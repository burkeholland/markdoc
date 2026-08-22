"use client";

import * as Y from "yjs";
import { HocuspocusProvider, type WebSocketStatus } from "@hocuspocus/provider";
import type { Awareness } from "y-protocols/awareness";
import { CommentsModel, COMMENTS_ORIGIN } from "./comments";
import { SuggestionsModel, SUGGESTIONS_ORIGIN } from "./suggestions";
import { MarkdownBinding } from "../sync/markdown-binding";
import type { CollabUser } from "./shared";
import type { Role } from "@/server/db/schema";

export type EditMode = "editing" | "suggesting" | "viewing";
export type Surface = "code" | "rich";
export type SaveState = "saved" | "saving" | "offline" | "connecting" | "error";

export interface PresenceUser extends CollabUser {
  clientId: number;
  /** Source offset of the user's cursor head, if known. */
  cursor: number | null;
  isLocal: boolean;
}

export interface CollabSessionOptions {
  docId: string;
  user: CollabUser;
  role: Role;
  /** Returns a fresh collaboration token. */
  getToken: () => Promise<string>;
  wsUrl?: string;
}

type Listener = () => void;

/**
 * Owns everything that is shared between the two editing surfaces for one
 * open document: the Y.Doc and provider, presence, undo history, comments and
 * suggestions models, and the Markdown binding used by the rich editor.
 */
export class CollabSession {
  readonly ydoc = new Y.Doc();
  readonly ytext: Y.Text;
  readonly meta: Y.Map<unknown>;
  readonly provider: HocuspocusProvider;
  readonly awareness: Awareness;
  readonly undoManager: Y.UndoManager;
  readonly comments: CommentsModel;
  readonly suggestions: SuggestionsModel;
  readonly binding: MarkdownBinding;
  readonly user: CollabUser;
  readonly role: Role;
  readonly docId: string;

  status: WebSocketStatus | "connecting" = "connecting";
  synced = false;
  authError: string | null = null;
  unsyncedChanges = 0;
  mode: EditMode;
  activeSurface: Surface = "rich";
  /** Currently highlighted comment thread (shared by both panes and the sidebar). */
  activeCommentId: string | null = null;
  activeSuggestionId: string | null = null;
  /** Pending comment composer anchored to a selection, if any. */
  pendingComment: { from: number; to: number } | null = null;
  private listeners = new Set<Listener>();
  private notifyScheduled = false;
  private destroyed = false;

  constructor(readonly options: CollabSessionOptions) {
    this.docId = options.docId;
    this.user = options.user;
    this.role = options.role;
    this.mode = options.role === "viewer" || options.role === "commenter" ? "viewing" : "editing";
    this.ytext = this.ydoc.getText("content");
    this.meta = this.ydoc.getMap("meta");

    const url = options.wsUrl ?? defaultWsUrl();
    this.provider = new HocuspocusProvider({
      url,
      name: options.docId,
      document: this.ydoc,
      token: () => options.getToken(),
      onStatus: ({ status }) => {
        this.status = status;
        this.notify();
      },
      onSynced: ({ state }) => {
        this.synced = state;
        this.notify();
      },
      onAuthenticationFailed: ({ reason }) => {
        this.authError = reason;
        this.notify();
      },
      onAuthenticated: () => {
        this.authError = null;
        this.notify();
      },
      onUnsyncedChanges: ({ number }) => {
        this.unsyncedChanges = number;
        this.notify();
      },
      onAwarenessChange: () => this.notify(),
    });
    this.awareness = this.provider.awareness!;
    this.awareness.setLocalStateField("user", {
      id: options.user.id,
      name: options.user.name,
      color: options.user.color,
      colorLight: options.user.colorLight,
      avatar: options.user.avatar ?? null,
    });

    this.undoManager = new Y.UndoManager(this.ytext, {
      captureTimeout: 400,
      trackedOrigins: new Set([SUGGESTIONS_ORIGIN, COMMENTS_ORIGIN]),
    });
    this.comments = new CommentsModel(this.ydoc, this.ytext);
    this.suggestions = new SuggestionsModel(this.ydoc, this.ytext);
    this.binding = new MarkdownBinding(this.ytext, { onSync: () => this.notify() });
    this.undoManager.addTrackedOrigin(this.binding);
    this.undoManager.on("stack-item-added", this.notify);
    this.undoManager.on("stack-item-popped", this.notify);
    this.undoManager.on("stack-cleared", this.notify);
    this.comments.subscribe(this.notify);
    this.suggestions.subscribe(this.notify);
    this.meta.observe(this.notify);
    this.ytext.observe(this.notify);
  }

  get canEdit(): boolean {
    return (this.role === "owner" || this.role === "editor") && this.mode !== "viewing";
  }

  get canComment(): boolean {
    return this.role !== "viewer";
  }

  /** Whether comment changes must go through the REST API (read-only connections). */
  get commentsViaApi(): boolean {
    return !(this.role === "owner" || this.role === "editor");
  }

  get saveState(): SaveState {
    if (this.authError) return "error";
    if (this.status === "connecting") return "connecting";
    if (this.status !== "connected") return "offline";
    if (!this.synced || this.unsyncedChanges > 0) return "saving";
    return "saved";
  }

  get title(): string {
    const t = this.meta.get("title");
    return typeof t === "string" ? t : "";
  }

  setTitle(title: string) {
    this.ydoc.transact(() => this.meta.set("title", title), COMMENTS_ORIGIN);
  }

  setMode(mode: EditMode) {
    if (mode !== "viewing" && !(this.role === "owner" || this.role === "editor")) return;
    this.mode = mode;
    this.notify();
  }

  setActiveSurface(surface: Surface) {
    if (this.activeSurface === surface) return;
    this.activeSurface = surface;
    this.notify();
  }

  setActiveComment(id: string | null) {
    if (this.activeCommentId === id) return;
    this.activeCommentId = id;
    if (id) this.activeSuggestionId = null;
    this.notify();
  }

  setActiveSuggestion(id: string | null) {
    if (this.activeSuggestionId === id) return;
    this.activeSuggestionId = id;
    if (id) this.activeCommentId = null;
    this.notify();
  }

  setPendingComment(range: { from: number; to: number } | null) {
    this.pendingComment = range;
    this.notify();
  }

  /** Users currently present, one entry per user (a user may have several tabs). */
  presence(): PresenceUser[] {
    const byUser = new Map<string, PresenceUser>();
    const localId = this.ydoc.clientID;
    this.awareness.getStates().forEach((state, clientId) => {
      const u = state.user as Partial<CollabUser> | undefined;
      if (!u?.id) return;
      let cursor: number | null = null;
      const head = (state.cursor as { head?: unknown } | undefined)?.head;
      if (head) {
        try {
          const abs = Y.createAbsolutePositionFromRelativePosition(
            Y.createRelativePositionFromJSON(head as Parameters<typeof Y.createRelativePositionFromJSON>[0]),
            this.ydoc,
          );
          if (abs && abs.type === this.ytext) cursor = abs.index;
        } catch {
          cursor = null;
        }
      }
      const entry: PresenceUser = {
        id: u.id,
        name: u.name ?? "Anonymous",
        color: u.color ?? "#2563eb",
        colorLight: u.colorLight ?? "#2563eb33",
        avatar: u.avatar ?? null,
        clientId,
        cursor,
        isLocal: clientId === localId,
      };
      const existing = byUser.get(u.id);
      if (!existing || (existing.cursor === null && cursor !== null) || entry.isLocal) byUser.set(u.id, entry);
    });
    return Array.from(byUser.values()).sort((a, b) => (a.isLocal ? -1 : b.isLocal ? 1 : a.name.localeCompare(b.name)));
  }

  undo() {
    this.undoManager.undo();
  }

  redo() {
    this.undoManager.redo();
  }

  get canUndo(): boolean {
    return this.undoManager.canUndo();
  }

  get canRedo(): boolean {
    return this.undoManager.canRedo();
  }

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private notify = () => {
    if (this.destroyed || this.notifyScheduled) return;
    this.notifyScheduled = true;
    queueMicrotask(() => {
      this.notifyScheduled = false;
      this.version++;
      for (const l of this.listeners) l();
    });
  };

  /** Monotonic counter used as a React snapshot for useSyncExternalStore. */
  version = 0;

  destroy() {
    this.destroyed = true;
    this.listeners.clear();
    this.binding.destroy();
    this.comments.destroy();
    this.suggestions.destroy();
    this.undoManager.destroy();
    this.provider.destroy();
    this.ydoc.destroy();
  }
}

export function defaultWsUrl(): string {
  if (typeof window === "undefined") return "ws://localhost:3000/collab";
  const proto = window.location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${window.location.host}/collab`;
}
