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
    try {
      message = JSON.parse(text).error ?? text;
    } catch {
      /* plain text */
    }
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
  { title: "List documents", description: "List the documents the user owns or that are shared with them (id, title, storage, last edit).", inputSchema: {} },
  async () => {
    const { documents } = await api("GET", "/api/documents");
    const lines = documents.map((d) => `- ${d.title} — id ${d.id} — ${d.storage}${d.repoName ? ` ${d.repoOwner}/${d.repoName}:${d.repoPath}` : ""} — edited ${d.updatedAt} — ${docUrl(d.id)}`);
    return ok(lines.length ? lines.join("\n") : "No documents yet.", { documents });
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
    },
  },
  async ({ id, content, edits }) => {
    if (!content && !edits?.length) throw new Error("Provide `content` or `edits`.");
    const res = await api("POST", `/api/documents/${id}/suggest`, content !== undefined ? { content } : { edits });
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
    const lines = comments.map((t) => {
      const replies = t.replies.map((r) => `\n    ↳ ${r.author}: ${r.body}`).join("");
      return `- [${t.id}] ${t.resolved ? "(resolved) " : ""}${t.author} on ${JSON.stringify(t.currentText ?? t.quote)}: ${t.body}${replies}`;
    });
    return ok(lines.length ? lines.join("\n") : "No comments.", { comments });
  },
);

server.registerTool(
  "markdoc_comment",
  {
    title: "Comment",
    description: "Add a comment anchored to a quote of the document text, reply to a thread, or resolve/reopen a thread.",
    inputSchema: {
      id: z.string(),
      action: z.enum(["add", "reply", "resolve", "reopen"]).default("add"),
      quote: z.string().optional().describe("Exact text to anchor a new comment to"),
      threadId: z.string().optional().describe("Thread to reply to / resolve"),
      body: z.string().optional().describe("Comment text"),
    },
  },
  async ({ id, action, quote, threadId, body }) => {
    if (action === "add") {
      if (!quote || !body) throw new Error("`quote` and `body` are required to add a comment.");
      const res = await api("POST", `/api/documents/${id}/comments`, { action: "add", quote, body });
      return ok(`Commented on ${JSON.stringify(quote)} (thread ${res.id}).`, res);
    }
    if (!threadId) throw new Error("`threadId` is required.");
    if (action === "reply") {
      if (!body) throw new Error("`body` is required to reply.");
      const res = await api("POST", `/api/documents/${id}/comments`, { action: "reply", threadId, body });
      return ok(`Replied to thread ${threadId}.`, res);
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

server.registerTool(
  "markdoc_publish",
  { title: "Publish to GitHub", description: "Publish the document to its linked gist or repository file (creates a commit). The document must already be connected to GitHub in the app.", inputSchema: { id: z.string(), message: z.string().optional() } },
  async ({ id, message }) => {
    const res = await api("POST", `/api/documents/${id}/publish`, { message });
    return ok(res.result.skipped ? "Already up to date on GitHub." : `Published. ${res.result.url ?? ""}`, res);
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
