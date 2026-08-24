import type { Metadata, Viewport } from "next";
import { Inter, JetBrains_Mono, Fraunces, Inter_Tight } from "next/font/google";
import { THEME_BOOT_SCRIPT } from "@/lib/theme";
import { BRAND_BOOT_SCRIPT } from "@/lib/brand";
import "./globals.css";

const inter = Inter({ variable: "--font-inter", subsets: ["latin"], display: "swap" });
const mono = JetBrains_Mono({ variable: "--font-jetbrains-mono", subsets: ["latin"], display: "swap" });
// Display faces for the two brand candidates (src/lib/brand.ts). Not preloaded: the browser only
// fetches a face once a rule under [data-brand] uses it, so visitors without the switch pay nothing.
const fraunces = Fraunces({ variable: "--font-fraunces", subsets: ["latin"], display: "swap", preload: false, axes: ["opsz", "SOFT"] });
const interTight = Inter_Tight({ variable: "--font-inter-tight", subsets: ["latin"], display: "swap", preload: false });

export const metadata: Metadata = {
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
    { media: "(prefers-color-scheme: dark)", color: "#0b0f17" },
  ],
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    // data-theme and data-brand are set by the boot scripts before React runs, so the server markup never matches them.
    <html lang="en" className={`${inter.variable} ${mono.variable} ${fraunces.variable} ${interTight.variable} h-full antialiased`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT + BRAND_BOOT_SCRIPT }} />
      </head>
      <body className="min-h-full flex flex-col bg-surface text-ink">{children}</body>
    </html>
  );
}
