import { handler, requireAccess, json, HttpError } from "@/server/http";
import { readLiveText } from "@/server/livedoc";
import { renderDocumentHtml } from "@/server/export/html";
import { renderPdf, PdfBusyError, PdfCancelledError, PdfUnavailableError } from "@/server/export/pdf";
import { findUnrenderable, UnrenderableDocumentError } from "@/editor/markdown/renderable";
import { exportContentDisposition } from "@/lib/download-filename";

type Params = { params: Promise<{ id: string }> };

type Format = "md" | "html" | "pdf";

const CONTENT_TYPES: Record<Format, string> = {
  md: "text/markdown; charset=utf-8",
  html: "text/html; charset=utf-8",
  pdf: "application/pdf",
};

const FORMATS = Object.keys(CONTENT_TYPES) as Format[];

/** `md` when absent; anything other than `md|html|pdf` is a 400 rather than a silent Markdown fallback. */
function parseFormat(value: string | null): Format {
  if (value === null || value === "") return "md";
  if ((FORMATS as string[]).includes(value)) return value as Format;
  throw new HttpError(400, "Unknown format", { format: value, formats: FORMATS });
}

/**
 * Download the document. `?format=md|html|pdf` (default `md`); `?suggestions=1` keeps pending
 * suggested insertions; `?download=1` adds an attachment header (and inlines images for HTML).
 */
export const GET = handler(async (req: Request, { params }: Params) => {
  const { id } = await params;
  const { doc, user } = await requireAccess(id, "view");
  const url = new URL(req.url);
  const live = await readLiveText(id);
  const markdown = url.searchParams.get("suggestions") === "1" ? live.text : live.clean;
  const currentTitle = live.title || doc.title;
  const download = url.searchParams.get("download") === "1";
  const format = parseFormat(url.searchParams.get("format"));
  const title = currentTitle || "Document";

  let body: BodyInit;
  if (format === "md") {
    body = markdown;
  } else if (format === "html") {
    // Inlining is scoped to this document's own assets: the access check above covers the document, not every id its Markdown names.
    body = await renderDocumentHtml({ title, markdown, assetBaseUrl: url.origin, inlineAssets: download ? { documentId: id } : false });
  } else {
    // What the renderer refuses outright is refused now: such a document does not wait for a turn first.
    const unrenderable = findUnrenderable(markdown);
    if (unrenderable) throw new UnrenderableDocumentError(unrenderable);
    // PDF rendering happens in a headless browser with no session, so its images must be inlined, and only
    // bytes that are an allowed image go in (`verifyBytes`). The page is built once this request has the
    // renderer: while it waits it holds no embedded pictures.
    const page = () => renderDocumentHtml({ title, markdown, assetBaseUrl: url.origin, inlineAssets: { documentId: id, verifyBytes: true } });
    try {
      // The renderer is shared between callers: the user the access check has verified, or nobody (anonymous).
      body = new Uint8Array(await renderPdf(page, { signal: req.signal, userId: user?.id }));
    } catch (err) {
      if (err instanceof PdfUnavailableError) {
        console.error("PDF export unavailable:", err.cause);
        return json({ error: err.message }, { status: 503 });
      }
      // The renderer is busy or this render ran too long: nothing is wrong with the request, so it is a 503 too.
      if (err instanceof PdfBusyError) {
        return json({ error: err.message }, { status: 503, headers: err.retryAfter ? { "Retry-After": String(err.retryAfter) } : undefined });
      }
      // The caller went away; nobody reads this answer.
      if (err instanceof PdfCancelledError) return json({ error: err.message }, { status: 499 });
      throw err;
    }
  }

  return new Response(body, {
    headers: {
      "Content-Type": CONTENT_TYPES[format],
      ...(download ? { "Content-Disposition": exportContentDisposition(currentTitle || "", format) } : {}),
      "Cache-Control": "no-store",
    },
  });
});