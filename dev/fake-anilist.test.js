// `npm test`: the fake AniList that local run-time checks use (loopback only, no network).
const test = require('node:test');
const assert = require('node:assert');
const fake = require('./fake-anilist');

const LIST_QUERY = 'query($userId:Int){ MediaListCollection(userId:$userId, type:ANIME){ lists { entries { status score media { id title { english } } } } } }';
const SAVE = 'mutation($id:Int,$status:MediaListStatus,$raw:Int){ SaveMediaListEntry(mediaId:$id,status:$status,scoreRaw:$raw){ status score media { idMal } } }';
const DELETE = 'mutation($id:Int){ DeleteMediaListEntry(id:$id){ deleted } }';

const LISTS = {
    MediaListCollection: {
        lists: [{
            entries: [{
                status: 'COMPLETED',
                progress: 12,
                score: 9,
                updatedAt: 1700000000,
                completedAt: { year: 2024, month: 3, day: 1 },
                media: { id: 21, title: { english: 'ONE PIECE', romaji: 'ONE PIECE', userPreferred: 'ONE PIECE' } },
            }],
        }],
    },
};
const RECS = {
    Page: {
        media: [{
            id: 21,
            recommendations: { nodes: [{ rating: 50, mediaRecommendation: { id: 20, title: { english: 'Naruto', romaji: 'NARUTO', userPreferred: 'NARUTO' } } }] },
        }],
    },
};

async function serve(t, opts) {
    const f = await fake.start({ port: 0, log: () => {}, ...opts });
    t.after(() => f.close());
    return f.url;
}

async function gql(base, token, query, variables) {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    const r = await fetch(base, { method: 'POST', headers, body: JSON.stringify({ query, variables }) });
    return { status: r.status, body: await r.json() };
}

test('fake tokens name their viewer', () => {
    assert.deepEqual(fake.viewerFor('fake-tester-pc-0000001'), { id: 1001, name: 'Tester', offline: false, expired: false });
    assert.equal(fake.viewerFor('fake-tester-tv-0000001').id, 1001);
    assert.equal(fake.viewerFor('fake-other-00000000001').id, 2002);
    assert.deepEqual(fake.viewerFor('fake-mia-offline-00001'), { id: 900002, name: 'Mia', offline: true, expired: false });
    assert.equal(fake.viewerFor('fake-kid-expired-00001').expired, true);
    const zed = fake.viewerFor('fake-zed-0000000000000');
    assert.ok(zed.id >= 910000 && zed.id < 1000000);
    assert.equal(fake.viewerFor('fake-zed-1111111111111').id, zed.id);
    for (const t of ['fake-mia', 'fake-mia-0000000000_00', 'devtoken-pc-000000000000000001', 'fake--000000000000000', '', null]) {
        assert.equal(fake.viewerFor(t), null, t);
    }
});

test('the viewer, its lists and list edits, kept per account', async (t) => {
    const base = await serve(t, { lists: { '*': LISTS }, recs: RECS });
    const pc = 'fake-tester-pc-0000001';
    const lists = async (token, userId) => (await gql(base, token, LIST_QUERY, { userId })).body.data.MediaListCollection.lists;

    assert.deepEqual((await gql(base, pc, 'query { Viewer { id name avatar { large } } }')).body, {
        data: { Viewer: { id: 1001, name: 'Tester', avatar: { large: null } } },
    });
    assert.equal((await lists(pc, 1001))[0].entries[0].media.title.english, 'ONE PIECE');

    const saved = (await gql(base, pc, SAVE, { id: 20, status: 'PLANNING', raw: 80 })).body.data.SaveMediaListEntry;
    assert.equal(saved.status, 'PLANNING');
    assert.equal(saved.score, 8);
    assert.equal(saved.media.title.english, 'Naruto'); // known from the recommendations file

    // The TV's token is the same viewer; another viewer starts from the fixture alone.
    assert.deepEqual((await lists('fake-tester-tv-0000001', 1001)).map((l) => l.status), ['COMPLETED', 'PLANNING']);
    assert.equal((await lists('fake-other-00000000001', 2002)).flatMap((l) => l.entries).length, 1);

    const entry = await gql(base, pc, 'query($id:Int){ Media(id:$id){ idMal mediaListEntry { id } } }', { id: 20 });
    const entryId = entry.body.data.Media.mediaListEntry.id;
    assert.deepEqual((await gql(base, pc, DELETE, { id: entryId })).body, { data: { DeleteMediaListEntry: { deleted: true } } });
    assert.equal((await gql(base, pc, DELETE, { id: entryId })).body.errors[0].status, 404);
    assert.equal((await gql(base, pc, 'query($id:Int){ Media(id:$id){ mediaListEntry { status } } }', { id: 20 })).body.data.Media.mediaListEntry, null);

    const stats = (await gql(base, pc, 'query { Viewer { statistics { anime { count episodesWatched } } } }')).body.data.Viewer.statistics.anime;
    assert.deepEqual([stats.count, stats.episodesWatched], [1, 12]);
    const activity = 'query($u:Int,$t:Int,$p:Int){ Page(page:$p, perPage:50){ pageInfo{ hasNextPage } activities(userId:$u){ ... on ListActivity { createdAt } } } }';
    assert.deepEqual((await gql(base, pc, activity, { u: 1001, t: 0, p: 1 })).body.data.Page.activities, []);

    const recs = 'query($ids:[Int]){ Page(perPage:3){ media(id_in:$ids, type:ANIME){ id recommendations(sort:RATING_DESC, perPage:16){ nodes{ rating } } } } }';
    assert.deepEqual((await gql(base, null, recs, { ids: [21] })).body.data.Page.media.map((m) => m.id), [21]);
    assert.deepEqual((await gql(base, null, recs, { ids: [5] })).body.data.Page.media, []);
});

test('refusals look like AniList, and offline edits drop the connection', async (t) => {
    const base = await serve(t, {});
    const viewer = 'query { Viewer { id } }';
    assert.deepEqual(await gql(base, 'eyJhbGciOiJIUzI1NiJ9.not-a-fake', viewer), {
        status: 400, body: { errors: [{ message: 'Invalid token', status: 400 }], data: null },
    });
    assert.equal((await gql(base, 'fake-kid-expired-00001', viewer)).status, 401);
    assert.equal((await gql(base, null, viewer)).status, 400);
    assert.equal((await gql(base, 'fake-mia-offline-00001', viewer)).body.data.Viewer.id, 900002);
    await assert.rejects(gql(base, 'fake-mia-offline-00001', SAVE, { id: 1, status: 'CURRENT' }));
});

test("the extractor's /sync sign-in check works against the fake", async (t) => {
    const base = await serve(t, {});
    const lookup = require('../sync').viewerLookup({ url: base });
    assert.equal(await lookup.idFor('fake-tester-pc-0000001'), 1001);
    assert.equal(await lookup.idFor('fake-mia-offline-00001'), 900002);
    await assert.rejects(lookup.idFor('fake-kid-expired-00001'), { status: 401 });
    await assert.rejects(lookup.idFor('devtoken-pc-000000000000000001'), { status: 401 });
});

test('CORS answers the dev web build only', async (t) => {
    const base = await serve(t, {});
    const preflight = (origin) => fetch(base, {
        method: 'OPTIONS',
        headers: { Origin: origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type' },
    });
    const ok = await preflight('http://localhost:8791');
    assert.equal(ok.status, 204);
    assert.equal(ok.headers.get('access-control-allow-origin'), 'http://localhost:8791');
    assert.match(ok.headers.get('access-control-allow-headers'), /Authorization/);
    const evil = await preflight('https://evil.example');
    assert.equal(evil.status, 204);
    assert.equal(evil.headers.get('access-control-allow-origin'), null);
});
