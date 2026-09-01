import type { Metadata } from "next";

// Unmatched URLs render this route from a build-time prerender, before MARKDOC_URL / AUTH_URL are known,
// so the root layout's relative Open Graph image resolved to http://localhost:3000/brand/og.png in
// production (#928). A 404 has no preview image to advertise: the empty lists replace the inherited
// images without baking an origin into the image. Next adds <meta name="robots" content="noindex"> itself.
export const metadata: Metadata = {
  title: "Page not found",
  openGraph: { images: [] },
  twitter: { images: [] },
};

export default function NotFound() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-surface-2 px-4 py-4 text-center" data-testid="not-found">
      <p className="text-xs font-semibold uppercase tracking-wider text-ink-3">404</p>
      <h1 className="mt-2 text-2xl font-semibold text-ink">Page not found</h1>
      <p className="mt-2 max-w-sm text-sm text-ink-3">This page doesn&apos;t exist, or you don&apos;t have access to it.</p>
      {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- keeps next/link out of every route's shared chunk (#1485) */}
      <a href="/" className="btn btn-primary mt-6">Go to Markdoc</a>
    </main>
  );
}
