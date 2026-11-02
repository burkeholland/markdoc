import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { customAlphabet } from "nanoid";
import { getDb, schema } from "@/server/db";
import type { Folder, Role } from "@/server/db/schema";
import { changeDocumentFolderAccess, withFolderAccessLock } from "@/server/collab/authorization";
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
  ownerId: string;
  ownerName: string | null;
  ownerLogin: string | null;
  role: Role;
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

/** Folders the user owns or has been given a role on, each with its live document count. */
export async function listFoldersForUser(ownerId: string, userLogin: string | null = null): Promise<FolderSummary[]> {
  const db = await getDb();
  const owned = db
    .select({
      id: schema.folders.id,
      name: schema.folders.name,
      createdAt: schema.folders.createdAt,
      updatedAt: schema.folders.updatedAt,
      ownerId: schema.folders.ownerId,
      ownerName: schema.users.name,
      ownerLogin: schema.users.login,
      role: sql<Role>`'owner'`,
      documentCount: sql<number>`count(${schema.documents.id})::int`,
    })
    .from(schema.folders)
    .innerJoin(schema.users, eq(schema.users.id, schema.folders.ownerId))
    .leftJoin(schema.documents, and(eq(schema.documents.folderId, schema.folders.id), isNull(schema.documents.deletedAt)))
    .where(eq(schema.folders.ownerId, ownerId))
    .groupBy(schema.folders.id, schema.users.name, schema.users.login)
    .orderBy(asc(sql`lower(${schema.folders.name})`));
  const login = userLogin?.trim().replace(/^@/, "").toLowerCase();
  const shared = login
    ? db
        .select({
          id: schema.folders.id,
          name: schema.folders.name,
          createdAt: schema.folders.createdAt,
          updatedAt: schema.folders.updatedAt,
          ownerId: schema.folders.ownerId,
          ownerName: schema.users.name,
          ownerLogin: schema.users.login,
          role: schema.folderCollaborators.role,
          documentCount: sql<number>`count(${schema.documents.id})::int`,
        })
        .from(schema.folderCollaborators)
        .innerJoin(schema.folders, eq(schema.folders.id, schema.folderCollaborators.folderId))
        .innerJoin(schema.users, eq(schema.users.id, schema.folders.ownerId))
        .leftJoin(schema.documents, and(eq(schema.documents.folderId, schema.folders.id), isNull(schema.documents.deletedAt)))
        .where(and(eq(schema.folderCollaborators.login, login), sql`${schema.folders.ownerId} <> ${ownerId}`))
        .groupBy(schema.folders.id, schema.users.name, schema.users.login, schema.folderCollaborators.role)
        .orderBy(asc(sql`lower(${schema.folders.name})`))
    : Promise.resolve([]);
  const [ownedFolders, sharedFolders] = await Promise.all([owned, shared]);
  return [...ownedFolders, ...sharedFolders];
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

/** A folder summary for its owner or a person with a folder role. */
export async function getFolderForUser(folderId: string, userId: string, login: string | null): Promise<FolderSummary | null> {
  return (await listFoldersForUser(userId, login)).find((folder) => folder.id === folderId) ?? null;
}

/** Direct folder roles only; inherited document roles are resolved separately. */
export async function listFolderCollaborators(folderId: string) {
  const db = await getDb();
  return db
    .select({
      login: schema.folderCollaborators.login,
      role: schema.folderCollaborators.role,
      createdAt: schema.folderCollaborators.createdAt,
      name: schema.users.name,
      image: schema.users.image,
    })
    .from(schema.folderCollaborators)
    .leftJoin(schema.users, sql`lower(${schema.users.login}) = lower(${schema.folderCollaborators.login})`)
    .where(eq(schema.folderCollaborators.folderId, folderId));
}

/** The role directly set on a folder for this login, or null when it has none. */
export async function getFolderCollaboratorRole(folderId: string, login: string): Promise<Exclude<Role, "owner"> | null> {
  const db = await getDb();
  const normalized = normalizeCollaboratorLogin(login);
  const [row] = await db
    .select({ role: schema.folderCollaborators.role })
    .from(schema.folderCollaborators)
    .where(and(eq(schema.folderCollaborators.folderId, folderId), eq(schema.folderCollaborators.login, normalized)));
  return row?.role ?? null;
}

export type AddFolderCollaboratorResult =
  | { outcome: "written" }
  | { outcome: "unchanged" }
  | { outcome: "refused"; role: Exclude<Role, "owner"> };

/** Give a login a folder role without changing an existing role unless the owner explicitly asks. */
export async function addFolderCollaborator(
  folderId: string,
  login: string,
  role: Exclude<Role, "owner">,
  addedBy: string,
  options: { change?: boolean } = {},
): Promise<AddFolderCollaboratorResult> {
  const db = await getDb();
  const normalized = normalizeCollaboratorLogin(login);
  const values = { folderId, login: normalized, role, addedBy };
  const target = [schema.folderCollaborators.folderId, schema.folderCollaborators.login];
  if (options.change) {
    const written = await db
      .insert(schema.folderCollaborators)
      .values(values)
      .onConflictDoUpdate({ target, set: { role }, setWhere: sql`${schema.folderCollaborators.role} <> ${role}` })
      .returning();
    return { outcome: written.length > 0 ? "written" : "unchanged" };
  }
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const inserted = await db.insert(schema.folderCollaborators).values(values).onConflictDoNothing({ target }).returning();
    if (inserted.length > 0) return { outcome: "written" };
    const current = await getFolderCollaboratorRole(folderId, normalized);
    if (current === role) return { outcome: "unchanged" };
    if (current) return { outcome: "refused", role: current };
  }
  throw new Error(`folder collaborator ${normalized} on ${folderId} kept changing while it was added`);
}

/** Remove a direct folder role; inherited document roles are unaffected. */
export async function removeFolderCollaborator(folderId: string, login: string): Promise<boolean> {
  const db = await getDb();
  const removed = await db
    .delete(schema.folderCollaborators)
    .where(and(eq(schema.folderCollaborators.folderId, folderId), eq(schema.folderCollaborators.login, normalizeCollaboratorLogin(login))))
    .returning();
  return removed.length > 0;
}

function normalizeCollaboratorLogin(login: string): string {
  return login.trim().replace(/^@/, "").toLowerCase();
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
  return withFolderAccessLock(folderId, async () => {
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
  });
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
    .select({ id: schema.documents.id, folderId: schema.documents.folderId })
    .from(schema.documents)
    .where(
      and(
        inArray(schema.documents.id, [...documentIds]),
        eq(schema.documents.ownerId, ownerId),
        isNull(schema.documents.deletedAt),
      ),
    );
  const moved = qualifying.filter(({ folderId: current }) => current !== folderId).map((row) => row.id);
  if (moved.length === 0) return { outcome: "ok", moved };
  let updated: string[] = [];
  await changeDocumentFolderAccess(moved, folderId, async () => {
    const rows = await (db as NodePgDatabase<typeof schema>)
      .update(schema.documents)
      .set({ folderId })
      .where(
        and(
          inArray(schema.documents.id, moved),
          eq(schema.documents.ownerId, ownerId),
          isNull(schema.documents.deletedAt),
        ),
      )
      .returning({ id: schema.documents.id });
    updated = rows.map(({ id }) => id);
  });
  return { outcome: "ok", moved: updated };
}
