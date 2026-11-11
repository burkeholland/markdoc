import type { Metadata, Viewport } from "next";
import { Inter, JetBrains_Mono, Fraunces, Instrument_Sans, Source_Serif_4, IBM_Plex_Mono } from "next/font/google";
import { ThemeBootstrap } from "@/components/theme-bootstrap";
import { publicOrigin } from "@/server/public-origin";
import { HydrationMarker } from "@/components/hydration-marker";
import "./globals.css";

const inter = Inter({ variable: "--font-inter", subsets: ["latin"], display: "swap" });
const mono = JetBrains_Mono({ variable: "--font-jetbrains-mono", subsets: ["latin"], display: "swap" });
// Display face (--p-font-display in globals.css): wordmark, document titles and reader h1–h3.
const fraunces = Fraunces({ variable: "--font-fraunces", subsets: ["latin"], display: "swap", axes: ["opsz", "SOFT"] });
// The preview's font choices (src/lib/preview-font.ts); Inter is loaded above.
const instrumentSans = Instrument_Sans({ variable: "--font-instrument-sans", subsets: ["latin"], display: "swap" });
const sourceSerif = Source_Serif_4({ variable: "--font-source-serif", subsets: ["latin"], display: "swap" });
const plexMono = IBM_Plex_Mono({ variable: "--font-plex-mono", subsets: ["latin"], weight: ["400", "500", "600"], display: "swap" });

export const metadata: Metadata = {
  // Relative image URLs below resolve against this; without it Next falls back to http://localhost:3000
  // in production and link previews (Slack, Teams, X, iMessage) show no image.
  metadataBase: new URL(publicOrigin()),
  title: { default: "Markdoc", template: "%s · Markdoc" },
  description: "Markdown, together. Write in real time, review with comments and suggestions, keep every version.",
  icons: { icon: [{ url: "/brand/favicon.svg", type: "image/svg+xml" }, { url: "/favicon.ico", sizes: "32x32" }] },
  openGraph: {
    title: "Markdoc",
    description: "Markdown, together. Write in real time, review with comments and suggestions, keep every version.",
    siteName: "Markdoc",
    images: [{ url: "/brand/og.png", width: 1200, height: 630, alt: "Markdoc — Markdown, together." }],
  },
  // Document pages (`/d/[id]`, `/p/[id]`) replace title, description and image with the document's own
  // card for whoever may read it (src/server/document-metadata.ts); everything else unfurls as this.
  twitter: { card: "summary_large_image" },
};

// themeColor mirrors --p-surface in globals.css for each theme; viewport-fit=cover lets the header
// and status bar extend under the notch/home indicator (they pad with env(safe-area-inset-*)).
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#14161a" },
  ],
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    // data-theme is set by the boot script before React runs, so the server markup never matches it.
    <html lang="en" className={`${inter.variable} ${mono.variable} ${fraunces.variable} ${instrumentSans.variable} ${sourceSerif.variable} ${plexMono.variable} h-full antialiased`} suppressHydrationWarning>
      <body className="min-h-full flex flex-col bg-surface text-ink">
        <ThemeBootstrap />
        {children}
        <HydrationMarker />
      </body>
    </html>
  );
}
