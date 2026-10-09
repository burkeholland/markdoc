import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { IndexeddbPersistence } from "y-indexeddb";

// A CollabSession normally opens a WebSocket through Hocuspocus; stand in a provider
// that only supplies the awareness instance and lets tests drive connection events.
vi.mock("@hocuspocus/provider", async () => {
  const { Awareness } = await import("y-protocols/awareness");
  class HocuspocusProvider {
    awareness: InstanceType<typeof Awareness>;
    connectCalls = 0;
    lastRequest: { requestId: string } | null = null;
    sequence = 0;
    static last: HocuspocusProvider | null = null;
    constructor(readonly opts: {
      document: Y.Doc;
      onStatus?: (e: { status: string }) => void;
      onSynced?: (e: { state: boolean }) => void;
      onUnsyncedChanges?: (e: { number: number }) => void;
      onAuthenticationFailed?: (e: { reason: string }) => void;
      onStateless?: (e: { payload: string }) => void;
    }) {
      this.awareness = new Awareness(opts.document);
      HocuspocusProvider.last = this;
    }
    connect() {
      this.connectCalls++;
      return Promise.resolve();
    }
    sendStateless(payload: string) {
      this.lastRequest = JSON.parse(payload);
    }
    destroy() {
      this.awareness.destroy();
    }
  }
  return { HocuspocusProvider };
});

import { HocuspocusProvider } from "@hocuspocus/provider";
import { CollabSession, RECOVERED_FLASH_MS } from "./session";
import { makeCollabUser } from "./shared";
import {
  clearAllLocalDocuments,
  clearLocalDocument,
  ensureLocalEpoch,
  hasIndexedDB,
  hasLocalDocuments,
  IDB_EPOCH,
  IDB_EPOCH_KEY,
  IDB_REGISTRY_KEY,
  LOCAL_LOAD_TIMEOUT_MS,
  LOCAL_WIPE_TIMEOUT_MS,
  localDbName,
  openLocalPersistence,
  saveStateLabel,
  storedIdbEpoch,
} from "./offline";

type FakeProvider = {
  connectCalls: number;
  lastRequest: { requestId: string } | null;
  sequence: number;
  opts: {
    onStatus: (e: { status: string }) => void;
    onSynced: (e: { state: boolean }) => void;
    onUnsyncedChanges: (e: { number: number }) => void;
    onAuthenticationFailed: (e: { reason: string }) => void;
    onStateless: (e: { payload: string }) => void;
  };
};
const lastProvider = () => (HocuspocusProvider as unknown as { last: FakeProvider }).last;

function acknowledgePersistence(session: CollabSession) {
  const provider = lastProvider();
  provider.opts.onStateless({ payload: JSON.stringify({
    type: "document-persistence", docId: session.docId, epoch: "test-epoch",
    sequence: ++provider.sequence, revision: 0, savedRevision: 0, state: "saved", error: null,
    requestId: provider.lastRequest?.requestId,
    saved: { docId: session.docId, version: "test-epoch:0", content: session.ytext.toString(), title: session.title, savedAt: new Date().toISOString() },
    snapshot: Array.from(Y.encodeSnapshot(Y.snapshot(session.ydoc))),
  }) });
}

function makeSession(docId = "doc"): CollabSession {
  return new CollabSession({ docId, user: makeCollabUser("a", "Alice"), role: "owner", getToken: async () => "token" });
}

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

describe("CRDT merge is order independent", () => {
  it("applies offline edits from two peers in either order with the same result", () => {
    const base = new Y.Doc();
    base.getText("content").insert(0, "Hello world");
    const snapshot = Y.encodeStateAsUpdate(base);

    // Two peers start from the same state; one edits "offline" (no provider at all).
    const online = new Y.Doc();
    const offline = new Y.Doc();
    Y.applyUpdate(online, snapshot);
    Y.applyUpdate(offline, snapshot);
    const onlineBefore = Y.encodeStateVector(online);
    const offlineBefore = Y.encodeStateVector(offline);

    online.getText("content").insert(11, " from the server");
    offline.getText("content").insert(0, "Offline says: ");

    const onlineUpdate = Y.encodeStateAsUpdate(online, onlineBefore);
    const offlineUpdate = Y.encodeStateAsUpdate(offline, offlineBefore);

    // Merge in both orders.
    const a = new Y.Doc();
    Y.applyUpdate(a, snapshot);
    Y.applyUpdate(a, onlineUpdate);
    Y.applyUpdate(a, offlineUpdate);

    const b = new Y.Doc();
    Y.applyUpdate(b, snapshot);
    Y.applyUpdate(b, offlineUpdate);
    Y.applyUpdate(b, onlineUpdate);

    expect(a.getText("content").toString()).toBe(b.getText("content").toString());
    expect(a.getText("content").toString()).toBe("Offline says: Hello world from the server");

    // And the two peers converge when they exchange their updates directly.
    Y.applyUpdate(online, offlineUpdate);
    Y.applyUpdate(offline, onlineUpdate);
    expect(online.getText("content").toString()).toBe(offline.getText("content").toString());
  });
});

describe("without IndexedDB", () => {
  beforeEach(() => {
    vi.stubGlobal("indexedDB", undefined);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("feature detection reports it missing", () => {
    expect(hasIndexedDB()).toBe(false);
    expect(openLocalPersistence("x", new Y.Doc())).toBeNull();
  });

  it("a session constructs without throwing and is locally loaded at once", async () => {
    const session = makeSession("no-idb");
    expect(session.localLoaded).toBe(true);
    await expect(session.whenLocalLoaded).resolves.toBeUndefined();
    await expect(session.clearLocal()).resolves.toBeUndefined();
    await expect(clearLocalDocument("no-idb")).resolves.toBeUndefined();
    session.destroy();
  });

  it("removes the fallback registry even when IndexedDB is unavailable", async () => {
    vi.stubGlobal("localStorage", memoryStorage({ [IDB_REGISTRY_KEY]: JSON.stringify(["private-doc"]) }));
    await expect(hasLocalDocuments()).resolves.toBe(true);
    await expect(clearAllLocalDocuments()).resolves.toBe(0);
    expect(localStorage.getItem(IDB_REGISTRY_KEY)).toBeNull();
  });
});

/** Minimal in-memory `localStorage` stand-in (the Node test runtime has none). */
function memoryStorage(initial: Record<string, string> = {}): Storage {
  const map = new Map(Object.entries(initial));
  return {
    get length() {
      return map.size;
    },
    key: (i: number) => [...map.keys()][i] ?? null,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, String(v)),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
  } as Storage;
}

describe("with IndexedDB (fake-indexeddb)", () => {
  beforeEach(async () => {
    const { indexedDB, IDBKeyRange } = await import("fake-indexeddb");
    vi.stubGlobal("indexedDB", indexedDB);
    vi.stubGlobal("IDBKeyRange", IDBKeyRange);
    // Mirrors written by these tests belong to the current epoch; the epoch tests below override this.
    vi.stubGlobal("localStorage", memoryStorage({ [IDB_EPOCH_KEY]: String(IDB_EPOCH) }));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("restores the text from IndexedDB in a second session with no network", async () => {
    const docId = `restore-${Date.now()}`;
    const first = makeSession(docId);
    expect(first.localLoaded).toBe(false);
    await first.whenLocalLoaded;
    expect(first.localLoaded).toBe(true);

    first.ytext.insert(0, "# Written while offline\n\nStill here after a refresh.");
    // Persistence writes every update asynchronously; give the transaction a moment.
    await tick();
    first.destroy();
    await tick();

    const second = makeSession(docId);
    expect(second.ytext.toString()).toBe("");
    await second.whenLocalLoaded;
    expect(second.ytext.toString()).toBe("# Written while offline\n\nStill here after a refresh.");
    second.destroy();
  });

  it("connect() opens the socket only once the local copy has been applied, so sync step 1 carries its state vector (#189)", async () => {
    const docId = `order-${Date.now()}`;
    const first = makeSession(docId);
    await first.whenLocalLoaded;
    first.ytext.insert(0, "# Mirrored\n\nKnown to this device.");
    await tick();
    first.destroy();
    await tick();

    // What the editor shell does: a deferred session, then startLocalPersistence() and connect() in one effect.
    const second = new CollabSession({ docId, user: makeCollabUser("a", "Alice"), role: "owner", getToken: async () => "token", deferLocal: true, autoConnect: false });
    const provider = lastProvider();
    second.startLocalPersistence();
    second.connect();
    expect(provider.connectCalls).toBe(0);
    expect(second.ytext.toString()).toBe("");
    await second.whenLocalLoaded;
    await tick(0);
    expect(second.ytext.toString()).toBe("# Mirrored\n\nKnown to this device.");
    expect(provider.connectCalls).toBe(1);
    // The mirror's origin is what the provider filters on (see collab/provider.ts).
    expect((second.provider as unknown as { localOrigin: unknown }).localOrigin).toBeInstanceOf(IndexeddbPersistence);
    second.destroy();
  });

  it("connect() on a session whose mirror was never started starts it, so the socket never waits forever", async () => {
    const session = new CollabSession({ docId: `lazy-${Date.now()}`, user: makeCollabUser("a", "Alice"), role: "owner", getToken: async () => "token", deferLocal: true, autoConnect: false });
    const provider = lastProvider();
    session.connect();
    expect(provider.connectCalls).toBe(0);
    await session.whenLocalLoaded;
    await tick(0);
    expect(provider.connectCalls).toBe(1);
    session.destroy();
  });

  it("clearLocal() removes the stored copy", async () => {
    const docId = `clear-${Date.now()}`;
    const first = makeSession(docId);
    await first.whenLocalLoaded;
    first.ytext.insert(0, "to be forgotten");
    await tick();
    await first.clearLocal();
    first.destroy();
    await tick();

    const second = makeSession(docId);
    await second.whenLocalLoaded;
    expect(second.ytext.toString()).toBe("");
    second.destroy();
  });

  it("an authentication failure wipes the local copy", async () => {
    const docId = `auth-${Date.now()}`;
    const first = makeSession(docId);
    await first.whenLocalLoaded;
    first.ytext.insert(0, "secret");
    await tick();
    lastProvider().opts.onAuthenticationFailed({ reason: "permission-denied" });
    await tick();
    expect(first.saveState).toBe("error");
    first.destroy();
    await tick();

    const bare = new Y.Doc();
    const p = new IndexeddbPersistence(localDbName(docId), bare);
    await p.whenSynced;
    expect(bare.getText("content").toString()).toBe("");
    await p.clearData();
  });

  it("the raw persistence round-trips through a bare Y.Doc", async () => {
    const name = localDbName(`bare-${Date.now()}`);
    const a = new Y.Doc();
    const pa = new IndexeddbPersistence(name, a);
    await pa.whenSynced;
    a.getText("content").insert(0, "bare doc");
    await tick();
    await pa.destroy();

    const b = new Y.Doc();
    const pb = new IndexeddbPersistence(name, b);
    await pb.whenSynced;
    expect(b.getText("content").toString()).toBe("bare doc");
    await pb.clearData();
  });

  describe("reload of a never-edited document", () => {
    const CONTENT = "# Template\n\n## One\n\n## Two\n";
    // What the server sends: the document's stored `ystate`, minted once.
    const seed = (() => {
      const d = new Y.Doc();
      d.getText("content").insert(0, CONTENT);
      return Y.encodeStateAsUpdate(d);
    })();

    /** Open the doc as a browser would: IndexedDB first, then the server's state arrives. */
    async function openAndSync(docId: string, serverState: Uint8Array): Promise<CollabSession> {
      const session = makeSession(docId);
      await session.whenLocalLoaded;
      Y.applyUpdate(session.ydoc, serverState, lastProvider());
      lastProvider().opts.onStatus({ status: "connected" });
      lastProvider().opts.onSynced({ state: true });
      await tick();
      return session;
    }

    it("stays intact when the server hands back the same persisted seed", async () => {
      const docId = `reload-${Date.now()}`;
      const first = await openAndSync(docId, seed);
      expect(first.ytext.toString()).toBe(CONTENT);
      first.destroy();
      await tick();

      const second = await openAndSync(docId, seed);
      expect(second.ytext.toString()).toBe(CONTENT);
      second.destroy();
      await clearLocalDocument(docId);
    });

    it("doubles when the server re-seeds from plain content (the bug the server now prevents)", async () => {
      const docId = `reseed-${Date.now()}`;
      const first = await openAndSync(docId, seed);
      first.destroy();
      await tick();

      const reseeded = new Y.Doc();
      reseeded.getText("content").insert(0, CONTENT);
      const second = await openAndSync(docId, Y.encodeStateAsUpdate(reseeded));
      expect(second.ytext.toString()).toHaveLength(CONTENT.length * 2);
      second.destroy();
      await clearLocalDocument(docId);
    });

    it("a stale mirror from the previous epoch is wiped before the mirror opens, so the text stays single", async () => {
      const docId = `epoch-${Date.now()}`;
      // A pre-fix browser: mirror of a seed the server never persisted, written under epoch 1.
      const oldSeed = new Y.Doc();
      oldSeed.getText("content").insert(0, CONTENT);
      const first = await openAndSync(docId, Y.encodeStateAsUpdate(oldSeed));
      first.destroy();
      await tick();
      localStorage.setItem(IDB_EPOCH_KEY, "1");

      // The server now hands out its persisted seed (different CRDT ids, same text).
      const second = await openAndSync(docId, seed);
      expect(second.ytext.toString()).toBe(CONTENT);
      expect(storedIdbEpoch()).toBe(IDB_EPOCH);
      second.destroy();
      await clearLocalDocument(docId);
    });
  });

  describe("mirror epoch", () => {
    async function writeMirror(docId: string, text: string) {
      const d = new Y.Doc();
      const p = new IndexeddbPersistence(localDbName(docId), d);
      await p.whenSynced;
      d.getText("content").insert(0, text);
      await tick();
      await p.destroy();
    }

    async function readMirror(docId: string): Promise<string> {
      const d = new Y.Doc();
      const p = new IndexeddbPersistence(localDbName(docId), d);
      await p.whenSynced;
      const text = d.getText("content").toString();
      await p.clearData();
      return text;
    }

    it("a missing or older epoch deletes every markdoc:* database and records the current epoch", async () => {
      const a = `wipe-a-${Date.now()}`;
      const b = `wipe-b-${Date.now()}`;
      await writeMirror(a, "mirror a");
      await writeMirror(b, "mirror b");
      localStorage.removeItem(IDB_EPOCH_KEY);
      expect(storedIdbEpoch()).toBeNull();

      await expect(ensureLocalEpoch()).resolves.toBe(true);
      expect(storedIdbEpoch()).toBe(IDB_EPOCH);
      const names = (await indexedDB.databases()).map((d) => d.name);
      expect(names.filter((n) => n === localDbName(a) || n === localDbName(b))).toEqual([]);
      expect(await readMirror(a)).toBe("");
      expect(await readMirror(b)).toBe("");

      localStorage.setItem(IDB_EPOCH_KEY, "1");
      await writeMirror(a, "written under epoch 1");
      await expect(ensureLocalEpoch()).resolves.toBe(true);
      expect(await readMirror(a)).toBe("");
      expect(localStorage.getItem(IDB_EPOCH_KEY)).toBe(String(IDB_EPOCH));
    });

    it("a matching epoch leaves the mirrors alone", async () => {
      const docId = `keep-${Date.now()}`;
      await writeMirror(docId, "keep me");
      expect(storedIdbEpoch()).toBe(IDB_EPOCH);
      await expect(ensureLocalEpoch()).resolves.toBe(true);
      expect(await readMirror(docId)).toBe("keep me");
    });

    it("sign-out cleanup closes active persistence and removes multiple mirrors plus the registry", async () => {
      const activeId = `signout-active-${Date.now()}`;
      const closedId = `signout-closed-${Date.now()}`;
      const activeDoc = new Y.Doc();
      const active = openLocalPersistence(activeId, activeDoc)!;
      await active.whenLoaded;
      activeDoc.getText("content").insert(0, "active private marker");
      await writeMirror(closedId, "closed private marker");
      await tick();

      expect(await hasLocalDocuments()).toBe(true);
      expect(JSON.parse(localStorage.getItem(IDB_REGISTRY_KEY)!)).toContain(activeId);
      await expect(clearAllLocalDocuments()).resolves.toBe(2);

      expect((await indexedDB.databases()).map((database) => database.name).filter((name) => name?.startsWith("markdoc:"))).toEqual([]);
      expect(localStorage.getItem(IDB_REGISTRY_KEY)).toBeNull();
      expect(await readMirror(activeId)).toBe("");
      expect(await readMirror(closedId)).toBe("");
      activeDoc.destroy();
    });

    it("sign-out cleanup uses the registry when indexedDB.databases() is unavailable", async () => {
      const a = `signout-fallback-a-${Date.now()}`;
      const b = `signout-fallback-b-${Date.now()}`;
      for (const id of [a, b]) {
        const doc = new Y.Doc();
        const persistence = openLocalPersistence(id, doc)!;
        await persistence.whenLoaded;
        doc.getText("content").insert(0, id);
        await tick();
        await persistence.destroy();
        doc.destroy();
      }

      const real = indexedDB;
      const withoutList = Object.create(real) as IDBFactory & { databases?: unknown };
      Object.defineProperty(withoutList, "databases", { value: undefined });
      for (const method of ["open", "deleteDatabase", "cmp"] as const) {
        (withoutList as unknown as Record<string, unknown>)[method] = (real[method] as (...args: unknown[]) => unknown).bind(real);
      }
      vi.stubGlobal("indexedDB", withoutList);
      await expect(clearAllLocalDocuments()).resolves.toBe(2);
      expect(localStorage.getItem(IDB_REGISTRY_KEY)).toBeNull();
      vi.stubGlobal("indexedDB", real);

      expect(await readMirror(a)).toBe("");
      expect(await readMirror(b)).toBe("");
    });

    it("sign-out cleanup tracks active mirrors when enumeration and the registry are unavailable", async () => {
      const docId = `signout-active-fallback-${Date.now()}`;
      const doc = new Y.Doc();
      const persistence = openLocalPersistence(docId, doc)!;
      await persistence.whenLoaded;
      doc.getText("content").insert(0, "active private marker");
      await tick();
      localStorage.removeItem(IDB_REGISTRY_KEY);

      const real = indexedDB;
      const withoutList = Object.create(real) as IDBFactory & { databases?: unknown };
      Object.defineProperty(withoutList, "databases", { value: undefined });
      for (const method of ["open", "deleteDatabase", "cmp"] as const) {
        (withoutList as unknown as Record<string, unknown>)[method] = (real[method] as (...args: unknown[]) => unknown).bind(real);
      }
      vi.stubGlobal("indexedDB", withoutList);

      expect(await hasLocalDocuments()).toBe(true);
      await expect(clearAllLocalDocuments()).resolves.toBe(1);
      vi.stubGlobal("indexedDB", real);
      expect(await readMirror(docId)).toBe("");
      doc.destroy();
    });

    it("sign-out cleanup rejects a blocked database and retains the registry for retry", async () => {
      const docId = `signout-blocked-${Date.now()}`;
      const doc = new Y.Doc();
      const persistence = openLocalPersistence(docId, doc)!;
      await persistence.whenLoaded;
      doc.getText("content").insert(0, "must not be reported as removed");
      await tick();
      await persistence.destroy();
      const holder = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(localDbName(docId));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      holder.onversionchange = null;

      try {
        await expect(clearAllLocalDocuments()).rejects.toThrow("blocked by another open connection");
        expect(JSON.parse(localStorage.getItem(IDB_REGISTRY_KEY)!)).toContain(docId);
      } finally {
        holder.close();
        doc.destroy();
      }
      await tick();
      await expect(clearAllLocalDocuments()).resolves.toBeGreaterThanOrEqual(1);
      expect(localStorage.getItem(IDB_REGISTRY_KEY)).toBeNull();
    });

    it("sign-out cleanup restores an active mirror after its deletion is blocked", async () => {
      const docId = `signout-active-blocked-${Date.now()}`;
      const doc = new Y.Doc();
      const persistence = openLocalPersistence(docId, doc)!;
      await persistence.whenLoaded;
      doc.getText("content").insert(0, "before failed sign-out");
      await tick();
      const holder = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(localDbName(docId));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      holder.onversionchange = null;

      await expect(clearAllLocalDocuments()).rejects.toThrow("blocked by another open connection");
      doc.getText("content").insert(doc.getText("content").length, " and after");
      holder.close();
      await tick(100);

      expect(await readMirror(docId)).toBe("before failed sign-out and after");
      await persistence.destroy();
      doc.destroy();
      await clearLocalDocument(docId);
    });

    it("sign-out cleanup times out a stalled database listing and retains the registry", async () => {
      const docId = `signout-timeout-${Date.now()}`;
      localStorage.setItem(IDB_REGISTRY_KEY, JSON.stringify([docId]));
      vi.stubGlobal("indexedDB", withDatabases(() => new Promise(() => {})));
      vi.useFakeTimers();

      const cleanup = expect(clearAllLocalDocuments()).rejects.toThrow(`${LOCAL_WIPE_TIMEOUT_MS}ms`);
      await vi.advanceTimersByTimeAsync(LOCAL_WIPE_TIMEOUT_MS);
      await cleanup;
      expect(JSON.parse(localStorage.getItem(IDB_REGISTRY_KEY)!)).toContain(docId);
      vi.useRealTimers();
    });

    it("falls back to the localStorage registry when indexedDB.databases() is missing", async () => {
      const listed = `reg-listed-${Date.now()}`;
      const unlisted = `reg-unlisted-${Date.now()}`;
      // Open through the module so the registry records the id; the other one bypasses it.
      const d = new Y.Doc();
      const p = openLocalPersistence(listed, d)!;
      await p.whenLoaded;
      d.getText("content").insert(0, "listed");
      await tick();
      await p.destroy();
      await writeMirror(unlisted, "unlisted");
      expect(JSON.parse(localStorage.getItem(IDB_REGISTRY_KEY)!)).toContain(listed);

      const real = indexedDB;
      const withoutList = Object.create(real) as IDBFactory & { databases?: unknown };
      Object.defineProperty(withoutList, "databases", { value: undefined });
      for (const m of ["open", "deleteDatabase", "cmp"] as const) {
        (withoutList as unknown as Record<string, unknown>)[m] = (real[m] as (...a: unknown[]) => unknown).bind(real);
      }
      vi.stubGlobal("indexedDB", withoutList);
      localStorage.setItem(IDB_EPOCH_KEY, "1");
      await expect(ensureLocalEpoch()).resolves.toBe(true);
      vi.stubGlobal("indexedDB", real);

      expect(await readMirror(listed)).toBe("");
      expect(await readMirror(unlisted)).toBe("unlisted");
      expect(JSON.parse(localStorage.getItem(IDB_REGISTRY_KEY)!)).toEqual([]);
    });

    it("a session does not open a mirror until the epoch check passed", async () => {
      const docId = `session-epoch-${Date.now()}`;
      await writeMirror(docId, "stale");
      localStorage.setItem(IDB_EPOCH_KEY, "1");
      const session = makeSession(docId);
      expect(session.localLoaded).toBe(false);
      await session.whenLocalLoaded;
      expect(session.ytext.toString()).toBe("");
      expect(storedIdbEpoch()).toBe(IDB_EPOCH);
      session.ytext.insert(0, "fresh");
      await tick();
      session.destroy();
      await tick();
      expect(await readMirror(docId)).toBe("fresh");
    });

    /** `indexedDB` whose `databases()` is replaced; every other method is the real one. */
    function withDatabases(databases: () => Promise<{ name?: string }[]>): IDBFactory {
      const real = indexedDB;
      const stub = Object.create(real) as IDBFactory;
      Object.defineProperty(stub, "databases", { value: databases });
      for (const m of ["open", "deleteDatabase", "cmp"] as const) {
        (stub as unknown as Record<string, unknown>)[m] = (real[m] as (...a: unknown[]) => unknown).bind(real);
      }
      return stub;
    }

    it("a database another connection holds open blocks the wipe: no epoch, no mirror, and the next load succeeds", async () => {
      const held = `blocked-${Date.now()}`;
      const other = `blocked-other-${Date.now()}`;
      await writeMirror(held, "held open elsewhere");
      await writeMirror(other, "deletable");
      // A connection that ignores `versionchange` (lib0's closes on it; a foreign one need not).
      const holder = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open(localDbName(held));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      localStorage.setItem(IDB_EPOCH_KEY, "1");
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        await expect(ensureLocalEpoch()).resolves.toBe(false);
        expect(storedIdbEpoch()).toBe(1);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining("blocked"));
        // The session honours the verdict: no mirror this time, but the document still loads.
        const session = makeSession(held);
        await session.whenLocalLoaded;
        session.ytext.insert(0, "not mirrored");
        await tick();
        session.destroy();
        await tick();
      } finally {
        warn.mockRestore();
        holder.close();
      }
      await tick();
      // The holder is gone: the retry deletes everything and records the epoch.
      await expect(ensureLocalEpoch()).resolves.toBe(true);
      expect(storedIdbEpoch()).toBe(IDB_EPOCH);
      expect(await readMirror(held)).toBe("");
      expect(await readMirror(other)).toBe("");
    });

    it("a wipe past LOCAL_WIPE_TIMEOUT_MS gives up without writing the epoch", async () => {
      vi.stubGlobal("indexedDB", withDatabases(() => new Promise(() => {})));
      localStorage.removeItem(IDB_EPOCH_KEY);
      vi.useFakeTimers();
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const verdict = ensureLocalEpoch();
        await vi.advanceTimersByTimeAsync(LOCAL_WIPE_TIMEOUT_MS - 1);
        await vi.advanceTimersByTimeAsync(1);
        await expect(verdict).resolves.toBe(false);
        expect(storedIdbEpoch()).toBeNull();
        expect(warn).toHaveBeenCalledWith(expect.stringContaining(`${LOCAL_WIPE_TIMEOUT_MS}ms`));
      } finally {
        warn.mockRestore();
        vi.useRealTimers();
      }
    });

    it("the session stops waiting on a slow wipe after LOCAL_LOAD_TIMEOUT_MS and still opens the mirror once it lands", async () => {
      const docId = `slow-wipe-${Date.now()}`;
      let release!: (names: { name?: string }[]) => void;
      const listing = new Promise<{ name?: string }[]>((resolve) => {
        release = resolve;
      });
      vi.stubGlobal("indexedDB", withDatabases(() => listing));
      localStorage.setItem(IDB_EPOCH_KEY, "1");
      const session = makeSession(docId);
      expect(session.localLoaded).toBe(false);
      const started = Date.now();
      await session.whenLocalLoaded;
      // Loaded by the timer, not by the wipe: the epoch is still the old one.
      expect(Date.now() - started).toBeGreaterThanOrEqual(LOCAL_LOAD_TIMEOUT_MS - 50);
      expect(storedIdbEpoch()).toBe(1);

      release([]);
      await tick();
      expect(storedIdbEpoch()).toBe(IDB_EPOCH);
      session.ytext.insert(0, "mirrored late");
      await tick(100);
      session.destroy();
      await tick();
      expect(await readMirror(docId)).toBe("mirrored late");
    });
  });
});

describe("save state and reconnect feedback", () => {
  let session: CollabSession;
  beforeEach(() => {
    vi.stubGlobal("indexedDB", undefined);
    vi.useFakeTimers();
    session = makeSession("state");
  });
  afterEach(() => {
    session.destroy();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("distinguishes the first connection from a reconnect and flashes after recovery", () => {
    const p = lastProvider().opts;
    expect(session.saveState).toBe("connecting");

    p.onStatus({ status: "connected" });
    p.onUnsyncedChanges({ number: 1 });
    expect(session.saveState).toBe("saving");
    p.onSynced({ state: true });
    p.onUnsyncedChanges({ number: 0 });
    expect(session.saveState).toBe("pending");
    acknowledgePersistence(session);
    expect(session.saveState).toBe("saved");
    expect(session.recovered).toBe(false);

    // Connection drops; local edits pile up.
    p.onStatus({ status: "disconnected" });
    expect(session.saveState).toBe("offline");
    p.onUnsyncedChanges({ number: 3 });
    expect(saveStateLabel(session.saveState, session.unsyncedChanges)).toBe("Offline — 3 unsaved changes");

    // The provider retries: this is a reconnect, not the initial connect.
    p.onStatus({ status: "connecting" });
    expect(session.saveState).toBe("reconnecting");
    expect(saveStateLabel(session.saveState, session.unsyncedChanges)).toBe("Reconnecting…");

    // Back online: the provider resets the counter and syncs; we stay "saving" until it hits 0.
    p.onStatus({ status: "connected" });
    expect(session.saveState).toBe("saving");
    expect(session.recovered).toBe(false);
    p.onUnsyncedChanges({ number: 1 });
    p.onSynced({ state: true });
    p.onUnsyncedChanges({ number: 0 });
    acknowledgePersistence(session);
    expect(session.saveState).toBe("saved");
    expect(session.recovered).toBe(true);
    expect(saveStateLabel("saved", 0, true)).toBe("All changes saved");

    vi.advanceTimersByTime(RECOVERED_FLASH_MS + 1);
    expect(session.recovered).toBe(false);
    expect(saveStateLabel("saved", 0, false)).toBe("Saved");
  });

  it("flashes after a first connection that uploads changes restored from local storage", () => {
    const p = lastProvider().opts;
    // A reload while offline: the IndexedDB copy has edits the server never saw, and the first
    // connection attempt fails before the network comes back.
    p.onUnsyncedChanges({ number: 2 });
    expect(session.saveState).toBe("connecting");
    expect(session.recovered).toBe(false);
    p.onStatus({ status: "disconnected" });
    expect(session.saveState).toBe("offline");
    expect(saveStateLabel(session.saveState, session.unsyncedChanges)).toBe("Offline — 2 unsaved changes");

    p.onStatus({ status: "connecting" });
    p.onStatus({ status: "connected" });
    p.onSynced({ state: true });
    p.onUnsyncedChanges({ number: 0 });
    acknowledgePersistence(session);
    expect(session.saveState).toBe("saved");
    expect(session.recovered).toBe(true);
    vi.advanceTimersByTime(RECOVERED_FLASH_MS + 1);
    expect(session.recovered).toBe(false);
  });

  it("does not flash on a warm open whose local copy loads while the first socket is still opening (#189)", () => {
    const p = lastProvider().opts;
    // The mirror restores the document before the handshake: the provider counts it as one pending change.
    p.onUnsyncedChanges({ number: 1 });
    expect(session.saveState).toBe("connecting");
    p.onStatus({ status: "connected" });
    // startSync resets the counter, the server's ack clears it.
    p.onUnsyncedChanges({ number: 1 });
    p.onSynced({ state: true });
    p.onUnsyncedChanges({ number: 0 });
    acknowledgePersistence(session);
    expect(session.saveState).toBe("saved");
    expect(session.recovered).toBe(false);
  });

  it("does not flash on a plain first connection", () => {
    const p = lastProvider().opts;
    p.onStatus({ status: "connected" });
    p.onSynced({ state: true });
    p.onUnsyncedChanges({ number: 0 });
    acknowledgePersistence(session);
    expect(session.saveState).toBe("saved");
    expect(session.recovered).toBe(false);
  });

  it("does not report saved before the held rich-pane rebuild represents the synced text", () => {
    const p = lastProvider().opts;
    const held = vi.spyOn(session.binding, "hasHeldSync", "get").mockReturnValue(true);
    p.onStatus({ status: "connected" });
    p.onSynced({ state: true });
    p.onUnsyncedChanges({ number: 0 });
    acknowledgePersistence(session);
    expect(session.contentReady).toBe(false);
    expect(session.canEdit).toBe(false);
    expect(session.saveState).toBe("saving");

    held.mockReturnValue(false);
    expect(session.contentReady).toBe(true);
    expect(session.canEdit).toBe(true);
    expect(session.saveState).toBe("saved");
  });

  it("labels", () => {
    expect(saveStateLabel("offline", 0)).toBe("Offline — changes will sync");
    expect(saveStateLabel("offline", 1)).toBe("Offline — 1 unsaved change");
    expect(saveStateLabel("connecting", 0)).toBe("Connecting…");
    expect(saveStateLabel("saving", 2)).toBe("Saving…");
    expect(saveStateLabel("error", 0)).toBe("Not connected");
  });
});
