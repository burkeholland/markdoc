"use client";

import Link from "next/link";
import { useEffect, useRef } from "react";

export function LandingSignInLink({ id, className, children }: { id: string; className: string; children: React.ReactNode }) {
  const ref = useRef<HTMLAnchorElement>(null);

  useEffect(() => {
    if (window.history.state?.landingSignInFocus === id && document.activeElement === document.body) {
      ref.current?.focus({ preventScroll: true });
    }
  }, [id]);

  return (
    <Link
      ref={ref}
      href="/login"
      className={className}
      onNavigate={() => {
        const state = { ...window.history.state };
        if (document.activeElement === ref.current) {
          state.landingSignInFocus = id;
        } else {
          delete state.landingSignInFocus;
        }
        window.history.replaceState(state, "");
      }}
    >
      {children}
    </Link>
  );
}
