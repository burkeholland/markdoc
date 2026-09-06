import type { McpActivity } from "@/server/tokens";

/**
 * Read checklist-relevant methods from a clone, leaving the transport's stream untouched.
 * Invalid JSON is handled by the transport and records no activity.
 */
export async function mcpActivityIn(req: Request): Promise<McpActivity[]> {
  if (req.method !== "POST") return [];
  try {
    const body: unknown = await req.clone().json();
    const messages = Array.isArray(body) ? body : [body];
    const out = new Set<McpActivity>();
    for (const m of messages) {
      const method = (m as { method?: unknown } | null)?.method;
      if (method === "tools/list") out.add("list");
      else if (method === "tools/call") out.add("call");
    }
    return Array.from(out);
  } catch {
    return [];
  }
}
