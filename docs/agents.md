# Agents and Markdoc

Markdoc is built so that people **and** agents can work on the same document. An agent (GitHub Copilot, Claude, a script, a CI job) acts through a personal access token and everything it does is visible live in the editor and attributed: versions say *"Burke via GitHub Copilot CLI"*, and the agent's comments and suggestions carry the token's name with a bot badge.

The recommended pattern is **agent proposes, human decides**: the agent drafts or revises with `suggest`, the humans see tracked changes in both panes and accept or reject them, then everyone keeps editing together.

## Contents

- [1. Create a token](#1-create-a-token)
- [2. Connect an MCP client](#2-connect-an-mcp-client)
  - [MCP tools](#mcp-tools)
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

`mcp/server.mjs` exposes Markdoc over the Model Context Protocol (stdio). Point any MCP client at it:

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

For GitHub Copilot CLI put that in `~/.copilot/mcp-config.json` (or use `/mcp add`); for VS Code put it in `.vscode/mcp.json` under `servers`; Claude Desktop and Cursor use the same shape. From a checkout you can also run `npm run mcp` with `MARKDOC_URL` and `MARKDOC_TOKEN` set.

### MCP tools

Eighteen tools; every `id` is the document id from the URL `/d/<id>`.

| Tool | Arguments | What it does |
| --- | --- | --- |
| `markdoc_whoami` | | Which user and agent identity the token acts as. |
| `markdoc_list_documents` | `starred?`, `trash?` | Documents you own or that are shared with you, most recently opened first; each has `starred` and `lastOpenedAt`. `starred: true` for only starred ones, `trash: true` for your own documents in the trash. |
| `markdoc_search_documents` | `query` (2+ chars), `limit?` | Find documents by title or body text; each hit includes a snippet around the match. |
| `markdoc_create_document` | `title?`, `content?`, `template?` | New document from Markdown or from a template id; returns the URL to open in the browser. |
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
| `markdoc_publish` | `id`, `message?` | Commit to the linked gist or repository (the document must already be connected in the app). |

A typical session: *"Let's write the launch plan"* → the agent calls `markdoc_create_document` and gives you the link → you open it, invite teammates, edit and comment → the agent reads `markdoc_comments`, answers with `markdoc_comment`, and revises with `markdoc_suggest` → you accept the good parts in the app.

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
| `POST /api/documents/:id/suggest` | `{ content }` or `{ edits: [{ find, replace, all? }] }` | edit | Propose word-level tracked changes. `400` when a `find` string is missing from the text or occurs more than once without `all: true`. |
| `GET /api/documents/:id/suggestions` | | view | Pending suggestions with ranges and context. |
| `POST /api/documents/:id/suggestions` | `{ action: accept \| reject \| acceptAll \| rejectAll, id? }` | edit | Review suggestions. |
| `GET /api/documents/:id/comments` | | view | `{ comments: [thread] }`: threads with the text they anchor to, a `mentions` array, `reactions` (`{ "👍": [userId, …] }`) and `editedAt` per thread and reply. |
| `POST /api/documents/:id/comments` | `{ action: "add", quote \| from,to, body }`, `{ action: "reply", threadId, body }`, `{ action: "resolve", threadId, resolved }`, `{ action: "edit", threadId, replyId?, body }`, `{ action: "delete", threadId, replyId? }`, `{ action: "react", threadId, replyId?, emoji }` | comment | Comment. `quote` must appear in the text (`400` otherwise). Editing and deleting is limited to your own comments unless you own the document. `react` toggles your reaction (`{ ok, reacted }`) and notifies nobody. |

### Versions, activity and export

| Method & path | Body / query | Access | Purpose |
| --- | --- | --- | --- |
| `GET /api/documents/:id/versions` | | view | `{ versions }`, newest first; `kind` is `auto`, `named`, `publish`, `restore` or `import`. |
| `POST /api/documents/:id/versions` | `{ title }` | edit | Name the current state (`201 { version }`). |
| `GET /api/documents/:id/versions/:vid` | | view | One version with its full text. |
| `POST /api/documents/:id/versions/:vid` | `{ action: "restore" }` or `{ action: "rename", title }` | edit | Restore (the pre-restore state is kept as a version) or rename (an `auto` version becomes `named`). |
| `POST /api/documents/:id/versions/:vid/copy` | | view | Copy that version as a new document you own: `201 { id, title }`, titled *Copy of <title> (v<n>)*, same rules as `/duplicate` (images copied, stored in Markdoc, no collaborators, one version *Copied from v<n>*). Trashed documents and unknown versions are `404`. |
| `DELETE /api/documents/:id/versions/:vid` | | edit | Delete a version. |
| `GET /api/documents/:id/activity` | `?before=<iso>&limit=50` | view | Who did what, when: `{ items: [{ id, actorId, actorName, actorKind: "user" \| "agent", action, detail, createdAt }], nextBefore }`, newest first. `action` is one of `edit`, `comment.add`, `comment.resolve`, `suggestion.add`, `suggestion.accept`, `suggestion.reject`, `version.save`, `version.restore`, `publish`, `share.add`, `share.remove`, `asset.upload`, `title.change`; `detail` holds small facts (`chars`, `count`, `number`, `title`, `login`, `role`, a ≤120-char `quote`), never document text. Pass `nextBefore` as `before` for the next page. Your own API calls appear under the token's name with `actorKind: "agent"`. |
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
| `POST /api/documents/:id/publish` | `{ message? }` | edit | Commit the clean text to the linked gist or repository file: `{ url, commitSha, publishedAt, skipped }` (`skipped` when nothing changed). The commit is made against the last known file sha, so upstream edits since the last publish/pull are rejected rather than overwritten. `400` when the document is not linked. |
| `POST /api/documents/:id/pull` | | edit | Replace the text with the GitHub copy (a version is kept). |
| `POST /api/import` | `{ source: "gist", gistId, filename? }` or `{ source: "repo", owner, repo, branch, path }` | signed in | Create a document from a GitHub file, linked for publish/pull (`201 { document }`). |
| `GET /api/github/gists`, `GET /api/github/repos`, `GET /api/github/repos/:owner/:repo/branches`, `GET /api/github/repos/:owner/:repo/files?ref=<branch>` | | signed in | Browse what the signed-in GitHub account can import from. |

Sharing a document with an audience: `/p/:id` is the read-only **reader view** (clean text, table of contents, reading time, download menu, no editor chrome); it opens for anyone when link access is not *Restricted*, while `/d/:id` is the editor.

### Account and notifications

| Method & path | Body / query | Access | Purpose |
| --- | --- | --- | --- |
| `GET /api/me` | | signed in | Current user and agent name. |
| `GET /api/notifications` | `?unread=1&limit=20&kind=<kind>` | signed in | Your notifications, newest first, with the document title: `{ items: [{ id, kind, documentId, documentTitle, actorLogin, actorName, refId, snippet, createdAt, readAt }], unreadCount }`. `kind` is one of `mention`, `reply` (to a thread you wrote in), `resolve` / `reopen` (of such a thread), `suggestion.accept` / `suggestion.reject` (of your suggestion), `share` (a document shared with you); `refId` is the thread, reply or suggestion id (`<docId>:<login>` for shares). |
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

People are notified — bell in the editor header, strip on the dashboard, `GET /api/notifications` for you — when someone replies to a thread they started or replied in, resolves or re-opens such a thread, accepts or rejects their suggestion, shares a document with them, or @mentions them. Emoji reactions never notify. Whatever you do through the API produces the same notifications for the humans involved (never for the actor). Actions through an agent token count as the token owner's: they notify everyone else involved and never the owner.

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

## What people see

- A chip in the editor header while an agent is active: *"Copilot proposed changes"*.
- The agent's suggestions in green/red on both surfaces, listed under **Comments → Suggestions** with Accept/Reject.
- The agent's comments with a bot badge; replies from people are readable through `markdoc_comments`.
- Every action in the document's **Activity** panel under the token's name, marked as an agent.
- Version history entries attributed to *"you via &lt;agent&gt;"*. In the history panel people can tick any two versions to compare them (old → new, with a Swap button, the authors of every version in the range, and `[` / `]` to jump between change hunks; a paragraph that only moved shows once as *moved* rather than red + green), name an auto version inline, restore it, or copy it as a new document.
