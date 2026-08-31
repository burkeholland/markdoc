import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowRight, MessageSquare, Sparkles, Users, GitBranch, History, Columns2 } from "lucide-react";
import { cookies } from "next/headers";
import { auth, githubConfigured } from "@/auth";
import { Wordmark } from "@/components/ui/logo";
import { GitHubIcon } from "@/components/ui/github-icon";
import { Dashboard } from "@/components/dashboard/dashboard";
import { getGitHubToken, listDocumentsForUser } from "@/server/documents";
import { DEFAULT_DASHBOARD_SORT, SORT_COOKIE, isDashboardSort } from "@/lib/dashboard-sort";
import { embeddedDocumentPath } from "@/server/http";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const session = await auth();
  const embedPath = await embeddedDocumentPath(session?.user?.id);
  if (embedPath) redirect(embedPath);
  if (session?.user?.id) {
    const user = { id: session.user.id, login: session.user.login ?? null, name: session.user.name ?? null, image: session.user.image ?? null };
    const [docs, token, cookieStore] = await Promise.all([listDocumentsForUser(user), getGitHubToken(user.id), cookies()]);
    // The saved sort travels in a cookie so the server renders the cards in that order (#165).
    const savedSort = cookieStore.get(SORT_COOKIE)?.value;
    return (
      <Dashboard
        user={{ id: user.id, name: user.name ?? user.login ?? "You", login: user.login, image: user.image }}
        documents={docs.map((d) => ({ ...d, updatedAt: d.updatedAt.toISOString(), createdAt: d.createdAt.toISOString(), lastOpenedAt: d.lastOpenedAt?.toISOString() ?? null, deletedAt: null }))}
        githubAvailable={!!token}
        githubConfigured={githubConfigured}
        initialSort={isDashboardSort(savedSort) ? savedSort : DEFAULT_DASHBOARD_SORT}
      />
    );
  }
  return <Landing />;
}

function Feature({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-line bg-surface p-5">
      <div className="mb-3 inline-flex h-9 w-9 items-center justify-center rounded-lg bg-accent-soft text-accent">{icon}</div>
      <h3 className="text-[15px] font-semibold text-ink">{title}</h3>
      <p className="mt-1 text-sm leading-6 text-ink-3">{children}</p>
    </div>
  );
}

function Landing() {
  return (
    <main className="min-h-screen bg-surface-2">
      <header className="app-header mx-auto flex max-w-6xl items-center justify-between px-6 py-5">
        <Wordmark />
        <Link href="/login" className="btn btn-primary gap-2">
          <GitHubIcon size={16} /> Sign in with GitHub
        </Link>
      </header>
      <section className="mx-auto max-w-6xl px-6 pb-16 pt-12">
        <div className="max-w-2xl">
          <h1 className="hero-title text-4xl font-bold leading-tight tracking-tight text-ink sm:text-5xl">Markdown, together.</h1>
          <p className="mt-3 text-xl leading-8 text-ink-2">A shared editor for Markdown — source and preview side by side, live for everyone.</p>
          <p className="mt-5 text-lg leading-8 text-ink-3">
            Edit the source or the rendered page; both update for everyone at once. Review with comments and suggestions, keep every version, and publish
            straight to a gist or a repository.
          </p>
          <div className="mt-8 flex flex-wrap items-center gap-3">
            <Link href="/login" className="btn btn-primary h-11 gap-2 px-5 text-base">
              Get started <ArrowRight size={18} />
            </Link>
            <span className="text-sm text-ink-3">Free while in preview · GitHub account required</span>
          </div>
        </div>
        <div className="mt-14 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Feature icon={<Columns2 size={18} />} title="Two surfaces, one document">
            A code editor and a rich preview side by side. Type in either one; the other follows instantly, cursors included.
          </Feature>
          <Feature icon={<Users size={18} />} title="Real-time collaboration">
            Presence, live carets and selections, conflict-free merging on both surfaces. Works offline and catches up when you reconnect.
          </Feature>
          <Feature icon={<MessageSquare size={18} />} title="Comments that stick">
            Anchor threads to text; they follow the words as the document changes. Reply, resolve, and reopen.
          </Feature>
          <Feature icon={<Sparkles size={18} />} title="Suggesting mode">
            Propose edits as tracked changes. Owners accept or reject each one, or all at once.
          </Feature>
          <Feature icon={<History size={18} />} title="Version history">
            Automatic snapshots while you work, named versions when it matters, word-level diffs, one-click restore.
          </Feature>
          <Feature icon={<GitBranch size={18} />} title="GitHub-native storage">
            Open any Markdown file from a gist or repository. Publishing creates a real commit on the branch you choose.
          </Feature>
        </div>
      </section>
    </main>
  );
}
