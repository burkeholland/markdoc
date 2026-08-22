import type { Document } from "@/server/db/schema";
import { githubUrlFor } from "@/server/publish";

export type DocumentDto = ReturnType<typeof publicDocument>;

/** Document fields that are safe to send to the browser. */
export function publicDocument(doc: Document) {
  return {
    id: doc.id,
    title: doc.title,
    storage: doc.storage,
    linkAccess: doc.linkAccess,
    ownerId: doc.ownerId,
    gistId: doc.gistId,
    gistFile: doc.gistFile,
    repoOwner: doc.repoOwner,
    repoName: doc.repoName,
    repoBranch: doc.repoBranch,
    repoPath: doc.repoPath,
    publishedAt: doc.publishedAt?.toISOString() ?? null,
    hasUnpublishedChanges: doc.storage !== "local" && doc.publishedContent !== doc.content,
    githubUrl: githubUrlFor(doc),
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
}
