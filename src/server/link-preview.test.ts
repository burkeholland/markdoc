import { beforeAll, describe, expect, it, vi } from "vitest";

process.env.PGLITE_DATA_DIR = "memory://";
process.env.AUTH_SECRET = "test-secret-test-secret-test-secret";
delete process.env.DATABASE_URL;

// Route tests resolve the caller through next-auth and `next/headers` (same stand-ins as trash-copy.test.ts).
type Actor = { id: string; login: string; name: string; image: null };
let actor: Actor | null = null;
vi.mock("@/auth", () => ({ auth: async () => (actor ? { user: actor } : null) }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
// Drawing the PNG is document-card.test.ts's business; here only whether a card is drawn, and from what.
vi.mock("@/server/og/document-card", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/og/document-card")>()),
  renderDocumentCard: vi.fn(async () => new Response("card", { headers: { "content-type": "image/png" } })),
}));
vi.mock("@/components/ui/logo", () => ({ Logo: () => null }));

const { getDb, schema } = await import("@/server/db");
const { eq } = await import("drizzle-orm");
const { createDocument, deleteDocument, getLinkPreviewDocument, updateDocument, upsertCollaborator } = await import("@/server/documents");
const { renderDocumentCard } = await import("@/server/og/document-card");
const { documentCardImage } = await import("@/server/og/document-card-route");
const { PATCH } = await import("../app/api/documents/[id]/route");
const { generateMetadata: signInMetadata } = await import("../app/login/page");

let owner: Actor;
let editor: Actor;
let stranger: Actor;

const params = (id: string) => ({ params: Promise.resolve({ id }) });
const as = async <T>(who: Actor | null, fn: () => Promise<T>) => {
  const saved = actor;
  actor = who;
  try {
    return await fn();
  } finally {
    actor = saved;
  }
};
const patch = (id: string, body: unknown) =>
  PATCH(new Request(`http://localhost:3700/api/documents/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), params(id));
const row = async (id: string) => {
  const db = await getDb();
  const [stored] = await db.select().from(schema.documents).where(eq(schema.documents.id, id));
  return stored;
};
/** The metadata of `/login?next=<next>`: where an unfurler lands after a restricted document sent it to sign in. */
const signInPage = (next: string) => signInMetadata({ params: Promise.resolve({}), searchParams: Promise.resolve({ next }) });
/** The sign-in page's own metadata: what it says when it has no document card to carry. */
const SIGN_IN_ONLY = { title: "Sign in", description: "Sign in to Markdoc, the collaborative Markdown editor for people and AI agents." };
const card = (id: string) => documentCardImage(params(id));
const NOT_FOUND = { digest: "NEXT_HTTP_ERROR_FALLBACK;404" };

const SECRET = "the-part-after-the-excerpt";
const LONG_BODY = `# Board memo\n\n${"We are planning the launch carefully. ".repeat(8)}\n\n${SECRET}\n`;

/** A restricted document (the default) owned by `owner`, with `editor` added as an editor. */
async function restrictedDocument(title = "Board memo", content = LONG_BODY) {
  const doc = await createDocument({ ownerId: owner.id, title, content });
  await upsertCollaborator(doc.id, editor.login, "editor", owner.id);
  return doc;
}

beforeAll(async () => {
  const db = await getDb();
  const users = await db
    .insert(schema.users)
    .values([
      { name: "Olive", login: "olive", email: "olive-preview@example.com" },
      { name: "Eddie", login: "eddie", email: "eddie-preview@example.com" },
      { name: "Sam", login: "sam", email: "sam-preview@example.com" },
    ])
    .returning();
  [owner, editor, stranger] = users.map((u) => ({ id: u.id, login: u.login!, name: u.name!, image: null }));
});

describe("PATCH /api/documents/:id { linkPreview }", () => {
  it("lets the owner turn link previews on and off, and answers with the setting", async () => {
    const doc = await restrictedDocument();
    expect((await row(doc.id)).linkPreview).toBe(false);

    const on = await as(owner, () => patch(doc.id, { linkPreview: true }));
    expect(on.status).toBe(200);
    expect(((await on.json()) as { document: { linkPreview: boolean; linkAccess: string } }).document).toMatchObject({ linkPreview: true, linkAccess: "private" });
    expect((await row(doc.id)).linkPreview).toBe(true);

    const off = await as(owner, () => patch(doc.id, { linkPreview: false }));
    expect(((await off.json()) as { document: { linkPreview: boolean } }).document.linkPreview).toBe(false);
    expect((await row(doc.id)).linkPreview).toBe(false);
  });

  it("changes nothing when the setting is already the one sent", async () => {
    const doc = await restrictedDocument();
    const before = (await row(doc.id)).updatedAt;
    const res = await as(owner, () => patch(doc.id, { linkPreview: false }));
    expect(res.status).toBe(200);
    expect((await row(doc.id)).updatedAt).toEqual(before);
  });

  it("is the owner's alone: an editor gets 403, a signed-out caller 401, and the setting stands", async () => {
    const doc = await restrictedDocument();
    expect((await as(editor, () => patch(doc.id, { linkPreview: true }))).status).toBe(403);
    expect((await as(null, () => patch(doc.id, { linkPreview: true }))).status).toBe(401);
    expect((await as(stranger, () => patch(doc.id, { linkPreview: true }))).status).toBe(404);
    expect((await row(doc.id)).linkPreview).toBe(false);
  });

  it("refuses a value that is not a boolean", async () => {
    const doc = await restrictedDocument();
    expect((await as(owner, () => patch(doc.id, { linkPreview: "yes" }))).status).toBe(400);
    expect((await row(doc.id)).linkPreview).toBe(false);
  });

  it("can be sent together with linkAccess", async () => {
    const doc = await restrictedDocument();
    const res = await as(owner, () => patch(doc.id, { linkAccess: "view", linkPreview: true }));
    expect(res.status).toBe(200);
    expect(await row(doc.id)).toMatchObject({ linkAccess: "view", linkPreview: true });
  });
});

describe("getLinkPreviewDocument", () => {
  it("finds a restricted document only once its owner turned link previews on", async () => {
    const doc = await restrictedDocument();
    expect(await getLinkPreviewDocument(doc.id)).toBeNull();
    await updateDocument(doc.id, { linkPreview: true });
    expect(await getLinkPreviewDocument(doc.id)).toMatchObject({ id: doc.id, title: "Board memo", ownerId: owner.id });
  });

  it("always finds a link-shared document: anyone with the link can read it anyway", async () => {
    const doc = await restrictedDocument();
    await updateDocument(doc.id, { linkAccess: "view" });
    expect(await getLinkPreviewDocument(doc.id)).toMatchObject({ id: doc.id });
  });

  it("never finds a document in the trash, or an id that does not exist", async () => {
    const doc = await restrictedDocument();
    await updateDocument(doc.id, { linkPreview: true });
    await deleteDocument(doc.id);
    expect(await getLinkPreviewDocument(doc.id)).toBeNull();
    expect(await getLinkPreviewDocument("nosuchdocid0")).toBeNull();
  });
});

describe("the sign-in page a restricted document sends an unfurler to", () => {
  it("keeps the generic card, and says nothing about the document, while link previews are off", async () => {
    const doc = await restrictedDocument();
    const meta = await signInPage(`/d/${doc.id}`);
    expect(meta).toEqual(SIGN_IN_ONLY);
    expect(JSON.stringify(meta)).not.toContain("Board memo");
  });

  it("carries the document's title, first lines and card image once they are on, and no more of its text", async () => {
    const doc = await restrictedDocument();
    await as(owner, () => patch(doc.id, { linkPreview: true }));
    const meta = await signInPage(`/d/${doc.id}`);
    expect(meta).toMatchObject({
      title: "Sign in",
      description: expect.stringMatching(/^We are planning the launch carefully\./),
      robots: { index: false },
      openGraph: {
        type: "article",
        title: "Board memo",
        description: expect.stringMatching(/^We are planning the launch carefully\./),
        url: `/d/${doc.id}`,
        images: [{ url: `/d/${doc.id}/opengraph-image`, width: 1200, height: 630 }],
      },
      twitter: { card: "summary_large_image", title: "Board memo", images: [{ url: `/d/${doc.id}/opengraph-image` }] },
    });
    expect(meta.openGraph?.description?.length).toBeLessThanOrEqual(160);
    expect(JSON.stringify(meta)).not.toContain(SECRET);
  });

  it("names the reader page when that is where the sign-in returns to", async () => {
    const doc = await restrictedDocument();
    await updateDocument(doc.id, { linkPreview: true });
    expect((await signInPage(`/p/${doc.id}?from=slack`)).openGraph).toMatchObject({ url: `/p/${doc.id}`, images: [{ url: `/p/${doc.id}/opengraph-image` }] });
  });

  it("ignores a return path that is not a safe local document page", async () => {
    const doc = await restrictedDocument();
    await updateDocument(doc.id, { linkPreview: true });
    expect(await signInPage(`//evil.example/d/${doc.id}`)).toEqual(SIGN_IN_ONLY);
    expect(await signInPage(`/settings?d=${doc.id}`)).toEqual(SIGN_IN_ONLY);
  });

  it("keeps the generic card for a document in the trash", async () => {
    const doc = await restrictedDocument();
    await updateDocument(doc.id, { linkPreview: true });
    await deleteDocument(doc.id);
    expect(await signInPage(`/d/${doc.id}`)).toEqual(SIGN_IN_ONLY);
  });
});

describe("the card image (opengraph-image of /d/<id> and /p/<id>)", () => {
  it("answers 404 to a signed-out unfurler and a signed-in stranger while link previews are off", async () => {
    const doc = await restrictedDocument();
    vi.mocked(renderDocumentCard).mockClear();
    await expect(as(null, () => card(doc.id))).rejects.toMatchObject(NOT_FOUND);
    await expect(as(stranger, () => card(doc.id))).rejects.toMatchObject(NOT_FOUND);
    expect(renderDocumentCard).not.toHaveBeenCalled();
  });

  it("is drawn for anyone once link previews are on: the document's title, its owner and when it changed", async () => {
    const doc = await restrictedDocument();
    await updateDocument(doc.id, { linkPreview: true });
    vi.mocked(renderDocumentCard).mockClear();
    const res = await as(null, () => card(doc.id));
    expect(res.status).toBe(200);
    // What the Share dialog says a preview shows, and nothing else: no reading time, never stored.
    expect(renderDocumentCard).toHaveBeenCalledWith(
      { title: "Board memo", ownerName: "Olive", readingMinutes: 0, updatedAt: (await row(doc.id)).updatedAt },
      { cacheControl: "private, no-store" },
    );
    expect((await as(stranger, () => card(doc.id))).status).toBe(200);
  });

  it("is always drawn for the people with access", async () => {
    const doc = await restrictedDocument();
    expect((await as(owner, () => card(doc.id))).status).toBe(200);
    expect((await as(editor, () => card(doc.id))).status).toBe(200);
  });

  it("is the same restricted card, never stored, when the owner asks for it", async () => {
    const doc = await restrictedDocument();
    vi.mocked(renderDocumentCard).mockClear();
    await as(owner, () => card(doc.id));
    expect(renderDocumentCard).toHaveBeenCalledWith(expect.objectContaining({ readingMinutes: 0 }), { cacheControl: "private, no-store" });
  });

  it("keeps the reading time and the five-minute cache for a link-shared document", async () => {
    const doc = await restrictedDocument();
    await updateDocument(doc.id, { linkAccess: "view" });
    vi.mocked(renderDocumentCard).mockClear();
    await as(null, () => card(doc.id));
    expect(renderDocumentCard).toHaveBeenCalledWith(expect.objectContaining({ title: "Board memo", readingMinutes: 1 }), { cacheControl: "public, max-age=300" });
  });

  it("answers 404 for a document in the trash even with link previews on", async () => {
    const doc = await restrictedDocument();
    await updateDocument(doc.id, { linkPreview: true });
    await deleteDocument(doc.id);
    await expect(as(null, () => card(doc.id))).rejects.toMatchObject(NOT_FOUND);
  });
});
