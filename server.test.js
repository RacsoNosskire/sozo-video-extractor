// `npm test`. server.js as the image runs it, with Puppeteer and miruro's lookup stubbed through
// the require cache: /health, CORS before /sync, /miruro/stream's answers and its 504, and which
// routes log an ignored X-Real-IP. No network, no Chrome.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const Module = require('module');

// A package server.js loads, answered from the require cache with `exports`.
function stub(name, exports) {
    const file = require.resolve(name);
    const m = new Module(file, module);
    m.filename = file;
    m.loaded = true;
    m.exports = exports;
    require.cache[file] = m;
}

const browser = { connected: true, close: async () => {} };
stub('puppeteer-extra', { use() {}, launch: async () => browser });
stub('puppeteer-extra-plugin-stealth', () => ({}));

// The lookup each test sets; streamAnswer and lookups stay miruro.js's own.
const miruro = require('./miruro');
let lookup = async () => null;
miruro.resolveMiruroStream = (...args) => lookup(...args);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aniziq-server-'));
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
process.env.SYNC_DIR = dir;
delete process.env.TRUSTED_PROXIES;
// Only `node server.js` listens. A listen() while it loads is caught here instead of taking a port.
const listens = test.mock.method(http.Server.prototype, 'listen', function () { return this; });
const { app } = require('./server');
listens.mock.restore();

async function listen(t) {
    const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    t.after(() => { server.closeAllConnections(); server.close(); });
    return `http://127.0.0.1:${server.address().port}`;
}

const FOUND = { videoUrl: 'https://s1.keeply.top/a/pl.m3u8', referer: 'https://www.miruro.tv/', qualities: [], subtitles: [], skips: [], audio: ['sub', 'dub'] };
const health = async (base) => (await fetch(`${base}/health`)).json();

test('loading server.js builds the app and listens nowhere', () => {
    assert.equal(listens.mock.callCount(), 0);
    assert.equal(typeof app.handle, 'function');
});

test('/health: 200, status ok, never cached, with the lookups and whether sync can store', async (t) => {
    const base = await listen(t);
    const r = await fetch(`${base}/health`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('cache-control'), 'no-store');
    const body = await r.json();
    assert.deepEqual([body.status, body.sync], ['ok', 'ok']); // old apps' Test needs status "ok"
    assert.ok(Number.isFinite(body.uptime) && Math.abs(body.now - Date.now()) < 60_000);
    assert.deepEqual(Object.keys(body.lookups), ['lastOkAt', 'lastFailAt', 'lastError']);
});

test("CORS: the dev web build's preflight for /sync gets its headers", async (t) => {
    const base = await listen(t);
    const r = await fetch(`${base}/sync`, {
        method: 'OPTIONS',
        headers: { Origin: 'http://localhost:8791', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type' },
    });
    assert.equal(r.status, 204);
    assert.equal(r.headers.get('access-control-allow-origin'), 'http://localhost:8791');
    assert.match(r.headers.get('access-control-allow-headers'), /\bAuthorization\b/);
});

test('/miruro/stream: what the lookup found, and a request without anilistId', async (t) => {
    const base = await listen(t);
    const asked = [];
    lookup = async (...args) => {
        asked.push(args);
        return FOUND;
    };
    const before = Date.now();
    const r = await fetch(`${base}/miruro/stream?anilistId=21&ep=5&type=dub`);
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { status: 'ok', ...FOUND });
    assert.deepEqual(asked, [[browser, '21', 5, 'dub']]);
    assert.ok((await health(base)).lookups.lastOkAt >= before);
    const missing = await fetch(`${base}/miruro/stream?ep=1`);
    assert.deepEqual([missing.status, await missing.json()], [400, { status: 'error', error: 'Missing anilistId' }]);
});

test('/miruro/stream: no answer within 70 s is one 504, and a lookup that ends later is still noted', async (t) => {
    const base = await listen(t);
    const note = t.mock.method(miruro.lookups, 'note');
    const errors = t.mock.method(console, 'error', () => {});
    let finish;
    let started;
    const called = new Promise((resolve) => { started = resolve; });
    lookup = () => {
        started();
        return new Promise((resolve) => { finish = resolve; });
    };
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const reply = fetch(`${base}/miruro/stream?anilistId=21&ep=1`);
    await called;
    t.mock.timers.tick(70_000);
    const r = await reply;
    assert.equal(r.status, 504);
    assert.deepEqual(await r.json(), { status: 'error', error: 'Extractor timeout', reason: 'timeout' });
    assert.equal((await health(base)).lookups.lastError, 'timeout');

    finish(FOUND); // the answer comes after the 504 went out: noted, not sent
    for (let i = 0; i < 100 && note.mock.callCount() < 2; i++) await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(note.mock.calls.map((c) => c.arguments), [[false, 'timeout'], [true, undefined]]);
    assert.equal((await health(base)).lookups.lastError, 'timeout');
    assert.deepEqual(errors.mock.calls, []);
});

test('[TRUST]: an ignored X-Real-IP is logged by the rate-limited routes, not by /health or /miruro/stream', async (t) => {
    const base = await listen(t);
    const log = t.mock.method(console, 'log', () => {});
    const trust = () => log.mock.calls.map((c) => c.arguments.join(' ')).filter((line) => line.startsWith('[TRUST]'));
    const nginx = { 'X-Real-IP': '192.168.40.31' };
    lookup = async () => null;
    await (await fetch(`${base}/health`, { headers: nginx })).arrayBuffer();
    await (await fetch(`${base}/miruro/stream?anilistId=21&ep=1`, { headers: nginx })).arrayBuffer();
    assert.deepEqual(trust(), []);
    await (await fetch(`${base}/auth/pair`, { headers: nginx })).arrayBuffer();
    assert.deepEqual(trust(), ['[TRUST] X-Real-IP from 127.0.0.1 ignored (not in TRUSTED_PROXIES)']);
});
