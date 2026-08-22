import { describe, expect, it, beforeAll, vi } from "vitest";

process.env.PGLITE_DATA_DIR = "memory://";
process.env.AUTH_SECRET = "test-secret-test-secret-test-secret";
delete process.env.DATABASE_URL;

// Same stand-ins as export.test.ts: the route resolves the caller through next-auth and
// `next/headers`, neither of which runs outside a Next request.
let actor: { id: string; login: string; name: string; image: null } | null = null;
vi.mock("@/auth", () => ({ auth: async () => (actor ? { user: actor } : null) }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));

const { getDb, schema } = await import("@/server/db");
const { eq } = await import("drizzle-orm");
const getDocument = async (id: string) => (await getDb()).query.documents.findFirst({ where: eq(schema.documents.id, id) });
const { POST } = await import("./route");
const { GET: GET_TEMPLATES } = await import("../templates/route");
const { TEMPLATES } = await import("@/lib/templates");

const post = (body: unknown) => POST(new Request("http://localhost:3700/api/documents", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));

describe("POST /api/documents with a template", () => {
  beforeAll(async () => {
    const db = await getDb();
    const [user] = await db.insert(schema.users).values({ name: "Tina", login: "tina", email: "tina@example.com" }).returning();
    actor = { id: user.id, login: "tina", name: "Tina", image: null };
  });

  it("fills title and content from the template, with placeholders replaced", async () => {
    const res = await post({ template: "meeting-notes" });
    expect(res.status).toBe(201);
    const { document } = (await res.json()) as { document: { id: string; title: string } };
    expect(document.title).toBe("Meeting notes");
    const doc = await getDocument(document.id);
    expect(doc?.content).toContain("# Meeting notes");
    expect(doc?.content).toContain("## Action items");
    expect(doc?.content).toContain("@tina");
    expect(doc?.content).not.toContain("{{");
  });

  it("lets an explicit title or content win over the template", async () => {
    const res = await post({ template: "checklist", title: "Launch checklist" });
    expect(res.status).toBe(201);
    const { document } = (await res.json()) as { document: { id: string; title: string } };
    expect(document.title).toBe("Launch checklist");
    expect((await getDocument(document.id))?.content).toContain("# Checklist");

    const res2 = await post({ template: "checklist", content: "# Mine\n" });
    const body2 = (await res2.json()) as { document: { id: string } };
    expect((await getDocument(body2.document.id))?.content).toBe("# Mine\n");
  });

  it("rejects unknown template ids with 400", async () => {
    const res = await post({ template: "does-not-exist" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/Unknown template/);
  });

  it("still creates a plain document without a template", async () => {
    const res = await post({ title: "Plain" });
    expect(res.status).toBe(201);
    const { document } = (await res.json()) as { document: { id: string } };
    expect((await getDocument(document.id))?.content).toBe("# Plain\n\n");
  });

  it("requires a signed-in caller", async () => {
    const saved = actor;
    actor = null;
    try {
      expect((await post({ template: "blank" })).status).toBe(401);
    } finally {
      actor = saved;
    }
  });
});

describe("GET /api/templates", () => {
  it("lists the eight templates with id, name and description only", async () => {
    const res = await GET_TEMPLATES(new Request("http://localhost:3700/api/templates"));
    expect(res.status).toBe(200);
    const { templates } = (await res.json()) as { templates: { id: string; name: string; description: string }[] };
    expect(templates).toHaveLength(8);
    expect(templates.map((t) => t.id)).toEqual(TEMPLATES.map((t) => t.id));
    for (const t of templates) expect(Object.keys(t).sort()).toEqual(["description", "id", "name"]);
  });
});
