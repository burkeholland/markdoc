# Agents and Markdoc

Markdoc is built so that people **and** agents can work on the same document. An agent (GitHub Copilot, Claude, a script, a CI job) acts through a personal access token and everything it does is visible live in the editor and attributed: versions say *"Burke via GitHub Copilot CLI"*, and the agent's comments and suggestions carry the token's name with a bot badge.

The recommended pattern is **agent proposes, human decides**: the agent drafts or revises with `suggest`, the humans see tracked changes in both panes and accept or reject them, then everyone keeps editing together.

## Contents

- [1. Connect an agent](#1-connect-an-agent)
- [2. Connect an MCP client](#2-connect-an-mcp-client)
  - [Inside the Copilot app](#inside-the-copilot-app)
  - [MCP tools](#mcp-tools)
  - [What an agent session looks like](#what-an-agent-session-looks-like)
  - [Permissions in Copilot CLI](#permissions-in-copilot-cli)
  - [Requests](#requests)
    - [Working a request, step by step](#working-a-request-step-by-step)
- [3. Or call the REST API directly](#3-or-call-the-rest-api-directly)
  - [Access levels](#access-levels)
  - [Documents](#documents)
  - [Content, suggestions and comments](#content-suggestions-and-comments)
  - [Agent requests](#agent-requests)
  - [Agent presence and watch](#agent-presence-and-watch)
  - [Webhooks](#webhooks)
  - [Versions, activity and export](#versions-activity-and-export)
  - [Images](#images)
  - [Sharing and GitHub](#sharing-and-github)
  - [Account and notifications](#account-and-notifications)
  - [Mentioning people](#mentioning-people)
  - [Formatting and reactions](#formatting-and-reactions)
  - [Notifications](#notifications)
  - [Rate limits](#rate-limits)
- [4. Recipes](#4-recipes)
  - [Review a document](#review-a-document)
  - [Sit in a document](#sit-in-a-document)
- [What people see](#what-people-see)
- [UI conventions](#ui-conventions)

## 1. Connect an agent

**Connect an AI agent** is one short flow with one set of steps, wherever you start it: the people stack in the editor header, **Share → Connect an AI agent**, the command palette, the `/agent` slash command, the hint bar, the `@` picker in a comment, or **Settings** (`/settings#connect`).

1. **Add Markdoc to your agent.** Press **Create access key**. Markdoc makes a key named *AI agent* (rename it under **Change**; that name is what people see on the agent's comments and suggestions) and shows one standard `mcpServers` config with the server URL and `Authorization` header already filled in. It is the same for every MCP client: paste it into your agent's MCP config (or, for clients that add servers through a form, copy the URL and header from **Adding it through a form instead?**), then start a new session in the agent. The screen says it is waiting and looks for the agent's first request every few seconds.
2. **Give the agent the document.** Once the agent has made a request, the steps say *AI agent is connected* and show one sentence to paste into it: *Sit in the Markdoc document "…" (id …): call markdoc_presence active, then loop markdoc_watch …* (see [Sit in a document](#sit-in-a-document)). Opened from Settings, where there is no document, the sentence is *Check Markdoc for requests*.

Later visits skip ahead: when a key that reaches this document has already been used by an agent, the dialog opens on the connected banner and the sentence, with **Connect another agent** and **Manage keys** beside them. A key limited to other documents does not count, so the steps show again.

The default key can **comment and suggest**, works in **all your documents** and **expires in 90 days**. **Change**, next to the button, shows the options: the access level, **Only this document** (in the editor's dialogs), a name and an expiry (30 days, 90 days, 1 year or never). Names must stay distinct by their @mention form (`Copilot CLI` and `copilot-cli` clash): a taken name is refused on the spot, with what you typed left in the field. In the interface an API token is called a *key*; the REST API and the MCP tools still say token.

A key is never wider than you and can be narrower:

| Scope | Shown as | What the key may do |
| --- | --- | --- |
| `read` | Read only | Every `GET` route, `watch` and `presence`. Cannot comment, suggest, write, star, copy or delete. |
| `comment` | Comment & suggest | `read` plus comments, `suggest`, reviews and `requests/*` (claim, complete, cancel). Cannot rewrite, publish, rename, share, copy or delete. The connect steps default to this. |
| `full` | Full access | Everything you can do (the default for `POST /api/tokens` without a `scope`, so scripts keep working). |

A key can be limited to some documents: every other document answers `404` as if it did not exist (direct reads, lists, search, events, requests and notifications), and such a key cannot create, import or copy documents (`403`). The editor's dialogs offer **Only this document**; `POST /api/tokens` takes a `documentIds` list for any number of them. Out-of-scope calls answer `403 { error: "This token is comment-scoped; create a full-access token at /settings to rewrite documents", scope, requiredScope }`; `GET /api/me` and `markdoc_whoami` report `scope` and `documentIds`. Browser sessions are unaffected. Keys cannot create other keys.

**Managing keys.** **Settings** (`/settings#tokens`) lists every key with its name, access level, whether an agent has connected (and when it was last seen) and how many documents it reaches. **Manage** opens the details (last request, last tool call, expiry) and the actions. **Rename** changes metadata and the agent's @mention name, not its secret. **Replace key** asks for confirmation, then atomically creates a new key and revokes the old one with the same scope, document access, collaborator-request setting and expiry; every client using the old key must be updated, and a failed replacement leaves it unchanged. **Revoke** also asks for confirmation. An expired key can only be revoked: make a new one with a new expiry.

Markdoc stores only a hash of the secret. A newly created or replaced secret is shown once, in the command (after a replacement, in a box with its own **Copy**); store it before closing the dialog or leaving Settings. It cannot be recovered or edited later, and the steps never put an existing key in a command. After the agent connects, the command and the key leave the screen.

## 2. Connect an MCP client

Markdoc serves the Model Context Protocol itself at `/api/mcp` (Streamable HTTP). Any MCP client connects with the server URL and a key: nothing to install, no checkout. The steps in section 1 print the exact setup for your agent, using the server you are currently browsing and the key you just made:

| Agent | What you get |
| --- | --- |
| Copilot CLI | `copilot mcp add --transport http --header "Authorization: Bearer <key>" markdoc <origin>/api/mcp`, then a new Copilot session. An optional **Skip permission prompts** block adds a `copilot --allow-tool …` line (see [Permissions in Copilot CLI](#permissions-in-copilot-cli)). |
| VS Code | A `servers` block for your **user** MCP configuration (Command Palette → *MCP: Open User Configuration*), not `.vscode/mcp.json`, so the key stays out of your repository. |
| Claude Code | `claude mcp add --transport http --scope user markdoc <origin>/api/mcp --header "Authorization: Bearer <key>"`. `--header` goes last because it takes several values. |
| Cursor | A `mcpServers` block for `~/.cursor/mcp.json`, then restart Cursor. |
| Copilot app | `MARKDOC_URL` and `MARKDOC_TOKEN` for the environment that launches the app, plus the extension install [below](#inside-the-copilot-app). |
| Other | The generic block below, and a stdio block for clients that cannot speak HTTP. |

The generic block for other Streamable HTTP clients; substitute your key for `MARKDOC_TOKEN` in the Authorization header:

```json
{
  "mcpServers": {
    "markdoc": {
      "type": "http",
      "url": "http://<machine-name>:3000/api/mcp",
      "headers": { "Authorization": "Bearer mdk_…" },
      "tools": ["*"]
    }
  }
}
```

Copilot CLI also reads this same shape from `~/.copilot/mcp-config.json` if you prefer to edit it by hand. Use the stable machine-hostname URL you open Markdoc with so DHCP changes do not invalidate the config; a numeric LAN URL remains useful only as a connection diagnostic. Moving an existing browser from a numeric URL to the hostname is a new origin: sign in once there, and reconnect/save or manually copy any unsynced old-origin edit because cookies, localStorage, and IndexedDB cannot be invisibly migrated. Behind a reverse proxy, set `MARKDOC_URL` to Markdoc's canonical public origin so tool results contain usable links. Token-bearing REST callbacks never use `Host`, `Forwarded` or `X-Forwarded-*`: the custom server pins them to its own listener. A non-custom deployment falls back to `http://127.0.0.1:$PORT`; set `MARKDOC_INTERNAL_URL` to a trusted internal http(s) origin only when that loopback URL cannot reach Markdoc. Both settings must be bare origins such as `https://docs.example.com`; if an older deployment used a URL path prefix, move that routing to the reverse proxy. Paths, credentials, queries, fragments, and non-http(s) schemes make startup or `/api/mcp` fail closed. A plain `GET /api/mcp` (no token) answers `{ name, version, transport, tools, docs, auth }` so a `curl` shows it is alive; without a token every MCP request is a `401` that says where to create one. The transport is stateless (no session ids): `GET` with `Accept: text/event-stream` and `DELETE` answer `405` as the MCP spec prescribes, which Streamable HTTP clients treat as "no standalone stream / nothing to close". When a tool call fails on validation, the tool error text carries the first problem (`… failed (400): Invalid request — content: Too big: …`) so you can tell why.

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

### Inside the Copilot app

Markdoc also ships an experimental [Copilot app canvas extension](../extensions/markdoc/) that keeps the complete editor beside the chat. Install it from a checkout (the extension host provides the SDK, so there is no build or runtime install):

```sh
mkdir -p ~/.copilot/extensions/markdoc
cp -R extensions/markdoc/. ~/.copilot/extensions/markdoc/
```

In PowerShell:

```powershell
$dest = "$HOME\.copilot\extensions\markdoc"
New-Item -ItemType Directory -Force $dest | Out-Null
Copy-Item .\extensions\markdoc\* $dest -Recurse -Force
```

Set `MARKDOC_URL` (the origin you use in a browser, with no path) and `MARKDOC_TOKEN` (a Markdoc token) in the environment that launches Copilot, then start a new app session. Then ask *"Open my document in Markdoc"* or invoke `/markdoc open <document-id>`. The canvas contains both editor panes, formatting, comments (including @-mentioning an agent to make a request), mode, and live presence; dashboard navigation and sharing, publishing, and account menus stay outside the embedded surface.

While a canvas is open, the extension appears in the document as **Copilot app** and long-polls the document event feed. It pushes these human actions into the same chat, once each:

- `request.created`, including the request id, the comment thread it came from, instruction, mode, and selected quote; the prompt points Copilot to `markdoc_claim_request`, an editing tool or a reply into that thread, and `markdoc_complete_request`. A comment that mentions the agent produces `comment.added`, `mention` and `request.created` for the same thread (a reply that does: `mention` and `request.created`); the extension waits briefly for the request and pushes only that one, so one ask is one prompt.
- `mention`, including the mentioned comment or reply id, the thread id, and snippet; the prompt points to `markdoc_comments` and `markdoc_comment`.
- `comment.added`, including the thread id, body, and anchored quote; the prompt points to `markdoc_comments` and `markdoc_comment`.
- `review.created`, including the review id, verdict, and summary; the prompt points to `markdoc_comments`, `markdoc_read_document`, `markdoc_comment`, and `markdoc_suggest`.

The API token never enters the canvas URL or browser. A random local shell requests `POST /api/embed/handoff` with the token, then gives the frame a fresh 60-second, single-use URL bound to that shell's exact origin. Only an iframe navigation from that origin can spend it; a replay, expired URL, top-level navigation, or different parent is refused. The handoff issues a five-minute encrypted `markdoc.embed-session` cookie instead of replacing the user's Auth.js login and redirects to `/d/<id>?embed=1`. The editor renews that cookie before expiry and posts `markdoc:embed-session` (document id, expiry) to the parent origin on each renewal; the first such message is sent once the editor stack has loaded and mounted, not at the frame's first paint, so on a slow device it can arrive several seconds after the server-rendered preview is visible. The shell does not wait for that message; it only uses it to push its own renewal deadline out. If renewal is interrupted, the shell reloads the frame through a fresh one-time handoff without exposing the token. The cookie retains the API token id, document id, and permitted parent origin. Every response carries a matching `frame-ancestors` policy, and every request rechecks that the token is still live and reapplies its `read` / `comment` / `full` scope and document restriction. Revoking the token also stops renewal and new requests from an open embed.

For plain HTTP, the shell uses the same hostname as `MARKDOC_URL` so the browser treats the framed session cookie as same-site; that hostname must resolve to the machine running Copilot. Remote Markdoc deployments must use HTTPS, where the embed cookie is `SameSite=None; Secure; Partitioned` and cross-site mutation requests are rejected. Pushed event fields are marked as untrusted collaborator content, and the dedicated canvas session is restricted to the Markdoc tools needed to read, comment, suggest, rewrite, claim, and complete work; filesystem, shell, browser, GitHub, and other global tools are unavailable to event-driven turns. Current limits: canvases and personal extensions are experimental Copilot features; the graphical canvas requires the Copilot app. Copilot CLI can load the extension with `copilot --experimental`, but does not display the canvas. One Markdoc canvas is active per Copilot session; a second panel is refused so document-scoped cookies cannot collide. Reuse the existing panel with `open_document`, or close it first. The extension pushes only the four event types above (not every keystroke, reply, resolution, or suggestion decision), needs the app process to reach `MARKDOC_URL`, and stops polling and leaves presence as soon as the canvas closes. A named `@user/Agent` mention reaches only a token with a unique active mention name, and a comment containing the mention produces one push rather than a comment turn plus a mention turn. Active turns receive events in queue order; an idle session starts the pushed turn immediately.

### MCP tools

Twenty-seven tools; every `id` is the document id from the URL `/d/<id>`. Write tools end their reply with `Warnings: <codes>` when the change landed but a follow-up record did not (see the REST section's `warnings` convention); the same array is in `structuredContent.warnings`.

| Tool | Arguments | What it does |
| --- | --- | --- |
| `markdoc_whoami` | | Which user and agent identity the token acts as, its scope (`read` / `comment` / `full`), any document restriction, whether other users may address requests to it (`collaboratorsMayAsk`, the owner's per-token switch; off = only the owner can ask it), and the webhooks your events are also pushed to (if any). |
| `markdoc_list_documents` | `starred?`, `trash?` (not both) | Documents you own or that are shared with you, most recently opened first (never-opened ones follow by last edit); each has `starred` and `lastOpenedAt`. `starred: true` for only starred ones, `trash: true` for your own documents in the trash (each with `deletedAt`); both together are refused before any request. |
| `markdoc_search_documents` | `query` (2–200 chars), `limit?` (1–100, default 20) | Find documents by title or body text (case-insensitive; title matches rank first); each hit has a `snippet` around the first content match (`null` when only the title matched). |
| `markdoc_create_document` | `title?`, `content?`, `template?` (one of `content` / `template` is required) | New document from Markdown or from a template id (`blank`, `meeting-notes`, `project-readme`, `design-doc`, `weekly-status`, `blog-post`, `decision-record`, `checklist`; it fills `title` and `content` when they are omitted); returns the id and the URL to open in the browser. |
| `markdoc_import_text` | `content` (≤ 2 MB), `format?: markdown \| text \| html` (default `markdown`), `title?` | New document from a string: Markdown or plain text as-is, HTML converted to GFM Markdown (sanitised). Title from front matter, the first heading or `<title>` unless given. Returns the URL and any `warnings`. |
| `markdoc_list_templates` | | The template ids `markdoc_create_document` accepts, with names and descriptions. |
| `markdoc_duplicate_document` | `id` | "Make a copy": a new document you own, titled *Copy of …*, with the current clean text and images (pending suggestions dropped, comments not copied). Always a Markdoc document, even when the source lives on GitHub. |
| `markdoc_delete_document` | `id`, `permanent?` | Move a document you own to the trash (restorable for 30 days). `permanent: true` deletes it for good (also one already in the trash). |
| `markdoc_restore_document` | `id` | Take a document you own out of the trash. Errors (`409`) when it is not in the trash; nothing changed. |
| `markdoc_read_document` | `id`, `clean?` | Current Markdown (`clean: true` excludes pending suggestions). The header line carries the document's `contentHash` (`# Title (id …, hash …) — N pending suggestion(s), M open comment(s)`) to pass back as `ifContentHash`. |
| `markdoc_replace_content` | `id`, `content`, `message?`, `ifContentHash?` | Replace the whole text, applied live as a minimal diff (collaborators keep their cursors); `message` names a version. With `ifContentHash` (the hash you read) the write is refused — *"Document changed since you read it … re-read and retry"*, with a diff of what moved — when anyone edited the document in between, so a person typing alongside you never loses their words. Always pass it. |
| `markdoc_append` | `id`, `markdown`, `ifContentHash?` | Append Markdown to the end. `ifContentHash` works as for `markdoc_replace_content`: the append is refused with *"Document changed since you read it"* when anyone edited the document after your read, so your paragraph never lands under text that moved. |
| `markdoc_suggest` | `id`, `content` or `edits: [{ find, replace, all? }]` (exactly one of the two; 1–200 edits), `requestId?`, `ifContentHash?` | Propose changes as tracked suggestions, from a full revised text or find → replace edits (each `find` must match exactly once unless `all: true`; `400` otherwise). `content: ""` is allowed and proposes deleting the text; `content` and `edits` together are refused before any request. `requestId` counts them against a request you are working on. `ifContentHash` works as for `markdoc_replace_content`. |
| `markdoc_suggestions` | `id` | List pending suggestions with author and surrounding context. |
| `markdoc_review_suggestions` | `id`, `action: accept \| reject \| acceptAll \| rejectAll`, `suggestionId?` (required for `accept` / `reject`) | Accept or reject (only when asked to). Errors instead of "done" when the id is missing or unknown; `acceptAll` / `rejectAll` with nothing pending is a plain success — *Nothing to decide on … (0 pending)*, `decided: 0` — since the document is already in the asked-for state. |
| `markdoc_comments` | `id` | Read threads, open and resolved, with the text they anchor to, their replies and reactions. |
| `markdoc_comment` | `id`, `action?: add \| reply \| resolve \| reopen \| react` (default `add`), `quote?`, `threadId?`, `replyId?`, `body?`, `emoji?`, `requestId?` | Add a comment on a quote (`quote` and `body`), reply to a thread (`threadId` and `body`), resolve or reopen it (`threadId`), or toggle an emoji reaction (`react` with `threadId` and `emoji`, optionally on a `replyId`). `requestId` (with `add` or `reply`) links the comment to a request you are working on — prefer `reply` into the request's own `threadId`; an `add` linked to a request that came from a comment is folded into that thread as a reply, and the reply then reads *Replied into request thread … (reply …)* instead of *Commented on … (thread …)*. A new comment or reply body may carry one ` ```suggestion ` fenced block (GitHub's syntax) proposing a rewrite of the quoted text; people see the proposed text next to the highlighted passage, with **Accept** / **Reject**, and nothing changes until they accept. |
| `markdoc_review` | `id`, `summary`, `verdict?: approve \| request_changes \| comment` (default `comment`), `comments: [{ quote, body }]` (at least one) | Leave a GitHub-style review: one thread per finding (bodies may carry ` ```suggestion ` blocks) plus a review card at the top of the Comments panel with **Accept all** / **Reject all**. Atomic: one quote that is not found fails the whole call and creates nothing. See [Review a document](#review-a-document). |
| `markdoc_versions` | `id` | Version history. |
| `markdoc_publish` | `id`, `message?`, `force?` | Commit to the linked gist or repository (the document must already be connected in the app). Answers with `status: remote-ahead \| diverged` instead of publishing when GitHub moved since the last sync; `force: true` overwrites. A GitHub file over the 2 MB document bound (`remote-unreadable`) is an error without `force` and is overwritten with it. |
| `markdoc_pull` | `id`, `merge?`, `force?` | Bring the GitHub file into the document. Answers with `status: local-ahead \| diverged` instead of discarding unpublished edits; `merge: true` three-way merges a diverged document (conflicts → `status: "conflict"`, `merged` text with `<<<<<<< local` / `=======` / `>>>>>>> github` markers, `conflicts` count); `force: true` replaces the text regardless (a version is kept). A GitHub file over the 2 MB bound cannot be pulled at all (error, even with `force`). |
| `markdoc_sync_status` | `id` | `in-sync`, `local-ahead` (publish is safe), `remote-ahead` (pull is safe) or `diverged`, with line counts for each side; `remote-unreadable` when the GitHub file is over the 2 MB document bound (nothing to pull or compare — only a force-publish can overwrite it). Always reads GitHub fresh (skips the 30 s cache). |
| `markdoc_list_requests` | `status?: open \| claimed \| done \| cancelled` (default `open`), `limit?` (1–200) | Work humans asked for by @-mentioning an agent in a comment: the requests addressed to **this** agent (`@your-login/your-slug`), plus your own user's unaddressed ones, across every document you own or collaborate on — each with the document, the requester, the selected text, the instruction, the mode, the addressee (`for @login/slug (Name)`), `claimedBy` / `claimedByLogin` and the comment thread to answer in (`threadId`). Requests addressed to another agent are not listed. See [Requests](#requests). |
| `markdoc_claim_request` | `documentId`, `requestId` | Take a request; in the editor your avatar in the people stack gets a spinner badge, the people popover reads *"\<agent> is on it"*, the comment's chip *"\<agent> is working…"*, and the comment gets a 👀 reaction from the agent that stays until the request is completed or cancelled. Only the addressee may claim: any other token gets `403 { code: "not-addressee", agent }` naming who the request is for. Re-claiming one you hold is a no-op; `409` when another agent holds it or it is done / cancelled. |
| `markdoc_complete_request` | `documentId`, `requestId`, `summary?` (≤ 2000 chars) | Mark it done. The reply says what happened: *"The requester has been notified."* only when the `request.done` notification exists (`notified`), *"The requester was not notified (no account to notify / the notification could not be written)."* otherwise, and *"Already completed earlier; notification re-sent if it was missing."* on a retry (`alreadyDone`); `warnings` are listed when present. `structuredContent` is the REST body `{ request, notified, alreadyDone, warnings? }`. The counts come from the `requestId`-linked suggest / comment calls, and the requester's Comments panel opens on your suggestions. Same `403` as claim for a request addressed to someone else. |
| `markdoc_presence` | `id`, `state: active \| idle \| left`, `status?` (≤ 80 chars), `anchor?` (1–2000 chars), `cursor?: { from, to } \| null` | Show up in the document's presence list as a bot avatar with a short status (*reading*, *drafting the summary*). `anchor` (exact text, first occurrence — like a comment's `quote`; `400` when it is not found) or `cursor` (offsets in the clean Markdown from `markdoc_read_document { clean: true }`) places your **caret** there: people see a labelled caret with a bot glyph in both panes, like any collaborator's; `cursor: null` hides it. `suggest`, `comment` and `replace_content` move it to where you acted. Lapses 90 s after the last call or write; `left` removes you at once. |
| `markdoc_watch` | `id?`, `since?`, `wait?` (0–55 s, default 30), `includeSelf?` | Wait for humans: long-poll a document for `content.changed` (with a diff), `comment.added` / `replied` / `resolved`, `suggestion.accepted` / `suggestion.rejected` (a decision on a suggestion block in a comment), `review.created`, `mention` (your user, or you as `@user/Your-Agent` from the picker — then `agent` names you; `refId` is the comment or reply, `threadId` the thread to answer in), `request.created` (`agent` is the `login/slug` it is addressed to, `null` for the requester's own agents) and `activity` (anything else in the feed); or, without `id`, mentions across every document you can open, plus reviews across documents you own or collaborate on and the requests for you there — addressed to this agent, or your own user's unaddressed ones. Every event carries `actor` (`{ name, login, kind: "user" \| "agent", agent, self }`); your own writes are not delivered unless `includeSelf: true` (then marked *(you)*). First call without `since` returns a cursor only. See [Sit in a document](#sit-in-a-document). |

`markdoc_suggest` and `markdoc_comment` (`add` or `reply`) also take an optional `requestId` so the work they produce is counted against the request.

A typical session: *"Let's write the launch plan"* → the agent calls `markdoc_create_document` and gives you the link → you open it, invite teammates, edit and comment → the agent reads `markdoc_comments`, answers with `markdoc_comment`, and revises with `markdoc_suggest` → you accept the good parts in the app.

### What an agent session looks like

The other shape — the agent sits in a document you already have open and reacts when you ask — is four tools in a loop: **presence** (show up), **watch** (wait for people), **suggest** (answer as tracked changes) and **complete** (close the request). Every call below is copy-pasteable against a real document id; `DOC`, `CUR` and `REQ` are the values returned by the previous calls.

```json
{ "tool": "markdoc_presence",  "arguments": { "id": "DOC", "state": "active", "status": "reading", "anchor": "## Rollout plan" } }
{ "tool": "markdoc_watch",     "arguments": { "id": "DOC" } }
{ "tool": "markdoc_presence",  "arguments": { "id": "DOC", "state": "idle", "status": "waiting for feedback" } }
{ "tool": "markdoc_watch",     "arguments": { "id": "DOC", "since": "CUR", "wait": 55 } }
{ "tool": "markdoc_claim_request",    "arguments": { "documentId": "DOC", "requestId": "REQ" } }
{ "tool": "markdoc_presence",  "arguments": { "id": "DOC", "state": "active", "status": "tightening the rollout plan", "anchor": "In order to be able to ship on time we will need to" } }
{ "tool": "markdoc_read_document",    "arguments": { "id": "DOC", "clean": true } }
{ "tool": "markdoc_suggest",   "arguments": { "id": "DOC", "requestId": "REQ", "edits": [{ "find": "In order to be able to ship on time we will need to", "replace": "To ship on time we must" }] } }
{ "tool": "markdoc_complete_request", "arguments": { "documentId": "DOC", "requestId": "REQ", "summary": "Tightened the opening sentence of the rollout plan as one tracked change." } }
{ "tool": "markdoc_presence",  "arguments": { "id": "DOC", "state": "idle", "status": "waiting for feedback" } }
{ "tool": "markdoc_watch",     "arguments": { "id": "DOC", "since": "CUR", "wait": 55 } }
{ "tool": "markdoc_presence",  "arguments": { "id": "DOC", "state": "left" } }
```

Line by line, what the people in the document see: the bot avatar appears in the header's people stack with *reading* and a labelled caret lands on the *Rollout plan* heading (1); the first `watch` returns only a `cursor`, the agent goes *idle* and the avatar dims (2–3); the long-poll blocks until someone acts (4) — here the human selected a sentence and commented *"@you/Copilot-CLI Tighten this"*, and the call returns a `request.created` event with `requestId`, the comment's `threadId`, `mode: "suggest"` and the `quote` (the same comment also produces `comment.added` and `mention` events — the request is the one to act on; a comment or mention without a request would be answered with `markdoc_comment { action: "reply", threadId }`). The agent claims it, so its avatar gets a spinner badge and the chip on the comment reads *"Copilot CLI is working…"* (5), moves its caret onto the sentence and reads the clean text (6–7), proposes the change as a green/red tracked suggestion (8), and completes the request, which turns the chip to *Done*, opens **Comments → Suggestions** and notifies the requester (9). Then it goes idle and waits again with the cursor the last `watch` returned, so nothing is delivered twice (10–11), and `left` removes the avatar the moment the session ends (12). Read-only tools (`watch`, `read_document`) never prompt in Copilot CLI; `presence` and `suggest` are on the cards' `--allow-tool` line, and `claim_request` / `complete_request` are additive too, so `markdoc(markdoc_claim_request),markdoc(markdoc_complete_request)` can be appended to it for a session that works requests — see the next section.

### Permissions in Copilot CLI

Copilot CLI runs MCP tools under its own permission layer: reads are allowed automatically, anything that can change something asks you first — *Allow once*, *Allow for this session*, or *Don't ask again in this directory*, which is saved to `~/.copilot/permissions-config.json` (scoped to the Git root or working directory you started in). That is why a session that only suggests and comments can still prompt several times. Three ways to quieten it, from narrowest to widest (full reference: [Allowing and denying tool use](https://docs.github.com/en/copilot/how-tos/copilot-cli/use-copilot-cli/allowing-tools)):

1. **Pre-allow the safe tools for a session** with `--allow-tool`. Patterns are `<server key>(<tool>)`, comma-separated in one argument, and the server key is the one in your config (`markdoc` in the blocks above). The Share card and the Connect card carry this line with a Copy button:

   ```sh
   copilot --allow-tool 'markdoc(markdoc_suggest),markdoc(markdoc_comment),markdoc(markdoc_presence),markdoc(markdoc_append),markdoc(markdoc_create_document)'
   ```

   `markdoc(markdoc_*)` is not a pattern the CLI understands; `--allow-tool markdoc` (no parentheses) allows every Markdoc tool, including the destructive ones below. Command-line allows last for that session only and are never written to disk.
2. **Answer *Don't ask again in this directory* once per tool** when prompted. The approval lands in `~/.copilot/permissions-config.json`; `/reset-allowed-tools` clears it for the current location.
3. `/allow-all` (or `--allow-all-tools`) allows everything, shell included — not recommended outside a sandbox.

Every Markdoc tool carries the MCP `annotations` clients use to decide whether to ask (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint: false` — the server only talks to Markdoc). `tools/list` returns them; `npm run mcp:smoke` prints them.

| Hint | Tools | Meaning for the client |
| --- | --- | --- |
| `readOnlyHint: true` | `whoami`, `list_documents`, `search_documents`, `list_templates`, `read_document`, `suggestions`, `comments`, `versions`, `sync_status`, `list_requests`, `watch` | Pure reads; a client that honours hints never asks. |
| `destructiveHint: false`, `idempotentHint: false` | `create_document`, `import_text`, `duplicate_document`, `append`, `suggest`, `comment`, `review`, `presence`, `claim_request`, `complete_request`, `restore_document`, `publish`, `pull` | Additive or reversible: a new document, a tracked change the humans review, a comment, a review, a commit. `publish` / `pull` with `force: true` overwrite one side — the tool descriptions tell the model to do that only when asked. |
| `destructiveHint: true` | `replace_content`, `review_suggestions`, `delete_document` | Rewrites text in place (versioned, but live), decides on other people's suggestions, or removes a document. These are meant to stay behind a prompt. |

The server-level instructions tell the model that `markdoc_suggest` is the preferred way to change text and `markdoc_replace_content` is for an explicit "rewrite it in place", so the destructive tool is rarely even attempted.

### Requests

The other direction — a human asks **from the document** and an agent picks it up. The request is a comment that @-mentions an agent:

1. In the editor, select some text (or nothing for the whole document) and press **Comment** (toolbar, selection bubble, `/comment` or the command palette — searching the palette for *agent* or *ask* lands on it). Type `@`, pick the agent from the picker (`@you/Copilot-CLI`), and write the instruction — or pick a chip (*Tighten this*, *Fix grammar and tone*, *Turn into a checklist*). The mention reveals a row under the box that chooses how the agent should answer — **Tracked changes** (default), **Comment only** or **Rewrite directly** (edit access) — then press Enter. The thread card carries the request as a chip: *"Waiting for an agent"*, then *"Copilot CLI is working…"* (*"Burke's Copilot CLI is working…"* when it is someone else's agent), then *"Done: 3 suggestions"*, with × to cancel while it is pending. The people stack in the header tracks it too: a spinner badge on the agent's avatar once one claims it, or — while no agent is in the document — a dashed bot placeholder labelled *"1 request waiting for an agent"*; its popover lists the request under **Requests**.
2. Your agent — GitHub Copilot CLI connected through the MCP server above, by default — calls `markdoc_list_requests` when you ask it to *"Check Markdoc for requests"*. Each request names the document, the requester, the instruction, the mode, the selected text, the agent it is for and the comment thread it came from (`threadId`).
3. It calls `markdoc_claim_request`, reads the document (`markdoc_read_document`), does the work with `markdoc_suggest` / `markdoc_comment { action: "reply", threadId }` (passing the same `requestId`) or `markdoc_replace_content`, and finishes with `markdoc_complete_request { summary }`.
4. Back in the editor the chip and the badge turn to done, a toast says *"Copilot CLI finished: 3 suggestions"*, the Comments panel opens on **Suggestions** and the requester gets a `request.done` notification. The Activity panel shows *asked an agent* and *finished a request* rows.

**A request goes to one agent.** The first `@login/Agent` mention in the comment is the addressee; other agents mentioned in the same comment are only mentioned (they get the `mention` event, not the request). Only that agent — the token of that owner whose name slugs to `Agent` — lists it, claims it, attaches suggestions or comments to it and completes it; any other token gets `403 { code: "not-addressee", agent }` naming who it is for, before anything is written. A request with no agent mention (the *Ask an agent* dialog, or an old client) is for the requester's own agents: every token of theirs sees it and nobody else's. Whoever claims a request is recorded as `claimedBy` (the token name) and `claimedByLogin` (its owner), so two users' agents called *Copilot* stay apart in the chip and the inbox: the editor names someone else's agent with its owner wherever it appears — *Burke's Copilot CLI* in the picker, the chip, the people stack and the finished toast — and your own by its plain name.

**Who may ask your agent.** By default only you can address `@you/Agent`. In the `@` picker, someone else's agent that is not open to you is greyed out with a lock and the reason (*Only Burke can ask this agent*); you can still mention it, but the composer then says *"Burke's Copilot CLI only takes requests from Burke."* and will not send. Should a request reach the server anyway (a stale picker, the owner just switched it off), it answers `403 { code: "agent-owner-only" }` - the comment is still posted, the request is refused, and the editor says so in a toast. The switch is per key, under **Manage** on the key's row in **Settings**: **People I share documents with can ask this agent** (`collaboratorsMayAsk`; `PATCH /api/tokens/:id { collaboratorsMayAsk: true }` for the browser session - tokens cannot flip it). Once on, anyone who can comment on a document you share can address that agent there, the row is an ordinary one for them, and the request lands in its inbox marked as asked by them. `markdoc_whoami` tells the agent which way its switch is set, and the picker's source (`GET /api/documents/:id/collaborators` → `agents[].collaboratorsMayAsk`, `ownerName`) tells the editor. A mention of an agent that does not exist - no live token of that owner has that name - is `400 { code: "unknown-agent" }`. An agent whose owner is not in the document - neither its owner nor a collaborator, whatever the switch says - is `400 { code: "agent-not-in-document", agent: { login, slug } }` with *"Dana's Scribe is not in this document"*: agents only list documents their human is a member of, so nobody would ever see that request.

Requests are scoped: `markdoc_list_requests` only lists documents the token's user owns or collaborates on, and only the requests for that token (see above). Commenters can ask for comments; asking for changes needs edit access. The requester (or the document owner) can cancel from the chip on the thread or from the **Requests** section of the people popover. Nothing runs on the Markdoc server — it only keeps the inbox; the model is whichever agent you connect.

*"Check Markdoc for requests"* is a one-shot pull. To make the document talk back on its own - requests, @mentions and comments reaching the agent within a minute, without a trip to the terminal each time - keep the agent in the watch loop described in [Sit in a document](#sit-in-a-document). The editor hands you the sentence for it: **Connect an AI agent** at the bottom of the people popover (offered while no agent is present), in Share, the command palette entry and the `/agent` slash command all open the connect steps from [section 1](#1-connect-an-agent), which end in a ready-to-paste instruction for this document and a **Copy** button.

Someone without a key sees no agent in the mention picker; its footer says so once per browser, with a **Connect an agent** link that opens the same connect steps in place.

#### Working a request, step by step

The agent side is always the same four moves; only the middle one changes with the request's `mode`.

1. **Find work.** `markdoc_list_requests` with no arguments lists `open` requests (`status` can also be `claimed`, `done` or `cancelled`; `limit` caps the list at 1–200). Each item carries `id`, `documentId`, `documentTitle`, `userName`, `instruction`, `selection` (`{ from, to, quote }`, or `null` for the whole document), `threadId` (the comment the request was made in; `null` for a request created over the API without one), `mode`, `status`, `claimedBy` and `createdAt`. For an interactive session, check when the human asks or poll with `markdoc_watch`; an unattended agent (a GitHub Actions job, a bot) can have the same events pushed to it instead — see [Webhooks](#webhooks). The human's side updates live.
2. **Claim it.** `markdoc_claim_request { documentId, requestId }`. Claiming a request you already hold is a no-op; one that another agent holds, or that was cancelled, answers `409`. Sending `markdoc_suggest` or `markdoc_comment` with the `requestId` claims it implicitly (with a request that is already done or cancelled they answer `409` before writing), but claim first so the chip on the comment and the people stack show your name while you read. Either way, when the request came from a comment, your agent puts a 👀 reaction on that comment the moment it picks it up (so the person sees it was seen), and Markdoc takes the 👀 away again when you complete the request or it is cancelled. You do not need to add or remove it yourself.
3. **Do the work** with the tools you already use, matching the mode the human chose:
   - `suggest` → `markdoc_suggest` with `requestId`.
   - `comment` → `markdoc_comment` (`action: "reply"`, `threadId` from the request) with `requestId`: the answer lands in the conversation the person started. Only a request without a `threadId` calls for `action: "add"` anchored to the selected `quote`.
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

**Comment only (`mode: "comment"`)** — *"Is this claim backed by data?"* in a comment on the quote *"Most users prefer the dark theme"*; the request carries that comment's `threadId`, so the answer is a reply in it:

```json
{ "tool": "markdoc_list_requests", "arguments": {} }
{ "tool": "markdoc_claim_request", "arguments": { "documentId": "DOC", "requestId": "REQ" } }
{ "tool": "markdoc_comment", "arguments": { "id": "DOC", "action": "reply", "threadId": "THREAD", "requestId": "REQ",
  "body": "No source for this in the document. The settings survey in **§3** reports 41 % dark / 59 % light — either cite it or soften to *many users*." } }
{ "tool": "markdoc_complete_request", "arguments": { "documentId": "DOC", "requestId": "REQ",
  "summary": "Left one comment: the preference claim needs a source or softer wording." } }
```

**Rewrite directly (`mode: "rewrite"`)** — *"Turn into a checklist"* with no selection (whole document). The change lands in place for everyone, so only do this when the mode says so; `message` names the version it creates, and `ifContentHash` (the `hash` from the read) makes sure nothing a person typed while you worked is overwritten — on a conflict the tool errors with the diff; re-read and retry:

```json
{ "tool": "markdoc_list_requests", "arguments": {} }
{ "tool": "markdoc_claim_request", "arguments": { "documentId": "DOC", "requestId": "REQ" } }
{ "tool": "markdoc_read_document", "arguments": { "id": "DOC", "clean": true } }
{ "tool": "markdoc_replace_content", "arguments": { "id": "DOC",
  "content": "# Launch checklist\n\n- [ ] Cut the release branch\n- [ ] Run the e2e suite\n- [ ] Publish the changelog\n",
  "message": "Rewritten as a checklist (requested in a comment)",
  "ifContentHash": "<hash from the read_document header>" } }
{ "tool": "markdoc_complete_request", "arguments": { "documentId": "DOC", "requestId": "REQ",
  "summary": "Rewrote the document as a three-item checklist; see version history to compare." } }
```

The same flow over REST is in [Recipes](#4-recipes).

## 3. Or call the REST API directly

All routes accept `Authorization: Bearer mdk_…` (the browser session cookie works too). Bodies are JSON unless noted; errors are `{ error, issues? }` with a 4xx/5xx status (`issues` lists the zod problems of an invalid body or query). Text may not contain `U+0000` (NUL): any string field carrying one is refused up front as `400 { error: "Invalid request", issues: [{ path: ["content"], message: "Text may not contain NUL characters" }] }`, naming the field. A failure inside the server is always `500 { error: "Unexpected error" }` (the detail is in the server log). Every `/api/*` path answers JSON — an unknown path is `404 { error: "Not found" }`, never the HTML page.

A `4xx` means nothing changed. After a `5xx`, re-read (`GET /api/documents/:id/content`, `GET /api/documents/:id/sync`) before retrying — the write may or may not have landed. When a write has landed but a follow-up step failed — a version row, an activity-feed row, a request link, a notification or a mention record — the response is still `2xx` and carries `warnings: string[]` with stable codes: `version-not-saved`, `activity-not-recorded`, `notification-not-sent`, `request-not-attached`, `mentions-not-recorded`. The key is absent when nothing failed. The write is in place: do not repeat it because of a warning. `request-not-attached` means the request did not count the work (it was completed or cancelled meanwhile, or the link could not be saved): check the request before completing it. `notification-not-sent` means the person was not told — tell them yourself. `publish` and `pull` write GitHub (or the live text) before recording the sync base, so a `500` from them can leave both texts equal with a stale base: `GET /api/documents/:id/sync` then answers `in-sync`, and a plain retry (`publish` → `skipped: true`, `pull` → `changed: false`) repairs the record — no `force` needed. `link` to a new gist creates the gist before writing the link, so a `500` there leaves the document unlinked and the gist behind — check your gists before linking again. `POST /api/documents/:id/requests` and `POST …/requests/:rid/complete` write their activity row in the same transaction as the request; `suggest` and `comments` with a `requestId` never move a done or cancelled request back to claimed (`409` before writing, or `request-not-attached` when it closed between the check and the write).

The examples below assume:

```bash
BASE=http://localhost:3000
TOKEN=mdk_…
```

### Access levels

The *Access* column is the minimum role on the document: **view** (owner, any collaborator, or anyone when link access allows it), **comment** (commenter or above), **edit** (editor or owner), **own** (owner only). A token's scope caps the role it gets: `read` acts as a viewer, `comment` as a commenter (`suggest` is the one exception: a comment token may propose suggestions on a document its user can edit), `full` as the user. Documents in the trash answer `404` everywhere except `DELETE ?permanent=1` and `restore`.

### Documents

| Method & path | Body / query | Access | Purpose |
| --- | --- | --- | --- |
| `GET /api/documents` | `?starred=1`, `?trash=1` | signed in | List documents, most recently opened first (never-opened ones follow by last edit); each has `starred` and `lastOpenedAt`. `starred=1` lists only your starred ones; `trash=1` lists your own documents in the trash (each with `deletedAt`). |
| `GET /api/documents?q=text&limit=20` | | signed in | Search titles and content (case-insensitive, 2+ chars): `{ documents: [{ …, snippet }], query }`. |
| `POST /api/documents` | `{ title?, content?, template? }` | signed in | Create (`201`). `title` is at most **200 characters** (the limit for every document title; longer → `400`). `template` is an id from `GET /api/templates`; it fills `title` and `content` when they are omitted (`{{date}}` → today, `{{user}}` → your login). Unknown id → `400`. |
| `GET /api/templates` | | signed in | `{ templates: [{ id, name, description }] }`: `blank`, `meeting-notes`, `project-readme`, `design-doc`, `weekly-status`, `blog-post`, `decision-record`, `checklist`. |
| `GET /api/documents/:id` | | view | `{ document, role }`: title, storage, link access, timestamps and your role. |
| `PATCH /api/documents/:id` | `{ title? }`, `{ linkAccess?: private \| view \| comment \| edit }`, `{ linkPreview?: boolean }` | edit (`linkAccess`, `linkPreview`: own) | Rename, change who a link admits, or choose what a restricted document's link preview shows. A rename renames the document for everyone, including open editors: the title is written to the live document first (so `GET /api/documents/:id/content` and every later store agree at once) and then to the listing, and is recorded once in the activity feed as `title.change` with `detail.title` (`200 { document, warnings? }` - `activity-not-recorded` when that row could not be written; the rename stands). Sending the current title again changes nothing (`200`, no activity row, `updatedAt` untouched); titles are at most 200 characters (longer → `400`). A `linkAccess` change also reaches everyone who is in the document *because of the link* right now (see [Sharing and GitHub](#sharing-and-github)). `linkPreview: true` lets link previews of a *Restricted* document show its title, first lines, the owner's name and when it was last updated (see [Sharing and GitHub](#sharing-and-github)); sending the current value changes nothing. `title`, `linkAccess` and `linkPreview` may be sent together (owner only). |
| `DELETE /api/documents/:id` | `?permanent=1` | own | Move to the **trash**: it vanishes from lists, search and every route (`404`), connected editors are sent back to the dashboard, and it is purged after **30 days**. `permanent=1` deletes immediately (also for documents already in the trash). |
| `POST /api/documents/:id/restore` | | own | Take the document out of the trash. Not in the trash → `409 { error: "Document is not in the trash" }` (nothing changed). |
| `POST /api/documents/:id/duplicate` | | view | Make a copy: `201 { id, title }`. The copy is yours, titled *Copy of …*, holds the current clean text with referenced images copied, is stored in Markdoc (no GitHub link), has no collaborators and one version *Copied from …*. The document, its images and its first version are created in one transaction: a non-2xx status means nothing was created. |
| `GET` / `PUT` / `DELETE /api/documents/:id/star` | | view (`PUT` / `DELETE`: a `read` token gets `403`) | Read, set or clear your star (`{ starred }`). Stars are per user. |

### Content, suggestions and comments

| Method & path | Body | Access | Purpose |
| --- | --- | --- | --- |
| `GET /api/documents/:id/content` | | view | `{ content, clean, title, contentHash, pendingSuggestions, openComments, stats }`. `contentHash` is the SHA-256 of `clean` — send it back with your write as `ifContentHash` (below); `stats` are prose statistics of `clean`: `{ words, characters, charactersNoSpaces, sentences, paragraphs, headings, readingMinutes (200 wpm), speakingMinutes (130 wpm) }` (fenced code and front matter excluded). |
| `PUT /api/documents/:id/content` | `{ content, message?, ifContentHash? }` or header `If-Match: "<contentHash>"` | edit | Replace the whole text (minimal live diff; `message` names a version). With `ifContentHash` / `If-Match`, the write only lands when the clean text still hashes to that value; otherwise **`409 { error: "Document changed since you read it", contentHash, diff, truncated }`** — `contentHash` is the current one, `diff` a unified diff of the clean text since the hash you sent (≤ 200 lines; `null` when that state is no longer cached) — and nothing is applied. Any value that is not the current hash is a mismatch, including a truncated or malformed one (`409`, never `400`), so the re-read-and-retry loop always works; a weak validator (`If-Match: W/"…"`) never matches (RFC 9110), `If-Match: *` is unconditional. Returns `{ ok, changed, contentHash, warnings? }` with the new hash; `warnings: ["version-not-saved"]` when the text changed but the version named by `message` (or the agent auto-version) could not be recorded. |
| `PATCH /api/documents/:id/content` | `{ append, ifContentHash? }` or header `If-Match: "<contentHash>"` | edit | Append Markdown (a blank line is inserted before it when needed). `ifContentHash` / `If-Match` work exactly as for `PUT /content`: `409` with the current `contentHash` and `diff` when the document moved since your read, and nothing is appended. Returns `{ ok, contentHash }` with the new hash. |
| `POST /api/documents/:id/suggest` | `{ content }` or `{ edits: [{ find, replace, all? }] }`, plus `requestId?`, `ifContentHash?` (or `If-Match`) | edit | Propose tracked changes, grouping substantive rewrites by passage while keeping small edits small. `400` when a `find` string is missing from the text or occurs more than once without `all: true`; `409` as for `PUT /content` when `ifContentHash` no longer matches. Returns `{ ok, suggestions, suggestionIds, contentHash, warnings? }`; counts and IDs refer to reviewable groups, not individual red/green runs. With `requestId` the suggestions count against that request (`409 { error: "Request is done" \| "Request is cancelled", status }` before anything is written when it is no longer open; `warnings: ["request-not-attached"]` when it closed between that check and the write — the suggestions stay, the request did not count them). `activity-not-recorded` means the suggestions are in the document and only the feed row is missing. |
| `GET /api/documents/:id/suggestions` | | view | Pending review groups with ranges and context. A replacement has `type: "replace"`, `before` and `after` passages, and one `id` for both runs. New groups include `outdated`, indicating a newer overlapping edit. |
| `POST /api/documents/:id/suggestions` | `{ action: accept \| reject, id }` or `{ action: acceptAll \| rejectAll }` | edit | Review suggestions. `accept` / `reject` decide one suggestion: `400` without `id`, `404` when no pending suggestion has that `id`. Returns `{ ok, decided }` (the number decided; plus `id` for a single decision). May carry `warnings` (`activity-not-recorded`, `notification-not-sent`): the decision stood — a repeat is `404` / `decided: 0` because nothing is left to decide. |
| `GET /api/documents/:id/comments` | | view | `{ comments: [thread] }`: threads with the text they anchor to, a `mentions` array, `reactions` (`{ "👍": [userId, …] }`) and `editedAt` per thread and reply. |
| `POST /api/documents/:id/comments` | `{ action: "add", quote \| from,to \| anchor, body, requestId? }`, `{ action: "reply", threadId, body, requestId? }`, `{ action: "resolve", threadId, resolved }`, `{ action: "edit", threadId, replyId?, body }`, `{ action: "delete", threadId, replyId? }`, `{ action: "react", threadId, replyId?, emoji }`, `{ action: "suggestion", threadId, replyId?, decision: accept \| reject }` | comment | Comment. `quote` must appear in the text (`400` otherwise). `anchor` is what the editor sends, next to `from`/`to`, for a comment composed in the browser: `{ start, end }`, two Yjs relative positions into the document text (`{ item: { client, clock }, assoc }` or `{ tname: "content", assoc }`, nothing else), resolved against the server's copy so that keys on their way do not shift the comment. An anchor that names no range of that copy (another document, a browser ahead of the server, a start after its end) is not guessed at: the `from`/`to` of the same request are used and the answer carries `anchored: false`; `400` when its shape is wrong, or when it names nothing and the request has no `from`/`to`. Agents use `quote` or `from`/`to`, which behave as before. A `reply` to an unknown `threadId` answers `404 { error: "Comment not found" }` and nothing is recorded. `requestId` links the comment to a request you are working: a `done` or `cancelled` request is refused before anything is written (`409 { error, status }`), an unknown one is `404`; an `add` whose request came from a comment is folded into that thread as a reply (`200 { id, threadId, folded: true }`, `id` being the reply) rather than opening a new one, and a linked reply notifies through `request.done` instead of a reply notification. Editing and deleting is limited to your own comments unless you own the document; an accepted or rejected suggestion body is immutable (`409` on edit), though it can still be deleted. `react` toggles your reaction (`{ ok, reacted }`) and notifies nobody. A new comment or reply body may carry one ` ```suggestion ` fenced block proposing a rewrite of the quoted text; `suggestion` decides on the root block, or the exact reply block when `replyId` is present. `accept` (editors only; `409` when the quoted text changed, i.e. the suggestion is outdated) replaces the quote and notifies the author; accepting a root suggestion also resolves the thread. `reject` only records that suggestion's decision. `add`/`reply`/`edit`/`resolve`/`suggestion` may carry `warnings?` (`mentions-not-recorded`, `notification-not-sent`, `request-not-attached`, `activity-not-recorded`) when the comment landed but a follow-up record did not. |
| `POST /api/documents/:id/reviews` | `{ summary, verdict: approve \| request_changes \| comment, comments: [{ quote, body }] }` | comment | A review: one thread per comment (bodies may carry ` ```suggestion ` blocks) and a review card. Atomic: if any `quote` is not found, `400 { error, notFound: [...] }` and nothing is created; if the review card cannot be written, the threads are taken back out before the `500`. Returns `201 { review, warnings? }`; the document owner is notified. A mention, activity row or notification that fails after the review exists is a warning code (`mentions-not-recorded`, `activity-not-recorded`, `notification-not-sent`), omitted when empty. |
| `GET /api/documents/:id/reviews` | | view | `{ reviews: [{ id, documentId, authorId, authorName, collabAuthorId, agent, verdict, summary, threadIds, createdAt }] }`, newest first. |

A paragraph replacement has one Accept/Reject action in both editing panes and in the suggestions list. Separate calls, authors, targets and edits separated by unchanged blocks stay independent. Typing in suggesting mode retains its existing adjacent-edit behavior. Agent replacements that overlap pending suggestions, or targeted edits that revise an earlier replacement in the same batch, return `409` before writing anything; submit overlapping replacements as one edit. A review of an outdated group also returns `409` without changing text (bulk decisions are refused before any are applied). Edits outside its ranges do not make a group outdated. Very large revisions that exceed the bounded block-diff budget return `422`; split them into smaller targeted edits. Existing ungrouped suggestions remain individually reviewable.

### Agent requests

| Method & path | Body / query | Access | Purpose |
| --- | --- | --- | --- |
| `GET /api/agent/requests` | `?status=open` (default; comma-separated list of `open`, `claimed`, `done`, `cancelled`), `?limit=50` (1–200; anything else → `400`) | token only | The agent's inbox: the requests addressed to this token (`agent` = `{ login, slug }` of its owner and mention slug) plus the token owner's own unaddressed ones (`agent: null`), across every document the token's user owns or collaborates on — never a request addressed to another agent. Each has `documentTitle`, `userName`, `instruction`, `selection`, `mode`, `status`, `agent`, `agentName` (this token's name, for addressed rows), `claimedBy`, `claimedByLogin`. |
| `POST /api/documents/:id/requests` | `{ instruction (≤ 2000), selection?: { from, to, quote }, threadId?, mode?: suggest \| comment \| rewrite, agent?: "login/slug" }` | comment (`suggest`/`rewrite`: edit) | Create a request for an agent (`201 { request }`). `agent` (case-insensitive, a leading `@` is fine) names the addressee; when omitted, the first `@login/Agent` mention in the root comment of `threadId` is used; no mention → unaddressed (the requester's own agents). The addressee must be a live token: `400 { error, code: "unknown-agent", agent }` otherwise; one whose owner is not in the document (neither owner nor collaborator) is `400 { error, code: "agent-not-in-document", agent: { login, slug } }` (checked before the owner switch); another user's agent may only be asked when its owner set `collaboratorsMayAsk`, else `403 { error: "<Owner>'s <token> only takes requests from <Owner>", code: "agent-owner-only", agent }`. The editor sends `threadId` — the comment that @-mentioned the agent — and the request then shows as a chip on that thread; an unknown `threadId` is `404 { error: "Comment not found" }`. Records `agent.request` activity in the same transaction as the request. |
| `GET /api/documents/:id/requests` | `?status=open,claimed` (any of `open`, `claimed`, `done`, `cancelled`; anything else → `400`) | view | Requests on this document, newest first, each with `agent` and `claimedByLogin`. |
| `POST /api/documents/:id/requests/:rid/claim` | | comment, addressee only | Take an open request. Only the addressee may: the owner's token whose slug matches, or, for an unaddressed request, one of the requester's own tokens — anyone else is `403 { error: "Request is addressed to @login/slug", code: "not-addressee", agent }` (unaddressed: *"Request can only be worked by \<requester>'s own agents"*, `agent: null`), checked before any status check or write. `409` when another agent has it. Sets `claimedBy` (token name) and `claimedByLogin` (its owner's login). A claim by an agent token (or an implicit claim by a `requestId`-linked suggest/comment) adds a 👀 reaction to the request's comment thread, from reaction user `agent:<login>/<slug>`; `complete` and `cancel` remove it. |
| `POST /api/documents/:id/requests/:rid/complete` | `{ summary?, suggestions?, comments? }` | comment, addressee only | Mark done: `result` gets the counts (from `requestId`-linked suggest/comment calls unless overridden) and `summary`; the status and the `agent.request.done` activity row commit together. Returns `200 { request, notified, alreadyDone, warnings? }`: `notified` is whether the requester holds a `request.done` notification (false when they have no login); `alreadyDone` when the request was done before the call (nothing is written, the notification is attempted again, so a retry after a crash still delivers it); `warnings: ["notification-not-sent"]` when the notification could not be written. `409 { error: "Request was cancelled", status }` for a cancelled request. Same `403` as claim for anyone but the addressee; so does a `requestId` on `POST …/suggest` or `…/comments` (nothing is written). |
| `POST /api/documents/:id/requests/:rid/cancel` | | requester or owner | Withdraw an open or claimed request. |

Request status is also mirrored into the live document (`meta.agentRequests`, with `agent` and `claimedByLogin` on rows written since the addressing change), which is how the editor's people stack updates without polling. Rows created before addressing existed have no addressee and behave as unaddressed: the requester's own tokens work them.

### Agent presence and watch

| Method & path | Body / query | Access | Purpose |
| --- | --- | --- | --- |
| `POST /api/agent/documents/:id/presence` | `{ state: active \| idle \| left, status?, anchor?, cursor?: { from, to } \| null }` | token only (view) | Heartbeat: the agent appears in the header's presence list with a bot avatar and `status` until 90 s after the last heartbeat or write, or until `left`. `anchor` (first occurrence of the text in the clean Markdown; `400` when absent) or `cursor` (clean-text offsets, clamped) places the agent's caret; the response echoes `presence.cursor` as clean offsets. Every write through the API (`content`, `suggest`, `comments`) marks the agent active implicitly and moves the caret to the edit / the quote. |
| `GET /api/agent/documents/:id/presence` | | view | Agents currently present on the document (`name`, `userLogin`, `state`, `status`, `cursor`). |
| `GET /api/agent/documents/:id/events` | `?since=<cursor>&wait=<s ≤ 55>&includeSelf=1?` | token only (view) | Long-poll for the document: `{ cursor, events, documentId, waitMax }`. Without `since` you get the current cursor and no events (a malformed `since` → `400 { error: "Invalid cursor" }`). Events: `content.changed` (`contentHash`, unified `diff` of the clean text against the last state you saw, ≤ 200 lines, `truncated`), `comment.added` / `comment.replied` / `comment.resolved` (`threadId`, `author`, `body`), `mention` (your user was @-mentioned: `by`, `snippet`, `refId` — the comment or reply — and `threadId` — the thread it belongs to, the same as `refId` for a top-level comment, `null` when the thread is gone; `agent` is your token's slug when the mention was `@user/Your-Agent`), `request.created` (`requestId`, `mode`, `instruction`, `quote`, `agent` — the `login/slug` it is addressed to, `null` for the requester's own agents — and `threadId` — the comment the request was made in; a comment or reply that @-mentions an agent yields `mention` and `request.created` for the same thread (plus `comment.added` for a new comment), and the request is the one to act on), `suggestion.accepted` / `suggestion.rejected` (a decision on a ` ```suggestion ` block in a comment: `threadId`, `replyId` when it was in a reply, `by`, `author`, `quote`), `review.created` (`reviewId`, `by`, `verdict`, `summary`, `comments`, `suggestions`, `threadIds`) and `activity` (anything else in the feed). Every event carries `actor: { id, name, login, kind: "user" \| "agent", agent, self }` — `kind` tells a person from another agent, `agent` is that token's name, `self` is true when the polling token caused it. Your own writes (append, replace, suggest, comment, review) are **not delivered** and do not end the wait, so a watch right after your own `PATCH /content` sleeps the full `wait`; pass `includeSelf=1` to see them. Otherwise returns as soon as something happens. A token whose @mention name collides with another active token's is refused with `409` until one is renamed or revoked. |
| `GET /api/agent/events` | `?since=<cursor>&wait=<s ≤ 55>&includeSelf=1?` | token only | The cross-document variant an idle session sits on: `{ cursor, events, agent, waitMax }` (`agent` is your token's name) with `mention` (same fields, `threadId` included) across every document the token's user can open (owned, explicitly shared, or available by link), plus `review.created` across documents they own or collaborate on and, there, the `request.created` events for this token: requests addressed to it (`agent` = its `login/slug`) or asked by its own user without an addressee (`agent: null`) — never one addressed to another agent. Same `actor`, same `400` for a malformed `since` and same `409` for a colliding @mention name, and the same rule: events you caused are skipped unless `includeSelf=1`. |

Agents are published into the document's awareness by the server, so the bot avatar, its status, the "Agent" badge in the presence popover and its caret appear in every open browser without any client-side polling. The caret is sent as the same Yjs relative positions browsers publish, so it follows the text as people edit around it.

### Webhooks

Instead of holding a 55 s long-poll open forever, an unattended agent can have the events pushed to it. **Settings → Advanced: webhooks → Add webhook**: a URL, the events to deliver (`request.created`, `mention`, `comment.added`, `comment.replied`, `review.created`, `suggestion.accepted` / `suggestion.rejected`, `content.changed`) and optionally the documents to watch (default: every document you can see). Only documents you can see may be named; access is checked again before every delivery, so a document whose share was revoked stops arriving. The signing secret is shown once. The list shows the last delivery (`200 · 2 min ago` / `failed ×3`) and **Send test** posts a `test` event. After fixing a receiver that reached the failure limit, use **Enable** on its disabled row to keep the same URL, subscriptions and signing secret while resetting its consecutive failures.

Each delivery is `POST <url>` with the same JSON event `GET /api/agent/documents/:id/events` returns, plus `documentId`, `documentTitle` and `cursor` (the long-poll cursor after this event, so a receiver can fall back to polling from where the pushes left off). Headers: `X-Markdoc-Event` (the type), `X-Markdoc-Delivery` (a UUID, the same across retries), `X-Markdoc-Attempt` and `X-Markdoc-Signature: sha256=<hex HMAC-SHA256 of the raw body with the secret>`. Answer `2xx` within 5 s; anything else is retried after 10 s, 1 min and 10 min, and after 20 consecutive failures the webhook is disabled and you get a `webhook.disabled` notification. Events you caused yourself are delivered too (there is no token to be "self"). Delivery logs are kept for 7 days.

| Method & path | Body / query | Access | Purpose |
| --- | --- | --- | --- |
| `GET /api/webhooks`, `POST /api/webhooks` | `{ url, events: [...], documentIds?: [...] \| null }` | session only | List your webhooks with `active`, `failures` and `lastDelivery { status, at, attempt, event }`; add one (`201`, `secret` returned once). The URL must be http(s) and may not be Markdoc's own origin (`400 A webhook cannot point at Markdoc itself`) — under any spelling: the host you reached Markdoc by, `MARKDOC_URL`, `localhost`, `127.x.x.x`, `[::1]`, `0.0.0.0`, the server's interface addresses and its machine name, on Markdoc's port; other hosts and other ports, localhost included, are fine. A stored hook that turns out to target Markdoc is never delivered and is disabled at once. Every `documentIds` entry must be a document you can see, else `404 { error: "Document not found: <id>" }` (same rule as `POST /api/tokens`); empty or `null` = all. Tokens get `403`, like `/api/tokens`. |
| `DELETE /api/webhooks/:id` | | session only | Remove a webhook. |
| `POST /api/webhooks/:id/enable` | | session only | Re-enable your webhook in place and return `{ webhook }` with `active: true` and `failures: 0`. The signing secret and delivery history do not change and the secret is not returned. The stored URL is checked against Markdoc's current own origins again; a self-target stays disabled and answers `400 { error: "A webhook cannot point at Markdoc itself" }`. Missing and other users' hooks answer `404`; tokens answer `403`. |
| `POST /api/webhooks/:id/test` | | session only | Send a `test` event once (no retries) and return `{ delivery: { deliveryId, status, ok, durationMs, attempt } }`. |

Verifying a delivery in Node:

```js
const expected = "sha256=" + crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
const ok = expected.length === sig.length && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig));
```

### Versions, activity and export

Two version-producing calls on one document at the same time (an agent's `PUT /content` and the collaboration server's auto-version, two agents, publish + restore) do not lose one: the version number is retried once on collision; `PUT /content` still answers `warnings: ["version-not-saved"]` if the second attempt also fails.

| Method & path | Body / query | Access | Purpose |
| --- | --- | --- | --- |
| `GET /api/documents/:id/versions` | | view | `{ versions }`, newest first; `kind` is `auto`, `named`, `publish`, `restore` or `import`. |
| `POST /api/documents/:id/versions` | `{ title }` | edit | Name the current state (`201 { version, warnings? }`; `activity-not-recorded` means the version is saved and only the feed row is missing — do not save it again). |
| `GET /api/documents/:id/versions/:vid` | | view | One version with its full text. |
| `POST /api/documents/:id/versions/:vid` | `{ action: "restore" }` or `{ action: "rename", title }` | edit | Restore (the pre-restore state is kept as a version) or rename (an `auto` version becomes `named`). Restore answers `200 { ok, version, warnings? }`: `version` is the *Restored version n* entry, or `null` with `version-not-saved` when that entry could not be written after the text was already restored; `activity-not-recorded` when the feed row failed. Until the text is replaced every step is fatal: a non-2xx means the text did not change (at most the *Before restore* snapshot was kept). |
| `POST /api/documents/:id/versions/:vid/copy` | | view | Copy that version as a new document you own: `201 { id, title }`, titled *Copy of \<title> (v\<n>)*, same rules as `/duplicate` (images copied, stored in Markdoc, no collaborators, one version *Copied from v\<n>*). The document, its images and its first version are created in one transaction: a non-2xx status means nothing was created. Trashed documents and unknown versions are `404`. |
| `DELETE /api/documents/:id/versions/:vid` | | edit | Delete a version. Unknown version → `404`. |
| `GET /api/documents/:id/activity` | `?before=<iso>&limit=50` (1–200; anything else → `400`) | view | Who did what, when: `{ items: [{ id, actorId, actorName, actorKind: "user" \| "agent", action, detail, createdAt }], nextBefore }`, newest first. `action` is one of `edit`, `comment.add`, `comment.reply`, `comment.resolve`, `comment.suggestion.accepted` / `comment.suggestion.rejected` (a decision on a ` ```suggestion ` block in a comment), `review.create`, `suggestion.add`, `suggestion.accept`, `suggestion.reject`, `version.save`, `version.restore`, `publish`, `share.add`, `share.remove`, `asset.upload`, `title.change`, `agent.request` (someone asked an agent), `agent.request.done` (an agent finished one; `detail` has `requestId`, `mode`, `suggestions`, `comments`, `summary`); `detail` holds small facts (`chars`, `count`, `number`, `title`, `login`, `role`, a ≤120-char `quote`), never document text. Pass `nextBefore` as `before` for the next page. Your own API calls appear under the token's name with `actorKind: "agent"`. |
| `GET /api/documents/:id/export` | `?format=md \| html \| pdf` (default `md`; any other value → `400 { error: "Unknown format", format, formats }`), `?download=1` (attachment; HTML embeds images as `data:` URIs), `?suggestions=1` keeps pending insertions | view | Plain Markdown, a standalone HTML page, or a Letter PDF. Only images uploaded to *this* document are embedded (HTML download and PDF); an `/api/assets/<id>` that belongs to another document stays an absolute URL, so the reader's own access to that document decides whether it loads. Embedding stops at 64 MB of image bytes per export; images past that keep their URL. In a PDF an uploaded image is embedded only when its bytes are PNG, JPEG, GIF, WebP or SVG by the check uploads go through, under the type the bytes are; any other shows as its alt text. PDFs are made one at a time and up to 8 requests wait their turn. The turn goes to the caller that has used the renderer least in the last minutes (a caller is the user, whichever token or session asks; everybody without a session counts as one caller), so a script that exports many large documents does not keep others waiting behind all of them. When all 8 places are taken, a caller that holds at least two places fewer than the caller holding the most takes the newest place of that caller. A request that finds no place, loses its place this way, or has waited 30 s gets `503 { error }` with a `Retry-After` header (seconds; send it again after that): wait for one export's answer before asking for the next and this does not happen to you. A PDF that takes longer than 60 s to make gets `503 { error }` without one. PDF also returns `503 { error }` if Chromium is unavailable on the server. HTML and PDF answer `422 { error: "Document is not renderable", reason: "brackets" \| "emphasis" \| "timeout" }` for text the renderer refuses (more than 1 000 `]` or 2 000 `*`/`_` in one paragraph, or a render past its time budget); the first two are answered at once, also for a PDF, before the request waits for a turn; rendering runs on a worker thread, so it never delays other requests. |

### Images

| Method & path | Body | Access | Purpose |
| --- | --- | --- | --- |
| `POST /api/documents/:id/assets` | multipart `file` field, or a raw image body with `Content-Type: image/png` and `?name=shot.png` | edit | Upload an image (PNG, JPEG, GIF, WebP, SVG; ≤ 5 MB). The stored type comes from the file's own bytes, not from the declared one (multipart: the file part's type; raw body: `Content-Type`): a PNG sent as `image/jpeg` is stored and served as `image/png`, the response's `mime` says so and `name` stays as sent. Bytes that are none of the five types, an SVG sent as another type and another type sent as SVG are `415 { error }` with a message that says what was wrong (`This file was sent as PNG but its content is SVG. …`); SVG must be text with an `<svg>` root (not compressed `.svgz`), and SVG with scripts or event handlers is `400 { error }` under any declared type. Nothing is stored for a refused file. Returns `201 { id, url, name, mime, size, alt, warnings? }`; put `![alt](url)` in the Markdown. Identical bytes within a document share one asset, also when uploaded at the same time. `warnings: ["activity-not-recorded"]` means the asset is stored and only the feed row is missing. |
| `GET /api/assets/:id` | | view (owning document) | The image bytes; shared links included. |

### Sharing and GitHub

| Method & path | Body | Access | Purpose |
| --- | --- | --- | --- |
| `GET /api/documents/:id/collaborators` | | view | `{ owner, collaborators, linkAccess, agents }` — `agents` are the tokens a comment can @-mention here (`{ name, login, ownerLogin, ownerName, present, collaboratorsMayAsk }`; `collaboratorsMayAsk: false` means only `ownerLogin` may address requests to it). |
| `POST /api/documents/:id/collaborators` | `{ login, role: editor \| commenter \| viewer, change?: boolean }` | own | Add a person by GitHub handle: `{ ok, login, role, pending }`. `200` when that person has signed in to Markdoc before; `202` with `pending: true` when nobody with that handle has (the share applies on their first sign-in, so check the spelling). `login` is trimmed and one leading `@` is dropped before it is checked: 1 to 39 letters, digits or hyphens (`@` plus 39 characters is fine), stored in lower case. **An add never changes a role.** For a login that already has access: the same `role` answers `200` / `202` exactly as a first add would and writes nothing (no activity row, no notification); another `role` is `409 { error, code: "already-collaborator", login, role }`, where `role` is the one the person keeps, and nothing changes. To change a role send `change: true` (a real boolean; anything else is a `400`): with `change: true` the call sets the role whether or not the person had access. Until #2252 this route replaced an existing person's role on every call; a caller that relied on that must now send `change: true`. Any token that could call this route before (a full-access token of the owner) gets the same rule. May carry `warnings` (`activity-not-recorded`, `notification-not-sent`): the access change stood (repeating the call writes nothing more); with `notification-not-sent` the person was not told, so tell them yourself. |
| `DELETE /api/documents/:id/collaborators` | `{ login }` | own | Remove a person: `200 { ok: true, warnings? }` (`activity-not-recorded`: the share ended, only the feed row is missing; a repeat is the 404 below by design). Not idempotent: a login that is not currently a collaborator (case and a leading `@` are ignored) is `404 { error: "Collaborator not found" }` and records nothing. |
| `POST /api/documents/:id/link` | `{ storage: "local" }`, `{ storage: "gist", gistId?, filename?, isPublic?, description? }` or `{ storage: "repo", owner, repo, branch, path }` | own | Connect the document to a gist or repository file (or back to Markdoc-only storage): `200 { document, warnings? }`. The existing file becomes the merge base; one over the 2 MB bound is `413` (see below) and nothing is linked. For a new gist the link is written as soon as the gist exists; `200 { document, warnings: ["version-not-saved"] }` when the *Published to new gist* version row could not be saved. |
| `GET /api/documents/:id/sync` | `?fresh=1` (skip the 30 s cache), `?content=1` (include `remoteContent`) | view | Three-way status against the linked file, like a Git client: `{ status: "in-sync" \| "local-ahead" \| "remote-ahead" \| "diverged", remote: { sha, revision, url, updatedAt }, localChanged, remoteChanged, lines: { local, remote }, pollMs }`. The base is the content of the last publish/pull; `remote.sha` is the file blob sha for repositories and the latest history version for gists. The GitHub read is cached for 30 s per document. When the GitHub file is over the 2 MB bound the answer is `413 { error, status: "remote-unreadable", size, limit, remote, pollMs }` (`pollMs` is on the 413 too, so a client keeps polling at the configured rate while the file is over the bound) — never `remote-ahead` with an empty remote. `in-sync` is also the answer when the texts agree but the stored base is behind (a publish or pull that crashed after its GitHub write) — `localChanged`/`remoteChanged` are `false` and `lines` `0/0` then. |
| `POST /api/documents/:id/publish` | `{ message?, force? }` (or `?force=1`) | edit | Commit the clean text to the linked gist or repository file: `{ result: { url, commitSha, publishedAt, skipped, status }, document, warnings? }` (`skipped` when nothing changed; `document` is the updated document). Refuses with `409 { error, status: "remote-ahead" \| "diverged", remote, localChanged, remoteChanged, lines }` when GitHub moved since the last sync — pull or merge first. `force` overwrites anyway (version *Force-published*), including a `remote-unreadable` file (refused with `413` without `force`). `400` when the document is not linked. `warnings` (`version-not-saved`, `activity-not-recorded`) lists bookkeeping that failed after the commit and the base were written. A `skipped` publish also refreshes the stored base when GitHub already has the text. |
| `POST /api/documents/:id/pull` | `?merge=1`, `?force=1` | edit | Bring the GitHub copy into the document: `{ result: { changed, url, status, merged? }, document, warnings? }`. Refuses with `409 { error, status: "local-ahead" \| "diverged", remoteContent, remote, localChanged, remoteChanged, lines }` when unpublished local edits would be lost. `merge=1` three-way merges a diverged document (clean → applied, version *Merged from GitHub*, `status: "local-ahead"` — publish to finish; conflicts → `409 { error, status: "conflict", merged, conflicts, remoteContent, remote, lines }` where `merged` carries `<<<<<<< local` / `=======` / `>>>>>>> github` markers and nothing is applied). `force=1` replaces the text regardless (version *Pulled from GitHub* / *Force-pulled from GitHub*). A `remote-unreadable` file is `413` with or without `force` and the text is left alone. `warnings: ["version-not-saved"]` when the text was replaced and the base recorded but the version row failed. |
| `POST /api/import` | `{ source: "gist", gistId, filename? }` or `{ source: "repo", owner, repo, branch, path }` | signed in | Create a document from a GitHub file, linked for publish/pull (`201 { document }`). The document and its *Imported from GitHub* version are created in one transaction: a non-2xx status means nothing was created. The same 2 MB bound as `/api/import/file` applies: a larger file is `413 { error: "The file on GitHub is <n> MB; Markdoc documents are limited to 2 MB", size, limit }` and nothing is created (GitHub's API inlines only the first 1 MB of a file; between 1 and 2 MB Markdoc reads the raw blob). A gist file GitHub truncated is fetched from its `raw_url` with a 15 s deadline (`408`) and the same cap. |
| `POST /api/import/file` | multipart: one or more `files` (`.md`, `.markdown`, `.mdown`, `.mkd`, `.txt`, `.text`, `.html`, `.htm`; ≤ 2 MB each, ≤ 20) plus optional `images` the Markdown references by relative path; or JSON `{ title?, content, format: markdown \| text \| html }` | signed in | Import local files as new Markdoc documents: `201 { documents: [{ id, title, warnings }], failed: [{ index, name, error }] }` — `documents` are the files that became documents (in file order), `failed` the ones that did not (`index` is the file's position in the request, `error` a short message; `[]` when every file was imported). Each document is created in one transaction — row, assets, rewritten text and its *Imported from \<file>* version — so a file that fails leaves nothing behind and can simply be sent again; when no file could be imported the response is the error itself (`500 { error: "Unexpected error" }` for a server fault) and nothing changed. Title from front matter `title:`, else the first H1, else the file name (or the given `title`), clipped to 200 characters like every document title — the content keeps the full heading; UTF-8 or UTF-16 with a byte-order mark; a file that is not text (a binary renamed `.md`, NUL bytes after decoding) is `415 "<name>" is not a text file` and nothing in the batch is imported; line endings normalised to LF; HTML is sanitised and converted to GFM Markdown. Images whose file name matches a relative `![…](path)` become assets of that document and the path is rewritten to `/api/assets/:id`; unmatched ones are listed in that document's `warnings` (import notes, not the write-warning codes above). |
| `GET /api/github/gists`, `GET /api/github/repos`, `GET /api/github/repos/:owner/:repo/branches`, `GET /api/github/repos/:owner/:repo/files?ref=<branch>` | | signed in | Browse what the signed-in GitHub account can import from. |
| `GET /api/github/users` | `?q=<prefix>` (2–39 login characters; a leading `@` is ignored) | session only | Up to 8 GitHub accounts whose login starts with the prefix, for the Share dialog's handle field: `{ users: [{ login, name, avatarUrl }], limited }`. `limited: true` with an empty list when GitHub's search rate limit is hit — type the full handle and add as usual. Tokens cannot call it (`403`). |

Sharing a document with an audience: `/p/:id` is the read-only **reader view** (clean text, table of contents, reading time, download menu, no editor chrome); it opens for anyone when link access is not *Restricted*, while `/d/:id` is the editor.

Link previews (what Slack, Teams, iMessage and other apps show when someone pastes a `/d/:id` or `/p/:id` link): a document whose link is open shows its title, first lines (160 characters of prose), when it was last updated and a card image with the owner's name, reading time and last update. A *Restricted* document shows the generic Markdoc card unless its owner turns on *Show title and first lines in link previews* in the Share dialog (`PATCH /api/documents/:id { linkPreview: true }`): then anyone with the link sees its title, first lines, the owner's name and when it was last updated (no reading time), while opening the document still needs access. The first lines are read from the page the reader builds (the same parse, conversion to HTML and sanitizing), so they only hold text the reader page shows: front matter, HTML and comments, code, link and image addresses, reference definitions, footnotes and table cells past the header's columns never appear in them, while links keep their text and images their alt text. A document the renderer refuses (see `GET /api/documents/:id/export`) has no first lines in its preview. Unfurlers are sent to sign in like any signed-out visitor, so the sign-in page carries the preview. The card image answers `404` to anyone without access while the switch is off, and a restricted document's card is never cached (`Cache-Control: private, no-store`), so turning the switch off takes effect at once (an app that already unfurled the link may keep its copy).

Access changes are authoritative for live sessions, not just for the next open. Removing or downgrading a collaborator, and changing link access (`PATCH /api/documents/:id { linkAccess }`), re-resolves every affected connection within about a second: edits they sent before the change are stored, later ones are dropped. Closing a link (*Restricted*) disconnects everyone who was in the document through the link — signed-in non-collaborators and anonymous readers alike — with the editor's "access changed" state; downgrading it (*edit* → *view* / *comment*) leaves them connected read-only. The owner and explicit collaborators are never affected by a link change.

### Account and notifications

| Method & path | Body / query | Access | Purpose |
| --- | --- | --- | --- |
| `GET /api/me` | | signed in | Current user, agent name, for a token its `scope` (`read` / `comment` / `full`), `documentIds` (`null` = all), `agentMention: { slug, unique }` (what follows `@user/` in a comment, and whether no other active token of yours shares it — the watch routes answer `409` while it is not unique) and `collaboratorsMayAsk` (whether other users may address requests to this token; `null` for a browser session), and the user's active `webhooks` (`id`, `url`, `events`, `documentIds`; never the secret) so an agent knows events are also pushed somewhere. |
| `GET /api/notifications` | `?unread=1&limit=20&kind=<kind>` (`limit` 1–100, `kind` one of the kinds below; anything else → `400`) | signed in | Your notifications, newest first, with the document title: `{ items: [{ id, kind, documentId, documentTitle, actorLogin, actorName, refId, snippet, agentTargets, createdAt, readAt }], unreadCount }`. `kind` is one of `mention` (`agentTargets` lists the agents of yours the comment addressed as `@you/Agent`; `[]` for a plain mention, `null` on other kinds), `reply` (to a thread you wrote in), `resolve` / `reopen` (of such a thread), `suggestion.accept` / `suggestion.reject` (of your suggestion), `suggestion.accepted` (a ` ```suggestion ` block in a comment of yours was applied; `snippet` is the quote), `review` (someone reviewed a document you own; `refId` is the review, `snippet` its verdict and summary), `share` (a document shared with you), `request.done` (an agent finished a request you made; `actorName` is the agent, `snippet` its summary), `webhook.disabled` (a webhook of yours failed 20 deliveries in a row and was turned off; `snippet` is its URL); `refId` is the thread, reply, suggestion or request id (`<docId>:<login>` for shares). |
| `POST /api/notifications/:id/read` / `POST /api/notifications/read-all` / `POST /api/notifications/thread-read` | `{ documentId, refIds }` for thread-read | signed in (a `read` token gets `403`) | Mark one, all, or everything about the given threads/replies read. |
| `GET /api/mentions` / `POST /api/mentions/:id/read` | | signed in | **Deprecated, removed next release**: alias of `GET /api/notifications?unread=1&kind=mention` (also returns the old `mentions` array) and of `POST /api/notifications/:id/read`. |
| `GET /api/tokens`, `POST /api/tokens` | GET: `?includeRevoked=true` optional; POST: `{ name, expiresInDays?, scope?, documentIds? }` | session only | List your own non-revoked tokens by default; `includeRevoked=true` includes history. Metadata includes scope, document restriction, `collaboratorsMayAsk`, creation/usage/expiry timestamps and `revokedAt`, never the secret or hash. Create returns `201` with the secret once. `scope` is `read`, `comment` or `full` (default `full`); `documentIds` restricts the token to documents you can see (an unknown id → `404`; `null` or omitted = all, an empty list → `400`). A `name` whose @mention slug is already taken by another active token of yours → `409`. Token actors get `403`, so a leaked token cannot enumerate siblings or create credentials. |
| `PATCH /api/tokens/:id` | `{ name?: string, collaboratorsMayAsk?: boolean }` (at least one; no other fields) | session only | Rename a token (trimmed, 1–80 characters; conflicting active @mention name → `409`) and/or set who may address requests to it. `collaboratorsMayAsk: true` lets other users address `@you/<slug>` on shared documents (default `false` = only you). Neither field changes the secret or token permissions. Returns `200 { token }` metadata; a token actor gets `403`, another user's or a revoked token `404`. |
| `POST /api/tokens/:id/replace` | `{ confirm: true }` | session only | Atomically create a replacement and revoke the old token; returns `201 { token }` with the new secret once. Preserves name, scope, document restriction, collaborator-request setting and absolute expiry. An insertion failure rolls back revocation. Missing/false confirmation → `400`, token actor → `403`, another user's or revoked token → `404`, expired token → `409` (create a new token instead). |
| `DELETE /api/tokens/:id` | | session only | Revoke a token. |
| `GET /api/health` | `?probe=live` | public | Full check: `{ ok, db, collab, documentsLoaded, connections, latencyMs, version }` after one database round trip (`503 { ok: false, error }` when the database does not answer). With `?probe=live` the answer is `{ ok: true, probe: "live", collab, version }` and never touches the database — that is what the platform's liveness probe calls. |

### Mentioning people

Agents can get someone's attention by writing `@login` (their GitHub handle) in a comment or reply body, for example `"body": "@burke the numbers in section 2 look stale"`. A mention notifies someone only when they can currently open the document: they own it, are an explicit collaborator, or the document is available by link. Mentions still render as chips in the comments panel and are listed in each thread's `mentions` array from `GET /api/documents/:id/comments`, even when the mentioned login cannot open the document and is not notified. Eligible mentions show up on the mentioned person's dashboard and in the bell in the editor header until they open the thread or dismiss them. E-mail addresses are not treated as mentions.

**Mentioning an agent.** People mention an agent as `@login/Agent-Name` — the token owner's login, a slash, and the token name with spaces turned into dashes (`@burke/Copilot-CLI`). The editor's `@` picker offers every agent present on the document or active in it in the last 30 days, with a bot badge and an *agent* hint under the people, and inserts that form. Because tokens act as their user, the mention is keyed on the owner's login: it reaches the agent through `markdoc_watch` / `GET /api/agent/…/events` as a `mention` event with `agent` set to the slug, and it is listed in `mentions` as the owner's login. When the owner mentions their own agent, the notification is stored already read — the agent gets the event, the owner's bell does not ring. When someone else mentions your agent, you are notified like a normal mention.

### Formatting and reactions

Comment and reply bodies support inline Markdown: `**bold**`, `*italic*`, `` `code` ``, `[text](https://…)` and bare `http(s)://` URLs (which auto-link). Single newlines are line breaks, blank lines start a new paragraph. Headings, lists, images and HTML are not rendered — they stay literal text — and only `http`, `https` and `mailto` links are clickable. The stored `body` is always the raw text you sent.

Reactions are emoji on a thread or a reply: `POST … { action: "react", threadId, replyId?, emoji: "👍" }` toggles yours (send it again to remove it) and answers `{ ok: true, reacted: true | false }`. Reactions appear live as chips in the comments panel (the editor offers 👍 ❤️ 🎉 👀 😄 🚀; any single emoji is accepted, including skin tones, flags and ZWJ sequences — words like `+1` or `:thumbsup:` are `400` with an `issues` entry on `emoji`) and in `reactions` from `GET /api/documents/:id/comments`. When an agent picks up a request made from a comment, Markdoc adds a 👀 from that agent (user id `agent:<login>/<slug>`, separate from its owner's own reactions) to the comment and removes it once the request is completed or cancelled (see [Requests](#requests)). **Reactions never create notifications** — react freely to acknowledge feedback without ringing anyone's bell; reply when you need someone to look.

### Notifications

People are notified — bell in the editor header, strip on the dashboard, `GET /api/notifications` for you — when someone replies to a thread they started or replied in, resolves or re-opens such a thread, accepts or rejects their suggestion, shares a document with them, @mentions them, or when an agent completes a request they made by @-mentioning it in a comment (`request.done`, attributed to the agent by name). Emoji reactions never notify. Whatever you do through the API produces the same notifications for the humans involved (never for the actor). Actions through an agent token count as the token owner's: they notify everyone else involved and never the owner — except `request.done`, which always reaches the requester, even when the agent's token is their own.

### Rate limits

Every `/api/*` route spends one request from a budget, counted **per token** (a looping agent cannot starve the others), per browser session for cookie callers, and per IP for anyone else. A budget is a token bucket: it holds a *burst* of requests and refills at a *sustained* rate.

| Budget | Applies to | Burst | Sustained |
| --- | --- | --- | --- |
| read | `GET`/`HEAD`/`OPTIONS`, and JSON-RPC posts to `/api/mcp` (each tool call is also counted at the REST route it uses) | 60 | 600 / min |
| write | every other method | 30 | 120 / min |
| create | `POST /api/documents`, `POST /api/import`, `POST /api/import/file`, `POST /api/documents/:id/assets`, `POST /api/documents/:id/duplicate` | 20 | 20 / min |
| failed auth | bearer tokens that do not resolve, per IP — the 31st wrong token in a minute (and any token from that IP until one failure refills) is refused before the database is asked | 30 | 30 / min |

Every response carries `X-RateLimit-Limit` (the burst) and `X-RateLimit-Remaining`. Past the budget the answer is `429 { error, retryAfter }` with a `Retry-After` header (whole seconds); nothing was done — wait that long and send the request again. `/api/health` and the collaboration WebSocket are never limited. Operators: `RATE_LIMIT=off` disables the limiter (the e2e dev server and `npm run dev:port` do this by default); `TRUST_PROXY=1` makes the per-IP buckets use the first `X-Forwarded-For` hop instead of the socket address when Markdoc sits behind a reverse proxy.

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

**Work a request over REST.** List the inbox, claim the first request, answer in the mode it asks for — in the comment thread it came from — and complete it. `GET /api/agent/requests` needs a token (a browser session gets `403`).

```bash
REQ=$(curl -s -H "Authorization: Bearer $TOKEN" "$BASE/api/agent/requests" | jq -c '.requests[0]')
ID=$(jq -r .documentId <<<"$REQ"); RID=$(jq -r .id <<<"$REQ"); MODE=$(jq -r .mode <<<"$REQ"); QUOTE=$(jq -r '.selection.quote // empty' <<<"$REQ"); THREAD=$(jq -r '.threadId // empty' <<<"$REQ")
curl -s -H "Authorization: Bearer $TOKEN" -X POST "$BASE/api/documents/$ID/requests/$RID/claim"
case $MODE in
  suggest) curl -s -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -X POST "$BASE/api/documents/$ID/suggest" \
             -d "$(jq -n --arg f "$QUOTE" --arg r "To ship on time we must" --arg rid "$RID" '{edits: [{find: $f, replace: $r}], requestId: $rid}')" ;;
  comment) curl -s -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -X POST "$BASE/api/documents/$ID/comments" \
             -d "$(jq -n --arg t "$THREAD" --arg rid "$RID" '{action: "reply", threadId: $t, body: "No source for this claim — cite the survey or soften it.", requestId: $rid}')" ;;
  rewrite) curl -s -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -X PUT "$BASE/api/documents/$ID/content" \
             -d "$(jq -n --rawfile c rewritten.md '{content: $c, message: "Rewritten (requested in a comment)"}')" ;;
esac
curl -s -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -X POST "$BASE/api/documents/$ID/requests/$RID/complete" \
  -d '{"summary":"Done — see the Suggestions tab."}'
```

### Review a document

One call leaves a GitHub-style review: a verdict, a summary, and one comment per finding. Quote the exact sentence each comment is about and put your rewrite in a ` ```suggestion ` block — the person sees the sentence highlighted in the document and your proposal as plain text in the comment, with **Accept** (applies it, resolves the thread, one undo step) and **Reject**, or **Accept all** on the card at the top of the Comments panel. Nothing is applied until they click.

```text
markdoc_review {
  "id": "<document id>",
  "verdict": "request_changes",
  "summary": "Clear structure; two sentences read awkwardly and one claim needs a date.",
  "comments": [
    { "quote": "Our product is very unique.", "body": "\"Very unique\" is redundant.\n\n```suggestion\nOur product is unique.\n```" },
    { "quote": "We launched recently", "body": "Say when — readers skim for dates.\n\n```suggestion\nWe launched in March 2026\n```" },
    { "quote": "## Pricing", "body": "Consider moving this above Roadmap; most readers come for the price." }
  ]
}
```

Over REST the same body goes to `POST /api/documents/:id/reviews`. Afterwards `markdoc_watch` reports `suggestion.accepted` / `suggestion.rejected` (with the `threadId`, plus `replyId` when a reply carried the suggestion) as the person decides, and `comment.resolved` for each accepted root suggestion.

### Sit in a document

Collaborate live from Copilot CLI: the agent is visible in the header's people stack and reacts when people write.

The shortest way in is from the editor: open the people stack in the header → **Connect an AI agent** (also in Share, the command palette and the `/agent` slash command), follow the steps if you have not connected yet, and paste the sentence it shows into Copilot CLI - *Sit in the Markdoc document "…" (id …): call markdoc_presence active, then loop markdoc_watch with wait 55 and act on comments, mentions and requests until I say stop.* That sentence is the loop below; the bot avatar sits in the people stack while it runs.

1. `markdoc_presence { id, state: "active", status: "reading", anchor: "<the paragraph you are reading>" }` — the bot avatar appears next to the people in the document, with a labelled caret on that text.
2. `markdoc_watch { id }` — the first call returns only a `cursor`.
3. Loop: `markdoc_presence { id, state: "idle", status: "waiting for feedback" }`, then `markdoc_watch { id, since: cursor, wait: 55 }`. When events come back:
   - `comment.added` / `comment.replied` / `mention` → read the thread with `markdoc_comments`, answer with `markdoc_comment { action: "reply", threadId }`. When the comment @-mentioned you, a `request.created` for the same thread follows within a moment — act on that one instead of answering twice.
   - `content.changed` → the `diff` shows what changed; if it needs work, `markdoc_suggest { edits }` (tracked changes) rather than `markdoc_replace_content`.
   - `request.created` → `markdoc_claim_request`, do it in its `threadId` (`markdoc_suggest` / `markdoc_comment { action: "reply", threadId, requestId }`), `markdoc_complete_request`.
   Pass the returned `cursor` into the next call; nothing is delivered twice. Your own actions are not events: after a `markdoc_suggest` or `markdoc_comment`, the next watch keeps waiting for a *person* instead of waking you with your own diff. Each event's `actor` says who did it — `actor.kind` is `"agent"` for another token (`actor.agent` names it; the text line says *(agent)*), and with `includeSelf: true` your own writes come back marked *(you)*.
4. When you are done, `markdoc_presence { id, state: "left" }`.

With no `id`, `markdoc_watch` is the inbox for an idle session: mentions and requests across every document you can see, so you can wait for *"@copilot, can you…"* anywhere. In the editor, typing `@` in a comment offers present and recent agents (*Copilot CLI · agent*); picking one writes `@user/Copilot-CLI`, which reaches you as a `mention` event with `agent: "Copilot-CLI"` — also when the person writing is your own token's owner.

The same loop over REST:

```bash
CUR=$(curl -s -H "Authorization: Bearer $TOKEN" "$BASE/api/agent/documents/$ID/events" | jq -r .cursor)
curl -s -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -X POST "$BASE/api/agent/documents/$ID/presence" -d '{"state":"idle","status":"waiting"}'
while true; do
  RES=$(curl -s -H "Authorization: Bearer $TOKEN" "$BASE/api/agent/documents/$ID/events?since=$CUR&wait=55")
  echo "$RES" | jq -c '.events[]'
  CUR=$(echo "$RES" | jq -r .cursor)
done
```

## What people see

- A bot avatar in the header's people stack while an agent is present, with a spinner badge while it works (a claimed request, or a write in the last 45 s); the popover shows its **Agent** badge, its status (*"drafting the summary"*) and what it just did (*proposed changes · 12 s ago*), lists open requests under **Requests** (*"Copilot CLI is on it"* / *"Waiting for an agent"*, with Cancel for the requester or owner) and, while no agent is present, offers **Connect an AI agent**. Requests with no agent in the document show as a dashed bot placeholder in the stack, labelled *"1 request waiting for an agent"*.
- The agent's caret in both panes — a dashed caret in the agent's colour with a bot glyph and its name, sitting on the text it announced with `anchor` / `cursor` or where it last suggested, commented or edited; it dims when the agent is idle, and clicking the label follows it like a person.
- Agents under the people in the `@` picker of every comment (*Copilot CLI · agent*; someone else's as *Burke's Copilot CLI*, greyed with a lock while its owner keeps it to themself); the posted chip carries a bot badge.
- The agent's suggestions in green/red on both surfaces, listed under **Comments → Suggestions** with Accept/Reject.
- The agent's comments with a bot badge; replies from people are readable through `markdoc_comments`.
- Every action in the document's **Activity** panel under the token's name, marked as an agent.
- Version history entries attributed to *"you via &lt;agent&gt;"*. In the history panel people can tick any two versions to compare them (old → new, with a Swap button, the authors of every version in the range, and `[` / `]` to jump between change hunks; a paragraph that only moved shows once as *moved* rather than red + green), name an auto version inline, restore it, or copy it as a new document.

## UI conventions

- Someone else's agent is shown as *Owner's Agent* (*Burke's Copilot CLI*, *Chris' Scribe*) everywhere it is named — picker, mode row, request chip, people stack and popover, toasts; your own agent as its plain name. The owner's display name, or their login when that is all the client knows (`agentDisplayName` in `src/editor/collab/mentions.ts`).
- Never use a coloured left border or left bar to mark, highlight or select a UI item (a review card, a quoted line, the current entry of a list) — use a soft filled pill, an even border all round, weight or colour of the text instead; the only vertical lines on the left are carets and remote cursors, and Markdown blockquotes inside document content, which are content, not UI.
