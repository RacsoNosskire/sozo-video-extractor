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

function extractResolutionNumber(value) {
    const match = String(value || '').match(/(\d{3,4})p/i);
    return match ? Number(match[1]) : 0;
}

async function resolveKwikStream(br, kwikUrl, referer, meta = {}) {
    const page = await br.newPage();
    let videoUrl = '';

    try {
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36');
        await page.setExtraHTTPHeaders({ Referer: referer });

        const client = await page.target().createCDPSession();
        await client.send('Network.enable');
        client.on('Network.requestWillBeSent', (params) => {
            const u = params.request.url;
            if (!videoUrl && u.includes('.m3u8')) videoUrl = u;
            if (!videoUrl && u.match(/\.mp4(\?|$)/) && !u.includes('thumb')) videoUrl = u;
        });

        await page.goto(kwikUrl, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});

        const start = Date.now();
        while (!videoUrl && Date.now() - start < 8000) {
            await new Promise(r => setTimeout(r, 200));
        }

        if (!videoUrl) {
            const src = await page.evaluate(() => {
                const v = document.querySelector('video');
                if (v) return v.src || v.currentSrc || '';
                return '';
            }).catch(() => '');
            if (src) videoUrl = src;
        }

        if (!videoUrl) return null;

        // Kwik's own page auto-plays the m3u8 in a <video> element. That media fetch
        // goes through Chromium's network stack and triggers Cloudflare's challenge for
        // the segment host (owocdn.top), which Chromium solves and stores cf_clearance.
        // Wait long enough for the video element to actually start loading segments,
        // then harvest cookies for the segment host from this same page.
        let segmentCookies = '';
        try {
            // Make sure kwik's player actually starts. Try clicking play in case autoplay
            // is blocked, and wait for any owocdn segment fetches to complete.
            await page.evaluate(() => {
                const v = document.querySelector('video');
                if (v) { v.muted = true; v.play().catch(() => {}); }
            }).catch(() => {});
            // Poll until cf_clearance for the segment host shows up, up to 12s.
            for (let i = 0; i < 24; i++) {
                const cs = await page.cookies(videoUrl);
                if (cs.some(c => c.name === 'cf_clearance')) break;
                await new Promise(r => setTimeout(r, 500));
            }
            const cookies = await page.cookies(videoUrl);
            segmentCookies = cookies.map(c => `${c.name}=${c.value}`).join('; ');
            console.log(`[KWIK] Got ${cookies.length} cookies for ${new URL(videoUrl).host}: ${cookies.map(c => c.name).join(',')}`);
        } catch (e) {
            console.log(`[KWIK] Cookie harvest failed: ${e.message}`);
        }

        return {
            videoUrl,
            kwikUrl,
            cookies: segmentCookies,
            resolution: meta.resolution || 'Auto',
            fansub: meta.fansub || 'AnimePahe',
            audio: meta.audio || 'jpn',
            quality: meta.quality || '',
            fullText: meta.fullText || meta.resolution || 'AnimePahe Stream',
            isActive: Boolean(meta.isActive),
        };
    } finally {
        await page.close().catch(() => {});
    }
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
    if (!session) return res.status(400).json({ error: 'Missing session parameter' });
    try {
        console.log(`[PAHE] Episodes: ${session}`);
        const body = await paheApiCall(`/api?m=release&id=${session}&sort=episode_asc&page=1`);
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
        await page.goto(playUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await new Promise(r => setTimeout(r, 1500));

        const optionMeta = await page.evaluate(() => {
            return Array.from(document.querySelectorAll('#resolutionMenu button[data-src], button.dropdown-item[data-src]')).map((button) => {
                const badges = Array.from(button.querySelectorAll('span.badge')).map((el) => el.textContent?.trim()).filter(Boolean);
                return {
                    kwikUrl: button.getAttribute('data-src') || '',
                    fansub: button.getAttribute('data-fansub') || 'AnimePahe',
                    resolution: button.getAttribute('data-resolution') || '',
                    audio: button.getAttribute('data-audio') || 'jpn',
                    quality: badges.find((text) => /BD|WEB|DVD/i.test(text || '')) || '',
                    isActive: button.classList.contains('active'),
                    fullText: (button.textContent || '').trim(),
                };
            }).filter((item) => item.kwikUrl);
        }).catch(() => []);

        if (optionMeta.length > 0) {
            console.log(`[PAHE] Found ${optionMeta.length} quality buttons`);
            const seen = new Set();
            const options = [];
            for (const meta of optionMeta.sort((a, b) => extractResolutionNumber(b.resolution) - extractResolutionNumber(a.resolution))) {
                if (seen.has(meta.kwikUrl)) continue;
                seen.add(meta.kwikUrl);
                const resolved = await resolveKwikStream(br, meta.kwikUrl, 'https://animepahe.pw/', meta).catch(() => null);
                if (resolved) options.push(resolved);
            }

            await page.close().catch(() => {});

            if (options.length > 0) {
                return res.json({
                    status: 'ok',
                    options,
                    videoUrl: options[0].videoUrl,
                    kwikUrl: options[0].kwikUrl,
                });
            }
        }

        // Extract Kwik link from page
        const kwikUrl = await page.evaluate(() => {
            const btn = document.querySelector('#resolutionMenu button[data-src], button.dropdown-item[data-src]');
            return btn ? btn.getAttribute('data-src') : '';
        }).catch(() => '');

        if (kwikUrl) {
            console.log(`[KWIK] ${kwikUrl}`);
            const resolved = await resolveKwikStream(br, kwikUrl, 'https://animepahe.pw/', {
                fansub: 'AnimePahe',
                resolution: 'Auto',
                audio: 'jpn',
                quality: 'Auto',
                isActive: true,
                fullText: 'AnimePahe Stream',
            }).catch(() => null);
            if (resolved?.videoUrl) videoUrl = resolved.videoUrl;
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
