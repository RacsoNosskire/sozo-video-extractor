// HLS proxy for the AniZiQ browser build (desktop-rs, `trunk serve`). A web page can't send the
// Referer the CDN wants, can't read cross-origin responses without CORS, and can't strip the
// fake PNG header some CDNs put in front of TS segments — so this does what the desktop app's
// loopback proxy (desktop-rs/src/proxy.rs) does, over HTTP:
//   /proxy/m3u8?u=<b64url playlist>&r=<b64url referer>  → rewritten playlist
//   /proxy/seg?u=…&r=…                                  → segment (fake header stripped)
//   /proxy/sub?u=…&r=…                                  → subtitle file
// u/r are base64url (no padding), the same encoding the app uses.

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)';
const TS_PACKET = 188;

const dec = (s) => Buffer.from(String(s || ''), 'base64url').toString('utf8');
const enc = (s) => Buffer.from(s, 'utf8').toString('base64url');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// GET with a few retries: CDN edges answer 403/429/5xx to read-ahead bursts. Returns the body
// and the URL it finally came from (relative playlist entries resolve against that).
async function fetchRetry(url, referer) {
    let last = '';
    for (let attempt = 0; attempt < 4; attempt++) {
        if (attempt > 0) await sleep(400 * attempt);
        const headers = { 'User-Agent': UA };
        if (referer) headers.Referer = referer;
        const res = await fetch(url, { headers, redirect: 'follow' });
        if (res.ok) return { body: Buffer.from(await res.arrayBuffer()), finalUrl: res.url || url };
        last = `GET ${url}: HTTP ${res.status}`;
        if (!(res.status === 403 || res.status === 429 || res.status >= 500)) break;
    }
    throw new Error(last);
}

// First offset whose 0x47 begins a real 188-byte TS packet cadence (skips the fake header);
// 0 when the data isn't a wrapped TS segment.
function tsStart(d) {
    if (d.length <= 5 * TS_PACKET) return 0;
    const limit = Math.min(d.length - 5 * TS_PACKET, 8192);
    for (let o = 0; o < limit; o++) {
        if ([0, 1, 2, 3, 5].every((k) => d[o + k * TS_PACKET] === 0x47)) return o;
    }
    return 0;
}

function rewritePlaylist(text, playlistUrl, referer, base) {
    const proxied = (uri, playlist) => {
        const abs = new URL(uri, playlistUrl).toString();
        const path = abs.split('?')[0];
        const route = playlist || path.endsWith('.m3u8') ? 'm3u8' : 'seg';
        return `${base}/${route}?u=${enc(abs)}&r=${enc(referer)}`;
    };
    let nextIsPlaylist = false;
    return text
        .split('\n')
        .map((line) => {
            const t = line.trim();
            if (!t) return line;
            if (t.startsWith('#')) {
                nextIsPlaylist = t.startsWith('#EXT-X-STREAM-INF');
                const tagPlaylist = t.startsWith('#EXT-X-MEDIA') || t.startsWith('#EXT-X-I-FRAME-STREAM-INF');
                // Keys, init segments and alternate renditions carry URI="…".
                return line.replace(/URI="([^"]*)"/, (m, uri) => {
                    let scheme = null;
                    try { scheme = new URL(uri).protocol; } catch { /* relative */ }
                    if (scheme && scheme !== 'http:' && scheme !== 'https:') return m;
                    return `URI="${proxied(uri, tagPlaylist)}"`;
                });
            }
            const out = proxied(t, nextIsPlaylist);
            nextIsPlaylist = false;
            return out;
        })
        .join('\n');
}

function mount(app) {
    // Links in rewritten playlists point back here. Behind a reverse proxy (the hosted browser
    // app serves the extractor under /x over HTTPS) honour its X-Forwarded-* headers, so the
    // links keep the page's scheme, host and path prefix.
    const base = (req) => {
        const first = (h) => (req.get(h) || '').split(',')[0].trim();
        const proto = first('x-forwarded-proto') || req.protocol;
        const host = first('x-forwarded-host') || req.get('host');
        const prefix = first('x-forwarded-prefix').replace(/\/+$/, '');
        return `${proto}://${host}${prefix}/proxy`;
    };
    const params = (req) => ({ url: dec(req.query.u), referer: dec(req.query.r) });
    const fail = (res, path, e) => {
        console.error(`[PROXY ${path}] ${e.message}`);
        if (!res.headersSent) res.status(502).type('text/plain').send(e.message);
    };

    app.get('/proxy/m3u8', async (req, res) => {
        try {
            const { url, referer } = params(req);
            const { body, finalUrl } = await fetchRetry(url, referer);
            res.type('application/vnd.apple.mpegurl').send(rewritePlaylist(body.toString('utf8'), finalUrl, referer, base(req)));
        } catch (e) { fail(res, 'm3u8', e); }
    });

    app.get('/proxy/seg', async (req, res) => {
        try {
            const { url, referer } = params(req);
            const { body, finalUrl } = await fetchRetry(url, referer);
            // A playlist whose URL didn't look like one (no .m3u8).
            if (body.subarray(0, 7).toString() === '#EXTM3U') {
                return res.type('application/vnd.apple.mpegurl').send(rewritePlaylist(body.toString('utf8'), finalUrl, referer, base(req)));
            }
            res.type('video/mp2t').send(body.subarray(tsStart(body)));
        } catch (e) { fail(res, 'seg', e); }
    });

    app.get('/proxy/sub', async (req, res) => {
        try {
            const { url, referer } = params(req);
            const { body } = await fetchRetry(url, referer);
            res.type('text/vtt; charset=utf-8').send(body);
        } catch (e) { fail(res, 'sub', e); }
    });
}

module.exports = { mount, rewritePlaylist, tsStart };
