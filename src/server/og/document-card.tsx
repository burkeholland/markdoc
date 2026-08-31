import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";

/**
 * The per-document social card (task #1287): what Slack, Teams, X and iMessage show under a `/d/<id>`
 * or `/p/<id>` link. Rendered by Satori + resvg through `next/og`; only flexbox and a subset of CSS
 * exist there, and every element with more than one child needs an explicit `display: flex`.
 *
 * Nothing here touches the network: the two faces are vendored TTF subsets under ./fonts (Satori reads
 * TTF/OTF/WOFF, not the woff2 `next/font/google` emits), read once per process; the text is reduced to
 * their repertoire first ({@link cardText}), so `next/og` never reaches for a remote fallback glyph; the
 * brand mark is the JSX below (Satori cannot fetch a relative URL). Access is the caller's business: the
 * routes in `src/app/{d,p}/[id]/opengraph-image.tsx` run the page's access check and 404 before rendering.
 */

/** 1200×630, the size unfurlers render edge to edge; `og:image:width/height` are derived from it. */
export const CARD_SIZE = { width: 1200, height: 630 } as const;
export const CARD_CONTENT_TYPE = "image/png";
/** A renamed document shows its new title within five minutes; Slack caches unfurls longer anyway. */
export const CARD_CACHE_CONTROL = "public, max-age=300";
export const CARD_ALT = "The document's title, owner and reading time on a Markdoc card";

export interface DocumentCardInput {
  title: string;
  /** Owner display name; null leaves the "by …" part out. */
  ownerName: string | null;
  /** From `computeStats(clean).readingMinutes`; 0 hides the reading time, as the reader page does. */
  readingMinutes: number;
  updatedAt: Date;
}

type ImageResponseOptions = NonNullable<ConstructorParameters<typeof ImageResponse>[1]>;
export type CardFonts = NonNullable<ImageResponseOptions["fonts"]>;

// Latin subsets (Basic Latin, Latin-1, Latin Extended-A, general punctuation, €, ™, arrows) of the two
// faces the app uses, as static instances from fonts.googleapis.com (`text=` requests answer TTF);
// both SIL OFL, see ./fonts/OFL.txt. Together 106 492 bytes. Read relative to the working directory,
// as the Next docs prescribe for `ImageResponse` assets; the Dockerfile copies this directory.
const DISPLAY_FAMILY = "Fraunces";
const TEXT_FAMILY = "Inter";
const FONT_FILES = { display: "Fraunces-SemiBold-latin.ttf", text: "Inter-Medium-latin.ttf" } as const;

/** File names under ./fonts: the display face (title) and the text face (meta line, wordmark). */
export type FontFiles = { display: string; text: string };

/** A file of ./fonts. Keeping the folder literal here lets the build trace exactly that folder, nothing more. */
const fontPath = (file: string) => join(process.cwd(), "src", "server", "og", "fonts", file);

let defaultFonts: Promise<CardFonts | undefined> | undefined;

/**
 * The vendored faces, or undefined when they cannot be read (the card then renders in `next/og`'s bundled
 * Geist). The default files are read once per process, success or failure, so a missing file is logged once.
 */
export function loadCardFonts(files: FontFiles = FONT_FILES): Promise<CardFonts | undefined> {
  if (files !== FONT_FILES) return readFonts(files);
  defaultFonts ??= readFonts(files);
  return defaultFonts;
}

async function readFonts(files: FontFiles): Promise<CardFonts | undefined> {
  try {
    const [display, text] = await Promise.all([readFile(fontPath(files.display)), readFile(fontPath(files.text))]);
    return [
      { name: DISPLAY_FAMILY, data: display, weight: 600, style: "normal" },
      { name: TEXT_FAMILY, data: text, weight: 500, style: "normal" },
    ];
  } catch (err) {
    console.error("[og] fonts", err);
    return undefined;
  }
}

/**
 * Render the card. `fonts` defaults to the vendored faces; `null` forces the bundled fallback (tests).
 * `Cache-Control` replaces `next/og`'s default (`public, max-age=0, must-revalidate` in production).
 */
export async function renderDocumentCard(input: DocumentCardInput, fonts?: CardFonts | null): Promise<ImageResponse> {
  const loaded = fonts === undefined ? await loadCardFonts() : (fonts ?? undefined);
  // A title made only of glyphs the card cannot draw leaves the headline out; a blank one reads "Untitled".
  const headline = cardText(input.title) || (input.title.trim() ? "" : "Untitled");
  const drawn = { ...input, ownerName: input.ownerName === null ? null : cardText(input.ownerName) || null };
  return new ImageResponse(<Card headline={headline} input={drawn} />, {
    ...CARD_SIZE,
    fonts: loaded,
    headers: { "cache-control": CARD_CACHE_CONTROL },
  });
}

// The repertoire of the vendored subsets: Basic Latin, Latin-1, Latin Extended-A, general punctuation
// (dashes, quotes, bullet, ellipsis, per mille, ‹›), €, ™, arrows. Composed first, so "i" + U+0308 is "ï".
const UNDRAWABLE = /[^\u0020-\u007e\u00a0-\u017f\u2010-\u2027\u2030-\u203a\u20ac\u2122\u2190-\u2193]+/gu;

/**
 * `text` reduced to what the vendored fonts can draw, whitespace collapsed. For any other glyph — emoji,
 * another script, a lone combining mark — `next/og` would fetch a fallback at request time (Google Fonts
 * for scripts, jsdelivr for emoji; the emoji fetch is unguarded, so a blocked egress would fail the whole
 * card), and the card must never touch the network. The page's `og:title` text still carries the full title.
 */
export function cardText(text: string): string {
  return text.normalize("NFC").replace(UNDRAWABLE, " ").replace(/\s+/g, " ").trim();
}

/** "by Alice · 3 min read · Updated Aug 31" — each part only when known; the year only when it is not this one. */
export function cardMetaLine(input: DocumentCardInput, now: Date = new Date()): string {
  const parts: string[] = [];
  if (input.ownerName) parts.push(`by ${input.ownerName}`);
  if (input.readingMinutes > 0) parts.push(`${input.readingMinutes} min read`);
  parts.push(`Updated ${formatUpdated(input.updatedAt, now)}`);
  return parts.join(" · ");
}

function formatUpdated(date: Date, now: Date): string {
  const sameYear = date.getUTCFullYear() === now.getUTCFullYear();
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }), timeZone: "UTC" }).format(date);
}

/** Three lines of display type at most: long titles step down so more of them fits before the ellipsis. */
export function titleFontSize(title: string): number {
  if (title.length <= 36) return 76;
  if (title.length <= 72) return 64;
  return 54;
}

// Light theme only, from globals.css: --p-paper, --p-accent, --p-ink, --p-ink-3, --p-selection.
const PAPER = "#fcfbf7";
const ACCENT = "#0f766e";
const INK = "#1c1917";
const INK_3 = "#57534e";
const ACCENT_LINE = "#c4ebe4";

function Card({ headline, input }: { headline: string; input: DocumentCardInput }) {
  return (
    <div style={{ width: "100%", height: "100%", display: "flex", background: PAPER, fontFamily: TEXT_FAMILY, color: INK }}>
      <div style={{ width: 16, height: "100%", background: ACCENT }} />
      <div style={{ flex: 1, display: "flex", flexDirection: "column", justifyContent: "space-between", padding: "60px 80px 52px 72px", minWidth: 0 }}>
        <Mark size={72} />
        <div style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
          {headline ? (
            <div
              style={{
                display: "block",
                lineClamp: 3,
                wordBreak: "break-word",
                fontFamily: DISPLAY_FAMILY,
                fontWeight: 600,
                fontSize: titleFontSize(headline),
                lineHeight: 1.1,
                letterSpacing: -1.5,
                color: INK,
              }}
            >
              {headline}
            </div>
          ) : null}
          <div style={{ display: "flex", marginTop: headline ? 26 : 0, fontSize: 28, lineHeight: 1.3, color: INK_3, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {cardMetaLine(input)}
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", fontFamily: DISPLAY_FAMILY, fontWeight: 600, fontSize: 32, letterSpacing: -0.5, color: INK }}>Markdoc</div>
          <div style={{ width: 180, height: 6, background: ACCENT_LINE, borderRadius: 3 }} />
        </div>
      </div>
    </div>
  );
}

/** public/brand/mark.svg as JSX: the document with a folded corner carrying the Markdown `#` glyph. */
function Mark({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32">
      <path d="M9 2h12l9 9v12a7 7 0 0 1-7 7H9a7 7 0 0 1-7-7V9a7 7 0 0 1 7-7z" fill={ACCENT} />
      <path d="M21 2v6a3 3 0 0 0 3 3h6z" fill="#ffffff" fillOpacity={0.42} />
      <path d="M10 13.5h13M9 19.5h13M14.5 9.5l-2 13M20 9.5l-2 13" stroke="#ffffff" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </svg>
  );
}
