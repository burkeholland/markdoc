import { describe, expect, it, beforeAll } from "vitest";

process.env.PGLITE_DATA_DIR = "memory://";
delete process.env.DATABASE_URL;

const { getDb, schema } = await import("@/server/db");
const { eq } = await import("drizzle-orm");
const { createDocument, recordDocumentOpen } = await import("@/server/documents");
const { createApiToken, resolveApiToken } = await import("@/server/tokens");
const { recordUsage, usageReport, usageDay } = await import("@/server/usage");

let alice: string;
let bob: string;

beforeAll(async () => {
  const db = await getDb();
  const [a] = await db.insert(schema.users).values({ name: "Alice", login: "alice", email: "alice-usage@example.com", createdAt: new Date("2026-03-01T09:00:00Z") }).returning();
  const [b] = await db.insert(schema.users).values({ name: "Bob", login: "bob", email: "bob-usage@example.com", createdAt: new Date("2026-03-03T23:30:00Z") }).returning();
  alice = a.id;
  bob = b.id;
});

const day = (report: Awaited<ReturnType<typeof usageReport>>, d: string) => report.find((r) => r.day === d);

describe("daily usage", () => {
  it("keeps past opens of the same document that the recents row overwrites", async () => {
    const doc = await createDocument({ ownerId: alice, title: "Plans" });
    await recordDocumentOpen(alice, doc.id, new Date("2026-03-01T10:00:00Z"));
    await recordDocumentOpen(alice, doc.id, new Date("2026-03-05T10:00:00Z"));

    const db = await getDb();
    const recent = await db.select().from(schema.recents).where(eq(schema.recents.userId, alice));
    expect(recent).toHaveLength(1);

    const report = await usageReport("2026-03-01", "2026-03-05");
    expect(day(report, "2026-03-01")).toMatchObject({ dau: 1, wau: 1, mau: 1 });
    expect(day(report, "2026-03-03")).toMatchObject({ dau: 0, wau: 1, mau: 1 });
    expect(day(report, "2026-03-05")).toMatchObject({ dau: 1, wau: 1, mau: 1 });
  });

  it("counts a user once per window however many kinds of use they had", async () => {
    await recordUsage(bob, "open", new Date("2026-03-04T08:00:00Z"));
    await recordUsage(bob, "edit", new Date("2026-03-04T09:00:00Z"));
    await recordUsage(bob, "edit", new Date("2026-03-04T10:00:00Z"));
    const report = await usageReport("2026-03-04", "2026-03-05");
    expect(day(report, "2026-03-04")).toMatchObject({ dau: 1, wau: 2, mau: 2 });
    expect(day(report, "2026-03-05")).toMatchObject({ dau: 1, wau: 2, mau: 2 });

    const db = await getDb();
    const rows = await db.select().from(schema.dailyUsage).where(eq(schema.dailyUsage.userId, bob));
    expect(rows.map((r) => [r.day, r.kind]).sort()).toEqual([["2026-03-04", "edit"], ["2026-03-04", "open"]]);
    expect(Object.keys(rows[0]).sort()).toEqual(["day", "kind", "userId"]);
  });

  it("ignores ids that are not signed-in users", async () => {
    await recordUsage("anon-1234abcd", "edit", new Date("2026-03-04T08:00:00Z"));
    expect(day(await usageReport("2026-03-04", "2026-03-04"), "2026-03-04")?.dau).toBe(1);
  });

  it("records agent token use", async () => {
    const created = await createApiToken(bob, "usage agent");
    await resolveApiToken(created.token);
    const today = usageDay(new Date());
    await expect.poll(async () => {
      const db = await getDb();
      const rows = await db.select().from(schema.dailyUsage).where(eq(schema.dailyUsage.userId, bob));
      return rows.some((r) => r.kind === "agent" && r.day === today);
    }).toBe(true);
  });

  it("reports sign-ups and new documents by UTC day", async () => {
    const report = await usageReport("2026-03-01", "2026-03-04");
    expect(day(report, "2026-03-01")?.newUsers).toBe(1);
    expect(day(report, "2026-03-03")?.newUsers).toBe(1);
    expect(day(report, "2026-03-04")?.newUsers).toBe(0);
    const today = usageDay(new Date());
    expect((await usageReport(today, today))[0].newDocs).toBeGreaterThanOrEqual(1);
  });
});
