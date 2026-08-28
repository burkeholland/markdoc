import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/server/db";
import { consumeHandoff, type HandoffFailure } from "@/server/embed-handoff";
import { handler, HttpError } from "@/server/http";
import { mcpPublicOrigin } from "@/server/mcp-origin";
import { mintSessionCookie } from "@/server/session-cookie";

type Params = { params: Promise<{ nonce: string }> };

const GONE: Record<HandoffFailure, string> = {
  unknown: "This link is not valid. Ask the agent to open the document again.",
  expired: "This link has expired (it was valid for 60 s). Ask the agent to open the document again.",
  used: "This link was already used. Ask the agent to open the document again.",
};

/** Auth.js uses the `__Secure-` cookie when the site is served over https (directly or behind a proxy). */
function servedOverHttps(req: Request): boolean {
  const forwarded = req.headers.get("x-forwarded-proto")?.split(",", 1)[0]?.trim().toLowerCase();
  if (forwarded) return forwarded === "https";
  return new URL(req.url).protocol === "https:";
}

/**
 * Spend a handoff nonce from `POST /api/embed/handoff`: set the normal session cookie for the user
 * the token belonged to and redirect to `/d/:id?embed=1`. Valid once and for 60 s; anything else is
 * `410`. No other way in: the nonce carries no document or user from the caller, both come from the
 * token that minted it.
 */
export const GET = handler(async (req: Request, { params }: Params) => {
  const { nonce } = await params;
  const result = consumeHandoff(nonce);
  if (!result.ok) throw new HttpError(410, GONE[result.reason], { reason: result.reason });
  const db = await getDb();
  const [user] = await db.select().from(schema.users).where(eq(schema.users.id, result.handoff.userId));
  if (!user) throw new HttpError(410, GONE.unknown, { reason: "unknown" });
  const cookie = await mintSessionCookie({ id: user.id, login: user.login ?? null, name: user.name ?? null, email: user.email ?? null, image: user.image ?? null }, servedOverHttps(req));
  const res = NextResponse.redirect(`${mcpPublicOrigin(req)}/d/${result.handoff.documentId}?embed=1`, { status: 302 });
  res.cookies.set(cookie);
  res.headers.set("Cache-Control", "no-store");
  return res;
});

export const dynamic = "force-dynamic";
