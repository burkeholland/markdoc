import { HttpError } from "@/server/http";

/**
 * Largest GitHub file Markdoc reads into a document — the same 2 MB bound as `POST /api/import/file`
 * (`MAX_IMPORT_BYTES`) and `POST /api/documents`. Not a GitHub limit: the Contents API stops
 * inlining content at 1 MB (`encoding: "none"`), and anything up to this bound is fetched as a raw blob.
 */
export const GITHUB_FILE_MAX_BYTES = 2 * 1024 * 1024;

const formatMb = (bytes: number) => {
  const mb = bytes / (1024 * 1024);
  // Round up so a file just over the bound never reads "2 MB; limited to 2 MB".
  return mb >= 10 ? String(Math.ceil(mb)) : String(Math.ceil(mb * 100) / 100);
};

/**
 * `413`: the file exists on GitHub but is larger than Markdoc's document bound, so its text was not
 * read. `revision` (blob sha / gist history version) is kept so a force-publish can still overwrite it.
 */
export class GitHubFileTooLargeError extends HttpError {
  constructor(
    /** Bytes as GitHub reports them; null when only the streamed body told us it was over the bound. */
    public size: number | null,
    public revision: string | null,
    public limit = GITHUB_FILE_MAX_BYTES,
  ) {
    super(413, `The file on GitHub is ${size === null ? `larger than ${formatMb(limit)}` : formatMb(size)} MB; Markdoc documents are limited to ${formatMb(limit)} MB`, {
      size,
      limit,
    });
  }
}

/** Throw `GitHubFileTooLargeError` when `content` is over the bound (a defence behind the size check). */
export function assertWithinBound(content: string, revision: string | null) {
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > GITHUB_FILE_MAX_BYTES) throw new GitHubFileTooLargeError(bytes, revision);
}
