// Miruro source for the Sozo/AniZiQ extractor.
//
// Strategy: instead of reversing Miruro's encrypted /api/secure/pipe responses
// (and fighting Cloudflare on the API host), we drive miruro.tv itself in a
// headless browser keyed by AniList ID + episode, let their own JS pass CF and
// decrypt the sources, and scrape the resulting HLS master playlist straight
// off the network. A normal player (ExoPlayer/OkHttp) can then fetch it with
// just a Referer header — verified against vault*.ultracloud.cc.

const MIRURO_HOST = 'https://www.miruro.tv';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// key: `${anilistId}:${ep}:${type}` -> { url, referer, ts }
const streamCache = new Map();
const CACHE_TTL = 20 * 60 * 1000; // 20 min (playlist tokens are short-lived, keep modest)

function getCached(key) {
  const e = streamCache.get(key);
  if (e && Date.now() - e.ts < CACHE_TTL) return e;
  streamCache.delete(key);
  return null;
}

/**
 * Resolve an HLS stream for a given AniList id + episode number.
 * @param {import('puppeteer').Browser} browser shared puppeteer browser
 * @param {string|number} anilistId
 * @param {number} ep 1-based episode number
 * @param {string} type 'sub' | 'dub'
 * @returns {Promise<{videoUrl:string, referer:string, qualities:Array}|null>}
 */
async function resolveMiruroStream(browser, anilistId, ep, type = 'sub') {
  const key = `${anilistId}:${ep}:${type}`;
  const cached = getCached(key);
  if (cached) {
    console.log(`[MIRURO] cache hit ${key}`);
    return { videoUrl: cached.url, referer: cached.referer, qualities: cached.qualities || [], subtitles: cached.subtitles || [] };
  }

  const page = await browser.newPage();
  try {
    await page.setUserAgent(UA);
    let m3u8 = '';
    let subUrl = '';
    const client = await page.target().createCDPSession();
    await client.send('Network.enable');
    client.on('Network.requestWillBeSent', (params) => {
      const u = params.request.url;
      // The master playlist is a *.m3u8 that is NOT a segment/subtitle track.
      if (!m3u8 && /\.m3u8(\?|$)/i.test(u) && !/\.vtt|thumbnail/i.test(u)) {
        m3u8 = u;
        console.log(`[MIRURO] m3u8 ${u.slice(0, 90)}`);
      }
      // Soft subtitle track (Miruro serves e.g. .../sub.vtt for sub content).
      if (!subUrl && /\.vtt(\?|$)/i.test(u) && !/thumbnail/i.test(u)) {
        subUrl = u;
        console.log(`[MIRURO] sub ${u.slice(0, 90)}`);
      }
    });

    const url = `${MIRURO_HOST}/watch?id=${anilistId}&ep=${ep}&type=${type}`;
    console.log(`[MIRURO] ${url}`);
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 50000 }).catch(() => {});

    // Poll for the player to resolve and start loading the playlist.
    const start = Date.now();
    while (!m3u8 && Date.now() - start < 30000) {
      await new Promise(r => setTimeout(r, 500));
    }
    if (!m3u8) {
      console.log('[MIRURO] no m3u8 captured');
      return null;
    }

    // The subtitle .vtt often loads a beat after the playlist — give it a short
    // grace window so we don't miss it.
    const subStart = Date.now();
    while (!subUrl && Date.now() - subStart < 6000) {
      await new Promise(r => setTimeout(r, 300));
    }

    // Fetching the playlist server-side is unreliable (undici TLS is blocked by
    // the CDN), so return the master URL directly; ExoPlayer parses variants.
    const referer = `${MIRURO_HOST}/`;
    const subtitles = subUrl ? [{ url: subUrl, lang: 'English' }] : [];
    const result = { url: m3u8, referer, qualities: [], subtitles, ts: Date.now() };
    streamCache.set(key, result);
    return { videoUrl: m3u8, referer, qualities: [], subtitles };
  } finally {
    await page.close().catch(() => {});
  }
}

module.exports = { resolveMiruroStream };
