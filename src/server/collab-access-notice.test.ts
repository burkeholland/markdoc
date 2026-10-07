import { describe, expect, it, beforeAll, afterAll, afterEach, vi } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import WebSocket from "ws";
import * as Y from "yjs";
import { HocuspocusProvider, HocuspocusProviderWebsocket } from "@hocuspocus/provider";

/**
 * Issue #2269: the server tells a live connection that its own access changed.
 *
 * One stateless message, `{ type: "access-changed", role }`, to each connection whose role really changed,
 * after the new access is applied and before its waiting messages go on; `role: null` just before a
 * connection that lost its access is closed. Nobody else hears of it, and nothing is said when nothing changed.
 * The harness is the one of collab-access-pause.test.ts: a real collaboration server and real providers.
 */

process.env.PGLITE_DATA_DIR = "memory://";
process.env.AUTH_SECRET = "test-secret-test-secret-test-secret";
delete process.env.DATABASE_URL;
delete process.env.COLLAB_ACCESS_CHANGE_TEST_DELAY_MS;

vi.mock("@/auth", () => ({ auth: async () => null }));

const { getDb, schema } = await import("./db");
const { createCollabServer, shutdownCollab, TEXT_KEY } = await import("./collab/hocuspocus");
const { attachCollab } = await import("./collab/ws");
const { signCollabToken } = await import("./collab/token");
const { registerCollab } = await import("./collab/registry");
const { createDocument, removeCollaborator, updateDocument, upsertCollaborator } = await import("./documents");
const authorization = await import("./collab/authorization");
const { changeCollaboratorAccess, changeLinkAccess, collabAccessChangeBlocks, collabConnectionOpened } = authorization;
const { createApiToken } = await import("./tokens");

type Role = "editor" | "commenter" | "viewer";
type LinkAccess = "private" | "view" | "comment" | "edit";
type AccessMessage = { type: "access-changed"; role: Role | "owner" | null };

async function eventually(check: () => boolean | Promise<boolean>, what: string, timeout = 5000): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (await check()) return;
    if (Date.now() - start > timeout) throw new Error(`timed out waiting for: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** `refused` is the server's "not applied" answer to an update of a read-only connection. */
function kindOf(data: ArrayBuffer | Uint8Array): "refused" | "other" {
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
  return bytes[i] === 8 && bytes[i + 1] !== 1 ? "refused" : "other";
}

describe("the server tells a connection that its own access changed (issue #2269)", () => {
  let server: Server;
  let url: string;
  let hocuspocus: ReturnType<typeof createCollabServer>;
  let serial = 0;
  const open = new Set<{ provider: HocuspocusProvider; socket: HocuspocusProviderWebsocket }>();
  const limits = { ...authorization.HOLD_LIMITS };

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
    Object.assign(authorization.HOLD_LIMITS, limits);
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
    /** Every `access-changed` message, in order. */
    const told: AccessMessage[] = [];
    /** What arrived, in order: an access message, a refused update, the close of the document. */
    const trace: string[] = [];
    const provider: HocuspocusProvider = new HocuspocusProvider({
      websocketProvider: socket,
      name,
      document: ydoc,
      token,
      onMessage: ({ message }) => {
        if (kindOf((message as unknown as { data: ArrayBuffer }).data) === "refused") trace.push("refused");
      },
      onStateless: ({ payload }) => {
        const message = JSON.parse(payload) as AccessMessage;
        if (message?.type !== "access-changed") return;
        told.push(message);
        trace.push(`access:${message.role}`);
      },
      onClose: ({ event }) => {
        if ((event as { reason?: string }).reason === "Unauthorized") trace.push("closed");
      },
    });
    provider.attach();
    void socket.connect();
    const client = {
      ydoc,
      provider,
      socket,
      told,
      trace,
      roles: () => told.map((message) => message.role),
      type: (text: string) => ydoc.getText(TEXT_KEY).insert(ydoc.getText(TEXT_KEY).length, text),
    };
    open.add(client);
    return client;
  }

  interface SceneOptions {
    link?: LinkAccess;
    row?: Role | null;
    agent?: boolean;
    /** The role the person's token claims, when it is not the one the database holds. */
    tokenRole?: Role;
  }

  async function scene({ link = "private", row = "editor", agent = false, tokenRole }: SceneOptions = {}) {
    const tag = `${Date.now().toString(36)}${(serial += 1)}`;
    const db = await getDb();
    const [owner] = await db.insert(schema.users).values({ name: "Owner", login: `notice-owner-${tag}`, email: `notice-owner-${tag}@example.com` }).returning();
    const [person] = await db.insert(schema.users).values({ name: "Person", login: `notice-person-${tag}`, email: `notice-person-${tag}@example.com` }).returning();
    const doc = await createDocument({ ownerId: owner.id, content: "Start" });
    if (link !== "private") await updateDocument(doc.id, { linkAccess: link });
    if (row) await upsertCollaborator(doc.id, person.login!, row, owner.id);
    const startsAs = row ?? (link === "edit" ? "editor" : link === "comment" ? "commenter" : "viewer");
    const apiToken = agent ? await createApiToken(person.id, `Agent ${tag}`, { scope: "full", documentIds: [doc.id] }) : null;
    const personToken = () =>
      signCollabToken({
        userId: person.id,
        docId: doc.id,
        role: tokenRole ?? startsAs,
        name: "Person",
        login: person.login,
        avatar: null,
        ...(apiToken ? { tokenId: apiToken.id, tokenScope: apiToken.scope, tokenExpiresAt: apiToken.expiresAt?.getTime() ?? null } : {}),
      });
    const ownerClient = connect(await signCollabToken({ userId: owner.id, docId: doc.id, role: "owner", name: "Owner", login: owner.login, avatar: null }), doc.id);
    const personClient = connect(await personToken(), doc.id);
    await eventually(() => ownerClient.provider.isSynced && personClient.provider.isSynced && personClient.provider.unsyncedChanges === 0, "both clients in sync");
    const live = hocuspocus.documents.get(doc.id)!;
    const connectionsOf = (userId: string) => live.getConnections().filter((candidate) => candidate.context.userId === userId);
    return {
      owner,
      person,
      doc,
      ownerClient,
      personClient,
      live,
      connection: connectionsOf(person.id)[0]!,
      connectionsOf,
      login: person.login!,
      personToken,
      serverText: () => live.getText(TEXT_KEY).toString(),
      /** Another connection: someone else (a login, or a visitor through the link when `visitor`), or a second tab of the person. */
      join: async (who: { login: string; role: Role; row?: Role } | { visitor: Role } | "second tab") => {
        if (who === "second tab") {
          const client = connect(await personToken(), doc.id);
          await eventually(() => client.provider.isSynced, "the second tab in sync");
          return client;
        }
        if ("visitor" in who) {
          const client = connect(await signCollabToken({ userId: `anon-${tag}`, docId: doc.id, role: who.visitor, name: "Anonymous", login: null, avatar: null }), doc.id);
          await eventually(() => client.provider.isSynced, "the visitor in sync");
          return client;
        }
        const [user] = await db.insert(schema.users).values({ name: who.login, login: `${who.login}-${tag}`, email: `${who.login}-${tag}@example.com` }).returning();
        if (who.row) await upsertCollaborator(doc.id, user.login!, who.row, owner.id);
        const client = connect(await signCollabToken({ userId: user.id, docId: doc.id, role: who.role, name: who.login, login: user.login, avatar: null }), doc.id);
        await eventually(() => client.provider.isSynced, `${who.login} in sync`);
        return client;
      },
    };
  }

  type Scene = Awaited<ReturnType<typeof scene>>;
  const setRow = (s: Scene, role: Role) => changeCollaboratorAccess(s.doc.id, s.login, role, async () => void (await upsertCollaborator(s.doc.id, s.login, role, s.owner.id)));
  const removeRow = (s: Scene) => changeCollaboratorAccess(s.doc.id, s.login, null, async () => void (await removeCollaborator(s.doc.id, s.login)));
  const setLink = (s: Scene, link: LinkAccess) => changeLinkAccess(s.doc.id, link, async () => void (await updateDocument(s.doc.id, { linkAccess: link })));
  /** Everything the server has sent so far has arrived: a marker message comes back after it. */
  async function settled(s: Scene, ...clients: ReturnType<typeof connect>[]) {
    const marker = JSON.stringify({ type: "marker", id: (serial += 1) });
    const seen = new Set<ReturnType<typeof connect>>();
    const all = [s.ownerClient, ...clients];
    const listeners = all.map((client) => {
      const listener = ({ payload }: { payload: string }) => {
        if (payload === marker) seen.add(client);
      };
      client.provider.on("stateless", listener);
      return () => client.provider.off("stateless", listener);
    });
    s.live.broadcastStateless(marker);
    try {
      await eventually(() => all.every((client) => seen.has(client) || !client.provider.isAuthenticated), "the marker to arrive");
    } finally {
      for (const off of listeners) off();
    }
  }

  describe("a collaborator's role changes", () => {
    it.each([
      ["editor", "viewer"],
      ["editor", "commenter"],
      ["commenter", "viewer"],
      ["viewer", "editor"],
      ["commenter", "editor"],
      ["viewer", "commenter"],
    ] as const)("%s to %s: that person's connection is told the new role once, the owner nothing", async (from, to) => {
      const s = await scene({ row: from });
      await setRow(s, to);
      await eventually(() => s.personClient.told.length > 0, "the person to be told");
      await settled(s, s.personClient);
      expect(s.personClient.told).toEqual([{ type: "access-changed", role: to }]);
      expect(s.ownerClient.told).toEqual([]);
      expect(s.connection.context.role).toBe(to);
    });

    it("an agent (API token) connection is told too", async () => {
      const s = await scene({ agent: true });
      await setRow(s, "viewer");
      await eventually(() => s.personClient.told.length > 0, "the agent to be told");
      expect(s.personClient.roles()).toEqual(["viewer"]);
    });

    it("the same role again says nothing", async () => {
      const s = await scene({ row: "viewer" });
      await setRow(s, "viewer");
      await settled(s, s.personClient);
      expect(s.personClient.told).toEqual([]);
    });

    it("the row is removed while the link gives the same role: nothing is said, the person can still edit", async () => {
      const s = await scene({ link: "edit", row: "editor" });
      await removeRow(s);
      await settled(s, s.personClient);
      expect(s.personClient.told).toEqual([]);
      expect(s.connection.readOnly).toBe(false);
    });

    it("the row is removed and the link gives less: told the role the link gives", async () => {
      const s = await scene({ link: "view", row: "editor" });
      await removeRow(s);
      await eventually(() => s.personClient.told.length > 0, "the person to be told");
      expect(s.personClient.roles()).toEqual(["viewer"]);
    });

    it("removed with a private link: told null once, and only then closed", async () => {
      const s = await scene();
      await removeRow(s);
      await eventually(() => s.personClient.trace.includes("closed"), "the document to be closed for the person");
      expect(s.personClient.trace).toEqual(["access:null", "closed"]);
      expect(s.live.hasConnection(s.connection)).toBe(false);
      await settled(s);
      expect(s.ownerClient.told).toEqual([]);
    });

    it("two tabs of the person are both told, once each", async () => {
      const s = await scene();
      const second = await s.join("second tab");
      await setRow(s, "commenter");
      await eventually(() => s.personClient.told.length > 0 && second.told.length > 0, "both tabs to be told");
      await settled(s, s.personClient, second);
      expect(s.personClient.roles()).toEqual(["commenter"]);
      expect(second.roles()).toEqual(["commenter"]);
    });

    it("another collaborator on the document hears nothing", async () => {
      const s = await scene();
      const other = await s.join({ login: "bystander", role: "editor", row: "editor" });
      await setRow(s, "viewer");
      await eventually(() => s.personClient.told.length > 0, "the person to be told");
      await settled(s, s.personClient, other);
      expect(other.told).toEqual([]);
      expect(s.ownerClient.told).toEqual([]);
    });

    it("two changes in a row are told in order, one message each", async () => {
      const s = await scene();
      const first = setRow(s, "viewer");
      const second = setRow(s, "editor");
      await Promise.all([first, second]);
      await eventually(() => s.personClient.told.length >= 2, "both changes to be told");
      await settled(s, s.personClient);
      expect(s.personClient.roles()).toEqual(["viewer", "editor"]);
    });

    it("lowered and then removed: the role, then null and the close", async () => {
      const s = await scene();
      await setRow(s, "viewer");
      await removeRow(s);
      await eventually(() => s.personClient.trace.includes("closed"), "the document to be closed for the person");
      expect(s.personClient.trace).toEqual(["access:viewer", "access:null", "closed"]);
    });
  });

  describe("when the message is sent", () => {
    /** A change whose database write is done and whose mutation has not returned: the pause is on. */
    function slowLowering(s: Scene, { fail = false, write = true } = {}) {
      const hold = deferred();
      const written = deferred();
      const done = changeCollaboratorAccess(s.doc.id, s.login, "viewer", async () => {
        if (write) await upsertCollaborator(s.doc.id, s.login, "viewer", s.owner.id);
        written.resolve();
        await hold.promise;
        if (fail) throw new Error("the change was refused");
      });
      done.catch(() => undefined);
      return { done, written: written.promise, finish: hold.resolve };
    }

    it("not while the connection is still paused under its old access; then with the new access in place and before any waiting key is refused", async () => {
      const s = await scene();
      /** What the server's side of the connection looked like at the moment it sent the message. */
      const atSend: { readOnly: boolean; role: string; paused: boolean; waiting: number }[] = [];
      const send = s.connection.sendStateless.bind(s.connection);
      s.connection.sendStateless = (payload: string) => {
        if (payload.includes("access-changed")) {
          atSend.push({
            readOnly: s.connection.readOnly,
            role: s.connection.context.role,
            paused: collabAccessChangeBlocks(s.connection),
            waiting: (s.connection as unknown as { messageQueue: unknown[] }).messageQueue.length,
          });
        }
        send(payload);
      };
      const change = slowLowering(s);
      await change.written;
      s.personClient.type(" one");
      s.personClient.type(" two");
      await eventually(() => (s.connection as unknown as { messageQueue: unknown[] }).messageQueue.length === 2, "the two keys to wait on the server");
      await settled(s, s.personClient);
      // The database says Viewer already, the change has not ended: nothing has been said.
      expect(s.personClient.told).toEqual([]);
      expect(atSend).toEqual([]);

      change.finish();
      await change.done;
      await eventually(() => s.personClient.trace.filter((entry) => entry === "refused").length === 2, "the two keys to be refused");
      // Sent once, read-only and Viewer already, still paused, both keys still waiting.
      expect(atSend).toEqual([{ readOnly: true, role: "viewer", paused: true, waiting: 2 }]);
      // And the page hears of it before it hears that its keys were refused.
      expect(s.personClient.trace).toEqual(["access:viewer", "refused", "refused"]);
      expect(s.serverText()).toBe("Start");
    });

    it("a change that fails before it wrote anything, and is restored, says nothing", async () => {
      const s = await scene();
      const change = slowLowering(s, { fail: true, write: false });
      await change.written;
      s.personClient.type(" one");
      change.finish();
      await expect(change.done).rejects.toThrow("the change was refused");
      await eventually(() => s.serverText() === "Start one", "the key that waited to be applied");
      await settled(s, s.personClient);
      expect(s.personClient.told).toEqual([]);
      expect(s.connection.readOnly).toBe(false);
    });

    it("a change that fails after its write went through: the role did change, so the person is told, once", async () => {
      const s = await scene();
      const change = slowLowering(s, { fail: true });
      await change.written;
      change.finish();
      await expect(change.done).rejects.toThrow("the change was refused");
      await eventually(() => s.personClient.told.length > 0, "the person to be told");
      await settled(s, s.personClient);
      expect(s.personClient.roles()).toEqual(["viewer"]);
    });

    it.each([
      ["more messages than the limit", { messages: 2 }],
      ["more bytes than the limit", { bytes: 64 }],
      ["a pause longer than the limit", { ms: 30 }],
    ] as const)("a connection whose hold hit a bound during the pause (%s) is still told exactly once", async (_what, limit) => {
      const s = await scene();
      Object.assign(authorization.HOLD_LIMITS, limit);
      const change = slowLowering(s);
      await change.written;
      for (const key of [" one", " two", " three", " four"]) s.personClient.type(key + "x".repeat(40));
      // The bound is hit while the change still runs: the hold falls back to refusing.
      await eventually(() => s.personClient.trace.filter((entry) => entry === "refused").length > 0, "the hold to fall back to refusing");
      expect(s.personClient.told).toEqual([]);
      change.finish();
      await change.done;
      await eventually(() => s.personClient.told.length > 0, "the person to be told");
      await settled(s, s.personClient);
      expect(s.personClient.roles()).toEqual(["viewer"]);
      expect(s.serverText()).toBe("Start");
    });
  });

  describe("the link's access changes", () => {
    it("edit to view: people in through the link are told, a visitor who is not signed in too; the owner and an explicit collaborator are not", async () => {
      const s = await scene({ link: "edit", row: null });
      const collaborator = await s.join({ login: "explicit", role: "editor", row: "editor" });
      const visitor = await s.join({ visitor: "editor" });
      await setLink(s, "view");
      await eventually(() => s.personClient.told.length > 0 && visitor.told.length > 0, "the link people to be told");
      await settled(s, s.personClient, collaborator, visitor);
      expect(s.personClient.roles()).toEqual(["viewer"]);
      expect(visitor.roles()).toEqual(["viewer"]);
      expect(collaborator.told).toEqual([]);
      expect(s.ownerClient.told).toEqual([]);
    });

    it("edit to off: told null, then closed", async () => {
      const s = await scene({ link: "edit", row: null });
      await setLink(s, "private");
      await eventually(() => s.personClient.trace.includes("closed"), "the document to be closed for the person");
      expect(s.personClient.trace).toEqual(["access:null", "closed"]);
    });

    it("view to edit: told Editor", async () => {
      const s = await scene({ link: "view", row: null });
      await setLink(s, "edit");
      await eventually(() => s.personClient.told.length > 0, "the person to be told");
      expect(s.personClient.roles()).toEqual(["editor"]);
    });

    it("the person is also an explicit collaborator: the link changes nothing for them, and nothing is said", async () => {
      const s = await scene({ link: "edit", row: "editor" });
      await setLink(s, "private");
      await settled(s, s.personClient);
      expect(s.personClient.told).toEqual([]);
      expect(s.connection.readOnly).toBe(false);
    });
  });

  describe("a change between the token and the connection", () => {
    it("the token still says Editor, the database says Viewer: the connection is told as it opens, once", async () => {
      const s = await scene({ row: "viewer", tokenRole: "editor" });
      await eventually(() => s.personClient.told.length > 0, "the person to be told");
      await settled(s, s.personClient);
      expect(s.personClient.roles()).toEqual(["viewer"]);
      expect(s.connection.readOnly).toBe(true);
      expect(s.ownerClient.told).toEqual([]);
    });

    it("the token and the database agree: nothing is said", async () => {
      const s = await scene({ row: "viewer" });
      await settled(s, s.personClient);
      expect(s.personClient.told).toEqual([]);
    });

    it("only a role that differs is told, to that connection alone; no access any more is told as null", async () => {
      const s = await scene();
      collabConnectionOpened(s.connection, "editor", "editor");
      collabConnectionOpened(s.connection, undefined, "viewer");
      await settled(s, s.personClient);
      expect(s.personClient.told).toEqual([]);
      collabConnectionOpened(s.connection, "editor", null);
      await eventually(() => s.personClient.told.length > 0, "the person to be told");
      await settled(s, s.personClient);
      expect(s.personClient.roles()).toEqual([null]);
      expect(s.ownerClient.told).toEqual([]);
    });
  });
});
