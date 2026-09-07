"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowLeft, Check, Copy, ExternalLink, Radio } from "lucide-react";
import { Dialog, DialogContent } from "@/components/ui/primitives";
import { api, apiErrorText } from "@/lib/api";
import { useCopy } from "@/lib/hooks";
import { AGENT_CONNECT_DISMISSED_KEY, AGENT_DOCS_URL } from "@/lib/mcp";
import { AgentConnectCard, useOrigin } from "@/components/settings/agent-connect-card";

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

interface TokenSetupCheck {
  hasTokens: boolean | null;
  pending: boolean;
  error: string | null;
  retry: () => void;
}

interface TokenCheckVisit {
  waitingFor: TokenListRequest | null;
}

interface TokenListRequest {
  visit: TokenCheckVisit | null;
  requiresFreshVisit: boolean;
}

/** The user's last confirmed token state, plus the exact active panel visit's request state. */
function useHasTokens(active: boolean): TokenSetupCheck {
  const [hasTokens, setHasTokens] = useState<boolean | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const visitRef = useRef<TokenCheckVisit | null>(null);
  const requestRef = useRef<TokenListRequest | null>(null);

  const check = useCallback((visit: TokenCheckVisit) => {
    function run(currentVisit: TokenCheckVisit): void {
      if (visitRef.current !== currentVisit) return;
      const running = requestRef.current;
      if (running) {
        if (running.visit !== currentVisit) {
          if (running.requiresFreshVisit) currentVisit.waitingFor = running;
          else running.visit = currentVisit;
        }
        setPending(true);
        return;
      }

      currentVisit.waitingFor = null;
      const request: TokenListRequest = { visit: currentVisit, requiresFreshVisit: false };
      requestRef.current = request;
      setPending(true);

      void (async () => {
        try {
          const res = await api.tokens.list();
          if (requestRef.current !== request || !request.visit || request.visit !== visitRef.current) return;
          setHasTokens(res.tokens.length > 0);
          setError(null);
        } catch (reason) {
          if (requestRef.current !== request || !request.visit || request.visit !== visitRef.current) return;
          setError(apiErrorText(reason, "Could not check token setup"));
        } finally {
          if (requestRef.current !== request) return;
          requestRef.current = null;
          const requestVisit = request.visit;
          request.visit = null;
          if (requestVisit && visitRef.current === requestVisit) {
            setPending(false);
            return;
          }

          const waitingVisit = visitRef.current;
          if (!waitingVisit || waitingVisit.waitingFor !== request) return;
          waitingVisit.waitingFor = null;
          run(waitingVisit);
        }
      })();
    }

    run(visit);
  }, []);

  const retire = useCallback((visit: TokenCheckVisit) => {
    visit.waitingFor = null;
    if (requestRef.current?.visit === visit) requestRef.current.visit = null;
    if (visitRef.current === visit) visitRef.current = null;
  }, []);

  useLayoutEffect(() => {
    if (!active) {
      if (requestRef.current) requestRef.current.requiresFreshVisit = true;
      setPending(false);
      setError(null);
      return;
    }

    const visit: TokenCheckVisit = { waitingFor: null };
    visitRef.current = visit;
    setError(null);
    check(visit);
    return () => retire(visit);
  }, [active, check, retire]);

  const retry = useCallback(() => {
    const visit = visitRef.current;
    if (visit) check(visit);
  }, [check]);
  return { hasTokens, pending, error, retry };
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
function KeepAgentHerePanelContent({
  doc,
  onCreateToken,
  onBack,
  active,
  hideHeading,
  tokenSetup,
}: KeepAgentHerePanelProps & { active: boolean; hideHeading: boolean; tokenSetup: TokenSetupCheck }) {
  const prompt = keepAgentPrompt(doc);
  const pre = useRef<HTMLPreElement>(null);
  const { copy, label, copied } = useCopy(prompt, pre);
  const origin = useOrigin();
  const { hasTokens, pending: tokenCheckPending, error: tokenCheckError, retry: retryTokenCheck } = tokenSetup;
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
      {tokenCheckPending && !tokenCheckError && (
        <p className="text-xs text-ink-3" role="status" aria-live="polite" aria-atomic="true" data-testid="keep-agent-token-checking">
          Checking token setup…
        </p>
      )}
      {tokenCheckError && (
        <div className="flex items-center gap-2 rounded-lg bg-red-50 px-3 py-2 text-xs text-danger dark:bg-red-950/40" data-testid="keep-agent-token-error">
          <span className="min-w-0 flex-1" role="alert" aria-atomic="true">{tokenCheckError}</span>
          <button
            type="button"
            className="btn btn-outline btn-sm shrink-0"
            onClick={retryTokenCheck}
            disabled={tokenCheckPending}
            aria-busy={tokenCheckPending || undefined}
          >
            {tokenCheckPending ? "Retrying…" : "Retry"}
          </button>
        </div>
      )}
      {showSetup && <AgentConnectCard origin={origin} onDismiss={dismiss} onCreateToken={onCreateToken} className="p-3" />}
      <nav className="flex flex-wrap gap-2" aria-label="Agent setup">
        <a className="btn btn-outline btn-sm" href={`/settings?next=${encodeURIComponent(`/d/${doc.id}`)}#tokens`}>Tokens</a>
        <a className="btn btn-outline btn-sm whitespace-normal" href={`/settings?next=${encodeURIComponent(`/d/${doc.id}`)}#connect`}>Connect an MCP client</a>
      </nav>
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
        className="inline-flex min-h-6 w-fit items-center gap-1 text-xs font-medium text-accent underline-offset-2 hover:underline"
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

export function KeepAgentHerePanel({ doc, onCreateToken, onBack, active = true, hideHeading = false }: KeepAgentHerePanelProps) {
  const tokenSetup = useHasTokens(active);
  return (
    <KeepAgentHerePanelContent
      doc={doc}
      onCreateToken={onCreateToken}
      onBack={onBack}
      active={active}
      hideHeading={hideHeading}
      tokenSetup={tokenSetup}
    />
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
  const tokenSetup = useHasTokens(open);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="Keep an agent here" className="max-h-[calc(100dvh-2rem)] w-[min(94vw,520px)] overflow-y-auto">
        <div data-testid="keep-agent-dialog">
          <KeepAgentHerePanelContent doc={doc} onCreateToken={onCreateToken} active={open} hideHeading tokenSetup={tokenSetup} />
        </div>
      </DialogContent>
    </Dialog>
  );
}