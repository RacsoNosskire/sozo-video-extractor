// `npm test`: dev/device.js against /sync and the fake AniList, all on loopback.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const device = require('./device');
const fake = require('./fake-anilist');
const sync = require('../sync');

test('device.js talks only to a local server', () => {
    assert.equal(device.localBase('http://127.0.0.1:3232/'), 'http://127.0.0.1:3232');
    assert.equal(device.localBase('http://localhost:3232'), 'http://localhost:3232');
    assert.equal(device.localBase('http://10.0.2.2:3232'), 'http://10.0.2.2:3232');
    const refused = ['http://192.168.40.88:3232', 'https://aniziq.zikso.org/x', 'https://127.0.0.1:3232', 'http://127.0.0.1.evil.example/', 'http://u:p@127.0.0.1/', 'nonsense'];
    for (const base of refused) assert.throws(() => device.localBase(base), /refusing/, base);
    assert.throws(() => device.changesFor('watch', ['21', 'x', '1', '2'], 'tv', 1), /ep must be a whole number/);
});

test('device.js pushes and pulls through /sync with a fake token', async (t) => {
    const anilist = await fake.start({ port: 0, log: () => {} });
    t.after(() => anilist.close());
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aniziq-sync-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const app = express();
    sync.mount(app, { dir, anilistUrl: anilist.url });
    const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    t.after(() => { server.closeAllConnections(); server.close(); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const token = 'fake-tester-unit-0000001';
    t.after(() => fs.rmSync(device.stateFile(base, token, 'tv'), { force: true }));
    const run = (...argv) => device.run(['--base', base, '--token', token, ...argv], { log: () => {} });

    const first = await run('pull');
    assert.match(first.epoch, /^[0-9a-f]{16}$/);
    assert.equal(first.cursor, 0);
    await run('watch', '21', '5', '600000', '1420000', 'Test');
    await run('save', '1535', 'Death', 'Note');
    const second = await run('pull');
    assert.deepEqual(second.changes.history.map((e) => [e.id, e.data.episode, e.data.positionMs, e.data.device, e.data.title]), [[21, 5, 600000, 'tv', 'Test']]);
    assert.equal(second.changes.saved[0].data.title, 'Death Note');
    await run('unsave', '1535');
    await run('hide', '21', '5');
    const third = await run('pull');
    assert.deepEqual(third.changes, { history: [], saved: [{ id: 1535, at: third.changes.saved[0].at, deleted: true }], hidden: [{ id: 21, at: third.changes.hidden[0].at, data: { episode: 5 } }] });
    await run('show', '21');
    assert.equal((await run('pull')).changes.hidden[0].deleted, true);

    assert.ok(!fs.readFileSync(path.join(dir, '1001.json'), 'utf8').includes(token));
    assert.ok(!fs.readFileSync(device.stateFile(base, token, 'tv'), 'utf8').includes(token));
    await assert.rejects(device.run(['--base', base, '--token', 'not-a-fake-token-0000000', 'pull'], { log: () => {} }), /--user is needed/);
    await assert.rejects(device.run(['--base', base, '--token', 'not-a-fake-token-0000000', '--user', '1001', 'pull'], { log: () => {} }), /HTTP 401/);
});
