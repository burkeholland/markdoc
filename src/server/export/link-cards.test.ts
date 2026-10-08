import { describe, expect, it } from "vitest";
import { parseMarkdown } from "../../editor/markdown/parse";
import { schema } from "../../editor/markdown/schema";
import { CARD_FRAME_HOSTS, matchLinkCard } from "../../editor/markdown/link-cards";
import { previewText } from "../preview-text";
import { renderMarkdownFragment } from "./render-markdown";
import { readerHtml, rehypeLinkCards } from "./markdown-syntax";
import rehypeStringify from "rehype-stringify";
import { unified } from "unified";
import type { Element, Root as HastRoot } from "hast";

process.env.PGLITE_DATA_DIR = "memory://";
delete process.env.DATABASE_URL;

const { renderDocumentHtml, renderMarkdownBody } = await import("./html");

const TWEET = "https://x.com/jack/status/20";
const VIDEO = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";

const render = async (markdown: string, linkCards = true) => (await renderMarkdownFragment(markdown, { assetBaseUrl: "", linkCards })).html;

const POST_CARD =
  `<figure class="md-link-card" data-link-card="${TWEET}" data-provider="x" aria-label="Post on X: x.com/jack/status/20">` +
  `<figcaption class="md-link-card-header"><span class="md-link-card-label">Post on X</span> ` +
  `<a class="md-link-card-link" href="${TWEET}" target="_blank" rel="noopener noreferrer">x.com/jack/status/20</a></figcaption>` +
  `<div class="md-link-card-frame" data-kind="post"></div></figure>`;

/** Nothing that loads or runs anything, and no address of a frame host: the HTML only names the link. */
function expectInert(html: string, what: string) {
  expect(html, what).not.toMatch(/<(script|iframe|frame|object|embed|link|style|base|meta|form)\b/i);
  expect(html, what).not.toMatch(/\s(on[a-z]+|srcdoc|src|action|formaction)=/i);
  expect(html, what).not.toContain("javascript:");
  for (const host of CARD_FRAME_HOSTS) expect(html, what).not.toContain(host);
}

describe("link cards on the published page (#2317)", () => {
  it("a known link alone on its line is drawn as the card: Markdoc's own markup, the link, an empty box, no frame", async () => {
    expect(await render(TWEET)).toBe(POST_CARD);
    const html = await render(`# Title\n\nIntro\n\n${TWEET}\n\n${VIDEO}&t=42s\n\nOutro\n`);
    expect(html).toContain(POST_CARD);
    expect(html).toContain(
      `<figure class="md-link-card" data-link-card="${VIDEO}&#x26;t=42s" data-provider="youtube" aria-label="YouTube video: youtube.com/watch?v=dQw4w9WgXcQ&#x26;t=42s">` +
        `<figcaption class="md-link-card-header"><span class="md-link-card-label">YouTube video</span> ` +
        `<a class="md-link-card-link" href="${VIDEO}&#x26;t=42s" target="_blank" rel="noopener noreferrer">youtube.com/watch?v=dQw4w9WgXcQ&#x26;t=42s</a></figcaption>` +
        `<div class="md-link-card-frame" data-kind="video"></div></figure>`,
    );
    expect(html.match(/<figure/g)).toHaveLength(2);
    expect(html).toContain("<p>Intro</p>");
    expectInert(html, "two cards");
  });

  it.each([
    ["in angle brackets", `<${TWEET}>`],
    ["as a Markdown link", `[a post](${TWEET})`],
    ["as a Markdown link to itself", `[${TWEET}](${TWEET})`],
    ["in a sentence", `See ${TWEET} now`],
    ["with a space before it", ` ${TWEET}`],
    ["with a space after it", `${TWEET} `],
    ["in a list", `- ${TWEET}`],
    ["in a quote", `> ${TWEET}`],
    ["in a table", `| a |\n| - |\n| ${TWEET} |`],
    ["as a heading", `# ${TWEET}`],
    ["in a code block", `\`\`\`\n${TWEET}\n\`\`\``],
    ["two on two lines of one paragraph", `${TWEET}\n${VIDEO}`],
    ["a look-alike host", "https://x.com.evil.example/jack/status/20"],
    ["a link to another site", "https://example.com/a"],
    ["http", "http://x.com/jack/status/20"],
    ["a link with a tag in its query", `${TWEET}?x="><script>alert(1)</script>`],
  ])("the same link %s is an ordinary link, not a card", async (what, markdown) => {
    const html = await render(markdown);
    expect(html, what).not.toContain("md-link-card");
    expect(html, what).not.toContain("data-link-card");
    expect(html, what).not.toContain("<figure");
    expectInert(html, what);
  });

  it.each([
    ["a paragraph that carries the mark", `<p data-link-card="${TWEET}"><a href="https://evil.example/">x</a></p>`],
    ["a ready-made card", `<figure class="md-link-card" data-link-card="${TWEET}"><div class="md-link-card-frame" data-kind="video"></div></figure>`],
    ["a ready-made frame", `<iframe src="https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ"></iframe>`],
    ["a frame to another site", `<iframe src="https://evil.example/"></iframe>`],
    ["a frame inside a card", `<figure class="md-link-card" data-link-card="${VIDEO}"><div class="md-link-card-frame"><iframe src="https://evil.example/" srcdoc="<script>alert(1)</script>"></iframe></div></figure>`],
    ["a script", `<script src="https://platform.twitter.com/widgets.js"></script>`],
    ["Twitter's own embed code", `<blockquote class="twitter-tweet"><a href="${TWEET}"></a></blockquote> <script async src="https://platform.twitter.com/widgets.js" charset="utf-8"></script>`],
    ["an inline mark in a sentence", `Text <span data-link-card="${TWEET}">x</span> text`],
    ["a mark on a link inside a card line", `<a data-link-card="${TWEET}" href="${TWEET}">${TWEET}</a>`],
  ])("raw HTML in the document cannot make a card, a frame or a script: %s", async (what, markdown) => {
    for (const source of [markdown, `Before\n\n${markdown}\n\nAfter`, `${TWEET}\n\n${markdown}`]) {
      const html = await render(source);
      expectInert(html, what);
      // Only a real card line makes a card: the third source has exactly one, the others none.
      expect(html.match(/<figure/g) ?? [], what).toHaveLength(source.startsWith(TWEET) ? 1 : 0);
      expect(html.match(/data-link-card/g) ?? [], what).toHaveLength(source.startsWith(TWEET) ? 1 : 0);
      expect(html.match(/md-link-card-frame/g) ?? [], what).toHaveLength(source.startsWith(TWEET) ? 1 : 0);
      expect(html, what).not.toContain("evil.example");
    }
  });

  it("draws a card for exactly the lines the editor draws one for", async () => {
    const pieces = ["https://", "http://", "x.com", "twitter.com", "www.", "youtu.be", "youtube.com", "/", "/jack", "/status/", "20", "watch", "?v=", "dQw4w9WgXcQ", "&t=5", "?", "_", ".", "~", "%41", "-", "embed/", "#", " ", "<", ">", "*", "@", ":", "\n", "- ", "> "];
    let seed = 20231008;
    const next = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 0x100000000;
    let cards = 0;
    for (let i = 0; i < 600; i++) {
      let line = [TWEET, VIDEO, "https://youtu.be/dQw4w9WgXcQ", "https://youtu.be/abcdefghij_", ""][Math.floor(next() * 5)];
      for (let n = Math.floor(next() * 3); n > 0; n--) {
        const at = Math.floor(next() * (line.length + 1));
        line = line.slice(0, at) + pieces[Math.floor(next() * pieces.length)] + line.slice(at);
      }
      const source = `Before\n\n${line}\n\nAfter`;
      const inEditor: string[] = [];
      parseMarkdown(source).doc.forEach((node) => {
        if (node.type === schema.nodes.link_card) inEditor.push(String(node.attrs.url));
      });
      const html = await render(source);
      const onPage = Array.from(html.matchAll(/<figure class="md-link-card" data-link-card="([^"]*)"/g), (m) => m[1].replace(/&#x26;/g, "&"));
      expect(onPage, JSON.stringify(line)).toEqual(inEditor);
      for (const url of onPage) expect(matchLinkCard(url), url).not.toBeNull();
      expectInert(html, JSON.stringify(line));
      cards += onPage.length;
    }
    expect(cards).toBeGreaterThan(60);
  });

  it("a video id that ends with an underscore is a card here too, with its whole link", async () => {
    const html = await render("https://youtu.be/abcdefghij_");
    expect(html).toContain('data-link-card="https://youtu.be/abcdefghij_"');
    expect(html).toContain('href="https://youtu.be/abcdefghij_"');
    expect(html).not.toContain("<p>");
  });

  it("only draws cards when asked: the default, which the exports use, keeps the plain link", async () => {
    const plain = `<p><a href="${TWEET}">${TWEET}</a></p>`;
    expect(await render(TWEET, false)).toBe(plain);
    expect((await renderMarkdownFragment(TWEET, { assetBaseUrl: "" })).html).toBe(plain);
    const exported = await renderDocumentHtml({ title: "Cards", markdown: `${TWEET}\n\n${VIDEO}\n`, assetBaseUrl: "https://docs.example.com" });
    expect(exported).toContain(plain);
    expect(exported).not.toContain("md-link-card");
    expect(exported).not.toContain("<figure");
    expect(exported).not.toContain("<iframe");
    // The processor itself, asked for nothing: no cards. Asked for them: cards.
    expect(String(await readerHtml().use(rehypeStringify).process(TWEET))).toBe(plain);
    expect(String(await readerHtml({}).use(rehypeStringify).process(TWEET))).toBe(plain);
    expect(String(await readerHtml({ linkCards: true }).use(rehypeStringify).process(TWEET))).toBe(POST_CARD);
  });

  it("the step after the sanitizer makes a card of a marked top-level paragraph only, and takes every other mark off", async () => {
    const el = (tagName: string, properties: Element["properties"], children: Element["children"] = []): Element => ({ type: "element", tagName, properties, children });
    const say = (value: string) => ({ type: "text" as const, value });
    const run = async (children: HastRoot["children"]) => {
      const tree: HastRoot = { type: "root", children };
      const processor = unified().use(rehypeLinkCards).use(rehypeStringify);
      return processor.stringify(await processor.run(tree));
    };
    // What the step before it makes: the paragraph, marked with its link.
    expect(await run([el("p", { dataLinkCard: TWEET }, [say(TWEET)])])).toBe(POST_CARD);
    // A mark on anything that is not a top-level paragraph, or a mark that is not a link on the list: no card, no mark.
    const forged = await run([
      el("div", { dataLinkCard: TWEET }, [say("a marked div")]),
      el("figure", { dataLinkCard: VIDEO, className: ["md-link-card"] }, [el("div", { className: ["md-link-card-frame"] })]),
      el("blockquote", {}, [el("p", { dataLinkCard: TWEET }, [say("a marked paragraph in a quote")])]),
      el("ul", {}, [el("li", { dataLinkCard: VIDEO }, [el("p", { dataLinkCard: VIDEO }, [say("in a list")])])]),
      el("p", { dataLinkCard: "https://evil.example/x" }, [say("a paragraph marked with another site")]),
      el("p", { dataLinkCard: `${TWEET}"><iframe src="https://evil.example/">` }, [say("a mark that tries to close the attribute")]),
      el("p", { dataLinkCard: ["https://x.com/jack/status/20"] as unknown as string }, [say("a mark that is a list")]),
      el("p", { dataLinkCard: true }, [say("a mark with no value")]),
    ]);
    expect(forged).not.toContain("data-link-card");
    expect(forged).not.toContain("<figcaption");
    expect(forged).not.toContain("md-link-card-header");
    expectInert(forged, "forged marks");
    expect(forged).toContain("<div>a marked div</div>");
    expect(forged).toContain("<blockquote><p>a marked paragraph in a quote</p></blockquote>");
    expect(forged).toContain("<p>a paragraph marked with another site</p>");
  });

  it("the render worker draws the same card (it loads the list straight from source)", async () => {
    const withCards = await renderMarkdownBody(`# T\n\n${TWEET}\n`, { assetBaseUrl: "", linkCards: true });
    expect(withCards.html).toContain(POST_CARD);
    expect(withCards.headings.map((heading) => heading.text)).toEqual(["T"]);
    const without = await renderMarkdownBody(`# T\n\n${TWEET}\n`, { assetBaseUrl: "" });
    expect(without.html).not.toContain("md-link-card");
    expect(without.html).toContain(`<a href="${TWEET}">`);
  });

  it("the link preview text of a document is what it was: the link's own text", () => {
    expect(previewText(`${TWEET}\n\nSome words after the card.`)).toBe(previewText(`<${TWEET}>\n\nSome words after the card.`));
  });
});
