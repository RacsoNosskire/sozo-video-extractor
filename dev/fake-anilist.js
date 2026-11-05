// A stand-in for AniList's GraphQL API, for local run-time checks only. The app reaches it through
// AZ_ANILIST_URL (signed-in calls) and this server's /sync through ANILIST_URL. It binds
// 127.0.0.1 (the Android emulator reaches it as 10.0.2.2), isn't a test file and isn't copied
// into the image. See README.md, "Fake AniList".
//
//   node dev/fake-anilist.js [--port 3299] [--lists [<name>=]<file>]... [--recs <file>]
//
// Tokens look like "fake-<name>[-<tag>...]", at least 20 characters, and stand for the viewer
// <Name>; tags tell one device's token from another's ("fake-tester-pc-0000001"). Two tags change
// the answers: "offline" (reads work, list edits fail like a dropped connection) and "expired"
// (every call is refused like a revoked token). Any other token is refused as AniList refuses a
// bad one. Lists start from the --lists files and keep edits until the process stops.

const fs = require('fs');
const http = require('http');

const DEFAULT_PORT = 3299;
const ORIGINS = new Set(['http://localhost:8791', 'http://127.0.0.1:8791']);
const MAX_BODY = 1024 * 1024;

// Fixed ids for the names the specs use; any other name gets a stable id from its letters.
const KNOWN = { tester: 1001, other: 2002, dad: 900001, mia: 900002, kid: 900003 };
const TOKEN = /^fake-([A-Za-z][A-Za-z0-9]*)((?:-[A-Za-z0-9]+)*)$/;

function nameId(name) {
    let h = 0x811c9dc5;
    for (const c of Buffer.from(name)) h = Math.imul(h ^ c, 0x01000193) >>> 0;
    return 910000 + (h % 90000);
}

// The viewer a fake token stands for, or null when it isn't one.
function viewerFor(token) {
    if (typeof token !== 'string' || token.length < 20 || token.length > 4096) return null;
    const m = TOKEN.exec(token);
    if (!m) return null;
    const key = m[1].toLowerCase();
    const tags = m[2].toLowerCase().split('-');
    return {
        id: KNOWN[key] ?? nameId(key),
        name: key[0].toUpperCase() + key.slice(1),
        offline: tags.includes('offline'),
        expired: tags.includes('expired'),
    };
}

// A fixture file holds an AniList answer, with or without its {"data": …} wrapper.
function readFixture(file) {
    const v = JSON.parse(fs.readFileSync(file, 'utf8'));
    return v && typeof v.data === 'object' && v.data !== null ? v.data : v;
}

const listEntries = (data) => ((data && data.MediaListCollection && data.MediaListCollection.lists) || [])
    .flatMap((l) => l.entries || [])
    .filter((e) => e && e.media && Number.isInteger(e.media.id));

// The arguments written into a query for one field: name → $variable value or literal.
function argsOf(query, field, vars) {
    const at = query.indexOf(`${field}(`);
    if (at < 0) return {};
    const text = query.slice(at + field.length + 1, query.indexOf(')', at));
    const out = {};
    for (const [, key, value] of text.matchAll(/(\w+)\s*:\s*(\$\w+|"[^"]*"|[\w.-]+)/g)) {
        if (value.startsWith('$')) out[key] = (vars || {})[value.slice(1)];
        else if (value.startsWith('"')) out[key] = value.slice(1, -1);
        else if (/^-?\d+(\.\d+)?$/.test(value)) out[key] = Number(value);
        else out[key] = { true: true, false: false, null: null }[value] ?? value;
    }
    return out;
}

const STATUS_NAMES = {
    CURRENT: 'Watching', REPEATING: 'Rewatching', COMPLETED: 'Completed', PAUSED: 'Paused', DROPPED: 'Dropped', PLANNING: 'Planning',
};
const noDate = () => ({ year: null, month: null, day: null });

function createFake({ lists = {}, recs = null } = {}) {
    const catalog = new Map();
    const remember = (m) => { if (m && Number.isInteger(m.id)) catalog.set(m.id, { ...catalog.get(m.id), ...m }); };
    for (const data of Object.values(lists)) listEntries(data).forEach((e) => remember(e.media));
    const recMedia = (recs && recs.Page && recs.Page.media) || [];
    for (const m of recMedia) {
        remember(m);
        for (const n of (m.recommendations && m.recommendations.nodes) || []) remember(n && n.mediaRecommendation);
    }
    const media = (id) => ({
        id,
        idMal: null,
        synonyms: [],
        title: { english: null, romaji: `Anime ${id}`, userPreferred: `Anime ${id}` },
        coverImage: { large: '' },
        bannerImage: null,
        episodes: null,
        averageScore: null,
        format: 'TV',
        seasonYear: null,
        status: 'FINISHED',
        nextAiringEpisode: null,
        description: '',
        ...catalog.get(id),
    });

    let nextEntryId = 70000001;
    const accounts = new Map(); // viewer id → Map(media id → list entry)
    const account = (v) => {
        if (!accounts.has(v.id)) {
            const seed = lists[v.name.toLowerCase()] || lists['*'];
            const entries = new Map();
            for (const e of listEntries(seed)) {
                const { media: m, ...rest } = e;
                entries.set(m.id, { id: Number.isInteger(e.id) ? e.id : nextEntryId++, ...rest, mediaId: m.id });
            }
            accounts.set(v.id, entries);
        }
        return accounts.get(v.id);
    };
    const entryJson = (e) => {
        const { mediaId, ...rest } = e;
        return { ...rest, media: media(mediaId) };
    };

    function save(v, args) {
        const id = args.mediaId;
        if (!Number.isInteger(id) || id <= 0) return { status: 400, errors: [{ message: 'validation', status: 400 }] };
        const entries = account(v);
        const e = entries.get(id) || {
            id: nextEntryId++,
            status: 'CURRENT',
            progress: 0,
            score: 0,
            repeat: 0,
            notes: null,
            private: false,
            hiddenFromStatusLists: false,
            startedAt: noDate(),
            completedAt: noDate(),
            mediaId: id,
        };
        const set = (key, value) => { if (value !== undefined) e[key] = value; };
        set('status', args.status);
        set('progress', args.progress);
        set('score', args.scoreRaw !== undefined ? args.scoreRaw / 10 : args.score);
        set('repeat', args.repeat);
        set('notes', args.notes);
        set('private', args.private);
        set('hiddenFromStatusLists', args.hiddenFromStatusLists);
        set('startedAt', args.startedAt && { ...noDate(), ...args.startedAt });
        set('completedAt', args.completedAt && { ...noDate(), ...args.completedAt });
        e.updatedAt = Math.floor(Date.now() / 1000);
        entries.set(id, e);
        return { data: { SaveMediaListEntry: entryJson(e) }, note: `saved ${id} as ${e.status}` };
    }

    function remove(v, args) {
        const entries = account(v);
        const hit = [...entries.values()].find((e) => e.id === args.id);
        if (!hit) return { errors: [{ message: 'Not Found.', status: 404 }], data: { DeleteMediaListEntry: null } };
        entries.delete(hit.mediaId);
        return { data: { DeleteMediaListEntry: { deleted: true } }, note: `removed ${hit.mediaId}` };
    }

    // Anyone's lists can be read by id, as on AniList; an account nobody has used yet has none.
    function collection(v, args) {
        const id = args.userId === undefined ? v.id : args.userId;
        const entries = [...(id === v.id ? account(v) : accounts.get(id) || new Map()).values()];
        const out = Object.keys(STATUS_NAMES)
            .map((status) => ({ name: STATUS_NAMES[status], status, isCustomList: false, entries: entries.filter((e) => e.status === status).map(entryJson) }))
            .filter((l) => l.entries.length);
        return { data: { MediaListCollection: { lists: out } }, note: `lists: ${entries.length} entries` };
    }

    function stats(v) {
        const entries = [...account(v).values()];
        const episodes = entries.reduce((n, e) => n + (e.progress || 0), 0);
        const scores = new Map();
        for (const e of entries) if (e.score > 0) scores.set(e.score, (scores.get(e.score) || 0) + 1);
        const anime = {
            count: entries.length,
            episodesWatched: episodes,
            minutesWatched: episodes * 24,
            genres: [],
            scores: [...scores].map(([score, count]) => ({ score, count })),
        };
        return { data: { Viewer: { statistics: { anime } } } };
    }

    // { status, body } for one GraphQL request, or { drop: true } to cut the connection.
    function answer(token, query, vars) {
        if (/\brecommendations\b/.test(query)) {
            const ids = Array.isArray(vars && vars.ids) ? vars.ids : null;
            const found = ids ? recMedia.filter((m) => ids.includes(m.id)) : recMedia;
            return { body: { data: { Page: { media: found } } }, note: `recommendations for ${ids ? ids.join(',') : 'all'}: ${found.length}` };
        }
        const refuse = (status, message) => ({ status, body: { errors: [{ message, status }], data: null } });
        if (!token) return refuse(400, 'The fake AniList answers signed-in calls only (Authorization: Bearer fake-…)');
        const v = viewerFor(token);
        if (!v) return { ...refuse(400, 'Invalid token'), note: 'refused an unknown token' };
        const who = `${v.name} ${v.id}`;
        if (v.expired) return { ...refuse(401, 'Invalid token'), who, note: 'refused (expired)' };
        const write = /\b(SaveMediaListEntry|DeleteMediaListEntry)\b/.exec(query);
        if (write && v.offline) return { drop: true, who, note: `${write[1]} dropped (offline)` };

        let r;
        if (write && write[1] === 'SaveMediaListEntry') r = save(v, argsOf(query, 'SaveMediaListEntry', vars));
        else if (write) r = remove(v, argsOf(query, 'DeleteMediaListEntry', vars));
        else if (/\bMediaListCollection\b/.test(query)) r = collection(v, argsOf(query, 'MediaListCollection', vars));
        else if (/\bstatistics\b/.test(query)) r = stats(v);
        else if (/\bactivities\b/.test(query)) r = { data: { Page: { pageInfo: { hasNextPage: false }, activities: [] } } };
        else if (/\bmediaListEntry\b/.test(query)) {
            const id = argsOf(query, 'Media', vars).id;
            const e = account(v).get(id);
            r = { data: { Media: { id, idMal: media(id).idMal, mediaListEntry: e ? entryJson(e) : null } }, note: `entry ${id}: ${e ? e.status : 'none'}` };
        } else if (/\bViewer\b/.test(query)) r = { data: { Viewer: { id: v.id, name: v.name, avatar: { large: null } } }, note: 'viewer' };
        else return { ...refuse(400, "The fake AniList doesn't know this query"), who };
        const { note, status = 200, ...body } = r;
        return { status, body, who, note };
    }

    return { answer, accounts };
}

function cors(req, res) {
    const origin = req.headers.origin;
    res.setHeader('Vary', 'Origin');
    if (ORIGINS.has(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Accept');
        res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
        res.setHeader('Access-Control-Max-Age', '600');
    }
}

const HELP = `Fake AniList (local checks only). POST GraphQL here with Authorization: Bearer fake-<name>-<tag>,
at least 20 characters. Viewers: ${Object.entries(KNOWN).map(([k, id]) => `${k} ${id}`).join(', ')}; other names get
an id from 910000 up. Tags: offline (edits fail like a dropped connection), expired (refused).
`;

// Serves the fake; resolves with { url, port, close() } once it listens.
function start({ port = DEFAULT_PORT, host = '127.0.0.1', lists = {}, recs = null, log = console.log } = {}) {
    const fake = createFake({ lists, recs });
    const server = http.createServer((req, res) => {
        cors(req, res);
        if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }
        if (req.method === 'GET') {
            res.setHeader('Content-Type', 'text/plain; charset=utf-8');
            return res.end(HELP);
        }
        if (req.method !== 'POST') { res.statusCode = 405; return res.end(); }
        const chunks = [];
        let size = 0;
        req.on('data', (c) => {
            size += c.length;
            if (size > MAX_BODY) req.destroy();
            else chunks.push(c);
        });
        req.on('end', () => {
            let body;
            try {
                body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            } catch {
                body = null;
            }
            const auth = /^Bearer (.+)$/.exec(req.headers.authorization || '');
            const r = body && typeof body.query === 'string'
                ? fake.answer(auth && auth[1].trim(), body.query, body.variables)
                : { status: 400, body: { errors: [{ message: 'Invalid JSON', status: 400 }], data: null } };
            log(`[FAKE ANILIST] ${r.who || '-'}: ${r.note || (r.status && r.status !== 200 ? `HTTP ${r.status}` : 'ok')}`);
            if (r.drop) return req.socket.destroy();
            res.statusCode = r.status || 200;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify(r.body));
        });
    });
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
            const { port: bound } = server.address();
            resolve({
                url: `http://${host}:${bound}/`,
                port: bound,
                accounts: fake.accounts,
                close: () => new Promise((done) => { server.closeAllConnections(); server.close(done); }),
            });
        });
    });
}

function main(argv) {
    const opts = { port: Number(process.env.FAKE_ANILIST_PORT) || DEFAULT_PORT, lists: {}, recs: null };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        const next = () => {
            if (i + 1 >= argv.length) throw new Error(`${arg} needs a value`);
            return argv[++i];
        };
        if (arg === '--port') opts.port = Number(next());
        else if (arg === '--lists') {
            const value = next();
            const m = /^([A-Za-z][A-Za-z0-9]*)=(.+)$/.exec(value);
            opts.lists[m ? m[1].toLowerCase() : '*'] = readFixture(m ? m[2] : value);
        } else if (arg === '--recs') opts.recs = readFixture(next());
        else if (arg === '--help' || arg === '-h') {
            process.stdout.write(`${HELP}\nnode dev/fake-anilist.js [--port 3299] [--lists [<name>=]<file>]... [--recs <file>]\n`);
            return;
        } else throw new Error(`unknown argument ${arg}`);
    }
    start(opts).then(({ url }) => {
        const lists = Object.keys(opts.lists).map((k) => (k === '*' ? 'everyone' : k));
        console.log(`Fake AniList on ${url} (lists: ${lists.join(', ') || 'empty'}; recommendations: ${opts.recs ? 'from file' : 'none'})`);
    }, (e) => {
        console.error(`Fake AniList: ${e.message}`);
        process.exitCode = 1;
    });
}

if (require.main === module) {
    try {
        main(process.argv.slice(2));
    } catch (e) {
        console.error(`Fake AniList: ${e.message}`);
        process.exitCode = 2;
    }
}

module.exports = { viewerFor, start, createFake, KNOWN };
