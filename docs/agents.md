# Agents and Markdoc

Markdoc is built so that people **and** agents can work on the same document. An agent (GitHub Copilot, Claude, a script, a CI job) acts through a personal access token and everything it does is visible live in the editor and attributed: versions say *"Burke via GitHub Copilot CLI"*, and the agent's comments and suggestions carry the token's name with a bot badge.

The recommended pattern is **agent proposes, human decides**: the agent drafts or revises with `suggest`, the humans see tracked changes in both panes and accept or reject them, then everyone keeps editing together.

## Contents

- [1. Create a token](#1-create-a-token)
- [2. Connect an MCP client](#2-connect-an-mcp-client)
  - [MCP tools](#mcp-tools)
  - [Requests](#requests)
    - [Working a request, step by step](#working-a-request-step-by-step)
- [3. Or call the REST API directly](#3-or-call-the-rest-api-directly)
  - [Access levels](#access-levels)
  - [Documents](#documents)
  - [Content, suggestions and comments](#content-suggestions-and-comments)
  - [Versions, activity and export](#versions-activity-and-export)
  - [Images](#images)
  - [Sharing and GitHub](#sharing-and-github)
  - [Account and notifications](#account-and-notifications)
  - [Mentioning people](#mentioning-people)
  - [Formatting and reactions](#formatting-and-reactions)
  - [Notifications](#notifications)
- [4. Recipes](#4-recipes)
- [What people see](#what-people-see)

## 1. Create a token

Open **Settings → Agents & API access** (`/settings`), name the token after the agent (for example *GitHub Copilot CLI*) and copy it. Tokens have the same access as you; revoke them there at any time. Tokens cannot create other tokens.

## 2. Connect an MCP client

Markdoc serves the Model Context Protocol itself at `/api/mcp` (Streamable HTTP). Any MCP client connects with the server URL and a token — nothing to install, no checkout. The **Share** dialog of every document has a *Collaborate with an agent* card with this config filled in for the server you are on (and a *Create a token* button), as does the *Connect an agent* card in **Settings → Agents** and on the first **Ask an agent**:

```json
{
  "mcpServers": {
    "markdoc": {
      "type": "http",
      "url": "http://localhost:3000/api/mcp",
      "headers": { "Authorization": "Bearer mdk_…" },
      "tools": ["*"]
    }
  }
}
```

For GitHub Copilot CLI put that in `~/.copilot/mcp-config.json` (or run `/mcp add` and enter the same URL and header); for VS Code put it in `.vscode/mcp.json` under `servers`; Claude, Cursor and other Streamable HTTP clients use the same shape. Use the URL you open Markdoc with (a LAN address such as `http://192.168.1.20:3000/api/mcp` works too; `MARKDOC_URL` on the server overrides the origin the tools call back to when it sits behind a proxy). A plain `GET /api/mcp` (no token) answers `{ name, version, tools, docs }` so a `curl` shows it is alive; without a token every MCP request is a `401` that says where to create one.

**Alternative: stdio from a checkout.** `mcp/server.mjs` exposes the same tools over stdio for clients that cannot speak HTTP:

```json
{
  "mcpServers": {
    "markdoc": {
      "command": "node",
      "args": ["/path/to/markdoc/mcp/server.mjs"],
      "env": { "MARKDOC_URL": "http://localhost:3000", "MARKDOC_TOKEN": "mdk_…" }
    }
  }
}
```

From a checkout you can also run `npm run mcp` with `MARKDOC_URL` and `MARKDOC_TOKEN` set. Both transports register the same tool set from `mcp/tools.mjs`; `npm run mcp:smoke` (with `MARKDOC_URL` and `MARKDOC_TOKEN`) checks a running server over HTTP with a real MCP client.

### MCP tools

Twenty-four tools; every `id` is the document id from the URL `/d/<id>`.

| Tool | Arguments | What it does |
| --- | --- | --- |
| `markdoc_whoami` | | Which user and agent identity the token acts as. |
| `markdoc_list_documents` | `starred?`, `trash?` | Documents you own or that are shared with you, most recently opened first; each has `starred` and `lastOpenedAt`. `starred: true` for only starred ones, `trash: true` for your own documents in the trash. |
| `markdoc_search_documents` | `query` (2+ chars), `limit?` | Find documents by title or body text; each hit includes a snippet around the match. |
| `markdoc_create_document` | `title?`, `content?`, `template?` | New document from Markdown or from a template id; returns the URL to open in the browser. |
| `markdoc_import_text` | `content`, `format?: markdown \| text \| html`, `title?` | New document from a string: Markdown or plain text as-is, HTML converted to GFM Markdown (sanitised). Title from front matter, the first heading or `<title>` unless given. Returns the URL and any `warnings`. |
| `markdoc_list_templates` | | The template ids `markdoc_create_document` accepts, with names and descriptions. |
| `markdoc_duplicate_document` | `id` | "Make a copy": a new document you own, titled *Copy of …*, with the current clean text and images. Always a Markdoc document, even when the source lives on GitHub. |
| `markdoc_delete_document` | `id`, `permanent?` | Move a document you own to the trash (restorable for 30 days). `permanent: true` deletes it for good. |
| `markdoc_restore_document` | `id` | Take a document out of the trash. |
| `markdoc_read_document` | `id`, `clean?` | Current Markdown (`clean: true` excludes pending suggestions). |
| `markdoc_replace_content` | `id`, `content`, `message?` | Replace the whole text, applied live as a minimal diff (collaborators keep their cursors); `message` names a version. |
| `markdoc_append` | `id`, `markdown` | Append Markdown to the end. |
| `markdoc_suggest` | `id`, `content` or `edits: [{ find, replace, all? }]` | Propose changes as tracked suggestions, from a full revised text or find → replace edits. |
| `markdoc_suggestions` | `id` | List pending suggestions with author and surrounding context. |
| `markdoc_review_suggestions` | `id`, `action: accept \| reject \| acceptAll \| rejectAll`, `suggestionId?` | Accept or reject (only when asked to). |
| `markdoc_comments` | `id` | Read threads, open and resolved, with the text they anchor to. |
| `markdoc_comment` | `id`, `action: add \| reply \| resolve \| reopen \| react`, `quote?`, `threadId?`, `replyId?`, `body?`, `emoji?` | Add a comment on a quote, reply to a thread, resolve or reopen it, or toggle an emoji reaction (`react` with `emoji`, optionally on a `replyId`). |
| `markdoc_versions` | `id` | Version history. |
| `markdoc_publish` | `id`, `message?`, `force?` | Commit to the linked gist or repository (the document must already be connected in the app). Answers with `status: remote-ahead \| diverged` instead of publishing when GitHub moved since the last sync; `force: true` overwrites. |
| `markdoc_pull` | `id`, `merge?`, `force?` | Bring the GitHub file into the document. Answers with `status: local-ahead \| diverged` instead of discarding unpublished edits; `merge: true` three-way merges a diverged document (conflicts → `status: "conflict"`, `merged` text with `<<<<<<< local` / `=======` / `>>>>>>> github` markers, `conflicts` count); `force: true` replaces the text regardless (a version is kept). |
| `markdoc_sync_status` | `id` | `in-sync`, `local-ahead` (publish is safe), `remote-ahead` (pull is safe) or `diverged`, with line counts for each side. |
| `markdoc_list_requests` | `status?`, `limit?` | Work humans asked for with **Ask an agent** in the editor: open requests across every document you can see, with the selected text, the instruction and the mode. See [Requests](#requests). |
| `markdoc_claim_request` | `documentId`, `requestId` | Take a request; the editor's pill switches to *"<agent> is working…"*. |
| `markdoc_complete_request` | `documentId`, `requestId`, `summary?` | Mark it done: the requester is notified (`request.done`) and the Comments panel opens on your suggestions. |

`markdoc_suggest` and `markdoc_comment` (`add`) also take an optional `requestId` so the work they produce is counted against the request.

A typical session: *"Let's write the launch plan"* → the agent calls `markdoc_create_document` and gives you the link → you open it, invite teammates, edit and comment → the agent reads `markdoc_comments`, answers with `markdoc_comment`, and revises with `markdoc_suggest` → you accept the good parts in the app.

### Requests

The other direction — a human asks **from the document** and an agent picks it up:

1. In the editor, select some text (or nothing for the whole document) and press **Ask an agent** (toolbar, selection bubble or command palette). Type an instruction or pick a chip (*Tighten this*, *Fix grammar and tone*, *Turn into a checklist*), choose how the agent should answer — **tracked changes** (default), **comment only** or **rewrite directly** (edit access) — and send. A pill in the header shows *"1 request waiting"*.
2. Your agent — GitHub Copilot CLI connected through the MCP server above, by default — calls `markdoc_list_requests` when you ask it to *"Check Markdoc for requests"*. Each request names the document, the requester, the instruction, the mode and the selected text.
3. It calls `markdoc_claim_request`, reads the document (`markdoc_read_document`), does the work with `markdoc_suggest` / `markdoc_comment` (passing the same `requestId`) or `markdoc_replace_content`, and finishes with `markdoc_complete_request { summary }`.
4. Back in the editor the pill clears, a toast says *"Copilot CLI finished: 3 suggestions"*, the Comments panel opens on **Suggestions** and the requester gets a `request.done` notification. The Activity panel shows *asked an agent* and *finished a request* rows.

Requests are scoped: `markdoc_list_requests` only lists documents the token's user owns or collaborates on. Commenters can ask for comments; asking for changes needs edit access. The requester (or the document owner) can cancel from the pill's menu. Nothing runs on the Markdoc server — it only keeps the inbox; the model is whichever agent you connect.

The first time someone without a token clicks **Ask an agent**, the dialog shows a one-time *Connect an agent* card with the MCP config for the server they are on (the same card sits at the top of **Settings → Agents**).

#### Working a request, step by step

The agent side is always the same four moves; only the middle one changes with the request's `mode`.

1. **Find work.** `markdoc_list_requests` with no arguments lists `open` requests (`status` can also be `claimed`, `done` or `cancelled`; `limit` caps the list at 1–200). Each item carries `id`, `documentId`, `documentTitle`, `userName`, `instruction`, `selection` (`{ from, to, quote }`, or `null` for the whole document), `mode`, `status`, `claimedBy` and `createdAt`. There is no push channel to the agent — check when the human asks, or poll on a timer; the human's side updates live.
2. **Claim it.** `markdoc_claim_request { documentId, requestId }`. Claiming a request you already hold is a no-op; one that another agent holds, or that was cancelled, answers `409`. Sending `markdoc_suggest` or `markdoc_comment` with the `requestId` claims it implicitly, but claim first so the pill shows your name while you read.
3. **Do the work** with the tools you already use, matching the mode the human chose:
   - `suggest` → `markdoc_suggest` with `requestId`.
   - `comment` → `markdoc_comment` (`action: "add"`) with `requestId`, anchored to the selected `quote`.
   - `rewrite` → `markdoc_replace_content` (it has no `requestId`; the result is the edit itself).
4. **Complete it.** `markdoc_complete_request { documentId, requestId, summary }`. `summary` (one sentence, ≤ 2000 characters, clipped to 500 in the notification) is what the requester reads in the toast and the bell. The counts come from the `requestId`-linked calls; completing twice is a no-op and a cancelled request answers `409`.

Quote the selection exactly as the request gives it: `markdoc_suggest` `edits[].find` must match once (or set `all: true`) and `markdoc_comment` `quote` must appear in the text, both `400` otherwise. Read the document with `markdoc_read_document { id, clean: true }` first when you need more than the selection.

**Tracked changes (`mode: "suggest"`)** — the request was *"Tighten this"* on the quote *"In order to be able to ship on time we will need to"*:

```json
{ "tool": "markdoc_list_requests", "arguments": {} }
{ "tool": "markdoc_claim_request", "arguments": { "documentId": "DOC", "requestId": "REQ" } }
{ "tool": "markdoc_read_document", "arguments": { "id": "DOC", "clean": true } }
{ "tool": "markdoc_suggest", "arguments": { "id": "DOC", "requestId": "REQ",
  "edits": [{ "find": "In order to be able to ship on time we will need to", "replace": "To ship on time we must" }] } }
{ "tool": "markdoc_complete_request", "arguments": { "documentId": "DOC", "requestId": "REQ",
  "summary": "Tightened the opening sentence as one tracked change." } }
```

**Comment only (`mode: "comment"`)** — *"Is this claim backed by data?"* on the quote *"Most users prefer the dark theme"*:

```json
{ "tool": "markdoc_list_requests", "arguments": {} }
{ "tool": "markdoc_claim_request", "arguments": { "documentId": "DOC", "requestId": "REQ" } }
{ "tool": "markdoc_comment", "arguments": { "id": "DOC", "action": "add", "requestId": "REQ",
  "quote": "Most users prefer the dark theme",
  "body": "No source for this in the document. The settings survey in **§3** reports 41 % dark / 59 % light — either cite it or soften to *many users*." } }
{ "tool": "markdoc_complete_request", "arguments": { "documentId": "DOC", "requestId": "REQ",
  "summary": "Left one comment: the preference claim needs a source or softer wording." } }
```

**Rewrite directly (`mode: "rewrite"`)** — *"Turn into a checklist"* with no selection (whole document). The change lands in place for everyone, so only do this when the mode says so; `message` names the version it creates:

```json
{ "tool": "markdoc_list_requests", "arguments": {} }
{ "tool": "markdoc_claim_request", "arguments": { "documentId": "DOC", "requestId": "REQ" } }
{ "tool": "markdoc_read_document", "arguments": { "id": "DOC", "clean": true } }
{ "tool": "markdoc_replace_content", "arguments": { "id": "DOC",
  "content": "# Launch checklist\n\n- [ ] Cut the release branch\n- [ ] Run the e2e suite\n- [ ] Publish the changelog\n",
  "message": "Rewritten as a checklist (Ask an agent)" } }
{ "tool": "markdoc_complete_request", "arguments": { "documentId": "DOC", "requestId": "REQ",
  "summary": "Rewrote the document as a three-item checklist; see version history to compare." } }
```

The same flow over REST is in [Recipes](#4-recipes).

## 3. Or call the REST API directly

All routes accept `Authorization: Bearer mdk_…` (the browser session cookie works too). Bodies are JSON unless noted; errors are `{ error }` with a 4xx/5xx status. The examples below assume:

```bash
BASE=http://localhost:3000
TOKEN=mdk_…
```

### Access levels

The *Access* column is the minimum role on the document: **view** (owner, any collaborator, or anyone when link access allows it), **comment** (commenter or above), **edit** (editor or owner), **own** (owner only). Documents in the trash answer `404` everywhere except `DELETE ?permanent=1` and `restore`.

### Documents

| Method & path | Body / query | Access | Purpose |
| --- | --- | --- | --- |
| `GET /api/documents` | `?starred=1`, `?trash=1` | signed in | List documents, most recently opened first (never-opened ones follow by last edit); each has `starred` and `lastOpenedAt`. `starred=1` lists only your starred ones; `trash=1` lists your own documents in the trash (each with `deletedAt`). |
| `GET /api/documents?q=text&limit=20` | | signed in | Search titles and content (case-insensitive, 2+ chars): `{ documents: [{ …, snippet }], query }`. |
| `POST /api/documents` | `{ title?, content?, template? }` | signed in | Create (`201`). `template` is an id from `GET /api/templates`; it fills `title` and `content` when they are omitted (`{{date}}` → today, `{{user}}` → your login). Unknown id → `400`. |
| `GET /api/templates` | | signed in | `{ templates: [{ id, name, description }] }`: `blank`, `meeting-notes`, `project-readme`, `design-doc`, `weekly-status`, `blog-post`, `decision-record`, `checklist`. |
| `GET /api/documents/:id` | | view | `{ document, role }`: title, storage, link access, timestamps and your role. |
| `PATCH /api/documents/:id` | `{ title? }`, `{ linkAccess?: private \| view \| comment \| edit }` | edit (`linkAccess`: own) | Rename, or change who a link admits. |
| `DELETE /api/documents/:id` | `?permanent=1` | own | Move to the **trash**: it vanishes from lists, search and every route (`404`), connected editors are sent back to the dashboard, and it is purged after **30 days**. `permanent=1` deletes immediately (also for documents already in the trash). |
| `POST /api/documents/:id/restore` | | own | Take the document out of the trash. |
| `POST /api/documents/:id/duplicate` | | view | Make a copy: `201 { id, title }`. The copy is yours, titled *Copy of …*, holds the current clean text with referenced images copied, is stored in Markdoc (no GitHub link), has no collaborators and one version *Copied from …*. |
| `GET` / `PUT` / `DELETE /api/documents/:id/star` | | view | Read, set or clear your star (`{ starred }`). Stars are per user. |

### Content, suggestions and comments

| Method & path | Body | Access | Purpose |
| --- | --- | --- | --- |
| `GET /api/documents/:id/content` | | view | `{ content, clean, title, contentHash, pendingSuggestions, openComments, stats }`. `contentHash` is the SHA-256 of `clean`; `stats` are prose statistics of `clean`: `{ words, characters, charactersNoSpaces, sentences, paragraphs, headings, readingMinutes (200 wpm), speakingMinutes (130 wpm) }` (fenced code and front matter excluded). |
| `PUT /api/documents/:id/content` | `{ content, message? }` | edit | Replace the whole text (minimal live diff; `message` names a version). |
| `PATCH /api/documents/:id/content` | `{ append }` | edit | Append Markdown. |
| `POST /api/documents/:id/suggest` | `{ content }` or `{ edits: [{ find, replace, all? }] }`, plus `requestId?` | edit | Propose word-level tracked changes. `400` when a `find` string is missing from the text or occurs more than once without `all: true`. Returns `{ suggestions, suggestionIds }`; with `requestId` the suggestions count against that request. |
| `GET /api/documents/:id/suggestions` | | view | Pending suggestions with ranges and context. |
| `POST /api/documents/:id/suggestions` | `{ action: accept \| reject \| acceptAll \| rejectAll, id? }` | edit | Review suggestions. |
| `GET /api/documents/:id/comments` | | view | `{ comments: [thread] }`: threads with the text they anchor to, a `mentions` array, `reactions` (`{ "👍": [userId, …] }`) and `editedAt` per thread and reply. |
| `POST /api/documents/:id/comments` | `{ action: "add", quote \| from,to, body, requestId? }`, `{ action: "reply", threadId, body }`, `{ action: "resolve", threadId, resolved }`, `{ action: "edit", threadId, replyId?, body }`, `{ action: "delete", threadId, replyId? }`, `{ action: "react", threadId, replyId?, emoji }` | comment | Comment. `quote` must appear in the text (`400` otherwise). Editing and deleting is limited to your own comments unless you own the document. `react` toggles your reaction (`{ ok, reacted }`) and notifies nobody. |

### Agent requests

| Method & path | Body / query | Access | Purpose |
| --- | --- | --- | --- |
| `GET /api/agent/requests` | `?status=open` (default; comma-separated list allowed), `?limit=` | token only | The agent's inbox: requests across every document the token's user owns or collaborates on, each with `documentTitle`, `userName`, `instruction`, `selection`, `mode`, `status`. |
| `POST /api/documents/:id/requests` | `{ instruction (≤ 2000), selection?: { from, to, quote }, mode?: suggest \| comment \| rewrite }` | comment (`suggest`/`rewrite`: edit) | Ask an agent (`201 { request }`). Records `agent.request` activity. |
| `GET /api/documents/:id/requests` | `?status=open,claimed` | view | Requests on this document, newest first. |
| `POST /api/documents/:id/requests/:rid/claim` | | comment | Take an open request (`409` when another agent has it). |
| `POST /api/documents/:id/requests/:rid/complete` | `{ summary?, suggestions?, comments? }` | comment | Mark done: `result` gets the counts (from `requestId`-linked suggest/comment calls unless overridden) and `summary`; records `agent.request.done` and notifies the requester (`request.done`). |
| `POST /api/documents/:id/requests/:rid/cancel` | | requester or owner | Withdraw an open or claimed request. |

Request status is also mirrored into the live document (`meta.agentRequests`), which is how the editor's pill updates without polling.

### Versions, activity and export

| Method & path | Body / query | Access | Purpose |
| --- | --- | --- | --- |
| `GET /api/documents/:id/versions` | | view | `{ versions }`, newest first; `kind` is `auto`, `named`, `publish`, `restore` or `import`. |
| `POST /api/documents/:id/versions` | `{ title }` | edit | Name the current state (`201 { version }`). |
| `GET /api/documents/:id/versions/:vid` | | view | One version with its full text. |
| `POST /api/documents/:id/versions/:vid` | `{ action: "restore" }` or `{ action: "rename", title }` | edit | Restore (the pre-restore state is kept as a version) or rename (an `auto` version becomes `named`). |
| `POST /api/documents/:id/versions/:vid/copy` | | view | Copy that version as a new document you own: `201 { id, title }`, titled *Copy of <title> (v<n>)*, same rules as `/duplicate` (images copied, stored in Markdoc, no collaborators, one version *Copied from v<n>*). Trashed documents and unknown versions are `404`. |
| `DELETE /api/documents/:id/versions/:vid` | | edit | Delete a version. |
| `GET /api/documents/:id/activity` | `?before=<iso>&limit=50` | view | Who did what, when: `{ items: [{ id, actorId, actorName, actorKind: "user" \| "agent", action, detail, createdAt }], nextBefore }`, newest first. `action` is one of `edit`, `comment.add`, `comment.resolve`, `suggestion.add`, `suggestion.accept`, `suggestion.reject`, `version.save`, `version.restore`, `publish`, `share.add`, `share.remove`, `asset.upload`, `title.change`, `agent.request` (someone asked an agent), `agent.request.done` (an agent finished one; `detail` has `requestId`, `mode`, `suggestions`, `comments`, `summary`); `detail` holds small facts (`chars`, `count`, `number`, `title`, `login`, `role`, a ≤120-char `quote`), never document text. Pass `nextBefore` as `before` for the next page. Your own API calls appear under the token's name with `actorKind: "agent"`. |
| `GET /api/documents/:id/export` | `?format=md \| html \| pdf` (default `md`), `?download=1` (attachment; HTML embeds images as `data:` URIs), `?suggestions=1` keeps pending insertions | view | Plain Markdown, a standalone HTML page, or a Letter PDF. PDF returns `503 { error }` if Chromium is unavailable on the server. |

### Images

| Method & path | Body | Access | Purpose |
| --- | --- | --- | --- |
| `POST /api/documents/:id/assets` | multipart `file` field, or a raw image body with `Content-Type: image/png` and `?name=shot.png` | edit | Upload an image (PNG, JPEG, GIF, WebP, SVG; ≤ 5 MB). Returns `{ id, url, name, mime, size, alt }`; put `![alt](url)` in the Markdown. Identical bytes within a document share one asset. |
| `GET /api/assets/:id` | | view (owning document) | The image bytes; shared links included. |

### Sharing and GitHub

| Method & path | Body | Access | Purpose |
| --- | --- | --- | --- |
| `GET /api/documents/:id/collaborators` | | view | `{ owner, collaborators, linkAccess }`. |
| `POST /api/documents/:id/collaborators` | `{ login, role: editor \| commenter \| viewer }` | own | Add or change a person by GitHub handle. |
| `DELETE /api/documents/:id/collaborators` | `{ login }` | own | Remove a person. |
| `POST /api/documents/:id/link` | `{ storage: "local" }`, `{ storage: "gist", gistId?, filename?, isPublic?, description? }` or `{ storage: "repo", owner, repo, branch, path }` | own | Connect the document to a gist or repository file (or back to Markdoc-only storage). |
| `GET /api/documents/:id/sync` | `?fresh=1` (skip the 30 s cache), `?content=1` (include `remoteContent`) | view | Three-way status against the linked file, like a Git client: `{ status: "in-sync" \| "local-ahead" \| "remote-ahead" \| "diverged", remote: { sha, revision, url, updatedAt }, localChanged, remoteChanged, lines: { local, remote }, pollMs }`. The base is the content of the last publish/pull; `remote.sha` is the file blob sha for repositories and the latest history version for gists. The GitHub read is cached for 30 s per document. |
| `POST /api/documents/:id/publish` | `{ message?, force? }` (or `?force=1`) | edit | Commit the clean text to the linked gist or repository file: `{ url, commitSha, publishedAt, skipped, status }` (`skipped` when nothing changed). Refuses with `409 { error, status: "remote-ahead" \| "diverged", remote, localChanged, remoteChanged, lines }` when GitHub moved since the last sync — pull or merge first. `force` overwrites anyway (version *Force-published*). `400` when the document is not linked. |
| `POST /api/documents/:id/pull` | `?merge=1`, `?force=1` | edit | Bring the GitHub copy into the document: `{ changed, url, status, merged? }`. Refuses with `409 { error, status: "local-ahead" \| "diverged", remoteContent, remote, lines }` when unpublished local edits would be lost. `merge=1` three-way merges a diverged document (clean → applied, version *Merged from GitHub*, `status: "local-ahead"` — publish to finish; conflicts → `409 { status: "conflict", merged, conflicts, remoteContent }` where `merged` carries `<<<<<<< local` / `=======` / `>>>>>>> github` markers and nothing is applied). `force=1` replaces the text regardless (version *Pulled from GitHub* / *Force-pulled from GitHub*). |
| `POST /api/import` | `{ source: "gist", gistId, filename? }` or `{ source: "repo", owner, repo, branch, path }` | signed in | Create a document from a GitHub file, linked for publish/pull (`201 { document }`). |
| `POST /api/import/file` | multipart: one or more `files` (`.md`, `.markdown`, `.txt`, `.html`, `.htm`; ≤ 2 MB each, ≤ 20) plus optional `images` the Markdown references by relative path; or JSON `{ title?, content, format: markdown \| text \| html }` | signed in | Import local files as new Markdoc documents: `201 { documents: [{ id, title, warnings }] }`. Title from front matter `title:`, else the first H1, else the file name; line endings normalised to LF; HTML is sanitised and converted to GFM Markdown. Images whose file name matches a relative `![…](path)` become assets of that document and the path is rewritten to `/api/assets/:id`; unmatched ones are listed in `warnings`. One version *Imported from <file>* is recorded. |
| `GET /api/github/gists`, `GET /api/github/repos`, `GET /api/github/repos/:owner/:repo/branches`, `GET /api/github/repos/:owner/:repo/files?ref=<branch>` | | signed in | Browse what the signed-in GitHub account can import from. |

Sharing a document with an audience: `/p/:id` is the read-only **reader view** (clean text, table of contents, reading time, download menu, no editor chrome); it opens for anyone when link access is not *Restricted*, while `/d/:id` is the editor.

### Account and notifications

| Method & path | Body / query | Access | Purpose |
| --- | --- | --- | --- |
| `GET /api/me` | | signed in | Current user and agent name. |
| `GET /api/notifications` | `?unread=1&limit=20&kind=<kind>` | signed in | Your notifications, newest first, with the document title: `{ items: [{ id, kind, documentId, documentTitle, actorLogin, actorName, refId, snippet, createdAt, readAt }], unreadCount }`. `kind` is one of `mention`, `reply` (to a thread you wrote in), `resolve` / `reopen` (of such a thread), `suggestion.accept` / `suggestion.reject` (of your suggestion), `share` (a document shared with you), `request.done` (an agent finished a request you made; `actorName` is the agent, `snippet` its summary); `refId` is the thread, reply, suggestion or request id (`<docId>:<login>` for shares). |
| `POST /api/notifications/:id/read` / `POST /api/notifications/read-all` / `POST /api/notifications/thread-read` | `{ documentId, refIds }` for thread-read | signed in | Mark one, all, or everything about the given threads/replies read. |
| `GET /api/mentions` / `POST /api/mentions/:id/read` | | signed in | **Deprecated, removed next release**: alias of `GET /api/notifications?unread=1&kind=mention` (also returns the old `mentions` array) and of `POST /api/notifications/:id/read`. |
| `GET /api/tokens`, `POST /api/tokens` | `{ name, expiresInDays? }` | session only | List your API tokens; create one (`201`, the secret is returned once). Tokens cannot call these. |
| `DELETE /api/tokens/:id` | | session only | Revoke a token. |
| `GET /api/health` | | public | `{ ok, version }`. |

### Mentioning people

Agents can get someone's attention by writing `@login` (their GitHub handle) in a comment or reply body, for example `"body": "@burke the numbers in section 2 look stale"`. Mentions render as chips in the comments panel, are listed in each thread's `mentions` array from `GET /api/documents/:id/comments`, and show up on the mentioned person's dashboard and in the bell in the editor header until they open the thread or dismiss them. E-mail addresses are not treated as mentions.

### Formatting and reactions

Comment and reply bodies support inline Markdown: `**bold**`, `*italic*`, `` `code` ``, `[text](https://…)` and bare `http(s)://` URLs (which auto-link). Single newlines are line breaks, blank lines start a new paragraph. Headings, lists, images and HTML are not rendered — they stay literal text — and only `http`, `https` and `mailto` links are clickable. The stored `body` is always the raw text you sent.

Reactions are emoji on a thread or a reply: `POST … { action: "react", threadId, replyId?, emoji: "👍" }` toggles yours (send it again to remove it) and answers `{ ok: true, reacted: true | false }`. Reactions appear live as chips in the comments panel (the editor offers 👍 ❤️ 🎉 👀 😄 🚀, any emoji is accepted) and in `reactions` from `GET /api/documents/:id/comments`. **Reactions never create notifications** — react freely to acknowledge feedback without ringing anyone's bell; reply when you need someone to look.

### Notifications

People are notified — bell in the editor header, strip on the dashboard, `GET /api/notifications` for you — when someone replies to a thread they started or replied in, resolves or re-opens such a thread, accepts or rejects their suggestion, shares a document with them, @mentions them, or when an agent completes a request they made with **Ask an agent** (`request.done`, attributed to the agent by name). Emoji reactions never notify. Whatever you do through the API produces the same notifications for the humans involved (never for the actor). Actions through an agent token count as the token owner's: they notify everyone else involved and never the owner — except `request.done`, which always reaches the requester, even when the agent's token is their own.

## 4. Recipes

Each recipe uses `$BASE` and `$TOKEN` from above and `jq` for picking ids.

**Push a draft for human review as tracked changes.** Read the clean text, send the whole revision as a suggestion, then tell the reviewer.

```bash
curl -s -H "Authorization: Bearer $TOKEN" "$BASE/api/documents/$ID/content" | jq -r .clean > draft.md
# … edit draft.md …
curl -s -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -X POST "$BASE/api/documents/$ID/suggest" \
  -d "$(jq -n --rawfile c draft.md '{content: $c}')"
curl -s -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -X POST "$BASE/api/documents/$ID/comments" \
  -d '{"action":"add","quote":"Summary","body":"@burke revised the summary and dates as suggestions; accept what reads right."}'
```

**Comment with an @mention on a specific sentence.** Quote the text exactly as it appears; the comment follows it as the document changes.

```bash
curl -s -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -X POST "$BASE/api/documents/$ID/comments" \
  -d '{"action":"add","quote":"We ship Friday","body":"@burke the release branch is not cut yet - still Friday?"}'
curl -s -H "Authorization: Bearer $TOKEN" "$BASE/api/documents/$ID/comments" | jq '.comments[] | {id, quote, mentions}'
```

**Create from a template, then export a PDF.**

```bash
ID=$(curl -s -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -X POST "$BASE/api/documents" \
  -d '{"template":"meeting-notes","title":"Platform sync 2026-08-23"}' | jq -r .document.id)
curl -s -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -X PATCH "$BASE/api/documents/$ID/content" \
  -d '{"append":"\n## Decisions\n\n- Ship the reader view this week.\n"}'
curl -s -H "Authorization: Bearer $TOKEN" -o notes.pdf "$BASE/api/documents/$ID/export?format=pdf&download=1"
```

**Search, then star the match.**

```bash
ID=$(curl -s -H "Authorization: Bearer $TOKEN" "$BASE/api/documents?q=launch%20plan&limit=1" | jq -r '.documents[0].id')
curl -s -H "Authorization: Bearer $TOKEN" -X PUT "$BASE/api/documents/$ID/star"
curl -s -H "Authorization: Bearer $TOKEN" "$BASE/api/documents?starred=1" | jq '.documents[] | .title'
```

**Upload an image and embed it.**

```bash
URL=$(curl -s -H "Authorization: Bearer $TOKEN" -F file=@chart.png "$BASE/api/documents/$ID/assets" | jq -r .url)
curl -s -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -X PATCH "$BASE/api/documents/$ID/content" \
  -d "{\"append\":\"\\n![chart]($URL)\\n\"}"
```

**Work an "Ask an agent" request over REST.** List the inbox, claim the first request, answer in the mode it asks for, complete it. `GET /api/agent/requests` needs a token (a browser session gets `403`).

```bash
REQ=$(curl -s -H "Authorization: Bearer $TOKEN" "$BASE/api/agent/requests" | jq -c '.requests[0]')
ID=$(jq -r .documentId <<<"$REQ"); RID=$(jq -r .id <<<"$REQ"); MODE=$(jq -r .mode <<<"$REQ"); QUOTE=$(jq -r '.selection.quote // empty' <<<"$REQ")
curl -s -H "Authorization: Bearer $TOKEN" -X POST "$BASE/api/documents/$ID/requests/$RID/claim"
case $MODE in
  suggest) curl -s -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -X POST "$BASE/api/documents/$ID/suggest" \
             -d "$(jq -n --arg f "$QUOTE" --arg r "To ship on time we must" --arg rid "$RID" '{edits: [{find: $f, replace: $r}], requestId: $rid}')" ;;
  comment) curl -s -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -X POST "$BASE/api/documents/$ID/comments" \
             -d "$(jq -n --arg q "$QUOTE" --arg rid "$RID" '{action: "add", quote: $q, body: "No source for this claim — cite the survey or soften it.", requestId: $rid}')" ;;
  rewrite) curl -s -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -X PUT "$BASE/api/documents/$ID/content" \
             -d "$(jq -n --rawfile c rewritten.md '{content: $c, message: "Rewritten (Ask an agent)"}')" ;;
esac
curl -s -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -X POST "$BASE/api/documents/$ID/requests/$RID/complete" \
  -d '{"summary":"Done — see the Suggestions tab."}'
```

## What people see

- A chip in the editor header while an agent is active: *"Copilot proposed changes"*.
- The agent's suggestions in green/red on both surfaces, listed under **Comments → Suggestions** with Accept/Reject.
- The agent's comments with a bot badge; replies from people are readable through `markdoc_comments`.
- Every action in the document's **Activity** panel under the token's name, marked as an agent.
- Version history entries attributed to *"you via &lt;agent&gt;"*. In the history panel people can tick any two versions to compare them (old → new, with a Swap button, the authors of every version in the range, and `[` / `]` to jump between change hunks; a paragraph that only moved shows once as *moved* rather than red + green), name an auto version inline, restore it, or copy it as a new document.
