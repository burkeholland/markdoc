// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type * as Y from "yjs";
import { DOMParser as PMDOMParser } from "prosemirror-model";
import { EditorState, NodeSelection, TextSelection } from "prosemirror-state";
import { EditorView } from "prosemirror-view";

vi.mock("@hocuspocus/provider", async () => {
  const { Awareness } = await import("y-protocols/awareness");
  class HocuspocusProvider {
    awareness: InstanceType<typeof Awareness>;
    constructor(opts: { document: Y.Doc }) {
      this.awareness = new Awareness(opts.document);
    }
    destroy() {
      this.awareness.destroy();
    }
  }
  return { HocuspocusProvider };
});

import { CollabSession } from "../collab/session";
import { makeCollabUser } from "../collab/shared";
import { schema } from "../markdown/schema";
import { parseMarkdown } from "../markdown/parse";
import { serializeMarkdown } from "../markdown/serialize";
import { CARD_FRAME_HOSTS } from "../markdown/link-cards";
import { EditorActions } from "@/components/editor/actions";
import { createNodeViews } from "./nodeviews";
import { createRichEditorState, setEditable } from "./setup";
import { refreshRichHighlights } from "./highlights";
import { cardLinkParagraph, selectedCard, showCardAsText, showLinkAsCard, showSelectedCardAsText } from "./commands";

// jsdom has no layout: ProseMirror asks a Range for its boxes when it scrolls the selection into view.
Range.prototype.getClientRects ??= () => [] as unknown as DOMRectList;
Range.prototype.getBoundingClientRect ??= () => new DOMRect();

const TWEET = "https://x.com/jack/status/20";
const VIDEO = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";

function clipboard(text: string, html = ""): ClipboardEvent {
  const types: Record<string, string> = { "text/plain": text, "text/html": html };
  return {
    clipboardData: { getData: (type: string) => types[type] ?? "", types: Object.keys(types).filter((t) => types[t]) },
    preventDefault() {},
  } as unknown as ClipboardEvent;
}

describe("link cards in the rich pane (#2317)", () => {
  const cleanups: (() => void)[] = [];
  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) cleanup();
    document.body.replaceChildren();
  });

  /** The rich pane as the app builds it: the real session, binding, plugins and node views. */
  function open(text: string, role: "owner" | "editor" | "commenter" | "viewer" = "owner") {
    const session = new CollabSession({
      docId: "link-cards",
      user: makeCollabUser("alice", "Alice"),
      role,
      getToken: async () => "token",
      autoConnect: false,
      deferLocal: true,
    });
    session.keepAlive();
    session.ytext.insert(0, text);
    const state: EditorState = createRichEditorState(session);
    session.binding.releaseRemoteSync();
    const view = new EditorView(document.body.appendChild(document.createElement("div")), {
      state,
      nodeViews: createNodeViews(() => session.canEdit, { isolateUndo: () => session.undoManager.stopCapturing() }),
    });
    setEditable(view, session.canEdit);
    session.undoManager.clear();
    cleanups.push(() => {
      view.destroy();
      session.destroy();
    });
    const cards = () => Array.from(view.dom.querySelectorAll<HTMLElement>('[data-testid="link-card"]'));
    const shape = () => {
      const out: string[] = [];
      view.state.doc.forEach((node) => out.push(node.type === schema.nodes.link_card ? `card(${node.attrs.url})` : node.type === schema.nodes.paragraph ? `p(${node.textContent})` : node.type.name));
      return out.join(" | ");
    };
    const cardPos = (index = 0) => {
      let found = -1;
      let seen = 0;
      view.state.doc.forEach((node, offset) => {
        if (node.type === schema.nodes.link_card && seen++ === index) found = offset;
      });
      return found;
    };
    const selectCard = (index = 0) => view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, cardPos(index))));
    const key = (name: string, target: EventTarget = view.dom) => {
      const event = new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true });
      target.dispatchEvent(event);
      return event;
    };
    const text$ = () => session.ytext.toString();
    return { session, view, cards, shape, cardPos, selectCard, key, text: text$ };
  }

  describe("what the card is made of", () => {
    it("draws a named card with its link and a Show as text button, and nothing from another site", () => {
      const { view, cards } = open(`Intro\n\n${TWEET}\n\n${VIDEO}\n\n<${TWEET}>\n`);
      expect(cards()).toHaveLength(2);
      const [post, video] = cards();
      expect(post.tagName).toBe("FIGURE");
      expect(post.getAttribute("contenteditable")).toBe("false");
      expect(post.getAttribute("data-provider")).toBe("x");
      expect(post.getAttribute("aria-label")).toBe("Post on X: x.com/jack/status/20");
      expect(video.getAttribute("data-provider")).toBe("youtube");
      expect(video.getAttribute("aria-label")).toBe("YouTube video: youtube.com/watch?v=dQw4w9WgXcQ");
      expect(post.querySelector(".md-link-card-label")!.textContent).toBe("Post on X");
      expect(video.querySelector(".md-link-card-label")!.textContent).toBe("YouTube video");

      const link = post.querySelector("a")!;
      expect(link.getAttribute("href")).toBe(TWEET);
      expect(link.textContent).toBe("x.com/jack/status/20");
      expect(link.target).toBe("_blank");
      expect(link.rel).toBe("noopener noreferrer");

      const button = post.querySelector("button")!;
      expect(button.type).toBe("button");
      expect(button.textContent).toBe("Show as text");
      // The accessible name starts with the visible words (WCAG 2.5.3) and says which card.
      expect(button.getAttribute("aria-label")).toBe("Show as text: Post on X");
      expect(video.querySelector("button")!.getAttribute("aria-label")).toBe("Show as text: YouTube video");

      // No script, frame or other loaded thing anywhere in the editor, and nothing that points at a frame host.
      expect(view.dom.querySelectorAll("script, iframe, frame, object, embed, img, video, audio, link, style, [src], [srcdoc], [srcset]")).toHaveLength(0);
      expect(document.querySelectorAll("script, iframe")).toHaveLength(0);
      for (const host of CARD_FRAME_HOSTS) expect(view.dom.innerHTML).not.toContain(host);
      // The only addresses in the cards are the two links themselves.
      expect(Array.from(view.dom.querySelectorAll(".md-link-card [href]"), (el) => el.getAttribute("href"))).toEqual([TWEET, VIDEO]);
    });

    it("a card node whose link is not on the list (no text can make one) is drawn without an address", () => {
      for (const url of ["javascript:alert(1)", "https://evil.example/", "data:text/html,<script>alert(1)</script>", ""]) {
        const state = EditorState.create({ doc: schema.nodes.doc.create(null, [schema.nodes.link_card.create({ url })]) });
        const view = new EditorView(document.body.appendChild(document.createElement("div")), { state, nodeViews: createNodeViews(() => true) });
        const card = view.dom.querySelector<HTMLElement>('[data-testid="link-card"]')!;
        expect(card.getAttribute("data-provider"), url).toBe("");
        expect(card.querySelector(".md-link-card-label")!.textContent, url).toBe("Link");
        expect(card.querySelector("a")!.hasAttribute("href"), url).toBe(false);
        expect(view.dom.querySelectorAll("script, iframe, [src]"), url).toHaveLength(0);
        view.destroy();
      }
    });

    it("redraws the card when its link changes under it", () => {
      const { session, cards } = open(TWEET);
      session.ydoc.transact(() => {
        session.ytext.delete(TWEET.length - 2, 2);
        session.ytext.insert(TWEET.length - 2, "1234");
      });
      expect(cards()).toHaveLength(1);
      expect(cards()[0].querySelector("a")!.getAttribute("href")).toBe("https://x.com/jack/status/1234");
      expect(cards()[0].getAttribute("aria-label")).toBe("Post on X: x.com/jack/status/1234");
    });
  });

  describe("Show as text", () => {
    it("turns the card into its plain link, written in angle brackets, and one undo brings the card back", () => {
      const { session, view, cards, shape, text } = open(`Intro\n\n${TWEET}\n\nOutro`);
      cards()[0].querySelector("button")!.click();
      expect(text()).toBe(`Intro\n\n<${TWEET}>\n\nOutro`);
      expect(shape()).toBe(`p(Intro) | p(${TWEET}) | p(Outro)`);
      expect(cards()).toHaveLength(0);
      // The paragraph is what `<link>` reads back as, so the two panes agree without a second pass.
      const link = view.state.doc.child(1).firstChild!;
      expect(link.marks.map((mark) => [mark.type.name, mark.attrs.href])).toEqual([["link", TWEET]]);
      // The caret is at the end of the link.
      expect(view.state.selection.from).toBe(8 + TWEET.length);

      session.undo();
      expect(text()).toBe(`Intro\n\n${TWEET}\n\nOutro`);
      expect(shape()).toBe(`p(Intro) | card(${TWEET}) | p(Outro)`);
      expect(session.undoManager.canUndo()).toBe(false);
      session.redo();
      expect(text()).toBe(`Intro\n\n<${TWEET}>\n\nOutro`);
      expect(shape()).toBe(`p(Intro) | p(${TWEET}) | p(Outro)`);
    });

    it("is its own undo step right after typing and right before more typing", () => {
      const { session, view, cards, text } = open(`Intro\n\n${TWEET}\n\nOutro`);
      view.dispatch(view.state.tr.insertText("!", 6));
      cards()[0].querySelector("button")!.click();
      const end = view.state.doc.content.size - 1;
      view.dispatch(view.state.tr.insertText("?", end));
      expect(text()).toBe(`Intro!\n\n<${TWEET}>\n\nOutro?`);
      session.undo();
      expect(text()).toBe(`Intro!\n\n<${TWEET}>\n\nOutro`);
      session.undo();
      expect(text()).toBe(`Intro!\n\n${TWEET}\n\nOutro`);
      session.undo();
      expect(text()).toBe(`Intro\n\n${TWEET}\n\nOutro`);
    });

    it("turns only its own card", () => {
      const { cards, text } = open(`${TWEET}\n\n${VIDEO}\n\n${TWEET}`);
      cards()[1].querySelector("button")!.click();
      expect(text()).toBe(`${TWEET}\n\n<${VIDEO}>\n\n${TWEET}`);
      cards()[1].querySelector("button")!.click();
      expect(text()).toBe(`${TWEET}\n\n<${VIDEO}>\n\n<${TWEET}>`);
    });

    it.each(["viewer", "commenter"] as const)("does nothing for a %s, and the editor says so to the style sheet that hides the button", (role) => {
      const { view, cards, text } = open(TWEET, role);
      expect(view.dom.getAttribute("contenteditable")).toBe("false");
      cards()[0].querySelector("button")!.click();
      expect(text()).toBe(TWEET);
      expect(cards()).toHaveLength(1);
    });

    it("the commands refuse anything that is not a card", () => {
      const { view, text } = open(`Intro\n\n${TWEET}`);
      expect(showCardAsText(0)(view.state, view.dispatch)).toBe(false);
      expect(showCardAsText(3)(view.state, view.dispatch)).toBe(false);
      expect(showSelectedCardAsText(view.state, view.dispatch)).toBe(false);
      expect(text()).toBe(`Intro\n\n${TWEET}`);
    });
  });

  describe("Show link as card", () => {
    it.each([
      ["in angle brackets", `<${TWEET}>`],
      ["as a Markdown link to itself", `[${TWEET}](${TWEET})`],
    ])("turns a paragraph that is only a known link (%s) into a card, in one undo step", (_what, source) => {
      const { session, view, shape, text } = open(`Intro\n\n${source}\n\nOutro`);
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 10)));
      expect(cardLinkParagraph(view.state)?.url).toBe(TWEET);
      expect(showLinkAsCard(view.state, view.dispatch)).toBe(true);
      expect(text()).toBe(`Intro\n\n${TWEET}\n\nOutro`);
      expect(shape()).toBe(`p(Intro) | card(${TWEET}) | p(Outro)`);
      expect(selectedCard(view.state)?.node.attrs.url).toBe(TWEET);
      session.undo();
      expect(text()).toBe(`Intro\n\n${source}\n\nOutro`);
    });

    it.each([
      ["a link with other text", `[a post](${TWEET})`],
      ["a link in a sentence", `See <${TWEET}> now`],
      ["a link with a title", `[${TWEET}](${TWEET} "title")`],
      ["a link to another site", "<https://example.com/a>"],
      ["a known link in a list item", `- <${TWEET}>`],
      ["a known link in a quote", `> <${TWEET}>`],
      ["a bold known link", `**<${TWEET}>**`],
      ["a known link as the text of a link to another address", `[${TWEET}](https://example.com/a)`],
    ])("refuses %s", (_what, source) => {
      const { view, text } = open(source);
      view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(4))));
      expect(cardLinkParagraph(view.state)).toBeNull();
      expect(showLinkAsCard(view.state, view.dispatch)).toBe(false);
      expect(text()).toBe(source);
    });
    it("the palette's actions: the state says which one applies, and each is its own undo step", () => {
      const { session, view, selectCard, text } = open(`Intro\n\n${TWEET}\n\nOutro`);
      const actions = new EditorActions(session, () => {});
      actions.setRichView(view);
      session.setActiveSurface("rich");
      expect(actions.cardState()).toBeNull();
      selectCard();
      expect(actions.cardState()).toBe("card");
      view.dispatch(view.state.tr.insertText("!", 6));
      selectCard();
      actions.showCard("text");
      expect(text()).toBe(`Intro!\n\n<${TWEET}>\n\nOutro`);
      expect(actions.cardState()).toBe("link");
      actions.showCard("text");
      expect(text()).toBe(`Intro!\n\n<${TWEET}>\n\nOutro`);
      actions.showCard("card");
      expect(text()).toBe(`Intro!\n\n${TWEET}\n\nOutro`);
      expect(actions.cardState()).toBe("card");
      session.undo();
      expect(text()).toBe(`Intro!\n\n<${TWEET}>\n\nOutro`);
      session.undo();
      expect(text()).toBe(`Intro!\n\n${TWEET}\n\nOutro`);
      session.undo();
      expect(text()).toBe(`Intro\n\n${TWEET}\n\nOutro`);
    });

    it("the palette's actions do nothing for someone who cannot edit", () => {
      const { session, view, selectCard, text } = open(TWEET, "commenter");
      const actions = new EditorActions(session, () => {});
      actions.setRichView(view);
      session.setActiveSurface("rich");
      selectCard();
      actions.showCard("text");
      expect(text()).toBe(TWEET);
    });
  });

  describe("typing a link in the rich pane", () => {
    it.each([
      ["a post link", TWEET],
      ["a video link", VIDEO],
    ])("%s typed key by key on an empty line stays a link, in angle brackets in the text, and typing goes on", async (_what, url) => {
      const { view, shape, text, cards } = open("Intro");
      view.dispatch(view.state.tr.insert(view.state.doc.content.size, schema.nodes.paragraph.create()));
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, view.state.doc.content.size - 1)));
      for (const [i, char] of [...url].entries()) {
        view.dispatch(view.state.tr.insertText(char));
        expect(cards(), `after ${i + 1} keys`).toHaveLength(0);
        expect(view.state.doc.child(1).textContent, `after ${i + 1} keys`).toBe(url.slice(0, i + 1));
        expect(view.state.selection.from, `caret after ${i + 1} keys`).toBe(8 + i + 1);
        // The text never holds the bare link alone on its line: a collaborator's preview never shows a card for it.
        expect(parseMarkdown(text()).doc.child(1).type, `after ${i + 1} keys`).toBe(schema.nodes.paragraph);
      }
      expect(text()).toBe(`Intro\n\n<${url}>`);
      // A moment later the pane has taken the text back in (the link is now a link); nothing else changed.
      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(text()).toBe(`Intro\n\n<${url}>`);
      expect(shape()).toBe(`p(Intro) | p(${url})`);
      view.dispatch(view.state.tr.insertText(" and more", view.state.doc.content.size - 1));
      expect(text()).toBe(`Intro\n\n<${url}> and more`);
      expect(cards()).toHaveLength(0);
    });

    it("deleting the words around a link on a line of its own does not make it a card behind the person's back", () => {
      const { view, text, cards } = open(`See ${TWEET}`);
      view.dispatch(view.state.tr.delete(1, 5));
      expect(cards()).toHaveLength(0);
      expect(text()).toBe(`<${TWEET}>`);
    });
  });

  describe("copying a card", () => {
    const htmlToDoc = (html: string) => {
      const dom = document.createElement("div");
      dom.innerHTML = html;
      return PMDOMParser.fromSchema(schema).parse(dom);
    };
    const blocks = (html: string) => {
      const out: string[] = [];
      htmlToDoc(html).forEach((node) => out.push(node.type === schema.nodes.link_card ? `card(${node.attrs.url})` : node.type.name));
      return out.join(" | ");
    };

    it("a copied card is its link as text, and pastes back as the card", () => {
      const { view, selectCard } = open(`Intro\n\n${TWEET}`);
      selectCard();
      const { dom, text } = view.serializeForClipboard(view.state.selection.content());
      expect(text).toBe(TWEET);
      expect(dom.querySelectorAll("script, iframe, [src]")).toHaveLength(0);
      expect(blocks(dom.innerHTML)).toBe(`card(${TWEET})`);
      expect(serializeMarkdown(htmlToDoc(dom.innerHTML))).toBe(TWEET);
    });

    it("pasted HTML cannot make a card of a link that is not on the list, or a card inside a list or a quote", () => {
      expect(blocks(`<div data-link-card="${TWEET}">x</div>`)).toBe(`card(${TWEET})`);
      for (const url of ["https://x.com.evil.example/jack/status/20", "javascript:alert(1)", "", `${TWEET} `, `${TWEET}"><script>alert(1)</script>`]) {
        const html = `<div data-link-card="${url.replace(/"/g, "&quot;")}">text</div>`;
        expect(blocks(html), url).not.toContain("card(");
        expect(htmlToDoc(html).textContent, url).toBe("text");
      }
      for (const html of [`<ul><li><div data-link-card="${TWEET}">x</div></li></ul>`, `<blockquote><div data-link-card="${TWEET}">x</div></blockquote>`]) {
        const parsed = htmlToDoc(html);
        parsed.check();
        parsed.descendants((node, _pos, parent) => {
          if (node.type === schema.nodes.link_card) expect(parent).toBe(parsed);
        });
        // Whatever the parser made of it, the Markdown reads back as the same document.
        const written = serializeMarkdown(parsed);
        expect(parseMarkdown(written).doc.eq(parsed), written).toBe(true);
      }
    });
  });

  describe("pasting a link", () => {
    it("a known link pasted into an empty document becomes a card with an empty line after it", () => {
      const { view, shape, text } = open("");
      view.pasteText(TWEET, clipboard(TWEET));
      expect(text()).toBe(TWEET);
      expect(shape()).toBe(`card(${TWEET}) | p()`);
      // The caret is on the empty line, ready to go on typing.
      expect(view.state.selection.empty).toBe(true);
      expect(view.state.selection.$from.parent.type).toBe(schema.nodes.paragraph);
      expect(view.state.selection.from).toBe(2);
      view.dispatch(view.state.tr.insertText("Next"));
      expect(text()).toBe(`${TWEET}\n\nNext`);
    });

    it("the first undo leaves the plain link, the second the empty line", () => {
      const { session, view, shape, text } = open("Intro");
      view.dispatch(view.state.tr.insert(view.state.doc.content.size, schema.nodes.paragraph.create()));
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, view.state.doc.content.size - 1)));
      session.undoManager.stopCapturing();
      view.pasteText(`  ${VIDEO}\n`, clipboard(`  ${VIDEO}\n`));
      expect(text()).toBe(`Intro\n\n${VIDEO}`);
      expect(shape()).toBe(`p(Intro) | card(${VIDEO}) | p()`);
      session.undo();
      expect(text()).toBe(`Intro\n\n<${VIDEO}>`);
      expect(shape()).toContain(`p(${VIDEO})`);
      expect(shape()).not.toContain("card(");
      session.undo();
      expect(text()).toBe("Intro");
      session.redo();
      session.redo();
      expect(text()).toBe(`Intro\n\n${VIDEO}`);
    });

    it("between two blocks the card takes the empty line and the caret goes to the next block", () => {
      const { view, shape, text } = open("First\n\nLast");
      view.dispatch(view.state.tr.insert(7, schema.nodes.paragraph.create()));
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 8)));
      view.pasteText(TWEET, clipboard(TWEET));
      expect(text()).toBe(`First\n\n${TWEET}\n\nLast`);
      expect(shape()).toBe(`p(First) | card(${TWEET}) | p(Last)`);
      expect(view.state.selection.$from.parent.textContent).toBe("Last");
      expect(view.state.selection.$from.parentOffset).toBe(0);
    });

    it.each([
      ["at the end of a paragraph with text", "Hello", 6, `Hello${TWEET}`],
      ["in a list item", "- ", 3, `- ${TWEET}`],
      ["in a quote", "> a", 3, `> a${TWEET}`],
    ])("%s the link is pasted as text, not as a card", (_what, source, at, expected) => {
      const { view, shape, text } = open(source);
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, at)));
      view.pasteText(TWEET, clipboard(TWEET));
      expect(shape()).not.toContain("card(");
      expect(text()).toBe(expected);
    });

    it.each([
      ["a link to another site", "https://example.com/a"],
      ["a look-alike host", "https://x.com.evil.example/jack/status/20"],
      ["a known link with a word after it", `${TWEET} look`],
      ["http", "http://x.com/jack/status/20"],
    ])("%s pasted on an empty line stays text", (_what, pasted) => {
      const { view, shape } = open("");
      view.pasteText(pasted, clipboard(pasted));
      expect(shape()).not.toContain("card(");
    });

    it("while suggesting, a pasted known link stays a link (and the text keeps it in angle brackets)", () => {
      const { session, view, shape, text } = open("");
      session.setMode("suggesting");
      view.pasteText(TWEET, clipboard(TWEET));
      expect(shape()).not.toContain("card(");
      expect(text()).toBe(`<${TWEET}>`);
    });
  });

  describe("keyboard", () => {
    it("Tab on a selected card moves focus to its link, the button follows it, and Escape returns to the editor with the card selected", () => {
      const { view, cards, selectCard, key } = open(`Intro\n\n${TWEET}\n\nOutro`);
      view.focus();
      selectCard();
      expect(cards()[0].classList.contains("ProseMirror-selectednode")).toBe(true);
      const tab = key("Tab");
      expect(tab.defaultPrevented).toBe(true);
      const link = cards()[0].querySelector("a")!;
      const button = cards()[0].querySelector("button")!;
      expect(document.activeElement).toBe(link);
      // The link and the button are ordinary tab stops, in this order, and no other is inside the card.
      expect(Array.from(cards()[0].querySelectorAll("a[href], button, input, select, textarea, [tabindex]"))).toEqual([link, button]);
      expect(link.tabIndex).toBe(0);
      expect(button.tabIndex).toBe(0);

      button.focus();
      // A key on the button is the button's: the editor does not take Tab, Enter or a letter from it.
      for (const name of ["Tab", "Enter", " ", "a", "Backspace"]) expect(key(name, button).defaultPrevented, name).toBe(false);
      const escape = key("Escape", button);
      expect(escape.defaultPrevented).toBe(true);
      expect(document.activeElement).toBe(view.dom);
      expect(selectedCard(view.state)?.node.attrs.url).toBe(TWEET);
    });

    it("Tab with no card selected is not taken by the card", () => {
      const { view, key } = open(`Intro\n\n${TWEET}`);
      view.focus();
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 2)));
      key("Tab");
      expect(document.activeElement).toBe(view.dom);
    });

    it("for a viewer the link is an ordinary tab stop (a read-only editor takes no keys)", () => {
      const { view, cards } = open(TWEET, "viewer");
      expect(view.dom.getAttribute("contenteditable")).toBe("false");
      const link = cards()[0].querySelector("a")!;
      expect(link.tabIndex).toBe(0);
      expect(link.getAttribute("href")).toBe(TWEET);
    });

    it("Backspace on a selected card removes it, and Enter adds a line after it", () => {
      const { view, selectCard, key, shape, text } = open(`Intro\n\n${TWEET}\n\n${VIDEO}`);
      view.focus();
      selectCard(1);
      key("Enter");
      expect(shape()).toBe(`p(Intro) | card(${TWEET}) | card(${VIDEO}) | p()`);
      selectCard(0);
      key("Backspace");
      expect(text()).toBe(`Intro\n\n${VIDEO}`);
      expect(shape()).toBe(`p(Intro) | card(${VIDEO}) | p()`);
    });
  });

  describe("comments and suggestions on a card", () => {
    const START = "Intro\n\n".length;

    it("a comment on the characters of the link marks the whole card, and stops when it is resolved or gone", () => {
      const { session, view, cards } = open(`Intro\n\n${TWEET}\n\nOutro`);
      const id = session.comments.add({ from: START + 8, to: START + 13, body: "Is this the right post?", author: session.user });
      refreshRichHighlights(view);
      expect(cards()[0].getAttribute("data-card-highlight")).toBe("comment");
      expect(cards()[0].classList.contains("md-card-comment")).toBe(true);
      expect(cards()[0].classList.contains("md-card-active")).toBe(false);
      session.setActiveComment(id);
      refreshRichHighlights(view);
      expect(cards()[0].classList.contains("md-card-active")).toBe(true);
      session.comments.setResolved(id, true, session.user);
      refreshRichHighlights(view);
      expect(cards()[0].getAttribute("data-card-highlight")).toBe("comment-resolved");
      session.comments.remove(id);
      refreshRichHighlights(view);
      expect(cards()[0].hasAttribute("data-card-highlight")).toBe(false);
    });

    it("a comment on the text around the card does not mark it", () => {
      const { session, view, cards } = open(`Intro\n\n${TWEET}\n\nOutro`);
      session.comments.add({ from: 0, to: 5, body: "intro", author: session.user });
      session.comments.add({ from: START + TWEET.length + 2, to: START + TWEET.length + 7, body: "outro", author: session.user });
      refreshRichHighlights(view);
      expect(cards()[0].hasAttribute("data-card-highlight")).toBe(false);
      expect(view.dom.querySelectorAll(".md-comment")).toHaveLength(2);
    });

    it("the comment made with a card selected is on the card's whole line, and it stays on the link after Show as text", () => {
      const { session, view, cards, selectCard } = open(`Intro\n\n${TWEET}\n\nOutro`);
      const actions = new EditorActions(session, () => {});
      actions.setRichView(view);
      session.setActiveSurface("rich");
      selectCard();
      const range = actions.selectionSourceRange();
      expect(range).toEqual({ from: START, to: START + TWEET.length });
      const id = session.comments.add({ ...range!, body: "On the card", author: session.user });
      refreshRichHighlights(view);
      expect(cards()[0].classList.contains("md-card-comment")).toBe(true);

      cards()[0].querySelector("button")!.click();
      refreshRichHighlights(view);
      const thread = session.comments.get(id)!;
      expect(session.ytext.toString().slice(thread.range!.from, thread.range!.to)).toBe(TWEET);
      expect(Array.from(view.dom.querySelectorAll(".md-comment"), (el) => el.textContent).join("")).toBe(TWEET);
      // After a comment, focus returns with the card still selected: there is no caret position in a card.
      session.undo();
      selectCard();
      actions.focusCollapsed();
      expect(selectedCard(view.state)).not.toBeNull();
    });

    it("the cursor of the Markdown pane on the card's line marks the card as the focused block", () => {
      const session = open(`Intro\n\n${TWEET}\n\nOutro`);
      session.view.destroy();
      let focus: number | null = START + 4;
      const view = new EditorView(document.body.appendChild(document.createElement("div")), {
        state: createRichEditorState(session.session, { getFocusSource: () => focus }),
        nodeViews: createNodeViews(() => true),
      });
      cleanups.unshift(() => view.destroy());
      const card = () => view.dom.querySelector<HTMLElement>('[data-testid="link-card"]')!;
      refreshRichHighlights(view);
      expect(card().classList.contains("md-focus-block")).toBe(true);
      expect(view.dom.querySelectorAll(".md-focus-block")).toHaveLength(1);
      focus = 2;
      refreshRichHighlights(view);
      expect(card().classList.contains("md-focus-block")).toBe(false);
      expect(view.dom.querySelector(".md-focus-block")!.textContent).toBe("Intro");
    });

    it("Show as text while suggesting is a suggestion: the text gets the two brackets, the clean text keeps the card", () => {
      const { session, cards, shape, text } = open(`Intro\n\n${TWEET}\n\nOutro`);
      session.setMode("suggesting");
      cards()[0].querySelector("button")!.click();
      expect(text()).toBe(`Intro\n\n<${TWEET}>\n\nOutro`);
      expect(shape()).toBe(`p(Intro) | p(${TWEET}) | p(Outro)`);
      const suggestions = session.suggestions.list();
      expect(suggestions.map((s) => [s.type, text().slice(s.from, s.to)])).toEqual([["insert", "<"], ["insert", ">"]]);
      // What a reader of the published page gets until someone accepts: the card.
      expect(session.suggestions.cleanText()).toBe(`Intro\n\n${TWEET}\n\nOutro`);

      session.reviewSuggestion("rejectAll");
      expect(text()).toBe(`Intro\n\n${TWEET}\n\nOutro`);
      expect(shape()).toBe(`p(Intro) | card(${TWEET}) | p(Outro)`);
    });

    it("accepting that suggestion keeps the plain link", () => {
      const { session, cards, shape, text } = open(TWEET);
      session.setMode("suggesting");
      cards()[0].querySelector("button")!.click();
      session.reviewSuggestion("acceptAll");
      expect(text()).toBe(`<${TWEET}>`);
      expect(session.suggestions.cleanText()).toBe(`<${TWEET}>`);
      expect(shape()).toBe(`p(${TWEET})`);
    });

    it("deleting a card while suggesting keeps the card and marks it as a suggested deletion", async () => {
      const { session, view, cards, selectCard, key, text } = open(`Intro\n\n${TWEET}\n\nOutro`);
      session.setMode("suggesting");
      view.focus();
      selectCard();
      key("Backspace");
      expect(text()).toContain(TWEET);
      // The rich pane takes a whole deleted block back from the text a moment later, as for any block.
      await vi.waitFor(() => expect(cards()).toHaveLength(1));
      refreshRichHighlights(view);
      expect(cards()[0].getAttribute("data-card-highlight")).toBe("suggest-delete");
      // Until someone accepts, the text and the published page keep the card.
      expect(session.suggestions.cleanText()).toBe(text());
      session.reviewSuggestion("rejectAll");
      refreshRichHighlights(view);
      expect(cards()[0].hasAttribute("data-card-highlight")).toBe(false);
    });

    it("a card someone suggests to add is marked as a suggested insertion", () => {
      const { session, view, cards } = open("Intro");
      session.ydoc.transact(() => {
        session.ytext.insert(5, `\n\n${VIDEO}`);
        session.suggestions.recordInserted(5, VIDEO.length + 2, session.user);
      });
      refreshRichHighlights(view);
      expect(cards()).toHaveLength(1);
      expect(cards()[0].getAttribute("data-card-highlight")).toBe("suggest-insert");
      expect(cards()[0].classList.contains("md-card-suggest-insert")).toBe(true);
    });

    it("a find match in the link marks the card", () => {
      const { session, view, cards } = open(`jack\n\n${TWEET}`);
      session.find = { matches: [{ from: 0, to: 4 }, { from: 20, to: 24 }], active: 1 } as typeof session.find;
      refreshRichHighlights(view);
      expect(cards()[0].getAttribute("data-card-highlight")).toBe("find-active");
    });
  });
});
