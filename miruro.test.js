// `npm test`. miruro.js against a fake browser and playlist check: no network, no Chrome.
const test = require('node:test');
const assert = require('node:assert');
const miruro = require('./miruro');

const { resolveMiruroStream, streamAnswer, audioOf, pickCandidates, lookups } = miruro;

const provider = (name, streams, extra = {}) => ({
    provider: name,
    servers: [{ server: 's1', headers: { Referer: 'https://ultracloud.cc/' }, streams }],
    subtitles: [],
    ...extra,
});
const hls = (url) => ({ format: 'hls', url });
const playOf = (tracks) => ({ tracks: Object.entries(tracks).map(([track, providers]) => ({ track, providers })) });
const SUBS = [{ file: 'https://cdn.example/en.vtt', format: 'vtt', label: 'English', language: 'en', default: true }];
const BOTH = playOf({
    ssub: [provider('icarus', [hls('https://cdn.example/sub.m3u8')], { subtitles: SUBS, intro: { start: 90, end: 180 } })],
    dub: [provider('icarus', [hls('https://cdn.example/dub.m3u8')])],
});
const SUB_ONLY = playOf({ ssub: [provider('icarus', [hls('https://cdn.example/sub.m3u8')], { subtitles: SUBS })] });

// A puppeteer browser whose page answers catalog paths from `answer(path)`; it counts pages.
function fakeBrowser(answer) {
    const browser = {
        pages: 0,
        async newPage() {
            browser.pages += 1;
            return {
                setUserAgent: async () => {},
                setRequestInterception: async () => {},
                on: () => {},
                goto: async () => {},
                cookies: async () => [{ name: 'cf_clearance', value: '1' }],
                evaluate: async (fn, path) => (path === undefined ? {} : answer(path)), // no path: window.env
                close: async () => {},
            };
        },
    };
    return browser;
}

// A catalog that knows `anilistId` and answers its play call with `play`.
const catalog = (anilistId, play) => fakeBrowser((path) => {
    if (path.startsWith('/api/v1/anime?')) return { status: 200, json: { data: [{ id: `m${anilistId}`, external_ids: { anilist: [anilistId] } }] } };
    if (path === `/api/v1/anime/m${anilistId}/episodes/1/play`) return play;
    return { status: 404, error: 'not found' };
});
const plays = { isPlaylist: async () => true };

test('audioOf: the versions with an HLS stream', () => {
    assert.deepEqual(audioOf(BOTH), ['sub', 'dub']);
    assert.deepEqual(audioOf(SUB_ONLY), ['sub']);
    assert.deepEqual(audioOf(playOf({ dub: [provider('icarus', [{ format: 'mp4', url: 'https://cdn.example/a.mp4' }])] })), []);
    assert.deepEqual(audioOf({}), []);
});

test('pickCandidates for dub: none without a dub track, icarus first with one', () => {
    assert.deepEqual(pickCandidates(SUB_ONLY, 'dub'), []);
    const play = playOf({ dub: [provider('zoro', [hls('https://cdn.example/z.m3u8')]), provider('icarus', [hls('https://cdn.example/i.m3u8')])] });
    assert.deepEqual(pickCandidates(play, 'dub').map((c) => c.provider), ['icarus', 'zoro']);
});

test('a missing dub comes with the subtitled stream, which is then cached', async () => {
    const browser = catalog(9001, { status: 200, json: SUB_ONLY });
    const r = await resolveMiruroStream(browser, 9001, 1, 'dub', plays);
    assert.equal(r.missing, true);
    assert.deepEqual(r.audio, ['sub']);
    assert.equal(r.fallback.type, 'sub');
    assert.match(r.fallback.videoUrl, /^https:\/\/s1\.keeply\.top\/.+\/pl\.m3u8$/);
    assert.equal(r.fallback.referer, 'https://www.miruro.tv/');
    assert.equal(r.fallback.subtitles[0].lang, 'English');

    const sub = await resolveMiruroStream(browser, 9001, 1, 'sub', plays);
    assert.equal(sub.videoUrl, r.fallback.videoUrl);
    assert.deepEqual(sub.audio, ['sub']);
    assert.equal(browser.pages, 1); // from the cache

    const unplayable = catalog(9002, { status: 200, json: SUB_ONLY });
    assert.deepEqual(await resolveMiruroStream(unplayable, 9002, 1, 'dub', { isPlaylist: async () => false }), { missing: true, audio: ['sub'], fallback: null });
});

test('a found episode says which versions it has, and a repeat comes from the cache', async () => {
    const browser = catalog(9003, { status: 200, json: BOTH });
    const r = await resolveMiruroStream(browser, 9003, 1, 'sub', plays);
    assert.match(r.videoUrl, /^https:\/\/s1\.keeply\.top\//);
    assert.deepEqual(r.audio, ['sub', 'dub']);
    assert.deepEqual(r.skips, [{ kind: 'op', start: 90, end: 180 }]);
    assert.equal(r.subtitles.length, 1);
    const again = await resolveMiruroStream(browser, 9003, 1, 'sub', plays);
    assert.deepEqual(again, r);
    assert.equal(browser.pages, 1);
});

test('source failures are sourceDown; a missing show or episode is null', async () => {
    const noPlaylist = await resolveMiruroStream(catalog(9004, { status: 200, json: BOTH }), 9004, 1, 'sub', { isPlaylist: async () => false });
    assert.deepEqual(noPlaylist, { sourceDown: true });
    const challenge = fakeBrowser(() => ({ status: 403, error: '<!DOCTYPE html>' }));
    assert.deepEqual(await resolveMiruroStream(challenge, 9005, 1, 'sub', plays), { sourceDown: true });
    const offline = fakeBrowser(() => ({ status: 0, error: 'Failed to fetch' }));
    assert.deepEqual(await resolveMiruroStream(offline, 9006, 1, 'sub', plays), { sourceDown: true });
    const elsewhere = fakeBrowser(() => ({ status: 200, json: { data: [{ id: 'x', external_ids: { anilist: [1] } }] } }));
    assert.equal(await resolveMiruroStream(elsewhere, 9007, 1, 'sub', plays), null);
    assert.equal(await resolveMiruroStream(catalog(9008, { status: 404, error: 'no episode' }), 9008, 1, 'sub', plays), null);
    assert.deepEqual(await resolveMiruroStream(catalog(9009, { status: 500, error: 'oops' }), 9009, 1, 'sub', plays), { sourceDown: true });
    assert.equal(await resolveMiruroStream(catalog(9010, { status: 200, json: { tracks: [] } }), 9010, 1, 'sub', plays), null);
});

test('streamAnswer: statuses, bodies and how each counts as a lookup', () => {
    const found = { videoUrl: 'https://s1.keeply.top/a/pl.m3u8', referer: 'https://www.miruro.tv/', qualities: [], subtitles: [], skips: [], audio: ['sub', 'dub'] };
    assert.deepEqual(streamAnswer(found, 'sub'), { status: 200, ok: true, body: { status: 'ok', ...found } });
    const fallback = { type: 'sub', ...found };
    assert.deepEqual(streamAnswer({ missing: true, audio: ['sub'], fallback }, 'dub'), {
        status: 404,
        ok: true,
        body: { status: 'error', error: 'No dub for this episode', reason: 'no_track', audio: ['sub'], fallback },
    });
    assert.equal(streamAnswer({ missing: true, audio: ['dub'], fallback: null }, 'sub').body.error, 'No subtitled version of this episode');
    assert.deepEqual(streamAnswer({ sourceDown: true }, 'sub'), {
        status: 502, ok: false, error: 'source_down', body: { status: 'error', error: 'The stream source is not answering', reason: 'source_down' },
    });
    assert.deepEqual(streamAnswer(null, 'sub'), { status: 404, ok: true, body: { status: 'error', error: 'No stream found', reason: 'not_found' } });
});

test('lookups keep times and an error word only', () => {
    assert.deepEqual(lookups.snapshot(), { lastOkAt: null, lastFailAt: null, lastError: null });
    const before = Date.now();
    lookups.note(true);
    assert.ok(lookups.snapshot().lastOkAt >= before);
    lookups.note(false, 'source_down');
    const s = lookups.snapshot();
    assert.ok(s.lastFailAt >= before);
    assert.equal(s.lastError, 'source_down');
    lookups.note(false, 'Something /secret/ happened');
    assert.equal(lookups.snapshot().lastError, 'error');
});
