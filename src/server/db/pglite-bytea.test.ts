import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { PGLITE_BYTEA } from "./index";

/**
 * The embedded database writes and reads `bytea` through `Buffer` (#2341). The text it hands PostgreSQL is
 * the same as before (`\x` and two hex digits a byte), so a data folder written by a server without the
 * option is read by one with it, and the reverse. A real folder on disk, opened four times.
 */
const folder = mkdtempSync(path.join(tmpdir(), "markdoc-bytea-"));
afterAll(() => rmSync(folder, { recursive: true, force: true }));

/** Every byte value, an empty value, one byte, and 300,000 bytes that are not a pattern. */
const values: [string, Uint8Array][] = [
  ["every byte", Uint8Array.from({ length: 256 }, (_, i) => i)],
  ["empty", new Uint8Array(0)],
  ["one zero byte", Uint8Array.of(0)],
  ["backslash and quotes", new TextEncoder().encode(`\\x00 ' " \\ \n`)],
  ["300,000 bytes", Uint8Array.from({ length: 300_000 }, (_, i) => (Math.imul(i, 2654435761) >>> 13) & 255)],
];
// A view into a larger buffer, the way Node's Buffer pool hands bytes out: only the view's bytes may be written.
const pooled = Buffer.concat([Buffer.from("before"), Buffer.from(values[0][1]), Buffer.from("after")]).subarray(6, 6 + 256);

const read = async (db: PGlite) => (await db.query<{ id: string; b: Uint8Array }>("select id, b from t order by id")).rows;
const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && Buffer.from(a).equals(Buffer.from(b));

describe("PGlite bytea through Buffer: the stored bytes are the same (#2341)", () => {
  it("the option names the bytea type (17) and nothing else", () => {
    expect(Object.keys(PGLITE_BYTEA.serializers)).toEqual(["17"]);
    expect(Object.keys(PGLITE_BYTEA.parsers)).toEqual(["17"]);
  });

  it("writes the text PostgreSQL expects, and reads it back", () => {
    expect(PGLITE_BYTEA.serializers[17](Uint8Array.of(0, 1, 15, 16, 255))).toBe("\\x00010f10ff");
    expect(PGLITE_BYTEA.serializers[17](new Uint8Array(0))).toBe("\\x");
    expect(PGLITE_BYTEA.serializers[17](pooled)).toBe("\\x" + Buffer.from(values[0][1]).toString("hex"));
    // A value that is already text (a caller that built the literal itself) goes through untouched.
    expect(PGLITE_BYTEA.serializers[17]("\\x0102")).toBe("\\x0102");
    const parsed = PGLITE_BYTEA.parsers[17]("\\x00010f10ff");
    expect(parsed).toBeInstanceOf(Uint8Array);
    expect(Array.from(parsed)).toEqual([0, 1, 15, 16, 255]);
    expect(PGLITE_BYTEA.parsers[17]("\\x").length).toBe(0);
  });

  it("a folder written without the option is read with it, and a folder written with it is read without", async () => {
    // 1. As main writes it.
    let db = new PGlite(folder);
    await db.exec("create table t (id text primary key, b bytea)");
    for (const [id, bytes] of values) await db.query("insert into t values ($1, $2)", [`old ${id}`, bytes]);
    const asMainReadsItsOwn = await read(db);
    await db.close();

    // 2. This branch opens the same folder: the same bytes come back. It writes its own rows next to them.
    db = new PGlite(folder, { ...PGLITE_BYTEA });
    const oldRows = await read(db);
    expect(oldRows.map((r) => r.id)).toEqual(values.map(([id]) => `old ${id}`).sort());
    for (const row of oldRows) {
      const want = values.find(([id]) => `old ${id}` === row.id)![1];
      expect(row.b).toBeInstanceOf(Uint8Array);
      expect(same(row.b, want), row.id).toBe(true);
      expect(same(row.b, asMainReadsItsOwn.find((r) => r.id === row.id)!.b), row.id).toBe(true);
    }
    for (const [id, bytes] of values) await db.query("insert into t values ($1, $2)", [`new ${id}`, bytes]);
    await db.query("insert into t values ($1, $2)", ["new pooled", pooled]);
    // What is stored is the same value for the database itself, not only for the reader.
    const equalInSql = await db.query<{ n: number }>("select count(*)::int as n from t a join t b on b.id = 'new ' || substr(a.id, 5) and a.b = b.b where a.id like 'old %'");
    expect(equalInSql.rows[0].n).toBe(values.length);
    await db.close();

    // 3. Back on main: it reads what this branch wrote.
    db = new PGlite(folder);
    const all = await read(db);
    for (const [id, bytes] of values) {
      expect(same(all.find((r) => r.id === `new ${id}`)!.b, bytes), `new ${id}`).toBe(true);
      expect(same(all.find((r) => r.id === `old ${id}`)!.b, bytes), `old ${id}`).toBe(true);
    }
    expect(same(all.find((r) => r.id === "new pooled")!.b, values[0][1])).toBe(true);
    await db.close();

    // 4. And this branch once more, after main had the folder.
    db = new PGlite(folder, { ...PGLITE_BYTEA });
    const again = await read(db);
    expect(again).toHaveLength(2 * values.length + 1);
    for (const [id, bytes] of values) expect(same(again.find((r) => r.id === `new ${id}`)!.b, bytes), id).toBe(true);
    await db.close();
  }, 120_000);
});
