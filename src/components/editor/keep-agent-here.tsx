"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowLeft, Check, Copy, ExternalLink, Radio } from "lucide-react";
import { Dialog, DialogContent, Popover, PopoverContent, PopoverTrigger } from "@/components/ui/primitives";
import { api } from "@/lib/api";
import { useCopy } from "@/lib/hooks";
import { AGENT_DOCS_URL } from "@/lib/mcp";
import { AgentConnectCard, AGENT_CONNECT_DISMISSED_KEY, useOrigin } from "@/components/settings/agent-connect-card";

/**
 * The sentence a person pastes into Copilot CLI (or any MCP client connected to Markdoc) to put their
 * agent into the watch loop for one document: `markdoc_presence` → `markdoc_watch { wait: 55 }` → act on
 * comments, mentions and requests (docs/agents.md "Sit in a document").
 */
export function keepAgentPrompt(doc: { id: string; title: string }): string {
  const title = (doc.title || "Untitled").replace(/"/g, "'");
  return `Sit in the Markdoc document "${title}" (id ${doc.id}): call markdoc_presence active, then loop markdoc_watch with wait 55 and act on comments, mentions and requests until I say stop.`;
}

/** Lead-in above the paste box: what to do with the sentence (Burke's "give them the exact command"). */
export const KEEP_AGENT_HINT = "Paste this into Copilot CLI (or any MCP client connected to Markdoc):";

export const KEEP_AGENT_AFTER = "While it runs, your requests and @mentions reach the agent within a minute.";

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
  /** Renders a back arrow in the heading (a host that switches views). */
  onBack?: () => void;
  /** The panel is showing; the token check runs when it becomes true. */
  active?: boolean;
  /** Drop the panel's own heading (the dialog already has the title). */
  hideHeading?: boolean;
}

/** The "Keep an agent here" contents: the Connect-an-agent card for first-timers, then the sentence and a Copy button. */
export function KeepAgentHerePanel({ doc, onCreateToken, onBack, active = true, hideHeading = false }: KeepAgentHerePanelProps) {
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
      {!hideHeading && (
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
      )}
      {showSetup && <AgentConnectCard origin={origin} onDismiss={dismiss} onCreateToken={onCreateToken} className="p-3" />}
      <p className="text-xs leading-5 text-ink-3">Your agent sits in this document and reacts to what people write — requests, @mentions and comments reach it without a trip to the terminal.</p>
      <p className="text-sm font-medium leading-5 text-ink-2" data-testid="keep-agent-hint">
        {KEEP_AGENT_HINT}
      </p>
      <div className="relative">
        <pre ref={pre} className="select-text whitespace-pre-wrap break-words rounded-lg border border-line bg-surface-2 p-3 pb-10 font-sans text-[13px] leading-5 text-ink" data-testid="keep-agent-prompt">
          {prompt}
        </pre>
        <button type="button" className="btn btn-primary btn-sm absolute bottom-2 right-2 gap-1.5" onClick={copy} aria-label="Copy instruction" data-testid="keep-agent-copy">
          {copied ? <Check size={14} /> : <Copy size={14} />}
          {label}
        </button>
      </div>
      <p className="text-xs leading-5 text-ink-3" data-testid="keep-agent-after">
        {KEEP_AGENT_AFTER}
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

export interface KeepAgentHereDialogProps {
  doc: { id: string; title: string };
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreateToken?: () => void;
}

/**
 * "Keep an agent here" as a dialog: the {@link KeepAgentHerePanel} with the ready-to-paste sentence. Opened from
 * the presence popover, the command palette (`doc:keep-agent`) and the editor's `/agent` slash item.
 */
export function KeepAgentHereDialog({ doc, open, onOpenChange, onCreateToken }: KeepAgentHereDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="Keep an agent here" className="max-h-[calc(100dvh-2rem)] w-[min(94vw,520px)] overflow-y-auto">
        <div data-testid="keep-agent-dialog">
          <KeepAgentHerePanel doc={doc} onCreateToken={onCreateToken} active={open} hideHeading />
        </div>
      </DialogContent>
    </Dialog>
  );
}