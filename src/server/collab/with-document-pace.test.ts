import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";

process.env.PGLITE_DATA_DIR = "memory://";
process.env.AUTH_SECRET = "test-secret-test-secret-test-secret";
delete process.env.DATABASE_URL;

vi.mock("@/auth", () => ({ auth: async () => null }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));

const { withDocument } = await import("./hocuspocus");
type Server = Parameters<typeof withDocument>[0];

/**
 * A write through the REST API loads the document, changes it and stores it. On the embedded database each
 * of the three answers in the server's thread, and they used to run back to back: for a document of
 * 2,000,000 characters nobody else was answered for 2 to 4.6 s (#2341). `withDocument` now lets other
 * requests in between the three.
 *
 * The collaboration server here is a stand-in whose steps either keep this thread for 60 ms (a busy loop,
 * as the embedded database does) or answer in a later turn of the event loop (as a database on a socket).
 */
const busy = (ms: number) => {
  const until = performance.now() + ms;
  while (performance.now() < until) {
    /* keep the thread */
  }
};

function standIn(step: () => Promise<void> | void, order: string[]): Server {
  const doc = new Y.Doc();
  return {
    openDirectConnection: async () => {
      await step();
      order.push("loaded");
      return {
        transact: async (fn: (doc: Y.Doc) => void) => {
          await step();
          fn(doc);
          order.push("changed");
        },
        disconnect: async () => {
          await step();
          order.push("stored");
        },
      };
    },
  } as unknown as Server;
}
/** A request that came in: it is answered in the next turn of the event loop that the write allows. */
const request = (order: string[], name: string) => setImmediate(() => order.push(`${name} answered`));
const ctx = { userId: "u", docId: "d", role: "editor" as const, name: "User", login: null, avatar: null };

describe("withDocument: other requests are answered between load, change and store", () => {
  it("three steps that each keep the thread for 60 ms: a request that arrived during a step is answered before the next one", async () => {
    const order: string[] = [];
    let n = 0;
    const server = standIn(() => {
      request(order, `request ${++n}`);
      busy(60);
    }, order);
    const result = await withDocument(server, "d", ctx, () => "done");
    expect(result).toBe("done");
    expect(order).toEqual(["loaded", "request 1 answered", "changed", "request 2 answered", "stored", "request 3 answered"]);
  });

  it("steps that take no time (a small document) are not followed by a wait", async () => {
    const order: string[] = [];
    const server = standIn(() => {}, order);
    const started = performance.now();
    await withDocument(server, "d", ctx, () => undefined);
    // Three waits of 25 ms would be 75 ms.
    expect(performance.now() - started).toBeLessThan(20);
    expect(order).toEqual(["loaded", "changed", "stored"]);
  });

  it("the document is stored even when the change throws, and the error reaches the caller", async () => {
    const order: string[] = [];
    const server = standIn(() => {}, order);
    await expect(
      withDocument(server, "d", ctx, () => {
        throw new Error("refused");
      }),
    ).rejects.toThrow("refused");
    expect(order).toEqual(["loaded", "stored"]);
  });
});
