"use client";
import { navigateTo } from "@/lib/nav";
import { Avatar, Menu, MenuContent, MenuItem, MenuLabel, MenuRadioGroup, MenuRadioItem, MenuSeparator, MenuTrigger, Tip, GitHubIcon } from "@/components/ui/primitives";

import { memo, useEffect, useRef, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import {
  Activity,
  Check,
  ChevronDown,
  CloudOff,
  Loader2,
  MessageSquare,
  MoreVertical,
  Pencil,
  Share2,
  UserPlus,
  History,
  Download,
  FileCode2,
  FileText,
  Copy,
  Trash2,
  Keyboard,
  ExternalLink,
  AlertTriangle,
  Eye,
  PenLine,
  MessageSquarePlus,
  LogOut,
  ArrowLeft,
  RefreshCw,
  UploadCloud,
  Link2,
} from "lucide-react";
import type { CollabSession, EditMode, SaveState } from "@/editor/collab/session";
import { saveStateLabel } from "@/editor/collab/offline";
import type { DocumentDto } from "@/server/dto";

import { cn, shortcut } from "@/lib/utils";
import { jsonEqual, useSessionValue } from "./use-session";
import { AgentActivityChip } from "./agent-activity";

export function Logo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" width="32" height="32" className={className} aria-hidden>
      <rect x="4" y="2" width="24" height="28" rx="5" fill="#2563eb" />
      <path d="M18 2v8a2 2 0 0 0 2 2h8" fill="#93c5fd" />
      <path d="M10 16h12M10 21h12M10 26h7" stroke="#ffffff" strokeWidth="2.2" strokeLinecap="round" />
    </svg>
  );
}

const noopSubscribe = () => () => {};

function SaveIndicator({ session }: { session: CollabSession }) {
  const liveState = useSessionValue(session, (s) => s.saveState);
  const liveUnsynced = useSessionValue(session, (s) => s.unsyncedChanges);
  const liveRecovered = useSessionValue(session, (s) => s.recovered);
  // The server renders a fresh session ("Connecting…"); an offline client may already have
  // failed to connect by the time React hydrates. Match the server markup first, then switch.
  const hydrated = useSyncExternalStore(noopSubscribe, () => true, () => false);
  const state: SaveState = hydrated ? liveState : "connecting";
  const unsynced = hydrated ? liveUnsynced : 0;
  const recovered = hydrated && liveRecovered;
  const map: Record<SaveState, { icon: React.ReactNode; className: string }> = {
    saved: { icon: <Check size={16} strokeWidth={2.5} />, className: "text-success" },
    saving: { icon: <Loader2 size={16} className="animate-spin" />, className: "text-ink-3" },
    connecting: { icon: <Loader2 size={16} className="animate-spin" />, className: "text-ink-3" },
    reconnecting: { icon: <Loader2 size={16} className="animate-spin" />, className: "text-warning" },
    offline: { icon: <CloudOff size={16} />, className: "text-warning" },
    error: { icon: <AlertTriangle size={16} />, className: "text-danger" },
  };
  const m = map[state];
  const flash = state === "saved" && recovered;
  return (
    <span
      className={cn("inline-flex items-center gap-1.5 rounded-md text-sm font-medium transition-colors", m.className, flash && "save-state-recovered")}
      data-testid="save-state"
      data-state={state}
      data-unsynced={unsynced}
      data-recovered={flash || undefined}
      role="status"
    >
      {m.icon}
      <span>{saveStateLabel(state, unsynced, recovered)}</span>
    </span>
  );
}

function TitleEditor({ session, fallback }: { session: CollabSession; fallback: string }) {
  const title = useSessionValue(session, (s) => s.title || fallback);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);
  const input = useRef<HTMLInputElement>(null);
  const canEdit = session.role === "owner" || session.role === "editor";

  useEffect(() => {
    if (!editing) setDraft(title);
  }, [title, editing]);
  useEffect(() => {
    document.title = `${title} · Markdoc`;
  }, [title]);
  useEffect(() => {
    if (editing) {
      input.current?.focus();
      input.current?.select();
    }
  }, [editing]);

  const commit = () => {
    const next = draft.trim();
    if (next && next !== title) session.setTitle(next);
    setEditing(false);
  };

  if (editing) {
    return (
      <input
        ref={input}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          if (e.key === "Escape") setEditing(false);
        }}
        className="h-9 min-w-[12rem] max-w-[28rem] rounded-lg border border-accent bg-surface px-2 text-[22px] font-semibold text-ink outline-none ring-2 ring-accent/20"
        aria-label="Document title"
        data-testid="title-input"
      />
    );
  }
  return (
    <button
      type="button"
      onClick={() => canEdit && setEditing(true)}
      className={cn("group flex min-w-0 items-center gap-2 rounded-lg px-2 py-1 text-left", canEdit && "hover:bg-surface-3")}
      title={canEdit ? "Rename" : title}
      data-testid="title"
    >
      <span className="truncate text-[22px] font-semibold leading-8 text-ink">{title}</span>
      {canEdit && <Pencil size={15} className="shrink-0 text-ink-4 opacity-0 transition-opacity group-hover:opacity-100" />}
    </button>
  );
}

export function PresenceStack({ session }: { session: CollabSession }) {
  const users = useSessionValue(session, (s) => s.presence(), jsonEqual);
  const shown = users.slice(0, 3);
  const extra = users.length - shown.length;
  return (
    <div className="flex items-center -space-x-2" data-testid="presence">
      {shown.map((u) => (
        <Tip key={u.id} label={u.isLocal ? `${u.name} (you)` : u.name}>
          <span className="inline-flex">
            <Avatar name={u.name} src={u.avatar} color={u.color} size={36} />
          </span>
        </Tip>
      ))}
      {extra > 0 && (
        <Tip label={users.slice(3).map((u) => u.name).join(", ")}>
          <span className="avatar text-[13px]">+{extra}</span>
        </Tip>
      )}
    </div>
  );
}

export function ModeSwitcher({ session }: { session: CollabSession }) {
  const mode = useSessionValue(session, (s) => s.mode);
  const editable = session.role === "owner" || session.role === "editor";
  const icons: Record<EditMode, React.ReactNode> = {
    editing: <PenLine size={15} />,
    suggesting: <MessageSquarePlus size={15} />,
    viewing: <Eye size={15} />,
  };
  const labels: Record<EditMode, string> = { editing: "Editing", suggesting: "Suggesting", viewing: "Viewing" };
  return (
    <Menu>
      <MenuTrigger asChild>
        <button
          type="button"
          className={cn(
            "btn btn-sm gap-1.5 border",
            mode === "suggesting" ? "border-green-200 bg-green-50 text-green-800" : "border-line-2 bg-surface text-ink-2 hover:bg-surface-2",
          )}
          data-testid="mode-switcher"
        >
          {icons[mode]}
          <span>{labels[mode]}</span>
          <ChevronDown size={14} className="text-ink-4" />
        </button>
      </MenuTrigger>
      <MenuContent align="end" className="w-64">
        <MenuRadioGroup value={mode} onValueChange={(v) => session.setMode(v as EditMode)}>
          <MenuRadioItem value="editing" disabled={!editable} description="Edit the document directly">
            Editing
          </MenuRadioItem>
          <MenuRadioItem value="suggesting" disabled={!editable} description="Edits become suggestions others can accept">
            Suggesting
          </MenuRadioItem>
          <MenuRadioItem value="viewing" description="Read or print the final document">
            Viewing
          </MenuRadioItem>
        </MenuRadioGroup>
      </MenuContent>
    </Menu>
  );
}

export type ExportFormat = "md" | "html" | "pdf";

export interface HeaderProps {
  session: CollabSession;
  doc: DocumentDto;
  commentsOpen: boolean;
  onToggleComments: () => void;
  onShare: () => void;
  onPublish: () => void;
  onPublishNow: () => void;
  onPull: () => void;
  onHistory: () => void;
  onActivity: () => void;
  onShortcuts: () => void;
  onDelete: () => void;
  onDownload: (format: ExportFormat, withSuggestions: boolean) => void;
  onCopyMarkdown: () => void;
  onNameVersion: () => void;
  publishing: boolean;
  isOwner: boolean;
  onHome: () => void;
}

export const Header = memo(function Header(props: HeaderProps) {
  const { session, doc } = props;
  const openComments = useSessionValue(session, (s) => s.comments.list().filter((c) => !c.resolved).length);
  const linked = doc.storage !== "local";
  const canEdit = session.role === "owner" || session.role === "editor";

  return (
    <header className="flex h-16 shrink-0 items-center gap-3 border-b border-line px-4" data-testid="header">
      <Link href="/" className="icon-btn h-10 w-10 shrink-0" aria-label="Back to documents" title="All documents">
        <Logo className="h-8 w-8" />
      </Link>
      <div className="flex min-w-0 flex-1 items-center gap-4">
        <TitleEditor session={session} fallback={doc.title} />
        <SaveIndicator session={session} />
      </div>
      <div className="flex shrink-0 items-center gap-3">
        <AgentActivityChip session={session} />
        <ModeSwitcher session={session} />
        <PresenceStack session={session} />
        <button type="button" className="btn btn-outline" onClick={props.onShare} data-testid="share-button">
          <UserPlus size={17} />
          Share
        </button>
        <Tip label={props.commentsOpen ? "Hide comments" : "Show comments"} shortcut={shortcut("Mod-Alt-M")}>
          <button type="button" className="icon-btn relative" onClick={props.onToggleComments} data-active={props.commentsOpen} aria-label="Comments" data-testid="comments-toggle">
            <MessageSquare size={20} />
            {openComments > 0 && (
              <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 text-[10px] font-semibold text-white" data-testid="comments-badge">
                {openComments}
              </span>
            )}
          </button>
        </Tip>
        <Menu>
          <MenuTrigger asChild>
            <button type="button" className="icon-btn" aria-label="More" data-testid="more-menu">
              <MoreVertical size={20} />
            </button>
          </MenuTrigger>
          <MenuContent align="end" className="w-64">
            <MenuItem icon={<History size={15} />} onSelect={props.onHistory}>
              Version history
            </MenuItem>
            <MenuItem icon={<Activity size={15} />} onSelect={props.onActivity} data-testid="menu-activity">
              Activity
            </MenuItem>
            {canEdit && (
              <MenuItem icon={<Pencil size={15} />} onSelect={props.onNameVersion}>
                Name current version
              </MenuItem>
            )}
            <MenuSeparator />
            <MenuItem icon={<Download size={15} />} onSelect={() => props.onDownload("md", false)} data-testid="download-md">
              Download Markdown
            </MenuItem>
            <MenuItem icon={<FileCode2 size={15} />} onSelect={() => props.onDownload("html", false)} data-testid="download-html">
              Download HTML
            </MenuItem>
            <MenuItem icon={<FileText size={15} />} onSelect={() => props.onDownload("pdf", false)} data-testid="download-pdf">
              Download PDF
            </MenuItem>
            <MenuItem icon={<Copy size={15} />} onSelect={props.onCopyMarkdown}>
              Copy Markdown
            </MenuItem>
            <MenuSeparator />
            {linked && doc.githubUrl && (
              <MenuItem icon={<ExternalLink size={15} />} onSelect={() => window.open(doc.githubUrl!, "_blank", "noopener")}>
                Open on GitHub
              </MenuItem>
            )}
            {props.isOwner && (
              <MenuItem icon={<GitHubIcon size={15} />} onSelect={props.onPublish}>
                {linked ? "GitHub connection…" : "Connect to GitHub…"}
              </MenuItem>
            )}
            <MenuItem icon={<Keyboard size={15} />} onSelect={props.onShortcuts}>
              Keyboard shortcuts
            </MenuItem>
            <MenuSeparator />
            <MenuItem icon={<ArrowLeft size={15} />} onSelect={props.onHome}>
              All documents
            </MenuItem>
            <MenuItem icon={<LogOut size={15} />} onSelect={() => navigateTo("/api/auth/signout")}>
              Sign out
            </MenuItem>
            {props.isOwner && (
              <>
                <MenuSeparator />
                <MenuItem icon={<Trash2 size={15} />} className="text-danger" onSelect={props.onDelete}>
                  Delete document
                </MenuItem>
              </>
            )}
          </MenuContent>
        </Menu>
        <Menu>
          <MenuTrigger asChild>
            <button type="button" className="btn btn-primary gap-1.5 pl-4 pr-3" disabled={props.publishing} data-testid="publish-button">
              {props.publishing ? <Loader2 size={16} className="animate-spin" /> : null}
              Publish
              <ChevronDown size={16} className="opacity-80" />
            </button>
          </MenuTrigger>
          <MenuContent align="end" className="w-72">
            {linked ? (
              <>
                <MenuLabel>
                  {doc.storage === "gist" ? "Gist" : `${doc.repoOwner}/${doc.repoName} · ${doc.repoBranch}`}
                </MenuLabel>
                <MenuItem icon={<UploadCloud size={15} />} onSelect={props.onPublishNow} disabled={!canEdit}>
                  {doc.storage === "gist" ? "Update gist" : "Commit to GitHub…"}
                </MenuItem>
                <MenuItem icon={<RefreshCw size={15} />} onSelect={props.onPull} disabled={!canEdit}>
                  Pull latest from GitHub
                </MenuItem>
                {doc.githubUrl && (
                  <MenuItem icon={<ExternalLink size={15} />} onSelect={() => window.open(doc.githubUrl!, "_blank", "noopener")}>
                    Open on GitHub
                  </MenuItem>
                )}
                {props.isOwner && (
                  <>
                    <MenuSeparator />
                    <MenuItem icon={<Link2 size={15} />} onSelect={props.onPublish}>
                      Change connection…
                    </MenuItem>
                  </>
                )}
              </>
            ) : (
              <>
                <MenuLabel>Publish to GitHub</MenuLabel>
                <MenuItem icon={<GitHubIcon size={15} />} onSelect={props.onPublish} disabled={!props.isOwner}>
                  Gist or repository…
                </MenuItem>
                <MenuSeparator />
                <MenuItem icon={<Download size={15} />} onSelect={() => props.onDownload("md", false)}>
                  Download Markdown
                </MenuItem>
                <MenuItem icon={<Share2 size={15} />} onSelect={props.onShare}>
                  Share link…
                </MenuItem>
              </>
            )}
          </MenuContent>
        </Menu>
      </div>
    </header>
  );
});




