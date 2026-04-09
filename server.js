const express = require('express');
const https = require('https');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

// Cached DDoS-Guard cookies for animepahe (refreshed when expired)
let paheCookies = '';
let paheCookiesTime = 0;
const COOKIE_TTL = 25 * 60 * 1000; // 25 min

async function refreshPaheCookies() {
    if (paheCookies && Date.now() - paheCookiesTime < COOKIE_TTL) return paheCookies;
    console.log('[COOKIES] Refreshing animepahe cookies via Puppeteer');
    const br = await getBrowser();
    const page = await br.newPage();
    try {
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36');
        await page.goto('https://animepahe.pw/', { waitUntil: 'networkidle2', timeout: 30000 });
        await new Promise(r => setTimeout(r, 2000));
        const cookies = await page.cookies();
        paheCookies = cookies.map(c => `${c.name}=${c.value}`).join('; ');
        paheCookiesTime = Date.now();
        console.log(`[COOKIES] Got ${cookies.length} cookies`);
        return paheCookies;
    } finally {
        await page.close().catch(() => {});
    }
}

// Plain HTTPS fetch with cookies (no Puppeteer overhead)
function httpsFetch(url, cookies) {
    return new Promise((resolve, reject) => {
        const req = https.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
                'Accept': 'application/json',
                'Cookie': cookies,
                'Referer': 'https://animepahe.pw/',
            },
            timeout: 10000,
        }, (res) => {
            let body = '';
            res.on('data', (chunk) => body += chunk);
            res.on('end', () => resolve({ status: res.statusCode, body }));
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    });
}

async function paheApiCall(path) {
    let cookies = await refreshPaheCookies();
    let result = await httpsFetch(`https://animepahe.pw${path}`, cookies);
    // If forbidden, refresh cookies and retry once
    if (result.status === 403 || result.body.includes('DDoS-Guard')) {
        console.log('[RETRY] Got DDoS-Guard, refreshing cookies');
        paheCookies = '';
        cookies = await refreshPaheCookies();
        result = await httpsFetch(`https://animepahe.pw${path}`, cookies);
    }
    return result.body;
}

const app = express();
const PORT = process.env.PORT || 3232;

const cache = new Map();
const CACHE_TTL = 30 * 60 * 1000;

function getCached(key) {
    const entry = cache.get(key);
    if (entry && Date.now() - entry.time < CACHE_TTL) return entry.value;
    cache.delete(key);
    return null;
}

function setCache(key, value) {
    cache.set(key, { value, time: Date.now() });
}

setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of cache) {
        if (now - entry.time > CACHE_TTL) cache.delete(key);
    }
}, 10 * 60 * 1000);

let browser = null;

async function getBrowser() {
    if (!browser || !browser.connected) {
        browser = await puppeteer.launch({
            headless: 'new',
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--disable-web-security',
                '--disable-features=IsolateOrigins,site-per-process',
                '--no-first-run',
                '--no-zygote',
                '--autoplay-policy=no-user-gesture-required',
            ],
        });
    }
    return browser;
}

async function extractVideoUrl(watchUrl) {
    const cached = getCached(watchUrl);
    if (cached) {
        console.log(`[CACHE HIT] ${watchUrl}`);
        return cached;
    }

    console.log(`[EXTRACT] ${watchUrl}`);
    const br = await getBrowser();
    const page = await br.newPage();

    try {
        await page.setUserAgent(
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
        );

        let videoUrl = '';
        let megaupEmbedUrl = '';
        let subtitles = [];
        const allUrls = [];

        const client = await page.target().createCDPSession();
        await client.send('Network.enable');

        client.on('Network.requestWillBeSent', (params) => {
            const url = params.request.url;
            allUrls.push(url);

            // Capture megaup embed URL from network
            if (!megaupEmbedUrl && url.includes('megaup.nl/e/')) {
                console.log(`[MEGAUP URL] ${url}`);
                megaupEmbedUrl = url;
            }

            if (!videoUrl) {
                if (url.includes('.m3u8')) {
                    console.log(`[HLS] ${url}`);
                    videoUrl = url;
                } else if (url.match(/\.mp4(\?|$)/) && !url.includes('thumb') && !url.includes('poster')) {
                    console.log(`[MP4] ${url}`);
                    videoUrl = url;
                }
            }
        });

        // Also capture response bodies for endpoints that may contain video URLs
        client.on('Network.responseReceived', async (params) => {
            const url = params.response.url;
            if (url.includes('.vtt') && !url.includes('thumbnail')) {
                subtitles.push(url);
            }
        });

        await page.goto(watchUrl, { waitUntil: 'domcontentloaded', timeout: 25000 });

        // Wait for the SPA to load and auto-play the video
        await new Promise(r => setTimeout(r, 5000));

        // Try to click the first server if not already clicked
        try {
            await page.evaluate(() => {
                const server = document.querySelector('#servers a.active') || document.querySelector('#servers a');
                if (server) server.click();
            });
            console.log('[CLICK] Clicked first server');
        } catch (e) {}

        // Wait for megaup iframe and navigate to it directly to force load
        await new Promise(r => setTimeout(r, 5000));

        // Use megaup URL captured from network requests
        try {
            const megaupUrl = megaupEmbedUrl;
            if (megaupUrl) {
                console.log(`[MEGAUP] Loading: ${megaupUrl}`);
                // Visit the megaup page directly in a new tab to bypass iframe restrictions
                const megaupPage = await br.newPage();
                await megaupPage.setUserAgent(
                    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
                );
                await megaupPage.setExtraHTTPHeaders({
                    'Referer': watchUrl.replace(/#.*$/, ''),
                });

                // Capture network on this page too
                const megaClient = await megaupPage.target().createCDPSession();
                await megaClient.send('Network.enable');
                megaClient.on('Network.requestWillBeSent', (params) => {
                    const url = params.request.url;
                    if (!videoUrl) {
                        if (url.includes('.m3u8')) { console.log(`[MEGA HLS] ${url}`); videoUrl = url; }
                        else if (url.match(/\.mp4(\?|$)/) && !url.includes('thumb')) { console.log(`[MEGA MP4] ${url}`); videoUrl = url; }
                    }
                    allUrls.push(url);
                });

                await megaupPage.goto(megaupUrl, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
                await new Promise(r => setTimeout(r, 8000));

                // Try to extract from JWPlayer
                if (!videoUrl) {
                    const src = await megaupPage.evaluate(() => {
                        if (typeof jwplayer !== 'undefined') {
                            try {
                                const p = jwplayer();
                                if (p && p.getPlaylistItem) {
                                    const item = p.getPlaylistItem();
                                    if (item && item.file) return item.file;
                                    if (item && item.sources && item.sources[0]) return item.sources[0].file;
                                }
                            } catch (e) {}
                        }
                        const v = document.querySelector('video');
                        if (v) return v.src || v.currentSrc || '';
                        return '';
                    }).catch(() => '');
                    if (src) { console.log(`[MEGA JW] ${src}`); videoUrl = src; }
                }
                await megaupPage.close().catch(() => {});
            }
        } catch (e) {
            console.log(`[MEGAUP ERR] ${e.message}`);
        }

        // If still no video URL, try to extract from JWPlayer or video element in any frame
        if (!videoUrl) {
            console.log('[POLL] Checking frames for video...');
            for (const frame of page.frames()) {
                try {
                    const src = await frame.evaluate(() => {
                        // Try JWPlayer
                        if (typeof jwplayer !== 'undefined') {
                            try {
                                const p = jwplayer();
                                if (p && p.getPlaylistItem) {
                                    const item = p.getPlaylistItem();
                                    if (item && item.file) return item.file;
                                    if (item && item.sources && item.sources[0]) {
                                        return item.sources[0].file || item.sources[0].src;
                                    }
                                }
                                if (p && p.getPlaylist) {
                                    const pl = p.getPlaylist();
                                    if (pl && pl[0] && pl[0].file) return pl[0].file;
                                }
                            } catch (e) {}
                        }
                        // Try video element
                        const video = document.querySelector('video');
                        if (video) {
                            if (video.src && video.src.startsWith('http')) return video.src;
                            if (video.currentSrc && video.currentSrc.startsWith('http')) return video.currentSrc;
                            const source = video.querySelector('source[src]');
                            if (source && source.src) return source.src;
                        }
                        return '';
                    }).catch(() => '');

                    if (src) {
                        console.log(`[FRAME] Found video in ${frame.url()}: ${src}`);
                        videoUrl = src;
                        break;
                    }
                } catch (e) {}
            }
        }

        // If still nothing, wait more
        if (!videoUrl) {
            console.log('[WAIT] More waiting...');
            await new Promise(r => setTimeout(r, 8000));
        }

        if (videoUrl) {
            const result = { videoUrl, subtitles };
            setCache(watchUrl, result);
            console.log(`[SUCCESS] ${videoUrl}`);
            return result;
        }

        // Debug: log unique non-static URLs
        console.log('[DEBUG] All non-static URLs seen:');
        const filtered = allUrls.filter(u =>
            !u.includes('.css') && !u.includes('.js') && !u.includes('.png') &&
            !u.includes('.jpg') && !u.includes('.svg') && !u.includes('.woff') &&
            !u.includes('.gif') && !u.includes('.ico') && !u.includes('cloudflare') &&
            !u.includes('google') && !u.includes('sharethis') && !u.includes('gravatar')
        );
        filtered.slice(-30).forEach(u => console.log('  ' + u));

        console.log('[FAIL] No video URL found');
        return null;

    } finally {
        await page.close().catch(() => {});
    }
}

// Search animepahe (uses cached cookies, no Puppeteer per request)
app.get('/animepahe/search', async (req, res) => {
    const query = req.query.q;
    if (!query) return res.status(400).json({ error: 'Missing q parameter' });
    try {
        console.log(`[PAHE] Search: ${query}`);
        const body = await paheApiCall(`/api?m=search&q=${encodeURIComponent(query)}`);
        try {
            res.json({ status: 'ok', data: JSON.parse(body) });
        } catch (e) {
            res.json({ status: 'error', error: 'Got HTML', preview: body.substring(0, 200) });
        }
    } catch (e) {
        res.status(500).json({ status: 'error', error: e.message });
    }
});

// Get episodes (uses cached cookies)
app.get('/animepahe/episodes', async (req, res) => {
    const session = req.query.session;
    const page = parseInt(req.query.page, 10) || 1;
    if (!session) return res.status(400).json({ error: 'Missing session parameter' });
    try {
        console.log(`[PAHE] Episodes: ${session} page=${page}`);
        const body = await paheApiCall(`/api?m=release&id=${session}&sort=episode_asc&page=${page}`);
        try {
            res.json({ status: 'ok', data: JSON.parse(body) });
        } catch (e) {
            res.json({ status: 'error', error: 'Got HTML', preview: body.substring(0, 200) });
        }
    } catch (e) {
        res.status(500).json({ status: 'error', error: e.message });
    }
});

// Extract video URL from animepahe play page (Kwik embed)
app.get('/animepahe/video', async (req, res) => {
    const session = req.query.session;
    const epSession = req.query.ep;
    if (!session || !epSession) return res.status(400).json({ error: 'Missing session/ep' });
    // Hard timeout so we never leave the client hanging if puppeteer wedges.
    const overallTimeout = setTimeout(() => {
        if (!res.headersSent) {
            console.log('[PAHE] overall timeout — replying 504');
            res.status(504).json({ status: 'error', error: 'Extractor timeout' });
        }
    }, 75000);
    res.on('finish', () => clearTimeout(overallTimeout));
    res.on('close', () => clearTimeout(overallTimeout));
    try {
        const br = await getBrowser();
        const page = await br.newPage();
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36');

        let videoUrl = '';
        const allUrls = [];
        const client = await page.target().createCDPSession();
        await client.send('Network.enable');
        client.on('Network.requestWillBeSent', (params) => {
            const u = params.request.url;
            allUrls.push(u);
            if (!videoUrl && u.includes('.m3u8')) {
                console.log(`[PAHE HLS] ${u}`);
                videoUrl = u;
            }
            if (!videoUrl && u.match(/\.mp4(\?|$)/) && !u.includes('thumb')) {
                console.log(`[PAHE MP4] ${u}`);
                videoUrl = u;
            }
        });

        const playUrl = `https://animepahe.pw/play/${session}/${epSession}`;
        console.log(`[PAHE] Play: ${playUrl}`);
        // CRITICAL: the ep_session the client passed was issued by animepahe
        // *for the cookie set that paheApiCall used* when it hit /api?m=release.
        // If puppeteer creates a new DDoS-Guard session here, animepahe binds
        // the /play/ URL to the new cookies and the old ep_session becomes
        // invalid → 500 SERVER ERROR. So seed the puppeteer page with the
        // exact same cookies paheApiCall is using.
        const sharedCookieStr = await refreshPaheCookies();
        if (sharedCookieStr) {
            const cookieObjs = sharedCookieStr.split('; ').map((kv) => {
                const i = kv.indexOf('=');
                return {
                    name: kv.slice(0, i),
                    value: kv.slice(i + 1),
                    domain: '.animepahe.pw',
                    path: '/',
                };
            }).filter(c => c.name);
            await page.setCookie(...cookieObjs).catch(() => {});
        }
        await page.setExtraHTTPHeaders({ Referer: `https://animepahe.pw/anime/${session}` });
        await page.goto(playUrl, { waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});
        // Wait for the resolution menu to actually render — up to 8 s.
        try {
            await page.waitForSelector('#resolutionMenu button[data-src], button.dropdown-item[data-src]', { timeout: 8000 });
        } catch {
            console.log('[PAHE] resolutionMenu never appeared');
        }

        // Read every quality button so we can return them all to the app.
        const optionMeta = await page.evaluate(() => {
            return Array.from(document.querySelectorAll('#resolutionMenu button[data-src], button.dropdown-item[data-src]')).map((button) => {
                const badges = Array.from(button.querySelectorAll('span.badge')).map((el) => el.textContent?.trim()).filter(Boolean);
                return {
                    kwikUrl: button.getAttribute('data-src') || '',
                    fansub: button.getAttribute('data-fansub') || 'AnimePahe',
                    resolution: button.getAttribute('data-resolution') || '',
                    audio: button.getAttribute('data-audio') || 'jpn',
                    quality: badges.find((t) => /BD|WEB|DVD/i.test(t || '')) || '',
                    isActive: button.classList.contains('active'),
                    fullText: (button.textContent || '').trim(),
                };
            }).filter((item) => item.kwikUrl);
        }).catch(() => []);

        // Helper: open one kwik embed in a fresh tab and capture the m3u8 URL it loads.
        async function resolveKwikStream(kwikLink, meta) {
            const kp = await br.newPage();
            try {
                await kp.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36');
                await kp.setExtraHTTPHeaders({ 'Referer': 'https://animepahe.pw/' });
                let foundUrl = '';
                const cdp = await kp.target().createCDPSession();
                await cdp.send('Network.enable');
                cdp.on('Network.requestWillBeSent', (params) => {
                    const u = params.request.url;
                    if (!foundUrl && u.includes('.m3u8')) foundUrl = u;
                    if (!foundUrl && u.match(/\.mp4(\?|$)/) && !u.includes('thumb')) foundUrl = u;
                });
                await kp.goto(kwikLink, { waitUntil: 'domcontentloaded', timeout: 25000 }).catch(() => {});
                const start = Date.now();
                while (!foundUrl && Date.now() - start < 15000) {
                    await new Promise(r => setTimeout(r, 200));
                }
                if (!foundUrl) {
                    foundUrl = await kp.evaluate(() => {
                        const v = document.querySelector('video');
                        return v ? (v.src || v.currentSrc || '') : '';
                    }).catch(() => '');
                }
                if (!foundUrl) return null;
                return {
                    videoUrl: foundUrl,
                    kwikUrl: kwikLink,
                    fansub: meta.fansub,
                    resolution: meta.resolution,
                    audio: meta.audio,
                    quality: meta.quality,
                    isActive: meta.isActive,
                    fullText: meta.fullText,
                };
            } finally {
                await kp.close().catch(() => {});
            }
        }

        if (optionMeta.length > 0) {
            console.log(`[PAHE] Found ${optionMeta.length} quality buttons`);
            // Resolve each kwik embed sequentially — running 6 puppeteer tabs in
            // parallel was causing some kwik pages to time out and the whole batch
            // to come back empty for shows like Naruto.
            const resolved = [];
            for (const m of optionMeta) {
                const r = await resolveKwikStream(m.kwikUrl, m).catch((e) => {
                    console.log(`[KWIK ERR] ${m.kwikUrl}: ${e.message}`);
                    return null;
                });
                if (r) resolved.push(r);
            }
            // Sort highest resolution first.
            resolved.sort((a, b) => {
                const ra = parseInt(String(a.resolution).match(/\d+/)?.[0] || '0', 10);
                const rb = parseInt(String(b.resolution).match(/\d+/)?.[0] || '0', 10);
                return rb - ra;
            });
            await page.close().catch(() => {});
            if (resolved.length > 0) {
                return res.json({
                    status: 'ok',
                    options: resolved,
                    videoUrl: resolved[0].videoUrl,
                    kwikUrl: resolved[0].kwikUrl,
                });
            }
        }

        // Fallback: legacy single-quality flow.
        const kwikUrl = await page.evaluate(() => {
            const btn = document.querySelector('#resolutionMenu button[data-src], button.dropdown-item[data-src]');
            return btn ? btn.getAttribute('data-src') : '';
        }).catch(() => '');

        if (kwikUrl) {
            console.log(`[KWIK] ${kwikUrl}`);
            const kwikPage = await br.newPage();
            await kwikPage.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36');
            await kwikPage.setExtraHTTPHeaders({ 'Referer': 'https://animepahe.pw/' });

            const kwikClient = await kwikPage.target().createCDPSession();
            await kwikClient.send('Network.enable');
            kwikClient.on('Network.requestWillBeSent', (params) => {
                const u = params.request.url;
                if (!videoUrl && u.includes('.m3u8')) { console.log(`[HLS] ${u}`); videoUrl = u; }
                if (!videoUrl && u.match(/\.mp4(\?|$)/) && !u.includes('thumb')) { console.log(`[MP4] ${u}`); videoUrl = u; }
            });
            await kwikPage.goto(kwikUrl, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});

            // Poll for the video URL instead of fixed wait
            const start = Date.now();
            while (!videoUrl && Date.now() - start < 8000) {
                await new Promise(r => setTimeout(r, 200));
            }

            if (!videoUrl) {
                const src = await kwikPage.evaluate(() => {
                    const v = document.querySelector('video');
                    if (v) return v.src || v.currentSrc || '';
                    return '';
                }).catch(() => '');
                if (src) videoUrl = src;
            }
            await kwikPage.close().catch(() => {});
        }

        await page.close().catch(() => {});

        if (videoUrl) {
            res.json({ status: 'ok', videoUrl, kwikUrl });
        } else {
            console.log('[PAHE] All URLs:');
            allUrls.filter(u => !u.match(/\.(css|js|png|jpg|svg|woff|gif|ico)/)).slice(-20).forEach(u => console.log('  ' + u));
            res.status(404).json({ status: 'error', error: 'No video URL found', kwikUrl });
        }
    } catch (e) {
        console.error(`[PAHE ERROR] ${e.message}`);
        res.status(500).json({ status: 'error', error: e.message });
    }
});

// ── AniList TV Pairing ──────────────────────────────────────────────
// In-memory store: code → { token, createdAt }
const pairSessions = new Map();
const PAIR_TTL = 5 * 60 * 1000; // 5 min
const ANILIST_CLIENT_ID = '38692';

// Cleanup expired sessions every minute
setInterval(() => {
    const now = Date.now();
    for (const [code, s] of pairSessions) {
        if (now - s.createdAt > PAIR_TTL) pairSessions.delete(code);
    }
}, 60_000);

function generateCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I
    let code = '';
    for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
    return code;
}

// TV calls this to create a pairing session → returns { code }
app.get('/auth/pair', (req, res) => {
    let code;
    do { code = generateCode(); } while (pairSessions.has(code));
    pairSessions.set(code, { token: null, createdAt: Date.now() });
    console.log(`[PAIR] Created session ${code}`);
    res.json({ code });
});

// Phone opens this URL (from QR) → shows a page that handles the full OAuth flow client-side
app.get('/auth/login', (req, res) => {
    const code = req.query.code;
    if (!code || !pairSessions.has(code)) {
        return res.status(400).send('Invalid or expired pairing code.');
    }
    const serverOrigin = `${req.protocol || 'http'}://${req.headers.host}`;
    res.setHeader('Content-Type', 'text/html');
    res.send(`<!DOCTYPE html>
<html><head><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sozo TV Login</title>
<style>
  body { font-family: -apple-system, sans-serif; background: #141414; color: #e5e5e5;
         display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; padding: 20px; box-sizing: border-box; }
  .box { text-align: center; max-width: 420px; width: 100%; }
  h2 { color: #E50914; margin-bottom: 8px; }
  p { line-height: 1.5; }
  .ok { color: #4caf50; }
  .err { color: #E50914; }
  .btn { display: inline-block; background: #E50914; color: white; padding: 14px 32px; border-radius: 4px;
         font-size: 18px; font-weight: bold; text-decoration: none; margin-top: 16px; }
  .btn:hover { background: #c40812; }
  #token-section { display: none; margin-top: 20px; }
  textarea { width: 100%; height: 60px; background: #2a2a2a; border: 1px solid #555; color: white;
             border-radius: 4px; padding: 10px; font-size: 14px; resize: vertical; margin-top: 8px; }
  .submit-btn { background: #E50914; color: white; padding: 10px 24px; border: none; border-radius: 4px;
                font-size: 16px; cursor: pointer; margin-top: 8px; }
</style></head><body>
<div class="box">
  <div id="step1">
    <h2>Sozo TV Login</h2>
    <p>Pairing code: <strong style="color:#E50914;font-size:1.4em;letter-spacing:3px">${code}</strong></p>
    <a class="btn" href="https://anilist.co/api/v2/oauth/authorize?client_id=${ANILIST_CLIENT_ID}&response_type=token">Login with AniList</a>
    <p style="color:#808080;font-size:13px;margin-top:20px">After login, AniList shows your token on a page.<br>Copy it and paste below.</p>
  </div>
  <div id="token-section">
    <h2>Paste your token</h2>
    <p style="color:#808080;font-size:14px">After authorizing, AniList shows a page with your token. Copy the entire token and paste it here:</p>
    <textarea id="token-input" placeholder="Paste access token here..."></textarea>
    <br><button class="submit-btn" onclick="sendToken()">Send to TV</button>
    <p id="result"></p>
  </div>
  <div id="done" style="display:none">
    <h2 class="ok">Connected!</h2>
    <p>You can close this page and return to your TV.</p>
  </div>
</div>
<script>
// Show token input after clicking the AniList link
document.querySelector('.btn').addEventListener('click', function() {
  setTimeout(function() { document.getElementById('token-section').style.display = 'block'; }, 1000);
});
// Also check if we came back with a hash fragment (some flows)
if (window.location.hash.includes('access_token')) {
  var hash = window.location.hash.substring(1);
  var params = {};
  hash.split('&').forEach(function(p) { var kv = p.split('='); if(kv.length===2) params[kv[0]]=kv[1]; });
  if (params['access_token']) {
    document.getElementById('token-input').value = params['access_token'];
    document.getElementById('token-section').style.display = 'block';
    sendToken();
  }
}
function sendToken() {
  var raw = document.getElementById('token-input').value.trim();
  var token = raw;
  if (raw.includes('access_token=')) { token = raw.split('access_token=')[1].split('&')[0]; }
  if (!token || token.length < 20) {
    document.getElementById('result').innerHTML = '<span class="err">Token looks too short. Make sure you copied the full token.</span>';
    return;
  }
  document.getElementById('result').innerHTML = 'Sending...';
  fetch('${serverOrigin}/auth/complete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: '${code}', token: token })
  }).then(function(r) { return r.json(); }).then(function(d) {
    if (d.ok) {
      document.getElementById('token-section').style.display = 'none';
      document.getElementById('step1').style.display = 'none';
      document.getElementById('done').style.display = 'block';
    } else {
      document.getElementById('result').innerHTML = '<span class="err">' + (d.error||'Failed') + '</span>';
    }
  }).catch(function(e) {
    document.getElementById('result').innerHTML = '<span class="err">' + e.message + '</span>';
  });
}
</script></body></html>`);
});

// Phone's callback page POSTs the token here
app.post('/auth/complete', express.json(), (req, res) => {
    const { code, token } = req.body || {};
    if (!code || !token) return res.json({ ok: false, error: 'Missing code or token' });
    const session = pairSessions.get(code);
    if (!session) return res.json({ ok: false, error: 'Invalid or expired code' });
    session.token = token;
    console.log(`[PAIR] Token received for ${code} (${token.length} chars)`);
    res.json({ ok: true });
});

// TV polls this until token arrives
app.get('/auth/poll', (req, res) => {
    const code = req.query.code;
    if (!code) return res.json({ status: 'error', error: 'Missing code' });
    const session = pairSessions.get(code);
    if (!session) return res.json({ status: 'expired' });
    if (session.token) {
        const token = session.token;
        pairSessions.delete(code); // one-time use
        return res.json({ status: 'ok', token });
    }
    res.json({ status: 'waiting' });
});

// ── End pairing ─────────────────────────────────────────────────────

app.get('/extract', async (req, res) => {
    const url = req.query.url;
    if (!url) return res.status(400).json({ error: 'Missing url parameter' });

    try {
        const result = await extractVideoUrl(url);
        if (result) {
            res.json({ status: 'ok', videoUrl: result.videoUrl, subtitles: result.subtitles });
        } else {
            res.status(404).json({ status: 'error', error: 'No video URL found' });
        }
    } catch (e) {
        console.error(`[ERROR] ${e.message}`);
        res.status(500).json({ status: 'error', error: e.message });
    }
});

app.get('/health', (req, res) => {
    res.json({ status: 'ok', uptime: process.uptime() });
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Sozo Video Extractor running on port ${PORT}`);
});

process.on('SIGTERM', async () => {
    if (browser) await browser.close();
    process.exit(0);
});
