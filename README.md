# Markdoc

Markdown, together. Write Markdown with other people in real time, edit the **source** or the **rendered page** (both are live for everyone), review with **comments** and **suggestions**, keep every **version**, and **publish** to a GitHub gist or repository.

![Markdoc dashboard](docs/dashboard.png)

![Markdoc editor](docs/screenshot.png)

*Reviewing an agent's proposal:* an agent connected through MCP proposed edits and left a comment; the human accepts or rejects them in the app.

![Agent review](docs/agent-review.png)

## What it does

What changed recently is in [CHANGELOG.md](CHANGELOG.md).

### Writing

- Two-pane live editor: CodeMirror source and a ProseMirror rich pane side by side; type in either, the other follows instantly.
- Markdown-aware typing in the code pane: a third `` ` `` opens a fenced block, backticks never auto-pair, `*` `_` `` ` `` `[` wrap the selection, Tab / Shift-Tab nest and outdent list items.
- GitHub Flavored Markdown (tables, task lists, footnotes, front matter, raw HTML kept) with a linter in the status bar and jump-to-line.
- Slash menu: type `/` in the rich pane for headings, lists, tables, code blocks with a language, images, links, comments, today's date.
- Command palette (`Ctrl+Shift+P`, or `Ctrl+K` with nothing selected) for every editor and dashboard command.
- Find & replace across both panes (`Ctrl+F` / `Ctrl+H`; `⌘F` / `⌥⌘F` on a Mac), with live highlights; editors see the replace row as soon as the bar opens.
- Smart paste: a URL over a selection becomes a link, Markdown-looking text is inserted as source, HTML keeps bold/lists, and tab-separated plain text (a spreadsheet range, `psql` or `jq -r @tsv` output) becomes a table in either pane.
- Tables with a floating menu and shortcuts for rows, columns and alignment.
- Images by paste, drop or upload, stored as assets behind `/api/assets`.
- Document statistics and a shared writing goal (`Ctrl+Shift+C`): words, sentences, reading time, selection counts.
- Templates: meeting notes, design doc, weekly status, blog post, decision record, checklist and more.
- Dark mode: system / light / dark, applied before paint so there is no flash; toggle in the status bar, dashboard header, `/settings` and the command palette. Exports keep the light print stylesheet.
- Accessible by keyboard and screen reader: skip link and landmarks, a one-tab-stop toolbar with arrow keys, dialogs and the palette return focus to what opened them, AA contrast in both themes; every screen is scanned with axe in the e2e suite.

### Collaborating

- Real-time editing over Yjs and WebSockets with presence avatars and live carets in both panes; hover an avatar to see which section a collaborator is in, click to jump there or follow their cursor (`Esc` stops).
- Comments anchored to text that follow the words as they move; reply, edit, resolve, reopen; `@mentions` with a suggestions popover.
- Suggesting mode: edits become tracked changes (green/red) that anyone with edit access can accept or reject, one by one or all at once.
- Version history with automatic snapshots, named versions, word-level diffs and one-click restore.
- Version compare: diff any two versions, swap sides, step through hunks, see moved paragraphs as moves, rename a version or copy it as a new document.
- Activity panel per document: who edited, commented, suggested, published or shared, with agents marked.
- Notifications: a bell in the editor header and a strip on the dashboard when someone replies to your thread, resolves it, accepts or rejects your suggestion, shares with you or @mentions you; `?thread=` links open the thread.
- Share by GitHub handle as editor, commenter or viewer, or by link (restricted, view, comment, edit).
- Reader view at `/p/<id>`: clean read-only page with a table of contents, reading time and download menu.
- Offline editing that survives a refresh or a closed tab; edits merge on reconnect and the header shows what is unsaved.

### Organising

- Dashboard search looks inside document content and shows a snippet around each match.
- Stars, recently opened, and sort order that is remembered.
- Templates gallery on the dashboard and in the empty state.
- Trash with restore for 30 days, then permanent deletion.
- Make a copy of any document you can view.

### Exporting

- Markdown, standalone HTML (images embedded) or a Letter PDF from the header menu or `GET /api/documents/:id/export`.
- Publish to a GitHub gist or a repository file (a real commit on the branch you choose); import from either.
- Safe sync with GitHub: the Publish button shows whether the document is in sync, ahead, behind or diverged; publish and pull refuse to overwrite the other side, and the Sync dialog merges three-way (conflicts left as markers the linter flags), keeps yours or takes GitHub's.

### Agents

- Personal API tokens, a REST API, and an MCP server (`mcp/server.mjs`) so GitHub Copilot, Claude or scripts can create documents, propose tracked changes and answer comments; the app shows who did what. A `2xx` may carry `warnings: string[]` (the change landed, a follow-up record did not). See [docs/agents.md](docs/agents.md).
- Copilot CLI as a collaborator: Markdoc serves MCP itself at `/api/mcp` (Streamable HTTP) — paste the config from the Share dialog's *Collaborate with an agent* card and the agent sits in the document with a bot avatar, a status and its own caret (`markdoc_presence`), waits for comments, edits, mentions and requests with `markdoc_watch`, and can be called by name as `@you/Copilot-CLI` from the `@` picker in any comment. See [What an agent session looks like](docs/agents.md#what-an-agent-session-looks-like).
- Fewer permission prompts: every tool carries MCP annotations (read-only, additive, destructive), so Copilot CLI never asks before a read, and the Share and Connect cards carry a `copilot --allow-tool …` line that pre-allows the safe writes for a session. See [Permissions in Copilot CLI](docs/agents.md#permissions-in-copilot-cli).
- **Requests are comments**: select text (or nothing), press **Comment**, @-mention the agent and write the instruction; a row under the box chooses how it should answer (tracked changes, comment only, rewrite). The request waits in an inbox agents read over MCP (`markdoc_list_requests` → `markdoc_claim_request` → work with `requestId` in the comment's thread → `markdoc_complete_request`); the thread carries a chip from *Waiting for an agent* to *Done*, with Cancel, and the people stack in the header tracks it live (a spinner badge on the agent's avatar, or a dashed placeholder while no agent is in the document). The answer lands in the same thread, as suggestions plus a notification. A request is addressed to the agent you mentioned: only that person's token lists, claims and completes it, and by default only its owner may ask it — someone else's agent shows as *Burke's Copilot CLI*, greyed out with a lock in the `@` picker, and the composer refuses to send until the owner turns on **Collaborators may ask this agent** under **Settings → Agents**. Nothing runs server-side — your own Copilot CLI does the work. With no agent connected yet, the `@` picker points to the *Connect an agent* card in Settings with the MCP config for the host you are on. See [Requests](docs/agents.md#requests).

Sign in is GitHub only (OAuth), with a development login for local work.

### Keyboard shortcuts

`Ctrl` is `Cmd` on macOS. Press `Ctrl+/` in the editor for the full list.

| Shortcut | Action |
| --- | --- |
| `Ctrl+Shift+P` | Command palette |
| `Ctrl+K` | Command palette (no selection) / Link (with a selection) |
| `Ctrl+F` / `Ctrl+H` (`⌘F` / `⌥⌘F` on a Mac) | Find / Find and replace |
| `Ctrl+Shift+C` | Document statistics and writing goal |
| `Ctrl+Alt+M` | Add a comment on the selection |
| `Ctrl+B` / `Ctrl+I` / `Ctrl+Shift+X` | Bold / Italic / Strikethrough |
| `` Ctrl+` `` | Inline code |
| `Ctrl+Alt+1…6` / `Ctrl+Alt+0` | Heading 1–6 / Paragraph |
| `Ctrl+Shift+8` / `Ctrl+Shift+7` / `Ctrl+Shift+9` | Bulleted / Numbered / Task list |
| `Ctrl+Alt+C` | Code block |
| `Ctrl+Alt+↓` / `Ctrl+Alt+→` | Table: row below / column right (`↑` / `←` for above / left) |
| `Ctrl+/` | Keyboard shortcuts help |

## Run it locally

Requirements: Node.js 22+ and npm. No database or Docker needed: an embedded Postgres (PGlite) is used when `DATABASE_URL` is not set.

```bash
npm install
cp .env.example .env.local   # then edit: set AUTH_SECRET (any long random string)
npm run dev                  # http://<machine-name>:3000 (stable LAN URL)
```

With `AUTH_DEV_LOGIN=1` (the default in `.env.example`) the login page offers a **development login** that accepts any handle, so you can open two browsers as two users without a GitHub OAuth app. Set `GITHUB_TOKEN` (for example from `gh auth token`) to use gists and repositories with the development login.

The server listens on all interfaces (`HOST` overrides). Use `http://<machine-name>:3000` as the canonical local URL from this computer, a phone, or another LAN client; it survives DHCP address changes. The start-up log prints that stable name first, then its `<machine-name>.local` alias, loopback, and deterministically ordered numeric interface addresses as secondary diagnostics (virtual/WSL adapters are labelled and never select the canonical URL). Sign-in, the collaboration-token request, and the one active `/collab` socket follow the browser's origin. In development, Next's cross-origin guard for `/_next/*` includes both stable names and current numeric diagnostics (`scripts/lib/dev-origins.mjs`; `ALLOWED_DEV_ORIGINS=a,b` adds others). A DHCP change needs no restart for hostname access; restart only if you are deliberately troubleshooting through the new numeric IP. `e2e/lan.spec.ts` covers the stable-hostname path.

Changing from a numeric URL (for example `http://192.168.1.20:3000`) to the hostname is a one-time origin transition. Cookies, `localStorage`, and IndexedDB are scoped to the exact origin, so sign in once at the hostname. Markdoc cannot invisibly move an unsynced IndexedDB edit from the old numeric origin: reconnect and save it at the old URL before switching, or copy the text manually if that address is no longer reachable.

To sign in with GitHub for real, create an OAuth App (Settings → Developer settings → OAuth Apps) with the callback URL on the same stable origin, for example `http://<machine-name>:3000/api/auth/callback/github`, and set `AUTH_GITHUB_ID` / `AUTH_GITHUB_SECRET`. Markdoc requests the `read:user user:email gist repo` scopes so it can publish on your behalf. With the OAuth app set, an account that has no GitHub token (the development login) gets a **Sign in with GitHub** button in the GitHub dialogs; without it, *Open from GitHub* and the *Connect to GitHub…* / *Gist or repository…* entries are disabled and say that GitHub storage is not set up on this server.

### Environment variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `AUTH_SECRET` | yes | Signs sessions and collaboration tokens. |
| `AUTH_GITHUB_ID`, `AUTH_GITHUB_SECRET` | for GitHub login | GitHub OAuth App credentials. |
| `AUTH_URL` | in production | Public URL, e.g. `https://markdoc.example.com`. Also the fallback origin for absolute URLs the server builds itself (link-preview `og:image` / `twitter:image`, including the per-document card a shared document link unfurls with — title, first lines, owner) when `MARKDOC_URL` is unset; without either, previews point at `http://localhost:<PORT>`. |
| `MARKDOC_URL` | optional | Canonical public origin (bare `https://host`, no path) used for MCP tool output and link-preview images; wins over `AUTH_URL`. The server refuses to start on a non-bare-origin value. |
| `MARKDOC_CANONICAL_HOST` | optional | Bare hostname (e.g. `markdoc.example.com`) the site should be reached on. When set, a top-level `GET`/`HEAD` that arrives on any other host (such as the Container App's default `*.azurecontainerapps.io` name after a custom-domain cutover) is answered `308` to `https://<host>` with the same path and query; `/api/*`, WebSocket upgrades and writes pass through. Unset (the default) changes nothing; an invalid value logs one warning and is ignored. See `docs/custom-domain.md`. |
| `DATABASE_URL` | in production | Postgres connection string. Omit locally to use PGlite in `.data/pglite`. |
| `DATABASE_SSL` | optional | Set to `1` to require TLS (Azure PostgreSQL). |
| `AUTH_DEV_LOGIN` | dev only | `1` enables the development login (ignored when `NODE_ENV=production`); `force` enables it in production too, only for smoke-testing a local build. |
| `GITHUB_TOKEN` | dev only | Personal token used for gists/repos with the development login. |
| `PGLITE_DATA_DIR` | optional | Embedded database location; `memory://` for tests. |
| `AUTO_VERSION_INTERVAL_MS` | optional | How often automatic versions are captured while editing (default 10 minutes). |
| `CHROMIUM_PATH` | optional | Chromium executable for PDF export; Playwright's own download is used when unset. |
| `DRIZZLE_MIGRATIONS_DIR` | optional | Where startup migrations are read from (default `./drizzle`). |
| `APP_VERSION` | optional | Reported by `/api/health` (the Dockerfile sets it from the `APP_VERSION` build arg). |

## Test it

```bash
npm test              # Vitest: ~430 unit tests (parser/serializer, sync binding, comments/suggestions models, DB, routes, collaboration server); the incremental-parser fuzz runs 300 seeded docs
npm run test:e2e      # Playwright: ~220 tests in 41 specs (two-browser collaboration, comments, suggestions, versions, sharing, tables, templates, search, stars, trash, reader, palette, notifications, offline, dark mode, phone layouts, import, …); e2e/scale.spec.ts runs the same flows against the Burke-scale fixture with measured budgets (CI: two shards for the suite, `--project default --shard=N/2`, plus a third job for the scale spec alone, `--project scale`)
npm run typecheck
npm run lint
```

- Burke-scale fixture: `e2e/fixtures/burke-scale.ts` seeds a ~12k-word document with 25 comment threads, 60 documents (starred, shared, trashed) and an API token; `e2e/scale.spec.ts` runs the long-document flows against it with measured budgets (`npx playwright test --project scale`; its own CI job), and `npm run seed:burke-scale` loads the same fixture into a dev server so you can try the app with real volume.

### Working in a worktree

A second checkout (`git worktree add ../markdoc-task-x -b task-x`) needs its own `npm ci --ignore-scripts`: Turbopack refuses to run from a junctioned or symlinked `node_modules`, so linking the main checkout's dependencies is not enough. No `.env.local` is needed — `PORT=3800 npm run dev:port` starts with dev-only auth defaults (see below) and a private PGlite directory, and `E2E_PORT=3218 npm run test:e2e` gives the suite its own port and Next cache. In a spec, after a `reload` or `goto` wait for `html[data-hydrated]` (the root layout's `<HydrationMarker>` sets it once React has committed) via `reloadHydrated` / `waitForHydration` from `e2e/helpers.ts` before clicking anything, including the first `goto` of a test (use `devLogin`); never treat boot-script state such as `data-theme` as a readiness signal, it is written before React runs.

### Scripts and knobs

Every `npm run` script, and the environment variables the test tooling reads:

| Script / variable | What it does |
| --- | --- |
| `dev` | Dev server (Next + collaboration WebSocket) on `:3000`. |
| `dev:port` | `PORT=3800 npm run dev:port`: a dev server on its own port with `.next-manual-<port>` and `.data/pglite-<port>`, so it never collides with the suite or another dev. Without `.env.local` it fills in dev-only defaults (`AUTH_SECRET=dev-only-secret-<port>`, `AUTH_DEV_LOGIN=1`, `RATE_LIMIT=off`) and prints which ones it applied; anything you set wins (`RATE_LIMIT=on` to try the API limiter by hand). |
| `build` / `build:server` | `next build` plus the custom server bundled to `dist/server.mjs` (`build:server` does only the second step). |
| `start` | Production server from `dist/`. |
| `start:local` | Production server on `:3900` with a throwaway PGlite and the dev login forced on, for local smoke tests. |
| `smoke` | API smoke against `BASE_URL` (default `:3900`): health, dev login, dashboard, template doc, PNG asset round-trip, md/html/pdf export. `SMOKE_PDF_OPTIONAL=1` tolerates a 503 from PDF. |
| `seed:burke-scale` | Loads the Burke-scale fixture (`e2e/fixtures/burke-scale.ts`: a ~12k-word document with 25 comment threads, 60 documents, 10 starred, 8 in the trash, 12 shared, an API token) into a dev server through the public API so you can look at the app with real volume. `MARKDOC_URL` (default `:3870`), `SEED_OWNER` / `SEED_PEER` dev-login handles; refuses port 3000 without `--yes`. Takes ~15 s on a `dev:port` server (limiter off by default); on a server with the API rate limiter on it honours every `429`'s `Retry-After` instead (~4 min), or start that server with `RATE_LIMIT=off`. |
| `soak:collab` | Collaboration soak: starts its own dev server on `:3270` with a throwaway PGlite directory (`SOAK_DATA_DIR`, outside the repo), then drives real Hocuspocus clients through six scenarios — 5 / 20 / 50 writers typing for a minute, distinct vs. one shared user, a reconnect storm, an offline merge, a hard server kill with restart, and read-only viewers under load — and prints a summary table plus a `results-<timestamp>.json`. It measures convergence (client texts, live text, text persisted after unload), dropped or duplicated ops by Yjs clock, one-way latency percentiles, server working set, and what a crash loses. `SOAK_SCENARIOS`, `SOAK_N`, `SOAK_TYPING_MS` and `SOAK_TIME_SCALE` shorten a run (`SOAK_SCENARIOS=1 SOAK_N=2 SOAK_TYPING_MS=5000` is a 2-minute smoke); `BASE_URL` points it at a running server instead (scenario 5 is then skipped). No product code is touched; the full run takes about 15 minutes. What one replica of the production build carries (N = 20–150 writers, server CPU, health latency) is in [`docs/collab-capacity.md`](docs/collab-capacity.md). |
| `test` / `test:watch` | Vitest once / in watch mode. |
| `test:fuzz` | Full 1500-document incremental-parser fuzz (`FUZZ_DOCS` / `FUZZ_SEED` override; the seed is logged on failure). |
| `test:github` | The one unit file that talks to the real GitHub API, `src/server/publish-github.integration.test.ts` (a commit and a delete on `burkeholland/markdoc-scratch`, or `SCRATCH_REPO`): `npm test` and this script both skip it unless the caller sets `MARKDOC_GITHUB_INTEGRATION=1` and a token is available (`GITHUB_TOKEN`, else `gh auth token`, read only when the flag is set), so an ordinary run never touches the network — the release preflight runs it deliberately. |
| `test:e2e` | Playwright; starts its own server on `:3100` with an in-memory database. `posttest:e2e` removes the run's Next cache afterwards. |
| `tsconfig:revert` | Undo the `include` churn `next dev` writes into `tsconfig.json` when that is the only change. |
| `typecheck` / `lint` | `next typegen && tsc --noEmit` / `eslint` (Markdown files are not linted). |
| `db:generate` | `drizzle-kit generate`: a new migration under `drizzle/` after a schema change. |
| `mcp` | Run the MCP server from a checkout (`MARKDOC_URL`, `MARKDOC_TOKEN`). |
| `mcp:smoke` | Checks a running server's `/api/mcp` with a real MCP client (`MARKDOC_URL`, `MARKDOC_TOKEN`): the `GET` card, the `401` without a token, `tools/list` against the stdio list with annotations, whoami, create and read. |
| `repair:github-identity` | Audits or repairs one legacy development identity and its empty GitHub OAuth duplicate. It is dry-run by default; see the reviewed procedure below. |
| `MARKDOC_URL` / `MARKDOC_INTERNAL_URL` | Canonical public origin used in MCP links / trusted internal origin for the remote MCP route's REST callbacks. The custom server sets the internal origin to its own listener; other deployments default to `http://127.0.0.1:$PORT`. Set `MARKDOC_URL` behind a reverse proxy and set `MARKDOC_INTERNAL_URL` only when loopback cannot reach Markdoc. Both values must be bare http(s) origins: move any former URL-prefix routing to the proxy because paths, credentials, queries, and fragments now fail closed. Request forwarding headers never choose the callback destination. |
| `repair:imported-ystate` | Re-seeds `ystate` for documents imported before `8e1f8c9` whose stored text disagrees with it (`-- --dry-run` reports, `-- --id <docId>` targets one); run with the live server stopped. |
| `E2E_PORT` | Private port and Next cache (`.next-e2e-<port>`) for one e2e run; give each worktree its own on a shared machine. |
| `E2E_WARMUP_TIMEOUT_MS` | Cap for each first-hit compile in `e2e/global-setup.ts` (editor route, API routes); default `300000` when the load gate is on, `120000` otherwise. The header line of the warm-up log shows the effective value. |
| `E2E_BUDGET_SCALE` | Multiplier for the suite's timing budgets (`budgetMs` in `e2e/helpers.ts`; default `1` locally, `3` on CI). Set e.g. `2` when running targeted specs on a busy machine so load noise does not fail the performance budgets; the run log's first line states the scale, and a report from a scaled run must say so. Release preflight runs at `1`; CI never sets it. |
| `E2E_SERVER_LOG` | `1` pipes the e2e dev server's stdout into the Playwright output so hydration warnings can be grepped. |
| `PROD_BASE_URL` | Makes `e2e/prod-smoke.spec.ts` run against a built server instead of starting the dev server; the rest of the suite is skipped. |
| `READER_POLL_MS` | How often the reader view (`/p/:id`) polls for a newer version (default 30 s). |

`npm run test:e2e` deletes its Next cache (`.next-e2e`, or `.next-e2e-<port>`) before every run and, through `posttest:e2e`, after every passing one (a failed run's cache, or one left by a plain `npx playwright test`, is deleted by the next run's pre-run step; the dev server still holds the cache while `e2e/global-teardown.ts` runs, so that file leaves it alone); `e2e/global-setup.ts` probes `/api/health` and warms the editor and API routes first so a cold compile never fails the first test. `next dev` appends the dist dir in use to `include` in `tsconfig.json`; `test:e2e` and `dev:port` revert that on exit when it is the only change, otherwise they print the diff (`npm run tsconfig:revert` does the same by hand). `next build` and `next typegen` type-check `tsconfig.build.json` instead — it extends the base, excludes `e2e/**`, `playwright.config.ts`, `scripts/**/*.mts` and `*.test.ts(x)` (the container image context has none of them) and, because it `extends`, Next never rewrites it; `npm run typecheck` (`tsc` on `tsconfig.json`) still covers the test code. `scripts/github-smoke.mts` exercises gist and repository publishing against the real GitHub API (needs a running server with `GITHUB_TOKEN` and a scratch repository; see the file header); `scripts/agent-smoke.mts`, `scripts/mcp-smoke.mts`, `scripts/perf-*.mts` and `scripts/screenshot.mts` are one-off dev tools with usage in their headers.

### One-time GitHub identity repair

`repair:github-identity` repairs only the case where a safe legacy development user and an otherwise empty OAuth duplicate have the same normalized GitHub login. It preserves the legacy user ID, moves exactly one GitHub account, and refuses unknown user references, ambiguous logins or email conflicts, extra accounts or sessions, and any application row tied to the duplicate user ID. Login-keyed collaborator and notification rows stay attached to the same normalized login and are fingerprinted without being rewritten. The command never merges application data.

Have the affected user sign out, take a database backup, and stop Markdoc so the repaired identity cannot write during the procedure. Markdoc sessions are JWT-backed, so this database command cannot revoke an existing browser cookie that still names the duplicate user ID; the repaired user must start with a fresh GitHub sign-in after the service restarts. Supply identifiers through the environment rather than credential-bearing command arguments:

```bash
export DATABASE_URL='postgresql://.../?sslmode=require'
export MARKDOC_REPAIR_LEGACY_LOGIN='expected-login'
export MARKDOC_REPAIR_GITHUB_ACCOUNT_ID='expected-numeric-id'
export MARKDOC_REPAIR_MANIFEST='/secure/operator-path/github-identity-rollback.json'

npm run repair:github-identity                 # dry-run; always rolls back
npm run repair:github-identity -- --apply      # one transaction; stages the rollback manifest before commit
npm run repair:github-identity -- --verify     # no-write verification against the manifest
```

Review the dry-run counts before `--apply`. Output contains only counts, booleans, classification labels, and hash prefixes. The checksummed rollback manifest contains the two user profile rows needed to reconstruct the deleted duplicate, but no OAuth tokens; store it as sensitive identity metadata and do not commit it.

Rollback is deliberately narrow: while Markdoc is still stopped and only if `--verify` passed, run `npm run repair:github-identity -- --rollback` with the same environment. It restores the original two profile rows and moves the same account back. Any changed profile, account, authentication row, or classified application fingerprint since apply makes rollback fail without writes. Once the repaired identity has signed in or created new data, restore from the database backup instead.

### One-time legacy ownership transfer

`transfer:legacy-ownership` covers the case the repair command refuses by design: a legacy development-login user (`<login>@dev.local`, unverified email, no account or session rows) owns documents, and the GitHub user who should own them already has real data of their own. It moves everything the legacy user owns or is referenced by to the user behind one GitHub `account` row and then deletes the legacy user. It handles every foreign key to `user.id` in the schema (a test fails if one is added without being listed), the id-shaped text columns (`document.last_edited_by`, `collaborator.added_by`, `version.created_by`, `activity.actor_id` including `agent:<id>:` prefixes) and the login-keyed `collaborator` and `notification` rows; per-document rows the target already has are deleted and reported as deduplicated, and a collaborator row on a document the target now owns is deleted rather than kept. Comment authorship inside document CRDT state is counted but not rewritten. Identity inputs come only from the environment; `DATABASE_URL` follows the same contract as the app (`sslmode=require|verify-ca|verify-full`, or `DATABASE_SSL=1`) and the tool also refuses to run unless `pg_stat_ssl` reports an encrypted session:

```bash
export DATABASE_URL='postgresql://.../?sslmode=require'
export MARKDOC_TRANSFER_SOURCE_LOGIN='legacy-login'
export MARKDOC_TRANSFER_TARGET_GITHUB_ACCOUNT_ID='target-numeric-github-id'

npm run transfer:legacy-ownership                                     # dry-run; counts only, always rolls back
npm run transfer:legacy-ownership -- --apply                          # one serializable transaction; prints transfer_id
npm run transfer:legacy-ownership -- --verify [--transfer-id <id>]    # no-write check that the applied state is intact
npm run transfer:legacy-ownership -- --rollback --transfer-id <id>    # reverses the transfer if nothing changed since
```

Stop Markdoc and take a backup first, as for the repair. The rollback record is a row in the `ownership_transfer` table (created by the app's Drizzle migrations), written in the same transaction as the transfer, so it survives the ephemeral container; `--apply` refuses with `MIGRATION_MISSING` until the app has migrated. Output is counts, booleans, login lengths, classification labels and the transfer id — never user ids, environment values or the record's contents. Refusals exit `1` with a classification (`SOURCE_USER_COUNT`, `SOURCE_NOT_LEGACY`, `SOURCE_HAS_ACCOUNT_OR_SESSION`, `TARGET_ACCOUNT_COUNT`, `TARGET_IS_SOURCE`, `NOTHING_TO_TRANSFER`, `SCHEMA_USER_FK_DRIFT`, `RESIDUAL_REFERENCES`, `STATE_CHANGED`, …) and write nothing; exit `0` is success, `2` means the transfer committed but its rollback record could not be read back, and `3` means the commit outcome is unknown (check `--verify` before doing anything else). `--rollback` re-inserts the legacy user and reverses each recorded change only while every moved row still matches its post-apply fingerprint; otherwise restore from the backup.

### Run the production build locally

The production server is `next build` plus the custom server bundled to `dist/server.mjs` (esbuild, see `scripts/build-server.mjs`). Between the two, `scripts/precompress-static.mjs` writes a brotli (q11) `.br` sibling for every `.js`/`.css` of 1 kB or more under `<distDir>/static`; in production the custom server streams those for `/_next/static/**` requests whose `Accept-Encoding` lists `br` (`server/static-brotli.ts`: GET/HEAD only, no `Range`, path confined to the static root, same `Content-Type`/`Cache-Control` as Next), and every other request — gzip, identity, `Range`, development mode — still goes to Next's handler unchanged. Exercise it before a deploy:

```bash
npm run build
npm run start:local                                 # production server on :3900, throwaway PGlite in .data/pglite-prod-smoke, dev login forced on
BASE_URL=http://localhost:3900 npm run smoke        # API smoke: health, dev login, dashboard, template doc, PNG asset round-trip, md/html/pdf export
PROD_BASE_URL=http://localhost:3900 npx playwright test e2e/prod-smoke.spec.ts   # browser: dashboard, template doc, typing in both panes over the WebSocket
```

`start:local` sets `AUTH_DEV_LOGIN=force`, which is the only way the development login works under `NODE_ENV=production`; never set it on a real deployment. `npm run smoke` exits non-zero on the first failing check (`SMOKE_PDF_OPTIONAL=1` tolerates a 503 from PDF export on hosts without Chromium). `e2e/prod-smoke.spec.ts` is skipped when `PROD_BASE_URL` is unset, so the regular suite is unaffected. Stop the server and delete `.data/pglite-prod-smoke` when you are done.

Next bundles server dependencies; `serverExternalPackages` in `next.config.ts` leaves only `@electric-sql/pglite` (WASM files), `pg`, `@hocuspocus/server`, `ws` and `yjs` (one instance shared with the custom server) to Node's loader. `drizzle-orm` is bundled on purpose: externalised, `@auth/drizzle-adapter`'s imports of `drizzle-orm/mysql-core` and `drizzle-orm/sqlite-core` became runtime `import()`s in every route chunk and intermittently failed in dev (`Failed to generate static paths` / `Failed to load external module`); `src/server/db/externals.test.ts` guards the list.

**PDF export needs Chromium.** `GET /api/documents/:id/export?format=pdf` renders with `playwright-core`; it answers `503` when no browser can be launched. Locally, `npx playwright install chromium` installs Playwright's build; on a server, point `CHROMIUM_PATH` at a system Chromium (the Dockerfile installs Alpine's and sets it).

### Accessibility

`npx playwright test e2e/a11y.spec.ts` runs axe-core (`@axe-core/playwright`, WCAG 2.1 A/AA tag set) against every screen and floating surface: login, dashboard (starred strip, trash chip, template dialog), the editor with outline and comments open and with each floating UI open in turn (find bar, slash menu, table menu, selection bubble, command palette, stats/presence/notifications popovers, share/image/shortcuts dialogs), the versions panel in compare mode, the activity panel, the reader page, settings, an iPhone 13 viewport, and dark mode for the dashboard and editor. Each state must report zero violations; on failure the rule id, impact and offending selectors are printed. `color-contrast` is disabled in the general light-theme scans (axe cannot resolve it through the blurred headers and translucent overlays) and enabled for the dark dashboard and dark editor scans (outline + comments, find bar, slash menu, table menu) and for the "axe: contrast" block, which scans the dashboard, editor, settings and reader in light and dark with it on; all pass with zero violations. The palette itself ("Ink & teal": warm stone inks, teal accent, Fraunces for titles and h1–h3, Inter for everything else) is checked as numbers in `src/app/tokens-contrast.test.ts` and `src/app/theme-contrast.test.ts`. The second half of the spec is a keyboard-only walkthrough (`page.keyboard` only): skip link → header → toolbar (one tab stop; `←`/`→` wrap, `Home`/`End` jump, disabled buttons are skipped, `Shift+Tab` back in lands on the last-used button) → panes, bold via `Ctrl+B`, command palette, commenting with `Ctrl+Alt+M`, Share via the palette with an exact check that `Esc` returns focus to the rich pane, Share from the header button returning focus to that button, and a check that the main controls resolve to unique accessible names. Set `A11Y_SOFT=1` to report every state in one run instead of stopping at the first failure. Note for keyboard users: the Markdown pane binds `Tab` to indent; press `Esc` then `Tab` to leave it.

## How it works

```text
 browser                                               server (one Node process)
 ┌─────────────────────────────────────────┐          ┌──────────────────────────────────────┐
 │ CodeMirror ◀── y-codemirror ──▶ Y.Text   │◀── WS ──▶│ Hocuspocus (auth, persistence,       │
 │ ProseMirror ◀─ MarkdownBinding ─▶  │     │          │   activity watcher, live API edits)  │
 │ comments / suggestions ◀──▶ Y.Map        │◀─ HTTP ─▶│ Next.js app + REST API + reader view │
 │ IndexedDB mirror (y-indexeddb)           │          │ Postgres via Drizzle (PGlite locally) │
 └─────────────────────────────────────────┘          └──────────────────────────────────────┘
```

- **The Markdown text is the document.** A Yjs `Y.Text` holds the source; CodeMirror binds to it directly. That keeps gists and repositories honest and conflict-free merging simple.
- **The rich pane is a lossless projection.** `src/editor/sync/markdown-binding.ts` serializes local ProseMirror edits block by block and applies them to the text as minimal diffs; text changes from anywhere (other users, the code pane, undo, an API call, a pull from GitHub) are parsed and applied to ProseMirror as a minimal replacement, so the caret and selection survive. Empty paragraphs, which Markdown cannot express, are kept locally as "phantom" blocks.
- **Carets are shared across surfaces.** Both editors publish the selection as a source-text position, so your caret in the code pane shows up in everyone's rich pane and vice versa.
- **Comments and suggestions are annotations** stored in Yjs maps with relative-position anchors (`src/editor/collab/`). They survive concurrent edits and render identically in both panes. Suggesting mode intercepts edits: deletions are kept and marked, insertions are recorded; accepting or rejecting applies the final text.
- **Open documents are mirrored to IndexedDB** (`src/editor/collab/offline.ts`, one `markdoc:<docId>` database per document via `y-indexeddb`), so edits made offline survive a refresh or closed tab and merge into the server copy on reconnect; the header chip stays on "Saving…" while you type and reads "Saved" about a second after you stop (every keystroke still syncs at once; only the chip settles), shows the unsaved count while offline and confirms "All changes saved" once they land. The local copy is deleted when the document is deleted or access is revoked.
- **One server process.** `server/index.ts` hosts Next.js and the collaboration WebSocket (`/collab`) on one port. `src/server/collab/hocuspocus.ts` authenticates with short-lived JWTs minted by `/api/documents/:id/collab-token`, loads documents from Postgres and persists them (debounced) with automatic versioning. API edits go through the same live document (`src/server/livedoc.ts`), so an agent's `suggest` shows up in open editors immediately.
- **Baseline security headers.** `server/index.ts` puts `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin` and `Permissions-Policy: camera=(), microphone=(), geolocation=()` on every response — pages, `/api/*`, `/_next/static/*` (the brotli branch included) — and `Strict-Transport-Security: max-age=31536000` only when the request arrived over HTTPS (`x-forwarded-proto: https` from the Container Apps ingress; never on plain HTTP, so local dev and the e2e server send none). `src/proxy.ts` adds `Content-Security-Policy: frame-ancestors 'none'` to every page except the embedded document: `/d/<id>?embed=1` with a valid `markdoc.embed-session` cookie keeps `frame-ancestors <parentOrigin>` for the Copilot canvas, `/api/*` keeps its own headers (`/api/assets` sandboxes SVGs) and the handoff route `/embed/<nonce>` is left frameable. Without a valid embed cookie that URL is an ordinary page (or a redirect to `/login`) and the browser blocks it inside the canvas frame until the shell reloads it through a fresh handoff. `e2e/security-headers.spec.ts` checks the set; `curl -sI https://<fqdn>/login` shows it in production.
- **Activity is watched, not logged by the client.** `src/server/activity.ts` records rows from API routes and from a watcher on the live Hocuspocus document (typing is coalesced into one row per actor per ten minutes); the Activity panel reads `GET /api/documents/:id/activity`. Notifications (`src/server/notifications.ts`) are produced the same way, from the comment, suggestion and share routes and from the live document: replies, resolves, suggestion decisions, shares and @mentions, never for the actor; `GET /api/notifications` feeds the bell and the dashboard strip.
- **Assets live in Postgres.** Pasted or uploaded images are stored as `asset` rows (bytes, SHA-256, MIME) and served from `/api/assets/:id` with the owning document's access check; identical bytes within a document share one row, and "make a copy" copies the referenced ones.
- **Export and the reader view share one renderer.** `src/server/export/html.ts` turns clean Markdown into the standalone HTML page; `/p/:id` (`src/components/reader`) reuses `renderMarkdownBody` and the `contentHash` to show a "new version" pill, and PDF export prints the same HTML through Chromium. The Markdown → HTML pipeline itself lives in `render-markdown.ts` and runs on a worker thread (`render-pool.ts`, one lazy worker, 15 s budget, `dist/render-worker.mjs` in production) behind a linear guard (`src/editor/markdown/renderable.ts`) that refuses paragraphs with more than 1 000 `]` or 2 000 `*`/`_` — micromark resolves those quadratically and 80 KB of unbalanced brackets used to block the whole process for 38 s; refused documents answer `422 { error: "Document is not renderable" }`.
- **Per-user tables for organising.** `star` and `recent` rows drive the dashboard's stars, recently-opened order and sort; trash is a `deleted_at` column on `document` that hides it from every route until it is restored or purged after 30 days.
- **Build.** `drizzle-orm` is bundled into the server (not externalised; see the note under *Run the production build locally*), and `src/server/db/externals.test.ts` pins the short list of packages Node loads from `node_modules`.

## Deploy to Azure

The target is **Azure Container Apps** with PostgreSQL. `infra/main.bicep` describes the whole environment (Container App, ACR, Key Vault, managed identity, Log Analytics, and a private PostgreSQL VM that has no public IP after bootstrap and accepts TLS connections only from the Container Apps subnet); `deploy/azure.ps1` provisions it and builds the image in Azure Container Registry (no local Docker). Nothing deploys automatically; `.github/workflows/deploy.yml` is a manual workflow. The image (`Dockerfile`) is `node:22-alpine` with Alpine's Chromium for PDF export and a `HEALTHCHECK` on `/api/health`; validate changes to it with `npm run build` + the production smoke above and `hadolint Dockerfile` (no local Docker needed).

Two health checks, two probes. `GET /api/health` is the full check — one database round trip, reported as `latencyMs`, plus the collaboration server's counters — and answers `503 { ok: false, error }` when PostgreSQL does not; the **Startup** probe, the release runbook below and the ops scripts wait on its `ok:true, db:true`. `GET /api/health?probe=live` answers `{ ok: true, probe: "live", collab, version }` from the process alone and never opens a database connection; it is the **Liveness** probe (`infra/main.bicep`), so a slow or restarting PostgreSQL cannot make the platform kill a healthy replica (the previous liveness probe was the full check under the platform's default 1 s timeout, and a cold connection to the database VM alone takes ~45 ms plus TLS jitter; both probes now allow `timeoutSeconds: 5`). There is no readiness probe: the app runs one replica. Inside the app, the PostgreSQL pool logs `[db] idle client error: <message>` and carries on when the server drops an idle connection (a restart, `pg_terminate_backend`, VM patching); before, that event was an uncaught exception that took the whole process down and lost the edits still in the collaboration server's debounce window.

### Production runbook: app-only releases

A release never overlaps another mutation on `markdoc-rg` — no `deploy/azure.ps1` run, no NAT gateway or subnet change, no OS patch window at the same time; if one is under way, wait for it to finish before step 2 (building the image in step 1 changes nothing that runs).

Production is the one Container App `markdoc` in `markdoc-rg` (East US 2), and it already exists. A release changes **only its image**: it does not rerun the Bicep template or `deploy/azure.ps1`, the one-time PGlite data migration (`scripts/migrate-pglite-to-postgres.mts`, and never its `--replace` mode), credential rotation, or provisioning; the app's own Drizzle schema migrations still run at container startup, as on every start. PostgreSQL stays authoritative throughout, and the app image is the only thing that rolls forward or back. `.github/workflows/deploy.yml` is the in-repo implementation of steps 1–3; the same commands work from a workstation.

1. Pick the exact accepted `main` commit (full 40-character SHA) and build from a clean checkout of it in ACR (`az acr build`), tagging the image with the full SHA and its 12-character prefix and passing `--build-arg APP_VERSION=<sha>` so `/api/health` reports it. (`deploy/azure.ps1 -SourceCommit <sha>` builds the same way from a clean deployment checkout and refuses when that checkout differs from the commit in application files, but as a full-template run it is not the release path for the existing app.) `hadolint` is not available through npm on this machine (the wrapper's binary download 404s); lint the Dockerfile with the official `hadolint/hadolint` image or GitHub Action when one is available. `npm audit` must print `found 0 vulnerabilities`; the `overrides` block in `package.json` exists only to replace the never-executed `esbuild@0.18` nested under drizzle-kit's deprecated `@esbuild-kit` loader — remove it when drizzle-kit drops that dependency (drizzle-team/drizzle-orm#5689). The preflight also runs the one real-GitHub unit file, which an ordinary `npm test` skips: `MARKDOC_GITHUB_INTEGRATION=1 npm run test:github` must report 2 passed (it commits to and cleans up `burkeholland/markdoc-scratch`).
2. Resolve the tag's immutable digest (`az acr manifest list-metadata -r <acr> -n markdoc`) and update the existing app by digest: `az containerapp update -n markdoc -g markdoc-rg --image <loginServer>/markdoc@sha256:… --set-env-vars APP_VERSION=<sha>`. Change nothing else: the Key Vault-backed `database-url` secret reference, the `auth-secret` and `github-client-secret` secrets, `AUTH_URL`, ingress (HTTPS only), 0.5 vCPU / 1 GiB, and `minReplicas`/`maxReplicas` of 1/1 stay as they are, and `AUTH_DEV_LOGIN` stays unset.
3. The app runs in single-revision mode, so Container Apps moves 100% of traffic once the new revision's startup probe passes. Wait for it to be Healthy with one replica, then probe `https://<fqdn>/api/health` until it returns `ok=true`, `db=true` and `version=<sha>` (the workflow asserts the same); also check that HTTP redirects to HTTPS, `/login` returns 200, an unauthenticated `/collab` WebSocket reaches the custom server's `authenticationFailed` rejection rather than a timeout or 404, and that `curl -sI -H "Accept-Encoding: br" https://<fqdn>/_next/static/chunks/<a chunk named in the /login HTML>.js` answers `content-encoding: br` (the precompressed assets; if the ingress ever normalised `br` out of the request's `Accept-Encoding`, the origin would fall through to Next — identity for a br-only request, gzip for a browser, which never sends `br` alone).

   Then prove that the served build is the one you built. `npm run release:verify -- --base https://<fqdn> --sha <sha> --dist <local .next of that sha>` runs every check in this paragraph and the redirect/health/live/WebSocket checks above as one table (exit 0 = all pass; `--wait-flip S` samples the cutover first) — the text that follows is what it checks. **Chunks:** build the released SHA locally (`npm run build` in a clean checkout), fetch the public `/login` HTML and list every `/_next/static/chunks/*.js` it references; fetch each one with **no** `Accept-Encoding` header and compare byte count and SHA-256 with the same file under `.next/static/chunks` — every pair must match. Fetch by name, and compare the same way, the largest chunks the HTML does not reference: the editor route's (the largest file listed only for `/d/[id]` in its `page_client-reference-manifest.js`), the lazy CodeMirror chunks (the `.js` files under `static/chunks` that contain `cm-content` and appear in no route's entry list) and the lazy grammar chunk (the one containing `Visual Basic .NET`); a 404 or a size difference means the wrong SHA was built. The comparison is always *your local build vs production*, never production vs the previous revision: chunk names change whenever client code changes. **Manifest vs HTML:** the number the bundle tasks report is the manifest sum — the page and layout entries ∪ `rootMainFiles` of `.next/server/app/**/page_client-reference-manifest.js` — e.g. `/login` = 455 186 B at `5f9eb0d`; the HTML also references the `not-found` boundary chunk (8 895 B) and the `noModule` polyfill (112 594 B, downloaded by legacy browsers only), so "entry JS by manifest" is not "bytes a modern browser downloads" (464 081 B over 7 chunks for `/login` at `5f9eb0d`) — say which one a number is. **Brotli:** with `Accept-Encoding: br`, every `.js`/`.css` chunk of 1 kB or more must answer `content-encoding: br` with `content-length` equal to the `.br` sibling in your local `.next/static/chunks`, and the body (`curl -s -D - -o <file>`; never a client that auto-decodes) must decompress (`zlib.brotliDecompressSync`) to the identity bytes, SHA-256 equal to the plain fetch. Known non-findings: a `HEAD` with `Accept-Encoding: gzip` shows no `content-encoding` on any revision (Next's `compression` skips HEAD — check gzip with a GET), a `Range` request answers `206` identity, `curl --path-as-is` on `/_next/static/../package.json` gets Next's 404 page, and `.map` files are 404. **CSS:** the Tailwind chunk's name differs between a Windows worktree and the image. `.dockerignore` drops `scripts/*.mts` and `*.md`, which Tailwind's source scan sees locally, so the local file has a few extra utility rules (3 at `5f9eb0d`: `.list-item`, `.\[dev\:port\]`, `.\[seed\:burke-scale\]`; 981 rules against the image's 978 as `release:verify` counts them — top-level brace groups, an `@media`/`@supports` block being one rule and `@layer` wrappers transparent, plus top-level statements such as `@layer a, b;`) and a different hash, and one `@supports (color:lab())` block differs only in oxide's float formatting. Compare rule by rule; ≤ 5 local-only utility rules and formatting-only differences are not a stop. **Which chunk is "the shared chunk":** since `5f9eb0d` (the CodeMirror pane behind `next/dynamic`) the largest chunk listed for every route is the React/Next runtime in `rootMainFiles` (229 280 B), while the largest **application** chunk (335 989 B) is shared by `/` and `/d/[id]` but not by `/login` — say which one a size refers to.
4. Keep the previous revision, now inactive at its own digest, as the rollback. Reactivate it (`az containerapp revision activate --revision <previous>`), or run `az containerapp update --image` with the previous digest and `APP_VERSION`; either way only the application changes and the database is untouched. Never reverse the database because an app image failed: if the new revision may have accepted writes, PostgreSQL still holds them and the previous image keeps serving them.
5. Record the source SHA, image digest, the new and previous revision names, the flip time (from issuing `az containerapp update` to the first `/api/health` 200 at the new `version`: 47.75–50.45 s on the last five releases) and the cutover poll result (2 s `/api/health` samples from before the `update` until the version flips; count the non-200 answers — 0 on the last four releases), and check that the before/after `az containerapp show` diff (the same picture taken before step 2 and after step 3: revision name, image, scale, env and secret names, probes) is `image`, `latestRevisionName` and `APP_VERSION` only, with the probes byte-identical.

Facts about the current deployment, recorded here rather than proposed for change: everything, including the database, lives in `markdoc-rg` (East US 2) on the same VNet (`markdoc-vnet`). The authoritative production database is the private PostgreSQL VM `markdoc-pg` that `infra/main.bicep` describes: Standard_B1ms, Ubuntu 24.04, no public IP, NIC in the `markdoc-vnet/postgres` subnet, NSG `markdoc-pg-nsg` allowing TCP 5432 only from the Container Apps subnet `10.42.0.0/23`, protected by pgBackRest plus the Recovery Services vault `markdoc-backup` (policy `daily-7-days`). The app reaches PostgreSQL over TLS on the VM's private address through the Key Vault `database-url` secret with `DATABASE_SSL=1`; warm `/api/health` reports `latencyMs` of 1–3 ms. Because `infra/main.bicep` composes `database-url` from that private address whenever `configureDatabase`, `commitDatabasePassword` or `restoreDatabasePassword` is set, the `-InitializeDatabase`, `-RotateDatabasePassword` and recovery flags below act on the production database VM and are production-affecting operations; an app-only release never runs them. Database rollback or restore uses the VM's pgBackRest backups and WAL archive (`infra/postgres-recovery.sh`, `-VerifyRecovery`), not a managed-service point-in-time restore.

### Production runbook: monthly OS security patch

`deploy/azure.ps1` never upgrades the base OS (`apt-get install` refreshes only the packages it names), so the database VM is patched on its own cadence: **monthly, first Sunday, 04:00Z**, after the 02:00Z Azure Backup snapshot, the 02:30Z pgBackRest full and the 03:30Z logical dump and before the 05:00Z restore check, plus an out-of-band run within 7 days of a PostgreSQL minor with a security fix or a network-reachable OpenSSL/kernel advisory. `docs/postgres-patching.md` has the options, the reasoning, the cost (≈ $0.01–0.10 per month at 2026-08-30 retail prices) and the rollback paths. The run is one command from a signed-in `az` session:

```powershell
.\deploy\patch-postgres-vm.ps1 -DryRun     # prints every az call as [read-only] or [mutation] and runs none; do this first
.\deploy\patch-postgres-vm.ps1             # security-only, ≈ 25–40 min; -Snapshot takes a pre-patch OS-disk snapshot, -NoReboot defers a kernel reboot
```

The script (1) refuses unless the VM is running, the network is in steady state (rule 260 `DenyOtherInternetEgress` present, rule 250 absent, no public IP), the last Azure Backup job, `logical-backup=ok` and `backup-health=ok` are fresh and `/api/health` reports `db=true`; (2) opens the same temporary egress path `-ConfigureRecovery` uses (bootstrap public IP plus NSG rule 250 `AllowApprovedPackageSetup`, TCP 80/443 only), with the cleanup registered through `Invoke-OperationWithGuaranteedCleanup` before the first mutation; (3) runs `infra/patch-os.sh` as the managed run command `patch-os`: `unattended-upgrade` from Ubuntu's security pockets only, never PGDG (`-Full` swaps in plain `apt-get upgrade`, never a distribution upgrade), which logs `os-patch=ok` or `os-patch=failed` to Syslog `local0`, where the existing `markdoc-postgres-backup-failure` alert now watches; (4) closes egress through the shared `Restore-PostgresSteadyStateEgress` and `Remove-BootstrapPublicIp` helpers (`deploy/azure-postgres-network.ps1`), also after a failure; (5) only if the guest reported `reboot=required`, restarts the VM gracefully with `az vm restart` (≈ 60–120 s of database unavailability, measured by polling `/api/health`; never a redeploy) **after** egress is closed; (6) waits for `/api/health`, for `os-patch=ok` and `backup-health=ok` in Syslog and a fresh Heartbeat, re-asserts the steady-state network, and prints one line to paste into the record: `upgraded=<n> kernel=<before>-><after> reboot=<yes|no|deferred> db-unavailable=<n>s egress-open=<n>min`. Nothing runs it automatically; a scheduled GitHub Actions workflow comes later. `deploy/azure-safety.tests.ps1` pins the ordering (cleanup registered before any mutation, both helpers in the cleanup, restart after the window, no distribution upgrade verbs) and the free Activity Log alert `markdoc-postgres-nsg-rule-write` mails the action group on every rule write to `markdoc-pg-nsg`: once per window is expected, anything else means an egress path was opened by hand.

A package regression is undone inside the same window: `.\deploy\patch-postgres-vm.ps1 -Rollback <package>=<previous version>` reinstalls exactly that version (from the apt archive or Launchpad) and holds it; kernel and whole-VM rollback paths are in `docs/postgres-patching.md`. `infra/postgres-recovery.sh` pins `apt.postgresql.org` to priority 100 for everything but `pgbackrest`, so neither this window nor a rerun of `-ConfigureRecovery` can move `postgresql-16` to PGDG's build or pull in a new major.

### One-off maintenance inside the VNet

The production database VM accepts connections only from the Container Apps subnet, so the maintenance CLIs (`npm run repair:github-identity` and the ownership-transfer tool, `transfer:legacy-ownership`) run from the manual Container Apps Job `markdoc-maint` in `markdoc-prod-env`, built from the Dockerfile's `build` stage (`--target build`) at the same SHA as the running app. A pristine export of that SHA carries both CLIs: `.dockerignore` keeps `scripts/repair-github-identity.mts` and `scripts/transfer-legacy-ownership.mts` while dropping the other `scripts/*.mts`. When a tool depends on a new Drizzle migration, release the app first (its startup runs the migrations) and only then run the job at that SHA. The job's `DATABASE_URL` is the same Key Vault reference the app uses. A job execution's Succeeded/Failed status reflects the container's exit code, so a dry-run refusal (exit 1) shows as Failed and the classification line in the log is the real result.

```bash
# 0. Once per release the job must follow: build the tools image from the accepted SHA and point the job at it
git archive --format=tar <sha> | tar -x -C <export dir>        # pristine export; .dockerignore keeps the two maintenance CLIs, so nothing in it needs editing
az acr build -r markdocacrmnd542unepl56 --target build -t markdoc-tools:<sha> -t markdoc-tools:<12-char> --file Dockerfile <export dir>
az acr repository show -n markdocacrmnd542unepl56 --image markdoc-tools:<12-char> --query digest -o tsv     # manifest list-metadata refuses repo:tag on this CLI
az containerapp job update -n markdoc-maint -g markdoc-rg --image markdocacrmnd542unepl56.azurecr.io/markdoc-tools@sha256:<digest>

# 1. Backups first when the tool writes (--apply, --rollback; not needed for probes, dry runs or --verify). <file> holds these six lines:
#      sudo -u postgres pgbackrest --stanza=markdoc --type=diff backup
#      sudo -u postgres pgbackrest --stanza=markdoc info | head -n 40
#      sudo -u postgres /usr/local/sbin/markdoc-logical-backup
#      umask 077; F=/var/backups/markdoc/pre-transfer-$(date -u +%Y%m%dT%H%M%SZ).dump
#      sudo -u postgres pg_dump --format=custom --compress=9 markdoc > "$F"; chmod 0600 "$F"
#      stat -c 'size=%s mode=%a' "$F"; sha256sum "$F"; pg_restore --list "$F" | wc -l
#    (dash is the interpreter: no `set -o pipefail`; output is tail-truncated at ~4 KB, keep it short)
az vm run-command invoke -g markdoc-rg -n markdoc-pg --command-id RunShellScript --scripts @<file>

# 2. Start one execution. An override replaces the whole container spec: the template's env is not inherited, re-pass every variable.
#    (bash: --command npm --args run <script> -- <flags> --env-vars "DATABASE_URL=secretref:database-url" … also works; Windows: az is a .cmd, cmd.exe mangles quotes inside --args, use --yaml)
cat > <exec.yaml> <<'EOF'
containers:
  - name: markdoc-maint
    image: markdocacrmnd542unepl56.azurecr.io/markdoc-tools@sha256:<digest>
    command: ["sh"]
    args: ["-c", "npm run <script> -- <flags>; echo exit=$?"]     # the wrapper keeps the execution Succeeded; the exit= line and the classification line are the result
    env:
      - { name: DATABASE_URL, secretRef: database-url }
      - { name: DATABASE_SSL, value: "1" }
      - { name: NODE_ENV, value: production }
      - { name: MARKDOC_TRANSFER_SOURCE_LOGIN, value: <value> }              # the tool's own variables, by name; fill in, do not commit
      - { name: MARKDOC_TRANSFER_TARGET_GITHUB_ACCOUNT_ID, value: <value> }
    resources: { cpu: 0.5, memory: 1Gi }
EOF
az containerapp job start -n markdoc-maint -g markdoc-rg --yaml <exec.yaml> --query name -o tsv     # → <exec>

# 3. Wait until status leaves Running (30–40 s incl. image pull; replica timeout 1800 s; retry limit 0, so Failed is terminal). Succeeded ⇔ exit 0, Failed ⇔ non-zero: see the exit-1 note above
az containerapp job execution show -n markdoc-maint -g markdoc-rg --job-execution-name <exec> --query "{status:properties.status,start:properties.startTime,end:properties.endTime}" -o json

# 4. Logs and exit code from Log Analytics (~60–150 s ingestion); the system row reads "terminated with exit code 'N'", for N see "One-time legacy ownership transfer"
#    (while the pod still exists: az containerapp job logs show -n markdoc-maint -g markdoc-rg --execution <exec> --container markdoc-maint)
az monitor log-analytics query -w 38faa130-4081-42a2-b43b-6ee128652871 --analytics-query "ContainerAppConsoleLogs_CL | where TimeGenerated > ago(2h)
  | where ContainerJobName_s == 'markdoc-maint' and ContainerGroupName_s startswith '<exec>' | project TimeGenerated, Stream_s, Log_s | order by TimeGenerated asc" -o table
az monitor log-analytics query -w 38faa130-4081-42a2-b43b-6ee128652871 --analytics-query "ContainerAppSystemLogs_CL | where TimeGenerated > ago(2h)
  | where JobName_s == 'markdoc-maint' and ExecutionName_s == '<exec>' and Reason_s == 'ContainerTerminated' | project TimeGenerated, Log_s" -o table
```

After a release that carries a migration, prove that the migration ran before starting any tool that depends on it: a read-only probe execution (`node -e` over the `pg` package already in the tools image) counting `information_schema.tables` for `table_schema = 'public'` went from `tables=17` to `tables=18` when the app applied `0017_ownership_transfer`, and the app's `/api/health` answering `db=true` at the new `version` is the same proof from outside, because `getDb()` resolves only after `migrate()` has completed. The job accrues $0 between executions (a manual job bills only while a replica runs), so `markdoc-maint`, its `markdoc-tools` tags and the execution YAML files stay in place between exercises. Delete the job only when the whole exercise is over: `az containerapp job delete -n markdoc-maint -g markdoc-rg -y`.

### Provisioning a new environment

```powershell
$env:MARKDOC_PG_PASSWORD = '<strong password>'
$env:MARKDOC_AUTH_SECRET = '<openssl rand -base64 32>'
$env:MARKDOC_GITHUB_CLIENT_ID = '<oauth app id>'
$env:MARKDOC_GITHUB_CLIENT_SECRET = '<oauth app secret>'
$env:MARKDOC_ALERT_EMAIL = '<production alert receiver>'
$env:MARKDOC_VM_SSH_PUBLIC_KEY = Get-Content "$HOME\.ssh\id_ed25519.pub" -Raw
.\deploy\azure.ps1 -InitializeDatabase -ConfigureRecovery
# The first run prints the app URL; add it as the OAuth callback, then rerun normally.
```

For unattended production deployment, pass `-SecretsPath <file>` instead. The CLIXML file must contain `PostgresAdminPassword`, `AuthSecret`, `GitHubClientId`, `GitHubClientSecret`, `AlertEmailAddress`, and `VmAdminSshPublicKey` as DPAPI-encrypted `SecureString` properties, with inheritance disabled and access restricted to the current Windows user. Before reading it, the script resolves the store's final local-volume identity and acquires a current-SID-only `Global\` mutex, so equivalent path aliases cannot run overlapping operations; hard-linked stores and foreign pre-created mutexes fail closed. The mutex remains held through deployment, compensation, cleanup, and the final protected store write. During rotation the script verifies the file ACL before writing, adds a DPAPI-encrypted `PostgresCandidatePassword` plus the exact prior image, version, revision, and app URL needed for recovery, promotes the candidate only after the new revision is healthy, and removes the recovery state after a verified success or rollback. A retry resumes retained state before checking the old revision's health, while a fresh rotation still requires one healthy serving revision. Secure Bicep values are written to a randomly named parameter file in `%TEMP%` only for the duration of each Azure CLI call and removed in `finally`; they are never command-line arguments.

Known limitation: the DPAPI secret file is readable only by the creating Windows user; cross-session readability was not verified. The `Global\` mutex is designed to serialize two Windows sessions of that user, but no same-user second session has been available to exercise it, so treat the store as single-session and do not run two deployments as the same user from different sessions.

Run `deploy/azure-safety.tests.ps1` under both `powershell.exe` and `pwsh` after changing deployment safety behavior. `deploy/azure-ownership-session.tests.ps1` is an optional harness that tries the same-user second-session case through an S4U scheduled task; it skips when task registration is denied (as it is for a non-elevated Entra account) and has not been run to completion, so it is not a deployment or merge gate.

Ordinary reruns deliberately do not attach a VM public IP, write the PostgreSQL password to Key Vault, rerun database bootstrap, restart PostgreSQL, or change database ownership. A new environment requires the explicit `-InitializeDatabase` flag. Password rotation requires `-RotateDatabasePassword`; it preserves both the current and candidate credentials until a new revision is healthy. Any failure after PostgreSQL accepts the candidate restores the role, active Key Vault secrets, and previously serving revision before the candidate is disabled. `-SimulateDatabaseRotationFailure` proves the pre-change path; `-SimulatePostChangeDatabaseRotationFailure` proves compensation after `ALTER ROLE`. Recovery configuration changes require `-ConfigureRecovery`; temporary package egress is removed and the steady-state deny rule is verified whether setup succeeds or fails. Because `-ConfigureRecovery` installs packages through the temporary bootstrap public IP, which the rotation deployments never attach, the script refuses `-RotateDatabasePassword` combined with `-ConfigureRecovery`: rotate first, then run `-ConfigureRecovery` on its own (`docs/postgres-egress.md`, §10). `-SimulateRecoveryConfigurationFailure` drills that cleanup path. `-SourceCommit <full-sha>` labels the image with an accepted application commit only when every application file in the clean deployment checkout matches that commit. `-ImageTag <full-sha>` reuses an existing ACR image. Run `-VerifyRecovery` to restore the latest physical backup into an isolated scratch cluster without stopping or modifying production.

The PostgreSQL recovery layers are:

- pgBackRest continuously archives WAL to a private Azure Blob container using the VM's managed identity. `archive_timeout=240s` bounds the recovery point to five minutes after a write, including quiet periods.
- A full physical pgBackRest backup and a separate `pg_dump` logical backup run daily. pgBackRest retains seven full backups; logical dumps expire after 30 days.
- Azure Recovery Services also keeps seven daily encrypted VM recovery points. This is an additional disaster-recovery layer, not the point-in-time database backup. Every deployment re-PUTs the unchanged backup policy, so an alert processing rule on the vault suppresses only the built-in "Modify policy with shorter retention" alert that each re-PUT raises; backup-job failures and every other vault alert stay visible.
- A two-minute systemd check validates repository access, physical-backup freshness, the age of any pending WAL archive backlog, pgBackRest spool status, and unresolved archive failures. The five-minute backlog-age bound is tied to `archive_timeout=240s`; an idle database with no unarchived WAL does not false-alert. Its secret-free health object includes archive age and backlog measurements. Its heartbeat and failures flow through a restricted egress path (an Azure Monitor private endpoint; the NAT gateway it replaced was retired per `docs/postgres-egress.md`) to Log Analytics, and both Azure Monitor rules notify the production action group.
- A weekly job restores the latest physical backup to an isolated local socket and temporary data directory, starts it on port 55432, verifies the `markdoc` database after recovery, records the duration off-VM, then removes the scratch cluster. Its success line also carries the duration into Log Analytics (`Syslog | where ProcessName == "markdoc-restore-check"` shows a `duration-seconds=` field), so restore time can be trended and alerted on. Its timer is persistent, so a drill missed while the VM was down or being patched runs at the next boot instead of waiting a week. Run `-VerifyRecovery` after recovery changes and confirm it finishes within the two-hour RTO.

Approximate monthly cost shape (pay-as-you-go, East US 2 list prices; storage, backup, and logs vary with database size and traffic, so verify current prices in the Azure Pricing Calculator):

| Resource | Size | ~$/month |
| --- | --- | --- |
| Container App | 0.5 vCPU / 1 GiB, one always-on replica | 34 |
| Container App (`-Small`) | 0.25 vCPU / 0.5 GiB | 14 |
| Container App (`-ScaleToZero`) | sleeps when nobody is connected | ~0 idle |
| PostgreSQL VM + OS disk (`markdoc-pg`, `markdoc-rg`) | Standard B1ms, 32 GiB Standard SSD LRS; the production database | usage-priced |
| PostgreSQL controlled egress | Key Vault + Storage service endpoints and an Azure Monitor private endpoint with 5 private DNS zones; no public IP on the VM; the old NAT gateway is deleted by hand per `docs/postgres-egress.md` §7 | ~10 |
| PostgreSQL recovery storage | Standard StorageV2 LRS, hot tier; WAL + 7 physical + 30 logical daily backups | capacity/operations |
| Recovery Services backup | Standard vault, daily VM recovery point, seven-day LRS retention | protected-instance/storage |
| Container Registry | Basic | 5 |
| Log Analytics / Azure Monitor | 30-day logs, 1 GiB/day workspace cap, two backup alerts | ingestion/alerts |

The collaboration server keeps open documents in memory, so the app runs as a single replica; scaling out would need Hocuspocus's Redis extension.

## Project layout

```text
server/index.ts              custom server: Next.js + collaboration WebSocket on one port
server/static-brotli.ts      production only: serves the build's precompressed .br for /_next/static/** when the client accepts br
src/app                      pages: dashboard, /login, /d/[id] editor, /p/[id] reader, /settings
src/app/api                  REST routes (documents, content, suggest, comments, versions, activity,
                             assets, export, share, star, trash, templates, notifications, tokens, GitHub)
src/components/editor        editor UI: header, toolbar, panes, panels (comments, versions, activity),
                             command palette, slash menu, find bar, table menu, stats popover, dialogs
                             (like the CodeMirror pane, the side panels, dialogs, palette and find bar are
                             next/dynamic boundaries loaded on first use, outside the route's entry JS)
src/components/dashboard     document list, search, stars/recents/sort, templates gallery, notifications strip
src/components/notifications notifications bell in the editor header, open-thread helper
src/components/reader        /p/[id] reader view: page, table of contents, update pill, download menu
src/components/settings      API tokens
src/components/ui            shared primitives (menus, popovers, tips, icons), theme toggle, relative time,
                             logo.tsx (Logo/Wordmark, no "use client": server pages import it, not the editor header) and github-icon.tsx (GitHubIcon, no "use client" either, so /login and / ship none of primitives.tsx); primitives.tsx is a barrel over tooltip.tsx/menu.tsx/popover.tsx/dialog.tsx/display.tsx, and routes that need one family import the module directly (the public reader does)
src/editor/markdown          GFM schema, parser with source map, incremental parser, serializer, linter;
                             to-markdown.ts is prosemirror-markdown's serializer core, vendored (MIT header in the file)
src/editor/sync              ProseMirror <-> Y.Text binding, text diff
src/editor/collab            session, comments, suggestions, offline (IndexedDB) models
src/editor/codemirror        source pane setup, commands, suggesting filter
src/editor/prosemirror       rich pane setup, commands, input rules, tables, node views
src/server/db                Drizzle schema, connection (Postgres or PGlite), externals guard
src/server/collab            Hocuspocus server, JWT collab tokens, document registry, WebSocket
src/server/export            Markdown -> standalone HTML renderer (shared with the reader), PDF via Chromium
src/server/github            Octokit: gists, repositories, import
src/server/documents.ts      create/list/search/star/recent/trash/duplicate
src/server/livedoc.ts        apply API edits to the live Yjs document (content, suggest, comments)
src/server/activity.ts       activity rows from routes and the live-document watcher
src/server/notifications.ts  notification rows (replies, resolves, suggestion decisions, shares, @mentions) + live watcher
src/server/assets.ts         image assets in Postgres
src/server/publish.ts        link/publish/pull against gists and repositories
src/server/tokens.ts         personal API tokens
mcp/server.mjs               MCP server over stdio (see docs/agents.md)
drizzle/                     migrations, applied at startup:
  0000_init                    users, sessions, documents, collaborators, versions, stars
  0001_api_tokens              personal API tokens
  0002_timestamptz             all timestamps to timestamptz
  0003_assets                  image assets (bytes + sha256 per document)
  0004_mentions                @mentions per comment and mentioned login (replaced by 0008)
  0005_activity                per-document activity feed
  0006_recent                  per-user recently-opened documents
  0007_trash                   document.deleted_at for the trash
  0008_notifications           notification table; migrates and drops mention
e2e/                         Playwright specs; global-setup.ts health-probes and warms routes,
                             dist-dir.ts gives each E2E_PORT its own Next cache
scripts/smoke.mts            API smoke against a running (production) server
scripts/dev-port.mts         dev server on a private port/cache/db
scripts/build-server.mjs     esbuild bundles: server/index.ts -> dist/server.mjs, the Markdown render worker -> dist/render-worker.mjs
scripts/precompress-static.mjs  build step after `next build`: brotli q11 `.br` next to every .js/.css >= 1 kB under <distDir>/static
scripts/live/                PowerShell ops for Burke's live :3000 server (start, promote, autostart, snapshot/restore, resume-check)
infra, deploy                Bicep and deployment script
```

## Live test server (Burke's :3000)

Burke's live test server runs `npm run dev` from a pinned sibling worktree `../markdoc-live` (env in that folder's `.env.local`), with PGlite data and the log under the sibling `../markdoc-data`. Both default paths are derived from the repo location; set `FACTORY_ROOT` (or pass `-Root` / `-LogPath`) to point elsewhere — see `Get-FactoryRoot` in `scripts/live/common.ps1` and its Node twin `scripts/lib/factory-root.mjs`. Ops scripts live in `scripts/live/` (Windows PowerShell 5.1 compatible):

- `start-live.ps1` — idempotent start: exits 0 if `/api/health` already answers 200, otherwise kills stale `markdoc-live` node processes, deletes `.next`, starts `npm run dev` hidden (log appended to `../markdoc-data/live.log`, rotated at 20 MB) and waits for `ok:true, db:true`. While waiting, "connection refused" and any 5xx count as *still starting* (a cold Next.js server compiles the route on the first hit and may answer 500 meanwhile); it waits at least `-MinWaitSec` (90) and at most `-TimeoutSec` (180), gives up early only when the launcher process exits, and prints a `NOT HEALTHY: <reason>` line on failure.
- `promote.ps1 -Sha <sha>` — what the lead does at every merge: verifies the sha is on `origin/main`, stops the server, `git checkout --detach <sha>`, runs `npm ci --ignore-scripts` only if `package.json`/`package-lock.json` changed, clears `.next`, restarts; rolls back to the previous sha only when the process exited or health was not `ok:true, db:true` after the wait above, and prints `ROLLBACK REASON: …`. Rehearse against a copy with `-Root <worktree> -Port <n> -LogPath <file>`, never against :3000.
- `install-autostart.ps1` — registers two per-user scheduled tasks (no admin): "Markdoc live server" (at logon, runs `start-live.ps1`) and "Markdoc snapshot" (every 15 min, runs `snapshot-data.ps1 -Latest`); `-Uninstall` removes both. Re-run it from `markdoc-live` after the first promote that includes these scripts so the tasks point at the permanent path.
- `snapshot-data.ps1 [-Latest | -Out <dir>]` / `restore-data.ps1 [-From <dir>]` — hot backup of the PGlite database through `GET /api/admin/backup` (gated by `BACKUP_TOKEN`) as `markdoc-pglite.tar.gz` + `manifest.json`, and the matching restore via PGlite's `loadDataDir`. `-Latest` (the default) rewrites `../markdoc-data/snapshots/latest` atomically and keeps the last 3 timestamped copies; `-From` defaults to that folder.
- `resume-check.ps1` (`npm run resume-check`) — checklist that exits 0 when the live server is fully back after a machine wipe, repairing what it safely can (`-DryRun` to only report).

**Wipe-proofing.** [RESUME.md](RESUME.md) is the recovery document: what state Markdoc keeps on the machine and where (live worktree, `.env.local`, the PGlite data folder, the scheduled tasks), what the snapshot contains and how it is taken without stopping the server, where the 15-minute snapshot lands in factory-state, how to restore it, which secrets have to be re-entered and how to regenerate them, and the `resume-check.ps1` checklist the factory's bootstrap script runs after cloning everything back from GitHub.

## License

MIT

`src/editor/markdown/to-markdown.ts` is a copy of the serializer from [prosemirror-markdown](https://github.com/ProseMirror/prosemirror-markdown) 1.13.5 (MIT, Marijn Haverbeke and others); its licence text stays in the file header. It is vendored because the package's only entry point builds a markdown-it parser at load time, which put about 100 kB of never-run code in every page's shared script; upstream fixes to that file are copied by hand, and ESLint refuses a new import of the package.
