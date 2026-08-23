import { ViewPlugin, type EditorView, type ViewUpdate } from "@codemirror/view";
import type { CollabSession } from "../collab/session";
import { isIdle } from "../collab/follow";

/**
 * Presence interactions on the remote carets y-codemirror.next draws in the code pane:
 * clicking a caret label starts following that user, and the caret elements get the same
 * `data-following` / `data-flash` / `data-idle` attributes as the rich pane's carets.
 *
 * y-codemirror's widgets know only the user's name and colour, so carets are matched to
 * presence entries by name.
 */
export function remoteCaretInteractions(session: CollabSession) {
  return ViewPlugin.fromClass(
    class {
      private unsubscribe: () => void;

      constructor(private view: EditorView) {
        this.view.dom.addEventListener("mousedown", this.onMouseDown, true);
        this.view.dom.addEventListener("click", this.onClick, true);
        this.unsubscribe = session.subscribe(() => this.sync());
        this.sync();
      }

      update(update: ViewUpdate) {
        // Decorations reach the DOM after plugin updates; re-tag the carets in the measure phase.
        if (update.docChanged || update.viewportChanged || update.transactions.length > 0) {
          this.view.requestMeasure({ read: () => this.sync(), key: this });
        }
      }

      destroy() {
        this.view.dom.removeEventListener("mousedown", this.onMouseDown, true);
        this.view.dom.removeEventListener("click", this.onClick, true);
        this.unsubscribe();
      }

      private labelTarget(e: Event): HTMLElement | null {
        const t = e.target;
        return t instanceof Element ? (t.closest(".cm-ySelectionInfo") as HTMLElement | null) : null;
      }

      private onMouseDown = (e: MouseEvent) => {
        if (!this.labelTarget(e)) return;
        // Keep the click from moving the local caret.
        e.preventDefault();
        e.stopPropagation();
      };

      private onClick = (e: MouseEvent) => {
        const label = this.labelTarget(e);
        if (!label) return;
        e.preventDefault();
        e.stopPropagation();
        const user = session.presence().find((u) => !u.isLocal && u.name === label.textContent);
        if (user) session.follow(user.id);
      };

      private sync() {
        const carets = this.view.contentDOM.querySelectorAll<HTMLElement>(".cm-ySelectionCaret");
        if (carets.length === 0) return;
        const users = session.presence().filter((u) => !u.isLocal);
        const now = Date.now();
        carets.forEach((caret) => {
          const label = caret.querySelector<HTMLElement>(".cm-ySelectionInfo");
          const user = users.find((u) => u.name === label?.textContent);
          if (!user) return;
          caret.dataset.userId = user.id;
          toggle(caret, "following", session.followUserId === user.id);
          toggle(caret, "flash", session.flashUserId === user.id);
          toggle(caret, "idle", isIdle(user.idleSince, now));
          if (label) {
            label.style.pointerEvents = "auto";
            label.style.cursor = "pointer";
            label.title = `Follow ${user.name}`;
          }
        });
      }
    },
  );
}

function toggle(el: HTMLElement, attr: string, on: boolean) {
  if (on) el.dataset[attr] = "";
  else delete el.dataset[attr];
}
