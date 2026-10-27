import { handler, requireUser } from "@/server/http";
import { exportAllDocuments, requireBrowserSession } from "@/server/account";

/** Download every non-trashed document the signed-in user owns, as a zip of Markdown files (folders as directories). */
export const GET = handler(async () => {
  const user = await requireUser();
  requireBrowserSession(user, "export an account");
  const { zip } = await exportAllDocuments(user.id);
  const date = new Date().toISOString().slice(0, 10);
  return new Response(new Uint8Array(zip), {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="markdoc-export-${date}.zip"`,
      "Cache-Control": "no-store",
    },
  });
});
