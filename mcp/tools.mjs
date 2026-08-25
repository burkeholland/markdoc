// The Markdoc MCP tool set, shared by the stdio server (mcp/server.mjs) and the remote endpoint
// (src/app/api/mcp/route.ts). Both build a `client` over the REST API with a base URL and a token,
// then call `registerTools(server, client)`; the tool definitions live here exactly once.
//
// To add a tool: call `tool(name, config, handler)` inside `registerTools`; the count and the
// name list the HTTP route reports come from that same list.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export const SERVER_INFO = { name: "markdoc", version: "0.1.0" };

export const INSTRUCTIONS = [
  "Markdoc is a collaborative Markdown editor: people and agents write the same document in real time, with comments, tracked suggestions and version history.",
  "Use markdoc_create_document to start a document people can open in their browser and edit with you in real time;",
  "always give the user the returned URL.",
  "markdoc_suggest is the preferred way to change text: suggestions show up as tracked changes the humans review and accept or reject in the app.",
  "Use markdoc_replace_content only when the user explicitly asks you to rewrite the document in place, and always pass the hash from markdoc_read_document as ifContentHash so you never overwrite what a person typed while you worked.",
  "Use markdoc_comments to read feedback left for you and markdoc_comment to reply.",
  "When asked to review a document, call markdoc_review: a summary, a verdict and one comment per finding, each quoting the exact text and proposing a rewrite in a ```suggestion block the humans accept with one click.",
  "When the user asks you to check Markdoc for requests (or says an agent was asked for something in a document), call markdoc_list_requests,",
  "claim a request, do what its instruction says with the requestId, and call markdoc_complete_request with a one-line summary.",
].join(" ");

/**
 * MCP `ToolAnnotations` (https://modelcontextprotocol.io/specification/2025-06-18/server/tools#tool-annotations).
 * Clients such as GitHub Copilot CLI read them to decide whether to ask the user before a call, so
 * every tool below carries one of these three sets. `openWorldHint` is false everywhere: the server
 * only ever talks to the Markdoc it is configured for.
 */
/** Pure reads: nothing changes, safe to repeat. */
export const READ_ONLY = Object.freeze({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
/** Additive or reversible writes (a suggestion, a comment, a new document, a commit): not destructive, not idempotent. */
export const ADDITIVE = Object.freeze({ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false });
/** Writes that replace or remove what others wrote, or decide on their work. */
export const DESTRUCTIVE = Object.freeze({ readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false });

/**
 * A small REST client: `{ baseUrl, request, get, post, put, patch, delete }` over fetch with the
 * base URL and the bearer token. `fetch` lets the HTTP route (or a test) substitute the implementation.
 * @param {{ baseUrl: string, token: string, fetch?: typeof globalThis.fetch }} options
 */
export function createClient({ baseUrl, token, fetch: fetchImpl = globalThis.fetch }) {
  const base = baseUrl.replace(/\/$/, "");
  const authorization = ["Bearer", token].join(" ");
  async function request(method, path, body) {
    const res = await fetchImpl(base + path, {
      method,
      headers: { Authorization: authorization, "Content-Type": "application/json", Accept: "application/json, text/markdown" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) {
      let message = text;
      let data = null;
      try {
        data = JSON.parse(text);
        message = data.error ?? text;
      } catch {
        /* plain text */
      }
      // Sync refusals (409 with a `status`) are answers, not failures: let publish/pull surface them.
      if (res.status === 409 && data?.status) throw Object.assign(new Error(message), { sync: data });
      throw Object.assign(new Error(`${method} ${path} failed (${res.status}): ${message}${describeIssues(data?.issues)}`), { status: res.status, data });
    }
    if (res.headers.get("content-type")?.includes("application/json")) return JSON.parse(text);
    return text;
  }
  return {
    baseUrl: base,
    request,
    get: (path) => request("GET", path),
    post: (path, body) => request("POST", path, body),
    put: (path, body) => request("PUT", path, body),
    patch: (path, body) => request("PATCH", path, body),
    delete: (path) => request("DELETE", path),
  };
}

const ok = (text, structured) => ({ content: [{ type: "text", text }], ...(structured ? { structuredContent: structured } : {}) });

/**
 * Zod `issues` from a 400, as " — content: Too big: expected string to have <=2000000 characters (+2 more)":
 * the path and message of the first issue are what tells a model *why* the request was invalid.
 * @param {unknown} issues
 */
export function describeIssues(issues) {
  if (!Array.isArray(issues) || issues.length === 0) return "";
  const [first] = issues;
  const path = Array.isArray(first?.path) && first.path.length ? first.path.join(".") : "body";
  const message = typeof first?.message === "string" && first.message ? first.message : JSON.stringify(first);
  const more = issues.length > 1 ? ` (+${issues.length - 1} more)` : "";
  return ` — ${path}: ${message}${more}`;
}

const SYNC_HINT = {
  "remote-ahead": "GitHub has changes the document does not. Call markdoc_pull first (or publish with force: true to overwrite).",
  diverged: "Both the document and the GitHub file changed. Call markdoc_pull with merge: true, or force one side.",
  "local-ahead": "The document has unpublished changes; pulling would discard them. Call markdoc_publish first (or pull with force: true).",
};

/** A new McpServer with the Markdoc instructions and every tool registered against `client`. */
export function createMarkdocServer(client) {
  const server = new McpServer(SERVER_INFO, { instructions: INSTRUCTIONS });
  registerTools(server, client);
  return server;
}

/** The tool names `registerTools` registers (same order), without a live server or client. */
export function listToolNames() {
  return listToolDefinitions().map((t) => t.name);
}

/**
 * `{ name, title, annotations }` for every tool, in registration order, without a live server or
 * client — what docs, the smoke script and the tests compare `tools/list` against.
 * @returns {{ name: string, title: string, annotations: typeof READ_ONLY | typeof ADDITIVE | typeof DESTRUCTIVE }[]}
 */
export function listToolDefinitions() {
  const defs = [];
  registerTools({ registerTool: (name, config) => defs.push({ name, title: config.title, annotations: config.annotations }) }, null);
  return defs;
}

/**
 * Register every Markdoc tool on `server`; each one calls the REST API through `client`.
 * Returns the registered tool names.
 * @param {{ registerTool: (name: string, config: object, handler: Function) => unknown }} server
 * @param {ReturnType<typeof createClient> | null} client
 * @returns {string[]}
 */
export function registerTools(server, client) {
  const names = [];
  const tool = (name, config, handler) => {
    // Every tool must say what it does to the document; a missing set is a bug, not a default.
    if (!config.annotations || typeof config.annotations.readOnlyHint !== "boolean") throw new Error(`Tool ${name} has no annotations`);
    server.registerTool(name, config, handler);
    names.push(name);
  };
  const baseUrl = client?.baseUrl ?? "";
  const api = (method, path, body) => client.request(method, path, body);
  const docUrl = (id) => `${baseUrl}/d/${id}`;

  tool(
    "markdoc_whoami",
    { title: "Who am I", description: "Show which user and agent identity this token acts as.", inputSchema: {}, annotations: READ_ONLY },
    async () => {
      const me = await api("GET", "/api/me");
      return ok(`Acting as ${me.user.name ?? me.user.login} (${me.user.login ?? me.user.id}) via agent "${me.agent}". Server: ${baseUrl}`, me);
    },
  );

  tool(
    "markdoc_list_documents",
    {
      title: "List documents",
      description:
        "List the documents the user owns or that are shared with them (id, title, storage, last edit, starred, lastOpenedAt). Most recently opened first; never-opened documents follow by last edit.",
      inputSchema: { starred: z.boolean().optional().describe("Only documents the user has starred"), trash: z.boolean().optional().describe("List the user's own documents in the trash instead (each has deletedAt)") },
      annotations: READ_ONLY,
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

  tool(
    "markdoc_search_documents",
    {
      title: "Search documents",
      description: "Search the user's documents by title or body text (case-insensitive). Returns matching documents with a short snippet around the first content match.",
      inputSchema: { query: z.string().min(2).max(200).describe("Text to look for in titles and content"), limit: z.number().int().min(1).max(100).optional().describe("Max results (default 20)") },
      annotations: READ_ONLY,
    },
    async ({ query, limit }) => {
      const { documents } = await api("GET", `/api/documents?q=${encodeURIComponent(query)}${limit ? `&limit=${limit}` : ""}`);
      const lines = documents.map((d) => `- ${d.title} — id ${d.id} — edited ${d.updatedAt} — ${docUrl(d.id)}${d.snippet ? `\n    ${d.snippet}` : ""}`);
      return ok(lines.length ? lines.join("\n") : `No documents match "${query}".`, { query, documents });
    },
  );

  tool(
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
      annotations: ADDITIVE,
    },
    async ({ title, content, template }) => {
      if (content === undefined && !template) throw new Error("Provide `content` or `template`.");
      const { document } = await api("POST", "/api/documents", { title, content, template });
      return ok(`Created "${document.title}" (id ${document.id}). Open it: ${docUrl(document.id)}`, { id: document.id, title: document.title, url: docUrl(document.id) });
    },
  );

  tool(
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
      annotations: ADDITIVE,
    },
    async ({ title, content, format }) => {
      const { documents } = await api("POST", "/api/import/file", { title, content, format });
      const [document] = documents;
      const warn = document.warnings.length ? ` Warnings: ${document.warnings.join("; ")}` : "";
      return ok(`Imported "${document.title}" (id ${document.id}). Open it: ${docUrl(document.id)}${warn}`, { ...document, url: docUrl(document.id) });
    },
  );

  tool(
    "markdoc_list_templates",
    { title: "List templates", description: "List the document templates markdoc_create_document accepts (id, name, description).", inputSchema: {}, annotations: READ_ONLY },
    async () => {
      const { templates } = await api("GET", "/api/templates");
      return ok(templates.map((t) => `- ${t.id}: ${t.name} — ${t.description}`).join("\n"), { templates });
    },
  );

  tool(
    "markdoc_read_document",
    {
      title: "Read document",
      description:
        "Read a document's current Markdown. `clean` excludes text that is still a pending suggestion. The header line carries the document's contentHash: pass it as `ifContentHash` to markdoc_replace_content / markdoc_suggest so your write is refused (instead of silently overwriting) if someone edited the document after you read it.",
      inputSchema: { id: z.string().describe("Document id (from the URL /d/<id>)"), clean: z.boolean().optional().describe("Return the text without pending suggestions (default false)") },
      annotations: READ_ONLY,
    },
    async ({ id, clean }) => {
      const data = await api("GET", `/api/documents/${id}/content`);
      const text = clean ? data.clean : data.content;
      const header = `# ${data.title || "Untitled"} (id ${id}, hash ${data.contentHash}) — ${data.pendingSuggestions} pending suggestion(s), ${data.openComments} open comment(s)\n\n`;
      return ok(header + text, { id, title: data.title, content: text, contentHash: data.contentHash, pendingSuggestions: data.pendingSuggestions, openComments: data.openComments, url: docUrl(id) });
    },
  );

  const IF_HASH = z.string().optional().describe("The contentHash from markdoc_read_document (header line `hash …`). When the document changed since, the call fails with what changed instead of writing; re-read and retry.");

  /**
   * A conditional write refused because the document moved: tell the model to re-read and retry and
   * show it the diff (409 bodies carry `contentHash` and `diff`). Anything else rethrows.
   * @param {unknown} err
   */
  const staleOr = (err) => {
    const data = err?.status === 409 && err?.data && typeof err.data.contentHash === "string" ? err.data : null;
    if (!data) throw err;
    const what = data.diff ? `here is what changed:\n${data.diff}${data.truncated ? "\n… (diff truncated)" : ""}` : "what changed is not available; re-read the document.";
    return { isError: true, content: [{ type: "text", text: `Document changed since you read it — nothing was written. Re-read it (markdoc_read_document) and retry with the new hash ${data.contentHash}; ${what}` }], structuredContent: data };
  };

  tool(
    "markdoc_replace_content",
    {
      title: "Replace content",
      description:
        "Replace the whole document with new Markdown. Applied live as a minimal edit (collaborators keep their cursors). Use for your own drafts, or when the user explicitly asks for an in-place rewrite; use markdoc_suggest for other people's text. Always pass `ifContentHash` from the markdoc_read_document you worked from: a person may be typing in the same document, and without it their words are silently overwritten.",
      inputSchema: { id: z.string(), content: z.string().describe("The complete new Markdown"), message: z.string().optional().describe("Short description saved in version history"), ifContentHash: IF_HASH },
      annotations: DESTRUCTIVE,
    },
    async ({ id, content, message, ifContentHash }) => {
      try {
        const res = await api("PUT", `/api/documents/${id}/content`, { content, message, ...(ifContentHash ? { ifContentHash } : {}) });
        return ok(res.changed ? `Document ${id} updated (hash ${res.contentHash}). ${docUrl(id)}` : `Document ${id} already had that content (hash ${res.contentHash}).`, { ...res, url: docUrl(id) });
      } catch (err) {
        return staleOr(err);
      }
    },
  );

  tool(
    "markdoc_append",
    { title: "Append", description: "Append Markdown to the end of a document.", inputSchema: { id: z.string(), markdown: z.string() }, annotations: ADDITIVE },
    async ({ id, markdown }) => {
      await api("PATCH", `/api/documents/${id}/content`, { append: markdown });
      return ok(`Appended to ${id}. ${docUrl(id)}`);
    },
  );

  tool(
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
        ifContentHash: IF_HASH,
      },
      annotations: ADDITIVE,
    },
    async ({ id, content, edits, requestId, ifContentHash }) => {
      if (!content && !edits?.length) throw new Error("Provide `content` or `edits`.");
      try {
        const res = await api("POST", `/api/documents/${id}/suggest`, { ...(content !== undefined ? { content } : { edits }), ...(requestId ? { requestId } : {}), ...(ifContentHash ? { ifContentHash } : {}) });
        return ok(`Proposed ${res.suggestions} change(s) on ${id}. Reviewers can accept or reject them at ${docUrl(id)}`, { ...res, url: docUrl(id) });
      } catch (err) {
        return staleOr(err);
      }
    },
  );

  tool(
    "markdoc_suggestions",
    { title: "List suggestions", description: "List pending suggestions (tracked changes) on a document with author and surrounding context.", inputSchema: { id: z.string() }, annotations: READ_ONLY },
    async ({ id }) => {
      const { suggestions } = await api("GET", `/api/documents/${id}/suggestions`);
      const lines = suggestions.map((s) => `- [${s.id}] ${s.type} by ${s.author}: ${JSON.stringify(s.text)} — context: ${JSON.stringify(s.context)}`);
      return ok(lines.length ? lines.join("\n") : "No pending suggestions.", { suggestions });
    },
  );

  tool(
    "markdoc_review_suggestions",
    {
      title: "Accept or reject suggestions",
      description: "Accept or reject one suggestion by `suggestionId` (required for accept/reject; list ids with markdoc_suggestions), or all of them with acceptAll/rejectAll. Only do this when the user asked you to.",
      inputSchema: {
        id: z.string(),
        action: z.enum(["accept", "reject", "acceptAll", "rejectAll"]),
        suggestionId: z.string().optional().describe("Required for accept/reject: the suggestion id from markdoc_suggestions"),
      },
      annotations: DESTRUCTIVE,
    },
    async ({ id, action, suggestionId }) => {
      const single = action === "accept" || action === "reject";
      if (single && !suggestionId) throw new Error("`suggestionId` is required for accept/reject (list them with markdoc_suggestions).");
      const res = await api("POST", `/api/documents/${id}/suggestions`, { action, ...(single ? { id: suggestionId } : {}) });
      const decided = Number(res?.decided ?? 0);
      if (decided === 0) throw new Error(`${action} decided nothing on ${id}: no pending suggestions.`);
      const verb = action.startsWith("accept") ? "Accepted" : "Rejected";
      return ok(single ? `${verb} suggestion ${suggestionId} on ${id}.` : `${verb} ${decided} suggestion(s) on ${id}.`, { ok: true, action, decided, ...(single ? { suggestionId } : {}) });
    },
  );

  tool(
    "markdoc_comments",
    { title: "List comments", description: "Read the comment threads on a document (open and resolved), with the text each one is anchored to.", inputSchema: { id: z.string() }, annotations: READ_ONLY },
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

  tool(
    "markdoc_comment",
    {
      title: "Comment",
      description:
        "Add a comment anchored to a quote of the document text, reply to a thread, resolve/reopen a thread, or toggle an emoji reaction on a thread or reply. Bodies may use inline Markdown (**bold**, *italic*, `code`, [links](https://…)) and @login mentions. To propose a rewrite of the quoted text, include one fenced block with the info string `suggestion` (exactly GitHub's syntax) — ```suggestion⏎new text⏎``` — people see a diff with Accept / Reject; Accept replaces the quoted text. Nothing is applied until a human accepts.",
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
      annotations: ADDITIVE,
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

  tool(
    "markdoc_review",
    {
      title: "Review a document",
      description:
        "Leave a GitHub-style review: a summary, a verdict (approve / request_changes / comment) and one comment per finding. Each comment quotes the exact text it is about (first occurrence) and may propose a rewrite of that quote in a ```suggestion fenced block — the humans see a diff and click Accept (applies it) or Reject. Nothing is changed until they accept. The review shows as a card at the top of the Comments panel with Accept all / Reject all. Atomic: if any quote is not found, nothing is created and the error lists which.",
      inputSchema: {
        id: z.string(),
        summary: z.string().describe("One or two sentences on the whole document"),
        verdict: z.enum(["approve", "request_changes", "comment"]).default("comment"),
        comments: z
          .array(
            z.object({
              quote: z.string().describe("Exact text the comment is about"),
              body: z.string().describe("Comment text; add ```suggestion⏎replacement⏎``` to propose a rewrite of the quote"),
            }),
          )
          .min(1)
          .describe("One entry per finding"),
      },
      annotations: ADDITIVE,
    },
    async ({ id, summary, verdict, comments }) => {
      const { review } = await api("POST", `/api/documents/${id}/reviews`, { summary, verdict, comments });
      const suggestions = comments.filter((c) => /(^|\n)\s*(`{3,}|~{3,})\s*suggestion\s*\n/.test(c.body)).length;
      return ok(`Review ${review.id} posted on ${id}: ${verdict}, ${comments.length} comment(s), ${suggestions} suggestion(s). People can accept them at ${docUrl(id)}`, { ...review, url: docUrl(id) });
    },
  );

  tool(
    "markdoc_versions",
    { title: "Version history", description: "List saved versions of a document.", inputSchema: { id: z.string() }, annotations: READ_ONLY },
    async ({ id }) => {
      const { versions } = await api("GET", `/api/documents/${id}/versions`);
      const lines = versions.map((v) => `- v${v.number} ${v.kind}${v.title ? ` "${v.title}"` : ""} by ${v.createdByName ?? "?"} at ${v.createdAt}${v.commitSha ? ` (commit ${v.commitSha.slice(0, 7)})` : ""}`);
      return ok(lines.join("\n") || "No versions.", { versions });
    },
  );

  tool(
    "markdoc_publish",
    {
      title: "Publish to GitHub",
      description:
        "Publish the document to its linked gist or repository file (creates a commit). The document must already be connected to GitHub in the app. Refuses (status remote-ahead / diverged) when GitHub moved since the last sync; force: true overwrites GitHub's version — only when the user asks.",
      inputSchema: { id: z.string(), message: z.string().optional(), force: z.boolean().optional() },
      annotations: ADDITIVE,
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

  tool(
    "markdoc_pull",
    {
      title: "Pull from GitHub",
      description:
        "Bring the linked GitHub file into the document. Refuses (status local-ahead / diverged) when unpublished edits would be lost; merge: true three-way merges a diverged document (conflicts come back as status \"conflict\" with the marked text), force: true replaces the text regardless — only when the user asks.",
      inputSchema: { id: z.string(), merge: z.boolean().optional(), force: z.boolean().optional() },
      annotations: ADDITIVE,
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

  tool(
    "markdoc_sync_status",
    { title: "GitHub sync status", description: "Where a GitHub-linked document stands: in-sync, local-ahead (publish is safe), remote-ahead (pull is safe) or diverged (merge or force one side).", inputSchema: { id: z.string() }, annotations: READ_ONLY },
    async ({ id }) => {
      const s = await api("GET", `/api/documents/${id}/sync?fresh=1`);
      return ok(`${s.status} (local ${s.lines.local} line(s) changed, GitHub ${s.lines.remote}).`, s);
    },
  );

  tool(
    "markdoc_duplicate_document",
    {
      title: "Make a copy",
      description:
        "Create a copy of a document owned by the user: \"Copy of <title>\" with the current text (pending suggestions dropped, comments not copied), images included. The copy is always a Markdoc document even when the source is linked to GitHub. Returns the new id and URL.",
      inputSchema: { id: z.string().describe("Document id to copy") },
      annotations: ADDITIVE,
    },
    async ({ id }) => {
      const copy = await api("POST", `/api/documents/${id}/duplicate`);
      return ok(`Created "${copy.title}" (id ${copy.id}). Open it: ${docUrl(copy.id)}`, { id: copy.id, title: copy.title, url: docUrl(copy.id) });
    },
  );

  tool(
    "markdoc_delete_document",
    {
      title: "Move document to trash",
      description:
        "Move a document the user owns to the trash (soft delete). It disappears from lists and search and nobody can open it; the owner can restore it with markdoc_restore_document for 30 days, after which it is deleted for good. Pass permanent: true to delete it immediately and irreversibly.",
      inputSchema: { id: z.string(), permanent: z.boolean().optional().describe("Delete for good instead of moving to the trash (default false)") },
      annotations: DESTRUCTIVE,
    },
    async ({ id, permanent }) => {
      await api("DELETE", `/api/documents/${id}${permanent ? "?permanent=1" : ""}`);
      return ok(permanent ? `Deleted document ${id} permanently.` : `Moved document ${id} to the trash. It can be restored for 30 days.`, { id, permanent: !!permanent });
    },
  );

  tool(
    "markdoc_restore_document",
    { title: "Restore from trash", description: "Take a document the user owns out of the trash so it is listed and editable again. An error (409) when the document is not in the trash: nothing changed.", inputSchema: { id: z.string() }, annotations: ADDITIVE },
    async ({ id }) => {
      const res = await api("POST", `/api/documents/${id}/restore`);
      return ok(`Restored "${res.document.title}" (id ${id}). Open it: ${docUrl(id)}`, { id, title: res.document.title, url: docUrl(id) });
    },
  );

  tool(
    "markdoc_list_requests",
    {
      title: "List requests for me",
      description:
        "Check Markdoc for work humans asked for from inside the editor (\"Ask an agent\"): open requests across every document the user can see, each with the document, the selected text (if any), the instruction and the mode — suggest (propose tracked changes with markdoc_suggest), comment (reply with markdoc_comment) or rewrite (edit directly with markdoc_replace_content). Claim one with markdoc_claim_request, do the work passing its requestId, then markdoc_complete_request.",
      inputSchema: {
        status: z.enum(["open", "claimed", "done", "cancelled"]).optional().describe("Default: open"),
        limit: z.number().int().min(1).max(200).optional(),
      },
      annotations: READ_ONLY,
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

  tool(
    "markdoc_claim_request",
    {
      title: "Claim a request",
      description: "Take an open request so the human sees who is working on it. Then read the document (markdoc_read_document), do the work with markdoc_suggest / markdoc_comment / markdoc_replace_content passing the same requestId, and finish with markdoc_complete_request.",
      inputSchema: { documentId: z.string(), requestId: z.string() },
      annotations: ADDITIVE,
    },
    async ({ documentId, requestId }) => {
      const { request } = await api("POST", `/api/documents/${documentId}/requests/${requestId}/claim`);
      return ok(
        `Claimed request ${request.id} (${request.mode}) on document ${documentId}.\nInstruction: ${request.instruction}\n${request.selection ? `Selected text: ${JSON.stringify(request.selection.quote)}` : "Applies to the whole document."}\nOpen it: ${docUrl(documentId)}`,
        { request },
      );
    },
  );

  tool(
    "markdoc_complete_request",
    {
      title: "Complete a request",
      description: "Mark a request done once your suggestions/comments are in. The requester is notified and sees the result; `summary` is shown to them (one sentence on what you did).",
      inputSchema: {
        documentId: z.string(),
        requestId: z.string(),
        summary: z.string().max(2000).optional().describe("One sentence for the human: what you changed or found"),
      },
      annotations: ADDITIVE,
    },
    async ({ documentId, requestId, summary }) => {
      const { request } = await api("POST", `/api/documents/${documentId}/requests/${requestId}/complete`, summary ? { summary } : {});
      const r = request.result ?? { suggestions: 0, comments: 0 };
      return ok(`Request ${request.id} is done: ${r.suggestions} suggestion(s), ${r.comments} comment(s). The requester has been notified. ${docUrl(documentId)}`, { request });
    },
  );

  tool(
    "markdoc_presence",
    {
      title: "Show up in a document",
      description:
        "Announce yourself in a document's presence list (a bot avatar next to the people in the header) with a short status such as \"reading\", \"drafting the summary\" or \"waiting for Burke\". state: active while you work, idle while you wait (markdoc_watch), left when you are done. Presence lapses 90 s after the last call unless you keep writing (every suggest/comment/replace marks you active too). Place your caret with `anchor` (text you are looking at; first occurrence, like a comment quote) or `cursor` ({ from, to } offsets in the clean Markdown from markdoc_read_document clean: true): people see a labelled caret there, like another collaborator's. Writes move it to where you acted.",
      inputSchema: {
        id: z.string().describe("Document id"),
        state: z.enum(["active", "idle", "left"]),
        status: z.string().max(80).optional().describe("Short free text shown next to your name"),
        anchor: z.string().min(1).max(2000).optional().describe("Exact text you are looking at; your caret selects its first occurrence"),
        cursor: z.object({ from: z.number().int().min(0), to: z.number().int().min(0) }).nullable().optional().describe("Offsets in the clean Markdown to put your caret at; null hides it"),
      },
      annotations: ADDITIVE,
    },
    async ({ id, state, status, anchor, cursor }) => {
      const res = await api("POST", `/api/agent/documents/${id}/presence`, { state, ...(status !== undefined ? { status } : {}), ...(anchor !== undefined ? { anchor } : {}), ...(cursor !== undefined ? { cursor } : {}) });
      if (!res.presence) return ok(`Left document ${id}.`, { id, state: "left" });
      const at = res.presence.cursor ? ` Caret at ${res.presence.cursor.from}–${res.presence.cursor.to} of the clean text.` : "";
      return ok(
        `Now ${res.presence.state} in document ${id}${res.presence.status ? ` (“${res.presence.status}”)` : ""} as ${res.presence.name}; expires in ${Math.round(res.ttlMs / 1000)} s without another call or write.${at}`,
        { id, presence: res.presence },
      );
    },
  );

  tool(
    "markdoc_watch",
    {
      title: "Wait for humans",
      description:
        "Long-poll for what people do: with `id`, everything on that document — content.changed (hash + unified diff of the clean text), comment.added / comment.replied / comment.resolved, suggestion.accepted / suggestion.rejected (a decision on a ```suggestion block in a comment), review.created, mention (someone @-mentioned your user, or you by name as @<user>/<your-token-name> from the picker — then `agent` is set), request.created (Ask an agent), activity. Without `id`, mentions and requests across every document you can see. Every event carries `actor` ({ name, login, kind: user|agent, agent, self }); your own writes (append, suggest, comment, review) are not delivered, so the call keeps waiting after your own actions — pass includeSelf: true to see them, marked (you). The first call without `since` returns only a cursor (start from now); loop passing the last cursor back as `since`. Blocks up to `wait` seconds (default 30, max 55) and returns early as soon as something happens. Respond with markdoc_comment / markdoc_suggest, then call markdoc_presence idle and watch again.",
      inputSchema: {
        id: z.string().optional().describe("Document id; omit for the cross-document inbox"),
        since: z.string().optional().describe("Cursor from the previous call"),
        wait: z.number().int().min(0).max(55).optional().describe("Seconds to wait for events (default 30)"),
        includeSelf: z.boolean().optional().describe("Also return events caused by this token's own writes (default false)"),
      },
      annotations: READ_ONLY,
    },
    async ({ id, since, wait, includeSelf }) => {
      const q = new URLSearchParams();
      if (since) q.set("since", since);
      q.set("wait", String(since ? wait ?? 30 : 0));
      if (includeSelf) q.set("includeSelf", "1");
      const res = await api("GET", `${id ? `/api/agent/documents/${id}/events` : "/api/agent/events"}?${q}`);
      if (!since) return ok(`Watching from now. Call markdoc_watch again with since: ${res.cursor}`, res);
      const who = (e) => (e.actor?.self ? " (you)" : e.actor?.kind === "agent" ? " (agent)" : "");
      const lines = res.events.map((e) => {
        const doc = id ? "" : ` (document ${e.documentId}${e.documentTitle ? ` “${e.documentTitle}”` : ""})`;
        switch (e.type) {
          case "content.changed":
            return `- content.changed${doc} by ${e.actor?.name ?? "someone"}${who(e)} → ${e.contentHash}${e.diff ? `\n${e.diff}` : " (diff unavailable; re-read the document)"}`;
          case "comment.added":
          case "comment.replied":
          case "comment.resolved":
            return `- ${e.type}${doc} by ${e.author}${who(e)} [thread ${e.threadId}]: ${e.body}`;
          case "mention":
            return `- mention${doc} by ${e.by ?? "someone"}${who(e)}${e.agent ? ` (addressed to you as @…/${e.agent})` : ""}: ${e.snippet}`;
          case "request.created":
            return `- request.created${doc} [${e.requestId}] ${e.mode} from ${e.by ?? "someone"}: ${e.instruction}${e.quote ? ` — selection: ${JSON.stringify(e.quote)}` : ""}`;
          default:
            return `- ${e.action ?? e.type}${doc} by ${e.actor?.name ?? e.by ?? "someone"}${who(e)}`;
        }
      });
      return ok(lines.length ? `${lines.join("\n")}\n\nNext cursor: ${res.cursor}` : `Nothing happened in ${wait ?? 30} s. Next cursor: ${res.cursor}`, res);
    },
  );

  return names;
}
