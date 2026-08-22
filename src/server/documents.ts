import { and, desc, eq, or, sql } from "drizzle-orm";
import { customAlphabet } from "nanoid";
import { getDb, schema } from "@/server/db";
import type { Document, LinkAccess, Role, StorageKind } from "@/server/db/schema";

const nanoid = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyz", 12);

export interface SessionUser {
  id: string;
  login: string | null;
  name?: string | null;
  image?: string | null;
}

export interface DocumentAccess {
  doc: Document;
  role: Role;
}

export function canEdit(role: Role): boolean {
  return role === "owner" || role === "editor";
}

export function canComment(role: Role): boolean {
  return role !== "viewer";
}

export function isOwner(role: Role): boolean {
  return role === "owner";
}

function roleFromLink(linkAccess: LinkAccess, signedIn: boolean): Role | null {
  switch (linkAccess) {
    case "private":
      return null;
    case "view":
      return "viewer";
    case "comment":
      return signedIn ? "commenter" : "viewer";
    case "edit":
      return signedIn ? "editor" : "viewer";
  }
}

/** Resolve the document and the caller's role, or null if the caller has no access. */
export async function getDocumentAccess(docId: string, user: SessionUser | null): Promise<DocumentAccess | null> {
  const db = await getDb();
  const [doc] = await db.select().from(schema.documents).where(eq(schema.documents.id, docId));
  if (!doc) return null;
  if (user && doc.ownerId === user.id) return { doc, role: "owner" };
  if (user?.login) {
    const [collab] = await db
      .select()
      .from(schema.collaborators)
      .where(and(eq(schema.collaborators.documentId, docId), eq(schema.collaborators.login, user.login.toLowerCase())));
    if (collab) return { doc, role: collab.role };
  }
  const linkRole = roleFromLink(doc.linkAccess, !!user);
  return linkRole ? { doc, role: linkRole } : null;
}

export interface DocumentSummary {
  id: string;
  title: string;
  storage: StorageKind;
  updatedAt: Date;
  createdAt: Date;
  ownerId: string;
  ownerName: string | null;
  ownerLogin: string | null;
  role: Role;
  excerpt: string;
  repoOwner: string | null;
  repoName: string | null;
  repoPath: string | null;
  gistId: string | null;
}

function excerpt(content: string): string {
  return content
    .replace(/^---[\s\S]*?---\s*/m, "")
    .replace(/^#+\s.*$/m, "")
    .replace(/[#*_`>\-\[\]!]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
}

export async function listDocumentsForUser(user: SessionUser): Promise<DocumentSummary[]> {
  const db = await getDb();
  const login = user.login?.toLowerCase() ?? "";
  const rows = await db
    .select({
      doc: schema.documents,
      owner: { name: schema.users.name, login: schema.users.login },
      collabRole: schema.collaborators.role,
    })
    .from(schema.documents)
    .leftJoin(schema.users, eq(schema.users.id, schema.documents.ownerId))
    .leftJoin(
      schema.collaborators,
      and(eq(schema.collaborators.documentId, schema.documents.id), eq(schema.collaborators.login, login)),
    )
    .where(or(eq(schema.documents.ownerId, user.id), sql`${schema.collaborators.login} is not null`))
    .orderBy(desc(schema.documents.updatedAt));
  return rows.map(({ doc, owner, collabRole }) => ({
    id: doc.id,
    title: doc.title,
    storage: doc.storage,
    updatedAt: doc.updatedAt,
    createdAt: doc.createdAt,
    ownerId: doc.ownerId,
    ownerName: owner?.name ?? null,
    ownerLogin: owner?.login ?? null,
    role: doc.ownerId === user.id ? "owner" : (collabRole ?? "viewer"),
    excerpt: excerpt(doc.content),
    repoOwner: doc.repoOwner,
    repoName: doc.repoName,
    repoPath: doc.repoPath,
    gistId: doc.gistId,
  }));
}

export interface CreateDocumentInput {
  ownerId: string;
  title?: string;
  content?: string;
  storage?: StorageKind;
  gistId?: string | null;
  gistFile?: string | null;
  repoOwner?: string | null;
  repoName?: string | null;
  repoBranch?: string | null;
  repoPath?: string | null;
  githubSha?: string | null;
}

export const DEFAULT_CONTENT = `# Untitled

Start writing. Use the toolbar, Markdown shortcuts, or edit the source on the left.
`;

export function titleFromContent(content: string, fallback = "Untitled"): string {
  const m = /^#\s+(.+)$/m.exec(content);
  return m ? m[1].trim().replace(/[*_`]/g, "") : fallback;
}

export async function createDocument(input: CreateDocumentInput): Promise<Document> {
  const db = await getDb();
  const content = input.content ?? DEFAULT_CONTENT;
  const id = nanoid();
  const [doc] = await db
    .insert(schema.documents)
    .values({
      id,
      title: input.title ?? titleFromContent(content),
      ownerId: input.ownerId,
      content,
      storage: input.storage ?? "local",
      gistId: input.gistId ?? null,
      gistFile: input.gistFile ?? null,
      repoOwner: input.repoOwner ?? null,
      repoName: input.repoName ?? null,
      repoBranch: input.repoBranch ?? null,
      repoPath: input.repoPath ?? null,
      githubSha: input.githubSha ?? null,
      publishedContent: input.storage && input.storage !== "local" ? content : null,
      publishedAt: input.storage && input.storage !== "local" ? new Date() : null,
    })
    .returning();
  if (input.storage && input.storage !== "local") {
    await addVersion({ documentId: id, content, kind: "import", createdBy: input.ownerId, title: "Imported from GitHub" });
  }
  return doc;
}

export async function updateDocument(docId: string, patch: Partial<Document>): Promise<Document | null> {
  const db = await getDb();
  const [doc] = await db
    .update(schema.documents)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(schema.documents.id, docId))
    .returning();
  return doc ?? null;
}

export async function deleteDocument(docId: string): Promise<void> {
  const db = await getDb();
  await db.delete(schema.documents).where(eq(schema.documents.id, docId));
}

export interface AddVersionInput {
  documentId: string;
  content: string;
  kind: schema.VersionKind;
  createdBy?: string | null;
  createdByName?: string | null;
  title?: string | null;
  commitSha?: string | null;
}

export async function addVersion(input: AddVersionInput) {
  const db = await getDb();
  const [{ max }] = await db
    .select({ max: sql<number>`coalesce(max(${schema.versions.number}), 0)` })
    .from(schema.versions)
    .where(eq(schema.versions.documentId, input.documentId));
  const [version] = await db
    .insert(schema.versions)
    .values({
      id: nanoid(),
      documentId: input.documentId,
      number: Number(max) + 1,
      content: input.content,
      kind: input.kind,
      createdBy: input.createdBy ?? null,
      createdByName: input.createdByName ?? null,
      title: input.title ?? null,
      commitSha: input.commitSha ?? null,
    })
    .returning();
  return version;
}

export async function listVersions(docId: string) {
  const db = await getDb();
  return db
    .select({
      id: schema.versions.id,
      number: schema.versions.number,
      title: schema.versions.title,
      kind: schema.versions.kind,
      createdBy: schema.versions.createdBy,
      createdByName: schema.versions.createdByName,
      commitSha: schema.versions.commitSha,
      createdAt: schema.versions.createdAt,
      size: sql<number>`length(${schema.versions.content})`,
    })
    .from(schema.versions)
    .where(eq(schema.versions.documentId, docId))
    .orderBy(desc(schema.versions.number));
}

export async function getVersion(docId: string, versionId: string) {
  const db = await getDb();
  const [v] = await db
    .select()
    .from(schema.versions)
    .where(and(eq(schema.versions.documentId, docId), eq(schema.versions.id, versionId)));
  return v ?? null;
}

export async function latestVersion(docId: string) {
  const db = await getDb();
  const [v] = await db
    .select()
    .from(schema.versions)
    .where(eq(schema.versions.documentId, docId))
    .orderBy(desc(schema.versions.number))
    .limit(1);
  return v ?? null;
}

export async function listCollaborators(docId: string) {
  const db = await getDb();
  const rows = await db
    .select({
      login: schema.collaborators.login,
      role: schema.collaborators.role,
      createdAt: schema.collaborators.createdAt,
      name: schema.users.name,
      image: schema.users.image,
    })
    .from(schema.collaborators)
    .leftJoin(schema.users, eq(schema.users.login, schema.collaborators.login))
    .where(eq(schema.collaborators.documentId, docId));
  return rows;
}

export async function upsertCollaborator(docId: string, login: string, role: Exclude<Role, "owner">, addedBy: string) {
  const db = await getDb();
  const normalized = login.trim().toLowerCase().replace(/^@/, "");
  await db
    .insert(schema.collaborators)
    .values({ documentId: docId, login: normalized, role, addedBy })
    .onConflictDoUpdate({
      target: [schema.collaborators.documentId, schema.collaborators.login],
      set: { role },
    });
  return normalized;
}

export async function removeCollaborator(docId: string, login: string) {
  const db = await getDb();
  await db
    .delete(schema.collaborators)
    .where(and(eq(schema.collaborators.documentId, docId), eq(schema.collaborators.login, login.toLowerCase())));
}

export async function getUserById(id: string) {
  const db = await getDb();
  const [u] = await db.select().from(schema.users).where(eq(schema.users.id, id));
  return u ?? null;
}

/** GitHub OAuth access token for a user, or the GITHUB_TOKEN fallback in development. */
export async function getGitHubToken(userId: string): Promise<string | null> {
  const db = await getDb();
  const [account] = await db
    .select({ token: schema.accounts.access_token })
    .from(schema.accounts)
    .where(and(eq(schema.accounts.userId, userId), eq(schema.accounts.provider, "github")));
  if (account?.token) return account.token;
  if (process.env.NODE_ENV !== "production" && process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  return null;
}
