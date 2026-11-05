# Sozo / AniZiQ video extractor

The stream server the AniZiQ apps (Windows, the site, Android TV) and the Kotlin TV app use. Node +
Express; headless Chrome (Puppeteer) only starts when an episode is looked up. Deployed by Dokploy
from this repo's `main` (see "Deploying").

| Route | What |
|---|---|
| `GET /miruro/stream?anilistId=&ep=&type=sub\|dub` | Resolves one episode on miruro.tv (`miruro.js`) |
| `GET /proxy/m3u8\|seg\|sub` | HLS proxy for the browser build (`proxy.js`) |
| `GET /auth/pair`, `/auth/login`, `POST /auth/complete`, `GET /auth/poll` | TV sign-in through a phone (`pairing.js`) |
| `GET /health` | Liveness, and how the last episode lookups went (`Cache-Control: no-store`) |
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
