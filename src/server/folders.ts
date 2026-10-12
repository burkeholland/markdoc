import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { customAlphabet } from "nanoid";
import { getDb, schema } from "@/server/db";
import type { Folder } from "@/server/db/schema";
import { deleteDocument } from "@/server/documents";
import { boundFolderName } from "@/lib/folder-name";

const nanoid = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyz", 12);

export { FOLDER_NAME_MAX, boundFolderName } from "@/lib/folder-name";

/** A folder plus how many live (not trashed) documents it holds. */
export interface FolderSummary {
  id: string;
  name: string;
  documentCount: number;
  createdAt: Date;
  updatedAt: Date;
}

/** A create can fail on the name; a rename can additionally hit a folder the caller does not own. */
export type FolderCreateResult =
  | { outcome: "ok"; folder: Folder }
  | { outcome: "empty-name" }
  | { outcome: "duplicate-name" };

export type FolderWriteResult = FolderCreateResult | { outcome: "not-found" };

/** Postgres's unique-violation SQLSTATE, raised here by the `folder_owner_name_idx` index. */
const UNIQUE_VIOLATION = "23505";

/**
 * Whether this error is the name collision the unique index refuses. The constraint — not a read
 * before the write — is what decides: two requests creating the same name at once would both pass a
 * pre-check, so the collision has to be read back off the error.
 *
 * Drizzle wraps the driver's error in a "Failed query" `Error` and keeps the original as `cause`, so
 * the SQLSTATE is one or more levels down rather than on the error itself.
 */
function isDuplicateName(err: unknown): boolean {
  for (let current = err, depth = 0; current && typeof current === "object" && depth < 5; depth++) {
    if ((current as { code?: unknown }).code === UNIQUE_VIOLATION) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/** Every folder of this owner, by name, each with its live document count. */
export async function listFoldersForUser(ownerId: string): Promise<FolderSummary[]> {
  const db = await getDb();
  const rows = await db
    .select({
      id: schema.folders.id,
      name: schema.folders.name,
      createdAt: schema.folders.createdAt,
      updatedAt: schema.folders.updatedAt,
      // Counting the join rather than a subquery per folder keeps this one statement. `deletedAt is
      // null` lives in the join condition, not a WHERE, so an empty folder still comes back.
      documentCount: sql<number>`count(${schema.documents.id})::int`,
    })
    .from(schema.folders)
    .leftJoin(
      schema.documents,
      and(eq(schema.documents.folderId, schema.folders.id), isNull(schema.documents.deletedAt)),
    )
    .where(eq(schema.folders.ownerId, ownerId))
    .groupBy(schema.folders.id)
    .orderBy(asc(sql`lower(${schema.folders.name})`));
  return rows;
}

/** One folder, only if this user owns it. */
export async function getFolderForOwner(folderId: string, ownerId: string): Promise<Folder | null> {
  const db = await getDb();
  const [folder] = await db
    .select()
    .from(schema.folders)
    .where(and(eq(schema.folders.id, folderId), eq(schema.folders.ownerId, ownerId)));
  return folder ?? null;
}

export async function createFolder(ownerId: string, name: string): Promise<FolderCreateResult> {
  const bounded = boundFolderName(name);
  if (!bounded) return { outcome: "empty-name" };
  const db = await getDb();
  try {
    const [folder] = await db.insert(schema.folders).values({ id: nanoid(), name: bounded, ownerId }).returning();
    return { outcome: "ok", folder };
  } catch (err) {
    if (isDuplicateName(err)) return { outcome: "duplicate-name" };
    throw err;
  }
}

/** Rename a folder this user owns. Renaming to the name it already has succeeds unchanged. */
export async function renameFolder(folderId: string, ownerId: string, name: string): Promise<FolderWriteResult> {
  const bounded = boundFolderName(name);
  if (!bounded) return { outcome: "empty-name" };
  const db = await getDb();
  try {
    const [folder] = await db
      .update(schema.folders)
      .set({ name: bounded, updatedAt: new Date() })
      .where(and(eq(schema.folders.id, folderId), eq(schema.folders.ownerId, ownerId)))
      .returning();
    return folder ? { outcome: "ok", folder } : { outcome: "not-found" };
  } catch (err) {
    if (isDuplicateName(err)) return { outcome: "duplicate-name" };
    throw err;
  }
}

/**
 * Delete a folder and send every document in it to the trash, where it is purged after 30 days
 * exactly as a document deleted on its own is (#2377).
 *
 * The documents are trashed first, one at a time through {@link deleteDocument}, so each one also
 * evicts its live editors — the column's `on delete set null` would otherwise leave a trashed-looking
 * folder's documents sitting at the top level with editors still connected. Returns how many moved,
 * or null if this user does not own the folder.
 */
export async function deleteFolder(folderId: string, ownerId: string): Promise<number | null> {
  const db = await getDb();
  const folder = await getFolderForOwner(folderId, ownerId);
  if (!folder) return null;
  const rows = await db
    .select({ id: schema.documents.id })
    .from(schema.documents)
    .where(and(eq(schema.documents.folderId, folderId), isNull(schema.documents.deletedAt)));
  for (const row of rows) await deleteDocument(row.id);
  await db.delete(schema.folders).where(and(eq(schema.folders.id, folderId), eq(schema.folders.ownerId, ownerId)));
  return rows.length;
}

export type MoveResult = { outcome: "ok"; moved: string[] } | { outcome: "no-folder" };

/**
 * Put documents into a folder, or at the top level when `folderId` is null. Returns the ids that
 * actually moved: an id this user does not own, or one already in that folder, is skipped rather
 * than refused, so moving a mixed selection is not all-or-nothing.
 *
 * Ownership is the test, not edit access. A folder belongs to one person, so filing someone else's
 * document into it would put a document in a folder its owner cannot see.
 */
export async function moveDocumentsToFolder(
  documentIds: readonly string[],
  folderId: string | null,
  ownerId: string,
): Promise<MoveResult> {
  if (documentIds.length === 0) return { outcome: "ok", moved: [] };
  const db = await getDb();
  if (folderId && !(await getFolderForOwner(folderId, ownerId))) return { outcome: "no-folder" };
  // Resolve which ids qualify first, then update those. `returning()` here would carry whole
  // document rows back — `ystate` and `content` included — for a write that needs only the ids.
  const qualifying = await db
    .select({ id: schema.documents.id })
    .from(schema.documents)
    .where(
      and(
        inArray(schema.documents.id, [...documentIds]),
        eq(schema.documents.ownerId, ownerId),
        isNull(schema.documents.deletedAt),
      ),
    );
  const moved = qualifying.map((row) => row.id);
  if (moved.length === 0) return { outcome: "ok", moved };
  await db.update(schema.documents).set({ folderId }).where(inArray(schema.documents.id, moved));
  return { outcome: "ok", moved };
}
