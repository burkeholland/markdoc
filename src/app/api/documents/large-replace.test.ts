import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

process.env.PGLITE_DATA_DIR = "memory://";
process.env.AUTH_SECRET = "test-secret-test-secret-test-secret";
// The rate limit is another bound (30 writes at once per session); this file sends more than that.
process.env.RATE_LIMIT = "off";
delete process.env.DATABASE_URL;

/**
 * A whole-document write must never keep the server's one thread for long (#2341). Before, `PUT /content`,
 * a version restore, the 409 answer and an agent's watch ran a diff with no limit: 8,000 characters
 * replaced by 8,000 others stalled the server for 2 s, 500,000 for longer than 10 minutes.
 *
 * Nothing here measures time. The character diff (fast-diff) is wrapped: every call is recorded with the
 * size of what it was asked to compare (the two lengths that are left when what both ends have in common
 * is cut off, multiplied), and a call over the limit is NOT run, so the same tests fail in seconds on
 * code without the bound instead of hanging for hours.
 */
const diffCalls = vi.hoisted(() => [] as number[]);
const EXACT_LIMIT = 1_000_000;
vi.mock("fast-diff", async (importOriginal) => {
  const actual = (await importOriginal<{ default: typeof import("fast-diff") }>()).default;
  const counted = ((a: string, b: string, ...rest: unknown[]) => {
    let start = 0;
    const max = Math.min(a.length, b.length);
    while (start < max && a.charCodeAt(start) === b.charCodeAt(start)) start++;
    let end = 0;
    while (end < max - start && a.charCodeAt(a.length - 1 - end) === b.charCodeAt(b.length - 1 - end)) end++;
    const product = (a.length - start - end) * (b.length - start - end);
    diffCalls.push(product);
    // 1,000 x 1,000 characters take 23 to 61 ms. Anything larger is answered without the work.
    if (product > 1_000_000) return [[-1, a], [1, b]];
    return (actual as unknown as (...args: unknown[]) => unknown)(a, b, ...rest);
  }) as unknown as typeof actual;
  Object.assign(counted, { INSERT: 1, EQUAL: 0, DELETE: -1 });
  return { default: counted };
});

type Actor = { id: string; login: string; name: string; image: null };
let actor: Actor | null = null;
let requestHeaders = new Headers();
vi.mock("@/auth", () => ({ auth: async () => (actor ? { user: actor } : null) }));
vi.mock("next/headers", () => ({ headers: async () => requestHeaders }));

const { getDb, schema } = await import("@/server/db");
const { createDocument, addVersion, upsertCollaborator } = await import("@/server/documents");
const { createApiToken } = await import("@/server/tokens");
const { largeWrites, LARGE_WRITE_SIZE } = await import("@/server/large-write");
const { DIFF_MAX_CHANGED_LINES } = await import("@/server/agent-events");
const content = await import("@/app/api/documents/[id]/content/route");
const suggest = await import("@/app/api/documents/[id]/suggest/route");
const version = await import("@/app/api/documents/[id]/versions/[vid]/route");
const watch = await import("@/app/api/agent/documents/[id]/events/route");

const LARGEST = 2_000_000;
const ASCII = "abcdefghijklmnopqrstuvwxyz";
const CJK = "文字漢語日本中国章書読話聞見食水火木金土山川田人大小上下左右";
function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}
/** Prose with a known seed: words, a line every 14 words, a blank line every 56. Exactly `chars` long, no white space at the end. */
function prose(chars: number, seed: number, alphabet = ASCII): string {
  const r = rng(seed);
  const out: string[] = [];
  let n = 0;
  let words = 0;
  while (n < chars) {
    let w = "";
    for (let i = 2 + Math.floor(r() * 8); i > 0; i--) w += alphabet[Math.floor(r() * alphabet.length)];
    words++;
    const sep = words % 14 === 0 ? (words % 56 === 0 ? "\n\n" : "\n") : " ";
    out.push(w + sep);
    n += w.length + sep.length;
  }
  const text = out.join("").slice(0, chars);
  return /\s$/.test(text) ? text.slice(0, -1) + alphabet[0] : text;
}

let ana: Actor;
let ben: Actor;
let docId = "";
const params = () => ({ params: Promise.resolve({ id: docId }) });
const url = (path = "content") => `http://localhost:3700/api/documents/${docId}/${path}`;
type Handler = (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;
/** A request as a client sends it: the body's size is declared. `signal` is the caller's connection. */
function request(method: string, body: unknown, path = "content", extra: { headers?: Record<string, string>; signal?: AbortSignal; declare?: boolean } = {}) {
  const text = JSON.stringify(body);
  const headers: Record<string, string> = { "Content-Type": "application/json", ...(extra.declare === false ? {} : { "Content-Length": String(Buffer.byteLength(text)) }), ...extra.headers };
  return new Request(url(path), { method, body: text, headers, signal: extra.signal });
}
const as = async <T>(who: Actor | null, fn: () => Promise<T>, bearer?: string) => {
  const saved = [actor, requestHeaders] as const;
  actor = who;
  requestHeaders = bearer ? new Headers({ authorization: ["Bearer", bearer].join(" ") }) : new Headers();
  try {
    return await fn();
  } finally {
    [actor, requestHeaders] = saved;
  }
};
const put = (who: Actor, text: string, extra: Record<string, unknown> = {}, opts: Parameters<typeof request>[3] = {}, bearer?: string) =>
  as(who, () => (content.PUT as Handler)(request("PUT", { content: text, ...extra }, "content", opts), params()), bearer);
const patch = (who: Actor, append: string, opts: Parameters<typeof request>[3] = {}) => as(who, () => (content.PATCH as Handler)(request("PATCH", { append }, "content", opts), params()));
const read = async (who: Actor = ana) => (await (await as(who, () => (content.GET as Handler)(new Request(url()), params()))).json()) as { content: string; contentHash: string };
const fresh = async (text: string, owner: Actor = ana) => {
  docId = (await createDocument({ ownerId: owner.id, title: "Large", content: text })).id;
  diffCalls.length = 0;
  return docId;
};
/** Let promise callbacks and a few turns of the event loop run. */
const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => setImmediate(resolve));
};

beforeAll(async () => {
  const db = await getDb();
  const [a] = await db.insert(schema.users).values({ name: "Ana", login: "ana-large", email: "ana-large@example.com" }).returning();
  const [b] = await db.insert(schema.users).values({ name: "Ben", login: "ben-large", email: "ben-large@example.com" }).returning();
  ana = { id: a.id, login: "ana-large", name: "Ana", image: null };
  ben = { id: b.id, login: "ben-large", name: "Ben", image: null };
});

afterEach(() => {
  expect(largeWrites.runningCount, "a test left a large write running").toBe(0);
  expect(largeWrites.waitingCount, "a test left a large write waiting").toBe(0);
});

describe("PUT /content at the largest size: the character diff is never asked for more than a small passage (#2341)", () => {
  const cases: [string, () => [string, string]][] = [
    ["2,000,000 characters replaced by 2,000,000 others", () => [prose(LARGEST, 11), prose(LARGEST, 23)]],
    ["2,000,000 Chinese characters replaced by 2,000,000 others", () => [prose(LARGEST, 11, CJK), prose(LARGEST, 23, CJK)]],
    ["one letter 2,000,000 times replaced by another letter 2,000,000 times", () => ["a".repeat(LARGEST), "文".repeat(LARGEST)]],
    ["32,000 characters replaced by 32,000 others (half a minute of stall before)", () => [prose(32_000, 11), prose(32_000, 23)]],
    ["8,000 characters replaced by 8,000 others (2 s of stall before)", () => [prose(8_000, 11), prose(8_000, 23)]],
  ];
  it.each(cases)(
    "%s",
    async (_name, texts) => {
      const [oldText, newText] = texts();
      await fresh(oldText);
      const res = await put(ana, newText);
      expect(res.status).toBe(200);
      expect(((await res.json()) as { changed: boolean }).changed).toBe(true);
      // The only step whose time is not linear, and what it was asked to do:
      expect(Math.max(0, ...diffCalls)).toBeLessThanOrEqual(EXACT_LIMIT);
      expect(diffCalls.reduce((n, p) => n + p, 0)).toBeLessThanOrEqual(2 * EXACT_LIMIT);
      // The stored Markdown is the text that was sent, to the character.
      expect((await read()).content === newText).toBe(true);
    },
    120_000,
  );

  it("one word changed in 2,000,000 characters: one small edit, found by the character diff as before", async () => {
    const oldText = prose(LARGEST, 11);
    const newText = oldText.slice(0, LARGEST / 2) + "CHANGED" + oldText.slice(LARGEST / 2 + 7);
    await fresh(oldText);
    expect((await put(ana, newText)).status).toBe(200);
    expect(diffCalls.length).toBe(1);
    expect(diffCalls[0]).toBeLessThanOrEqual(49);
    expect((await read()).content === newText).toBe(true);
  }, 120_000);

  it("the answer and the stored text of ordinary writes are what they always were", async () => {
    const base = "# Plan\n\nFirst paragraph here.\n\nSecond paragraph.\n";
    for (const next of [base, base.replace("Second", "Third"), "", "Something else entirely.\n", base + "\n\nOne more.\n", "😀 emoji 😁 and 文字\r\nWindows line\r\n"]) {
      await fresh(base);
      const res = await put(ana, next);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean; changed: boolean; contentHash: string };
      expect(body.ok).toBe(true);
      expect(body.changed).toBe(next !== base);
      const after = await read();
      expect(after.content).toBe(next);
      expect(after.contentHash).toBe(body.contentHash);
    }
  });
});

describe("restoring a version: the same bound", () => {
  it("a version of 2,000,000 characters over 2,000,000 others is restored, and the character diff stays small", async () => {
    const oldText = prose(LARGEST, 11);
    const live = prose(LARGEST, 23);
    await fresh(live);
    const kept = await addVersion({ documentId: docId, content: oldText, kind: "named", title: "keep", createdBy: ana.id });
    diffCalls.length = 0;
    const res = await as(ana, () =>
      version.POST(new Request(url(`versions/${kept.id}`), { method: "POST", body: JSON.stringify({ action: "restore" }), headers: { "Content-Type": "application/json" } }), { params: Promise.resolve({ id: docId, vid: kept.id }) }),
    );
    expect(res.status).toBe(200);
    expect(Math.max(0, ...diffCalls)).toBeLessThanOrEqual(EXACT_LIMIT);
    expect((await read()).content === oldText).toBe(true);
  }, 120_000);
});

describe("large writes take turns: two places per user, 503 with Retry-After for the third", () => {
  const large = prose(LARGE_WRITE_SIZE, 5);

  it("the numbers a client sees: a body of 200,000 bytes is large", () => {
    expect(LARGE_WRITE_SIZE).toBe(200_000);
  });

  it("while a user holds two places, a third large PUT is refused before anything is read or written; a small one goes through", async () => {
    await fresh("Start\n");
    const running = await largeWrites.enter(ana.id);
    const waiting = largeWrites.enter(ana.id);
    await settle();
    const refused = await put(ana, large);
    expect(refused.status).toBe(503);
    expect(refused.headers.get("Retry-After")).toBe("5");
    expect(await refused.json()).toEqual({ error: "You already have 2 large document writes in progress (200,000 bytes or more each). Wait for one to finish, then try again", retryAfter: 5 });
    expect((await read()).content).toBe("Start\n");
    // A write below the size is not counted, queued or refused.
    const small = await put(ana, "Start\n\nA small change.\n");
    expect(small.status).toBe(200);
    await running.release();
    await (await waiting).release();
    // And with a place free again the same large write lands.
    const again = await put(ana, large);
    expect(again.status).toBe(200);
    expect((await read()).content === large).toBe(true);
  });

  it("an API token of the user is the same caller as the user's session", async () => {
    await fresh("Start\n");
    const token = (await createApiToken(ana.id, "Writer")).token;
    const running = await largeWrites.enter(ana.id);
    const waiting = largeWrites.enter(ana.id);
    await settle();
    const refused = await put(ana, large, {}, {}, token);
    expect(refused.status).toBe(503);
    await running.release();
    await (await waiting).release();
    const landed = await put(ana, large, {}, {}, token);
    expect(landed.status).toBe(200);
  });

  it("another user is not counted with this one: their large write waits its turn and lands", async () => {
    await fresh("Start\n");
    await upsertCollaborator(docId, ben.login, "editor", ana.id);
    const running = await largeWrites.enter(ana.id);
    const waiting = largeWrites.enter(ana.id);
    await settle();
    const bens = put(ben, large);
    await settle();
    expect(largeWrites.placesOf(ben.id)).toBe(1);
    await running.release();
    await (await waiting).release();
    expect((await bens).status).toBe(200);
    expect((await read()).content === large).toBe(true);
  });

  it("PATCH, suggest and restore are bounded the same way", async () => {
    await fresh("Start\n");
    const kept = await addVersion({ documentId: docId, content: large, kind: "named", title: "keep", createdBy: ana.id });
    const running = await largeWrites.enter(ana.id);
    const waiting = largeWrites.enter(ana.id);
    await settle();
    expect((await patch(ana, large)).status).toBe(503);
    expect((await as(ana, () => (suggest.POST as Handler)(request("POST", { content: large }, "suggest"), params()))).status).toBe(503);
    // A restore has a small body; it is sized by the version's text.
    const restore = await as(ana, () =>
      version.POST(new Request(url(`versions/${kept.id}`), { method: "POST", body: JSON.stringify({ action: "restore" }), headers: { "Content-Type": "application/json" } }), { params: Promise.resolve({ id: docId, vid: kept.id }) }),
    );
    expect(restore.status).toBe(503);
    expect(restore.headers.get("Retry-After")).toBe("5");
    expect((await read()).content).toBe("Start\n");
    await running.release();
    await (await waiting).release();
  });

  it("a body that does not declare its size is sized by its text once it is parsed", async () => {
    await fresh("Start\n");
    const running = await largeWrites.enter(ana.id);
    const waiting = largeWrites.enter(ana.id);
    await settle();
    expect((await put(ana, large, {}, { declare: false })).status).toBe(503);
    expect((await put(ana, "Start\n\nSmall.\n", {}, { declare: false })).status).toBe(200);
    await running.release();
    await (await waiting).release();
  });

  it("a caller without edit rights is refused by the access check and takes no place", async () => {
    await fresh("Start\n");
    const res = await put(ben, large);
    expect(res.status).toBe(404);
    expect(largeWrites.placesOf(ben.id)).toBe(0);
    const nobody = await as(null, () => (content.PUT as Handler)(request("PUT", { content: large }), params()));
    expect(nobody.status).toBe(401);
  });

  it("20 large replaces at once from one user: 2 land, 18 get the 503, the document holds one of the texts whole", async () => {
    await fresh("Start\n");
    const texts = Array.from({ length: 20 }, (_, i) => prose(LARGE_WRITE_SIZE, 100 + i));
    // Another user's write holds the turn meanwhile, so that which of the 20 are refused does not depend on speed.
    const other = await largeWrites.enter(ben.id);
    let answered = 0;
    const pending = texts.map((text) =>
      put(ana, text).then((res) => {
        answered++;
        return res;
      }),
    );
    while (answered < 18) await settle();
    expect(largeWrites.placesOf(ana.id)).toBe(2);
    await other.release();
    const answers = await Promise.all(pending);
    const statuses = answers.map((res) => res.status);
    expect(statuses.filter((s) => s === 200).length).toBe(2);
    expect(statuses.filter((s) => s === 503).length).toBe(18);
    const stored = (await read()).content;
    expect(texts.filter((_, i) => statuses[i] === 200).some((text) => text === stored)).toBe(true);
  }, 120_000);
});

describe("a caller that goes away", () => {
  const large = prose(LARGE_WRITE_SIZE, 6);

  it("while its large write waits: 499, nothing is written, its place is free", async () => {
    await fresh("Start\n");
    const running = await largeWrites.enter(ben.id);
    const gone = new AbortController();
    const pending = put(ana, large, {}, { signal: gone.signal });
    await settle();
    expect(largeWrites.waitingCount).toBe(1);
    gone.abort();
    const res = await pending;
    expect(res.status).toBe(499);
    expect(largeWrites.placesOf(ana.id)).toBe(0);
    await running.release();
    expect((await read()).content).toBe("Start\n");
  });

  it("before its large write began: 499, nothing is written", async () => {
    await fresh("Start\n");
    const gone = new AbortController();
    gone.abort();
    const res = await put(ana, large, {}, { signal: gone.signal });
    expect(res.status).toBe(499);
    expect((await read()).content).toBe("Start\n");
  });
});

describe("PATCH /content: an append may not take the text past 2,000,000 characters", () => {
  it("exactly 2,000,000 is accepted; one more is the 400 that PUT gives a text that is too long, and nothing is appended", async () => {
    const base = prose(LARGEST - 12, 3);
    await fresh(base);
    // A blank line (2 characters) goes between the text and the append.
    const over = await patch(ana, "12345678901");
    expect(over.status).toBe(400);
    const body = (await over.json()) as { error: string; issues: { code: string; path: string[]; message: string }[] };
    expect(body.error).toBe("Invalid request");
    expect(body.issues).toEqual([{ code: "too_big", path: ["append"], message: "Too big: expected the document to have <=2000000 characters after the append" }]);
    expect((await read()).content === base).toBe(true);
    const fits = await patch(ana, "1234567890");
    expect(fits.status).toBe(200);
    expect((await read()).content.length).toBe(LARGEST);
    // PUT's own answer for a text that is too long: the same status, error and code.
    const put400 = await put(ana, "a".repeat(LARGEST + 1));
    expect(put400.status).toBe(400);
    const putBody = (await put400.json()) as { error: string; issues: { code: string; path: string[] }[] };
    expect(putBody.error).toBe("Invalid request");
    expect(putBody.issues[0]).toMatchObject({ code: "too_big", path: ["content"] });
  }, 120_000);

  it("a document that is already longer stays readable, and a PUT of an allowed text still replaces it", async () => {
    const long = prose(LARGEST + 500, 4);
    await fresh(long);
    expect((await read()).content.length).toBe(LARGEST + 500);
    expect((await patch(ana, "more")).status).toBe(400);
    expect((await put(ana, long.slice(0, 1_000))).status).toBe(200);
    expect((await read()).content).toBe(long.slice(0, 1_000));
  }, 120_000);
});

describe("the diff of what moved has a limit", () => {
  const lines = (n: number, mark: string) => Array.from({ length: n }, (_, i) => `${mark} line ${i}`).join("\n") + "\n";

  it(`a 409 for a text in which more than ${DIFF_MAX_CHANGED_LINES} lines changed says so without a diff: diff null, truncated true`, async () => {
    expect(DIFF_MAX_CHANGED_LINES).toBe(1_000);
    await fresh(lines(6_000, "old"));
    const { contentHash: seen } = await read();
    expect((await put(ana, lines(6_000, "new"))).status).toBe(200);
    const stale = await put(ana, "anything\n", { ifContentHash: seen });
    expect(stale.status).toBe(409);
    const body = (await stale.json()) as { error: string; contentHash: string; diff: string | null; truncated: boolean };
    expect(body.error).toBe("Document changed since you read it");
    expect(body.diff).toBeNull();
    expect(body.truncated).toBe(true);
    expect(body.contentHash).toBe((await read()).contentHash);
  }, 120_000);

  it("300 changed lines of 22,000 still come with a diff", async () => {
    const before = lines(22_000, "old");
    const after = before.split("\n").map((line, i) => (i % 74 === 0 && line ? line + " changed" : line)).join("\n");
    await fresh(before);
    const { contentHash: seen } = await read();
    expect((await put(ana, after)).status).toBe(200);
    const body = (await (await put(ana, "anything\n", { ifContentHash: seen })).json()) as { diff: string | null; truncated: boolean };
    expect(body.diff).toContain("+old line 0 changed");
    expect(body.truncated).toBe(true);
  }, 120_000);

  it("an agent with a READ token that watches the document gets the change without a diff, at once", async () => {
    await fresh(lines(6_000, "old"));
    const token = (await createApiToken(ana.id, "Reader", { scope: "read" })).token;
    const watchOnce = async (query = "") => {
      const res = await as(null, () => watch.GET(new Request(`http://localhost:3700/api/agent/documents/${docId}/events${query}`), params()), token);
      expect(res.status).toBe(200);
      return (await res.json()) as { cursor: string; events: { type: string; diff?: string | null; truncated?: boolean }[] };
    };
    const { cursor } = await watchOnce();
    expect((await put(ana, lines(6_000, "new"))).status).toBe(200);
    const page = await watchOnce(`?since=${encodeURIComponent(cursor)}&wait=0`);
    const changed = page.events.filter((event) => event.type === "content.changed");
    expect(changed).toHaveLength(1);
    expect(changed[0].diff).toBeNull();
    expect(changed[0].truncated).toBe(true);
  }, 120_000);
});
