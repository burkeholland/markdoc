// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { cardLoadLabel, claimCardFrame, createCardFrame, releaseCardFrame } from "./link-card-frame";
import { CARD_FRAME_HOSTS, matchLinkCard, MAX_CARD_FRAMES, type LinkCard } from "./markdown/link-cards";

const TWEET = "https://x.com/jack/status/20";
const VIDEO = "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s";
const LINKS_BY_HOST: Record<string, string> = {
  "https://www.youtube-nocookie.com": VIDEO,
  "https://platform.twitter.com": TWEET,
  "https://www.facebook.com": "https://www.facebook.com/markdoc/posts/1234567890",
  "https://www.linkedin.com": "https://www.linkedin.com/feed/update/urn:li:activity:1234567890123456789",
  "https://player.vimeo.com": "https://vimeo.com/123456789",
  "https://www.loom.com": "https://www.loom.com/share/e5d19b462fa64f1287a385bcb140837e",
  "https://www.tiktok.com": "https://www.tiktok.com/@burkeholland/video/7060000000000000000",
};

/** A document that writes down the order in which a new element's attributes are set. */
function recordingDocument(origin: string) {
  const order: string[] = [];
  const doc = {
    defaultView: { location: { origin } },
    createElement(tag: string) {
      const element = document.createElement(tag);
      const set = element.setAttribute.bind(element);
      element.setAttribute = (name: string, value: string) => {
        order.push(name);
        set(name, value);
      };
      return element;
    },
  } as unknown as Document;
  return { doc, order };
}

describe("the one place a frame is made (#2317)", () => {
  it("a YouTube card: the no-cookie embed address and exactly these attributes", () => {
    const frame = createCardFrame(matchLinkCard(VIDEO)!, VIDEO)!;
    expect(frame.tagName).toBe("IFRAME");
    expect(Object.fromEntries(Array.from(frame.attributes, (attribute) => [attribute.name, attribute.value]))).toEqual({
      sandbox: "allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox",
      allow: "fullscreen; picture-in-picture; encrypted-media",
      referrerpolicy: "strict-origin-when-cross-origin",
      loading: "lazy",
      title: "YouTube video: youtube.com/watch?v=dQw4w9WgXcQ&t=42s",
      class: "md-link-card-iframe",
      src: "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?start=42",
    });
  });

  it("a post on X: the embed address with the id only and do-not-track", () => {
    const frame = createCardFrame(matchLinkCard(`${TWEET}?s=20&t=abc`)!, `${TWEET}?s=20&t=abc`)!;
    expect(frame.getAttribute("src")).toBe("https://platform.twitter.com/embed/Tweet.html?id=20&dnt=true");
    expect(frame.getAttribute("title")).toBe("Post on X: x.com/jack/status/20?s=20&t=abc");
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox");
    expect(frame.hasAttribute("allowfullscreen")).toBe(false);
    expect(frame.hasAttribute("srcdoc")).toBe(false);
    expect(frame.hasAttribute("name")).toBe(false);
  });

  it("sets the limits before the address, so the frame never starts to load without them", () => {
    const { doc, order } = recordingDocument("https://markdoc.app");
    const frame = createCardFrame(matchLinkCard(VIDEO)!, VIDEO, doc)!;
    expect(frame).not.toBeNull();
    expect(order.at(-1)).toBe("src");
    expect(order.indexOf("sandbox")).toBeLessThan(order.indexOf("src"));
    expect(order.indexOf("allow")).toBeLessThan(order.indexOf("src"));
    expect(order.indexOf("referrerpolicy")).toBeLessThan(order.indexOf("src"));
    expect(order.filter((name) => name === "src")).toHaveLength(1);
  });

  it("makes no frame to the page's own origin, whatever the app is served as", () => {
    const card = matchLinkCard(VIDEO)!;
    // An app that is served from a frame host would frame itself with its own origin and scripts: refused.
    for (const host of CARD_FRAME_HOSTS) {
      const link = LINKS_BY_HOST[host]!;
      const own = matchLinkCard(link)!;
      expect(createCardFrame(own, link, recordingDocument(host).doc), host).toBeNull();
    }
    // Every origin a Markdoc really has is another origin, and gets its frame.
    for (const origin of ["https://markdoc.app", "http://localhost:3000", "http://127.0.0.1:3941", "http://markdoc:3000", "http://markdoc.local", "http://192.168.1.20:3000", "https://www.youtube.com", "https://x.com"]) {
      expect(createCardFrame(card, VIDEO, recordingDocument(origin).doc), origin).not.toBeNull();
    }
  });

  it("makes no frame for an address that is not on a listed host, even from a card object that claims it", () => {
    const card = matchLinkCard(VIDEO)!;
    const forged: LinkCard[] = [
      { ...card, frameUrl: "https://evil.example/embed/dQw4w9WgXcQ" },
      { ...card, frameUrl: "https://www.youtube-nocookie.com.evil.example/embed/x" },
      { ...card, frameUrl: "https://www.youtube-nocookie.com@evil.example/embed/x" },
      { ...card, frameUrl: "https://www.youtube-nocookie.com" },
      { ...card, frameUrl: "http://www.youtube-nocookie.com/embed/x" },
      { ...card, frameUrl: "//www.youtube-nocookie.com/embed/x" },
      { ...card, frameUrl: "javascript:alert(1)" },
      { ...card, frameUrl: "data:text/html,<script>alert(1)</script>" },
      { ...card, frameUrl: "about:blank" },
      { ...card, frameUrl: "" },
      { ...card, frameUrl: "/embed/x" },
    ];
    for (const bad of forged) expect(createCardFrame(bad, VIDEO), bad.frameUrl).toBeNull();
    expect(document.querySelectorAll("iframe")).toHaveLength(0);
  });

  it("names the button of a card past the limit after what it loads", () => {
    expect(cardLoadLabel(matchLinkCard(VIDEO)!)).toBe("Load video");
    expect(cardLoadLabel(matchLinkCard(TWEET)!)).toBe("Load post");
  });

  it("a page has 20 places for frames that load by themselves; a place given back can be taken again", () => {
    const page = {};
    const other = {};
    for (let i = 0; i < MAX_CARD_FRAMES; i++) expect(claimCardFrame(page), `place ${i + 1}`).toBe(true);
    expect(claimCardFrame(page)).toBe(false);
    expect(claimCardFrame(page)).toBe(false);
    // Another page has its own places.
    expect(claimCardFrame(other)).toBe(true);
    releaseCardFrame(page);
    expect(claimCardFrame(page)).toBe(true);
    expect(claimCardFrame(page)).toBe(false);
    // Giving back more than was taken does not make room for more than the limit.
    for (let i = 0; i < MAX_CARD_FRAMES + 5; i++) releaseCardFrame(page);
    let taken = 0;
    while (claimCardFrame(page)) taken++;
    expect(taken).toBe(MAX_CARD_FRAMES);
  });
});
