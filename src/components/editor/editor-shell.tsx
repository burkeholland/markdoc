"use client";
import { navigateTo } from "@/lib/nav";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import type { EditorView as CMView } from "@codemirror/view";
import type { EditorView as PMView } from "prosemirror-view";
import { Eye, PenLine, X } from "lucide-react";
import type { DocumentDto } from "@/server/dto";
import type { Role } from "@/server/db/schema";
import type { CodeApi } from "@/editor/codemirror/api";
import type { LintIssue } from "@/editor/markdown/lint";
import type { HeadingInfo } from "@/editor/markdown/parse";
import { decideInsert, wrapInCodeFence } from "@/editor/markdown/renderable";
import { activateHighlight } from "@/editor/highlight-activation";
import { api, ApiError, apiErrorText, type SyncStatusDto } from "@/lib/api";
import { uploadAsset } from "@/lib/api";
import { copyText } from "@/lib/clipboard";
import { setPendingNotice, takePendingNotice } from "@/lib/notice";
import { cn } from "@/lib/utils";
import { TooltipProvider, Tip, Dialog, DialogPortal, DialogOverlay, DialogPrimitiveContent, DialogTitle } from "@/components/ui/primitives";
import { useBreakpoint } from "@/lib/viewport-hooks";
import { defaultLayout, LAYOUT_STORAGE_KEY, TABLET_MAX } from "@/lib/viewport";
import { shallowEqual, useCollabSession, useSessionValue, type EditorUser } from "./use-session";
import { EditorActions, EMPTY_FORMAT, type DialogKind, type FormatState } from "./actions";
import type { PendingFileDrop } from "./file-drop-dialog";
import { Header, type ExportFormat } from "./header";
import { Toolbar } from "./toolbar";
import { OutlinePanel } from "./outline";
import { RichPane } from "./rich-pane";
import { StatusBar, type Layout } from "./status-bar";
import type { VersionPreview } from "./versions-panel";
import { PanelResizeHandle, PANEL_DEFAULT, PANEL_MAX, PANEL_MIN, PANEL_WIDTH_KEY, clampPanelWidth, panelMaxFor, parseStoredPanelWidth } from "./panel-resize-handle";
import type { SyncActions } from "./sync-dialog";
import { useEverTrue } from "@/lib/hooks";
import { lazyOnFirstUse } from "./lazy-on-first-use";
import { emptySync, useSyncPolling } from "./use-sync-polling";
import { CODE_COLUMN_BOX, CODE_COLUMN_SPLIT, MAIN_BOX, PANE_LABEL_ROW_BOX, PANES_BOX, RICH_COLUMN_BOX, RICH_COLUMN_SPLIT, RICH_PLACEHOLDER_BOX, RICH_SCROLLER_BOX, SHELL_BOX } from "./chrome-classes";

/** Same box as the pane's root while its chunk loads, so the split layout does not shift when the pane arrives. */
function CodePanePlaceholder() {
  return <div className="h-full min-h-0 w-full" aria-busy="true" data-testid="code-pane-loading" />;
}

/** Fills the side-panel slot (the slot already has its width) with the panel's header row while its chunk loads, so nothing shifts. */
function SidePanelPlaceholder({ title }: { title: string }) {
  return (
    <aside className="flex w-[340px] shrink-0 flex-col border-l border-line bg-surface-2" aria-busy="true" aria-label={title} data-testid="side-panel-loading">
      <div className="flex h-12 items-center justify-between border-b border-line pl-4 pr-2">
        <span className="pane-label">{title}</span>
      </div>
    </aside>
  );
}

// Loaded on demand: CodeMirror and its Markdown grammar (~650 kB of JavaScript) are fetched only when a
// code or split layout shows the pane, so the rich layout — the phone default — never downloads them and
// the desktop paints the rich pane before the request completes (#1121). `actions.ts` and `scroll-sync.ts`
// get their CodeMirror values from the pane through `onReady(view, api)`, so nothing else in this graph
// imports `@codemirror/*` as a value.
const CodePane = dynamic(() => import("./code-pane").then((m) => m.CodePane), { ssr: false, loading: () => <CodePanePlaceholder /> });

// Also on demand (#1150): the side panels, the dialogs, the command palette, the find bar and the file-drop
// dialog are UI nobody sees on a cold load, so each module is a `next/dynamic` boundary fetched on first use
// (`lazyOnFirstUse` adds the one re-render that keeps React's 300 ms fallback throttle out of the first open).
// Everything that takes an `open` prop sits behind a mount-once gate (`useEverTrue`): after the first open it
// stays mounted exactly as a static import did, so Radix's close transition, `onOpenChange` and focus return
// to the trigger are unchanged — the only new thing is one chunk request on the first open. Only types may be
// imported from these modules; a value import puts the module back into the route's entry JS. Each module has
// exactly one `import()` here, shared by its components and by any prefetch (`prefetchVersions`), so it gets
// exactly one chunk.
const loadCommentsPanel = () => import("./comments-panel");
const loadVersionsPanel = () => import("./versions-panel");
const loadActivityPanel = () => import("./activity-panel");
const loadShareDialog = () => import("./share-dialog");
const loadGitHubDialog = () => import("./github-dialog");
const loadSyncDialog = () => import("./sync-dialog");
const loadDialogs = () => import("./dialogs");
const loadFileDropDialog = () => import("./file-drop-dialog");
const loadFindBar = () => import("./find-bar");
const loadCommandPalette = () => import("./command-palette");
const CommentsPanel = lazyOnFirstUse(loadCommentsPanel, (m) => m.CommentsPanel, () => <SidePanelPlaceholder title="Comments" />);
const VersionsPanel = lazyOnFirstUse(loadVersionsPanel, (m) => m.VersionsPanel, () => <SidePanelPlaceholder title="Version history" />);
const ActivityPanel = lazyOnFirstUse(loadActivityPanel, (m) => m.ActivityPanel, () => <SidePanelPlaceholder title="Activity" />);
const VersionDiffView = lazyOnFirstUse(loadVersionsPanel, (m) => m.VersionDiffView);
const ShareDialog = lazyOnFirstUse(loadShareDialog, (m) => m.ShareDialog);
const GitHubDialog = lazyOnFirstUse(loadGitHubDialog, (m) => m.GitHubDialog);
const CommitDialog = lazyOnFirstUse(loadGitHubDialog, (m) => m.CommitDialog);
const SyncDialog = lazyOnFirstUse(loadSyncDialog, (m) => m.SyncDialog);
const LinkDialog = lazyOnFirstUse(loadDialogs, (m) => m.LinkDialog);
const ImageDialog = lazyOnFirstUse(loadDialogs, (m) => m.ImageDialog);
const TableDialog = lazyOnFirstUse(loadDialogs, (m) => m.TableDialog);
const NameVersionDialog = lazyOnFirstUse(loadDialogs, (m) => m.NameVersionDialog);
const ShortcutsDialog = lazyOnFirstUse(loadDialogs, (m) => m.ShortcutsDialog);
const FileDropDialog = lazyOnFirstUse(loadFileDropDialog, (m) => m.FileDropDialog);
const FindBar = lazyOnFirstUse(loadFindBar, (m) => m.FindBar);
const CommandPalette = lazyOnFirstUse(loadCommandPalette, (m) => m.CommandPalette);

import { SelectionBubble } from "./selection-bubble";
import { claimerName, describeResult, useAgentRequests, useAgentRequestsDone } from "./agent-requests";
import { presenceNameOf } from "./presence-agents";
import { TableMenu } from "./table-menu";
import { SlashMenu, useSlashMenuController } from "./slash-menu";
import { FollowBanner } from "./follow-banner";
import { HintBar } from "./hint-bar";
import { useScrollSync } from "./scroll-sync";
import { isPaletteShortcut } from "./palette-shortcut";
import { buildCommands, type EditorCommandContext } from "./commands";
import type { NotificationDto } from "@/lib/api";
import { notificationHref } from "@/components/notifications/open";
import type { FindMatch } from "@/editor/find";
import type { PresenceUser } from "@/editor/collab/session";
import type { NoticeAction } from "@/editor/markdown/tsv";
import { findShortcutAction, isMac } from "@/lib/utils";

export interface EditorShellProps {
  doc: DocumentDto;
  role: Role;
  user: EditorUser;
  githubAvailable: boolean;
  /** The server has a GitHub OAuth app; without it the GitHub entry points are disabled (#162). */
  githubConfigured: boolean;
  /** Canvas mode keeps editing controls but removes navigation and account/share menus. */
  embed?: boolean;
  /** Exact shell origin and expiry carried by a validated embed cookie. */
  embedParentOrigin?: string;
  embedSessionExpiresAt?: number;
  /**
   * Server-rendered HTML of the document, shown in the rich column until the editor holds the
   * live text, so a long document is readable as soon as the page loads (issue #118). Null when
   * the document is empty or could not be rendered.
   */
  initialHtml?: string | null;
}

interface Toast {
  id: number;
  message: string;
  kind: "info" | "error" | "success";
  action?: { label: string; href?: string; onClick?: () => void };
}

type SidePanel = "comments" | "versions" | "activity" | null;

const noopSubscribe = () => () => {};

const subscribeResize = (notify: () => void) => {
  window.addEventListener("resize", notify);
  return () => window.removeEventListener("resize", notify);
};
const readPanelMax = () => panelMaxFor(window.innerWidth);
const serverPanelMax = () => PANEL_MAX;

const EMBED_RENEW_MARGIN_MS = 90_000;
const EMBED_RENEW_RETRY_MS = 15_000;

/** The user's choice to keep the find bar's replace row collapsed; absent = shown for editors. */
const FIND_REPLACE_STORAGE_KEY = "markdoc:find-replace";
const readFindReplaceHidden = (): boolean => {
  try {
    return localStorage.getItem(FIND_REPLACE_STORAGE_KEY) === "hidden";
  } catch {
    return false;
  }
};
const storeFindReplaceHidden = (hidden: boolean) => {
  try {
    if (hidden) localStorage.setItem(FIND_REPLACE_STORAGE_KEY, "hidden");
    else localStorage.removeItem(FIND_REPLACE_STORAGE_KEY);
  } catch {
    // Storage may be unavailable (private mode); the choice still applies while the bar is open.
  }
};

export function EditorShell({
  doc: initialDoc,
  role,
  user,
  githubAvailable,
  githubConfigured,
  initialHtml = null,
  embed = false,
  embedParentOrigin,
  embedSessionExpiresAt,
}: EditorShellProps) {
  const router = useRouter();
  const session = useCollabSession(initialDoc.id, user, role, embed);
  const [doc, setDoc] = useState(initialDoc);
  const [layout, setLayoutState] = useState<Layout>("split");
  const [outlineOpen, setOutlineOpen] = useState(true);
  const [outlineDrawerOpen, setOutlineDrawerOpen] = useState(false);
  const [requestedPanel, setSidePanel] = useState<SidePanel | "automatic-comments">(null);
  const [focusCommentsOnOpen, setFocusCommentsOnOpen] = useState(false);
  const restoreCommentsFocusRef = useRef(false);
  // A request for the comments panel to open a composer on the whole document (#1025): from the
  // toolbar/shortcut with no selection, the palette, the empty state and hint (b) (`mention` pre-types `@`).
  const [documentComposer, setDocumentComposer] = useState<{ mention: boolean; nonce: number } | null>(null);
  const breakpoint = useBreakpoint();
  const isPhone = breakpoint === "phone";
  const isTablet = breakpoint === "tablet";
  const canDockPanel = breakpoint === "desktop";
  // Never mount a modal, even for one render, when an automatic desktop panel becomes narrow.
  const sidePanel: SidePanel = requestedPanel === "automatic-comments" ? (canDockPanel ? "comments" : null) : requestedPanel;
  useEffect(() => {
    if (!canDockPanel) setSidePanel((panel) => panel === "automatic-comments" ? null : panel);
  }, [canDockPanel]);
  // Phones never split: a remembered/initial "split" renders as the preview there.
  const shownLayout: Layout = isPhone && layout === "split" ? "rich" : layout;
  // First load: narrow windows open in the preview unless the user chose Markdown before; tablets
  // start with the outline hidden so both panes get the width.
  useEffect(() => {
    let stored: string | null = null;
    try {
      stored = localStorage.getItem(LAYOUT_STORAGE_KEY);
    } catch {
      // Storage may be unavailable (private mode); fall back to the width-based default.
    }
    setLayoutState(defaultLayout(window.innerWidth, stored));
    if (window.innerWidth < TABLET_MAX) setOutlineOpen(false);
  }, []);
  const setLayout = useCallback((next: Layout) => {
    setLayoutState(next);
    try {
      localStorage.setItem(LAYOUT_STORAGE_KEY, next);
    } catch {
      // Ignore storage errors; the choice still applies for this session.
    }
  }, []);
  const [lineWrapping, setLineWrapping] = useState(true);
  const [dialog, setDialog] = useState<DialogKind>(null);
  const [commitOpen, setCommitOpen] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [sync, setSync] = useState<SyncStatusDto | null>(null);
  const [syncOpen, setSyncOpen] = useState(false);
  const [syncTick, setSyncTick] = useState(0);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [versionPreview, setVersionPreview] = useState<VersionPreview | null>(null);
  const [versionsRefresh, setVersionsRefresh] = useState(0);
  const [linkInitial, setLinkInitial] = useState<{ href: string; text: string } | null>(null);
  const [viewsReady, setViewsReady] = useState(0);
  const [richView, setRichView] = useState<PMView | null>(null);
  const [codeView, setCodeView] = useState<CMView | null>(null);
  const [codeApi, setCodeApi] = useState<CodeApi | null>(null);
  const [richScroller, setRichScroller] = useState<HTMLDivElement | null>(null);
  const [syncScroll, setSyncScrollState] = useState(true);
  const [findUi, setFindUi] = useState<{ replace: boolean; nonce: number } | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const richScrollRef = useRef<HTMLDivElement>(null);
  const setRichScrollRef = useCallback((el: HTMLDivElement | null) => {
    richScrollRef.current = el;
    setRichScroller(el);
  }, []);
  useEffect(() => {
    if (!embed || !embedParentOrigin || !embedSessionExpiresAt || window.parent === window) return;
    let stopped = false;
    let renewing = false;
    let expiresAt = embedSessionExpiresAt;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tellShell = () => {
      window.parent.postMessage(
        { type: "markdoc:embed-session", documentId: initialDoc.id, expiresAt },
        embedParentOrigin,
      );
    };
    const schedule = (delay: number) => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void renew(), Math.max(0, delay));
    };
    const renew = async () => {
      if (stopped || renewing) return;
      renewing = true;
      try {
        const result = await api.embed.renewSession();
        if (stopped) return;
        expiresAt = new Date(result.expiresAt).getTime();
        tellShell();
        schedule(expiresAt - Date.now() - EMBED_RENEW_MARGIN_MS);
      } catch (error) {
        if (!stopped) {
          console.warn("[markdoc] embedded session renewal failed; the canvas shell will retry", error);
          schedule(EMBED_RENEW_RETRY_MS);
        }
      } finally {
        renewing = false;
      }
    };
    const wake = () => {
      if (document.visibilityState === "hidden") return;
      if (Date.now() >= expiresAt - EMBED_RENEW_MARGIN_MS) void renew();
    };
    tellShell();
    schedule(expiresAt - Date.now() - EMBED_RENEW_MARGIN_MS);
    window.addEventListener("pageshow", wake);
    document.addEventListener("visibilitychange", wake);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      window.removeEventListener("pageshow", wake);
      document.removeEventListener("visibilitychange", wake);
    };
  }, [embed, embedParentOrigin, embedSessionExpiresAt, initialDoc.id]);
  useEffect(() => {
    try {
      if (localStorage.getItem("markdoc:syncScroll") === "0") setSyncScrollState(false);
    } catch {
      // Storage may be unavailable (private mode); keep the default.
    }
  }, []);
  const setSyncScroll = useCallback((on: boolean) => {
    setSyncScrollState(on);
    try {
      localStorage.setItem("markdoc:syncScroll", on ? "1" : "0");
    } catch {
      // Ignore storage errors; the setting still applies for this session.
    }
  }, []);
  // Desktop side panel width (Comments / Versions / Activity share it). The upper bound follows
  // the window; the remembered width is read once and clamped whenever the window gets narrower.
  const [panelWidth, setPanelWidthState] = useState(PANEL_DEFAULT);
  const panelMax = useSyncExternalStore(subscribeResize, readPanelMax, serverPanelMax);
  useEffect(() => {
    let stored: number | null = null;
    try {
      stored = parseStoredPanelWidth(localStorage.getItem(PANEL_WIDTH_KEY));
    } catch {
      // Storage may be unavailable (private mode); keep the default width.
    }
    if (stored !== null) setPanelWidthState(clampPanelWidth(stored, PANEL_MIN, panelMaxFor(window.innerWidth)));
  }, []);
  const setPanelWidth = useCallback(
    (next: number) => {
      const width = clampPanelWidth(next, PANEL_MIN, panelMax);
      setPanelWidthState(width);
      try {
        localStorage.setItem(PANEL_WIDTH_KEY, String(width));
      } catch {
        // Ignore storage errors; the width still applies for this session.
      }
    },
    [panelMax],
  );
  const resetPanelWidth = useCallback(() => setPanelWidth(PANEL_DEFAULT), [setPanelWidth]);
  useEffect(() => {
    if (panelWidth > panelMax) setPanelWidth(panelMax);
  }, [panelWidth, panelMax, setPanelWidth]);

  const actions = useMemo(() => new EditorActions(session, setDialog), [session]);
  const slashMenu = useSlashMenuController();
  const isOwner = role === "owner";
  useEffect(() => {
    actions.setRichScroller(richScroller);
  }, [actions, richScroller]);

  const toast = useCallback((message: string, kind: Toast["kind"] = "info", action?: Toast["action"]) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, message, kind, action }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === "error" ? 8000 : 4500);
  }, []);

  // A message left by the previous page (e.g. "Copy created" after "Make a copy").
  useEffect(() => {
    const notice = takePendingNotice();
    if (notice) toast(notice.message, notice.kind);
  }, [toast, doc.id]);

  // Toolbar state is derived from the live editors. Caret moves reach the session too (setLocalCursor),
  // so the selector runs after selection changes as well as text changes; the shallow comparison keeps
  // the object stable when nothing visible changed, and the shell does not re-render for plain typing.
  const format: FormatState = useSessionValue(session, () => (viewsReady ? actions.formatState() : EMPTY_FORMAT), shallowEqual);

  const onCodeReady = useCallback(
    (view: CMView | null, api: CodeApi | null) => {
      actions.setCodeView(view, api);
      setCodeView(view);
      setCodeApi(api);
      setViewsReady((n) => n + 1);
    },
    [actions],
  );
  const onRichReady = useCallback(
    (view: PMView | null) => {
      actions.setRichView(view);
      setRichView(view);
      setViewsReady((n) => n + 1);
    },
    [actions],
  );

  // The caret position lives on the session: the outline and the opposite pane's focus line read it
  // there, so a keystroke does not re-render the shell (and with it every closed dialog).
  const onCodeSelection = useCallback((head: number) => session.setLocalCursor("code", head), [session]);
  const onRichSelection = useCallback((head: number) => session.setLocalCursor("rich", session.binding.getSourceMap().pmToSrc(head)), [session]);

  const openAutomaticComments = useCallback(() => {
    if (canDockPanel) setSidePanel((panel) => panel === "comments" ? panel : "automatic-comments");
  }, [canDockPanel]);

  const onHighlightClick = useCallback(
    (kind: string, id: string | null, sourcePosition: number) => {
      if (activateHighlight(session, kind, id, sourcePosition)) openAutomaticComments();
    },
    [session, openAutomaticComments],
  );

  /** Comment on the whole document: opens Comments with a zero-width composer at {0,0}; `mention` types `@` for the agent picker. */
  const startDocumentComment = useCallback(
    (opts?: { mention?: boolean }) => {
      if (!session.canComment) return;
      setSidePanel("comments");
      setDocumentComposer((prev) => ({ mention: !!opts?.mention, nonce: (prev?.nonce ?? 0) + 1 }));
    },
    [session],
  );

  const startComment = useCallback(() => {
    if (!session.canComment) return;
    const range = actions.selectionSourceRange();
    // No selection is no longer an error: the comment is about the document (#1025).
    if (!range) {
      startDocumentComment();
      return;
    }
    session.setPendingComment(range);
    setSidePanel("comments");
  }, [actions, session, startDocumentComment]);

  const openLink = useCallback(() => {
    setLinkInitial(actions.currentLink());
    setDialog("link");
  }, [actions]);

  const reveal = useCallback((offset: number) => actions.revealSource(offset, { focus: true }), [actions]);

  // Presence popover "Jump": scroll both panes to a collaborator's cursor and flash their caret.
  const jumpToUser = useCallback(
    (u: PresenceUser) => {
      if (u.cursor === null) return;
      actions.revealSource(u.cursor, { focus: false });
      session.flashUser(u.id);
    },
    [actions, session],
  );

  // Following: keep the visible pane(s) centred on the followed user's cursor as it moves.
  const followUserId = useSessionValue(session, (s) => s.followUserId);
  const followedCursor = useSessionValue(session, (s) => (s.followUserId ? (s.presence().find((u) => u.id === s.followUserId)?.cursor ?? null) : null));
  const followEnded = useSessionValue(session, (s) => s.followEnded, shallowEqual);
  useEffect(() => {
    if (followEnded) toast(`${followEnded.name} left`, "info");
  }, [followEnded, toast]);

  const onOutlineSelect = useCallback(
    (h: HeadingInfo) => {
      actions.revealSource(h.from, { focus: true });
    },
    [actions],
  );

  const onIssueSelect = useCallback(
    (issue: LintIssue) => {
      session.setActiveSurface("code");
      actions.revealSource(issue.offset, { focus: true });
      if (shownLayout === "rich") setLayout(isPhone ? "code" : "split");
    },
    [actions, session, shownLayout, isPhone, setLayout],
  );

  const publishNow = useCallback(
    async (message?: string, force = false) => {
      setPublishing(true);
      try {
        const res = await api.documents.publish(doc.id, message, { force });
        if (res.document) setDoc(res.document);
        setVersionsRefresh((n) => n + 1);
        setSyncTick((n) => n + 1);
        if (res.result.skipped) toast("Already up to date on GitHub.", "info");
        else toast(doc.storage === "gist" ? "Gist updated." : "Committed to GitHub.", "success", res.result.url ? { label: "View", href: res.result.url } : undefined);
      } catch (e) {
        // GitHub moved since the last sync: hand the decision to the Sync dialog instead of a raw error.
        if (e instanceof ApiError && e.status === 409 && e.body?.status) {
          setSync((s) => ({ ...(s ?? emptySync()), ...(e.body as Partial<SyncStatusDto>), status: e.body!.status as SyncStatusDto["status"] }));
          setCommitOpen(false);
          setSyncOpen(true);
          throw e;
        }
        toast(apiErrorText(e, "Publish failed"), "error");
        throw e;
      } finally {
        setPublishing(false);
      }
    },
    [doc.id, doc.storage, toast],
  );

  const pull = useCallback(
    async (options: { force?: boolean; merge?: boolean } = {}) => {
      setPublishing(true);
      try {
        const res = await api.documents.pull(doc.id, options);
        if (res.document) setDoc(res.document);
        setVersionsRefresh((n) => n + 1);
        setSyncTick((n) => n + 1);
        toast(res.result.merged ? "Merged GitHub\u2019s changes — review, then publish." : res.result.changed ? "Pulled the latest version from GitHub." : "Already up to date.", "success");
        return res;
      } catch (e) {
        // Local edits would be lost (or both sides changed): open the Sync dialog; the caller handles merge conflicts.
        if (e instanceof ApiError && e.status === 409 && e.body?.status) {
          if (e.body.status !== "conflict") {
            setSync((s) => ({ ...(s ?? emptySync()), ...(e.body as Partial<SyncStatusDto>), status: e.body!.status as SyncStatusDto["status"] }));
            setSyncOpen(true);
          }
          throw e;
        }
        toast(apiErrorText(e, "Pull failed"), "error");
        throw e;
      } finally {
        setPublishing(false);
      }
    },
    [doc.id, toast],
  );

  // Poll the three-way status while the document is GitHub-backed (60 s, or SYNC_POLL_MS via the response) and
  // right after publish/pull; the server caches the GitHub read so this is cheap. Hidden tabs do not poll.
  const linkedToGitHub = doc.storage !== "local";
  useSyncPolling({ documentId: doc.id, enabled: linkedToGitHub, refreshKey: syncTick, onStatus: setSync });

  const syncActions = useMemo<SyncActions>(
    () => ({
      merge: async () => {
        try {
          await pull({ merge: true });
          return 0;
        } catch (e) {
          if (e instanceof ApiError && e.status === 409 && e.body?.status === "conflict" && typeof e.body.merged === "string") {
            // Put the marked text in the document so the user resolves conflicts inline (the `merge-conflict` lint flags each marker).
            session.replaceSource([{ from: 0, to: session.ytext.length, text: e.body.merged }]);
            session.setActiveSurface("code");
            if (shownLayout === "rich") setLayout(isPhone ? "code" : "split");
            toast(`Merged with ${e.body.conflicts} conflict${e.body.conflicts === 1 ? "" : "s"} — resolve the marked lines, then publish.`, "info");
            return Number(e.body.conflicts ?? 1);
          }
          throw e;
        }
      },
      keepMine: (message: string) => publishNow(message, true),
      takeRemote: async () => {
        await pull({ force: true });
      },
      compare: async () => {
        const body = await api.documents.sync(doc.id, { fresh: true, content: true });
        const remoteContent = body.remoteContent ?? "";
        const now = new Date().toISOString();
        setVersionPreview({
          version: { id: "github-remote", number: 0, title: "GitHub", kind: "import", createdBy: null, createdByName: "GitHub", commitSha: body.remote.sha, createdAt: body.remote.updatedAt ?? now, size: remoteContent.length },
          content: remoteContent,
        });
      },
    }),
    [pull, publishNow, session, shownLayout, isPhone, setLayout, toast, doc.id],
  );

  const download = useCallback(
    async (format: ExportFormat, withSuggestions: boolean) => {
      const href = `/api/documents/${doc.id}/export?format=${format}&download=1${withSuggestions ? "&suggestions=1" : ""}`;
      if (format !== "pdf") {
        navigateTo(href);
        return;
      }
      // PDF rendering takes a few seconds; fetch to a blob so the toast can report failures.
      toast("Preparing PDF…", "info");
      try {
        const res = await fetch(href);
        if (!res.ok) {
          const data = (await res.json().catch(() => null)) as { error?: string } | null;
          throw new Error(data?.error ?? `PDF export failed (${res.status})`);
        }
        const blob = await res.blob();
        const match = /filename="([^"]+)"/.exec(res.headers.get("Content-Disposition") ?? "");
        const objectUrl = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = objectUrl;
        a.download = match?.[1] ?? `${doc.title || "document"}.pdf`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(objectUrl), 10_000);
      } catch (e) {
        toast(apiErrorText(e, "PDF export failed"), "error");
      }
    },
    [doc.id, doc.title, toast],
  );

  const copyMarkdown = useCallback(() => {
    // Synchronous call: the execCommand fallback (plain-HTTP LAN origins) needs the click gesture.
    void copyText(session.suggestions.cleanText()).then((ok) => {
      if (ok) toast("Markdown copied to clipboard.", "success");
      else toast("Could not copy. Select the Markdown in the code pane and press Ctrl+C.", "error");
    });
  }, [session, toast]);

  // Pasted, dropped and dialog-chosen images all go through the document's asset store.
  const uploadImage = useCallback((file: File) => uploadAsset(doc.id, file), [doc.id]);
  const onImageError = useCallback((message: string) => toast(`Image upload failed: ${message}`, "error"), [toast]);
  const onNotice = useCallback((message: string, action?: NoticeAction) => toast(message, "info", action), [toast]);

  // A .md/.txt file dropped on either pane: ask whether to replace, insert at the drop point or open as a new document.
  const [fileDrop, setFileDrop] = useState<PendingFileDrop | null>(null);
  const onCodeFileDrop = useCallback((file: File, at: number) => setFileDrop({ file, at }), []);
  const onRichFileDrop = useCallback((file: File, pos: number) => setFileDrop({ file, at: session.binding.getSourceMap().pmToSrc(pos) }), [session]);
  // Imported text micromark cannot parse in linear time goes in as a fenced code block (see renderable.ts).
  const guardImport = useCallback(
    (text: string) => {
      const decision = decideInsert(text, "Imported file");
      if (decision.kind === "markdown") return text;
      toast(decision.message, "info");
      return wrapInCodeFence(text) + "\n";
    },
    [toast],
  );
  const replaceAll = useCallback((text: string) => session.replaceSource([{ from: 0, to: session.ytext.length, text: guardImport(text) }]), [session, guardImport]);
  const insertAt = useCallback(
    (text: string, at: number) => {
      text = guardImport(text);
      const len = session.ytext.length;
      const pos = Math.min(Math.max(at, 0), len);
      const src = session.ytext.toString();
      const before = pos > 0 && src[pos - 1] !== "\n" ? "\n" : "";
      const after = pos < len && src[pos] !== "\n" && !text.endsWith("\n") ? "\n" : "";
      session.replaceSource([{ from: pos, to: pos, text: before + text + after }]);
    },
    [session, guardImport],
  );

  // Set once this client has decided to leave (own delete or server eviction) so the two paths do not race.
  const leavingRef = useRef(false);
  const deleteDoc = useCallback(async () => {
    if (!confirm(`Move “${doc.title}” to trash? You can restore it from the dashboard for 30 days.`)) return;
    try {
      await api.documents.delete(doc.id);
    } catch (e) {
      toast(apiErrorText(e, "Could not move to trash"), "error");
      return;
    }
    leavingRef.current = true;
    setPendingNotice(`“${doc.title}” was moved to the trash.`, "success");
    await session.clearLocal();
    router.push("/");
  }, [doc.id, doc.title, router, session, toast]);

  // Another owner session (or this one, via the API) trashed the document: leave with a notice.
  const trashed = useSessionValue(session, (s) => s.trashed);
  useEffect(() => {
    if (!trashed || leavingRef.current) return;
    leavingRef.current = true;
    setPendingNotice("This document was moved to the trash.", "info");
    void session.clearLocal().finally(() => router.push("/"));
  }, [trashed, session, router]);

  const duplicateDoc = useCallback(async () => {
    try {
      const res = await api.documents.duplicate(doc.id);
      setPendingNotice(
        doc.storage === "local" ? `Created “${res.title}”.` : `Created “${res.title}” as a Markdoc document. The copy is not connected to GitHub.`,
        "success",
      );
      router.push(`/d/${res.id}`);
    } catch (e) {
      toast(apiErrorText(e, "Could not make a copy"), "error");
    }
  }, [doc.id, doc.storage, router, toast]);

  // Stable handlers so the memoized header, toolbar and status bar skip re-renders while typing.
  const toggleComments = useCallback(
    (focusPanel = true) => {
      const closing = sidePanel === "comments";
      restoreCommentsFocusRef.current = closing;
      setFocusCommentsOnOpen(!closing && focusPanel);
      setSidePanel(closing ? null : "comments");
    },
    [sidePanel],
  );

  const restoreCommentsFocus = useCallback(() => {
    if (canDockPanel) {
      document.querySelector<HTMLElement>('[data-testid="comments-toggle"]')?.focus({ preventScroll: true });
    } else {
      // Both views retain and map their selection while blurred. Use that live selection, not a
      // saved offset that could be stale after a collaborative edit or an accepted suggestion.
      if (shownLayout !== "split" && shownLayout !== session.activeSurface) {
        const map = session.binding.getSourceMap();
        const selection = session.activeSurface === "code" ? codeView?.state.selection.main : richView?.state.selection;
        const range = selection && (session.activeSurface === "code"
          ? { from: selection.anchor, to: selection.head }
          : { from: map.pmToSrc(selection.anchor), to: map.pmToSrc(selection.head) });
        session.setActiveSurface(shownLayout);
        // A split layout can hide the source pane when resized to a phone. Return to the same
        // passage in the visible pane rather than focusing the hidden editor or its old caret.
        if (range) {
          actions.selectSourceRange(range, { focus: true });
          return;
        }
      }
      actions.focus();
    }
  }, [actions, canDockPanel, codeView, richView, session, shownLayout]);

  // Agent requests are made from comments (mention an agent, T2 #379); results come back through the
  // shared document (meta.agentRequests, mirrored by the server) so the presence stack and toast are realtime.
  const [commentsFocus, setCommentsFocus] = useState<{ tab: "open" | "resolved" | "suggestions"; nonce: number } | null>(null);
  // A focus request only applies to the panel it opened; once the panel closes, a later reopen picks
  // its own landing tab (Suggestions in Suggesting mode, #117) instead of replaying the stale request.
  useEffect(() => {
    if (sidePanel === "comments") return;
    setCommentsFocus(null);
    setDocumentComposer(null);
    setFocusCommentsOnOpen(false);
    if (sidePanel === null && restoreCommentsFocusRef.current) {
      restoreCommentsFocusRef.current = false;
      restoreCommentsFocus();
    }
  }, [sidePanel, restoreCommentsFocus]);
  const cancelAgentRequest = useCallback(
    (requestId: string) => {
      api.documents
        .cancelRequest(doc.id, requestId)
        .then(() => toast("Request cancelled.", "info"))
        .catch((e) => toast(apiErrorText(e, "Could not cancel the request"), "error"));
    },
    [doc.id, toast],
  );
  const agentRequests = useAgentRequests(session);
  useAgentRequestsDone(session, agentRequests, (r) => {
    // Someone else's agent is "Drew's Copilot CLI"; the owner's display name comes from presence when they are here.
    const who = claimerName(r, session.user.login, (login) => presenceNameOf(session.presence(), login));
    toast(`${who} finished: ${describeResult(r.result)}`, "success");
    if (canDockPanel || sidePanel === "comments") {
      openAutomaticComments();
      setCommentsFocus({ tab: r.result?.suggestions ? "suggestions" : "open", nonce: Date.now() });
    }
  });
  const goCreateToken = useCallback(() => {
    navigateTo(`/settings?next=${encodeURIComponent(`/d/${doc.id}`)}#tokens`);
  }, [doc.id]);
  // "Keep an agent here" from the command palette or the `/agent` slash item: the header opens its dialog.
  const [keepAgentNonce, setKeepAgentNonce] = useState(0);
  const openKeepAgent = useCallback(() => setKeepAgentNonce((n) => n + 1), []);
  // Hint (b) and the empty state: a comment on the whole document with `@` already typed, so the
  // agent picker is up before the user types anything (#1025).
  const startMentionComment = useCallback(() => startDocumentComment({ mention: true }), [startDocumentComment]);

  /** Open the comments panel on a thread (by thread or reply id) or suggestion. Returns false when nothing matches. */
  const activateRef = useCallback(
    (refId: string) => {
      const thread = session.comments.list().find((t) => t.id === refId || t.replies.some((r) => r.id === refId));
      if (thread) {
        session.revealComment(thread.id);
        setSidePanel("comments");
        return true;
      }
      if (session.suggestions.groups().some((s) => s.id === refId || s.members.some((member) => member.id === refId))) {
        session.setActiveSuggestion(refId);
        setSidePanel("comments");
        return true;
      }
      return false;
    },
    [session],
  );

  const onOpenNotification = useCallback(
    (n: NotificationDto) => {
      if (n.documentId !== doc.id) {
        navigateTo(notificationHref(n));
        return;
      }
      if (n.kind === "share") return;
      if (!activateRef(n.refId)) {
        // Decided suggestions are gone from the document; show the panel anyway.
        setSidePanel("comments");
        if (n.kind.startsWith("suggestion.")) session.setActiveSuggestion(n.refId);
      }
    },
    [doc.id, activateRef, session],
  );

  // `/d/<id>?thread=<thread|reply|suggestion id>` (from a notification elsewhere) opens that thread once the document is in.
  const threadParamReady = useSessionValue(session, (s) => s.localLoaded || s.synced);
  useEffect(() => {
    if (!threadParamReady) return;
    const url = new URL(window.location.href);
    const threadParam = url.searchParams.get("thread");
    if (!threadParam) return;
    url.searchParams.delete("thread");
    window.history.replaceState(window.history.state, "", url.toString());
    // The shared comments map may arrive a beat after the text; retry briefly.
    let tries = 0;
    const tick = () => {
      if (activateRef(threadParam) || ++tries > 40) return;
      timer = setTimeout(tick, 100);
    };
    let timer = setTimeout(tick, 0);
    return () => clearTimeout(timer);
  }, [threadParamReady, activateRef]);
  const toggleHistory = useCallback(() => setSidePanel((p) => (p === "versions" ? null : "versions")), []);
  // Opening the More menu warms both the versions list and, through the loader, the versions chunk itself.
  const onMoreMenuOpen = useCallback(() => {
    loadVersionsPanel()
      .then((m) => m.prefetchVersions(doc.id))
      .catch(() => undefined);
  }, [doc.id]);
  const toggleActivity = useCallback(() => setSidePanel((p) => (p === "activity" ? null : "activity")), []);
  const openShare = useCallback(() => setDialog("share"), []);
  const openPublish = useCallback(() => setDialog("publish"), []);
  const openShortcuts = useCallback(() => setDialog("shortcuts"), []);
  const openPalette = useCallback(() => setPaletteOpen(true), []);
  const openImage = useCallback(() => setDialog("image"), []);
  const openTable = useCallback(() => setDialog("table"), []);
  const openVersionName = useCallback(() => setDialog("versionName"), []);
  const openStorage = useCallback(() => (isOwner ? setDialog("publish") : undefined), [isOwner]);
  const publishFromHeader = useCallback(() => (doc.storage === "gist" ? void publishNow() : setCommitOpen(true)), [doc.storage, publishNow]);
  const pullFromHeader = useCallback(() => void pull().catch(() => undefined), [pull]);
  const openSync = useCallback(() => setSyncOpen(true), []);
  const deleteFromHeader = useCallback(() => void deleteDoc(), [deleteDoc]);
  const duplicateFromHeader = useCallback(() => void duplicateDoc(), [duplicateDoc]);
  const copyFromHeader = useCallback(() => void copyMarkdown(), [copyMarkdown]);
  const goHome = useCallback(() => router.push("/"), [router]);

  // Find & replace. The model lives on the session (shared with the highlight pipeline);
  // the shell owns focus handling and the replace-row toggle. Editors get the replace row by
  // default (the bar gates it on canEdit); hiding it is remembered until Mod-H / ⌥⌘F asks for it again.
  const openFind = useCallback(
    (replace: boolean) => {
      const seed = actions.selectionText();
      session.setFind(seed || session.find?.query || "");
      if (replace) storeFindReplaceHidden(false);
      const preferred = replace || !readFindReplaceHidden();
      setFindUi((ui) => ({ replace: replace || (ui?.replace ?? preferred), nonce: (ui?.nonce ?? 0) + 1 }));
      const m = session.find?.matches[session.find.active];
      if (m) actions.revealSourceRange(m);
    },
    [actions, session],
  );
  const closeFind = useCallback(() => {
    const m = session.find?.matches[session.find.active] ?? null;
    session.closeFind();
    setFindUi(null);
    // The active match becomes the selection in the pane the user was working in.
    if (m) actions.selectSourceRange(m, { focus: true });
    else actions.focus();
  }, [actions, session]);
  const setFindReplaceVisible = useCallback((replace: boolean) => {
    storeFindReplaceHidden(!replace);
    setFindUi((ui) => (ui ? { ...ui, replace } : ui));
  }, []);
  const revealMatch = useCallback((m: FindMatch) => actions.revealSourceRange(m), [actions]);

  // Global shortcuts that are not editor-specific.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      // Option-letter on macOS reports a symbol in `key`; fall back to the physical key there.
      const key = isMac && e.altKey && /^Key[A-Z]$/.test(e.code) ? e.code.slice(3).toLowerCase() : e.key.toLowerCase();
      if (mod && !e.altKey && !e.shiftKey && key === "s") {
        e.preventDefault();
        void session.flushSave().then(
          () => session.dirty
            ? toast("Requested changes saved; newer edits are still pending.", "info")
            : toast("Document saved.", "success"),
          (error: unknown) => toast(apiErrorText(error, "Could not save document"), "error"),
        );
      }
      if (mod && e.altKey && key === "m") {
        e.preventDefault();
        startComment();
      }
      if (mod && e.key === "/" ) {
        e.preventDefault();
        setDialog("shortcuts");
      }
      // Mod-F must win over the browser and both editors' default search bindings.
      const findAction = findShortcutAction(e, isMac);
      if (findAction) {
        e.preventDefault();
        openFind(findAction === "replace");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [startComment, openFind, session, toast]);

  // Command palette. Captured at the window so Mod-K with a collapsed selection is taken before the
  // editors' own Mod-K (Link) binding; with a selection the event falls through to them.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (paletteOpen || !isPaletteShortcut(e)) return;
      e.preventDefault();
      e.stopPropagation();
      setPaletteOpen(true);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [paletteOpen]);

  const canChangeMode = role === "owner" || role === "editor";
  const paletteCtx: EditorCommandContext = {
    actions,
    session: { canEdit: session.canEdit, canComment: session.canComment, mode: session.mode, canChangeMode, setMode: (m) => session.setMode(m) },
    doc,
    isOwner,
    embed,
    slashWhere: { inTable: format.tablePos >= 0, canComment: session.canComment },
    setDialog,
    openLink,
    openImage,
    startComment,
    commentDocument: startDocumentComment,
    keepAgent: openKeepAgent,
    toggleComments,
    toggleHistory,
    toggleActivity,
    layout: shownLayout,
    setLayout,
    outlineOpen: isPhone ? outlineDrawerOpen : outlineOpen,
    toggleOutline: () => (isPhone ? setOutlineDrawerOpen((o) => !o) : setOutlineOpen((o) => !o)),
    syncScroll,
    setSyncScroll,
    openFind,
    download: (format) => void download(format, false),
    copyMarkdown: copyFromHeader,
    duplicate: duplicateFromHeader,
    trash: deleteFromHeader,
    publish: () => (doc.storage === "local" ? setDialog("publish") : publishFromHeader()),
    openReader: () => window.open(`/p/${doc.id}`, "_blank", "noopener"),
    navigate: (href) => router.push(href),
    notify: (message) => toast(message, "info"),
    headings: () => session.binding.getHeadings(),
    collaborators: () => session.presence().filter((u) => !u.isLocal).map((u) => ({ id: u.id, name: u.name })),
    follow: (id) => session.follow(id),
    recentDocuments: async () => {
      const res = await fetch("/api/documents?limit=8");
      if (!res.ok) throw new Error(`Could not load documents (${res.status})`);
      const data = (await res.json()) as { documents: { id: string; title: string }[] };
      return data.documents.filter((d) => d.id !== doc.id).map((d) => ({ id: d.id, title: d.title }));
    },
  };
  // The palette reads the context when it opens; a ref keeps `paletteCommands` stable across renders.
  const paletteCtxRef = useRef(paletteCtx);
  useEffect(() => {
    paletteCtxRef.current = paletteCtx;
  });
  const paletteCommands = useCallback(() => buildCommands(paletteCtxRef.current), []);

  const findOpen = useSessionValue(session, (s) => s.find !== null);

  // The title lives in the shared document so everyone sees renames immediately.
  const sharedTitle = useSessionValue(session, (s) => s.title);
  const docView = useMemo(() => (sharedTitle && sharedTitle !== doc.title ? { ...doc, title: sharedTitle } : doc), [doc, sharedTitle]);

  const authError = useSessionValue(session, (s) => s.authError);
  // Keep the panes covered until either the local copy or the server state is in, so a
  // document never flashes empty before its content arrives. The server has no IndexedDB
  // and renders without the overlay, so only show it after hydration to keep markup in sync.
  const contentReady = useSessionValue(session, (s) => s.localLoaded || s.synced);
  const hydrated = useSyncExternalStore(noopSubscribe, () => true, () => false);
  // The rich pane holds the live text once the local copy or the server state put something in
  // it and the binding has rebuilt the ProseMirror document from it (the rebuild is coalesced
  // while the document loads and its parse runs in a task of its own, see MarkdownBinding.holdRemoteSync)
  // or the server confirmed the document really is empty.
  const richHasContent = useSessionValue(session, (s) => (s.synced || s.ytext.length > 0) && !s.binding.hasHeldSync);
  // Until then the server-rendered preview stands in for the rich pane; the server and the
  // hydrating client both render it (the session has no content on either), so markup matches.
  const showRichPlaceholder = initialHtml !== null && !richHasContent;
  const showLoading = hydrated && !contentReady;
  const showCode = shownLayout !== "rich" && !versionPreview;
  const showRich = shownLayout !== "code" && !versionPreview;
  // The code pane mounts the first time a code/split layout shows it and stays mounted (the column hides
  // it) afterwards, exactly as before its chunk was split off; a layout that never shows it — the phone
  // default — never downloads CodeMirror. Not during hydration: that render assumes a desktop viewport
  // (useBreakpoint), so a phone would fetch the chunk for a pane it hides a moment later (#1121).
  const [codePaneMounted, setCodePaneMounted] = useState(false);
  useEffect(() => {
    if (hydrated && showCode) setCodePaneMounted(true);
  }, [hydrated, showCode]);
  const viewingOnly = useSessionValue(session, (s) => s.mode === "viewing");
  useScrollSync({ session, code: codeView, codeApi, rich: richView, richScroller, enabled: syncScroll && showCode && showRich });
  // revealSource scrolls only the active surface while the sync mirrors the panes onto each other.
  useEffect(() => {
    actions.setScrollSynced(syncScroll && showCode && showRich);
  }, [actions, syncScroll, showCode, showRich]);

  // Re-centre on the followed cursor (debounced) whenever it moves or the panes change.
  useEffect(() => {
    if (!followUserId || followedCursor === null) return;
    const t = setTimeout(() => actions.scrollToSource(followedCursor, { code: showCode, rich: showRich, synced: syncScroll && showCode && showRich }), 150);
    return () => clearTimeout(t);
  }, [actions, followUserId, followedCursor, showCode, showRich, syncScroll]);

  // Following stops on the user's own scroll (wheel/touch, not programmatic), typing in either pane, or Esc.
  useEffect(() => {
    if (!followUserId) return;
    const stop = (event: "user-scroll" | "typing") => () => session.dispatchFollow({ type: event });
    const onScroll = stop("user-scroll");
    const onType = stop("typing");
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") session.dispatchFollow({ type: "stop" });
    };
    const scrollers = [richScroller, codeView?.scrollDOM ?? null].filter((el): el is HTMLElement => !!el);
    const editors = [richView?.dom ?? null, codeView?.contentDOM ?? null].filter((el): el is HTMLElement => !!el);
    for (const el of scrollers) {
      el.addEventListener("wheel", onScroll, { passive: true });
      el.addEventListener("touchmove", onScroll, { passive: true });
    }
    for (const el of editors) el.addEventListener("beforeinput", onType, true);
    window.addEventListener("keydown", onKey, true);
    return () => {
      for (const el of scrollers) {
        el.removeEventListener("wheel", onScroll);
        el.removeEventListener("touchmove", onScroll);
      }
      for (const el of editors) el.removeEventListener("beforeinput", onType, true);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [session, followUserId, richScroller, codeView, richView]);
  const closeSidePanel = useCallback(() => {
    restoreCommentsFocusRef.current = sidePanel === "comments";
    setSidePanel(null);
  }, [sidePanel]);
  const keepCommentsOpen = useCallback(() => {
    setSidePanel((panel) => panel === "automatic-comments" ? "comments" : panel);
  }, []);
  const toggleOutline = useCallback(() => (isPhone ? setOutlineDrawerOpen((o) => !o) : setOutlineOpen((o) => !o)), [isPhone]);
  const closeOutlineDrawer = useCallback(() => setOutlineDrawerOpen(false), []);

  // Stable handlers for the dialogs: each is memoized, so a render of the shell (a toast, a sync poll, a
  // format change) does not re-render the closed ones.
  const dialogOpenChange = useMemo(() => {
    const make = (kind: Exclude<DialogKind, null>) => (open: boolean) => setDialog(open ? kind : null);
    return { share: make("share"), publish: make("publish"), link: make("link"), image: make("image"), table: make("table"), versionName: make("versionName"), shortcuts: make("shortcuts") };
  }, []);
  const onPublishDocChange = useCallback((d: DocumentDto) => {
    setDoc(d);
    setVersionsRefresh((n) => n + 1);
  }, []);
  const applyLink = useCallback((href: string, text: string) => actions.applyLink(href, text), [actions]);
  const removeLink = useCallback(() => actions.removeLink(), [actions]);
  const insertImage = useCallback((src: string, alt: string) => actions.insertImage(src, alt), [actions]);
  const insertTable = useCallback((rows: number, cols: number) => actions.insertTable(rows, cols), [actions]);
  const closeFileDrop = useCallback(() => setFileDrop(null), []);
  const fileDropError = useCallback((m: string) => toast(m, "error"), [toast]);
  const saveNamedVersion = useCallback(
    async (title: string) => {
      await api.documents.createVersion(doc.id, title);
      setVersionsRefresh((n) => n + 1);
      toast(`Saved version “${title}”.`, "success");
    },
    [doc.id, toast],
  );
  const canEdit = useSessionValue(session, (s) => s.canEdit);
  const onOutlinePick = useCallback(
    (h: HeadingInfo) => {
      setOutlineDrawerOpen(false);
      onOutlineSelect(h);
    },
    [onOutlineSelect],
  );

  // Mount-once gates for the lazy dialogs (see the `dynamic` block at the top): each dialog mounts on its first
  // open and stays mounted afterwards, so closing it still runs through Radix exactly as before.
  const everOpened = {
    share: useEverTrue(dialog === "share"),
    publish: useEverTrue(dialog === "publish"),
    commit: useEverTrue(commitOpen),
    sync: useEverTrue(syncOpen),
    link: useEverTrue(dialog === "link"),
    image: useEverTrue(dialog === "image"),
    table: useEverTrue(dialog === "table"),
    versionName: useEverTrue(dialog === "versionName"),
    shortcuts: useEverTrue(dialog === "shortcuts"),
    palette: useEverTrue(paletteOpen),
    fileDrop: useEverTrue(fileDrop !== null),
  };

  const panel =
    sidePanel === "comments" ? (
      <CommentsPanel
        session={session}
        onClose={closeSidePanel}
        onReveal={reveal}
        onPendingDone={() => actions.focusCollapsed()}
        onCancelRequest={cancelAgentRequest}
        onCreateToken={goCreateToken}
        focusTab={commentsFocus}
        documentComposer={documentComposer}
        focusOnMount={focusCommentsOnOpen}
        onToast={toast}
      />
    ) : sidePanel === "versions" ? (
      <VersionsPanel session={session} onClose={closeSidePanel} onPreview={setVersionPreview} refreshKey={versionsRefresh} />
    ) : sidePanel === "activity" ? (
      <ActivityPanel session={session} onClose={closeSidePanel} />
    ) : null;
  const panelTitle = sidePanel === "comments" ? "Comments" : sidePanel === "versions" ? "Version history" : "Activity";

  return (
    <TooltipProvider>
      <div className={SHELL_BOX} data-testid="editor-shell" data-breakpoint={breakpoint}>
        <a
          href="#editor-main"
          className="skip-link"
          data-testid="skip-link"
          onClick={(e) => {
            e.preventDefault();
            actions.focus();
          }}
        >
          Skip to editor
        </a>
        <Header
          session={session}
          doc={docView}
          commentsOpen={sidePanel === "comments"}
          onToggleComments={toggleComments}
          onOpenNotification={onOpenNotification}
          onShare={openShare}
          onPublish={openPublish}
          onPublishNow={publishFromHeader}
          onPull={pullFromHeader}
          onSync={openSync}
          sync={sync}
          onHistory={toggleHistory}
          onMoreMenuOpen={onMoreMenuOpen}
          onActivity={toggleActivity}
          onShortcuts={openShortcuts}
          onCommandPalette={openPalette}
          onDelete={deleteFromHeader}
          onDuplicate={duplicateFromHeader}
          onDownload={download}
          onCopyMarkdown={copyFromHeader}
          onNameVersion={openVersionName}
          publishing={publishing}
          isOwner={isOwner}
          githubConfigured={githubConfigured}
          onHome={goHome}
          layout={shownLayout}
          onLayout={setLayout}
          onOutline={toggleOutline}
          compact={isPhone}
          onJumpToUser={jumpToUser}
          onCancelRequest={cancelAgentRequest}
          onCreateToken={goCreateToken}
          keepAgentNonce={keepAgentNonce}
          embed={embed}
        />
        <Toolbar session={session} actions={actions} format={format} onComment={startComment} onImage={openImage} onTable={openTable} />
        {!isPhone && <HintBar session={session} actions={actions} onShare={openShare} onComment={startMentionComment} />}
        {findOpen && (
          <FindBar
            session={session}
            replaceVisible={findUi?.replace ?? false}
            onReplaceVisible={setFindReplaceVisible}
            focusNonce={findUi?.nonce ?? 0}
            onReveal={revealMatch}
            onClose={closeFind}
          />
        )}
        <FollowBanner session={session} />
        {authError && (
          <div className="flex items-center justify-center gap-3 bg-red-50 px-4 py-2 text-sm text-danger dark:bg-red-950/40" role="alert">
            Could not connect to the collaboration server ({authError}).
            <button type="button" className="btn btn-sm btn-outline" onClick={() => window.location.reload()}>
              Reload
            </button>
          </div>
        )}
        <main id="editor-main" className={MAIN_BOX}>
          {isPhone ? (
            <Dialog open={outlineDrawerOpen} onOpenChange={setOutlineDrawerOpen}>
              <DialogPortal>
                <DialogOverlay className="dialog-overlay animate-fade-in" data-testid="outline-drawer-backdrop" />
                <DialogPrimitiveContent className="drawer" aria-describedby={undefined} data-testid="outline-drawer">
                  <DialogTitle className="sr-only">Outline</DialogTitle>
                  <OutlinePanel session={session} open onToggle={closeOutlineDrawer} onSelect={onOutlinePick} />
                </DialogPrimitiveContent>
              </DialogPortal>
            </Dialog>
          ) : (
            // Hidden by CSS below `md` (= the hook's phone threshold, PHONE_MAX): the server and hydration
            // renders assume a desktop viewport, so without it a phone paints a 224 px rail first (#1470).
            <OutlinePanel className="max-md:hidden" session={session} open={outlineOpen} onToggle={toggleOutline} onSelect={onOutlineSelect} />
          )}
          <div className={PANES_BOX}>
            {showLoading && !showRichPlaceholder && (
              <div className="absolute inset-0 z-10 flex items-center justify-center bg-surface text-sm text-ink-3" data-testid="doc-loading" aria-busy="true">
                Loading…
              </div>
            )}
            {versionPreview ? (
              <div className="flex h-full min-h-0 min-w-0 flex-col">
                {versionPreview.version.id === "github-remote" && (
                  <div className="flex items-center gap-3 border-b border-line bg-surface-2 px-6 py-1.5 text-sm text-ink-2" data-testid="sync-compare-bar">
                    <span>Comparing GitHub\u2019s copy with this document.</span>
                    <button type="button" className="btn btn-sm btn-outline ml-auto" onClick={() => setVersionPreview(null)} data-testid="sync-compare-close">
                      Back to editing
                    </button>
                  </div>
                )}
                <VersionDiffView session={session} preview={versionPreview} />
              </div>
            ) : (
              <>
                {/* `layout` (not `shownLayout`): before hydration it is always "split", so the phone's first paint already
                    hides the code column and the rich column's `flex-1 basis-0` fills the width, as after hydration (#1470). */}
                <div className={cn(CODE_COLUMN_BOX, showRich ? CODE_COLUMN_SPLIT : "flex-1", !showCode && "hidden", layout === "split" && "max-md:hidden")} data-testid="code-column">
                  {showLoading && showRichPlaceholder && (
                    <div className="absolute inset-0 z-10 flex items-center justify-center bg-surface text-sm text-ink-3" data-testid="doc-loading" aria-busy="true">
                      Loading…
                    </div>
                  )}
                  <div className="min-h-0 flex-1">
                    {codePaneMounted && (
                      <CodePane
                        session={session}
                        onReady={onCodeReady}
                        onSelection={onCodeSelection}
                        onHighlightClick={onHighlightClick}
                        uploadImage={uploadImage}
                        onImageError={onImageError}
                        onNotice={onNotice}
                        onMarkdownFileDrop={onCodeFileDrop}
                        lineWrapping={lineWrapping}
                      />
                    )}
                  </div>
                </div>
                <div className={cn(RICH_COLUMN_BOX, showCode ? RICH_COLUMN_SPLIT : "flex-1", !showRich && "hidden")} data-testid="rich-column">
                  <div className={PANE_LABEL_ROW_BOX}>
                    <span className="pane-label">{viewingOnly ? "Preview" : "Preview"}</span>
                    <Tip label={viewingOnly ? "Switch to editing" : "View only"}>
                      <button
                        type="button"
                        className="icon-btn h-8 w-8"
                        onClick={() => session.setMode(viewingOnly ? "editing" : "viewing")}
                        disabled={role !== "owner" && role !== "editor"}
                        aria-label={viewingOnly ? "Switch to editing" : "View only"}
                        data-testid="preview-mode-toggle"
                      >
                        {viewingOnly ? <PenLine size={17} /> : <Eye size={18} />}
                      </button>
                    </Tip>
                  </div>
                  <div ref={setRichScrollRef} className={RICH_SCROLLER_BOX}>
                    {showRichPlaceholder && (
                      // Read-only stand-in until the live text is in; `inert` keeps its links and headings out of focus and a11y order.
                      <div className={RICH_PLACEHOLDER_BOX} data-testid="rich-placeholder" aria-hidden="true" inert dangerouslySetInnerHTML={{ __html: initialHtml }} />
                    )}
                    <SelectionBubble view={richView} session={session} actions={actions} format={format} containerRef={richScrollRef} onComment={startComment} onLink={openLink} />
                    <TableMenu view={richView} session={session} actions={actions} format={format} containerRef={richScrollRef} />
                    <SlashMenu view={richView} session={session} controller={slashMenu} containerRef={richScrollRef} onImage={openImage} onLink={openLink} onComment={startComment} onKeepAgent={openKeepAgent} />
                    <RichPane
                      session={session}
                      hidden={showRichPlaceholder}
                      onReady={onRichReady}
                      onSelection={onRichSelection}
                      onHighlightClick={onHighlightClick}
                      onLinkShortcut={openLink}
                      onCommentShortcut={startComment}
                      uploadImage={uploadImage}
                      onImageError={onImageError}
                      onNotice={onNotice}
                      onMarkdownFileDrop={onRichFileDrop}
                      slashMenu={slashMenu.handlers}
                    />
                  </div>
                </div>
              </>
            )}
          </div>
          {panel &&
            (isPhone ? (
              <Dialog open onOpenChange={(o) => !o && closeSidePanel()}>
                <DialogPortal>
                  <DialogOverlay className="dialog-overlay animate-fade-in" data-testid="sheet-backdrop" />
                  <DialogPrimitiveContent
                    className="sheet"
                    aria-describedby={undefined}
                    data-testid="sheet"
                    data-panel={sidePanel}
                    onCloseAutoFocus={sidePanel === "comments" ? (event) => event.preventDefault() : undefined}
                  >
                    <DialogTitle className="sr-only">{panelTitle}</DialogTitle>
                    <span className="sheet-handle" aria-hidden />
                    {panel}
                  </DialogPrimitiveContent>
                </DialogPortal>
              </Dialog>
            ) : isTablet ? (
              // Tablets float the panel over the panes so the text does not reflow when it opens.
              <div className="absolute inset-y-0 right-0 z-20 flex w-[360px] max-w-full shadow-2xl shadow-black/20 [&>aside]:w-full" data-testid="panel-overlay">
                {panel}
              </div>
            ) : (
              // Desktop: the panel takes the remembered width; the grip on its left edge resizes it.
              <div
                className="relative flex shrink-0 [&>aside]:w-full [&>aside]:min-w-0"
                style={{ width: panelWidth }}
                data-testid="side-panel"
                onPointerDownCapture={keepCommentsOpen}
                onFocusCapture={keepCommentsOpen}
              >
                <PanelResizeHandle width={panelWidth} min={PANEL_MIN} max={panelMax} onResize={setPanelWidth} onReset={resetPanelWidth} />
                {panel}
              </div>
            ))}
        </main>
        <StatusBar
          session={session}
          doc={docView}
          layout={shownLayout}
          onLayout={setLayout}
          lineWrapping={lineWrapping}
          onLineWrapping={setLineWrapping}
          syncScroll={syncScroll}
          onSyncScroll={setSyncScroll}
          onIssueSelect={onIssueSelect}
          onShortcuts={openShortcuts}
          onStorage={embed ? undefined : openStorage}
          compact={isPhone}
        />

        {!embed && (
          <>
            {everOpened.share && <ShareDialog open={dialog === "share"} onOpenChange={dialogOpenChange.share} doc={docView} isOwner={isOwner} onDocChange={setDoc} />}
            {everOpened.publish && (
              <GitHubDialog open={dialog === "publish"} onOpenChange={dialogOpenChange.publish} doc={docView} onDocChange={onPublishDocChange} githubAvailable={githubAvailable} githubConfigured={githubConfigured} isOwner={isOwner} />
            )}
            {everOpened.commit && <CommitDialog open={commitOpen} onOpenChange={setCommitOpen} doc={docView} onCommit={publishNow} isOwner={isOwner} />}
            {everOpened.sync && <SyncDialog open={syncOpen} onOpenChange={setSyncOpen} doc={docView} sync={sync} actions={syncActions} />}
          </>
        )}
        {everOpened.link && <LinkDialog open={dialog === "link"} onOpenChange={dialogOpenChange.link} initial={linkInitial} onSubmit={applyLink} onRemove={removeLink} />}
        {everOpened.image && <ImageDialog open={dialog === "image"} onOpenChange={dialogOpenChange.image} onSubmit={insertImage} onUpload={uploadImage} />}
        {everOpened.fileDrop && <FileDropDialog pending={fileDrop} onClose={closeFileDrop} canEdit={canEdit} onReplace={replaceAll} onInsert={insertAt} onError={fileDropError} />}
        {everOpened.table && <TableDialog open={dialog === "table"} onOpenChange={dialogOpenChange.table} onSubmit={insertTable} />}
        {everOpened.versionName && <NameVersionDialog open={dialog === "versionName"} onOpenChange={dialogOpenChange.versionName} onSubmit={saveNamedVersion} />}
        {everOpened.shortcuts && <ShortcutsDialog open={dialog === "shortcuts"} onOpenChange={dialogOpenChange.shortcuts} />}
        {everOpened.palette && <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} commands={paletteCommands} />}

        <div className="pointer-events-none fixed bottom-14 left-1/2 z-[70] flex -translate-x-1/2 flex-col items-center gap-2" aria-live="polite">
          {toasts.map((t) => (
            <div
              key={t.id}
              className={cn(
                "pointer-events-auto flex items-center gap-3 rounded-xl px-4 py-2.5 text-sm shadow-xl animate-fade-in",
                t.kind === "error" ? "bg-red-600 text-white" : "bg-inverse text-white",
              )}
              role="status"
              data-testid="toast"
            >
              <span>{t.message}</span>
              {t.action?.href && (
                <a className="font-semibold underline decoration-white/40 underline-offset-2" href={t.action.href} target="_blank" rel="noopener noreferrer">
                  {t.action.label}
                </a>
              )}
              {t.action?.onClick && (
                <button
                  type="button"
                  className="font-semibold underline decoration-white/40 underline-offset-2"
                  onClick={() => {
                    t.action?.onClick?.();
                    setToasts((list) => list.filter((x) => x.id !== t.id));
                  }}
                  data-testid="toast-action"
                >
                  {t.action.label}
                </button>
              )}
              <button type="button" className="text-white/60 hover:text-white" onClick={() => setToasts((list) => list.filter((x) => x.id !== t.id))} aria-label="Dismiss">
                <X size={14} />
              </button>
            </div>
          ))}
        </div>
      </div>
    </TooltipProvider>
  );
}
