# Markdoc

Google Docs for Markdown. Write Markdown together in real time, edit the **source** or the **rendered page** (both are live for everyone), review with **comments** and **suggestions**, keep every **version**, and **publish** to a GitHub gist or repository.

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
- Find & replace across both panes (`Ctrl+F` / `Ctrl+H`), with live highlights.
- Smart paste: a URL over a selection becomes a link, Markdown-looking text is inserted as source, HTML keeps bold/lists.
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

- Personal API tokens, a REST API, and an MCP server (`mcp/server.mjs`) so GitHub Copilot, Claude or scripts can create documents, propose tracked changes and answer comments; the app shows who did what. See [docs/agents.md](docs/agents.md).
- **Ask an agent** from the document: select text (or nothing), pick an instruction and how the agent should answer (tracked changes, comment only, rewrite). The request waits in an inbox agents read over MCP (`markdoc_list_requests` → `markdoc_claim_request` → work with `requestId` → `markdoc_complete_request`); a header pill tracks it live, and the result comes back as suggestions plus a notification. Nothing runs server-side — your own Copilot CLI does the work. First-time users get a *Connect an agent* card with the MCP config for the host they are on. See [Requests](docs/agents.md#requests).

Sign in is GitHub only (OAuth), with a development login for local work.

### Keyboard shortcuts

`Ctrl` is `Cmd` on macOS. Press `Ctrl+/` in the editor for the full list.

| Shortcut | Action |
| --- | --- |
| `Ctrl+Shift+P` | Command palette |
| `Ctrl+K` | Command palette (no selection) / Link (with a selection) |
| `Ctrl+F` / `Ctrl+H` | Find / Find and replace |
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
npm run dev                  # http://localhost:3000
```

With `AUTH_DEV_LOGIN=1` (the default in `.env.example`) the login page offers a **development login** that accepts any handle, so you can open two browsers as two users without a GitHub OAuth app. Set `GITHUB_TOKEN` (for example from `gh auth token`) to use gists and repositories with the development login.

The server listens on all interfaces (`HOST` overrides), so the same process also works from a phone or another machine on the LAN at `http://<your-ip>:3000` or `http://<machine-name>:3000` — the start-up log lists the addresses. Sign-in redirects and the collaboration socket follow whatever host the browser used, and in development Next's cross-origin guard for `/_next/*` is pre-filled with this machine's LAN addresses and name (`scripts/lib/dev-origins.mjs`; add others with `ALLOWED_DEV_ORIGINS=a,b`; restart after a DHCP change). `e2e/lan.spec.ts` covers it.

To sign in with GitHub for real, create an OAuth App (Settings → Developer settings → OAuth Apps) with callback URL `http://localhost:3000/api/auth/callback/github` and set `AUTH_GITHUB_ID` / `AUTH_GITHUB_SECRET`. Markdoc requests the `read:user user:email gist repo` scopes so it can publish on your behalf.

### Environment variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `AUTH_SECRET` | yes | Signs sessions and collaboration tokens. |
| `AUTH_GITHUB_ID`, `AUTH_GITHUB_SECRET` | for GitHub login | GitHub OAuth App credentials. |
| `AUTH_URL` | in production | Public URL, e.g. `https://markdoc.example.com`. |
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
npm run test:e2e      # Playwright: ~125 tests in 28 specs (two-browser collaboration, comments, suggestions, versions, sharing, tables, templates, search, stars, trash, reader, palette, notifications, offline, dark mode, phone layouts, import, …); e2e/scale.spec.ts runs the same flows against the Burke-scale fixture with measured budgets
npm run typecheck
npm run lint
```

### Working in a worktree

A second checkout (`git worktree add ../markdoc-task-x -b task-x`) needs its own `npm ci --ignore-scripts`: Turbopack refuses to run from a junctioned or symlinked `node_modules`, so linking the main checkout's dependencies is not enough. No `.env.local` is needed — `PORT=3800 npm run dev:port` starts with dev-only auth defaults (see below) and a private PGlite directory, and `E2E_PORT=3218 npm run test:e2e` gives the suite its own port and Next cache.

### Scripts and knobs

Every `npm run` script, and the environment variables the test tooling reads:

| Script / variable | What it does |
| --- | --- |
| `dev` | Dev server (Next + collaboration WebSocket) on `:3000`. |
| `dev:port` | `PORT=3800 npm run dev:port`: a dev server on its own port with `.next-manual-<port>` and `.data/pglite-<port>`, so it never collides with the suite or another dev. Without `.env.local` it fills in dev-only defaults (`AUTH_SECRET=dev-only-secret-<port>`, `AUTH_DEV_LOGIN=1`) and prints which ones it applied; anything you set wins. |
| `build` / `build:server` | `next build` plus the custom server bundled to `dist/server.mjs` (`build:server` does only the second step). |
| `start` | Production server from `dist/`. |
| `start:local` | Production server on `:3900` with a throwaway PGlite and the dev login forced on, for local smoke tests. |
| `smoke` | API smoke against `BASE_URL` (default `:3900`): health, dev login, dashboard, template doc, PNG asset round-trip, md/html/pdf export. `SMOKE_PDF_OPTIONAL=1` tolerates a 503 from PDF. |
| `seed:burke-scale` | Loads the Burke-scale fixture (`e2e/fixtures/burke-scale.ts`: a ~12k-word document with 25 comment threads, 60 documents, 10 starred, 8 in the trash, 12 shared, an API token) into a dev server through the public API so you can look at the app with real volume. `MARKDOC_URL` (default `:3870`), `SEED_OWNER` / `SEED_PEER` dev-login handles; refuses port 3000 without `--yes`. |
| `test` / `test:watch` | Vitest once / in watch mode. |
| `test:fuzz` | Full 1500-document incremental-parser fuzz (`FUZZ_DOCS` / `FUZZ_SEED` override; the seed is logged on failure). |
| `test:e2e` | Playwright; starts its own server on `:3100` with an in-memory database. `posttest:e2e` removes the run's Next cache afterwards. |
| `tsconfig:revert` | Undo the `include` churn `next dev` writes into `tsconfig.json` when that is the only change. |
| `typecheck` / `lint` | `next typegen && tsc --noEmit` / `eslint` (Markdown files are not linted). |
| `db:generate` | `drizzle-kit generate`: a new migration under `drizzle/` after a schema change. |
| `mcp` | Run the MCP server from a checkout (`MARKDOC_URL`, `MARKDOC_TOKEN`). |
| `E2E_PORT` | Private port and Next cache (`.next-e2e-<port>`) for one e2e run; give each worktree its own on a shared machine. |
| `E2E_SERVER_LOG` | `1` pipes the e2e dev server's stdout into the Playwright output so hydration warnings can be grepped. |
| `PROD_BASE_URL` | Makes `e2e/prod-smoke.spec.ts` run against a built server instead of starting the dev server; the rest of the suite is skipped. |
| `READER_POLL_MS` | How often the reader view (`/p/:id`) polls for a newer version (default 30 s). |

`npm run test:e2e` deletes its Next cache (`.next-e2e`, or `.next-e2e-<port>`) before and after every run; `e2e/global-setup.ts` probes `/api/health` and warms the editor and API routes first so a cold compile never fails the first test. `next dev` appends the dist dir in use to `include` in `tsconfig.json`; `test:e2e` and `dev:port` revert that on exit when it is the only change, otherwise they print the diff (`npm run tsconfig:revert` does the same by hand). `next build` and `next typegen` type-check `tsconfig.build.json` instead — it extends the base, excludes `e2e/**`, `playwright.config.ts`, `scripts/**/*.mts` and `*.test.ts(x)` (the container image context has none of them) and, because it `extends`, Next never rewrites it; `npm run typecheck` (`tsc` on `tsconfig.json`) still covers the test code. `scripts/github-smoke.mts` exercises gist and repository publishing against the real GitHub API (needs a running server with `GITHUB_TOKEN` and a scratch repository; see the file header); `scripts/agent-smoke.mts`, `scripts/mcp-smoke.mts`, `scripts/perf-*.mts` and `scripts/screenshot.mts` are one-off dev tools with usage in their headers.

### Run the production build locally

The production server is `next build` plus the custom server bundled to `dist/server.mjs` (esbuild, see `scripts/build-server.mjs`). Exercise it before a deploy:

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

`npx playwright test e2e/a11y.spec.ts` runs axe-core (`@axe-core/playwright`, WCAG 2.1 A/AA tag set) against every screen and floating surface: login, dashboard (starred strip, trash chip, template dialog), the editor with outline and comments open and with each floating UI open in turn (find bar, slash menu, table menu, selection bubble, command palette, stats/presence/notifications popovers, share/image/shortcuts dialogs), the versions panel in compare mode, the activity panel, the reader page, settings, an iPhone 13 viewport, and dark mode for the dashboard and editor. Each state must report zero violations; on failure the rule id, impact and offending selectors are printed. `color-contrast` is disabled in the light-theme scans (axe cannot resolve it through the blurred headers and translucent overlays; the light tokens are checked by hand and by `src/app/theme-contrast.test.ts`) and enabled for the dark dashboard and dark editor scans (outline + comments, find bar, slash menu, table menu), which pass with zero violations. The second half of the spec is a keyboard-only walkthrough (`page.keyboard` only): skip link → header → toolbar (one tab stop; `←`/`→` wrap, `Home`/`End` jump, disabled buttons are skipped, `Shift+Tab` back in lands on the last-used button) → panes, bold via `Ctrl+B`, command palette, commenting with `Ctrl+Alt+M`, Share via the palette with an exact check that `Esc` returns focus to the rich pane, Share from the header button returning focus to that button, and a check that the main controls resolve to unique accessible names. Set `A11Y_SOFT=1` to report every state in one run instead of stopping at the first failure. Note for keyboard users: the Markdown pane binds `Tab` to indent; press `Esc` then `Tab` to leave it.

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
- **Open documents are mirrored to IndexedDB** (`src/editor/collab/offline.ts`, one `markdoc:<docId>` database per document via `y-indexeddb`), so edits made offline survive a refresh or closed tab and merge into the server copy on reconnect; the header shows the unsaved count while offline and confirms "All changes saved" once they land. The local copy is deleted when the document is deleted or access is revoked.
- **One server process.** `server/index.ts` hosts Next.js and the collaboration WebSocket (`/collab`) on one port. `src/server/collab/hocuspocus.ts` authenticates with short-lived JWTs minted by `/api/documents/:id/collab-token`, loads documents from Postgres and persists them (debounced) with automatic versioning. API edits go through the same live document (`src/server/livedoc.ts`), so an agent's `suggest` shows up in open editors immediately.
- **Activity is watched, not logged by the client.** `src/server/activity.ts` records rows from API routes and from a watcher on the live Hocuspocus document (typing is coalesced into one row per actor per ten minutes); the Activity panel reads `GET /api/documents/:id/activity`. Notifications (`src/server/notifications.ts`) are produced the same way, from the comment, suggestion and share routes and from the live document: replies, resolves, suggestion decisions, shares and @mentions, never for the actor; `GET /api/notifications` feeds the bell and the dashboard strip.
- **Assets live in Postgres.** Pasted or uploaded images are stored as `asset` rows (bytes, SHA-256, MIME) and served from `/api/assets/:id` with the owning document's access check; identical bytes within a document share one row, and "make a copy" copies the referenced ones.
- **Export and the reader view share one renderer.** `src/server/export/html.ts` turns clean Markdown into the standalone HTML page; `/p/:id` (`src/components/reader`) reuses `renderMarkdownBody` and the `contentHash` to show a "new version" pill, and PDF export prints the same HTML through Chromium.
- **Per-user tables for organising.** `star` and `recent` rows drive the dashboard's stars, recently-opened order and sort; trash is a `deleted_at` column on `document` that hides it from every route until it is restored or purged after 30 days.
- **Build.** `drizzle-orm` is bundled into the server (not externalised; see the note under *Run the production build locally*), and `src/server/db/externals.test.ts` pins the short list of packages Node loads from `node_modules`.

## Deploy to Azure

The target is **Azure Container Apps** with **Azure Database for PostgreSQL Flexible Server**. Infrastructure is in `infra/main.bicep`; `deploy/azure.ps1` provisions everything and builds the image in Azure Container Registry (no local Docker). Nothing deploys automatically; `.github/workflows/deploy.yml` is a manual workflow. The image (`Dockerfile`) is `node:22-alpine` with Alpine's Chromium for PDF export and a `HEALTHCHECK` on `/api/health`; validate changes to it with `npm run build` + the production smoke above and `hadolint Dockerfile` (no local Docker needed).

```powershell
$env:MARKDOC_PG_PASSWORD = '<strong password>'
$env:MARKDOC_AUTH_SECRET = '<openssl rand -base64 32>'
$env:MARKDOC_GITHUB_CLIENT_ID = '<oauth app id>'
$env:MARKDOC_GITHUB_CLIENT_SECRET = '<oauth app secret>'
.\deploy\azure.ps1             # first run prints the app URL; add it as the OAuth callback, then rerun
```

Approximate monthly cost (East US 2, pay-as-you-go list prices):

| Resource | Size | ~$/month |
| --- | --- | --- |
| Container App | 0.5 vCPU / 1 GiB, one always-on replica | 34 |
| Container App (`-Small`) | 0.25 vCPU / 0.5 GiB | 14 |
| Container App (`-ScaleToZero`) | sleeps when nobody is connected | ~0 idle |
| PostgreSQL Flexible Server | Burstable B1ms, 32 GiB | 16 |
| Container Registry | Basic | 5 |
| Log Analytics | first 5 GiB free, 1 GiB/day cap | ~0 |

Expect **$40–55/month** for a small team, about **$25** with the small app size. The collaboration server keeps open documents in memory, so the app runs as a single replica; scaling out would need Hocuspocus's Redis extension.

## Project layout

```text
server/index.ts              custom server: Next.js + collaboration WebSocket on one port
src/app                      pages: dashboard, /login, /d/[id] editor, /p/[id] reader, /settings
src/app/api                  REST routes (documents, content, suggest, comments, versions, activity,
                             assets, export, share, star, trash, templates, notifications, tokens, GitHub)
src/components/editor        editor UI: header, toolbar, panes, panels (comments, versions, activity),
                             command palette, slash menu, find bar, table menu, stats popover, dialogs
src/components/dashboard     document list, search, stars/recents/sort, templates gallery, notifications strip
src/components/notifications notifications bell in the editor header, open-thread helper
src/components/reader        /p/[id] reader view: page, table of contents, update pill, download menu
src/components/settings      API tokens
src/editor/markdown          GFM schema, parser with source map, incremental parser, serializer, linter
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
scripts/build-server.mjs     esbuild bundle of server/index.ts -> dist/server.mjs
scripts/live/                PowerShell ops for Burke's live :3000 server (start, promote, autostart, snapshot/restore, resume-check)
infra, deploy                Bicep and deployment script
```

## Live test server (Burke's :3000)

Burke's live test server runs `npm run dev` from a pinned sibling worktree `../markdoc-live` (env in that folder's `.env.local`), with PGlite data and the log under the sibling `../markdoc-data`. Both default paths are derived from the repo location; set `FACTORY_ROOT` (or pass `-Root` / `-LogPath`) to point elsewhere — see `Get-FactoryRoot` in `scripts/live/common.ps1` and its Node twin `scripts/lib/factory-root.mjs`. Ops scripts live in `scripts/live/` (Windows PowerShell 5.1 compatible):

- `start-live.ps1` — idempotent start: exits 0 if `/api/health` already answers 200, otherwise kills stale `markdoc-live` node processes, deletes `.next`, starts `npm run dev` hidden (log appended to `../markdoc-data/live.log`, rotated at 20 MB) and waits up to 180 s for health.
- `promote.ps1 -Sha <sha>` — what the lead does at every merge: verifies the sha is on `origin/main`, stops the server, `git checkout --detach <sha>`, runs `npm ci --ignore-scripts` only if `package.json`/`package-lock.json` changed, clears `.next`, restarts; rolls back to the previous sha if health never returns 200.
- `install-autostart.ps1` — registers two per-user scheduled tasks (no admin): "Markdoc live server" (at logon, runs `start-live.ps1`) and "Markdoc snapshot" (every 15 min, runs `snapshot-data.ps1 -Latest`); `-Uninstall` removes both. Re-run it from `markdoc-live` after the first promote that includes these scripts so the tasks point at the permanent path.
- `snapshot-data.ps1 [-Latest | -Out <dir>]` / `restore-data.ps1 [-From <dir>]` — hot backup of the PGlite database through `GET /api/admin/backup` (gated by `BACKUP_TOKEN`) as `markdoc-pglite.tar.gz` + `manifest.json`, and the matching restore via PGlite's `loadDataDir`. `-Latest` (the default) rewrites `../markdoc-data/snapshots/latest` atomically and keeps the last 3 timestamped copies; `-From` defaults to that folder.
- `resume-check.ps1` (`npm run resume-check`) — checklist that exits 0 when the live server is fully back after a machine wipe, repairing what it safely can (`-DryRun` to only report).

**Wipe-proofing.** [RESUME.md](RESUME.md) is the recovery document: what state Markdoc keeps on the machine and where (live worktree, `.env.local`, the PGlite data folder, the scheduled tasks), what the snapshot contains and how it is taken without stopping the server, where the 15-minute snapshot lands in factory-state, how to restore it, which secrets have to be re-entered and how to regenerate them, and the `resume-check.ps1` checklist the factory's bootstrap script runs after cloning everything back from GitHub.

## License

MIT
