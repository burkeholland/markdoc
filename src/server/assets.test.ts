import { describe, expect, it, beforeAll, vi } from "vitest";
import { and, eq } from "drizzle-orm";

process.env.PGLITE_DATA_DIR = "memory://";
process.env.AUTH_SECRET = "test-secret-test-secret-test-secret";
delete process.env.DATABASE_URL;

// Same stand-ins as the route tests: the upload route resolves the caller through next-auth and `next/headers`.
let actor: { id: string; login: string; name: string; image: null } | null = null;
vi.mock("@/auth", () => ({ auth: async () => (actor ? { user: actor } : null) }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
// Wrapped so a test can make the activity row fail after the asset is stored.
vi.mock("@/server/activity", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/activity")>();
  return { ...actual, recordActivity: vi.fn(actual.recordActivity) };
});

const { getDb, schema } = await import("./db");
const { putAsset, getAsset, AssetError, MAX_ASSET_BYTES, isUnsafeSvg, cleanAssetName, sha256Hex } = await import("./assets");
const { recordActivity } = await import("./activity");
const { POST } = await import("@/app/api/documents/[id]/assets/route");

// Smallest valid PNG (1x1 transparent pixel).
const PNG = Uint8Array.from(
  Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64"),
);

describe("assets", () => {
  let userId: string;
  const docId = "asset-doc";
  const otherDocId = "asset-doc-2";

  beforeAll(async () => {
    const db = await getDb();
    const [user] = await db.insert(schema.users).values({ name: "Ann", login: "ann", email: "ann@example.com" }).returning();
    userId = user.id;
    await db.insert(schema.documents).values([
      { id: docId, title: "Pics", ownerId: userId, content: "" },
      { id: otherDocId, title: "Other", ownerId: userId, content: "" },
    ]);
  });

  it("stores an image and reads it back with its metadata", async () => {
    const stored = await putAsset({ documentId: docId, userId, name: "dot.png", mime: "image/png", bytes: PNG });
    expect(stored.url).toBe(`/api/assets/${stored.id}`);
    expect(stored).toMatchObject({ name: "dot.png", mime: "image/png", size: PNG.byteLength });

    const got = await getAsset(stored.id);
    expect(got).not.toBeNull();
    expect(got!.mime).toBe("image/png");
    expect(got!.size).toBe(PNG.byteLength);
    expect(got!.documentId).toBe(docId);
    expect(Array.from(got!.bytes)).toEqual(Array.from(PNG));
    expect(await getAsset("missing")).toBeNull();
  });

  it("dedupes identical bytes within a document but not across documents", async () => {
    const a = await putAsset({ documentId: docId, userId, name: "dot.png", mime: "image/png", bytes: PNG });
    const b = await putAsset({ documentId: docId, userId, name: "same-pixels.png", mime: "image/png", bytes: PNG });
    expect(b.id).toBe(a.id);
    const c = await putAsset({ documentId: otherDocId, userId, name: "dot.png", mime: "image/png", bytes: PNG });
    expect(c.id).not.toBe(a.id);
  });

  it("normalizes the content type and adds a fitting extension", async () => {
    const stored = await putAsset({ documentId: docId, userId, name: "Screen Shot 2026", mime: "IMAGE/JPEG; charset=binary", bytes: new Uint8Array([1, 2, 3]) });
    expect(stored.mime).toBe("image/jpeg");
    expect(stored.name).toBe("Screen-Shot-2026.jpg");
    expect(cleanAssetName("../evil name.PNG", "image/png")).toBe("..-evil-name.PNG");
  });

  it("rejects files over 5 MB", async () => {
    const big = new Uint8Array(MAX_ASSET_BYTES + 1);
    await expect(putAsset({ documentId: docId, userId, name: "big.png", mime: "image/png", bytes: big })).rejects.toMatchObject({ status: 413 });
    const exact = new Uint8Array(MAX_ASSET_BYTES);
    exact[0] = 7;
    await expect(putAsset({ documentId: docId, userId, name: "exact.png", mime: "image/png", bytes: exact })).resolves.toMatchObject({ size: MAX_ASSET_BYTES });
  });

  it("rejects unsupported types and empty files", async () => {
    await expect(putAsset({ documentId: docId, userId, name: "doc.pdf", mime: "application/pdf", bytes: PNG })).rejects.toBeInstanceOf(AssetError);
    await expect(putAsset({ documentId: docId, userId, name: "doc.pdf", mime: "application/pdf", bytes: PNG })).rejects.toMatchObject({ status: 415 });
    await expect(putAsset({ documentId: docId, userId, name: "empty.png", mime: "image/png", bytes: new Uint8Array() })).rejects.toMatchObject({ status: 400 });
  });

  it("rejects SVG with scripts or event handlers but accepts plain SVG", async () => {
    const enc = (s: string) => new TextEncoder().encode(s);
    const scripted = enc('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    const handler = enc('<svg xmlns="http://www.w3.org/2000/svg"><rect onload="alert(1)" width="1" height="1"/></svg>');
    const jsHref = enc('<svg xmlns="http://www.w3.org/2000/svg"><a href="javascript:alert(1)"><text>x</text></a></svg>');
    const clean = enc('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4" fill="tomato"/></svg>');
    expect(isUnsafeSvg(scripted)).toBe(true);
    expect(isUnsafeSvg(handler)).toBe(true);
    expect(isUnsafeSvg(jsHref)).toBe(true);
    expect(isUnsafeSvg(clean)).toBe(false);
    await expect(putAsset({ documentId: docId, userId, name: "bad.svg", mime: "image/svg+xml", bytes: scripted })).rejects.toMatchObject({ status: 400 });
    await expect(putAsset({ documentId: docId, userId, name: "bad2.svg", mime: "image/svg+xml", bytes: handler })).rejects.toMatchObject({ status: 400 });
    const ok = await putAsset({ documentId: docId, userId, name: "ok.svg", mime: "image/svg+xml", bytes: clean });
    expect(ok.mime).toBe("image/svg+xml");
  });

  it("removes assets when their document is deleted", async () => {
    const db = await getDb();
    const stored = await putAsset({ documentId: otherDocId, userId, name: "x.png", mime: "image/png", bytes: new Uint8Array([9, 9, 9]) });
    await db.delete(schema.documents).where(eq(schema.documents.id, otherDocId));
    expect(await getAsset(stored.id)).toBeNull();
  });

  /**
   * Two uploads of the same bytes at once both pass the select (no row yet) and both insert; the loser used
   * to trip `asset_document_sha_idx` and answer 500 although the asset was stored (audit #1202 F18). The
   * insert is `on conflict do nothing` now and the loser re-reads the winner's row, so both callers get the
   * one asset. PGlite runs one statement at a time, but the select→insert pair interleaves at the awaits.
   */
  it("two concurrent puts of the same bytes both resolve with one asset id and one row (race-free dedupe)", async () => {
    const db = await getDb();
    const rounds = 20;
    const rejected: unknown[] = [];
    let sameId = 0;
    for (let i = 0; i < rounds; i++) {
      const bytes = new Uint8Array([0x52, 0x41, 0x43, 0x45, i]);
      const put = (name: string) => putAsset({ documentId: docId, userId, name, mime: "image/png", bytes });
      const outcomes = await Promise.allSettled([put(`race-${i}-a.png`), put(`race-${i}-b.png`)]);
      for (const o of outcomes) if (o.status === "rejected") rejected.push(o.reason);
      const ids = outcomes.flatMap((o) => (o.status === "fulfilled" ? [o.value.id] : []));
      if (ids.length === 2 && ids[0] === ids[1]) sameId++;
      const rows = await db
        .select({ id: schema.assets.id, name: schema.assets.name })
        .from(schema.assets)
        .where(and(eq(schema.assets.documentId, docId), eq(schema.assets.sha256, sha256Hex(bytes))));
      expect(rows).toHaveLength(1);
      if (ids.length) expect(ids[0]).toBe(rows[0].id);
    }
    const sqlState = (err: unknown): unknown => {
      for (let e = err, depth = 0; e && typeof e === "object" && depth < 5; e = (e as { cause?: unknown }).cause, depth++) {
        if ("code" in e) return (e as { code: unknown }).code;
      }
      return undefined;
    };
    expect({ rounds, rejected: rejected.length, sameId, codes: [...new Set(rejected.map(sqlState))] }).toEqual({ rounds, rejected: 0, sameId: rounds, codes: [] });
  });
});

/**
 * The route stores the asset and then records `asset.upload`; a failure there used to answer 500 for an
 * upload that had happened (the retry returned the same asset through the sha256 dedupe). Audit #1202 F18.
 */
describe("POST /api/documents/[id]/assets", () => {
  const docId = "asset-route-doc";
  const ctx = { params: Promise.resolve({ id: docId }) };
  const upload = (name: string, bytes: Uint8Array<ArrayBuffer>) => POST(new Request(`http://localhost:3700/api/documents/${docId}/assets?name=${name}`, { method: "POST", headers: { "content-type": "image/png" }, body: bytes }), ctx);
  /** Runs `fn` with console.error silenced; returns its result and the `[assets]`-prefixed lines it logged. */
  const quietly = async <T>(fn: () => Promise<T>): Promise<{ result: T; logged: unknown[][] }> => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = await fn();
      return { result, logged: errors.mock.calls.filter((c) => typeof c[0] === "string" && c[0].startsWith("[assets]")) };
    } finally {
      errors.mockRestore();
    }
  };
  const uploads = async () => {
    const db = await getDb();
    return db
      .select()
      .from(schema.activity)
      .where(and(eq(schema.activity.documentId, docId), eq(schema.activity.action, "asset.upload")));
  };

  beforeAll(async () => {
    const db = await getDb();
    const [user] = await db.insert(schema.users).values({ name: "Bea", login: "bea", email: "bea@example.com" }).returning();
    actor = { id: user.id, login: "bea", name: "Bea", image: null };
    await db.insert(schema.documents).values({ id: docId, title: "Uploads", ownerId: user.id, content: "" });
  });

  it("a normal upload answers exactly 201 { id, url, name, mime, size, alt } — no warnings key — and records asset.upload", async () => {
    const res = await upload("plain.png", PNG);
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string };
    expect(body).toEqual({ id: expect.any(String), url: `/api/assets/${body.id}`, name: "plain.png", mime: "image/png", size: PNG.byteLength, alt: "plain" });
    expect(await uploads()).toHaveLength(1);
  });

  it("recordActivity failing after the asset is stored: 201 with the asset and warnings: [activity-not-recorded]", async () => {
    const bytes = new Uint8Array([0x57, 0x41, 0x52, 0x4e]);
    vi.mocked(recordActivity).mockRejectedValueOnce(new Error('Failed query: insert into "activity" ("id", "document_id") values ($1, $2) params: abc,secret-owner-uuid'));
    const { result: res, logged } = await quietly(() => upload("warn.png", bytes));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string };
    expect(body).toEqual({ id: expect.any(String), url: `/api/assets/${body.id}`, name: "warn.png", mime: "image/png", size: bytes.byteLength, alt: "warn", warnings: ["activity-not-recorded"] });
    // The driver's message (statement + parameters) stays in the log, logged once under the route's code.
    expect(JSON.stringify(body)).not.toContain("Failed query");
    expect(logged).toEqual([["[assets] activity-not-recorded", expect.any(Error)]]);

    expect(await getAsset(body.id)).toMatchObject({ documentId: docId, size: bytes.byteLength });
    expect(await uploads()).toHaveLength(1);
    // The retry an agent makes lands on the same asset through the dedupe, and records the activity this time.
    const again = await upload("warn.png", bytes);
    expect(again.status).toBe(201);
    expect(((await again.json()) as { id: string }).id).toBe(body.id);
    expect(await uploads()).toHaveLength(2);
  });

  it("a rejected image is still its 4xx with nothing stored and no activity", async () => {
    const before = (await uploads()).length;
    const res = await upload("empty.png", new Uint8Array());
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "The file is empty" });
    expect(await uploads()).toHaveLength(before);
  });
});
