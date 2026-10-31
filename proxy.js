// HLS proxy for the AniZiQ browser build (desktop-rs, `trunk serve`). A web page can't send the
// Referer the CDN wants, can't read cross-origin responses without CORS, and can't strip the
// fake PNG header some CDNs put in front of TS segments — so this does what the desktop app's
// loopback proxy (desktop-rs/src/proxy.rs) does, over HTTP:
//   /proxy/m3u8?u=<b64url playlist>&r=<b64url referer>  → rewritten playlist
//   /proxy/seg?u=…&r=…                                  → segment (fake header stripped)
//   /proxy/sub?u=…&r=…                                  → subtitle file
// u/r are base64url (no padding), the same encoding the app uses.
// This fetches URLs it is handed, so it must not become a way into the LAN or a free proxy for
// other sites: see `browserAllowed`, `isBlockedIp` and the caps below.

const http = require('http');
const https = require('https');
const dns = require('dns');
const net = require('net');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)';
const TS_PACKET = 188;

// The only web pages that may use this server. Requests with neither Origin nor Sec-Fetch-Site
// (the native apps, curl) aren't from a page and stay allowed.
const ALLOWED_ORIGINS = new Set(['https://aniziq.zikso.org', 'http://localhost:8791', 'http://127.0.0.1:8791']);

const MAX_REDIRECTS = 5;
const MAX_SEGMENT = 64 * 1024 * 1024;
const MAX_TEXT = 8 * 1024 * 1024; // playlists and subtitle files
const FETCH_DEADLINE_MS = 60 * 1000; // one fetch, retries and redirects included

const dec = (s) => Buffer.from(String(s || ''), 'base64url').toString('utf8');
const enc = (s) => Buffer.from(s, 'utf8').toString('base64url');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const keepAlive = { http: new http.Agent({ keepAlive: true }), https: new https.Agent({ keepAlive: true }) };

// A request this proxy won't make; never retried. `status` is what the client gets.
class Refused extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

// The origin to name in CORS headers, or null for anything else.
const allowedOrigin = (origin) => (ALLOWED_ORIGINS.has(origin) ? origin : null);

// May this request use the proxy? A page's request must come from an allowed origin; one without
// an Origin (a tag on someone's page) mustn't say it crossed sites. Plain-http servers don't get
// Sec-Fetch-Site, so such a tag can still get through, but without CORS it can't read the answer.
function browserAllowed(origin, fetchSite) {
    if (origin !== undefined) return allowedOrigin(origin) !== null;
    return fetchSite !== 'cross-site' && fetchSite !== 'same-site';
}

const ipv4Blocked = (a, b) =>
    a === 0 || a === 10 || a === 127 || a >= 224 // this network, private, loopback, multicast and reserved
    || (a === 100 && b >= 64 && b <= 127) // carrier NAT (Tailscale too)
    || (a === 169 && b === 254) // link-local, cloud metadata
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && (b === 0 || b === 168))
    || (a === 198 && (b === 18 || b === 19)); // benchmarking

// The eight 16-bit groups of an IPv6 address, or null if it isn't one.
function ipv6Groups(ip) {
    let text = ip.split('%')[0].toLowerCase();
    const dotted = text.match(/^(.*:)(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
    if (dotted) {
        const [a, b, c, d] = dotted.slice(2).map(Number);
        text = `${dotted[1]}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
    }
    const [head, tail, extra] = text.split('::');
    if (extra !== undefined) return null;
    const groups = (part) => (part ? part.split(':').map((g) => parseInt(g, 16)) : []);
    const front = groups(head);
    const back = groups(tail);
    const zeros = text.includes('::') ? 8 - front.length - back.length : 0;
    const all = [...front, ...new Array(Math.max(zeros, 0)).fill(0), ...back];
    return all.length === 8 && all.every((g) => g >= 0 && g <= 0xffff) ? all : null;
}

// True for anything but a public internet address. Unparsable counts as private.
function isBlockedIp(ip) {
    if (net.isIPv4(ip)) {
        const [a, b] = ip.split('.').map(Number);
        return ipv4Blocked(a, b);
    }
    const g = ipv6Groups(ip);
    if (!g) return true;
    const leadingZeros = (n) => g.slice(0, n).every((x) => x === 0);
    const v4 = (hi) => ipv4Blocked(hi >> 8, hi & 255);
    // Forms that carry an IPv4 address: compatible (with :: and ::1), mapped, NAT64, 6to4.
    if (leadingZeros(6)) return v4(g[6]);
    if (leadingZeros(5) && g[5] === 0xffff) return v4(g[6]);
    if (g[0] === 0x64 && g[1] === 0xff9b) return g[2] !== 0 || v4(g[6]);
    if (g[0] === 0x2002) return v4(g[1]);
    // Teredo and documentation; then only global unicast (2000::/3) is left.
    if (g[0] === 0x2001 && (g[1] === 0 || g[1] === 0xdb8)) return true;
    return (g[0] & 0xe000) !== 0x2000;
}

// http(s) only, no embedded credentials, no private address written into the URL.
function checkTarget(text, blocked = isBlockedIp) {
    let url;
    try {
        url = new URL(text);
    } catch {
        throw new Refused(400, 'bad url');
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Refused(403, `scheme ${url.protocol} not allowed`);
    if (url.username || url.password) throw new Refused(403, 'credentials in url not allowed');
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (net.isIP(host) && blocked(host)) throw new Refused(403, 'private address not allowed');
    return url;
}

// dns.lookup for the socket itself, so the addresses checked are the ones connected to and a
// name that changes its answer between a check and the connect gets nowhere.
const publicLookup = (blocked) => (hostname, options, cb) => {
    dns.lookup(hostname, { ...options, all: true }, (err, addrs) => {
        if (err) return cb(err);
        if (addrs.some((a) => blocked(a.address))) return cb(new Refused(403, `${hostname} resolves to a private address`));
        if (options.all) return cb(null, addrs);
        cb(null, addrs[0].address, addrs[0].family);
    });
};

// One GET, no redirect following. Resolves with the status and, for a 2xx, the body.
function getOnce(url, referer, limit, signal, blocked) {
    return new Promise((resolve, reject) => {
        const secure = url.protocol === 'https:';
        const headers = { 'User-Agent': UA };
        if (referer) headers.Referer = referer;
        const req = (secure ? https : http).get(url, {
            headers,
            signal,
            agent: secure ? keepAlive.https : keepAlive.http,
            lookup: publicLookup(blocked),
        }, (res) => {
            if (res.statusCode < 200 || res.statusCode >= 300) {
                res.resume();
                return resolve({ status: res.statusCode, location: res.headers.location });
            }
            const tooBig = () => new Refused(413, `response over ${limit} bytes`);
            if (Number(res.headers['content-length']) > limit) {
                res.destroy();
                return reject(tooBig());
            }
            const chunks = [];
            let size = 0;
            res.on('data', (c) => {
                size += c.length;
                if (size > limit) {
                    res.destroy();
                    return reject(tooBig());
                }
                chunks.push(c);
            });
            res.on('error', reject);
            res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
        });
        req.on('error', reject);
    });
}

// GET that follows redirects by hand, each hop checked like the first.
async function getFollowing(text, referer, limit, signal, blocked) {
    let current = text;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        const url = checkTarget(current, blocked);
        const res = await getOnce(url, referer, limit, signal, blocked);
        if (![301, 302, 303, 307, 308].includes(res.status) || !res.location) return { ...res, url: url.toString() };
        current = new URL(res.location, url).toString();
    }
    throw new Refused(502, 'too many redirects');
}

// GET with a few retries: CDN edges answer 403/429/5xx to read-ahead bursts. Returns the body
// and the URL it finally came from (relative playlist entries resolve against that).
async function fetchRetry(url, referer, limit, { deadlineMs = FETCH_DEADLINE_MS, blocked = isBlockedIp } = {}) {
    const signal = AbortSignal.timeout(deadlineMs);
    let last = '';
    for (let attempt = 0; attempt < 4; attempt++) {
        if (attempt > 0) await sleep(400 * attempt);
        const res = await getFollowing(url, referer, limit, signal, blocked);
        if (res.body) return { body: res.body, finalUrl: res.url };
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

// WebVTT cleaned as desktop-rs/src/proxy.rs `clean_vtt` does: text split off a cue by a blank line
// is joined back onto it, and cues that are only an ASS vector drawing ("m 0 0 l 250 0 ...") go.
// Anything that isn't WebVTT comes back unchanged.
const vttTime = (s) => {
    const dot = s.indexOf('.');
    if (dot < 0) return false;
    const clock = s.slice(0, dot).split(':');
    return clock.length >= 2 && clock.length <= 3
        && [...clock, s.slice(dot + 1)].every((p) => /^[0-9]+$/.test(p));
};

function vttCueText(block) {
    const at = block[0].includes('-->') ? 0 : 1;
    const line = block[at];
    if (line === undefined || !line.includes('-->')) return null;
    const [start, rest] = line.split(/-->(.*)/s);
    const end = rest.trim().split(/\s+/)[0];
    return vttTime(start.trim()) && vttTime(end) ? block.slice(at + 1) : null;
}

function isVttDrawing(text) {
    const tokens = text.join(' ').replace(/<[^>]*>/g, '').trim().split(/\s+/);
    return tokens[0] === 'm' && tokens.length >= 3
        && tokens.slice(1).every((t) => ['m', 'n', 'l', 'b', 's', 'p', 'c'].includes(t) || Number.isFinite(Number(t)));
}

function cleanVtt(text) {
    if (!text.replace(/^\uFEFF/, '').startsWith('WEBVTT')) return text;
    const blocks = [];
    let block = [];
    for (const line of text.split(/\r?\n/)) {
        if (line.trim()) block.push(line);
        else if (block.length) { blocks.push(block); block = []; }
    }
    if (block.length) blocks.push(block);
    const out = [];
    let lastIsCue = false;
    blocks.forEach((b, i) => {
        if (i === 0 || /^(NOTE|STYLE|REGION)/.test(b[0])) {
            lastIsCue = false;
            out.push(b);
            return;
        }
        const cue = vttCueText(b);
        if (cue) {
            lastIsCue = !isVttDrawing(cue);
            if (lastIsCue) out.push(b);
        } else if (lastIsCue && out.length) {
            out[out.length - 1].push(...b);
        }
    });
    return out.map((b) => b.join('\n')).join('\n\n') + '\n';
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

// This server's address as the client sees it. Behind a reverse proxy (the hosted browser app
// serves the extractor under /x over HTTPS) that comes from its X-Forwarded-* headers, so links
// keep the page's scheme, host and path prefix. The result ends up in HTML and playlists, so a
// header that doesn't look like what it should be is ignored.
function publicBase(req) {
    const first = (h) => (req.get(h) || '').split(',')[0].trim();
    const proto = first('x-forwarded-proto');
    const host = first('x-forwarded-host');
    const prefix = first('x-forwarded-prefix').replace(/\/+$/, '');
    const scheme = /^https?$/.test(proto) ? proto : req.protocol;
    const name = /^[A-Za-z0-9.:[\]-]+$/.test(host) ? host : req.get('host');
    return `${scheme}://${name}${/^(\/[A-Za-z0-9._-]+)*$/.test(prefix) ? prefix : ''}`;
}

function mount(app) {
    const base = (req) => `${publicBase(req)}/proxy`;
    const params = (req) => ({ url: dec(req.query.u), referer: dec(req.query.r) });
    const fail = (res, path, e) => {
        console.error(`[PROXY ${path}] ${e.message}`);
        if (!res.headersSent) res.status(e.status || 502).type('text/plain').send(e.message);
    };

    app.use('/proxy', (req, res, next) => {
        if (browserAllowed(req.get('origin'), req.get('sec-fetch-site'))) return next();
        console.error(`[PROXY] refused a request from origin ${req.get('origin') || '(none)'}`);
        res.status(403).type('text/plain').send('forbidden');
    });

    app.get('/proxy/m3u8', async (req, res) => {
        try {
            const { url, referer } = params(req);
            const { body, finalUrl } = await fetchRetry(url, referer, MAX_TEXT);
            res.type('application/vnd.apple.mpegurl').send(rewritePlaylist(body.toString('utf8'), finalUrl, referer, base(req)));
        } catch (e) { fail(res, 'm3u8', e); }
    });

    app.get('/proxy/seg', async (req, res) => {
        try {
            const { url, referer } = params(req);
            const { body, finalUrl } = await fetchRetry(url, referer, MAX_SEGMENT);
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
            const { body } = await fetchRetry(url, referer, MAX_TEXT);
            res.type('text/vtt; charset=utf-8').send(cleanVtt(body.toString('utf8')));
        } catch (e) { fail(res, 'sub', e); }
    });
}

module.exports = {
    mount, rewritePlaylist, tsStart, cleanVtt, publicBase, allowedOrigin, browserAllowed, isBlockedIp, checkTarget, fetchRetry,
};
