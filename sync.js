// Device sync ("Continue on any device"): watch positions (history), Saved titles (saved) and the
// shows removed from Continue Watching (hidden) follow the AniList account across the PC app, the
// site and the TV. One endpoint, POST /sync, pushes and pulls; README.md describes the protocol.
//
// The account comes only from AniList's answer for the bearer token, cached by the token's
// SHA-256 (10 minutes for an id, 1 for a refusal). The token itself is never stored, logged or
// written. Each account is one JSON file in SYNC_DIR, merged entry by entry: the later `at` wins,
// and a removal is a dated tombstone. Settings, searches and AniList edits never come here.

const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const path = require('path');
const express = require('express');
const { browserAllowed } = require('./proxy');
const { rateLimit } = require('./pairing');

const ANILIST = 'https://graphql.anilist.co';
const DAY = 24 * 60 * 60 * 1000;
const LIMITS = {
    body: '1mb',
    changes: 500, // per request
    reply: 1000, // entries per reply
    stored: 3000, // entries per kind and account
    perMinute: 60, // requests per client
    lookupsPerMinute: 20, // AniList viewer lookups not answered from the cache, all clients together
    unknownPerMinute: 15, // of those, for tokens AniList hasn't vouched for here
    recheckPerMinute: 2, // of those, for the tokens of one account it has vouched for
    users: 50, // account files (SYNC_MAX_USERS)
    tombstoneDays: 365,
    aheadMs: 5 * 60 * 1000, // how far past the server's clock an `at` may be
};
const KINDS = ['history', 'saved', 'hidden'];
const DEVICES = ['pc', 'web', 'tv'];
const MAX_ID = 2 ** 31 - 1;
const MAX_MS = 172_800_000; // 48 h
const MAX_EPISODE = 100_000;
const IMAGES = 'https://s4.anilist.co/';
const BEARER = /^Bearer ([A-Za-z0-9._~+/=-]{20,4096})$/;
const ACCOUNT_FILE = /^\d+\.json$/;

class HttpError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const isInt = (v, min, max) => Number.isSafeInteger(v) && v >= min && v <= max;
// Cut by characters, not UTF-16 units, so no half of an emoji is left over.
const text = (v, max) => (typeof v === 'string' ? Array.from(v).slice(0, max).join('') : '');
// Every device fetches the image, so only AniList's own CDN.
const image = (v) => (typeof v === 'string' && v.length <= 1000 && v.startsWith(IMAGES) ? v : '');
// A missing count is 0; a count out of range spoils the entry (NaN).
const count = (v, max) => (v === undefined || v === null ? 0 : isInt(v, 0, max) ? v : NaN);

const CLEAN = {
    history(d) {
        const title = text(d.title, 300);
        const nums = [count(d.episode, MAX_EPISODE), count(d.totalEpisodes, MAX_EPISODE), count(d.positionMs, MAX_MS), count(d.durationMs, MAX_MS)];
        if (!title.trim() || nums.some(Number.isNaN)) return null;
        const [episode, totalEpisodes, positionMs, durationMs] = nums;
        const device = DEVICES.includes(d.device) ? d.device : '';
        return { title, imageUrl: image(d.imageUrl), episode, totalEpisodes, positionMs, durationMs, device };
    },
    saved(d) {
        const title = text(d.title, 300);
        if (!title.trim()) return null;
        const out = { title, imageUrl: image(d.imageUrl), subtitle: text(d.subtitle, 300) };
        if (d.score !== undefined && d.score !== null) {
            if (!isInt(d.score, 0, 100)) return null;
            out.score = d.score;
        }
        return out;
    },
    hidden(d) {
        const episode = count(d.episode, MAX_EPISODE);
        return Number.isNaN(episode) ? null : { episode };
    },
};

// One incoming entry with only the fields that sync, or null when it can't be taken. `at` is
// clamped to 5 minutes past `now`, so a device whose clock runs ahead can't win for ever.
function cleanEntry(kind, e, now) {
    if (!isObject(e) || !isInt(e.id, 1, MAX_ID) || !isInt(e.at, 0, Number.MAX_SAFE_INTEGER)) return null;
    const at = Math.min(e.at, now + LIMITS.aheadMs);
    if (e.deleted === true) return { id: e.id, at, deleted: true };
    if (e.deleted !== undefined && e.deleted !== false) return null;
    if (!isObject(e.data)) return null;
    const data = CLEAN[kind](e.data);
    return data ? { id: e.id, at, data } : null;
}

const newEpoch = () => crypto.randomBytes(8).toString('hex');

function emptyDoc(user) {
    return { v: 1, user, epoch: newEpoch(), rev: 0, updatedAt: 0, history: {}, saved: {}, hidden: {} };
}

// Last writer wins per entry: an incoming entry replaces the stored one only when its `at` is
// later, so a tie (a re-send) changes nothing. Each accepted entry gets the next rev. `lost` lists,
// as { kind, id }, the valid entries that lost to a stored one as new or newer.
function mergeInto(doc, changes, now) {
    let changed = 0;
    let skipped = 0;
    const lost = [];
    for (const kind of KINDS) {
        const list = changes && Array.isArray(changes[kind]) ? changes[kind] : [];
        for (const raw of list) {
            const e = cleanEntry(kind, raw, now);
            if (!e) {
                skipped += 1;
                continue;
            }
            const stored = doc[kind][e.id];
            if (stored && !(e.at > stored.at)) {
                lost.push({ kind, id: e.id });
                continue;
            }
            doc.rev += 1;
            doc[kind][e.id] = e.deleted ? { at: e.at, rev: doc.rev, deleted: true } : { at: e.at, rev: doc.rev, data: e.data };
            changed += 1;
        }
    }
    return { changed, skipped, lost };
}

// A stored entry as the reply carries it.
const wire = (id, s) => (s.deleted ? { id, at: s.at, deleted: true } : { id, at: s.at, data: s.data });

// The stored entries with rev > since, in rev order, at most `limit`; `more` says call again
// from `cursor`.
function changesSince(doc, since, limit = LIMITS.reply) {
    const all = [];
    for (const kind of KINDS) {
        for (const [id, s] of Object.entries(doc[kind])) if (s.rev > since) all.push({ kind, id: Number(id), s });
    }
    all.sort((a, b) => a.s.rev - b.s.rev);
    const page = all.slice(0, limit);
    const changes = { history: [], saved: [], hidden: [] };
    for (const { kind, id, s } of page) changes[kind].push(wire(id, s));
    const more = all.length > page.length;
    return { changes, cursor: more ? page[page.length - 1].s.rev : doc.rev, more };
}

// Tombstones older than a year go. Over the cap, tombstones go first (oldest first), then the
// live entries with the oldest `at`. Returns how many went.
function prune(doc, now) {
    const cutoff = now - LIMITS.tombstoneDays * DAY;
    let removed = 0;
    for (const kind of KINDS) {
        const map = doc[kind];
        for (const [id, s] of Object.entries(map)) {
            if (s.deleted && s.at < cutoff) {
                delete map[id];
                removed += 1;
            }
        }
        const ids = Object.keys(map);
        if (ids.length <= LIMITS.stored) continue;
        const live = (s) => (s.deleted ? 0 : 1);
        ids.sort((a, b) => live(map[a]) - live(map[b]) || map[a].at - map[b].at);
        for (const id of ids.slice(0, ids.length - LIMITS.stored)) {
            delete map[id];
            removed += 1;
        }
    }
    return removed;
}

// ANILIST_URL may name AniList itself or a stand-in on this machine (dev/fake-anilist.js), never
// anything else: the tokens it is sent are real sign-ins.
function anilistUrl(value) {
    if (value === undefined || value === null || value === '') return ANILIST;
    let url = null;
    try {
        url = new URL(value);
    } catch { /* refused below */ }
    const plain = url && (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password;
    const host = url ? url.hostname.replace(/^\[|\]$/g, '') : '';
    if (plain && url.protocol === 'https:' && url.host === 'graphql.anilist.co' && url.pathname === '/' && !url.search) return ANILIST;
    if (plain && (host === 'localhost' || host === '::1' || (net.isIPv4(host) && host.startsWith('127.')))) {
        console.warn(`[SYNC] WARNING: ANILIST_URL=${url.href}: sign-ins are checked by a local stand-in, not AniList. For testing only.`);
        return url.href;
    }
    const shown = url ? ` (${url.origin})` : '';
    console.error(`[SYNC] ANILIST_URL${shown} refused: only ${ANILIST} or a loopback address. Using ${ANILIST}.`);
    return ANILIST;
}

// Who a token belongs to, asked of AniList and cached by the token's SHA-256. Throws HttpError
// 401 when AniList refuses the token and 503 when it can't answer (not cached). At most
// LIMITS.lookupsPerMinute questions a minute go to AniList, so random tokens can't get this
// server rate-limited there. Of those, tokens AniList hasn't vouched for get
// LIMITS.unknownPerMinute and each account it has vouched for (one in `allow`, when that is set)
// LIMITS.recheckPerMinute, so a flood of made-up tokens can't keep the accounts that sync here
// from being checked again.
function viewerLookup({ url = ANILIST, fetchImpl = fetch, now = Date.now, allow = null } = {}) {
    const cache = new Map(); // sha256 hex → { id (0 = refused), until }
    const known = new Map(); // sha256 hex → id, the tokens AniList vouched for, oldest first
    const inFlight = new Map();
    const asked = []; // { t, account } of the questions in the last minute; 0 for a token not vouched for
    const toAniList = url.replace(/\/+$/, '') === ANILIST;
    const refused = () => new HttpError(401, 'sign-in refused');
    let busyLoggedAt = -Infinity;

    const remember = (key, id, ms) => {
        if (cache.size >= 1000) cache.clear();
        cache.set(key, { id, until: now() + ms });
    };

    // Throws 503 when this minute's checks are used up, or the share of them for `account` (0:
    // tokens not vouched for); the log says so once a minute.
    function budget(t, account) {
        while (asked.length && t - asked[0].t >= 60_000) asked.shift();
        const same = asked.filter((a) => a.account === account).length;
        let full = '';
        if (asked.length >= LIMITS.lookupsPerMinute) full = `${asked.length} this minute`;
        else if (!account && same >= LIMITS.unknownPerMinute) full = `${same} this minute for tokens it hasn't vouched for`;
        else if (account && same >= LIMITS.recheckPerMinute) full = `${same} re-checks this minute for account ${account}`;
        if (!full) return;
        if (t - busyLoggedAt >= 60_000) {
            busyLoggedAt = t;
            console.error(`[SYNC] AniList sign-in checks over budget (${full}): answering 503`);
        }
        throw new HttpError(503, 'AniList is busy');
    }

    async function ask(token, key) {
        const t = now();
        const account = known.get(key) || 0;
        budget(t, account);
        asked.push({ t, account });
        let res;
        let body;
        try {
            res = await fetchImpl(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${token}` },
                body: JSON.stringify({ query: 'query { Viewer { id } }' }),
                signal: AbortSignal.timeout(10_000),
            });
            body = await res.text();
        } catch {
            throw new HttpError(503, 'AniList is unreachable');
        }
        let json = null;
        try {
            json = JSON.parse(body);
        } catch { /* not JSON: AniList is having trouble */ }
        const message = json && Array.isArray(json.errors) && json.errors[0] ? json.errors[0].message : '';
        // AniList answers a bad token with HTTP 400 "Invalid token".
        if (res.status === 401 || (typeof message === 'string' && /invalid token/i.test(message))) {
            known.delete(key);
            remember(key, 0, 60_000);
            throw refused();
        }
        const id = json && json.data && json.data.Viewer ? json.data.Viewer.id : null;
        if (res.status === 200 && isInt(id, 1, MAX_ID)) {
            // Kept apart from the cache (newest last), so the token's next check has its account's share.
            known.delete(key);
            if (!allow || allow.has(id)) {
                if (known.size >= 1000) known.delete(known.keys().next().value);
                known.set(key, id);
            }
            remember(key, id, 10 * 60_000);
            return id;
        }
        throw new HttpError(503, `AniList answered HTTP ${res.status}`);
    }

    return {
        cache,
        known,
        async idFor(token) {
            const key = crypto.createHash('sha256').update(token).digest('hex');
            const hit = cache.get(key);
            if (hit && hit.until > now()) {
                if (hit.id) return hit.id;
                throw refused();
            }
            // The apps' test tokens (dev/fake-anilist.js) never go to AniList.
            if (toAniList && token.startsWith('fake-')) throw refused();
            let pending = inFlight.get(key);
            if (!pending) {
                pending = ask(token, key).finally(() => inFlight.delete(key));
                inFlight.set(key, pending);
            }
            return pending;
        },
    };
}

// SYNC_USERS="1001,2002": only these accounts sync; unset lets any account AniList vouches for.
function allowList(value) {
    if (value === undefined || value === null || value === '') return null;
    const items = Array.isArray(value) ? value : String(value).split(',');
    const ids = items.map((s) => Number(String(s).trim())).filter((n) => isInt(n, 1, MAX_ID));
    if (!ids.length) console.error('[SYNC] SYNC_USERS names no account id, so no account can sync');
    return new Set(ids);
}

// The request without its entries checked (mergeInto does that, one by one), or HttpError 400,
// or 413 for too many changes.
function envelope(body) {
    if (!isObject(body) || body.v !== 1) throw new HttpError(400, 'bad request');
    const { user, epoch = '', since = 0, changes = {} } = body;
    const ok = isInt(user, 1, MAX_ID) && typeof epoch === 'string' && epoch.length <= 64
        && isInt(since, 0, Number.MAX_SAFE_INTEGER) && isObject(changes);
    if (!ok) throw new HttpError(400, 'bad request');
    const lists = {};
    let total = 0;
    for (const kind of KINDS) {
        const list = changes[kind] === undefined ? [] : changes[kind];
        if (!Array.isArray(list)) throw new HttpError(400, 'bad request');
        lists[kind] = list;
        total += list.length;
    }
    if (total > LIMITS.changes) throw new HttpError(413, 'too many changes');
    return { user, epoch, since, changes: lists };
}

const validStored = (id, s, rev) => /^\d+$/.test(id) && isObject(s) && Number.isSafeInteger(s.at)
    && isInt(s.rev, 1, rev) && (s.deleted === true || isObject(s.data));

function validDoc(doc, user) {
    return isObject(doc) && doc.v === 1 && doc.user === user && typeof doc.epoch === 'string'
        && /^[0-9a-f]{16}$/.test(doc.epoch) && isInt(doc.rev, 0, Number.MAX_SAFE_INTEGER)
        && KINDS.every((k) => isObject(doc[k]) && Object.entries(doc[k]).every(([id, s]) => validStored(id, s, doc.rev)));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Mounts POST /sync. Options (tests; the environment otherwise): dir (SYNC_DIR), anilistUrl
// (ANILIST_URL), allow (SYNC_USERS), maxUsers (SYNC_MAX_USERS), trusted (TRUSTED_PROXIES), now,
// fetchImpl. Returns { ready, dir }; ready is false when the folder can't be written, and /sync
// then answers 500.
function mount(app, opts = {}) {
    const dir = path.resolve(opts.dir ?? process.env.SYNC_DIR ?? path.join(__dirname, 'data', 'sync'));
    const now = opts.now ?? Date.now;
    const allow = allowList(opts.allow ?? process.env.SYNC_USERS);
    const envMax = Number(process.env.SYNC_MAX_USERS);
    const maxUsers = opts.maxUsers ?? (isInt(envMax, 1, 1_000_000) ? envMax : LIMITS.users);
    const viewers = viewerLookup({ url: anilistUrl(opts.anilistUrl ?? process.env.ANILIST_URL), fetchImpl: opts.fetchImpl, now, allow });

    let ready = false;
    try {
        fs.mkdirSync(dir, { recursive: true });
        fs.accessSync(dir, fs.constants.W_OK);
        ready = fs.statSync(dir).isDirectory();
    } catch (e) {
        console.error(`[SYNC] ${dir} can't be used (${e.code || e.message}), so /sync is off`);
    }
    if (ready) console.log(`[SYNC] accounts in ${dir}: ${allow ? `only ${[...allow].join(', ')}` : `any AniList account, up to ${maxUsers}`}`);

    const file = (user) => path.join(dir, `${user}.json`);
    const queues = new Map();
    const creating = new Set();

    // Requests for one account run one at a time.
    function exclusive(key, fn) {
        const run = (queues.get(key) || Promise.resolve()).then(fn);
        const tail = run.catch(() => {});
        queues.set(key, tail);
        tail.then(() => {
            if (queues.get(key) === tail) queues.delete(key);
        });
        return run;
    }

    // The account's file, read fresh; a new document for a new account (if there is room) or in
    // place of a file that doesn't read, which is set aside as <id>.json.bad-<ms>.
    async function load(user) {
        let raw;
        try {
            raw = await fs.promises.readFile(file(user), 'utf8');
        } catch (e) {
            if (e.code !== 'ENOENT') throw new HttpError(500, 'storage unavailable');
            let names;
            try {
                names = await fs.promises.readdir(dir);
            } catch {
                throw new HttpError(500, 'storage unavailable');
            }
            if (names.filter((n) => ACCOUNT_FILE.test(n)).length + creating.size >= maxUsers) throw new HttpError(403, 'sync is full');
            creating.add(user);
            return { doc: emptyDoc(user), fresh: true };
        }
        try {
            const doc = JSON.parse(raw);
            if (validDoc(doc, user)) return { doc, fresh: false };
        } catch { /* set aside below */ }
        const bad = `${file(user)}.bad-${now()}`;
        try {
            await fs.promises.rename(file(user), bad);
        } catch {
            throw new HttpError(500, 'storage unavailable');
        }
        console.error(`[SYNC] ${user}: the file didn't read, kept as ${path.basename(bad)}; starting again`);
        return { doc: emptyDoc(user), fresh: true };
    }

    // Written whole to a temporary file, then renamed over the old one.
    async function save(user, doc) {
        const target = file(user);
        const tmp = `${target}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
        try {
            await fs.promises.writeFile(tmp, JSON.stringify(doc));
            for (let attempt = 0; ; attempt++) {
                try {
                    await fs.promises.rename(tmp, target);
                    break;
                } catch (e) {
                    // Windows refuses for a moment while something (a virus scan) has the file open.
                    if (attempt >= 3 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e;
                    await sleep(50 * (attempt + 1));
                }
            }
        } catch (e) {
            await fs.promises.unlink(tmp).catch(() => {});
            console.error(`[SYNC] ${user}: write failed (${e.code || e.message})`);
            throw new HttpError(500, 'write failed');
        }
    }

    async function exchange(user, req) {
        const t = now();
        const { doc, fresh } = await load(user);
        let merged;
        try {
            // A cursor past the file's rev means the file is older than what the device saw (a
            // restore): a new epoch makes every device send its entries again.
            let rotated = false;
            if (req.epoch === doc.epoch && req.since > doc.rev) {
                doc.epoch = newEpoch();
                rotated = true;
            }
            merged = mergeInto(doc, req.changes, t);
            if (merged.changed || fresh || rotated) {
                prune(doc, t);
                doc.updatedAt = t;
                await save(user, doc);
            }
        } finally {
            creating.delete(user);
        }
        const page = changesSince(doc, req.epoch === doc.epoch ? req.since : 0);
        // For what lost to a stored entry, that entry, even from before `since`: the device takes
        // it, so the copies agree (one whose clock runs behind would otherwise keep its own).
        for (const { kind, id } of merged.lost) {
            const s = doc[kind][id];
            if (s && !page.changes[kind].some((e) => e.id === id)) page.changes[kind].push(wire(id, s));
        }
        const sent = KINDS.reduce((n, k) => n + page.changes[k].length, 0);
        // `now` is this server's clock, for a device to tell how far off its own is.
        const reply = { v: 1, user, epoch: doc.epoch, cursor: page.cursor, more: page.more, skipped: merged.skipped, now: t, changes: page.changes };
        return { reply, sent, ...merged };
    }

    const fail = (res, status, error) => res.status(status).json({ status: 'error', error });
    const tokens = new WeakMap(); // request → token, only while it runs

    // Web pages from other sites get nothing; the native apps send no Origin.
    app.use('/sync', (req, res, next) => {
        if (browserAllowed(req.get('origin'), req.get('sec-fetch-site'))) return next();
        console.error(`[SYNC] refused a request from origin ${req.get('origin') || '(none)'}`);
        fail(res, 403, 'forbidden');
    });

    app.post(
        '/sync',
        rateLimit(LIMITS.perMinute, 60_000, { trusted: opts.trusted }),
        (req, res, next) => {
            if (!ready) return fail(res, 500, 'storage unavailable');
            const m = BEARER.exec(req.get('authorization') || '');
            if (!m) return fail(res, 401, 'sign-in required');
            tokens.set(req, m[1]);
            next();
        },
        express.json({ limit: LIMITS.body }),
        async (req, res) => {
            try {
                const body = envelope(req.body);
                const viewer = await viewers.idFor(tokens.get(req));
                if (allow && !allow.has(viewer)) throw new HttpError(403, "this account doesn't sync here");
                if (body.user !== viewer) throw new HttpError(409, "the request's user isn't the signed-in account");
                const out = await exclusive(viewer, () => exchange(viewer, body));
                console.log(`[SYNC] ${viewer}: ${out.changed} in, ${out.sent} out${out.skipped ? `, ${out.skipped} skipped` : ''}`);
                res.json(out.reply);
            } catch (e) {
                const known = e instanceof HttpError;
                if (!known) console.error(`[SYNC] ${e.message}`);
                if (known && e.status === 503) res.set('Retry-After', '30');
                fail(res, known ? e.status : 500, known ? e.message : 'internal error');
            }
        },
    );

    // express.json's own errors, as JSON.
    app.use('/sync', (err, req, res, next) => {
        if (res.headersSent) return next(err);
        if (err.type === 'entity.too.large') return fail(res, 413, 'too large');
        fail(res, 400, 'bad json');
    });

    return { ready, dir };
}

module.exports = { mount, cleanEntry, mergeInto, changesSince, prune, emptyDoc, viewerLookup, anilistUrl, LIMITS };
