import { NextResponse } from "next/server";
import { consumeHandoff, type HandoffFailure } from "@/server/embed-handoff";
import { handler, HttpError, tokenAllowsDocument } from "@/server/http";
import { mcpPublicOrigin, publicRequestUsesHttps } from "@/server/mcp-origin";
import { mintSessionCookie } from "@/server/session-cookie";
import { resolveApiTokenById } from "@/server/tokens";

type Params = { params: Promise<{ nonce: string }> };

const GONE: Record<HandoffFailure, string> = {
  unknown: "This link is not valid. Ask the agent to open the document again.",
  expired: "This link has expired (it was valid for 60 s). Ask the agent to open the document again.",
  used: "This link was already used. Ask the agent to open the document again.",
};

/**
 * Spend a handoff nonce from `POST /api/embed/handoff`: set an isolated embed cookie for the user
 * the token belonged to and redirect to `/d/:id?embed=1`. Valid once and for 60 s; anything else is
 * `410`. No other way in: the nonce carries no document or user from the caller, both come from the
 * token that minted it.
 */
export const GET = handler(async (req: Request, { params }: Params) => {
  const { nonce } = await params;
  if (req.headers.get("sec-fetch-dest") !== "iframe") {
    throw new HttpError(403, "This handoff must be opened by the Markdoc canvas", { reason: "frame" });
  }
  let parentOrigin: string;
  try {
    parentOrigin = new URL(req.headers.get("referer") ?? "").origin;
  } catch {
    throw new HttpError(403, "The Markdoc canvas origin is missing", { reason: "frame" });
  }
  const result = consumeHandoff(nonce, parentOrigin);
  if (!result.ok) throw new HttpError(410, GONE[result.reason], { reason: result.reason });
  const user = await resolveApiTokenById(result.handoff.tokenId);
  if (!user || user.id !== result.handoff.userId || !tokenAllowsDocument(user, result.handoff.documentId)) {
    throw new HttpError(410, GONE.unknown, { reason: "unknown" });
  }
  const cookie = await mintSessionCookie(
    {
      id: user.id,
      login: user.login,
      name: user.name ?? null,
      image: user.image ?? null,
      embedTokenId: user.tokenId,
      embedDocumentId: result.handoff.documentId,
      embedParentOrigin: result.handoff.parentOrigin,
    },
    publicRequestUsesHttps(req),
  );
  const res = NextResponse.redirect(`${mcpPublicOrigin(req)}/d/${result.handoff.documentId}?embed=1`, { status: 302 });
  res.cookies.set(cookie);
  res.headers.set("Cache-Control", "no-store");
  return res;
});

export const dynamic = "force-dynamic";
