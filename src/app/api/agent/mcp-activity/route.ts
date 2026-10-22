import { z } from "zod";
import { handler, json, HttpError, readJson, requireUser } from "@/server/http";
import { recordMcpActivity } from "@/server/tokens";

/**
 * Called by the MCP server (burkeholland/markdoc-mcp) with the agent's own token after a JSON-RPC
 * message: `list` when a client ran `tools/list` (connected), `call` for `tools/call` (working). The
 * Settings checklist reads these. Token-only: a browser session has no MCP client to report.
 */
const Body = z.object({ kinds: z.array(z.enum(["list", "call"])).min(1).max(2) });

export const POST = handler(async (req: Request) => {
  const user = await requireUser();
  if (!user.tokenId) throw new HttpError(403, "MCP activity is reported with an API token");
  const { kinds } = await readJson(req, (d) => Body.parse(d));
  for (const kind of new Set(kinds)) await recordMcpActivity(user.tokenId, kind);
  return json({ ok: true });
});
