import { headers } from "next/headers";
import { getDocumentAccess } from "@/server/documents";
import { handler, HttpError, json, tokenAllowsDocument } from "@/server/http";
import { publicRequestUsesHttps } from "@/server/mcp-origin";
import { decodeEmbedSession, EMBED_SESSION_MAX_AGE_S, mintSessionCookie } from "@/server/session-cookie";
import { resolveApiTokenById } from "@/server/tokens";

const SESSION_TTL_MS = EMBED_SESSION_MAX_AGE_S * 1000;

/** Renew an active canvas session while its backing API token and document access remain valid. */
export const POST = handler(async (req: Request) => {
  const claims = await decodeEmbedSession((await headers()).get("cookie"));
  if (!claims) {
    throw new HttpError(401, "The embedded session has expired", { reason: "embed_session_expired" });
  }
  const user = await resolveApiTokenById(claims.tokenId);
  const access =
    user && user.id === claims.userId && tokenAllowsDocument(user, claims.documentId)
      ? await getDocumentAccess(claims.documentId, user)
      : null;
  if (!user || !access) {
    throw new HttpError(401, "The embedded session no longer has access", { reason: "embed_access_revoked" });
  }
  const cookie = await mintSessionCookie(
    {
      id: user.id,
      login: user.login,
      name: user.name ?? null,
      image: user.image ?? null,
      embedTokenId: user.tokenId,
      embedDocumentId: claims.documentId,
      embedParentOrigin: claims.parentOrigin,
    },
    publicRequestUsesHttps(req),
  );
  const expiresAt = Date.now() + SESSION_TTL_MS;
  const response = json({ expiresAt: new Date(expiresAt).toISOString(), ttlMs: SESSION_TTL_MS });
  response.cookies.set(cookie);
  response.headers.set("Cache-Control", "no-store");
  return response;
});

export const dynamic = "force-dynamic";
