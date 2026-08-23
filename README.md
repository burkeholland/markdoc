# Markdoc

Google Docs for Markdown. Write Markdown together in real time, edit the **source** or the **rendered page** (both are live for everyone), review with **comments** and **suggestions**, keep every **version**, and **publish** to a GitHub gist or repository.

![Markdoc editor](docs/screenshot.png)

*Reviewing an agent's proposal:* an agent connected through MCP proposed edits and left a comment; the human accepts or rejects them in the app.

![Agent review](docs/agent-review.png)

## What it does

| Area | Details |
| --- | --- |
| Two editing surfaces | CodeMirror 6 source pane and a ProseMirror rich pane, side by side. Type in either one; the other follows instantly. Toolbar, shortcuts and Markdown input rules (`# `, `- `, `- [ ] `, `> `, ```` ``` ````, `---`) work on both. |
| Real-time collaboration | Yjs CRDT over WebSockets (Hocuspocus). Presence avatars, live carets and selections in **both** panes, offline edits merge on reconnect. |
| Comments | Threads anchored to text ranges that follow the words as the document changes. Reply, edit, resolve, reopen. Commenters can comment without being able to edit. |
| Suggesting mode | Edits become tracked changes (green insertions, red struck deletions) on both surfaces. Accept or reject one at a time or all at once. Published text never includes pending suggestions. |
| Version history | Automatic snapshots while editing, named versions, versions for every publish/pull/restore. Word-level diff against the current text and one-click restore (the pre-restore state is kept). |
| Storage | Markdoc's own database, **GitHub Gists**, or **repository files** (publishing creates a real commit on the branch you choose; conflicts with upstream edits are detected). Import any Markdown file from your gists or repos. |
| Sharing | Add people by GitHub handle as editor, commenter or viewer. Link sharing: restricted, view, comment, or edit. |
| Markdown quality | GitHub Flavored Markdown (tables, task lists, footnotes, strikethrough, front matter, raw HTML preserved). Built-in linter in the status bar (heading structure, broken references, unclosed fences, ragged tables, trailing whitespace) with jump-to-line. |
| Sign in | GitHub only (OAuth). |
| Agents | Personal access tokens plus an **MCP server** (`mcp/server.mjs`) so GitHub Copilot, Claude or scripts can create documents, propose tracked changes, and read/answer comments. The app shows who the agent is and what it did. See [docs/agents.md](docs/agents.md). |

## Run it locally

Requirements: Node.js 22+ and npm. No database or Docker needed: an embedded Postgres (PGlite) is used when `DATABASE_URL` is not set.

```bash
npm install
cp .env.example .env.local   # then edit: set AUTH_SECRET (any long random string)
npm run dev                  # http://localhost:3000
```

With `AUTH_DEV_LOGIN=1` (the default in `.env.example`) the login page offers a **development login** that accepts any handle, so you can open two browsers as two users without a GitHub OAuth app. Set `GITHUB_TOKEN` (for example from `gh auth token`) to use gists and repositories with the development login.

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
npm test              # Vitest: parser/serializer, sync binding, suggestions/comments models, DB, collaboration server (~200 tests); incremental-parser fuzz runs 300 seeded docs
npm run test:fuzz     # Full 1500-document incremental-parser fuzz (FUZZ_DOCS / FUZZ_SEED override; the seed is logged on failure)
npm run test:e2e      # Playwright: two-browser collaboration, comments, suggestions, versions, sharing, editing, commenter role, insert dialogs, tables, templates (~50 tests)
npm run typecheck
npm run lint
```

`npm run test:e2e` starts its own server on port 3100 with an in-memory database. `scripts/github-smoke.mts` exercises gist and repository publishing against the real GitHub API (needs a running server with `GITHUB_TOKEN` and a scratch repository; see the file header).

### Run the production build locally

The production server is `next build` plus the custom server bundled to `dist/server.mjs` (esbuild, see `scripts/build-server.mjs`). Exercise it before a deploy:

```bash
npm run build
npm run start:local                                 # production server on :3900, throwaway PGlite in .data/pglite-prod-smoke, dev login forced on
BASE_URL=http://localhost:3900 npm run smoke        # API smoke: health, dev login, dashboard, template doc, PNG asset round-trip, md/html/pdf export
PROD_BASE_URL=http://localhost:3900 npx playwright test e2e/prod-smoke.spec.ts   # browser: dashboard, template doc, typing in both panes over the WebSocket
```

`start:local` sets `AUTH_DEV_LOGIN=force`, which is the only way the development login works under `NODE_ENV=production`; never set it on a real deployment. `npm run smoke` exits non-zero on the first failing check (`SMOKE_PDF_OPTIONAL=1` tolerates a 503 from PDF export on hosts without Chromium). `e2e/prod-smoke.spec.ts` is skipped when `PROD_BASE_URL` is unset, so the regular suite is unaffected. Stop the server and delete `.data/pglite-prod-smoke` when you are done.

**PDF export needs Chromium.** `GET /api/documents/:id/export?format=pdf` renders with `playwright-core`; it answers `503` when no browser can be launched. Locally, `npx playwright install chromium` installs Playwright's build; on a server, point `CHROMIUM_PATH` at a system Chromium (the Dockerfile installs Alpine's and sets it).

## How it works

```
 browser                                        server (one Node process)
 ┌──────────────────────────────────────┐       ┌────────────────────────────────┐
 │ CodeMirror ◀── y-codemirror ──▶ Y.Text │◀─WS─▶│ Hocuspocus (auth, persistence) │
 │ ProseMirror ◀─ MarkdownBinding ─▶  │   │       │ Next.js app + API routes       │
 │ comments / suggestions  ◀─▶ Y.Map    │       │ Postgres (Drizzle)             │
 └──────────────────────────────────────┘       └────────────────────────────────┘
```

- **The Markdown text is the document.** A Yjs `Y.Text` holds the source; CodeMirror binds to it directly. That keeps gists and repositories honest and conflict-free merging simple.
- **The rich pane is a lossless projection.** `src/editor/sync/markdown-binding.ts` serializes local ProseMirror edits block by block and applies them to the text as minimal diffs; text changes from anywhere (other users, the code pane, undo, a pull from GitHub) are parsed and applied to ProseMirror as a minimal replacement, so the caret and selection survive. Empty paragraphs, which Markdown cannot express, are kept locally as "phantom" blocks.
- **Carets are shared across surfaces.** Both editors publish the selection as a source-text position, so your caret in the code pane shows up in everyone's rich pane and vice versa.
- **Comments and suggestions are annotations** stored in Yjs maps with relative-position anchors (`src/editor/collab/`). They survive concurrent edits and render identically in both panes. Suggesting mode intercepts edits: deletions are kept and marked, insertions are recorded; accepting or rejecting applies the final text.
- **Server.** `server/index.ts` hosts Next.js and the collaboration WebSocket (`/collab`) on one port. `src/server/collab/hocuspocus.ts` authenticates with short-lived JWTs minted by `/api/documents/:id/collab-token`, loads documents from Postgres, and persists them (debounced) with automatic versioning. REST routes under `src/app/api` handle documents, sharing, versions, GitHub publishing and imports.

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

```
server/index.ts            custom server: Next.js + collaboration WebSocket
src/app                    routes (dashboard, login, /d/[id] editor) and API
src/components/editor      editor UI (header, toolbar, panes, panels, dialogs)
src/editor/markdown        GFM schema, parser with source map, serializer, linter
src/editor/sync            ProseMirror <-> Y.Text binding
src/editor/collab          session, comments, suggestions models
src/editor/codemirror      source pane setup, commands, suggesting filter
src/editor/prosemirror     rich pane setup, commands, input rules, node views
src/server                 database (Drizzle), documents, GitHub, publish, collaboration server
e2e                        Playwright tests
infra, deploy              Bicep and deployment script
```

## License

MIT



## Live test server (Burke's :3000)

Burke's live test server runs `npm run dev` from the pinned worktree `C:\Dev\ai-experiments\FACTORY\markdoc-live` (env in that folder's `.env.local`, PGlite data under `markdoc-data\pglite`). Ops scripts live in `scripts/live/` (Windows PowerShell 5.1 compatible):

- `start-live.ps1` — idempotent start: exits 0 if `/api/health` already answers 200, otherwise kills stale `markdoc-live` node processes, deletes `.next`, starts `npm run dev` hidden (log appended to `markdoc-data\live.log`, rotated at 20 MB) and waits up to 180 s for health.
- `promote.ps1 -Sha <sha>` — what the lead does at every merge: verifies the sha is on `origin/main`, stops the server, `git checkout --detach <sha>`, runs `npm ci --ignore-scripts` only if `package.json`/`package-lock.json` changed, clears `.next`, restarts; rolls back to the previous sha if health never returns 200.
- `install-autostart.ps1` — registers a per-user scheduled task "Markdoc live server" (at logon, no admin) that runs `start-live.ps1`; `-Uninstall` removes it. Re-run it from `markdoc-live` after the first promote that includes these scripts so the task points at the permanent path.
