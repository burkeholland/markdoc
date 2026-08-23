#!/usr/bin/env node
// Markdoc MCP server: lets agents (GitHub Copilot, Claude, Cursor, …) create, read, revise,
// comment on and review Markdoc documents through the Model Context Protocol.
//
//   MARKDOC_URL=https://your-markdoc.example.com MARKDOC_TOKEN=mdk_... node mcp/server.mjs
//
// Create a token at <MARKDOC_URL>/settings. Everything the agent does is attributed to
// "<you> via <token name>", and suggestions/comments carry the token name as the author.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const baseUrl = (process.env.MARKDOC_URL ?? "http://localhost:3000").replace(/\/$/, "");
const token = process.env.MARKDOC_TOKEN;
if (!token) {
  console.error("MARKDOC_TOKEN is not set. Create a token at " + baseUrl + "/settings");
  process.exit(1);
}

async function api(method, path, body) {
  const res = await fetch(baseUrl + path, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json, text/markdown" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    let message = text;
    let body = null;
    try {
      body = JSON.parse(text);
      message = body.error ?? text;
    } catch {
      /* plain text */
    }
    // Sync refusals (409 with a `status`) are answers, not failures: let publish/pull surface them.
    if (res.status === 409 && body?.status) throw Object.assign(new Error(message), { sync: body });
    throw new Error(`${method} ${path} failed (${res.status}): ${message}`);
  }
  if (res.headers.get("content-type")?.includes("application/json")) return JSON.parse(text);
  return text;
}

const docUrl = (id) => `${baseUrl}/d/${id}`;
const ok = (text, structured) => ({ content: [{ type: "text", text }], ...(structured ? { structuredContent: structured } : {}) });

const server = new McpServer({ name: "markdoc", version: "0.1.0" }, {
  instructions: [
    "Markdoc is a collaborative Markdown editor (Google Docs for Markdown).",
    "Use markdoc_create_document to start a document people can open in their browser and edit with you in real time;",
    "always give the user the returned URL.",
    "Prefer markdoc_suggest over markdoc_replace_content when revising someone else's text: suggestions show up as tracked",
    "changes the humans accept or reject. Use markdoc_comments to read feedback left for you and markdoc_comment to reply.",
    "When the user asks you to check Markdoc for requests (or says an agent was asked for something in a document), call markdoc_list_requests,",
    "claim a request, do what its instruction says with the requestId, and call markdoc_complete_request with a one-line summary.",
  ].join(" "),
});

server.registerTool(
  "markdoc_whoami",
  { title: "Who am I", description: "Show which user and agent identity this token acts as.", inputSchema: {} },
  async () => {
    const me = await api("GET", "/api/me");
    return ok(`Acting as ${me.user.name ?? me.user.login} (${me.user.login ?? me.user.id}) via agent "${me.agent}". Server: ${baseUrl}`, me);
  },
);

server.registerTool(
  "markdoc_list_documents",
  {
    title: "List documents",
    description:
      "List the documents the user owns or that are shared with them (id, title, storage, last edit, starred, lastOpenedAt). Most recently opened first; never-opened documents follow by last edit.",
    inputSchema: { starred: z.boolean().optional().describe("Only documents the user has starred"), trash: z.boolean().optional().describe("List the user's own documents in the trash instead (each has deletedAt)") },
  },
  async ({ starred, trash }) => {
    const { documents } = await api("GET", `/api/documents${trash ? "?trash=1" : starred ? "?starred=1" : ""}`);
    const lines = documents.map(
      (d) =>
        `- ${d.starred ? "★ " : ""}${d.title} — id ${d.id} — ${d.storage}${d.repoName ? ` ${d.repoOwner}/${d.repoName}:${d.repoPath}` : ""} — edited ${d.updatedAt}${d.lastOpenedAt ? ` — opened ${d.lastOpenedAt}` : ""}${d.deletedAt ? ` — trashed ${d.deletedAt}` : ""} — ${docUrl(d.id)}`,
    );
    return ok(lines.length ? lines.join("\n") : trash ? "The trash is empty." : starred ? "No starred documents." : "No documents yet.", { documents });
  },
);

server.registerTool(
  "markdoc_search_documents",
  {
    title: "Search documents",
    description: "Search the user's documents by title or body text (case-insensitive). Returns matching documents with a short snippet around the first content match.",
    inputSchema: { query: z.string().min(2).max(200).describe("Text to look for in titles and content"), limit: z.number().int().min(1).max(100).optional().describe("Max results (default 20)") },
  },
  async ({ query, limit }) => {
    const { documents } = await api("GET", `/api/documents?q=${encodeURIComponent(query)}${limit ? `&limit=${limit}` : ""}`);
    const lines = documents.map((d) => `- ${d.title} — id ${d.id} — edited ${d.updatedAt} — ${docUrl(d.id)}${d.snippet ? `\n    ${d.snippet}` : ""}`);
    return ok(lines.length ? lines.join("\n") : `No documents match "${query}".`, { query, documents });
  },
);

server.registerTool(
  "markdoc_create_document",
  {
    title: "Create document",
    description:
      "Create a new Markdoc document from Markdown, or from a template (ids: blank, meeting-notes, project-readme, design-doc, weekly-status, blog-post, decision-record, checklist; see GET /api/templates). Returns the id and the URL to open it in the browser, where others can collaborate in real time.",
    inputSchema: {
      title: z.string().optional().describe("Title; defaults to the first heading"),
      content: z.string().optional().describe("Markdown content (omit when using `template`)"),
      template: z.string().optional().describe("Template id; fills title and content when `content` is omitted"),
    },
  },
  async ({ title, content, template }) => {
    if (content === undefined && !template) throw new Error("Provide `content` or `template`.");
    const { document } = await api("POST", "/api/documents", { title, content, template });
    return ok(`Created "${document.title}" (id ${document.id}). Open it: ${docUrl(document.id)}`, { id: document.id, title: document.title, url: docUrl(document.id) });
  },
);

server.registerTool(
  "markdoc_import_text",
  {
    title: "Import text",
    description:
      "Create a new document from a string in a given format: Markdown as-is, plain text as-is, or HTML converted to GFM Markdown (sanitised; headings, lists, tables, links, images, code, strikethrough). Title defaults to the front-matter title, first heading or <title>. Returns the id, warnings and the URL.",
    inputSchema: {
      title: z.string().optional().describe("Title; defaults to the front-matter title, the first heading or the HTML <title>"),
      content: z.string().describe("The text to import (≤ 2 MB)"),
      format: z.enum(["markdown", "text", "html"]).default("markdown").describe("How to read `content`"),
    },
  },
  async ({ title, content, format }) => {
    const { documents } = await api("POST", "/api/import/file", { title, content, format });
    const [document] = documents;
    const warn = document.warnings.length ? ` Warnings: ${document.warnings.join("; ")}` : "";
    return ok(`Imported "${document.title}" (id ${document.id}). Open it: ${docUrl(document.id)}${warn}`, { ...document, url: docUrl(document.id) });
  },
);

server.registerTool(
  "markdoc_list_templates",
  { title: "List templates", description: "List the document templates markdoc_create_document accepts (id, name, description).", inputSchema: {} },
  async () => {
    const { templates } = await api("GET", "/api/templates");
    return ok(templates.map((t) => `- ${t.id}: ${t.name} — ${t.description}`).join("\n"), { templates });
  },
);

server.registerTool(
  "markdoc_read_document",
  {
    title: "Read document",
    description: "Read a document's current Markdown. `clean` excludes text that is still a pending suggestion.",
    inputSchema: { id: z.string().describe("Document id (from the URL /d/<id>)"), clean: z.boolean().optional().describe("Return the text without pending suggestions (default false)") },
  },
  async ({ id, clean }) => {
    const data = await api("GET", `/api/documents/${id}/content`);
    const text = clean ? data.clean : data.content;
    const header = `# ${data.title || "Untitled"} (id ${id}) — ${data.pendingSuggestions} pending suggestion(s), ${data.openComments} open comment(s)\n\n`;
    return ok(header + text, { id, title: data.title, content: text, pendingSuggestions: data.pendingSuggestions, openComments: data.openComments, url: docUrl(id) });
  },
);

server.registerTool(
  "markdoc_replace_content",
  {
    title: "Replace content",
    description: "Replace the whole document with new Markdown. Applied live as a minimal edit (collaborators keep their cursors). Use for your own drafts; use markdoc_suggest for other people's text.",
    inputSchema: { id: z.string(), content: z.string().describe("The complete new Markdown"), message: z.string().optional().describe("Short description saved in version history") },
  },
  async ({ id, content, message }) => {
    const res = await api("PUT", `/api/documents/${id}/content`, { content, message });
    return ok(res.changed ? `Document ${id} updated. ${docUrl(id)}` : `Document ${id} already had that content.`, { ...res, url: docUrl(id) });
  },
);

server.registerTool(
  "markdoc_append",
  { title: "Append", description: "Append Markdown to the end of a document.", inputSchema: { id: z.string(), markdown: z.string() } },
  async ({ id, markdown }) => {
    await api("PATCH", `/api/documents/${id}/content`, { append: markdown });
    return ok(`Appended to ${id}. ${docUrl(id)}`);
  },
);

server.registerTool(
  "markdoc_suggest",
  {
    title: "Suggest changes",
    description:
      "Propose changes as tracked suggestions (green insertions, struck deletions) that the humans accept or reject in the app. Provide either the full revised `content`, or a list of `edits` (find → replace; each `find` must match exactly once unless `all` is true).",
    inputSchema: {
      id: z.string(),
      content: z.string().optional().describe("Full revised Markdown"),
      edits: z.array(z.object({ find: z.string(), replace: z.string(), all: z.boolean().optional() })).optional(),
      requestId: z.string().optional().describe("Link to an \"Ask an agent\" request you are working on (from markdoc_list_requests)"),
    },
  },
  async ({ id, content, edits, requestId }) => {
    if (!content && !edits?.length) throw new Error("Provide `content` or `edits`.");
    const res = await api("POST", `/api/documents/${id}/suggest`, { ...(content !== undefined ? { content } : { edits }), ...(requestId ? { requestId } : {}) });
    return ok(`Proposed ${res.suggestions} change(s) on ${id}. Reviewers can accept or reject them at ${docUrl(id)}`, { ...res, url: docUrl(id) });
  },
);

server.registerTool(
  "markdoc_suggestions",
  { title: "List suggestions", description: "List pending suggestions (tracked changes) on a document with author and surrounding context.", inputSchema: { id: z.string() } },
  async ({ id }) => {
    const { suggestions } = await api("GET", `/api/documents/${id}/suggestions`);
    const lines = suggestions.map((s) => `- [${s.id}] ${s.type} by ${s.author}: ${JSON.stringify(s.text)} — context: ${JSON.stringify(s.context)}`);
    return ok(lines.length ? lines.join("\n") : "No pending suggestions.", { suggestions });
  },
);

server.registerTool(
  "markdoc_review_suggestions",
  {
    title: "Accept or reject suggestions",
    description: "Accept or reject a suggestion by id, or all of them. Only do this when the user asked you to.",
    inputSchema: { id: z.string(), action: z.enum(["accept", "reject", "acceptAll", "rejectAll"]), suggestionId: z.string().optional() },
  },
  async ({ id, action, suggestionId }) => {
    await api("POST", `/api/documents/${id}/suggestions`, { action, id: suggestionId });
    return ok(`${action} done on ${id}.`);
  },
);

server.registerTool(
  "markdoc_comments",
  { title: "List comments", description: "Read the comment threads on a document (open and resolved), with the text each one is anchored to.", inputSchema: { id: z.string() } },
  async ({ id }) => {
    const { comments } = await api("GET", `/api/documents/${id}/comments`);
    const reactions = (r) => (r && Object.keys(r).length ? " " + Object.entries(r).map(([e, ids]) => `${e}${ids.length}`).join(" ") : "");
    const lines = comments.map((t) => {
      const replies = t.replies.map((r) => `\n    ↳ [${r.id}] ${r.author}: ${r.body}${reactions(r.reactions)}`).join("");
      return `- [${t.id}] ${t.resolved ? "(resolved) " : ""}${t.author} on ${JSON.stringify(t.currentText ?? t.quote)}: ${t.body}${reactions(t.reactions)}${replies}`;
    });
    return ok(lines.length ? lines.join("\n") : "No comments.", { comments });
  },
);

server.registerTool(
  "markdoc_comment",
  {
    title: "Comment",
    description: "Add a comment anchored to a quote of the document text, reply to a thread, resolve/reopen a thread, or toggle an emoji reaction on a thread or reply. Bodies may use inline Markdown (**bold**, *italic*, `code`, [links](https://…)) and @login mentions.",
    inputSchema: {
      id: z.string(),
      action: z.enum(["add", "reply", "resolve", "reopen", "react"]).default("add"),
      quote: z.string().optional().describe("Exact text to anchor a new comment to"),
      threadId: z.string().optional().describe("Thread to reply to / resolve / react to"),
      replyId: z.string().optional().describe("With `react`: react to this reply instead of the thread body"),
      body: z.string().optional().describe("Comment text"),
      emoji: z.string().optional().describe("With `react`: the emoji to toggle, e.g. 👍 ❤️ 🎉 👀 😄 🚀"),
      requestId: z.string().optional().describe("With `add`: link the comment to an \"Ask an agent\" request you are working on"),
    },
  },
  async ({ id, action, quote, threadId, replyId, body, emoji, requestId }) => {
    if (action === "add") {
      if (!quote || !body) throw new Error("`quote` and `body` are required to add a comment.");
      const res = await api("POST", `/api/documents/${id}/comments`, { action: "add", quote, body, ...(requestId ? { requestId } : {}) });
      return ok(`Commented on ${JSON.stringify(quote)} (thread ${res.id}).`, res);
    }
    if (!threadId) throw new Error("`threadId` is required.");
    if (action === "reply") {
      if (!body) throw new Error("`body` is required to reply.");
      const res = await api("POST", `/api/documents/${id}/comments`, { action: "reply", threadId, body });
      return ok(`Replied to thread ${threadId}.`, res);
    }
    if (action === "react") {
      if (!emoji) throw new Error("`emoji` is required to react.");
      const res = await api("POST", `/api/documents/${id}/comments`, { action: "react", threadId, replyId, emoji });
      return ok(`${res.reacted ? "Reacted" : "Removed reaction"} ${emoji} on ${replyId ? `reply ${replyId}` : `thread ${threadId}`}.`, res);
    }
    await api("POST", `/api/documents/${id}/comments`, { action: "resolve", threadId, resolved: action === "resolve" });
    return ok(`Thread ${threadId} ${action === "resolve" ? "resolved" : "reopened"}.`);
  },
);

server.registerTool(
  "markdoc_versions",
  { title: "Version history", description: "List saved versions of a document.", inputSchema: { id: z.string() } },
  async ({ id }) => {
    const { versions } = await api("GET", `/api/documents/${id}/versions`);
    const lines = versions.map((v) => `- v${v.number} ${v.kind}${v.title ? ` "${v.title}"` : ""} by ${v.createdByName ?? "?"} at ${v.createdAt}${v.commitSha ? ` (commit ${v.commitSha.slice(0, 7)})` : ""}`);
    return ok(lines.join("\n") || "No versions.", { versions });
  },
);

const SYNC_HINT = {
  "remote-ahead": "GitHub has changes the document does not. Call markdoc_pull first (or publish with force: true to overwrite).",
  diverged: "Both the document and the GitHub file changed. Call markdoc_pull with merge: true, or force one side.",
  "local-ahead": "The document has unpublished changes; pulling would discard them. Call markdoc_publish first (or pull with force: true).",
};

server.registerTool(
  "markdoc_publish",
  {
    title: "Publish to GitHub",
    description:
      "Publish the document to its linked gist or repository file (creates a commit). The document must already be connected to GitHub in the app. Refuses (status remote-ahead / diverged) when GitHub moved since the last sync; force: true overwrites.",
    inputSchema: { id: z.string(), message: z.string().optional(), force: z.boolean().optional() },
  },
  async ({ id, message, force }) => {
    try {
      const res = await api("POST", `/api/documents/${id}/publish${force ? "?force=1" : ""}`, { message });
      return ok(res.result.skipped ? "Already up to date on GitHub." : `Published. ${res.result.url ?? ""}`, res);
    } catch (err) {
      if (!err.sync) throw err;
      return ok(`Not published: ${err.sync.status}. ${SYNC_HINT[err.sync.status] ?? err.message}`, err.sync);
    }
  },
);

server.registerTool(
  "markdoc_pull",
  {
    title: "Pull from GitHub",
    description:
      "Bring the linked GitHub file into the document. Refuses (status local-ahead / diverged) when unpublished edits would be lost; merge: true three-way merges a diverged document (conflicts come back as status \"conflict\" with the marked text), force: true replaces the text regardless.",
    inputSchema: { id: z.string(), merge: z.boolean().optional(), force: z.boolean().optional() },
  },
  async ({ id, merge, force }) => {
    const q = [force && "force=1", merge && "merge=1"].filter(Boolean).join("&");
    try {
      const res = await api("POST", `/api/documents/${id}/pull${q ? `?${q}` : ""}`);
      const r = res.result;
      return ok(r.merged ? "Merged GitHub\u2019s changes into the document; publish to finish." : r.changed ? "Pulled the latest version from GitHub." : "Already up to date.", res);
    } catch (err) {
      if (!err.sync) throw err;
      if (err.sync.status === "conflict") return ok(`Merge has ${err.sync.conflicts} conflict(s); the marked text is in \`merged\`.`, err.sync);
      return ok(`Not pulled: ${err.sync.status}. ${SYNC_HINT[err.sync.status] ?? err.message}`, err.sync);
    }
  },
);

server.registerTool(
  "markdoc_sync_status",
  { title: "GitHub sync status", description: "Where a GitHub-linked document stands: in-sync, local-ahead (publish is safe), remote-ahead (pull is safe) or diverged (merge or force one side).", inputSchema: { id: z.string() } },
  async ({ id }) => {
    const s = await api("GET", `/api/documents/${id}/sync?fresh=1`);
    return ok(`${s.status} (local ${s.lines.local} line(s) changed, GitHub ${s.lines.remote}).`, s);
  },
);

server.registerTool(
  "markdoc_duplicate_document",
  {
    title: "Make a copy",
    description:
      "Create a copy of a document owned by the user: \"Copy of <title>\" with the current text (pending suggestions dropped, comments not copied), images included. The copy is always a Markdoc document even when the source is linked to GitHub. Returns the new id and URL.",
    inputSchema: { id: z.string().describe("Document id to copy") },
  },
  async ({ id }) => {
    const copy = await api("POST", `/api/documents/${id}/duplicate`);
    return ok(`Created "${copy.title}" (id ${copy.id}). Open it: ${docUrl(copy.id)}`, { id: copy.id, title: copy.title, url: docUrl(copy.id) });
  },
);

server.registerTool(
  "markdoc_delete_document",
  {
    title: "Move document to trash",
    description:
      "Move a document the user owns to the trash (soft delete). It disappears from lists and search and nobody can open it; the owner can restore it with markdoc_restore_document for 30 days, after which it is deleted for good. Pass permanent: true to delete it immediately and irreversibly.",
    inputSchema: { id: z.string(), permanent: z.boolean().optional().describe("Delete for good instead of moving to the trash (default false)") },
  },
  async ({ id, permanent }) => {
    await api("DELETE", `/api/documents/${id}${permanent ? "?permanent=1" : ""}`);
    return ok(permanent ? `Deleted document ${id} permanently.` : `Moved document ${id} to the trash. It can be restored for 30 days.`, { id, permanent: !!permanent });
  },
);

server.registerTool(
  "markdoc_restore_document",
  { title: "Restore from trash", description: "Take a document the user owns out of the trash so it is listed and editable again.", inputSchema: { id: z.string() } },
  async ({ id }) => {
    const res = await api("POST", `/api/documents/${id}/restore`);
    return ok(`Restored "${res.document.title}" (id ${id}). Open it: ${docUrl(id)}`, { id, title: res.document.title, url: docUrl(id) });
  },
);

server.registerTool(
  "markdoc_list_requests",
  {
    title: "List requests for me",
    description:
      "Check Markdoc for work humans asked for from inside the editor (\"Ask an agent\"): open requests across every document the user can see, each with the document, the selected text (if any), the instruction and the mode — suggest (propose tracked changes with markdoc_suggest), comment (reply with markdoc_comment) or rewrite (edit directly with markdoc_replace_content). Claim one with markdoc_claim_request, do the work passing its requestId, then markdoc_complete_request.",
    inputSchema: {
      status: z.enum(["open", "claimed", "done", "cancelled"]).optional().describe("Default: open"),
      limit: z.number().int().min(1).max(200).optional(),
    },
  },
  async ({ status, limit }) => {
    const q = new URLSearchParams();
    if (status) q.set("status", status);
    if (limit) q.set("limit", String(limit));
    const qs = q.toString();
    const { requests } = await api("GET", `/api/agent/requests${qs ? `?${qs}` : ""}`);
    const lines = requests.map(
      (r) =>
        `- [${r.id}] ${r.status}${r.claimedBy ? ` (${r.claimedBy})` : ""} · ${r.mode} · "${r.documentTitle}" (document ${r.documentId}) · from ${r.userName ?? r.userLogin ?? "someone"} · ${r.createdAt}\n    instruction: ${r.instruction}${r.selection ? `\n    selection: ${JSON.stringify(r.selection.quote)}` : "\n    selection: whole document"}`,
    );
    return ok(lines.length ? lines.join("\n") : `No ${status ?? "open"} requests. Nothing to do right now.`, { requests });
  },
);

server.registerTool(
  "markdoc_claim_request",
  {
    title: "Claim a request",
    description: "Take an open request so the human sees who is working on it. Then read the document (markdoc_read_document), do the work with markdoc_suggest / markdoc_comment / markdoc_replace_content passing the same requestId, and finish with markdoc_complete_request.",
    inputSchema: { documentId: z.string(), requestId: z.string() },
  },
  async ({ documentId, requestId }) => {
    const { request } = await api("POST", `/api/documents/${documentId}/requests/${requestId}/claim`);
    return ok(
      `Claimed request ${request.id} (${request.mode}) on document ${documentId}.\nInstruction: ${request.instruction}\n${request.selection ? `Selected text: ${JSON.stringify(request.selection.quote)}` : "Applies to the whole document."}\nOpen it: ${docUrl(documentId)}`,
      { request },
    );
  },
);

server.registerTool(
  "markdoc_complete_request",
  {
    title: "Complete a request",
    description: "Mark a request done once your suggestions/comments are in. The requester is notified and sees the result; `summary` is shown to them (one sentence on what you did).",
    inputSchema: {
      documentId: z.string(),
      requestId: z.string(),
      summary: z.string().max(2000).optional().describe("One sentence for the human: what you changed or found"),
    },
  },
  async ({ documentId, requestId, summary }) => {
    const { request } = await api("POST", `/api/documents/${documentId}/requests/${requestId}/complete`, summary ? { summary } : {});
    const r = request.result ?? { suggestions: 0, comments: 0 };
    return ok(`Request ${request.id} is done: ${r.suggestions} suggestion(s), ${r.comments} comment(s). The requester has been notified. ${docUrl(documentId)}`, { request });
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
