import { handler, requireAccess, json, HttpError } from "@/server/http";
import { readLiveText } from "@/server/livedoc";
import { renderDocumentHtml } from "@/server/export/html";
import { renderPdf, PdfUnavailableError } from "@/server/export/pdf";

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
  const { doc } = await requireAccess(id, "view");
  const url = new URL(req.url);
  const live = await readLiveText(id);
  const markdown = url.searchParams.get("suggestions") === "1" ? live.text : live.clean;
  const filename = (doc.title || "document").replace(/[^\w\- ]+/g, "").trim() || "document";
  const download = url.searchParams.get("download") === "1";
  const format = parseFormat(url.searchParams.get("format"));
  const title = live.title || doc.title || "Document";

  let body: BodyInit;
  if (format === "md") {
    body = markdown;
  } else {
    // PDF rendering happens in a headless browser with no session, so its images must be inlined.
    const html = await renderDocumentHtml({ title, markdown, assetBaseUrl: url.origin, inlineAssets: download || format === "pdf" });
    if (format === "html") {
      body = html;
    } else {
      try {
        body = new Uint8Array(await renderPdf(html));
      } catch (err) {
        if (err instanceof PdfUnavailableError) {
          console.error("PDF export unavailable:", err.cause);
          return json({ error: err.message }, { status: 503 });
        }
        throw err;
      }
    }
  }

  return new Response(body, {
    headers: {
      "Content-Type": CONTENT_TYPES[format],
      ...(download ? { "Content-Disposition": `attachment; filename="${filename}.${format}"` } : {}),
      "Cache-Control": "no-store",
    },
  });
});