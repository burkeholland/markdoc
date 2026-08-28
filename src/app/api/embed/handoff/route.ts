import { z } from "zod";
import { handler, json, readJson, requireAccess, HttpError } from "@/server/http";
import { createHandoff, HANDOFF_TTL_MS } from "@/server/embed-handoff";
import { mcpPublicOrigin } from "@/server/mcp-origin";

const schema = z.object({
  documentId: z.string().min(1).max(64),
});

/**
 * Mint a one-time URL that signs a browser in as the token's user and opens one document. For hosts
 * that render Markdoc in a panel where GitHub OAuth cannot run (the Copilot app canvas): the
 * extension calls this with its token, then hands `url` to the panel. Token-only; the token must be
 * able to see the document (a document outside its list is `404`). The nonce is valid once and for
 * 60 s (`GET /embed/:nonce` → `410` afterwards). Spends the token's write budget like other routes.
 */
export const POST = handler(async (req: Request) => {
  const { documentId } = await readJson(req, (d) => schema.parse(d));
  const { user } = await requireAccess(documentId, "view");
  if (!user?.agent) throw new HttpError(403, "This endpoint is for API tokens (agents). Create one at /settings");
  const { nonce, expiresAt } = createHandoff(user.id, documentId);
  const url = `${mcpPublicOrigin(req)}/embed/${nonce}`;
  return json({ url, documentId, expiresAt: new Date(expiresAt).toISOString(), ttlMs: HANDOFF_TTL_MS }, { status: 201 });
});

export const dynamic = "force-dynamic";
