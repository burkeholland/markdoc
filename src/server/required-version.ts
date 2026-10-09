import { and, eq } from "drizzle-orm";
import { customAlphabet } from "nanoid";
import { getDb, schema } from "@/server/db";
import { addVersion } from "@/server/documents";
import { HttpError } from "@/server/http";

const versionId = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyz", 12);

export interface RequiredVersionInput {
  documentId: string;
  content: string;
  contentHash: string;
  kind: schema.VersionKind;
  title?: string | null;
  createdBy?: string | null;
  createdByName?: string | null;
}

/** Create the bounded, server-owned intent before its text mutation. */
export async function createRequiredVersionIntent(input: RequiredVersionInput): Promise<string> {
  const db = await getDb();
  const id = versionId();
  const inserted = await db
    .insert(schema.requiredVersionIntents)
    .values({
      documentId: input.documentId,
      versionId: id,
      content: input.content,
      contentHash: input.contentHash,
      kind: input.kind,
      title: input.title ?? null,
      createdBy: input.createdBy ?? null,
      createdByName: input.createdByName ?? null,
    })
    .onConflictDoNothing()
    .returning();
  if (inserted.length === 0) {
    throw new HttpError(503, "This document already has a versioned write being reconciled", { retryAfter: 5 }, { "Retry-After": "5" });
  }
  return id;
}

/** Remove only the intent this request owns, after a known pre-mutation failure or no-op. */
export async function discardRequiredVersionIntent(documentId: string, id: string): Promise<void> {
  const db = await getDb();
  await db
    .delete(schema.requiredVersionIntents)
    .where(and(eq(schema.requiredVersionIntents.documentId, documentId), eq(schema.requiredVersionIntents.versionId, id)));
}

export async function markRequiredVersionApplied(documentId: string, id: string): Promise<void> {
  const db = await getDb();
  await db
    .update(schema.requiredVersionIntents)
    .set({ applied: true })
    .where(and(eq(schema.requiredVersionIntents.documentId, documentId), eq(schema.requiredVersionIntents.versionId, id)));
}

/**
 * Finish a prior or current required version. A crash-created prepared row is recoverable when the live
 * content has its target hash. Any ambiguous stale row stays durable and blocks success instead of
 * inventing history or silently dropping the requirement.
 */
export async function finalizeRequiredVersionIntent(documentId: string, currentHash: string): Promise<boolean> {
  const db = await getDb();
  const [intent] = await db
    .select()
    .from(schema.requiredVersionIntents)
    .where(eq(schema.requiredVersionIntents.documentId, documentId));
  if (!intent) return false;
  const contentApplied = intent.applied || intent.contentHash === currentHash;
  if (!contentApplied) {
    throw new HttpError(500, "A previous content write has unresolved version history", {
      contentApplied: false,
      contentHash: currentHash,
      versionPending: true,
    });
  }
  try {
    await addVersion({
      id: intent.versionId,
      documentId,
      content: intent.content,
      kind: intent.kind,
      title: intent.title,
      createdBy: intent.createdBy,
      createdByName: intent.createdByName,
    });
  } catch {
    throw new HttpError(500, "The content was written, but its required version was not saved", {
      contentApplied: true,
      contentHash: currentHash,
      versionPending: true,
    });
  }
  await discardRequiredVersionIntent(documentId, intent.versionId);
  return true;
}
