import type { Node as PMNode } from "prosemirror-model";
import { NodeSelection } from "prosemirror-state";
import type { EditorView, NodeView, NodeViewConstructor, ViewMutationRecord } from "prosemirror-view";
import { toggleTaskChecked, setCodeBlockLanguage, showCardAsText } from "./commands";
import { normalizeLanguage } from "./code-highlight";
import { cardLinkText, matchLinkCard } from "../markdown/link-cards";
import { safeLinkHref } from "../links";

class ListItemView implements NodeView {
  dom: HTMLElement;
  contentDOM: HTMLElement;
  private checkbox: HTMLElement | null = null;

  constructor(
    private node: PMNode,
    private view: EditorView,
    private getPos: () => number | undefined,
    private canEdit: () => boolean,
  ) {
    this.dom = document.createElement("li");
    this.contentDOM = document.createElement("div");
    this.contentDOM.className = "md-li-content";
    this.dom.appendChild(this.contentDOM);
    this.render();
  }

  private render() {
    const checked: boolean | null = this.node.attrs.checked;
    if (checked === null) {
      this.dom.removeAttribute("data-checked");
      this.dom.classList.remove("md-task-item");
      if (this.checkbox) {
        this.checkbox.remove();
        this.checkbox = null;
      }
      return;
    }
    this.dom.classList.add("md-task-item");
    this.dom.setAttribute("data-checked", checked ? "true" : "false");
    if (!this.checkbox) {
      this.checkbox = document.createElement("span");
      this.checkbox.className = "md-task-checkbox";
      this.checkbox.contentEditable = "false";
      this.checkbox.setAttribute("role", "checkbox");
      this.checkbox.setAttribute("aria-label", "Task");
      this.checkbox.innerHTML =
        '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 8.5l3 3 6-7"/></svg>';
      this.checkbox.addEventListener("mousedown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (!this.canEdit()) return;
        const pos = this.getPos();
        if (pos === undefined) return;
        toggleTaskChecked(pos)(this.view.state, this.view.dispatch);
      });
      this.dom.insertBefore(this.checkbox, this.contentDOM);
    }
    this.checkbox.setAttribute("aria-checked", checked ? "true" : "false");
  }

  update(node: PMNode) {
    if (node.type !== this.node.type) return false;
    this.node = node;
    this.render();
    return true;
  }

  ignoreMutation(mutation: ViewMutationRecord) {
    return this.checkbox ? this.checkbox.contains(mutation.target) : false;
  }

  stopEvent(event: Event) {
    return this.checkbox ? this.checkbox.contains(event.target as Node) : false;
  }
}

class CodeBlockView implements NodeView {
  dom: HTMLElement;
  contentDOM: HTMLElement;
  private input: HTMLInputElement;

  constructor(
    private node: PMNode,
    private view: EditorView,
    private getPos: () => number | undefined,
    private canEdit: () => boolean,
  ) {
    this.dom = document.createElement("pre");
    this.dom.className = "md-code-block";
    this.contentDOM = document.createElement("code");
    this.input = document.createElement("input");
    this.input.className = "md-code-lang-input";
    this.input.placeholder = "language";
    this.input.spellcheck = false;
    this.input.setAttribute("aria-label", "Code block language");
    this.input.addEventListener("mousedown", (e) => e.stopPropagation());
    this.input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter" || e.key === "Escape") {
        e.preventDefault();
        this.input.blur();
        this.view.focus();
      }
    });
    this.input.addEventListener("change", () => this.commit());
    this.input.addEventListener("blur", () => this.commit());
    this.dom.appendChild(this.input);
    this.dom.appendChild(this.contentDOM);
    this.render();
  }

  private commit() {
    if (!this.canEdit()) return;
    const value = this.input.value.trim() || null;
    if (value === (this.node.attrs.language ?? null)) return;
    const pos = this.getPos();
    if (pos === undefined) return;
    setCodeBlockLanguage(pos, value)(this.view.state, this.view.dispatch);
  }

  private render() {
    const lang: string | null = this.node.attrs.language ?? null;
    this.dom.setAttribute("data-language", lang ?? "");
    if (document.activeElement !== this.input) this.input.value = lang ?? "";
    this.input.disabled = !this.canEdit();
    const normalized = normalizeLanguage(lang);
    this.dom.classList.toggle("md-code-unknown-lang", !!lang && !normalized);
  }

  update(node: PMNode) {
    if (node.type !== this.node.type) return false;
    this.node = node;
    this.render();
    return true;
  }

  ignoreMutation(mutation: ViewMutationRecord) {
    return this.input === mutation.target || this.input.contains(mutation.target);
  }

  stopEvent(event: Event) {
    return event.target === this.input;
  }
}

/**
 * A link card (#2317): Markdoc's own markup around a link to a known site. The header names the card,
 * shows the link (it opens in a new tab) and, for people who can edit, "Show as text". Nothing here
 * comes from the other site: no script, no frame, no request.
 *
 * Keyboard: the arrow keys select the card as one block; Tab then moves into it (`focusSelectedCard`),
 * the link and the button are ordinary tab stops, and Escape returns to the editor with the card
 * selected. The button is hidden from people who cannot edit by CSS on the editor's `contenteditable`
 * (see globals.css), since a node view is not redrawn when the role changes.
 */
class LinkCardView implements NodeView {
  dom: HTMLElement;
  private label: HTMLElement;
  private link: HTMLAnchorElement;
  private button: HTMLButtonElement;

  constructor(
    private node: PMNode,
    private view: EditorView,
    private getPos: () => number | undefined,
    private canEdit: () => boolean,
    private isolateUndo: () => void,
  ) {
    this.dom = document.createElement("figure");
    this.dom.className = "md-link-card";
    this.dom.setAttribute("contenteditable", "false");
    this.dom.setAttribute("data-testid", "link-card");

    const header = document.createElement("figcaption");
    header.className = "md-link-card-header";
    this.label = document.createElement("span");
    this.label.className = "md-link-card-label";
    this.link = document.createElement("a");
    this.link.className = "md-link-card-link";
    this.link.target = "_blank";
    this.link.rel = "noopener noreferrer";
    this.button = document.createElement("button");
    this.button.type = "button";
    this.button.className = "md-link-card-as-text";
    this.button.textContent = "Show as text";
    this.button.setAttribute("data-testid", "link-card-as-text");
    this.button.addEventListener("click", (event) => {
      event.preventDefault();
      this.showAsText();
    });
    header.append(this.label, this.link, this.button);
    this.dom.appendChild(header);
    this.dom.addEventListener("keydown", (event) => {
      if (event.key !== "Escape" || !this.isControl(event.target)) return;
      event.preventDefault();
      event.stopPropagation();
      this.selectCard();
    });
    this.render();
  }

  private isControl(target: EventTarget | null): boolean {
    return target instanceof Node && (this.link.contains(target) || this.button.contains(target));
  }

  /** Back to the editor with the card selected: where Tab came from. */
  private selectCard() {
    const pos = this.getPos();
    this.view.focus();
    if (pos === undefined) return;
    this.view.dispatch(this.view.state.tr.setSelection(NodeSelection.create(this.view.state.doc, pos)));
  }

  private showAsText() {
    if (!this.canEdit()) return;
    const pos = this.getPos();
    if (pos === undefined) return;
    // Its own undo step, also right after typing: one undo brings the card back and nothing else.
    this.isolateUndo();
    showCardAsText(pos)(this.view.state, this.view.dispatch);
    this.isolateUndo();
    this.view.focus();
  }

  private render() {
    const url = String(this.node.attrs.url);
    const card = matchLinkCard(url);
    const label = card?.label ?? "Link";
    const text = cardLinkText(url);
    this.dom.setAttribute("data-provider", card?.provider ?? "");
    this.dom.setAttribute("aria-label", `${label}: ${text}`);
    this.label.textContent = label;
    this.link.textContent = text;
    const href = card ? safeLinkHref(url) : undefined;
    if (href) this.link.href = href;
    else this.link.removeAttribute("href");
    // The visible words first, then which card: several cards on a page have several of these buttons.
    this.button.setAttribute("aria-label", `Show as text: ${label}`);
  }

  update(node: PMNode) {
    if (node.type !== this.node.type) return false;
    const changed = node.attrs.url !== this.node.attrs.url;
    this.node = node;
    if (changed) this.render();
    return true;
  }

  ignoreMutation() {
    return true;
  }

  /** Clicks and keys on the link and the button are theirs; anywhere else on the card the editor selects it. */
  stopEvent(event: Event) {
    return this.isControl(event.target);
  }
}

export interface NodeViewOptions {
  /** Called before and after a card's own action so that it is one undo step by itself. */
  isolateUndo?: () => void;
}

export function createNodeViews(canEdit: () => boolean, { isolateUndo = () => {} }: NodeViewOptions = {}): Record<string, NodeViewConstructor> {
  return {
    list_item: (node, view, getPos) => new ListItemView(node, view, getPos, canEdit),
    code_block: (node, view, getPos) => new CodeBlockView(node, view, getPos, canEdit),
    link_card: (node, view, getPos) => new LinkCardView(node, view, getPos, canEdit, isolateUndo),
  };
}

