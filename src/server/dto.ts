import type { Document } from "@/server/db/schema";
import type { DocumentMeta } from "@/server/documents";
import { githubUrlFor } from "@/server/publish";

export type DocumentDto = ReturnType<typeof publicDocument>;

/**
 * Either a full `document` row or the metadata-only shape an access check returns, which carries
 * `hasUnpublishedChanges` computed in SQL instead of the `content` / `publishedContent` columns.
 */
export type PublicDocumentSource = DocumentMeta & (Pick<Document, "content" | "publishedContent"> | { hasUnpublishedChanges: boolean });

/** Document fields that are safe to send to the browser. */
export function publicDocument(doc: PublicDocumentSource) {
  return {
    id: doc.id,
    title: doc.title,
    storage: doc.storage,
    linkAccess: doc.linkAccess,
    linkPreview: doc.linkPreview,
    ownerId: doc.ownerId,
    gistId: doc.gistId,
    gistFile: doc.gistFile,
    repoOwner: doc.repoOwner,
    repoName: doc.repoName,
    repoBranch: doc.repoBranch,
    repoPath: doc.repoPath,
    publishedAt: doc.publishedAt?.toISOString() ?? null,
    hasUnpublishedChanges: "hasUnpublishedChanges" in doc ? doc.hasUnpublishedChanges : doc.storage !== "local" && doc.publishedContent !== doc.content,
    githubUrl: githubUrlFor(doc),
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
}

export type FolderDto = ReturnType<typeof folderDto>;

/** A folder as the dashboard sees it. Dates as ISO strings, like every other DTO here. */
export function folderDto(folder: { id: string; name: string; documentCount: number; createdAt: Date; updatedAt: Date }) {
  return {
    id: folder.id,
    name: folder.name,
    documentCount: folder.documentCount,
    createdAt: folder.createdAt.toISOString(),
    updatedAt: folder.updatedAt.toISOString(),
  };
}
