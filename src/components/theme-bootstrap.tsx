"use client";

import { useLayoutEffect, useRef } from "react";
import { useServerInsertedHTML } from "next/navigation";
import { applyTheme, readThemePreference, THEME_BOOT_SCRIPT } from "@/lib/theme";

// The phase-1 look switch (`?brand=a|b`, task #398) is gone; a stored choice from then is dropped so it never lingers.
const BRAND_CLEANUP_SCRIPT = `(function(){try{localStorage.removeItem("markdoc:brand");}catch(e){}})();`;

export function ThemeBootstrap() {
  const inserted = useRef(false);
  useServerInsertedHTML(() => {
    if (inserted.current) return null;
    inserted.current = true;
    // Keep the parser-blocking script out of React's client-rendered recovery tree.
    return <script dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT + BRAND_CLEANUP_SCRIPT }} />;
  });

  useLayoutEffect(() => {
    // notFound() recovery can replace <html>, losing the attribute set before hydration.
    applyTheme(readThemePreference());
    try { localStorage.removeItem("markdoc:brand"); } catch {}
  }, []);

  return null;
}
