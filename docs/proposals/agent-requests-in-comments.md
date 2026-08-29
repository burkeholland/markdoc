# Fold "Ask an agent" into comments

Status: proposal, no code · task #979 · base `1975b962` · 2026-08-29

Burke asked what **Ask an agent** does that a comment would not. Answer: nothing, except mechanics a plain comment lacks: an inbox agents can pull when they are not in the document, a chosen answer mode, a progress pill, a done notification and cancel. This proposal keeps those mechanics and drops the second concept: **@mentioning an agent in a comment is the request.** The mode becomes one small row in the comment composer; the button, bubble entry, palette command, hint, empty-state link and dialog go.

## 1. Inventory

Cross-checked against `git grep -n -i -E "ask.?agent|requestId|list_requests"` (241 hits). Every hit is in a row below or in the exclusion line.

| Kind | Location | Decision |
| --- | --- | --- |
| Entry point: toolbar button | `src/components/editor/toolbar.tsx:92,100,271–284` (`ask-agent-button`) | remove |
| Entry point: selection bubble | `src/components/editor/selection-bubble.tsx:61,70,190–194` | remove |
| Entry point: palette command | `src/components/editor/commands.ts:63–64,254–261` (`doc:ask-agent`) | remove (no alias, see §4) |
| Entry point: Comments empty state | `src/components/editor/comments-panel.tsx:350–351,1119,1316–1323` (`comments-empty-ask-agent*`) | change → "Comment and mention an agent" |
| Entry point: hint bar (b) — missing from the task's count of 4 | `src/components/editor/hint-bar.tsx:27,31,134`, `src/lib/hints.ts:8,11,15,21,63` | change → merge into hint (c) |
| Dialog | `src/components/editor/ask-agent-dialog.tsx` (modes, chips, Connect card, Keep-agent link, Agent docs link) | remove; `QUICK_INSTRUCTIONS`, `AskAgentMode` move to the composer module |
| Shell wiring | `src/components/editor/editor-shell.tsx:57,592–643,814,941–943,961,1023–1024,1119,1191–1200` (`openAskAgent`, `sendAskAgent`, `cancelAgentRequest`, `useAgentRequestsDone`) | change: drop dialog state; keep cancel/done handlers |
| Pill | `src/components/editor/agent-requests-pill.tsx`, `header.tsx:59,456` | keep (thread card reuses `pendingRequests`, `describeResult`) |
| Keep-agent copy | `src/components/editor/keep-agent-here.tsx:17,24,98,231`, `keep-agent-here.test.ts:8` | change wording ("Ask-an-agent requests" → "requests from comments") |
| Client API | `src/lib/api.ts:249–253` (`requests`, `createRequest`, `cancelRequest`) | keep; `createRequest` body gains `threadId?` |
| Route: requests | `src/app/api/documents/[id]/requests/route.ts`, `[rid]/claim`, `[rid]/complete`, `[rid]/cancel`, `src/app/api/agent/requests/route.ts` | keep; create accepts `threadId?` |
| Route: comments | `src/app/api/documents/[id]/comments/route.ts:23–24,174,178–182` | change: `requestId?` also on `reply`; fold rule (§3) |
| Route: suggest | `src/app/api/documents/[id]/suggest/route.ts:29,109–110` | keep |
| Server: requests | `src/server/agent-requests.ts` (`createRequest`, `attachWork`, `completeRequest`, `cancelRequest`, `mirrorRequest`) | change: store `threadId`, stamp `requestId` on the thread map |
| Server: schema | `src/server/db/schema.ts:336–362` (`agent_request`) | change: nullable `thread_id` (migration 0018, additive) |
| Server: events | `src/server/agent-events.ts:45,345–355,506–537`, `src/app/api/agent/events/route.ts:7`, `src/app/api/agent/documents/[id]/events/route.ts` | keep `request.created`; add `threadId` field; reword comment |
| Server: mentions | `src/server/notifications.ts:129–157,405–478` (`recordMentions`, watcher), `src/editor/collab/mentions.ts` | keep (already handles `@user/Agent`) |
| Notification kinds | `mention`, `reply`, `request.done` (`schema.ts:245`, `notifications.ts:173`, `agent-requests.ts:280`) | keep; suppress `reply` for `requestId`-linked replies (§5) |
| Webhook events | `src/server/webhooks.ts:18` (`request.created`, `mention`) | keep |
| MCP tools | `mcp/tools.mjs:21–22,330,408,578–637,699` (`markdoc_list_requests`, `claim`, `complete`, `requestId` on suggest/comment) | keep; descriptions reworded |
| Copilot-app extension | `extensions/markdoc/extension-core.mjs:63,120–131`, `extension.test.mjs:53,174` | change: dedupe `request.created` against its thread |
| Settings | `src/app/settings/page.tsx:9,27,54`, `src/components/settings/agent-connect-card.tsx:252` | keep |
| Smoke script | `scripts/agent-smoke.mts:80–94` | change: create the request from a comment |
| Docs | `README.md:65`; `docs/agents.md:53,103,144,150,173,199–212,218–224,260,316,363,419,483–495,524,535`; `CHANGELOG.md:184` (history, untouched) | change (§3, §4) |
| e2e | `e2e/ask-agent.spec.ts`, `keep-agent-here.spec.ts:94–121`, `copilot-canvas.spec.ts:55,82–83`, `a11y.spec.ts:610–622,1083–1087,1275–1280`, `onboarding.spec.ts:94–128,151,169` | rewrite (§4) |
| e2e unchanged | `e2e/mentions.spec.ts`, `e2e/agent-presence.spec.ts` (mentions only, no dialog) | keep, extend with one request case |
| Unit | `src/components/editor/comments-panel.test.tsx:133,163`, `src/lib/hints.test.ts:32–94`, `src/server/agent-requests.test.ts`, `agent-presence.test.ts:354–407`, `src/app/api/mcp/annotations.test.ts:23` | change / keep |

Excluded as unrelated: `requestIdleCallback` (`markdown-binding.ts`), HTTP "requests" prose (`lan.spec.ts`, `share-autocomplete.spec.ts`, `ssr-preview.spec.ts`, `burke-scale.ts`, `rate-limit.ts`, `proxy.ts`, `export/*`, `http.test.ts`, `mcp/route.ts`), token-scope wording (`tokens/route.ts:27`, `lib/mcp.ts:33`, `token-scope.test.ts`). No unit test exists next to `ask-agent-dialog.tsx`; it is pinned only by e2e.

## 2. Proposed UX

**Composer row.** The comment composer (`Composer` in `comments-panel.tsx`, new-comment and reply variants, not edit) watches its text with `parseAgentMentions`. When the body names an agent the picker knows, a compact row slides in under the textarea:

```text
┌ How should Copilot CLI answer? ─────────────────────────────┐
│ (•) Tracked changes   ( ) Comment only   ( ) Rewrite        │
│ Tighten this · Fix grammar and tone · Turn into a checklist │
└─────────────────────────────────────────────────────────────┘
```

Default *tracked changes*; commenters see only *Comment only* preselected with "Needs edit access" on the others; *Rewrite directly* needs edit access. The chips are the dialog's `QUICK_INSTRUCTIONS`, inserted after the mention. No agent mentioned → no row, nothing changes for ordinary comments.

**Who can be mentioned.** Today's candidates: agents present or active in the last 30 days (`listMentionableAgents`). Add the user's own tokens (`api.tokens.list()`, fetched once when the picker first opens) as `@me/<slug>` entries labelled *your agent · not here yet*, so a never-seen connected agent is reachable.

**Posting.** `ops.add` / `ops.reply` runs as today, then `api.documents.createRequest(doc.id, { instruction, mode, selection, threadId })` with instruction = body minus agent mentions, selection = the thread anchor (`null` for a document comment). The server stores `threadId`, stamps `requestId` on the thread's Y.Map and mirrors — so the thread card shows a chip *Waiting for an agent* → *Copilot CLI is working…* → *Done: 2 suggestions*, with × for requester/owner. Pill, `request.done` toast, Comments-opens-on-Suggestions and cancel are unchanged. The "Sent to agents" toast goes; the chip is the confirmation.

**Replies.** A reply that mentions an agent shows the same row (default = the thread's last mode) and creates a new request on the same thread; the card shows the latest. No "extend" API: agents read the whole thread with `markdoc_comments`.

**Whole document.** There is no anchor-less comment today (`startComment` toasts "Select some text"; the API accepts `from = to`). Add a *document comment*: a thread anchored at `{ from: 0, to: 0 }`, card header *Whole document* instead of a quote bar, no editor highlight, reached from the empty state and a "Comment on the document" item in the panel's ⋯ menu. Its request has `selection: null`, like today's whole-document ask.

**Empty state** becomes: *Agents can review this document too — Comment and mention an agent*, opening the document composer with `@` pre-typed (`Composer initial="@"`, the picker opens on focus).

**Connect an agent.** When the user has no token and types `@`, the picker's footer shows one line: *No agent connected yet — Connect an agent · Agent docs* (`onCreateToken`, `AGENT_DOCS_URL`, dismiss remembered under `AGENT_CONNECT_DISMISSED_KEY`). The full card stays in Settings → Agents and the Share dialog.

**Before / after, in Burke's words.** Before: I select a sentence, click *Ask an agent*, a dialog appears, I type or pick *Tighten this*, glance at three radio buttons, click Send, get a toast, later a second toast, and the answer lands somewhere in Comments. After: I select the sentence, press Comment, type `@cop`, pick *Copilot CLI*, type *tighten this*, Enter. The card says *Waiting for an agent*, then *Copilot CLI is working…*, then the tracked change appears under it. If I only want a comment back, I flip one option before sending. One place, one conversation.

## 3. What agents see

No tool or route is added or removed. In `markdoc_list_requests` / `GET /api/agent/requests` these fields stay identical: `id`, `documentId`, `documentTitle`, `userName`, `userLogin`, `instruction` (comment body, agent mentions stripped), `selection` (`{ from, to, quote }` = thread anchor, or `null`), `mode`, `status`, `claimedBy`, `result`, `createdAt`. `claim`, `complete`, `cancel`, `requestId` on `markdoc_suggest` / `markdoc_comment add`, `request.created` and `request.done` keep their shapes. The step-by-step recipe in docs/agents.md keeps working unchanged.

Additive, optional: `threadId` on request items and on `request.created`; `requestId?` on comment `reply`, counted by `attachWork` like `add`. Fold rule for legacy agents: `add` + `requestId` whose request has a `threadId` is stored as a reply on that thread (`quote` ignored, `{ id }` is the reply id), so "comment only" answers land in the human's thread instead of a twin thread on the same quote. The lead should confirm this rule (§5).

Docs to reword: `docs/agents.md:144` (tool table), `:173` (session narrative "pressed Ask an agent"), `:199–212` (Requests intro, Keep-agent link location, Connect card), `:222` (comment mode → `reply` with `threadId`), `:260,:495` (version message), `:316` (`threadId?`), `:330–331` (event fields), `:419` (notification sentence), `:483` (recipe title), `:524,:535` (Sit in a document), `:53,:103` (Connect/canvas mentions); `README.md:65`; `mcp/tools.mjs` descriptions; `extension-core.mjs:122` prompt text.

## 4. Removal list

| Item | Where | Action |
| --- | --- | --- |
| Toolbar button, bubble button, hint-bar action | `toolbar.tsx`, `selection-bubble.tsx`, `hint-bar.tsx` + `hints.ts` | delete; `onAskAgent` props gone |
| Palette `doc:ask-agent` | `commands.ts:254–261` | delete. No alias: an alias keeps the second noun alive, which is Burke's objection; instead add `agent`, `ask`, `copilot`, `ai` to the existing *Comment* command's keywords so "ask an agent" still lands on Comment |
| Dialog | `ask-agent-dialog.tsx` | delete (Keep-agent link remains in the header pill and palette) |
| Empty-state link | `comments-panel.tsx:1316–1323` | replace (§2) |
| Shell state | `editor-shell.tsx` `askAgent`, `openAskAgent`, `sendAskAgent`, `onAskAgentOpenChange`, `askAgentDoc`, `<AskAgentDialog>` | delete |
| README line 65, doc sections in §3 | | rewrite |
| `e2e/ask-agent.spec.ts` | | rewrite as `e2e/agent-requests.spec.ts` (comment → request → claim → suggest → complete; cancel from card; connect row) |
| `e2e/keep-agent-here.spec.ts:94–121` | | drop the dialog-footer test; `palette-item-doc:ask-agent` assertion → `doc:keep-agent` only |
| `e2e/copilot-canvas.spec.ts:55,82–83`, `e2e/a11y.spec.ts:610–622,1083–1087,1275–1280`, `e2e/onboarding.spec.ts:94–128,151,169` | | retarget to the composer row / toolbar `End` = `tb-comment` / hint (c) |
| `comments-panel.test.tsx:133,163`, `hints.test.ts` | | retarget `onAskAgent` → new empty-state button; drop `ask-agent` hint id |

## 5. Risks / open questions

- **Commenter asks for edits.** The row never offers edit modes without `canEdit`; the server still enforces `modeAllowed` (403). Card hint: *Copilot will answer with a comment; edits need edit access* — a ` ```suggestion ` block in its reply is the natural answer.
- **Several agents mentioned.** One request per post; every mentioned agent gets its `mention`; the first `claim` wins, as today.
- **Mention without a connected agent.** The row appears only for picker-known agents. A freehand `@x/y` that matches nothing posts a plain comment with the inline hint *no connected agent named y*.
- **Duplicate signals to agents.** One post now yields `comment.added`, `mention` and `request.created`. The extension already keys `mention` and `comment.added` to one conversation; `request.created` must map to the same key via `threadId`. Watch-loop docs: when both arrive for one thread, claim the request, skip the ad-hoc reply.
- **Duplicate signals to humans.** The agent's reply notifies the thread starter (`reply`) and completion notifies the requester (`request.done`). Suppress `notifyReply` for replies posted with `requestId`.
- **Fold rule (§3)** changes what `add` returns for legacy agents (reply id). Alternative: leave `add` alone and accept twin threads.
- **Document comments** are new shared-doc data (zero-width anchor). Check `resolveAnchor`, decorations, `revealComment` and `GET /comments` `range` for `from = to = 0`.
- **a11y.** The row is a `radiogroup` labelled *How should Copilot CLI answer?*, after the textarea in tab order, never steals focus, announced through the existing `aria-live` hint line; an axe scan "editor + composer with mode row" replaces the dialog scan.
- **Migration 0018** (nullable `thread_id`) is additive; old and new code run against it.

## 6. Implementation plan

No runtime flag (the repo has none): T1–T3 ship beside the dialog, T4 removes it. Rollback: revert T4, then T3–T1; the migration needs no undo.

| Task | Scope (≤ 4 h) | Files | Tests |
| --- | --- | --- | --- |
| **T1 Server: a request knows its thread** | Migration 0018; `createRequest` takes `threadId`, stamps `requestId` on the thread map, mirrors; `reply` + `requestId` → `attachWork`; fold rule; `request.created.threadId`; `notifyReply` suppression; client DTO types | `schema.ts`, `drizzle/0018_*.sql`, `agent-requests.ts`, `requests/route.ts`, `comments/route.ts`, `agent-events.ts`, `notifications.ts`, `lib/api.ts` | `agent-requests.test.ts` (+threadId, fold, reply count), `notifications.test.ts`, `agent-presence.test.ts:407` |
| **T2 Composer: mention = request** | Mode row + chips + own-token candidates; `createRequest` after add/reply with the stripped instruction; thread-card chip (waiting / working / done) with cancel; drop the "Sent to agents" toast | `comments-panel.tsx`, `comments.css`, `editor-shell.tsx` (cancel handler passed down) | `comments-panel.test.tsx` (row only on agent mention; commenter sees comment-only; chip states from a mirrored request) |
| **T3 Document comment, empty state, connect row, hint** | Zero-width anchor thread, *Whole document* header, ⋯ menu item, empty-state link with `@` pre-typed, picker footer row, hint (b)→(c) merge | `comments-panel.tsx`, `comments.ts` (guard), `editor-shell.tsx` (`startDocumentComment`), `hints.ts`, `hint-bar.tsx` | `comments.test.ts`, `hints.test.ts`, `comments-panel.test.tsx:163` |
| **T4 Remove old entry points, docs, e2e** | Delete dialog, toolbar/bubble/palette/hint entries, shell state; keywords on *Comment*; reword `keep-agent-here.tsx`, `mcp/tools.mjs`, `extension-core.mjs` (+dedupe key), `agent-smoke.mts`, docs/agents.md, README; `agent-requests.spec.ts` (3 tests), retarget `keep-agent-here`, `copilot-canvas`, `a11y`, `onboarding`, one request case in `mentions.spec.ts` | listed in §4 | `extension.test.mjs`, `keep-agent-here.test.ts`, `annotations.test.ts`, `npm run lint`, full e2e once (browser slot permitting) |

Order: T1 → T2 → T3 → T4; T3's document-comment half needs no server change and can start alongside T1.

## 7. Measured assertions

| Assertion | Expected |
| --- | --- |
| Entry points removed (toolbar, bubble, palette, empty-state, hint-bar action) | 5 → 0 after T4 (the task's count of 4 misses the hint bar); 0 aliases |
| Dialog files deleted | 1 (`ask-agent-dialog.tsx`; no unit test beside it) |
| e2e specs rewritten or retargeted | 5 (`ask-agent` → `agent-requests`, `keep-agent-here`, `copilot-canvas`, `a11y`, `onboarding`); 2 untouched (`mentions`, `agent-presence`) |
| MCP tools / REST routes added or removed; breaking field changes | 0 / 0; additive optional fields: 3 (`threadId` on requests and `request.created`, `requestId?` on `reply`) |
| Steps from selection to a sent request | 4 → 3 by the task's convention (select → Ask an agent → instruction → mode fieldset → Send, vs select → Comment → `@agent` + text → Enter; the row is preselected and hidden until a mention) |
| `git grep -c -E "ask-agent\|askAgent\|AskAgent" src e2e` after T4 | 0 |
