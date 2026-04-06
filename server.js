const express = require('express');
const puppeteer = require('puppeteer');

const app = express();
const PORT = process.env.PORT || 3232;

// Cache extracted URLs for 30 minutes
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

// Clean old cache entries every 10 minutes
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
                '--no-first-run',
                '--no-zygote',
                '--single-process',
                '--disable-extensions',
                '--autoplay-policy=no-user-gesture-required',
            ],
        });
    }
    return browser;
}

/**
 * Extract video URL from anigo.to or anikai.to watch page
 * The page loads a megaup.nl embed which fetches /media/ endpoint
 * that returns an encrypted token. The client JS decrypts it into a video URL.
 * We intercept the actual video request after decryption.
 */
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

        // Collect video-related URLs from network requests
        let videoUrl = '';
        let subtitles = [];

        page.on('request', (req) => {
            const url = req.url();
            // Catch HLS manifest
            if (url.includes('.m3u8')) {
                console.log(`[HLS] ${url}`);
                if (!videoUrl) videoUrl = url;
            }
            // Catch MP4 direct
            if (url.includes('.mp4') && !url.includes('thumb') && !url.includes('poster')) {
                console.log(`[MP4] ${url}`);
                if (!videoUrl) videoUrl = url;
            }
        });

        page.on('response', async (res) => {
            const url = res.url();
            // Catch the /media/ endpoint response and look for video source
            if (url.includes('/media/')) {
                try {
                    const json = await res.json();
                    console.log(`[MEDIA] status=${json.status} result=${String(json.result).substring(0, 50)}...`);
                } catch (e) {}
            }
            // Catch subtitle files
            if (url.includes('.vtt') && !url.includes('thumbnail')) {
                subtitles.push(url);
            }
        });

        await page.goto(watchUrl, { waitUntil: 'networkidle2', timeout: 20000 });

        // Wait for the server to auto-select and video to start loading
        // The page's JS will auto-play the first server
        await new Promise(r => setTimeout(r,3000));

        // If no video URL intercepted yet, try to get it from JWPlayer inside the iframe
        if (!videoUrl) {
            try {
                // Find the megaup iframe
                const frames = page.frames();
                for (const frame of frames) {
                    if (frame.url().includes('megaup')) {
                        console.log(`[FRAME] Found megaup frame: ${frame.url()}`);
                        // Wait for JWPlayer to initialize
                        const src = await frame.evaluate(() => {
                            return new Promise((resolve) => {
                                let attempts = 0;
                                const poll = setInterval(() => {
                                    attempts++;
                                    if (attempts > 20) { clearInterval(poll); resolve(''); return; }
                                    // Check JWPlayer
                                    if (typeof jwplayer !== 'undefined') {
                                        const p = jwplayer();
                                        if (p && p.getPlaylistItem) {
                                            const item = p.getPlaylistItem();
                                            if (item && item.file) {
                                                clearInterval(poll);
                                                resolve(item.file);
                                                return;
                                            }
                                        }
                                    }
                                    // Check video element
                                    const video = document.querySelector('video');
                                    if (video && video.src && video.src.startsWith('http')) {
                                        clearInterval(poll);
                                        resolve(video.src);
                                        return;
                                    }
                                    if (video && video.currentSrc && video.currentSrc.startsWith('http')) {
                                        clearInterval(poll);
                                        resolve(video.currentSrc);
                                        return;
                                    }
                                }, 500);
                            });
                        }).catch(() => '');

                        if (src) {
                            console.log(`[JWPLAYER] ${src}`);
                            videoUrl = src;
                        }
                        break;
                    }
                }
            } catch (e) {
                console.log(`[FRAME ERROR] ${e.message}`);
            }
        }

        // Last resort: wait longer and check network
        if (!videoUrl) {
            console.log('[WAITING] No video found yet, waiting 10 more seconds...');
            await new Promise(r => setTimeout(r,10000));
        }

        if (videoUrl) {
            const result = { videoUrl, subtitles };
            setCache(watchUrl, result);
            console.log(`[SUCCESS] ${videoUrl}`);
            return result;
        }

        console.log('[FAIL] No video URL found');
        return null;

    } finally {
        await page.close().catch(() => {});
    }
}

// API endpoint
app.get('/extract', async (req, res) => {
    const url = req.query.url;
    if (!url) {
        return res.status(400).json({ error: 'Missing url parameter' });
    }

    try {
        const result = await extractVideoUrl(url);
        if (result) {
            res.json({
                status: 'ok',
                videoUrl: result.videoUrl,
                subtitles: result.subtitles,
            });
        } else {
            res.status(404).json({ status: 'error', error: 'No video URL found' });
        }
    } catch (e) {
        console.error(`[ERROR] ${e.message}`);
        res.status(500).json({ status: 'error', error: e.message });
    }
});

// Health check
app.get('/health', (req, res) => {
    res.json({ status: 'ok', uptime: process.uptime() });
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Sozo Video Extractor running on port ${PORT}`);
});

// Graceful shutdown
process.on('SIGTERM', async () => {
    if (browser) await browser.close();
    process.exit(0);
});
