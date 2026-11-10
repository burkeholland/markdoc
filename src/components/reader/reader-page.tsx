import Link from "next/link";
import { PenLine } from "lucide-react";
import { Logo } from "@/components/ui/logo";
import { Avatar } from "@/components/ui/display";
import { RelativeTime } from "@/components/ui/relative-time";
import type { RenderedHeading } from "@/server/export/html";
import { ReaderToc } from "./toc";
import { UpdatePill } from "./update-pill";
import { DownloadMenu } from "./download-menu";
import { ReaderScrollableRegions } from "./scrollable-regions";
import { ReaderCopyLink } from "./copy-link";
import { ReaderLinkCards } from "./link-cards";
import { ReaderBody } from "./reader-body";
import { stashReaderBody } from "./reader-body-handoff";

export interface ReaderPageProps {
  docId: string;
  title: string;
  /** Sanitized HTML fragment from renderMarkdownBody. */
  html: string;
  headings: RenderedHeading[];
  initialHash: string;
  updatedAt: string;
  /** Reading time in minutes (computeStats); 0 hides the label. */
  readingMinutes?: number;
  owner: { name: string; image: string | null } | null;
  signedIn: boolean;
  signInReturnPath?: string;
  canOpenEditor: boolean;
  pollMs: number;
}

/** Read-only presentation of a document: minimal chrome, the article, and a table of contents. */
export function ReaderPage({ docId, title, html, headings, initialHash, updatedAt, readingMinutes = 0, owner, signedIn, signInReturnPath, canOpenEditor, pollMs }: ReaderPageProps) {
  const toc = headings.filter((h) => h.level === 2 || h.level === 3);
  const signInHref = signInReturnPath ? `/login?next=${encodeURIComponent(signInReturnPath)}` : "/login";
  // Titles usually come from the first h1; do not show it twice.
  const hideFirstH1 = headings[0]?.level === 1 && headings[0].text.trim() === title.trim() && html.startsWith("<h1 ");
  return (
    <div className="reader flex min-h-screen flex-col bg-surface text-ink" data-testid="reader">
      {/* First Tab stop: the aside (one TOC entry per heading) precedes the article in the DOM on every screen
          size (#1495), so keyboard and screen-reader users get a way past it. Same class as the editor's link. */}
      <a href="#reader-article" className="skip-link" data-testid="reader-skip-link">
        Skip to article
      </a>
      <header className="reader-chrome sticky top-0 z-10 flex h-14 shrink-0 items-center gap-3 border-b border-line bg-surface/90 px-4 backdrop-blur" data-testid="reader-header">
        <Link href={signedIn ? "/" : signInHref} className="icon-btn h-9 w-9 shrink-0 tap-target relative" aria-label={signedIn ? "All documents" : "Sign in to Markdoc"}>
          <Logo className="h-7 w-7" />
        </Link>
        <a
          href="#reader-article"
          title={title}
          className="min-w-0 flex-1 truncate text-sm font-medium text-ink transition-colors hover:text-accent"
          data-testid="reader-header-title"
        >
          {title}
        </a>
        <div className="flex shrink-0 items-center gap-2">
          {canOpenEditor && (
            <Link href={`/d/${docId}`} className="btn btn-sm btn-outline gap-1.5 tap-target relative" data-testid="open-in-editor">
              <PenLine size={14} />
              <span className="hidden sm:inline">Open in editor</span>
              <span className="sm:hidden">Edit</span>
            </Link>
          )}
          <ReaderCopyLink docId={docId} />
          <DownloadMenu docId={docId} />
        </div>
      </header>

      <UpdatePill docId={docId} initialHash={initialHash} pollMs={pollMs} />

      <main className="reader-layout mx-auto flex w-full max-w-[1180px] flex-1 flex-col gap-6 px-5 py-8 sm:px-8 lg:flex-row lg:gap-14 lg:py-12">
        {/* The aside precedes the article in the DOM so the phone's "Contents" button, which sits above the article,
            is in place before the streamed article paints (a trailing `order-first` aside pushed it down 62 px, #1470);
            wide screens keep the TOC as the right column with `lg:order-last`. */}
        {toc.length > 0 && (
          <aside className="reader-aside lg:order-last lg:w-56 lg:shrink-0" data-testid="reader-aside">
            <ReaderToc headings={toc} />
          </aside>
        )}
        {/* The skip link's target: tabIndex -1 so Chromium moves focus here too (a fragment alone only scrolls);
            the scroll margin keeps the title out from under the sticky header, like the headings' 88 px. No ring:
            a click in the text focuses the article too, and the first PageDown after it would frame the whole column. */}
        <article className="reader-article min-w-0 flex-1 scroll-mt-[88px] focus-visible:outline-none" id="reader-article" tabIndex={-1} data-testid="reader-article">
          <header className="mb-8 border-b border-line pb-6">
            <h1 className="reader-title wrap-anywhere text-[2.25rem] font-bold leading-tight tracking-tight text-ink" data-testid="reader-title">
              {title}
            </h1>
            <div className="mt-3 flex min-w-0 flex-wrap items-center gap-2 wrap-anywhere text-sm text-ink-3" data-testid="reader-byline">
              {owner && (
                <>
                  <Avatar name={owner.name} src={owner.image} size={22} className="shrink-0" />
                  <span className="min-w-0 font-medium text-ink-2">{owner.name}</span>
                  <span aria-hidden>·</span>
                </>
              )}
              <RelativeTime date={updatedAt} prefix="Updated " />
              {readingMinutes > 0 && (
                <>
                  <span aria-hidden>·</span>
                  <span data-testid="reader-reading-time">{readingMinutes} min read</span>
                </>
              )}
            </div>
          </header>
          <ReaderBody bodyKey={stashReaderBody(html)} empty={html.length === 0} hideFirstH1={hideFirstH1} />
          <ReaderScrollableRegions contentKey={initialHash} />
          <ReaderLinkCards contentKey={initialHash} />
          <footer className="reader-footer mt-16 border-t border-line pt-5 text-xs text-ink-4">
            Made with{" "}
            <Link href={signedIn ? "/" : signInHref} className="font-medium text-ink-3 hover:text-accent">
              Markdoc
            </Link>
          </footer>
        </article>
      </main>
    </div>
  );
}
