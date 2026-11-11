"use client";

import { signOut } from "next-auth/react";

export function SignOutButton({ callbackUrl }: { callbackUrl: string }) {
  return (
    <button type="button" className="btn btn-danger h-11 w-full" onClick={() => void signOut({ redirectTo: callbackUrl })}>
      Sign out
    </button>
  );
}
