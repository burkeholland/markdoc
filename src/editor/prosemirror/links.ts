import { Plugin, TextSelection } from "prosemirror-state";
import type { CollabSession } from "../collab/session";
import { ownsLiveHighlight } from "../highlight-activation";
import { installLinkInteractions } from "../links";
import { richHighlightAtPointer } from "./highlights";

export function richLinksPlugin(session: CollabSession): Plugin {
  return new Plugin({
    view(view) {
      const destroy = installLinkInteractions(view.dom, (event) => {
        const target = event.target;
        const element = target instanceof Element ? target : target instanceof Node ? target.parentElement : null;
        if (element?.closest(".md-remote-caret")) return null;
        const anchor = element?.closest("a[href]");
        return anchor && view.dom.contains(anchor) ? anchor.getAttribute("href") : null;
      }, (start, current) => {
        const anchor = view.posAtCoords({ left: start.clientX, top: start.clientY });
        const head = view.posAtCoords({ left: current.clientX, top: current.clientY });
        if (!anchor || !head) return;
        view.focus();
        view.dispatch(view.state.tr.setSelection(TextSelection.between(
          view.state.doc.resolve(anchor.pos), view.state.doc.resolve(head.pos),
        )).setMeta("pointer", true).scrollIntoView());
      }, (event) => {
        const target = richHighlightAtPointer(view, session, event);
        return !!target && ownsLiveHighlight(session, target.kind, target.id, target.sourcePosition);
      });
      return { destroy };
    },
  });
}
