"use client";

import { useEffect, useRef, useState } from "react";
import { Check, ListChecks } from "lucide-react";
import { cn } from "@/lib/utils";
import { api, type ApiTokenDto } from "@/lib/api";
import { copilotAllowToolLine } from "@/lib/mcp";

export interface CopilotChecklistProps {
  /** An agent request exists for this user (asked from the editor): the last step counts as done too. */
  hasAgentRequests: boolean;
  /** Server-rendered first state so the list is right before the first fetch. */
  initialTokens?: Pick<ApiTokenDto, "lastMcpSeenAt" | "lastMcpCallAt">[];
  /** How often to re-read /api/tokens while a step is still open (ms); 0 disables. */
  pollMs?: number;
}

export interface ChecklistState {
  hasToken: boolean;
  mcpSeen: boolean;
  mcpCalled: boolean;
}

interface ChecklistProgress extends ChecklistState {
  tried: boolean;
}

export function checklistState(tokens: Pick<ApiTokenDto, "lastMcpSeenAt" | "lastMcpCallAt">[]): ChecklistState {
  return { hasToken: tokens.length > 0, mcpSeen: tokens.some((t) => !!t.lastMcpSeenAt), mcpCalled: tokens.some((t) => !!t.lastMcpCallAt) };
}

function advanceChecklistState(
  current: ChecklistProgress,
  next: ChecklistState,
  hasAgentRequests = false,
): ChecklistProgress {
  const advanced = {
    hasToken: current.hasToken || next.hasToken,
    mcpSeen: current.mcpSeen || next.mcpSeen,
    mcpCalled: current.mcpCalled || next.mcpCalled,
    tried: current.tried || next.mcpCalled || hasAgentRequests,
  };
  return advanced.hasToken === current.hasToken &&
    advanced.mcpSeen === current.mcpSeen &&
    advanced.mcpCalled === current.mcpCalled &&
    advanced.tried === current.tried
    ? current
    : advanced;
}

/**
 * "Set up Copilot CLI" at the top of Settings → Agents: four steps whose checkmarks come from real
 * state — a token exists, an MCP client listed the tools with it (`lastMcpSeenAt`), a tool call went
 * through (`lastMcpCallAt`, so the permission prompt was answered) or a request was sent from the editor.
 */
export function CopilotChecklist({ hasAgentRequests, initialTokens, pollMs = 5000 }: CopilotChecklistProps) {
  const settlementGeneration = useRef(0);
  const initial = checklistState(initialTokens ?? []);
  const [state, setState] = useState<ChecklistProgress>(() => ({ ...initial, tried: initial.mcpCalled || hasAgentRequests }));
  const steps: { id: string; label: string; detail: React.ReactNode; done: boolean }[] = [
    { id: "token", label: "Create a token", detail: <>Below: name it after the agent (e.g. “GitHub Copilot CLI”) and copy the secret once.</>, done: state.hasToken },
    {
      id: "config",
      label: "Paste the config into Copilot CLI",
      detail: (
        <>
          <code className="rounded bg-surface-2 px-1 py-0.5 font-mono text-xs">/mcp add</code> with the configuration shown under “Connect an agent”. Turns green when the CLI lists Markdoc’s tools.
        </>
      ),
      done: state.mcpSeen,
    },
    {
      id: "allow",
      label: "Allow the Markdoc tools",
      detail: (
        <>
          Answer the permission prompt, or start Copilot with <code className="rounded bg-surface-2 px-1 py-0.5 font-mono text-xs">{copilotAllowToolLine()}</code>.
        </>
      ),
      done: state.mcpCalled,
    },
    {
      id: "try",
      label: "Try “read my doc”",
      detail: <>Ask Copilot to read one of your documents, or send a request from the editor (mention it in a comment). Turns green after the first tool call or request.</>,
      done: state.tried,
    },
  ];
  const allDone = steps.every((s) => s.done);

  useEffect(() => {
    settlementGeneration.current++;
    setState((current) =>
      advanceChecklistState(
        current,
        { hasToken: initial.hasToken, mcpSeen: initial.mcpSeen, mcpCalled: initial.mcpCalled },
        hasAgentRequests,
      ),
    );
  }, [hasAgentRequests, initial.hasToken, initial.mcpCalled, initial.mcpSeen]);

  useEffect(() => {
    if (allDone || pollMs <= 0) return;
    let cancelled = false;
    let pending = false;
    const load = () => {
      if (cancelled || pending) return;
      pending = true;
      const generation = settlementGeneration.current;
      void api.tokens
        .list()
        .then((r) => {
          if (!cancelled && generation === settlementGeneration.current) {
            setState((current) => advanceChecklistState(current, checklistState(r.tokens)));
          }
        })
        .catch(() => {})
        .finally(() => {
          if (!cancelled) pending = false;
        });
    };
    load();
    const timer = setInterval(load, pollMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [allDone, pollMs]);

  const doneCount = steps.filter((s) => s.done).length;
  return (
    <section className="rounded-2xl border border-line bg-surface p-5" aria-labelledby="copilot-checklist-title" data-testid="copilot-checklist" data-done={doneCount}>
      <div className="mb-3 flex items-center gap-2">
        <ListChecks size={16} className="text-accent" aria-hidden />
        <h2 id="copilot-checklist-title" className="text-sm font-semibold text-ink">
          Set up Copilot CLI
        </h2>
        <span className="ml-auto text-xs text-ink-3" data-testid="copilot-checklist-progress">
          {doneCount} of {steps.length}
        </span>
      </div>
      <ol className="flex flex-col gap-2.5">
        {steps.map((s, i) => (
          <li key={s.id} className="flex gap-3" data-testid={`checklist-${s.id}`} data-done={s.done}>
            <span
              className={cn(
                "mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-[11px] font-semibold",
                s.done ? "border-green-600 bg-green-600 text-white dark:border-green-500 dark:bg-green-500" : "border-line-2 text-ink-3",
              )}
              aria-hidden
            >
              {s.done ? <Check size={12} strokeWidth={3} /> : i + 1}
            </span>
            <div className="min-w-0 text-sm">
              <div className={cn("font-medium", s.done ? "text-green-700 dark:text-green-400" : "text-ink")}>
                {s.label}
                <span className="sr-only">{s.done ? " — done" : " — to do"}</span>
              </div>
              <p className="mt-0.5 break-words text-xs leading-5 text-ink-3">{s.detail}</p>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
