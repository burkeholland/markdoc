import { describe, expect, it, beforeAll, afterAll, vi } from "vitest";
import * as Y from "yjs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import WebSocket from "ws";
import { eq } from "drizzle-orm";
import { HocuspocusProvider, HocuspocusProviderWebsocket } from "@hocuspocus/provider";

process.env.PGLITE_DATA_DIR = "memory://";
process.env.AUTH_SECRET = "test-secret-test-secret-test-secret";
delete process.env.DATABASE_URL;

// duplicateDocument reads the live text through livedoc, whose registry pulls in the auth module.
vi.mock("@/auth", () => ({ auth: async () => null }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));

const { getDb, schema } = await import("./db");
const { createDocument, duplicateDocument } = await import("./documents");
const { TEXT_KEY, META_KEY, hydrateDoc, encodeSeedState, isDoubledSeed, revertDoubledSeed } = await import("./collab/seed");
const { createCollabServer, shutdownCollab } = await import("./collab/hocuspocus");
const { attachCollab } = await import("./collab/ws");
const { signCollabToken } = await import("./collab/token");

const CONTENT = "# Launch checklist\n\n## Before\n\n- Charge batteries\n\n## After\n\n- Write the report\n";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(check: () => boolean, timeout = 5000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeout) throw new Error("timeout");
    await sleep(20);
  }
}

async function readRow(id: string) {
  const db = await getDb();
  const [row] = await db.select({ ystate: schema.documents.ystate, content: schema.documents.content }).from(schema.documents).where(eq(schema.documents.id, id));
  return row;
}

/** Count of headings in the Markdown, the same signal the outline shows. */
const headingCount = (md: string) => md.split("\n").filter((l) => /^#{1,6}\s/.test(l)).length;

let ownerId: string;

beforeAll(async () => {
  const db = await getDb();
  const [a] = await db.insert(schema.users).values({ name: "Alice", login: "alice", email: "alice@example.com" }).returning();
  ownerId = a.id;
});

describe("seed state", () => {
  it("seeding the same content twice without persisting it doubles the text when merged (the bug)", () => {
    const first = new Y.Doc();
    const second = new Y.Doc();
    hydrateDoc(first, null, CONTENT, "Launch checklist");
    hydrateDoc(second, null, CONTENT, "Launch checklist");
    Y.applyUpdate(first, Y.encodeStateAsUpdate(second));
    expect(first.getText(TEXT_KEY).toString()).toHaveLength(CONTENT.length * 2);
    expect(headingCount(first.getText(TEXT_KEY).toString())).toBe(headingCount(CONTENT) * 2);
  });

  it("hydrating from the persisted seed any number of times merges to the content once", () => {
    const seed = encodeSeedState(CONTENT, "Launch checklist");
    const a = new Y.Doc();
    const b = new Y.Doc();
    expect(hydrateDoc(a, seed, CONTENT, "Launch checklist")).toBe(false);
    expect(hydrateDoc(b, seed, CONTENT, "Launch checklist")).toBe(false);
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    expect(a.getText(TEXT_KEY).toString()).toBe(CONTENT);
    expect(b.getText(TEXT_KEY).toString()).toBe(CONTENT);
    expect(a.getMap(META_KEY).get("title")).toBe("Launch checklist");
  });

  it("hydrateDoc reports whether it had to seed", () => {
    const doc = new Y.Doc();
    expect(hydrateDoc(doc, null, CONTENT, "T")).toBe(true);
    expect(hydrateDoc(new Y.Doc(), new Uint8Array(0), CONTENT, "T")).toBe(true);
    expect(hydrateDoc(new Y.Doc(), null, "", "T")).toBe(false);
  });
});

describe("doubled-seed guard", () => {
  /** Server seeded this lifetime; a client pushes its mirror of an older, never-persisted seed. */
  function mergeStaleMirror(content: string): Y.Doc {
    const server = new Y.Doc();
    const staleMirror = new Y.Doc();
    hydrateDoc(server, null, content, "T");
    hydrateDoc(staleMirror, null, content, "T");
    Y.applyUpdate(server, Y.encodeStateAsUpdate(staleMirror));
    return server;
  }

  it("recognises exactly seed+seed, with or without one separator newline", () => {
    expect(isDoubledSeed(CONTENT + CONTENT, CONTENT)).toBe(true);
    const noTrailingNewline = CONTENT.trimEnd();
    expect(isDoubledSeed(noTrailingNewline + noTrailingNewline, noTrailingNewline)).toBe(true);
    expect(isDoubledSeed(`${noTrailingNewline}\n${noTrailingNewline}`, noTrailingNewline)).toBe(true);
    // Real edits, however close, are not the artefact.
    expect(isDoubledSeed(CONTENT, CONTENT)).toBe(false);
    expect(isDoubledSeed(`${CONTENT}\n${CONTENT}`, CONTENT)).toBe(false);
    expect(isDoubledSeed(CONTENT + CONTENT + "x", CONTENT)).toBe(false);
    expect(isDoubledSeed(CONTENT + "x" + CONTENT, CONTENT)).toBe(false);
    expect(isDoubledSeed(CONTENT + CONTENT.slice(1), CONTENT)).toBe(false);
    expect(isDoubledSeed("", "")).toBe(false);
    expect(isDoubledSeed("ab", "")).toBe(false);
  });

  it("collapses the merged stale mirror back to the seed and reports it", () => {
    const server = mergeStaleMirror(CONTENT);
    expect(server.getText(TEXT_KEY).toString()).toHaveLength(CONTENT.length * 2);
    const origins: unknown[] = [];
    server.on("update", (_u: Uint8Array, origin: unknown) => origins.push(origin));
    expect(revertDoubledSeed(server, CONTENT, { source: "local", context: {} })).toBe(true);
    expect(server.getText(TEXT_KEY).toString()).toBe(CONTENT);
    expect(headingCount(server.getText(TEXT_KEY).toString())).toBe(headingCount(CONTENT));
    expect(origins).toEqual([{ source: "local", context: {} }]);
    // The correction is a plain update that any client (including the stale one) converges on.
    const client = new Y.Doc();
    Y.applyUpdate(client, Y.encodeStateAsUpdate(server));
    expect(client.getText(TEXT_KEY).toString()).toBe(CONTENT);
  });

  it("leaves anything that is not the exact double untouched", () => {
    const edited = new Y.Doc();
    hydrateDoc(edited, null, CONTENT, "T");
    edited.getText(TEXT_KEY).insert(CONTENT.length, "- One more item\n");
    const before = edited.getText(TEXT_KEY).toString();
    expect(revertDoubledSeed(edited, CONTENT)).toBe(false);
    expect(edited.getText(TEXT_KEY).toString()).toBe(before);

    const doubledPlusEdit = mergeStaleMirror(CONTENT);
    doubledPlusEdit.getText(TEXT_KEY).insert(0, "x");
    const doubledText = doubledPlusEdit.getText(TEXT_KEY).toString();
    expect(revertDoubledSeed(doubledPlusEdit, CONTENT)).toBe(false);
    expect(doubledPlusEdit.getText(TEXT_KEY).toString()).toBe(doubledText);
  });
});

describe("createDocument", () => {
  it("writes ystate at creation and it decodes to the content and title", async () => {
    const doc = await createDocument({ ownerId, content: CONTENT });
    const row = await readRow(doc.id);
    expect(row.ystate).not.toBeNull();
    expect(row.ystate!.byteLength).toBeGreaterThan(0);
    expect(row.content).toBe(CONTENT);
    const fresh = new Y.Doc();
    Y.applyUpdate(fresh, row.ystate!);
    expect(fresh.getText(TEXT_KEY).toString()).toBe(CONTENT);
    expect(fresh.getMap(META_KEY).get("title")).toBe("Launch checklist");
  });

  it("duplicateDocument writes ystate for the copy too", async () => {
    const source = await createDocument({ ownerId, content: CONTENT });
    const copy = await duplicateDocument(source.id, ownerId);
    const row = await readRow(copy.id);
    expect(row.ystate).not.toBeNull();
    const fresh = new Y.Doc();
    Y.applyUpdate(fresh, row.ystate!);
    expect(fresh.getText(TEXT_KEY).toString()).toBe(CONTENT);
    expect(fresh.getMap(META_KEY).get("title")).toBe("Copy of Launch checklist");
  });
});

describe("onLoadDocument persists the seed for legacy rows", () => {
  let server: Server;
  let url: string;
  let hocuspocus: ReturnType<typeof createCollabServer>;

  beforeAll(async () => {
    hocuspocus = createCollabServer();
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

  /** A row the way the app wrote it before ystate was minted at creation. */
  async function legacyRow(): Promise<string> {
    const db = await getDb();
    const id = `legacy-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    await db.insert(schema.documents).values({ id, title: "Launch checklist", ownerId, content: CONTENT });
    expect((await readRow(id)).ystate).toBeNull();
    return id;
  }

  async function connect(docId: string, ydoc: Y.Doc) {
    const token = await signCollabToken({ userId: ownerId, docId, role: "owner", name: "Alice", login: "alice", avatar: null });
    const socket = new HocuspocusProviderWebsocket({ url, WebSocketPolyfill: WebSocket as unknown as typeof globalThis.WebSocket });
    const provider = new HocuspocusProvider({ websocketProvider: socket, name: docId, document: ydoc, token });
    provider.attach();
    await waitFor(() => provider.isSynced);
    return {
      close: async () => {
        provider.destroy();
        socket.destroy();
        const live = hocuspocus.documents.get(docId);
        if (live) await hocuspocus.unloadDocument(live).catch(() => undefined);
        await waitFor(() => !hocuspocus.documents.has(docId));
      },
    };
  }

  it("open (no edit) → unload → open again yields the content exactly once, and the row has ystate after the first load", async () => {
    const docId = await legacyRow();

    const a = new Y.Doc();
    const clientA = await connect(docId, a);
    expect(a.getText(TEXT_KEY).toString()).toBe(CONTENT);
    const afterFirstLoad = await readRow(docId);
    expect(afterFirstLoad.ystate).not.toBeNull();
    expect(afterFirstLoad.content).toBe(CONTENT);
    const decoded = new Y.Doc();
    Y.applyUpdate(decoded, afterFirstLoad.ystate!);
    expect(decoded.getText(TEXT_KEY).toString()).toBe(CONTENT);
    await clientA.close();

    // Client B starts from A's state, the way a browser restores its IndexedDB mirror
    // before the socket opens; the server must hand back the same seed, not a new one.
    const b = new Y.Doc();
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    const clientB = await connect(docId, b);
    expect(b.getText(TEXT_KEY).toString()).toBe(CONTENT);
    expect(headingCount(b.getText(TEXT_KEY).toString())).toBe(headingCount(CONTENT));
    await clientB.close();

    // A third, cold client (no local copy) also sees it once.
    const c = new Y.Doc();
    const clientC = await connect(docId, c);
    expect(c.getText(TEXT_KEY).toString()).toBe(CONTENT);
    await clientC.close();
    expect((await readRow(docId)).content).toBe(CONTENT);
  });

  it("a client holding a mirror of a pre-persistence seed is collapsed back to the content on a freshly seeded row", async () => {
    const docId = await legacyRow();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      // The browser's IndexedDB copy: the same Markdown seeded by an older server that never stored it.
      const stale = new Y.Doc();
      hydrateDoc(stale, null, CONTENT, "Launch checklist");
      const client = await connect(docId, stale);
      // The server seeds on this load (first open since the fix), merges the stale seed, and reverts.
      await waitFor(() => stale.getText(TEXT_KEY).toString() === CONTENT);
      expect(headingCount(stale.getText(TEXT_KEY).toString())).toBe(headingCount(CONTENT));
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(docId));
      // The store that follows writes the single text, not the double.
      await waitFor(() => hocuspocus.documents.get(docId)?.getText(TEXT_KEY).toString() === CONTENT);
      await sleep(250);
      expect((await readRow(docId)).content).toBe(CONTENT);
      await client.close();
      expect((await readRow(docId)).content).toBe(CONTENT);

      // A cold client afterwards sees the content once.
      const cold = new Y.Doc();
      const clientCold = await connect(docId, cold);
      expect(cold.getText(TEXT_KEY).toString()).toBe(CONTENT);
      await clientCold.close();
    } finally {
      warn.mockRestore();
    }
  });

  it("the guard only watches the first change: a real edit that happens to repeat the text is kept", async () => {
    const docId = await legacyRow();
    const a = new Y.Doc();
    const clientA = await connect(docId, a);
    a.getText(TEXT_KEY).insert(a.getText(TEXT_KEY).length, "- Lock the door\n");
    const edited = CONTENT + "- Lock the door\n";
    await waitFor(() => hocuspocus.documents.get(docId)?.getText(TEXT_KEY).toString() === edited);
    // Now a deliberate duplication by the user — not the first change, so nothing is reverted.
    a.getText(TEXT_KEY).insert(a.getText(TEXT_KEY).length, CONTENT);
    await waitFor(() => hocuspocus.documents.get(docId)?.getText(TEXT_KEY).toString() === edited + CONTENT);
    await sleep(100);
    expect(hocuspocus.documents.get(docId)?.getText(TEXT_KEY).toString()).toBe(edited + CONTENT);
    await clientA.close();
  });

  it("a document created through createDocument never needs seeding on load", async () => {
    const doc = await createDocument({ ownerId, content: CONTENT });
    const before = await readRow(doc.id);
    const a = new Y.Doc();
    const clientA = await connect(doc.id, a);
    expect(a.getText(TEXT_KEY).toString()).toBe(CONTENT);
    await clientA.close();
    const after = await readRow(doc.id);
    // No edit happened, so nothing rewrote the row: the stored seed is the one from creation.
    expect(Buffer.from(after.ystate!).equals(Buffer.from(before.ystate!))).toBe(true);

    const b = new Y.Doc();
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    const clientB = await connect(doc.id, b);
    expect(b.getText(TEXT_KEY).toString()).toBe(CONTENT);
    await clientB.close();
  });
});
