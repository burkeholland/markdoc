# Changelog

Newest first. Each entry is one merged feature or fix on `main`; test-only and work-in-progress commits are folded into the feature they belong to. Short hashes point at the merge or squash commit.

## 2026-08-23

Everything that landed on `main` after the previous README pass (`6181b7d`), 22–23 August.

### Writing

- Document statistics popover (`Ctrl+Shift+C`) with words, sentences, reading time, selection counts and a shared writing-goal ring; reading time in the reader view and in `GET /api/documents/:id/content` (`9630ac3`, `fcfdb09`).
- Command palette (`Ctrl+Shift+P`, or `Ctrl+K` with no selection) backed by a command registry for the editor and the dashboard (`e9bfce2`, `0364c2d`).
- Slash command menu in the rich pane: `/heading`, `/list`, `/table`, `/code <lang>`, `/image`, `/link`, `/comment`, `/date`; one undo reverts the whole choice (`0123457`, `3a009af`).
- Table editing in the rich pane: row/column/alignment commands, a floating table menu, shortcuts and empty-cell styling; hidden when editing is off or the code pane is active (`4a74339`, `041c7f6`).
- Find & replace across both panes (`Ctrl+F` / `Ctrl+H`), seeded from the live selection (`4c41bb9`).
- Smart paste: a URL over a selection becomes a link, Markdown-looking text is inserted as source, HTML keeps bold and lists (`09a5bf4`).
- Images by paste, drop or upload, stored as Postgres assets behind `/api/assets` (`d117620`).
- Document templates: dashboard gallery and empty state, `template` parameter on the API and MCP, `GET /api/templates` (`6d117c3`).
- Code pane: Enter on an empty quote or list marker line exits the block instead of continuing it (`ba51f69`).
- Outline: stable hydration markup, `aria-current`, arrow-key navigation; clicking a heading lands on the block in the code pane (`6734795`).

### Collaborating

- Notifications: replies to your threads, resolves and re-opens, decisions on your suggestions, shares and @mentions, in a bell in the editor header, a strip on the dashboard and thread dots; `?thread=` deep links; `GET /api/notifications` (migration 0008 replaces the `mention` table; `/api/mentions` is deprecated) (`4e5b218`).
- Reader view `/p/:id`: read-only page with table of contents, "new version" pill, download menu; anonymous view links to `/d` redirect there; `renderMarkdownBody` and `contentHash` shared with export (`309b04e`).
- Per-document Activity panel: edits (coalesced per actor), comments, suggestions, versions, publish, shares, assets; agents marked; `GET /api/documents/:id/activity` (`1ba7824`, `15a728f`).
- `@mentions` in comments with a suggestions popover, chips, and dashboard notifications; `GET /api/mentions` (`2b2000a`).
- Offline resilience: open documents are mirrored to IndexedDB, unsaved-change count and reconnect feedback in the header, "All changes saved" after a reload with pending edits (`580219d`, `d7233a3`).
- Hydration fixes: client-only relative times, hydration-gated status-bar counts, shared `useHydrated()` (`f947cc0`).

### Organising

- Dashboard stars, recently opened order and sort that is remembered; header star; `star` API; MCP `starred` filter (`8de3569`).
- Dashboard search inside document content with snippets; `markdoc_search_documents` MCP tool; "Searching…" pending state (`7883a8c`, `159bdbb`).
- Make a copy, and trash with restore (soft delete, 30-day purge); open editors are kicked when a document is trashed; `duplicate`, `delete`, `restore` MCP tools (`6e88f71`).

### Exporting

- Export to standalone HTML and PDF from the header menu and `GET /api/documents/:id/export?format=` (`73c26c7`).

### Agents

- MCP tools added this day: `markdoc_search_documents`, `markdoc_duplicate_document`, `markdoc_delete_document`, `markdoc_restore_document`; `starred`/`trash` filters on `markdoc_list_documents`; `template` on `markdoc_create_document` (see the entries above).

### Build, ops and tests

- `drizzle-orm` is bundled into the server instead of externalised, which stops the intermittent runtime `import()` of `drizzle-orm/mysql-core` in route chunks (`9451112`).
- Production build health: Dockerfile (`node:22-alpine` + Chromium, healthcheck), `CHROMIUM_PATH`, `npm run smoke`, `start:local`, `e2e/prod-smoke.spec.ts` (`2cf7f2f`, `f396860`).
- Live test server scripts for Burke's `:3000`: `start-live.ps1`, `promote.ps1` with rollback, logon autostart (`9a20f0e`, `702b4d1`).
- Test and dev hygiene: per-run Next dist dirs for e2e, `E2E_PORT`, `E2E_SERVER_LOG`, `dev:port`, `tsconfig:revert`, fast-fail on a corrupt e2e cache, Playwright global warm-up of editor and API routes (`e260463`, `9e1696e`, `215e8ad`).
- Deterministic, load-tolerant incremental-parser fuzz (`FUZZ_DOCS` / `FUZZ_SEED`, `npm run test:fuzz`) (`00aa2d5`).
- Comments API route coverage with a live Hocuspocus document for commenter, viewer and anonymous callers (`c9a7706`).
