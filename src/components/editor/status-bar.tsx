"use client";
import { Menu, MenuCheckboxItem, MenuContent, MenuLabel, MenuRadioGroup, MenuRadioItem, MenuSeparator, MenuTrigger, Popover, PopoverContent, PopoverTrigger, GitHubIcon } from "@/components/ui/primitives";

import { memo, useMemo } from "react";
import { AlertTriangle, ArrowUpDown, Check, ChevronDown, CircleHelp, FileText, GitBranch, HardDrive, Columns2, Code2, Eye, WrapText } from "lucide-react";
import type { CollabSession } from "@/editor/collab/session";
import type { DocumentDto } from "@/server/dto";
import { lintMarkdown, type LintIssue } from "@/editor/markdown/lint";

import { cn, countWords, formatNumber } from "@/lib/utils";
import { useHydrated } from "@/lib/hooks";
import { useDebouncedSessionValue } from "./use-session";

export type Layout = "split" | "code" | "rich";

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
  onStorage: () => void;
  /** Plain text of the rendered document, for word counts (falls back to the source). */
  getRichText: () => string;
}

export const StatusBar = memo(function StatusBar({ session, doc, layout, onLayout, lineWrapping, onLineWrapping, syncScroll, onSyncScroll, onIssueSelect, onShortcuts, onStorage, getRichText }: StatusBarProps) {
  // Linting re-parses the whole document and word counts walk it: wait for a pause in typing.
  const source = useDebouncedSessionValue(session, (s) => s.ytext.toString(), 500);
  // The server renders an empty session; by the time this part of the page hydrates the client
  // may already hold the local copy. Show placeholders until hydrated so the markup matches.
  const hydrated = useHydrated();
  const issues = useMemo(() => (hydrated ? lintMarkdown(source) : []), [hydrated, source]);
  const words = useMemo(() => countWords(getRichText() || source), [getRichText, source]);
  const errors = issues.filter((i) => i.severity === "error").length;

  const storageLabel =
    doc.storage === "repo" ? (doc.repoBranch ?? "main") : doc.storage === "gist" ? "gist" : "local";
  const StorageIcon = doc.storage === "repo" ? GitBranch : doc.storage === "gist" ? GitHubIcon : HardDrive;

  return (
    <footer className="flex h-10 shrink-0 items-center gap-1 border-t border-line px-3 text-[13px] text-ink-3" data-testid="status-bar">
      <span className="inline-flex items-center gap-1.5 px-2">
        <FileText size={14} />
        <span data-testid="word-count">{hydrated ? `${formatNumber(words)} words` : "— words"}</span>
      </span>
      <span className="h-4 w-px bg-line" />
      <span className="px-2" data-testid="char-count">
        {hydrated ? `${formatNumber(source.length)} characters` : "— characters"}
      </span>
      <div className="flex-1" />

      <Menu>
        <MenuTrigger asChild>
          <button type="button" className="inline-flex h-7 items-center gap-1 rounded-md px-2 hover:bg-surface-3 hover:text-ink" data-testid="layout-menu">
            Markdown
            <ChevronDown size={14} />
          </button>
        </MenuTrigger>
        <MenuContent align="end" className="w-60">
          <MenuLabel>View</MenuLabel>
          <MenuRadioGroup value={layout} onValueChange={(v) => onLayout(v as Layout)}>
            <MenuRadioItem value="split">
              <span className="inline-flex items-center gap-2">
                <Columns2 size={14} /> Code and preview
              </span>
            </MenuRadioItem>
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
          <MenuSeparator />
          <MenuLabel>Flavor</MenuLabel>
          <div className="px-2.5 pb-2 text-xs text-ink-3">GitHub Flavored Markdown (tables, task lists, footnotes, strikethrough).</div>
        </MenuContent>
      </Menu>

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
        title={doc.storage === "repo" ? `${doc.repoOwner}/${doc.repoName}: ${doc.repoPath}` : doc.storage === "gist" ? `Gist ${doc.gistId}` : "Stored in Markdoc"}
        data-testid="storage-indicator"
      >
        <StorageIcon size={14} />
        {storageLabel}
        {doc.hasUnpublishedChanges && doc.storage !== "local" && <span className="h-1.5 w-1.5 rounded-full bg-warning" title="Unpublished changes" />}
      </button>
      <button type="button" className="icon-btn h-7 w-7" onClick={onShortcuts} aria-label="Help and shortcuts">
        <CircleHelp size={16} />
      </button>
    </footer>
  );
});



