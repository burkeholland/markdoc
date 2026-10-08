/**
 * Which links are cards (#2317). The one list for the editor and for every renderer: a link is matched as
 * a whole string against anchored patterns. Nothing is fetched, no redirect is followed, and the link is
 * never parsed as a URL (a URL parser forgives too much: upper case, user names, ports, back slashes).
 *
 * The frame address is never copied from the link. It is the provider's fixed host plus a path built from
 * the parts a pattern captured, and every captured part comes from a small alphabet (letters, digits,
 * `_`, `-`).
 *
 * Packages only, no `@/` alias, and only syntax Node can strip: the reader's render worker will import
 * this file too (see `src/server/export/render-markdown.ts`).
 */
export type CardProviderId = "youtube" | "x";

/** How the frame is sized: a 16 by 9 player, or a tall box that scrolls inside (a post has no fixed height). */
export type CardKind = "video" | "post";

export interface LinkCard {
  provider: CardProviderId;
  /** "YouTube video", "Post on X": what the card is called, on the card and in accessible names. */
  label: string;
  kind: CardKind;
  /** Address of the provider's own embed page; always starts with one of `CARD_FRAME_HOSTS` and a `/`. */
  frameUrl: string;
  /** The frame's `sandbox` attribute: one of the two values below, by provider. */
  sandbox: string;
}

/**
 * What every card frame may do: run its own page's scripts, and open a link in a new tab that is an
 * ordinary tab ("Watch on YouTube"). Never granted: top navigation (the frame cannot move the Markdoc
 * page), forms, modals, downloads, pointer lock, presentation, storage access.
 */
export const CARD_SANDBOX = "allow-scripts allow-popups allow-popups-to-escape-sandbox";

/**
 * The same plus the provider's own origin, for the providers whose embed page stays blank without it
 * (measured: YouTube and X). That is safe only because the frame is never the app's own origin: with
 * its own origin and scripts a frame could lift its sandbox. `link-card-frame.ts` refuses to make one.
 */
export const CARD_SANDBOX_OWN_ORIGIN = "allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox";

/** The frame's `allow` attribute. No autoplay: a card never starts playing by itself. */
export const CARD_FRAME_ALLOW = "fullscreen; picture-in-picture; encrypted-media";

/** The origin only, never the address of the document. YouTube refuses to play without any referrer. */
export const CARD_FRAME_REFERRER_POLICY = "strict-origin-when-cross-origin";

/** Frames are heavy. A page loads this many by itself; a card beyond that shows a button that loads it. */
export const MAX_CARD_FRAMES = 20;

/** Longest link that can be a card; a longer one stays a link. */
export const MAX_CARD_URL_LENGTH = 512;

/**
 * Everything a card link may contain at all: `https`, a lower-case host, then unreserved characters and
 * `% / ? & = +`. No spaces, quotes, angle brackets, back slashes, `@`, `:`, `#` or non-ASCII.
 */
const SAFE_URL = /^https:\/\/[a-z0-9.-]+\/[A-Za-z0-9\-._~%/?&=+]*$/;

/**
 * The first of two checks, each of which alone refuses a link that is not a card: the link is short and
 * made of the characters above. The second is the provider's own anchored pattern in `PROVIDERS`.
 */
export function hasCardLinkShape(url: string): boolean {
  return url.length <= MAX_CARD_URL_LENGTH && SAFE_URL.test(url);
}

/** Optional query string of plain `key=value` pairs. It is dropped unless a rule reads a key from it. */
const QUERY = "(?:\\?([A-Za-z0-9\\-._~%&=+]*))?";

/** The value of `key` in a query string, or null when it is missing or given more than once. */
function queryValue(query: string | undefined, key: string): string | null {
  if (!query) return null;
  let found: string | null = null;
  for (const pair of query.split("&")) {
    const eq = pair.indexOf("=");
    if (eq === -1 || pair.slice(0, eq) !== key) continue;
    if (found !== null) return null;
    found = pair.slice(eq + 1);
  }
  return found;
}

interface Rule {
  pattern: RegExp;
  /** The card for a match: its label and the path (starting with `/`) on the provider's frame host. */
  card: (match: RegExpExecArray) => { label: string; framePath: string } | null;
}

interface Provider {
  id: CardProviderId;
  kind: CardKind;
  /** Origin of the provider's embed pages. A public `https` host, never the app's own. */
  frameHost: string;
  /** The embed page stays blank unless it runs with its own origin. */
  ownOrigin: boolean;
  rules: Rule[];
}

const YOUTUBE_ID = "([A-Za-z0-9_-]{11})";

/** `t=90`, `t=90s` or `start=90` becomes `?start=90`; any other form is dropped. */
function youtubeStart(query: string | undefined): string {
  const value = queryValue(query, "t") ?? queryValue(query, "start");
  const seconds = value ? /^([0-9]{1,6})s?$/.exec(value) : null;
  return seconds ? `?start=${seconds[1]}` : "";
}

const youtubeVideo = (id: string, query: string | undefined) => ({ label: "YouTube video", framePath: `/embed/${id}${youtubeStart(query)}` });

const PROVIDERS: readonly Provider[] = [
  {
    id: "youtube",
    kind: "video",
    // The host that sets no cookies until the video is played.
    frameHost: "https://www.youtube-nocookie.com",
    ownOrigin: true,
    rules: [
      {
        pattern: new RegExp(`^https://(?:www\\.|m\\.)?youtube\\.com/watch${QUERY}$`),
        card: (m) => {
          const id = queryValue(m[1], "v");
          return id && /^[A-Za-z0-9_-]{11}$/.test(id) ? youtubeVideo(id, m[1]) : null;
        },
      },
      { pattern: new RegExp(`^https://youtu\\.be/${YOUTUBE_ID}${QUERY}$`), card: (m) => youtubeVideo(m[1], m[2]) },
      { pattern: new RegExp(`^https://(?:www\\.|m\\.)?youtube\\.com/(?:shorts|live|embed)/${YOUTUBE_ID}${QUERY}$`), card: (m) => youtubeVideo(m[1], m[2]) },
      { pattern: new RegExp(`^https://www\\.youtube-nocookie\\.com/embed/${YOUTUBE_ID}${QUERY}$`), card: (m) => youtubeVideo(m[1], m[2]) },
    ],
  },
  {
    id: "x",
    kind: "post",
    // X does not document this address: it is the page X's own widgets.js puts in its frame.
    frameHost: "https://platform.twitter.com",
    ownOrigin: true,
    rules: [
      {
        pattern: new RegExp(`^https://(?:www\\.|mobile\\.)?(?:x|twitter)\\.com/[A-Za-z0-9_]{1,15}/status/([0-9]{1,20})${QUERY}$`),
        card: (m) => ({ label: "Post on X", framePath: `/embed/Tweet.html?id=${m[1]}&dnt=true` }),
      },
    ],
  },
];

/** The origins a card frame may point at, one per provider. */
export const CARD_FRAME_HOSTS: readonly string[] = PROVIDERS.map((provider) => provider.frameHost);

/** The card for a link, or null when the link is not exactly one of the known forms. */
export function matchLinkCard(url: string): LinkCard | null {
  if (!hasCardLinkShape(url)) return null;
  for (const provider of PROVIDERS) {
    for (const rule of provider.rules) {
      const match = rule.pattern.exec(url);
      if (!match) continue;
      const card = rule.card(match);
      if (!card || !card.framePath.startsWith("/")) return null;
      return {
        provider: provider.id,
        label: card.label,
        kind: provider.kind,
        frameUrl: provider.frameHost + card.framePath,
        sandbox: provider.ownOrigin ? CARD_SANDBOX_OWN_ORIGIN : CARD_SANDBOX,
      };
    }
  }
  return null;
}

/** A card link as people read it: without the scheme and a leading `www.`. */
export function cardLinkText(url: string): string {
  return url.replace(/^https:\/\/(?:www\.)?/, "");
}

/** The frame's title: what the card is and which link, for a screen reader's list of frames. */
export function cardFrameTitle(card: LinkCard, url: string): string {
  return `${card.label}: ${cardLinkText(url)}`;
}