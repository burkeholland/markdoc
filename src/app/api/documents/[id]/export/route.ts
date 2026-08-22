import { handler, requireAccess } from "@/server/http";
import { readLiveText } from "@/server/livedoc";

type Params = { params: Promise<{ id: string }> };

/** Download the document as Markdown. `?suggestions=1` keeps pending suggested insertions. */
export const GET = handler(async (req: Request, { params }: Params) => {
  const { id } = await params;
  const { doc } = await requireAccess(id, "view");
  const url = new URL(req.url);
  const live = await readLiveText(id);
  const body = url.searchParams.get("suggestions") === "1" ? live.text : live.clean;
  const filename = (doc.title || "document").replace(/[^\w\- ]+/g, "").trim() || "document";
  const download = url.searchParams.get("download") === "1";
  return new Response(body, {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      ...(download ? { "Content-Disposition": `attachment; filename="${filename}.md"` } : {}),
      "Cache-Control": "no-store",
    },
  });
});
