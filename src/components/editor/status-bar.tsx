"use client";
import { Menu, MenuCheckboxItem, MenuContent, MenuItem, MenuLabel, MenuRadioGroup, MenuRadioItem, MenuSeparator, MenuTrigger, Popover, PopoverContent, PopoverTrigger } from "@/components/ui/primitives";
import { GitHubIcon } from "@/components/ui/github-icon";

import { memo, useCallback, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { AlertTriangle, ArrowUpDown, Check, ChevronDown, CircleHelp, GitBranch, HardDrive, Columns2, Code2, Eye, WrapText, MoreHorizontal } from "lucide-react";
import type { CollabSession } from "@/editor/collab/session";
import type { DocumentDto } from "@/server/dto";
import { lintMarkdown, type LintIssue } from "@/editor/markdown/lint";

import { cn } from "@/lib/utils";
import { ThemeToggle, useTheme } from "@/components/ui/theme-toggle";
import { isThemePreference, THEME_ORDER, themeLabel, type ThemePreference } from "@/lib/theme";
import { useHydrated } from "@/lib/hooks";
import { useDebouncedSessionValue } from "./use-session";
import { StatsPopover, useLocalSelection } from "./stats-popover";
import { STATUS_BOX } from "./chrome-classes";

export type { Layout } from "@/lib/viewport";
import type { Layout } from "@/lib/viewport";

export interface StatusBarProps {
  session: CollabSession;
  doc: DocumentDto;
  layout: Layout;
  onLayout: (layout: Layout) => void;
  lineWrapping: boolean;
  onLineWrapping: (wrap: boolean) => void;
  syncScroll: boolean;
  onSyncScroll: (on: boolean) => void;
  onIssueSelect: (issue: LintIssue) => void;
  onShortcuts: () => void;
  onStorage?: () => void;
  /** Phone: word count · storage · ⋯ menu (layout, wrap, sync scrolling and theme live inside). */
  compact?: boolean;
}

interface StatusBarDocumentPublication {
  value: DocumentDto;
  storage: DocumentDto["storage"];
  repoBranch: DocumentDto["repoBranch"];
  repoOwner: DocumentDto["repoOwner"];
  repoName: DocumentDto["repoName"];
  repoPath: DocumentDto["repoPath"];
  gistId: DocumentDto["gistId"];
  hasUnpublishedChanges: DocumentDto["hasUnpublishedChanges"];
}

interface StatusBarIssuePublication {
  snapshot: readonly LintIssue[];
  issue: LintIssue;
  index: number;
  line: number;
  column: number;
  offset: number;
  message: string;
  rule: string;
  severity: LintIssue["severity"];
}

interface StatusBarAuthority {
  mount: symbol;
  session: CollabSession;
  source: string;
  tree: unknown;
  document: StatusBarDocumentPublication;
  layout: Layout;
  layoutValues: readonly Layout[];
  onLayout: (layout: Layout) => void;
  lineWrapping: boolean;
  onLineWrapping: (wrap: boolean) => void;
  syncScroll: boolean;
  onSyncScroll: (on: boolean) => void;
  compact: boolean;
  hydrated: boolean;
  issueSnapshot: readonly LintIssue[];
  issueRows: readonly StatusBarIssuePublication[];
  onIssueSelect: (issue: LintIssue) => void;
  onShortcuts: () => void;
  onStorage: (() => void) | undefined;
  themePreference: ThemePreference;
  setThemePreference: (next: ThemePreference) => void;
}

interface StatusBarRootPublication {
  authority: StatusBarAuthority;
  root: HTMLElement;
  menuTrigger: HTMLButtonElement;
  issuesTrigger: HTMLButtonElement | null;
}

interface StatusBarControlPublication<T extends HTMLElement> {
  authority: StatusBarAuthority;
  root: HTMLElement;
  control: T;
  claimed: boolean;
}

type IsCurrentAuthority = (authority: StatusBarAuthority) => boolean;

const DESKTOP_LAYOUTS: readonly Layout[] = ["split", "code", "rich"];
const COMPACT_LAYOUTS: readonly Layout[] = ["code", "rich"];

function documentPublicationIsExact(document: StatusBarDocumentPublication) {
  const current = document.value;
  return (
    current.storage === document.storage
    && current.repoBranch === document.repoBranch
    && current.repoOwner === document.repoOwner
    && current.repoName === document.repoName
    && current.repoPath === document.repoPath
    && current.gistId === document.gistId
    && current.hasUnpublishedChanges === document.hasUnpublishedChanges
  );
}

function issuePublicationIsExact(authority: StatusBarAuthority, row: StatusBarIssuePublication) {
  const issue = row.issue;
  return (
    row.snapshot === authority.issueSnapshot
    && authority.issueRows[row.index] === row
    && row.snapshot[row.index] === issue
    && issue.line === row.line
    && issue.column === row.column
    && issue.offset === row.offset
    && issue.message === row.message
    && issue.rule === row.rule
    && issue.severity === row.severity
  );
}

function useStatusBarControl<T extends HTMLElement>(
  authority: StatusBarAuthority,
  rootRef: RefObject<HTMLElement | null>,
  isCurrentAuthority: IsCurrentAuthority,
) {
  const controlRef = useRef<T>(null);
  const publicationRef = useRef<StatusBarControlPublication<T> | null>(null);

  useLayoutEffect(() => {
    const root = rootRef.current;
    const control = controlRef.current;
    if (!root || !control) {
      publicationRef.current = null;
      return;
    }
    const publication: StatusBarControlPublication<T> = {
      authority,
      root,
      control,
      claimed: false,
    };
    publicationRef.current = publication;
    return () => {
      if (publicationRef.current === publication) publicationRef.current = null;
    };
  }, [authority, rootRef]);

  const claim = useCallback(() => {
    const publication = publicationRef.current;
    if (
      !publication
      || publication.authority !== authority
      || publication.claimed
      || !isCurrentAuthority(authority)
      || rootRef.current !== publication.root
      || controlRef.current !== publication.control
    )
      return false;
    publication.claimed = true;
    return true;
  }, [authority, isCurrentAuthority, rootRef]);

  return [controlRef, claim] as const;
}

function StatusBarMenuControls({
  authority,
  rootRef,
  isCurrentAuthority,
}: {
  authority: StatusBarAuthority;
  rootRef: RefObject<HTMLElement | null>;
  isCurrentAuthority: IsCurrentAuthority;
}) {
  const [layoutRef, claimLayout] = useStatusBarControl<HTMLDivElement>(authority, rootRef, isCurrentAuthority);
  const [wrappingRef, claimWrapping] = useStatusBarControl<HTMLDivElement>(authority, rootRef, isCurrentAuthority);
  const [syncScrollRef, claimSyncScroll] = useStatusBarControl<HTMLDivElement>(authority, rootRef, isCurrentAuthority);
  const [themeRef, claimTheme] = useStatusBarControl<HTMLDivElement>(authority, rootRef, isCurrentAuthority);
  const [shortcutsRef, claimShortcuts] = useStatusBarControl<HTMLDivElement>(authority, rootRef, isCurrentAuthority);

  const selectLayout = useCallback((value: string) => {
    const next = authority.layoutValues.find((candidate) => candidate === value);
    if (!next || next === authority.layout || !claimLayout()) return;
    authority.onLayout(next);
  }, [authority, claimLayout]);

  const changeWrapping = useCallback((value: boolean | "indeterminate") => {
    if (typeof value !== "boolean" || value === authority.lineWrapping || !claimWrapping()) return;
    authority.onLineWrapping(value);
  }, [authority, claimWrapping]);

  const changeSyncScroll = useCallback((value: boolean | "indeterminate") => {
    if (typeof value !== "boolean" || value === authority.syncScroll || !claimSyncScroll()) return;
    authority.onSyncScroll(value);
  }, [authority, claimSyncScroll]);

  const selectTheme = useCallback((value: string) => {
    if (
      !isThemePreference(value)
      || !THEME_ORDER.includes(value)
      || value === authority.themePreference
      || !claimTheme()
    )
      return;
    authority.setThemePreference(value);
  }, [authority, claimTheme]);

  return (
    <>
      <MenuLabel>View</MenuLabel>
      <MenuRadioGroup ref={layoutRef} value={authority.layout} onValueChange={selectLayout}>
        {!authority.compact && (
          <MenuRadioItem value="split">
            <span className="inline-flex items-center gap-2">
              <Columns2 size={14} /> Code and preview
            </span>
          </MenuRadioItem>
        )}
        <MenuRadioItem value="code">
          <span className="inline-flex items-center gap-2">
            <Code2 size={14} /> Code only
          </span>
        </MenuRadioItem>
        <MenuRadioItem value="rich">
          <span className="inline-flex items-center gap-2">
            <Eye size={14} /> Preview only
          </span>
        </MenuRadioItem>
      </MenuRadioGroup>
      <MenuSeparator />
      <MenuCheckboxItem ref={wrappingRef} checked={authority.lineWrapping} onCheckedChange={changeWrapping}>
        <span className="inline-flex items-center gap-2">
          <WrapText size={14} /> Wrap long lines
        </span>
      </MenuCheckboxItem>
      <MenuCheckboxItem ref={syncScrollRef} checked={authority.syncScroll} onCheckedChange={changeSyncScroll} data-testid="sync-scroll-toggle">
        <span className="inline-flex items-center gap-2">
          <ArrowUpDown size={14} /> Sync scrolling
        </span>
      </MenuCheckboxItem>
      {authority.compact && (
        <>
          <MenuSeparator />
          <MenuLabel>Theme</MenuLabel>
          <MenuRadioGroup ref={themeRef} value={authority.themePreference} onValueChange={selectTheme}>
            {THEME_ORDER.map((theme) => (
              <MenuRadioItem key={theme} value={theme} data-testid={`menu-theme-${theme}`}>
                {themeLabel(theme)}
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
          <MenuSeparator />
          <MenuItem
            ref={shortcutsRef}
            icon={<CircleHelp size={15} />}
            onSelect={() => {
              if (claimShortcuts()) authority.onShortcuts();
            }}
          >
            Help and shortcuts
          </MenuItem>
        </>
      )}
      {!authority.compact && (
        <>
          <MenuSeparator />
          <MenuLabel>Flavor</MenuLabel>
          <div className="px-2.5 pb-2 text-xs text-ink-3">GitHub Flavored Markdown (tables, task lists, footnotes, strikethrough).</div>
        </>
      )}
    </>
  );
}

function StatusBarIssueRow({
  authority,
  row,
  rootRef,
  isCurrentAuthority,
}: {
  authority: StatusBarAuthority;
  row: StatusBarIssuePublication;
  rootRef: RefObject<HTMLElement | null>;
  isCurrentAuthority: IsCurrentAuthority;
}) {
  const [buttonRef, claim] = useStatusBarControl<HTMLButtonElement>(authority, rootRef, isCurrentAuthority);
  return (
    <button
      ref={buttonRef}
      type="button"
      className="flex w-full items-start gap-2 px-3 py-1.5 text-left text-[13px] hover:bg-surface-3"
      onClick={() => {
        if (!issuePublicationIsExact(authority, row) || !claim()) return;
        authority.onIssueSelect(row.issue);
      }}
    >
      <span className={cn("mt-0.5 h-2 w-2 shrink-0 rounded-full", row.severity === "error" ? "bg-danger" : "bg-warning")} />
      <span className="flex-1 text-ink-2">{row.message}</span>
      <span className="shrink-0 font-mono text-xs text-ink-4">L{row.line}</span>
    </button>
  );
}

export const StatusBar = memo(function StatusBar({ session, doc, layout, onLayout, lineWrapping, onLineWrapping, syncScroll, onSyncScroll, onIssueSelect, onShortcuts, onStorage, compact = false }: StatusBarProps) {
  // Linting walks the document and statistics count it: wait for a pause in typing. The tree is the
  // binding's incrementally maintained parse, so no second parse of the document happens here.
  const { text: source, tree } = useDebouncedSessionValue(session, (s) => s.binding.getTree(), 500, (a, b) => a.text === b.text);
  // The server renders an empty session; by the time this part of the page hydrates the client
  // may already hold the local copy. Show placeholders until hydrated so the markup matches.
  const hydrated = useHydrated();
  const issues = useMemo(() => (hydrated ? lintMarkdown(source, tree) : []), [hydrated, source, tree]);
  const selection = useLocalSelection(session);
  const errors = issues.filter((i) => i.severity === "error").length;

  const [themePreference, setThemePreference] = useTheme();
  const [mount] = useState(() => Symbol("status-bar"));
  const documentValue = doc;
  const documentStorage = doc.storage;
  const documentRepoBranch = doc.repoBranch;
  const documentRepoOwner = doc.repoOwner;
  const documentRepoName = doc.repoName;
  const documentRepoPath = doc.repoPath;
  const documentGistId = doc.gistId;
  const documentHasUnpublishedChanges = doc.hasUnpublishedChanges;
  const documentPublication = useMemo<StatusBarDocumentPublication>(() => ({
    value: documentValue,
    storage: documentStorage,
    repoBranch: documentRepoBranch,
    repoOwner: documentRepoOwner,
    repoName: documentRepoName,
    repoPath: documentRepoPath,
    gistId: documentGistId,
    hasUnpublishedChanges: documentHasUnpublishedChanges,
  }), [
    documentGistId,
    documentHasUnpublishedChanges,
    documentRepoBranch,
    documentRepoName,
    documentRepoOwner,
    documentRepoPath,
    documentStorage,
    documentValue,
  ]);
  const authority = useMemo<StatusBarAuthority>(() => ({
    mount,
    session,
    source,
    tree,
    document: documentPublication,
    layout,
    layoutValues: compact ? COMPACT_LAYOUTS : DESKTOP_LAYOUTS,
    onLayout,
    lineWrapping,
    onLineWrapping,
    syncScroll,
    onSyncScroll,
    compact,
    hydrated,
    issueSnapshot: issues,
    issueRows: issues.map((issue, index) => ({
      snapshot: issues,
      issue,
      index,
      line: issue.line,
      column: issue.column,
      offset: issue.offset,
      message: issue.message,
      rule: issue.rule,
      severity: issue.severity,
    })),
    onIssueSelect,
    onShortcuts,
    onStorage,
    themePreference,
    setThemePreference,
  }), [
    compact,
    documentPublication,
    hydrated,
    issues,
    layout,
    lineWrapping,
    mount,
    onIssueSelect,
    onLayout,
    onLineWrapping,
    onShortcuts,
    onStorage,
    onSyncScroll,
    session,
    setThemePreference,
    source,
    syncScroll,
    themePreference,
    tree,
  ]);
  const rootRef = useRef<HTMLElement>(null);
  const menuTriggerRef = useRef<HTMLButtonElement>(null);
  const issuesTriggerRef = useRef<HTMLButtonElement>(null);
  const rootPublicationRef = useRef<StatusBarRootPublication | null>(null);
  const menuIntentRef = useRef<StatusBarAuthority | null>(null);
  const issuesIntentRef = useRef<StatusBarAuthority | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [issuesOpen, setIssuesOpen] = useState(false);

  useLayoutEffect(() => {
    const root = rootRef.current;
    const menuTrigger = menuTriggerRef.current;
    const issuesTrigger = compact ? null : issuesTriggerRef.current;
    if (!root || !menuTrigger || (!compact && !issuesTrigger)) {
      rootPublicationRef.current = null;
      return;
    }
    const publication = { authority, root, menuTrigger, issuesTrigger };
    rootPublicationRef.current = publication;
    if (menuIntentRef.current !== authority) menuIntentRef.current = null;
    if (issuesIntentRef.current !== authority) issuesIntentRef.current = null;
    return () => {
      if (rootPublicationRef.current === publication) rootPublicationRef.current = null;
      if (menuIntentRef.current === authority) menuIntentRef.current = null;
      if (issuesIntentRef.current === authority) issuesIntentRef.current = null;
    };
  }, [authority, compact]);

  const isCurrentAuthority = useCallback((candidate: StatusBarAuthority) => {
    const publication = rootPublicationRef.current;
    return (
      publication?.authority === candidate
      && rootRef.current === publication.root
      && menuTriggerRef.current === publication.menuTrigger
      && (candidate.compact
        ? publication.issuesTrigger === null
        : issuesTriggerRef.current === publication.issuesTrigger)
      && documentPublicationIsExact(candidate.document)
    );
  }, []);

  const authorizeMenuChange = useCallback(() => {
    if (isCurrentAuthority(authority)) menuIntentRef.current = authority;
  }, [authority, isCurrentAuthority]);

  const authorizeIssuesChange = useCallback(() => {
    if (isCurrentAuthority(authority)) issuesIntentRef.current = authority;
  }, [authority, isCurrentAuthority]);

  const changeMenuOpen = useCallback((open: boolean) => {
    const publication = rootPublicationRef.current;
    if (
      publication?.authority !== authority
      || publication.menuTrigger !== menuTriggerRef.current
      || menuIntentRef.current !== authority
      || !isCurrentAuthority(authority)
    )
      return;
    menuIntentRef.current = null;
    setMenuOpen((current) => {
      if (!isCurrentAuthority(authority) || current === open) return current;
      return open;
    });
  }, [authority, isCurrentAuthority]);

  const changeIssuesOpen = useCallback((open: boolean) => {
    const publication = rootPublicationRef.current;
    if (
      publication?.authority !== authority
      || !publication.issuesTrigger
      || publication.issuesTrigger !== issuesTriggerRef.current
      || issuesIntentRef.current !== authority
      || !isCurrentAuthority(authority)
    )
      return;
    issuesIntentRef.current = null;
    setIssuesOpen((current) => {
      if (!isCurrentAuthority(authority) || current === open) return current;
      return open;
    });
  }, [authority, isCurrentAuthority]);

  const [storageRef, claimStorage] = useStatusBarControl<HTMLButtonElement>(authority, rootRef, isCurrentAuthority);
  const [desktopShortcutsRef, claimDesktopShortcuts] = useStatusBarControl<HTMLButtonElement>(authority, rootRef, isCurrentAuthority);
  const document = authority.document;
  const storageLabel =
    document.storage === "repo" ? (document.repoBranch ?? "main") : document.storage === "gist" ? "gist" : "local";
  const StorageIcon = document.storage === "repo" ? GitBranch : document.storage === "gist" ? GitHubIcon : HardDrive;

  return (
    <footer ref={rootRef} className={STATUS_BOX} data-testid="status-bar" data-compact={compact || undefined}>
      <StatsPopover session={session} source={source} selection={selection} hydrated={hydrated} />
      <div className="flex-1" />

      {/* One trigger for both layouts: `compact` is false on the server and during hydration, so the phone
          form (32 px ⋯ icon, last in the row) comes from `max-md:`/`md:` classes and nothing moves when
          `compact` flips (#1531). The menu's contents still branch on `compact` — a portal, not first paint. */}
      <Menu open={menuOpen} onOpenChange={changeMenuOpen}>
        <MenuTrigger asChild>
          <button
            ref={menuTriggerRef}
            type="button"
            className="inline-flex h-8 w-8 items-center justify-center rounded-md hover:bg-surface-3 hover:text-ink max-md:order-last max-md:text-ink-2 max-md:transition-colors md:h-7 md:w-auto md:gap-1 md:px-2"
            aria-label={compact ? "View options" : undefined}
            onPointerDownCapture={authorizeMenuChange}
            onKeyDownCapture={authorizeMenuChange}
            onPointerDown={authorizeMenuChange}
            onKeyDown={authorizeMenuChange}
            data-testid="layout-menu"
          >
            {/* The phone name from the first byte: `compact` (and so `aria-label`) is false until hydration, and the
                visible "Markdown" text is `max-md:hidden` — without this the server markup has an unnamed button for ≈ 1 s.
                After hydration `aria-label` wins; from `md` the span is hidden and the visible text is the name (#1562). */}
            <span className="sr-only md:hidden">View options</span>
            <span className="inline-flex md:hidden">
              <MoreHorizontal size={18} />
            </span>
            <span className="inline-flex items-center gap-1 max-md:hidden">
              Markdown
              <ChevronDown size={14} />
            </span>
          </button>
        </MenuTrigger>
        <MenuContent
          align="end"
          className="w-60"
          onPointerDownCapture={authorizeMenuChange}
          onKeyDownCapture={authorizeMenuChange}
          onPointerDownOutside={authorizeMenuChange}
          onFocusOutside={authorizeMenuChange}
          onEscapeKeyDown={authorizeMenuChange}
        >
          <StatusBarMenuControls authority={authority} rootRef={rootRef} isCurrentAuthority={isCurrentAuthority} />
        </MenuContent>
      </Menu>

      {/* Desktop-only controls: hidden by CSS below `md` from the first paint, unmounted once `compact` is known
          (mobile.spec.ts asserts they are absent, not merely hidden). */}
      {compact ? null : (
      <Popover open={issuesOpen} onOpenChange={changeIssuesOpen}>
        <PopoverTrigger asChild>
          <button
            ref={issuesTriggerRef}
            type="button"
            className={cn("inline-flex h-7 items-center gap-1.5 rounded-md px-2 hover:bg-surface-3 max-md:hidden", issues.length ? (errors ? "text-danger" : "text-warning") : "text-ink-3 hover:text-ink")}
            onClickCapture={authorizeIssuesChange}
            onClick={authorizeIssuesChange}
            data-testid="issues-button"
          >
            {issues.length ? <AlertTriangle size={14} /> : <Check size={14} />}
            {issues.length === 0 ? "No issues" : `${issues.length} ${issues.length === 1 ? "issue" : "issues"}`}
          </button>
        </PopoverTrigger>
        <PopoverContent
          align="end"
          className="w-80 p-0"
          onPointerDownOutside={authorizeIssuesChange}
          onFocusOutside={authorizeIssuesChange}
          onEscapeKeyDown={authorizeIssuesChange}
        >
          <div className="border-b border-line px-3 py-2 text-xs font-semibold uppercase tracking-wider text-ink-3">Markdown issues</div>
          {issues.length === 0 ? (
            <div className="px-3 py-4 text-sm text-ink-3">Everything looks good.</div>
          ) : (
            <ul className="scrollbar-thin max-h-72 overflow-y-auto py-1">
              {authority.issueRows.map((row) => (
                <li key={row.index}>
                  <StatusBarIssueRow
                    authority={authority}
                    row={row}
                    rootRef={rootRef}
                    isCurrentAuthority={isCurrentAuthority}
                  />
                </li>
              ))}
            </ul>
          )}
        </PopoverContent>
      </Popover>
      )}

      {/* Rendered once for both layouts (32 px tall on phones, 28 px from `md`), so it is already in place at first paint. */}
      <button
        ref={storageRef}
        type="button"
        className="inline-flex h-8 items-center gap-1.5 rounded-md px-2 hover:bg-surface-3 hover:text-ink md:h-7"
        onClick={authority.onStorage ? () => {
          if (claimStorage()) authority.onStorage?.();
        } : undefined}
        disabled={!authority.onStorage}
        title={document.storage === "repo" ? `${document.repoOwner}/${document.repoName}: ${document.repoPath}` : document.storage === "gist" ? `Gist ${document.gistId}` : "Stored in Markdoc"}
        data-testid="storage-indicator"
      >
        <StorageIcon size={14} />
        {storageLabel}
        {document.hasUnpublishedChanges && document.storage !== "local" && <span className="h-1.5 w-1.5 rounded-full bg-warning" title="Unpublished changes" />}
      </button>

      {compact ? null : (
        <>
          <ThemeToggle className="h-7 w-7 max-md:hidden" />
          <button
            ref={desktopShortcutsRef}
            type="button"
            className="icon-btn h-7 w-7 max-md:hidden"
            onClick={() => {
              if (claimDesktopShortcuts()) authority.onShortcuts();
            }}
            aria-label="Help and shortcuts"
          >
            <CircleHelp size={16} />
          </button>
        </>
      )}
    </footer>
  );
});
