"use client";

import type { CSSProperties } from "react";

// Last resort for an error thrown by the root layout itself (Next uses it in production builds only). The
// layout — and with it globals.css, Tailwind and the fonts — is gone when this shows, so it renders its own
// <html>/<body> with inline styles. Colours go through custom properties so the one <style> block can switch
// them on the OS preference (no theme boot script has run); the values are globals.css's light/dark palette.
// Same copy, actions and test ids as error.tsx; React and Next already log the error once — no logging here.

const PALETTE = `:root { --bg: #f7f5f0; --ink: #1c1917; --ink-2: #44403c; --ink-3: #57534e; --accent: #0f766e; --on-accent: #ffffff; }
@media (prefers-color-scheme: dark) {
  :root { --bg: #1c1f24; --ink: #e7e5e4; --ink-2: #d6d3d1; --ink-3: #a8a29e; --accent: #2dd4bf; --on-accent: #14161a; }
}`;

const body: CSSProperties = {
  margin: 0, minHeight: "100vh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
  padding: "1rem", background: "var(--bg)", color: "var(--ink)", textAlign: "center",
  fontFamily: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
};
const column: CSSProperties = { width: "100%", maxWidth: "28rem" };
const eyebrow: CSSProperties = { margin: 0, fontSize: "0.75rem", fontWeight: 600, letterSpacing: "0.05em", textTransform: "uppercase", color: "var(--ink-3)" };
const heading: CSSProperties = { margin: "0.5rem 0 0", fontSize: "1.5rem", fontWeight: 600 };
const text: CSSProperties = { margin: "0.5rem auto 0", fontSize: "0.875rem", color: "var(--ink-3)" };
const actions: CSSProperties = { display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "center", gap: "0.75rem", marginTop: "1.5rem" };
const action: CSSProperties = {
  display: "inline-flex", alignItems: "center", minHeight: "2.5rem", padding: "0 0.875rem", border: 0, borderRadius: "0.375rem",
  font: "inherit", fontSize: "0.875rem", fontWeight: 500, textDecoration: "none", cursor: "pointer",
};
const primary: CSSProperties = { ...action, background: "var(--accent)", color: "var(--on-accent)" };
const ghost: CSSProperties = { ...action, background: "transparent", color: "var(--ink-2)" };
const details: CSSProperties = { marginTop: "1.5rem", fontSize: "0.75rem", textAlign: "left", color: "var(--ink-3)" };
const pre: CSSProperties = { margin: "0.25rem 0 0", whiteSpace: "pre-wrap", overflowWrap: "break-word", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" };

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en">
      <body style={body}>
        <style>{PALETTE}</style>
        <main style={column} data-testid="app-error">
          <p style={eyebrow}>Error</p>
          <h1 style={heading}>Something went wrong</h1>
          <p style={text}>Markdoc couldn&apos;t show this page. Try again, or go back to your documents.</p>
          <div style={actions}>
            <button type="button" style={primary} onClick={reset}>Try again</button>
            {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- keeps next/link out of every route's shared chunk (#1485) */}
            <a href="/" style={ghost}>Back to your documents</a>
          </div>
          <details style={details}>
            <summary>Details</summary>
            {error.digest ? <p data-testid="app-error-digest">Reference: {error.digest}</p> : null}
            {error.message ? <pre style={pre}>{error.message}</pre> : null}
          </details>
        </main>
      </body>
    </html>
  );
}
