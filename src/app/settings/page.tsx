import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { auth } from "@/auth";
import { Logo } from "@/components/ui/logo";
import { AdvancedSettings } from "@/components/settings/advanced-settings";
import { AgentsPanel } from "@/components/settings/agents-panel";
import { LinkCardsSetting } from "@/components/settings/link-cards-setting";
import { ThemePicker } from "@/components/ui/theme-toggle";
import { embeddedDocumentPath } from "@/server/http";
import { publicOrigin } from "@/server/public-origin";
import { listApiTokens, serializeApiTokenMetadata } from "@/server/tokens";

export const metadata = { title: "Settings" };
export const dynamic = "force-dynamic";

export default async function SettingsPage({ searchParams }: { searchParams: Promise<{ next?: string | string[] }> }) {
  const session = await auth();
  const embedPath = await embeddedDocumentPath(session?.user?.id);
  if (embedPath) redirect(embedPath);
  if (!session?.user?.id) redirect("/login?next=/settings");
  const origin = publicOrigin();
  const rawNext = (await searchParams).next;
  const nextParam = Array.isArray(rawNext) ? rawNext[0] : rawNext;
  // Only relative document paths: never bounce the user off-site.
  const next = nextParam && /^\/d\/[a-z0-9]+$/i.test(nextParam) ? nextParam : null;
  const tokens = (await listApiTokens(session.user.id)).map(serializeApiTokenMetadata);
  return (
    <main className="min-h-screen bg-surface-2">
      <header className="border-b border-line bg-surface">
        <div className="mx-auto flex h-16 max-w-4xl items-center gap-2 px-3 min-[390px]:gap-4 min-[390px]:px-6">
          <Link href="/" className="flex items-center gap-2.5">
            <Logo className="h-8 w-8" />
            <span className="sr-only text-lg font-semibold text-ink min-[390px]:not-sr-only">Markdoc</span>
          </Link>
          <span className="hidden text-ink-4 min-[390px]:inline">/</span>
          <span className="text-sm font-medium text-ink-2">Settings</span>
          <Link href="/" className="btn btn-ghost btn-sm ml-auto shrink-0 gap-1.5">
            <ArrowLeft size={14} /> Documents
          </Link>
        </div>
      </header>
      <section className="mx-auto max-w-4xl px-6 py-8">
        <div className="mb-8 flex flex-col items-start gap-4 rounded-2xl border border-line bg-surface px-5 py-4 sm:flex-row sm:items-center sm:justify-between sm:gap-6" data-testid="theme-row">
          <div>
            <h2 className="text-base font-semibold text-ink">Theme</h2>
            <p className="mt-0.5 text-sm text-ink-3" data-testid="theme-description">System follows your operating system; the choice is saved in this browser.</p>
          </div>
          <ThemePicker />
        </div>
        <LinkCardsSetting />
        <AgentsPanel origin={origin} userLogin={session.user.login ?? session.user.name ?? "you"} next={next} initialTokens={tokens} />
        <div className="mt-6">
          <AdvancedSettings />
        </div>
      </section>
    </main>
  );
}
