"use client";

import { memo, useEffect, useState } from "react";
import { Bot, Loader2 } from "lucide-react";
import { Dialog, DialogContent } from "@/components/ui/primitives";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { AgentConnectCard, AGENT_CONNECT_DISMISSED_KEY, useOrigin } from "@/components/settings/agent-connect-card";

export type AskAgentMode = "suggest" | "comment" | "rewrite";

export interface AskAgentSelection {
  from: number;
  to: number;
  quote: string;
}

export const QUICK_INSTRUCTIONS = ["Tighten this", "Fix grammar and tone", "Turn into a checklist"];

const MODES: { id: AskAgentMode; label: string; hint: string }[] = [
  { id: "suggest", label: "Propose as tracked changes", hint: "You accept or reject each change" },
  { id: "comment", label: "Comment only", hint: "Feedback in the Comments panel, no edits" },
  { id: "rewrite", label: "Rewrite directly", hint: "Edits the text in place" },
];

function readDismissed(): boolean {
  try {
    return typeof window !== "undefined" && window.localStorage.getItem(AGENT_CONNECT_DISMISSED_KEY) === "1";
  } catch {
    return false;
  }
}

export interface AskAgentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The selected text, or null for the whole document. */
  selection: AskAgentSelection | null;
  canEdit: boolean;
  canComment: boolean;
  onSend: (input: { instruction: string; mode: AskAgentMode; selection: AskAgentSelection | null }) => Promise<void>;
  /** Where to go to create a token; defaults to /settings#tokens and back. */
  onCreateToken?: () => void;
}

/** "Ask an agent": hand the selection (or the document) plus an instruction to whichever agent picks it up. */
export const AskAgentDialog = memo(function AskAgentDialog({ open, onOpenChange, selection, canEdit, canComment, onSend, onCreateToken }: AskAgentDialogProps) {
  const [instruction, setInstruction] = useState("");
  const [mode, setMode] = useState<AskAgentMode>("suggest");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasTokens, setHasTokens] = useState<boolean | null>(null);
  const [dismissed, setDismissed] = useState(true);
  const origin = useOrigin();

  useEffect(() => {
    if (!open) return;
    setInstruction("");
    setError(null);
    setMode(canEdit ? "suggest" : "comment");
    setDismissed(readDismissed());
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
  }, [open, canEdit]);

  const dismiss = () => {
    setDismissed(true);
    try {
      window.localStorage.setItem(AGENT_CONNECT_DISMISSED_KEY, "1");
    } catch {
      /* private mode */
    }
  };

  const showSetup = hasTokens === false && !dismissed;
  const canSend = instruction.trim().length > 0 && instruction.length <= 2000 && !busy && (mode === "comment" ? canComment : canEdit);

  const send = async () => {
    if (!canSend) return;
    setBusy(true);
    setError(null);
    try {
      await onSend({ instruction: instruction.trim(), mode, selection });
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not send the request");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="Ask an agent" description="Your agent picks this up, does the work and proposes it back here." className="max-h-[calc(100dvh-2rem)] w-[min(94vw,560px)] overflow-y-auto">
        <div className="flex flex-col gap-4" data-testid="ask-agent-dialog">
          {showSetup && <AgentConnectCard origin={origin} onDismiss={dismiss} onCreateToken={onCreateToken} />}

          <div className="rounded-lg border border-line bg-surface-2 px-3 py-2 text-sm" data-testid="ask-agent-selection">
            <div className="mb-0.5 text-[11px] font-semibold uppercase tracking-wider text-ink-3">{selection ? "Selected text" : "Scope"}</div>
            {selection ? <blockquote className="line-clamp-4 whitespace-pre-wrap text-ink-2">{selection.quote}</blockquote> : <span className="text-ink-2">Whole document</span>}
          </div>

          <form
            className="flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              void send();
            }}
          >
            <label className="flex flex-col gap-1 text-sm font-medium text-ink-2">
              What should the agent do?
              <textarea
                className="input min-h-20 resize-y"
                value={instruction}
                maxLength={2000}
                onChange={(e) => setInstruction(e.target.value)}
                placeholder={selection ? "e.g. Make this paragraph half as long without losing the numbers" : "e.g. Review the whole document for unclear sentences"}
                autoFocus={!showSetup}
                data-testid="ask-agent-instruction"
                onKeyDown={(e) => {
                  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                    e.preventDefault();
                    void send();
                  }
                }}
              />
            </label>
            <div className="flex flex-wrap gap-1.5" aria-label="Quick instructions">
              {QUICK_INSTRUCTIONS.map((q) => (
                <button
                  key={q}
                  type="button"
                  className={cn(
                    "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
                    instruction === q ? "border-accent bg-accent/10 text-ink" : "border-line bg-surface text-ink-2 hover:border-ink-4 hover:text-ink",
                  )}
                  onClick={() => setInstruction(q)}
                  data-testid="ask-agent-quick"
                >
                  {q}
                </button>
              ))}
            </div>
            <fieldset className="flex flex-col gap-1.5">
              <legend className="mb-1 text-sm font-medium text-ink-2">How should it answer?</legend>
              {MODES.map((m) => {
                const disabled = m.id === "comment" ? !canComment : !canEdit;
                return (
                  <label key={m.id} className={cn("flex cursor-pointer items-start gap-2.5 rounded-lg border px-3 py-2 text-sm", mode === m.id ? "border-accent bg-accent/5" : "border-line", disabled && "cursor-not-allowed opacity-50")}>
                    <input type="radio" name="ask-agent-mode" className="mt-0.5" value={m.id} checked={mode === m.id} disabled={disabled} onChange={() => setMode(m.id)} data-testid={`ask-agent-mode-${m.id}`} />
                    <span className="flex flex-col">
                      <span className="font-medium text-ink">{m.label}</span>
                      <span className="text-xs text-ink-3">{disabled && m.id !== "comment" ? "Needs edit access" : m.hint}</span>
                    </span>
                  </label>
                );
              })}
            </fieldset>
            {error && <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-danger dark:bg-red-950/40">{error}</div>}
            <div className="flex items-center justify-between gap-3 pt-1">
              <span className="text-xs text-ink-4">{instruction.length > 1800 ? `${2000 - instruction.length} characters left` : ""}</span>
              <div className="flex gap-2">
                <button type="button" className="btn btn-ghost" onClick={() => onOpenChange(false)}>
                  Cancel
                </button>
                <button type="submit" className="btn btn-primary gap-2" disabled={!canSend} data-testid="ask-agent-send">
                  {busy ? <Loader2 size={16} className="animate-spin" /> : <Bot size={16} />} Send
                </button>
              </div>
            </div>
          </form>
        </div>
      </DialogContent>
    </Dialog>
  );
});
