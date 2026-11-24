"use client";

import { useLinkStatus } from "next/link";
import type { ReactNode } from "react";

export function SignInLinkContent({ children }: { children: ReactNode }) {
  const { pending } = useLinkStatus();

  return (
    <>
      {pending ? <span aria-hidden="true">Opening sign-in…</span> : children}
      <span className="sr-only" role="status" aria-live="polite">
        {pending ? "Opening sign-in…" : ""}
      </span>
    </>
  );
}
