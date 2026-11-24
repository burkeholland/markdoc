"use client";

import { useLinkStatus } from "next/link";
import type { ReactNode } from "react";

export function SignInLinkContent({ children }: { children: ReactNode }) {
  const { pending } = useLinkStatus();

  return (
    <>
      <span className={pending ? "hidden" : "contents"}>{children}</span>
      <span aria-hidden="true" className={pending ? "" : "hidden"}>Opening sign-in…</span>
      <span className="sr-only" role="status" aria-live="polite">
        {pending ? "Opening sign-in…" : ""}
      </span>
    </>
  );
}
