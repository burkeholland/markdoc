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
| `markdoc_list_documents` | Documents you own or that are shared with you. |
| `markdoc_create_document` | New document from Markdown; returns the URL to open in the browser. |
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
| `GET /api/documents` | | List documents. |
| `POST /api/documents` | `{ title?, content? }` | Create. |
| `GET /api/documents/:id/content` | | `{ content, clean, title, pendingSuggestions, openComments }` |
| `PUT /api/documents/:id/content` | `{ content, message? }` | Replace the whole text (minimal live diff; `message` names a version). |
| `PATCH /api/documents/:id/content` | `{ append }` | Append Markdown. |
| `POST /api/documents/:id/suggest` | `{ content }` or `{ edits: [{ find, replace, all? }] }` | Propose word-level tracked changes. |
| `GET /api/documents/:id/suggestions` | | Pending suggestions with ranges and context. |
| `POST /api/documents/:id/suggestions` | `{ action: accept\|reject\|acceptAll\|rejectAll, id? }` | Review suggestions. |
| `GET /api/documents/:id/comments` | | Threads with the text they anchor to. |
| `POST /api/documents/:id/comments` | `{ action: "add", quote \| from,to, body }`, `{ action: "reply", threadId, body }`, `{ action: "resolve", threadId, resolved }` | Comment. |
| `GET /api/mentions` / `POST /api/mentions/:id/read` | | Your unread `@mentions` (with document title); mark one read. |
| `GET /api/documents/:id/versions` / `POST` | `{ title }` | History; name the current state. |
| `GET /api/documents/:id/export` | | Plain Markdown (`?suggestions=1` keeps pending insertions). |
| `POST /api/documents/:id/publish` / `pull` | `{ message? }` | GitHub publish / pull. |
| `POST /api/documents/:id/assets` | multipart `file` field, or a raw image body with `Content-Type: image/png` and `?name=shot.png` | Upload an image (PNG, JPEG, GIF, WebP, SVG; ≤ 5 MB). Returns `{ id, url, name, mime, size, alt }`; put `![alt](url)` in the Markdown. Identical bytes within a document share one asset. |
| `GET /api/assets/:id` | | The image bytes. Requires view access to the owning document (shared links included). |

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
