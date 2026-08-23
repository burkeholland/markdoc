"use client";
import { navigateTo } from "@/lib/nav";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import type { EditorView as CMView } from "@codemirror/view";
import type { EditorView as PMView } from "prosemirror-view";
import { Eye, PenLine, X } from "lucide-react";
import type { DocumentDto } from "@/server/dto";
import type { Role } from "@/server/db/schema";
import type { LintIssue } from "@/editor/markdown/lint";
import type { HeadingInfo } from "@/editor/markdown/parse";
import { api } from "@/lib/api";
import { uploadAsset } from "@/lib/api";
import { setPendingNotice, takePendingNotice } from "@/lib/notice";
import { cn } from "@/lib/utils";
import { TooltipProvider, Tip } from "@/components/ui/primitives";
import { shallowEqual, useCollabSession, useSessionValue, type EditorUser } from "./use-session";
import { EditorActions, EMPTY_FORMAT, type DialogKind, type FormatState } from "./actions";
import { Header, type ExportFormat } from "./header";
import { Toolbar } from "./toolbar";
import { OutlinePanel } from "./outline";
import { CodePane } from "./code-pane";
import { RichPane } from "./rich-pane";
import { StatusBar, type Layout } from "./status-bar";
import { CommentsPanel } from "./comments-panel";
import { VersionsPanel, VersionDiffView } from "./versions-panel";
import { ActivityPanel } from "./activity-panel";
import { ShareDialog } from "./share-dialog";
import { GitHubDialog, CommitDialog } from "./github-dialog";
import { LinkDialog, ImageDialog, TableDialog, NameVersionDialog, ShortcutsDialog } from "./dialogs";
import { SelectionBubble } from "./selection-bubble";
import { TableMenu } from "./table-menu";
import { SlashMenu, useSlashMenuController } from "./slash-menu";
import { FindBar } from "./find-bar";
import { useScrollSync } from "./scroll-sync";
import type { VersionSummary } from "@/lib/api";
import type { FindMatch } from "@/editor/find";
import { isMac } from "@/lib/utils";

export interface EditorShellProps {
  doc: DocumentDto;
  role: Role;
  user: EditorUser;
  githubAvailable: boolean;
}

interface Toast {
  id: number;
  message: string;
  kind: "info" | "error" | "success";
  action?: { label: string; href: string };
}

type SidePanel = "comments" | "versions" | "activity" | null;

const noopSubscribe = () => () => {};

export function EditorShell({ doc: initialDoc, role, user, githubAvailable }: EditorShellProps) {
  const router = useRouter();
  const session = useCollabSession(initialDoc.id, user, role);
  const [doc, setDoc] = useState(initialDoc);
  const [layout, setLayout] = useState<Layout>("split");
  const [outlineOpen, setOutlineOpen] = useState(true);
  const [sidePanel, setSidePanel] = useState<SidePanel>(null);
  const [lineWrapping, setLineWrapping] = useState(true);
  const [dialog, setDialog] = useState<DialogKind>(null);
  const [commitOpen, setCommitOpen] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [versionPreview, setVersionPreview] = useState<{ version: VersionSummary; content: string } | null>(null);
  const [versionsRefresh, setVersionsRefresh] = useState(0);
  const [cursor, setCursor] = useState<{ code: number | null; rich: number | null }>({ code: null, rich: null });
  const [linkInitial, setLinkInitial] = useState<{ href: string; text: string } | null>(null);
  const [viewsReady, setViewsReady] = useState(0);
  const [richView, setRichView] = useState<PMView | null>(null);
  const [codeView, setCodeView] = useState<CMView | null>(null);
  const [richScroller, setRichScroller] = useState<HTMLDivElement | null>(null);
  const [syncScroll, setSyncScrollState] = useState(true);
  const [findUi, setFindUi] = useState<{ replace: boolean; nonce: number } | null>(null);
  const richScrollRef = useRef<HTMLDivElement>(null);
  const setRichScrollRef = useCallback((el: HTMLDivElement | null) => {
    richScrollRef.current = el;
    setRichScroller(el);
  }, []);
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

  const actions = useMemo(() => new EditorActions(session, setDialog), [session]);
  const slashMenu = useSlashMenuController();
  const activeSurface = useSessionValue(session, (s) => s.activeSurface);
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
  }, [toast]);

  // Toolbar state is derived from the live editors. The selector also runs on every render,
  // so selection changes (React state) are picked up as well as session changes; the shallow
  // comparison keeps the object stable when nothing visible changed.
  const format: FormatState = useSessionValue(session, () => (viewsReady ? actions.formatState() : EMPTY_FORMAT), shallowEqual);
  const getRichText = useCallback(() => actions.rich?.state.doc.textContent ?? "", [actions]);

  const onCodeReady = useCallback(
    (view: CMView | null) => {
      actions.setCodeView(view);
      setCodeView(view);
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

  const onCodeSelection = useCallback(
    (head: number) => {
      setCursor((c) => (c.code === head ? c : { ...c, code: head }));
    },
    [],
  );
  const onRichSelection = useCallback(
    (head: number) => {
      const src = session.binding.getSourceMap().pmToSrc(head);
      setCursor((c) => (c.rich === src ? c : { ...c, rich: src }));
    },
    [session],
  );
  const cursorSource = activeSurface === "code" ? cursor.code : cursor.rich;

  const onHighlightClick = useCallback(
    (kind: string, id: string | null) => {
      if (!id) return;
      if (kind.startsWith("comment")) {
        session.setActiveComment(id);
        setSidePanel("comments");
      } else if (kind.startsWith("suggest")) {
        session.setActiveSuggestion(id);
        setSidePanel("comments");
      }
    },
    [session],
  );

  const startComment = useCallback(() => {
    if (!session.canComment) return;
    const range = actions.selectionSourceRange();
    if (!range) {
      toast("Select some text to comment on.", "info");
      return;
    }
    session.setPendingComment(range);
    setSidePanel("comments");
  }, [actions, session, toast]);

  const openLink = useCallback(() => {
    setLinkInitial(actions.currentLink());
    setDialog("link");
  }, [actions]);

  const reveal = useCallback((offset: number) => actions.revealSource(offset, { focus: true }), [actions]);

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
      if (layout === "rich") setLayout("split");
    },
    [actions, session, layout],
  );

  const publishNow = useCallback(
    async (message?: string) => {
      setPublishing(true);
      try {
        const res = await api.documents.publish(doc.id, message);
        if (res.document) setDoc(res.document);
        setVersionsRefresh((n) => n + 1);
        if (res.result.skipped) toast("Already up to date on GitHub.", "info");
        else toast(doc.storage === "gist" ? "Gist updated." : "Committed to GitHub.", "success", res.result.url ? { label: "View", href: res.result.url } : undefined);
      } catch (e) {
        toast(e instanceof Error ? e.message : "Publish failed", "error");
        throw e;
      } finally {
        setPublishing(false);
      }
    },
    [doc.id, doc.storage, toast],
  );

  const pull = useCallback(async () => {
    setPublishing(true);
    try {
      const res = await api.documents.pull(doc.id);
      if (res.document) setDoc(res.document);
      setVersionsRefresh((n) => n + 1);
      toast(res.result.changed ? "Pulled the latest version from GitHub." : "Already up to date.", "success");
    } catch (e) {
      toast(e instanceof Error ? e.message : "Pull failed", "error");
    } finally {
      setPublishing(false);
    }
  }, [doc.id, toast]);

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
        toast(e instanceof Error ? e.message : "PDF export failed", "error");
      }
    },
    [doc.id, doc.title, toast],
  );

  const copyMarkdown = useCallback(async () => {
    await navigator.clipboard.writeText(session.suggestions.cleanText());
    toast("Markdown copied to clipboard.", "success");
  }, [session, toast]);

  // Pasted, dropped and dialog-chosen images all go through the document's asset store.
  const uploadImage = useCallback((file: File) => uploadAsset(doc.id, file), [doc.id]);
  const onImageError = useCallback((message: string) => toast(`Image upload failed: ${message}`, "error"), [toast]);

  // Set once this client has decided to leave (own delete or server eviction) so the two paths do not race.
  const leavingRef = useRef(false);
  const deleteDoc = useCallback(async () => {
    if (!confirm(`Move “${doc.title}” to trash? You can restore it from the dashboard for 30 days.`)) return;
    try {
      await api.documents.delete(doc.id);
    } catch (e) {
      toast(e instanceof Error ? e.message : "Could not move to trash", "error");
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
      toast(e instanceof Error ? e.message : "Could not make a copy", "error");
    }
  }, [doc.id, doc.storage, router, toast]);

  // Stable handlers so the memoized header, toolbar and status bar skip re-renders while typing.
  const toggleComments = useCallback(() => setSidePanel((p) => (p === "comments" ? null : "comments")), []);
  const toggleHistory = useCallback(() => setSidePanel((p) => (p === "versions" ? null : "versions")), []);
  const toggleActivity = useCallback(() => setSidePanel((p) => (p === "activity" ? null : "activity")), []);
  const openShare = useCallback(() => setDialog("share"), []);
  const openPublish = useCallback(() => setDialog("publish"), []);
  const openShortcuts = useCallback(() => setDialog("shortcuts"), []);
  const openImage = useCallback(() => setDialog("image"), []);
  const openTable = useCallback(() => setDialog("table"), []);
  const openVersionName = useCallback(() => setDialog("versionName"), []);
  const openStorage = useCallback(() => (isOwner ? setDialog("publish") : undefined), [isOwner]);
  const publishFromHeader = useCallback(() => (doc.storage === "gist" ? void publishNow() : setCommitOpen(true)), [doc.storage, publishNow]);
  const pullFromHeader = useCallback(() => void pull(), [pull]);
  const deleteFromHeader = useCallback(() => void deleteDoc(), [deleteDoc]);
  const duplicateFromHeader = useCallback(() => void duplicateDoc(), [duplicateDoc]);
  const copyFromHeader = useCallback(() => void copyMarkdown(), [copyMarkdown]);
  const goHome = useCallback(() => router.push("/"), [router]);

  // Find & replace. The model lives on the session (shared with the highlight pipeline);
  // the shell owns focus handling and the replace-row toggle.
  const openFind = useCallback(
    (replace: boolean) => {
      const seed = actions.selectionText();
      session.setFind(seed || session.find?.query || "");
      setFindUi((ui) => ({ replace: replace || (ui?.replace ?? false), nonce: (ui?.nonce ?? 0) + 1 }));
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
  const setFindReplaceVisible = useCallback((replace: boolean) => setFindUi((ui) => (ui ? { ...ui, replace } : ui)), []);
  const revealMatch = useCallback((m: FindMatch) => actions.revealSourceRange(m), [actions]);

  // Global shortcuts that are not editor-specific.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      // Option-letter on macOS reports a symbol in `key`; fall back to the physical key there.
      const key = isMac && e.altKey && /^Key[A-Z]$/.test(e.code) ? e.code.slice(3).toLowerCase() : e.key.toLowerCase();
      if (mod && e.altKey && key === "m") {
        e.preventDefault();
        startComment();
      }
      if (mod && e.key === "/" ) {
        e.preventDefault();
        setDialog("shortcuts");
      }
      // Mod-F must win over the browser and both editors' default search bindings.
      if (mod && !e.shiftKey && key === "f" && (!e.altKey || isMac)) {
        e.preventDefault();
        openFind(e.altKey);
      } else if (mod && !e.shiftKey && !e.altKey && key === "h") {
        e.preventDefault();
        openFind(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [startComment, openFind]);

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
  const showLoading = hydrated && !contentReady;
  const showCode = layout !== "rich" && !versionPreview;
  const showRich = layout !== "code" && !versionPreview;
  const viewingOnly = useSessionValue(session, (s) => s.mode === "viewing");
  useScrollSync({ session, code: codeView, rich: richView, richScroller, enabled: syncScroll && showCode && showRich });

  return (
    <TooltipProvider>
      <div className="flex h-screen flex-col overflow-hidden bg-surface" data-testid="editor-shell">
        <Header
          session={session}
          doc={docView}
          commentsOpen={sidePanel === "comments"}
          onToggleComments={toggleComments}
          onShare={openShare}
          onPublish={openPublish}
          onPublishNow={publishFromHeader}
          onPull={pullFromHeader}
          onHistory={toggleHistory}
          onActivity={toggleActivity}
          onShortcuts={openShortcuts}
          onDelete={deleteFromHeader}
          onDuplicate={duplicateFromHeader}
          onDownload={download}
          onCopyMarkdown={copyFromHeader}
          onNameVersion={openVersionName}
          publishing={publishing}
          isOwner={isOwner}
          onHome={goHome}
        />
        <Toolbar session={session} actions={actions} format={format} onComment={startComment} onImage={openImage} onTable={openTable} />
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
        {authError && (
          <div className="flex items-center justify-center gap-3 bg-red-50 px-4 py-2 text-sm text-danger" role="alert">
            Could not connect to the collaboration server ({authError}).
            <button type="button" className="btn btn-sm btn-outline" onClick={() => window.location.reload()}>
              Reload
            </button>
          </div>
        )}
        <div className="flex min-h-0 flex-1">
          <OutlinePanel session={session} open={outlineOpen} onToggle={() => setOutlineOpen((o) => !o)} cursorSource={cursorSource} onSelect={onOutlineSelect} />
          <div className="relative flex min-w-0 flex-1">
            {showLoading && (
              <div className="absolute inset-0 z-10 flex items-center justify-center bg-surface text-sm text-ink-3" data-testid="doc-loading" aria-busy="true">
                Loading…
              </div>
            )}
            {versionPreview ? (
              <VersionDiffView session={session} version={versionPreview.version} content={versionPreview.content} />
            ) : (
              <>
                <div className={cn("flex min-w-0 flex-col", showRich ? "flex-1 basis-0 border-r border-line" : "flex-1", !showCode && "hidden")} data-testid="code-column">
                  <div className="min-h-0 flex-1">
                    <CodePane
                      session={session}
                      onReady={onCodeReady}
                      onSelection={onCodeSelection}
                      onHighlightClick={onHighlightClick}
                      uploadImage={uploadImage}
                      onImageError={onImageError}
                      focusSource={activeSurface === "rich" ? cursor.rich : null}
                      lineWrapping={lineWrapping}
                    />
                  </div>
                </div>
                <div className={cn("flex min-w-0 flex-col", showCode ? "flex-1 basis-0" : "flex-1", !showRich && "hidden")} data-testid="rich-column">
                  <div className="flex h-12 shrink-0 items-center justify-between pl-6 pr-3">
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
                  <div ref={setRichScrollRef} className="scrollbar-thin relative min-h-0 flex-1 overflow-y-auto">
                    <SelectionBubble view={richView} session={session} actions={actions} format={format} containerRef={richScrollRef} onComment={startComment} onLink={openLink} />
                    <TableMenu view={richView} session={session} actions={actions} format={format} containerRef={richScrollRef} />
                    <SlashMenu view={richView} session={session} controller={slashMenu} containerRef={richScrollRef} onImage={openImage} onLink={openLink} onComment={startComment} />
                    <RichPane
                      session={session}
                      onReady={onRichReady}
                      onSelection={onRichSelection}
                      onHighlightClick={onHighlightClick}
                      onLinkShortcut={openLink}
                      onCommentShortcut={startComment}
                      uploadImage={uploadImage}
                      onImageError={onImageError}
                      focusSource={activeSurface === "code" ? cursor.code : null}
                      slashMenu={slashMenu.handlers}
                    />
                  </div>
                </div>
              </>
            )}
          </div>
          {sidePanel === "comments" && <CommentsPanel session={session} onClose={() => setSidePanel(null)} onReveal={reveal} />}
          {sidePanel === "versions" && (
            <VersionsPanel session={session} onClose={() => setSidePanel(null)} onPreview={setVersionPreview} refreshKey={versionsRefresh} />
          )}
          {sidePanel === "activity" && <ActivityPanel session={session} onClose={() => setSidePanel(null)} />}
        </div>
        <StatusBar
          session={session}
          doc={docView}
          layout={layout}
          onLayout={setLayout}
          lineWrapping={lineWrapping}
          onLineWrapping={setLineWrapping}
          syncScroll={syncScroll}
          onSyncScroll={setSyncScroll}
          onIssueSelect={onIssueSelect}
          onShortcuts={openShortcuts}
          onStorage={openStorage}
          getRichText={getRichText}
        />

        <ShareDialog open={dialog === "share"} onOpenChange={(o) => setDialog(o ? "share" : null)} doc={docView} isOwner={isOwner} onDocChange={setDoc} />
        <GitHubDialog open={dialog === "publish"} onOpenChange={(o) => setDialog(o ? "publish" : null)} doc={docView} onDocChange={(d) => { setDoc(d); setVersionsRefresh((n) => n + 1); }} githubAvailable={githubAvailable} />
        <CommitDialog open={commitOpen} onOpenChange={setCommitOpen} doc={docView} onCommit={publishNow} />
        <LinkDialog
          open={dialog === "link"}
          onOpenChange={(o) => setDialog(o ? "link" : null)}
          initial={linkInitial}
          onSubmit={(href, text) => actions.applyLink(href, text)}
          onRemove={() => actions.removeLink()}
        />
        <ImageDialog open={dialog === "image"} onOpenChange={(o) => setDialog(o ? "image" : null)} onSubmit={(src, alt) => actions.insertImage(src, alt)} onUpload={uploadImage} />
        <TableDialog open={dialog === "table"} onOpenChange={(o) => setDialog(o ? "table" : null)} onSubmit={(r, c) => actions.insertTable(r, c)} />
        <NameVersionDialog
          open={dialog === "versionName"}
          onOpenChange={(o) => setDialog(o ? "versionName" : null)}
          onSubmit={async (title) => {
            await api.documents.createVersion(doc.id, title);
            setVersionsRefresh((n) => n + 1);
            toast(`Saved version “${title}”.`, "success");
          }}
        />
        <ShortcutsDialog open={dialog === "shortcuts"} onOpenChange={(o) => setDialog(o ? "shortcuts" : null)} />

        <div className="pointer-events-none fixed bottom-14 left-1/2 z-[70] flex -translate-x-1/2 flex-col items-center gap-2" aria-live="polite">
          {toasts.map((t) => (
            <div
              key={t.id}
              className={cn(
                "pointer-events-auto flex items-center gap-3 rounded-xl px-4 py-2.5 text-sm shadow-xl animate-fade-in",
                t.kind === "error" ? "bg-red-600 text-white" : "bg-ink text-white",
              )}
              role="status"
              data-testid="toast"
            >
              <span>{t.message}</span>
              {t.action && (
                <a className="font-semibold underline decoration-white/40 underline-offset-2" href={t.action.href} target="_blank" rel="noopener noreferrer">
                  {t.action.label}
                </a>
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






