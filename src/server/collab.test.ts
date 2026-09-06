import { describe, expect, it, beforeAll, afterAll, afterEach, vi } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import WebSocket, { WebSocketServer } from "ws";
import * as Y from "yjs";
import { eq } from "drizzle-orm";
import { SignJWT, errors as joseErrors } from "jose";
import { HocuspocusProvider, HocuspocusProviderWebsocket } from "@hocuspocus/provider";
import { MarkdocProvider } from "@/editor/collab/provider";

process.env.PGLITE_DATA_DIR = "memory://";
process.env.AUTH_SECRET = "test-secret-test-secret-test-secret";
delete process.env.DATABASE_URL;

const { getDb, schema } = await import("./db");
const { createCollabServer, hydrateDoc, shutdownCollab, TEXT_KEY } = await import("./collab/hocuspocus");
const { attachCollab, protectUpgradePath } = await import("./collab/ws");
const { collabTokenFailureMessage, signCollabToken, verifyCollabToken } = await import("./collab/token");
const { registerCollab } = await import("./collab/registry");
const { createDocument, removeCollaborator, updateDocument, upsertCollaborator } = await import("./documents");
const { changeCollaboratorAccess, changeLinkAccess, collabAccessChangeBlocks } = await import("./collab/authorization");
const { createApiToken } = await import("./tokens");

function waitFor(check: () => boolean, timeout = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (check()) return resolve();
      if (Date.now() - start > timeout) return reject(new Error("timeout"));
      setTimeout(tick, 20);
    };
    tick();
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function withTimeout<T>(promise: Promise<T>, timeout = 1000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("timed out waiting for concurrent collaboration work")), timeout);
  });
  try {
    return await Promise.race([promise, expired]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Classify one Hocuspocus wire message: `sync-step1|2`, `update`, `awareness`, `auth`, `sync-status`, … */
function describeMessage(data: ArrayBuffer | Uint8Array): { type: string; bytes: number } {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  let i = 0;
  let nameLength = 0;
  let shift = 0;
  for (;;) {
    const b = bytes[i++];
    nameLength |= (b & 0x7f) << shift;
    if (b < 0x80) break;
    shift += 7;
  }
  i += nameLength;
  const kind = bytes[i];
  const type = kind === 0 ? ["sync-step1", "sync-step2", "update"][bytes[i + 1]] ?? "sync-?" : ({ 1: "awareness", 2: "auth", 5: "stateless", 8: "sync-status" } as Record<number, string>)[kind] ?? `type-${kind}`;
  return { type, bytes: bytes.byteLength };
}

const countBy = (messages: { type: string }[]) => messages.reduce<Record<string, number>>((acc, m) => ((acc[m.type] = (acc[m.type] ?? 0) + 1), acc), {});

describe("collaboration server", () => {
  let server: Server;
  let url: string;
  let hocuspocus: ReturnType<typeof createCollabServer>;
  let userId: string;
  let docId: string;
  const warmClientDisposers = new Set<() => void>();

  afterEach(() => {
    for (const dispose of warmClientDisposers) dispose();
  });

  beforeAll(async () => {
    const db = await getDb();
    const [user] = await db.insert(schema.users).values({ name: "Alice", login: "alice", email: "alice@example.com" }).returning();
    userId = user.id;
    const doc = await createDocument({ ownerId: userId, content: "# Hello\n\nWorld." });
    docId = doc.id;

    hocuspocus = createCollabServer();
    registerCollab(hocuspocus);
    hocuspocus.configuration.debounce = 50;
    hocuspocus.configuration.maxDebounce = 100;
    server = createServer((_req, res) => {
      res.statusCode = 404;
      res.end();
    });
    attachCollab(server, hocuspocus, { path: "/collab" });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const { port } = server.address() as AddressInfo;
    url = `ws://127.0.0.1:${port}/collab`;
  });

  afterAll(async () => {
    await shutdownCollab(hocuspocus);
    await new Promise<void>((r) => server.close(() => r()));
  });

  function connect(token: string, name = docId) {
    const ydoc = new Y.Doc();
    const socket = new HocuspocusProviderWebsocket({ url, WebSocketPolyfill: WebSocket as unknown as typeof globalThis.WebSocket });
    const received: { type: string; bytes: number }[] = [];
    const provider = new HocuspocusProvider({
      websocketProvider: socket,
      name,
      document: ydoc,
      token,
      onMessage: ({ message }) => received.push(describeMessage((message as unknown as { data: ArrayBuffer | Uint8Array }).data)),
    });
    provider.attach();
    return { ydoc, provider, socket, received };
  }

  it("loads the document from the database and syncs two clients", async () => {
    const token = await signCollabToken({ userId, docId, role: "owner", name: "Alice", login: "alice", avatar: null });
    const a = connect(token);
    const b = connect(token);
    await waitFor(() => a.provider.isSynced && b.provider.isSynced);
    expect(a.ydoc.getText("content").toString()).toBe("# Hello\n\nWorld.");
    expect(a.ydoc.getMap("meta").get("title")).toBe("Hello");

    a.ydoc.getText("content").insert(a.ydoc.getText("content").length, " More.");
    await waitFor(() => b.ydoc.getText("content").toString().endsWith(" More."));

    // Persisted (debounced) to the database.
    const db = await getDb();
    await waitFor(() => false, 300).catch(() => {});
    const [row] = await db.select().from(schema.documents).where(eq(schema.documents.id, docId));
    expect(row.content).toBe("# Hello\n\nWorld. More.");
    expect(row.ystate?.byteLength).toBeGreaterThan(0);

    // Reloading state from the stored update yields the same text.
    const fresh = new Y.Doc();
    hydrateDoc(fresh, row.ystate!, row.content, row.title);
    expect(fresh.getText("content").toString()).toBe("# Hello\n\nWorld. More.");

    a.provider.destroy();
    b.provider.destroy();
    a.socket.destroy();
    b.socket.destroy();
  });

  it("rejects invalid tokens and tokens for other documents", async () => {
    const bad = connect("not-a-token");
    let failed = false;
    bad.provider.on("authenticationFailed", () => (failed = true));
    await waitFor(() => failed);
    bad.provider.destroy();
    bad.socket.destroy();

    const other = await signCollabToken({ userId, docId: "someone-else", role: "owner", name: "A", login: null, avatar: null });
    const mismatch = connect(other);
    let failed2 = false;
    mismatch.provider.on("authenticationFailed", () => (failed2 = true));
    await waitFor(() => failed2);
    mismatch.provider.destroy();
    mismatch.socket.destroy();
  });

  describe("token failure reasons in the server log (task #988)", () => {
    const claims = () => ({ userId, docId, role: "owner" as const, name: "Alice", login: "alice", avatar: null });
    /** A token shaped like `signCollabToken`'s but signed with `secret` for `audience`. */
    const mint = (secret: string, audience: string) =>
      new SignJWT({ ...claims(), version: 2, principal: "user" })
        .setProtectedHeader({ alg: "HS256" })
        .setIssuedAt()
        .setSubject(userId)
        .setAudience(audience)
        .setExpirationTime("1h")
        .sign(new TextEncoder().encode(secret));

    const cases: [kind: string, token: () => Promise<string>, logged: string][] = [
      ["expired (a tab reconnecting after a release)", () => signCollabToken(claims(), -60), "Invalid token (expired)"],
      ["claims (wrong audience)", () => mint(process.env.AUTH_SECRET!, "not-markdoc-collab"), "Invalid token (claims)"],
      ["signature (minted with another secret)", () => mint("another-secret-another-secret-another", "markdoc-collab-v2"), "Invalid token (signature)"],
      ["other (not a JWT at all — what the release:verify probe sends)", async () => "not-a-token", "Invalid token (malformed)"],
    ];

    it.each(cases)("%s: the log says why, the client still only sees permission-denied", async (_kind, mintToken, logged) => {
      const token = await mintToken();
      const failure = await verifyCollabToken(token).then(() => null, (err: unknown) => err);
      expect(failure).not.toBeNull();
      expect(collabTokenFailureMessage(failure)).toBe(logged);

      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const client = connect(token);
        let reason: string | null = null;
        client.provider.on("authenticationFailed", ({ reason: r }: { reason: string }) => (reason = r));
        await waitFor(() => reason !== null);
        client.provider.destroy();
        client.socket.destroy();
        expect(reason).toBe("permission-denied");
        // Exactly one `[onAuthenticate] …` line (Hocuspocus's own format), carrying the reason and nothing else.
        expect(error.mock.calls.filter((call) => call[0] === "[onAuthenticate]")).toEqual([["[onAuthenticate]", logged]]);
        const everything = JSON.stringify(error.mock.calls);
        expect(everything).not.toContain(token);
        expect(everything).not.toContain("alice");
        expect(everything).not.toContain(docId);
      } finally {
        error.mockRestore();
      }
    });

    it("a well-signed token that is not a collaboration token is the (shape) line; unknown causes stay bare", async () => {
      const notCollab = await new SignJWT({ userId, role: "owner" }).setProtectedHeader({ alg: "HS256" }).setAudience("markdoc-collab-v2").setExpirationTime("1h").sign(new TextEncoder().encode(process.env.AUTH_SECRET!));
      const failure = await verifyCollabToken(notCollab).then(() => null, (err: unknown) => err);
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toBe("Invalid collaboration token");
      expect(collabTokenFailureMessage(failure)).toBe("Invalid token (shape)");
      expect(collabTokenFailureMessage(undefined)).toBe("Invalid token");
    });

    // Task #1445 (#1423 triage row 14): the fall-through line is split so the release:verify probe
    // (`(malformed)`) and a suspicious wrong-shape token (`(shape)`) no longer print the same line.
    const byCause: [kind: string, logged: string, error: () => unknown][] = [
      ["a jose JWSInvalid (not a compact JWS)", "Invalid token (malformed)", () => new joseErrors.JWSInvalid("Invalid Compact JWS")],
      ["a jose JWTInvalid (a JWS that is not a JWT)", "Invalid token (malformed)", () => new joseErrors.JWTInvalid("JWT Claims Set must be a top-level JSON object")],
      ["this module's own wrong-shape rejection", "Invalid token (shape)", () => new Error("Invalid collaboration token")],
      ["an unrelated error", "Invalid token", () => new Error("boom")],
    ];

    it.each(byCause)("%s → %s", (_kind, logged, error) => {
      expect(collabTokenFailureMessage(error())).toBe(logged);
    });
  });

  it("owns upgrade routing so collaboration is handled once and HMR reaches Next", async () => {
    const nextServer = new WebSocketServer({ noServer: true });
    const routed = createServer((_req, res) => {
      res.statusCode = 404;
      res.end();
    });
    let collabConnections = 0;
    const protectCollab = protectUpgradePath(routed, "/collab");
    let nextUpgrades = 0;
    routed.on("upgrade", (req, socket, head) => {
      nextUpgrades++;
      nextServer.handleUpgrade(req, socket, head, (ws) => nextServer.emit("connection", ws, req));
    });
    protectCollab();
    const collabServer = attachCollab(routed, hocuspocus, { path: "/collab" });
    collabServer.on("connection", () => collabConnections++);
    await new Promise<void>((resolve) => routed.listen(0, "127.0.0.1", resolve));
    const { port } = routed.address() as AddressInfo;
    const collabClient = new WebSocket(`ws://127.0.0.1:${port}/collab`);
    const hmrClient = new WebSocket(`ws://127.0.0.1:${port}/_next/hmr`);

    try {
      await Promise.all(
        [collabClient, hmrClient].map(
          (client) =>
            new Promise<void>((resolve, reject) => {
              const timeout = setTimeout(() => reject(new Error("WebSocket upgrade timed out")), 2_000);
              client.once("open", () => {
                clearTimeout(timeout);
                resolve();
              });
              client.once("error", (err) => {
                clearTimeout(timeout);
                reject(err);
              });
            }),
        ),
      );
      expect(routed.listenerCount("upgrade")).toBe(2);
      expect(collabConnections).toBe(1);
      expect(nextUpgrades).toBe(1);
    } finally {
      collabClient.close();
      hmrClient.close();
      nextServer.close();
      await new Promise<void>((resolve) => routed.close(() => resolve()));
    }
  });

  it("bootstraps a non-collaboration upgrade before another listener is attached", async () => {
    const nextServer = new WebSocketServer({ noServer: true });
    const routed = createServer();
    attachCollab(routed, hocuspocus, {
      path: "/collab",
      fallback: (req, socket, head) => nextServer.handleUpgrade(req, socket, head, (ws) => nextServer.emit("connection", ws, req)),
    });
    await new Promise<void>((resolve) => routed.listen(0, "127.0.0.1", resolve));
    const { port } = routed.address() as AddressInfo;
    const client = new WebSocket(`ws://127.0.0.1:${port}/_next/hmr`);

    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("bootstrap HMR upgrade timed out")), 2_000);
        client.once("open", () => {
          clearTimeout(timeout);
          resolve();
        });
        client.once("error", (err) => {
          clearTimeout(timeout);
          reject(err);
        });
      });
    } finally {
      client.close();
      nextServer.close();
      await new Promise<void>((resolve) => routed.close(() => resolve()));
    }
  });

  it("closes an unhandled upgrade when no fallback or other listener exists", async () => {
    const routed = createServer();
    attachCollab(routed, hocuspocus, { path: "/collab" });
    await new Promise<void>((resolve) => routed.listen(0, "127.0.0.1", resolve));
    const { port } = routed.address() as AddressInfo;
    const client = new WebSocket(`ws://127.0.0.1:${port}/other`);

    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("unhandled upgrade was not closed")), 2_000);
        client.once("error", () => {
          clearTimeout(timeout);
          resolve();
        });
        client.once("open", () => {
          clearTimeout(timeout);
          reject(new Error("unhandled upgrade unexpectedly opened"));
        });
      });
    } finally {
      client.close();
      await new Promise<void>((resolve) => routed.close(() => resolve()));
    }
  });

  it("makes viewers read-only", async () => {
    const db = await getDb();
    const [viewer] = await db.insert(schema.users).values({ name: "Viewer", login: "viewer", email: "viewer@example.com" }).returning();
    await upsertCollaborator(docId, viewer.login!, "viewer", userId);
    const token = await signCollabToken({ userId: viewer.id, docId, role: "viewer", name: viewer.name!, login: viewer.login, avatar: null });
    const v = connect(token);
    await waitFor(() => v.provider.isSynced);
    expect(v.provider.isAuthenticated).toBe(true);
    expect(v.provider.authorizedScope).toBe("readonly");
    v.provider.destroy();
    v.socket.destroy();
  });

  it("settles a token-backed pending message and access transition without deadlocking", async () => {
    const db = await getDb();
    const [owner] = await db.insert(schema.users).values({ name: "Transition owner", login: "transition-owner", email: "transition-owner@example.com" }).returning();
    const [editor] = await db.insert(schema.users).values({ name: "Transition editor", login: "transition-editor", email: "transition-editor@example.com" }).returning();
    const doc = await createDocument({ ownerId: owner.id, content: "Pending" });
    await upsertCollaborator(doc.id, editor.login!, "editor", owner.id);
    const apiToken = await createApiToken(editor.id, "Transition agent", { scope: "full", documentIds: [doc.id] });
    const token = await signCollabToken({
      userId: editor.id,
      docId: doc.id,
      role: "editor",
      name: editor.name!,
      login: editor.login,
      avatar: null,
      tokenId: apiToken.id,
      tokenScope: apiToken.scope,
      tokenExpiresAt: apiToken.expiresAt?.getTime() ?? null,
    });
    const client = connect(token, doc.id);
    await waitFor(() => client.provider.isSynced);
    const connection = hocuspocus.documents.get(doc.id)?.getConnections().find((candidate) => candidate.context.tokenId === apiToken.id);
    expect(connection).toBeDefined();
    if (!connection) throw new Error("token-backed collaboration connection was not registered");

    const originalBeforeHandleMessage = connection.callbacks.beforeHandleMessage;
    let releasePending!: () => void;
    const pendingReleased = new Promise<void>((resolve) => {
      releasePending = resolve;
    });
    let markPending!: () => void;
    const pendingStarted = new Promise<void>((resolve) => {
      markPending = resolve;
    });
    let held = false;
    connection.callbacks.beforeHandleMessage = async (candidate, update) => {
      if (!held) {
        held = true;
        markPending();
        await pendingReleased;
      }
      return originalBeforeHandleMessage(candidate, update);
    };

    try {
      client.ydoc.getText(TEXT_KEY).insert(client.ydoc.getText(TEXT_KEY).length, " message");
      await withTimeout(pendingStarted);
      const transition = changeCollaboratorAccess(doc.id, editor.login!, "viewer", async () => {
        await upsertCollaborator(doc.id, editor.login!, "viewer", owner.id);
      });
      await waitFor(() => collabAccessChangeBlocks(connection), 1000);
      releasePending();
      await withTimeout(Promise.all([transition, connection.waitForPendingMessages()]));
      expect(connection.readOnly).toBe(true);
      expect(connection.context.role).toBe("viewer");
    } finally {
      releasePending();
      client.provider.destroy();
      client.socket.destroy();
    }
  });

  it("revokes stale editor sockets and tokens, then permits a newly shared editor", async () => {
    const db = await getDb();
    const [owner] = await db.insert(schema.users).values({ name: "Revocation owner", login: "revoke-owner", email: "revoke-owner@example.com" }).returning();
    const [editor] = await db.insert(schema.users).values({ name: "Revoked editor", login: "revoked-editor", email: "revoked-editor@example.com" }).returning();
    const doc = await createDocument({ ownerId: owner.id, content: "Start" });
    await upsertCollaborator(doc.id, editor.login!, "editor", owner.id);

    const ownerToken = await signCollabToken({ userId: owner.id, docId: doc.id, role: "owner", name: owner.name!, login: owner.login, avatar: null });
    const staleEditorToken = await signCollabToken({
      userId: editor.id,
      docId: doc.id,
      role: "editor",
      name: editor.name!,
      login: editor.login,
      avatar: null,
    });
    const ownerClient = connect(ownerToken, doc.id);
    const editorClient = connect(staleEditorToken, doc.id);
    await waitFor(() => ownerClient.provider.isSynced && editorClient.provider.isSynced);

    editorClient.ydoc.getText(TEXT_KEY).insert(5, " before");
    await waitFor(() => ownerClient.ydoc.getText(TEXT_KEY).toString() === "Start before");
    await changeCollaboratorAccess(doc.id, editor.login!, null, async () => {
      await removeCollaborator(doc.id, editor.login!);
    });

    const [afterRemoval] = await db.select().from(schema.documents).where(eq(schema.documents.id, doc.id));
    expect(afterRemoval.content).toBe("Start before");
    await waitFor(() => !hocuspocus.documents.get(doc.id)?.getConnections().some((connection) => connection.context.userId === editor.id));

    editorClient.ydoc.getText(TEXT_KEY).insert(editorClient.ydoc.getText(TEXT_KEY).length, " rejected");
    await sleep(150);
    expect(ownerClient.ydoc.getText(TEXT_KEY).toString()).toBe("Start before");
    const [afterRejectedEdit] = await db.select().from(schema.documents).where(eq(schema.documents.id, doc.id));
    expect(afterRejectedEdit.content).toBe("Start before");

    const replay = connect(staleEditorToken, doc.id);
    let replayRejected = false;
    replay.provider.on("authenticationFailed", () => (replayRejected = true));
    await waitFor(() => replayRejected);

    await changeCollaboratorAccess(doc.id, editor.login!, "editor", async () => {
      await upsertCollaborator(doc.id, editor.login!, "editor", owner.id);
    });
    const freshEditorToken = await signCollabToken({
      userId: editor.id,
      docId: doc.id,
      role: "editor",
      name: editor.name!,
      login: editor.login,
      avatar: null,
    });
    const reshared = connect(freshEditorToken, doc.id);
    await waitFor(() => reshared.provider.isSynced);
    reshared.ydoc.getText(TEXT_KEY).insert(reshared.ydoc.getText(TEXT_KEY).length, " restored");
    await waitFor(() => ownerClient.ydoc.getText(TEXT_KEY).toString() === "Start before restored");

    for (const client of [ownerClient, editorClient, replay, reshared]) {
      client.provider.destroy();
      client.socket.destroy();
    }
  });

  it("downgrades only the affected editor after flushing their accepted update", async () => {
    const db = await getDb();
    const [owner] = await db.insert(schema.users).values({ name: "Downgrade owner", login: "downgrade-owner", email: "downgrade-owner@example.com" }).returning();
    const [editor] = await db.insert(schema.users).values({ name: "Downgraded editor", login: "downgraded-editor", email: "downgraded-editor@example.com" }).returning();
    const doc = await createDocument({ ownerId: owner.id, content: "Base" });
    await upsertCollaborator(doc.id, editor.login!, "editor", owner.id);

    const ownerClient = connect(
      await signCollabToken({ userId: owner.id, docId: doc.id, role: "owner", name: owner.name!, login: owner.login, avatar: null }),
      doc.id,
    );
    const staleEditorToken = await signCollabToken({
      userId: editor.id,
      docId: doc.id,
      role: "editor",
      name: editor.name!,
      login: editor.login,
      avatar: null,
    });
    const editorClient = connect(staleEditorToken, doc.id);
    await waitFor(() => ownerClient.provider.isSynced && editorClient.provider.isSynced);

    editorClient.ydoc.getText(TEXT_KEY).insert(4, " accepted");
    await waitFor(() => ownerClient.ydoc.getText(TEXT_KEY).toString() === "Base accepted");
    await changeCollaboratorAccess(doc.id, editor.login!, "viewer", async () => {
      await upsertCollaborator(doc.id, editor.login!, "viewer", owner.id);
    });

    const editorConnection = hocuspocus.documents.get(doc.id)?.getConnections().find((connection) => connection.context.userId === editor.id);
    expect(editorConnection?.readOnly).toBe(true);
    const [afterDowngrade] = await db.select().from(schema.documents).where(eq(schema.documents.id, doc.id));
    expect(afterDowngrade.content).toBe("Base accepted");

    editorClient.ydoc.getText(TEXT_KEY).insert(editorClient.ydoc.getText(TEXT_KEY).length, " rejected");
    await sleep(150);
    expect(ownerClient.ydoc.getText(TEXT_KEY).toString()).toBe("Base accepted");
    const [afterRejectedEdit] = await db.select().from(schema.documents).where(eq(schema.documents.id, doc.id));
    expect(afterRejectedEdit.content).toBe("Base accepted");

    const replay = connect(staleEditorToken, doc.id);
    await waitFor(() => replay.provider.isSynced);
    expect(replay.provider.authorizedScope).toBe("readonly");
    replay.ydoc.getText(TEXT_KEY).insert(replay.ydoc.getText(TEXT_KEY).length, " replayed");
    await sleep(150);
    expect(ownerClient.ydoc.getText(TEXT_KEY).toString()).toBe("Base accepted");

    ownerClient.ydoc.getText(TEXT_KEY).insert(ownerClient.ydoc.getText(TEXT_KEY).length, " owner");
    await waitFor(() => editorClient.ydoc.getText(TEXT_KEY).toString().includes(" owner"));
    expect(ownerClient.ydoc.getText(TEXT_KEY).toString()).toBe("Base accepted owner");

    await changeCollaboratorAccess(doc.id, editor.login!, "editor", async () => {
      await upsertCollaborator(doc.id, editor.login!, "editor", owner.id);
    });
    const upgraded = connect(
      await signCollabToken({ userId: editor.id, docId: doc.id, role: "editor", name: editor.name!, login: editor.login, avatar: null }),
      doc.id,
    );
    await waitFor(() => upgraded.provider.isSynced);
    upgraded.ydoc.getText(TEXT_KEY).insert(upgraded.ydoc.getText(TEXT_KEY).length, " upgraded");
    await waitFor(() => ownerClient.ydoc.getText(TEXT_KEY).toString().endsWith(" upgraded"));

    for (const client of [ownerClient, editorClient, replay, upgraded]) {
      client.provider.destroy();
      client.socket.destroy();
    }
  });

  it("closes link editors and anonymous viewers when the owner restricts the link; owner and collaborators keep editing", async () => {
    const db = await getDb();
    const [owner] = await db.insert(schema.users).values({ name: "Link owner", login: "link-owner", email: "link-owner@example.com" }).returning();
    const [guest] = await db.insert(schema.users).values({ name: "Link guest", login: "link-guest", email: "link-guest@example.com" }).returning();
    const [collab] = await db.insert(schema.users).values({ name: "Link collab", login: "link-collab", email: "link-collab@example.com" }).returning();
    const doc = await createDocument({ ownerId: owner.id, content: "Start" });
    await updateDocument(doc.id, { linkAccess: "edit" });
    await upsertCollaborator(doc.id, collab.login!, "editor", owner.id);

    const ownerClient = connect(
      await signCollabToken({ userId: owner.id, docId: doc.id, role: "owner", name: owner.name!, login: owner.login, avatar: null }),
      doc.id,
    );
    const collabClient = connect(
      await signCollabToken({ userId: collab.id, docId: doc.id, role: "editor", name: collab.name!, login: collab.login, avatar: null }),
      doc.id,
    );
    // What POST /collab-token mints for a signed-in non-collaborator on an edit link, and for an anonymous visitor.
    const guestToken = await signCollabToken({ userId: guest.id, docId: doc.id, role: "editor", name: guest.name!, login: guest.login, avatar: null });
    const guestClient = connect(guestToken, doc.id);
    const anonId = "anon-link-test";
    const anonClient = connect(await signCollabToken({ userId: anonId, docId: doc.id, role: "viewer", name: "Anonymous", login: null, avatar: null }), doc.id);
    await waitFor(() => [ownerClient, collabClient, guestClient, anonClient].every((c) => c.provider.isSynced));
    expect(guestClient.provider.authorizedScope).toBe("read-write");
    expect(anonClient.provider.authorizedScope).toBe("readonly");

    guestClient.ydoc.getText(TEXT_KEY).insert(5, " guest");
    await waitFor(() => ownerClient.ydoc.getText(TEXT_KEY).toString() === "Start guest" && anonClient.ydoc.getText(TEXT_KEY).toString() === "Start guest");

    const changedAt = Date.now();
    await changeLinkAccess(doc.id, "private", async () => {
      await updateDocument(doc.id, { linkAccess: "private" });
    });

    // The edit accepted before the change is stored; both link visitors are gone within a second.
    const [afterClose] = await db.select().from(schema.documents).where(eq(schema.documents.id, doc.id));
    expect(afterClose.content).toBe("Start guest");
    expect(afterClose.linkAccess).toBe("private");
    const linkVisitor = (connection: { context: { userId: string } }) => connection.context.userId === guest.id || connection.context.userId === anonId;
    await waitFor(() => !hocuspocus.documents.get(doc.id)?.getConnections().some(linkVisitor), 1000);
    expect(Date.now() - changedAt).toBeLessThan(1000);
    const remaining = hocuspocus.documents.get(doc.id)!.getConnections();
    expect(remaining.map((c) => c.context.userId).sort()).toEqual([owner.id, collab.id].sort());
    expect(remaining.every((c) => !c.readOnly)).toBe(true);

    guestClient.ydoc.getText(TEXT_KEY).insert(guestClient.ydoc.getText(TEXT_KEY).length, " AFTER-REVOKE");
    await sleep(150);
    expect(ownerClient.ydoc.getText(TEXT_KEY).toString()).toBe("Start guest");
    expect(anonClient.ydoc.getText(TEXT_KEY).toString()).toBe("Start guest");
    const [afterRejectedEdit] = await db.select().from(schema.documents).where(eq(schema.documents.id, doc.id));
    expect(afterRejectedEdit.content).toBe("Start guest");

    // A replayed pre-change token is refused too.
    const replay = connect(guestToken, doc.id);
    let replayRejected = false;
    replay.provider.on("authenticationFailed", () => (replayRejected = true));
    await waitFor(() => replayRejected);

    // Owner and the explicit collaborator were never affected.
    ownerClient.ydoc.getText(TEXT_KEY).insert(ownerClient.ydoc.getText(TEXT_KEY).length, " owner");
    await waitFor(() => collabClient.ydoc.getText(TEXT_KEY).toString() === "Start guest owner");
    collabClient.ydoc.getText(TEXT_KEY).insert(collabClient.ydoc.getText(TEXT_KEY).length, " collab");
    await waitFor(() => ownerClient.ydoc.getText(TEXT_KEY).toString() === "Start guest owner collab");
    expect(anonClient.ydoc.getText(TEXT_KEY).toString()).toBe("Start guest");

    for (const client of [ownerClient, collabClient, guestClient, anonClient, replay]) {
      client.provider.destroy();
      client.socket.destroy();
    }
  });

  it("downgrades link editors to read-only on edit → view / comment and keeps a collaborator who also used the link", async () => {
    const db = await getDb();
    const [owner] = await db.insert(schema.users).values({ name: "Link downgrade owner", login: "link-dg-owner", email: "link-dg-owner@example.com" }).returning();
    const [guest] = await db.insert(schema.users).values({ name: "Link downgrade guest", login: "link-dg-guest", email: "link-dg-guest@example.com" }).returning();
    const [collab] = await db.insert(schema.users).values({ name: "Link downgrade collab", login: "link-dg-collab", email: "link-dg-collab@example.com" }).returning();
    const doc = await createDocument({ ownerId: owner.id, content: "Base" });
    await updateDocument(doc.id, { linkAccess: "edit" });
    await upsertCollaborator(doc.id, collab.login!, "editor", owner.id);

    const ownerClient = connect(
      await signCollabToken({ userId: owner.id, docId: doc.id, role: "owner", name: owner.name!, login: owner.login, avatar: null }),
      doc.id,
    );
    const guestToken = await signCollabToken({ userId: guest.id, docId: doc.id, role: "editor", name: guest.name!, login: guest.login, avatar: null });
    const guestClient = connect(guestToken, doc.id);
    // A collaborator who opened the document through the same edit link: access derives from the share, not the link.
    const collabClient = connect(
      await signCollabToken({ userId: collab.id, docId: doc.id, role: "editor", name: collab.name!, login: collab.login, avatar: null }),
      doc.id,
    );
    await waitFor(() => [ownerClient, guestClient, collabClient].every((c) => c.provider.isSynced));

    guestClient.ydoc.getText(TEXT_KEY).insert(4, " accepted");
    await waitFor(() => ownerClient.ydoc.getText(TEXT_KEY).toString() === "Base accepted");
    await changeLinkAccess(doc.id, "view", async () => {
      await updateDocument(doc.id, { linkAccess: "view" });
    });

    const connectionOf = (id: string) => hocuspocus.documents.get(doc.id)?.getConnections().find((connection) => connection.context.userId === id);
    expect(connectionOf(guest.id)?.readOnly).toBe(true);
    expect(connectionOf(guest.id)?.context.role).toBe("viewer");
    expect(connectionOf(collab.id)?.readOnly).toBe(false);
    const [afterDowngrade] = await db.select().from(schema.documents).where(eq(schema.documents.id, doc.id));
    expect(afterDowngrade.content).toBe("Base accepted");

    guestClient.ydoc.getText(TEXT_KEY).insert(guestClient.ydoc.getText(TEXT_KEY).length, " rejected");
    await sleep(150);
    expect(ownerClient.ydoc.getText(TEXT_KEY).toString()).toBe("Base accepted");
    const [afterRejectedEdit] = await db.select().from(schema.documents).where(eq(schema.documents.id, doc.id));
    expect(afterRejectedEdit.content).toBe("Base accepted");

    // A replayed pre-change token connects read-only now.
    const replay = connect(guestToken, doc.id);
    await waitFor(() => replay.provider.isSynced);
    expect(replay.provider.authorizedScope).toBe("readonly");

    // Signed-in link visitors stay connected as commenters on a comment link.
    await changeLinkAccess(doc.id, "comment", async () => {
      await updateDocument(doc.id, { linkAccess: "comment" });
    });
    expect(connectionOf(guest.id)?.readOnly).toBe(true);
    expect(connectionOf(guest.id)?.context.role).toBe("commenter");
    const guestConnections = hocuspocus.documents.get(doc.id)!.getConnections().filter((connection) => connection.context.userId === guest.id);
    expect(guestConnections).toHaveLength(2);
    expect(guestConnections.every((connection) => connection.readOnly && connection.context.role === "commenter")).toBe(true);

    // They still follow the document live, and the collaborator keeps editing.
    collabClient.ydoc.getText(TEXT_KEY).insert(collabClient.ydoc.getText(TEXT_KEY).length, " collab");
    await waitFor(() => ownerClient.ydoc.getText(TEXT_KEY).toString() === "Base accepted collab");
    await waitFor(() => replay.ydoc.getText(TEXT_KEY).toString() === "Base accepted collab");

    // Re-opening the link restores editing for a fresh link session.
    await changeLinkAccess(doc.id, "edit", async () => {
      await updateDocument(doc.id, { linkAccess: "edit" });
    });
    expect(connectionOf(guest.id)?.readOnly).toBe(false);
    const reopened = connect(guestToken, doc.id);
    await waitFor(() => reopened.provider.isSynced);
    reopened.ydoc.getText(TEXT_KEY).insert(reopened.ydoc.getText(TEXT_KEY).length, " reopened");
    await waitFor(() => ownerClient.ydoc.getText(TEXT_KEY).toString().endsWith(" reopened"));

    for (const client of [ownerClient, guestClient, collabClient, replay, reopened]) {
      client.provider.destroy();
      client.socket.destroy();
    }
  });

  it("sends the initial state once and never echoes a client's own updates or awareness (task #480)", async () => {
    // A body large enough that a second copy of the state is unmistakable in the byte counts.
    const body = `# Traffic\n\n${"lorem ipsum dolor sit amet. ".repeat(2000)}`;
    const doc = await createDocument({ ownerId: userId, content: body });
    const token = await signCollabToken({ userId, docId: doc.id, role: "owner", name: "Alice", login: "alice", avatar: null });

    // First connection loads the document from the database: the hydration update must not be broadcast to it.
    const a = connect(token, doc.id);
    await waitFor(() => a.provider.isSynced);
    a.provider.awareness!.setLocalStateField("user", { name: "A" });
    await sleep(200);
    const b = connect(token, doc.id);
    await waitFor(() => b.provider.isSynced);
    b.provider.awareness!.setLocalStateField("user", { name: "B" });
    await sleep(200);

    const stateBytes = Y.encodeStateAsUpdate(a.ydoc).byteLength;
    expect(stateBytes).toBeGreaterThan(body.length);
    for (const client of [a, b]) {
      const total = client.received.reduce((n, m) => n + m.bytes, 0);
      // One sync step 2 (the whole state) plus small protocol messages; the second copy was ~2×.
      expect(total).toBeLessThan(stateBytes * 1.1);
      expect(countBy(client.received)["sync-step2"]).toBe(1);
      expect(countBy(client.received).update).toBeUndefined();
    }

    // A types 50 characters, moving its caret each time (what y-codemirror does mid-document).
    a.received.length = 0;
    b.received.length = 0;
    const text = a.ydoc.getText("content");
    for (let i = 0; i < 50; i++) {
      text.insert(text.length, "x");
      a.provider.awareness!.setLocalStateField("cursor", { pos: text.length });
      await sleep(20);
    }
    await waitFor(() => b.ydoc.getText("content").toString() === text.toString());
    await sleep(300);

    const toA = countBy(a.received);
    const toB = countBy(b.received);
    // The typist only gets the ack per update (the provider needs it for "saved"): no update echo, no own caret.
    expect(toA["sync-status"]).toBe(50);
    expect(toA.update).toBeUndefined();
    expect(toA.awareness).toBeUndefined();
    // The collaborator gets every update and a throttled stream of caret positions.
    expect(toB.update).toBe(50);
    expect(toB.awareness).toBeGreaterThanOrEqual(1);
    expect(toB.awareness).toBeLessThan(50);
    expect(b.provider.awareness!.getStates().get(a.ydoc.clientID)?.cursor).toEqual({ pos: text.length });

    // Nothing was lost: B's own edit reaches A exactly once too.
    b.ydoc.getText("content").insert(0, "B> ");
    await waitFor(() => a.ydoc.getText("content").toString().startsWith("B> "));
    await sleep(50);
    expect(countBy(a.received).update).toBe(1);
    expect(countBy(b.received).update).toBe(50);

    for (const client of [a, b]) {
      client.provider.destroy();
      client.socket.destroy();
    }
  });

  /**
   * A browser that holds the document in IndexedDB, the way `CollabSession` wires it (issue #189): the
   * mirror is applied under its own origin before the socket opens, and the provider must let the sync
   * handshake — not a raw update — carry whatever the server is missing.
   */
  function warmClient(token: string, name: string) {
    const ydoc = new Y.Doc();
    const sent: { type: string; bytes: number }[] = [];
    // Counts the frames that actually leave: the provider's own `send` also runs for queued messages on flush.
    class CountingSocket extends WebSocket {
      send(data: Parameters<WebSocket["send"]>[0], ...rest: unknown[]) {
        sent.push(describeMessage(data as Uint8Array));
        return (super.send as (...a: unknown[]) => void)(data, ...rest);
      }
    }
    const socket = new HocuspocusProviderWebsocket({ url, autoConnect: false, WebSocketPolyfill: CountingSocket as unknown as typeof globalThis.WebSocket });
    const received: { type: string; bytes: number }[] = [];
    const provider = new MarkdocProvider({
      websocketProvider: socket,
      name,
      document: ydoc,
      token,
      onMessage: ({ message }) => received.push(describeMessage((message as unknown as { data: ArrayBuffer | Uint8Array }).data)),
    });
    provider.attach();
    const localOrigin = { name: "indexeddb mirror" };
    provider.setLocalOrigin(localOrigin);
    const total = (list: { bytes: number }[]) => list.reduce((n, m) => n + m.bytes, 0);
    const dispose = () => {
      warmClientDisposers.delete(dispose);
      provider.destroy();
      socket.destroy();
      ydoc.destroy();
    };
    warmClientDisposers.add(dispose);
    return { ydoc, provider, socket, received, sent, localOrigin, total, dispose };
  }

  it("a client whose local copy is current exchanges state vectors, not the document (issue #189)", async () => {
    const body = `# Warm open\n\n${"the quick brown fox jumps over the lazy dog. ".repeat(2500)}`;
    const doc = await createDocument({ ownerId: userId, content: body });
    const token = await signCollabToken({ userId, docId: doc.id, role: "owner", name: "Alice", login: "alice", avatar: null });

    // Cold open: the whole state once, downstream only.
    const cold = warmClient(token, doc.id);
    void cold.socket.connect();
    await waitFor(() => cold.provider.isSynced && !cold.provider.hasUnsyncedChanges);
    const state = Y.encodeStateAsUpdate(cold.ydoc);
    expect(state.byteLength).toBeGreaterThan(body.length);
    expect(cold.total(cold.received)).toBeGreaterThan(state.byteLength);
    expect(cold.total(cold.received)).toBeLessThan(state.byteLength * 1.1);
    expect(cold.total(cold.sent)).toBeLessThan(state.byteLength * 0.05);
    cold.dispose();

    // Warm open, nothing changed: the mirror restores the state before the socket opens.
    const warm = warmClient(token, doc.id);
    Y.transact(warm.ydoc, () => Y.applyUpdate(warm.ydoc, state), warm.localOrigin);
    expect(warm.ydoc.getText("content").toString()).toBe(body);
    // Counted as pending (the copy may hold offline edits) but not pushed: nothing has been sent yet.
    expect(warm.provider.hasUnsyncedChanges).toBe(true);
    expect(warm.sent).toHaveLength(0);
    void warm.socket.connect();
    await waitFor(() => warm.provider.isSynced && !warm.provider.hasUnsyncedChanges);
    await sleep(200);
    const recvKinds = countBy(warm.received);
    const sentKinds = countBy(warm.sent);
    console.log(`[collab] warm open: recv ${warm.total(warm.received)} B ${JSON.stringify(recvKinds)} · sent ${warm.total(warm.sent)} B ${JSON.stringify(sentKinds)} · state ${state.byteLength} B`);
    expect(warm.total(warm.received)).toBeLessThan(state.byteLength * 0.05);
    expect(warm.total(warm.sent)).toBeLessThan(state.byteLength * 0.05);
    expect(sentKinds.update).toBeUndefined();
    expect(recvKinds["sync-step2"]).toBe(1);
    expect(warm.ydoc.getText("content").toString()).toBe(body);

    /** The IndexedDB copy of a browser that typed `text` at `index` while offline (under that session's own client id). */
    const mirrorWith = (index: number, text: string) => {
      const offline = new Y.Doc();
      Y.applyUpdate(offline, state);
      offline.getText("content").insert(index, text);
      return Y.encodeStateAsUpdate(offline);
    };

    // Warm open with an edit made offline: only the edit travels, and it reaches the server.
    const edited = warmClient(token, doc.id);
    Y.transact(edited.ydoc, () => Y.applyUpdate(edited.ydoc, mirrorWith(0, "Typed offline. ")), edited.localOrigin);
    expect(edited.provider.hasUnsyncedChanges).toBe(true);
    void edited.socket.connect();
    await waitFor(() => edited.provider.isSynced && !edited.provider.hasUnsyncedChanges);
    await waitFor(() => warm.ydoc.getText("content").toString().startsWith("Typed offline. "));
    await sleep(200);
    expect(edited.total(edited.sent)).toBeLessThan(state.byteLength * 0.05);
    expect(edited.total(edited.received)).toBeLessThan(state.byteLength * 0.05);
    console.log(`[collab] warm offline edit: recv ${edited.total(edited.received)} B · sent ${edited.total(edited.sent)} B · bound ${state.byteLength * 0.05} B`);
    expect(countBy(edited.sent).update).toBeUndefined();
    expect(countBy(edited.sent)["sync-step2"]).toBe(1);

    // Mirror slower than the socket (applied after the handshake): the state vectors are exchanged again.
    const late = warmClient(token, doc.id);
    void late.socket.connect();
    await waitFor(() => late.provider.isSynced && !late.provider.hasUnsyncedChanges);
    late.sent.length = 0;
    late.received.length = 0;
    Y.transact(late.ydoc, () => Y.applyUpdate(late.ydoc, mirrorWith(body.length, " Late mirror.")), late.localOrigin);
    await waitFor(() => warm.ydoc.getText("content").toString().includes(" Late mirror."));
    await waitFor(() => !late.provider.hasUnsyncedChanges);
    await sleep(200);
    expect(late.total(late.sent)).toBeLessThan(state.byteLength * 0.05);
    expect(late.total(late.received)).toBeLessThan(state.byteLength * 0.05);
    console.log(`[collab] late mirror edit: recv ${late.total(late.received)} B · sent ${late.total(late.sent)} B · bound ${state.byteLength * 0.05} B`);
    expect(countBy(late.sent).update).toBeUndefined();
    expect(countBy(late.sent)["sync-step1"]).toBe(1);
    expect(countBy(late.sent)["sync-step2"]).toBe(1);

    for (const client of [warm, edited, late]) {
      client.dispose();
    }
  });
});
