import { describe, expect, it, beforeAll, afterAll, afterEach, vi } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import WebSocket from "ws";
import * as Y from "yjs";
import { eq } from "drizzle-orm";
import { HocuspocusProvider, HocuspocusProviderWebsocket } from "@hocuspocus/provider";

/**
 * Issue #2281: what an access change costs the person who is typing while it runs.
 *
 * The in-process test database answers without the server taking another message, so on it the pause of an
 * access change has no width and none of this can be seen. Every test here therefore keeps the database
 * change open on purpose (`slowChange`): the collaborator or link write is done, the mutation has not
 * returned, and the server keeps handling messages meanwhile, as it does with a database on another machine.
 */

process.env.PGLITE_DATA_DIR = "memory://";
process.env.AUTH_SECRET = "test-secret-test-secret-test-secret";
delete process.env.DATABASE_URL;
delete process.env.COLLAB_ACCESS_CHANGE_TEST_DELAY_MS;

// Lets one test keep "what access does this connection have now?" open, to stand inside the moment
// between a failed change and the restored access.
const accessLookup = vi.hoisted(() => ({ gate: null as Promise<void> | null, waiting: 0 }));
vi.mock("./documents", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./documents")>();
  return {
    ...actual,
    getDocumentAccess: async (...args: Parameters<typeof actual.getDocumentAccess>) => {
      if (accessLookup.gate) {
        accessLookup.waiting += 1;
        await accessLookup.gate;
      }
      return actual.getDocumentAccess(...args);
    },
  };
});

// Moving a document to the trash loads the live-document helpers, which reach the sign-in module; it is not needed here.
vi.mock("@/auth", () => ({ auth: async () => null }));

const { getDb, schema } = await import("./db");
const { createCollabServer, shutdownCollab, TEXT_KEY } = await import("./collab/hocuspocus");
const { attachCollab } = await import("./collab/ws");
const { signCollabToken } = await import("./collab/token");
const { registerCollab } = await import("./collab/registry");
const { createDocument, deleteDocument, removeCollaborator, updateDocument, upsertCollaborator } = await import("./documents");
const authorization = await import("./collab/authorization");
const { changeCollaboratorAccess, changeLinkAccess, collabAccessChangeBlocks } = authorization;
const { createApiToken, revokeApiToken } = await import("./tokens");

type Role = "editor" | "commenter" | "viewer";
type LinkAccess = "private" | "view" | "comment" | "edit";

async function eventually(check: () => boolean | Promise<boolean>, what: string, timeout = 5000): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (await check()) return;
    if (Date.now() - start > timeout) throw new Error(`timed out waiting for: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function withTimeout<T>(promise: Promise<T>, what: string, timeout = 3000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`deadlock? timed out waiting for: ${what}`)), timeout);
  });
  try {
    return await Promise.race([promise, expired]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** What kind of Hocuspocus message this is, as far as these tests care. */
function kindOf(data: ArrayBuffer | Uint8Array): "step1" | "step2" | "update" | "applied" | "refused" | "stateless" | "other" {
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
  if (bytes[i] === 0) return (["step1", "step2", "update"] as const)[bytes[i + 1]] ?? "other";
  if (bytes[i] === 8) return bytes[i + 1] === 1 ? "applied" : "refused";
  return bytes[i] === 5 ? "stateless" : "other";
}

describe("an access change while the person types (issue #2281)", () => {
  let server: Server;
  let url: string;
  let hocuspocus: ReturnType<typeof createCollabServer>;
  let serial = 0;
  const open = new Set<{ provider: HocuspocusProvider; socket: HocuspocusProviderWebsocket }>();
  const limits = authorization.HOLD_LIMITS ? { ...authorization.HOLD_LIMITS } : null;

  beforeAll(async () => {
    hocuspocus = createCollabServer();
    registerCollab(hocuspocus);
    hocuspocus.configuration.debounce = 20;
    server = createServer((_req, res) => {
      res.statusCode = 404;
      res.end();
    });
    attachCollab(server, hocuspocus, { path: "/collab" });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/collab`;
  });

  afterEach(() => {
    accessLookup.gate = null;
    accessLookup.waiting = 0;
    if (limits) Object.assign(authorization.HOLD_LIMITS, limits);
    for (const client of open) {
      client.provider.destroy();
      client.socket.destroy();
    }
    open.clear();
  });

  afterAll(async () => {
    await shutdownCollab(hocuspocus);
    await new Promise<void>((r) => server.close(() => r()));
  });

  function connect(token: string, name: string) {
    const ydoc = new Y.Doc();
    const socket = new HocuspocusProviderWebsocket({ url, autoConnect: false, WebSocketPolyfill: WebSocket as unknown as typeof globalThis.WebSocket });
    /** What the server sent this client, by kind. `applied` / `refused` are its answers to this client's sync messages. */
    const got = { step1: 0, step2: 0, update: 0, applied: 0, refused: 0, stateless: 0, other: 0 };
    const stateless: { type?: string; requestId?: string; state?: string; error?: string | null }[] = [];
    const provider = new HocuspocusProvider({
      websocketProvider: socket,
      name,
      document: ydoc,
      token,
      onMessage: ({ message }) => {
        got[kindOf((message as unknown as { data: ArrayBuffer }).data)] += 1;
      },
      onStateless: ({ payload }) => {
        stateless.push(JSON.parse(payload));
      },
    });
    provider.attach();
    void socket.connect();
    const client = {
      ydoc,
      provider,
      socket,
      got,
      stateless,
      text: () => ydoc.getText(TEXT_KEY).toString(),
      /** One Yjs update per call, at the end of the text: one "key". */
      type: (text: string) => ydoc.getText(TEXT_KEY).insert(ydoc.getText(TEXT_KEY).length, text),
      /** Updates sent and not yet acknowledged; what the page turns into "Unsaved changes". */
      unsent: () => provider.unsyncedChanges,
    };
    open.add(client);
    return client;
  }

  interface SceneOptions {
    link?: LinkAccess;
    /** The person's collaborator row, or null when they come in through the link only. */
    row?: Role | null;
    /** Connect the person through an API token (an agent) instead of a browser session. */
    agent?: boolean;
  }

  /** An owner and one person on a fresh document, both connected and in sync. */
  async function scene({ link = "edit", row = "editor", agent = false }: SceneOptions = {}) {
    const tag = `${Date.now().toString(36)}${(serial += 1)}`;
    const db = await getDb();
    const [owner] = await db.insert(schema.users).values({ name: "Owner", login: `pause-owner-${tag}`, email: `pause-owner-${tag}@example.com` }).returning();
    const [person] = await db.insert(schema.users).values({ name: "Person", login: `pause-person-${tag}`, email: `pause-person-${tag}@example.com` }).returning();
    const doc = await createDocument({ ownerId: owner.id, content: "Start" });
    if (link !== "private") await updateDocument(doc.id, { linkAccess: link });
    if (row) await upsertCollaborator(doc.id, person.login!, row, owner.id);
    const startsAs = row ?? (link === "edit" ? "editor" : link === "comment" ? "commenter" : "viewer");
    const apiToken = agent ? await createApiToken(person.id, `Agent ${tag}`, { scope: "full", documentIds: [doc.id] }) : null;
    const ownerClient = connect(await signCollabToken({ userId: owner.id, docId: doc.id, role: "owner", name: "Owner", login: owner.login, avatar: null }), doc.id);
    const personClient = connect(
      await signCollabToken({
        userId: person.id,
        docId: doc.id,
        role: startsAs,
        name: "Person",
        login: person.login,
        avatar: null,
        ...(apiToken ? { tokenId: apiToken.id, tokenScope: apiToken.scope, tokenExpiresAt: apiToken.expiresAt?.getTime() ?? null } : {}),
      }),
      doc.id,
    );
    await eventually(() => ownerClient.provider.isSynced && personClient.provider.isSynced && personClient.unsent() === 0, "both clients in sync");
    const live = hocuspocus.documents.get(doc.id)!;
    const connectionOf = (userId: string) => live.getConnections().find((candidate) => candidate.context.userId === userId)!;
    const connection = connectionOf(person.id);
    return {
      owner,
      person,
      doc,
      apiToken,
      ownerClient,
      personClient,
      live,
      connection,
      connectionOf,
      login: person.login!,
      serverText: () => live.getText(TEXT_KEY).toString(),
      /** The stored document, as a reload or a fresh browser would get it. */
      stored: async () => (await db.select({ content: schema.documents.content }).from(schema.documents).where(eq(schema.documents.id, doc.id)))[0]?.content,
      /** Messages of the person's connection that the server has received and not finished handling. */
      waiting: () => (connection as unknown as { messageQueue: Uint8Array[] }).messageQueue.length,
      /** Extra connections of other people on the same document. */
      join: async (login: string, role: Role | "owner", id?: string) => {
        const userId = id ?? (await db.insert(schema.users).values({ name: login, login, email: `${login}@example.com` }).returning())[0].id;
        const client = connect(await signCollabToken({ userId, docId: doc.id, role, name: login, login: id ? null : login, avatar: null }), doc.id);
        await eventually(() => client.provider.isSynced && client.unsent() === 0, `${login} in sync`);
        return { client, userId, connection: connectionOf(userId) };
      },
    };
  }

  /**
   * An access change whose database write is done but whose mutation has not returned: the pause is on and
   * the server handles messages meanwhile. `finish()` lets it return (or throw, with `fail`).
   */
  function slowChange(run: (mutation: () => Promise<void>) => Promise<void>, write: () => Promise<unknown>, { fail = false } = {}) {
    const hold = deferred();
    const written = deferred();
    let started = false;
    const done = run(async () => {
      started = true;
      await write();
      written.resolve();
      await hold.promise;
      if (fail) throw new Error("the change was refused");
    });
    done.catch(() => undefined);
    return { done, written: written.promise, finish: hold.resolve, started: () => started };
  }

  type Scene = Awaited<ReturnType<typeof scene>>;
  const removeRow = (s: Scene, options?: { fail?: boolean }) =>
    slowChange((mutation) => changeCollaboratorAccess(s.doc.id, s.login, null, mutation), () => removeCollaborator(s.doc.id, s.login), options);
  const setRow = (s: Scene, role: Role, options?: { fail?: boolean }) =>
    slowChange((mutation) => changeCollaboratorAccess(s.doc.id, s.login, role, mutation), () => (options?.fail ? Promise.resolve() : upsertCollaborator(s.doc.id, s.login, role, s.owner.id)), options);
  const setLink = (s: Scene, link: LinkAccess, options?: { fail?: boolean }) =>
    slowChange((mutation) => changeLinkAccess(s.doc.id, link, mutation), () => (options?.fail ? Promise.resolve() : updateDocument(s.doc.id, { linkAccess: link })), options);

  /** Everything is where it should be for someone who may still edit: live text, the owner's copy, the stored document, the page's counter. */
  async function expectNothingLost(s: Scene, text: string) {
    await eventually(() => s.serverText() === text, `the live document to read "${text}" (it reads "${s.serverText()}")`);
    await eventually(() => s.ownerClient.text() === text, "the owner's copy to have all of it");
    await eventually(async () => (await s.stored()) === text, "the stored document to have all of it");
    await eventually(() => s.personClient.unsent() === 0, `the person's page to have nothing unsent (it has ${s.personClient.unsent()})`);
    expect(s.personClient.text()).toBe(text);
    expect(s.live.store.pendingStructs).toBeNull();
  }

  describe("a person who may still edit loses nothing and keeps saving", () => {
    it.each([
      ["a browser session", false],
      ["an agent (API token)", true],
    ])("their collaborator row is removed while the link gives edit: %s", async (_who, agent) => {
      const s = await scene({ agent });
      s.personClient.type(" before");
      await eventually(() => s.serverText() === "Start before", "the key typed before the change");

      const change = removeRow(s);
      await change.written;
      expect(collabAccessChangeBlocks(s.connection)).toBe(true);
      // Three keys while the change runs: the server has them and keeps them waiting, in order. None is refused.
      s.personClient.type(" one");
      s.personClient.type(" two");
      s.personClient.type(" three");
      await eventually(() => s.waiting() === 3, "the three keys to reach the server");
      expect(s.serverText()).toBe("Start before");
      expect(s.personClient.got.refused).toBe(0);

      change.finish();
      await withTimeout(change.done, "the removal");
      expect(collabAccessChangeBlocks(s.connection)).toBe(false);
      expect(s.connection.readOnly).toBe(false);
      expect(s.connection.context.role).toBe("editor");
      await expectNothingLost(s, "Start before one two three");

      // And saving goes on, with no reload and no full sync from the server.
      s.personClient.type(" after");
      await expectNothingLost(s, "Start before one two three after");
      expect(s.personClient.got.refused).toBe(0);
      expect(s.personClient.got.step1).toBe(1);
    });

    it("a change that is refused inside the transition (the mutation throws) costs them nothing", async () => {
      const s = await scene({ row: null });
      const change = setRow(s, "viewer", { fail: true });
      await change.written;
      s.personClient.type(" one");
      s.personClient.type(" two");
      await eventually(() => s.waiting() === 2, "the two keys to reach the server");
      expect(s.serverText()).toBe("Start");

      change.finish();
      await expect(withTimeout(change.done, "the refused change")).rejects.toThrow("the change was refused");
      expect(s.connection.readOnly).toBe(false);
      await expectNothingLost(s, "Start one two");
      s.personClient.type(" after");
      await expectNothingLost(s, "Start one two after");
      expect(s.personClient.got.refused).toBe(0);
    });

    it("a key that arrives while access is being restored after a failed change waits too (the catch path)", async () => {
      const s = await scene({ row: null });
      const change = setRow(s, "viewer", { fail: true });
      await change.written;
      // The mutation has thrown and the server is asking the database what access the person has now.
      const lookup = deferred();
      accessLookup.gate = lookup.promise;
      change.finish();
      await eventually(() => accessLookup.waiting === 1, "the access lookup after the failure");
      expect(collabAccessChangeBlocks(s.connection)).toBe(true);
      s.personClient.type(" caught");
      await eventually(() => s.waiting() === 1, "the key to reach the server");
      expect(s.serverText()).toBe("Start");

      accessLookup.gate = null;
      lookup.resolve();
      await expect(withTimeout(change.done, "the refused change")).rejects.toThrow("the change was refused");
      await expectNothingLost(s, "Start caught");
      expect(s.personClient.got.refused).toBe(0);
    });

    it("a message whose handling began before the pause is finished and kept, and the change waits for it", async () => {
      const s = await scene();
      const order: string[] = [];
      s.live.on("update", () => order.push("applied"));
      // Stop the person's next message after it was admitted and before Hocuspocus decides whether to apply it.
      const before = s.connection.callbacks.beforeSync;
      const reached = deferred();
      const letGo = deferred();
      s.connection.callbacks.beforeSync = async (connection, payload) => {
        s.connection.callbacks.beforeSync = before;
        reached.resolve();
        await letGo.promise;
        return before(connection, payload);
      };
      s.personClient.type(" in flight");
      await reached.promise;

      const change = slowChange(
        (mutation) => changeCollaboratorAccess(s.doc.id, s.login, null, mutation),
        async () => {
          order.push("change");
          await removeCollaborator(s.doc.id, s.login);
        },
      );
      // Two turns of the event loop: the change has paused the connection and is waiting for that one message.
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      expect(change.started()).toBe(false);
      letGo.resolve();
      await change.written;
      // It was applied before the database change began, and it is in the document that change stored first.
      expect(order).toEqual(["applied", "change"]);
      expect(await s.stored()).toBe("Start in flight");
      change.finish();
      await withTimeout(change.done, "the removal");
      await expectNothingLost(s, "Start in flight");
      expect(s.personClient.got.refused).toBe(0);
    });

    it("everything they send waits in order, a save request included, and the save request is answered", async () => {
      const s = await scene();
      const change = removeRow(s);
      await change.written;
      s.personClient.type(" one");
      s.personClient.provider.sendStateless(JSON.stringify({ type: "document-persistence-flush", docId: s.doc.id, requestId: "save-during-pause" }));
      s.personClient.type(" two");
      await eventually(() => s.waiting() === 3, "the three messages to reach the server");
      expect(s.personClient.stateless.some((message) => message.requestId === "save-during-pause")).toBe(false);

      change.finish();
      await withTimeout(change.done, "the removal");
      await eventually(() => s.personClient.stateless.some((message) => message.requestId === "save-during-pause"), "the answer to the save request");
      const answer = s.personClient.stateless.find((message) => message.requestId === "save-during-pause")!;
      expect(answer.error ?? null).toBeNull();
      expect(answer.state).not.toBe("error");
      await expectNothingLost(s, "Start one two");
    });

    it("a link change that fails: a link visitor who was typing loses nothing", async () => {
      const s = await scene({ row: null });
      const change = setLink(s, "view", { fail: true });
      await change.written;
      s.personClient.type(" one");
      await eventually(() => s.waiting() === 1, "the key to reach the server");
      change.finish();
      await expect(withTimeout(change.done, "the failed link change")).rejects.toThrow("the change was refused");
      await expectNothingLost(s, "Start one");
      expect(s.personClient.got.refused).toBe(0);
    });

    it("a change for one person never pauses another who is typing", async () => {
      const s = await scene();
      const other = await s.join(`pause-other-${Date.now().toString(36)}`, "editor");
      await upsertCollaborator(s.doc.id, other.connection.context.login!, "editor", s.owner.id);
      const change = removeRow(s);
      await change.written;
      expect(collabAccessChangeBlocks(other.connection)).toBe(false);
      other.client.type(" other");
      s.ownerClient.type(" owner");
      // Both land while the change is still running.
      await eventually(() => s.serverText().includes(" other") && s.serverText().includes(" owner"), "the other people's keys");
      expect(other.client.got.refused + s.ownerClient.got.refused).toBe(0);
      change.finish();
      await withTimeout(change.done, "the removal");
    });
  });

  describe("a person whose edit access really ends: nothing typed after the change is accepted", () => {
    it("lowered to Viewer (an explicit row wins over an edit link): every waiting key is refused, in order, none applied", async () => {
      const s = await scene();
      s.personClient.type(" before");
      await eventually(() => s.serverText() === "Start before", "the key typed before the change");
      const change = setRow(s, "viewer");
      // Sent the moment the pause is on, before the database write has even returned.
      s.personClient.type(" one");
      await change.written;
      // The key accepted before the change is in the document the change stored first.
      expect(await s.stored()).toBe("Start before");
      s.personClient.type(" two");
      s.personClient.type(" three");
      await eventually(() => s.waiting() === 3, "the three keys to reach the server");

      change.finish();
      await withTimeout(change.done, "the lowering");
      expect(s.connection.readOnly).toBe(true);
      expect(s.connection.context.role).toBe("viewer");
      await eventually(() => s.personClient.got.refused === 3, "the three keys to be refused");
      s.personClient.type(" later");
      await eventually(() => s.personClient.got.refused === 4, "a later key to be refused");
      expect(s.serverText()).toBe("Start before");
      expect(s.ownerClient.text()).toBe("Start before");
      expect(await s.stored()).toBe("Start before");
      // No full sync is asked of someone who cannot edit.
      expect(s.personClient.got.step1).toBe(1);
      expect(s.live.store.pendingStructs).toBeNull();
    });

    it("a change that fails after its write went through: the connection gets the access the database has, not the one it had", async () => {
      const s = await scene();
      const change = slowChange(
        (mutation) => changeCollaboratorAccess(s.doc.id, s.login, "viewer", mutation),
        () => upsertCollaborator(s.doc.id, s.login, "viewer", s.owner.id),
        { fail: true },
      );
      await change.written;
      s.personClient.type(" one");
      await eventually(() => s.waiting() === 1, "the key to reach the server");
      change.finish();
      await expect(withTimeout(change.done, "the failed change")).rejects.toThrow("the change was refused");
      expect(s.connection.context.role).toBe("viewer");
      expect(s.connection.readOnly).toBe(true);
      await eventually(() => s.personClient.got.refused === 1, "the key to be refused");
      expect(s.serverText()).toBe("Start");
      expect(await s.stored()).toBe("Start");
    });

    it("removed for good (4401): nothing that waited is applied, and their presence does not come back", async () => {
      const s = await scene({ link: "private" });
      s.personClient.type(" before");
      await eventually(() => s.serverText() === "Start before", "the key typed before the change");
      const change = removeRow(s);
      await change.written;
      s.personClient.type(" one");
      s.personClient.provider.setAwarenessField("user", { name: "Person" });
      s.personClient.type(" two");
      await eventually(() => s.waiting() === 3, "the three messages to reach the server");

      change.finish();
      await withTimeout(change.done, "the removal");
      expect(s.live.hasConnection(s.connection)).toBe(false);
      expect(s.connection.readOnly).toBe(true);
      await eventually(() => s.waiting() === 0, "the waiting messages to be handled");
      expect(s.serverText()).toBe("Start before");
      expect(s.ownerClient.text()).toBe("Start before");
      expect(await s.stored()).toBe("Start before");
      expect(s.live.awareness.getStates().has(s.personClient.ydoc.clientID)).toBe(false);
      expect(s.live.store.pendingStructs).toBeNull();
    });

    it("an edit link lowered to comment: link visitors who were typing are refused; the owner and an explicit collaborator are not paused", async () => {
      const s = await scene({ row: null });
      const collaborator = await s.join(`pause-collab-${Date.now().toString(36)}`, "editor");
      await upsertCollaborator(s.doc.id, collaborator.connection.context.login!, "editor", s.owner.id);
      const anonymous = await s.join("Anonymous", "viewer", `anon-pause-${Date.now().toString(36)}`);
      const change = setLink(s, "comment");
      await change.written;
      expect(collabAccessChangeBlocks(s.connection)).toBe(true);
      expect(collabAccessChangeBlocks(anonymous.connection)).toBe(true);
      expect(collabAccessChangeBlocks(collaborator.connection)).toBe(false);
      s.personClient.type(" visitor");
      collaborator.client.type(" collaborator");
      await eventually(() => s.waiting() === 1 && s.serverText() === "Start collaborator", "the visitor's key to wait and the collaborator's to land");

      change.finish();
      await withTimeout(change.done, "the link change");
      expect(s.connection.context.role).toBe("commenter");
      expect(s.connection.readOnly).toBe(true);
      expect(anonymous.connection.readOnly).toBe(true);
      await eventually(() => s.personClient.got.refused === 1, "the visitor's key to be refused");
      expect(s.serverText()).toBe("Start collaborator");
      expect(await s.stored()).toBe("Start collaborator");
    });

    it("a token revoked while its connection is paused: what the agent sent meanwhile is not applied", async () => {
      const s = await scene({ agent: true });
      const change = removeRow(s);
      await change.written;
      s.personClient.type(" one");
      await eventually(() => s.waiting() === 1, "the key to reach the server");
      expect(await revokeApiToken(s.person.id, s.apiToken!.id)).toBe(true);
      s.personClient.type(" two");
      expect(s.live.hasConnection(s.connection)).toBe(false);

      change.finish();
      await withTimeout(change.done, "the removal");
      await eventually(() => s.waiting() === 0, "the waiting messages to be handled");
      expect(s.connection.readOnly).toBe(true);
      expect(s.serverText()).toBe("Start");
      expect(await s.stored()).toBe("Start");
    });

    it("a token that expires while its connection is paused, with access resolved as Editor before the expiry: still nothing applied", async () => {
      const s = await scene({ agent: true });
      const change = removeRow(s);
      await change.written;
      s.personClient.type(" one");
      await eventually(() => s.waiting() === 1, "the key to reach the server");
      // The access lookup after the change answers "Editor" (the link), and only then the token runs out:
      // the expiry timer closes the connection, exactly as hocuspocus.ts does.
      const lookup = deferred();
      accessLookup.gate = lookup.promise;
      change.finish();
      await eventually(() => accessLookup.waiting === 1, "the access lookup after the change");
      s.connection.readOnly = true;
      s.connection.close({ code: 4401, reason: "Unauthorized" });
      accessLookup.gate = null;
      lookup.resolve();
      await withTimeout(change.done, "the removal");
      await eventually(() => s.waiting() === 0, "the waiting messages to be handled");
      expect(s.connection.readOnly).toBe(true);
      expect(s.serverText()).toBe("Start");
      expect(await s.stored()).toBe("Start");
    });

    it("a connection that closed is never opened for writing again, even when the change resolves it as an Editor", async () => {
      const s = await scene({ agent: true });
      const change = removeRow(s);
      await change.written;
      const lookup = deferred();
      accessLookup.gate = lookup.promise;
      change.finish();
      await eventually(() => accessLookup.waiting === 1, "the access lookup after the change");
      s.connection.readOnly = true;
      s.connection.close({ code: 4401, reason: "Unauthorized" });
      accessLookup.gate = null;
      lookup.resolve();
      await withTimeout(change.done, "the removal");
      expect(s.connection.context.role).toBe("editor");
      expect(s.connection.readOnly).toBe(true);
    });

    it("the document is moved to the trash during the pause: the change still ends and nothing that waited is stored", async () => {
      const s = await scene();
      const change = removeRow(s);
      await change.written;
      s.personClient.type(" one");
      await eventually(() => s.waiting() === 1, "the key to reach the server");
      await withTimeout(deleteDocument(s.doc.id), "moving the document to the trash");
      change.finish();
      await withTimeout(change.done, "the removal");
      await eventually(() => s.waiting() === 0, "the waiting messages to be handled");
      expect(s.connection.readOnly).toBe(true);
      expect(await s.stored()).toBe("Start");
    });

    it("a tab that closes while its keys wait: they are dropped, with its presence, even for someone who keeps edit", async () => {
      const s = await scene();
      const change = removeRow(s);
      await change.written;
      s.personClient.provider.setAwarenessField("user", { name: "Person" });
      s.personClient.type(" one");
      await eventually(() => s.waiting() === 2, "the two messages to reach the server");
      s.personClient.socket.disconnect();
      await eventually(() => !s.live.hasConnection(s.connection), "the connection to close");

      change.finish();
      await withTimeout(change.done, "the removal");
      await eventually(() => s.waiting() === 0, "the waiting messages to be handled");
      expect(s.connection.readOnly).toBe(true);
      expect(s.serverText()).toBe("Start");
      expect(s.live.awareness.getStates().has(s.personClient.ydoc.clientID)).toBe(false);
      // Their own copy still has the key: the next time they open the document it is sent.
      expect(s.personClient.text()).toBe("Start one");
    });
  });

  describe("lowered, then given edit back", () => {
    it.each([
      ["the role is set to Editor again", "role"],
      ["the row is removed and the link gives edit", "row"],
    ])("nothing is accepted while lowered; once they can edit again all of it arrives and saving goes on: %s", async (_how, how) => {
      const s = await scene({ row: null });
      const lowered = setRow(s, "viewer");
      await lowered.written;
      lowered.finish();
      await withTimeout(lowered.done, "the lowering");
      expect(s.connection.readOnly).toBe(true);

      // Their page still lets them type (issue 2269). The server refuses every key.
      s.personClient.type(" one");
      s.personClient.type(" two");
      s.personClient.type(" three");
      await eventually(() => s.personClient.got.refused === 3, "the three keys to be refused");
      expect(s.serverText()).toBe("Start");
      expect(await s.stored()).toBe("Start");
      expect(s.personClient.got.step1).toBe(1);
      expect(s.personClient.unsent()).toBe(3);

      const raised = how === "role" ? setRow(s, "editor") : removeRow(s);
      await raised.written;
      // Still a Viewer for the server until the change has ended: nothing arrives, nothing is asked for.
      expect(s.serverText()).toBe("Start");
      expect(s.personClient.got.step1).toBe(1);
      raised.finish();
      await withTimeout(raised.done, "giving edit back");
      expect(s.connection.readOnly).toBe(false);

      // The server asked this one connection for what it lacks; what was typed while lowered is in now.
      await expectNothingLost(s, "Start one two three");
      expect(s.personClient.got.step1).toBe(2);
      expect(s.ownerClient.got.step1).toBe(1);
      s.personClient.type(" after");
      await expectNothingLost(s, "Start one two three after");
      expect(s.personClient.got.refused).toBe(3);
    });

    it("the server asks for the missing part only when the connection can edit: Viewer to Commenter asks nothing", async () => {
      const s = await scene({ row: null });
      const lowered = setRow(s, "viewer");
      await lowered.written;
      lowered.finish();
      await withTimeout(lowered.done, "the lowering");
      s.personClient.type(" one");
      await eventually(() => s.personClient.got.refused === 1, "the key to be refused");

      const commenter = setRow(s, "commenter");
      await commenter.written;
      commenter.finish();
      await withTimeout(commenter.done, "the change to Commenter");
      expect(s.connection.readOnly).toBe(true);
      s.personClient.type(" two");
      await eventually(() => s.personClient.got.refused === 2, "the second key to be refused");
      expect(s.personClient.got.step1).toBe(1);
      expect(s.serverText()).toBe("Start");

      const raised = setRow(s, "editor");
      await raised.written;
      raised.finish();
      await withTimeout(raised.done, "giving edit back");
      await expectNothingLost(s, "Start one two");
      expect(s.personClient.got.step1).toBe(2);
    });

    it("a link lowered to view and opened for editing again: the visitor's typing arrives and saving goes on", async () => {
      const s = await scene({ row: null });
      const lowered = setLink(s, "view");
      await lowered.written;
      lowered.finish();
      await withTimeout(lowered.done, "the link change");
      s.personClient.type(" one");
      await eventually(() => s.personClient.got.refused === 1, "the key to be refused");
      expect(s.serverText()).toBe("Start");

      const raised = setLink(s, "edit");
      await raised.written;
      raised.finish();
      await withTimeout(raised.done, "the link change back");
      await expectNothingLost(s, "Start one");
      s.personClient.type(" after");
      await expectNothingLost(s, "Start one after");
    });
  });

  describe("the pause is bounded and fails closed", () => {
    it("a change that takes longer than the limit: waiting stops and keys are refused; an Editor is healed when it ends", async () => {
      authorization.HOLD_LIMITS.ms = 150;
      const s = await scene();
      const change = removeRow(s);
      await change.written;
      s.personClient.type(" one");
      await eventually(() => s.waiting() === 1, "the key to reach the server");
      // Time is the subject here: past the limit the key is refused instead of waiting on.
      await eventually(() => s.personClient.got.refused === 1, "the key to be refused once the limit has passed");
      expect(s.connection.readOnly).toBe(true);
      expect(collabAccessChangeBlocks(s.connection)).toBe(true);
      s.personClient.type(" two");
      await eventually(() => s.personClient.got.refused === 2, "a key after the limit to be refused at once");
      expect(s.serverText()).toBe("Start");

      change.finish();
      await withTimeout(change.done, "the removal");
      expect(s.connection.readOnly).toBe(false);
      await expectNothingLost(s, "Start one two");
      expect(s.personClient.got.step1).toBe(2);
    });

    it("a change that takes longer than the limit and ends the access: nothing is applied", async () => {
      authorization.HOLD_LIMITS.ms = 150;
      const s = await scene();
      const change = setRow(s, "viewer");
      await change.written;
      s.personClient.type(" one");
      await eventually(() => s.personClient.got.refused === 1, "the key to be refused once the limit has passed");
      change.finish();
      await withTimeout(change.done, "the lowering");
      s.personClient.type(" two");
      await eventually(() => s.personClient.got.refused === 2, "a later key to be refused");
      expect(s.connection.readOnly).toBe(true);
      expect(s.serverText()).toBe("Start");
      expect(await s.stored()).toBe("Start");
      expect(s.personClient.got.step1).toBe(1);
    });

    it.each([
      ["more messages than the limit", { messages: 4 }, 6],
      ["more bytes than the limit", { bytes: 600 }, 3],
    ])("%s while paused: all of them are refused, none is kept in memory; an Editor is healed when the change ends", async (_what, limit, keys) => {
      Object.assign(authorization.HOLD_LIMITS, limit);
      const s = await scene();
      const change = removeRow(s);
      await change.written;
      const typed = Array.from({ length: keys }, (_, i) => ` ${i}${"x".repeat(250)}`);
      for (const key of typed) s.personClient.type(key);
      await eventually(() => s.personClient.got.refused === keys, "every key to be refused");
      expect(s.waiting()).toBe(0);
      expect(s.serverText()).toBe("Start");

      change.finish();
      await withTimeout(change.done, "the removal");
      await expectNothingLost(s, `Start${typed.join("")}`);
    });

    it("past the limit, with two changes pausing one connection: it stays refused until the last one ends", async () => {
      authorization.HOLD_LIMITS.ms = 150;
      const s = await scene({ row: null });
      const link = setLink(s, "view", { fail: true });
      const row = setRow(s, "viewer", { fail: true });
      await Promise.all([link.written, row.written]);
      s.personClient.type(" one");
      await eventually(() => s.personClient.got.refused === 1, "the key to be refused once the limit has passed");

      link.finish();
      await expect(withTimeout(link.done, "the failed link change")).rejects.toThrow();
      // The other change is still running: the connection is not opened for writing yet.
      expect(s.connection.readOnly).toBe(true);
      s.personClient.type(" two");
      await eventually(() => s.personClient.got.refused === 2, "a key between the two endings to be refused");
      expect(s.serverText()).toBe("Start");

      row.finish();
      await expect(withTimeout(row.done, "the failed role change")).rejects.toThrow();
      expect(s.connection.readOnly).toBe(false);
      await expectNothingLost(s, "Start one two");
    });

    it("past the limit, with two changes that end in the same instant: an Editor is still opened for writing and healed", async () => {
      authorization.HOLD_LIMITS.ms = 150;
      const s = await scene({ row: null });
      const link = setLink(s, "view", { fail: true });
      const row = setRow(s, "viewer", { fail: true });
      await Promise.all([link.written, row.written]);
      s.personClient.type(" one");
      await eventually(() => s.personClient.got.refused === 1, "the key to be refused once the limit has passed");
      // Both are restoring access at the same time, so each sees the other still pausing the connection.
      const lookup = deferred();
      accessLookup.gate = lookup.promise;
      link.finish();
      row.finish();
      await eventually(() => accessLookup.waiting === 2, "both access lookups");
      accessLookup.gate = null;
      lookup.resolve();
      await expect(withTimeout(link.done, "the failed link change")).rejects.toThrow();
      await expect(withTimeout(row.done, "the failed role change")).rejects.toThrow();
      expect(s.connection.readOnly).toBe(false);
      await expectNothingLost(s, "Start one");
    });
  });

  describe("no deadlock", () => {
    it("two changes for the same person queue up: each pause holds and releases on its own", async () => {
      const s = await scene();
      const first = removeRow(s);
      const second = setRow(s, "viewer");
      await first.written;
      expect(second.started()).toBe(false);
      s.personClient.type(" one");
      await eventually(() => s.waiting() === 1, "the key to reach the server");
      first.finish();
      await withTimeout(first.done, "the removal");
      // Between the two they are an Editor through the link: the key that waited is in.
      await second.written;
      await eventually(() => s.serverText() === "Start one", "the key that waited out the first change");
      expect(await s.stored()).toBe("Start one");
      s.personClient.type(" two");
      await eventually(() => s.waiting() === 1, "the second key to reach the server");
      second.finish();
      await withTimeout(second.done, "the lowering");
      await eventually(() => s.personClient.got.refused === 1, "the key of the second pause to be refused");
      expect(s.connection.readOnly).toBe(true);
      expect(s.serverText()).toBe("Start one");
      expect(await s.stored()).toBe("Start one");
    });

    it("a link change and a collaborator change overlap on one connection: it stays paused until both have ended", async () => {
      const s = await scene({ row: null });
      const link = setLink(s, "view", { fail: true });
      const row = setRow(s, "viewer", { fail: true });
      await Promise.all([link.written, row.written]);
      s.personClient.type(" one");
      await eventually(() => s.waiting() === 1, "the key to reach the server");

      link.finish();
      await expect(withTimeout(link.done, "the failed link change")).rejects.toThrow();
      expect(collabAccessChangeBlocks(s.connection)).toBe(true);
      s.personClient.type(" two");
      await eventually(() => s.waiting() === 2, "the second key to reach the server");
      expect(s.serverText()).toBe("Start");
      expect(s.personClient.got.refused).toBe(0);

      row.finish();
      await expect(withTimeout(row.done, "the failed role change")).rejects.toThrow();
      expect(collabAccessChangeBlocks(s.connection)).toBe(false);
      await expectNothingLost(s, "Start one two");
      expect(s.personClient.got.refused).toBe(0);
    });

    it("overlapping changes that end the access: nothing that waited through either is applied", async () => {
      const s = await scene({ row: null });
      const link = setLink(s, "view");
      const row = setRow(s, "viewer", { fail: true });
      await Promise.all([link.written, row.written]);
      s.personClient.type(" one");
      await eventually(() => s.waiting() === 1, "the key to reach the server");
      row.finish();
      await expect(withTimeout(row.done, "the failed role change")).rejects.toThrow();
      link.finish();
      await withTimeout(link.done, "the link change");
      await eventually(() => s.personClient.got.refused === 1, "the key to be refused");
      expect(s.connection.readOnly).toBe(true);
      expect(s.serverText()).toBe("Start");
      expect(await s.stored()).toBe("Start");
    });
  });
});
