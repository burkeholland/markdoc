# Agents and Markdoc

Markdoc is built so that people **and** agents can work on the same document. An agent (GitHub Copilot, Claude, a script, a CI job) acts through a personal access token and everything it does is visible live in the editor and attributed: versions say *"Burke via GitHub Copilot CLI"*, and the agent's comments and suggestions carry the token's name with a bot badge.

The recommended pattern is **agent proposes, human decides**: the agent drafts or revises with `suggest`, the humans see tracked changes in both panes and accept or reject them, then everyone keeps editing together.

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

Tools:

| Tool | What it does |
| --- | --- |
| `markdoc_whoami` | Which user and agent identity the token acts as. |
| `markdoc_list_documents` | Documents you own or that are shared with you, most recently opened first; each has `starred` and `lastOpenedAt`. Pass `starred: true` for only starred ones, or `trash: true` for your own documents in the trash. |
| `markdoc_search_documents` | Find documents by title or body text (`query`, optional `limit`); each hit includes a snippet around the match. |
| `markdoc_create_document` | New document from Markdown (`content`) or from a template (`template` id); returns the URL to open in the browser. |
| `markdoc_duplicate_document` | "Make a copy": a new document you own, titled *Copy of …*, with the current clean text and images. Always a Markdoc document, even when the source lives on GitHub. |
| `markdoc_delete_document` | Move a document you own to the trash (soft delete; restorable for 30 days). `permanent: true` deletes it for good. |
| `markdoc_restore_document` | Take a document out of the trash. |
| `markdoc_list_templates` | The template ids `markdoc_create_document` accepts, with names and descriptions. |
| `markdoc_read_document` | Current Markdown (`clean: true` excludes pending suggestions). |
| `markdoc_replace_content` / `markdoc_append` | Direct edits, applied live as minimal diffs (collaborators keep their cursors). |
| `markdoc_suggest` | Propose changes as tracked suggestions, from a full revised text or `find → replace` edits. |
| `markdoc_suggestions` / `markdoc_review_suggestions` | List pending suggestions; accept/reject (only when asked). |
| `markdoc_comments` / `markdoc_comment` | Read threads (with the text they anchor to); add a comment on a quote, reply, resolve. |
| `markdoc_versions` | Version history. |
| `markdoc_publish` | Commit to the linked gist or repository. |

A typical session: *"Let's write the launch plan"* → the agent calls `markdoc_create_document` and gives you the link → you open it, invite teammates, edit and comment → the agent reads `markdoc_comments`, answers with `markdoc_comment`, and revises with `markdoc_suggest` → you accept the good parts in the app.

## 3. Or call the REST API directly

All routes accept `Authorization: Bearer mdk_…`.

| Method & path | Body | Purpose |
| --- | --- | --- |
| `GET /api/me` | | Current user and agent name. |
| `GET /api/documents` | | List documents, most recently opened first (never-opened ones follow by last edit); each has `starred` and `lastOpenedAt`. `?starred=1` lists only the caller's starred documents. `?trash=1` lists the caller's own documents in the trash instead (each with `deletedAt`). |
| `POST /api/documents/:id/duplicate` | | Make a copy (anyone with view access): `201 { id, title }`. The copy is owned by the caller, titled *Copy of …*, holds the current clean text with referenced images copied, is stored in Markdoc (no GitHub link), has no collaborators and one version *Copied from …*. |
| `DELETE /api/documents/:id` | | Owner only. Moves the document to the **trash**: it vanishes from lists, search and every route (`404`), connected editors are sent back to the dashboard, and it is deleted for good after **30 days**. `?permanent=1` deletes it immediately (also for documents already in the trash). |
| `POST /api/documents/:id/restore` | | Owner only. Takes the document out of the trash. |
| `GET /api/documents/:id/star` / `PUT` / `DELETE` | | Read, set or clear the caller's star on a document (`{ starred }`). Stars are per user. |
| `GET /api/documents?q=text&limit=20` | | Search titles and content (case-insensitive, 2+ chars); `{ documents: [{ …, snippet }], query }`. |
| `POST /api/documents` | `{ title?, content?, template? }` | Create. `template` is an id from `GET /api/templates`; it fills `title` and `content` when they are omitted (`{{date}}` → today, `{{user}}` → your login). Unknown id → `400`. |
| `GET /api/templates` | | `{ templates: [{ id, name, description }] }` — the ids: `blank`, `meeting-notes`, `project-readme`, `design-doc`, `weekly-status`, `blog-post`, `decision-record`, `checklist`. |
| `GET /api/documents/:id/content` | | `{ content, clean, title, contentHash, pendingSuggestions, openComments, stats }` — `contentHash` is the SHA-256 of `clean`; `stats` are prose statistics of `clean`: `{ words, characters, charactersNoSpaces, sentences, paragraphs, headings, readingMinutes (200 wpm), speakingMinutes (130 wpm) }` (fenced code and front matter excluded, inline code and link text included). |
| `PUT /api/documents/:id/content` | `{ content, message? }` | Replace the whole text (minimal live diff; `message` names a version). |
| `PATCH /api/documents/:id/content` | `{ append }` | Append Markdown. |
| `POST /api/documents/:id/suggest` | `{ content }` or `{ edits: [{ find, replace, all? }] }` | Propose word-level tracked changes. |
| `GET /api/documents/:id/suggestions` | | Pending suggestions with ranges and context. |
| `POST /api/documents/:id/suggestions` | `{ action: accept\|reject\|acceptAll\|rejectAll, id? }` | Review suggestions. |
| `GET /api/documents/:id/comments` | | Threads with the text they anchor to. |
| `POST /api/documents/:id/comments` | `{ action: "add", quote \| from,to, body }`, `{ action: "reply", threadId, body }`, `{ action: "resolve", threadId, resolved }` | Comment. |
| `GET /api/mentions` / `POST /api/mentions/:id/read` | | Your unread `@mentions` (with document title); mark one read. |
| `GET /api/documents/:id/versions` / `POST` | `{ title }` | History; name the current state. |
| `GET /api/documents/:id/activity` | `?before=<iso>&limit=50` | Who did what, when — `{ items: [{ id, actorId, actorName, actorKind: "user"\|"agent", action, detail, createdAt }], nextBefore }`, newest first. `action` is one of `edit`, `comment.add`, `comment.resolve`, `suggestion.add`, `suggestion.accept`, `suggestion.reject`, `version.save`, `version.restore`, `publish`, `share.add`, `share.remove`, `asset.upload`, `title.change`; `detail` holds small facts (`chars`, `count`, `number`, `title`, `login`, `role`, a ≤120-char `quote`) — never document text. Pass `nextBefore` as `before` for the next page. Your own API calls appear here under the token's name with `actorKind: "agent"`. |
| `GET /api/documents/:id/export` | `?format=md\|html\|pdf` (default `md`), `?download=1` (attachment; HTML embeds images as `data:` URIs), `?suggestions=1` keeps pending insertions | Plain Markdown, a standalone HTML page, or a Letter PDF. PDF returns `503 { error }` if Chromium is unavailable on the server. |
| `POST /api/documents/:id/publish` / `pull` | `{ message? }` | GitHub publish / pull. |
| `POST /api/documents/:id/assets` | multipart `file` field, or a raw image body with `Content-Type: image/png` and `?name=shot.png` | Upload an image (PNG, JPEG, GIF, WebP, SVG; ≤ 5 MB). Returns `{ id, url, name, mime, size, alt }`; put `![alt](url)` in the Markdown. Identical bytes within a document share one asset. |
| `GET /api/assets/:id` | | The image bytes. Requires view access to the owning document (shared links included). |

Sharing a document with an audience: `/p/:id` is the read-only **reader view** (clean text, table of contents, no editor chrome); it opens for anyone when link access is not *Restricted*, while `/d/:id` is the editor.

Example:

```bash
curl -s -H "Authorization: Bearer $MARKDOC_TOKEN" -H "Content-Type: application/json" \
  -X POST http://localhost:3000/api/documents/abc123/suggest \
  -d '{"edits":[{"find":"We ship Friday","replace":"We ship next Friday"}]}'
```

Uploading an image and embedding it:

```bash
curl -s -H "Authorization: ******" -F file=@chart.png \
  http://localhost:3000/api/documents/abc123/assets
# → {"id":"…","url":"/api/assets/…","name":"chart.png","mime":"image/png","size":12345,"alt":"chart"}
curl -s -H "Authorization: ******" -H "Content-Type: application/json" \
  -X PATCH http://localhost:3000/api/documents/abc123/content -d '{"append":"\n![chart](/api/assets/…)\n"}'
```

### Mentioning people

Agents can get someone's attention by writing `@login` (their GitHub handle) in a comment or reply body, for example `"body": "@burke the numbers in section 2 look stale"`. Mentions render as chips in the comments panel, are listed in each thread's `mentions` array from `GET /api/documents/:id/comments`, and show up on the mentioned person's dashboard until they open the document or dismiss them. E-mail addresses are not treated as mentions.

## What people see

- A chip in the editor header while an agent is active: *"Copilot proposed changes"*.
- The agent's suggestions in green/red on both surfaces, listed under **Comments → Suggestions** with Accept/Reject.
- The agent's comments with a bot badge; replies from people are readable through `markdoc_comments`.
- Version history entries attributed to *"you via &lt;agent&gt;"*.
