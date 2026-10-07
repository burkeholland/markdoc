"use client";

import * as Y from "yjs";
import type { CompleteHocuspocusProviderWebsocketConfiguration, WebSocketStatus } from "@hocuspocus/provider";
import type { Awareness } from "y-protocols/awareness";
import { MarkdocProvider } from "./provider";
import { ClientDocumentPersistence, type SavedDocumentVersion } from "./persistence";
import type { PersistenceMessage } from "@/lib/document-persistence";
import { CommentsModel, COMMENTS_ORIGIN, isDocumentRange, type CommentSuggestionSnapshot, type CommentSuggestionTarget } from "./comments";
import { SuggestionsModel, SUGGESTIONS_ORIGIN } from "./suggestions";
import { MarkdownBinding } from "../sync/markdown-binding";
import {
  clearLocalDocument,
  ensureLocalEpoch,
  hasIndexedDB,
  LOCAL_LOAD_TIMEOUT_MS,
  openLocalPersistence,
  type ConnectionPhase,
  type LocalPersistence,
} from "./offline";
import { createAnchor, newId, perfMark, resolveAnchor, type CollabUser, type TextAnchor } from "./shared";
import type { Role } from "@/server/db/schema";
import { applyOps, diffOps } from "../sync/text-diff";
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
import { restoreReplacementComments, SUGGESTION_ANCHORS_META, type CommentAnchorChange } from "./replacement-anchors";

export type EditMode = "editing" | "suggesting" | "viewing";
export type Surface = "code" | "rich";
export type SaveState = ConnectionPhase;

const COMMENT_SUGGESTION_META = Symbol("commentSuggestion");
const COMMENT_SUGGESTION_TRANSITIONS = "commentSuggestionTransitions";
const COMMENT_SUGGESTION_TRANSITION_VERSION = 1;
const MAX_COMMENT_SUGGESTION_TRANSITIONS = 20;
const COMMENT_SUGGESTION_HISTORY_ORIGIN = { name: "comment-suggestion-history" };
const COMMENT_SUGGESTION_REPLAY_ORIGIN = { name: "comment-suggestion-replay" };

interface CommentSuggestionTransitionSnapshot {
  text: string;
  range: TextAnchor;
  comment: CommentSuggestionSnapshot;
}

interface CommentSuggestionTransition {
  version: typeof COMMENT_SUGGESTION_TRANSITION_VERSION;
  id: string;
  actorId: string;
  threadId: string;
  target: CommentSuggestionTarget;
  proposal: string;
  createdAt: number;
  phase: "applied" | "undone";
  currentRange: TextAnchor;
  currentComment: CommentSuggestionSnapshot;
  before: CommentSuggestionTransitionSnapshot;
  after: CommentSuggestionTransitionSnapshot;
}

interface CommentSuggestionMeta {
  transition: CommentSuggestionTransition;
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isYjsId(value: unknown): boolean {
  return isRecord(value) && Number.isInteger(value.client) && Number.isInteger(value.clock);
}

function readTextAnchor(value: unknown): TextAnchor | null {
  if (!isRecord(value)) return null;
  const readRelativePosition = (position: unknown) => {
    if (!isRecord(position)) return false;
    const hasType = typeof position.tname === "string" || isYjsId(position.type);
    return (
      hasType &&
      (position.item === undefined || isYjsId(position.item)) &&
      (position.assoc === undefined || (typeof position.assoc === "number" && Number.isInteger(position.assoc)))
    );
  };
  if (!readRelativePosition(value.start) || !readRelativePosition(value.end)) return null;
  return { start: value.start as TextAnchor["start"], end: value.end as TextAnchor["end"] };
}

function readSuggestionDecision(
  value: unknown,
): { suggestionState: "accepted" | "rejected"; suggestionBy: string; suggestionAt: number; quote: string } | null | undefined {
  if (value === null) return null;
  if (
    !isRecord(value) ||
    (value.suggestionState !== "accepted" && value.suggestionState !== "rejected") ||
    typeof value.suggestionBy !== "string" ||
    typeof value.suggestionAt !== "number" ||
    !Number.isFinite(value.suggestionAt) ||
    typeof value.quote !== "string"
  ) {
    return undefined;
  }
  const suggestionState = value.suggestionState;
  return {
    suggestionState,
    suggestionBy: value.suggestionBy,
    suggestionAt: value.suggestionAt,
    quote: value.quote,
  };
}

function readCommentSuggestionSnapshot(value: unknown): CommentSuggestionSnapshot | null {
  if (!isRecord(value) || (value.kind !== "root" && value.kind !== "reply")) return null;
  const anchor = readTextAnchor(value.anchor);
  const decision = readSuggestionDecision(value.decision);
  if (!anchor || typeof value.quote !== "string" || decision === undefined) return null;

  if (value.kind === "reply") {
    if (typeof value.replyId !== "string" || !value.replyId) return null;
    return { kind: "reply", replyId: value.replyId, anchor, quote: value.quote, decision };
  }

  const resolution = value.resolution;
  if (
    !isRecord(resolution) ||
    typeof resolution.resolved !== "boolean" ||
    (resolution.resolvedBy !== null && typeof resolution.resolvedBy !== "string") ||
    (resolution.resolvedAt !== null && (typeof resolution.resolvedAt !== "number" || !Number.isFinite(resolution.resolvedAt)))
  ) {
    return null;
  }
  return {
    kind: "root",
    anchor,
    quote: value.quote,
    decision,
    resolution: {
      resolved: resolution.resolved,
      resolvedBy: resolution.resolvedBy,
      resolvedAt: resolution.resolvedAt,
    },
  };
}

function readTransitionSnapshot(value: unknown): CommentSuggestionTransitionSnapshot | null {
  if (!isRecord(value) || typeof value.text !== "string") return null;
  const range = readTextAnchor(value.range);
  const comment = readCommentSuggestionSnapshot(value.comment);
  return range && comment ? { text: value.text, range, comment } : null;
}

function readCommentSuggestionTransition(value: unknown): CommentSuggestionTransition | null {
  if (!isRecord(value) || value.version !== COMMENT_SUGGESTION_TRANSITION_VERSION) return null;
  const targetValue = value.target;
  const target: CommentSuggestionTarget | null =
    isRecord(targetValue) && targetValue.kind === "root"
      ? { kind: "root" }
      : isRecord(targetValue) && targetValue.kind === "reply" && typeof targetValue.replyId === "string" && targetValue.replyId
        ? { kind: "reply", replyId: targetValue.replyId }
        : null;
  const before = readTransitionSnapshot(value.before);
  const after = readTransitionSnapshot(value.after);
  const currentRange = readTextAnchor(value.currentRange);
  const currentComment = readCommentSuggestionSnapshot(value.currentComment);
  if (
    !target ||
    !before ||
    !after ||
    !currentRange ||
    !currentComment ||
    typeof value.id !== "string" ||
    !value.id ||
    typeof value.actorId !== "string" ||
    !value.actorId ||
    typeof value.threadId !== "string" ||
    !value.threadId ||
    typeof value.proposal !== "string" ||
    typeof value.createdAt !== "number" ||
    !Number.isFinite(value.createdAt) ||
    (value.phase !== "applied" && value.phase !== "undone") ||
    before.text === after.text ||
    before.comment.kind !== target.kind ||
    after.comment.kind !== target.kind ||
    currentComment.kind !== target.kind ||
    before.comment.decision !== null ||
    after.comment.decision?.suggestionState !== "accepted" ||
    after.comment.decision.suggestionBy !== value.actorId ||
    after.comment.decision.quote !== before.text ||
    value.proposal !== after.text ||
    before.comment.quote !== before.text
  ) {
    return null;
  }
  if (
    target.kind === "reply" &&
    (before.comment.kind !== "reply" ||
      after.comment.kind !== "reply" ||
      currentComment.kind !== "reply" ||
      before.comment.replyId !== target.replyId ||
      after.comment.replyId !== target.replyId ||
      currentComment.replyId !== target.replyId)
  ) {
    return null;
  }
  if (
    target.kind === "root" &&
    (after.comment.kind !== "root" ||
      !after.comment.resolution.resolved ||
      after.comment.resolution.resolvedBy !== value.actorId ||
      typeof after.comment.resolution.resolvedAt !== "number")
  ) {
    return null;
  }
  return {
    version: COMMENT_SUGGESTION_TRANSITION_VERSION,
    id: value.id,
    actorId: value.actorId,
    threadId: value.threadId,
    target,
    proposal: value.proposal,
    createdAt: value.createdAt,
    phase: value.phase,
    currentRange,
    currentComment,
    before,
    after,
  };
}

function sameAnchor(a: TextAnchor, b: TextAnchor): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function sameDecision(
  a: CommentSuggestionSnapshot["decision"],
  b: CommentSuggestionSnapshot["decision"],
): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.suggestionState === b.suggestionState &&
    a.suggestionBy === b.suggestionBy &&
    a.suggestionAt === b.suggestionAt &&
    a.quote === b.quote
  );
}

function sameCommentSuggestionSnapshot(a: CommentSuggestionSnapshot, b: CommentSuggestionSnapshot): boolean {
  if (a.kind !== b.kind || !sameAnchor(a.anchor, b.anchor) || a.quote !== b.quote || !sameDecision(a.decision, b.decision)) return false;
  if (a.kind === "reply" && b.kind === "reply") return a.replyId === b.replyId;
  if (a.kind !== "root" || b.kind !== "root") return false;
  return (
    a.resolution.resolved === b.resolution.resolved &&
    a.resolution.resolvedBy === b.resolution.resolvedBy &&
    a.resolution.resolvedAt === b.resolution.resolvedAt
  );
}

/** How long the "All changes saved" highlight stays after a reconnect. */
export const RECOVERED_FLASH_MS = 2000;

/**
 * How long one connection attempt may sit in "connecting" before it is abandoned and a fresh one
 * started. Across a server restart the browser's socket can hang in CONNECTING with no error or
 * close event at all (#190: the pill said "Reconnecting…" for minutes after the server was back);
 * the provider has no handshake timeout of its own, so without this the retry loop stops for good.
 */
export const CONNECT_ATTEMPT_TIMEOUT_MS = 5_000;

/** Longest pause between reconnect attempts (the provider's default backs off to 30 s). */
export const RECONNECT_MAX_DELAY_MS = 3_000;

/** Shortest pause between reconnect attempts; also the provider's delay before the first retry. */
export const RECONNECT_MIN_DELAY_MS = 1_000;

/** Pause before retrying after the collaboration token could not be fetched (server restarting). */
export const TOKEN_RETRY_DELAY_MS = 2_000;

/** Cut off for this long with unsaved edits: the pill says the edits are kept on this device. */
export const OFFLINE_PROLONGED_MS = 30_000;
/** Quiet period used to collapse per-keystroke shell updates into one update after a typing burst. */
export const TYPING_NOTIFY_IDLE_MS = 500;

/** Whether a failed collaboration-token fetch was a refusal (no access) rather than a server that did not answer. */
export function isAccessRefusal(err: unknown): boolean {
  const status = (err as { status?: unknown } | null)?.status;
  return status === 401 || status === 403 || status === 404;
}

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
  /** An agent (API token) announced by the server, not a person in a browser. */
  isAgent: boolean;
  /** Agent status text ("reading", "drafting the summary"); null for people. */
  status: string | null;
  /** For agents: login of the user the token acts for (what `@login/<agent>` mentions resolve to). */
  ownerLogin: string | null;
  /** For agents: display name of that user, when the server announced it (`Burke's Copilot CLI` labels). */
  ownerName: string | null;
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
  /**
   * Do not open the WebSocket in the constructor; the owner calls {@link CollabSession.connect} once it
   * is sure this instance is the one it keeps. React StrictMode (development) invokes state initializers
   * twice, and a session that connected on construction made every tab run two connections — the full
   * state arrived twice on open and every update twice afterwards. A session created this way destroys
   * itself after {@link ORPHAN_GRACE_MS} unless {@link CollabSession.keepAlive} (or `connect`) is called.
   */
  autoConnect?: boolean;
   /** Canvas sessions retry authorization failures without deleting their IndexedDB recovery copy. */
   preserveLocalOnAuthFailure?: boolean;
}

/** How long a deferred-connect session waits to be adopted before it frees its Y.Doc and provider. */
export const ORPHAN_GRACE_MS = 10_000;

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
  private readonly commentSuggestionTransitions: Y.Map<unknown>;
  readonly provider: MarkdocProvider;
  readonly awareness: Awareness;
  readonly undoManager: Y.UndoManager;
  readonly comments: CommentsModel;
  readonly suggestions: SuggestionsModel;
  readonly binding: MarkdownBinding;
  readonly user: CollabUser;
  readonly role: Role;
  readonly docId: string;
  readonly persistence: ClientDocumentPersistence;

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
  /** True once the connection has been down for {@link OFFLINE_PROLONGED_MS}; the pill then says edits are kept locally. */
  prolongedOffline = false;
  private everConnected = false;
  private wasOffline = false;
  private recoveredTimer: ReturnType<typeof setTimeout> | null = null;
  private connectingTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private prolongedTimer: ReturnType<typeof setTimeout> | null = null;
  /** Why the last collaboration-token fetch failed, read by `onAuthenticationFailed`. */
  private tokenFailure: unknown = null;
  private local: LocalPersistence | null = null;
  private localStarted = false;
  mode: EditMode;
  activeSurface: Surface = "rich";
  /**
   * Source offset of the local caret in each pane, as the panes report it. Kept here (not in
   * React state of the shell) so only the outline and the opposite pane's focus line re-render
   * when it moves, not the whole editor.
   */
  localCursor: { code: number | null; rich: number | null } = { code: null, rich: null };
  /** Currently highlighted comment thread (shared by both panes and the sidebar). */
  activeCommentId: string | null = null;
  activeSuggestionId: string | null = null;
  /** Bumped by `revealComment` so the comments panel re-picks its tab even when the thread was already active. */
  revealSeq = 0;
  /**
   * The comment being composed on a selection, if any. Its range is held the way a posted comment's
   * is, as Yjs relative positions taken when the comment was started, and turned back into offsets only
   * after the text has changed: plain offsets went stale with the first key a collaborator typed before
   * the selection, and the comment was posted on text nobody had selected (#2258).
   */
  private pending: { id: number; anchor: TextAnchor | null; range: { from: number; to: number }; stale: boolean } | null = null;
  private pendingSeq = 0;
  /** Find & replace state while the find bar is open (matches are in source offsets). */
  find: FindState | null = null;
  /** Collaborator whose cursor the viewport is glued to, if any. */
  followUserId: string | null = null;
  /** Set (with a fresh `seq`) when following ended because that user left, so the shell can toast. */
  followEnded: { name: string; seq: number } | null = null;
  /** Collaborator whose remote caret is flashing (after "Jump"), if any. */
  flashUserId: string | null = null;
  /** Y.Text identity changes not produced by the matching rich transaction. */
  relativePositionVersion = 0;
  /** Comment-anchor identity changes independent of document text. */
  commentRangeVersion = 0;
  private flashTimer: ReturnType<typeof setTimeout> | null = null;
  private lastActivityPublish = 0;
  private sectionCache: { headings: HeadingInfo[]; byOffset: Map<number, string | null> } | null = null;
  private listeners = new Set<Listener>();
  private notifyScheduled = false;
  private afterPaintNotify: {
    frame: number | null;
    timer: ReturnType<typeof setTimeout> | null;
    cooling: boolean;
    dirty: boolean;
    typing: boolean;
  } | null = null;
  private destroyed = false;

  constructor(readonly options: CollabSessionOptions) {
    this.docId = options.docId;
    this.user = options.user;
    this.role = options.role;
    this.mode = options.role === "viewer" || options.role === "commenter" ? "viewing" : "editing";
    this.ytext = this.ydoc.getText("content");
    this.meta = this.ydoc.getMap("meta");
    this.commentSuggestionTransitions = this.ydoc.getMap(COMMENT_SUGGESTION_TRANSITIONS);
    let persistenceState: ClientDocumentPersistence["state"] = "pending";
    let persistenceError: string | null = null;
    this.persistence = new ClientDocumentPersistence(
      this.docId,
      this.ydoc,
      (request) => this.provider.sendStateless(JSON.stringify(request)),
      () => {
        this.updateRecovery();
        const nextState = this.persistence.state;
        const nextError = this.persistence.error;
        if (nextState !== persistenceState || nextError !== persistenceError) {
          persistenceState = nextState;
          persistenceError = nextError;
          // A durability edge must not wait for an already-active typing cooldown.
          this.notify();
        } else {
          this.notifyAfterPaint();
        }
      },
    );

    // Mirror the document into IndexedDB so offline edits survive a refresh. `connect` waits for the
    // mirror (bounded) before opening the socket, so the sync handshake starts from what this device
    // already has and only the difference travels (issue #189).
    this.whenLocalLoaded = new Promise<void>((resolve) => {
      this.resolveLocalLoaded = resolve;
    });
    if (!options.deferLocal) this.startLocalPersistence();

    const url = options.wsUrl ?? defaultWsUrl();
    // The websocket provider reads `autoConnect` and the retry settings from the same configuration
    // object at runtime; the public provider type only names `url`, so the socket options come in from
    // a socket-typed fragment. The retry backoff is capped so a server that comes back after a restart
    // is found within seconds, not after the default 30 s pause.
    const socketOptions: Partial<CompleteHocuspocusProviderWebsocketConfiguration> = {
      ...(options.autoConnect === false ? { autoConnect: false } : {}),
      delay: RECONNECT_MIN_DELAY_MS,
      minDelay: RECONNECT_MIN_DELAY_MS,
      maxDelay: RECONNECT_MAX_DELAY_MS,
      factor: 2,
    };
    this.provider = new MarkdocProvider({
      url,
      ...socketOptions,
      name: options.docId,
      document: this.ydoc,
      token: async () => {
        perfMark("markdoc:token-start");
        // The provider asks for the token only once the socket is open; `connect()` fetched it meanwhile.
        const prefetched = this.tokenPrefetch;
        this.tokenPrefetch = null;
        try {
          const token = prefetched ? await prefetched : await options.getToken();
          perfMark("markdoc:token");
          this.tokenFailure = null;
          return token;
        } catch (err) {
          // The provider reports a failed fetch as an authentication failure; remember why so
          // `onAuthenticationFailed` can tell a refusal from a server that is not answering yet.
          this.tokenFailure = err;
          throw err;
        }
      },
      onStatus: ({ status }) => {
        this.status = status;
        if (status === "connected") {
          perfMark("markdoc:ws-connected");
          this.everConnected = true;
          this.clearProlongedOffline();
        } else {
          // The provider resets its own synced flag on close without emitting; mirror it.
          this.synced = false;
          this.persistence.disconnected();
          // A drop after being connected, or a first connection that fails while the local copy
          // holds changes (a reload while offline): the next "saved" gets the confirmation flash,
          // and if the outage lasts the pill says the edits are kept on this device.
          if (this.everConnected || this.unsyncedChanges > 0) {
            this.wasOffline = true;
            this.armProlongedOffline();
          }
        }
        if (status === "connecting") this.armConnectWatchdog();
        else this.disarmConnectWatchdog();
        this.updateRecovery();
        this.notify();
      },
      onSynced: ({ state }) => {
        this.synced = state;
        if (state) {
          perfMark("markdoc:synced");
          // The first sync ends the coalesced initial load: one rebuild of the rich pane, before
          // the UI learns it is synced (so the stand-in is never swapped for an empty editor).
          this.binding.releaseRemoteSync();
          this.persistence.synced();
        }
        this.updateRecovery();
        this.notify();
      },
      onAuthenticationFailed: ({ reason }) => {
        const failure = this.tokenFailure;
        this.tokenFailure = null;
        if (failure !== null && !isAccessRefusal(failure)) {
          // The token could not be fetched (server restarting, network blip): nobody refused access, so
          // the local copy stays and the connection is retried shortly. Wiping here lost every offline
          // edit on the first reload after a restart (#190).
          console.warn("[markdoc] collaboration token fetch failed; retrying", failure);
          this.scheduleReconnect(TOKEN_RETRY_DELAY_MS);
          this.notify();
          return;
        }
        if (options.preserveLocalOnAuthFailure) {
          // The canvas shell renews a short-lived browser session out of band. A 401 during that
          // handoff is not proof that document access was revoked, so retain the recovery copy.
          console.warn("[markdoc] embedded collaboration authorization failed; retaining local changes");
          this.scheduleReconnect(TOKEN_RETRY_DELAY_MS);
          this.notify();
          return;
        }
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
        // Changes made while the connection is down should also get the "All changes saved"
        // confirmation. Only a failed connection counts: the local copy loading while the very
        // first socket is still opening (every warm open) is not an outage.
        if (number > 0 && this.status === "disconnected") {
          this.wasOffline = true;
          this.armProlongedOffline();
        }
        if (number === 0 && this.synced) perfMark("markdoc:sync-acked");
        this.updateRecovery();
        this.notifyAfterPaint(number > 0);
      },
      onAwarenessChange: () => {
        this.checkFollowedPresence();
        this.notifyAfterPaint();
      },
      onStateless: ({ payload }) => {
        let message: { type?: string } | null = null;
        try {
          message = JSON.parse(payload) as { type?: string };
        } catch {
          return;
        }
        if (message?.type === "document-persistence") {
          this.persistence.receive(message as PersistenceMessage);
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
    this.undoManager.addToScope(this.suggestions.ymap);
    this.binding = new MarkdownBinding(this.ytext, {
      onSync: (direction) => (direction === "local" ? this.notifyAfterPaint(true) : this.notify()),
    });
    // Coalesce the text the local copy and the server deliver into one rich-pane rebuild (released on the first sync).
    this.binding.holdRemoteSync();
    this.undoManager.addTrackedOrigin(this.binding);
    this.undoManager.on("stack-item-added", () => this.notifyAfterPaint(true));
    this.undoManager.on("stack-item-popped", this.onUndoStackItemPopped);
    this.undoManager.on("stack-cleared", this.notify);
    this.ydoc.on("afterTransaction", this.captureSuggestionAnchors);
    this.comments.ymap.observeDeep(this.onCommentsChanged);
    this.suggestions.ymap.observe(this.notify);
    this.meta.observe(this.notify);
    this.commentSuggestionTransitions.observe(this.notify);
    this.ytext.observe(this.onTextChanged);
    this.ytext.observe(this.refreshFind);
    this.undoManager.addTrackedOrigin(LOCAL_EDIT_ORIGIN);
    if (options.autoConnect === false) this.scheduleDestroy(ORPHAN_GRACE_MS);
    else this.connectRequested = true;
    this.registerWindowListeners();
  }

  private connectRequested = false;

  private static readonly WAKE_EVENTS = ["online", "focus", "visibilitychange", "pageshow"] as const;

  /** Coming back online, to the tab or from sleep: retry at once instead of waiting out the backoff. */
  private onWindowWake = () => {
    if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
    if (this.status === "connected" || !this.connectRequested) return;
    this.restartConnection("window event");
  };

  private registerWindowListeners() {
    if (typeof window === "undefined" || typeof window.addEventListener !== "function") return;
    for (const event of CollabSession.WAKE_EVENTS) window.addEventListener(event, this.onWindowWake);
  }

  private unregisterWindowListeners() {
    if (typeof window === "undefined" || typeof window.removeEventListener !== "function") return;
    for (const event of CollabSession.WAKE_EVENTS) window.removeEventListener(event, this.onWindowWake);
  }

  /** Abandon a connection attempt that is still "connecting" after {@link CONNECT_ATTEMPT_TIMEOUT_MS}. */
  private armConnectWatchdog() {
    this.disarmConnectWatchdog();
    this.connectingTimer = setTimeout(() => {
      this.connectingTimer = null;
      if (this.status !== "connecting") return;
      this.restartConnection("attempt stalled");
    }, CONNECT_ATTEMPT_TIMEOUT_MS);
  }

  private disarmConnectWatchdog() {
    if (this.connectingTimer) clearTimeout(this.connectingTimer);
    this.connectingTimer = null;
  }

  /** Retry the connection after `delayMs` unless it is up and authenticated by then. */
  private scheduleReconnect(delayMs: number) {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.status === "connected" && this.provider.isAuthenticated) return;
      this.restartConnection("token retry");
    }, delayMs);
  }

  /**
   * Drop whatever socket the provider holds (open, pending or none) and start a fresh connection
   * attempt. A socket stuck in CONNECTING is closed so the provider's retry moves on; `connect()`
   * restarts its backoff from the shortest delay.
   *
   * Never runs before the local copy has been applied: the first socket is opened by {@link connect}
   * once the mirror loaded, so that sync step 1 carries this device's real state vector (issue #189),
   * and a wake event or watchdog must not open one earlier. The restarted socket goes through the
   * provider's normal open → token → `startSync` handshake, so a mirror that loads late still reaches
   * the server through `forceSync` (see collab/provider.ts).
   */
  private restartConnection(why: string) {
    if (this.destroyed || this.trashed || this.authError || !this.connectRequested || !this.localLoaded) return;
    const socket = this.provider.configuration?.websocketProvider;
    if (!socket || typeof socket.connect !== "function") return;
    if (process.env.NODE_ENV !== "production") console.info(`[markdoc] reconnecting collaboration socket (${why})`);
    this.restarts++;
    socket.disconnect();
    void socket.connect();
  }

  /** How many times a stalled or failed attempt was replaced by a fresh one (diagnostics). */
  restarts = 0;

  private armProlongedOffline() {
    if (this.prolongedTimer || this.prolongedOffline) return;
    this.prolongedTimer = setTimeout(() => {
      this.prolongedTimer = null;
      if (this.status === "connected") return;
      this.prolongedOffline = true;
      this.notify();
    }, OFFLINE_PROLONGED_MS);
  }

  private clearProlongedOffline() {
    if (this.prolongedTimer) clearTimeout(this.prolongedTimer);
    this.prolongedTimer = null;
    this.prolongedOffline = false;
  }

  /**
   * Open the connection of a session created with `autoConnect: false` (once) and keep the session alive.
   *
   * The socket opens only once the local copy has been applied (bounded by the local-load timeout):
   * sync step 1 then carries the state vector of what this device already has and the server answers
   * with the difference — a few hundred bytes on a warm open instead of the whole document (issue #189).
   * The collaboration token is fetched meanwhile, so nothing is serialised behind the IndexedDB read.
   */
  connect() {
    this.keepAlive();
    if (this.connectRequested || this.destroyed || this.trashed) return;
    this.connectRequested = true;
    perfMark("markdoc:connect");
    // Fetch the collaboration token while the socket opens instead of after: the REST round trip
    // used to sit between the socket opening and the first sync on every open (#118).
    const prefetch = this.options.getToken();
    prefetch.catch(() => undefined);
    this.tokenPrefetch = prefetch;
    // A deferred mirror nobody started yet would keep the socket waiting; connect runs after hydration too.
    this.startLocalPersistence();
    if (this.localLoaded) {
      void this.provider.connect();
      return;
    }
    void this.whenLocalLoaded.then(() => {
      if (this.destroyed || this.trashed) return;
      perfMark("markdoc:ws-open");
      void this.provider.connect();
    });
  }

  /** Token fetched by {@link connect}, consumed by the provider on the first socket open. */
  private tokenPrefetch: Promise<string> | null = null;

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
    if (!this.synced) return "saving";
    if (this.persistence.state !== "saved") return this.persistence.state;
    if (this.unsyncedChanges > 0) return "pending";
    if (!this.savedMarked) {
      // First persistence acknowledgement of this open, not merely sync step 2.
      this.savedMarked = true;
      perfMark("markdoc:saved");
    }
    return "saved";
  }

  get dirty(): boolean {
    return this.persistence.dirty;
  }

  get saveError(): string | null {
    return this.persistence.error;
  }

  get savedVersion(): SavedDocumentVersion | null {
    return this.persistence.savedVersion;
  }

  subscribeSaved = (listener: (saved: SavedDocumentVersion) => void): (() => void) => this.persistence.subscribeSaved(listener);

  flushSave(): Promise<SavedDocumentVersion | null> {
    if (!this.canEdit) return Promise.reject(new Error("You do not have permission to save this document."));
    return this.persistence.flush();
  }

  private contentCompositionOwners = new Set<HTMLElement>();

  /** Composition completion may not create another Yjs update; it still restarts the idle deadline. */
  bindContentComposition(element: HTMLElement): () => void {
    const start = () => {
      this.contentCompositionOwners.add(element);
      this.persistence.setComposing(true);
    };
    const end = () => {
      this.contentCompositionOwners.delete(element);
      this.persistence.setComposing(this.contentCompositionOwners.size > 0);
    };
    element.addEventListener("compositionstart", start);
    element.addEventListener("compositionend", end);
    return () => {
      element.removeEventListener("compositionstart", start);
      element.removeEventListener("compositionend", end);
      end();
    };
  }

  private savedMarked = false;

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
   *
   * The UI waits on the wipe for at most {@link LOCAL_LOAD_TIMEOUT_MS}: past that
   * {@link localLoaded} is set anyway (a wipe never leaves local state to apply) while the
   * wipe runs on to its own cap, and the mirror still opens once it has succeeded.
   */
  startLocalPersistence() {
    if (this.localStarted) return;
    this.localStarted = true;
    if (this.destroyed) return;
    const markLoaded = () => {
      if (this.localLoaded) return;
      this.localLoaded = true;
      perfMark("markdoc:local-loaded");
      this.resolveLocalLoaded();
      this.notify();
    };
    if (!hasIndexedDB()) {
      markLoaded();
      return;
    }
    const stopWaiting = setTimeout(markLoaded, LOCAL_LOAD_TIMEOUT_MS);
    void ensureLocalEpoch().then((usable) => {
      clearTimeout(stopWaiting);
      if (!this.destroyed && usable) this.local = openLocalPersistence(this.docId, this.ydoc);
      if (!this.local) {
        markLoaded();
        return;
      }
      // The mirror's restore must not be pushed to the server as an update; the handshake carries the difference.
      this.provider.setLocalOrigin(this.local.origin);
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

  setLocalCursor(surface: Surface, source: number | null) {
    if (this.localCursor[surface] === source) return;
    this.localCursor = { ...this.localCursor, [surface]: source };
    this.notifyAfterPaint();
  }

  /** Source offset of the caret in the active pane (the outline highlights the section it is in). */
  get cursorSource(): number | null {
    return this.activeSurface === "code" ? this.localCursor.code : this.localCursor.rich;
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
    if (id) id = this.suggestions.ymap.get(id)?.groupId ?? id;
    if (this.activeSuggestionId === id) return;
    this.activeSuggestionId = id;
    if (id) this.activeCommentId = null;
    this.notify();
  }

  /** Text and annotation decisions share one history step, isolated from nearby typing. */
  reviewSuggestion(action: "accept" | "reject" | "acceptAll" | "rejectAll", id?: string): number {
    this.undoManager.stopCapturing();
    try {
      if (action === "acceptAll" || action === "rejectAll") return this.suggestions[action]();
      if (!id) throw new Error("A suggestion id is required");
      return this.suggestions[action](id);
    } finally {
      this.undoManager.stopCapturing();
    }
  }

  /**
   * Source range of the pending comment as the text is now, or null when none is pending. A comment on
   * the whole document is `{ from: 0, to: 0 }` and stays there. Each value is a snapshot: the same
   * object while the range has not moved, a new one when an edit (anyone's) has moved it.
   */
  get pendingComment(): { from: number; to: number } | null {
    const pending = this.pending;
    if (!pending) return null;
    if (pending.stale) {
      pending.stale = false;
      const range = pending.anchor && resolveAnchor(this.ytext, pending.anchor);
      if (range && (range.from !== pending.range.from || range.to !== pending.range.to)) pending.range = range;
    }
    return pending.range;
  }

  /** Which pending comment this is: a new number for each comment that is started, null when none is. Edits that move the range do not change it. */
  get pendingCommentId(): number | null {
    return this.pending?.id ?? null;
  }

  setPendingComment(range: { from: number; to: number } | null) {
    const current = this.pendingComment;
    if (!range) this.pending = null;
    // Comment pressed again on the range that is already pending is still the same comment.
    else if (!current || current.from !== range.from || current.to !== range.to) {
      this.pending = {
        id: ++this.pendingSeq,
        anchor: isDocumentRange(range) ? null : createAnchor(this.ytext, range.from, range.to),
        range: { from: range.from, to: range.to },
        stale: false,
      };
    }
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
      const u = state.user as (Partial<CollabUser> & { role?: Role; isAgent?: boolean; status?: string | null; userLogin?: string | null; userName?: string | null }) | undefined;
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
        isAgent: u.isAgent === true,
        status: typeof u.status === "string" && u.status ? u.status : null,
        ownerLogin: u.isAgent === true && typeof u.userLogin === "string" && u.userLogin ? u.userLogin : null,
        ownerName: u.isAgent === true && typeof u.userName === "string" && u.userName ? u.userName : null,
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

  /** Accept a root or reply suggestion as one text-and-comment undo step. */
  acceptCommentSuggestion(threadId: string, proposed: string, replyId?: string): boolean {
    const target: CommentSuggestionTarget = replyId ? { kind: "reply", replyId } : { kind: "root" };
    const before = this.comments.snapshotSuggestion(threadId, target);
    if (!before) return false;
    const proposal = this.comments.suggestionText(threadId, target);
    if (proposal === null || proposal !== proposed) return false;
    const beforeRange = resolveAnchor(this.ytext, before.anchor);
    const sourceBefore = this.ytext.toString();
    if (!beforeRange || sourceBefore.slice(beforeRange.from, beforeRange.to) !== before.quote) return false;
    const beforeTransition: CommentSuggestionTransitionSnapshot = {
      text: before.quote,
      range: createAnchor(this.ytext, beforeRange.from, beforeRange.to),
      comment: before,
    };

    this.undoManager.stopCapturing();
    const previousUndoStackLength = this.undoManager.undoStack.length;
    const previousUndoStackItem = this.undoManager.undoStack.at(-1);
    try {
      const accepted = replyId
        ? this.comments.acceptReplySuggestion(threadId, replyId, this.user)
        : this.comments.acceptSuggestion(threadId, proposed, this.user);
      if (!accepted) return false;

      const after = this.comments.snapshotSuggestion(threadId, target);
      if (!after) throw new Error("Accepted comment suggestion target disappeared");
      const sourceAfter = this.ytext.toString();
      const afterLength = beforeRange.to - beforeRange.from + sourceAfter.length - sourceBefore.length;
      const afterEnd = beforeRange.from + afterLength;
      if (
        afterLength < 0 ||
        afterEnd > sourceAfter.length ||
        sourceBefore.slice(0, beforeRange.from) !== sourceAfter.slice(0, beforeRange.from) ||
        sourceBefore.slice(beforeRange.to) !== sourceAfter.slice(afterEnd)
      ) {
        throw new Error("Accepted comment suggestion changed text outside its anchor");
      }
      const afterTransition: CommentSuggestionTransitionSnapshot = {
        text: sourceAfter.slice(beforeRange.from, afterEnd),
        range: createAnchor(this.ytext, beforeRange.from, afterEnd),
        comment: after,
      };
      const undoStackItem = this.undoManager.undoStack.at(-1);
      if (
        !undoStackItem ||
        undoStackItem === previousUndoStackItem ||
        this.undoManager.undoStack.length !== previousUndoStackLength + 1
      ) {
        if (!this.comments.restoreSuggestion(threadId, before)) {
          throw new Error("Could not restore comment suggestion after undo capture failed");
        }
        return false;
      }
      const transition: CommentSuggestionTransition = {
        version: COMMENT_SUGGESTION_TRANSITION_VERSION,
        id: newId(),
        actorId: this.user.id,
        threadId,
        target,
        proposal,
        createdAt: Date.now(),
        phase: "applied",
        currentRange: afterTransition.range,
        currentComment: after,
        before: beforeTransition,
        after: afterTransition,
      };
      undoStackItem.meta.set(COMMENT_SUGGESTION_META, { transition } satisfies CommentSuggestionMeta);
      this.writeCommentSuggestionTransition(transition);
      return true;
    } finally {
      this.undoManager.stopCapturing();
    }
  }

  // Y.UndoManager keeps merging edits into the newest stack item for `captureTimeout` after the
  // last *edit*, and undo/redo do not reset that clock: an edit typed right after an undo would be
  // folded into the step below the one just undone, so the next undo removed both (task #437).
  // Closing the capture window makes whatever comes after an undo/redo its own step.
  undo() {
    this.discardInvalidCommentSuggestionStackItems(this.undoManager.undoStack, "applied");
    if (this.undoManager.canUndo()) this.undoManager.undo();
    else this.replayCommentSuggestionTransition("applied");
    this.undoManager.stopCapturing();
  }

  redo() {
    this.discardInvalidCommentSuggestionStackItems(this.undoManager.redoStack, "undone");
    const stored = this.readStoredCommentSuggestionTransition();
    const hasMatchingTransient =
      stored?.phase === "undone" &&
      this.undoManager.redoStack.some(
        (item) => (item.meta.get(COMMENT_SUGGESTION_META) as CommentSuggestionMeta | undefined)?.transition.id === stored.id,
      );
    const durable = hasMatchingTransient ? null : this.readCurrentCommentSuggestionTransition("undone");
    if (durable) this.replayCommentSuggestionTransition("undone");
    else if (this.undoManager.canRedo()) this.undoManager.redo();
    this.undoManager.stopCapturing();
  }

  get canUndo(): boolean {
    this.discardInvalidCommentSuggestionStackItems(this.undoManager.undoStack, "applied");
    return this.undoManager.canUndo() || !!this.readCurrentCommentSuggestionTransition("applied");
  }

  get canRedo(): boolean {
    this.discardInvalidCommentSuggestionStackItems(this.undoManager.redoStack, "undone");
    const stored = this.readStoredCommentSuggestionTransition();
    const hasMatchingTransient =
      stored?.phase === "undone" &&
      this.undoManager.redoStack.some(
        (item) => (item.meta.get(COMMENT_SUGGESTION_META) as CommentSuggestionMeta | undefined)?.transition.id === stored.id,
      );
    const durable = hasMatchingTransient ? stored : this.readCurrentCommentSuggestionTransition("undone");
    return this.undoManager.canRedo() || !!durable;
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

  /** Show the first typing update after paint, then coalesce shell churn until the user pauses. */
  private notifyAfterPaint = (typing = false) => {
    if (this.destroyed) return;
    const current = this.afterPaintNotify;
    if (current) {
      if (typing && !current.typing) {
        current.typing = true;
        if (current.cooling) {
          if (current.timer) clearTimeout(current.timer);
          this.afterPaintNotify = null;
          this.notifyAfterPaint(true);
          return;
        }
      }
      if (current.cooling) {
        current.dirty = true;
        if (current.timer) clearTimeout(current.timer);
        current.timer = setTimeout(() => {
          if (this.afterPaintNotify !== current) return;
          this.afterPaintNotify = null;
          if (current.dirty) this.notify();
        }, TYPING_NOTIFY_IDLE_MS);
      }
      return;
    }
    const pending = {
      frame: null as number | null,
      timer: null as ReturnType<typeof setTimeout> | null,
      cooling: false,
      dirty: false,
      typing,
    };
    this.afterPaintNotify = pending;
    const run = () => {
      pending.frame = null;
      pending.timer = setTimeout(() => {
        if (this.afterPaintNotify !== pending) return;
        pending.cooling = true;
        this.notify();
        pending.timer = setTimeout(() => {
          if (this.afterPaintNotify !== pending) return;
          this.afterPaintNotify = null;
          if (pending.dirty) this.notify();
        }, TYPING_NOTIFY_IDLE_MS);
      }, 0);
    };
    if (typeof requestAnimationFrame === "function") pending.frame = requestAnimationFrame(run);
    else run();
  };

  private onUndoStackItemPopped = (event: { stackItem: { meta: Map<unknown, unknown> }; type: "undo" | "redo" }) => {
    const anchors = event.stackItem.meta.get(SUGGESTION_ANCHORS_META) as CommentAnchorChange[] | undefined;
    if (anchors) {
      this.ydoc.transact(() => {
        const restored = restoreReplacementComments(this.ydoc, anchors, event.type === "undo");
        const destination = event.type === "undo" ? this.undoManager.redoStack : this.undoManager.undoStack;
        destination.at(-1)?.meta.set(SUGGESTION_ANCHORS_META, restored);
      }, COMMENT_SUGGESTION_REPLAY_ORIGIN);
    }
    const meta = event.stackItem.meta.get(COMMENT_SUGGESTION_META) as CommentSuggestionMeta | undefined;
    if (meta) {
      const snapshot = event.type === "undo" ? meta.transition.before : meta.transition.after;
      this.ydoc.transact(() => {
        if (!this.comments.restoreSuggestion(meta.transition.threadId, snapshot.comment)) {
          throw new Error("Comment suggestion target disappeared during transient replay");
        }
        const range = this.resolveTransitionRange(snapshot, meta.transition.currentRange);
        if (!range) {
          this.invalidateCommentSuggestionTransition(meta.transition.id);
          return;
        }
        const updatedTransition: CommentSuggestionTransition = {
          ...meta.transition,
          phase: event.type === "undo" ? "undone" : "applied",
          currentRange: createAnchor(this.ytext, range.from, range.to),
          currentComment: snapshot.comment,
        };

        const destination = event.type === "undo" ? this.undoManager.redoStack : this.undoManager.undoStack;
        destination.at(-1)?.meta.set(COMMENT_SUGGESTION_META, { transition: updatedTransition } satisfies CommentSuggestionMeta);
        this.writeCommentSuggestionTransition(updatedTransition);
      }, COMMENT_SUGGESTION_HISTORY_ORIGIN);
    }
    this.notify();
  };

  private captureSuggestionAnchors = (transaction: Y.Transaction) => {
    if (transaction.origin !== SUGGESTIONS_ORIGIN) return;
    const anchors = transaction.meta.get(SUGGESTION_ANCHORS_META) as CommentAnchorChange[] | undefined;
    if (anchors) this.undoManager.undoStack.at(-1)?.meta.set(SUGGESTION_ANCHORS_META, anchors);
  };

  private onTextChanged = (_event: Y.YTextEvent, transaction: Y.Transaction) => {
    // Only a mark: the pending comment's range is worked out when it is next read.
    if (this.pending) this.pending.stale = true;
    if (
      transaction.local &&
      transaction.origin !== this.undoManager &&
      transaction.origin !== COMMENT_SUGGESTION_REPLAY_ORIGIN &&
      this.readStoredCommentSuggestionTransition()?.phase === "undone"
    ) {
      const transition = this.readStoredCommentSuggestionTransition();
      if (transition) this.invalidateCommentSuggestionTransition(transition.id);
    }
    if (transaction.origin === this.binding) {
      if (transaction.deleteSet.clients.size > 0) this.relativePositionVersion++;
      this.notifyAfterPaint(true);
    } else {
      this.relativePositionVersion++;
      this.notify();
    }
  };

  private onCommentsChanged = (_events: Y.YEvent<Y.AbstractType<unknown>>[], transaction: Y.Transaction) => {
    this.commentRangeVersion++;
    if (transaction.local) {
      const transition = this.readStoredCommentSuggestionTransition();
      if (transition?.phase === "undone" && !this.isCommentSuggestionTransitionCurrent(transition, "undone")) {
        this.invalidateCommentSuggestionTransition(transition.id);
      }
    }
    this.notify();
  };

  private readStoredCommentSuggestionTransition(): CommentSuggestionTransition | null {
    const stored = this.commentSuggestionTransitions.get(this.user.id);
    if (stored === undefined) return null;
    const transition = readCommentSuggestionTransition(stored);
    if (!transition || transition.actorId !== this.user.id) {
      this.commentSuggestionTransitions.delete(this.user.id);
      return null;
    }
    return transition;
  }

  private readCurrentCommentSuggestionTransition(phase: CommentSuggestionTransition["phase"]): CommentSuggestionTransition | null {
    const transition = this.readStoredCommentSuggestionTransition();
    if (!transition || transition.phase !== phase) return null;
    if (!this.isCommentSuggestionTransitionCurrent(transition, phase)) {
      this.invalidateCommentSuggestionTransition(transition.id);
      return null;
    }
    return transition;
  }

  private isCommentSuggestionTransitionCurrent(
    transition: CommentSuggestionTransition,
    phase: CommentSuggestionTransition["phase"],
  ): boolean {
    if (transition.phase !== phase) return false;
    const expected = phase === "applied" ? transition.after : transition.before;
    const current = this.comments.snapshotSuggestion(transition.threadId, transition.target);
    const range = this.resolveTransitionRange(expected, transition.currentRange);
    return (
      !!current &&
      sameCommentSuggestionSnapshot(current, transition.currentComment) &&
      this.comments.suggestionText(transition.threadId, transition.target) === transition.proposal &&
      !!range
    );
  }

  private discardInvalidCommentSuggestionStackItems(
    stack: { meta: Map<unknown, unknown> }[],
    phase: CommentSuggestionTransition["phase"],
  ) {
    while (stack.length > 0) {
      const meta = stack.at(-1)!.meta.get(COMMENT_SUGGESTION_META) as CommentSuggestionMeta | undefined;
      if (!meta || this.isCommentSuggestionTransitionCurrent(meta.transition, phase)) return;
      this.invalidateCommentSuggestionTransition(meta.transition.id);
    }
  }

  private invalidateCommentSuggestionTransition(id: string) {
    const stored = this.readStoredCommentSuggestionTransition();
    if (stored?.id === id) this.commentSuggestionTransitions.delete(this.user.id);
    for (const stack of [this.undoManager.undoStack, this.undoManager.redoStack]) {
      for (let i = stack.length - 1; i >= 0; i--) {
        const meta = stack[i].meta.get(COMMENT_SUGGESTION_META) as CommentSuggestionMeta | undefined;
        if (meta?.transition.id === id) stack.splice(i, 1);
      }
    }
    this.notify();
  }

  private resolveTransitionRange(
    snapshot: CommentSuggestionTransitionSnapshot,
    currentRange: TextAnchor,
  ): { from: number; to: number } | null {
    for (const anchor of [currentRange, snapshot.range, snapshot.comment.anchor]) {
      let range: { from: number; to: number } | null;
      try {
        range = resolveAnchor(this.ytext, anchor);
      } catch {
        range = null;
      }
      if (range && this.ytext.toString().slice(range.from, range.to) === snapshot.text) return range;
    }
    return null;
  }

  private replayCommentSuggestionTransition(phase: CommentSuggestionTransition["phase"]): boolean {
    const transition = this.readCurrentCommentSuggestionTransition(phase);
    if (!transition) return false;
    const current = phase === "applied" ? transition.after : transition.before;
    const next = phase === "applied" ? transition.before : transition.after;
    const range = this.resolveTransitionRange(current, transition.currentRange);
    if (!range) {
      this.commentSuggestionTransitions.delete(this.user.id);
      return false;
    }

    this.ydoc.transact(() => {
      applyOps(this.ytext, diffOps(current.text, next.text, range.from));
      const replayAnchor = createAnchor(this.ytext, range.from, range.from + next.text.length);
      const nextComment = { ...next.comment, anchor: replayAnchor };
      if (!this.comments.restoreSuggestion(transition.threadId, nextComment)) {
        throw new Error("Comment suggestion target disappeared during durable replay");
      }
      this.writeCommentSuggestionTransition({
        ...transition,
        phase: phase === "applied" ? "undone" : "applied",
        currentRange: replayAnchor,
        currentComment: nextComment,
      });
    }, COMMENT_SUGGESTION_REPLAY_ORIGIN);
    this.notify();
    return true;
  }

  private writeCommentSuggestionTransition(transition: CommentSuggestionTransition) {
    this.ydoc.transact(() => {
      this.commentSuggestionTransitions.set(transition.actorId, transition);
      if (this.commentSuggestionTransitions.size <= MAX_COMMENT_SUGGESTION_TRANSITIONS) return;
      const oldest = Array.from(this.commentSuggestionTransitions.entries())
        .map(([actorId, value]) => ({ actorId, createdAt: readCommentSuggestionTransition(value)?.createdAt ?? Number.NEGATIVE_INFINITY }))
        .sort((a, b) => a.createdAt - b.createdAt || a.actorId.localeCompare(b.actorId))
        .slice(0, this.commentSuggestionTransitions.size - MAX_COMMENT_SUGGESTION_TRANSITIONS);
      for (const item of oldest) this.commentSuggestionTransitions.delete(item.actorId);
    }, COMMENT_SUGGESTION_HISTORY_ORIGIN);
  }

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
    this.persistence.destroy(this.canEdit && !this.authError);
    this.contentCompositionOwners.clear();
    this.destroyed = true;
    if (this.recoveredTimer) clearTimeout(this.recoveredTimer);
    if (this.flashTimer) clearTimeout(this.flashTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    const pendingNotify = this.afterPaintNotify;
    if (pendingNotify?.frame !== null && pendingNotify?.frame !== undefined && typeof cancelAnimationFrame === "function") {
      cancelAnimationFrame(pendingNotify.frame);
    }
    if (pendingNotify?.timer) clearTimeout(pendingNotify.timer);
    this.afterPaintNotify = null;
    this.disarmConnectWatchdog();
    this.clearProlongedOffline();
    this.unregisterWindowListeners();
    this.listeners.clear();
    this.commentSuggestionTransitions.unobserve(this.notify);
    this.ytext.unobserve(this.onTextChanged);
    this.comments.ymap.unobserveDeep(this.onCommentsChanged);
    this.suggestions.ymap.unobserve(this.notify);
    this.ydoc.off("afterTransaction", this.captureSuggestionAnchors);
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
