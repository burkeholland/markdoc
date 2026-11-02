import { describe, expect, it } from "vitest";
import type { Node as PMNode } from "prosemirror-model";
import { parseMarkdown } from "./parse";
import { serializeBlocks, serializeMarkdown } from "./serialize";
import { reparseRange, textChangeSpan } from "./incremental";
import { schema } from "./schema";
import {
  CARD_FRAME_ALLOW,
  CARD_FRAME_HOSTS,
  CARD_FRAME_REFERRER_POLICY,
  CARD_PROVIDER_NAMES,
  cardProviderList,
  CARD_SANDBOX,
  CARD_SANDBOX_OWN_ORIGIN,
  cardFrameTitle,
  cardLinkText,
  hasCardLinkShape,
  matchLinkCard,
  MAX_CARD_FRAMES,
  MAX_CARD_URL_LENGTH,
} from "./link-cards";

const TWEET = "https://x.com/jack/status/20";
const VIDEO = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";

/** The top-level blocks of a document, short enough to read in a failure message. */
function shape(doc: PMNode): string {
  const out: string[] = [];
  doc.forEach((node) => {
    if (node.type === schema.nodes.link_card) out.push(`card(${node.attrs.url})`);
    else if (node.type !== schema.nodes.paragraph) out.push(node.type.name);
    else {
      const inline: string[] = [];
      node.forEach((child) => inline.push(child.isText ? `${child.marks.map((mark) => mark.type.name).join("+") || "text"}:${child.text}` : child.type.name));
      out.push(`p(${inline.join(",")})`);
    }
  });
  return out.join(" | ");
}

const read = (source: string) => shape(parseMarkdown(source).doc);

/** Parse, write, parse again, write again: the second document equals the first and the text is stable. */
function roundTrip(source: string) {
  const first = parseMarkdown(source).doc;
  const written = serializeMarkdown(first);
  const second = parseMarkdown(written).doc;
  expect(second.eq(first), `second parse of ${JSON.stringify(source)}`).toBe(true);
  expect(serializeMarkdown(second), `second write of ${JSON.stringify(source)}`).toBe(written);
  return written;
}

const doc = (...blocks: PMNode[]) => schema.nodes.doc.create(null, blocks);
const paragraph = (...content: PMNode[]) => schema.nodes.paragraph.create(null, content);
const link = (href: string, text = href) => schema.text(text, [schema.marks.link.create({ href })]);

describe("the allow-list: which links are cards", () => {
  it.each([
    [TWEET, "x", "Post on X", "https://platform.twitter.com/embed/Tweet.html?id=20&dnt=true"],
    ["https://twitter.com/jack/status/20", "x", "Post on X", "https://platform.twitter.com/embed/Tweet.html?id=20&dnt=true"],
    ["https://www.x.com/jack/status/20", "x", "Post on X", "https://platform.twitter.com/embed/Tweet.html?id=20&dnt=true"],
    ["https://mobile.twitter.com/jack/status/20", "x", "Post on X", "https://platform.twitter.com/embed/Tweet.html?id=20&dnt=true"],
    ["https://x.com/a_B_9/status/1844789012345678901?s=20&t=abc-DEF_123", "x", "Post on X", "https://platform.twitter.com/embed/Tweet.html?id=1844789012345678901&dnt=true"],
    [VIDEO, "youtube", "YouTube video", "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ"],
    ["https://youtube.com/watch?v=dQw4w9WgXcQ", "youtube", "YouTube video", "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ"],
    ["https://m.youtube.com/watch?v=dQw4w9WgXcQ", "youtube", "YouTube video", "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ"],
    ["https://www.youtube.com/watch?list=PL123&v=dQw4w9WgXcQ&t=10s", "youtube", "YouTube video", "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?start=10"],
    ["https://www.youtube.com/watch?v=dQw4w9WgXcQ&start=75", "youtube", "YouTube video", "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?start=75"],
    ["https://youtu.be/dQw4w9WgXcQ?t=1m30s", "youtube", "YouTube video", "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?start=90"],
    ["https://youtu.be/dQw4w9WgXcQ?t=1h2m3s", "youtube", "YouTube video", "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?start=3723"],
    ["https://www.youtube.com/watch?v=dQw4w9WgXcQ&pp=ygUEdGVzdA%3D%3D", "youtube", "YouTube video", "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ"],
    ["https://youtu.be/dQw4w9WgXcQ", "youtube", "YouTube video", "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ"],
    ["https://youtu.be/dQw4w9WgXcQ?si=abc_DEF-123&t=90", "youtube", "YouTube video", "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?start=90"],
    ["https://youtu.be/-_-_-_-_-_-", "youtube", "YouTube video", "https://www.youtube-nocookie.com/embed/-_-_-_-_-_-"],
    ["https://www.youtube.com/shorts/dQw4w9WgXcQ", "youtube", "YouTube video", "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ"],
    ["https://www.youtube.com/live/dQw4w9WgXcQ?feature=share", "youtube", "YouTube video", "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ"],
    ["https://www.youtube.com/embed/dQw4w9WgXcQ", "youtube", "YouTube video", "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ"],
    ["https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ", "youtube", "YouTube video", "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ"],
    ["https://www.facebook.com/markdoc/posts/1234567890", "facebook", "Facebook post", "https://www.facebook.com/plugins/post.php?href=https%3A%2F%2Fwww.facebook.com%2Fmarkdoc%2Fposts%2F1234567890&show_text=true&width=500"],
    ["https://facebook.com/markdoc/videos/1234567890", "facebook", "Facebook video", "https://www.facebook.com/plugins/video.php?href=https%3A%2F%2Fwww.facebook.com%2Fmarkdoc%2Fvideos%2F1234567890&show_text=true&width=500"],
    ["https://www.facebook.com/watch/?v=1234567890&ref=sharing", "facebook", "Facebook video", "https://www.facebook.com/plugins/video.php?href=https%3A%2F%2Fwww.facebook.com%2Fwatch%2F%3Fv%3D1234567890&show_text=true&width=500"],
    ["https://www.facebook.com/reel/1234567890", "facebook", "Facebook video", "https://www.facebook.com/plugins/video.php?href=https%3A%2F%2Fwww.facebook.com%2Freel%2F1234567890&show_text=true&width=500"],
    ["https://www.facebook.com/permalink.php?story_fbid=1234567890&id=42", "facebook", "Facebook post", "https://www.facebook.com/plugins/post.php?href=https%3A%2F%2Fwww.facebook.com%2Fpermalink.php%3Fstory_fbid%3D1234567890%26id%3D42&show_text=true&width=500"],
    ["https://www.linkedin.com/feed/update/urn:li:activity:1234567890123456789/", "linkedin", "LinkedIn post", "https://www.linkedin.com/embed/feed/update/urn:li:activity:1234567890123456789"],
    ["https://linkedin.com/feed/update/urn:li:ugcPost:1234567890123456789", "linkedin", "LinkedIn post", "https://www.linkedin.com/embed/feed/update/urn:li:ugcPost:1234567890123456789"],
    ["https://www.linkedin.com/posts/burkeholland_activity-1234567890123456789-sample", "linkedin", "LinkedIn post", "https://www.linkedin.com/embed/feed/update/urn:li:activity:1234567890123456789"],
    ["https://vimeo.com/123456789", "vimeo", "Vimeo video", "https://player.vimeo.com/video/123456789"],
    ["https://www.vimeo.com/123456789/abc123?share=copy", "vimeo", "Vimeo video", "https://player.vimeo.com/video/123456789?h=abc123"],
    ["https://vimeo.com/123456789?autoplay=1&h=abc123", "vimeo", "Vimeo video", "https://player.vimeo.com/video/123456789?h=abc123"],
    ["https://player.vimeo.com/video/123456789?h=abc123", "vimeo", "Vimeo video", "https://player.vimeo.com/video/123456789?h=abc123"],
    ["https://www.loom.com/share/e5d19b462fa64f1287a385bcb140837e", "loom", "Loom video", "https://www.loom.com/embed/e5d19b462fa64f1287a385bcb140837e"],
    ["https://loom.com/share/e5d19b462fa64f1287a385bcb140837e?sid=abc123", "loom", "Loom video", "https://www.loom.com/embed/e5d19b462fa64f1287a385bcb140837e"],
    ["https://www.tiktok.com/@burkeholland/video/7060000000000000000", "tiktok", "TikTok video", "https://www.tiktok.com/player/v1/7060000000000000000"],
    ["https://www.tiktok.com/player/v1/7060000000000000000", "tiktok", "TikTok video", "https://www.tiktok.com/player/v1/7060000000000000000"],
  ])("%s is a card", (url, provider, label, frameUrl) => {
    const kind = provider === "x" || (provider === "facebook" && label === "Facebook post") || provider === "linkedin" ? "post" : "video";
    expect(matchLinkCard(url)).toEqual({ provider, label, frameUrl, kind, sandbox: "allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox" });
    expect(hasCardLinkShape(url)).toBe(true);
  });

  it.each([
    ["a Facebook lookalike host", "https://facebook.com.evil.example/markdoc/posts/123"],
    ["an unlisted Facebook mobile host", "https://m.facebook.com/markdoc/posts/123"],
    ["a LinkedIn lookalike host", "https://linkedin.com.evil.example/feed/update/urn:li:activity:123"],
    ["a malformed LinkedIn activity", "https://www.linkedin.com/feed/update/urn:li:activity:123/extra"],
    ["a Vimeo lookalike host", "https://vimeo.com.evil.example/123456789"],
    ["a Vimeo path with a redirect suffix", "https://player.vimeo.com/video/123456789/redirect"],
    ["a Loom lookalike host", "https://loom.com.evil.example/share/e5d19b462fa64f1287a385bcb140837e"],
    ["a Loom id that is too short", "https://www.loom.com/share/short"],
    ["a TikTok lookalike host", "https://tiktok.com.evil.example/@burke/video/7060000000000000000"],
    ["a TikTok id that is too short", "https://www.tiktok.com/@burke/video/123"],
  ])("does not turn %s into a card", (_what, url) => {
    expect(matchLinkCard(url)).toBeNull();
  });

  it("keeps only a start time from the query, normalized to whole seconds", () => {
    const frame = (query: string) => matchLinkCard(`https://youtu.be/dQw4w9WgXcQ${query}`)?.frameUrl;
    const plain = "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ";
    expect(frame("?t=0")).toBe(`${plain}?start=0`);
    expect(frame("?t=999999s")).toBe(`${plain}?start=999999`);
    for (const dropped of ["?t=1234567", "?t=-5", "?t=5.5", "?t=", "?t", "?t=5&t=6", "?autoplay=1", "?list=PL1&index=2", "?start=1e3", "?t=%31"]) {
      expect(frame(dropped), dropped).toBe(plain);
    }
    // `t` given twice is no `t`; a single `start` then counts.
    expect(frame("?t=5&t=6&start=7")).toBe(`${plain}?start=7`);
  });

  // Each of these is one edit away from a card link. None may be a card, in the list or in a document.
  const HOSTILE: [string, string][] = [
    ["another site whose name starts like the provider's", "https://youtube.com.evil.example/watch?v=dQw4w9WgXcQ"],
    ["the provider as a user name", "https://www.youtube.com@evil.example/watch?v=dQw4w9WgXcQ"],
    ["the provider as a user name with a port", "https://x.com:443@evil.example/jack/status/20"],
    ["the card link as the path of another site", "https://evil.example/https://www.youtube.com/watch?v=dQw4w9WgXcQ"],
    ["the card link as a query value of another site", "https://evil.example/?u=https://x.com/jack/status/20"],
    ["the provider as a subdomain label of another site", "https://x.com.evil.example/jack/status/20"],
    ["a longer host name that ends like the provider's", "https://notx.com/jack/status/20"],
    ["a host one letter longer", "https://xx.com/jack/status/20"],
    ["a subdomain that is not listed", "https://api.x.com/jack/status/20"],
    ["another character where the dot of x.com is", "https://x-com/jack/status/20"],
    ["another character where the dot of twitter.com is", "https://twitter-com/jack/status/20"],
    ["another character where the dot after www is", "https://www-x.com/jack/status/20"],
    ["another character where the dot after mobile is", "https://mobile-twitter.com/jack/status/20"],
    ["another character where the dot of youtube.com is", "https://www.youtube-com/watch?v=dQw4w9WgXcQ"],
    ["another character where the dot after www is, YouTube", "https://www-youtube.com/watch?v=dQw4w9WgXcQ"],
    ["another character where the dot after m is", "https://m-youtube.com/shorts/dQw4w9WgXcQ"],
    ["another character where the dot of youtu.be is", "https://youtu-be/dQw4w9WgXcQ"],
    ["another character where the dots of the no-cookie host are", "https://www-youtube-nocookie-com/embed/dQw4w9WgXcQ"],
    ["a port", "https://x.com:8443/jack/status/20"],
    ["the default port", "https://x.com:443/jack/status/20"],
    ["an upper-case host", "https://X.com/jack/status/20"],
    ["an upper-case scheme", "HTTPS://x.com/jack/status/20"],
    ["http", "http://x.com/jack/status/20"],
    ["no scheme", "//x.com/jack/status/20"],
    ["no scheme, www", "www.youtube.com/watch?v=dQw4w9WgXcQ"],
    ["a back slash before a user name", "https://x.com\\@evil.example/jack/status/20"],
    ["a back slash as a path separator", "https://x.com\\jack\\status\\20"],
    ["dot segments after the id", "https://x.com/jack/status/20/../../../evil"],
    ["a trailing slash", "https://x.com/jack/status/20/"],
    ["an extra path segment", "https://x.com/jack/status/20/photo/1"],
    ["a fragment", "https://x.com/jack/status/20#frag"],
    ["a quote and a tag in the query", 'https://x.com/jack/status/20?x="><script>alert(1)</script>'],
    ["a tag in the query", "https://x.com/jack/status/20?x=<b>"],
    ["an encoded line break after the id", "https://x.com/jack/status/20%0d%0aSet-Cookie:x"],
    ["a space", "https://x.com/jack/status/20 "],
    ["a leading space", " https://x.com/jack/status/20"],
    ["a line break", "https://x.com/jack/status/20\nhttps://evil.example/"],
    ["a tab", "https://x.com/jack/status/20\t"],
    ["a full-width digit in the id", "https://x.com/jack/status/2\uff10"],
    ["a Cyrillic letter that looks like x", "https://\u0445.com/jack/status/20"],
    ["a punycode host", "https://xn--80a.com/jack/status/20"],
    ["a right-to-left override", "https://x.com/jack/status/20\u202e"],
    ["a zero-width space", "https://x.com/jack/status/\u200b20"],
    ["a user name that is too long", "https://x.com/aaaaaaaaaaaaaaaa/status/20"],
    ["an id that is too long", "https://x.com/jack/status/123456789012345678901"],
    ["an id with a letter", "https://x.com/jack/status/20a"],
    ["no id", "https://x.com/jack/status/"],
    ["a profile, not a post", "https://x.com/jack"],
    ["two video ids", "https://www.youtube.com/watch?v=dQw4w9WgXcQ&v=AAAAAAAAAAA"],
    ["a video id one character short", "https://www.youtube.com/watch?v=dQw4w9WgXc"],
    ["a video id one character long", "https://www.youtube.com/watch?v=dQw4w9WgXcQQ"],
    ["a short-host id one character short", "https://youtu.be/dQw4w9WgXc"],
    ["a short-host id one character long", "https://youtu.be/dQw4w9WgXcQQ"],
    ["a shorts id one character short", "https://www.youtube.com/shorts/dQw4w9WgXc"],
    ["an embed id one character long", "https://www.youtube.com/embed/dQw4w9WgXcQQ"],
    ["a no-cookie id one character short", "https://www.youtube-nocookie.com/embed/dQw4w9WgXc?t=1"],
    ["a path as the video id", "https://www.youtube.com/watch?v=../../embed/x"],
    ["an encoded video id", "https://www.youtube.com/watch?v=dQw4w9WgXc%51"],
    ["no video id", "https://www.youtube.com/watch"],
    ["another YouTube page with a video id in its query", "https://www.youtube.com/redirect?v=dQw4w9WgXcQ"],
    ["a search page with a video id in its query", "https://www.youtube.com/results?v=dQw4w9WgXcQ"],
    ["a longer page name that starts with watch", "https://www.youtube.com/watchlater?v=dQw4w9WgXcQ"],
    ["a slash after watch", "https://www.youtube.com/watch/?v=dQw4w9WgXcQ"],
    ["the provider's own redirect page", "https://www.youtube.com/redirect?q=https://evil.example"],
    ["dot segments after an embed id", "https://www.youtube.com/embed/dQw4w9WgXcQ/../../redirect?q=https://evil.example"],
    ["an extra segment on the short host", "https://youtu.be/dQw4w9WgXcQ/extra"],
    ["a channel, not a video", "https://www.youtube.com/@RickAstleyYT"],
    ["a playlist, not a video", "https://www.youtube.com/playlist?list=PL123"],
    ["a YouTube host that is not listed", "https://music.youtube.com/watch?v=dQw4w9WgXcQ"],
    ["the no-cookie host without www", "https://youtube-nocookie.com/embed/dQw4w9WgXcQ"],
    ["a frame host with another path", "https://platform.twitter.com/embed/Tweet.html?id=20"],
    ["another top-level domain where .com is, X", "https://x.org/jack/status/20"],
    ["another top-level domain where .com is, Twitter", "https://twitter.net/jack/status/20"],
    ["another top-level domain where .com is, YouTube", "https://www.youtube.org/watch?v=dQw4w9WgXcQ"],
    ["another top-level domain where .be is", "https://youtu.com/dQw4w9WgXcQ"],
    ["another top-level domain where .com is, the no-cookie host", "https://www.youtube-nocookie.net/embed/dQw4w9WgXcQ"],
    ["the YouTube mobile prefix on X", "https://m.x.com/jack/status/20"],
    ["the X mobile prefix on YouTube", "https://mobile.youtube.com/watch?v=dQw4w9WgXcQ"],
    ["a hyphen in the user name", "https://x.com/ja-ck/status/20"],
    ["a dot in the user name", "https://x.com/ja.ck/status/20"],
    ["an encoded letter in the user name", "https://x.com/%6Aack/status/20"],
    ["a slash in the query of a post", "https://x.com/jack/status/20?a=/b"],
    ["a slash in the query of a short link", "https://youtu.be/dQw4w9WgXcQ?a=/b"],
    ["more path after the video id in the query", "https://www.youtube.com/watch?v=dQw4w9WgXcQ/extra"],
    ["a second question mark after the video id", "https://www.youtube.com/watch?v=dQw4w9WgXcQ?x=1"],
    ["an old player path with a video id", "https://www.youtube.com/v/dQw4w9WgXcQ"],
    ["a channel path of eleven characters", "https://www.youtube.com/channel/dQw4w9WgXcQ"],
    ["a script link", "javascript:alert(1)//https://x.com/jack/status/20"],
    ["a data link", "data:text/html,https://x.com/jack/status/20"],
    ["a link in angle brackets", `<${TWEET}>`],
    ["a Markdown link", `[x](${TWEET})`],
    ["nothing", ""],
    ["a query longer than the limit", `https://x.com/jack/status/20?${"a".repeat(MAX_CARD_URL_LENGTH)}`],
  ];

  // Two checks refuse a link, and each must do so alone. These are well formed (short, https, a lower-case
  // host, plain characters), so only the provider's own pattern refuses them. Every other entry above has
  // a character or a shape that no card link may have at all, and the first check refuses it already.
  const WELL_FORMED = new Set([
    "another site whose name starts like the provider's",
    "the card link as the path of another site",
    "the card link as a query value of another site",
    "an encoded line break after the id",
    "the provider's own redirect page",
    "the provider as a subdomain label of another site",
    "a longer host name that ends like the provider's",
    "a host one letter longer",
    "a subdomain that is not listed",
    "another character where the dot of x.com is",
    "another character where the dot of twitter.com is",
    "another character where the dot after www is",
    "another character where the dot after mobile is",
    "another character where the dot of youtube.com is",
    "another character where the dot after www is, YouTube",
    "another character where the dot after m is",
    "another character where the dot of youtu.be is",
    "another character where the dots of the no-cookie host are",
    "a short-host id one character short",
    "a short-host id one character long",
    "a shorts id one character short",
    "an embed id one character long",
    "a no-cookie id one character short",
    "a channel, not a video",
    "dot segments after the id",
    "a trailing slash",
    "an extra path segment",
    "a punycode host",
    "a user name that is too long",
    "an id that is too long",
    "an id with a letter",
    "no id",
    "a profile, not a post",
    "two video ids",
    "a video id one character short",
    "a video id one character long",
    "a path as the video id",
    "dot segments after an embed id",
    "an encoded video id",
    "no video id",
    "another YouTube page with a video id in its query",
    "a search page with a video id in its query",
    "a longer page name that starts with watch",
    "a slash after watch",
    "an extra segment on the short host",
    "a playlist, not a video",
    "a YouTube host that is not listed",
    "the no-cookie host without www",
    "a frame host with another path",
    "another top-level domain where .com is, X",
    "another top-level domain where .com is, Twitter",
    "another top-level domain where .com is, YouTube",
    "another top-level domain where .be is",
    "another top-level domain where .com is, the no-cookie host",
    "the YouTube mobile prefix on X",
    "the X mobile prefix on YouTube",
    "a hyphen in the user name",
    "a dot in the user name",
    "an encoded letter in the user name",
    "a slash in the query of a post",
    "a slash in the query of a short link",
    "more path after the video id in the query",
    "a second question mark after the video id",
    "an old player path with a video id",
    "a channel path of eleven characters",
  ]);

  it("each of the two checks refuses alone: the shape of the link, and the provider's pattern", () => {
    for (const name of WELL_FORMED) expect(HOSTILE.some(([what]) => what === name), name).toBe(true);
    for (const [what, url] of HOSTILE) expect(hasCardLinkShape(url), what).toBe(WELL_FORMED.has(what));
    expect(HOSTILE.filter(([what]) => !WELL_FORMED.has(what)).length).toBeGreaterThan(25);
  });

  it.each(HOSTILE)("%s is not a card", (_what, url) => {
    expect(matchLinkCard(url)).toBeNull();
    expect(read(url)).not.toContain("card(");
    expect(read(`Before\n\n${url}\n\nAfter`)).not.toContain("card(");
  });

  it("stops at the length limit exactly", () => {
    const base = "https://x.com/jack/status/20?a=";
    const longest = base + "a".repeat(MAX_CARD_URL_LENGTH - base.length);
    expect(longest).toHaveLength(MAX_CARD_URL_LENGTH);
    expect(matchLinkCard(longest)).not.toBeNull();
    expect(read(longest)).toBe(`card(${longest})`);
    expect(matchLinkCard(longest + "a")).toBeNull();
    expect(read(longest + "a")).not.toContain("card(");
  });

  it("answers quickly for long hostile input", () => {
    const started = performance.now();
    for (const filler of ["a", "/", "&", "=", "%", ".", "-"]) {
      expect(matchLinkCard(`https://x.com/jack/status/20?${filler.repeat(100_000)}!`)).toBeNull();
      expect(matchLinkCard(`https://www.youtube.com/watch?${`v=${filler.repeat(11)}&`.repeat(40)}`)).toBeNull();
    }
    expect(performance.now() - started).toBeLessThan(500);
  });
});

describe("the frame address", () => {
  // Every card form the list knows, with ids and queries that try to carry something into the frame address.
  const LINKS = [
    TWEET,
    "https://twitter.com/jack/status/18446744073709551615?ref_src=twsrc%5Etfw&id=666&dnt=false",
    VIDEO,
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=5&origin=https%3A%2F%2Fevil.example&autoplay=1&enablejsapi=1",
    "https://youtu.be/dQw4w9WgXcQ?start=1&list=PL1&playlist=evil",
    "https://www.youtube.com/shorts/dQw4w9WgXcQ?t=1",
    "https://www.youtube.com/live/dQw4w9WgXcQ",
    "https://www.youtube.com/embed/dQw4w9WgXcQ?autoplay=1",
    "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?autoplay=1",
    "https://www.facebook.com/markdoc/posts/1234567890?ref=sharing",
    "https://www.facebook.com/watch/?v=1234567890&autoplay=1",
    "https://www.facebook.com/reel/1234567890",
    "https://www.linkedin.com/feed/update/urn:li:activity:1234567890123456789/",
    "https://www.linkedin.com/posts/burkeholland_activity-1234567890123456789-sample",
    "https://vimeo.com/123456789/abc123?share=copy&autoplay=1",
    "https://www.loom.com/share/e5d19b462fa64f1287a385bcb140837e",
    "https://www.tiktok.com/@burkeholland/video/7060000000000000000?is_from_webapp=1",
  ];

  it("starts with one of the fixed hosts and carries only validated provider data", () => {
    for (const url of LINKS) {
      const card = matchLinkCard(url)!;
      expect(card, url).not.toBeNull();
      expect(CARD_FRAME_HOSTS.filter((host) => card.frameUrl.startsWith(`${host}/`)), url).toHaveLength(1);
      const frameUrl = new URL(card.frameUrl);
      expect(CARD_FRAME_HOSTS, url).toContain(frameUrl.origin);
      expect(frameUrl.username + frameUrl.password, url).toBe("");
      expect(frameUrl.protocol, url).toBe("https:");
      expect(card.frameUrl, url).not.toContain("evil.example");
      expect(card.frameUrl, url).not.toMatch(/[<>"'`]/);
    }
  });

  it("names its sites for the Settings row and the Insert dialog, one name per frame host", () => {
    expect(CARD_PROVIDER_NAMES).toEqual(["YouTube", "X", "Facebook", "LinkedIn", "Vimeo", "Loom", "TikTok"]);
    expect(CARD_PROVIDER_NAMES).toHaveLength(CARD_FRAME_HOSTS.length);
    expect(cardProviderList()).toBe("YouTube, X, Facebook, LinkedIn, Vimeo, Loom or TikTok");
    expect(cardProviderList([])).toBe("");
    expect(cardProviderList(["YouTube"])).toBe("YouTube");
    expect(cardProviderList(["YouTube", "X", "Vimeo"])).toBe("YouTube, X or Vimeo");
  });

  it("the frame's limits are the ruled ones: scripts and new tabs, the provider's own origin only where it is blank without it", () => {
    expect(CARD_SANDBOX).toBe("allow-scripts allow-popups allow-popups-to-escape-sandbox");
    expect(CARD_SANDBOX_OWN_ORIGIN).toBe("allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox");
    expect(CARD_FRAME_ALLOW).toBe("fullscreen; picture-in-picture; encrypted-media");
    expect(CARD_FRAME_REFERRER_POLICY).toBe("strict-origin-when-cross-origin");
    expect(MAX_CARD_FRAMES).toBe(20);
    for (const url of LINKS) {
      const card = matchLinkCard(url)!;
      expect([CARD_SANDBOX, CARD_SANDBOX_OWN_ORIGIN], url).toContain(card.sandbox);
      // Never: moving the Markdoc page, forms, dialogs, downloads, pointer lock, presentation, storage access.
      for (const never of ["allow-top-navigation", "allow-top-navigation-by-user-activation", "allow-top-navigation-to-custom-protocols", "allow-forms", "allow-modals", "allow-downloads", "allow-pointer-lock", "allow-presentation", "allow-storage-access-by-user-activation", "allow-orientation-lock"]) {
        expect(card.sandbox.split(" "), url).not.toContain(never);
      }
      expect(card.sandbox.split(" ")).toContain("allow-scripts");
      expect(card.kind, url).toBe(card.provider === "x" || (card.provider === "facebook" && card.label === "Facebook post") || card.provider === "linkedin" ? "post" : "video");
    }
    for (const never of ["autoplay", "camera", "microphone", "geolocation", "display-capture", "payment", "clipboard", "*"]) expect(CARD_FRAME_ALLOW).not.toContain(never);
    expect(cardFrameTitle(matchLinkCard(TWEET)!, TWEET)).toBe("Post on X: x.com/jack/status/20");
    expect(cardFrameTitle(matchLinkCard(VIDEO)!, VIDEO)).toBe("YouTube video: youtube.com/watch?v=dQw4w9WgXcQ");
  });

  it("the fixed hosts are public https hosts, so none of them can be the app's own", () => {
    expect([...CARD_FRAME_HOSTS]).toEqual([
      "https://www.youtube-nocookie.com",
      "https://platform.twitter.com",
      "https://www.facebook.com",
      "https://www.linkedin.com",
      "https://player.vimeo.com",
      "https://www.loom.com",
      "https://www.tiktok.com",
    ]);
    for (const host of CARD_FRAME_HOSTS) {
      const url = new URL(host);
      // An origin and nothing else: https, the default port, no path, no user name.
      expect(url.origin).toBe(host);
      expect(url.protocol).toBe("https:");
      expect(url.port).toBe("");
      expect(url.username + url.password).toBe("");
      // A registered name under .com with at least three labels. Not localhost, not a single-label LAN name,
      // not a .local or .internal name, not an IP address: a Markdoc on any of those is a different origin.
      expect(url.hostname).toMatch(/^(?:[a-z][a-z0-9-]*\.){2,}com$/);
      for (const own of ["localhost", "127.0.0.1", "[::1]", "markdoc", "markdoc.local", "markdoc.internal", "192.168.1.20", "markdoc.app", "www.markdoc.app"]) {
        for (const scheme of ["http", "https"]) {
          for (const port of ["", ":3000", ":443", ":3941"]) expect(new URL(`${scheme}://${own}${port}`).origin).not.toBe(host);
        }
      }
    }
  });
});

describe("the Markdown form", () => {
  it("the bare link alone on its line is a card and is written back exactly", () => {
    for (const source of [TWEET, VIDEO, `${VIDEO}&t=42s`, "https://youtu.be/dQw4w9WgXcQ?si=abc_DEF-123"]) {
      expect(read(source)).toBe(`card(${source})`);
      expect(roundTrip(source)).toBe(source);
    }
  });

  it("the same link in angle brackets or as a Markdown link is text and is written back exactly", () => {
    expect(read(`<${TWEET}>`)).toBe(`p(link:${TWEET})`);
    expect(roundTrip(`<${TWEET}>`)).toBe(`<${TWEET}>`);
    expect(read(`[a post](${TWEET})`)).toBe("p(link:a post)");
    expect(roundTrip(`[a post](${TWEET})`)).toBe(`[a post](${TWEET})`);
    expect(read(`[a post](${TWEET} "title")`)).toBe("p(link:a post)");
    // A Markdown link whose text is its address was always written as an autolink.
    expect(roundTrip(`[${TWEET}](${TWEET})`)).toBe(`<${TWEET}>`);
  });

  it("cards among other blocks keep their place and their text", () => {
    const source = `# Title\n\nIntro\n\n${VIDEO}\n\n<${TWEET}>\n\n${TWEET}\n\n- item\n`;
    expect(read(source)).toBe(`heading | p(text:Intro) | card(${VIDEO}) | p(link:${TWEET}) | card(${TWEET}) | bullet_list`);
    expect(roundTrip(source)).toBe(source.trimEnd());
    expect(read(`${TWEET}\n\n${VIDEO}`)).toBe(`card(${TWEET}) | card(${VIDEO})`);
  });

  it("a card needs no blank line before a block that can interrupt a paragraph", () => {
    expect(read(`${TWEET}\n# Heading`)).toBe(`card(${TWEET}) | heading`);
    expect(read(`${TWEET}\n- item`)).toBe(`card(${TWEET}) | bullet_list`);
    expect(read(`${TWEET}\n\`\`\`\ncode\n\`\`\``)).toBe(`card(${TWEET}) | code_block`);
    expect(read(`Intro\n${TWEET}`)).not.toContain("card(");
  });

  it.each([
    ["in a sentence", `See ${TWEET} for more`],
    ["followed by a word", `${TWEET} look`],
    ["followed by a full stop", `${TWEET}.`],
    ["two links on two lines of one paragraph", `${TWEET}\n${VIDEO}`],
    ["a line of text under it", `${TWEET}\nmore`],
    ["one space before it", ` ${TWEET}`],
    ["three spaces before it", `   ${TWEET}`],
    ["a space after it", `${TWEET} `],
    ["a tab after it", `${TWEET}\t`],
    ["two spaces after it (a hard break)", `${TWEET}  \nmore`],
    ["in a list item", `- ${TWEET}`],
    ["in a numbered list item", `1. ${TWEET}`],
    ["in a task item", `- [ ] ${TWEET}`],
    ["in a quote", `> ${TWEET}`],
    ["in a table cell", `| a |\n| - |\n| ${TWEET} |`],
    ["in a footnote", `Text[^1]\n\n[^1]: ${TWEET}`],
    ["as a heading", `# ${TWEET}`],
    ["as a setext heading", `${TWEET}\n===`],
    ["bold", `**${TWEET}**`],
    ["as code", `\`${TWEET}\``],
    ["in a code block", `\`\`\`\n${TWEET}\n\`\`\``],
    ["indented as code", `    ${TWEET}`],
    ["in an HTML block", `<div>\n${TWEET}\n</div>`],
    ["a link reference definition", `[x]: ${TWEET}`],
    ["a link to another site", "https://example.com/a"],
    ["an image", `![alt](${TWEET})`],
  ])("not a card: %s", (_what, source) => {
    expect(read(source)).not.toContain("card(");
    roundTrip(source);
  });

  it("reads a card on a line that ends with CRLF, and at the end of a text without a line break", () => {
    expect(read(`Intro\r\r${TWEET}\r\rOutro`)).toBe(`p(text:Intro) | card(${TWEET}) | p(text:Outro)`);
    expect(read(`Intro\r\n\r\n${TWEET}\r\n\r\nOutro\r\n`)).toBe(`p(text:Intro) | card(${TWEET}) | p(text:Outro)`);
    expect(read(`Intro\n\n${TWEET}`)).toBe(`p(text:Intro) | card(${TWEET})`);
    expect(read(`${TWEET}\n`)).toBe(`card(${TWEET})`);
  });

  it("a video id that ends with an underscore is a card too (GFM alone would cut the link short)", () => {
    const source = "https://youtu.be/abcdefghij_";
    expect(read(source)).toBe(`card(${source})`);
    expect(roundTrip(source)).toBe(source);
    expect(roundTrip(`<${source}>`)).toBe(`<${source}>`);
  });

  it("in front matter a link is front matter", () => {
    expect(read(`---\n${TWEET}\n---\n\n${TWEET}`)).toBe(`frontmatter | card(${TWEET})`);
  });

  it("gives the card the source range of its line", () => {
    const source = `Intro\n\n${TWEET}\n\nOutro`;
    const { doc: parsed, map } = parseMarkdown(source);
    expect(parsed.child(1).type).toBe(schema.nodes.link_card);
    expect(source.slice(map.blocks[1].from, map.blocks[1].to)).toBe(TWEET);
    const card = parsed.child(0).nodeSize;
    expect(map.pmToSrc(card)).toBe(source.indexOf(TWEET));
  });

  it("is the same thing for the list and for a document: a line is a card exactly when it is a known link", () => {
    const pieces = ["https://", "http://", "x.com", "twitter.com", "www.", "youtu.be", "youtube.com", "/", "/jack", "/status/", "20", "watch", "?v=", "dQw4w9WgXcQ", "&t=5", "?", "_", ".", "~", "%41", "-", "embed/", "shorts/", "#", " ", "<", ">", "*", "@", ":"];
    let seed = 20231007;
    const next = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 0x100000000;
    let cards = 0;
    for (let i = 0; i < 4000; i++) {
      const base = [TWEET, VIDEO, "https://youtu.be/dQw4w9WgXcQ", ""][Math.floor(next() * 4)];
      let line = base;
      for (let n = Math.floor(next() * 4); n > 0; n--) {
        const at = Math.floor(next() * (line.length + 1));
        line = line.slice(0, at) + pieces[Math.floor(next() * pieces.length)] + line.slice(at);
      }
      const isCard = read(line) === `card(${line})`;
      expect(isCard, JSON.stringify(line)).toBe(matchLinkCard(line) !== null);
      if (isCard) cards++;
    }
    expect(cards).toBeGreaterThan(300);
  });
});

describe("what the rich pane writes", () => {
  const card = (url: string) => schema.nodes.link_card.create({ url });

  it("a card is written as the bare link and reads back as the same card", () => {
    const document = doc(paragraph(schema.text("Intro")), card(TWEET), card(VIDEO));
    const written = serializeMarkdown(document);
    expect(written).toBe(`Intro\n\n${TWEET}\n\n${VIDEO}`);
    expect(parseMarkdown(written).doc.eq(document)).toBe(true);
    expect(serializeBlocks([card(TWEET)])).toBe(TWEET);
  });

  it("a paragraph that is nothing but a known link is written in angle brackets and never reads back as a card", () => {
    for (const url of [TWEET, VIDEO, "https://youtu.be/abcdefghij_", "https://youtu.be/_bcdefghijk", "https://youtu.be/dQw4w9WgXcQ?si=a_b"]) {
      for (const node of [paragraph(schema.text(url)), paragraph(link(url))]) {
        const written = serializeMarkdown(doc(node));
        expect(written).toBe(`<${url}>`);
        expect(read(written)).toBe(`p(link:${url})`);
        expect(serializeBlocks([node])).toBe(`<${url}>`);
      }
    }
  });

  it("no paragraph is ever written as a line that reads back as a card", () => {
    const strong = schema.marks.strong.create();
    const paragraphs = [
      paragraph(schema.text(TWEET)),
      paragraph(link(TWEET)),
      paragraph(schema.text(`${TWEET} `)),
      paragraph(schema.text(` ${TWEET}`)),
      paragraph(schema.text(TWEET), schema.nodes.hard_break.create()),
      paragraph(schema.nodes.hard_break.create(), schema.text(TWEET)),
      paragraph(schema.text(TWEET.slice(0, 20)), schema.text(TWEET.slice(20), [strong])),
      paragraph(schema.text(TWEET.slice(0, -1)), link("https://example.com/", "0")),
      paragraph(link(TWEET.slice(0, -1)), schema.text("0")),
      paragraph(schema.text(TWEET, [strong])),
      paragraph(schema.text(TWEET, [schema.marks.code.create()])),
      paragraph(schema.text(TWEET, [schema.marks.link.create({ href: TWEET, title: "t" })])),
      paragraph(link("https://example.com/", TWEET)),
      paragraph(schema.text(TWEET), schema.nodes.html_inline.create({ html: "" })),
      paragraph(schema.nodes.html_inline.create({ html: "" }), schema.text(TWEET)),
      paragraph(schema.text("https://x.com/jack/status/"), schema.nodes.html_inline.create({ html: "" }), schema.text("20")),
      paragraph(schema.text("https://youtu.be/_bcdefghijk")),
      paragraph(schema.text("https://youtu.be/abcdefghij_")),
    ];
    for (const node of paragraphs) {
      const written = serializeMarkdown(doc(paragraph(schema.text("Before")), node, paragraph(schema.text("After"))));
      expect(read(written), JSON.stringify(written)).not.toContain("card(");
      expect(read(serializeBlocks([node])), JSON.stringify(written)).not.toContain("card(");
    }
  });

  it("leaves every other paragraph as it was written before", () => {
    expect(serializeMarkdown(doc(paragraph(schema.text("https://example.com/a"))))).toBe("https://example.com/a");
    expect(serializeMarkdown(doc(paragraph(link("https://example.com/a"))))).toBe("<https://example.com/a>");
    expect(serializeMarkdown(doc(paragraph(schema.text(`See ${TWEET}`))))).toBe(`See ${TWEET}`);
    expect(serializeMarkdown(doc(paragraph(schema.text(`${TWEET} look`))))).toBe(`${TWEET} look`);
    // Inside a list item or a quote the bare link is no card, so it stays as it was.
    const item = schema.nodes.list_item.create(null, paragraph(schema.text(TWEET)));
    expect(serializeMarkdown(doc(schema.nodes.bullet_list.create(null, item)))).toBe(`- ${TWEET}`);
    expect(serializeMarkdown(doc(schema.nodes.blockquote.create(null, paragraph(schema.text(TWEET)))))).toBe(`> ${TWEET}`);
  });

  it("a card can only stand at the top level", () => {
    expect(schema.nodes.doc.contentMatch.matchType(schema.nodes.link_card)).not.toBeNull();
    expect(schema.nodes.doc.contentMatch.defaultType).toBe(schema.nodes.paragraph);
    for (const parent of [schema.nodes.blockquote, schema.nodes.list_item, schema.nodes.footnote_definition, schema.nodes.table_cell, schema.nodes.paragraph]) {
      expect(parent.contentMatch.matchType(schema.nodes.link_card), parent.name).toBeNull();
    }
    expect(() => schema.nodes.blockquote.createChecked(null, card(TWEET))).toThrow();
  });

  it("the card's text, for copying and for the empty-document check, is its link", () => {
    expect(doc(card(TWEET)).textContent).toBe(TWEET);
    expect(cardLinkText(TWEET)).toBe("x.com/jack/status/20");
    expect(cardLinkText(VIDEO)).toBe("youtube.com/watch?v=dQw4w9WgXcQ");
  });
});

describe("typing a link in the Markdown pane", () => {
  it.each([
    ["a video link", VIDEO, VIDEO.length],
    // `.../status/2` is already a whole link, one key before the last.
    ["a post link", TWEET, TWEET.length - 1],
  ])("%s: the incremental parse equals a full parse at every key, and the card appears when the link is whole", (_what, url, firstCard) => {
    const before = "# Title\n\nIntro\n\n";
    const after = "\n\nOutro\n";
    let text = before + after;
    let previous = parseMarkdown(text);
    let seen = -1;
    let incremental = 0;
    for (let i = 1; i <= url.length; i++) {
      const nextText = before + url.slice(0, i) + after;
      const full = parseMarkdown(nextText);
      const partial = reparseRange(previous, text, nextText, textChangeSpan(text, nextText)!);
      if (partial) {
        incremental++;
        expect(partial.doc.eq(full.doc), `key ${i}`).toBe(true);
        expect(partial.map.blocks, `key ${i}`).toEqual(full.map.blocks);
      }
      if (seen === -1 && shape(full.doc).includes("card(")) seen = i;
      previous = partial ?? full;
      text = nextText;
    }
    expect(seen).toBe(firstCard);
    expect(incremental).toBe(url.length);
  });

  it("adding and removing the angle brackets switches between the card and the paragraph incrementally", () => {
    const card = `Intro\n\n${TWEET}\n\nOutro`;
    const open = `Intro\n\n<${TWEET}\n\nOutro`;
    const closed = `Intro\n\n<${TWEET}>\n\nOutro`;
    let previous = parseMarkdown(card);
    let text = card;
    for (const nextText of [open, closed, open, card]) {
      const partial = reparseRange(previous, text, nextText, textChangeSpan(text, nextText)!);
      const full = parseMarkdown(nextText);
      expect(partial, JSON.stringify(nextText)).not.toBeNull();
      expect(partial!.doc.eq(full.doc), JSON.stringify(nextText)).toBe(true);
      previous = partial!;
      text = nextText;
    }
    expect(shape(previous.doc)).toBe(`p(text:Intro) | card(${TWEET}) | p(text:Outro)`);
    expect(read(closed)).toBe(`p(text:Intro) | p(link:${TWEET}) | p(text:Outro)`);
  });
});
