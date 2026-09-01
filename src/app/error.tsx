"use client";

// Next wraps every route segment below the root layout in this boundary, so an uncaught render or
// lifecycle error in a client component shows this screen inside the root layout (fonts, theme)
// instead of Next's blank "Application error" page; `reset()` re-renders the failed segment. Nothing is
// imported from the app (`@/lib`, `@/components`, `next/link`, `next/navigation`): the boundary has to
// render while the rest of the app is broken. React and Next already log the error once — no logging here.

export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-surface-2 px-4 py-4 text-center" data-testid="app-error">
      <p className="text-xs font-semibold uppercase tracking-wider text-ink-3">Error</p>
      <h1 className="mt-2 text-2xl font-semibold text-ink">Something went wrong</h1>
      <p className="mt-2 max-w-sm text-sm text-ink-3">Markdoc couldn&apos;t show this page. Try again, or go back to your documents.</p>
      <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
        {/* `.btn` is h-9 (36 px); on a phone the two actions grow to a 40 px finger-sized target. */}
        <button type="button" className="btn btn-primary max-sm:h-10" onClick={reset}>Try again</button>
        {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- keeps next/link out of every route's shared chunk (#1485) */}
        <a href="/" className="btn btn-ghost max-sm:h-10">Back to your documents</a>
      </div>
      <details className="mt-6 max-w-sm text-left text-xs text-ink-3">
        <summary>Details</summary>
        {/* A production server error arrives with its message redacted and only a digest: that is what support asks for. */}
        {error.digest ? <p data-testid="app-error-digest">Reference: {error.digest}</p> : null}
        {error.message ? <pre className="mt-1 whitespace-pre-wrap break-words">{error.message}</pre> : null}
      </details>
    </main>
  );
}
