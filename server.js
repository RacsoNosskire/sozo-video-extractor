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

// Search animepahe and return matching anime
app.get('/animepahe/search', async (req, res) => {
    const query = req.query.q;
    if (!query) return res.status(400).json({ error: 'Missing q parameter' });
    try {
        const br = await getBrowser();
        const page = await br.newPage();
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36');
        // Navigate to homepage first to solve DDoS-Guard
        console.log(`[PAHE] Loading homepage to solve DDoS-Guard`);
        await page.goto('https://animepahe.pw/', { waitUntil: 'networkidle2', timeout: 30000 });
        await new Promise(r => setTimeout(r, 3000));
        // Now call the search API
        console.log(`[PAHE] Searching: ${query}`);
        const result = await page.evaluate(async (q) => {
            const r = await fetch('/api?m=search&q=' + encodeURIComponent(q), {
                headers: { 'Accept': 'application/json' }
            });
            return await r.text();
        }, query);
        await page.close();
        try {
            const json = JSON.parse(result);
            res.json({ status: 'ok', data: json });
        } catch (e) {
            res.json({ status: 'error', error: 'Got HTML instead of JSON', preview: result.substring(0, 200) });
        }
    } catch (e) {
        res.status(500).json({ status: 'error', error: e.message });
    }
});

// Get episodes for an anime session
app.get('/animepahe/episodes', async (req, res) => {
    const session = req.query.session;
    if (!session) return res.status(400).json({ error: 'Missing session parameter' });
    try {
        const br = await getBrowser();
        const page = await br.newPage();
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36');
        await page.goto('https://animepahe.pw/', { waitUntil: 'networkidle2', timeout: 30000 });
        await new Promise(r => setTimeout(r, 3000));
        const result = await page.evaluate(async (s) => {
            const r = await fetch('/api?m=release&id=' + s + '&sort=episode_asc&page=1', {
                headers: { 'Accept': 'application/json' }
            });
            return await r.text();
        }, session);
        await page.close();
        try {
            res.json({ status: 'ok', data: JSON.parse(result) });
        } catch (e) {
            res.json({ status: 'error', error: 'Got HTML', preview: result.substring(0, 200) });
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
        console.log(`[PAHE] Loading play page: ${playUrl}`);
        await page.goto(playUrl, { waitUntil: 'networkidle2', timeout: 30000 });
        await new Promise(r => setTimeout(r, 5000));

        // Extract Kwik link from page
        const kwikUrl = await page.evaluate(() => {
            // Look for the resolution dropdown which has the kwik data-src
            const btn = document.querySelector('#resolutionMenu button[data-src], button.dropdown-item[data-src]');
            return btn ? btn.getAttribute('data-src') : '';
        }).catch(() => '');

        if (kwikUrl) {
            console.log(`[PAHE KWIK] ${kwikUrl}`);
            // Open kwik page
            const kwikPage = await br.newPage();
            await kwikPage.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36');
            await kwikPage.setExtraHTTPHeaders({ 'Referer': 'https://animepahe.pw/' });

            const kwikClient = await kwikPage.target().createCDPSession();
            await kwikClient.send('Network.enable');
            kwikClient.on('Network.requestWillBeSent', (params) => {
                const u = params.request.url;
                if (!videoUrl && u.includes('.m3u8')) { console.log(`[KWIK HLS] ${u}`); videoUrl = u; }
                if (!videoUrl && u.match(/\.mp4(\?|$)/) && !u.includes('thumb')) { console.log(`[KWIK MP4] ${u}`); videoUrl = u; }
            });
            await kwikPage.goto(kwikUrl, { waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});
            await new Promise(r => setTimeout(r, 5000));

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
