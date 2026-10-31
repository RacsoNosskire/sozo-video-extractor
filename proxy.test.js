// `npm test`. No Chrome needed: this covers proxy.js and pairing.js only.
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const express = require('express');
const proxy = require('./proxy');
const pairing = require('./pairing');

const { isBlockedIp, browserAllowed, checkTarget, fetchRetry } = proxy;

test('private, loopback and link-local addresses are blocked', () => {
    for (const ip of [
        '127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.40.88', '169.254.169.254', '0.0.0.0',
        '100.64.0.1', '224.0.0.1', '255.255.255.255', '::', '::1', 'fe80::1', 'fc00::1', 'fd7a:115c:a1e0::1', 'ff02::1',
        '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:192.168.0.1', '64:ff9b::a00:1', '2002:7f00:1::', '2001:db8::1', 'nonsense',
    ]) assert.equal(isBlockedIp(ip), true, ip);
});

test('public addresses pass', () => {
    for (const ip of ['1.1.1.1', '8.8.8.8', '172.15.0.1', '172.32.0.1', '100.63.0.1', '192.169.0.1', '2606:4700::1111', '::ffff:8.8.8.8', '64:ff9b::808:808', '2002:808:808::']) {
        assert.equal(isBlockedIp(ip), false, ip);
    }
});

test('targets: http(s) only, IP spellings normalised, no credentials', () => {
    assert.equal(checkTarget('https://cdn.example.com/a.m3u8').hostname, 'cdn.example.com');
    for (const url of ['data:text/plain,hi', 'file:///etc/passwd', 'ftp://example.com/', 'http://127.0.0.1/', 'http://2130706433/', 'http://0x7f.1/', 'http://[::1]/', 'http://[::ffff:7f00:1]/', 'http://u:p@example.com/', 'not a url', '']) {
        assert.throws(() => checkTarget(url), (e) => e.status === 403 || e.status === 400, url);
    }
});

test('browser gate', () => {
    for (const o of ['https://aniziq.zikso.org', 'http://localhost:8791', 'http://127.0.0.1:8791']) {
        assert.equal(browserAllowed(o, 'cross-site'), true, o);
        assert.equal(proxy.allowedOrigin(o), o);
    }
    assert.equal(browserAllowed(undefined, undefined), true); // native apps
    assert.equal(browserAllowed(undefined, 'same-origin'), true);
    assert.equal(browserAllowed(undefined, 'none'), true);
    assert.equal(browserAllowed(undefined, 'cross-site'), false);
    assert.equal(browserAllowed(undefined, 'same-site'), false);
    assert.equal(browserAllowed('https://evil.example', 'cross-site'), false);
    assert.equal(browserAllowed('null', undefined), false);
    assert.equal(proxy.allowedOrigin('https://evil.example'), null);
});

// A stand-in CDN on loopback. The tests treat only 10.0.0.0/8 as private, so it can be reached
// while a redirect to a "private" address still gets refused.
function upstream(t, routes) {
    return new Promise((resolve) => {
        const server = http.createServer((req, res) => (routes[req.url] || ((_, r) => { r.statusCode = 404; r.end(); }))(req, res));
        server.listen(0, '127.0.0.1', () => {
            t.after(() => { server.closeAllConnections(); server.close(); });
            resolve(`http://127.0.0.1:${server.address().port}`);
        });
    });
}
const opts = { blocked: (ip) => ip.startsWith('10.'), deadlineMs: 2000 };

test('redirects are followed and every hop is checked', async (t) => {
    const base = await upstream(t, {
        '/a': (_, r) => { r.writeHead(302, { Location: '/b' }); r.end(); },
        '/b': (_, r) => r.end('body'),
        '/evil': (_, r) => { r.writeHead(302, { Location: 'http://10.0.0.1/' }); r.end(); },
        '/data': (_, r) => { r.writeHead(302, { Location: 'data:text/plain,hi' }); r.end(); },
        '/loop': (_, r) => { r.writeHead(302, { Location: '/loop' }); r.end(); },
    });
    const ok = await fetchRetry(`${base}/a`, '', 100, opts);
    assert.equal(ok.body.toString(), 'body');
    assert.equal(ok.finalUrl, `${base}/b`);
    await assert.rejects(fetchRetry(`${base}/evil`, '', 100, opts), { status: 403 });
    await assert.rejects(fetchRetry(`${base}/data`, '', 100, opts), { status: 403 });
    await assert.rejects(fetchRetry(`${base}/loop`, '', 100, opts), /too many redirects/);
});

test('a name that resolves to a private address is refused', async () => {
    await assert.rejects(fetchRetry('http://localhost:9/', '', 100, { blocked: isBlockedIp, deadlineMs: 2000 }), { status: 403 });
});

test('size cap and timeout hold', async (t) => {
    const base = await upstream(t, {
        '/declared': (_, r) => { r.writeHead(200, { 'Content-Length': 1000 }); r.end(Buffer.alloc(1000)); },
        '/chunked': (_, r) => { r.write(Buffer.alloc(600)); r.end(Buffer.alloc(600)); },
        '/slow': () => {},
    });
    await assert.rejects(fetchRetry(`${base}/declared`, '', 100, opts), { status: 413 });
    await assert.rejects(fetchRetry(`${base}/chunked`, '', 1000, opts), { status: 413 });
    await assert.rejects(fetchRetry(`${base}/slow`, '', 100, { ...opts, deadlineMs: 200 }), { name: 'AbortError' });
});

test('retries the statuses CDNs burst with, then gives up', async (t) => {
    let calls = 0;
    const base = await upstream(t, {
        '/busy': (_, r) => { calls += 1; if (calls < 2) { r.statusCode = 503; return r.end(); } r.end('ok'); },
        '/gone': (_, r) => { r.statusCode = 404; r.end(); },
    });
    assert.equal((await fetchRetry(`${base}/busy`, '', 100, opts)).body.toString(), 'ok');
    await assert.rejects(fetchRetry(`${base}/gone`, '', 100, opts), /HTTP 404/);
});

function serve(t, mount) {
    return new Promise((resolve) => {
        const app = express();
        mount(app);
        const server = app.listen(0, '127.0.0.1', () => {
            t.after(() => { server.closeAllConnections(); server.close(); });
            resolve(`http://127.0.0.1:${server.address().port}`);
        });
    });
}

test('routes refuse foreign pages and private targets', async (t) => {
    const base = await serve(t, proxy.mount);
    const u = (s) => Buffer.from(s).toString('base64url');
    const page = `${base}/proxy/sub?u=${u('http://127.0.0.1:1/x')}&r=`;
    assert.equal((await fetch(page, { headers: { Origin: 'https://evil.example' } })).status, 403);
    assert.equal((await fetch(page, { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
    assert.equal((await fetch(page)).status, 403); // a native client passes the gate, a private target doesn't
});

test('links follow X-Forwarded-* and ignore junk', () => {
    const req = (headers) => ({ protocol: 'http', get: (h) => ({ host: '192.168.40.88:3232', ...headers })[h.toLowerCase()] });
    assert.equal(proxy.publicBase(req({})), 'http://192.168.40.88:3232');
    assert.equal(proxy.publicBase(req({
        'x-forwarded-proto': 'https', 'x-forwarded-host': 'aniziq.zikso.org', 'x-forwarded-prefix': '/x',
    })), 'https://aniziq.zikso.org/x');
    assert.equal(proxy.publicBase(req({
        'x-forwarded-proto': 'javascript', 'x-forwarded-host': 'a"b', 'x-forwarded-prefix': '/x"<',
    })), 'http://192.168.40.88:3232');
});

test('codes and secrets are random and the right shape', () => {
    const codes = new Set(Array.from({ length: 200 }, pairing.generateCode));
    assert.equal(codes.size, 200);
    for (const c of codes) assert.match(c, /^[A-HJ-NP-Z2-9]{8}$/);
    assert.match(pairing.generateSecret(), /^[0-9a-f]{64}$/);
});

test('the rate limit stops a client and not the next one', () => {
    const limit = pairing.rateLimit(2);
    const statuses = [];
    const run = (ip) => {
        let passed = false;
        const res = { status: (s) => { statuses.push(s); return res; }, json: () => {} };
        limit({ get: () => ip, socket: {} }, res, () => { passed = true; });
        return passed;
    };
    assert.deepEqual([run('a'), run('a'), run('a'), run('b')], [true, true, false, true]);
    assert.deepEqual(statuses, [429]);
});

test('login page keeps hostile strings out of the script', () => {
    const page = pairing.loginPage('ABCD2345', 'https://x/"</script><img>');
    assert.ok(!page.includes('</script><img>'));
});

test('pairing: QR flow end to end, and the secret guards the token', async (t) => {
    const base = await serve(t, pairing.mount);
    const poll = (code, secret) => fetch(`${base}/auth/poll?code=${code}`, { headers: secret ? { 'X-Device-Secret': secret } : {} });
    const complete = (code, token) => fetch(`${base}/auth/complete`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code, token }),
    }).then((r) => r.json());

    const { code, secret } = await (await fetch(`${base}/auth/pair`)).json();
    assert.ok(code && secret);
    assert.equal((await poll(code, secret).then((r) => r.json())).status, 'waiting');
    assert.equal((await poll(code)).status, 403);
    assert.equal((await poll(code, 'wrong')).status, 403);

    const page = await fetch(`${base}/auth/login?code=${code}`);
    assert.equal(page.status, 200);
    assert.ok((await page.text()).includes('/auth/complete'));
    assert.equal((await fetch(`${base}/auth/login?code=NOPE`)).status, 400);

    assert.equal((await complete('NOPE', 'x'.repeat(30))).ok, false);
    assert.equal((await complete(code, 'y'.repeat(5000))).ok, false);
    assert.equal((await complete(code, 'x'.repeat(30))).ok, true);
    assert.equal((await complete(code, 'z'.repeat(30))).ok, false); // no second token

    assert.equal((await poll(code, 'wrong')).status, 403); // knowing the code isn't enough
    assert.deepEqual(await poll(code, secret).then((r) => r.json()), { status: 'ok', token: 'x'.repeat(30) });
    assert.equal((await poll(code, secret).then((r) => r.json())).status, 'expired'); // one-time use
});

test('pairing: the session cap holds', async (t) => {
    const base = await serve(t, pairing.mount);
    const pair = (i) => fetch(`${base}/auth/pair`, { headers: { 'X-Real-IP': `c${Math.floor(i / 10)}` } });
    for (let i = 0; i < 100; i++) assert.equal((await pair(i)).status, 200);
    assert.equal((await pair(1000)).status, 429);
});
