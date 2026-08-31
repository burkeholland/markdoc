import { handler, HttpError, json, requireAccess } from "@/server/http";
import { syncStatus } from "@/server/publish";

type Params = { params: Promise<{ id: string }> };

/**
 * Three-way sync status against the linked GitHub file; the remote read is cached for 30 s per
 * document. `?fresh=1` bypasses the cache, `?content=1` adds `remoteContent`; `pollMs` tells the
 * header how often to ask again (SYNC_POLL_MS, default 60 s). The 413 `remote-unreadable` answer
 * carries `pollMs` too, so the header keeps polling at that rate while the GitHub file is over the
 * bound and picks up a force publish as soon as it lands instead of a minute later.
 */
export const GET = handler(async (req: Request, { params }: Params) => {
  const { id } = await params;
  const { doc, user } = await requireAccess(id, "view");
  const q = new URL(req.url).searchParams;
  const pollMs = Math.max(1000, Number(process.env.SYNC_POLL_MS) || 60_000);
  try {
    const status = await syncStatus(doc, user!, { fresh: q.get("fresh") === "1", content: q.get("content") === "1" });
    return json({ ...status, pollMs });
  } catch (err) {
    if (err instanceof HttpError && err.details?.status === "remote-unreadable") {
      throw new HttpError(err.status, err.message, { ...err.details, pollMs }, err.headers);
    }
    throw err;
  }
});