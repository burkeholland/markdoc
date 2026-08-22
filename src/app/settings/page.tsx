import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { auth } from "@/auth";
import { Logo } from "@/components/editor/header";
import { TokensPanel } from "@/components/settings/tokens-panel";

export const metadata = { title: "Settings" };
export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login?next=/settings");
  const origin = process.env.AUTH_URL?.replace(/\/$/, "") ?? "";
  return (
    <main className="min-h-screen bg-surface-2">
      <header className="border-b border-line bg-surface">
        <div className="mx-auto flex h-16 max-w-4xl items-center gap-4 px-6">
          <Link href="/" className="flex items-center gap-2.5">
            <Logo className="h-8 w-8" />
            <span className="text-lg font-semibold text-ink">Markdoc</span>
          </Link>
          <span className="text-ink-4">/</span>
          <span className="text-sm font-medium text-ink-2">Settings</span>
          <Link href="/" className="btn btn-ghost btn-sm ml-auto gap-1.5">
            <ArrowLeft size={14} /> Documents
          </Link>
        </div>
      </header>
      <section className="mx-auto max-w-4xl px-6 py-8">
        <TokensPanel origin={origin} userLogin={session.user.login ?? session.user.name ?? "you"} />
      </section>
    </main>
  );
}
