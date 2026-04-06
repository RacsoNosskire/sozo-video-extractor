const express = require('express');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

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
