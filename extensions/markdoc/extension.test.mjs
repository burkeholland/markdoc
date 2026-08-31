import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { startMarkdocExtension } from "./extension-core.mjs";

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address !== "string");
  return `http://127.0.0.1:${address.port}`;
}

async function close(server) {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}

async function requestWithHost(url, host) {
  return new Promise((resolve, reject) => {
    const req = request(url, { headers: { Host: host } }, (res) => {
      res.resume();
      res.once("end", () => resolve(res.statusCode));
    });
    req.once("error", reject);
    req.end();
  });
}

async function until(check, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = check();
    if (result) return result;
    await delay(10);
  }
  throw new Error("Timed out waiting for extension activity");
}

test("secures the shell, deduplicates pushes, selects active and idle delivery modes, and leaves on close", async () => {
  const presence = [];
  let handoffs = 0;
  let eventReads = 0;
  let handoffRequest;
  const queuedEvents = [];
  const event = {
    type: "request.created",
    documentId: "doc-1",
    documentTitle: "Launch plan",
    requestId: "req-7",
    by: "Burke",
    mode: "suggest",
    instruction: "Tighten this",
    quote: "A sentence that needs work.",
    actor: { id: "user-1", name: "Burke" },
    at: "2026-08-28T00:00:00.000Z",
  };
  const markdoc = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url, "http://127.0.0.1");
      if (req.method === "GET" && url.pathname === "/api/documents/doc-1") {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ document: { id: "doc-1", title: "Launch plan" }, role: "owner" }));
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/me") {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ user: { login: "burke" }, agent: "Copilot app", agentMention: { slug: "Copilot-app", unique: true }, scope: "comment", documentIds: ["doc-1"] }));
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/agent/documents/doc-1/presence") {
        let body = "";
        for await (const chunk of req) body += chunk;
        presence.push(JSON.parse(body));
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/agent/documents/doc-1/events") {
        eventReads += 1;
        await delay(5);
        // Like the server: a `wait` poll returns as soon as something is queued, else after the (shortened) wait.
        const waitS = Number(url.searchParams.get("wait") ?? 0);
        const deadline = Date.now() + Math.min(waitS, 1) * 300;
        while (eventReads > 3 && waitS > 0 && queuedEvents.length === 0 && Date.now() < deadline) await delay(5);
        const page = eventReads === 1
          ? { cursor: "cursor-1", events: [] }
          : eventReads <= 3
            ? { cursor: `cursor-${eventReads}`, events: [event] }
            : { cursor: `cursor-${eventReads}`, events: queuedEvents.splice(0) };
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(page));
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/embed/handoff") {
        handoffs += 1;
        let body = "";
        for await (const chunk of req) body += chunk;
        handoffRequest = JSON.parse(body);
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ url: `${origin}/embed/nonce`, sessionTtlMs: 300_000 }));
        return;
      }
      res.statusCode = 404;
      res.end();
    })();
  });
  const origin = await listen(markdoc);
  const sends = [];
  const eventHandlers = new Map();
  let blockSend = false;
  let releaseSend;
  const session = {
    send: async (options) => {
      sends.push(options);
      if (blockSend) await new Promise((resolve) => {
        releaseSend = resolve;
      });
      return `message-${sends.length}`;
    },
    on: (name, handler) => eventHandlers.set(name, handler),
    log: async () => {},
  };
  let canvasOptions;
  const runtime = await startMarkdocExtension({
    createCanvas: (options) => {
      canvasOptions = options;
      return options;
    },
    joinSession: async (options) => {
      assert.deepEqual(options.requestedEnvironmentVariables, ["MARKDOC_URL", "MARKDOC_TOKEN"]);
      assert.deepEqual(options.availableTools, [
        "markdoc_claim_request",
        "markdoc_read_document",
        "markdoc_comments",
        "markdoc_suggest",
        "markdoc_comment",
        "markdoc_replace_content",
        "markdoc_complete_request",
      ]);
      assert.equal(options.canvases.length, 1);
      return session;
    },
    environment: { MARKDOC_URL: origin, MARKDOC_TOKEN: "test-token-not-a-real-secret" },
  });

  try {
    assert.equal(canvasOptions.id, "markdoc-document");
    assert.deepEqual(canvasOptions.actions.map((action) => action.name), ["open_document", "focus_document", "list_open_documents"]);
    const opened = await canvasOptions.open({ instanceId: "instance-1", input: { id: "doc-1" } });
    assert.match(opened.url, /^http:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9_-]+$/);
    assert.doesNotMatch(opened.url, /test-token/);
    const shellAddress = runtime.instances.get("instance-1").server.address();
    assert(shellAddress && typeof shellAddress !== "string");
    assert.equal(shellAddress.address, "127.0.0.1");
    assert.equal(await requestWithHost(opened.url, `unrelated.invalid:${shellAddress.port}`), 421);
    const shellResponse = await fetch(opened.url);
    const shellBody = await shellResponse.text();
    assert.doesNotMatch(shellBody, /test-token/);
    assert.match(shellResponse.headers.get("content-security-policy"), /frame-src 'self'/);
    const frameResponse = await fetch(`${opened.url}/frame`, { redirect: "manual" });
    assert.equal(frameResponse.status, 302);
    assert.equal(frameResponse.headers.get("location"), `${origin}/embed/nonce`);
    assert.equal(handoffs, 1);
    assert.deepEqual(handoffRequest, { documentId: "doc-1", parentOrigin: new URL(opened.url).origin });
    const stateResponse = await fetch(`${opened.url}/state`);
    const state = await stateResponse.json();
    assert.equal(state.documentId, "doc-1");
    assert(state.sessionRefreshAt > Date.now() + 200_000);
    await until(() => sends.length === 1);
    await delay(50);
    assert.equal(sends.length, 1);
    assert.equal(sends[0].mode, "enqueue");
    assert.match(sends[0].prompt, /documentId: doc-1/);
    assert.match(sends[0].prompt, /requestId: req-7/);
    assert.match(sends[0].prompt, /quote: A sentence that needs work\./);
    assert.match(sends[0].prompt, /markdoc_claim_request/);
    assert.match(sends[0].displayPrompt, /^Markdoc: Burke asked: Tighten this in Launch plan$/);

    eventHandlers.get("session.idle")();
    queuedEvents.push(
      {
        type: "comment.added",
        documentId: "doc-1",
        documentTitle: "Launch plan",
        threadId: "thread-2",
        body: "@burke/Other-agent and @burke/Copilot-app can you check this?",
        actor: { id: "user-1", name: "Burke" },
        at: "2026-08-28T00:00:01.000Z",
      },
      {
        type: "comment.added",
        documentId: "doc-1",
        documentTitle: "Launch plan",
        threadId: "other-agent-thread",
        body: "@burke/Other-agent can you check this?",
        actor: { id: "user-1", name: "Burke" },
        at: "2026-08-28T00:00:01.000Z",
      },
      {
        type: "mention",
        documentId: "doc-1",
        documentTitle: "Launch plan",
        refId: "other-agent-thread",
        snippet: "@burke/Other-agent can you check this?",
        agent: "Other-agent",
        actor: { id: "user-1", name: "Burke" },
        at: "2026-08-28T00:00:01.000Z",
      },
      {
        type: "comment.added",
        documentId: "doc-1",
        documentTitle: "Launch plan",
        threadId: "other-user-thread",
        body: "@octocat/Copilot-app can you check this?",
        actor: { id: "user-1", name: "Burke" },
        at: "2026-08-28T00:00:01.000Z",
      },
      {
        type: "mention",
        documentId: "doc-1",
        documentTitle: "Launch plan",
        refId: "other-user-thread",
        snippet: "@octocat/Copilot-app can you check this?",
        agent: "Copilot-app",
        actor: { id: "user-1", name: "Burke" },
        at: "2026-08-28T00:00:01.000Z",
      },
      {
        type: "mention",
        documentId: "doc-1",
        documentTitle: "Launch plan",
        refId: "thread-2",
        snippet: "@burke/Other-agent and @burke/Copilot-app can you check this?",
        agent: "Other-agent",
        agents: ["Other-agent", "Copilot-app"],
        actor: { id: "user-1", name: "Burke" },
        at: "2026-08-28T00:00:01.000Z",
      },
    );
    await until(() => sends.length === 2);
    assert.equal(sends[1].mode, "immediate");
    assert.match(sends[1].prompt, /markdoc_comment/);
    assert.match(sends[1].prompt, /thread-2/);
    assert.match(sends[1].prompt, /untrusted collaborator content/);

    queuedEvents.push({
      type: "mention",
      documentId: "doc-1",
      documentTitle: "Launch plan",
      refId: "other-agent-thread",
      snippet: "@burke/Copilot-app can you check this edited mention?",
      agent: "Copilot-app",
      agents: ["Copilot-app"],
      actor: { id: "user-1", name: "Burke" },
      at: "2026-08-28T00:00:02.000Z",
    });
    await until(() => sends.length === 3);
    assert.match(sends[2].prompt, /other-agent-thread/);

    // One comment that mentions the agent = one push (#1075). The editor posts the comment first and creates the
    // request one round trip later, so `comment.added` + `mention` land in one page and `request.created` in the
    // next: the extension peeks once for it and pushes the request (claimable), not the mention.
    const readsBeforeThread9 = eventReads;
    queuedEvents.push(
      {
        type: "comment.added",
        documentId: "doc-1",
        documentTitle: "Launch plan",
        threadId: "thread-9",
        body: "@burke/Copilot-app Tighten this",
        actor: { id: "user-1", name: "Burke", kind: "user" },
        at: "2026-08-28T00:00:03.000Z",
      },
      {
        type: "mention",
        documentId: "doc-1",
        documentTitle: "Launch plan",
        refId: "thread-9",
        snippet: "@burke/Copilot-app Tighten this",
        agent: "Copilot-app",
        agents: ["Copilot-app"],
        actor: { id: "user-1", name: "Burke", kind: "user" },
        at: "2026-08-28T00:00:03.000Z",
      },
    );
    await until(() => eventReads > readsBeforeThread9 && queuedEvents.length === 0);
    queuedEvents.push({
      type: "request.created",
      documentId: "doc-1",
      documentTitle: "Launch plan",
      requestId: "req-9",
      threadId: "thread-9",
      by: "Burke",
      mode: "suggest",
      instruction: "Tighten this",
      quote: "A sentence that needs work.",
      actor: { id: "user-1", name: "Burke", kind: "user" },
      at: "2026-08-28T00:00:03.500Z",
    });
    await until(() => sends.length === 4);
    await delay(400);
    assert.equal(sends.length, 4, "comment.added + mention + request.created for one thread push once");
    assert.match(sends[3].prompt, /requestId: req-9/);
    assert.match(sends[3].prompt, /threadId: thread-9/);
    assert.match(sends[3].prompt, /markdoc_claim_request/);
    assert.match(sends[3].prompt, /asked you for work in a Markdoc comment/);
    assert.doesNotMatch(sends[3].prompt, new RegExp(["Ask an", "agent"].join(" ")));
    assert.match(sends[3].displayPrompt, /^Markdoc: Burke asked: Tighten this in Launch plan$/);

    // All three in one page: still one push, and the request's.
    queuedEvents.push(
      {
        type: "comment.added",
        documentId: "doc-1",
        documentTitle: "Launch plan",
        threadId: "thread-10",
        body: "@burke/Copilot-app is this paragraph needed?",
        actor: { id: "user-1", name: "Burke", kind: "user" },
        at: "2026-08-28T00:00:04.000Z",
      },
      {
        type: "mention",
        documentId: "doc-1",
        documentTitle: "Launch plan",
        refId: "thread-10",
        snippet: "@burke/Copilot-app is this paragraph needed?",
        agent: "Copilot-app",
        agents: ["Copilot-app"],
        actor: { id: "user-1", name: "Burke", kind: "user" },
        at: "2026-08-28T00:00:04.000Z",
      },
      {
        type: "request.created",
        documentId: "doc-1",
        documentTitle: "Launch plan",
        requestId: "req-10",
        threadId: "thread-10",
        by: "Burke",
        mode: "comment",
        instruction: "is this paragraph needed?",
        quote: null,
        actor: { id: "user-1", name: "Burke", kind: "user" },
        at: "2026-08-28T00:00:04.000Z",
      },
    );
    await until(() => sends.length === 5);
    await delay(400);
    assert.equal(sends.length, 5);
    assert.match(sends[4].prompt, /requestId: req-10/);
    assert.match(sends[4].prompt, /threadId: thread-10/);

    // A reply that mentions the agent: the mention's refId is the reply, its threadId the thread the request names
    // (#1103). One page with both → one push, the request's.
    queuedEvents.push(
      {
        type: "mention",
        documentId: "doc-1",
        documentTitle: "Launch plan",
        refId: "reply-11",
        threadId: "thread-11",
        snippet: "@burke/Copilot-app and the second paragraph?",
        agent: "Copilot-app",
        agents: ["Copilot-app"],
        actor: { id: "user-1", name: "Burke", kind: "user" },
        at: "2026-08-28T00:00:05.000Z",
      },
      {
        type: "request.created",
        documentId: "doc-1",
        documentTitle: "Launch plan",
        requestId: "req-11",
        threadId: "thread-11",
        by: "Burke",
        mode: "comment",
        instruction: "and the second paragraph?",
        quote: null,
        actor: { id: "user-1", name: "Burke", kind: "user" },
        at: "2026-08-28T00:00:05.000Z",
      },
    );
    await until(() => sends.length >= 6);
    await delay(400);
    assert.equal(sends.length, 6, "a reply mention and its request are one conversation: one push");
    assert.match(sends[5].prompt, /requestId: req-11/);
    assert.match(sends[5].prompt, /threadId: thread-11/);
    assert.match(sends[5].prompt, /markdoc_claim_request/);

    // Same reply-mention flow across two pages (the request arrives one round trip later): the peek waits for it.
    const readsBeforeReply12 = eventReads;
    queuedEvents.push({
      type: "mention",
      documentId: "doc-1",
      documentTitle: "Launch plan",
      refId: "reply-12",
      threadId: "thread-12",
      snippet: "@burke/Copilot-app one more pass?",
      agent: "Copilot-app",
      agents: ["Copilot-app"],
      actor: { id: "user-1", name: "Burke", kind: "user" },
      at: "2026-08-28T00:00:06.000Z",
    });
    await until(() => eventReads > readsBeforeReply12 && queuedEvents.length === 0);
    queuedEvents.push({
      type: "request.created",
      documentId: "doc-1",
      documentTitle: "Launch plan",
      requestId: "req-12",
      threadId: "thread-12",
      by: "Burke",
      mode: "suggest",
      instruction: "one more pass?",
      quote: "A sentence that needs work.",
      actor: { id: "user-1", name: "Burke", kind: "user" },
      at: "2026-08-28T00:00:06.500Z",
    });
    await until(() => sends.length >= 7);
    await delay(400);
    assert.equal(sends.length, 7, "reply mention, then its request one page later: one push");
    assert.match(sends[6].prompt, /requestId: req-12/);
    assert.match(sends[6].prompt, /threadId: thread-12/);

    // A reply mention with no request behind it is pushed on its own and names the thread to answer in.
    queuedEvents.push({
      type: "mention",
      documentId: "doc-1",
      documentTitle: "Launch plan",
      refId: "reply-13",
      threadId: "thread-13",
      snippet: "@burke/Copilot-app thanks!",
      agent: "Copilot-app",
      agents: ["Copilot-app"],
      actor: { id: "user-1", name: "Burke", kind: "user" },
      at: "2026-08-28T00:00:07.000Z",
    });
    await until(() => sends.length >= 8);
    assert.match(sends[7].prompt, /refId: reply-13/);
    assert.match(sends[7].prompt, /threadId: thread-13/);
    assert.match(sends[7].prompt, /markdoc_comment/);

    // Legacy server (no threadId on mentions): a reply mention is still keyed by its refId, so it and its request
    // push separately exactly as before, and a repeat of the same mention is still deduplicated.
    const legacyMention = {
      type: "mention",
      documentId: "doc-1",
      documentTitle: "Launch plan",
      refId: "reply-legacy",
      snippet: "@burke/Copilot-app legacy reply",
      agent: "Copilot-app",
      agents: ["Copilot-app"],
      actor: { id: "user-1", name: "Burke", kind: "user" },
      at: "2026-08-28T00:00:08.000Z",
    };
    queuedEvents.push(legacyMention, {
      type: "request.created",
      documentId: "doc-1",
      documentTitle: "Launch plan",
      requestId: "req-legacy",
      threadId: "thread-legacy",
      by: "Burke",
      mode: "comment",
      instruction: "legacy reply",
      quote: null,
      actor: { id: "user-1", name: "Burke", kind: "user" },
      at: "2026-08-28T00:00:08.000Z",
    });
    await until(() => sends.length >= 10);
    await delay(400);
    assert.equal(sends.length, 10, "without threadId the extension cannot relate a reply mention to its request: two pushes, as before");
    assert.match(sends[8].prompt, /requestId: req-legacy/);
    assert.match(sends[9].prompt, /refId: reply-legacy/);
    assert.doesNotMatch(sends[9].prompt, /threadId:/);
    const readsBeforeRepeat = eventReads;
    queuedEvents.push({ ...legacyMention, snippet: "@burke/Copilot-app legacy reply (edited)", at: "2026-08-28T00:00:09.000Z" });
    await until(() => eventReads > readsBeforeRepeat + 1 && queuedEvents.length === 0);
    await delay(400);
    assert.equal(sends.length, 10, "a legacy mention is keyed by refId: the same ref does not push twice");

    await assert.rejects(
      canvasOptions.open({ instanceId: "instance-2", input: { id: "doc-1" } }),
      /Only one Markdoc canvas/,
    );
    assert.equal(runtime.instances.size, 1);
    assert.equal(runtime.instances.has("instance-1"), true);
    assert.equal(runtime.instances.has("instance-2"), false);
    const reopened = await canvasOptions.open({ instanceId: "instance-1", input: { id: "doc-1" } });
    assert.equal(reopened.url, opened.url);
    assert.equal(runtime.instances.size, 1);
    blockSend = true;
    queuedEvents.push(
      {
        type: "comment.added",
        documentId: "doc-1",
        documentTitle: "Launch plan",
        threadId: "closing-thread-1",
        body: "First closing comment",
        actor: { id: "user-1", name: "Burke" },
        at: "2026-08-28T00:00:02.000Z",
      },
      {
        type: "comment.added",
        documentId: "doc-1",
        documentTitle: "Launch plan",
        threadId: "closing-thread-2",
        body: "Second closing comment",
        actor: { id: "user-1", name: "Burke" },
        at: "2026-08-28T00:00:03.000Z",
      },
    );
    await until(() => sends.length === 11);
    const closing = canvasOptions.onClose({ instanceId: "instance-1" });
    await delay(20);
    releaseSend();
    await closing;
    await delay(20);
    assert.equal(sends.length, 11);
    assert.equal(runtime.instances.size, 0);
    assert.deepEqual(presence.map((item) => item.state), ["idle", "left"]);
  } finally {
    for (const entry of runtime.instances.values()) await canvasOptions.onClose({ instanceId: entry.instanceId });
    await close(markdoc);
  }
});
