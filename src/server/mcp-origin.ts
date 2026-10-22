export function httpOrigin(value: string, variable: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${variable} must be an absolute http(s) origin`);
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error(`${variable} must be an http(s) origin without credentials, a path, query, or fragment`);
  }
  return url.origin;
}

/**
 * Public origin of this request (MARKDOC_URL wins). Forwarding headers preserve LAN and tunnel links;
 * the value is never used as a fetch destination.
 */
export function mcpPublicOrigin(req: Request, env?: { MARKDOC_URL?: string }): string {
  const canonical = (env ? env.MARKDOC_URL : process.env.MARKDOC_URL)?.trim();
  if (canonical) return httpOrigin(canonical, "MARKDOC_URL");

  const requestUrl = new URL(req.url);
  const host = (req.headers.get("x-forwarded-host") ?? req.headers.get("host"))?.split(",", 1)[0]?.trim();
  const forwardedProto = req.headers.get("x-forwarded-proto")?.split(",", 1)[0]?.trim().toLowerCase();
  const proto = forwardedProto === "http" || forwardedProto === "https" ? forwardedProto : requestUrl.protocol.slice(0, -1);
  if (!host) return requestUrl.origin;
  try {
    return new URL(`${proto}://${host}`).origin;
  } catch {
    return requestUrl.origin;
  }
}

/** Whether the browser-facing origin is HTTPS, including when TLS terminates at a trusted proxy. */
export function publicRequestUsesHttps(req: Request): boolean {
  return new URL(mcpPublicOrigin(req)).protocol === "https:";
}
