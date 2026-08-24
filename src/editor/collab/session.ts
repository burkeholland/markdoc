"use client";

import * as Y from "yjs";
import { HocuspocusProvider, type WebSocketStatus } from "@hocuspocus/provider";
import type { Awareness } from "y-protocols/awareness";
import { CommentsModel, COMMENTS_ORIGIN } from "./comments";
import { SuggestionsModel, SUGGESTIONS_ORIGIN } from "./suggestions";
import { MarkdownBinding } from "../sync/markdown-binding";
import {
  clearLocalDocument,
  ensureLocalEpoch,
  hasIndexedDB,
  openLocalPersistence,
  type ConnectionPhase,
  type LocalPersistence,
} from "./offline";
import type { CollabUser } from "./shared";
import type { Role } from "@/server/db/schema";
import {
  carryActiveIndex,
  DEFAULT_FIND_OPTIONS,
  expandReplacement,
  findMatches,
  matchIndexAfter,
  type FindMatch,
  type FindOptions,
} from "../find";
import { ACTIVITY_THROTTLE_MS, followReducer, sectionAt, type FollowEvent } from "./follow";
import type { HeadingInfo } from "../markdown/parse";

export type EditMode = "editing" | "suggesting" | "viewing";
export type Surface = "code" | "rich";
export type SaveState = ConnectionPhase;

/** How long the "All changes saved" highlight stays after a reconnect. */
export const RECOVERED_FLASH_MS = 2000;

export interface FindState {
  query: string;
  options: FindOptions;
  matches: FindMatch[];
  /** Index into `matches`, or -1 when there are none. */
  active: number;
}

/** Origin for direct source edits made outside the editors (find & replace); tracked by undo. */
export const LOCAL_EDIT_ORIGIN = { name: "local-edit" };

export interface PresenceUser extends CollabUser {
  clientId: number;
  /** Source offset of the user's cursor head, if known. */
  cursor: number | null;
  /** Text of the nearest heading above the cursor, or null before the first heading / without a cursor. */
  section: string | null;
  /** Timestamp (ms) the client last reported activity; null when it never did. */
  idleSince: number | null;
  /** The user's role on this document, when their client published it. */
  role: Role | null;
  isLocal: boolean;
}

export interface CollabSessionOptions {
  docId: string;
  user: CollabUser;
  role: Role;
  /** Returns a fresh collaboration token. */
  getToken: () => Promise<string>;
  wsUrl?: string;
  /**
   * Do not open the IndexedDB copy in the constructor; the owner calls
   * {@link CollabSession.startLocalPersistence} once React has hydrated, so
   * locally stored content cannot make the client's first render differ from the server's.
   */
  deferLocal?: boolean;
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
  /** Set when the server told us the document was moved to the trash; the editor navigates away. */
  trashed = false;
  unsyncedChanges = 0;
  /** Whether the locally persisted (IndexedDB) state has been applied; true at once when unavailable. */
  localLoaded = false;
  /** Resolves when {@link localLoaded} becomes true. */
  readonly whenLocalLoaded: Promise<void>;
  private resolveLocalLoaded!: () => void;
  /** True for a moment after a reconnect finished syncing, so the UI can flash a confirmation. */
  recovered = false;
  private everConnected = false;
  private wasOffline = false;
  private recoveredTimer: ReturnType<typeof setTimeout> | null = null;
  private local: LocalPersistence | null = null;
  private localStarted = false;
  mode: EditMode;
  activeSurface: Surface = "rich";
  /** Currently highlighted comment thread (shared by both panes and the sidebar). */
  activeCommentId: string | null = null;
  activeSuggestionId: string | null = null;
  /** Bumped by `revealComment` so the comments panel re-picks its tab even when the thread was already active. */
  revealSeq = 0;
  /** Pending comment composer anchored to a selection, if any. */
  pendingComment: { from: number; to: number } | null = null;
  /** Find & replace state while the find bar is open (matches are in source offsets). */
  find: FindState | null = null;
  /** Collaborator whose cursor the viewport is glued to, if any. */
  followUserId: string | null = null;
  /** Set (with a fresh `seq`) when following ended because that user left, so the shell can toast. */
  followEnded: { name: string; seq: number } | null = null;
  /** Collaborator whose remote caret is flashing (after "Jump"), if any. */
  flashUserId: string | null = null;
  private flashTimer: ReturnType<typeof setTimeout> | null = null;
  private lastActivityPublish = 0;
  private sectionCache: { headings: HeadingInfo[]; byOffset: Map<number, string | null> } | null = null;
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

    // Mirror the document into IndexedDB so offline edits survive a refresh. Yjs merges
    // the local and server states whichever arrives first, so this need not block connecting.
    this.whenLocalLoaded = new Promise<void>((resolve) => {
      this.resolveLocalLoaded = resolve;
    });
    if (!options.deferLocal) this.startLocalPersistence();

    const url = options.wsUrl ?? defaultWsUrl();
    this.provider = new HocuspocusProvider({
      url,
      name: options.docId,
      document: this.ydoc,
      token: () => options.getToken(),
      onStatus: ({ status }) => {
        this.status = status;
        if (status === "connected") {
          this.everConnected = true;
        } else {
          // The provider resets its own synced flag on close without emitting; mirror it.
          this.synced = false;
          if (this.everConnected) this.wasOffline = true;
        }
        this.updateRecovery();
        this.notify();
      },
      onSynced: ({ state }) => {
        this.synced = state;
        this.updateRecovery();
        this.notify();
      },
      onAuthenticationFailed: ({ reason }) => {
        this.authError = reason;
        // Access was refused: do not keep a copy of the document on this device.
        void this.clearLocal();
        this.notify();
      },
      onAuthenticated: () => {
        this.authError = null;
        this.notify();
      },
      onUnsyncedChanges: ({ number }) => {
        this.unsyncedChanges = number;
        // Pending changes while not connected (e.g. restored from IndexedDB after a reload
        // that happened offline) should also get the "All changes saved" confirmation.
        if (number > 0 && this.status !== "connected") this.wasOffline = true;
        this.updateRecovery();
        this.notify();
      },
      onAwarenessChange: () => {
        this.checkFollowedPresence();
        this.notify();
      },
      onStateless: ({ payload }) => {
        let message: { type?: string } | null = null;
        try {
          message = JSON.parse(payload) as { type?: string };
        } catch {
          return;
        }
        if (message?.type !== "trashed" || this.trashed) return;
        this.trashed = true;
        // Stop reconnecting: the server will refuse a token for a trashed document anyway.
        this.provider.disconnect();
        this.notify();
      },
    });
    this.awareness = this.provider.awareness!;
    this.awareness.setLocalStateField("user", {
      id: options.user.id,
      name: options.user.name,
      color: options.user.color,
      colorLight: options.user.colorLight,
      avatar: options.user.avatar ?? null,
      login: options.user.login ?? null,
      role: options.role,
    });
    this.awareness.setLocalStateField("lastActive", Date.now());
    this.lastActivityPublish = Date.now();

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
    this.ytext.observe(this.refreshFind);
    this.undoManager.addTrackedOrigin(LOCAL_EDIT_ORIGIN);
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
    if (this.status === "connecting") return this.everConnected ? "reconnecting" : "connecting";
    if (this.status !== "connected") return "offline";
    if (!this.synced || this.unsyncedChanges > 0) return "saving";
    return "saved";
  }

  /**
   * After a connection drop, the first time everything is synced again set
   * {@link recovered} for {@link RECOVERED_FLASH_MS} so the header can confirm it.
   */
  private updateRecovery() {
    if (!this.wasOffline || this.saveState !== "saved") return;
    this.wasOffline = false;
    this.recovered = true;
    if (this.recoveredTimer) clearTimeout(this.recoveredTimer);
    this.recoveredTimer = setTimeout(() => {
      this.recoveredTimer = null;
      this.recovered = false;
      this.notify();
    }, RECOVERED_FLASH_MS);
  }

  /**
   * Open the IndexedDB copy of this document (no-op when already started, destroyed,
   * or IndexedDB is unavailable, in which case {@link localLoaded} becomes true at once).
   * Mirrors from an older {@link IDB_EPOCH} are wiped first, before y-indexeddb can
   * apply them; the provider may sync meanwhile, the fresh mirror then stores its state.
   */
  startLocalPersistence() {
    if (this.localStarted) return;
    this.localStarted = true;
    if (this.destroyed) return;
    const markLoaded = () => {
      this.localLoaded = true;
      this.resolveLocalLoaded();
      this.notify();
    };
    if (!hasIndexedDB()) {
      markLoaded();
      return;
    }
    void ensureLocalEpoch().then((usable) => {
      if (!this.destroyed && usable) this.local = openLocalPersistence(this.docId, this.ydoc);
      if (!this.local) {
        markLoaded();
        return;
      }
      void this.local.whenLoaded.then(markLoaded);
    });
  }

  /** Delete this document's local (IndexedDB) copy, e.g. when it is deleted or access is lost. */
  async clearLocal(): Promise<void> {
    if (!this.local) {
      await clearLocalDocument(this.docId);
      return;
    }
    await this.local.clear();
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

  /** Activate a thread from outside the panel (notification, `?thread=`): the panel switches to its tab even if it was already active. */
  revealComment(id: string) {
    this.revealSeq++;
    this.activeCommentId = id;
    this.activeSuggestionId = null;
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

  // ---- Find & replace -------------------------------------------------------

  /** Open (or update) the find bar state; matches are recomputed immediately. */
  setFind(query: string, options: FindOptions = this.find?.options ?? DEFAULT_FIND_OPTIONS) {
    const previous = this.find?.matches[this.find.active] ?? null;
    const matches = findMatches(this.ytext.toString(), query, options);
    const changedQuery = !this.find || this.find.query !== query || this.find.options !== options;
    let active: number;
    if (changedQuery) {
      // Start from the match nearest the caret so the first hit is where the user is looking.
      active = matchIndexAfter(matches, this.findAnchor());
    } else {
      active = carryActiveIndex(matches, previous);
    }
    this.find = { query, options, matches, active };
    this.notify();
  }

  closeFind() {
    if (!this.find) return;
    this.find = null;
    this.notify();
  }

  /** Move the active match by `step` (wrapping). Returns the new active match. */
  stepFind(step: 1 | -1): FindMatch | null {
    const f = this.find;
    if (!f || f.matches.length === 0) return null;
    const active = (f.active + step + f.matches.length) % f.matches.length;
    this.find = { ...f, active };
    this.notify();
    return f.matches[active];
  }

  /** Source offset used as the starting point when a search begins: the local caret, if known. */
  private findAnchor(): number {
    const local = this.presence().find((u) => u.isLocal);
    return local?.cursor ?? 0;
  }

  private refreshFind = () => {
    if (!this.find) return;
    const previous = this.find.matches[this.find.active] ?? null;
    const matches = findMatches(this.ytext.toString(), this.find.query, this.find.options);
    this.find = { ...this.find, matches, active: carryActiveIndex(matches, previous) };
  };

  /**
   * Replace the active match and advance to the next one. Returns the match that
   * becomes active afterwards (so the UI can reveal it), or null.
   */
  replaceActive(replacement: string): FindMatch | null {
    const f = this.find;
    if (!f || f.active < 0 || !this.canEdit) return null;
    const match = f.matches[f.active];
    const text = expandReplacement(this.ytext.toString(), match, f.query, f.options, replacement);
    this.replaceSource([{ from: match.from, to: match.to, text }]);
    const next = this.find;
    if (!next || next.matches.length === 0) return null;
    // After the edit the active index points at the match that followed the replaced one.
    const idx = matchIndexAfter(next.matches, match.from + (this.mode === "suggesting" ? match.to - match.from + text.length : text.length));
    this.find = { ...next, active: idx === -1 ? 0 : idx };
    this.notify();
    return this.find.matches[this.find.active] ?? null;
  }

  /** Replace every match. Returns how many were replaced. */
  replaceAll(replacement: string): number {
    const f = this.find;
    if (!f || f.matches.length === 0 || !this.canEdit) return 0;
    const text = this.ytext.toString();
    const edits = f.matches.map((m) => ({ from: m.from, to: m.to, text: expandReplacement(text, m, f.query, f.options, replacement) }));
    this.replaceSource(edits);
    return edits.length;
  }

  /**
   * Apply source edits (non-overlapping, any order) as one undoable step. In
   * suggesting mode they become tracked changes instead of direct edits.
   */
  replaceSource(edits: { from: number; to: number; text: string }[]) {
    if (!this.canEdit || edits.length === 0) return;
    const sorted = [...edits].sort((a, b) => b.from - a.from);
    if (this.mode === "suggesting") {
      this.ydoc.transact(() => {
        for (const e of sorted) {
          if (e.to > e.from) this.suggestions.markDeleted(e.from, e.to, this.user);
          if (e.text) {
            this.ytext.insert(e.from, e.text);
            this.suggestions.recordInserted(e.from, e.text.length, this.user);
          }
        }
      }, SUGGESTIONS_ORIGIN);
      return;
    }
    this.ydoc.transact(() => {
      for (const e of sorted) {
        if (e.to > e.from) this.ytext.delete(e.from, e.to - e.from);
        if (e.text) this.ytext.insert(e.from, e.text);
      }
    }, LOCAL_EDIT_ORIGIN);
  }

  /** Users currently present, one entry per user (a user may have several tabs). */
  presence(): PresenceUser[] {
    const byUser = new Map<string, PresenceUser>();
    const localId = this.ydoc.clientID;
    this.awareness.getStates().forEach((state, clientId) => {
      const u = state.user as (Partial<CollabUser> & { role?: Role }) | undefined;
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
      const lastActive = state.lastActive;
      const entry: PresenceUser = {
        id: u.id,
        name: u.name ?? "Anonymous",
        color: u.color ?? "#2563eb",
        colorLight: u.colorLight ?? "#2563eb33",
        avatar: u.avatar ?? null,
        login: u.login ?? null,
        clientId,
        cursor,
        section: this.sectionAt(cursor),
        idleSince: typeof lastActive === "number" ? lastActive : null,
        role: u.role ?? null,
        isLocal: clientId === localId,
      };
      const existing = byUser.get(u.id);
      if (!existing || (existing.cursor === null && cursor !== null) || entry.isLocal) byUser.set(u.id, entry);
    });
    return Array.from(byUser.values()).sort((a, b) => (a.isLocal ? -1 : b.isLocal ? 1 : a.name.localeCompare(b.name)));
  }

  /** Nearest heading above a source offset, memoised per heading list (the binding caches the parse). */
  private sectionAt(offset: number | null): string | null {
    if (offset === null) return null;
    const headings = this.binding.getHeadings();
    if (!this.sectionCache || this.sectionCache.headings !== headings) {
      this.sectionCache = { headings, byOffset: new Map() };
    }
    const cache = this.sectionCache.byOffset;
    let section = cache.get(offset);
    if (section === undefined) {
      section = sectionAt(headings, offset);
      cache.set(offset, section);
    }
    return section;
  }

  // ---- Presence interactions ------------------------------------------------

  /**
   * Publish that the local user is active (called on selection changes, throttled) so
   * collaborators can dim carets that have not moved for a while.
   */
  touchActivity() {
    const now = Date.now();
    if (now - this.lastActivityPublish < ACTIVITY_THROTTLE_MS) return;
    this.lastActivityPublish = now;
    this.awareness.setLocalStateField("lastActive", now);
  }

  /** Start following a collaborator's cursor (null stops). */
  follow(userId: string | null) {
    this.dispatchFollow(userId ? { type: "follow", userId } : { type: "stop" });
  }

  /** Feed the follow state machine; returns whether the followed user changed. */
  dispatchFollow(event: FollowEvent): boolean {
    const next = followReducer(this.followUserId, event);
    if (next.left) {
      const name = this.knownNames.get(next.left) ?? "A collaborator";
      this.followEnded = { name, seq: (this.followEnded?.seq ?? 0) + 1 };
    }
    if (next.userId === this.followUserId && !next.left) return false;
    this.followUserId = next.userId;
    this.notify();
    return true;
  }

  /** Names seen in awareness, so a "left" notice can name the user after their state is gone. */
  private knownNames = new Map<string, string>();

  private checkFollowedPresence() {
    const ids: string[] = [];
    this.awareness.getStates().forEach((state) => {
      const u = state.user as Partial<CollabUser> | undefined;
      if (!u?.id) return;
      ids.push(u.id);
      if (u.name) this.knownNames.set(u.id, u.name);
    });
    if (this.followUserId !== null) this.dispatchFollow({ type: "presence", userIds: ids });
  }

  /** Flash a collaborator's remote caret for a second (after "Jump"). */
  flashUser(userId: string, ms = 1000) {
    this.flashUserId = userId;
    if (this.flashTimer) clearTimeout(this.flashTimer);
    this.flashTimer = setTimeout(() => {
      this.flashTimer = null;
      this.flashUserId = null;
      this.notify();
    }, ms);
    this.notify();
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

  private destroyTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Destroy shortly unless {@link keepAlive} is called first. React StrictMode
   * runs effect cleanups once on mount, so the owner must be able to cancel.
   */
  scheduleDestroy(delayMs = 150) {
    if (this.destroyTimer) clearTimeout(this.destroyTimer);
    this.destroyTimer = setTimeout(() => this.destroy(), delayMs);
  }

  keepAlive() {
    if (this.destroyTimer) clearTimeout(this.destroyTimer);
    this.destroyTimer = null;
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.recoveredTimer) clearTimeout(this.recoveredTimer);
    if (this.flashTimer) clearTimeout(this.flashTimer);
    this.listeners.clear();
    this.binding.destroy();
    this.comments.destroy();
    this.suggestions.destroy();
    this.undoManager.destroy();
    this.provider.destroy();
    void this.local?.destroy();
    this.ydoc.destroy();
  }
}

export function defaultWsUrl(): string {
  if (typeof window === "undefined") return "ws://localhost:3000/collab";
  const proto = window.location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${window.location.host}/collab`;
}

