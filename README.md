# Sozo / AniZiQ video extractor

The stream server the AniZiQ apps (Windows, the site, Android TV) and the Kotlin TV app use. Node +
Express; headless Chrome (Puppeteer) only starts when an episode is looked up. Deployed by Dokploy
from this repo's `main` (see "Deploying").

| Route | What |
|---|---|
| `GET /miruro/stream?anilistId=&ep=&type=sub\|dub` | Resolves one episode on miruro.tv (`miruro.js`) |
| `GET /proxy/m3u8\|seg\|sub` | HLS proxy for the browser build (`proxy.js`) |
| `GET /auth/pair`, `/auth/login`, `POST /auth/complete`, `GET /auth/poll` | TV sign-in through a phone (`pairing.js`) |
| `POST /sync` | Continue on any device: progress, Saved and Continue Watching per AniList account (`sync.js`) |
| `GET /health` | Liveness, how the last episode lookups went, and whether sync can store (`Cache-Control: no-store`) |
| `/animepahe/*` | Old source, unused by AniZiQ |

## Run and test

```
npm start            # port 3232 (PORT overrides)
npm test             # node --test: no network, no Chrome
```

Environment:

| Variable | Default | What |
|---|---|---|
| `PORT` | `3232` | Listening port |
| `SYNC_DIR` | `data/sync` here (git-ignored), `/data/sync` in the image | Device sync's folder: one `<AniList id>.json` per account. If it can't be created or written, `/sync` answers 500 and `/health` says `"sync":"off"`. |
| `SYNC_USERS` | unset (any account) | Comma-separated AniList ids that may sync, e.g. `1001,2002`; everyone else gets 403. Set it but name no id and nobody syncs. |
| `SYNC_MAX_USERS` | `50` | Account files at most; a new account past it gets 403 "sync is full". |
| `ANILIST_URL` | `https://graphql.anilist.co` | Where `/sync` checks sign-ins. Only AniList itself or a loopback address (`http://127.0.0.1:3299/`, the fake AniList) is accepted; anything else is refused with an error line and AniList is used. An override is logged as a WARNING at start. Local testing only: never in docker-compose.yml. |
| `TRUSTED_PROXIES` | unset (trust none) | Comma-separated addresses or CIDR ranges whose `X-Real-IP` names the real client (the site's nginx). From anyone else the header is ignored and the rate limits key on the socket's address, so a LAN client can't dodge them by rotating it. An ignored header is logged once per address: `[TRUST] X-Real-IP from 172.18.0.1 ignored (not in TRUSTED_PROXIES)`. |

## `/miruro/stream`

`type=sub` (the default) or `type=dub`. Older clients read only the 200 and treat everything else
as "no stream", so the extra fields are safe for them.

| Status | Body | When |
|---|---|---|
| 200 | `{status:"ok", videoUrl, referer, qualities, subtitles, skips, audio}` | Found. `audio` lists the versions the episode has: `["sub","dub"]`, `["sub"]`. |
| 404 | `{status:"error", error:"No dub for this episode", reason:"no_track", audio, fallback}` | The episode is there, but not in that version (or "No subtitled version of this episode"). `fallback` is the other version, `{type, videoUrl, referer, qualities, subtitles, skips}`, ready to play, or null. |
| 404 | `{status:"error", error:"No stream found", reason:"not_found"}` | Not in miruro's catalogue, no such episode, or no HLS stream at all. |
| 502 | `{status:"error", error:"The stream source is not answering", reason:"source_down"}` | miruro's catalogue (Cloudflare, HTML, no connection), its play call or every proxy failed. |
| 504 | `{status:"error", error:"Extractor timeout", reason:"timeout"}` | No answer within 70 s. |
| 500 | `{status:"error", error:<message>}` | Anything else. |

Results are cached for 20 minutes per episode and version; the fallback is cached under its own
version, so asking for it next costs nothing.

## `/health`

```
{"status":"ok","uptime":3.15,"now":1793906454024,"lookups":{"lastOkAt":null,"lastFailAt":null,"lastError":null}}
```

`lookups` records the last episode lookup that worked (a 200 or a 404 counts: the source answered)
and the last one that failed, as this server's `Date.now()` times, with `lastError` one of
`source_down`, `timeout` or `error`. A lookup that finishes after its 504 is still recorded. Nothing
else is kept: no show, no client. The apps compute ages against `now`, so clock differences don't
matter.

## `/sync`

"Continue on any device": the apps keep their own copy and exchange changes here, keyed by AniList
media id, per AniList account.

- `history`: one entry per show, its last episode played: `{title, imageUrl, episode, totalEpisodes,
  positionMs, durationMs, device}`, `device` being `pc`, `web` or `tv`.
- `saved`: the Saved list, `{title, imageUrl, subtitle, score?}`. A removal is a tombstone.
- `hidden`: the shows taken off Continue Watching, `{episode}` (the episode it was removed at). Putting
  one back is a tombstone.
- Never synced: settings, searches, AniList edits (each device sends its own), tokens, downloads. The
  sub/dub choice stays with each device, so a synced position resumes in that device's choice.

One request both pushes and pulls; a pull is a push with no changes. Headers: `Authorization: Bearer
<AniList token>`, `Content-Type: application/json`. The token is never in the URL.

```
POST /sync
{"v":1,"user":1001,"epoch":"9f2c4e1ab37d5e60","since":41,"changes":{"history":[{"id":21,"at":1762345678901,"data":{"title":"ONE PIECE","imageUrl":"https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx21.jpg","episode":1100,"totalEpisodes":1155,"positionMs":754000,"durationMs":1420000,"device":"pc"}}],"saved":[{"id":1535,"at":1762345600000,"deleted":true}],"hidden":[{"id":7,"at":1762345000000,"data":{"episode":4}}]}}

200
{"v":1,"user":1001,"epoch":"9f2c4e1ab37d5e60","cursor":44,"more":false,"skipped":0,"changes":{"history":[…],"saved":[…],"hidden":[…]}}
```

These two are the shared wire fixture: `sync.test.js` holds them in full (`REQUEST_FIXTURE`,
`REPLY_FIXTURE`), and the app's device-sync tests must use the same literals.

- `user` is the signed-in viewer, checked against the token's account (409 when they differ).
  `epoch` and `since` are the server copy the device knows and the `cursor` it got last (`""`, `0`
  at first).
- Each entry has `id` (1 to 2^31-1) and `at` (ms), then `data` or `deleted: true`.
- Merge: per entry, the later `at` wins and a tombstone is an ordinary dated entry. A tie keeps the
  stored copy, so sending again changes nothing. `at` is clamped to 5 minutes past the server's
  clock. Each accepted entry gets the next `rev`.
- The reply holds every stored entry with `rev > since`, the device's own accepted ones included,
  in `rev` order and at most 1000; `more: true` means ask again with `since = cursor`. `skipped`
  counts entries refused by the checks below; they never fail the request.
- An `epoch` that isn't the server's is answered as `since = 0`. A `since` past the file's `rev`
  (a file restored from something older) makes a new epoch first. Either way the devices see a new
  epoch and send their entries again, so a lost server copy fills itself.
- Checks: unknown fields go; `title` and `subtitle` are cut to 300 characters, and history and saved
  need a title; `imageUrl` stays only when it starts with `https://s4.anilist.co/` (AniList's CDN,
  every device fetches it) and is at most 1000 characters, else it is stored as `""`; `episode` and
  `totalEpisodes` 0–100000, `positionMs` and `durationMs` 0–172800000, `score` 0–100, `device` one of
  the three or `""`.
- Kept: tombstones for a year. Past 3000 entries of a kind, tombstones go first (oldest first), then
  the live entries with the oldest `at`.

| Status | Body `error` | When |
|---|---|---|
| 400 | `bad json`, `bad request` | Not JSON, or not the envelope above |
| 401 | `sign-in required`, `sign-in refused` | No token or a malformed one (AniList isn't asked), or AniList refused it |
| 403 | `forbidden`, `this account doesn't sync here`, `sync is full` | A page from another site (the `/proxy` rule), an account outside `SYNC_USERS`, or past `SYNC_MAX_USERS` |
| 409 | `the request's user isn't the signed-in account` | `user` isn't the token's account; nothing is written |
| 413 | `too large`, `too many changes` | Body over 1 MB, or more than 500 changes |
| 429 | `Too many requests` | More than 60 requests a minute from one client (`TRUSTED_PROXIES`) |
| 500 | `storage unavailable`, `write failed` | `SYNC_DIR` can't be used, or the write failed |
| 503 | `AniList is unreachable`, `AniList is busy`, … | AniList didn't answer (or with a 429 or 5xx), or more than 20 uncached sign-in checks this minute. `Retry-After: 30` |

An older server answers 404: the apps then say it doesn't sync yet.

How a sign-in is checked: the header must be `Bearer ` plus 20–4096 characters of
`[A-Za-z0-9._~+/=-]`; then AniList is asked `query { Viewer { id } }` (10 s limit). The answer is
kept by the token's SHA-256 for 10 minutes (a refusal for 1), concurrent checks of one token share a
call, and at most 20 checks a minute that the cache can't answer go to AniList, for all clients
together. The token itself is never stored, logged or written; a revoked token keeps working here
for up to 10 minutes. Tokens starting `fake-` (the test tokens) are refused without asking AniList.

Storage: one file per account, `SYNC_DIR/<id>.json` (`{"v":1,"user":…,"epoch":…,"rev":…,"updatedAt":…,
"history":{"21":{"at":…,"rev":…,"data":{…}}},"saved":{…},"hidden":{…}}`). Requests for one account run
one at a time, read the file fresh, and write it whole to a temporary file that is then renamed over
it, so a 200 means the data is on disk. A file that doesn't read is kept as `<id>.json.bad-<ms>` and
a new copy starts (the devices fill it again). Each request logs one line, never the token:
`[SYNC] 1001: 3 in, 3 out[, 1 skipped]` ("in" = entries that changed the copy).

## Deploying

Dokploy runs this repo as a **compose** app (`anime-url-0tzvo4` on 192.168.40.88): every push to
`main` re-clones it and runs `docker compose up -d --build` (about a minute). So pushing `main` is
shipping; work happens on other branches.

Device sync needs its files to outlive a redeploy. What is already in place for that:

- `docker-compose.yml` declares the named volume `aniziq-sync`, mounted at `/data` (compose calls it
  `<project>_aniziq-sync`), and sets `SYNC_DIR=/data/sync`.
- The Dockerfile creates `/data/sync` owned by the `extractor` user. Docker copies that into a new,
  empty named volume on first use, ownership included, so the volume starts writable.
- A named volume survives `docker compose up -d --build`. Only deleting the app together with its
  volumes removes it.

What to do at ship time (with the user's go), in this order:

1. Push `main`. Nothing has to be set up in Dokploy for the volume while the app stays a compose
   app. (Were it ever turned into a Dokploy Application, add a volume mount at `/data` in its
   Advanced settings instead.)
2. Check: `curl http://192.168.40.88:3232/health` shows `"sync":"ok"` and the `lookups` field, and
   `ssh root@192.168.40.88 docker volume ls | grep aniziq-sync` lists the volume. `"sync":"off"`
   means the folder isn't writable: the container log has a `[SYNC] … can't be used` line.
3. Optional: lock sync to the household with `SYNC_USERS=<AniList id>,…` in the compose
   environment (commented there). Unset, any AniList account may create a file until there are 50.
4. Optional: `TRUSTED_PROXIES`. Until it is set, everything the site's nginx forwards shares one rate
   limit (60 `/sync` requests a minute for all of the site's visitors together; plenty for a
   household). After the deploy, use the site once and look for
   `[TRUST] X-Real-IP from <address> ignored` in the container log: that address is the nginx as
   this server sees it (a Docker bridge address such as 172.18.0.1). Put it in `TRUSTED_PROXIES` in
   the compose environment and redeploy. Never a range the LAN's own devices use: they could then
   write any `X-Real-IP`.
5. Never set `ANILIST_URL` there: it is refused for anything but AniList and loopback anyway.

Without a volume nothing is lost either: each redeploy would start an empty copy with a new epoch,
and the devices would send their entries again.

The change is backward compatible: current apps never call `/sync` and read only the 200 of
`/miruro/stream`; apps with device sync that reach an older server get a 404 and say it doesn't sync
yet. Ship the extractor before the apps.

## Local test helpers (`dev/`)

Not copied into the image, and not matched by `node --test` (their tests are `*.test.js`).

### Fake AniList: `dev/fake-anilist.js`

The one stand-in AniList for run-time checks, for the apps and for this server alike:

```
node dev/fake-anilist.js [--port 3299] [--lists [<name>=]<file>]... [--recs <file>]
```

- Binds 127.0.0.1 only, port 3299 (`--port` or `FAKE_ANILIST_PORT`). The Android emulator reaches it
  as `http://10.0.2.2:3299`.
- The apps send their signed-in calls there with `AZ_ANILIST_URL=http://127.0.0.1:3299/` (dev builds
  only; anonymous catalogue queries still go to AniList). This server checks `/sync` tokens there
  with `ANILIST_URL=http://127.0.0.1:3299/`.
- Tokens are `fake-<name>[-<tag>…]`, at least 20 characters, letters, digits and dashes. `<name>`
  is the viewer; tags tell one device's token from another's. Two tags change the answers:
  `offline` (reads work, list edits fail like a dropped connection, so they queue and retry) and
  `expired` (every call is refused with HTTP 401 "Invalid token", like a revoked token). Any other
  token gets AniList's own refusal, HTTP 400 "Invalid token".

  | Token (examples) | Viewer |
  |---|---|
  | `fake-tester-pc-0000001`, `fake-tester-web-000001`, `fake-tester-tv-0000001` | 1001 Tester |
  | `fake-other-00000000001` | 2002 Other |
  | `fake-dad-0000000000001`, `fake-mia-offline-00001`, `fake-kid-expired-00001` | 900001 Dad, 900002 Mia, 900003 Kid |
  | `fake-<anything else>-…` | `<Anything else>`, a stable id from 910000 up |

- It answers what the apps send with a token: `Viewer` (id, name, no avatar), `Viewer.statistics`
  (counted from the lists), `MediaListCollection`, `Media.mediaListEntry` (and `idMal`),
  `SaveMediaListEntry`, `DeleteMediaListEntry` and list activity (always empty). Edits are kept in
  memory per viewer until the process stops, so a reload shows them.
- `--lists <file>` seeds every viewer's lists from a MediaListCollection answer
  (`{"MediaListCollection":{"lists":[{"entries":[…]}]}}`, with or without the `{"data":…}`
  wrapper); `--lists mia=<file>` seeds one viewer and wins over the general file. Without it,
  lists start empty.
- `--recs <file>` answers recommendations queries (signed in or not) from a Page.media answer,
  filtered by the query's `ids`. The app's own "Because you watched" query is anonymous and goes to
  AniList (or to `AZ_FAKE_RECS`), so this is for direct checks.
- Shows saved through it take their title and cover from the fixture files when they're in them,
  else "Anime <id>".
- CORS for the dev web build (`http://localhost:8791`, `http://127.0.0.1:8791`).
- One log line per request, with the viewer and never the token: `[FAKE ANILIST] Tester 1001: saved 154587 as PLANNING`.

### Ports used by local checks

| Port | What |
|---|---|
| 3232 | This server from the working tree (`npm start`) |
| 3295 | An older scratch fake stream server (not in either repo) |
| 3297 | `tools/fake_extractor.py` (fake stream server) |
| 3298 | Nothing listens: "nothing answered" checks |
| 3299 | `dev/fake-anilist.js` |
| 8791 | `trunk serve` (the web build) |
| 8799 | The TV update test server |
