const express = require('express');
const https = require('https');
const { allowedOrigin } = require('./proxy');
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

// The AniZiQ browser build (desktop-rs, trunk serve) calls this server from a web page. Other
// sites get no CORS headers, so they can't read an answer.
app.use((req, res, next) => {
    const origin = allowedOrigin(req.get('origin'));
    res.vary('Origin');
    if (origin) {
        res.set('Access-Control-Allow-Origin', origin);
        res.set('Access-Control-Allow-Headers', 'Content-Type, Range');
    }
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
});

let browser = null;

// --no-sandbox stays: Chrome's sandbox needs user namespaces, which Docker's default seccomp
// profile refuses even to a non-root user. --no-zygote goes with it.
async function getBrowser() {
    if (!browser || !browser.connected) {
        browser = await puppeteer.launch({
            headless: 'new',
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--disable-features=IsolateOrigins,site-per-process',
                '--no-first-run',
                '--no-zygote',
                '--autoplay-policy=no-user-gesture-required',
            ],
        });
    }
    return browser;
}

// Sessions go into animepahe.pw URLs; nothing but an id belongs there.
const paheId = (s) => typeof s === 'string' && /^[A-Za-z0-9-]{1,128}$/.test(s);

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
    if (!paheId(session)) return res.status(400).json({ error: 'Missing session parameter' });
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
    if (!paheId(session) || !paheId(epSession)) return res.status(400).json({ error: 'Missing session/ep' });
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

require('./pairing').mount(app);

// ── Miruro (AniList-native, browser-driven) ─────────────────────────
const { resolveMiruroStream } = require('./miruro');

app.get('/miruro/stream', async (req, res) => {
    const anilistId = req.query.anilistId;
    const ep = parseInt(req.query.ep, 10) || 1;
    const type = (req.query.type === 'dub') ? 'dub' : 'sub';
    if (!anilistId) return res.status(400).json({ status: 'error', error: 'Missing anilistId' });

    const overallTimeout = setTimeout(() => {
        if (!res.headersSent) res.status(504).json({ status: 'error', error: 'Extractor timeout' });
    }, 70000);
    res.on('finish', () => clearTimeout(overallTimeout));
    res.on('close', () => clearTimeout(overallTimeout));

    try {
        const br = await getBrowser();
        const result = await resolveMiruroStream(br, anilistId, ep, type);
        if (result && result.videoUrl) {
            res.json({
                status: 'ok',
                videoUrl: result.videoUrl,
                referer: result.referer,
                qualities: result.qualities || [],
                subtitles: result.subtitles || [],
                // Intro/outro of this exact video, seconds: [{kind:'op'|'ed', start, end}].
                skips: result.skips || [],
            });
        } else {
            res.status(404).json({ status: 'error', error: 'No stream found' });
        }
    } catch (e) {
        console.error(`[MIRURO ERROR] ${e.message}`);
        if (!res.headersSent) res.status(500).json({ status: 'error', error: e.message });
    }
});

// HLS proxy for the browser build (Referer, CORS, fake-header stripping).
require('./proxy').mount(app);

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
