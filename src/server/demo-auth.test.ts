import { describe, expect, it, vi } from "vitest";

process.env.PGLITE_DATA_DIR = "memory://";
process.env.AUTH_SECRET = "test-secret-test-secret-test-secret";
delete process.env.DATABASE_URL;

vi.mock("@/auth", () => ({ auth: async () => null }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));

const { getDb, schema } = await import("@/server/db");
const { eq } = await import("drizzle-orm");
const { assertDemoAuthSafe, demoAuthEnabled, ensureDemoUser, DEMO_DOCUMENTS, DEMO_LOGIN } = await import("@/server/demo-auth");

describe("demoAuthEnabled", () => {
  it.each([
    [{ MARKDOC_DEMO_AUTH: "1", NODE_ENV: "development" }, true],
    [{ MARKDOC_DEMO_AUTH: "1", NODE_ENV: "test" }, true],
    [{ MARKDOC_DEMO_AUTH: "1", NODE_ENV: "production" }, false],
    [{ MARKDOC_DEMO_AUTH: "1" }, false],
    [{ MARKDOC_DEMO_AUTH: "force", NODE_ENV: "production" }, false],
    [{ MARKDOC_DEMO_AUTH: "true", NODE_ENV: "development" }, false],
    [{ NODE_ENV: "development" }, false],
  ])("%o -> %s", (env, expected) => {
    expect(demoAuthEnabled(env)).toBe(expected);
  });
});

describe("assertDemoAuthSafe", () => {
  it("refuses any demo flag outside development/test", () => {
    expect(() => assertDemoAuthSafe({ MARKDOC_DEMO_AUTH: "1", NODE_ENV: "production" })).toThrow(/Refusing to start/);
    expect(() => assertDemoAuthSafe({ MARKDOC_DEMO_AUTH: "0" })).toThrow(/Refusing to start/);
  });
  it("allows production without the flag and the flag in development", () => {
    expect(() => assertDemoAuthSafe({ NODE_ENV: "production" })).not.toThrow();
    expect(() => assertDemoAuthSafe({ MARKDOC_DEMO_AUTH: "1", NODE_ENV: "development" })).not.toThrow();
  });
});

describe("ensureDemoUser", () => {
  it("creates the demo user once and seeds sample documents", async () => {
    const db = await getDb();
    const first = await ensureDemoUser(db);
    const second = await ensureDemoUser(db);
    expect(second!.id).toBe(first!.id);
    expect(first!.login).toBe(DEMO_LOGIN);
    const docs = await db.select().from(schema.documents).where(eq(schema.documents.ownerId, first!.id));
    expect(docs.map((d) => d.title).sort()).toEqual(DEMO_DOCUMENTS.map((d) => d.title).sort());
  });
});
