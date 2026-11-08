// Miruro source for the Sozo/AniZiQ extractor.
//
// Strategy: miruro.tv (v1.15+) keys titles by its own opaque ids and serves
// every source from a Cloudflare-guarded catalog API whose responses are
// obfuscated (XOR "miruro/catalog" + gzip). We open miruro.tv in a headless
// browser so Cloudflare issues cf_clearance, then call that API from the page:
//   1. /api/v1/anime?anilist_id_in=<id>         -> miruro id
//   2. /api/v1/anime/<id>/episodes/<ep>/play    -> tracks/providers/streams
// The upstream CDN now insists on Origin+Referer of ultracloud.cc, which the
// apps can't send, so we hand out miruro's own HLS proxy URL instead (the same
// one their player uses). It needs no headers and rewrites variants/segments.

const MIRURO_HOST = 'https://www.miruro.tv';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Fallbacks for the values miruro publishes in window.env (/env2.js).
const DEFAULT_PROXIES = ['https://s1.keeply.top/', 'https://s2.keeply.top/'];
const DEFAULT_PROXY_OBF_KEY = 'a54d389c18527d9fd3e7f0643e27edbe';

// Track preference per requested type. 'ssub' is soft-subbed (separate .vtt),
// which is what this source returned before; 'sub' is hard-subbed.
const TRACKS = { sub: ['ssub', 'sub'], dub: ['dub'] };
// icarus is the ultracloud-backed provider the apps were built around.
const PREFERRED_PROVIDER = 'icarus';

// key: `${anilistId}:${ep}:${type}` -> { url, referer, qualities, subtitles, skips, audio, ts }
const streamCache = new Map();
const CACHE_TTL = 20 * 60 * 1000; // 20 min (playlist tokens are short-lived, keep modest)

function getCached(key) {
  const e = streamCache.get(key);
  if (e && Date.now() - e.ts < CACHE_TTL) return e;
  streamCache.delete(key);
  return null;
}

// How the last real episode lookups went, for /health. Only times and one of the words below:
// nothing about which show, or who asked.
const LOOKUP_ERRORS = ['source_down', 'timeout', 'error'];
const lookups = {
  okAt: null,
  failAt: null,
  error: null,
  note(ok, error = 'error') {
    if (ok) {
      this.okAt = Date.now();
    } else {
      this.failAt = Date.now();
      this.error = LOOKUP_ERRORS.includes(error) ? error : 'error';
    }
  },
  snapshot() {
    return { lastOkAt: this.okAt, lastFailAt: this.failAt, lastError: this.error };
  },
};

// Mirrors the site's proxy URL builder: XOR with the hex key, base64url.
function proxyUrl(base, kind, url, referer, keyHex) {
  const key = Buffer.from(keyHex, 'hex');
  const enc = (s) => {
    const b = Buffer.from(s, 'utf8');
    for (let i = 0; i < b.length; i++) b[i] ^= key[i % key.length];
    return b.toString('base64url');
  };
  return `${base}${enc(url)}${referer ? `~${enc(referer)}` : ''}/${kind}`;
}

// Runs in the page: fetch a catalog path and undo the XOR+gzip envelope.
async function catalogFetch(path) {
  let lastErr = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(path);
      const ct = r.headers.get('content-type') || '';
      if (!ct.startsWith('application/octet-stream')) {
        return { status: r.status, error: (await r.text()).slice(0, 200) };
      }
      const buf = new Uint8Array(await r.arrayBuffer());
      const key = new TextEncoder().encode('miruro/catalog');
      for (let i = 0; i < buf.length; i++) buf[i] ^= key[i % key.length];
      const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'));
      return { status: r.status, json: JSON.parse(await new Response(stream).text()) };
    } catch (e) {
      // Cloudflare can fail the very first API calls before cf_clearance lands.
      lastErr = e.message;
      await new Promise(res => setTimeout(res, 1500));
    }
  }
  return { status: 0, error: lastErr };
}

// Ordered stream candidates for the requested type: preferred provider first,
// then any other HLS provider on the same tracks.
function pickCandidates(play, type) {
  const out = [];
  for (const trackName of TRACKS[type] || TRACKS.sub) {
    const track = (play.tracks || []).find(t => t.track === trackName);
    if (!track) continue;
    const providers = [...(track.providers || [])].sort((a, b) =>
      (b.provider === PREFERRED_PROVIDER) - (a.provider === PREFERRED_PROVIDER));
    for (const p of providers) {
      for (const server of p.servers || []) {
        for (const stream of server.streams || []) {
          if (stream.format !== 'hls' || !stream.url) continue;
          out.push({ track: trackName, provider: p.provider, server, stream, subtitles: p.subtitles || [], skips: skipsOf(p) });
        }
      }
    }
  }
  return out;
}

// The versions (TRACKS keys) an episode has an HLS stream for: ['sub', 'dub'], ['sub'], ….
function audioOf(play) {
  return Object.keys(TRACKS).filter(type => pickCandidates(play, type).length > 0);
}

// The provider's intro/outro (seconds) for this episode as [{kind:'op'|'ed', start, end}].
function skipsOf(p) {
  const out = [];
  for (const [kind, z] of [['op', p.intro], ['ed', p.outro]]) {
    if (z && Number.isFinite(z.start) && Number.isFinite(z.end) && z.end > z.start) out.push({ kind, start: z.start, end: z.end });
  }
  return out;
}

async function isPlaylist(url) {
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(10000) });
    return r.ok && (await r.text()).trimStart().startsWith('#EXTM3U');
  } catch {
    return false;
  }
}

// A subtitle file that loads: a WebVTT or SRT body with at least one cue.
async function hasCues(url) {
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(10000) });
    return r.ok && (await r.text()).includes('-->');
  } catch {
    return false;
  }
}

// The length in seconds of an HLS stream (its first variant's EXTINFs), or null.
async function playlistSeconds(url) {
  const get = async (u) => {
    const r = await fetch(u, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(10000) });
    return r.ok ? r.text() : '';
  };
  try {
    let text = await get(url);
    if (text.includes('#EXT-X-STREAM-INF')) {
      const variant = text.split(/\r?\n/).find(l => l.trim() && !l.startsWith('#'));
      if (!variant) return null;
      text = await get(new URL(variant.trim(), url).href);
    }
    const parts = [...text.matchAll(/#EXTINF:([0-9.]+)/g)].map(m => Number(m[1]));
    return parts.length ? parts.reduce((a, b) => a + b, 0) : null;
  } catch {
    return null;
  }
}

// How many other providers' subtitles borrowSubtitles tries, and how far their episode's length may
// be from the one playing (a longer gap is another cut, whose subtitles would be out of time).
const BORROW_TRIES = 3;
const SAME_LENGTH_S = 1.5;

// `found`'s subtitles when they load; when they don't (some providers' files are gone upstream:
// 403 there, 500 from the proxy), another provider's for the same episode whose stream is as long
// as this one's and whose files load. The video stays the one found: other providers can be far
// slower. Without such a provider, `found` as it is.
async function borrowSubtitles(found, candidates, obfKey, { cues = hasCues, seconds = playlistSeconds } = {}) {
  if (!found.subtitles.length || (await cues(found.subtitles[0].url))) return found;
  console.log(`[MIRURO] ${found.provider} subtitles don't load`);
  const own = await seconds(found.url);
  if (!own) return found;
  const tried = new Set();
  for (const c of candidates) {
    if (c.provider === found.provider || tried.has(c.provider)) continue;
    const files = c.subtitles
      .filter(s => s.file && (s.format === 'vtt' || s.format === 'srt'))
      .sort((a, b) => (b.default === true) - (a.default === true));
    if (!files.length) continue;
    if (tried.size >= BORROW_TRIES) break;
    tried.add(c.provider);
    const referer = (c.server.headers && (c.server.headers.Referer || c.server.headers.referer)) || '';
    const length = await seconds(proxyUrl(found.base, 'pl.m3u8', c.stream.url, referer, obfKey));
    if (!length || Math.abs(length - own) > SAME_LENGTH_S) {
      console.log(`[MIRURO] ${c.provider} is ${length ? `${length.toFixed(1)} s, not ${own.toFixed(1)} s` : 'of unknown length'}: its subtitles aren't used`);
      continue;
    }
    const subtitles = files.map(s => ({ url: proxyUrl(found.base, 'sub.vtt', s.file, referer, obfKey), lang: s.label || s.language || 'English', language: s.language || null }));
    if (!(await cues(subtitles[0].url))) continue;
    console.log(`[MIRURO] subtitles from ${c.provider} (${length.toFixed(1)} s, as the stream)`);
    return { ...found, subtitles };
  }
  return found;
}

// The first candidate one of the proxies serves a playlist for, or null.
async function firstPlayable(candidates, proxyBases, obfKey, check = isPlaylist) {
  for (const c of candidates) {
    const upstreamReferer = (c.server.headers && (c.server.headers.Referer || c.server.headers.referer)) || '';
    for (const base of proxyBases) {
      const m3u8 = proxyUrl(base, 'pl.m3u8', c.stream.url, upstreamReferer, obfKey);
      if (!(await check(m3u8))) {
        console.log(`[MIRURO] ${c.track}/${c.provider}/${c.server.server} via ${base} not playable`);
        continue;
      }
      console.log(`[MIRURO] ${c.track}/${c.provider}/${c.server.server} m3u8 ${m3u8.slice(0, 90)}`);

      const subtitles = c.subtitles
        .filter(s => s.file && (s.format === 'vtt' || s.format === 'srt'))
        .sort((a, b) => (b.default === true) - (a.default === true))
        .map(s => ({ url: proxyUrl(base, 'sub.vtt', s.file, upstreamReferer, obfKey), lang: s.label || s.language || 'English', language: s.language || null }));

      // The proxy itself needs no headers; keep the historical Referer so
      // clients that always send one behave exactly as before.
      return { url: m3u8, referer: `${MIRURO_HOST}/`, qualities: [], subtitles, skips: c.skips, provider: c.provider, base };
    }
  }
  return null;
}

const streamOf = (s) => ({ videoUrl: s.url, referer: s.referer, qualities: s.qualities || [], subtitles: s.subtitles || [], skips: s.skips || [] });

/**
 * Resolve an HLS stream for a given AniList id + episode number.
 * @param {import('puppeteer').Browser} browser shared puppeteer browser
 * @param {string|number} anilistId
 * @param {number} ep 1-based episode number
 * @param {string} type 'sub' | 'dub'
 * @param {{isPlaylist?: (url: string) => Promise<boolean>, hasCues?: (url: string) => Promise<boolean>,
 *   playlistSeconds?: (url: string) => Promise<number|null>}} [seams] tests replace the network checks
 * @returns {Promise<object|null>} one of
 *   {videoUrl, referer, qualities, subtitles, skips, audio}: found; audio lists the versions it has;
 *   {missing: true, audio, fallback}: the episode is there, not in this version; fallback is the
 *     other version ({type, videoUrl, …}) when one of its streams plays, else null;
 *   {sourceDown: true}: miruro's catalog, its play call or its proxies didn't answer;
 *   null: not in the catalog, or no such episode.
 */
async function resolveMiruroStream(browser, anilistId, ep, type = 'sub', { isPlaylist: check = isPlaylist, hasCues: cues = hasCues, playlistSeconds: seconds = playlistSeconds } = {}) {
  const key = `${anilistId}:${ep}:${type}`;
  const cached = getCached(key);
  if (cached) {
    console.log(`[MIRURO] cache hit ${key}`);
    return { ...streamOf(cached), audio: cached.audio || [] };
  }

  const page = await browser.newPage();
  try {
    await page.setUserAgent(UA);
    // Only the HTML/JS matter (Cloudflare challenge + same-origin context).
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      if (['image', 'media', 'font', 'stylesheet'].includes(req.resourceType())) req.abort().catch(() => {});
      else req.continue().catch(() => {});
    });

    console.log(`[MIRURO] lookup anilist ${anilistId} ep ${ep} ${type}`);
    await page.goto(`${MIRURO_HOST}/`, { waitUntil: 'domcontentloaded', timeout: 40000 });

    // Give Cloudflare's challenge script a moment to set cf_clearance.
    const cfStart = Date.now();
    while (Date.now() - cfStart < 10000) {
      const cookies = await page.cookies();
      if (cookies.some(c => c.name === 'cf_clearance')) break;
      await new Promise(r => setTimeout(r, 300));
    }

    const lookup = await page.evaluate(catalogFetch, `/api/v1/anime?anilist_id_in=${encodeURIComponent(anilistId)}&limit=100`);
    if (!lookup.json) {
      // Cloudflare's challenge page, an HTML error or no connection.
      console.log(`[MIRURO] catalog lookup failed (${lookup.status} ${lookup.error || ''})`);
      return { sourceDown: true };
    }
    const entries = Array.isArray(lookup.json.data) ? lookup.json.data : [];
    const anime = entries.find(a =>
      ((a.external_ids && a.external_ids.anilist) || []).map(String).includes(String(anilistId)));
    if (!anime) {
      console.log(`[MIRURO] no catalog entry for anilist ${anilistId}`);
      return null;
    }

    const play = await page.evaluate(catalogFetch, `/api/v1/anime/${encodeURIComponent(anime.id)}/episodes/${encodeURIComponent(ep)}/play`);
    if (!play.json) {
      console.log(`[MIRURO] play ${anime.id} ep ${ep} failed (${play.status} ${play.error || ''})`);
      return play.status === 404 ? null : { sourceDown: true };
    }

    const env = await page.evaluate(() => window.env || {}).catch(() => ({}));
    const proxies = [env.VITE_PROXY_A, env.VITE_PROXY_B]
      .filter(Boolean)
      .map(p => (p.endsWith('/') ? p : `${p}/`));
    const proxyBases = proxies.length ? proxies : DEFAULT_PROXIES;
    const obfKey = env.VITE_PROXY_OBF_KEY || DEFAULT_PROXY_OBF_KEY;

    const audio = audioOf(play.json);
    if (!audio.length) {
      const tracks = (play.json.tracks || []).map(t => t.track).join(',');
      console.log(`[MIRURO] no HLS stream (tracks: ${tracks})`);
      return null;
    }
    const keep = (t, found) => streamCache.set(`${anilistId}:${ep}:${t}`, { ...found, audio, ts: Date.now() });

    if (!audio.includes(type)) {
      const other = audio[0];
      console.log(`[MIRURO] no ${type} for ep ${ep} (has ${audio.join(',')})`);
      const candidates = pickCandidates(play.json, other);
      const first = await firstPlayable(candidates, proxyBases, obfKey, check);
      const found = first && (await borrowSubtitles(first, candidates, obfKey, { cues, seconds }));
      if (found) keep(other, found);
      return { missing: true, audio, fallback: found ? { type: other, ...streamOf(found) } : null };
    }

    const candidates = pickCandidates(play.json, type);
    const first = await firstPlayable(candidates, proxyBases, obfKey, check);
    const found = first && (await borrowSubtitles(first, candidates, obfKey, { cues, seconds }));
    if (!found) {
      console.log('[MIRURO] no candidate stream served a playlist');
      return { sourceDown: true };
    }
    keep(type, found);
    return { ...streamOf(found), audio };
  } finally {
    await page.close().catch(() => {});
  }
}

// The HTTP answer to /miruro/stream for a resolveMiruroStream result, and whether it counts as a
// lookup that worked (`ok`, else `error` says how it failed) in `lookups`.
function streamAnswer(result, type) {
  if (result && result.videoUrl) {
    const body = {
      status: 'ok',
      videoUrl: result.videoUrl,
      referer: result.referer,
      qualities: result.qualities || [],
      subtitles: result.subtitles || [],
      // Intro/outro of this exact video, seconds: [{kind:'op'|'ed', start, end}].
      skips: result.skips || [],
      audio: result.audio || [],
    };
    return { status: 200, ok: true, body };
  }
  if (result && result.missing) {
    const error = type === 'dub' ? 'No dub for this episode' : 'No subtitled version of this episode';
    return { status: 404, ok: true, body: { status: 'error', error, reason: 'no_track', audio: result.audio, fallback: result.fallback } };
  }
  if (result && result.sourceDown) {
    return { status: 502, ok: false, error: 'source_down', body: { status: 'error', error: 'The stream source is not answering', reason: 'source_down' } };
  }
  return { status: 404, ok: true, body: { status: 'error', error: 'No stream found', reason: 'not_found' } };
}

module.exports = { resolveMiruroStream, streamAnswer, audioOf, pickCandidates, borrowSubtitles, lookups };
