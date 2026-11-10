import { describe, expect, it, beforeAll, afterAll, afterEach, vi } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import WebSocket from "ws";
import * as Y from "yjs";
import * as encoding from "lib0/encoding";
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
// `gate` holds a lookup before it reads; `keepNextAnswer` holds the next lookup AFTER it has read (its answer
// is then older than anything written meanwhile).
// `letThrough` lookups pass the gate first (to hold only a later connection's lookup).
const accessLookup = vi.hoisted(() => ({ gate: null as Promise<void> | null, letThrough: 0, waiting: 0, keepNextAnswer: null as Promise<void> | null, kept: 0 }));
vi.mock("./documents", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./documents")>();
  return {
    ...actual,
    getDocumentAccess: async (...args: Parameters<typeof actual.getDocumentAccess>) => {
      if (accessLookup.gate && accessLookup.letThrough-- <= 0) {
        accessLookup.waiting += 1;
        await accessLookup.gate;
      }
      const answer = await actual.getDocumentAccess(...args);
      const keep = accessLookup.keepNextAnswer;
      if (keep) {
        accessLookup.keepNextAnswer = null;
        accessLookup.kept += 1;
        await keep;
      }
      return answer;
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
const { addFolderCollaborator, createFolder, moveDocumentsToFolder, removeFolderCollaborator } = await import("./folders");
const authorization = await import("./collab/authorization");
const { changeCollaboratorAccess, changeFolderCollaboratorAccess, changeLinkAccess, collabAccessChangeBlocks } = authorization;
const { createApiToken, revokeApiToken } = await import("./tokens");
const { ClientDocumentPersistence } = await import("@/editor/collab/persistence");
const { documentStoreSnapshot } = await import("./collab/autosave");
// `deleteDocument` loads this on first use; loaded here so that a slow first import is not mistaken for a deadlock.
await import("./livedoc");

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
  /** What the database holds per document, updated the moment a store has committed. */
  const lastStored = new Map<string, string>();

  beforeAll(async () => {
    hocuspocus = createCollabServer();
    registerCollab(hocuspocus);
    hocuspocus.configuration.debounce = 20;
    // Runs after the store of collab/hocuspocus.ts has written the row, and before clients are told "saved".
    hocuspocus.configuration.extensions.push({
      async onStoreDocument(payload) {
        lastStored.set(payload.documentName, documentStoreSnapshot(payload).content);
      },
    });
    server = createServer((_req, res) => {
      res.statusCode = 404;
      res.end();
    });
    // Exercise the access-pause acknowledgement bound, not the lower transport flood threshold.
    attachCollab(server, hocuspocus, { path: "/collab", floodLimits: { messageBurst: 10_000 } });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/collab`;
  });

  afterEach(() => {
    accessLookup.gate = null;
    accessLookup.letThrough = 0;
    accessLookup.waiting = 0;
    accessLookup.keepNextAnswer = null;
    accessLookup.kept = 0;
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
    /** Every message from the server in order, with what `watch` saw at that moment. */
    const trace: { kind: ReturnType<typeof kindOf>; seen: string | undefined }[] = [];
    const watching: { watch?: () => string; changed?: () => void } = {};
    // The two parts that decide what the page's header says, wired as src/editor/collab/session.ts wires them.
    const persistence = new ClientDocumentPersistence(
      name,
      ydoc,
      (request) => provider.sendStateless(JSON.stringify(request)),
      () => watching.changed?.(),
    );
    const provider: HocuspocusProvider = new HocuspocusProvider({
      websocketProvider: socket,
      name,
      document: ydoc,
      token,
      onMessage: ({ message }) => {
        const kind = kindOf((message as unknown as { data: ArrayBuffer }).data);
        got[kind] += 1;
        trace.push({ kind, seen: watching.watch?.() });
      },
      onSynced: () => persistence.synced(),
      onUnsyncedChanges: () => watching.changed?.(),
      onStateless: ({ payload }) => {
        const message = JSON.parse(payload);
        stateless.push(message);
        if (message?.type === "document-persistence") persistence.receive(message);
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
      trace,
      watching,
      /** The header of the page: the rule of `CollabSession.saveState` for a connected page. */
      saveState: () => (!provider.synced ? "saving" : persistence.state !== "saved" ? persistence.state : provider.unsyncedChanges > 0 ? "pending" : "saved"),
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
    /** A role granted by the document's folder, or null when there is no folder role. */
    folderRole?: Role | null;
    /** Connect the person through an API token (an agent) instead of a browser session. */
    agent?: boolean;
  }

  /** An owner and one person on a fresh document, both connected and in sync. */
  async function scene({ link = "edit", row = "editor", folderRole, agent = false }: SceneOptions = {}) {
    const tag = `${Date.now().toString(36)}${(serial += 1)}`;
    const db = await getDb();
    const [owner] = await db.insert(schema.users).values({ name: "Owner", login: `pause-owner-${tag}`, email: `pause-owner-${tag}@example.com` }).returning();
    const [person] = await db.insert(schema.users).values({ name: "Person", login: `pause-person-${tag}`, email: `pause-person-${tag}@example.com` }).returning();
    const doc = await createDocument({ ownerId: owner.id, content: "Start" });
    if (link !== "private") await updateDocument(doc.id, { linkAccess: link });
    if (row) await upsertCollaborator(doc.id, person.login!, row, owner.id);
    let folderId: string | null = null;
    if (folderRole) {
      const created = await createFolder(owner.id, `pause-folder-${tag}`);
      if (created.outcome !== "ok") throw new Error(`could not create access-test folder: ${created.outcome}`);
      folderId = created.folder.id;
      await moveDocumentsToFolder([doc.id], folderId, owner.id);
      await addFolderCollaborator(folderId, person.login!, folderRole, owner.id);
    }
    const startsAs = row ?? folderRole ?? (link === "edit" ? "editor" : link === "comment" ? "commenter" : "viewer");
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
    lastStored.set(doc.id, "Start");
    personClient.watching.watch = () => live.getText(TEXT_KEY).toString();
    const connectionOf = (userId: string) => live.getConnections().find((candidate) => candidate.context.userId === userId)!;
    const connection = connectionOf(person.id);
    return {
      owner,
      person,
      doc,
      folderId,
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
  const removeFolderRole = (s: Scene, options?: { fail?: boolean }) => {
    if (!s.folderId) throw new Error("this scene has no folder");
    return slowChange(
      (mutation) => changeFolderCollaboratorAccess(s.folderId!, s.login, null, mutation),
      () => (options?.fail ? Promise.resolve() : removeFolderCollaborator(s.folderId!, s.login)),
      options,
    );
  };
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

      expect(Object.hasOwn(s.connection, "handleMessage")).toBe(false);
      const change = removeRow(s);
      await change.written;
      expect(collabAccessChangeBlocks(s.connection)).toBe(true);
      // While paused the connection counts what arrives; afterwards its own `handleMessage` is back.
      expect(Object.hasOwn(s.connection, "handleMessage")).toBe(true);
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
      expect(Object.hasOwn(s.connection, "handleMessage")).toBe(false);
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
    it("lowered to Viewer without a stronger link: every waiting key is refused, in order, none applied", async () => {
      const s = await scene({ link: "private" });
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

    it("removing a folder role closes the live document connection after its accepted edits are stored", async () => {
      const s = await scene({ link: "private", row: null, folderRole: "editor" });
      s.personClient.type(" before");
      await eventually(() => s.serverText() === "Start before", "the key typed before the change");

      const change = removeFolderRole(s);
      await change.written;
      s.personClient.type(" after");
      await eventually(() => s.waiting() === 1, "the key to reach the server");
      expect(s.serverText()).toBe("Start before");

      change.finish();
      await withTimeout(change.done, "the folder role removal");
      expect(s.live.hasConnection(s.connection)).toBe(false);
      expect(s.connection.readOnly).toBe(true);
      await eventually(() => s.waiting() === 0, "the waiting key to be refused");
      expect(s.serverText()).toBe("Start before");
      expect(s.ownerClient.text()).toBe("Start before");
      expect(await s.stored()).toBe("Start before");
    });

    it("a change that fails after its write went through: the connection gets the access the database has, not the one it had", async () => {
      const s = await scene({ link: "private" });
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
      // The collaborator's key came after the change had stored the document: it is stored by the next autosave.
      await eventually(async () => (await s.stored()) === "Start collaborator", "the collaborator's key to be stored");
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
      ["the link is raised to Edit over the Viewer row", "link"],
    ])("nothing is accepted while lowered; once they can edit again all of it arrives and saving goes on: %s", async (_how, how) => {
      const s = await scene({ link: "private" });
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

      const raised = how === "role" ? setRow(s, "editor") : setLink(s, "edit");
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
      // The page was told "applied" only once the server had the text: one answer and two owed, all after it.
      const asked = s.personClient.trace.findLastIndex((entry) => entry.kind === "step1");
      const acknowledged = s.personClient.trace.slice(asked + 1).filter((entry) => entry.kind === "applied");
      expect(acknowledged.map((entry) => entry.seen)).toEqual(["Start one two three", "Start one two three", "Start one two three"]);
      s.personClient.type(" after");
      await expectNothingLost(s, "Start one two three after");
      expect(s.personClient.got.refused).toBe(3);
    });

    it("the server asks for the missing part only when the connection can edit: Viewer to Commenter asks nothing", async () => {
      const s = await scene({ link: "private" });
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

    it("a Viewer who typed nothing and is made an Editor is not asked for anything", async () => {
      const s = await scene({ link: "private", row: "viewer" });
      expect(s.connection.readOnly).toBe(true);
      const raised = setRow(s, "editor");
      await raised.written;
      raised.finish();
      await withTimeout(raised.done, "the change to Editor");
      expect(s.connection.readOnly).toBe(false);
      s.personClient.type(" one");
      await expectNothingLost(s, "Start one");
      // Their opening handshake held nothing new, so nothing was refused and no full sync is asked for.
      expect(s.personClient.got.step1).toBe(1);
      expect(s.personClient.got.refused).toBe(0);
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
      const s = await scene({ link: "private" });
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
      const flooded = performance.now();
      for (const key of typed) s.personClient.type(key);
      // At once, because of the size: long before the time limit (3 s) could do it.
      await eventually(() => s.personClient.got.refused === keys, "every key to be refused", 1500);
      expect(performance.now() - flooded).toBeLessThan(1500);
      expect(s.waiting()).toBe(0);
      expect(s.serverText()).toBe("Start");

      change.finish();
      await withTimeout(change.done, "the removal");
      await expectNothingLost(s, `Start${typed.join("")}`);
      // After the pause messages flow as before, through the connection's own `handleMessage`.
      expect(Object.hasOwn(s.connection, "handleMessage")).toBe(false);
      s.personClient.type(" after");
      await expectNothingLost(s, `Start${typed.join("")} after`);
      expect(s.personClient.got.refused).toBe(keys);
    });
  });

  describe("a bound hit after the access was applied (issue #2281, review point e)", () => {
    it.each([
      ["the size limit", "size", false],
      ["the time limit", "time", false],
      ["the size limit, while access is restored after a failed change", "size", true],
    ])("two tabs of one person, the second tab's access lookup still running, the first hits %s: it ends writable and loses nothing", async (_what, bound, fail) => {
      if (bound === "size") authorization.HOLD_LIMITS.messages = 3;
      else authorization.HOLD_LIMITS.ms = 250;
      const s = await scene();
      const second = connect(await signCollabToken({ userId: s.person.id, docId: s.doc.id, role: "editor", name: "Person", login: s.login, avatar: null }), s.doc.id);
      await eventually(() => second.provider.isSynced && second.unsent() === 0, "the second tab");
      const [first, other] = s.live.getConnections().filter((candidate) => candidate.context.userId === s.person.id);
      expect(first).toBe(s.connection);

      // The first tab's lookup answers; the second tab's is still out. The first is settled and still paused.
      const lookup = deferred();
      accessLookup.gate = lookup.promise;
      accessLookup.letThrough = 1;
      const change = fail ? slowChange((mutation) => changeCollaboratorAccess(s.doc.id, s.login, "viewer", mutation), () => Promise.resolve(), { fail: true }) : removeRow(s);
      await change.written;
      change.finish();
      await eventually(() => accessLookup.waiting === 1, "the second tab's access lookup");
      expect(first.readOnly).toBe(false);
      expect(collabAccessChangeBlocks(first)).toBe(true);
      expect(collabAccessChangeBlocks(other)).toBe(true);

      const keys = bound === "size" ? 5 : 1;
      const typed = Array.from({ length: keys }, (_, i) => ` k${i}`);
      for (const key of typed) s.personClient.type(key);
      await eventually(() => s.personClient.got.refused === keys, "the keys to be refused once the limit is hit", 2000);
      expect(first.readOnly).toBe(true);

      accessLookup.gate = null;
      lookup.resolve();
      if (fail) await expect(withTimeout(change.done, "the failed change")).rejects.toThrow("the change was refused");
      else await withTimeout(change.done, "the removal");
      expect(first.readOnly).toBe(false);
      expect(other.readOnly).toBe(false);
      await expectNothingLost(s, `Start${typed.join("")}`);
      s.personClient.type(" after");
      await expectNothingLost(s, `Start${typed.join("")} after`);
      await eventually(() => second.text() === s.personClient.text(), "the second tab to have the same text");
    });
  });

  describe("a save request and the pause (the reads in collab/autosave.ts)", () => {
    it("a save request that waited out one change is answered, not refused, when the next change has already paused the connection", async () => {
      const s = await scene();
      const first = removeRow(s);
      await first.written;
      s.personClient.provider.sendStateless(JSON.stringify({ type: "document-persistence-flush", docId: s.doc.id, requestId: "save-between-two-changes" }));
      await eventually(() => s.waiting() === 1, "the save request to reach the server");
      // A second change for the same person is already queued: it pauses the connection the moment the first ends.
      const second = setRow(s, "viewer", { fail: true });
      first.finish();
      await withTimeout(first.done, "the removal");
      await second.written;
      await eventually(() => s.personClient.stateless.some((message) => message.requestId === "save-between-two-changes"), "the answer to the save request");
      const answer = s.personClient.stateless.find((message) => message.requestId === "save-between-two-changes")!;
      expect(answer.error ?? null).toBeNull();
      expect(answer.state).not.toBe("error");
      second.finish();
      await expect(withTimeout(second.done, "the failed change")).rejects.toThrow("the change was refused");
      expect(s.connection.readOnly).toBe(false);
    });

    it("a save request from someone whose edit access ended while it waited is answered with \"no permission\"", async () => {
      const s = await scene({ link: "private" });
      const change = setRow(s, "viewer");
      await change.written;
      s.personClient.provider.sendStateless(JSON.stringify({ type: "document-persistence-flush", docId: s.doc.id, requestId: "save-after-lowering" }));
      await eventually(() => s.waiting() === 1, "the save request to reach the server");
      change.finish();
      await withTimeout(change.done, "the lowering");
      await eventually(() => s.personClient.stateless.some((message) => message.requestId === "save-after-lowering"), "the answer to the save request");
      const answer = s.personClient.stateless.find((message) => message.requestId === "save-after-lowering")!;
      expect(answer.state).toBe("error");
      expect(answer.error).toBe("You do not have permission to save this document.");
    });
  });

  describe("no deadlock", () => {
    it("two changes for the same person queue up: each pause holds and releases on its own", async () => {
      const s = await scene();
      const first = removeRow(s);
      const second = setLink(s, "view");
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

    it("a link change and a collaborator change at the same time on one connection run one after the other, and nothing is lost", async () => {
      const s = await scene({ row: null });
      const link = setLink(s, "view", { fail: true });
      const row = setRow(s, "viewer", { fail: true });
      await link.written;
      expect(row.started()).toBe(false);
      s.personClient.type(" one");
      await eventually(() => s.waiting() === 1, "the key to reach the server");
      link.finish();
      await expect(withTimeout(link.done, "the failed link change")).rejects.toThrow();
      await row.written;
      await eventually(() => s.serverText() === "Start one", "the key that waited out the link change");
      s.personClient.type(" two");
      await eventually(() => s.waiting() === 1, "the second key to reach the server");
      row.finish();
      await expect(withTimeout(row.done, "the failed role change")).rejects.toThrow();
      expect(collabAccessChangeBlocks(s.connection)).toBe(false);
      await expectNothingLost(s, "Start one two");
      expect(s.personClient.got.refused).toBe(0);
    });

    it("a stale answer cannot be applied last: the row is removed (the link gives edit) while the link is set to view", async () => {
      const s = await scene();
      // A removes the person's row and reads their access: "Editor, through the link". The answer is kept back.
      const answer = deferred();
      accessLookup.keepNextAnswer = answer.promise;
      const a = removeRow(s);
      await a.written;
      a.finish();
      await eventually(() => accessLookup.kept === 1, "A's access read");
      // B lowers the link meanwhile. If B could run past A, A's older answer would be applied over B's.
      const b = changeLinkAccess(s.doc.id, "view", async () => {
        await updateDocument(s.doc.id, { linkAccess: "view" });
      });
      // B either waits behind A, or (before the fix) finishes while A's answer is still kept back.
      await Promise.race([b, new Promise((resolve) => setTimeout(resolve, 100))]);
      answer.resolve();
      await withTimeout(a.done, "the removal");
      await withTimeout(b, "the link change");
      // What the database says: no row, a view link. The connection says the same, whatever the order was.
      expect(s.connection.context.role).toBe("viewer");
      expect(s.connection.readOnly).toBe(true);
      s.personClient.type(" one");
      await eventually(() => s.personClient.got.refused === 1, "the key to be refused");
      expect(s.serverText()).toBe("Start");
      expect(await s.stored()).toBe("Start");
      expect(s.personClient.got.step1).toBe(1);
    });

    it("changes that end the access, started together: nothing that waited through either is applied", async () => {
      const s = await scene({ row: null });
      const link = setLink(s, "view");
      const row = setRow(s, "viewer", { fail: true });
      await link.written;
      s.personClient.type(" one");
      await eventually(() => s.waiting() === 1, "the key to reach the server");
      link.finish();
      await withTimeout(link.done, "the link change");
      await row.written;
      row.finish();
      await expect(withTimeout(row.done, "the failed role change")).rejects.toThrow();
      await eventually(() => s.personClient.got.refused === 1, "the key to be refused");
      expect(s.connection.readOnly).toBe(true);
      expect(s.serverText()).toBe("Start");
      expect(await s.stored()).toBe("Start");
    });

    it("a change whose lookup of the affected connections fails: later changes and new connections still go through", async () => {
      const s = await scene({ row: null });
      const context = s.connection.context;
      Object.defineProperty(s.connection, "context", {
        configurable: true,
        get() {
          throw new Error("the lookup failed");
        },
      });
      let ran = false;
      const failed = changeLinkAccess(s.doc.id, "view", async () => {
        ran = true;
      });
      await expect(withTimeout(failed, "the change whose lookup fails")).rejects.toThrow("the lookup failed");
      Object.defineProperty(s.connection, "context", { configurable: true, writable: true, enumerable: true, value: context });
      expect(ran).toBe(false);
      expect(collabAccessChangeBlocks(s.connection)).toBe(false);

      // The document's queue of access changes is not stuck: the next change runs, and a new connection gets in.
      const next = setLink(s, "comment");
      await withTimeout(next.written, "the next change to begin");
      next.finish();
      await withTimeout(next.done, "the next change");
      expect(s.connection.context.role).toBe("commenter");
      const late = await withTimeout(s.join(`pause-late-${Date.now().toString(36)}`, "commenter"), "a new connection");
      expect(late.connection.readOnly).toBe(true);
    });

    it("after a message whose handling throws, an access change does not wait for it", async () => {
      const s = await scene();
      const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
      try {
        // A sync message of a kind that does not exist: Hocuspocus throws while handling it and resets the connection.
        const broken = encoding.createEncoder();
        encoding.writeVarString(broken, s.doc.id);
        encoding.writeVarUint(broken, 0);
        encoding.writeVarUint(broken, 99);
        encoding.writeVarUint8Array(broken, new Uint8Array([1, 2, 3]));
        s.personClient.socket.send(encoding.toUint8Array(broken));
        await eventually(() => !s.live.hasConnection(s.connection), "the connection to be reset");
        expect(logged.mock.calls.some((call) => String(call[0]).includes("because of exception"))).toBe(true);
      } finally {
        logged.mockRestore();
      }
      // The same person on a new connection, idle: nothing of theirs is being handled.
      const again = connect(await signCollabToken({ userId: s.person.id, docId: s.doc.id, role: "editor", name: "Person", login: s.login, avatar: null }), s.doc.id);
      await eventually(() => again.provider.isSynced && again.unsent() === 0, "the person's new connection");
      const started = performance.now();
      const change = removeRow(s);
      await withTimeout(change.written, "the change to begin", 1000);
      change.finish();
      await withTimeout(change.done, "the removal", 1000);
      // Far below the 3 s a change may wait for a message that is being handled.
      expect(performance.now() - started).toBeLessThan(1000);
      again.type(" after");
      await eventually(() => s.serverText() === "Start after", "a key on the new connection");
    });

    it("a message still being handled when its connection closes does not hold the next access change up", async () => {
      const s = await scene();
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
      s.personClient.socket.disconnect();
      await eventually(() => !s.live.hasConnection(s.connection), "the connection to close");
      const started = performance.now();
      const change = removeRow(s);
      await withTimeout(change.written, "the change to begin", 1000);
      change.finish();
      await withTimeout(change.done, "the removal", 1000);
      expect(performance.now() - started).toBeLessThan(1000);
      letGo.resolve();
    });
  });

  describe("what the page says while the server asks for the missing part", () => {
    it("typing on through lowered-then-raised: whenever the page says Saved, the stored document equals its text", async () => {
      const s = await scene({ link: "private" });
      const page = s.personClient;
      const wrong: string[] = [];
      const saidSaved = { editor: 0, lowered: 0, raised: 0 };
      let phase: keyof typeof saidSaved = "editor";
      /** Looked at after every event that can change the header: an acknowledgement, a save notice, a key. */
      const look = () => {
        if (page.saveState() !== "saved") return;
        saidSaved[phase] += 1;
        const stored = lastStored.get(s.doc.id);
        if (stored !== page.text()) wrong.push(`${phase}: the page says Saved with "${page.text()}" while the database holds "${stored}"`);
      };
      page.watching.changed = look;
      page.ydoc.on("update", look);

      /** A few keys, then a breath long enough for an Editor's text to be stored (never a fixed wait for the result). */
      const burst = async (label: string) => {
        for (const key of [`${label}a`, `${label}b`, `${label}c`, `${label}d`]) {
          page.type(` ${key}`);
          look();
          await new Promise((resolve) => setImmediate(resolve));
          look();
        }
        const until = Date.now() + 150;
        while (Date.now() < until && page.saveState() !== "saved") {
          await new Promise((resolve) => setTimeout(resolve, 2));
          look();
        }
      };

      await eventually(() => page.saveState() === "saved", "the page to say Saved at the start");
      await burst("e1");
      await burst("e2");
      expect(saidSaved.editor).toBeGreaterThan(0);

      const lowered = setRow(s, "viewer");
      await lowered.written;
      lowered.finish();
      await withTimeout(lowered.done, "the lowering");
      phase = "lowered";
      await burst("v1");
      await burst("v2");
      // Nothing of this is stored, and the page never claimed it was.
      expect(saidSaved.lowered).toBe(0);
      expect(lastStored.get(s.doc.id)).not.toContain("v1a");

      // Edit comes back while they keep typing: keys before the answer, with it, and after it.
      const raised = setRow(s, "editor");
      page.type(" r0");
      look();
      await raised.written;
      page.type(" r1");
      look();
      raised.finish();
      phase = "raised";
      page.type(" r2");
      look();
      await withTimeout(raised.done, "giving edit back");
      await burst("r3");
      await burst("r4");

      await eventually(() => page.saveState() === "saved", "the page to end at Saved");
      look();
      expect(wrong).toEqual([]);
      expect(saidSaved.raised).toBeGreaterThan(0);
      expect(page.unsent()).toBe(0);
      const text = page.text();
      for (const part of ["e1a", "e2d", "v1a", "v2d", "r0", "r1", "r2", "r3a", "r4d"]) expect(text).toContain(part);
      expect(s.serverText()).toBe(text);
      expect(s.ownerClient.text()).toBe(text);
      expect(await s.stored()).toBe(text);
      expect(lastStored.get(s.doc.id)).toBe(text);
    });
  });

  describe("bounded against a client that floods, and shut for good once access ended (review of PR 2283)", () => {
    /** A raw Hocuspocus sync message: 1 = sync step 2, 2 = update. */
    function frame(docId: string, sync: 1 | 2, payload: Uint8Array) {
      const encoder = encoding.createEncoder();
      encoding.writeVarString(encoder, docId);
      encoding.writeVarUint(encoder, 0);
      encoding.writeVarUint(encoder, sync);
      encoding.writeVarUint8Array(encoder, payload);
      return encoding.toUint8Array(encoder);
    }

    /** A client that only does what it is told: it authenticates and never answers the server on its own. */
    async function silentClient(token: string, docId: string) {
      const ws = new WebSocket(url);
      const got = { step1: 0, step2: 0, update: 0, applied: 0, refused: 0, stateless: 0, other: 0 };
      ws.on("message", (data: Buffer) => {
        got[kindOf(new Uint8Array(data.buffer, data.byteOffset, data.byteLength))] += 1;
      });
      await new Promise<void>((resolve, reject) => {
        ws.once("open", () => resolve());
        ws.once("error", reject);
      });
      const hello = encoding.createEncoder();
      encoding.writeVarString(hello, docId);
      encoding.writeVarUint(hello, 2);
      encoding.writeVarUint(hello, 0);
      encoding.writeVarString(hello, token);
      ws.send(encoding.toUint8Array(hello));
      return { ws, got };
    }

    const setRole = async (s: Scene, role: Role | null) => {
      const change = role ? setRow(s, role) : removeRow(s);
      await change.written;
      change.finish();
      await withTimeout(change.done, `the change to ${role ?? "no row"}`);
    };

    it("more refused keys than the limit, then edit comes back: no more acknowledgements than the limit are sent, and all the text is in", async () => {
      const limit = authorization.HOLD_LIMITS.refused;
      const extra = 5_000;
      const s = await scene({ link: "private" });
      await setRole(s, "viewer");
      let typed = "";
      for (let i = 0; i < limit + extra; i += 1) {
        typed += i % 10;
        s.personClient.type(String(i % 10));
      }
      await eventually(() => s.personClient.got.refused === limit + extra, "every key to be refused", 60_000);
      expect(s.serverText()).toBe("Start");
      expect(s.personClient.unsent()).toBe(limit + extra);
      const acknowledgedBefore = s.personClient.got.applied;

      await setRole(s, "editor");
      // Past the limit the connection is still asked for everything: the text is in the live document, the
      // owner's copy and the stored row.
      await eventually(() => s.serverText() === `Start${typed}`, "the text typed while lowered", 20_000);
      expect(s.personClient.got.step1).toBe(2);
      await eventually(() => s.ownerClient.text() === `Start${typed}`, "the owner's copy to have all of it");
      await eventually(async () => (await s.stored()) === `Start${typed}`, "the stored document to have all of it");
      // One acknowledgement for the answer and the owed ones: the limit in all, not one per refused key.
      await eventually(() => s.personClient.got.applied - acknowledgedBefore >= limit, "the acknowledgements");
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(s.personClient.got.applied - acknowledgedBefore).toBe(limit);
      // The accepted cost: the page's counter stays above zero, so its header says "Unsaved changes" until a reload.
      expect(s.personClient.unsent()).toBe(extra);
      await eventually(() => s.personClient.saveState() === "pending", `the page to say Unsaved changes (it says ${s.personClient.saveState()})`);
      // Saving goes on all the same.
      s.personClient.type(" after");
      await eventually(async () => (await s.stored()) === `Start${typed} after`, "a later key to be stored");
      expect(s.ownerClient.text()).toBe(`Start${typed} after`);
      expect(s.personClient.unsent()).toBe(extra);
      expect(s.live.store.pendingStructs).toBeNull();
    }, 120_000);

    it("lowered and raised three times without ever answering: what is owed does not add up past the limit", async () => {
      authorization.HOLD_LIMITS.refused = 20;
      const s = await scene({ link: "private", row: "viewer" });
      const silent = await silentClient(await signCollabToken({ userId: s.person.id, docId: s.doc.id, role: "viewer", name: "Person", login: s.login, avatar: null }), s.doc.id);
      await eventually(() => s.live.getConnections().filter((candidate) => candidate.context.userId === s.person.id).length === 2, "the silent client to be connected");
      try {
        const update = frame(s.doc.id, 2, new Uint8Array(0));
        for (let cycle = 1; cycle <= 3; cycle += 1) {
          for (let i = 0; i < 15; i += 1) silent.ws.send(update);
          await eventually(() => silent.got.refused === 15 * cycle, "fifteen updates to be refused");
          await setRole(s, "editor");
          await eventually(() => silent.got.step1 === cycle, "the server to ask for a full sync");
          if (cycle < 3) await setRole(s, "viewer");
        }
        expect(silent.got.applied).toBe(0);
        // Now it answers, with nothing: 1 for the answer and 19 owed, not 1 + 14 + 14 + 14.
        silent.ws.send(frame(s.doc.id, 1, Y.encodeStateAsUpdate(new Y.Doc())));
        await eventually(() => silent.got.applied >= 20, "the acknowledgements");
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(silent.got.applied).toBe(20);
        expect(s.serverText()).toBe("Start");
      } finally {
        silent.ws.terminate();
      }
    });

    it("a person below the limit still gets the exact number: 150 keys refused while lowered, 150 acknowledgements, and the page ends at Saved", async () => {
      const s = await scene({ link: "private" });
      await setRole(s, "viewer");
      let typed = "";
      for (let i = 0; i < 150; i += 1) {
        const key = String.fromCharCode(97 + (i % 26));
        typed += key;
        s.personClient.type(key);
      }
      await eventually(() => s.personClient.got.refused === 150, "every key to be refused");
      const acknowledgedBefore = s.personClient.got.applied;
      await setRole(s, "editor");
      await expectNothingLost(s, `Start${typed}`);
      expect(s.personClient.got.applied - acknowledgedBefore).toBe(150);
      await eventually(() => s.personClient.saveState() === "saved", "the page to say Saved");
    });

    it.each([
      ["the time limit", "time"],
      ["the size limit", "size"],
    ])("removed for good after the pause fell back to refusing at %s: the connection stays shut, nothing is applied, nothing is asked for", async (_what, bound) => {
      if (bound === "time") authorization.HOLD_LIMITS.ms = 120;
      else authorization.HOLD_LIMITS.messages = 3;
      const s = await scene({ link: "private" });
      s.personClient.type(" before");
      await eventually(() => s.serverText() === "Start before", "the key typed before the change");
      const change = removeRow(s);
      await change.written;
      const keys = bound === "time" ? 2 : 6;
      for (let i = 0; i < keys; i += 1) s.personClient.type(` k${i}`);
      await eventually(() => s.personClient.got.refused === keys, "the keys to be refused once the limit is hit", 2000);
      expect(collabAccessChangeBlocks(s.connection)).toBe(true);
      const everything = Y.encodeStateAsUpdate(s.personClient.ydoc);

      change.finish();
      await withTimeout(change.done, "the removal");
      // The pause ended while refusing, so the connection's access was applied once more: it must not be opened again.
      expect(s.live.hasConnection(s.connection)).toBe(false);
      expect(s.connection.readOnly).toBe(true);
      // A full state and an update that were already in the server's hands: neither is applied.
      s.connection.handleMessage(frame(s.doc.id, 1, everything));
      s.connection.handleMessage(frame(s.doc.id, 2, everything));
      await eventually(() => s.waiting() === 0, "the two messages to be handled");
      expect(s.connection.readOnly).toBe(true);
      expect(s.serverText()).toBe("Start before");
      expect(s.ownerClient.text()).toBe("Start before");
      expect(await s.stored()).toBe("Start before");
      // No full sync is asked of someone whose access ended.
      expect(s.personClient.got.step1).toBe(1);
      expect(s.live.store.pendingStructs).toBeNull();
    });

    it("a failed change whose access lookup fails too: the connection is closed and nothing that waited is applied", async () => {
      const s = await scene({ link: "private" });
      const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
      try {
        const change = setRow(s, "viewer", { fail: true });
        await change.written;
        s.personClient.type(" one");
        await eventually(() => s.waiting() === 1, "the key to reach the server");
        // The database still says Editor, but nobody can tell: restoring the access fails as well.
        const failing = Promise.reject(new Error("the access lookup failed"));
        failing.catch(() => undefined);
        accessLookup.gate = failing;
        change.finish();
        await expect(withTimeout(change.done, "the failed change")).rejects.toThrow("the change was refused");
        expect(logged.mock.calls.some((call) => String(call[0]).includes("failed to restore access"))).toBe(true);
      } finally {
        logged.mockRestore();
      }
      expect(s.live.hasConnection(s.connection)).toBe(false);
      expect(s.connection.readOnly).toBe(true);
      await eventually(() => s.waiting() === 0, "the key that waited to be handled");
      expect(s.serverText()).toBe("Start");
      expect(s.ownerClient.text()).toBe("Start");
      expect(await s.stored()).toBe("Start");
      expect(s.personClient.got.step1).toBe(1);
    });

    it.each([
      ["removed for good", null],
      ["lowered to Viewer", "viewer"],
    ] as const)("a second connection of theirs that authenticates during the pause, before the database write, waits for the change: %s", async (_what, role) => {
      const s = await scene({ link: "private" });
      const token = await signCollabToken({ userId: s.person.id, docId: s.doc.id, role: "editor", name: "Person", login: s.login, avatar: null });
      const mine = () => s.live.getConnections().filter((candidate) => candidate.context.userId === s.person.id);
      const write = deferred();
      const change = slowChange(
        (mutation) => changeCollaboratorAccess(s.doc.id, s.login, role, mutation),
        async () => {
          await write.promise;
          await (role ? upsertCollaborator(s.doc.id, s.login, role, s.owner.id) : removeCollaborator(s.doc.id, s.login));
        },
      );
      await eventually(() => collabAccessChangeBlocks(s.connection), "the pause");
      s.personClient.type(" one");
      // The database still says Editor. A connection that did not wait for the change would come in writable
      // and, not being one of the paused connections, would stay writable after the change.
      const second = await silentClient(token, s.doc.id);
      try {
        await new Promise((resolve) => setTimeout(resolve, 150));
        expect(mine()).toHaveLength(1);
        write.resolve();
        await change.written;
        change.finish();
        await withTimeout(change.done, "the change");
        if (role) await eventually(() => mine().length === 2, "the second connection to be let in after the change");
        else await new Promise((resolve) => setTimeout(resolve, 150));
        expect(mine()).toHaveLength(role ? 2 : 0);
        expect(mine().filter((candidate) => !candidate.readOnly)).toEqual([]);
        // Everything the person has, sent over the second connection as a full state and as an update.
        const everything = Y.encodeStateAsUpdate(s.personClient.ydoc);
        second.ws.send(frame(s.doc.id, 1, everything));
        second.ws.send(frame(s.doc.id, 2, everything));
        if (role) await eventually(() => second.got.refused === 2, "both to be refused");
        else await new Promise((resolve) => setTimeout(resolve, 150));
        expect(second.got.applied).toBe(0);
        expect(s.serverText()).toBe("Start");
        expect(s.ownerClient.text()).toBe("Start");
        expect(await s.stored()).toBe("Start");
      } finally {
        second.ws.terminate();
      }
    });

    it("messages of several kinds that waited are handled in the order they arrived", async () => {
      const s = await scene();
      const handled: string[] = [];
      const after = s.connection.callbacks.afterHandleMessage;
      s.connection.callbacks.afterHandleMessage = async (connection, update) => {
        handled.push(kindOf(update));
        return after(connection, update);
      };
      const change = removeRow(s);
      await change.written;
      s.personClient.type(" one");
      s.personClient.provider.sendStateless(JSON.stringify({ type: "document-persistence-status", docId: s.doc.id, requestId: "status-between" }));
      s.personClient.type(" two");
      s.personClient.provider.setAwarenessField("user", { name: "Person" });
      s.personClient.provider.sendStateless(JSON.stringify({ type: "document-persistence-status", docId: s.doc.id, requestId: "status-last" }));
      s.personClient.type(" three");
      await eventually(() => s.waiting() === 6, "the six messages to reach the server");
      expect(handled).toEqual([]);

      change.finish();
      await withTimeout(change.done, "the removal");
      await eventually(() => handled.length === 6, "the six messages to be handled");
      // An update, a status request, an update, presence ("other"), a status request, an update: as sent.
      expect(handled).toEqual(["update", "stateless", "update", "other", "stateless", "update"]);
      expect(s.personClient.stateless.filter((message) => message.requestId?.startsWith("status-")).map((message) => message.requestId)).toEqual(["status-between", "status-last"]);
      await expectNothingLost(s, "Start one two three");
    });

    describe("the owed acknowledgements go out a slice per turn of the event loop, the least owed first", () => {
      const sockets: WebSocket[] = [];
      afterEach(() => {
        vi.restoreAllMocks();
        for (const socket of sockets.splice(0)) socket.terminate();
      });

      /** `count` connections of the person, a signed-in visitor of a "view" link: read-only until the link gives edit. */
      async function visitors(s: Scene, count: number) {
        const token = await signCollabToken({ userId: s.person.id, docId: s.doc.id, role: "viewer", name: "Person", login: s.login, avatar: null });
        const mine = () => s.live.getConnections().filter((candidate) => candidate.context.userId === s.person.id && candidate !== s.connection);
        const clients: Awaited<ReturnType<typeof silentClient>>[] = [];
        for (let i = 0; i < count; i += 1) {
          clients.push(await silentClient(token, s.doc.id));
          sockets.push(clients[i].ws);
          await eventually(() => mine().length === i + 1, "the visitor's connection");
        }
        // What the server sends each of them as "applied", counted where it is sent.
        const sent = mine().map((connection) => {
          const counter = { applied: 0, connection };
          const send = connection.send.bind(connection);
          connection.send = (message: Uint8Array) => {
            if (kindOf(message) === "applied") counter.applied += 1;
            send(message);
          };
          return counter;
        });
        return { clients, sent, total: () => sent.reduce((sum, counter) => sum + counter.applied, 0) };
      }

      /** Each client has `count` updates refused, the link is opened for editing, and the server asks each for a full sync. */
      async function refusedThenRaised(s: Scene, clients: Awaited<ReturnType<typeof silentClient>>[], counts: number[]) {
        const update = frame(s.doc.id, 2, new Uint8Array(0));
        const before = clients.map((client) => ({ refused: client.got.refused, step1: client.got.step1 }));
        clients.forEach((client, index) => {
          for (let i = 0; i < counts[index]; i += 1) client.ws.send(update);
        });
        await eventually(() => clients.every((client, index) => client.got.refused === before[index].refused + counts[index]), "every update to be refused", 20_000);
        const raised = setLink(s, "edit");
        await raised.written;
        raised.finish();
        await withTimeout(raised.done, "the link change");
        await eventually(() => clients.every((client, index) => client.got.step1 === before[index].step1 + 1), "the server to ask every connection for a full sync");
      }

      /** Takes over the turns of the event loop the pump waits for: `turn()` runs one and says how many acknowledgements it sent. */
      function pumpByHand(total: () => number) {
        const real = globalThis.setImmediate;
        const waiting: (() => void)[] = [];
        vi.spyOn(globalThis, "setImmediate").mockImplementation(((callback: (...args: unknown[]) => void, ...args: unknown[]) => {
          if (callback.name !== "pumpAcknowledgements") return real(callback, ...args);
          waiting.push(() => callback(...args));
          return undefined;
        }) as never);
        return {
          scheduled: () => waiting.length,
          turn: () => {
            const before = total();
            waiting.shift()!();
            return total() - before;
          },
        };
      }

      const answer = (s: Scene) => frame(s.doc.id, 1, Y.encodeStateAsUpdate(new Y.Doc()));

      it("fifty flooded connections raised by one link change and answering at once: one slice per turn, and each still gets exactly the limit", async () => {
        Object.assign(authorization.HOLD_LIMITS, { refused: 40, acknowledgedPerTurn: 25 });
        const s = await scene({ link: "view", row: null });
        const { clients, sent, total } = await visitors(s, 50);
        await refusedThenRaised(s, clients, clients.map(() => 45));
        const pump = pumpByHand(total);
        for (const client of clients) client.ws.send(answer(s));
        // Every answer is handled (Hocuspocus acknowledges each itself). 50 x 39 are owed; only the first slice is out.
        await eventually(() => sent.every((counter) => counter.applied >= 1), "every answer to be handled");
        expect(total()).toBe(50 + 25);
        expect(pump.scheduled()).toBe(1);
        const slices: number[] = [];
        while (pump.scheduled() > 0) {
          slices.push(pump.turn());
          // One pump, whatever else happens: never two turns waiting.
          expect(pump.scheduled()).toBeLessThanOrEqual(1);
        }
        // The other 1,925 took 77 turns of 25, not one turn; then nothing is left scheduled.
        expect(slices).toEqual(Array.from({ length: 77 }, () => 25));
        expect(sent.map((counter) => counter.applied)).toEqual(sent.map(() => 40));
        await eventually(() => clients.every((client) => client.got.applied === 40), "every client to have received the limit");
        expect(s.serverText()).toBe("Start");
      });

      it("a person's 149 owed do not wait behind a flood: ten flooded connections are queued first, the person is done after 8 turns", async () => {
        Object.assign(authorization.HOLD_LIMITS, { refused: 400, acknowledgedPerTurn: 20 });
        const s = await scene({ link: "view", row: null });
        const { clients, sent, total } = await visitors(s, 11);
        const person = 10;
        await refusedThenRaised(s, clients, clients.map((_, index) => (index === person ? 150 : 410)));
        const pump = pumpByHand(total);
        clients.forEach((client, index) => {
          if (index !== person) client.ws.send(answer(s));
        });
        await eventually(() => sent.every((counter, index) => index === person || counter.applied >= 1), "the ten flooded answers to be handled");
        // The flood is queued: 10 x 399, of which the first 20 are out.
        expect(total()).toBe(10 + 20);
        clients[person].ws.send(answer(s));
        await eventually(() => sent[person].applied === 1, "the person's answer to be handled");
        let turns = 0;
        while (sent[person].applied < 150) {
          pump.turn();
          turns += 1;
        }
        expect(turns).toBe(8);
        // At that moment the flood has got the first slice and what the person's last turn left over: 20 + 11.
        expect(total() - sent[person].applied).toBe(10 + 20 + 11);
        while (pump.scheduled() > 0) pump.turn();
        expect(sent.map((counter) => counter.applied)).toEqual(sent.map((_, index) => (index === person ? 150 : 400)));
      });

      it.each([
        ["closes", "close"],
        ["cannot be sent to (the send throws)", "throw"],
      ])("a connection that %s while its acknowledgements wait loses its place, and the others still get theirs", async (_what, how) => {
        Object.assign(authorization.HOLD_LIMITS, { refused: 60, acknowledgedPerTurn: 10 });
        const s = await scene({ link: "view", row: null });
        const { clients, sent, total } = await visitors(s, 3);
        await refusedThenRaised(s, clients, [65, 65, 65]);
        const pump = pumpByHand(total);
        for (const client of clients) client.ws.send(answer(s));
        await eventually(() => sent.every((counter) => counter.applied >= 1), "every answer to be handled");
        expect(total()).toBe(3 + 10);
        const gone = sent.findIndex((counter) => counter.applied === 1);
        if (how === "close") sent[gone].connection.close({ code: 1000, reason: "gone" });
        else {
          const send = sent[gone].connection.send.bind(sent[gone].connection);
          sent[gone].connection.send = (message: Uint8Array) => {
            if (kindOf(message) === "applied") throw new Error("the socket is gone");
            send(message);
          };
        }
        while (pump.scheduled() > 0) pump.turn();
        expect(sent.map((counter) => counter.applied)).toEqual(sent.map((_, index) => (index === gone ? 1 : 60)));
        expect(pump.scheduled()).toBe(0);
      });

      it("more is owed to a connection that is still waiting: one entry, never more than the limit, one pump", async () => {
        Object.assign(authorization.HOLD_LIMITS, { refused: 60, acknowledgedPerTurn: 10 });
        const s = await scene({ link: "view", row: null });
        const { clients, total } = await visitors(s, 1);
        await refusedThenRaised(s, clients, [65]);
        const pump = pumpByHand(total);
        clients[0].ws.send(answer(s));
        await eventually(() => total() === 1 + 10, "the answer to be handled and the first slice sent");
        // 49 are still waiting. The link is lowered and raised again, and the connection answers once more.
        const lowered = setLink(s, "view");
        await lowered.written;
        lowered.finish();
        await withTimeout(lowered.done, "the link change");
        await refusedThenRaised(s, clients, [65]);
        clients[0].ws.send(answer(s));
        await eventually(() => total() === 1 + 10 + 1, "the second answer to be handled");
        expect(pump.scheduled()).toBe(1);
        const slices: number[] = [];
        while (pump.scheduled() > 0) slices.push(pump.turn());
        // 49 + 59 would be 108: the entry is held at the limit, 60.
        expect(slices).toEqual([10, 10, 10, 10, 10, 10]);
        expect(total()).toBe(1 + 10 + 1 + 60);
      });

      it("the bounds are the ones the review of PR 2283 settled on: changing one is a decision, not a side effect", () => {
        // The tests above lower the limit and the slice to keep their numbers small. These are the real ones.
        expect({ ...authorization.HOLD_LIMITS }).toEqual({ ms: 3_000, messages: 500, bytes: 1024 * 1024, refused: 2_000, acknowledgedPerTurn: 100 });
      });

      it("at the real bounds, one connection past the limit: 2,000 acknowledgements in 20 slices, never more than 100 in one turn", async () => {
        const s = await scene({ link: "view", row: null });
        const { clients, sent, total } = await visitors(s, 1);
        await refusedThenRaised(s, clients, [2_500]);
        const pump = pumpByHand(total);
        clients[0].ws.send(answer(s));
        // The answer is handled: Hocuspocus acknowledges it itself, and the first slice of the 1,999 owed is out.
        await eventually(() => total() >= 1, "the answer to be handled");
        expect(total()).toBe(1 + 100);
        const slices = [100];
        while (pump.scheduled() > 0) slices.push(pump.turn());
        expect(slices).toEqual([...Array.from({ length: 19 }, () => 100), 99]);
        expect(sent[0].applied).toBe(2_000);
        await eventually(() => clients[0].got.applied === 2_000, "the client to have received all of them");
      });
    });
  });
});
