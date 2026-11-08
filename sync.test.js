// `npm test`. sync.js: validation, merging, paging, pruning, the viewer cache, and /sync end to
// end against a stand-in AniList on loopback with a temporary SYNC_DIR. No network, no Chrome.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const express = require('express');
const proxy = require('./proxy');
const sync = require('./sync');

const { cleanEntry, mergeInto, changesSince, prune, emptyDoc, viewerLookup, anilistUrl, LIMITS } = sync;

// The wire example from the devices spec. desktop-rs's devsync tests use these two literals as
// they are, so a change here is a protocol change.
const REQUEST_FIXTURE = '{"v":1,"user":1001,"epoch":"9f2c4e1ab37d5e60","since":41,"changes":{"history":[{"id":21,"at":1762345678901,"data":{"title":"ONE PIECE","imageUrl":"https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx21.jpg","episode":1100,"totalEpisodes":1155,"positionMs":754000,"durationMs":1420000,"device":"pc"}}],"saved":[{"id":1535,"at":1762345600000,"deleted":true}],"hidden":[{"id":7,"at":1762345000000,"data":{"episode":4}}]}}';
const REPLY_FIXTURE = '{"v":1,"user":1001,"epoch":"9f2c4e1ab37d5e60","cursor":44,"more":false,"skipped":0,"changes":{"history":[{"id":21,"at":1762345678901,"data":{"title":"ONE PIECE","imageUrl":"https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx21.jpg","episode":1100,"totalEpisodes":1155,"positionMs":754000,"durationMs":1420000,"device":"pc"}}],"saved":[{"id":1535,"at":1762345600000,"deleted":true}],"hidden":[{"id":7,"at":1762345000000,"data":{"episode":4}}]}}';
const FIXTURE_NOW = 1762345679012;

const NOW = 1_800_000_000_000;
const DAY = 24 * 60 * 60 * 1000;
const TOK_A = 'tok-a-000000000000000000'; // device A of account 1001
const TOK_B = 'tok-b-000000000000000000'; // device B of account 1001
const TOK_C = 'tok-c-000000000000000000'; // account 3003

const watch = (id, at, extra = {}) => ({
    id, at, data: { title: `Show ${id}`, imageUrl: '', episode: 1, totalEpisodes: 12, positionMs: 1000, durationMs: 1440000, device: 'pc', ...extra },
});
const card = (id, at) => ({ id, at, data: { title: `Show ${id}`, imageUrl: '', subtitle: 'TV · 2024' } });
const ask = (user, epoch, since, changes = {}) => ({ v: 1, user, epoch, since, changes });

// A stand-in AniList on loopback: counts calls, knows three tokens, refuses the rest as AniList
// does (HTTP 400 "Invalid token"), and answers 500 while `down`.
async function standIn(t) {
    const ids = { [TOK_A]: 1001, [TOK_B]: 1001, [TOK_C]: 3003 };
    const anilist = { calls: 0, down: false };
    const server = http.createServer((req, res) => {
        req.resume();
        req.on('end', () => {
            anilist.calls += 1;
            res.setHeader('Content-Type', 'application/json');
            if (anilist.down) {
                res.statusCode = 500;
                return res.end('{}');
            }
            const id = ids[(req.headers.authorization || '').replace(/^Bearer /, '')];
            if (!id) {
                res.statusCode = 400;
                return res.end(JSON.stringify({ errors: [{ message: 'Invalid token', status: 400 }], data: null }));
            }
            res.end(JSON.stringify({ data: { Viewer: { id } } }));
        });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => { server.closeAllConnections(); server.close(); });
    anilist.url = `http://127.0.0.1:${server.address().port}/`;
    return anilist;
}

function tempDir(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aniziq-sync-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
}

// An app wired like server.js: CORS first, then /sync.
async function syncServer(t, opts) {
    const app = express();
    app.use(proxy.cors);
    const mounted = sync.mount(app, opts);
    const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    t.after(() => { server.closeAllConnections(); server.close(); });
    return { base: `http://127.0.0.1:${server.address().port}`, ...mounted };
}

const post = (base, token, body, headers = {}) => fetch(`${base}/sync`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
});
const call = async (...args) => {
    const r = await post(...args);
    return { status: r.status, headers: r.headers, body: await r.json() };
};
const readDoc = (dir, user) => JSON.parse(fs.readFileSync(path.join(dir, `${user}.json`), 'utf8'));

test('cleanEntry keeps what syncs and refuses what is malformed', () => {
    const tv = { title: 'ONE PIECE', imageUrl: 'https://s4.anilist.co/file/a.jpg', episode: 3, totalEpisodes: 0, positionMs: 1, durationMs: 2, device: 'tv' };
    assert.deepEqual(cleanEntry('history', { id: 21, at: 5, extra: 1, data: { ...tv, junk: true } }, NOW), { id: 21, at: 5, data: tv });
    const saved = { title: 'A', imageUrl: '', subtitle: 'TV', score: 87 };
    assert.deepEqual(cleanEntry('saved', { id: 1, at: 1, data: saved }, NOW), { id: 1, at: 1, data: saved });
    assert.deepEqual(cleanEntry('saved', { id: 1, at: 1, data: { title: 'A', score: null } }, NOW).data, { title: 'A', imageUrl: '', subtitle: '' });
    assert.deepEqual(cleanEntry('hidden', { id: 7, at: 1, data: { episode: 4 } }, NOW), { id: 7, at: 1, data: { episode: 4 } });

    assert.equal(cleanEntry('saved', { id: 1, at: 1, data: { title: 'x'.repeat(400), subtitle: 'y'.repeat(400) } }, NOW).data.title.length, 300);
    const emoji = cleanEntry('saved', { id: 1, at: 1, data: { title: '😀'.repeat(301) } }, NOW).data.title;
    assert.equal(Array.from(emoji).length, 300); // whole characters, no half surrogate
    // A lone surrogate, which the apps' JSON reader refuses, becomes U+FFFD, or spoils an image.
    const lone = { title: 'A\ud800B 😀', subtitle: '\udc00', imageUrl: 'https://s4.anilist.co/x\ud800' };
    assert.deepEqual(cleanEntry('saved', { id: 1, at: 1, data: lone }, NOW).data, { title: 'A�B 😀', imageUrl: '', subtitle: '�' });
    const history = cleanEntry('history', watch(1, 1, lone), NOW).data;
    assert.deepEqual([history.title, history.imageUrl], ['A�B 😀', '']);
    assert.equal(cleanEntry('history', watch(1, 1, { title: `${'x'.repeat(299)}\ud83d` }), NOW).data.title, `${'x'.repeat(299)}�`);
    const images = [
        'file:///etc/passwd', 'javascript:alert(1)', 'http://s4.anilist.co/a.jpg', 'https://evil.example/a.jpg',
        'https://s4.anilist.co.evil.example/a.jpg', `https://s4.anilist.co/${'a'.repeat(1000)}`, 42,
    ];
    for (const url of images) assert.equal(cleanEntry('history', watch(21, 1, { imageUrl: url }), NOW).data.imageUrl, '', String(url));
    assert.equal(cleanEntry('history', watch(21, 1, { device: 'phone' }), NOW).data.device, '');

    for (const id of [0, -1, 1.5, '21', 2 ** 31, null]) assert.equal(cleanEntry('history', watch(id, 1), NOW), null, `id ${id}`);
    for (const at of [-1, 1.5, '5', null, undefined]) assert.equal(cleanEntry('history', watch(1, at), NOW), null, `at ${at}`);
    const refused = [
        ['history', { id: 1, at: 1 }], ['history', { id: 1, at: 1, data: [] }], ['history', watch(1, 1, { title: '' })],
        ['history', watch(1, 1, { title: '   ' })], ['saved', { id: 1, at: 1, data: { subtitle: 'x' } }],
        ['history', watch(1, 1, { episode: 100001 })], ['history', watch(1, 1, { positionMs: -5 })],
        ['history', watch(1, 1, { durationMs: 172800001 })], ['saved', { id: 1, at: 1, data: { title: 'A', score: 101 } }],
        ['hidden', { id: 1, at: 1, data: { episode: 'x' } }], ['history', 'nope'], ['history', { ...watch(1, 1), deleted: 'yes' }],
    ];
    for (const [kind, e] of refused) assert.equal(cleanEntry(kind, e, NOW), null, JSON.stringify(e));

    assert.deepEqual(cleanEntry('saved', { id: 9, at: 3, deleted: true, data: { title: 'A' } }, NOW), { id: 9, at: 3, deleted: true });
    assert.equal(cleanEntry('hidden', { id: 9, at: NOW + 10 * 60_000, deleted: true }, NOW).at, NOW + 5 * 60_000);
    assert.equal(cleanEntry('history', watch(9, NOW + 60_000), NOW).at, NOW + 60_000);
});

test('mergeInto: the later at wins, ties keep the stored entry, and what lost is named', () => {
    const doc = emptyDoc(1001);
    assert.deepEqual(mergeInto(doc, { history: [watch(21, 100)] }, NOW), { changed: 1, skipped: 0, lost: [] });
    assert.equal(doc.rev, 1);
    const lost21 = { changed: 0, skipped: 0, lost: [{ kind: 'history', id: 21 }] };
    assert.deepEqual(mergeInto(doc, { history: [watch(21, 100, { episode: 9 })] }, NOW), lost21);
    assert.deepEqual(mergeInto(doc, { history: [watch(21, 99, { episode: 9 })] }, NOW), lost21);
    assert.deepEqual([doc.rev, doc.history[21].data.episode], [1, 1]);
    mergeInto(doc, { history: [watch(21, 101, { episode: 2 })] }, NOW);
    assert.deepEqual([doc.rev, doc.history[21].rev, doc.history[21].data.episode], [2, 2, 2]);

    mergeInto(doc, { saved: [card(5, 10)] }, NOW);
    mergeInto(doc, { saved: [{ id: 5, at: 11, deleted: true }] }, NOW);
    assert.deepEqual(doc.saved[5], { at: 11, rev: 4, deleted: true });
    assert.deepEqual(mergeInto(doc, { saved: [card(5, 10)] }, NOW).lost, [{ kind: 'saved', id: 5 }]); // older data loses to the tombstone
    assert.equal(doc.saved[5].deleted, true);
    mergeInto(doc, { saved: [card(5, 12)] }, NOW); // newer data beats it
    assert.deepEqual(doc.saved[5], { at: 12, rev: 5, data: card(5, 12).data });

    const batch = { history: [watch(1, 1), { id: 0, at: 1 }], hidden: [{ id: 2, at: 1, data: { episode: 1 } }], other: [1, 2] };
    assert.deepEqual(mergeInto(doc, batch, NOW), { changed: 2, skipped: 1, lost: [] });
    assert.deepEqual(mergeInto(doc, batch, NOW), { changed: 0, skipped: 1, lost: [{ kind: 'history', id: 1 }, { kind: 'hidden', id: 2 }] });
    assert.equal(doc.rev, 7);
});

test('changesSince pages in rev order', () => {
    const doc = emptyDoc(1001);
    mergeInto(doc, { history: [watch(1, 1), watch(2, 2)], saved: [card(3, 3), { id: 4, at: 4, deleted: true }], hidden: [{ id: 5, at: 5, data: { episode: 2 } }] }, NOW);
    const all = changesSince(doc, 0, 1000);
    assert.deepEqual([all.cursor, all.more], [5, false]);
    assert.deepEqual(all.changes.saved, [{ id: 3, at: 3, data: card(3, 3).data }, { id: 4, at: 4, deleted: true }]);
    assert.deepEqual(all.changes.hidden, [{ id: 5, at: 5, data: { episode: 2 } }]);

    const first = changesSince(doc, 0, 2);
    assert.deepEqual([first.more, first.cursor, first.changes.history.map((e) => e.id)], [true, 2, [1, 2]]);
    const second = changesSince(doc, first.cursor, 2);
    assert.deepEqual([second.more, second.cursor, second.changes.saved.map((e) => e.id)], [true, 4, [3, 4]]);
    const last = changesSince(doc, second.cursor, 2);
    assert.deepEqual([last.more, last.cursor, last.changes.hidden.map((e) => e.id)], [false, 5, [5]]);
    assert.deepEqual(changesSince(doc, 5, 2), { changes: { history: [], saved: [], hidden: [] }, cursor: 5, more: false });

    mergeInto(doc, { history: [watch(1, 9)] }, NOW); // a newer position comes out after the cursor
    assert.deepEqual(changesSince(doc, 5).changes.history.map((e) => e.id), [1]);
});

test('prune drops year-old tombstones, then trims the oldest entries over the cap', () => {
    const doc = emptyDoc(1001);
    mergeInto(doc, { saved: [{ id: 1, at: NOW - 366 * DAY, deleted: true }, { id: 2, at: NOW - 364 * DAY, deleted: true }, card(3, NOW - 900 * DAY)] }, NOW);
    assert.equal(prune(doc, NOW), 1);
    assert.deepEqual(Object.keys(doc.saved), ['2', '3']); // live entries stay however old

    const n = LIMITS.stored;
    const big = emptyDoc(1001);
    const live = Array.from({ length: n }, (_, i) => watch(i + 1, NOW - DAY + i));
    mergeInto(big, { history: [...live, { id: n + 1, at: NOW, deleted: true }, { id: n + 2, at: NOW - 5, deleted: true }] }, NOW);
    assert.equal(prune(big, NOW), 2);
    assert.equal(Object.keys(big.history).length, n);
    assert.ok(!big.history[n + 1] && !big.history[n + 2]); // tombstones go first
    mergeInto(big, { history: [watch(n + 3, NOW)] }, NOW);
    assert.equal(prune(big, NOW), 1);
    assert.ok(!big.history[1] && big.history[2] && big.history[n + 3]); // then the oldest live entry
});

test('viewerLookup: one AniList call per token, kept by hash, failures not kept', async () => {
    let t = 1_000_000;
    let mode = 'ok';
    const calls = [];
    const fetchImpl = async (url, init) => {
        calls.push(init.headers.Authorization);
        assert.deepEqual(JSON.parse(init.body), { query: 'query { Viewer { id } }' });
        if (mode === 'network') throw new TypeError('fetch failed');
        if (mode === '500') return new Response('<html>', { status: 500 });
        if (init.headers.Authorization === 'Bearer refused-token-000000000') {
            return new Response(JSON.stringify({ errors: [{ message: 'Invalid token', status: 400 }], data: null }), { status: 400 });
        }
        if (init.headers.Authorization === 'Bearer expired-token-000000000') return new Response('', { status: 401 });
        return new Response(JSON.stringify({ data: { Viewer: { id: 1001 } } }), { status: 200 });
    };
    const lookup = viewerLookup({ url: 'http://127.0.0.1:9/', fetchImpl, now: () => t });

    assert.equal(await lookup.idFor(TOK_A), 1001);
    assert.equal(await lookup.idFor(TOK_A), 1001);
    assert.equal(calls.length, 1);
    assert.deepEqual(await Promise.all([lookup.idFor(TOK_B), lookup.idFor(TOK_B)]), [1001, 1001]);
    assert.equal(calls.length, 2);

    await assert.rejects(lookup.idFor('refused-token-000000000'), { status: 401 });
    t += 59_000;
    await assert.rejects(lookup.idFor('refused-token-000000000'), { status: 401 });
    assert.equal(calls.length, 3);
    t += 2_000;
    await assert.rejects(lookup.idFor('refused-token-000000000'), { status: 401 });
    assert.equal(calls.length, 4);
    await assert.rejects(lookup.idFor('expired-token-000000000'), { status: 401 });
    await assert.rejects(lookup.idFor('expired-token-000000000'), { status: 401 });
    assert.equal(calls.length, 5);

    t = 1_000_000 + 10 * 60_000 + 1; // the id is kept 10 minutes
    assert.equal(await lookup.idFor(TOK_A), 1001);
    assert.equal(calls.length, 6);

    mode = '500';
    await assert.rejects(lookup.idFor(TOK_C), { status: 503 });
    mode = 'network';
    await assert.rejects(lookup.idFor(TOK_C), { status: 503 });
    mode = 'ok';
    assert.equal(await lookup.idFor(TOK_C), 1001);
    assert.equal(calls.length, 9);

    for (const key of lookup.cache.keys()) assert.match(key, /^[0-9a-f]{64}$/);
    assert.ok(!JSON.stringify([...lookup.cache]).includes('tok-'));
});

test('viewerLookup: at most 15 AniList calls a minute for unknown tokens; test tokens never go to AniList', async () => {
    let t = 0;
    let calls = 0;
    const fetchImpl = async () => {
        calls += 1;
        return new Response(JSON.stringify({ errors: [{ message: 'Invalid token' }] }), { status: 400 });
    };
    const lookup = viewerLookup({ url: 'http://127.0.0.1:9/', fetchImpl, now: () => t });
    for (let i = 0; i < 15; i++) await assert.rejects(lookup.idFor(`random-token-${i}-0000000000`), { status: 401 });
    await assert.rejects(lookup.idFor('random-token-15-0000000000'), { status: 503 });
    await assert.rejects(lookup.idFor('random-token-3-0000000000'), { status: 401 }); // cached refusals still answer
    assert.equal(calls, 15);
    t += 60_000;
    await assert.rejects(lookup.idFor('random-token-16-0000000000'), { status: 401 });
    assert.equal(calls, 16);

    const real = viewerLookup({ fetchImpl: async () => assert.fail('a fake- token was sent to AniList') });
    await assert.rejects(real.idFor('fake-tester-pc-0000001'), { status: 401 });
});

// AniList as viewerLookup asks it: `accountOf(token)` is the account, 0 a refusal. Counts calls.
function anilistFor(accountOf) {
    const anilist = { calls: 0 };
    anilist.fetchImpl = async (url, init) => {
        anilist.calls += 1;
        const id = accountOf(init.headers.Authorization.replace(/^Bearer /, ''));
        if (!id) return new Response(JSON.stringify({ errors: [{ message: 'Invalid token', status: 400 }], data: null }), { status: 400 });
        return new Response(JSON.stringify({ data: { Viewer: { id } } }), { status: 200 });
    };
    return anilist;
}
const junk = (i) => `made-up-token-${String(i).padStart(10, '0')}`;
// Someone else's real sign-ins: token `i` of account 7000 + `k`; rivals(accounts, n) is set `n` of
// them, two tokens each of accounts 7001 to 7000 + `accounts`.
const rival = (k, i) => `rival-${k}-token-${String(i).padStart(10, '0')}`;
const rivalAccount = (token) => (token.startsWith('rival-') ? 7000 + Number(token.split('-')[1]) : 0);
const rivals = (accounts, n = 0) => Array.from({ length: accounts }, (_, k) => [rival(k + 1, 2 * n), rival(k + 1, 2 * n + 1)]).flat();

// Spends this minute's 20 checks as someone holding `tokens` (2 per account, their ids run out)
// could: their re-checks, then 20 made-up tokens from junk(from). Returns what the made-up ones got.
async function spendMinute(lookup, tokens, from = 0) {
    for (const token of tokens) assert.equal(await lookup.idFor(token), rivalAccount(token));
    const flood = [];
    for (let i = from; i < from + 20; i++) flood.push(await lookup.idFor(junk(i)).catch((e) => e.status));
    return flood;
}

test('viewerLookup: made-up tokens get 15 checks a minute, so an account AniList vouched for is still checked', async (t) => {
    const log = t.mock.method(console, 'error', () => {});
    let now = NOW;
    const anilist = anilistFor((token) => ({ [TOK_A]: 1001, [TOK_C]: 3003 })[token] || 0);
    const lookup = viewerLookup({ url: 'http://127.0.0.1:9/', fetchImpl: anilist.fetchImpl, now: () => now });
    assert.equal(await lookup.idFor(TOK_A), 1001);
    now += 10 * 60_000 + 1_000; // its id has left the cache
    const flood = [];
    for (let i = 0; i < 20; i++) flood.push(await lookup.idFor(junk(i)).catch((e) => e.status));
    assert.deepEqual(flood, [...Array(15).fill(401), ...Array(5).fill(503)]);
    assert.equal(await lookup.idFor(TOK_A), 1001);
    await assert.rejects(lookup.idFor(TOK_C), { status: 503 }); // a token never seen waits for the flood to end
    assert.equal(anilist.calls, 17);
    const busy = "[SYNC] AniList sign-in checks over budget (15 this minute for tokens it hasn't vouched for): answering 503";
    assert.deepEqual(log.mock.calls.map((c) => c.arguments[0]), [busy]);
    now += 60_000; // the flood goes on, and the log says so once a minute
    for (let i = 20; i < 40; i++) await lookup.idFor(junk(i)).catch(() => {});
    assert.deepEqual(log.mock.calls.map((c) => c.arguments[0]), [busy, busy]);
});

test("viewerLookup: one account's tokens get 2 re-checks a minute, so many of them can't keep another account out", async (t) => {
    t.mock.method(console, 'error', () => {});
    let now = NOW;
    const own = (i) => `own-token-${String(i).padStart(14, '0')}`;
    const anilist = anilistFor((token) => (token === TOK_A ? 1001 : token.startsWith('own-token-') ? 2002 : 0));
    const lookup = viewerLookup({ url: 'http://127.0.0.1:9/', fetchImpl: anilist.fetchImpl, now: () => now });
    assert.equal(await lookup.idFor(TOK_A), 1001);
    for (let i = 0; i < 60; i++) {
        if (i && i % 12 === 0) now += 60_000; // 12 a minute fit the share for tokens not vouched for yet
        assert.equal(await lookup.idFor(own(i)), 2002);
    }
    const recheck = async () => {
        const out = [];
        for (let i = 0; i < 60; i++) out.push(await lookup.idFor(own(i)).catch((e) => e.status));
        return out;
    };
    now = NOW + 15 * 60_000; // every id has left the cache
    assert.deepEqual(await recheck(), Array(60).fill(2002)); // 2 ask AniList; the rest keep what it said, unasked
    for (let i = 0; i < 15; i++) await assert.rejects(lookup.idFor(junk(i)), { status: 401 });
    assert.equal(await lookup.idFor(TOK_A), 1001);
    assert.equal(anilist.calls, 1 + 60 + 2 + 15 + 1);
    now = NOW + 75 * 60_000; // over an hour since AniList vouched for the 58 it wasn't asked about again
    assert.deepEqual(await recheck(), [2002, 2002, ...Array(58).fill(503)]);
    assert.equal(anilist.calls, 1 + 60 + 2 + 15 + 1 + 2);
});

test('viewerLookup: three devices of one account re-checked in the same minute all keep their id', async (t) => {
    const log = t.mock.method(console, 'error', () => {});
    let now = NOW;
    const devices = [TOK_A, TOK_B, 'tok-tv-00000000000000000']; // the PC, the site and the TV
    const anilist = anilistFor((token) => (devices.includes(token) ? 1001 : 0));
    const lookup = viewerLookup({ url: 'http://127.0.0.1:9/', fetchImpl: anilist.fetchImpl, now: () => now });
    for (const [i, token] of devices.entries()) {
        now = NOW + i * 10_000;
        assert.equal(await lookup.idFor(token), 1001);
    }
    const again = [];
    for (const [i, token] of devices.entries()) {
        now = NOW + 10 * 60_000 + 1_000 + i * 10_000; // each one's next exchange after its id ran out
        again.push(await lookup.idFor(token).catch((e) => e.status));
    }
    assert.deepEqual(again, [1001, 1001, 1001]);
    assert.equal(anilist.calls, 3 + 2); // the account's 2 re-checks; the TV keeps what AniList said 10 minutes before
    assert.deepEqual(log.mock.calls, []); // nothing was refused
});

test("viewerLookup: real tokens of 3 or 4 other accounts and made-up ones can't turn the household's re-check into a 503", async (t) => {
    t.mock.method(console, 'error', () => {});
    for (const accounts of [3, 4]) {
        let now = NOW;
        const anilist = anilistFor((token) => (token === TOK_A ? 1001 : rivalAccount(token)));
        const lookup = viewerLookup({ url: 'http://127.0.0.1:9/', fetchImpl: anilist.fetchImpl, now: () => now });
        const theirs = rivals(accounts);
        for (const token of [TOK_A, ...theirs]) assert.ok(await lookup.idFor(token));
        now += 10 * 60_000 + 1_000; // every id has run out
        const calls = anilist.calls;
        const flood = await spendMinute(lookup, theirs);
        assert.deepEqual(flood, [...Array(20 - theirs.length).fill(401), ...Array(theirs.length).fill(503)]);
        assert.equal(await lookup.idFor(TOK_A), 1001, `${accounts} accounts`); // what AniList said 10 minutes before
        assert.equal(anilist.calls - calls, 20);
    }
});

test('viewerLookup: with no room for a check, an id stands until an hour after AniList last vouched for the token', async (t) => {
    t.mock.method(console, 'error', () => {});
    let now = NOW;
    const anilist = anilistFor((token) => (token === TOK_A ? 1001 : rivalAccount(token)));
    const lookup = viewerLookup({ url: 'http://127.0.0.1:9/', fetchImpl: anilist.fetchImpl, now: () => now });
    for (const token of [TOK_A, ...rivals(3, 0), ...rivals(3, 1)]) assert.ok(await lookup.idFor(token));
    now = NOW + 59 * 60_000;
    assert.deepEqual(await spendMinute(lookup, rivals(3, 0)), [...Array(14).fill(401), ...Array(6).fill(503)]);
    const calls = anilist.calls;
    assert.equal(await lookup.idFor(TOK_A), 1001); // vouched for 59 minutes ago
    now = NOW + 60 * 60_000 + 1_000;
    assert.deepEqual(await spendMinute(lookup, rivals(3, 1), 20), [...Array(14).fill(401), ...Array(6).fill(503)]);
    await assert.rejects(lookup.idFor(TOK_A), { status: 503 }); // 60 minutes and 1 s: the answer at 59 didn't renew it
    assert.equal(anilist.calls, calls + 20);
});

test('viewerLookup: what AniList vouched for is kept by hash, outlives cache.clear, goes on a refusal and follows SYNC_USERS', async (t) => {
    t.mock.method(console, 'error', () => {});
    let now = NOW;
    const revoked = new Set();
    const anilist = anilistFor((token) => (revoked.has(token) ? 0 : ({ [TOK_A]: 1001, [TOK_B]: 1001, [TOK_C]: 3003 })[token] || 0));
    const lookup = viewerLookup({ url: 'http://127.0.0.1:9/', fetchImpl: anilist.fetchImpl, now: () => now, allow: new Set([1001]) });
    assert.deepEqual([await lookup.idFor(TOK_A), await lookup.idFor(TOK_B), await lookup.idFor(TOK_C)], [1001, 1001, 3003]);
    assert.deepEqual([...lookup.known.values()], [{ id: 1001, at: NOW }, { id: 1001, at: NOW }]); // 3003 isn't in SYNC_USERS
    for (const key of lookup.known.keys()) assert.match(key, /^[0-9a-f]{64}$/);
    assert.ok(!JSON.stringify([...lookup.known]).includes('tok-'));

    revoked.add(TOK_B);
    now += 60_000;
    lookup.cache.clear(); // as at 1000 entries
    for (let i = 0; i < 15; i++) await assert.rejects(lookup.idFor(junk(i)), { status: 401 });
    assert.equal(await lookup.idFor(TOK_A), 1001);
    await assert.rejects(lookup.idFor(TOK_B), { status: 401 });
    await assert.rejects(lookup.idFor(TOK_C), { status: 503 }); // in with the made-up tokens
    assert.equal(lookup.known.size, 1);

    now += 61_000; // TOK_B's refusal has left the cache, and it is a token like any other now
    for (let i = 15; i < 30; i++) await assert.rejects(lookup.idFor(junk(i)), { status: 401 });
    await assert.rejects(lookup.idFor(TOK_B), { status: 503 });
});

test('viewerLookup: a token AniList refused is forgotten, so with no room for a check it gets no id', async (t) => {
    t.mock.method(console, 'error', () => {});
    let now = NOW;
    const revoked = new Set();
    const anilist = anilistFor((token) => (revoked.has(token) ? 0 : token === TOK_A || token === TOK_B ? 1001 : rivalAccount(token)));
    const lookup = viewerLookup({ url: 'http://127.0.0.1:9/', fetchImpl: anilist.fetchImpl, now: () => now });
    for (const token of [TOK_A, TOK_B, ...rivals(3)]) assert.ok(await lookup.idFor(token));
    revoked.add(TOK_B); // signed out on AniList
    now += 10 * 60_000 + 1_000;
    await assert.rejects(lookup.idFor(TOK_B), { status: 401 }); // there was room to ask
    now += 61_000; // the refusal has left the cache
    assert.deepEqual(await spendMinute(lookup, rivals(3)), [...Array(14).fill(401), ...Array(6).fill(503)]);
    await assert.rejects(lookup.idFor(TOK_B), { status: 503 }); // in with the made-up tokens
    assert.equal(await lookup.idFor(TOK_A), 1001); // vouched for 11 minutes ago and never refused
});

test("viewerLookup: while AniList fails, a token it vouched for isn't answered from memory", async (t) => {
    t.mock.method(console, 'error', () => {});
    let now = NOW;
    let failing = false;
    const anilist = anilistFor((token) => (token === TOK_A ? 1001 : 0));
    const fetchImpl = (url, init) => (failing ? Promise.resolve(new Response('slow down', { status: 429 })) : anilist.fetchImpl(url, init));
    const lookup = viewerLookup({ url: 'http://127.0.0.1:9/', fetchImpl, now: () => now });
    assert.equal(await lookup.idFor(TOK_A), 1001);
    failing = true; // and TOK_A may have been revoked meanwhile: nobody can tell
    now += 10 * 60_000 + 1_000;
    const got = [];
    for (let i = 0; i < 3; i++, now += 1_000) got.push(await lookup.idFor(TOK_A).catch((e) => e.status));
    assert.deepEqual(got, [503, 503, 503]); // the third finds its account's 2 checks used, and still no id
    failing = false;
    now += 61_000;
    assert.equal(await lookup.idFor(TOK_A), 1001); // AniList answers again
});

test('ANILIST_URL: AniList itself or a loopback stand-in, nothing else', () => {
    assert.equal(anilistUrl(undefined), 'https://graphql.anilist.co');
    assert.equal(anilistUrl('https://graphql.anilist.co/'), 'https://graphql.anilist.co');
    for (const u of ['http://127.0.0.1:3299/', 'http://localhost:3299', 'http://[::1]:3299/', 'http://127.0.0.2:1/x']) {
        assert.notEqual(anilistUrl(u), 'https://graphql.anilist.co', u);
    }
    const refused = [
        'http://graphql.anilist.co/', 'https://graphql.anilist.co/x', 'https://evil.example/', 'http://192.168.40.88:3299/',
        'http://10.0.2.2:3299/', 'http://u:p@127.0.0.1/', 'file:///x', 'nonsense', 'https://graphql.anilist.co.evil.example/',
    ];
    for (const u of refused) assert.equal(anilistUrl(u), 'https://graphql.anilist.co', u);
});

test('/sync end to end: push, pull, tombstones and the checks', async (t) => {
    const anilist = await standIn(t);
    const dir = tempDir(t);
    const { base, ready } = await syncServer(t, { dir, anilistUrl: anilist.url, now: () => NOW });
    const at = (n) => NOW - 10_000 + n; // recent: tombstones older than a year are pruned
    assert.equal(ready, true);

    assert.deepEqual((await call(base, null, ask(1001, '', 0))).body, { status: 'error', error: 'sign-in required' });
    const short = await post(base, null, ask(1001, '', 0), { Authorization: 'Bearer short' });
    assert.equal(short.status, 401);
    assert.equal(anilist.calls, 0);

    const a1 = await call(base, TOK_A, ask(1001, '', 0, { history: [watch(21, at(1000))], saved: [card(1535, at(1000))] }));
    assert.equal(a1.status, 200);
    assert.deepEqual([a1.body.v, a1.body.user, a1.body.cursor, a1.body.more, a1.body.skipped, a1.body.now], [1, 1001, 2, false, 0, NOW]);
    assert.match(a1.body.epoch, /^[0-9a-f]{16}$/);
    assert.deepEqual(a1.body.changes.history, [watch(21, at(1000))]); // accepted entries come back
    const { epoch } = a1.body;
    assert.ok(!fs.readFileSync(path.join(dir, '1001.json'), 'utf8').includes('tok-a'));
    assert.deepEqual(fs.readdirSync(dir), ['1001.json']); // no .tmp left behind

    const b1 = await call(base, TOK_B, ask(1001, '', 0));
    assert.deepEqual([b1.body.epoch, b1.body.cursor, b1.body.changes.history.length, b1.body.changes.saved.length], [epoch, 2, 1, 1]);

    const b2 = await call(base, TOK_B, ask(1001, epoch, 2, { saved: [{ id: 1535, at: at(2000), deleted: true }] }));
    assert.equal(b2.body.cursor, 3);
    const a2 = await call(base, TOK_A, ask(1001, epoch, 2));
    assert.deepEqual(a2.body.changes, { history: [], saved: [{ id: 1535, at: at(2000), deleted: true }], hidden: [] });

    // An older position from a device with a stale cursor loses, and it gets the stored one back.
    const a3 = await call(base, TOK_A, ask(1001, epoch, 0, { history: [watch(21, at(500), { episode: 7 })] }));
    assert.deepEqual(a3.body.changes.history, [watch(21, at(1000))]);
    assert.equal(a3.body.cursor, 3);
    // So does one with an up-to-date cursor (its clock runs behind); an older card gets the tombstone.
    const a4 = await call(base, TOK_A, ask(1001, epoch, 3, { history: [watch(21, at(500), { episode: 7 })], saved: [card(1535, at(1500))] }));
    assert.deepEqual(a4.body.changes, { history: [watch(21, at(1000))], saved: [{ id: 1535, at: at(2000), deleted: true }], hidden: [] });
    assert.equal(a4.body.cursor, 3);

    const before = fs.readFileSync(path.join(dir, '1001.json'), 'utf8');
    const wrongUser = await call(base, TOK_A, ask(2002, epoch, 0, { history: [watch(99, at(5000))] }));
    assert.equal(wrongUser.status, 409);
    assert.equal(fs.readFileSync(path.join(dir, '1001.json'), 'utf8'), before);

    const many = Array.from({ length: 501 }, (_, i) => card(i + 1, 1));
    assert.deepEqual((await call(base, TOK_A, ask(1001, epoch, 3, { saved: many }))).body, { status: 'error', error: 'too many changes' });
    const big = await call(base, TOK_A, JSON.stringify({ ...ask(1001, epoch, 3), pad: 'x'.repeat(1_100_000) }));
    assert.deepEqual([big.status, big.body], [413, { status: 'error', error: 'too large' }]);
    const garbled = await call(base, TOK_A, '{"v":1,');
    assert.deepEqual([garbled.status, garbled.body], [400, { status: 'error', error: 'bad json' }]);
    for (const body of [{ v: 2, user: 1001 }, { v: 1, user: '1001' }, { v: 1, user: 1001, since: -1 }, { v: 1, user: 1001, changes: { saved: {} } }, []]) {
        assert.equal((await call(base, TOK_A, body)).status, 400, JSON.stringify(body));
    }
    assert.equal(fs.readFileSync(path.join(dir, '1001.json'), 'utf8'), before);

    const refused = await call(base, 'unknown-token-000000000', ask(1001, '', 0));
    assert.deepEqual([refused.status, refused.body.error], [401, 'sign-in refused']);

    const skipped = await call(base, TOK_A, ask(1001, epoch, 3, { hidden: [{ id: 7, at: at(3000), data: { episode: 2 } }, { id: -7, at: 1 }] }));
    assert.deepEqual([skipped.body.skipped, skipped.body.cursor, skipped.body.changes.hidden.length], [1, 4, 1]);

    // A different epoch (a new server URL, a lost file) gets everything.
    const stranger = await call(base, TOK_A, ask(1001, 'ffffffffffffffff', 4));
    assert.deepEqual([stranger.body.epoch, stranger.body.cursor], [epoch, 4]);
    assert.deepEqual([stranger.body.changes.history.length, stranger.body.changes.saved.length, stranger.body.changes.hidden.length], [1, 1, 1]);
    // A cursor past the file's rev (a restored file) changes the epoch and gets everything too.
    const ahead = await call(base, TOK_A, ask(1001, epoch, 99));
    assert.notEqual(ahead.body.epoch, epoch);
    assert.equal(ahead.body.changes.history.length, 1);
    assert.equal(readDoc(dir, 1001).epoch, ahead.body.epoch);

    anilist.down = true;
    const down = await call(base, TOK_C, ask(3003, '', 0));
    assert.deepEqual([down.status, down.headers.get('retry-after'), down.body.status], [503, '30', 'error']);
    assert.ok(!fs.existsSync(path.join(dir, '3003.json')));
});

test('/sync: pages from other sites are refused, the dev web build gets CORS', async (t) => {
    const anilist = await standIn(t);
    const { base } = await syncServer(t, { dir: tempDir(t), anilistUrl: anilist.url });
    assert.deepEqual((await call(base, TOK_A, ask(1001, '', 0), { Origin: 'https://evil.example' })).body, { status: 'error', error: 'forbidden' });
    assert.equal((await post(base, TOK_A, ask(1001, '', 0), { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
    assert.equal(anilist.calls, 0);
    const dev = await post(base, TOK_A, ask(1001, '', 0), { Origin: 'http://localhost:8791' });
    assert.equal(dev.status, 200);
    assert.equal(dev.headers.get('access-control-allow-origin'), 'http://localhost:8791');
    const site = await post(base, TOK_A, ask(1001, '', 0), { Origin: 'https://aniziq.zikso.org', 'Sec-Fetch-Site': 'same-origin' });
    assert.equal(site.status, 200);
});

test('/sync: a lone surrogate sent as \\ud800 is stored and sent back as U+FFFD', async (t) => {
    const anilist = await standIn(t);
    const dir = tempDir(t);
    const { base } = await syncServer(t, { dir, anilistUrl: anilist.url, now: () => NOW });
    // JSON escapes as a hand-written request may send them; \ud83d\ude00 is a whole emoji.
    const saved = '{"id":5,"at":1,"data":{"title":"A\\ud800B \\ud83d\\ude00","subtitle":"\\udc00","imageUrl":"https://s4.anilist.co/x\\ud800"}}';
    const history = '{"id":21,"at":1,"data":{"title":"\\udfff","imageUrl":"https://s4.anilist.co/a.jpg","episode":1}}';
    const r = await post(base, TOK_A, `{"v":1,"user":1001,"epoch":"","since":0,"changes":{"saved":[${saved}],"history":[${history}]}}`);
    const text = await r.text();
    assert.equal(r.status, 200);
    const escaped = /\\ud[89a-f][0-9a-f]{2}/i;
    assert.doesNotMatch(text, escaped);
    assert.doesNotMatch(fs.readFileSync(path.join(dir, '1001.json'), 'utf8'), escaped);
    const { changes } = JSON.parse(text);
    assert.deepEqual(changes.saved[0].data, { title: 'A\uFFFDB 😀', imageUrl: '', subtitle: '\uFFFD' });
    assert.deepEqual([changes.history[0].data.title, changes.history[0].data.imageUrl], ['\uFFFD', 'https://s4.anilist.co/a.jpg']);
});

test('/sync: 60 requests a minute per client, X-Real-IP only from a trusted proxy', async (t) => {
    const anilist = await standIn(t);
    const behindNginx = await syncServer(t, { dir: tempDir(t), anilistUrl: anilist.url, trusted: '127.0.0.1' });
    const from = (base, ip) => post(base, null, ask(1001, '', 0), { 'X-Real-IP': ip });
    for (let i = 0; i < 60; i++) assert.equal((await from(behindNginx.base, '10.0.0.61')).status, 401);
    const limited = await from(behindNginx.base, '10.0.0.61');
    assert.deepEqual([limited.status, (await limited.json()).status], [429, 'error']);
    assert.equal((await from(behindNginx.base, '10.0.0.62')).status, 401);

    const direct = await syncServer(t, { dir: tempDir(t), anilistUrl: anilist.url, trusted: '' });
    for (let i = 0; i < 60; i++) assert.equal((await from(direct.base, `10.0.1.${i}`)).status, 401);
    assert.equal((await from(direct.base, '10.0.1.200')).status, 429); // rotating the header doesn't help
});

test('/sync: storage that cannot be used, the account cap and the allowlist', async (t) => {
    const anilist = await standIn(t);
    const dir = tempDir(t);
    const notADir = path.join(dir, 'file');
    fs.writeFileSync(notADir, 'x');
    const off = await syncServer(t, { dir: notADir, anilistUrl: anilist.url });
    assert.equal(off.ready, false);
    assert.deepEqual(await call(off.base, TOK_A, ask(1001, '', 0)).then((r) => [r.status, r.body]), [500, { status: 'error', error: 'storage unavailable' }]);
    assert.equal(anilist.calls, 0);

    const full = await syncServer(t, { dir: tempDir(t), anilistUrl: anilist.url, maxUsers: 1 });
    assert.equal((await call(full.base, TOK_A, ask(1001, '', 0))).status, 200);
    assert.deepEqual(await call(full.base, TOK_C, ask(3003, '', 0)).then((r) => [r.status, r.body]), [403, { status: 'error', error: 'sync is full' }]);
    assert.equal((await call(full.base, TOK_B, ask(1001, '', 0))).status, 200); // an account already there still syncs

    const only = await syncServer(t, { dir: tempDir(t), anilistUrl: anilist.url, allow: [1001] });
    assert.equal((await call(only.base, TOK_C, ask(3003, '', 0))).status, 403);
    assert.equal((await call(only.base, TOK_A, ask(1001, '', 0))).status, 200);
});

test('/sync: storage that fails says what in the log, and the reply names no file', async (t) => {
    const anilist = await standIn(t);
    const dir = tempDir(t);
    fs.mkdirSync(path.join(dir, '1001.json'));
    const { base } = await syncServer(t, { dir, anilistUrl: anilist.url });
    const errors = t.mock.method(console, 'error', () => {});
    assert.deepEqual(await call(base, TOK_A, ask(1001, '', 0)).then((r) => [r.status, r.body]), [500, { status: 'error', error: 'storage unavailable' }]);
    assert.deepEqual(errors.mock.calls.map((c) => c.arguments.join(' ')), ["[SYNC] 1001: can't read 1001.json (EISDIR)"]);
});

test('/sync: an unreadable account file is set aside and started again', async (t) => {
    const anilist = await standIn(t);
    const dir = tempDir(t);
    fs.writeFileSync(path.join(dir, '1001.json'), '{"v":1,"user":1001,');
    const { base } = await syncServer(t, { dir, anilistUrl: anilist.url });
    const r = await call(base, TOK_A, ask(1001, 'aaaaaaaaaaaaaaaa', 5, { history: [watch(21, 1)] }));
    assert.equal(r.status, 200);
    assert.notEqual(r.body.epoch, 'aaaaaaaaaaaaaaaa');
    assert.equal(r.body.cursor, 1);
    assert.equal(fs.readdirSync(dir).filter((n) => n.startsWith('1001.json.bad-')).length, 1);
    assert.equal(readDoc(dir, 1001).rev, 1);
});

test('/sync: an account file is flushed before it is renamed into place, and the folder after', async (t) => {
    const anilist = await standIn(t);
    const dir = tempDir(t);
    const { base } = await syncServer(t, { dir, anilistUrl: anilist.url });
    const events = [];
    const name = (p) => (path.resolve(p) === path.resolve(dir) ? 'folder' : p.endsWith('.tmp') ? 'tmp' : path.basename(p));
    const { open, rename } = fs.promises;
    t.mock.method(fs.promises, 'open', async (p, ...rest) => {
        const fh = await open(p, ...rest);
        const flush = fh.sync.bind(fh);
        fh.sync = () => flush().then(() => events.push(`sync ${name(p)}`), (e) => {
            events.push(`sync ${name(p)} ${e.code}`);
            throw e;
        });
        return fh;
    });
    t.mock.method(fs.promises, 'rename', async (from, to) => {
        await rename(from, to);
        events.push(`rename ${name(from)} ${name(to)}`);
    });
    assert.equal((await call(base, TOK_A, ask(1001, '', 0, { history: [watch(21, 1)] }))).status, 200);
    // Windows can't flush a folder (EPERM), which is all right.
    assert.deepEqual(events.map((e) => e.replace(/ EPERM$/, '')), ['sync tmp', 'rename tmp 1001.json', 'sync folder']);
    assert.deepEqual(fs.readdirSync(dir), ['1001.json']);
});

test('/sync: temporary files of writes that never finished are removed at start', (t) => {
    const dir = tempDir(t);
    const keep = ['1001.json', '1001.json.bad-1793906454024', 'notes.tmp'];
    for (const n of [...keep, '1001.json.1.dead.tmp', '2002.json.77.0a1b2c3d.tmp']) fs.writeFileSync(path.join(dir, n), '{"v":1,');
    const log = t.mock.method(console, 'log', () => {});
    sync.mount(express(), { dir });
    assert.deepEqual(fs.readdirSync(dir).sort(), keep.sort());
    assert.ok(log.mock.calls.some((c) => c.arguments[0] === '[SYNC] removed 2 temporary file(s) left by writes that never finished'));
});

test('/sync: parallel pushes for one account all land', async (t) => {
    const anilist = await standIn(t);
    const dir = tempDir(t);
    const { base } = await syncServer(t, { dir, anilistUrl: anilist.url });
    const replies = await Promise.all(Array.from({ length: 20 }, (_, i) => call(base, TOK_A, ask(1001, '', 0, { history: [watch(i + 1, 1)] }))));
    assert.ok(replies.every((r) => r.status === 200));
    const doc = readDoc(dir, 1001);
    assert.deepEqual([Object.keys(doc.history).length, doc.rev], [20, 20]);
    assert.equal(anilist.calls, 1);
});

test('the wire fixture: the shared request goes in and the shared reply comes out', async (t) => {
    const anilist = await standIn(t);
    const dir = tempDir(t);
    const start = { v: 1, user: 1001, epoch: '9f2c4e1ab37d5e60', rev: 41, updatedAt: FIXTURE_NOW - 1000, history: {}, saved: {}, hidden: {} };
    fs.writeFileSync(path.join(dir, '1001.json'), JSON.stringify(start));
    const { base } = await syncServer(t, { dir, anilistUrl: anilist.url, now: () => FIXTURE_NOW });
    const r = await call(base, TOK_A, REQUEST_FIXTURE);
    assert.equal(r.status, 200);
    const { now, ...reply } = r.body;
    assert.equal(now, FIXTURE_NOW); // the server's clock, which the shared fixture leaves out
    assert.deepEqual(reply, JSON.parse(REPLY_FIXTURE));
    const doc = readDoc(dir, 1001);
    assert.deepEqual([doc.rev, doc.history[21].rev, doc.saved[1535].rev, doc.hidden[7].rev, doc.updatedAt], [44, 42, 43, 44, FIXTURE_NOW]);
});
