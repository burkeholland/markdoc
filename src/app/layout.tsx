import type { Metadata, Viewport } from "next";
import { Inter, JetBrains_Mono, Fraunces } from "next/font/google";
import { THEME_BOOT_SCRIPT } from "@/lib/theme";
import { publicOrigin } from "@/server/public-origin";
import "./globals.css";

const inter = Inter({ variable: "--font-inter", subsets: ["latin"], display: "swap" });
const mono = JetBrains_Mono({ variable: "--font-jetbrains-mono", subsets: ["latin"], display: "swap" });
// Display face (--p-font-display in globals.css): wordmark, document titles, h1–h3 in the preview and reader.
const fraunces = Fraunces({ variable: "--font-fraunces", subsets: ["latin"], display: "swap", axes: ["opsz", "SOFT"] });

// The phase-1 look switch (`?brand=a|b`, task #398) is gone; a stored choice from then is dropped so it never lingers.
const BRAND_CLEANUP_SCRIPT = `(function(){try{localStorage.removeItem("markdoc:brand");}catch(e){}})();`;

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
    images: [{ url: "/brand/og.png", width: 1200, height: 630, alt: "Markdoc — Markdown, together." }],
  },
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
    <html lang="en" className={`${inter.variable} ${mono.variable} ${fraunces.variable} h-full antialiased`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT + BRAND_CLEANUP_SCRIPT }} />
      </head>
      <body className="min-h-full flex flex-col bg-surface text-ink">{children}</body>
    </html>
  );
}
