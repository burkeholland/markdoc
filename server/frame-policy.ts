import type { EmbedSessionClaims } from "@/server/session-cookie";

export const FRAME_ANCESTORS_NONE = "frame-ancestors 'none'";

/** Only HTML page responses receive the baseline frame policy. */
export function framePolicyApplies(pathname: string): boolean {
  return pathname !== "/api"
    && !pathname.startsWith("/api/")
    && !pathname.startsWith("/embed/")
    && !pathname.startsWith("/_next/static")
    && !pathname.startsWith("/_next/image")
    && !pathname.startsWith("/favicon.ico");
}

/** Resolve the frame policy without reading cookies or mutating the response. */
export function frameAncestorsPolicy(url: URL, embed: EmbedSessionClaims | null, now: number): string | null {
  if (!framePolicyApplies(url.pathname)) return null;
  const isEmbeddedDocument = embed
    && embed.expiresAt > now
    && url.pathname === `/d/${embed.documentId}`
    && url.searchParams.get("embed") === "1";
  return isEmbeddedDocument ? `frame-ancestors ${embed.parentOrigin}` : FRAME_ANCESTORS_NONE;
}
