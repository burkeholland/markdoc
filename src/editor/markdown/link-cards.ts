/**
 * Which links are cards (#2317). The one list for the editor and for every renderer: a link is matched as
 * a whole string against anchored patterns. Nothing is fetched, no redirect is followed, and the link is
 * never parsed as a URL (a URL parser forgives too much: upper case, user names, ports, back slashes).
 *
 * The frame address is never copied from the link. It is the provider's fixed host plus a path built from
 * captured ids and fixed path segments; no captured part can add a host, query key, or script.
 *
 * Packages only, no `@/` alias, and only syntax Node can strip: the reader's render worker will import
 * this file too (see `src/server/export/render-markdown.ts`).
 */
export type CardProviderId = "youtube" | "x" | "facebook" | "linkedin" | "vimeo" | "loom" | "tiktok";

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
 * The same plus the provider's own origin, when an embed page needs its origin context. That is safe
 * only because the frame is never the app's own origin: with its own origin and scripts a frame could
 * lift its sandbox. `link-card-frame.ts` refuses to make one.
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
 * `% / ? & = + : @`. No spaces, quotes, angle brackets, back slashes, `#` or non-ASCII. `:` is needed for
 * LinkedIn's `urn:li:*` post addresses and `@` for TikTok's username path; each provider still has its own
 * anchored pattern.
 */
const SAFE_URL = /^https:\/\/[a-z0-9.-]+\/[A-Za-z0-9\-._~%/?&=+:@]*$/;

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
  card: (match: RegExpExecArray) => { label: string; framePath: string; kind?: CardKind } | null;
}

interface Provider {
  id: CardProviderId;
  /** The site's name as people say it, for the Settings row and the Insert dialog. */
  name: string;
  kind: CardKind;
  /** Origin of the provider's embed pages. A public `https` host, never the app's own. */
  frameHost: string;
  /** The embed page stays blank unless it runs with its own origin. */
  ownOrigin: boolean;
  rules: Rule[];
}

const YOUTUBE_ID = "([A-Za-z0-9_-]{11})";

/** A YouTube timestamp in seconds or `1h2m3s` form, or null when it is not a timestamp. */
function youtubeTimestampSeconds(value: string): number | null {
  const numeric = /^([0-9]{1,6})s?$/.exec(value);
  if (numeric) return Number(numeric[1]);
  const parts = /^(?:(\d{1,3})h)?(?:(\d{1,3})m)?(?:(\d{1,3})s)?$/.exec(value);
  if (!parts || !(parts[1] || parts[2] || parts[3])) return null;
  const seconds = Number(parts[1] ?? 0) * 3600 + Number(parts[2] ?? 0) * 60 + Number(parts[3] ?? 0);
  return Number.isSafeInteger(seconds) && seconds <= 999999 ? seconds : null;
}

/** `t=90`, `t=1m30s` or `start=90` becomes `?start=90`; any other form is dropped. */
function youtubeStart(query: string | undefined): string {
  const value = queryValue(query, "t") ?? queryValue(query, "start");
  const seconds = value ? youtubeTimestampSeconds(value) : null;
  return seconds === null ? "" : `?start=${seconds}`;
}

const youtubeVideo = (id: string, query: string | undefined) => ({ label: "YouTube video", framePath: `/embed/${id}${youtubeStart(query)}` });
const numericId = "([0-9]{1,20})";
const facebookPostFrame = (href: string, kind: "post" | "video") =>
  `/plugins/${kind}.php?href=${encodeURIComponent(href)}&show_text=true&width=500`;

const PROVIDERS: readonly Provider[] = [
  {
    id: "youtube",
    name: "YouTube",
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
    name: "X",
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
  {
    id: "facebook",
    name: "Facebook",
    kind: "post",
    frameHost: "https://www.facebook.com",
    ownOrigin: true,
    rules: [
      {
        pattern: new RegExp(`^https://(?:www\\.)?facebook\\.com/([A-Za-z0-9._-]{1,100})/(posts|videos)/${numericId}${QUERY}$`),
        card: (m) => {
          const kind = m[2] === "videos" ? "video" : "post";
          const href = `https://www.facebook.com/${m[1]}/${m[2]}/${m[3]}`;
          return { label: kind === "video" ? "Facebook video" : "Facebook post", kind, framePath: facebookPostFrame(href, kind) };
        },
      },
      {
        pattern: new RegExp(`^https://(?:www\\.)?facebook\\.com/watch/?${QUERY}$`),
        card: (m) => {
          const id = queryValue(m[1], "v");
          return id && /^[0-9]{1,20}$/.test(id)
            ? { label: "Facebook video", kind: "video", framePath: facebookPostFrame(`https://www.facebook.com/watch/?v=${id}`, "video") }
            : null;
        },
      },
      {
        pattern: new RegExp(`^https://(?:www\\.)?facebook\\.com/reel/${numericId}/?${QUERY}$`),
        card: (m) => ({
          label: "Facebook video",
          kind: "video",
          framePath: facebookPostFrame(`https://www.facebook.com/reel/${m[1]}`, "video"),
        }),
      },
      {
        pattern: new RegExp(`^https://(?:www\\.)?facebook\\.com/permalink\\.php${QUERY}$`),
        card: (m) => {
          const story = queryValue(m[1], "story_fbid");
          const page = queryValue(m[1], "id");
          return story && page && /^[0-9]{1,20}$/.test(story) && /^[0-9]{1,20}$/.test(page)
            ? { label: "Facebook post", kind: "post", framePath: facebookPostFrame(`https://www.facebook.com/permalink.php?story_fbid=${story}&id=${page}`, "post") }
            : null;
        },
      },
    ],
  },
  {
    id: "linkedin",
    name: "LinkedIn",
    kind: "post",
    frameHost: "https://www.linkedin.com",
    ownOrigin: true,
    rules: [
      {
        pattern: new RegExp(`^https://(?:www\\.)?linkedin\\.com/feed/update/urn:li:(activity|share|ugcPost):${numericId}/?${QUERY}$`),
        card: (m) => ({ label: "LinkedIn post", framePath: `/embed/feed/update/urn:li:${m[1]}:${m[2]}` }),
      },
      {
        pattern: new RegExp(`^https://(?:www\\.)?linkedin\\.com/posts/[A-Za-z0-9_-]{1,120}_activity-${numericId}(?:-[A-Za-z0-9_-]{1,120})?${QUERY}$`),
        card: (m) => ({ label: "LinkedIn post", framePath: `/embed/feed/update/urn:li:activity:${m[1]}` }),
      },
    ],
  },
  {
    id: "vimeo",
    name: "Vimeo",
    kind: "video",
    frameHost: "https://player.vimeo.com",
    ownOrigin: true,
    rules: [
      {
        pattern: new RegExp(`^https://(?:www\\.)?vimeo\\.com/${numericId}(?:/([A-Za-z0-9]{1,64}))?${QUERY}$`),
        card: (m) => {
          const queryHash = queryValue(m[3], "h");
          const hash = queryHash ?? m[2];
          return { label: "Vimeo video", framePath: `/video/${m[1]}${hash && /^[A-Za-z0-9]{1,64}$/.test(hash) ? `?h=${hash}` : ""}` };
        },
      },
      {
        pattern: new RegExp(`^https://player\\.vimeo\\.com/video/${numericId}${QUERY}$`),
        card: (m) => {
          const hash = queryValue(m[2], "h");
          return { label: "Vimeo video", framePath: `/video/${m[1]}${hash && /^[A-Za-z0-9]{1,64}$/.test(hash) ? `?h=${hash}` : ""}` };
        },
      },
    ],
  },
  {
    id: "loom",
    name: "Loom",
    kind: "video",
    frameHost: "https://www.loom.com",
    ownOrigin: true,
    rules: [
      {
        pattern: /^https:\/\/(?:www\.)?loom\.com\/share\/([A-Za-z0-9_-]{16,64})(?:\?[A-Za-z0-9\-._~%&=+]*)?$/,
        card: (m) => ({ label: "Loom video", framePath: `/embed/${m[1]}` }),
      },
    ],
  },
  {
    id: "tiktok",
    name: "TikTok",
    kind: "video",
    frameHost: "https://www.tiktok.com",
    ownOrigin: true,
    rules: [
      {
        pattern: /^https:\/\/www\.tiktok\.com\/@[A-Za-z0-9._-]{1,24}\/video\/([0-9]{10,25})(?:\?[A-Za-z0-9\-._~%&=+]*)?$/,
        card: (m) => ({ label: "TikTok video", framePath: `/player/v1/${m[1]}` }),
      },
      {
        pattern: /^https:\/\/www\.tiktok\.com\/player\/v1\/([0-9]{10,25})(?:\?[A-Za-z0-9\-._~%&=+]*)?$/,
        card: (m) => ({ label: "TikTok video", framePath: `/player/v1/${m[1]}` }),
      },
    ],
  },
];

/** The sites a link can be a card for, by name, in the order of the list. */
export const CARD_PROVIDER_NAMES: readonly string[] = PROVIDERS.map((provider) => provider.name);

/** The same names as people say them in a sentence: "YouTube or X", "A, B or C". */
export function cardProviderList(names: readonly string[] = CARD_PROVIDER_NAMES): string {
  return names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} or ${names[names.length - 1]}`;
}

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
        kind: card.kind ?? provider.kind,
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