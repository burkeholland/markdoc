import { ViewPlugin, type EditorView, type ViewUpdate } from "@codemirror/view";
import type { CollabSession } from "../collab/session";
import { isSameAccount } from "../collab/identity";
import { isIdle } from "../collab/follow";
import { fitRemoteCaretLabels, watchRemoteCaretLabels } from "../collab/remote-caret-labels";

function colorKey(color: string): string {
  const element = document.createElement("span");
  element.style.backgroundColor = color;
  return element.style.backgroundColor;
}

function matchingUserId(session: CollabSession, caret: HTMLElement, name: string): string | null {
  const caretColor = colorKey(caret.style.backgroundColor);
  if (!caretColor) return null;

  const matchingIds = new Set<string>();
  session.awareness.getStates().forEach((state, clientId) => {
    if (clientId === session.ydoc.clientID) return;
    const user = state.user as { id?: unknown; name?: unknown; color?: unknown } | undefined;
    const cursor = state.cursor as { anchor?: unknown; head?: unknown } | undefined;
    if (
      !cursor?.anchor ||
      !cursor.head ||
      typeof user?.id !== "string" ||
      user.name !== name ||
      typeof user.color !== "string" ||
      colorKey(user.color) !== caretColor
    ) return;
    matchingIds.add(user.id);
  });
  return matchingIds.size === 1 ? matchingIds.values().next().value ?? null : null;
}

/**
 * Presence interactions on y-codemirror.next's remote carets: collaborator labels start
 * following that user, while same-account tabs stay visible but aren't treated as collaborators.
 *
 * y-codemirror exposes only the user's name and colour; awareness IDs are used when that pair
 * identifies one collaborator unambiguously.
 */
export function remoteCaretInteractions(session: CollabSession) {
  return ViewPlugin.fromClass(
    class {
      private unsubscribe: () => void;
      private stopWatchingLabels: () => void;

      constructor(private view: EditorView) {
        this.view.dom.addEventListener("mousedown", this.onMouseDown, true);
        this.view.dom.addEventListener("click", this.onClick, true);
        this.stopWatchingLabels = watchRemoteCaretLabels(this.view.dom);
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
        this.stopWatchingLabels();
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
        const caret = label.closest<HTMLElement>(".cm-ySelectionCaret");
        if (!caret || caret.hasAttribute("data-same-account")) return;
        const userId = caret.dataset.userId;
        if (!userId) return;
        const user = session.presence().find((u) => !u.isLocal && u.id === userId);
        if (user) session.follow(user.id);
      };

      private sync() {
        const carets = this.view.contentDOM.querySelectorAll<HTMLElement>(".cm-ySelectionCaret");
        if (carets.length === 0) {
          fitRemoteCaretLabels(this.view.dom);
          return;
        }
        const users = session.presence().filter((u) => !u.isLocal);
        const now = Date.now();
        carets.forEach((caret) => {
          const label = caret.querySelector<HTMLElement>(".cm-ySelectionInfo");
          if (!label) return;
          const name = label.dataset.originalName ?? label.textContent ?? "";
          const userId = matchingUserId(session, caret, name);
          if (userId && isSameAccount(session.user.id, userId)) {
            label.dataset.originalName = name;
            label.textContent = `${name} (you in another tab)`;
            label.style.pointerEvents = "none";
            label.style.cursor = "default";
            label.title = `${name} is your cursor in another tab`;
            caret.dataset.userId = userId;
            caret.dataset.sameAccount = "";
            return;
          }
          if (label.dataset.originalName !== undefined) {
            label.textContent = label.dataset.originalName;
            delete label.dataset.originalName;
          }
          delete caret.dataset.sameAccount;
          const user = users.find((u) => u.id === userId);
          if (!user) {
            delete caret.dataset.userId;
            toggle(caret, "following", false);
            toggle(caret, "flash", false);
            toggle(caret, "idle", false);
            toggle(caret, "agent", false);
            label.style.pointerEvents = "none";
            label.style.cursor = "default";
            label.title = "";
            return;
          }
          caret.dataset.userId = user.id;
          toggle(caret, "following", session.followUserId === user.id);
          toggle(caret, "flash", session.flashUserId === user.id);
          toggle(caret, "idle", isIdle(user.idleSince, now));
          toggle(caret, "agent", user.isAgent);
          if (label) {
            label.style.pointerEvents = "auto";
            label.style.cursor = "pointer";
            label.title = user.isAgent ? `Follow ${user.name} (agent)` : `Follow ${user.name}`;
          }
        });
        fitRemoteCaretLabels(this.view.dom);
      }
    },
  );
}

function toggle(el: HTMLElement, attr: string, on: boolean) {
  if (on) el.dataset[attr] = "";
  else delete el.dataset[attr];
}
