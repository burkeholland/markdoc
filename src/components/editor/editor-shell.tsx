"use client";
import { navigateTo } from "@/lib/nav";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { flushSync } from "react-dom";
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
import { api, ApiError, apiErrorText, type SyncStatusDto, type VersionSummary } from "@/lib/api";
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
import type { NameVersionSaveOwner, NameVersionVisit } from "./dialogs";
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
let loadedVersionsPanelModule: typeof import("./versions-panel") | null = null;
const loadVersionsPanel = () =>
  import("./versions-panel").then((module) => {
    loadedVersionsPanelModule = module;
    return module;
  });
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
const LazyVersionDiffView = lazyOnFirstUse(loadVersionsPanel, (m) => m.VersionDiffView);
const VersionDiffView: typeof import("./versions-panel").VersionDiffView = (props) => {
  const Ready = loadedVersionsPanelModule?.VersionDiffView;
  return Ready ? <Ready {...props} /> : <LazyVersionDiffView {...props} />;
};
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
import type { CollabSession, PresenceUser } from "@/editor/collab/session";
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

type PublishPullKind = "publish" | "pull";
type EditorIdentity = { documentId: string; session: CollabSession };
type PreviewSourceKind = "versions" | "github-compare";
type PreviewProducer = (preview: VersionPreview | null) => void;
const PREVIEW_ROOT_CLASS = "flex h-full min-h-0 min-w-0 flex-col";
const PREVIEW_BAR_CLASS = "flex items-center gap-3 border-b border-line bg-surface-2 px-6 py-1.5 text-sm text-ink-2";
const PREVIEW_BACK_CLASS = "btn btn-sm btn-outline ml-auto";
const PREVIEW_MESSAGE = "Comparing GitHub\\u2019s copy with this document.";
type ToastKind = "info" | "error" | "success";
interface ToastAction {
  readonly label: string;
  readonly href?: string;
  readonly onClick?: () => void;
}
interface ToastAuthority {
  readonly mount: symbol;
  readonly editor: EditorIdentity;
  readonly userId: string;
  readonly role: Role;
}
interface ToastPublication {
  readonly authority: ToastAuthority;
  readonly message: string;
  readonly kind: ToastKind;
  readonly action?: ToastAction;
  readonly timer: ReturnType<typeof setTimeout>;
}
type PublishPullOwner = { editor: EditorIdentity; kind: PublishPullKind };
type DocumentMutationAction = "delete" | "duplicate";
type DocumentMutationOwner = {
  editor: EditorIdentity;
  session: CollabSession;
  documentId: string;
  title: string;
  storage: DocumentDto["storage"];
  action: DocumentMutationAction;
  operation: number;
};
interface EditorPreviewVisit {
  readonly generation: symbol;
  readonly revision: number;
  readonly mount: symbol;
  readonly editor: EditorIdentity;
  readonly document: DocumentDto;
  readonly documentId: string;
  readonly storage: DocumentDto["storage"];
  readonly gistId: string | null;
  readonly gistFile: string | null;
  readonly repoOwner: string | null;
  readonly repoName: string | null;
  readonly repoBranch: string | null;
  readonly repoPath: string | null;
  readonly githubUrl: string | null;
  readonly session: CollabSession;
  readonly actions: EditorActions;
  readonly versionsProducer: PreviewProducer;
  readonly githubProducer: (preview: VersionPreview) => void;
  readonly captureContainer: (element: HTMLDivElement | null) => void;
  readonly establish: () => void;
  readonly retire: () => boolean;
  readonly owns: () => boolean;
  readonly container: () => HTMLDivElement | null;
}
interface PreviewValueFacts {
  readonly preview: VersionPreview;
  readonly version: VersionPreview["version"];
  readonly versionFacts: Readonly<VersionSummary>;
  readonly content: string;
  readonly base: VersionPreview["base"];
  readonly baseVersion: VersionSummary | null;
  readonly baseVersionFacts: Readonly<VersionSummary> | null;
  readonly baseContent: string | null;
  readonly range: VersionPreview["range"];
  readonly rangeVersions: readonly VersionPreview["version"][] | null;
  readonly rangeFacts: readonly Readonly<VersionSummary>[] | null;
}
interface PreviewSelection {
  readonly action: symbol;
  readonly visit: EditorPreviewVisit;
  readonly producer: PreviewProducer;
  readonly source: PreviewSourceKind;
  readonly value: PreviewValueFacts;
}
interface PreviewPresentationAuthority {
  readonly generation: symbol;
  readonly revision: number;
  readonly mount: symbol;
  readonly selection: PreviewSelection;
  readonly rootClass: string;
  readonly barClass: string;
  readonly backClass: string;
  readonly message: string;
}
interface PreviewPresentation {
  readonly authority: PreviewPresentationAuthority;
  readonly captureRoot: (element: HTMLDivElement | null) => void;
  readonly captureBack: (element: HTMLButtonElement | null) => void;
  readonly establish: () => void;
  readonly retireLayout: () => boolean;
  readonly retire: () => void;
  readonly activateBack: (event: React.MouseEvent<HTMLButtonElement>) => void;
}
interface PreviewGrant {
  readonly generation: symbol;
  readonly publication: PreviewPresentation;
  readonly committed: PreviewDomSnapshot;
  actionClaimed: boolean;
  retired: boolean;
  readonly retire: () => void;
}
interface PreviewVisitCells {
  readonly active: {
    current: EditorPreviewVisit | null;
    revision: number;
  };
  readonly replay: { current: PreviewVisitSuccessor | null };
  readonly retired: WeakSet<EditorPreviewVisit>;
}
interface PreviewPublicationCells {
  readonly active: {
    current: PreviewGrant | null;
    revision: number;
  };
  readonly replay: { current: PreviewPublicationSuccessor | null };
  readonly claimedEvents: WeakSet<object>;
  readonly claimedActions: WeakSet<object>;
}
interface PreviewPlacement {
  readonly document: Document;
  readonly parent: Node;
}
interface PreviewContainerSnapshot extends PreviewPlacement {
  readonly element: HTMLDivElement;
  readonly className: string;
}
interface PreviewVisitSuccessor {
  readonly source: EditorPreviewVisit;
  readonly snapshot: PreviewContainerSnapshot;
  readonly revision: number;
}
interface PreviewNodeSnapshot {
  readonly node: Node;
  readonly nodeValue: string | null;
  readonly attributes: readonly (readonly [string, string])[] | null;
  readonly children: readonly PreviewNodeSnapshot[];
}
interface PreviewDomSnapshot extends PreviewPlacement {
  readonly root: HTMLDivElement;
  readonly content: HTMLDivElement;
  readonly bar: HTMLDivElement | null;
  readonly back: HTMLButtonElement | null;
  readonly rootAttributes: readonly (readonly [string, string])[];
  readonly rootChildren: readonly Node[];
  readonly barSnapshot: PreviewNodeSnapshot | null;
  readonly backTargets: readonly Node[];
}
interface PreviewPublicationSuccessor {
  readonly source: PreviewPresentation;
  readonly authority: PreviewPresentationAuthority;
  readonly committed: PreviewDomSnapshot;
  readonly history: PreviewMutationHistory;
  readonly revision: number;
}
interface GitHubCompareRequest {
  readonly visit: EditorPreviewVisit;
  readonly document: DocumentDto;
  readonly documentId: string;
  readonly request: symbol;
}

type PreviewVisitPhase =
  | "mounting"
  | "active"
  | "layout-retired"
  | "ref-detached"
  | "replay-ready"
  | "successor-requested"
  | "dead";

type PreviewPresentationPhase =
  | "mounting"
  | "active"
  | "refs-detaching"
  | "refs-detached"
  | "refs-attaching"
  | "layout-retired"
  | "replay-ready"
  | "successor-requested"
  | "dead";

type PreviewElementName = "root" | "back";

function freezeVersionSummary(version: VersionSummary): Readonly<VersionSummary> {
  return Object.freeze({
    id: version.id,
    number: version.number,
    title: version.title,
    kind: version.kind,
    createdBy: version.createdBy,
    createdByName: version.createdByName,
    commitSha: version.commitSha,
    createdAt: version.createdAt,
    size: version.size,
  });
}

function versionSummaryMatches(version: VersionSummary, facts: Readonly<VersionSummary>) {
  return (
    version.id === facts.id &&
    version.number === facts.number &&
    version.title === facts.title &&
    version.kind === facts.kind &&
    version.createdBy === facts.createdBy &&
    version.createdByName === facts.createdByName &&
    version.commitSha === facts.commitSha &&
    version.createdAt === facts.createdAt &&
    version.size === facts.size
  );
}

function freezePreviewValue(preview: VersionPreview): PreviewValueFacts {
  const rangeVersions = preview.range ? Object.freeze([...preview.range]) : null;
  return Object.freeze({
    preview,
    version: preview.version,
    versionFacts: freezeVersionSummary(preview.version),
    content: preview.content,
    base: preview.base,
    baseVersion: preview.base?.version ?? null,
    baseVersionFacts: preview.base ? freezeVersionSummary(preview.base.version) : null,
    baseContent: preview.base?.content ?? null,
    range: preview.range,
    rangeVersions,
    rangeFacts: rangeVersions
      ? Object.freeze(rangeVersions.map(freezeVersionSummary))
      : null,
  });
}

function previewValueMatches(value: PreviewValueFacts) {
  const { preview } = value;
  if (
    preview !== value.preview ||
    preview.version !== value.version ||
    !versionSummaryMatches(preview.version, value.versionFacts) ||
    preview.content !== value.content ||
    preview.base !== value.base ||
    preview.range !== value.range
  ) {
    return false;
  }
  if (value.base) {
    if (
      value.base.version !== value.baseVersion ||
      !value.baseVersionFacts ||
      !versionSummaryMatches(value.base.version, value.baseVersionFacts) ||
      value.base.content !== value.baseContent
    ) {
      return false;
    }
  } else if (
    value.baseVersion !== null ||
    value.baseVersionFacts !== null ||
    value.baseContent !== null
  ) {
    return false;
  }
  if (!value.range || !value.rangeVersions || !value.rangeFacts) {
    return (
      value.range === undefined &&
      value.rangeVersions === null &&
      value.rangeFacts === null
    );
  }
  return (
    value.range.length === value.rangeVersions.length &&
    value.range.length === value.rangeFacts.length &&
    value.range.every((version, index) =>
      version === value.rangeVersions?.[index] &&
      Boolean(value.rangeFacts?.[index] &&
        versionSummaryMatches(version, value.rangeFacts[index]!)))
  );
}

function snapshotAttributes(node: Node): readonly (readonly [string, string])[] | null {
  if (node.nodeType !== 1) return null;
  return Object.freeze(
    [...(node as Element).attributes]
      .map(({ name, value }) => Object.freeze([name, value] as const))
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

function attributesMatch(
  element: Element,
  expected: readonly (readonly [string, string])[],
) {
  const current = snapshotAttributes(element);
  return Boolean(
    current &&
    current.length === expected.length &&
    current.every(([name, value], index) =>
      name === expected[index]?.[0] && value === expected[index]?.[1]),
  );
}

function snapshotPreviewNode(node: Node): PreviewNodeSnapshot {
  return Object.freeze({
    node,
    nodeValue: node.nodeValue,
    attributes: snapshotAttributes(node),
    children: Object.freeze([...node.childNodes].map(snapshotPreviewNode)),
  });
}

function previewNodeMatches(snapshot: PreviewNodeSnapshot): boolean {
  const { node } = snapshot;
  if (node.nodeValue !== snapshot.nodeValue) return false;
  const attributes = snapshotAttributes(node);
  if (attributes === null || snapshot.attributes === null) {
    if (attributes !== snapshot.attributes) return false;
  } else if (
    attributes.length !== snapshot.attributes.length ||
    attributes.some(([name, value], index) =>
      name !== snapshot.attributes?.[index]?.[0] ||
      value !== snapshot.attributes?.[index]?.[1])
  ) {
    return false;
  }
  return (
    node.childNodes.length === snapshot.children.length &&
    snapshot.children.every((child, index) =>
      node.childNodes.item(index) === child.node && previewNodeMatches(child))
  );
}

function descendantsOf(element: Element): readonly Node[] {
  const nodes: Node[] = [];
  const collect = (node: Node) => {
    nodes.push(node);
    for (const child of node.childNodes) collect(child);
  };
  collect(element);
  return Object.freeze(nodes);
}

function capturePreviewPlacement(element: HTMLElement): PreviewPlacement | null {
  const parent = element.parentNode;
  if (!parent) return null;
  return Object.freeze({
    document: element.ownerDocument,
    parent,
  });
}

function previewPlacementMatches(element: HTMLElement, placement: PreviewPlacement) {
  return (
    element.ownerDocument === placement.document &&
    element.parentNode === placement.parent
  );
}

class PreviewMutationHistory {
  private dirty = false;
  private readonly rootObserver: MutationObserver;
  private readonly placementObserver: MutationObserver;

  constructor(
    private readonly committed: PreviewDomSnapshot,
    private readonly onDirty: () => void,
  ) {
    const ownerWindow = committed.document.defaultView;
    if (!ownerWindow) throw new Error("The preview root has no owner window");
    this.rootObserver = new ownerWindow.MutationObserver((records) => {
      if (this.recordRoot(records)) this.onDirty();
    });
    this.placementObserver = new ownerWindow.MutationObserver((records) => {
      if (this.recordPlacement(records)) this.onDirty();
    });
    this.rootObserver.observe(committed.root, {
      attributes: true,
      characterData: true,
      childList: true,
      subtree: true,
    });
    this.placementObserver.observe(committed.parent, { childList: true });
  }

  private recordRoot(records: readonly MutationRecord[]) {
    const { root, bar } = this.committed;
    for (const record of records) {
      if (
        record.target === root ||
        (bar && (record.target === bar || bar.contains(record.target)))
      ) {
        this.dirty = true;
      }
    }
    return this.dirty;
  }

  private recordPlacement(records: readonly MutationRecord[]) {
    const root = this.committed.root;
    for (const record of records) {
      if (
        [...record.addedNodes, ...record.removedNodes].includes(root)
      ) {
        this.dirty = true;
      }
    }
    return this.dirty;
  }

  readonly isPristine = () => {
    this.recordRoot(this.rootObserver.takeRecords());
    this.recordPlacement(this.placementObserver.takeRecords());
    return !this.dirty;
  };

  readonly disconnect = () => {
    this.recordRoot(this.rootObserver.takeRecords());
    this.recordPlacement(this.placementObserver.takeRecords());
    this.rootObserver.disconnect();
    this.placementObserver.disconnect();
  };
}

function sameVisitFacts(left: EditorPreviewVisit, right: EditorPreviewVisit) {
  return (
    left.mount === right.mount &&
    left.editor === right.editor &&
    left.document === right.document &&
    left.documentId === right.documentId &&
    left.storage === right.storage &&
    left.gistId === right.gistId &&
    left.gistFile === right.gistFile &&
    left.repoOwner === right.repoOwner &&
    left.repoName === right.repoName &&
    left.repoBranch === right.repoBranch &&
    left.repoPath === right.repoPath &&
    left.githubUrl === right.githubUrl &&
    left.session === right.session &&
    left.actions === right.actions
  );
}

function createEditorPreviewVisit({
  revision,
  mount,
  editor,
  document,
  session,
  actions,
  cells,
  requestSuccessor,
  publishPreview,
  retireWork,
}: {
  revision: number;
  mount: symbol;
  editor: EditorIdentity;
  document: DocumentDto;
  session: CollabSession;
  actions: EditorActions;
  cells: PreviewVisitCells;
  requestSuccessor: () => void;
  publishPreview: (
    visit: EditorPreviewVisit,
    producer: PreviewProducer,
    source: PreviewSourceKind,
    preview: VersionPreview | null,
  ) => void;
  retireWork: (visit: EditorPreviewVisit) => void;
}): EditorPreviewVisit {
  const generation = Symbol("editor-preview-visit");
  const documentId = document.id;
  const storage = document.storage;
  const gistId = document.gistId;
  const gistFile = document.gistFile;
  const repoOwner = document.repoOwner;
  const repoName = document.repoName;
  const repoBranch = document.repoBranch;
  const repoPath = document.repoPath;
  const githubUrl = document.githubUrl;
  let phase: PreviewVisitPhase = "mounting";
  let container: HTMLDivElement | null = null;
  let committed: PreviewContainerSnapshot | null = null;
  let expiry = 0;

  const factsAreCurrent = () =>
    visit.generation === generation &&
    visit.revision === revision &&
    visit.mount === mount &&
    visit.editor === editor &&
    visit.document === document &&
    visit.documentId === documentId &&
    visit.storage === storage &&
    visit.gistId === gistId &&
    visit.gistFile === gistFile &&
    visit.repoOwner === repoOwner &&
    visit.repoName === repoName &&
    visit.repoBranch === repoBranch &&
    visit.repoPath === repoPath &&
    visit.githubUrl === githubUrl &&
    visit.session === session &&
    visit.actions === actions &&
    document.id === documentId &&
    document.storage === storage &&
    document.gistId === gistId &&
    document.gistFile === gistFile &&
    document.repoOwner === repoOwner &&
    document.repoName === repoName &&
    document.repoBranch === repoBranch &&
    document.repoPath === repoPath &&
    document.githubUrl === githubUrl &&
    editor.documentId === documentId &&
    editor.session === session &&
    session.docId === documentId &&
    visit.versionsProducer === versionsProducer &&
    visit.githubProducer === githubProducer;

  const exactContainer = (snapshot: PreviewContainerSnapshot | null) =>
    Boolean(
      container &&
      container.isConnected &&
      container.tagName === "DIV" &&
      container.getAttribute("class") === PANES_BOX &&
      container.ownerDocument.defaultView &&
      container.parentNode &&
      (!snapshot ||
        (container === snapshot.element &&
          container.getAttribute("class") === snapshot.className &&
          previewPlacementMatches(container, snapshot))),
    );

  const clearActive = () => {
    cells.retired.add(visit);
    if (cells.active.current === visit) {
      cells.active.current = null;
      cells.active.revision++;
      retireWork(visit);
    }
  };

  const releaseReplay = () => {
    if (cells.replay.current?.source === visit) cells.replay.current = null;
  };

  const invalidate = () => {
    expiry++;
    phase = "dead";
    releaseReplay();
    clearActive();
  };

  const captureContainer = (element: HTMLDivElement | null) => {
    if (container === element || phase === "dead" || phase === "successor-requested") return;
    const previous = container;
    container = element;
    if (phase === "mounting") {
      if (previous !== null || element === null) invalidate();
      return;
    }
    if (phase === "active" || phase === "replay-ready") {
      invalidate();
      return;
    }
    if (phase === "layout-retired") {
      if (!committed || previous !== committed.element || element !== null) {
        invalidate();
        return;
      }
      phase = "ref-detached";
      return;
    }
    if (
      phase !== "ref-detached" ||
      previous !== null ||
      !committed ||
      element !== committed.element
    ) {
      invalidate();
      return;
    }
    phase = "replay-ready";
  };

  function versionsProducer(preview: VersionPreview | null) {
    publishPreview(visit, versionsProducer, "versions", preview);
  }

  function githubProducer(preview: VersionPreview | null) {
    if (preview) publishPreview(visit, githubProducer, "github-compare", preview);
  }

  const activate = (snapshot: PreviewContainerSnapshot) => {
    const previous = cells.active.current;
    if (previous && previous !== visit) previous.retire();
    if (cells.active.current) {
      invalidate();
      return;
    }
    committed = snapshot;
    cells.active.current = visit;
    cells.active.revision++;
    phase = "active";
  };

  const establishInitial = () => {
    let successor = cells.replay.current;
    if (successor && !sameVisitFacts(successor.source, visit)) {
      cells.replay.current = null;
      successor = null;
    }
    if (
      successor &&
      (cells.active.current !== null ||
        cells.active.revision !== successor.revision ||
        !exactContainer(successor.snapshot))
    ) {
      cells.replay.current = null;
      invalidate();
      return;
    }
    if (!factsAreCurrent() || !exactContainer(null) || !container) {
      invalidate();
      return;
    }
    const placement = capturePreviewPlacement(container);
    if (!placement) {
      invalidate();
      return;
    }
    const snapshot = Object.freeze({
      element: container,
      className: PANES_BOX,
      ...placement,
    });
    if (
      Boolean(successor && !exactContainer(successor.snapshot)) ||
      !factsAreCurrent() ||
      !exactContainer(snapshot)
    ) {
      cells.replay.current = null;
      invalidate();
      return;
    }
    cells.replay.current = null;
    activate(snapshot);
  };

  const establishReplay = () => {
    if (
      phase !== "replay-ready" ||
      !committed ||
      cells.active.current !== null ||
      !factsAreCurrent() ||
      !exactContainer(committed)
    ) {
      invalidate();
      return;
    }
    cells.replay.current = Object.freeze({
      source: visit,
      snapshot: committed,
      revision: cells.active.revision,
    });
    phase = "successor-requested";
    const ticket = ++expiry;
    requestSuccessor();
    queueMicrotask(() => {
      if (expiry === ticket && cells.replay.current?.source === visit) invalidate();
    });
  };

  const establish = () => {
    if (phase === "mounting") establishInitial();
    else if (phase === "replay-ready") establishReplay();
    else invalidate();
  };

  const retire = () => {
    if (phase === "successor-requested") return false;
    if (
      phase !== "active" ||
      !committed ||
      cells.active.current !== visit ||
      !exactContainer(committed)
    ) {
      invalidate();
      return false;
    }
    clearActive();
    phase = "layout-retired";
    const ticket = ++expiry;
    queueMicrotask(() => {
      if (
        expiry === ticket &&
        (phase === "layout-retired" ||
          phase === "ref-detached" ||
          phase === "replay-ready")
      ) {
        invalidate();
      }
    });
    return true;
  };

  const owns = () =>
    phase === "active" &&
    cells.active.current === visit &&
    !cells.retired.has(visit) &&
    factsAreCurrent() &&
    exactContainer(null);

  const visit: EditorPreviewVisit = Object.freeze({
    generation,
    revision,
    mount,
    editor,
    document,
    documentId,
    storage,
    gistId,
    gistFile,
    repoOwner,
    repoName,
    repoBranch,
    repoPath,
    githubUrl,
    session,
    actions,
    versionsProducer,
    githubProducer,
    captureContainer,
    establish,
    retire,
    owns,
    container: () => container,
  });
  return visit;
}

function samePreviewAuthorityFacts(
  left: PreviewPresentationAuthority,
  right: PreviewPresentationAuthority,
) {
  return (
    left.mount === right.mount &&
    left.selection === right.selection &&
    left.rootClass === right.rootClass &&
    left.barClass === right.barClass &&
    left.backClass === right.backClass &&
    left.message === right.message
  );
}

class PreviewElementOwner<T extends HTMLElement> {
  private current: T | null = null;

  constructor(
    private readonly name: PreviewElementName,
    private readonly onChange: (
      name: PreviewElementName,
      previous: T | null,
      current: T | null,
    ) => void,
  ) {}

  readonly element = () => this.current;
  readonly capture = (element: T | null) => {
    if (this.current === element) return;
    const previous = this.current;
    this.current = element;
    this.onChange(this.name, previous, element);
  };
}

function createPreviewPresentation({
  authority,
  cells,
  selectionCurrent,
  requestSuccessor,
  clearSelection,
}: {
  authority: PreviewPresentationAuthority;
  cells: PreviewPublicationCells;
  selectionCurrent: () => PreviewSelection | null;
  requestSuccessor: () => void;
  clearSelection: (selection: PreviewSelection) => void;
}): PreviewPresentation {
  const {
    generation,
    revision,
    mount,
    selection,
    rootClass,
    barClass,
    backClass,
    message,
  } = authority;
  const expectedRefs: readonly PreviewElementName[] =
    selection.source === "github-compare"
      ? ["root", "back"]
      : ["root"];
  let phase: PreviewPresentationPhase = "mounting";
  let grant: PreviewGrant | null = null;
  let history: PreviewMutationHistory | null = null;
  let replay: {
    readonly committed: PreviewDomSnapshot;
    readonly revision: number;
    readonly detached: Set<PreviewElementName>;
    readonly attached: Set<PreviewElementName>;
  } | null = null;
  let replayIncludesLayout = false;
  let expiry = 0;
  const initialRefs = new Set<PreviewElementName>();

  const refsComplete = (refs: ReadonlySet<PreviewElementName>) =>
    expectedRefs.every((name) => refs.has(name));

  const releaseOwnedSuccessor = () => {
    const pending = cells.replay.current;
    if (!pending || pending.source !== presentation) return;
    pending.history.disconnect();
    cells.replay.current = null;
  };

  const clearGrant = (current: PreviewGrant) => {
    current.retired = true;
    if (cells.active.current === current) {
      cells.active.current = null;
      cells.active.revision++;
    }
    if (grant === current) grant = null;
  };

  const invalidate = () => {
    expiry++;
    phase = "dead";
    replay = null;
    releaseOwnedSuccessor();
    const currentHistory = history;
    history = null;
    currentHistory?.disconnect();
    if (grant) clearGrant(grant);
  };

  const elementOf = (snapshot: PreviewDomSnapshot, name: PreviewElementName) => {
    if (name === "root") return snapshot.root;
    return snapshot.back;
  };

  const onElementChange = (
    name: PreviewElementName,
    previous: HTMLElement | null,
    element: HTMLElement | null,
  ) => {
    if (phase === "dead") return;
    if (history && !history.isPristine()) {
      invalidate();
      return;
    }
    if (phase === "successor-requested") return;
    if (phase === "mounting") {
      if (previous !== null || element === null || initialRefs.has(name)) {
        invalidate();
        return;
      }
      initialRefs.add(name);
      return;
    }
    if (phase === "active") {
      const current = grant;
      if (
        !current ||
        current.retired ||
        cells.active.current !== current ||
        previous !== elementOf(current.committed, name) ||
        element !== null ||
        !history ||
        !history.isPristine() ||
        !liveFactsMatch() ||
        !exactDomIsCurrent(current.committed, false)
      ) {
        invalidate();
        return;
      }
      clearGrant(current);
      replay = {
        committed: current.committed,
        revision: cells.active.revision,
        detached: new Set<PreviewElementName>([name]),
        attached: new Set<PreviewElementName>(),
      };
      replayIncludesLayout = false;
      phase = refsComplete(replay.detached) ? "refs-detached" : "refs-detaching";
      const ticket = ++expiry;
      queueMicrotask(() => {
        if (
          expiry === ticket &&
          (phase === "refs-detaching" ||
            phase === "refs-detached" ||
            phase === "refs-attaching" ||
            phase === "layout-retired" ||
            phase === "replay-ready")
        ) {
          invalidate();
        }
      });
      return;
    }
    if (phase === "replay-ready") {
      invalidate();
      return;
    }
    if (!replay) {
      invalidate();
      return;
    }
    const expected = elementOf(replay.committed, name);
    if (!expected) {
      invalidate();
      return;
    }
    if (phase === "refs-detaching") {
      if (
        previous !== expected ||
        element !== null ||
        replay.detached.has(name) ||
        replay.attached.size > 0
      ) {
        invalidate();
        return;
      }
      replay.detached.add(name);
      if (refsComplete(replay.detached)) phase = "refs-detached";
      return;
    }
    if (
      (phase !== "refs-detached" &&
        phase !== "refs-attaching" &&
        phase !== "layout-retired") ||
      previous !== null ||
      element !== expected ||
      !replay.detached.has(name) ||
      replay.attached.has(name)
    ) {
      invalidate();
      return;
    }
    replay.attached.add(name);
    if (!refsComplete(replay.attached)) {
      phase = "refs-attaching";
      return;
    }
    phase = "replay-ready";
    if (!replayIncludesLayout) establishReplay();
  };

  const rootOwner = new PreviewElementOwner<HTMLDivElement>("root", onElementChange);
  const backOwner = new PreviewElementOwner<HTMLButtonElement>("back", onElementChange);

  const authorityMatches = () =>
    authority.generation === generation &&
    authority.revision === revision &&
    authority.mount === mount &&
    authority.selection === selection &&
    authority.rootClass === rootClass &&
    authority.barClass === barClass &&
    authority.backClass === backClass &&
    authority.message === message &&
    presentation.authority === authority;

  const liveFactsMatch = () => {
    const expectedProducer =
      selection.source === "versions"
        ? selection.visit.versionsProducer
        : selection.visit.githubProducer;
    return (
      authorityMatches() &&
      selectionCurrent() === selection &&
      selection.visit.mount === mount &&
      selection.visit.owns() &&
      selection.producer === expectedProducer &&
      previewValueMatches(selection.value)
    );
  };

  const currentElements = () => {
    const root = rootOwner.element();
    const back = backOwner.element();
    if (
      !root ||
      (selection.source === "github-compare" ? !back : back !== null)
    ) {
      return null;
    }
    return { root, back };
  };

  const exactDomIsCurrent = (
    snapshot: PreviewDomSnapshot | null,
    requireCapturedRefs = true,
  ) => {
    const elements = snapshot
      ? { root: snapshot.root, back: snapshot.back }
      : currentElements();
    const container = selection.visit.container();
    if (!elements || !container) return false;
    const { root, back } = elements;
    const ownerDocument = root.ownerDocument;
    const ownerWindow = ownerDocument.defaultView;
    const content = root.children.item(root.children.length - 1);
    const bar = selection.source === "github-compare"
      ? root.children.item(0)
      : null;
    const messageElement = bar?.children.item(0);
    if (
      !ownerWindow ||
      !root.isConnected ||
      root.parentElement !== container ||
      root.tagName !== "DIV" ||
      root.getAttribute("class") !== rootClass ||
      (requireCapturedRefs &&
        (rootOwner.element() !== root || backOwner.element() !== back)) ||
      !(content instanceof ownerWindow.HTMLDivElement) ||
      content.ownerDocument !== ownerDocument ||
      !content.isConnected ||
      content.tagName !== "DIV" ||
      content.parentElement !== root ||
      root.children.item(root.children.length - 1) !== content ||
      (selection.source === "versions"
        ? root.children.length !== 1 ||
          root.childNodes.length !== 1 ||
          root.children.item(0) !== content ||
          root.querySelector("[data-testid='sync-compare-bar']") !== null
        : !(bar instanceof ownerWindow.HTMLDivElement) ||
          bar.ownerDocument !== ownerDocument ||
          !bar.isConnected ||
          bar.parentElement !== root ||
          bar.getAttribute("class") !== barClass ||
          bar.getAttribute("data-testid") !== "sync-compare-bar" ||
          root.children.length !== 2 ||
          root.childNodes.length !== 2 ||
          bar.children.length !== 2 ||
          bar.childNodes.length !== 2 ||
          !(messageElement instanceof ownerWindow.HTMLSpanElement) ||
          messageElement.parentElement !== bar ||
          messageElement.textContent !== message ||
          !(back instanceof ownerWindow.HTMLButtonElement) ||
          back.ownerDocument !== ownerDocument ||
          !back.isConnected ||
          back.parentElement !== bar ||
          bar.children.item(1) !== back ||
          back.tagName !== "BUTTON" ||
          back.getAttribute("type") !== "button" ||
          back.type !== "button" ||
          back.disabled ||
          back.matches(":disabled") ||
          back.getAttribute("class") !== backClass ||
          back.getAttribute("data-testid") !== "sync-compare-close" ||
          back.children.length !== 0 ||
          back.childNodes.length !== 1 ||
          back.textContent !== "Back to editing")
    ) {
      return false;
    }
    if (!snapshot) return true;
    return (
      snapshot.root === root &&
      snapshot.content === content &&
      snapshot.bar === bar &&
      snapshot.back === back &&
      attributesMatch(root, snapshot.rootAttributes) &&
      root.childNodes.length === snapshot.rootChildren.length &&
      snapshot.rootChildren.every((node, index) =>
        root.childNodes.item(index) === node) &&
      (snapshot.barSnapshot
        ? previewNodeMatches(snapshot.barSnapshot)
        : bar === null) &&
      previewPlacementMatches(root, snapshot)
    );
  };

  const snapshotDom = (): PreviewDomSnapshot | null => {
    const elements = currentElements();
    if (!elements) return null;
    const { root, back } = elements;
    const content = root.children.item(root.children.length - 1);
    const ownerWindow = root.ownerDocument.defaultView;
    const placement = capturePreviewPlacement(root);
    const rootAttributes = snapshotAttributes(root);
    const bar = selection.source === "github-compare"
      ? root.children.item(0)
      : null;
    if (
      !ownerWindow ||
      !placement ||
      !(content instanceof ownerWindow.HTMLDivElement) ||
      !rootAttributes ||
      (bar !== null && !(bar instanceof ownerWindow.HTMLDivElement))
    ) {
      return null;
    }
    return Object.freeze({
      root,
      content,
      bar: bar as HTMLDivElement | null,
      back,
      rootAttributes,
      rootChildren: Object.freeze([...root.childNodes]),
      barSnapshot: bar ? snapshotPreviewNode(bar) : null,
      backTargets: back ? descendantsOf(back) : Object.freeze([]),
      ...placement,
    });
  };

  const activate = (
    committed: PreviewDomSnapshot,
    currentHistory: PreviewMutationHistory,
  ) => {
    const current: PreviewGrant = {
      generation: Symbol("preview-publication"),
      publication: presentation,
      committed,
      actionClaimed: false,
      retired: false,
      retire: () => {
        if (current.retired) return;
        if (grant === current) invalidate();
        else current.retired = true;
      },
    };
    const previous = cells.active.current;
    previous?.retire();
    if (cells.active.current) {
      currentHistory.disconnect();
      current.retired = true;
      invalidate();
      return;
    }
    history = currentHistory;
    grant = current;
    cells.active.current = current;
    cells.active.revision++;
    phase = "active";
  };

  const establishInitial = () => {
    let successor = cells.replay.current;
    if (successor && !samePreviewAuthorityFacts(successor.authority, authority)) {
      successor.history.disconnect();
      cells.replay.current = null;
      successor = null;
    }
    if (
      successor &&
      (cells.active.current !== null ||
        cells.active.revision !== successor.revision ||
        !successor.history.isPristine() ||
        !exactDomIsCurrent(successor.committed))
    ) {
      successor.history.disconnect();
      cells.replay.current = null;
      invalidate();
      return;
    }
    if (
      !refsComplete(initialRefs) ||
      !liveFactsMatch() ||
      !exactDomIsCurrent(null)
    ) {
      invalidate();
      return;
    }
    const committed = snapshotDom();
    if (!committed) {
      invalidate();
      return;
    }
    const currentHistory = new PreviewMutationHistory(committed, () => {
      if (history === currentHistory && phase === "active") invalidate();
    });
    if (
      !currentHistory.isPristine() ||
      Boolean(successor && !successor.history.isPristine()) ||
      Boolean(successor && !exactDomIsCurrent(successor.committed)) ||
      !liveFactsMatch() ||
      !exactDomIsCurrent(committed)
    ) {
      currentHistory.disconnect();
      successor?.history.disconnect();
      cells.replay.current = null;
      invalidate();
      return;
    }
    successor?.history.disconnect();
    cells.replay.current = null;
    if (
      !currentHistory.isPristine() ||
      !liveFactsMatch() ||
      !exactDomIsCurrent(committed)
    ) {
      currentHistory.disconnect();
      invalidate();
      return;
    }
    activate(committed, currentHistory);
  };

  function establishReplay() {
    const candidate = replay;
    const previousHistory = history;
    if (
      !candidate ||
      !previousHistory ||
      phase !== "replay-ready" ||
      cells.active.current !== null ||
      cells.active.revision !== candidate.revision ||
      !previousHistory.isPristine() ||
      !exactDomIsCurrent(candidate.committed) ||
      !liveFactsMatch() ||
      cells.replay.current
    ) {
      invalidate();
      return;
    }
    if (
      !previousHistory.isPristine() ||
      !exactDomIsCurrent(candidate.committed) ||
      !liveFactsMatch() ||
      cells.active.current !== null ||
      cells.active.revision !== candidate.revision ||
      cells.replay.current
    ) {
      invalidate();
      return;
    }
    cells.replay.current = Object.freeze({
      source: presentation,
      authority,
      committed: candidate.committed,
      history: previousHistory,
      revision: candidate.revision,
    });
    history = null;
    replay = null;
    phase = "successor-requested";
    const ticket = ++expiry;
    requestSuccessor();
    queueMicrotask(() => {
      if (
        expiry === ticket &&
        cells.replay.current?.source === presentation
      ) {
        invalidate();
      }
    });
  }

  const establish = () => {
    if (phase === "mounting") establishInitial();
    else if (phase === "replay-ready") establishReplay();
    else invalidate();
  };

  const retireLayout = () => {
    if (phase === "successor-requested") return false;
    if (
      phase !== "refs-detached" ||
      !replay ||
      !history ||
      cells.active.current !== null ||
      cells.active.revision !== replay.revision ||
      !history.isPristine() ||
      !liveFactsMatch() ||
      !exactDomIsCurrent(replay.committed, false)
    ) {
      invalidate();
      return false;
    }
    replayIncludesLayout = true;
    phase = "layout-retired";
    return true;
  };

  const activateBack = (event: React.MouseEvent<HTMLButtonElement>) => {
    const current = grant;
    if (
      !current ||
      current.retired ||
      cells.active.current !== current ||
      phase !== "active" ||
      current.actionClaimed ||
      selection.source !== "github-compare" ||
      !event ||
      typeof event !== "object"
    ) {
      return;
    }
    const { committed } = current;
    const back = committed.back;
    if (!back) return;
    const ownerDocument = back.ownerDocument;
    const ownerWindow = ownerDocument.defaultView;
    const nativeEvent = event.nativeEvent;
    const target = event.target;
    if (
      !ownerWindow ||
      event.type !== "click" ||
      event.button !== 0 ||
      event.currentTarget !== back ||
      !(nativeEvent instanceof ownerWindow.MouseEvent) ||
      nativeEvent.type !== "click" ||
      nativeEvent.button !== 0 ||
      nativeEvent.target !== target ||
      !(target instanceof ownerWindow.Node) ||
      target.ownerDocument !== ownerDocument ||
      !committed.backTargets.includes(target) ||
      event.defaultPrevented ||
      nativeEvent.defaultPrevented ||
      cells.claimedEvents.has(event) ||
      cells.claimedEvents.has(nativeEvent)
    ) {
      return;
    }
    current.actionClaimed = true;
    cells.claimedEvents.add(event);
    cells.claimedEvents.add(nativeEvent);
    if (
      !history ||
      !history.isPristine() ||
      !liveFactsMatch() ||
      !exactDomIsCurrent(committed) ||
      current.retired ||
      cells.active.current !== current
    ) {
      invalidate();
      return;
    }
    invalidate();
    clearSelection(selection);
  };

  const presentation: PreviewPresentation = Object.freeze({
    authority,
    captureRoot: rootOwner.capture,
    captureBack: backOwner.capture,
    establish,
    retireLayout,
    retire: invalidate,
    activateBack,
  });
  return presentation;
}

const publishPullBusyError = () => new Error("Another publish or pull is already in progress.");

type SidePanel = "comments" | "versions" | "activity" | null;

const noopSubscribe = () => () => {};

interface CollaboratorFollowVisitOptions {
  session: CollabSession;
  actions: EditorActions;
  richView: Pick<PMView, "dom"> | null;
  codeView: Pick<CMView, "scrollDOM" | "contentDOM"> | null;
  richScroller: HTMLElement | null;
  showCode: boolean;
  showRich: boolean;
  syncScroll: boolean;
  userId: string | null;
  cursor: number | null;
}

interface CollaboratorFollowTimer {
  readonly handle: ReturnType<typeof setTimeout>;
  fired: boolean;
}

interface CollaboratorFollowVisit extends CollaboratorFollowVisitOptions {
  active: boolean;
  retired: boolean;
  timer: CollaboratorFollowTimer | null;
  readonly scrollers: readonly HTMLElement[];
  readonly editors: readonly HTMLElement[];
  readonly onWheel: (event: WheelEvent) => void;
  readonly onTouchMove: (event: TouchEvent) => void;
  readonly onBeforeInput: (event: InputEvent) => void;
  readonly onKeyDown: (event: KeyboardEvent) => void;
}

/**
 * Owns collaborator-follow scrolling and stop gestures as one layout-timed visit. Exported for the
 * deterministic lifecycle harness; the editor shell is its only production caller.
 */
export function useCollaboratorFollowVisit(options: CollaboratorFollowVisitOptions) {
  const currentRef = useRef<CollaboratorFollowVisit | null>(null);
  const { session, actions, richView, codeView, richScroller, showCode, showRich, syncScroll, userId, cursor } = options;

  useLayoutEffect(() => {
    if (!userId) return;

    const scrollers = Array.from(
      new Set<HTMLElement>(
        [richScroller, codeView?.scrollDOM].filter((element): element is HTMLElement => !!element),
      ),
    );
    const editors = Array.from(
      new Set<HTMLElement>(
        [richView?.dom, codeView?.contentDOM].filter((element): element is HTMLElement => !!element),
      ),
    );
    const ownsVisit = () => visit.active && !visit.retired && currentRef.current === visit;
    const stop = (type: "user-scroll" | "typing") => {
      if (ownsVisit()) session.dispatchFollow({ type });
    };
    const visit: CollaboratorFollowVisit = {
      session,
      actions,
      richView,
      codeView,
      richScroller,
      showCode,
      showRich,
      syncScroll,
      userId,
      cursor,
      active: true,
      retired: false,
      timer: null,
      scrollers,
      editors,
      onWheel: () => stop("user-scroll"),
      onTouchMove: () => stop("user-scroll"),
      onBeforeInput: () => stop("typing"),
      onKeyDown: (event) => {
        if (event.key === "Escape" && ownsVisit()) session.dispatchFollow({ type: "stop" });
      },
    };
    currentRef.current = visit;

    if (cursor !== null) {
      const intent = {
        offset: cursor,
        code: showCode,
        rich: showRich,
        synced: syncScroll && showCode && showRich,
      };
      const run = (timer: CollaboratorFollowTimer) => {
        if (!ownsVisit() || visit.timer !== timer || timer.fired) return;
        timer.fired = true;
        visit.timer = null;
        actions.scrollToSource(intent.offset, {
          code: intent.code,
          rich: intent.rich,
          synced: intent.synced,
        });
      };
      const timer: CollaboratorFollowTimer = {
        handle: setTimeout(() => run(timer), 150),
        fired: false,
      };
      visit.timer = timer;
    }

    for (const element of scrollers) {
      element.addEventListener("wheel", visit.onWheel, { passive: true });
      element.addEventListener("touchmove", visit.onTouchMove, { passive: true });
    }
    for (const element of editors) element.addEventListener("beforeinput", visit.onBeforeInput, true);
    window.addEventListener("keydown", visit.onKeyDown, true);

    return () => {
      if (visit.retired) return;
      visit.active = false;
      visit.retired = true;
      const ownsRef = currentRef.current === visit;
      if (ownsRef) currentRef.current = null;
      const timer = visit.timer;
      if (ownsRef && timer && visit.timer === timer) {
        visit.timer = null;
        clearTimeout(timer.handle);
      }
      for (const element of visit.scrollers) {
        element.removeEventListener("wheel", visit.onWheel);
        element.removeEventListener("touchmove", visit.onTouchMove);
      }
      for (const element of visit.editors) element.removeEventListener("beforeinput", visit.onBeforeInput, true);
      window.removeEventListener("keydown", visit.onKeyDown, true);
    };
  }, [session, actions, richView, codeView, richScroller, showCode, showRich, syncScroll, userId, cursor]);
}

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
  const editorIdentity = useMemo<EditorIdentity>(
    () => ({ documentId: initialDoc.id, session }),
    [initialDoc.id, session],
  );
  const [toastMount] = useState(() => Symbol("editor-toasts"));
  const toastAuthority = useMemo<ToastAuthority>(
    () => Object.freeze({ mount: toastMount, editor: editorIdentity, userId: user.id, role }),
    [editorIdentity, role, toastMount, user.id],
  );
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
  const [publishingOwner, setPublishingOwner] = useState<PublishPullOwner | null>(null);
  const [documentMutationOwner, setDocumentMutationOwner] = useState<DocumentMutationOwner | null>(null);
  const [nameVersionVisit, setNameVersionVisit] = useState<NameVersionVisit | null>(null);
  const currentEditorRef = useRef<EditorIdentity | null>(null);
  const publishPullOwnerRef = useRef<PublishPullOwner | null>(null);
  const documentMutationOwnerRef = useRef<DocumentMutationOwner | null>(null);
  const documentMutationSequence = useRef(0);
  const leavingEditorRef = useRef<EditorIdentity | null>(null);
  const currentNameVersionVisitRef = useRef<NameVersionVisit | null>(null);
  const namedVersionOwnerRef = useRef<NameVersionSaveOwner | null>(null);
  const nameVersionVisitSequence = useRef(0);
  const namedVersionOperationSequence = useRef(0);
  const [sync, setSync] = useState<SyncStatusDto | null>(null);
  const [syncOpen, setSyncOpen] = useState(false);
  const [syncTick, setSyncTick] = useState(0);
  const toastAuthorityRef = useRef<ToastAuthority | null>(null);
  const pendingNoticeConsumedRef = useRef<ToastAuthority | null>(null);
  const toastPublicationsRef = useRef<readonly ToastPublication[]>([]);
  const toastTimersRef = useRef<Set<ToastPublication>>(new Set());
  const toastRenderKeysRef = useRef<WeakMap<ToastPublication, string>>(new WeakMap());
  const toastRenderKeySequence = useRef(0);
  const [toastPublications, setToastPublications] = useState<readonly ToastPublication[]>([]);
  const [previewMount] = useState(() => Symbol("editor-previews"));
  const [previewVisitCells] = useState<PreviewVisitCells>(() => ({
    active: { current: null, revision: 0 },
    replay: { current: null },
    retired: new WeakSet<EditorPreviewVisit>(),
  }));
  const [previewPublicationCells] = useState<PreviewPublicationCells>(() => ({
    active: { current: null, revision: 0 },
    replay: { current: null },
    claimedEvents: new WeakSet<object>(),
    claimedActions: new WeakSet<object>(),
  }));
  const previewValueClaimsRef = useRef(new WeakMap<EditorPreviewVisit, WeakSet<VersionPreview>>());
  const previewSelectionRef = useRef<PreviewSelection | null>(null);
  const githubCompareRequestsRef = useRef<Set<GitHubCompareRequest>>(new Set());
  const [previewSelection, setPreviewSelection] = useState<PreviewSelection | null>(null);
  const [previewVisitRevision, setPreviewVisitRevision] = useState(0);
  const [previewPresentationRevision, setPreviewPresentationRevision] = useState(0);
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
  const ownsPreviewVisit = useCallback((visit: EditorPreviewVisit) => visit.owns(), []);
  const clearPreviewSelection = useCallback((selection: PreviewSelection) => {
    if (previewSelectionRef.current !== selection) return;
    const grant = previewPublicationCells.active.current;
    if (grant?.publication.authority.selection === selection) grant.retire();
    previewSelectionRef.current = null;
    setPreviewSelection((current) => current === selection ? null : current);
  }, [previewPublicationCells]);
  const publishPreview = useCallback(
    (
      visit: EditorPreviewVisit,
      producer: PreviewProducer,
      source: PreviewSourceKind,
      preview: VersionPreview | null,
    ) => {
      const exactProducer =
        source === "versions"
          ? visit.versionsProducer === producer
          : visit.githubProducer === producer;
      if (!exactProducer || !visit.owns()) return;
      if (!preview) {
        const selection = previewSelectionRef.current;
        if (
          !selection ||
          selection.visit !== visit ||
          selection.producer !== producer ||
          selection.source !== source ||
          !previewValueMatches(selection.value) ||
          previewPublicationCells.claimedActions.has(selection)
        ) {
          return;
        }
        previewPublicationCells.claimedActions.add(selection);
        clearPreviewSelection(selection);
        return;
      }
      let claimedValues = previewValueClaimsRef.current.get(visit);
      if (!claimedValues) {
        claimedValues = new WeakSet<VersionPreview>();
        previewValueClaimsRef.current.set(visit, claimedValues);
      }
      if (claimedValues.has(preview)) return;
      claimedValues.add(preview);
      const selection: PreviewSelection = Object.freeze({
        action: Symbol("preview-producer-action"),
        visit,
        producer,
        source,
        value: freezePreviewValue(preview),
      });
      previewPublicationCells.active.current?.retire();
      previewSelectionRef.current = selection;
      setPreviewSelection(selection);
    },
    [clearPreviewSelection, previewPublicationCells],
  );
  const retirePreviewVisitWork = useCallback((visit: EditorPreviewVisit) => {
    for (const request of githubCompareRequestsRef.current) {
      if (request.visit === visit) githubCompareRequestsRef.current.delete(request);
    }
    const selection = previewSelectionRef.current;
    if (selection?.visit === visit) clearPreviewSelection(selection);
  }, [clearPreviewSelection]);
  const requestPreviewVisitSuccessor = useCallback(() => {
    setPreviewVisitRevision((revision) => revision + 1);
  }, []);
  const requestPreviewPresentationSuccessor = useCallback(() => {
    setPreviewPresentationRevision((revision) => revision + 1);
  }, []);
  const dismissToast = useCallback((publication: ToastPublication, timerFired = false) => {
    if (
      toastAuthorityRef.current !== publication.authority ||
      !toastPublicationsRef.current.includes(publication)
    ) {
      return false;
    }
    toastPublicationsRef.current = toastPublicationsRef.current.filter((current) => current !== publication);
    const timerPending = toastTimersRef.current.delete(publication);
    if (timerPending && !timerFired) clearTimeout(publication.timer);
    setToastPublications((current) => current.filter((candidate) => candidate !== publication));
    return true;
  }, []);
  const retireToastAuthority = useCallback((authority: ToastAuthority) => {
    const retiring = toastPublicationsRef.current.filter((publication) => publication.authority === authority);
    if (retiring.length === 0) return;
    const retiringSet = new Set(retiring);
    toastPublicationsRef.current = toastPublicationsRef.current.filter((publication) => !retiringSet.has(publication));
    for (const publication of retiring) {
      if (toastTimersRef.current.delete(publication)) clearTimeout(publication.timer);
    }
    setToastPublications((current) => current.filter((publication) => publication.authority !== authority));
  }, []);
  const toastRenderKey = useCallback((publication: ToastPublication) => {
    const existing = toastRenderKeysRef.current.get(publication);
    if (existing) return existing;
    const key = `toast-${++toastRenderKeySequence.current}`;
    toastRenderKeysRef.current.set(publication, key);
    return key;
  }, []);
  useLayoutEffect(() => {
    currentEditorRef.current = editorIdentity;
    publishPullOwnerRef.current = null;
    setPublishingOwner(null);
    documentMutationOwnerRef.current = null;
    setDocumentMutationOwner(null);
    const previousVisit = currentNameVersionVisitRef.current;
    if (previousVisit && previousVisit.editor !== editorIdentity) {
      const replacement = {
        id: ++nameVersionVisitSequence.current,
        editor: editorIdentity,
        documentId: editorIdentity.documentId,
      };
      namedVersionOwnerRef.current = null;
      currentNameVersionVisitRef.current = replacement;
      setNameVersionVisit(replacement);
    }
    return () => {
      if (currentEditorRef.current === editorIdentity) currentEditorRef.current = null;
      if (publishPullOwnerRef.current?.editor === editorIdentity) publishPullOwnerRef.current = null;
      if (documentMutationOwnerRef.current?.editor === editorIdentity) documentMutationOwnerRef.current = null;
      if (leavingEditorRef.current === editorIdentity) leavingEditorRef.current = null;
    };
  }, [editorIdentity]);
  useLayoutEffect(() => {
    toastAuthorityRef.current = toastAuthority;
    setToastPublications((current) =>
      current.filter(
        (publication) =>
          publication.authority === toastAuthority &&
          toastPublicationsRef.current.includes(publication),
      ),
    );
    return () => {
      if (toastAuthorityRef.current === toastAuthority) toastAuthorityRef.current = null;
      retireToastAuthority(toastAuthority);
    };
  }, [retireToastAuthority, toastAuthority]);
  useLayoutEffect(() => () => {
    currentNameVersionVisitRef.current = null;
    namedVersionOwnerRef.current = null;
  }, []);
  useLayoutEffect(() => {
    setDoc((current) => current.id === initialDoc.id ? current : initialDoc);
  }, [initialDoc]);
  const publishing = publishingOwner !== null && currentEditorRef.current === publishingOwner.editor;
  const documentMutation =
    documentMutationOwner !== null &&
    currentEditorRef.current === documentMutationOwner.editor &&
    documentMutationOwnerRef.current === documentMutationOwner
      ? documentMutationOwner.action
      : null;
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

  const openNameVersion = useCallback(() => {
    const editor = currentEditorRef.current;
    if (!editor) return;
    const visit = {
      id: ++nameVersionVisitSequence.current,
      editor,
      documentId: editor.documentId,
    };
    namedVersionOwnerRef.current = null;
    currentNameVersionVisitRef.current = visit;
    setNameVersionVisit(visit);
    setDialog("versionName");
  }, []);
  const setEditorDialog = useCallback((kind: DialogKind) => {
    if (kind === "versionName") openNameVersion();
    else setDialog(kind);
  }, [openNameVersion]);
  const actions = useMemo(() => new EditorActions(session, setEditorDialog), [session, setEditorDialog]);
  const previewVisit = useMemo(
    () =>
      createEditorPreviewVisit({
        revision: previewVisitRevision,
        mount: previewMount,
        editor: editorIdentity,
        document: initialDoc,
        session,
        actions,
        cells: previewVisitCells,
        requestSuccessor: requestPreviewVisitSuccessor,
        publishPreview,
        retireWork: retirePreviewVisitWork,
      }),
    [
      actions,
      editorIdentity,
      initialDoc,
      previewMount,
      previewVisitCells,
      previewVisitRevision,
      publishPreview,
      requestPreviewVisitSuccessor,
      retirePreviewVisitWork,
      session,
    ],
  );
  useLayoutEffect(() => {
    previewVisit.establish();
    return () => {
      previewVisit.retire();
    };
  }, [previewVisit]);
  const previewAuthority = useMemo<PreviewPresentationAuthority | null>(
    () =>
      previewSelection && previewSelectionRef.current === previewSelection
        ? Object.freeze({
            generation: Symbol("preview-presentation"),
            revision: previewPresentationRevision,
            mount: previewMount,
            selection: previewSelection,
            rootClass: PREVIEW_ROOT_CLASS,
            barClass: PREVIEW_BAR_CLASS,
            backClass: PREVIEW_BACK_CLASS,
            message: PREVIEW_MESSAGE,
          })
        : null,
    [
      previewMount,
      previewPresentationRevision,
      previewSelection,
    ],
  );
  const previewPresentation = useMemo(
    () =>
      previewAuthority
        ? createPreviewPresentation({
            authority: previewAuthority,
            cells: previewPublicationCells,
            selectionCurrent: () => previewSelectionRef.current,
            requestSuccessor: requestPreviewPresentationSuccessor,
            clearSelection: clearPreviewSelection,
          })
        : null,
    [
      clearPreviewSelection,
      previewAuthority,
      previewPublicationCells,
      requestPreviewPresentationSuccessor,
    ],
  );
  useLayoutEffect(() => {
    if (!previewPresentation) return;
    previewPresentation.establish();
    return () => {
      previewPresentation.retireLayout();
    };
  }, [previewPresentation]);
  const slashMenu = useSlashMenuController();
  const isOwner = role === "owner";
  useEffect(() => {
    actions.setRichScroller(richScroller);
  }, [actions, richScroller]);

  const toast = useCallback((message: string, kind: ToastKind = "info", action?: ToastAction) => {
    if (toastAuthorityRef.current !== toastAuthority) return;
    const immutableAction = action
      ? Object.freeze({ label: action.label, href: action.href, onClick: action.onClick })
      : undefined;
    const publication: ToastPublication = Object.freeze({
      authority: toastAuthority,
      message,
      kind,
      action: immutableAction,
      timer: setTimeout(() => {
        dismissToast(publication, true);
      }, kind === "error" ? 8000 : 4500),
    });
    toastTimersRef.current.add(publication);
    toastPublicationsRef.current = [...toastPublicationsRef.current, publication];
    setToastPublications((current) => [...current, publication]);
  }, [dismissToast, toastAuthority]);
  const activateToastAction = useCallback((publication: ToastPublication) => {
    const action = publication.action?.onClick;
    if (!action || !dismissToast(publication)) return;
    action();
  }, [dismissToast]);

  // A message left by the previous page (e.g. "Copy created" after "Make a copy").
  useEffect(() => {
    if (
      toastAuthorityRef.current !== toastAuthority ||
      pendingNoticeConsumedRef.current === toastAuthority
    ) {
      return;
    }
    pendingNoticeConsumedRef.current = toastAuthority;
    const notice = takePendingNotice();
    if (notice) toast(notice.message, notice.kind);
  }, [toast, toastAuthority]);

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

  const ownsPublishPull = useCallback(
    (owner: PublishPullOwner) => currentEditorRef.current === owner.editor && publishPullOwnerRef.current === owner,
    [],
  );
  const finishPublishPull = useCallback(
    (owner: PublishPullOwner) => {
      if (!ownsPublishPull(owner)) return;
      publishPullOwnerRef.current = null;
      setPublishingOwner((current) => current === owner ? null : current);
    },
    [ownsPublishPull],
  );
  const beginPublishPull = useCallback(
    <T,>(kind: PublishPullKind, request: (documentId: string) => Promise<T>) => {
      const editor = currentEditorRef.current;
      if (!editor || publishPullOwnerRef.current) return null;
      const owner = { editor, kind };
      publishPullOwnerRef.current = owner;
      // Commit the pending UI before the initiating event can activate another surface.
      flushSync(() => setPublishingOwner(owner));
      let pending: Promise<T>;
      try {
        pending = request(editor.documentId);
      } catch (error) {
        pending = Promise.reject(error);
      }
      return { owner, pending };
    },
    [],
  );

  const startPublish = useCallback(
    (message?: string, force = false) => {
      const operation = beginPublishPull("publish", (documentId) => api.documents.publish(documentId, message, { force }));
      if (!operation) return null;
      const { owner, pending } = operation;
      return (async () => {
        try {
          const res = await pending;
          if (!ownsPublishPull(owner)) return;
          if (res.document) setDoc(res.document);
          setVersionsRefresh((n) => n + 1);
          setSyncTick((n) => n + 1);
          if (res.result.skipped) toast("Already up to date on GitHub.", "info");
          else toast(doc.storage === "gist" ? "Gist updated." : "Committed to GitHub.", "success", res.result.url ? { label: "View", href: res.result.url } : undefined);
        } catch (e) {
          if (ownsPublishPull(owner)) {
            // GitHub moved since the last sync: hand the decision to the Sync dialog instead of a raw error.
            if (e instanceof ApiError && e.status === 409 && e.body?.status) {
              setSync((s) => ({ ...(s ?? emptySync()), ...(e.body as Partial<SyncStatusDto>), status: e.body!.status as SyncStatusDto["status"] }));
              setCommitOpen(false);
              setSyncOpen(true);
            } else {
              toast(apiErrorText(e, "Publish failed"), "error");
            }
          }
          throw e;
        } finally {
          finishPublishPull(owner);
        }
      })();
    },
    [beginPublishPull, doc.storage, finishPublishPull, ownsPublishPull, toast],
  );
  const publishNow = useCallback(
    (message?: string, force = false) => startPublish(message, force) ?? Promise.reject(publishPullBusyError()),
    [startPublish],
  );

  const beginPull = useCallback(
    (options: { force?: boolean; merge?: boolean } = {}) =>
      beginPublishPull("pull", (documentId) => api.documents.pull(documentId, options)),
    [beginPublishPull],
  );
  const applyPullSuccess = useCallback(
    (owner: PublishPullOwner, res: Awaited<ReturnType<typeof api.documents.pull>>) => {
      if (!ownsPublishPull(owner)) return;
      if (res.document) setDoc(res.document);
      setVersionsRefresh((n) => n + 1);
      setSyncTick((n) => n + 1);
      toast(res.result.merged ? "Merged GitHub\u2019s changes — review, then publish." : res.result.changed ? "Pulled the latest version from GitHub." : "Already up to date.", "success");
    },
    [ownsPublishPull, toast],
  );
  const applyPullError = useCallback(
    (owner: PublishPullOwner, error: unknown) => {
      if (!ownsPublishPull(owner)) return;
      // Local edits would be lost (or both sides changed): open the Sync dialog; merge handles marked conflicts below.
      if (error instanceof ApiError && error.status === 409 && error.body?.status) {
        if (error.body.status !== "conflict") {
          setSync((s) => ({ ...(s ?? emptySync()), ...(error.body as Partial<SyncStatusDto>), status: error.body!.status as SyncStatusDto["status"] }));
          setSyncOpen(true);
        }
      } else {
        toast(apiErrorText(error, "Pull failed"), "error");
      }
    },
    [ownsPublishPull, toast],
  );
  const startPull = useCallback(
    (options: { force?: boolean; merge?: boolean } = {}) => {
      const operation = beginPull(options);
      if (!operation) return null;
      const { owner, pending } = operation;
      return (async () => {
        try {
          const res = await pending;
          applyPullSuccess(owner, res);
          return res;
        } catch (error) {
          applyPullError(owner, error);
          throw error;
        } finally {
          finishPublishPull(owner);
        }
      })();
    },
    [applyPullError, applyPullSuccess, beginPull, finishPublishPull],
  );
  const pull = useCallback(
    (options: { force?: boolean; merge?: boolean } = {}) => startPull(options) ?? Promise.reject(publishPullBusyError()),
    [startPull],
  );

  // Poll the three-way status while the document is GitHub-backed (60 s, or SYNC_POLL_MS via the response) and
  // right after publish/pull; the server caches the GitHub read so this is cheap. Hidden tabs do not poll.
  const linkedToGitHub = doc.storage !== "local";
  useSyncPolling({ documentId: doc.id, enabled: linkedToGitHub, refreshKey: syncTick, onStatus: setSync });

  const compareWithGitHub = useCallback(
    (visit: EditorPreviewVisit) => {
      if (!ownsPreviewVisit(visit)) return Promise.resolve();
      const owner: GitHubCompareRequest = {
        visit,
        document: visit.document,
        documentId: visit.documentId,
        request: Symbol("github-compare-request"),
      };
      githubCompareRequestsRef.current.add(owner);
      const ownsRequest = () =>
        githubCompareRequestsRef.current.has(owner) &&
        owner.visit.document === owner.document &&
        owner.visit.documentId === owner.documentId &&
        ownsPreviewVisit(owner.visit);
      return (async () => {
        try {
          const versionsModule = loadVersionsPanel();
          const body = await api.documents.sync(owner.documentId, { fresh: true, content: true });
          await versionsModule;
          if (!ownsRequest()) return;
          const remoteContent = body.remoteContent ?? "";
          const now = new Date().toISOString();
          owner.visit.githubProducer({
            version: {
              id: "github-remote",
              number: 0,
              title: "GitHub",
              kind: "import",
              createdBy: null,
              createdByName: "GitHub",
              commitSha: body.remote.sha,
              createdAt: body.remote.updatedAt ?? now,
              size: remoteContent.length,
            },
            content: remoteContent,
          });
        } catch (error) {
          if (ownsRequest()) throw error;
        } finally {
          githubCompareRequestsRef.current.delete(owner);
        }
      })();
    },
    [ownsPreviewVisit],
  );
  const syncActions = useMemo<SyncActions>(
    () => ({
      merge: async () => {
        const operation = beginPull({ merge: true });
        if (!operation) throw publishPullBusyError();
        const { owner, pending } = operation;
        try {
          const res = await pending;
          applyPullSuccess(owner, res);
          return 0;
        } catch (e) {
          if (e instanceof ApiError && e.status === 409 && e.body?.status === "conflict" && typeof e.body.merged === "string") {
            if (!ownsPublishPull(owner)) throw e;
            // Put the marked text in the document so the user resolves conflicts inline (the `merge-conflict` lint flags each marker).
            session.replaceSource([{ from: 0, to: session.ytext.length, text: e.body.merged }]);
            session.setActiveSurface("code");
            if (shownLayout === "rich") setLayout(isPhone ? "code" : "split");
            toast(`Merged with ${e.body.conflicts} conflict${e.body.conflicts === 1 ? "" : "s"} — resolve the marked lines, then publish.`, "info");
            return Number(e.body.conflicts ?? 1);
          }
          applyPullError(owner, e);
          throw e;
        } finally {
          finishPublishPull(owner);
        }
      },
      keepMine: (message: string) => publishNow(message, true),
      takeRemote: async () => {
        await pull({ force: true });
      },
      compare: () => compareWithGitHub(previewVisit),
    }),
    [applyPullError, applyPullSuccess, beginPull, compareWithGitHub, finishPublishPull, ownsPublishPull, previewVisit, pull, publishNow, session, shownLayout, isPhone, setLayout, toast],
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

  const ownsDocumentMutation = useCallback(
    (owner: DocumentMutationOwner) =>
      currentEditorRef.current === owner.editor &&
      owner.editor.session === owner.session &&
      owner.editor.documentId === owner.documentId &&
      documentMutationOwnerRef.current === owner,
    [],
  );
  const finishDocumentMutation = useCallback(
    (owner: DocumentMutationOwner) => {
      if (!ownsDocumentMutation(owner)) return;
      documentMutationOwnerRef.current = null;
      setDocumentMutationOwner((current) => current === owner ? null : current);
    },
    [ownsDocumentMutation],
  );
  const beginDocumentMutation = useCallback(
    <T,>(action: DocumentMutationAction, request: (documentId: string) => Promise<T>) => {
      const editor = currentEditorRef.current;
      if (
        !editor ||
        editor !== editorIdentity ||
        editor.session !== session ||
        editor.documentId !== doc.id ||
        documentMutationOwnerRef.current
      ) {
        return null;
      }
      const owner: DocumentMutationOwner = {
        editor,
        session,
        documentId: doc.id,
        title: doc.title,
        storage: doc.storage,
        action,
        operation: ++documentMutationSequence.current,
      };
      documentMutationOwnerRef.current = owner;
      flushSync(() => setDocumentMutationOwner(owner));
      let pending: Promise<T>;
      try {
        pending = request(owner.documentId);
      } catch (error) {
        pending = Promise.reject(error);
      }
      return { owner, pending };
    },
    [doc.id, doc.storage, doc.title, editorIdentity, session],
  );

  // Set once this editor has decided to leave (own delete or server eviction) so the two paths do not race.
  const deleteDoc = useCallback(() => {
    if (currentEditorRef.current !== editorIdentity || documentMutationOwnerRef.current) return;
    if (!confirm(`Move “${doc.title}” to trash? You can restore it from the dashboard for 30 days.`)) return;
    const mutation = beginDocumentMutation("delete", (documentId) => api.documents.delete(documentId));
    if (!mutation) return;
    const { owner, pending } = mutation;
    void (async () => {
      try {
        await pending;
        if (!ownsDocumentMutation(owner)) return;
        leavingEditorRef.current = owner.editor;
        setPendingNotice(`“${owner.title}” was moved to the trash.`, "success");
        await owner.session.clearLocal();
        if (!ownsDocumentMutation(owner)) return;
        router.push("/");
      } catch (error) {
        if (ownsDocumentMutation(owner)) toast(apiErrorText(error, "Could not move to trash"), "error");
      } finally {
        finishDocumentMutation(owner);
      }
    })();
  }, [beginDocumentMutation, doc.title, editorIdentity, finishDocumentMutation, ownsDocumentMutation, router, toast]);

  // Another owner session (or this one, via the API) trashed the document: leave with a notice.
  const trashed = useSessionValue(session, (s) => s.trashed);
  useEffect(() => {
    if (!trashed || leavingEditorRef.current === editorIdentity) return;
    leavingEditorRef.current = editorIdentity;
    setPendingNotice("This document was moved to the trash.", "info");
    const leaveIfCurrent = () => {
      if (currentEditorRef.current === editorIdentity && leavingEditorRef.current === editorIdentity) router.push("/");
    };
    void session.clearLocal().then(leaveIfCurrent, leaveIfCurrent);
  }, [editorIdentity, trashed, session, router]);

  const duplicateDoc = useCallback(() => {
    const mutation = beginDocumentMutation("duplicate", (documentId) => api.documents.duplicate(documentId));
    if (!mutation) return;
    const { owner, pending } = mutation;
    void (async () => {
      try {
        const res = await pending;
        if (!ownsDocumentMutation(owner)) return;
        setPendingNotice(
          owner.storage === "local" ? `Created “${res.title}”.` : `Created “${res.title}” as a Markdoc document. The copy is not connected to GitHub.`,
          "success",
        );
        router.push(`/d/${res.id}`);
      } catch (error) {
        if (ownsDocumentMutation(owner)) toast(apiErrorText(error, "Could not make a copy"), "error");
      } finally {
        finishDocumentMutation(owner);
      }
    })();
  }, [beginDocumentMutation, finishDocumentMutation, ownsDocumentMutation, router, toast]);

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
  const openVersionName = openNameVersion;
  const openStorage = useCallback(() => (isOwner ? setDialog("publish") : undefined), [isOwner]);
  const publishFromHeader = useCallback(() => {
    if (doc.storage !== "gist") {
      if (!publishPullOwnerRef.current) setCommitOpen(true);
      return;
    }
    const request = startPublish();
    if (request) void request.catch(() => undefined);
  }, [doc.storage, startPublish]);
  const pullFromHeader = useCallback(() => {
    const request = startPull();
    if (request) void request.catch(() => undefined);
  }, [startPull]);
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
    setDialog: setEditorDialog,
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
  const operationDialogKey = `${initialDoc.id}:${user.id}:${role}:${embed ? "embed" : "page"}:${session.ydoc.guid}`;
  const changeCommitOpen = useCallback((open: boolean) => {
    if (currentEditorRef.current === editorIdentity) setCommitOpen(open);
  }, [editorIdentity]);
  const changeSyncOpen = useCallback((open: boolean) => {
    if (currentEditorRef.current === editorIdentity) setSyncOpen(open);
  }, [editorIdentity]);
  const changeNameVersionOpen = useCallback((visit: NameVersionVisit, open: boolean) => {
    if (currentEditorRef.current !== visit.editor || currentNameVersionVisitRef.current !== visit) return;
    if (open) {
      setDialog("versionName");
      return;
    }
    currentNameVersionVisitRef.current = null;
    if (namedVersionOwnerRef.current?.visit === visit) namedVersionOwnerRef.current = null;
    setDialog((current) => current === "versionName" ? null : current);
  }, []);

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
  const renderedPreviewPresentation =
    previewPresentation &&
    previewSelectionRef.current === previewPresentation.authority.selection &&
    previewPresentation.authority.selection.visit === previewVisit &&
    previewVisit.owns()
      ? previewPresentation
      : null;
  const versionPreview =
    renderedPreviewPresentation?.authority.selection.value.preview ?? null;
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

  useCollaboratorFollowVisit({
    session,
    actions,
    richView,
    codeView,
    richScroller,
    showCode,
    showRich,
    syncScroll,
    userId: followUserId,
    cursor: followedCursor,
  });
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
    return { share: make("share"), publish: make("publish"), link: make("link"), image: make("image"), table: make("table"), shortcuts: make("shortcuts") };
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
  const ownsNamedVersion = useCallback(
    (owner: NameVersionSaveOwner) =>
      owner.editor === owner.visit.editor &&
      owner.documentId === owner.visit.documentId &&
      currentEditorRef.current === owner.editor &&
      currentEditorRef.current.documentId === owner.documentId &&
      currentNameVersionVisitRef.current === owner.visit &&
      namedVersionOwnerRef.current === owner,
    [],
  );
  const saveNamedVersion = useCallback(
    (owner: NameVersionSaveOwner) => {
      if (
        owner.editor !== owner.visit.editor ||
        owner.documentId !== owner.visit.documentId ||
        currentEditorRef.current !== owner.editor ||
        currentEditorRef.current.documentId !== owner.documentId ||
        currentNameVersionVisitRef.current !== owner.visit ||
        namedVersionOwnerRef.current
      ) {
        return Promise.reject(new Error("This named-version save is no longer current."));
      }
      namedVersionOwnerRef.current = owner;
      let pending: ReturnType<typeof api.documents.createVersion>;
      try {
        pending = api.documents.createVersion(owner.documentId, owner.title);
      } catch (error) {
        pending = Promise.reject(error);
      }
      return (async () => {
        try {
          await pending;
          if (!ownsNamedVersion(owner)) return;
          setVersionsRefresh((n) => n + 1);
          toast(`Saved version “${owner.title}”.`, "success");
        } finally {
          if (ownsNamedVersion(owner)) namedVersionOwnerRef.current = null;
        }
      })();
    },
    [ownsNamedVersion, toast],
  );
  const nextNamedVersionOperationId = useCallback(() => ++namedVersionOperationSequence.current, []);
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
      <VersionsPanel session={session} onClose={closeSidePanel} onPreview={previewVisit.versionsProducer} refreshKey={versionsRefresh} />
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
          documentMutation={documentMutation}
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
          <div ref={previewVisit.captureContainer} className={PANES_BOX}>
            {showLoading && !showRichPlaceholder && (
              <div className="absolute inset-0 z-10 flex items-center justify-center bg-surface text-sm text-ink-3" data-testid="doc-loading" aria-busy="true">
                Loading…
              </div>
            )}
            {renderedPreviewPresentation ? (
              <div
                ref={renderedPreviewPresentation.captureRoot}
                className={renderedPreviewPresentation.authority.rootClass}
              >
                {renderedPreviewPresentation.authority.selection.source === "github-compare" && (
                  <div
                    className={renderedPreviewPresentation.authority.barClass}
                    data-testid="sync-compare-bar"
                  >
                    <span>{renderedPreviewPresentation.authority.message}</span>
                    <button
                      ref={renderedPreviewPresentation.captureBack}
                      type="button"
                      className={renderedPreviewPresentation.authority.backClass}
                      onClick={renderedPreviewPresentation.activateBack}
                      data-testid="sync-compare-close"
                    >
                      Back to editing
                    </button>
                  </div>
                )}
                <VersionDiffView
                  session={renderedPreviewPresentation.authority.selection.visit.session}
                  preview={renderedPreviewPresentation.authority.selection.value.preview}
                />
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
            {everOpened.commit && <CommitDialog key={`commit:${operationDialogKey}`} open={commitOpen} onOpenChange={changeCommitOpen} doc={docView} onCommit={publishNow} isOwner={isOwner} />}
            {everOpened.sync && <SyncDialog key={`sync:${operationDialogKey}`} open={syncOpen} onOpenChange={changeSyncOpen} doc={docView} sync={sync} actions={syncActions} />}
          </>
        )}
        {everOpened.link && <LinkDialog open={dialog === "link"} onOpenChange={dialogOpenChange.link} initial={linkInitial} onSubmit={applyLink} onRemove={removeLink} />}
        {everOpened.image && <ImageDialog open={dialog === "image"} onOpenChange={dialogOpenChange.image} onSubmit={insertImage} onUpload={uploadImage} />}
        {everOpened.fileDrop && <FileDropDialog pending={fileDrop} onClose={closeFileDrop} canEdit={canEdit} onReplace={replaceAll} onInsert={insertAt} onError={fileDropError} />}
        {everOpened.table && <TableDialog open={dialog === "table"} onOpenChange={dialogOpenChange.table} onSubmit={insertTable} />}
        {everOpened.versionName && nameVersionVisit && (
          <NameVersionDialog
            key={`version-name:${operationDialogKey}`}
            open={dialog === "versionName"}
            visit={nameVersionVisit}
            onOpenChange={changeNameVersionOpen}
            nextOperationId={nextNamedVersionOperationId}
            onSubmit={saveNamedVersion}
          />
        )}
        {everOpened.shortcuts && <ShortcutsDialog open={dialog === "shortcuts"} onOpenChange={dialogOpenChange.shortcuts} />}
        {everOpened.palette && <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} commands={paletteCommands} />}

        <div className="pointer-events-none fixed bottom-14 left-1/2 z-[70] flex w-max max-w-[calc(100vw-2rem)] -translate-x-1/2 flex-col items-center gap-2" aria-live="polite">
          {toastPublications
            .filter(
              (publication) =>
                publication.authority === toastAuthority &&
                toastPublicationsRef.current.includes(publication),
            )
            .map((t) => (
              <div
                key={toastRenderKey(t)}
                className={cn(
                  "pointer-events-auto flex min-w-0 max-w-full items-center gap-3 rounded-xl px-4 py-2.5 text-sm shadow-xl animate-fade-in",
                  t.kind === "error" ? "bg-red-600 text-white" : "bg-inverse text-white",
                )}
                role="status"
                data-testid="toast"
              >
                <span className="min-w-0 wrap-anywhere">{t.message}</span>
                {t.action?.href && (
                  <a className="min-w-0 wrap-anywhere font-semibold underline decoration-white/40 underline-offset-2" href={t.action.href} target="_blank" rel="noopener noreferrer">
                    {t.action.label}
                  </a>
                )}
                {t.action?.onClick && (
                  <button
                    type="button"
                    className="min-w-0 wrap-anywhere font-semibold underline decoration-white/40 underline-offset-2"
                    onClick={() => activateToastAction(t)}
                    data-testid="toast-action"
                  >
                    {t.action.label}
                  </button>
                )}
                <button type="button" className="shrink-0 text-white/60 hover:text-white" onClick={() => dismissToast(t)} aria-label="Dismiss">
                  <X size={14} />
                </button>
              </div>
            ))}
        </div>
      </div>
    </TooltipProvider>
  );
}
