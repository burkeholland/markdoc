"use client";

import { useState } from "react";
import { usePathname } from "next/navigation";
import { shareReturnPath } from "@/lib/share-target";

type Status = "idle" | "sending" | "sent" | "error";

/**
 * The same unavailable-resource screen for missing and inaccessible documents or folders.
 */
export function NoAccess({ resource = "document" }: { resource?: "document" | "folder" }) {
  const pathname = usePathname() ?? "";
  const id = (resource === "folder" ? /^\/f\/([^/]+)/ : /^\/d\/([^/]+)/).exec(pathname)?.[1] ?? null;
  const [status, setStatus] = useState<Status>("idle");

  const requestAccess = async () => {
    if (!id || status === "sending" || status === "sent") return;
    setStatus("sending");
    try {
      const res = await fetch(`/api/${resource === "folder" ? "folders" : "documents"}/${id}/access-request`, { method: "POST" });
      setStatus(res.ok ? "sent" : "error");
    } catch {
      setStatus("error");
    }
  };

  const switchAccount = () => {
    const next = shareReturnPath(pathname, Object.fromEntries(new URL(window.location.href).searchParams));
    // Loaded on the click: this screen is the document route's not-found boundary, so a static import puts
    // the sign-out flow's offline store (y-indexeddb, Yjs: ≈ 119 kB) in every document page's first paint.
    void import("@/lib/sign-out").then((m) => m.signOutSafely(`/login?next=${encodeURIComponent(next)}`));
  };

  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-surface-2 px-4 py-4 text-center" data-testid="no-access">
      <p className="text-xs font-semibold uppercase tracking-wider text-ink-3">No access</p>
      <h1 className="mt-2 text-2xl font-semibold text-ink">You can&apos;t open this {resource}</h1>
      <p className="mt-2 max-w-sm text-sm text-ink-3">
        It doesn&apos;t exist, or it hasn&apos;t been shared with you. Ask the owner for access, or switch to an account that has it.
      </p>
      <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
        {id && (
          <button type="button" className="btn btn-primary" onClick={requestAccess} disabled={status === "sending" || status === "sent"} data-testid="no-access-request">
            {status === "sent" ? "Request sent" : status === "sending" ? "Requesting…" : "Request access"}
          </button>
        )}
        <button type="button" className="btn btn-outline" onClick={switchAccount} data-testid="no-access-switch">
          Switch account
        </button>
      </div>
      <p className="mt-3 min-h-5 text-sm text-ink-3" role="status" data-testid="no-access-status">
        {status === "sent" && `If this ${resource} exists, its owner has been notified.`}
        {status === "error" && "Could not send the request. Try again."}
      </p>
      {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- keeps next/link out of the shared chunk (#1485) */}
      <a href="/" className="mt-4 text-sm font-medium text-accent hover:underline" data-testid="no-access-documents">
        ← Back to Documents
      </a>
    </main>
  );
}
