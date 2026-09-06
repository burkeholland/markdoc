"use client";

import { useRef } from "react";
import { Check, Copy, ShieldCheck } from "lucide-react";
import { useCopy } from "@/lib/hooks";
import { COPILOT_ALLOWING_TOOLS_URL, copilotAllowToolLine, TOKEN_SCOPE_LABEL, TOKEN_SCOPE_SUMMARY, type TokenScopeName } from "@/lib/mcp";
import { cn } from "@/lib/utils";

/**
 * "Stop the permission prompts": under the MCP config in the Share card and the Connect card, the
 * `copilot --allow-tool …` line that pre-allows Markdoc's safe tools for a session, plus the two
 * alternatives (the CLI's own "don't ask again" answer, and /allow-all). The pattern uses the same
 * server key as the config block above it, so it matches what the user pasted. When the token's
 * `scope` is known the line only lists tools that scope can run, and the scope is printed next to it.
 */
export function CopilotPermissionsHint({ testIdPrefix, className, scope }: { testIdPrefix: string; className?: string; scope?: TokenScopeName | null }) {
  const line = copilotAllowToolLine(undefined, scope ?? "full");
  const pre = useRef<HTMLPreElement>(null);
  const { copy, label, copied } = useCopy(line, pre);
  return (
    <div className={cn("rounded-lg border border-line bg-surface p-2.5 text-xs leading-5 text-ink-3", className)} data-testid={`${testIdPrefix}-permissions`}>
      <div className="flex items-center gap-1.5 font-semibold text-ink-2">
        <ShieldCheck size={13} className="text-violet-600" /> Stop the permission prompts
      </div>
      <p className="mt-0.5">Copilot CLI asks before each change. To pre-allow Markdoc&rsquo;s safe tools for a session:</p>
      <div className="mt-1.5 flex min-w-0 flex-col items-start gap-2">
        <pre
          ref={pre}
          className="w-full min-w-0 select-text whitespace-pre-wrap break-all rounded-md border border-line bg-surface-2 px-2 py-1.5 font-mono text-[11px] leading-4 text-ink-2"
          data-testid={`${testIdPrefix}-allow-line`}
        >
          {line}
        </pre>
        <button type="button" className="btn btn-outline btn-sm h-auto max-w-full gap-1.5 whitespace-normal text-left" onClick={copy} aria-label="Copy the Copilot CLI allow-tool line" data-testid={`${testIdPrefix}-allow-copy`}>
          {copied ? <Check size={14} className="text-success" /> : <Copy size={14} />}
          {label}
        </button>
      </div>
      {scope && (
        <p className="mt-1.5 flex flex-wrap items-center gap-1.5" data-testid={`${testIdPrefix}-scope`}>
          <span className="font-semibold text-ink-2">Token scope:</span>
          <span className="rounded-full border border-line bg-surface-2 px-2 py-0.5 font-mono text-[11px] text-ink-2" data-testid={`${testIdPrefix}-scope-chip`}>
            {scope}
          </span>
          <span>
            {TOKEN_SCOPE_LABEL[scope]} — {TOKEN_SCOPE_SUMMARY[scope]}.
          </span>
        </p>
      )}
      <p className="mt-1.5">
        or answer <em>don&rsquo;t ask again in this directory</em> once per tool; <code className="rounded bg-surface-2 px-1 py-0.5 font-mono">/allow-all</code> allows everything (not
        recommended). Reading and watching never prompt.{" "}
        {/* Always underlined: inside grey body text the accent colour alone fails axe `link-in-text-block`. */}
        <a className="text-accent underline underline-offset-2" href={COPILOT_ALLOWING_TOOLS_URL} target="_blank" rel="noreferrer">
          How Copilot CLI permissions work
        </a>
      </p>
    </div>
  );
}
