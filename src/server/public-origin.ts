import { httpOrigin } from "@/server/mcp-origin";

/** The variables `publicOrigin` reads. `process.env` qualifies as-is; tests pass a literal. */
type PublicOriginEnv = Partial<Pick<NodeJS.ProcessEnv, "AUTH_URL" | "MARKDOC_URL" | "PORT">> & { readonly [key: string]: string | undefined };

const DEFAULT_PORT = 3000;

/** `value` as a bare http(s) origin (no trailing slash), or null when unset or unusable. Never throws. */
function originFrom(value: string | undefined, variable: "AUTH_URL" | "MARKDOC_URL"): string | null {
  const text = value?.trim();
  if (!text) return null;
  try {
    return httpOrigin(text, variable);
  } catch {
    // Only the name: the value may be a secret-bearing mistake and must never reach a log.
    console.warn(`[public-origin] ${variable} is not an http(s) origin; ignoring it for absolute URLs`);
    return null;
  }
}

/**
 * The origin browsers reach Markdoc at, for absolute URLs the server has to build itself, such as
 * link-preview images. Precedence: `MARKDOC_URL` (the canonical origin, as for MCP tool output) →
 * `AUTH_URL` (set in production) → the development listener, `http://localhost:${PORT ?? 3000}`.
 * Unusable values are skipped rather than thrown: the root layout calls this at import time and a
 * bad env var must not take the server down.
 */
export function publicOrigin(env: PublicOriginEnv = process.env): string {
  return originFrom(env.MARKDOC_URL, "MARKDOC_URL") ?? originFrom(env.AUTH_URL, "AUTH_URL") ?? `http://localhost:${devPort(env.PORT)}`;
}

function devPort(value: string | undefined): number {
  const text = value?.trim();
  if (!text || !/^\d+$/.test(text)) return DEFAULT_PORT;
  const port = Number(text);
  return port >= 1 && port <= 65535 ? port : DEFAULT_PORT;
}
