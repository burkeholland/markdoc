"use client";

import { useEffect, useState } from "react";

let cached: Promise<string> | null = null;

/** The MCP server URL from `GET /api/agent/mcp-url` (runtime config); "" until it loads. */
export function useMcpUrl(): string {
  const [url, setUrl] = useState("");
  useEffect(() => {
    let live = true;
    cached ??= fetch("/api/agent/mcp-url", { cache: "no-store" })
      .then((r) => (r.ok ? (r.json() as Promise<{ url: string }>) : Promise.reject(new Error(String(r.status)))))
      .then((b) => b.url)
      .catch((e) => {
        cached = null;
        throw e;
      });
    cached.then((u) => live && setUrl(u)).catch(() => {});
    return () => {
      live = false;
    };
  }, []);
  return url;
}

/** Tests: forget the cached URL. */
export function resetMcpUrlCache() {
  cached = null;
}
