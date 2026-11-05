// A third device for checking device sync by hand. It talks to a LOCAL /sync only (127.0.0.1,
// localhost or 10.0.2.2), never the live server, and keeps its epoch and cursor in the temp folder
// (never the token). See README.md, "Device CLI".
//
//   node dev/device.js [--base http://127.0.0.1:3232] [--token fake-tester-device-001]
//                      [--user <id>] [--device tv|pc|web] [--since <n>] <command>

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { viewerFor } = require('./fake-anilist');

const LOCAL = new Set(['127.0.0.1', 'localhost', '10.0.2.2']);
const DEFAULT_TOKEN = 'fake-tester-device-001';
const USAGE = `node dev/device.js [--base http://127.0.0.1:3232] [--token ${DEFAULT_TOKEN}] [--user <id>]
                   [--device tv|pc|web] [--since <n>] <command>
  pull                                      what changed since this device's last pull (its own pushes too)
  watch <id> <ep> <posMs> <durMs> [title]   a watch position
  save <id> <title>                         add to Saved
  unsave <id>                               remove from Saved
  hide <id> <ep>                            take off Continue Watching
  show <id>                                 put back on Continue Watching
--user defaults to the fake AniList's viewer for the token; --device to tv.`;

// The base of a local server, or an Error for anything else.
function localBase(text) {
    let url = null;
    try {
        url = new URL(text);
    } catch { /* refused below */ }
    if (!url || url.protocol !== 'http:' || !LOCAL.has(url.hostname) || url.username || url.password || url.search || url.hash) {
        throw new Error(`refusing ${text}: only http://127.0.0.1, localhost or 10.0.2.2, never the live server`);
    }
    return url.href.replace(/\/+$/, '');
}

function whole(value, name) {
    const n = Number(value);
    if (value === undefined || !Number.isSafeInteger(n) || n < 0) throw new Error(`${name} must be a whole number, got ${value}`);
    return n;
}

function changesFor(command, args, device, at) {
    const id = () => whole(args[0], 'id');
    switch (command) {
        case 'pull':
            return {};
        case 'watch': {
            const [, ep, pos, dur] = args;
            const data = {
                title: args.slice(4).join(' ') || `Anime ${args[0]}`,
                imageUrl: '',
                episode: whole(ep, 'ep'),
                totalEpisodes: 0,
                positionMs: whole(pos, 'posMs'),
                durationMs: whole(dur, 'durMs'),
                device,
            };
            return { history: [{ id: id(), at, data }] };
        }
        case 'save':
            if (args.length < 2) throw new Error('save <id> <title>');
            return { saved: [{ id: id(), at, data: { title: args.slice(1).join(' '), imageUrl: '', subtitle: '' } }] };
        case 'unsave':
            return { saved: [{ id: id(), at, deleted: true }] };
        case 'hide':
            return { hidden: [{ id: id(), at, data: { episode: whole(args[1], 'ep') } }] };
        case 'show':
            return { hidden: [{ id: id(), at, deleted: true }] };
        default:
            throw new Error(`unknown command ${command}\n${USAGE}`);
    }
}

// Where this device (server, token, kind) keeps its epoch and cursor; named by a hash.
function stateFile(base, token, device) {
    const key = crypto.createHash('sha256').update(`${base}\n${token}\n${device}`).digest('hex').slice(0, 16);
    return path.join(os.tmpdir(), `aniziq-device-${key}.json`);
}

function readState(file) {
    try {
        const s = JSON.parse(fs.readFileSync(file, 'utf8'));
        return { epoch: typeof s.epoch === 'string' ? s.epoch : '', cursor: Number.isSafeInteger(s.cursor) ? s.cursor : 0 };
    } catch {
        return { epoch: '', cursor: 0 };
    }
}

// Runs one command and resolves with the last reply. A pull asks again while the server says
// `more`, and moves the cursor; a push keeps it, so the next pull shows the push too.
async function run(argv, { log = console.log, fetchImpl = fetch, now = Date.now } = {}) {
    const opts = { base: 'http://127.0.0.1:3232', token: DEFAULT_TOKEN, device: 'tv', user: null, since: null };
    const rest = [];
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        const value = () => {
            if (i + 1 >= argv.length) throw new Error(`${arg} needs a value`);
            return argv[++i];
        };
        if (arg === '--base') opts.base = value();
        else if (arg === '--token') opts.token = value();
        else if (arg === '--user') opts.user = whole(value(), '--user');
        else if (arg === '--device') opts.device = value();
        else if (arg === '--since') opts.since = whole(value(), '--since');
        else if (arg === '--help' || arg === '-h') {
            log(USAGE);
            return null;
        } else rest.push(arg);
    }
    const [command = 'pull', ...args] = rest;
    const base = localBase(opts.base);
    if (!['pc', 'web', 'tv'].includes(opts.device)) throw new Error('--device is pc, web or tv');
    const user = opts.user ?? (viewerFor(opts.token) || {}).id;
    if (!user) throw new Error("--user is needed: the fake AniList doesn't know this token");
    const changes = changesFor(command, args, opts.device, now());

    const file = stateFile(base, opts.token, opts.device);
    const state = readState(file);
    let since = command === 'pull' && opts.since !== null ? opts.since : state.cursor;
    for (;;) {
        const res = await fetchImpl(`${base}/sync`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${opts.token}` },
            body: JSON.stringify({ v: 1, user, epoch: state.epoch, since, changes: command === 'pull' ? {} : changes }),
            signal: AbortSignal.timeout(20_000),
        });
        const text = await res.text();
        let reply = null;
        try {
            reply = JSON.parse(text);
        } catch { /* printed as text */ }
        log(`POST ${base}/sync as ${user} (${opts.device}) ${command}, since ${since}: HTTP ${res.status}`);
        log(reply ? JSON.stringify(reply, null, 2) : text.slice(0, 500));
        if (res.status !== 200 || !reply) throw new Error(`HTTP ${res.status}`);
        const newEpoch = reply.epoch !== state.epoch;
        state.epoch = reply.epoch;
        if (command === 'pull') state.cursor = reply.cursor;
        else if (newEpoch) state.cursor = 0;
        fs.writeFileSync(file, JSON.stringify(state));
        if (command !== 'pull' || !reply.more) return reply;
        since = reply.cursor;
    }
}

if (require.main === module) {
    run(process.argv.slice(2)).catch((e) => {
        console.error(`device.js: ${e.message}`);
        process.exitCode = 1;
    });
}

module.exports = { run, localBase, stateFile, changesFor };
