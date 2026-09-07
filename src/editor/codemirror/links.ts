import { ViewPlugin } from "@codemirror/view";
import type * as Md from "mdast";
import type { CollabSession } from "../collab/session";
import { ownsLiveHighlight } from "../highlight-activation";
import { parseMarkdown } from "../markdown/parse";
import { installLinkInteractions } from "../links";
import { sourceHighlightAtPointer } from "./highlights";

function definitionHref(node: Md.Nodes, identifier: string): string | null {
  if (node.type === "definition" && node.identifier === identifier) return node.url;
  if ("children" in node) {
    for (const child of node.children) {
      const href = definitionHref(child, identifier);
      if (href !== null) return href;
    }
  }
  return null;
}

function linkAt(node: Md.Nodes, pos: number, tree: Md.Root): string | null {
  const from = node.position?.start.offset;
  const to = node.position?.end.offset;
  if (from === undefined || to === undefined || pos < from || pos >= to) return null;
  if (node.type === "link") return node.url;
  if (node.type === "linkReference") return definitionHref(tree, node.identifier);
  if ("children" in node) {
    for (const child of node.children) {
      const href = linkAt(child, pos, tree);
      if (href !== null) return href;
    }
  }
  return null;
}

export function sourceLinks(session: CollabSession) {
  return ViewPlugin.define((view) => {
    let fallback: { text: string; tree: Md.Root } | null = null;
    const destroy = installLinkInteractions(view.dom, (event) => {
      const target = event.target;
      if (!(target instanceof Element) || !view.contentDOM.contains(target)) return null;
      const widget = target.closest("[contenteditable=false]");
      if (widget && widget !== view.contentDOM) return null;
      const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
      if (pos === null) return null;
      const text = view.state.doc.toString();
      let parsed = session.binding.getTree();
      // The source can be visible while the rich binding still holds its initial remote sync.
      if (parsed.text !== text) {
        if (fallback?.text !== text) fallback = { text, tree: parseMarkdown(text).tree };
        parsed = fallback;
      }
      return linkAt(parsed.tree, pos, parsed.tree);
    }, (start, current) => {
      const anchor = view.posAtCoords({ x: start.clientX, y: start.clientY }, false);
      const head = view.posAtCoords({ x: current.clientX, y: current.clientY }, false);
      if (anchor === null || head === null) return;
      view.focus();
      view.dispatch({ selection: { anchor, head }, userEvent: "select.pointer", scrollIntoView: true });
    }, (event) => {
      const target = sourceHighlightAtPointer(view, event);
      return !!target && ownsLiveHighlight(session, target.kind, target.id, target.sourcePosition);
    });
    return { destroy };
  });
}
