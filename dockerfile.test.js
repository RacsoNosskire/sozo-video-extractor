// `npm test`. The image copies its files one by one (Dockerfile), so a module server.js loads
// without a COPY line of its own would stop the container at start; and server.js listens only
// when node runs it directly, so that is what the image and `npm start` must do.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { createRequire } = require('module');

// `file` and every file of this folder it loads with require('./…'), theirs too, as found by
// reading the source.
function reached(file, seen = new Set()) {
    if (seen.has(file)) return seen;
    seen.add(file);
    const load = createRequire(file);
    for (const m of fs.readFileSync(file, 'utf8').matchAll(/require\(\s*['"](\.\.?\/[^'"]+)['"]\s*\)/g)) reached(load.resolve(m[1]), seen);
    return seen;
}

test('the Dockerfile copies every local module server.js loads, and the image runs server.js itself', () => {
    const lines = fs.readFileSync(path.join(__dirname, 'Dockerfile'), 'utf8').split(/\r?\n/).map((l) => l.trim());
    const copied = new Set(lines.flatMap((l) => {
        const m = /^COPY\s+(.+?)\s+\.\/$/.exec(l);
        return m ? m[1].split(/\s+/).filter((s) => !s.startsWith('--')) : [];
    }));
    const files = [...reached(path.join(__dirname, 'server.js'))].map((f) => path.relative(__dirname, f).split(path.sep).join('/'));
    assert.ok(files.includes('sync.js') && files.includes('pairing.js'), files.join(', ')); // the walk itself works
    for (const f of files) assert.ok(copied.has(f), `the Dockerfile has no COPY ${f} ./`);

    assert.ok(lines.includes('CMD ["node", "server.js"]'), 'the image runs node server.js');
    assert.equal(JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8')).scripts.start, 'node server.js');
});
