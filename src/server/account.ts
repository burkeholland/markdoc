import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { zipSync, strToU8 } from "fflate";
import { getDb, schema } from "@/server/db";
import { readLiveText } from "@/server/livedoc";
import { DEMO_LOGIN } from "@/server/demo-auth";
import { HttpError, type Actor } from "@/server/http";
import { deleteVideoStorageForDocument, scheduleVideoStorageCleanup } from "@/server/video-assets";

/** A file or folder name that is safe on Windows, macOS and Linux; empty input becomes `fallback`. */
export function sanitizePathSegment(value: string, fallback: string): string {
  const cleaned = value
    .replace(/[<>:"/\\|?*\p{Cc}\p{Cs}\p{Zl}\p{Zp}]/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/, "")
    .slice(0, 120)
    .trim();
  if (!cleaned || cleaned === "." || cleaned === "..") return fallback;
  return /^(con|prn|aux|nul|com\d|lpt\d)$/i.test(cleaned) ? `${cleaned}_` : cleaned;
}

/** `folder/title.md` paths, unique case-insensitively ("Notes.md", "Notes (2).md"). */
export function exportPaths(docs: ReadonlyArray<{ title: string; folder: string | null }>): string[] {
  const used = new Set<string>();
  return docs.map(({ title, folder }) => {
    const dir = folder === null ? "" : `${sanitizePathSegment(folder, "Folder")}/`;
    const base = sanitizePathSegment(title, "Untitled");
    let path = `${dir}${base}.md`;
    for (let n = 2; used.has(path.toLowerCase()); n++) path = `${dir}${base} (${n}).md`;
    used.add(path.toLowerCase());
    return path;
  });
}

/** Zip of every non-trashed document the user owns, as Markdown, with folders as directories. */
export async function exportAllDocuments(userId: string): Promise<{ zip: Uint8Array; count: number }> {
  const db = await getDb();
  const rows = await db
    .select({ id: schema.documents.id, title: schema.documents.title, content: schema.documents.content, folder: schema.folders.name, createdAt: schema.documents.createdAt })
    .from(schema.documents)
    .leftJoin(schema.folders, eq(schema.folders.id, schema.documents.folderId))
    .where(and(eq(schema.documents.ownerId, userId), isNull(schema.documents.deletedAt)))
    .orderBy(asc(schema.documents.createdAt), asc(schema.documents.id));
  const docs = [];
  for (const row of rows) {
    // The live copy is what the editor shows; the stored column is a fallback for a document that cannot be read.
    let title = row.title;
    let markdown = row.content;
    try {
      const live = await readLiveText(row.id);
      markdown = live.clean;
      title = live.title || row.title;
    } catch (error) {
      console.error("[markdoc] export-all: live text unavailable", row.id, error);
    }
    docs.push({ title, folder: row.folder, markdown });
  }
  const paths = exportPaths(docs);
  const files: Record<string, Uint8Array> = {};
  docs.forEach((doc, i) => (files[paths[i]] = strToU8(doc.markdown)));
  return { zip: zipSync(files), count: docs.length };
}

/** Account-level actions belong to the person in a browser session, never to an API token or a canvas embed. */
export function requireBrowserSession(user: Actor, action: string): void {
  if (user.agent || user.tokenId || user.embedDocumentId) throw new HttpError(403, `API tokens and embedded sessions cannot ${action}`);
}

export function isDemoAccount(login: string | null | undefined): boolean {
  return (login ?? "").toLowerCase() === DEMO_LOGIN;
}

/**
 * Delete the user. Rows keyed by user id cascade (documents and everything under them, folders, tokens,
 * stars, sessions...); rows keyed by GitHub login (shares to this person, their notifications) do not.
 */
export async function deleteAccount(user: { id: string; login: string | null }): Promise<void> {
  const db = await getDb();
  await db.transaction(async (tx) => {
    if (user.login) {
      const login = user.login.toLowerCase();
      await tx.delete(schema.notifications).where(eq(schema.notifications.userLogin, login));
      await tx.delete(schema.collaborators).where(sql`lower(${schema.collaborators.login}) = ${login}`);
      await tx.delete(schema.folderCollaborators).where(sql`lower(${schema.folderCollaborators.login}) = ${login}`);
    }
    const documents = await tx
      .select({ id: schema.documents.id })
      .from(schema.documents)
      .where(eq(schema.documents.ownerId, user.id))
      .orderBy(asc(schema.documents.id))
      .for("update");
    for (const { id } of documents) await deleteVideoStorageForDocument(id, tx);
    await tx.delete(schema.users).where(eq(schema.users.id, user.id));
  });
  scheduleVideoStorageCleanup();
}
