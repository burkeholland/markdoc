"use client";
import { Menu, MenuCheckboxItem, MenuContent, MenuItem, MenuLabel, MenuRadioGroup, MenuRadioItem, MenuSeparator, MenuTrigger, Popover, PopoverContent, PopoverTrigger } from "@/components/ui/primitives";
import { GitHubIcon } from "@/components/ui/github-icon";

import { memo, useCallback, useLayoutEffect, useMemo, useRef, useState, type MutableRefObject, type ReactNode, type RefObject } from "react";
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

interface StatusBarValueIntent<T> {
  authority: StatusBarAuthority;
  value: T;
  claim: () => boolean;
}

interface StatusBarDisclosureIntent {
  authority: StatusBarAuthority;
  prove: () => boolean;
}

type IsCurrentAuthority = (authority: StatusBarAuthority) => boolean;
type EventWithCurrentTarget = { currentTarget: EventTarget | null };

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
  // Portal controls attach after their wrapper's first layout pass, so attachment itself must
  // republish before a Radix callback can prove which concrete element produced the interaction.
  const [control, setControl] = useState<T | null>(null);
  const publicationRef = useRef<StatusBarControlPublication<T> | null>(null);

  useLayoutEffect(() => {
    const root = rootRef.current;
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
  }, [authority, control, rootRef]);

  const createProof = useCallback((source: EventTarget | null) => {
    const publication = publicationRef.current;
    if (
      !publication
      || publication.authority !== authority
      || !isCurrentAuthority(authority)
      || rootRef.current !== publication.root
      || control !== publication.control
      || source !== publication.control
      || !publication.root.isConnected
      || !publication.control.isConnected
    )
      return null;
    return () => (
      publicationRef.current === publication
      && publication.authority === authority
      && isCurrentAuthority(authority)
      && rootRef.current === publication.root
      && control === publication.control
      && source === publication.control
      && publication.root.isConnected
      && publication.control.isConnected
    );
  }, [authority, control, isCurrentAuthority, rootRef]);

  const createClaim = useCallback((source: EventTarget | null) => {
    const publication = publicationRef.current;
    const prove = createProof(source);
    if (!publication || !prove || publication.claimed) return null;
    return () => {
      if (publication.claimed || !prove()) return false;
      publication.claimed = true;
      return true;
    };
  }, [createProof]);

  const claim = useCallback((source: EventTarget | null) => {
    const claimPublication = createClaim(source);
    return claimPublication?.() ?? false;
  }, [createClaim]);

  return [setControl, claim, createClaim, createProof, control] as const;
}

function useStatusBarIntent<T>(authority: StatusBarAuthority) {
  const intentRef = useRef<StatusBarValueIntent<T> | null>(null);
  useLayoutEffect(() => {
    if (intentRef.current?.authority !== authority) intentRef.current = null;
    return () => {
      if (intentRef.current?.authority === authority) intentRef.current = null;
    };
  }, [authority]);
  return intentRef;
}

function useStatusBarClaim(authority: StatusBarAuthority) {
  const claimedRef = useRef<StatusBarAuthority | null>(null);
  useLayoutEffect(() => {
    if (claimedRef.current !== authority) claimedRef.current = null;
    return () => {
      if (claimedRef.current === authority) claimedRef.current = null;
    };
  }, [authority]);
  return useCallback(() => {
    if (claimedRef.current === authority) return false;
    claimedRef.current = authority;
    return true;
  }, [authority]);
}

function StatusBarRadioItem({
  authority,
  rootRef,
  isCurrentAuthority,
  intentRef,
  value,
  eligible,
  children,
  testId,
}: {
  authority: StatusBarAuthority;
  rootRef: RefObject<HTMLElement | null>;
  isCurrentAuthority: IsCurrentAuthority;
  intentRef: MutableRefObject<StatusBarValueIntent<string> | null>;
  value: string;
  eligible: boolean;
  children: ReactNode;
  testId?: string;
}) {
  const [itemRef, , createClaim] = useStatusBarControl<HTMLDivElement>(authority, rootRef, isCurrentAuthority);
  const authorize = useCallback((event: EventWithCurrentTarget) => {
    if (!eligible) return;
    const claim = createClaim(event.currentTarget);
    if (claim) intentRef.current = { authority, value, claim };
  }, [authority, createClaim, eligible, intentRef, value]);

  return (
    <MenuRadioItem ref={itemRef} value={value} onSelect={authorize} data-testid={testId}>
      {children}
    </MenuRadioItem>
  );
}

function StatusBarCheckboxControl({
  authority,
  rootRef,
  isCurrentAuthority,
  checked,
  children,
  testId,
  onChange,
}: {
  authority: StatusBarAuthority;
  rootRef: RefObject<HTMLElement | null>;
  isCurrentAuthority: IsCurrentAuthority;
  checked: boolean;
  children: ReactNode;
  testId?: string;
  onChange: (value: boolean) => void;
}) {
  const [itemRef, , createClaim] = useStatusBarControl<HTMLDivElement>(authority, rootRef, isCurrentAuthority);
  const intentRef = useStatusBarIntent<boolean>(authority);
  const next = !checked;
  const authorize = useCallback((event: EventWithCurrentTarget) => {
    const claim = createClaim(event.currentTarget);
    if (claim) intentRef.current = { authority, value: next, claim };
  }, [authority, createClaim, intentRef, next]);
  const change = useCallback((value: boolean | "indeterminate") => {
    const intent = intentRef.current;
    if (intent?.authority === authority) intentRef.current = null;
    if (
      typeof value !== "boolean"
      || value !== next
      || intent?.authority !== authority
      || intent.value !== value
      || !intent.claim()
    )
      return;
    onChange(value);
  }, [authority, intentRef, next, onChange]);

  return (
    <MenuCheckboxItem
      ref={itemRef}
      checked={checked}
      onSelect={authorize}
      onCheckedChange={change}
      data-testid={testId}
    >
      {children}
    </MenuCheckboxItem>
  );
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
  const layoutIntentRef = useStatusBarIntent<string>(authority);
  const themeIntentRef = useStatusBarIntent<string>(authority);
  const claimLayout = useStatusBarClaim(authority);
  const claimTheme = useStatusBarClaim(authority);
  const [shortcutsRef, claimShortcuts] = useStatusBarControl<HTMLDivElement>(authority, rootRef, isCurrentAuthority);

  const selectLayout = useCallback((value: string) => {
    const next = authority.layoutValues.find((candidate) => candidate === value);
    const intent = layoutIntentRef.current;
    if (intent?.authority === authority) layoutIntentRef.current = null;
    if (
      !next
      || next === authority.layout
      || intent?.authority !== authority
      || intent.value !== next
      || !intent.claim()
      || !claimLayout()
    )
      return;
    authority.onLayout(next);
  }, [authority, claimLayout, layoutIntentRef]);

  const selectTheme = useCallback((value: string) => {
    const intent = themeIntentRef.current;
    if (intent?.authority === authority) themeIntentRef.current = null;
    if (
      !isThemePreference(value)
      || !THEME_ORDER.includes(value)
      || value === authority.themePreference
      || intent?.authority !== authority
      || intent.value !== value
      || !intent.claim()
      || !claimTheme()
    )
      return;
    authority.setThemePreference(value);
  }, [authority, claimTheme, themeIntentRef]);

  return (
    <>
      <MenuLabel>View</MenuLabel>
      <MenuRadioGroup value={authority.layout} onValueChange={selectLayout}>
        {!authority.compact && (
          <StatusBarRadioItem
            authority={authority}
            rootRef={rootRef}
            isCurrentAuthority={isCurrentAuthority}
            intentRef={layoutIntentRef}
            value="split"
            eligible={authority.layout !== "split"}
          >
            <span className="inline-flex items-center gap-2">
              <Columns2 size={14} /> Code and preview
            </span>
          </StatusBarRadioItem>
        )}
        <StatusBarRadioItem
          authority={authority}
          rootRef={rootRef}
          isCurrentAuthority={isCurrentAuthority}
          intentRef={layoutIntentRef}
          value="code"
          eligible={authority.layout !== "code"}
        >
          <span className="inline-flex items-center gap-2">
            <Code2 size={14} /> Code only
          </span>
        </StatusBarRadioItem>
        <StatusBarRadioItem
          authority={authority}
          rootRef={rootRef}
          isCurrentAuthority={isCurrentAuthority}
          intentRef={layoutIntentRef}
          value="rich"
          eligible={authority.layout !== "rich"}
        >
          <span className="inline-flex items-center gap-2">
            <Eye size={14} /> Preview only
          </span>
        </StatusBarRadioItem>
      </MenuRadioGroup>
      <MenuSeparator />
      <StatusBarCheckboxControl
        authority={authority}
        rootRef={rootRef}
        isCurrentAuthority={isCurrentAuthority}
        checked={authority.lineWrapping}
        onChange={authority.onLineWrapping}
      >
        <span className="inline-flex items-center gap-2">
          <WrapText size={14} /> Wrap long lines
        </span>
      </StatusBarCheckboxControl>
      <StatusBarCheckboxControl
        authority={authority}
        rootRef={rootRef}
        isCurrentAuthority={isCurrentAuthority}
        checked={authority.syncScroll}
        onChange={authority.onSyncScroll}
        testId="sync-scroll-toggle"
      >
        <span className="inline-flex items-center gap-2">
          <ArrowUpDown size={14} /> Sync scrolling
        </span>
      </StatusBarCheckboxControl>
      {authority.compact && (
        <>
          <MenuSeparator />
          <MenuLabel>Theme</MenuLabel>
          <MenuRadioGroup value={authority.themePreference} onValueChange={selectTheme}>
            {THEME_ORDER.map((theme) => (
              <StatusBarRadioItem
                key={theme}
                authority={authority}
                rootRef={rootRef}
                isCurrentAuthority={isCurrentAuthority}
                intentRef={themeIntentRef}
                value={theme}
                eligible={authority.themePreference !== theme}
                testId={`menu-theme-${theme}`}
              >
                {themeLabel(theme)}
              </StatusBarRadioItem>
            ))}
          </MenuRadioGroup>
          <MenuSeparator />
          <MenuItem
            ref={shortcutsRef}
            icon={<CircleHelp size={15} />}
            onSelect={(event) => {
              if (claimShortcuts(event.currentTarget)) authority.onShortcuts();
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
      onClick={(event) => {
        if (!issuePublicationIsExact(authority, row) || !claim(event.currentTarget)) return;
        authority.onIssueSelect(row.issue);
      }}
    >
      <span className={cn("mt-0.5 h-2 w-2 shrink-0 rounded-full", row.severity === "error" ? "bg-danger" : "bg-warning")} />
      <span className="flex-1 text-ink-2">{row.message}</span>
      <span className="shrink-0 font-mono text-xs text-ink-4">L{row.line}</span>
    </button>
  );
}

function StatusBarMenuContent({
  authority,
  rootRef,
  isCurrentAuthority,
  intentRef,
  children,
}: {
  authority: StatusBarAuthority;
  rootRef: RefObject<HTMLElement | null>;
  isCurrentAuthority: IsCurrentAuthority;
  intentRef: MutableRefObject<StatusBarDisclosureIntent | null>;
  children: ReactNode;
}) {
  const [setContent, , , createProof, content] = useStatusBarControl<HTMLDivElement>(authority, rootRef, isCurrentAuthority);
  const authorize = useCallback((event: EventWithCurrentTarget) => {
    const prove = createProof(event.currentTarget);
    if (prove) intentRef.current = { authority, prove };
  }, [authority, createProof, intentRef]);
  const authorizeOutside = useCallback((event: CustomEvent<{ originalEvent: Event }>) => {
    const originalTarget = event.detail?.originalEvent?.target;
    if (
      !originalTarget
      || event.target !== originalTarget
      || event.currentTarget !== originalTarget
      || !(originalTarget instanceof Node)
      || content?.contains(originalTarget)
    )
      return;
    const prove = createProof(content);
    if (prove) intentRef.current = { authority, prove };
  }, [authority, content, createProof, intentRef]);
  const authorizeEscape = useCallback((event: KeyboardEvent) => {
    if (
      event.key !== "Escape"
      || !content
      || event.currentTarget instanceof Element
    )
      return;
    const prove = createProof(content);
    if (prove) intentRef.current = { authority, prove };
  }, [authority, content, createProof, intentRef]);

  return (
    <MenuContent
      ref={setContent}
      align="end"
      className="w-60"
      data-testid="status-menu-content"
      onPointerDownCapture={authorize}
      onKeyDownCapture={authorize}
      onPointerDownOutside={authorizeOutside}
      onFocusOutside={authorizeOutside}
      onEscapeKeyDown={authorizeEscape}
    >
      {children}
    </MenuContent>
  );
}

function StatusBarIssuesContent({
  authority,
  rootRef,
  isCurrentAuthority,
  intentRef,
  children,
}: {
  authority: StatusBarAuthority;
  rootRef: RefObject<HTMLElement | null>;
  isCurrentAuthority: IsCurrentAuthority;
  intentRef: MutableRefObject<StatusBarDisclosureIntent | null>;
  children: ReactNode;
}) {
  const [setContent, , , createProof, content] = useStatusBarControl<HTMLDivElement>(authority, rootRef, isCurrentAuthority);
  const authorize = useCallback((event: EventWithCurrentTarget) => {
    const prove = createProof(event.currentTarget);
    if (prove) intentRef.current = { authority, prove };
  }, [authority, createProof, intentRef]);
  const authorizeOutside = useCallback((event: CustomEvent<{ originalEvent: Event }>) => {
    const originalTarget = event.detail?.originalEvent?.target;
    if (
      !originalTarget
      || event.target !== originalTarget
      || event.currentTarget !== originalTarget
      || !(originalTarget instanceof Node)
      || content?.contains(originalTarget)
    )
      return;
    const prove = createProof(content);
    if (prove) intentRef.current = { authority, prove };
  }, [authority, content, createProof, intentRef]);
  const authorizeEscape = useCallback((event: KeyboardEvent) => {
    if (
      event.key !== "Escape"
      || !content
      || event.currentTarget instanceof Element
    )
      return;
    const prove = createProof(content);
    if (prove) intentRef.current = { authority, prove };
  }, [authority, content, createProof, intentRef]);

  return (
    <PopoverContent
      ref={setContent}
      align="end"
      className="w-80 p-0"
      data-testid="status-issues-content"
      onKeyDownCapture={authorize}
      onPointerDownOutside={authorizeOutside}
      onFocusOutside={authorizeOutside}
      onEscapeKeyDown={authorizeEscape}
    >
      {children}
    </PopoverContent>
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
  const menuIntentRef = useRef<StatusBarDisclosureIntent | null>(null);
  const issuesIntentRef = useRef<StatusBarDisclosureIntent | null>(null);
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
    if (menuIntentRef.current?.authority !== authority) menuIntentRef.current = null;
    if (issuesIntentRef.current?.authority !== authority) issuesIntentRef.current = null;
    return () => {
      if (rootPublicationRef.current === publication) rootPublicationRef.current = null;
      if (menuIntentRef.current?.authority === authority) menuIntentRef.current = null;
      if (issuesIntentRef.current?.authority === authority) issuesIntentRef.current = null;
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

  const createRootControlProof = useCallback((
    source: EventTarget | null,
    control: HTMLButtonElement | null,
  ) => {
    const publication = rootPublicationRef.current;
    if (
      publication?.authority !== authority
      || !control
      || source !== control
      || publication.root !== rootRef.current
      || !publication.root.isConnected
      || !control.isConnected
      || !isCurrentAuthority(authority)
    )
      return null;
    return () => (
      rootPublicationRef.current === publication
      && publication.authority === authority
      && publication.root === rootRef.current
      && source === control
      && publication.root.isConnected
      && control.isConnected
      && isCurrentAuthority(authority)
    );
  }, [authority, isCurrentAuthority]);

  const authorizeMenuChange = useCallback((event: EventWithCurrentTarget) => {
    const prove = createRootControlProof(event.currentTarget, menuTriggerRef.current);
    if (prove) menuIntentRef.current = { authority, prove };
  }, [authority, createRootControlProof]);

  const authorizeIssuesChange = useCallback((event: EventWithCurrentTarget) => {
    const prove = createRootControlProof(event.currentTarget, issuesTriggerRef.current);
    if (prove) issuesIntentRef.current = { authority, prove };
  }, [authority, createRootControlProof]);

  const changeMenuOpen = useCallback((open: boolean) => {
    const publication = rootPublicationRef.current;
    const intent = menuIntentRef.current;
    if (
      publication?.authority !== authority
      || publication.menuTrigger !== menuTriggerRef.current
      || intent?.authority !== authority
      || !intent.prove()
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
    const intent = issuesIntentRef.current;
    if (
      publication?.authority !== authority
      || !publication.issuesTrigger
      || publication.issuesTrigger !== issuesTriggerRef.current
      || intent?.authority !== authority
      || !intent.prove()
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
        <StatusBarMenuContent
          authority={authority}
          rootRef={rootRef}
          isCurrentAuthority={isCurrentAuthority}
          intentRef={menuIntentRef}
        >
          <StatusBarMenuControls authority={authority} rootRef={rootRef} isCurrentAuthority={isCurrentAuthority} />
        </StatusBarMenuContent>
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
        <StatusBarIssuesContent
          authority={authority}
          rootRef={rootRef}
          isCurrentAuthority={isCurrentAuthority}
          intentRef={issuesIntentRef}
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
        </StatusBarIssuesContent>
      </Popover>
      )}

      {/* Rendered once for both layouts (32 px tall on phones, 28 px from `md`), so it is already in place at first paint. */}
      <button
        ref={storageRef}
        type="button"
        className="inline-flex h-8 items-center gap-1.5 rounded-md px-2 hover:bg-surface-3 hover:text-ink md:h-7"
        onClick={authority.onStorage ? (event) => {
          if (claimStorage(event.currentTarget)) authority.onStorage?.();
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
            onClick={(event) => {
              if (claimDesktopShortcuts(event.currentTarget)) authority.onShortcuts();
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
