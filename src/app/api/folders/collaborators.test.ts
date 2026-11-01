import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

process.env.PGLITE_DATA_DIR = "memory://";
process.env.AUTH_SECRET = "test-secret-test-secret-test-secret";
process.env.RATE_LIMIT = "off";
delete process.env.DATABASE_URL;

type Actor = { id: string; login: string; name: string; image: null };
let actor: Actor | null = null;
let requestHeaders = new Headers();
vi.mock("@/auth", () => ({ auth: async () => (actor ? { user: actor } : null) }));
vi.mock("next/headers", () => ({ headers: async () => requestHeaders }));
vi.mock("@/server/session-cookie", () => ({ decodeEmbedSession: async () => null }));

const { getDb, schema } = await import("@/server/db");
const { createDocument } = await import("@/server/documents");
const { addFolderCollaborator, createFolder, moveDocumentsToFolder } = await import("@/server/folders");
const { createApiToken } = await import("@/server/tokens");
const { DELETE, GET, POST } = await import("./[id]/collaborators/route");

let sequence = 0;
async function makeUser(): Promise<Actor> {
  const login = `folder-share-${++sequence}`;
  const db = await getDb();
  const [row] = await db.insert(schema.users).values({ login, name: "Person", email: `${login}@example.com` }).returning();
  return { id: row.id, login: row.login!, name: row.name!, image: null };
}

async function makeFolder(ownerId: string): Promise<string> {
  const result = await createFolder(ownerId, `Folder ${++sequence}`);
  if (result.outcome !== "ok") throw new Error("folder not created");
  return result.folder.id;
}

const params = (id: string) => ({ params: Promise.resolve({ id }) });
const getCollaborators = (id: string) =>
  GET(new Request(`http://localhost:3700/api/folders/${id}/collaborators`), params(id));
const addCollaborator = (id: string, login: string, role = "viewer") =>
  POST(
    new Request(`http://localhost:3700/api/folders/${id}/collaborators`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ login, role }),
    }),
    params(id),
  );
const removeCollaborator = (id: string, login: string) =>
  DELETE(
    new Request(`http://localhost:3700/api/folders/${id}/collaborators`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ login }),
    }),
    params(id),
  );

beforeEach(() => {
  actor = null;
  requestHeaders = new Headers();
});

describe("folder collaborator routes", () => {
  it("allows an owner to share, list, and remove a folder collaborator", async () => {
    actor = await makeUser();
    const person = await makeUser();
    const folderId = await makeFolder(actor.id);

    const added = await addCollaborator(folderId, person.login, "commenter");
    expect(added.status).toBe(200);
    expect(await added.json()).toMatchObject({ login: person.login, role: "commenter", pending: false });
    const listed = await getCollaborators(folderId);
    expect(listed.status).toBe(200);
    expect(await listed.json()).toMatchObject({
      collaborators: [{ login: person.login, role: "commenter" }],
    });

    expect((await removeCollaborator(folderId, person.login)).status).toBe(200);
    const afterRemoval = await getCollaborators(folderId);
    expect(await afterRemoval.json()).toMatchObject({ collaborators: [] });
  });

  it("blocks a document-restricted token from reading or changing folder-wide shares", async () => {
    const owner = await makeUser();
    const existing = await makeUser();
    const added = await makeUser();
    const folderId = await makeFolder(owner.id);
    const included = await createDocument({ ownerId: owner.id, title: "Included" });
    const outsideTokenScope = await createDocument({ ownerId: owner.id, title: "Outside token scope" });
    await moveDocumentsToFolder([included.id, outsideTokenScope.id], folderId, owner.id);
    await addFolderCollaborator(folderId, existing.login, "viewer", owner.id);

    const token = (await createApiToken(owner.id, "One document only", { documentIds: [included.id] })).token;
    requestHeaders = new Headers({ authorization: `Bearer ${token}` });
    const read = await getCollaborators(folderId);
    const share = await addCollaborator(folderId, added.login);
    const remove = await removeCollaborator(folderId, existing.login);

    for (const response of [read, share, remove]) {
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ error: "This token is restricted to other documents" });
    }
    const db = await getDb();
    const shares = await db.select().from(schema.folderCollaborators).where(eq(schema.folderCollaborators.folderId, folderId));
    expect(shares).toContainEqual(expect.objectContaining({ login: existing.login, role: "viewer" }));
    expect(shares.some((share) => share.login === added.login)).toBe(false);
  });
});
