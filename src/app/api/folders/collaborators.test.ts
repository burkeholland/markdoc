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
const { GET: GET_FOLDER, PATCH: PATCH_FOLDER } = await import("./[id]/route");
const { GET: LIST_FOLDERS, POST: CREATE_FOLDER } = await import("./route");
const { GET: PREVIEW } = await import("./[id]/access-preview/route");
const { POST: REQUEST_ACCESS } = await import("./[id]/access-request/route");
const { GET: NOTIFICATIONS } = await import("@/app/api/notifications/route");
const { markNotificationRead, notificationBelongsTo, markAllNotificationsRead, notify, listNotifications } = await import("@/server/notifications");
const { getFolderAccess, setFolderLinkAccess } = await import("@/server/folders");

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
  it("permits anonymous named link reads, but never sharing details or non-owner mutations", async () => {
    const owner = await makeUser();
    const other = await makeUser();
    const id = await makeFolder(owner.id);
    const document = await createDocument({ ownerId: owner.id, title: "Public folder document" });
    await moveDocumentsToFolder([document.id], id, owner.id);
    await setFolderLinkAccess(id, owner.id, "edit");
    actor = null;
    const result = await GET_FOLDER(new Request(`http://localhost:3700/api/folders/${id}`), params(id));
    expect(await result.json()).toMatchObject({ folder: { id, role: "viewer", linkAccess: "edit" }, documents: [{ id: document.id, role: "viewer" }] });
    expect((await getCollaborators(id)).status).toBe(401);
    actor = other;
    expect((await getCollaborators(id)).status).toBe(404);
    expect((await PREVIEW(new Request(`http://localhost:3700/api/folders/${id}/access-preview?login=${other.login}&role=viewer`), params(id))).status).toBe(404);
    const patch = () => PATCH_FOLDER(new Request(`http://localhost:3700/api/folders/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ linkAccess: "private" }) }), params(id));
    expect((await patch()).status).toBe(404);
    actor = owner;
    expect((await patch()).status).toBe(200);
    actor = other;
    expect((await GET_FOLDER(new Request(`http://localhost:3700/api/folders/${id}`), params(id))).status).toBe(404);
  });

  it("previews higher direct and link access without granting it, and refuses combined partial-write operations", async () => {
    actor = await makeUser();
    const person = await makeUser();
    const id = await makeFolder(actor.id);
    const document = await createDocument({ ownerId: actor.id, title: "Private budget" });
    await moveDocumentsToFolder([document.id], id, actor.id);
    const db = await getDb();
    await db.insert(schema.collaborators).values({ documentId: document.id, login: person.login, role: "editor" });
    const result = await PREVIEW(new Request(`http://localhost:3700/api/folders/${id}/access-preview?login=${person.login}&role=viewer`), params(id));
    expect(result.headers.get("Cache-Control")).toBe("no-store");
    expect(await result.json()).toMatchObject({ exceptions: [{ documentId: document.id, documentTitle: "Private budget", role: "editor", source: "collaborator" }] });
    expect(await getFolderAccess(id, person)).toBeNull();
    const invalid = await PATCH_FOLDER(new Request(`http://localhost:3700/api/folders/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Other", linkAccess: "edit" }) }), params(id));
    expect(invalid.status).toBe(400);
    expect(await getFolderAccess(id, null)).toBeNull();
    await addCollaborator(id, person.login, "viewer");
    expect(await (await getCollaborators(id)).json()).toMatchObject({ exceptions: { [person.login]: [{ documentId: document.id, role: "editor" }] } });
  });

  it("requests folder access without enumeration, targets its named Share pane, and does not grant on opening or reading", async () => {
    const owner = await makeUser();
    const requester = await makeUser();
    const id = await makeFolder(owner.id);
    actor = requester;
    for (const target of [id, id, "does-not-exist"]) {
      const response = await REQUEST_ACCESS(new Request(`http://localhost:3700/api/folders/${target}/access-request`, { method: "POST" }), params(target));
      expect(response.status).toBe(202);
      expect(await response.json()).toEqual({ requested: true });
    }
    actor = owner;
    const response = await NOTIFICATIONS(new Request("http://localhost:3700/api/notifications"));
    const { items, unreadCount } = await response.json();
    expect(unreadCount).toBe(1);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ resource: "folder", folderId: id, documentId: null, kind: "access.request", actorLogin: requester.login });
    expect(items[0].folderName).toBeTruthy();
    expect(await getFolderAccess(id, requester)).toBeNull();
    expect(await notificationBelongsTo(items[0].id, requester.login)).toBe(false);
    expect(await notificationBelongsTo(items[0].id, owner.login, ["one-document"])).toBe(false);
    expect(await markNotificationRead(items[0].id, owner.login, ["one-document"])).toBe(false);
    expect(await markNotificationRead(items[0].id, owner.login)).toBe(true);
    expect(await getFolderAccess(id, requester)).toBeNull();
  });

  it("combines folder and document unread/read-all operations and hides revoked folder notifications", async () => {
    const owner = await makeUser();
    const requester = await makeUser();
    const id = await makeFolder(owner.id);
    const document = await createDocument({ ownerId: owner.id, title: "Mixed notifications" });
    actor = requester;
    await REQUEST_ACCESS(new Request(`http://localhost:3700/api/folders/${id}/access-request`, { method: "POST" }), params(id));
    await notify({ documentId: document.id, userLogin: owner.login, kind: "share", actorLogin: requester.login, refId: `${document.id}:${owner.login}` });
    expect((await listNotifications(owner.login)).unreadCount).toBe(2);
    expect(await markAllNotificationsRead(owner.login, [document.id])).toBe(1);
    expect((await listNotifications(owner.login)).unreadCount).toBe(1);
    expect(await markAllNotificationsRead(owner.login)).toBe(1);
    expect((await listNotifications(owner.login)).unreadCount).toBe(0);
    actor = owner;
    await addCollaborator(id, requester.login, "viewer");
    expect((await listNotifications(requester.login)).items).toContainEqual(expect.objectContaining({ resource: "folder", folderId: id, kind: "share" }));
    await removeCollaborator(id, requester.login);
    expect(await listNotifications(requester.login)).toMatchObject({ items: [], unreadCount: 0 });
  });

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
    const folderRead = await GET_FOLDER(new Request(`http://localhost:3700/api/folders/${folderId}`), params(folderId));
    const preview = await PREVIEW(new Request(`http://localhost:3700/api/folders/${folderId}/access-preview?login=${added.login}&role=viewer`), params(folderId));
    const linkChange = await PATCH_FOLDER(new Request(`http://localhost:3700/api/folders/${folderId}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ linkAccess: "edit" }) }), params(folderId));
    const folderList = await LIST_FOLDERS();
    const folderCreate = await CREATE_FOLDER(new Request("http://localhost:3700/api/folders", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Outside document scope" }) }));

    for (const response of [read, share, remove, folderRead, preview, linkChange, folderList, folderCreate]) {
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ error: "This token is restricted to other documents" });
    }
    const db = await getDb();
    const shares = await db.select().from(schema.folderCollaborators).where(eq(schema.folderCollaborators.folderId, folderId));
    expect(shares).toContainEqual(expect.objectContaining({ login: existing.login, role: "viewer" }));
    expect(shares.some((share) => share.login === added.login)).toBe(false);
  });
});
