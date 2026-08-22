import { describe, expect, it, beforeAll } from "vitest";

process.env.PGLITE_DATA_DIR = "memory://";
delete process.env.DATABASE_URL;

const { getDb, schema } = await import("./db");
const { putAsset, getAsset, AssetError, MAX_ASSET_BYTES, isUnsafeSvg, cleanAssetName } = await import("./assets");

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
    const { eq } = await import("drizzle-orm");
    const stored = await putAsset({ documentId: otherDocId, userId, name: "x.png", mime: "image/png", bytes: new Uint8Array([9, 9, 9]) });
    await db.delete(schema.documents).where(eq(schema.documents.id, otherDocId));
    expect(await getAsset(stored.id)).toBeNull();
  });
});
