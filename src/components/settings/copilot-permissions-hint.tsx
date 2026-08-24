"use client";

import { useState } from "react";
import { Check, Copy, ShieldCheck } from "lucide-react";
import { copyText } from "@/lib/clipboard";
import { COPILOT_ALLOWING_TOOLS_URL, copilotAllowToolLine } from "@/lib/mcp";
import { cn } from "@/lib/utils";

/**
 * "Stop the permission prompts": under the MCP config in the Share card and the Connect card, the
 * `copilot --allow-tool …` line that pre-allows Markdoc's safe tools for a session, plus the two
 * alternatives (the CLI's own "don't ask again" answer, and /allow-all). The pattern uses the same
 * server key as the config block above it, so it matches what the user pasted.
 */
export function CopilotPermissionsHint({ testIdPrefix, className }: { testIdPrefix: string; className?: string }) {
  const line = copilotAllowToolLine();
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const copy = () => {
    void copyText(line).then((ok) => {
      setState(ok ? "copied" : "failed");
      setTimeout(() => setState("idle"), ok ? 1500 : 2500);
    });
  };
  return (
    <div className={cn("rounded-lg border border-line bg-surface p-2.5 text-xs leading-5 text-ink-3", className)} data-testid={`${testIdPrefix}-permissions`}>
      <div className="flex items-center gap-1.5 font-semibold text-ink-2">
        <ShieldCheck size={13} className="text-violet-600" /> Stop the permission prompts
      </div>
      <p className="mt-0.5">Copilot CLI asks before each change. To pre-allow Markdoc&rsquo;s safe tools for a session:</p>
      <div className="mt-1.5 flex items-start gap-2">
        <pre className="min-w-0 flex-1 select-all overflow-x-auto whitespace-pre-wrap break-all rounded-md border border-line bg-surface-2 px-2 py-1.5 font-mono text-[11px] leading-4 text-ink-2" data-testid={`${testIdPrefix}-allow-line`}>
          {line}
        </pre>
        <button type="button" className="btn btn-outline btn-sm shrink-0 gap-1.5" onClick={copy} aria-label="Copy the Copilot CLI allow-tool line" data-testid={`${testIdPrefix}-allow-copy`}>
          {state === "copied" ? <Check size={14} className="text-success" /> : <Copy size={14} />}
          {state === "copied" ? "Copied" : state === "failed" ? "Select & press Ctrl+C" : "Copy"}
        </button>
      </div>
      <p className="mt-1.5">
        or answer <em>don&rsquo;t ask again in this directory</em> once per tool; <code className="rounded bg-surface-2 px-1 py-0.5 font-mono">/allow-all</code> allows everything (not
        recommended). Reading and watching never prompt.{" "}
        <a className="text-accent hover:underline" href={COPILOT_ALLOWING_TOOLS_URL} target="_blank" rel="noreferrer">
          How Copilot CLI permissions work
        </a>
      </p>
    </div>
  );
}
