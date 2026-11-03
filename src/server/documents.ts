import { and, desc, eq, getTableColumns, ilike, inArray, isNotNull, isNull, lt, ne, or, sql } from "drizzle-orm";
import { customAlphabet } from "nanoid";
import { getDb, schema, type Db, type Tx } from "@/server/db";
import type { Document, Role, StorageKind } from "@/server/db/schema";
import { effectiveRoleForDocument, effectiveRoleSql, type AccessSource } from "@/server/document-access";
import { encodeSeedState } from "@/server/collab/seed";
import { boundTitle } from "@/server/document-title";
import { excerptOf, excerptOfPrefix } from "@/editor/stats";
import { plainTextFromMarkdown } from "@/editor/markdown/mdast";
import {
  copyVideoBlob,
  deleteVideoStorageForDocument,
  failVideoCopyReservations,
  finalizeVideoCopyReservations,
  registerVideoCopyReservations,
  scheduleVideoStorageCleanup,
  videoStorageKey,
} from "@/server/video-assets";

export { DOCUMENT_TITLE_MAX, boundTitle } from "@/server/document-title";
export type { Tx } from "@/server/db";

const nanoid = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyz", 12);

/** Whatever a statement can run on: the shared connection or a transaction on it. */
type Executor = Db | Tx;

export interface SessionUser {
  id: string;
  login: string | null;
  name?: string | null;
  image?: string | null;
}

/**
 * A `document` row without its bulky columns: no `ystate` (the Yjs state, read only by
 * livedoc.ts / collab/hocuspocus.ts), no `content` and no `publishedContent`. Everything that
 * authorizes, lists or describes a document works from this shape.
 */
export type DocumentMeta = Omit<Document, "ystate" | "content" | "publishedContent">;

/** Columns of {@link DocumentMeta}: every `document` column except the three large text/bytea ones. */
const documentMetaColumns = (() => {
  const columns: Partial<typeof schema.documents._.columns> = { ...getTableColumns(schema.documents) };
  delete columns.ystate;
  delete columns.content;
  delete columns.publishedContent;
  return columns as Omit<typeof schema.documents._.columns, "ystate" | "content" | "publishedContent">;
})();

/** The document as an access check sees it. */
export interface AccessDocument extends DocumentMeta {
  /**
   * For a document linked to GitHub, whether the stored text differs from what was last published
   * or pulled (`published_content is distinct from content`, compared in SQL so neither column has
   * to leave the database). Always false for a local document.
   */
  hasUnpublishedChanges: boolean;
}

export interface DocumentAccess {
  doc: AccessDocument;
  role: Role;
  source: AccessSource;
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

export interface AccessOptions {
  /** Also resolve documents that are in the trash (owner-only trash routes). */
  allowDeleted?: boolean;
}

/**
 * Resolve the document and the caller's role, or null if the caller has no access.
 * Documents in the trash resolve as "not found" unless `allowDeleted` is set.
 *
 * This runs for every `/api/documents/:id/*` request and every collaboration socket, so it reads
 * metadata only: no `ystate`, `content` or `publishedContent` (see {@link AccessDocument}).
 */
export async function getDocumentAccess(docId: string, user: SessionUser | null, { allowDeleted = false }: AccessOptions = {}): Promise<DocumentAccess | null> {
  const db = await getDb();
  const [doc] = await db
    .select({
      ...documentMetaColumns,
      hasUnpublishedChanges: sql<boolean>`(${schema.documents.storage} <> 'local' and ${schema.documents.publishedContent} is distinct from ${schema.documents.content})`,
    })
    .from(schema.documents)
    .where(eq(schema.documents.id, docId));
  if (!doc) return null;
  if (doc.deletedAt && !allowDeleted) return null;
  const access = await effectiveRoleForDocument(doc, user, db);
  return access ? { doc, ...access } : null;
}

/**
 * The document behind a public link preview (the title, first lines and card that Slack or Teams show
 * for a pasted link), or null: an unknown id, a document in the trash, or a restricted document whose
 * owner has not turned on link previews. A link-shared document always qualifies, since anyone with the
 * link can read it anyway. The preview is all this grants: opening the document still goes through
 * {@link getDocumentAccess}.
 */
export async function getLinkPreviewDocument(docId: string): Promise<DocumentMeta | null> {
  const db = await getDb();
  const [doc] = await db
    .select(documentMetaColumns)
    .from(schema.documents)
    .where(
      and(
        eq(schema.documents.id, docId),
        isNull(schema.documents.deletedAt),
        or(eq(schema.documents.linkPreview, true), ne(schema.documents.linkAccess, "private")),
      ),
    );
  return doc ?? null;
}

/**
 * The text last published to or pulled from GitHub (the three-way merge base), or null for a
 * document that was never synced. Read on its own because access rows leave the column out.
 */
export async function getPublishedContent(docId: string): Promise<string | null> {
  const db = await getDb();
  const [row] = await db.select({ publishedContent: schema.documents.publishedContent }).from(schema.documents).where(eq(schema.documents.id, docId));
  return row?.publishedContent ?? null;
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
  /** The folder this document is filed in, visible to its owner and people with a folder role. */
  folderId: string | null;
  /** Folder name for the owner and people with a role through that folder; direct collaborators do not see it. */
  folderName: string | null;
}

/** The card excerpt: the document's first prose, Markdown removed (see `excerptOf`). */
export function excerpt(content: string): string {
  return excerptOf(content, EXCERPT_LENGTH);
}

const EXCERPT_LENGTH = 160;

/**
 * How much of `content` a listing reads to build the excerpt: enough for a title, front matter
 * and a first paragraph many times over. The rare document whose first prose starts later than
 * this (a long code block or front matter up front) is re-read in full, see {@link excerptsFor}.
 */
export const EXCERPT_PREFIX_CHARS = 1000;

/** Columns a {@link DocumentSummary} is built from: metadata plus a bounded prefix of the text. */
const summaryColumns = {
  id: schema.documents.id,
  title: schema.documents.title,
  storage: schema.documents.storage,
  updatedAt: schema.documents.updatedAt,
  createdAt: schema.documents.createdAt,
  ownerId: schema.documents.ownerId,
  linkAccess: schema.documents.linkAccess,
  repoOwner: schema.documents.repoOwner,
  repoName: schema.documents.repoName,
  repoPath: schema.documents.repoPath,
  gistId: schema.documents.gistId,
  deletedAt: schema.documents.deletedAt,
  folderId: schema.documents.folderId,
  folderName: schema.folders.name,
  // One character more than the bound, so a prefix longer than the bound is known to be cut short.
  contentHead: sql<string>`left(${schema.documents.content}, ${EXCERPT_PREFIX_CHARS + 1})`,
};

type SummaryDoc = {
  [K in keyof typeof summaryColumns]: K extends keyof Document ? Document[K] : K extends "folderName" ? string | null : string;
};

interface VisibleRow {
  doc: SummaryDoc;
  owner: { name: string | null; login: string | null } | null;
  effectiveRole: Role | null;
  folderRole: Exclude<Role, "owner"> | null;
  starred: boolean | null;
  lastOpenedAt: Date | null;
}

/**
 * Documents the user owns, is listed as a collaborator on, or has opened through an active link share,
 * with the owner, the user's role, their star and their last-opened time joined in. Reads no `ystate`,
 * `publishedContent` or full `content`: the dashboard and `GET /api/documents` only show metadata and a
 * short excerpt. `extra` adds `document` columns to `doc` for the one caller that needs more (search).
 */
function visibleDocuments<E extends Partial<typeof schema.documents._.columns> = Record<never, never>>(db: Awaited<ReturnType<typeof getDb>>, user: SessionUser, extra?: E) {
  const access = effectiveRoleSql(schema.documents, { id: user.id, login: user.login, signedIn: true });
  const memberAccess = effectiveRoleSql(schema.documents, { id: user.id, login: user.login, signedIn: true }, { includeLink: false });
  const query = db
    .select({
      doc: { ...summaryColumns, ...(extra ?? ({} as E)) },
      owner: { name: schema.users.name, login: schema.users.login },
      effectiveRole: access.role,
      folderRole: access.folderRole,
      starred: schema.stars.starred,
      lastOpenedAt: schema.recents.openedAt,
    })
    .from(schema.documents)
    .leftJoin(schema.users, eq(schema.users.id, schema.documents.ownerId))
    .leftJoin(schema.folders, eq(schema.folders.id, schema.documents.folderId))
    .leftJoin(schema.stars, and(eq(schema.stars.documentId, schema.documents.id), eq(schema.stars.userId, user.id)))
    .leftJoin(schema.recents, and(eq(schema.recents.documentId, schema.documents.id), eq(schema.recents.userId, user.id)));
  const openedViaLink = and(isNotNull(schema.recents.documentId), ne(schema.documents.linkAccess, "private"));
  const visible = and(
    or(sql`${memberAccess.role} is not null`, openedViaLink),
    isNull(schema.documents.deletedAt),
  )!;
  const starredOnly = eq(schema.stars.starred, true);
  return { query, visible, starredOnly };
}

/**
 * Excerpts for the rows, by document id. Each is computed from the row's content prefix when that
 * is conclusive (see `excerptOfPrefix`); the documents where it is not are read in full in one
 * extra query, so the result is exactly `excerpt(content)` for every document. A row that already
 * carries the full `content` (search) uses it directly.
 */
async function excerptsFor(db: Awaited<ReturnType<typeof getDb>>, rows: VisibleRow[]): Promise<Map<string, string>> {
  const excerpts = new Map<string, string>();
  const needFull: string[] = [];
  for (const { doc } of rows) {
    if ("content" in doc && typeof doc.content === "string") {
      excerpts.set(doc.id, excerpt(doc.content));
      continue;
    }
    const truncated = doc.contentHead.length > EXCERPT_PREFIX_CHARS;
    const fromPrefix = excerptOfPrefix(doc.contentHead, truncated, EXCERPT_LENGTH);
    if (fromPrefix === null) needFull.push(doc.id);
    else excerpts.set(doc.id, fromPrefix);
  }
  if (needFull.length > 0) {
    const full = await db.select({ id: schema.documents.id, content: schema.documents.content }).from(schema.documents).where(inArray(schema.documents.id, needFull));
    for (const { id, content } of full) excerpts.set(id, excerpt(content));
  }
  return excerpts;
}

function toSummary({ doc, owner, effectiveRole, folderRole, starred, lastOpenedAt }: VisibleRow, user: SessionUser, excerpt: string): DocumentSummary {
  return {
    id: doc.id,
    title: doc.title,
    storage: doc.storage,
    updatedAt: doc.updatedAt,
    createdAt: doc.createdAt,
    ownerId: doc.ownerId,
    ownerName: owner?.name ?? null,
    ownerLogin: owner?.login ?? null,
    role: effectiveRole ?? "viewer",
    excerpt,
    repoOwner: doc.repoOwner,
    repoName: doc.repoName,
    repoPath: doc.repoPath,
    gistId: doc.gistId,
    starred: starred === true,
    lastOpenedAt: lastOpenedAt ?? null,
    deletedAt: doc.deletedAt ?? null,
    folderId: doc.ownerId === user.id || folderRole ? (doc.folderId ?? null) : null,
    folderName: doc.ownerId === user.id || folderRole ? (doc.folderName ?? null) : null,
  };
}

async function toSummaries(db: Awaited<ReturnType<typeof getDb>>, rows: VisibleRow[], user: SessionUser): Promise<DocumentSummary[]> {
  const excerpts = await excerptsFor(db, rows);
  return rows.map((row) => toSummary(row, user, excerpts.get(row.doc.id) ?? ""));
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
  return toSummaries(db, rows, user);
}

/** The caller's own documents that are in the trash, most recently trashed first. */
export async function listTrashForUser(user: SessionUser): Promise<DocumentSummary[]> {
  const db = await getDb();
  const { query } = visibleDocuments(db, user);
  const rows = await query
    .where(and(eq(schema.documents.ownerId, user.id), isNotNull(schema.documents.deletedAt)))
    .orderBy(desc(schema.documents.deletedAt));
  return toSummaries(db, rows, user);
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

/** ~120 characters of plain text around the first case-insensitive match of `needle`, or null. */
export function contentSnippet(content: string, needle: string): string | null {
  const flat = plainTextFromMarkdown(content);
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
 *
 * This is the one listing that still reads the full `content` column (for at most `limit` rows):
 * the snippet is cut from the whitespace-collapsed text around the first match, and a bounded
 * window could not reproduce it exactly (a run of whitespace collapses to one space, and the
 * ellipses depend on knowing where the text ends). `ystate` and `publishedContent` are not read.
 */
export async function searchDocumentsForUser(user: SessionUser, q: string, { limit = 20 }: { limit?: number } = {}): Promise<SearchResult[]> {
  const needle = q.trim();
  if (needle.length < 2) return [];
  const db = await getDb();
  const pattern = `%${escapeLike(needle)}%`;
  const titleMatch = ilike(schema.documents.title, pattern);
  const { query, visible } = visibleDocuments(db, user, { content: schema.documents.content });
  const rows = await query
    .where(and(visible, or(titleMatch, ilike(schema.documents.content, pattern))))
    .orderBy(sql`case when ${titleMatch} then 0 else 1 end`, desc(schema.documents.updatedAt))
    .limit(limit);
  const summaries = await toSummaries(db, rows, user);
  return summaries.map((summary, i) => ({ ...summary, snippet: contentSnippet(rows[i].doc.content, needle) }));
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

export const DEFAULT_CONTENT = "";

/** First `# ` heading with inline markup stripped, else `fallback`; clipped to {@link DOCUMENT_TITLE_MAX}. */
export function titleFromContent(content: string, fallback = "Untitled"): string {
  const m = /^#\s+(.+)$/m.exec(content);
  return boundTitle(m ? m[1].trim().replace(/[*_`]/g, "") : fallback);
}

/**
 * Insert a new document. A document linked to GitHub (`storage` ≠ `local`) also records its
 * "Imported from GitHub" version, in one transaction with the row: a failure between the two used to
 * leave a linked document without its version that the retry then duplicated (audit #1202 F11). The
 * local path (`POST /api/documents`) is a single insert. Pass `tx` to run inside a caller's transaction.
 */
export async function createDocument(input: CreateDocumentInput, tx?: Tx): Promise<Document> {
  const content = input.content ?? DEFAULT_CONTENT;
  const id = nanoid();
  // Every path that mints a title (API, file/text/HTML import, GitHub import) ends here, so the bound is enforced once.
  const title = boundTitle(input.title ?? titleFromContent(content));
  const linked = !!input.storage && input.storage !== "local";
  const row = {
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
    publishedContent: linked ? content : null,
    publishedAt: linked ? new Date() : null,
  };
  const insert = async (on: Executor) => (await on.insert(schema.documents).values(row).returning())[0];
  const create = async (on: Tx) => {
    const doc = await insert(on);
    if (linked) await addVersion({ documentId: id, content, kind: "import", createdBy: input.ownerId, title: "Imported from GitHub" }, on);
    return doc;
  };
  if (tx) return create(tx);
  const db = await getDb();
  return linked ? db.transaction(create) : insert(db);
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
 * For live documents use `replaceLiveText` in livedoc.ts instead. Pass `tx` to run inside a transaction.
 */
export async function setDocumentText(docId: string, content: string, tx?: Tx): Promise<Document | null> {
  const db: Executor = tx ?? (await getDb());
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
  await db.transaction(async (tx) => {
    const [document] = await tx.select({ id: schema.documents.id }).from(schema.documents).where(eq(schema.documents.id, docId)).for("update");
    if (!document) return;
    await deleteVideoStorageForDocument(docId, tx);
    await tx.delete(schema.documents).where(eq(schema.documents.id, docId));
  });
  scheduleVideoStorageCleanup();
}

/** Purge documents that have been in the trash longer than `days`. Returns how many were removed. */
export async function purgeTrashOlderThan(days = TRASH_RETENTION_DAYS, now = new Date()): Promise<number> {
  const db = await getDb();
  const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  const candidates = await db
    .select({ id: schema.documents.id })
    .from(schema.documents)
    .where(and(isNotNull(schema.documents.deletedAt), lt(schema.documents.deletedAt, cutoff)));
  let removed = 0;
  for (const { id } of candidates) {
    const purged = await db.transaction(async (tx) => {
      const [document] = await tx
        .select({ id: schema.documents.id })
        .from(schema.documents)
        .where(and(eq(schema.documents.id, id), isNotNull(schema.documents.deletedAt), lt(schema.documents.deletedAt, cutoff)))
        .for("update");
      if (!document) return false;
      await deleteVideoStorageForDocument(id, tx);
      const rows = await tx
        .delete(schema.documents)
        .where(and(eq(schema.documents.id, id), isNotNull(schema.documents.deletedAt), lt(schema.documents.deletedAt, cutoff)))
        .returning();
      return rows.length > 0;
    });
    if (purged) removed++;
  }
  scheduleVideoStorageCleanup();
  return removed;
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
  const videoReservations = assets
    .filter((asset) => asset.storageKey)
    .map((asset) => {
      const id = idMap.get(asset.id)!;
      return {
        id,
        documentId: docId,
        userId,
        name: asset.name,
        mime: asset.mime,
        size: asset.size,
        storageKey: videoStorageKey(id),
      };
    });

  // Row, copied assets and first version land together or not at all (audit #1202 F9): a failure after
  // the row insert used to leave "Copy of …" on the dashboard with asset URLs that 404, and the retry made a second copy.
  try {
    await registerVideoCopyReservations(videoReservations);
    for (const asset of assets) {
      if (!asset.storageKey) continue;
      await copyVideoBlob(asset.storageKey, idMap.get(asset.id)!, asset.size);
    }
    return await db.transaction(async (tx) => {
      const [doc] = await tx
        .insert(schema.documents)
        .values({ id: newId, title, ownerId: userId, content, ystate: encodeSeedState(content, title), storage: "local", lastEditedBy: userId })
        .returning();
      if (assets.length > 0) {
        await tx
          .insert(schema.assets)
          .values(
            assets.map((a) => ({
              id: idMap.get(a.id)!,
              documentId: newId,
              userId,
              name: a.name,
              mime: a.mime,
              size: a.size,
              sha256: a.sha256,
              data: a.data,
              storageKey: a.storageKey ? videoStorageKey(idMap.get(a.id)!) : null,
            })),
          );
      }
      await addVersion({ documentId: newId, content, kind: "named", createdBy: userId, title: options.versionTitle ?? `Copied from ${sourceTitle}` }, tx);
      await finalizeVideoCopyReservations(
          videoReservations.map(({ id }) => id),
          tx,
      );
      return doc;
    });
  } catch (error) {
    if (videoReservations.length > 0) {
      try {
          await failVideoCopyReservations(videoReservations);
      } catch (cleanupError) {
          throw new AggregateError([error, cleanupError], "Document copy failed and copied videos could not be queued for cleanup");
      }
    }
    throw error;
  }
}

const assetNanoid = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyz", 16);

export interface AddVersionInput {
  /** Stable server-owned id for idempotent recovery of a required version. */
  id?: string;
  documentId: string;
  content: string;
  kind: schema.VersionKind;
  createdBy?: string | null;
  createdByName?: string | null;
  title?: string | null;
  commitSha?: string | null;
}

/** The unique index on `(document_id, number)` (schema.ts) that the loser of the version-number race trips. */
const VERSION_NUMBER_INDEX = "version_doc_number_idx";

/**
 * True for a unique violation (SQLSTATE `23505`) on {@link VERSION_NUMBER_INDEX}, however it arrives:
 * drizzle wraps the driver's error as the `cause` of a `DrizzleQueryError`, and both PGlite and `pg`
 * put `code` and `constraint` on theirs, so the chain is walked. A driver that names no constraint
 * still counts — `version` has no other unique index a re-run with a fresh number would not cure.
 */
export function isVersionNumberCollision(err: unknown): boolean {
  for (let e = err, depth = 0; e && typeof e === "object" && depth < 5; e = (e as { cause?: unknown }).cause, depth++) {
    const { code, constraint } = e as { code?: unknown; constraint?: unknown };
    if (code === "23505") return constraint === undefined || constraint === VERSION_NUMBER_INDEX;
  }
  return false;
}

/** One attempt: `max(number)` for the document, then the insert at `max + 1`. */
async function insertNextVersion(on: Executor, input: AddVersionInput) {
  const [{ max }] = await on
    .select({ max: sql<number>`coalesce(max(${schema.versions.number}), 0)` })
    .from(schema.versions)
    .where(eq(schema.versions.documentId, input.documentId));
  const [version] = await on
    .insert(schema.versions)
    .values({
      id: input.id ?? nanoid(),
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

async function versionById(on: Executor, id: string) {
  const [version] = await on.select().from(schema.versions).where(eq(schema.versions.id, id));
  return version ?? null;
}

function sameVersion(version: typeof schema.versions.$inferSelect, input: AddVersionInput): boolean {
  return (
    version.documentId === input.documentId &&
    version.content === input.content &&
    version.kind === input.kind &&
    version.createdBy === (input.createdBy ?? null) &&
    version.createdByName === (input.createdByName ?? null) &&
    version.title === (input.title ?? null) &&
    version.commitSha === (input.commitSha ?? null)
  );
}

/**
 * Record the document's next version. Two version-producing calls on one document at the same time
 * (an agent's `PUT /content` and the collaboration server's auto-version, two agents, publish + restore)
 * both read the same `max` and the second insert trips {@link VERSION_NUMBER_INDEX}; that call re-reads
 * and inserts once more, so both get distinct consecutive numbers. A second collision throws as before
 * (audit #1202 G4). Pass `tx` to record the version inside a transaction: each attempt then runs in a
 * savepoint, because on PostgreSQL the violation would otherwise abort the whole transaction (25P02).
 */
export async function addVersion(input: AddVersionInput, tx?: Tx) {
  const attempt = tx ? () => tx.transaction((savepoint: Tx) => insertNextVersion(savepoint, input)) : async () => insertNextVersion(await getDb(), input);
  const executor = tx ?? (await getDb());
  for (let tries = 0; tries < 2; tries++) {
    if (input.id) {
      const existing = await versionById(executor, input.id);
      if (existing) {
        if (!sameVersion(existing, input)) throw new Error("Required version id already belongs to different version data");
        return existing;
      }
    }
    try {
      return await attempt();
    } catch (err) {
      if (input.id) {
        const existing = await versionById(executor, input.id);
        if (existing) {
          if (!sameVersion(existing, input)) throw new Error("Required version id already belongs to different version data");
          return existing;
        }
      }
      if (tries === 0 && isVersionNumberCollision(err)) continue;
      throw err;
    }
  }
  throw new Error("Could not allocate a version number");
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

/** The role this login holds on the document as a collaborator, or null when it has none (login normalized like `upsertCollaborator`). */
export async function getCollaboratorRole(docId: string, login: string): Promise<Exclude<Role, "owner"> | null> {
  const db = await getDb();
  const normalized = login.trim().toLowerCase().replace(/^@/, "");
  const [row] = await db
    .select({ role: schema.collaborators.role })
    .from(schema.collaborators)
    .where(and(eq(schema.collaborators.documentId, docId), eq(schema.collaborators.login, normalized)));
  return row?.role ?? null;
}

/** What `addCollaborator` did: wrote a row (`written`), found the same role (`unchanged`), or left another role alone (`refused`). */
export type AddCollaboratorResult = { outcome: "written" } | { outcome: "unchanged" } | { outcome: "refused"; role: Exclude<Role, "owner"> };

/**
 * Give a login a role without ever changing a role nobody asked to change (#2252). The decision and the
 * write are one statement, so two requests for the same login cannot both win:
 * - without `change`, an insert that leaves an existing row alone: the same role is `unchanged`, another
 *   role is `refused` with the role the person keeps;
 * - with `change`, an upsert that only writes when the role differs (a login without access is added).
 */
export async function addCollaborator(
  docId: string,
  login: string,
  role: Exclude<Role, "owner">,
  addedBy: string,
  options: { change?: boolean } = {},
): Promise<AddCollaboratorResult> {
  const db = await getDb();
  const normalized = login.trim().toLowerCase().replace(/^@/, "");
  const values = { documentId: docId, login: normalized, role, addedBy };
  const target = [schema.collaborators.documentId, schema.collaborators.login];
  if (options.change) {
    const written = await db
      .insert(schema.collaborators)
      .values(values)
      .onConflictDoUpdate({ target, set: { role }, setWhere: ne(schema.collaborators.role, role) })
      .returning();
    return { outcome: written.length > 0 ? "written" : "unchanged" };
  }
  // A row that is there on the insert and gone on the read was removed in between: insert again. Three rounds
  // would need three removals of this login to land in those gaps; then give up (a 500, nothing written).
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const inserted = await db.insert(schema.collaborators).values(values).onConflictDoNothing({ target }).returning();
    if (inserted.length > 0) return { outcome: "written" };
    const current = await getCollaboratorRole(docId, normalized);
    if (current === role) return { outcome: "unchanged" };
    if (current) return { outcome: "refused", role: current };
  }
  throw new Error(`collaborator ${normalized} on ${docId} kept changing while it was added`);
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
