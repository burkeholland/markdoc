# Operator log lines: what the server prints and what it means

> **Historical console/collection reference:** the census below is pinned to
> September 2 source. Container Apps log tables, revision fields and ingestion
> timings do not describe the current VM service. Follow the
> [VM diagnostic guidance](vm-hosting.md#health-and-safe-diagnostics) for bounded
> nonsecret service/health metadata. Full journals, command results, exceptions
> and environment/unit dumps are not guaranteed safe to publish.

Every line the production server can write to its console, taken from the code at `568fb99` (2026-09-02). The reproducible source census is:

```sh
git grep -n -E 'console\.(error|warn|log)\(' -- server src/server src/proxy.ts ':(glob)src/app/**/route.ts' ':(exclude,glob)**/*.test.*' ':(exclude,glob)**/*.integration.test.*'
git grep -n -E 'warnTail\("[^"]+"' -- src/server ':(glob)src/app/**/route.ts' ':(exclude,glob)**/*.test.*'
```

It finds 32 application bracket-prefix families. Hocuspocus contributes the two hook prefixes `[onAuthenticate]` and `[onLoadDocument]`, making the 34 families in §1 and Q4's `known` list; the unprefixed application lines and Next/Hocuspocus exceptions are classified after the table. `console.log` lines land on **stdout**, `console.warn`/`console.error` on **stderr**; in Log Analytics that is `Stream_s`, the text is `Log_s` (§5). A `console.error(msg, err)` arrives as one row per line: the prefixed line, then the stack frames (`    at …`) and error properties as unprefixed rows of their own. Nothing here is a metric — the runbook's post-release watch is in the README ([Deploy to Azure](../README.md#deploy-to-azure)).

## 1. Every prefixed line

| Line (as printed) | Source | Fires when | Steady state | If it appears unexpectedly |
| --- | --- | --- | --- | --- |
| `[http] <status> <METHOD> <route shape> <ms>ms` | `server/request-log.ts:46` (format), `:67` (stderr) | a response ended with status ≥ 500, a 4xx other than 401/404, or `0` (client gone before any header) — §3 | yes, low rate: 400s from clients, occasional `0` | a new `5xx` route = a bug in that route; a burst of `0` = clients dropping (ingress, deploy flip) |
| `[http] request error <METHOD> <route shape> <code>` | `server/request-guards.ts:31` (format), `:64`, `:66` (stderr); installed at `server/index.ts:165` | the Node request stream emitted an error other than an expected client-disconnect code | no | the code or error class identifies the stream failure; the raw URL and error message are not logged |
| `[http] response error <METHOD> <route shape> <code>` | `server/request-guards.ts:31` (format), `:64`, `:69` (stderr); installed at `server/index.ts:165` | the Node response stream emitted an error other than an expected client-disconnect code | no | as above; `ERR_STREAM_WRITE_AFTER_END` usually means application code wrote after ending the response |
| `[http] request failed` + stack | `server/index.ts:255` | Next's request handler *threw* (rejected promise); answered `500 internal server error` | no | the stack is the bug; its `[http] 500 …` line follows (two lines, one event) |
| `[db] idle client error: <message>` | `src/server/db/index.ts:49` (warn) | node-postgres dropped an idle pooled connection (PostgreSQL restart, `pg_terminate_backend`, VM patching, network blip); the next query reconnects | expected in the OS-patch window and around a database restart | outside a known window: check the VM (`/api/health` `latencyMs`, Syslog); a stream of them = the VM is flapping |
| `> [exit] shutdown started: trigger=<SIGTERM\|SIGINT\|startup> deadline=<n>ms` | `server/shutdown.ts:33` (stdout); owner installed at `server/index.ts:165–180`, startup handoff at `:392–394` | the first signal or startup failure claims the one shutdown owner; `<n>` is the total bound (`10000` by default) | yes with `SIGTERM`, once per release from the old replica | `SIGINT` is an operator/local stop; `SIGTERM` without a release or scale event means the platform stopped the app (§4 Q3); `startup` always ends in the failed summary and exit code 1 |
| `> [exit] shutdown complete: trigger=<SIGTERM\|SIGINT> intake=ok publishing=ok collaboration=ok database=ok deadline=ok` | `server/shutdown.ts:70–78` (stdout) | HTTP/WebSocket intake, publishing and collaboration shutdown all settled successfully, then the database closed, all inside the bound | yes after the shutdown-started line; process exit code 0 follows | absence after a started line means the output is incomplete or the process was forcibly terminated before its bound |
| `> [exit] shutdown failed: trigger=<SIGTERM\|SIGINT\|startup> intake=<pending\|ok\|failed> publishing=<pending\|ok\|failed> collaboration=<pending\|ok\|failed> database=<pending\|ok\|failed> deadline=<ok\|failed>` | `server/shutdown.ts:39–79` (stderr) | startup failed, a named phase rejected, or the total deadline elapsed; the summary contains phase results only, never errors or service data | no | `failed` identifies a phase that rejected; `pending` identifies work unfinished when `deadline=failed` (the database can remain pending if an earlier phase never settled); process exit code 1 follows |
| `> [exit] process exiting with code <n> after <t>s` | `server/index.ts:87–89` (stdout) | Node runs its process-exit handler | yes, `code 0` immediately after `shutdown complete` | `code 1` after `shutdown failed` preserves the owner's incomplete/startup-failure result; after an uncaught-error line it is a crash; no terminal shutdown summary can mean a force-kill or incomplete log capture |
| `> [exit] uncaughtException after <t>s: <stack>` / `> [exit] unhandledRejection after <t>s: <stack>` | `server/index.ts:92–98` | an error nobody caught; the process exits 1 and the container restarts | no | the stack is the bug; `RestartCount` rises; if it repeats, roll back (README runbook step 4) |
| `[trash] purge failed` + error | `server/index.ts:201` | the 6-hourly purge of documents trashed > `TRASH_RETENTION_DAYS` threw | no | a database error; the next run retries in 6 h — one line is noise, a series is the database |
| `[standby] takeover failed` + error | `server/index.ts:240` | `POST /_standby/takeover` on a standby process (local `scripts/live/promote.ps1` only) | never in production (`STANDBY_PORT` unset) | production printing it means the env changed — stop and look |
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
| `[pdf] launched Chromium <version>` | `src/server/export/pdf.ts:200` (stdout) | a PDF export started a Chromium: the first export, the first after 60 s without one, or the first after a browser was closed | yes, about once per burst of exports | nothing; `<version>` is the Chromium the image ships, to compare with Chrome's current stable version |
| `[pdf] browser close still running after <ms> ms; leaving it to process exit` | `src/server/export/pdf.ts:254` (warn) | Chromium did not close within its bound after a PDF export | no, rare | a Chromium may linger until the next restart; watch memory |
| `[pdf] render stopped after 60000 ms; closing Chromium` | `src/server/export/pdf.ts:398` (warn) | one PDF took longer than 60 s from the moment it had the renderer, and a Chromium was in use for it; the request answered 503 and the browser is closed | no | one very large document, or a Chromium that hangs; a series means exports that never fit the limit or a starved machine |
| `[pdf] render stopped after 60000 ms; its page was still being built, no Chromium was in use` | `src/server/export/pdf.ts:401` (warn) | as above, but the 60 s passed while the page was built (Markdown to HTML, pictures read and embedded); the request answered 503, no browser was closed | no | a slow database or a starved machine; the page that was being built is dropped when it is done |
| `[pdf] export refused: <reason>, <signed in\|anonymous> caller, <n> waiting` | `src/server/export/pdf.ts:319` (warn) | a PDF export answered 503 with `Retry-After: 10` without being rendered. `<reason>` is `queue-full` (all 8 places taken and no caller held two more than this one), `place-given` (this request waited, and its place went to a caller that held at least two fewer) or `queue-wait` (it waited 30 s). Of the caller only whether it is signed in; `<n>` is how many requests wait when the line is written. No document, user or address | occasional; one line per refused request | a few: nothing. A steady stream with `anonymous`: one or more callers without a session ask for more PDFs than one renderer makes; they only take turns from each other, a signed-in user still gets half of a full queue. A steady stream with `signed in`: several users at once, or one script that does not wait for its answers |
| `[pdf] Chromium did not close within 10000 ms and was killed` | `src/server/export/pdf.ts:288` (warn) | after a stopped render the browser did not close within its bound, and its process (the id it reported at launch, a child of this server, start time still the same) was ended | no, rare | Chromium was hung; the next export starts a new one |
| `[pdf] Chromium did not close within 10000 ms; its process could not be identified, leaving it to Playwright` | `src/server/export/pdf.ts:290` (warn) | as above, but the process id was unknown, did not belong to a child of this server, or no longer belonged to that Chromium, so nothing was killed | no, rare | Playwright ends the browser about 30 s after the close was asked; watch memory until then |
| `[pdf] <n> image(s) left out: content is not an allowed image type; <m> inlined under the type its bytes are` | `src/server/export/html.ts:246` (warn) | a PDF export met uploads whose bytes are not what they were stored as (stored before uploads were checked): `<n>` show as their alt text, `<m>` were embedded under the type their bytes are. Counts only, no document, file or user | occasional, for documents with old uploads | nothing for old documents; the same line for newly uploaded images would mean the upload check is being passed by |

The stream guards are installed before anything reads the request or writes the response (`server/index.ts:161–165`). `ECONNRESET`, `ECONNABORTED`, `EPIPE`, `ERR_STREAM_DESTROYED` and `ERR_STREAM_PREMATURE_CLOSE` are expected disconnects and stay silent (`server/request-guards.ts:20–26`, `:45–46`). For each emitted stream error, the guard writes at most one line on that stream. It includes only the method, redacted route shape and redacted error `code` (or class name); it never passes the raw URL, error message or error object to the logger. Both expected and unexpected stream errors are handled rather than rethrown, so neither reaches the process-level `uncaughtException`/`unhandledRejection` exit policy at `server/index.ts:92–99`.

### Unprefixed application and framework lines

These are the exact current spellings. The three local-access diagnostics include a leading `>`; the current loopback spelling is `localhost`, and the hostname-alias line does not contain an arrow.

| Line (as printed) | Exact source | When and how to read it |
| --- | --- | --- |
| `> Markdoc ready on http://<host>:<port> (<host kind>; <mode>)` | `server/index.ts:270` | once after the database and Next are ready; absence means startup did not complete, repetition for one replica means it restarted or the server was launched twice |
| `> Collaboration WebSocket on ws://<host>:<port>/collab` | `server/index.ts:271` | once immediately after the ready line; absence with a ready line means the captured output is incomplete |
| `> Hostname alias: http://<hostname>.local:<port>` | `server/index.ts:273`; value built at `scripts/lib/dev-origins.mjs:61–67` | once for each stable alias when `HOST` is wildcard (`0.0.0.0`/`::`); production's Dockerfile uses `0.0.0.0`. Absence is expected with a concrete `HOST`; otherwise it means the startup sequence or capture ended early. A repeated identical alias for one start is unexpected |
| `> Loopback diagnostic: http://localhost:<port>` | `server/index.ts:274` | exactly once after readiness when `HOST` is wildcard. Absence under production's wildcard host means the startup output is incomplete; repetition for one replica means another startup |
| `> Numeric diagnostic (<interface>[, virtual]): http://<address>:<port>` | `server/index.ts:275–276`; values built at `scripts/lib/dev-origins.mjs:62`, `:67` | once per unique non-internal IPv4 address when `HOST` is wildcard. Different interfaces legitimately produce several lines; no line means no eligible address, while the same address repeated in one startup is unexpected |
| `> Purged <n> document(s) from the trash` | `server/index.ts:200` | only when the startup or six-hour purge removed at least one document |
| `> Markdoc STANDBY on …` / `> Standby took over …` | `server/index.ts:265`, `:223` | local live-server promotion only; never production |
| `recordDocumentOpen failed` + error | `src/app/api/documents/[id]/collab-token/route.ts:12` | updating dashboard recency failed after access was granted |
| `PDF export unavailable:` + error cause | `src/app/api/documents/[id]/export/route.ts:56` | the PDF route answered 503 because Chromium could not launch |
| an unprefixed error/stack from a route handler | `src/server/http.ts:255` | an unexpected handler failure; the route also answers 500 and produces its `[http] 500 …` line |
| `record API token use failed` + error | `src/server/tokens.ts:213` | the once-per-minute best-effort `lastUsedAt` write failed; token authentication itself already succeeded |

`Running next.config.js provided runAfterProductionCompile` is Next 16.3.3 build output, not an application prefix (`node_modules/next/dist/build/after-production-compile.js:63–76`). It appears during `next build` only when the loaded config supplies `compiler.runAfterProductionCompile`. One occurrence is normal in a build baseline that enables the hook; absence means that expected hook was not loaded, and repetition means the build or hook ran more than once.

Other library lines without our prefix are Hocuspocus `Hocuspocus: closing connection …` (`node_modules/@hocuspocus/server/dist/hocuspocus-server.esm.js:894`, `:966`; message-queue limits), `Caught error during storeDocumentHooks. Document stays in memory to avoid data loss` (`:1547`; a database write problem, take it seriously), and `WebSocket error for peer: …` (`:1674–1675`). Next's `⨯ …` route errors and Node stack frames are framework continuations rather than application prefixes. **Not emitted by this code:** `[render]`, `[migrate]`, `[health]` — Drizzle's `migrate()` is silent and `src/app/api/health/route.ts` has no console call. Q4 in §4 classifies these unprefixed rows.

## 2. Release day: which lines are normal

- From the old replica: `> [exit] shutdown started: trigger=SIGTERM deadline=10000ms`, then `> [exit] shutdown complete: trigger=SIGTERM intake=ok publishing=ok collaboration=ok database=ok deadline=ok`, then `> [exit] process exiting with code 0 …`. From the new one: `> Markdoc ready on …` and `> Collaboration WebSocket on …`, once.
- The ingress **Startup** and **Liveness** probes (`/api/health`, `/api/health?probe=live`) never log: the route prints nothing and a 200 never produces an `[http]` line.
- `npm run release:verify` (README runbook step 3): `collab:idle` opens `/collab`, sends no application frame and expects a `4401` close without logging; the separate `collab:reject` check sends a string that is not a JWT, so **exactly one `[onAuthenticate] Invalid token (malformed)`** per run (`JWSInvalid`/`JWTInvalid` → `(malformed)`, `src/server/collab/token.ts:76`). Its other checks fetch pages, chunks and headers that answer 2xx/3xx (or 404), none of which logs. The full set the token check can print, from `collabTokenFailureMessage` (`src/server/collab/token.ts:72–79`): `Invalid token (expired)`, `(claims)`, `(signature)`, `(malformed)`, `(shape)`, and a bare `Invalid token` for anything else — six outcomes, not four.
- The `docs/custom-domain.md` post-release sign-in check: one `[auth] MissingCSRF during signin (expected from the post-release check)`.
- In the minutes after the flip: a handful of `[onAuthenticate] Invalid token (expired)` as open tabs whose token expired reconnect (they fetch a fresh one), and a few `[http] 0 …` from requests cut by the cutover. `[auth][warn] … cleared` only if `AUTH_SECRET` changed.
- Anything else in the first hour: find it in §1; `[exit] shutdown failed`, an uncaught-error `[exit]` line or a repeating `[http] 5xx` route is the rollback trigger (README runbook step 4).

## 3. The `[http]` line

`server/request-log.ts` starts a clock at the top of `requestHandler` (`server/index.ts:227–233`) and writes at most one stderr line when the response ends: `[http] <status> <METHOD> <route shape> <ms>ms`, e.g. `[http] 400 POST /api/documents/:id/collaborators 12ms`. The filter (`shouldLogResponse`, `server/request-log.ts:25–30`): status ≥ 500 always; 4xx unless 401 or 404; **`0`** when the response closed before any header was written (client gone, socket error — `server/request-log.ts:73`); 2xx, 3xx, 101, 401 and 404 never. A missing method prints `-`; a negative or non-finite duration prints `0`.

The route shape (`server/route-shape.ts`) drops the query string and fragment, then maps each path segment (`:157–175`): a segment on the closed **allow-list** `STATIC_SEGMENTS` (`:43–144` — every recursively discovered static folder under `src/app`, including `src/app/api`, plus recursively discovered Next metadata file routes such as `opengraph-image`, the Auth.js actions, the `public/` files, Next's `/_next/…` prefixes, `/collab` and `/_standby/takeover`) is kept; a segment that looks like an id — UUID, 12+ hex, all digits, 16+ base64url characters, or exactly 12 × `[0-9a-z]` (`:146–154`) — becomes **`:id`**; anything else becomes **`:x`** (a GitHub owner/repo, a login, a mistyped path, an unknown Auth.js action — and any *new* route until its folder or metadata file name is added to the list, the safe failure mode). The source-honesty test recursively walks folders and metadata files (`server/route-shape.test.ts:135–173`); today `opengraph-image.tsx` serves `/d/:id/opengraph-image` and `/p/:id/opengraph-image` (`server/route-shape.ts:123–124`). The shape is cut at **120** characters with a trailing `...` (`ROUTE_SHAPE_MAX_LENGTH`, `:31`, `:182–187`). No login, e-mail, title or token can reach a line. A *thrown* handler error produces two lines for one event: `[http] request failed` with the stack (`server/index.ts:255`) and then `[http] 500 <METHOD> <shape> <ms>ms` — what broke, and which route and how long.

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
let known = dynamic(["[http]", "[db]", "[exit]", "[trash]", "[standby]", "[onAuthenticate]", "[onLoadDocument]", "[collab]", "[websocket]",
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
```

A new `[prefix]` in Q1 or a new head in Q4 after a release is the first thing to read against the release's PR list; add it to §1 and to Q4's `known` list once it is understood.

## 5. Where the lines go

stdout/stderr → Container Apps console logs → Log Analytics (`ContainerAppConsoleLogs_CL`; the workspace keeps 30 days under a 1 GiB/day cap — README cost table under [Provisioning a new environment](../README.md#provisioning-a-new-environment); task #1424 measured the app's share at 4.66 MB per 30 days). Nothing alerts on these lines yet: the paragraph right after that table says what the post-release watch covers instead, and the health-check paragraph under [Deploy to Azure](../README.md#deploy-to-azure) introduces the `[db]` and `[http]` lines. Neither is repeated here.
