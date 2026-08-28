"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowLeft, Bot, Check, Copy, ExternalLink, Radio } from "lucide-react";
import type { CollabSession } from "@/editor/collab/session";
import { Popover, PopoverContent, PopoverTrigger, Tip } from "@/components/ui/primitives";
import { api } from "@/lib/api";
import { useCopy } from "@/lib/hooks";
import { AGENT_DOCS_URL } from "@/lib/mcp";
import { cn } from "@/lib/utils";
import { AgentConnectCard, AGENT_CONNECT_DISMISSED_KEY, useOrigin } from "@/components/settings/agent-connect-card";
import { jsonEqual, useSessionValue } from "./use-session";

/**
 * The sentence a person pastes into Copilot CLI (or any MCP client connected to Markdoc) to put their
 * agent into the watch loop for one document: `markdoc_presence` → `markdoc_watch { wait: 55 }` → act on
 * comments, mentions and requests (docs/agents.md "Sit in a document").
 */
export function keepAgentPrompt(doc: { id: string; title: string }): string {
  const title = (doc.title || "Untitled").replace(/"/g, "'");
  return `Sit in the Markdoc document "${title}" (id ${doc.id}): call markdoc_presence active, then loop markdoc_watch with wait 55 and act on comments, mentions and requests until I say stop.`;
}

export const KEEP_AGENT_HINT = "Paste this into Copilot CLI (or any MCP client connected to Markdoc). While it runs, your requests and @mentions reach the agent within a minute.";

function readDismissed(): boolean {
  try {
    return typeof window !== "undefined" && window.localStorage.getItem(AGENT_CONNECT_DISMISSED_KEY) === "1";
  } catch {
    return false;
  }
}

/** The user has at least one API token (null while unknown). Same gate as the Ask-an-agent dialog. */
function useHasTokens(active: boolean): boolean | null {
  const [hasTokens, setHasTokens] = useState<boolean | null>(null);
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    api.tokens
      .list()
      .then((res) => {
        if (!cancelled) setHasTokens(res.tokens.length > 0);
      })
      .catch(() => {
        if (!cancelled) setHasTokens(null);
      });
    return () => {
      cancelled = true;
    };
  }, [active]);
  return hasTokens;
}

export interface KeepAgentHerePanelProps {
  doc: { id: string; title: string };
  /** Where to go to create a token; defaults to /settings#tokens and back. */
  onCreateToken?: () => void;
  /** Renders a back arrow in the heading (the agent pill's menu switches views). */
  onBack?: () => void;
  /** The panel is showing; the token check runs when it becomes true. */
  active?: boolean;
}

/** The "Keep an agent here" contents: the Connect-an-agent card for first-timers, then the sentence and a Copy button. */
export function KeepAgentHerePanel({ doc, onCreateToken, onBack, active = true }: KeepAgentHerePanelProps) {
  const prompt = keepAgentPrompt(doc);
  const pre = useRef<HTMLPreElement>(null);
  const { copy, label, copied } = useCopy(prompt, pre);
  const origin = useOrigin();
  const hasTokens = useHasTokens(active);
  const [dismissed, setDismissed] = useState(true);
  useEffect(() => {
    if (active) setDismissed(readDismissed());
  }, [active]);
  const dismiss = () => {
    setDismissed(true);
    try {
      window.localStorage.setItem(AGENT_CONNECT_DISMISSED_KEY, "1");
    } catch {
      /* private mode */
    }
  };
  const showSetup = hasTokens === false && !dismissed;
  return (
    <div className="flex flex-col gap-3" data-testid="keep-agent-panel">
      <div className="flex items-center gap-1.5">
        {onBack && (
          <button type="button" className="icon-btn -ml-1 h-7 w-7" onClick={onBack} aria-label="Back" data-testid="keep-agent-back">
            <ArrowLeft size={15} />
          </button>
        )}
        <h3 className="flex items-center gap-2 text-sm font-semibold text-ink">
          <Radio size={15} className="text-violet-600" /> Keep an agent here
        </h3>
      </div>
      {showSetup && <AgentConnectCard origin={origin} onDismiss={dismiss} onCreateToken={onCreateToken} className="p-3" />}
      <p className="text-xs leading-5 text-ink-3">Your agent sits in this document and reacts to what people write — Ask-an-agent requests, @mentions and comments reach it without a trip to the terminal.</p>
      <div className="relative">
        <pre ref={pre} className="select-text whitespace-pre-wrap break-words rounded-lg border border-line bg-surface-2 p-3 pb-10 font-sans text-[13px] leading-5 text-ink" data-testid="keep-agent-prompt">
          {prompt}
        </pre>
        <button type="button" className="btn btn-primary btn-sm absolute bottom-2 right-2 gap-1.5" onClick={copy} aria-label="Copy instruction" data-testid="keep-agent-copy">
          {copied ? <Check size={14} /> : <Copy size={14} />}
          {label}
        </button>
      </div>
      <p className="text-xs leading-5 text-ink-3" data-testid="keep-agent-hint">
        {KEEP_AGENT_HINT}
      </p>
      <p className="text-xs leading-5 text-ink-3" data-testid="keep-agent-clients">
        Works with any MCP client: Copilot CLI, VS Code, Claude, Cursor.
      </p>
      <a
        className="inline-flex w-fit items-center gap-1 text-xs font-medium text-accent underline-offset-2 hover:underline"
        href={`${AGENT_DOCS_URL}#sit-in-a-document`}
        target="_blank"
        rel="noreferrer"
        data-testid="keep-agent-docs-link"
      >
        Agent docs <span aria-hidden="true">·</span> Sit in a document <ExternalLink size={13} aria-hidden="true" />
      </a>
    </div>
  );
}

export interface KeepAgentHerePopoverProps {
  doc: { id: string; title: string };
  onCreateToken?: () => void;
  /** The trigger (rendered with `asChild`). */
  children: React.ReactNode;
}

/** A popover anchored to its trigger with the {@link KeepAgentHerePanel} inside (the Ask-an-agent dialog footer). */
export function KeepAgentHerePopover({ doc, onCreateToken, children }: KeepAgentHerePopoverProps) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent align="start" side="top" className="w-[min(94vw,440px)]" aria-label="Keep an agent here" data-testid="keep-agent-popover">
        <KeepAgentHerePanel doc={doc} onCreateToken={onCreateToken} active={open} />
      </PopoverContent>
    </Popover>
  );
}

export interface AgentPillProps {
  session: CollabSession;
  doc: { id: string; title: string };
  onCreateToken?: () => void;
  /** Bumped by the command palette: opens the pill's menu on the "Keep an agent here" view. */
  keepAgentNonce?: number;
}

/**
 * Header pill that says whether an agent is sitting in the document ("Copilot CLI is here") and whose menu
 * leads to "Keep an agent here" — the ready-to-paste sentence that puts one there.
 */
export function AgentPill({ session, doc, onCreateToken, keepAgentNonce = 0 }: AgentPillProps) {
  const title = useSessionValue(session, (s) => s.title || doc.title);
  const agents = useSessionValue(
    session,
    (s) =>
      s
        .presence()
        .filter((u) => u.isAgent)
        .map((u) => ({ id: u.id, name: u.name, status: u.status })),
    jsonEqual,
  );
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<"agents" | "keep">("agents");
  useEffect(() => {
    if (keepAgentNonce > 0) {
      setView("keep");
      setOpen(true);
    }
  }, [keepAgentNonce]);
  const onOpenChange = (o: boolean) => {
    setOpen(o);
    if (!o) setView("agents");
  };
  const here = agents.length > 0;
  const label = !here ? "No agent here" : agents.length === 1 ? `${agents[0].name} is here` : `${agents.length} agents are here`;
  const tip = here ? `${agents.map((a) => a.name).join(", ")} ${agents.length === 1 ? "is" : "are"} sitting in this document` : "No agent is sitting in this document — keep one here to have it react to requests and @mentions";
  const docRef = { id: doc.id, title };
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <Tip label={tip}>
        <PopoverTrigger asChild>
          <button
            type="button"
            className={cn(
              "inline-flex h-9 items-center gap-1.5 rounded-full border px-3 text-xs font-medium transition-colors",
              here ? "border-violet-300 bg-violet-100 text-violet-900 dark:border-violet-800 dark:bg-violet-950 dark:text-violet-200" : "border-line-2 bg-surface text-ink-3 hover:text-ink",
            )}
            data-testid="agent-pill"
            data-present={here ? agents.length : 0}
            aria-label={label}
          >
            <Bot size={14} />
            <span className="max-w-48 truncate">{label}</span>
          </button>
        </PopoverTrigger>
      </Tip>
      <PopoverContent align="end" className={cn("p-3", view === "keep" ? "w-[min(94vw,440px)]" : "w-80")} aria-label="Agents in this document" data-testid="agent-pill-popover">
        {view === "keep" ? (
          <KeepAgentHerePanel doc={docRef} onCreateToken={onCreateToken} onBack={() => setView("agents")} active={open} />
        ) : (
          <div className="flex flex-col gap-2">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-3">{here ? `${agents.length === 1 ? "1 agent" : `${agents.length} agents`} in this document` : "No agent in this document"}</div>
            {!here && (
              <button type="button" className="btn btn-primary w-full justify-center gap-2" onClick={() => setView("keep")} data-testid="keep-agent-here">
                <Radio size={15} /> Keep an agent here
              </button>
            )}
            {here ? (
              <ul className="flex flex-col gap-0.5" data-testid="agent-pill-list">
                {agents.map((a) => (
                  <li key={a.id} className="flex items-center gap-2 rounded-lg px-1 py-1 text-sm" data-testid="agent-pill-item">
                    <span className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-violet-100 text-violet-700 dark:bg-violet-950 dark:text-violet-300">
                      <Bot size={13} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium text-ink">{a.name}</span>
                      <span className="block truncate text-xs text-ink-3">{a.status ?? "here"}</span>
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-xs leading-5 text-ink-3">Put your agent in the watch loop for this document so Ask-an-agent requests, @mentions and comments reach it without you switching to the terminal.</p>
            )}
            {here && (
              <button type="button" className="btn btn-outline btn-sm w-full justify-center gap-1.5" onClick={() => setView("keep")} data-testid="keep-agent-here">
                <Radio size={14} /> Keep an agent here
              </button>
            )}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
