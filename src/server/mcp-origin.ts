type McpOriginEnv = Partial<Pick<NodeJS.ProcessEnv, "MARKDOC_INTERNAL_URL" | "MARKDOC_URL" | "NODE_ENV" | "PORT">>;

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
 * Destination for token-bearing REST calls made by the remote MCP route. Only process
 * configuration may select it; the request URL and forwarding headers are deliberately absent.
 */
export function mcpRestOrigin(env: McpOriginEnv = process.env): string {
  const internal = env.MARKDOC_INTERNAL_URL?.trim();
  if (internal) return httpOrigin(internal, "MARKDOC_INTERNAL_URL");

  const canonical = env.MARKDOC_URL?.trim();
  if (canonical) return httpOrigin(canonical, "MARKDOC_URL");

  const portText = env.PORT?.trim() || "3000";
  if (!/^\d+$/.test(portText)) throw new Error("PORT must be an integer from 1 to 65535");
  const port = Number(portText);
  if (port < 1 || port > 65535) throw new Error("PORT must be an integer from 1 to 65535");
  return `http://127.0.0.1:${port}`;
}

/**
 * Public origin included in MCP tool output. Forwarding headers preserve LAN and tunnel links, but
 * this value is kept separate from `mcpRestOrigin` and is never used as a fetch destination.
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
