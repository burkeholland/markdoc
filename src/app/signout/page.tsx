import type { Metadata } from "next";
import { cookies } from "next/headers";
import { Logo } from "@/components/ui/logo";
import { SignOutButton } from "./sign-out-button";

export const metadata: Metadata = { title: "Sign out" };

export default async function SignOutPage() {
  const callbackUrl = (await cookies()).getAll().find(({ name }) => name.endsWith("authjs.callback-url"))?.value ?? "/";

  return (
    <main className="flex min-h-screen items-center justify-center bg-surface-2 px-4 py-4">
      <div className="w-full max-w-sm rounded-2xl border border-line bg-surface p-6 shadow-xl shadow-black/5 sm:p-8" data-testid="signout-card">
        <div className="mb-4 flex items-center gap-3">
          <Logo className="h-9 w-9" />
          <h1 className="text-xl font-semibold text-ink">Are you sure you want to sign out?</h1>
        </div>
        <SignOutButton callbackUrl={callbackUrl} />
      </div>
    </main>
  );
}
