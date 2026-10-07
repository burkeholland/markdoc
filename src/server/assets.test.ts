import { describe, expect, it, beforeAll, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { gzipSync } from "node:zlib";
import { budgetMs } from "../../scripts/lib/test-budget";
import { GIF, GIF_ANIMATED, IMAGE_BY_TYPE, JPEG, PNG, SVG, SVG_TEXT, WEBP, WEBP_ANIMATED, WEBP_LOSSLESS, distinctPng, pngOfSize } from "./assets.fixtures";

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
const { putAsset, getAsset, validateAsset, detectContentType, AssetError, MAX_ASSET_BYTES, ALLOWED_IMAGE_TYPES, isUnsafeSvg, cleanAssetName, sha256Hex } = await import("./assets");
const { recordActivity } = await import("./activity");
const { POST } = await import("@/app/api/documents/[id]/assets/route");

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
    const stored = await putAsset({ documentId: docId, userId, name: "Screen Shot 2026", mime: "IMAGE/JPEG; charset=binary", bytes: JPEG });
    expect(stored.mime).toBe("image/jpeg");
    expect(stored.name).toBe("Screen-Shot-2026.jpg");
    expect(cleanAssetName("../evil name.PNG", "image/png")).toBe("..-evil-name.PNG");
  });

  it("rejects files over 5 MB", async () => {
    const big = new Uint8Array(MAX_ASSET_BYTES + 1);
    await expect(putAsset({ documentId: docId, userId, name: "big.png", mime: "image/png", bytes: big })).rejects.toMatchObject({ status: 413 });
    const exact = pngOfSize(MAX_ASSET_BYTES);
    expect(exact.byteLength).toBe(MAX_ASSET_BYTES);
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
    const stored = await putAsset({ documentId: otherDocId, userId, name: "x.png", mime: "image/png", bytes: distinctPng("deleted-with-document") });
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
      const bytes = distinctPng(`race-${i}`);
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
    const bytes = distinctPng("warn");
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

  // The same route serves the editor, API tokens and agents: the refusal is one JSON error they can all read.
  it("bytes of another type than the declared one: 415 with a message that names both, nothing stored, no activity", async () => {
    const db = await getDb();
    const stored = async () => (await db.select({ id: schema.assets.id }).from(schema.assets).where(eq(schema.assets.documentId, docId))).length;
    const before = { assets: await stored(), activity: (await uploads()).length };
    const res = await upload("photo.png", JPEG);
    expect(res.status).toBe(415);
    expect(await res.json()).toEqual({ error: "This file was sent as PNG but its content is JPEG. Give it the matching file extension (.jpg) and upload it again" });
    const text = await upload("notes.png", new TextEncoder().encode("just some notes, not an image") as Uint8Array<ArrayBuffer>);
    expect(text.status).toBe(415);
    expect(await text.json()).toEqual({ error: "This file is not a PNG image: its content does not match its type. Save it again as PNG, JPEG, GIF, WebP or SVG and upload that file" });
    expect({ assets: await stored(), activity: (await uploads()).length }).toEqual(before);
  });
});

/**
 * Uploaded bytes must be what their declared type says (#2287). `validateAsset` is the one check behind the
 * upload route and the file import; it reads signatures and text only.
 */
describe("upload byte check", () => {
  const enc = (s: string) => new TextEncoder().encode(s) as Uint8Array<ArrayBuffer>;
  const status = (mime: string, bytes: Uint8Array): number | "ok" => {
    try {
      validateAsset({ mime, bytes });
      return "ok";
    } catch (err) {
      if (err instanceof AssetError) return err.status;
      throw err;
    }
  };
  const message = (mime: string, bytes: Uint8Array): string => {
    try {
      validateAsset({ mime, bytes });
      return "";
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  };
  const REAL: [name: string, mime: string, bytes: Uint8Array<ArrayBuffer>][] = [
    ["PNG", "image/png", PNG],
    ["PNG padded to exactly 5 MB", "image/png", pngOfSize(MAX_ASSET_BYTES)],
    ["JPEG", "image/jpeg", JPEG],
    ["GIF", "image/gif", GIF],
    ["animated GIF", "image/gif", GIF_ANIMATED],
    ["lossy WebP", "image/webp", WEBP],
    ["lossless WebP", "image/webp", WEBP_LOSSLESS],
    ["animated WebP", "image/webp", WEBP_ANIMATED],
    ["SVG", "image/svg+xml", SVG],
  ];

  it.each(REAL)("accepts a real %s under its own type", (_name, mime, bytes) => {
    expect(detectContentType(bytes)).toBe(mime);
    expect(status(mime, bytes)).toBe("ok");
  });

  it("refuses every allowed type whose bytes are another allowed type, and says which", () => {
    const types = [...ALLOWED_IMAGE_TYPES];
    expect(types.sort()).toEqual(Object.keys(IMAGE_BY_TYPE).sort());
    const label: Record<string, string> = { "image/png": "PNG", "image/jpeg": "JPEG", "image/gif": "GIF", "image/webp": "WebP", "image/svg+xml": "SVG" };
    const refused: string[] = [];
    for (const declared of types) {
      for (const content of types) {
        if (declared === content) continue;
        expect(status(declared, IMAGE_BY_TYPE[content]), `${content} sent as ${declared}`).toBe(415);
        expect(message(declared, IMAGE_BY_TYPE[content])).toContain(`was sent as ${label[declared]} but its content is ${label[content]}.`);
        refused.push(`${declared}<-${content}`);
      }
    }
    expect(refused).toHaveLength(20);
  });

  it("refuses a file cut inside its header, and an empty one", () => {
    // Shorter than the signature plus the first structure after it: not that type by its bytes.
    const headers: [mime: string, bytes: Uint8Array, headerLength: number][] = [
      ["image/png", PNG, 33],
      ["image/jpeg", JPEG, 4],
      ["image/gif", GIF, 20],
      ["image/gif", GIF_ANIMATED, 20],
      ["image/webp", WEBP, 20],
    ];
    for (const [mime, bytes, headerLength] of headers) {
      for (let length = 1; length < headerLength; length++) {
        expect(status(mime, bytes.subarray(0, length)), `${mime} cut to ${length} bytes`).toBe(415);
      }
      // From the full header on the bytes are that type; the check reads headers and decodes nothing.
      expect(status(mime, bytes.subarray(0, headerLength)), `${mime} cut to its ${headerLength} byte header`).toBe("ok");
      expect(status(mime, new Uint8Array()), `${mime} empty`).toBe(400);
    }
    expect(status("image/svg+xml", enc("<sv"))).toBe(415);
    expect(status("image/svg+xml", enc("<!-- never closed <svg>"))).toBe(415);
    expect(status("image/svg+xml", enc('<?xml version="1.0"'))).toBe(415);
    expect(status("image/svg+xml", new Uint8Array())).toBe(400);
  });

  it("refuses a signature with other content behind it", () => {
    const glued = (signature: number[] | string, rest: string) => Uint8Array.from([...(typeof signature === "string" ? Buffer.from(signature, "latin1") : signature), ...Buffer.from(rest, "latin1")]);
    const text = `${SVG_TEXT} and enough text to be longer than any header this check reads`;
    const cases: [mime: string, bytes: Uint8Array][] = [
      ["image/png", glued([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], text)],
      ["image/jpeg", glued([0xff, 0xd8, 0xff], text)],
      ["image/jpeg", glued([0xff, 0xd8], text)],
      ["image/gif", glued("GIF89a", text)],
      ["image/gif", glued("GIF87a", text)],
      ["image/webp", glued("RIFF", text)],
      ["image/webp", glued("RIFF\0\0\0\0WEBP", text)],
    ];
    for (const [mime, bytes] of cases) {
      expect(detectContentType(bytes), `${mime} signature + text`).toBeNull();
      expect(status(mime, bytes), `${mime} signature + text`).toBe(415);
      expect(message(mime, bytes)).toContain("its content does not match its type");
    }
  });

  it("accepts SVG the way drawing tools write it: byte-order mark, whitespace, declaration, comments, doctype", () => {
    const accepted: [name: string, bytes: Uint8Array][] = [
      ["byte-order mark", Uint8Array.from([0xef, 0xbb, 0xbf, ...enc(SVG_TEXT)])],
      ["leading whitespace", enc(`\r\n\t  ${SVG_TEXT}`)],
      ["XML declaration", enc(`<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n${SVG_TEXT}`)],
      ["declaration naming ISO-8859-1", enc(`<?xml version="1.0" encoding="iso-8859-1"?>${SVG_TEXT}`)],
      ["leading comment", enc(`<!-- Generator: a drawing tool, version 1.0 -->\n${SVG_TEXT}`)],
      ["comment that mentions other markup", enc(`<!-- not <html>, not <png> -->${SVG_TEXT}`)],
      ["doctype", enc(`<?xml version="1.0"?>\n<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">\n${SVG_TEXT}`)],
      ["doctype with an internal subset", enc(`<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd" [\n\t<!ENTITY ns_svg "http://www.w3.org/2000/svg">\n\t<!ENTITY gt ">">\n]>\n${SVG_TEXT}`)],
      ["stylesheet instruction", enc(`<?xml version="1.0"?><?xml-stylesheet type="text/css" href="a.css"?>${SVG_TEXT}`)],
      ["all of them", Uint8Array.from([0xef, 0xbb, 0xbf, ...enc(`<?xml version="1.0"?>\n<!-- a -->\n<!DOCTYPE svg>\n<!-- b -->\n${SVG_TEXT}\n`)])],
      ["prefixed root", enc('<svg:svg xmlns:svg="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><svg:rect width="1" height="1"/></svg:svg>')],
      ["UTF-16 with its byte-order mark", Uint8Array.from([0xff, 0xfe, ...Buffer.from(`<?xml version="1.0" encoding="UTF-16"?>${SVG_TEXT}`, "utf16le")])],
      ["upper-case attributes and no namespace", enc('<svg WIDTH="1" HEIGHT="1"></svg>')],
    ];
    for (const [name, bytes] of accepted) {
      expect(detectContentType(bytes), name).toBe("image/svg+xml");
      expect(status("image/svg+xml", bytes), name).toBe("ok");
    }
  });

  it("refuses what is not SVG text under the SVG type: compressed SVG, other markup, plain text, unknown encodings", () => {
    const refused: [name: string, bytes: Uint8Array, content: string | null][] = [
      ["gzip-compressed SVG (.svgz)", gzipSync(SVG), null],
      ["an HTML page", enc("<!DOCTYPE html><html><body><svg></svg></body></html>"), "xml"],
      ["an HTML page, lower-case doctype", enc("<!doctype html><svg></svg>"), "xml"],
      ["other XML", enc('<?xml version="1.0"?><note><svg/></note>'), "xml"],
      ["an element whose name only starts with svg", enc("<svgx></svgx>"), "xml"],
      ["plain text", enc("svg"), null],
      ["text before the markup", enc(`hello ${SVG_TEXT}`), null],
      ["UTF-16 without a byte-order mark", Uint8Array.from(Buffer.from(SVG_TEXT, "utf16le")), null],
      ["a declaration naming an encoding that hides ASCII", enc(`<?xml version="1.0" encoding="UTF-7"?>${SVG_TEXT}`), "xml"],
      ["a NUL byte in the text", enc(`${SVG_TEXT}\0`), null],
    ];
    for (const [name, bytes, content] of refused) {
      expect(detectContentType(bytes), name).toBe(content);
      expect(status("image/svg+xml", bytes), name).toBe(415);
      expect(message("image/svg+xml", bytes), name).toContain("This file is not an SVG image");
    }
  });

  it("checks SVG for scripts whatever type it was sent as, and never stores other markup", () => {
    const scripted = enc('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    const handler = enc('<?xml version="1.0"?>\n<!-- c -->\n<svg xmlns="http://www.w3.org/2000/svg"><rect onload="alert(1)" width="1" height="1"/></svg>');
    const utf16 = Uint8Array.from([0xff, 0xfe, ...Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', "utf16le")]);
    const SCRIPTS = "SVG images may not contain scripts or event handlers";
    for (const mime of ALLOWED_IMAGE_TYPES) {
      for (const bytes of [scripted, handler, utf16]) {
        expect(status(mime, bytes), mime).toBe(400);
        expect(message(mime, bytes), mime).toBe(SCRIPTS);
      }
    }
    expect(isUnsafeSvg(utf16)).toBe(true);
    // Markup that is not SVG (a web page saved under an image name) is no allowed type: refused as what it is not.
    const page = enc('<!doctype html><html><head><script src="a.js"></script></head><body onload="x()"></body></html>');
    const otherXml = enc('<?xml version="1.0"?><note><a href="javascript:alert(1)">x</a></note>');
    for (const mime of ALLOWED_IMAGE_TYPES) {
      for (const bytes of [page, otherXml]) {
        expect(detectContentType(bytes)).toBe("xml");
        expect(status(mime, bytes), mime).toBe(415);
        expect(message(mime, bytes), mime).toContain(mime === "image/svg+xml" ? "This file is not an SVG image" : "its content does not match its type");
      }
    }
    // Clean SVG under another type is a mismatch, not a script finding.
    expect(message("image/png", SVG)).toBe("This file was sent as PNG but its content is SVG. Give it the matching file extension (.svg) and upload it again");
  });

  it("stores nothing for a mismatch", async () => {
    const db = await getDb();
    const [user] = await db.insert(schema.users).values({ name: "Cy", login: "cy", email: "cy@example.com" }).returning();
    await db.insert(schema.documents).values({ id: "byte-check-doc", title: "Bytes", ownerId: user.id, content: "" });
    await expect(putAsset({ documentId: "byte-check-doc", userId: user.id, name: "a.png", mime: "image/png", bytes: GIF })).rejects.toMatchObject({ status: 415 });
    await expect(putAsset({ documentId: "byte-check-doc", userId: user.id, name: "a.svg", mime: "image/svg+xml", bytes: PNG })).rejects.toMatchObject({ status: 415 });
    expect(await db.select({ id: schema.assets.id }).from(schema.assets).where(eq(schema.assets.documentId, "byte-check-doc"))).toEqual([]);
  });

  /**
   * The check runs on every upload, on files up to 5 MB: none of its patterns may run long. Each input is the
   * worst case for one part of it (a prefix that almost matches, repeated to the size limit).
   */
  it("stays fast on 5 MB of text built against its patterns", () => {
    const fill = (unit: string, head = "<svg>") => enc(head + unit.repeat(Math.floor((MAX_ASSET_BYTES - head.length) / unit.length)));
    const inputs: [name: string, bytes: Uint8Array][] = [
      ["spaces", fill(" ")],
      ["open brackets", fill("<")],
      ["bracket then spaces", fill("< ")],
      ["almost <script", fill("<scrip ")],
      ["almost on*=", fill(" on")],
      ["one long attribute name", fill("a", "<svg> on")],
      ["attribute names then spaces", fill(" ona   ")],
      ["almost javascript:", fill("javascript ")],
      ["almost foreignObject", fill("<foreignObjec ")],
      ["one endless comment", fill("-", "<!--")],
      ["many comments", fill("<!---->", "")],
      ["one endless declaration", fill("?", "<?xml")],
      ["one endless doctype", fill("[", "<!DOCTYPE svg ")],
      ["doctype of quotes", fill('"', "<!DOCTYPE svg ")],
      ["one endless element name", fill("s", "<")],
      ["whitespace only", fill("\n", "")],
      ["zero bytes", new Uint8Array(MAX_ASSET_BYTES)],
      ["PNG padded to the limit", pngOfSize(MAX_ASSET_BYTES)],
    ];
    const timings: Record<string, number> = {};
    for (const [name, bytes] of inputs) {
      expect(bytes.byteLength).toBeLessThanOrEqual(MAX_ASSET_BYTES);
      const start = performance.now();
      for (const mime of ["image/svg+xml", "image/png"]) status(mime, bytes);
      timings[name] = Math.round(performance.now() - start);
    }
    console.log(`[assets] byte check, two calls on 5 MB each, ms: ${JSON.stringify(timings)}`);
    for (const [name, ms] of Object.entries(timings)) expect(ms, name).toBeLessThan(budgetMs(1500));
  });
});
