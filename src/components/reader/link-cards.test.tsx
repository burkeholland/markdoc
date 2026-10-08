// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "@testing-library/react";
import { StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MAX_CARD_FRAMES } from "@/editor/markdown/link-cards";
import { ReaderLinkCards } from "./link-cards";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const TWEET = "https://x.com/jack/status/20";
const VIDEO = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";

/** A card as the server draws it (`rehypeLinkCards`): the link, and an empty box for the frame. */
const card = (link: string, kind = "video", extra = "") =>
  `<figure class="md-link-card" data-link-card="${link}" data-provider="x"${extra}><figcaption class="md-link-card-header"><span class="md-link-card-label">Card</span> ` +
  `<a class="md-link-card-link" href="${link}">link</a></figcaption><div class="md-link-card-frame" data-kind="${kind}"></div></figure>`;

describe("the published page's link cards get their frames in the browser (#2317)", () => {
  let root: Root | null = null;
  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    document.body.replaceChildren();
  });

  /** The reader's body with `html` in it, and the component beside it, as on the page. */
  function show(html: string, { key = "hash-1", strict = false }: { key?: string; strict?: boolean } = {}) {
    let body = document.querySelector<HTMLElement>("[data-reader-overflow-root]");
    if (!body) {
      body = document.body.appendChild(document.createElement("div"));
      body.setAttribute("data-reader-overflow-root", "");
      body.className = "reader-body";
      root = createRoot(document.body.appendChild(document.createElement("div")));
    }
    body.innerHTML = html;
    const element = <ReaderLinkCards contentKey={key} />;
    act(() => root!.render(strict ? <StrictMode>{element}</StrictMode> : element));
    return body;
  }
  const frames = (scope: ParentNode) => Array.from(scope.querySelectorAll("iframe"));

  it("each card gets the frame for its link, with the limits, and nothing else changes", () => {
    const body = show(`<p>Intro</p>${card(TWEET, "post")}${card(`${VIDEO}&amp;t=42s`)}<p>Outro</p>`);
    expect(frames(body).map((frame) => Object.fromEntries(Array.from(frame.attributes, (attribute) => [attribute.name, attribute.value])))).toEqual([
      {
        sandbox: "allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox",
        allow: "fullscreen; picture-in-picture; encrypted-media",
        referrerpolicy: "strict-origin-when-cross-origin",
        loading: "lazy",
        title: "Post on X: x.com/jack/status/20",
        class: "md-link-card-iframe",
        src: "https://platform.twitter.com/embed/Tweet.html?id=20&dnt=true",
      },
      {
        sandbox: "allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox",
        allow: "fullscreen; picture-in-picture; encrypted-media",
        referrerpolicy: "strict-origin-when-cross-origin",
        loading: "lazy",
        title: "YouTube video: youtube.com/watch?v=dQw4w9WgXcQ&t=42s",
        class: "md-link-card-iframe",
        src: "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?start=42",
      },
    ]);
    for (const frame of frames(body)) expect(frame.parentElement!.className).toBe("md-link-card-frame");
    expect(body.querySelectorAll("p")).toHaveLength(2);
    expect(body.querySelectorAll("script, button")).toHaveLength(0);
  });

  it("the frame comes from the card's link and the list, never from an address in the HTML", () => {
    const body = show(
      [
        // A link that is not on the list, whatever else the markup says.
        card("https://evil.example/watch?v=dQw4w9WgXcQ"),
        card("https://x.com.evil.example/jack/status/20"),
        card("javascript:alert(1)"),
        card(""),
        // A real link with attributes that try to name another frame.
        card(TWEET, "post", ' data-frame="https://evil.example/" data-src="https://evil.example/" src="https://evil.example/"'),
        // The class without the link, the link without the class, and a card that is not a figure.
        `<figure class="md-link-card"><div class="md-link-card-frame"></div></figure>`,
        `<figure data-link-card="${VIDEO}"><div class="md-link-card-frame"></div></figure>`,
        `<div class="md-link-card" data-link-card="${VIDEO}"><div class="md-link-card-frame"></div></div>`,
        // A box that is not the card's own.
        `<figure class="md-link-card" data-link-card="${VIDEO}"><blockquote><div class="md-link-card-frame"></div></blockquote></figure>`,
      ].join(""),
    );
    expect(frames(body).map((frame) => frame.getAttribute("src"))).toEqual(["https://platform.twitter.com/embed/Tweet.html?id=20&dnt=true"]);
    expect(body.innerHTML).not.toContain('src="https://evil.example/" sandbox');
  });

  it("a page loads 20 frames by itself; the cards after that get a Load button that loads theirs", () => {
    const links = Array.from({ length: MAX_CARD_FRAMES + 2 }, (_, i) => (i === MAX_CARD_FRAMES ? VIDEO : `https://x.com/jack/status/${i + 1}`));
    const body = show(links.map((link) => card(link, link === VIDEO ? "video" : "post")).join(""));
    expect(frames(body)).toHaveLength(MAX_CARD_FRAMES);
    const buttons = Array.from(body.querySelectorAll<HTMLButtonElement>('[data-testid="link-card-load"]'));
    expect(buttons.map((button) => [button.textContent, button.getAttribute("aria-label"), button.type])).toEqual([
      ["Load video", "Load video: youtube.com/watch?v=dQw4w9WgXcQ", "button"],
      ["Load post", `Load post: x.com/jack/status/${MAX_CARD_FRAMES + 2}`, "button"],
    ]);
    act(() => buttons[0].click());
    const figure = body.querySelectorAll("figure")[MAX_CARD_FRAMES];
    expect(frames(figure).map((frame) => frame.getAttribute("src"))).toEqual(["https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ"]);
    expect(figure.querySelector("button")).toBeNull();
    expect(frames(body)).toHaveLength(MAX_CARD_FRAMES + 1);
    expect(body.querySelectorAll('[data-testid="link-card-load"]')).toHaveLength(1);
  });

  it("running twice over the same page adds nothing (React runs effects twice in development)", () => {
    const body = show(card(TWEET, "post") + card(VIDEO), { strict: true });
    const first = frames(body);
    expect(first).toHaveLength(2);
    show(body.innerHTML, { strict: true });
    act(() => root!.render(<ReaderLinkCards contentKey="hash-1" />));
    expect(frames(body)).toHaveLength(2);
  });

  it("new content gets its frames, and the limit counts the new page only", () => {
    const many = Array.from({ length: MAX_CARD_FRAMES }, (_, i) => card(`https://x.com/jack/status/${i + 1}`, "post")).join("");
    const body = show(many);
    expect(frames(body)).toHaveLength(MAX_CARD_FRAMES);
    show(card(VIDEO) + many, { key: "hash-2" });
    expect(frames(body)).toHaveLength(MAX_CARD_FRAMES);
    expect(frames(body)[0].getAttribute("src")).toBe("https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ");
    expect(body.querySelectorAll('[data-testid="link-card-load"]')).toHaveLength(1);
  });

  it("adds no message listener and does nothing without the reader's body", () => {
    const added: string[] = [];
    const listen = vi.spyOn(window, "addEventListener").mockImplementation((type: string) => void added.push(type));
    show(card(VIDEO));
    listen.mockRestore();
    expect(added).not.toContain("message");
    act(() => root?.unmount());
    document.body.replaceChildren();
    root = createRoot(document.body.appendChild(document.createElement("div")));
    expect(() => act(() => root!.render(<ReaderLinkCards contentKey="x" />))).not.toThrow();
    expect(document.querySelectorAll("iframe")).toHaveLength(0);
  });
});
