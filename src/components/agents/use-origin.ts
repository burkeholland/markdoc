"use client";

import { useEffect, useState } from "react";

/** The browser's origin after hydration; `fallback` (the server's public origin) until then. LAN and tunnel visits win over the configured origin. */
export function useOrigin(fallback = ""): string {
  const [origin, setOrigin] = useState(fallback);
  useEffect(() => {
    if (window.location.origin) setOrigin(window.location.origin);
  }, []);
  return origin;
}
