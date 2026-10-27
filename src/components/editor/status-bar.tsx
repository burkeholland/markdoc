"use client";
import { Menu, MenuCheckboxItem, MenuContent, MenuItem, MenuLabel, MenuRadioGroup, MenuRadioItem, MenuSeparator, MenuTrigger, Popover, PopoverContent, PopoverTrigger } from "@/components/ui/primitives";
import { GitHubIcon } from "@/components/ui/github-icon";

import { memo, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { AlertTriangle, ArrowUpDown, Check, ChevronDown, CircleHelp, GitBranch, HardDrive, Columns2, Code2, Eye, WrapText, MoreHorizontal } from "lucide-react";
import type { CollabSession } from "@/editor/collab/session";
import type { DocumentDto } from "@/server/dto";
import { lintMarkdown, type LintIssue } from "@/editor/markdown/lint";

import { cn } from "@/lib/utils";
import { ThemeToggle, useTheme } from "@/components/ui/theme-toggle";
import { isThemePreference, THEME_ORDER, themeLabel } from "@/lib/theme";
import { useHydrated } from "@/lib/hooks";
import { useDebouncedSessionValue } from "./use-session";
import { StatsPopover, useLocalSelection, type SourceSelection } from "./stats-popover";
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

const DESKTOP_LAYOUTS: readonly Layout[] = ["split", "code", "rich"];
const COMPACT_LAYOUTS: readonly Layout[] = ["code", "rich"];

type FocusEdge = "first" | "last";

/** ArrowDown/ArrowUp on a closed disclosure trigger opens it with focus on its first/last entry. */
function directionalEdge(event: KeyboardEvent<HTMLElement>): FocusEdge | null {
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return null;
  return event.key === "ArrowDown" ? "first" : event.key === "ArrowUp" ? "last" : null;
}

function focusEdge(container: HTMLElement, selector: string, edge: FocusEdge): boolean {
  const items = Array.from(container.querySelectorAll<HTMLElement>(selector)).filter((item) => !item.hasAttribute("data-disabled") && !(item as HTMLButtonElement).disabled);
  const target = edge === "first" ? items[0] : items[items.length - 1];
  if (!target) return false;
  target.focus();
  return true;
}

function isVisible(element: HTMLElement) {
  return element.getClientRects().length > 0 || getComputedStyle(element).display !== "none";
}

const StatusBarStatsPopover = memo(function StatusBarStatsPopover(props: { session: CollabSession; source: string; selection: SourceSelection; hydrated: boolean }) {
  return <StatsPopover {...props} />;
});

export const StatusBar = memo(function StatusBar({ session, doc, layout, onLayout, lineWrapping, onLineWrapping, syncScroll, onSyncScroll, onIssueSelect, onShortcuts, onStorage, compact = false }: StatusBarProps) {
  const { text: source, tree } = useDebouncedSessionValue(session, (s) => s.binding.getTree(), 500, (a, b) => a.text === b.text);
  const hydrated = useHydrated();
  const issues = useMemo(() => (hydrated ? lintMarkdown(source, tree) : []), [hydrated, source, tree]);
  const selection = useLocalSelection(session);
  const errors = issues.filter((i) => i.severity === "error").length;
  const [themePreference, setThemePreference] = useTheme();
  const [menuOpen, setMenuOpen] = useState(false);
  const [issuesOpen, setIssuesOpen] = useState(false);
  const menuEdge = useRef<FocusEdge | null>(null);
  const issuesEdge = useRef<FocusEdge | null>(null);
  // Radix's menu content forwards onOpenAutoFocus at runtime, but DropdownMenuContentProps omits it from its type.
  const menuOpenAutoFocus = {
    onOpenAutoFocus: (event: Event) => {
      const edge = menuEdge.current;
      menuEdge.current = null;
      if (edge && focusEdge(event.currentTarget as HTMLElement, '[role^="menuitem"]', edge)) event.preventDefault();
    },
  } as object;
  const layouts = compact ? COMPACT_LAYOUTS : DESKTOP_LAYOUTS;

  const openMenuFromKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    const edge = directionalEdge(event);
    if (!edge || menuOpen) return;
    event.preventDefault();
    menuEdge.current = edge;
    setMenuOpen(true);
  };
  const openIssuesFromKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    const edge = directionalEdge(event);
    if (!edge || issuesOpen) return;
    event.preventDefault();
    issuesEdge.current = edge;
    setIssuesOpen(true);
  };

  // Left/Right, Home and End move focus between the bar's enabled, visible top-level buttons (no wrapping).
  const onBarKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    const footer = event.currentTarget;
    const buttons = Array.from(footer.children)
      .filter((child): child is HTMLButtonElement => child instanceof HTMLButtonElement && !child.disabled && isVisible(child))
      // On phones the ⋯ menu trigger is visually last (`max-md:order-last`), so follow visual order.
      .sort((a, b) => (compact ? Number(a.classList.contains("max-md:order-last")) - Number(b.classList.contains("max-md:order-last")) : 0));
    const index = buttons.indexOf(event.target as HTMLButtonElement);
    if (index < 0) return;
    const destination = event.key === "ArrowLeft" ? index - 1 : event.key === "ArrowRight" ? index + 1 : event.key === "Home" ? 0 : buttons.length - 1;
    if (destination < 0 || destination >= buttons.length || destination === index) return;
    event.preventDefault();
    buttons[destination].focus({ preventScroll: true });
  };

  const storageLabel = doc.storage === "repo" ? (doc.repoBranch ?? "main") : doc.storage === "gist" ? "gist" : "local";
  const StorageIcon = doc.storage === "repo" ? GitBranch : doc.storage === "gist" ? GitHubIcon : HardDrive;

  return (
    <footer className={STATUS_BOX} data-testid="status-bar" data-compact={compact || undefined} onKeyDown={onBarKeyDown}>
      <StatusBarStatsPopover session={session} source={source} selection={selection} hydrated={hydrated} />

      <div className="flex-1" />

      {/* One trigger for both layouts: `compact` is false on the server and during hydration, so the phone
          form (32 px ⋯ icon, last in the row) comes from `max-md:`/`md:` classes and nothing moves when
          `compact` flips (#1531). The menu's contents still branch on `compact` — a portal, not first paint. */}
      <Menu open={menuOpen} onOpenChange={setMenuOpen}>
        <MenuTrigger asChild>
          <button
            type="button"
            className="inline-flex h-8 w-8 items-center justify-center rounded-md hover:bg-surface-3 hover:text-ink max-md:order-last max-md:text-ink-2 max-md:transition-colors md:h-7 md:w-auto md:gap-1 md:px-2"
            aria-label={compact ? "View options" : undefined}
            onKeyDown={openMenuFromKey}
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
          data-testid="status-menu-content"
          {...menuOpenAutoFocus}
        >
          <MenuLabel>View</MenuLabel>
          <MenuRadioGroup
            value={layout}
            onValueChange={(value) => {
              const next = layouts.find((candidate) => candidate === value);
              if (next && next !== layout) onLayout(next);
            }}
          >
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
          <MenuCheckboxItem checked={lineWrapping} onCheckedChange={(checked) => onLineWrapping(checked === true)}>
            <span className="inline-flex items-center gap-2">
              <WrapText size={14} /> Wrap long lines
            </span>
          </MenuCheckboxItem>
          <MenuCheckboxItem checked={syncScroll} onCheckedChange={(checked) => onSyncScroll(checked === true)} data-testid="sync-scroll-toggle">
            <span className="inline-flex items-center gap-2">
              <ArrowUpDown size={14} /> Sync scrolling
            </span>
          </MenuCheckboxItem>
          {compact ? (
            <>
              <MenuSeparator />
              <MenuLabel>Theme</MenuLabel>
              <MenuRadioGroup
                value={themePreference}
                onValueChange={(value) => {
                  if (isThemePreference(value) && value !== themePreference) setThemePreference(value);
                }}
              >
                {THEME_ORDER.map((theme) => (
                  <MenuRadioItem key={theme} value={theme} data-testid={`menu-theme-${theme}`}>
                    {themeLabel(theme)}
                  </MenuRadioItem>
                ))}
              </MenuRadioGroup>
              <MenuSeparator />
              <MenuItem icon={<CircleHelp size={15} />} onSelect={onShortcuts}>
                Help and shortcuts
              </MenuItem>
            </>
          ) : (
            <>
              <MenuSeparator />
              <MenuLabel>Flavor</MenuLabel>
              <div className="px-2.5 pb-2 text-xs text-ink-3">GitHub Flavored Markdown (tables, task lists, footnotes, strikethrough).</div>
            </>
          )}
        </MenuContent>
      </Menu>

      {compact ? null : (
        <Popover open={issuesOpen} onOpenChange={setIssuesOpen}>
          <PopoverTrigger asChild>
            <button
              type="button"
              className={cn("inline-flex h-7 items-center gap-1.5 rounded-md px-2 hover:bg-surface-3 max-md:hidden", issues.length ? (errors ? "text-danger" : "text-warning") : "text-ink-3 hover:text-ink")}
              onKeyDown={openIssuesFromKey}
              data-testid="issues-button"
            >
              {issues.length ? <AlertTriangle size={14} /> : <Check size={14} />}
              {issues.length === 0 ? "No issues" : `${issues.length} ${issues.length === 1 ? "issue" : "issues"}`}
            </button>
          </PopoverTrigger>
          <PopoverContent
            align="end"
            className="w-80 p-0"
            data-testid="status-issues-content"
            onOpenAutoFocus={(event) => {
              const edge = issuesEdge.current;
              issuesEdge.current = null;
              if (edge && focusEdge(event.currentTarget as HTMLElement, "button", edge)) event.preventDefault();
            }}
          >
            <div className="border-b border-line px-3 py-2 text-xs font-semibold uppercase tracking-wider text-ink-3">Markdown issues</div>
            {issues.length === 0 ? (
              <div className="px-3 py-4 text-sm text-ink-3">Everything looks good.</div>
            ) : (
              <ul className="scrollbar-thin max-h-72 overflow-y-auto py-1">
                {issues.map((issue, index) => (
                  <li key={index}>
                    <button
                      type="button"
                      className="flex w-full items-start gap-2 px-3 py-1.5 text-left text-[13px] hover:bg-surface-3"
                      onClick={() => {
                        setIssuesOpen(false);
                        onIssueSelect(issue);
                      }}
                    >
                      <span className={cn("mt-0.5 h-2 w-2 shrink-0 rounded-full", issue.severity === "error" ? "bg-danger" : "bg-warning")} />
                      <span className="min-w-0 flex-1 wrap-anywhere text-ink-2">{issue.message}</span>
                      <span className="shrink-0 font-mono text-xs text-ink-4">L{issue.line}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </PopoverContent>
        </Popover>
      )}

      <button
        type="button"
        className="inline-flex h-8 items-center gap-1.5 rounded-md px-2 hover:bg-surface-3 hover:text-ink md:h-7"
        onClick={onStorage}
        disabled={!onStorage}
        title={doc.storage === "repo" ? `${doc.repoOwner}/${doc.repoName}: ${doc.repoPath}` : doc.storage === "gist" ? `Gist ${doc.gistId}` : "Stored in Markdoc"}
        data-testid="storage-indicator"
      >
        <StorageIcon size={14} />
        {storageLabel}
        {doc.hasUnpublishedChanges && doc.storage !== "local" && <span className="h-1.5 w-1.5 rounded-full bg-warning" title="Unpublished changes" />}
      </button>

      {compact ? null : (
        <>
          <ThemeToggle className="h-7 w-7 max-md:hidden" />
          <button type="button" className="icon-btn h-7 w-7 max-md:hidden" onClick={onShortcuts} aria-label="Help and shortcuts">
            <CircleHelp size={16} />
          </button>
        </>
      )}
    </footer>
  );
});
