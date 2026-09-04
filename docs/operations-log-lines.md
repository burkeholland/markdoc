# Operator log lines: what the server prints and what it means

Every line the production server can write to its console, current as of 2026-09-03. The reproducible source census is:

```sh
git grep -n -E 'console\.(error|warn|log)\(' -- server src/server src/proxy.ts ':(glob)src/app/**/route.ts' ':(exclude,glob)**/*.test.*' ':(exclude,glob)**/*.integration.test.*'
git grep -n -E 'warnTail\("[^"]+"' -- src/server ':(glob)src/app/**/route.ts' ':(exclude,glob)**/*.test.*'
```

It finds 33 application bracket-prefix families. Hocuspocus contributes the two hook prefixes `[onAuthenticate]` and `[onLoadDocument]`, making the 35 families in §1 and Q4's `known` list; the unprefixed application lines and Next/Hocuspocus exceptions are classified after the table. `console.log` lines land on **stdout**, `console.warn`/`console.error` on **stderr**; in Log Analytics that is `Stream_s`, the text is `Log_s` (§5). A `console.error(msg, err)` arrives as one row per line: the prefixed line, then indented stack frames such as `at …` and error properties as unprefixed rows of their own. The `[pressure]` records are bounded aggregate metrics; every other family is an event log. The runbook's post-release watch remains in the README ([Deploy to Azure](../README.md#deploy-to-azure)).

## 1. Every prefixed line

| Line (as printed) | Source | Fires when | Steady state | If it appears unexpectedly |
| --- | --- | --- | --- | --- |
| `[http] <status> <METHOD> <route shape> <ms>ms` | `server/request-log.ts:46` (format), `:67` (stderr) | a response ended with status ≥ 500, a 4xx other than 401/404, or `0` (client gone before any header) — §3 | yes, low rate: 400s from clients, occasional `0` | a new `5xx` route = a bug in that route; a burst of `0` = clients dropping (ingress, deploy flip) |
| `[pressure] {"kind":"http",…}` / `[pressure] {"kind":"gauges",…}` | `server/pressure-observability.ts` (stdout) | every 15 s: one gauge record, plus one HTTP record when the window has request activity — [Pressure aggregates](#pressure-aggregates) | yes, four gauge records/minute/replica plus HTTP activity records | correlate route completion gaps with active ages, sockets, event-loop delay and subsystem gauges; these records are diagnostic and do not alert |
| `[http] request error <METHOD> <route shape> <code>` | `server/request-guards.ts:31` (format), `:64`, `:66` (stderr); installed at `server/index.ts:169` | the Node request stream emitted an error other than an expected client-disconnect code | no | the code or error class identifies the stream failure; the raw URL and error message are not logged |
| `[http] response error <METHOD> <route shape> <code>` | `server/request-guards.ts:31` (format), `:64`, `:69` (stderr); installed at `server/index.ts:169` | the Node response stream emitted an error other than an expected client-disconnect code | no | as above; `ERR_STREAM_WRITE_AFTER_END` usually means application code wrote after ending the response |
| `[http] request failed` + stack | `server/index.ts:262` | Next's request handler *threw* (rejected promise); answered `500 internal server error` | no | the stack is the bug; its `[http] 500 …` line follows (two lines, one event) |
| `[db] idle client error: <message>` | `src/server/db/index.ts:49` (warn) | node-postgres dropped an idle pooled connection (PostgreSQL restart, `pg_terminate_backend`, VM patching, network blip); the next query reconnects | expected in the OS-patch window and around a database restart | outside a known window: check the VM (`/api/health` `latencyMs`, Syslog); a stream of them = the VM is flapping |
| `> [exit] <SIGTERM\|SIGINT> after <t>s; shutting down, flushing documents...` | `server/index.ts:292` (stdout) | the platform stops the replica (revision swap, scale) | yes, once per release from the old replica | without a release or scale event: the platform restarted the app — read the system table (§4 Q3) |
| `> [exit] process exiting with code <n> after <t>s` | `server/index.ts:88` (stdout) | every process end | yes, `code 0` after the SIGTERM line | `code 1` or no preceding SIGTERM line = crash; the `[exit]` stderr line above it says why |
| `> [exit] uncaughtException after <t>s: <stack>` / `> [exit] unhandledRejection after <t>s: <stack>` | `server/index.ts:92`, `:96` | an error nobody caught; the process exits 1 and the container restarts | no | the stack is the bug; `RestartCount` rises; if it repeats, roll back (README runbook step 4) |
| `> [exit] startup failed after <t>s: <stack>` | `server/index.ts:307` | `main()` rejected: database unreachable, migration failed, port taken | no | the new revision never turns Healthy; check the `database-url` secret, the VM, the migration named in the stack |
| `[trash] purge failed` + error | `server/index.ts:208` | the 6-hourly purge of documents trashed > `TRASH_RETENTION_DAYS` threw | no | a database error; the next run retries in 6 h — one line is noise, a series is the database |
| `[standby] takeover failed` + error | `server/index.ts:247` | `POST /_standby/takeover` on a standby process (local `scripts/live/promote.ps1` only) | never in production (`STANDBY_PORT` unset) | production printing it means the env changed — stop and look |
| `[onAuthenticate] Invalid token (<cause>)` | Hocuspocus prints `[<hook>] <message>` for any hook that throws (`node_modules/@hocuspocus/server/dist/hocuspocus-server.esm.js` l.1564, v4.6.0; `quiet: true` only hides its banner); message from `src/server/collab/token.ts:72–79`, thrown at `src/server/collab/hocuspocus.ts:83` | a `/collab` WebSocket presented a token `verifyCollabToken` rejects; the client gets `permission-denied` and fetches a fresh token | `(expired)` yes — tabs reconnecting after a release or a long sleep; `(malformed)` probe-only (§2) | `(signature)` = a token minted with another secret; `(shape)` = our secret, not a collaboration token; `(claims)` = audience/claim mismatch — none is a normal client; look at who is connecting |
| `[onAuthenticate] Token does not match document` / `[onAuthenticate] Unauthorized` | `src/server/collab/hocuspocus.ts:85`, `:87` (reason from `src/server/collab/authorization.ts:13`) | a valid token for another document; or access was revoked between token and connect | rare, single lines | repeated for one document = a client replaying a stale token |
| `[onLoadDocument] Document not found` | `src/server/collab/hocuspocus.ts:125` | a socket opened a document that no longer exists (deleted with a tab still open) | rare, once per such tab | a stream of them = something reconnecting to a deleted id |
| `[collab] socket error` + error | `src/server/collab/ws.ts:67` | the `ws` socket of one client errored (client network) | occasional | a burst = the ingress or a WebSocket-hostile network path |
| `[collab] failed to restore access after <what> mutation failed` + error | `src/server/collab/authorization.ts:208` | a share mutation failed *and* re-applying the previous access to a live connection failed; that connection was closed `4401` | no | database trouble; the client reconnects on its own |
| `[collab] <docId>: reverted doubled text from a stale IndexedDB mirror of a pre-persistence seed` | `src/server/collab/hocuspocus.ts:150` (warn) | first change to a freshly seeded document undid a doubled seed from an old client mirror | rare, self-healed | nothing to do; a recurring id = a client with a very old IndexedDB copy |
| `[websocket] fallback upgrade failed` + error | `src/server/collab/ws.ts:84`, `:89` | a non-`/collab` upgrade (Next HMR) failed | dev only | in production the fallback is Next's; treat as a bug |
| `[auth][warn] session cookie signed with an old secret — cleared` (`(<reason>)` from the proxy) | `src/server/session-cookie.ts:227` (`:16` text), `src/proxy.ts:113` | a session cookie the current `AUTH_SECRET` cannot verify; the proxy strips it, the user signs in again | yes for days after a secret rotation; otherwise rare | a burst with no rotation = revisions running with different secrets |
| `[auth] MissingCSRF during <action>` (`… (expected from the post-release check)` for `signin`) | `src/server/session-cookie.ts:232` (warn) | `POST /api/auth/signin/github` without the CSRF cookie: the `docs/custom-domain.md` post-release check, or any cookie-less client | probe-only / background | a stream = a bot posting to the sign-in endpoint |
| `[auth] UnknownAction: <name>` | `src/server/session-cookie.ts:236` (warn) | an unsupported `/api/auth/*` action (`wp-login.php` and friends) | yes, scanner noise | nothing |
| `[auth][error] <type>: <message>` (+ `[auth][cause]:` stack, `[auth][details]:` JSON) | `src/server/session-cookie.ts:239`, `:243`, `:244` | every other Auth.js error: GitHub OAuth callback failure, provider outage, config | no | `cause` names it: GitHub down, a wrong `github-client-secret`, a callback URL mismatch |
| `[proxy][warn] MARKDOC_CANONICAL_HOST is not a bare hostname …; canonical-host redirect disabled` | `src/proxy.ts:19` | the env value is invalid; logged once, then ignored | no (config) | fix the variable; the site keeps serving |
| `[public-origin] <AUTH_URL\|MARKDOC_URL> is not an http(s) origin; ignoring it for absolute URLs` | `src/server/public-origin.ts:16` (warn) | the variable is unusable (name only, never the value) | no (config) | fix the variable; link-preview images fall back to the next origin |
| `[<scope>] <code>` + error — scopes `assets` `collaborators` `comments` `content` `documents` `link` `publish` `pull` `requests` `reviews` `suggest` `suggestions` `version` `versions`; codes `version-not-saved` `activity-not-recorded` `notification-not-sent` `request-not-attached` `mentions-not-recorded` | `src/server/warnings.ts:34` (`warnTail`, codes `:6`); scopes are the `warnTail("…")` callers in `src/app/api/documents/[id]/**` and `src/server/{agent-requests,publish,reviews}.ts` | a side effect *after* a successful write failed; the 2xx carried `warnings: [<code>]` (`docs/agents.md`) | no | the write stood; the code says what record is missing; a database error underneath |
| `[activity] <edit\|title\|comment\|reply\|reply suggestion\|suggestion\|resolve> failed` + error | `src/server/activity.ts:175`; `[activity] edit failed` also `src/app/api/documents/[id]/content/route.ts:74`, `:121` | an activity row could not be written | no | the activity feed misses one entry; database |
| `[notifications] <mention\|resolve\|suggestion.accepted\|reply suggestion.accepted\|reply\|suggestion> failed` + error | `src/server/notifications.ts:332` | a notification or mention write from the collaboration watcher failed | no | one person misses one notification; database |
| `[agent-requests] mirror failed` + error | `src/server/agent-requests.ts:294` | mirroring request rows into the live document's metadata failed | no | request chips may lag until the next mirror; database |
| `[reviews] could not undo the review's threads` + error | `src/server/reviews.ts:128` | the review row failed *and* removing its threads failed | no | threads without a review card remain; the user sees a non-2xx |
| `[reviews] notification-not-sent` + error | `src/server/reviews.ts:185` | the suggestion-accepted notification failed | no | one missed notification |
| `[webhooks] delivery failed` / `collect failed <docId>` / `sweep failed` / `dispatcher stopped` + error | `src/server/webhooks.ts:395`, `:479`, `:514`, `:527` | an internal throw in the dispatcher (an endpoint's own HTTP failure is a delivery row, not a log line) | no | `dispatcher stopped` = no webhooks until the process restarts; the rest retry on the next sweep |
| `[import] creating the document for file <i> of <n> failed` + error | `src/server/import-file.ts:358` | one file of a multi-file import failed; the response lists it in `failed[]` | no | user-visible; the error names the file's problem |
| `[github] user search rate-limited (HTTP <status>), resets at <iso>` | `src/server/github/index.ts:291` (warn, ≤ 1/min) | GitHub throttled the Share dialog's user search; the route answers `limited: true` | occasional under heavy sharing | nothing; autocomplete resumes at `resets at` |
| `[og] fonts` + error | `src/server/og/document-card.tsx:70` | the link-preview card's font files are unreadable | no | the image is missing its fonts (Dockerfile fonts `COPY`); cards render in fallback fonts |
| `[pdf] browser close still running after <ms> ms; leaving it to process exit` | `src/server/export/pdf.ts:75` (warn) | Chromium did not close within its bound after a PDF export | no, rare | a Chromium may linger until the next restart; watch memory |

The stream guards are installed before anything reads the request or writes the response (`server/index.ts:164–169`). `ECONNRESET`, `ECONNABORTED`, `EPIPE`, `ERR_STREAM_DESTROYED` and `ERR_STREAM_PREMATURE_CLOSE` are expected disconnects and stay silent (`server/request-guards.ts:20–26`, `:45–46`). For each emitted stream error, the guard writes at most one line on that stream. It includes only the method, redacted route shape and redacted error `code` (or class name); it never passes the raw URL, error message or error object to the logger. Both expected and unexpected stream errors are handled rather than rethrown, so neither reaches the process-level `uncaughtException`/`unhandledRejection` exit policy at `server/index.ts:92–98`.

### Unprefixed application and framework lines

These are the exact current spellings. The three local-access diagnostics include a leading `>`; the current loopback spelling is `localhost`, and the hostname-alias line does not contain an arrow.

| Line (as printed) | Exact source | When and how to read it |
| --- | --- | --- |
| `> Markdoc ready on http://<host>:<port> (<host kind>; <mode>)` | `server/index.ts:280` | once after the database and Next are ready; absence means startup did not complete, repetition for one replica means it restarted or the server was launched twice |
| `> Collaboration WebSocket on ws://<host>:<port>/collab` | `server/index.ts:281` | once immediately after the ready line; absence with a ready line means the captured output is incomplete |
| `> Hostname alias: http://<hostname>.local:<port>` | `server/index.ts:283`; value built at `scripts/lib/dev-origins.mjs:61–67` | once for each stable alias when `HOST` is wildcard (`0.0.0.0`/`::`); production's Dockerfile uses `0.0.0.0`. Absence is expected with a concrete `HOST`; otherwise it means the startup sequence or capture ended early. A repeated identical alias for one start is unexpected |
| `> Loopback diagnostic: http://localhost:<port>` | `server/index.ts:284` | exactly once after readiness when `HOST` is wildcard. Absence under production's wildcard host means the startup output is incomplete; repetition for one replica means another startup |
| `> Numeric diagnostic (<interface>[, virtual]): http://<address>:<port>` | `server/index.ts:285–286`; values built at `scripts/lib/dev-origins.mjs:62`, `:67` | once per unique non-internal IPv4 address when `HOST` is wildcard. Different interfaces legitimately produce several lines; no line means no eligible address, while the same address repeated in one startup is unexpected |
| `> Purged <n> document(s) from the trash` | `server/index.ts:207` | only when the startup or six-hour purge removed at least one document |
| `> Markdoc STANDBY on …` / `> Standby took over …` | `server/index.ts:275`, `:230` | local live-server promotion only; never production |
| `recordDocumentOpen failed` + error | `src/app/api/documents/[id]/collab-token/route.ts:12` | updating dashboard recency failed after access was granted |
| `PDF export unavailable:` + error cause | `src/app/api/documents/[id]/export/route.ts:55` | the PDF route answered 503 because Chromium could not launch |
| an unprefixed error/stack from a route handler | `src/server/http.ts:255` | an unexpected handler failure; the route also answers 500 and produces its `[http] 500 …` line |
| `record API token use failed` + error | `src/server/tokens.ts:213` | the once-per-minute best-effort `lastUsedAt` write failed; token authentication itself already succeeded |

`Running next.config.js provided runAfterProductionCompile` is Next 16.3.3 build output, not an application prefix (`node_modules/next/dist/build/after-production-compile.js:63–76`). It appears during `next build` only when the loaded config supplies `compiler.runAfterProductionCompile`. One occurrence is normal in a build baseline that enables the hook; absence means that expected hook was not loaded, and repetition means the build or hook ran more than once.

Other library lines without our prefix are Hocuspocus `Hocuspocus: closing connection …` (`node_modules/@hocuspocus/server/dist/hocuspocus-server.esm.js:894`, `:966`; message-queue limits), `Caught error during storeDocumentHooks. Document stays in memory to avoid data loss` (`:1547`; a database write problem, take it seriously), and `WebSocket error for peer: …` (`:1674–1675`). Next's `⨯ …` route errors and Node stack frames are framework continuations rather than application prefixes. **Not emitted by this code:** `[render]`, `[migrate]`, `[health]` — Drizzle's `migrate()` is silent and `src/app/api/health/route.ts` has no console call. Q4 in §4 classifies these unprefixed rows.

## 2. Release day: which lines are normal

- From the old replica: `> [exit] SIGTERM after <t>s; shutting down, flushing documents...` then `> [exit] process exiting with code 0 …`. From the new one: `> Markdoc ready on …` and `> Collaboration WebSocket on …`, once.
- The ingress **Startup** and **Liveness** probes (`/api/health`, `/api/health?probe=live`) never produce a per-request line: the route prints nothing and a 200 never produces an `[http]` line. They are included only in the 15-second `/api/health` `[pressure]` aggregate.
- `npm run release:verify` (README runbook step 3): its `collab:reject` check opens `/collab` with a string that is not a JWT, so **exactly one `[onAuthenticate] Invalid token (malformed)`** per run (`JWSInvalid`/`JWTInvalid` → `(malformed)`, `src/server/collab/token.ts:76`). Its other checks fetch pages, chunks and headers that answer 2xx/3xx (or 404), none of which logs. The full set the token check can print, from `collabTokenFailureMessage` (`src/server/collab/token.ts:72–79`): `Invalid token (expired)`, `(claims)`, `(signature)`, `(malformed)`, `(shape)`, and a bare `Invalid token` for anything else — six outcomes, not four.
- The `docs/custom-domain.md` post-release sign-in check: one `[auth] MissingCSRF during signin (expected from the post-release check)`.
- In the minutes after the flip: the normal four `[pressure]` gauge records/minute/replica and HTTP aggregate records, a handful of `[onAuthenticate] Invalid token (expired)` as open tabs whose token expired reconnect (they fetch a fresh one), and a few `[http] 0 …` from requests cut by the cutover. `[auth][warn] … cleared` only if `AUTH_SECRET` changed.
- Anything else in the first hour: find it in §1; a `[exit]` stderr line or a repeating `[http] 5xx` route is the rollback trigger (README runbook step 4). `[pressure]` remains diagnostic and does not change that policy.

## 3. The `[http]` line

`server/request-log.ts` starts a clock at the top of `requestHandler` (`server/index.ts:234–240`) and writes at most one stderr line when the response ends: `[http] <status> <METHOD> <route shape> <ms>ms`, e.g. `[http] 400 POST /api/documents/:id/collaborators 12ms`. The filter (`shouldLogResponse`, `server/request-log.ts:25–30`): status ≥ 500 always; 4xx unless 401 or 404; **`0`** when the response closed before any header was written (client gone, socket error — `server/request-log.ts:73`); 2xx, 3xx, 101, 401 and 404 never. A missing method prints `-`; a negative or non-finite duration prints `0`.

The route shape (`server/route-shape.ts`) drops the query string and fragment, then maps each path segment (`:157–175`): a segment on the closed **allow-list** `STATIC_SEGMENTS` (`:43–144` — every recursively discovered static folder under `src/app`, including `src/app/api`, plus recursively discovered Next metadata file routes such as `opengraph-image`, the Auth.js actions, the `public/` files, Next's `/_next/…` prefixes, `/collab` and `/_standby/takeover`) is kept; a segment that looks like an id — UUID, 12+ hex, all digits, 16+ base64url characters, or exactly 12 × `[0-9a-z]` (`:146–154`) — becomes **`:id`**; anything else becomes **`:x`** (a GitHub owner/repo, a login, a mistyped path, an unknown Auth.js action — and any *new* route until its folder or metadata file name is added to the list, the safe failure mode). The source-honesty test recursively walks folders and metadata files (`server/route-shape.test.ts:135–173`); today `opengraph-image.tsx` serves `/d/:id/opengraph-image` and `/p/:id/opengraph-image` (`server/route-shape.ts:123–124`). The shape is cut at **120** characters with a trailing `...` (`ROUTE_SHAPE_MAX_LENGTH`, `:31`, `:182–187`). No login, e-mail, title or token can reach a line. A *thrown* handler error produces two lines for one event: `[http] request failed` with the stack (`server/index.ts:262`) and then `[http] 500 <METHOD> <shape> <ms>ms` — what broke, and which route and how long.

### Pressure aggregates

`server/pressure-observability.ts` writes process-local aggregates to stdout every 15 seconds. A window emits one `kind:"gauges"` line and, only when request activity occurred, one `kind:"http"` line. The HTTP line contains at most 24 method/route series; excess series are combined as `OTHER /:overflow`. Methods are limited to `GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|OTHER`, and routes use the same closed, 120-character route shape described above. This bounds both line count and labels without retaining a per-request label.

An HTTP series has `accepted`, `completed` and `aborted` counts. `accepted` is recorded when Node invokes the request callback; `completed` means the response emitted `finish`; `aborted` means it closed first. A request crossing a window boundary therefore contributes `accepted` to its first window and its terminal count to a later one. The collector owns and removes its exact response and socket callbacks when they settle. Shutdown invalidates and removes any callbacks still open, clears their active entries, and cannot remove another subsystem's listener; a stale callback invoked after that boundary is a no-op. The three arrays are exact, non-cumulative bucket counts:

| Field | Array indexes |
| --- | --- |
| `duration_ms` | `0` ≤100 ms; `1` 101–500 ms; `2` 501–2,000 ms; `3` 2,001–10,000 ms; `4` >10,000 ms |
| `request_bytes`, `response_bytes` | `0` zero; `1` 1–1,024 B; `2` 1,025–65,536 B; `3` 65,537–1,048,576 B; `4` >1,048,576 B; `5` unknown |

Size means a valid non-negative `Content-Length`; chunked or absent lengths are `unknown`. The collector never reads or stores a body. The gauge record contains only integers:

| Gauge | Meaning at the end of the window |
| --- | --- |
| `active_requests`, `active_request_age_max_ms` | requests still open and the oldest one's current age |
| `tcp_open`, `tcp_accepted` | currently open TCP sockets across the main and standby listeners; new sockets during the window |
| `upgrades_open`, `upgrades_accepted` | currently open upgraded sockets; upgrade events during the window |
| `event_loop_delay_max_ms` | maximum Node event-loop delay observed during the window |
| `pg_total`, `pg_idle`, `pg_waiting` | node-postgres pool counts; zero when PostgreSQL is not active |
| `pg_checkout_max_ms` | largest completed checkout latency during the window or current age of a checkout still pending |
| `collab_connections` | Hocuspocus WebSocket plus direct connections |
| `render_queue`, `render_inflight` | Markdown worker jobs waiting and running |
| `pdf_queue`, `pdf_inflight` | PDF jobs waiting and running; the current implementation has no app queue, so `pdf_queue` is zero |
| `long_polls` | agent event requests currently asleep waiting for a wake-up |
| `webhook_inflight`, `webhook_retries` | outbound webhook HTTP attempts running and retry timers waiting |
| `gauge_failures` | fixed-name gauge providers that failed to read; their value is reported as zero |
| `collector_failures` | cumulative, bounded failures in the process-local gauge/event-loop collector; a failed collection reports fixed gauges as zero |
| `output_failures` | cumulative, bounded stdout sink failures; reporting a failure never recursively writes another line |

Collector and output failures are contained inside this passive diagnostic path: timer and final-shutdown collection cannot throw into server startup, request handling or shutdown. No pressure record includes a query string, address, header, cookie, token, user, document or webhook identifier, webhook URL, document content, request/response body, or error. Existing `[http]` failure logging is unchanged.

## 4. KQL cheat sheet

Workspace `38faa130-4081-42a2-b43b-6ee128652871`; tables `ContainerAppConsoleLogs_CL` (`Stream_s`, `Log_s`, `RevisionName_s`, `ContainerGroupName_s` = replica) and `ContainerAppSystemLogs_CL` (`Reason_s`, `Log_s`, `ReplicaName_s`). Ingestion lags 60–150 s. Run any query with `az monitor log-analytics query -w 38faa130-4081-42a2-b43b-6ee128652871 --analytics-query "<query>" -o table` (PowerShell: put the query in a `@'…'@` here-string and pass the variable). **Windows:** `az.cmd` crashes client-side on any glyph outside cp1252 in what it prints — the README's `▲` case ([Production runbook: app-only releases](../README.md#production-runbook-app-only-releases), step 1); a `Log_s` carrying `→`, `≈` or `▲` does the same, so use the same fix: `$env:AZ_INSTALLER='MSI'; & "C:\Program Files\Microsoft SDKs\Azure\CLI2\python.exe" -X utf8 -IBm azure.cli monitor log-analytics query -w … --analytics-query $q -o table`.

```kusto
// Q1 — lines by prefix, last 24 h (handles the "> " of [exit] and the second tag of [auth][warn])
ContainerAppConsoleLogs_CL
| where TimeGenerated > ago(24h) and ContainerAppName_s == "markdoc"
| extend prefix = extract(@"^(?:> )?(\[[^\]]+\](?:\[[^\]]+\])?)", 1, Log_s)
| where isnotempty(prefix)
| summarize n = count(), last = max(TimeGenerated) by prefix, Stream_s
| order by n desc

// Q2 — [http] by status × route with durations (§3; excludes request-failed and stream-error lines)
ContainerAppConsoleLogs_CL
| where TimeGenerated > ago(24h) and ContainerAppName_s == "markdoc"
| where Log_s startswith "[http] "
  and not(Log_s startswith "[http] request failed")
  and not(Log_s startswith "[http] request error")
  and not(Log_s startswith "[http] response error")
| parse Log_s with "[http] " status:int " " method:string " " route:string " " ms:int "ms"
| summarize n = count(), p50_ms = percentile(ms, 50), max_ms = max(ms) by status, method, route
| order by status desc, n desc

// Q3 — restarts and probe failures from the platform (the log-side view of RestartCount)
ContainerAppSystemLogs_CL
| where TimeGenerated > ago(24h) and ContainerAppName_s == "markdoc"
| where Reason_s == "ContainerTerminated" or Log_s matches regex @"(?i)probe|restart|terminated|crash|oom|back-?off"
| project TimeGenerated, RevisionName_s, ReplicaName_s, Reason_s, Log_s
| order by TimeGenerated desc

// Q4 — "new error class": stderr lines that carry none of the known prefixes (drops stack frames and other indented continuation rows)
let known = dynamic(["[http]", "[pressure]", "[db]", "[exit]", "[trash]", "[standby]", "[onAuthenticate]", "[onLoadDocument]", "[collab]", "[websocket]",
  "[auth]", "[proxy]", "[public-origin]", "[activity]", "[notifications]", "[agent-requests]", "[reviews]", "[webhooks]", "[import]", "[github]",
  "[og]", "[pdf]", "[assets]", "[collaborators]", "[comments]", "[content]", "[documents]", "[link]", "[publish]", "[pull]", "[requests]",
  "[suggest]", "[suggestions]", "[version]", "[versions]"]);
ContainerAppConsoleLogs_CL
| where TimeGenerated > ago(24h) and ContainerAppName_s == "markdoc" and Stream_s == "stderr"
| extend prefix = extract(@"^(?:> )?(\[[^\]]+\])", 1, Log_s)
| where isempty(prefix) or prefix !in (known)
| where not(Log_s startswith " ") and Log_s != "}"
| summarize n = count(), sample = take_any(Log_s), last = max(TimeGenerated) by head = substring(Log_s, 0, 60)
| order by n desc

// Q5 — HTTP pressure by minute × replica × normalized route
ContainerAppConsoleLogs_CL
| where TimeGenerated > ago(24h) and ContainerAppName_s == "markdoc" and Log_s startswith "[pressure] "
| extend p = parse_json(substring(Log_s, 11))
| where tostring(p.kind) == "http"
| mv-expand s = p.series
| extend accepted = tolong(s.accepted), completed = tolong(s.completed), aborted = tolong(s.aborted),
    duration_gt_10s = tolong(s.duration_ms[4]),
    request_gt_1mib = tolong(s.request_bytes[4]), request_unknown = tolong(s.request_bytes[5]),
    response_gt_1mib = tolong(s.response_bytes[4]), response_unknown = tolong(s.response_bytes[5])
| summarize accepted = sum(accepted), completed = sum(completed), aborted = sum(aborted),
    duration_gt_10s = sum(duration_gt_10s),
    request_gt_1mib = sum(request_gt_1mib), request_unknown = sum(request_unknown),
    response_gt_1mib = sum(response_gt_1mib), response_unknown = sum(response_unknown)
    by bin(TimeGenerated, 1m), RevisionName_s, ContainerGroupName_s,
       method = tostring(s.method), route = tostring(s.route)
| order by TimeGenerated desc, accepted desc

// Q6 — latest pressure gauges in each minute, per replica
ContainerAppConsoleLogs_CL
| where TimeGenerated > ago(24h) and ContainerAppName_s == "markdoc" and Log_s startswith "[pressure] "
| extend p = parse_json(substring(Log_s, 11))
| where tostring(p.kind) == "gauges"
| summarize arg_max(TimeGenerated, p) by minute = bin(TimeGenerated, 1m), RevisionName_s, ContainerGroupName_s
| project minute, RevisionName_s, ContainerGroupName_s,
    active_requests = tolong(p.active_requests), active_request_age_max_ms = tolong(p.active_request_age_max_ms),
    tcp_open = tolong(p.tcp_open), tcp_accepted = tolong(p.tcp_accepted),
    upgrades_open = tolong(p.upgrades_open), upgrades_accepted = tolong(p.upgrades_accepted),
    event_loop_delay_max_ms = tolong(p.event_loop_delay_max_ms),
    pg_total = tolong(p.pg_total), pg_idle = tolong(p.pg_idle), pg_waiting = tolong(p.pg_waiting),
    pg_checkout_max_ms = tolong(p.pg_checkout_max_ms), collab_connections = tolong(p.collab_connections),
    render_queue = tolong(p.render_queue), render_inflight = tolong(p.render_inflight),
    pdf_queue = tolong(p.pdf_queue), pdf_inflight = tolong(p.pdf_inflight),
    long_polls = tolong(p.long_polls), webhook_inflight = tolong(p.webhook_inflight),
    webhook_retries = tolong(p.webhook_retries), gauge_failures = tolong(p.gauge_failures),
    collector_failures = tolong(p.collector_failures), output_failures = tolong(p.output_failures)
| order by minute desc, ContainerGroupName_s asc
```

A new `[prefix]` in Q1 or a new head in Q4 after a release is the first thing to read against the release's PR list; add it to §1 and to Q4's `known` list once it is understood.

Q5 and Q6 are alert-independent diagnostics, not alert definitions or thresholds. Start with the replica and minute of an observed ingress or liveness event. Accepted requests without nearby terminal counts plus rising active age show requests being held; TCP/upgrade counts separate listener pressure from collaboration sockets; event-loop delay distinguishes a blocked loop; and the fixed subsystem gauges show which bounded resource was occupied. Compare adjacent windows because a long request's accepted and terminal events can land in different windows. These correlations narrow a source path but do not identify a user, document, payload, remote endpoint, or causal root by themselves.

## 5. Where the lines go

stdout/stderr → Container Apps console logs → Log Analytics (`ContainerAppConsoleLogs_CL`; the workspace keeps 30 days under a 1 GiB/day cap — README cost table under [Provisioning a new environment](../README.md#provisioning-a-new-environment); task #1424 measured the app's pre-pressure-observability share at 4.66 MB per 30 days). Nothing alerts on these lines yet: the paragraph right after that table says what the post-release watch covers instead, and the health-check paragraph under [Deploy to Azure](../README.md#deploy-to-azure) introduces the `[db]` and `[http]` lines. The `[pressure]` records stay in console logs for the on-demand Q5/Q6 correlation above; this change does not create an alert, probe, scale rule, limit, timeout or load-shedding path.
