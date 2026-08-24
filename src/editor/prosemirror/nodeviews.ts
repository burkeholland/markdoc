import type { Node as PMNode } from "prosemirror-model";
import type { EditorView, NodeView, NodeViewConstructor, ViewMutationRecord } from "prosemirror-view";
import { toggleTaskChecked, setCodeBlockLanguage } from "./commands";
import { normalizeLanguage } from "./code-highlight";

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

export function createNodeViews(canEdit: () => boolean): Record<string, NodeViewConstructor> {
  return {
    list_item: (node, view, getPos) => new ListItemView(node, view, getPos, canEdit),
    code_block: (node, view, getPos) => new CodeBlockView(node, view, getPos, canEdit),
  };
}

