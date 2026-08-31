"use client";
import { Menu, MenuCheckboxItem, MenuContent, MenuItem, MenuLabel, MenuRadioGroup, MenuRadioItem, MenuSeparator, MenuTrigger, Popover, PopoverContent, PopoverTrigger } from "@/components/ui/primitives";
import { GitHubIcon } from "@/components/ui/github-icon";

import { memo, useMemo } from "react";
import { AlertTriangle, ArrowUpDown, Check, ChevronDown, CircleHelp, GitBranch, HardDrive, Columns2, Code2, Eye, WrapText, MoreHorizontal } from "lucide-react";
import type { CollabSession } from "@/editor/collab/session";
import type { DocumentDto } from "@/server/dto";
import { lintMarkdown, type LintIssue } from "@/editor/markdown/lint";

import { cn } from "@/lib/utils";
import { ThemeToggle, useTheme } from "@/components/ui/theme-toggle";
import { THEME_ORDER, themeLabel, type ThemePreference } from "@/lib/theme";
import { useHydrated } from "@/lib/hooks";
import { useDebouncedSessionValue } from "./use-session";
import { StatsPopover, useLocalSelection } from "./stats-popover";

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

  const storageLabel =
    doc.storage === "repo" ? (doc.repoBranch ?? "main") : doc.storage === "gist" ? "gist" : "local";
  const StorageIcon = doc.storage === "repo" ? GitBranch : doc.storage === "gist" ? GitHubIcon : HardDrive;
  const [themePreference, setThemePreference] = useTheme();

  return (
    <footer className="safe-bottom safe-x box-content flex h-10 shrink-0 items-center gap-1 border-t border-line text-[13px] text-ink-3" data-testid="status-bar" data-compact={compact || undefined}>
      <StatsPopover session={session} source={source} selection={selection} hydrated={hydrated} />
      <div className="flex-1" />

      {compact && (
        <button
          type="button"
          className="inline-flex h-8 items-center gap-1.5 rounded-md px-2 hover:bg-surface-3 hover:text-ink"
          onClick={onStorage}
          disabled={!onStorage}
          title={doc.storage === "repo" ? `${doc.repoOwner}/${doc.repoName}: ${doc.repoPath}` : doc.storage === "gist" ? `Gist ${doc.gistId}` : "Stored in Markdoc"}
          data-testid="storage-indicator"
        >
          <StorageIcon size={14} />
          {storageLabel}
          {doc.hasUnpublishedChanges && doc.storage !== "local" && <span className="h-1.5 w-1.5 rounded-full bg-warning" title="Unpublished changes" />}
        </button>
      )}

      <Menu>
        <MenuTrigger asChild>
          {compact ? (
            <button type="button" className="icon-btn h-8 w-8" aria-label="View options" data-testid="layout-menu">
              <MoreHorizontal size={18} />
            </button>
          ) : (
            <button type="button" className="inline-flex h-7 items-center gap-1 rounded-md px-2 hover:bg-surface-3 hover:text-ink" data-testid="layout-menu">
              Markdown
              <ChevronDown size={14} />
            </button>
          )}
        </MenuTrigger>
        <MenuContent align="end" className="w-60">
          <MenuLabel>View</MenuLabel>
          <MenuRadioGroup value={layout} onValueChange={(v) => onLayout(v as Layout)}>
            {!compact && (
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
          <MenuCheckboxItem checked={lineWrapping} onCheckedChange={(v) => onLineWrapping(!!v)}>
            <span className="inline-flex items-center gap-2">
              <WrapText size={14} /> Wrap long lines
            </span>
          </MenuCheckboxItem>
          <MenuCheckboxItem checked={syncScroll} onCheckedChange={(v) => onSyncScroll(!!v)} data-testid="sync-scroll-toggle">
            <span className="inline-flex items-center gap-2">
              <ArrowUpDown size={14} /> Sync scrolling
            </span>
          </MenuCheckboxItem>
          {compact && (
            <>
              <MenuSeparator />
              <MenuLabel>Theme</MenuLabel>
              <MenuRadioGroup value={themePreference} onValueChange={(v) => setThemePreference(v as ThemePreference)}>
                {THEME_ORDER.map((t) => (
                  <MenuRadioItem key={t} value={t} data-testid={`menu-theme-${t}`}>
                    {themeLabel(t)}
                  </MenuRadioItem>
                ))}
              </MenuRadioGroup>
              <MenuSeparator />
              <MenuItem icon={<CircleHelp size={15} />} onSelect={onShortcuts}>
                Help and shortcuts
              </MenuItem>
            </>
          )}
          {!compact && (
            <>
              <MenuSeparator />
              <MenuLabel>Flavor</MenuLabel>
              <div className="px-2.5 pb-2 text-xs text-ink-3">GitHub Flavored Markdown (tables, task lists, footnotes, strikethrough).</div>
            </>
          )}
        </MenuContent>
      </Menu>

      {compact ? null : (
        <>
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            className={cn("inline-flex h-7 items-center gap-1.5 rounded-md px-2 hover:bg-surface-3", issues.length ? (errors ? "text-danger" : "text-warning") : "text-ink-3 hover:text-ink")}
            data-testid="issues-button"
          >
            {issues.length ? <AlertTriangle size={14} /> : <Check size={14} />}
            {issues.length === 0 ? "No issues" : `${issues.length} ${issues.length === 1 ? "issue" : "issues"}`}
          </button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-80 p-0">
          <div className="border-b border-line px-3 py-2 text-xs font-semibold uppercase tracking-wider text-ink-3">Markdown issues</div>
          {issues.length === 0 ? (
            <div className="px-3 py-4 text-sm text-ink-3">Everything looks good.</div>
          ) : (
            <ul className="scrollbar-thin max-h-72 overflow-y-auto py-1">
              {issues.map((issue, i) => (
                <li key={i}>
                  <button
                    type="button"
                    className="flex w-full items-start gap-2 px-3 py-1.5 text-left text-[13px] hover:bg-surface-3"
                    onClick={() => onIssueSelect(issue)}
                  >
                    <span className={cn("mt-0.5 h-2 w-2 shrink-0 rounded-full", issue.severity === "error" ? "bg-danger" : "bg-warning")} />
                    <span className="flex-1 text-ink-2">{issue.message}</span>
                    <span className="shrink-0 font-mono text-xs text-ink-4">L{issue.line}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </PopoverContent>
      </Popover>

      <button
        type="button"
        className="inline-flex h-7 items-center gap-1.5 rounded-md px-2 hover:bg-surface-3 hover:text-ink"
        onClick={onStorage}
        disabled={!onStorage}
        title={doc.storage === "repo" ? `${doc.repoOwner}/${doc.repoName}: ${doc.repoPath}` : doc.storage === "gist" ? `Gist ${doc.gistId}` : "Stored in Markdoc"}
        data-testid="storage-indicator"
      >
        <StorageIcon size={14} />
        {storageLabel}
        {doc.hasUnpublishedChanges && doc.storage !== "local" && <span className="h-1.5 w-1.5 rounded-full bg-warning" title="Unpublished changes" />}
      </button>
      <ThemeToggle className="h-7 w-7" />
      <button type="button" className="icon-btn h-7 w-7" onClick={onShortcuts} aria-label="Help and shortcuts">
        <CircleHelp size={16} />
      </button>
        </>
      )}
    </footer>
  );
});


