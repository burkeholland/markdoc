import { and, desc, eq, ilike, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import { customAlphabet } from "nanoid";
import { getDb, schema } from "@/server/db";
import type { Document, LinkAccess, Role, StorageKind } from "@/server/db/schema";
import { encodeSeedState } from "@/server/collab/seed";
import { boundTitle } from "@/server/document-title";
import { excerptOf } from "@/editor/stats";

export { DOCUMENT_TITLE_MAX, boundTitle } from "@/server/document-title";

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

export interface AccessOptions {
  /** Also resolve documents that are in the trash (owner-only trash routes). */
  allowDeleted?: boolean;
}

/**
 * Resolve the document and the caller's role, or null if the caller has no access.
 * Documents in the trash resolve as "not found" unless `allowDeleted` is set.
 */
export async function getDocumentAccess(docId: string, user: SessionUser | null, { allowDeleted = false }: AccessOptions = {}): Promise<DocumentAccess | null> {
  const db = await getDb();
  const [doc] = await db.select().from(schema.documents).where(eq(schema.documents.id, docId));
  if (!doc) return null;
  if (doc.deletedAt && !allowDeleted) return null;
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
  /** Whether the current user has starred this document. */
  starred: boolean;
  /** When the current user last opened this document, or null if never. */
  lastOpenedAt: Date | null;
  /** When the document was moved to the trash; null for live documents. */
  deletedAt: Date | null;
}

/** The card excerpt: the document's first prose, Markdown removed (see `excerptOf`). */
export function excerpt(content: string): string {
  return excerptOf(content, 160);
}

interface VisibleRow {
  doc: Document;
  owner: { name: string | null; login: string | null } | null;
  collabRole: Role | null;
  starred: boolean | null;
  lastOpenedAt: Date | null;
}

/**
 * Documents the user owns or is listed as a collaborator on, with the owner, the user's collaborator
 * role, their star and their last-opened time joined in.
 */
function visibleDocuments(db: Awaited<ReturnType<typeof getDb>>, user: SessionUser) {
  const login = user.login?.toLowerCase() ?? "";
  const query = db
    .select({
      doc: schema.documents,
      owner: { name: schema.users.name, login: schema.users.login },
      collabRole: schema.collaborators.role,
      starred: schema.stars.starred,
      lastOpenedAt: schema.recents.openedAt,
    })
    .from(schema.documents)
    .leftJoin(schema.users, eq(schema.users.id, schema.documents.ownerId))
    .leftJoin(
      schema.collaborators,
      and(eq(schema.collaborators.documentId, schema.documents.id), eq(schema.collaborators.login, login)),
    )
    .leftJoin(schema.stars, and(eq(schema.stars.documentId, schema.documents.id), eq(schema.stars.userId, user.id)))
    .leftJoin(schema.recents, and(eq(schema.recents.documentId, schema.documents.id), eq(schema.recents.userId, user.id)));
  const visible = and(or(eq(schema.documents.ownerId, user.id), sql`${schema.collaborators.login} is not null`), isNull(schema.documents.deletedAt))!;
  const starredOnly = eq(schema.stars.starred, true);
  return { query, visible, starredOnly };
}

function toSummary({ doc, owner, collabRole, starred, lastOpenedAt }: VisibleRow, user: SessionUser): DocumentSummary {
  return {
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
    starred: starred === true,
    lastOpenedAt: lastOpenedAt ?? null,
    deletedAt: doc.deletedAt ?? null,
  };
}

export interface ListDocumentsOptions {
  /** Only documents the user has starred. */
  starred?: boolean;
}

/** Most recently opened first; documents the user never opened follow, most recently edited first. */
export async function listDocumentsForUser(user: SessionUser, { starred }: ListDocumentsOptions = {}): Promise<DocumentSummary[]> {
  const db = await getDb();
  const { query, visible, starredOnly } = visibleDocuments(db, user);
  const rows = await query
    .where(starred ? and(visible, starredOnly) : visible)
    .orderBy(sql`${schema.recents.openedAt} desc nulls last`, desc(schema.documents.updatedAt));
  return rows.map((row) => toSummary(row, user));
}

/** The caller's own documents that are in the trash, most recently trashed first. */
export async function listTrashForUser(user: SessionUser): Promise<DocumentSummary[]> {
  const db = await getDb();
  const { query } = visibleDocuments(db, user);
  const rows = await query
    .where(and(eq(schema.documents.ownerId, user.id), isNotNull(schema.documents.deletedAt)))
    .orderBy(desc(schema.documents.deletedAt));
  return rows.map((row) => toSummary(row, user));
}

export async function starDocument(userId: string, docId: string): Promise<void> {
  const db = await getDb();
  await db
    .insert(schema.stars)
    .values({ documentId: docId, userId, starred: true })
    .onConflictDoUpdate({ target: [schema.stars.documentId, schema.stars.userId], set: { starred: true } });
}

export async function unstarDocument(userId: string, docId: string): Promise<void> {
  const db = await getDb();
  await db.delete(schema.stars).where(and(eq(schema.stars.documentId, docId), eq(schema.stars.userId, userId)));
}

export async function isStarred(userId: string, docId: string): Promise<boolean> {
  const db = await getDb();
  const [row] = await db
    .select({ starred: schema.stars.starred })
    .from(schema.stars)
    .where(and(eq(schema.stars.documentId, docId), eq(schema.stars.userId, userId)));
  return row?.starred === true;
}

/** Remember that the user opened the document just now (upsert; one row per user and document). */
export async function recordDocumentOpen(userId: string, docId: string, at = new Date()): Promise<void> {
  const db = await getDb();
  await db
    .insert(schema.recents)
    .values({ userId, documentId: docId, openedAt: at })
    .onConflictDoUpdate({ target: [schema.recents.userId, schema.recents.documentId], set: { openedAt: at } });
}

export interface SearchResult extends DocumentSummary {
  /** Plain text around the first content match, or null when only the title matched. */
  snippet: string | null;
}

const SNIPPET_BEFORE = 50;
const SNIPPET_LENGTH = 120;

/** ~120 characters of whitespace-collapsed content around the first case-insensitive match of `needle`, or null. */
export function contentSnippet(content: string, needle: string): string | null {
  const flat = content.replace(/\s+/g, " ").trim();
  const idx = flat.search(new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
  if (idx < 0) return null;
  let start = Math.max(0, idx - SNIPPET_BEFORE);
  let end = Math.min(flat.length, start + SNIPPET_LENGTH);
  if (end - start < SNIPPET_LENGTH) start = Math.max(0, end - SNIPPET_LENGTH);
  // Avoid cutting words where we can, but never cut into the match itself.
  if (start > 0) {
    const space = flat.indexOf(" ", start);
    if (space >= 0 && space < idx) start = space + 1;
  }
  if (end < flat.length) {
    const space = flat.lastIndexOf(" ", end);
    if (space > idx + needle.length) end = space;
  }
  const text = flat.slice(start, end).trim();
  return `${start > 0 ? "…" : ""}${text}${end < flat.length ? "…" : ""}`;
}

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * Case-insensitive substring search over title and content of the documents the user can see.
 * Title matches rank first, then content matches, each by most recently updated.
 */
export async function searchDocumentsForUser(user: SessionUser, q: string, { limit = 20 }: { limit?: number } = {}): Promise<SearchResult[]> {
  const needle = q.trim();
  if (needle.length < 2) return [];
  const db = await getDb();
  const pattern = `%${escapeLike(needle)}%`;
  const titleMatch = ilike(schema.documents.title, pattern);
  const { query, visible } = visibleDocuments(db, user);
  const rows = await query
    .where(and(visible, or(titleMatch, ilike(schema.documents.content, pattern))))
    .orderBy(sql`case when ${titleMatch} then 0 else 1 end`, desc(schema.documents.updatedAt))
    .limit(limit);
  return rows.map((row) => ({ ...toSummary(row, user), snippet: contentSnippet(row.doc.content, needle) }));
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

/** First `# ` heading with inline markup stripped, else `fallback`; clipped to {@link DOCUMENT_TITLE_MAX}. */
export function titleFromContent(content: string, fallback = "Untitled"): string {
  const m = /^#\s+(.+)$/m.exec(content);
  return boundTitle(m ? m[1].trim().replace(/[*_`]/g, "") : fallback);
}

export async function createDocument(input: CreateDocumentInput): Promise<Document> {
  const db = await getDb();
  const content = input.content ?? DEFAULT_CONTENT;
  const id = nanoid();
  // Every path that mints a title (API, file/text/HTML import, GitHub import) ends here, so the bound is enforced once.
  const title = boundTitle(input.title ?? titleFromContent(content));
  const [doc] = await db
    .insert(schema.documents)
    .values({
      id,
      title,
      ownerId: input.ownerId,
      content,
      // Mint the CRDT state once, here, so no load ever has to seed it (see collab/seed.ts).
      ystate: encodeSeedState(content, title),
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

/**
 * Patch document metadata. Refuses a `content` write that does not also carry `ystate`:
 * `ystate` is authoritative (see collab/seed.ts), so a content-only write would be silently
 * ignored by every editor. Use {@link setDocumentText} for a never-opened document or
 * `replaceLiveText` (livedoc.ts) for one that may have editors connected.
 */
export async function updateDocument(docId: string, patch: Partial<Document>): Promise<Document | null> {
  if ("content" in patch && !("ystate" in patch)) {
    throw new Error("updateDocument: `content` must be written together with `ystate` — use setDocumentText or replaceLiveText");
  }
  const db = await getDb();
  if (typeof patch.title === "string") patch = { ...patch, title: boundTitle(patch.title) };
  const [doc] = await db
    .update(schema.documents)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(schema.documents.id, docId))
    .returning();
  return doc ?? null;
}

/**
 * Replace a document's text, writing `content` and a freshly minted `ystate` seed together.
 * Only for documents nobody can have open yet (e.g. mid-import): a fresh seed discards the
 * CRDT history, so a connected editor holding the old state would see the text doubled.
 * For live documents use `replaceLiveText` in livedoc.ts instead.
 */
export async function setDocumentText(docId: string, content: string): Promise<Document | null> {
  const db = await getDb();
  const [current] = await db.select({ title: schema.documents.title }).from(schema.documents).where(eq(schema.documents.id, docId));
  if (!current) return null;
  const [doc] = await db
    .update(schema.documents)
    .set({ content, ystate: encodeSeedState(content, current.title), updatedAt: new Date() })
    .where(eq(schema.documents.id, docId))
    .returning();
  return doc ?? null;
}

/** Days a document stays in the trash before {@link purgeTrashOlderThan} removes it for good. */
export const TRASH_RETENTION_DAYS = 30;

/**
 * Move a document to the trash (soft delete). Connected editors are told and disconnected;
 * the document disappears from lists, search and access checks until {@link restoreDocument}.
 */
export async function deleteDocument(docId: string, at = new Date()): Promise<void> {
  const db = await getDb();
  await db.update(schema.documents).set({ deletedAt: at }).where(and(eq(schema.documents.id, docId), isNull(schema.documents.deletedAt)));
  // Lazy import: livedoc → hocuspocus → documents would otherwise be a static import cycle.
  const { evictLiveDocument } = await import("@/server/livedoc");
  await evictLiveDocument(docId, "trashed");
}

/** Take a document out of the trash. No-op for live documents. */
export async function restoreDocument(docId: string): Promise<Document | null> {
  const db = await getDb();
  const [doc] = await db.update(schema.documents).set({ deletedAt: null }).where(eq(schema.documents.id, docId)).returning();
  return doc ?? null;
}

/** Remove a document and everything attached to it (versions, assets, comments metadata) for good. */
export async function purgeDocument(docId: string): Promise<void> {
  const db = await getDb();
  const { evictLiveDocument } = await import("@/server/livedoc");
  await evictLiveDocument(docId, "trashed");
  await db.delete(schema.documents).where(eq(schema.documents.id, docId));
}

/** Purge documents that have been in the trash longer than `days`. Returns how many were removed. */
export async function purgeTrashOlderThan(days = TRASH_RETENTION_DAYS, now = new Date()): Promise<number> {
  const db = await getDb();
  const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  const rows = await db
    .delete(schema.documents)
    .where(and(isNotNull(schema.documents.deletedAt), lt(schema.documents.deletedAt, cutoff)))
    .returning();
  return rows.length;
}

const ASSET_URL_RE = /\/api\/assets\/([0-9a-z]+)/g;

/**
 * Create a copy of a document owned by `userId`: "Copy of <title>", the current clean text (pending
 * suggestions dropped, comments not carried over), always stored in Markdoc regardless of the source,
 * no collaborators. Assets referenced in the text are copied (new rows, same bytes) and their URLs rewritten.
 */
export interface DuplicateOptions {
  /** Text for the copy instead of the current live text (e.g. a past version's content). */
  content?: string;
  /** Appended to the "Copy of <title>" title, e.g. " (v12)". */
  titleSuffix?: string;
  /** Title of the copy's first version (default "Copied from <title>"). */
  versionTitle?: string;
}

export async function duplicateDocument(docId: string, userId: string, options: DuplicateOptions = {}): Promise<Document> {
  const db = await getDb();
  const [source] = await db.select().from(schema.documents).where(eq(schema.documents.id, docId));
  if (!source) throw new Error("Document not found");
  const { readLiveText } = await import("@/server/livedoc");
  const live = await readLiveText(docId);
  const sourceTitle = live.title || source.title;
  const title = boundTitle(`Copy of ${sourceTitle}${options.titleSuffix ?? ""}`);
  const newId = nanoid();
  const text = options.content ?? live.clean;

  const referenced = new Set(Array.from(text.matchAll(ASSET_URL_RE), (m) => m[1]));
  const assets = referenced.size > 0 ? (await db.select().from(schema.assets).where(eq(schema.assets.documentId, docId))).filter((a) => referenced.has(a.id)) : [];
  const idMap = new Map(assets.map((a) => [a.id, assetNanoid()]));
  const content = text.replace(ASSET_URL_RE, (m, id: string) => (idMap.has(id) ? `/api/assets/${idMap.get(id)}` : m));

  const [doc] = await db
    .insert(schema.documents)
    .values({ id: newId, title, ownerId: userId, content, ystate: encodeSeedState(content, title), storage: "local", lastEditedBy: userId })
    .returning();
  if (assets.length > 0) {
    await db
      .insert(schema.assets)
      .values(assets.map((a) => ({ id: idMap.get(a.id)!, documentId: newId, userId, name: a.name, mime: a.mime, size: a.size, sha256: a.sha256, data: a.data })));
  }
  await addVersion({ documentId: newId, content, kind: "named", createdBy: userId, title: options.versionTitle ?? `Copied from ${sourceTitle}` });
  return doc;
}

const assetNanoid = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyz", 16);

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

/** Remove a collaborator (login normalized like `upsertCollaborator`). Returns whether a row was actually removed. */
export async function removeCollaborator(docId: string, login: string): Promise<boolean> {
  const db = await getDb();
  const normalized = login.trim().toLowerCase().replace(/^@/, "");
  const removed = await db
    .delete(schema.collaborators)
    .where(and(eq(schema.collaborators.documentId, docId), eq(schema.collaborators.login, normalized)))
    .returning();
  return removed.length > 0;
}

export async function getUserById(id: string) {
  const db = await getDb();
  const [u] = await db.select().from(schema.users).where(eq(schema.users.id, id));
  return u ?? null;
}

/** The user who has signed in with this GitHub handle (case-insensitive), or null if nobody has. */
export async function getUserByLogin(login: string) {
  const db = await getDb();
  const [u] = await db
    .select()
    .from(schema.users)
    .where(sql`lower(${schema.users.login}) = ${login.trim().replace(/^@/, "").toLowerCase()}`)
    .limit(1);
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

