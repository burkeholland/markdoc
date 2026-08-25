"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Copy, KeyRound, Plug, TerminalSquare, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useCopy } from "@/lib/hooks";
import { MCP_PATH, type TokenScopeName } from "@/lib/mcp";
import { CopilotPermissionsHint } from "@/components/settings/copilot-permissions-hint";

export const AGENT_CONNECT_DISMISSED_KEY = "markdoc:agent-connect-dismissed";

/** Placeholder shown where the user's token goes until one is inlined. */
export const TOKEN_PLACEHOLDER = "MARKDOC_TOKEN";

/**
 * The MCP config for Copilot CLI / VS Code / Claude / Cursor pointing at this server's remote
 * endpoint (`/api/mcp`, Streamable HTTP). No checkout needed: a URL and a token.
 */
export function mcpHttpConfigFor(origin: string, token: string = TOKEN_PLACEHOLDER): string {
  return JSON.stringify(
    {
      mcpServers: {
        markdoc: {
          type: "http",
          url: `${origin}${MCP_PATH}`,
          headers: { Authorization: ["Bearer", token].join(" ") },
          tools: ["*"],
        },
      },
    },
    null,
    2,
  );
}

/** The stdio alternative: `mcp/server.mjs` from a checkout, for clients that cannot speak HTTP. */
export function mcpConfigFor(origin: string, token: string = TOKEN_PLACEHOLDER): string {
  return JSON.stringify(
    {
      mcpServers: {
        markdoc: {
          command: "node",
          args: ["/path/to/markdoc/mcp/server.mjs"],
          env: { MARKDOC_URL: origin, MARKDOC_TOKEN: token },
        },
      },
    },
    null,
    2,
  );
}

/** The browser's origin after hydration; `fallback` (e.g. the server's AUTH_URL) until then. */
export function useOrigin(fallback = ""): string {
  const [origin, setOrigin] = useState(fallback);
  useEffect(() => {
    if (typeof window !== "undefined" && window.location.origin) setOrigin(window.location.origin);
  }, []);
  return origin;
}

export function CopyBlock({ value, label, testId, copyTestId }: { value: string; label: string; testId?: string; copyTestId?: string }) {
  const pre = useRef<HTMLPreElement>(null);
  const { copy, label: buttonLabel, copied } = useCopy(value, pre);
  return (
    <div className="relative">
      {/* pre-wrap + break-all: the Bearer line wraps instead of being clipped; what is copied is `value`, not this rendering. */}
      <pre
        ref={pre}
        className="select-text whitespace-pre-wrap break-all rounded-lg border border-line bg-surface-2 p-3 pr-24 font-mono text-xs leading-5 text-ink-2"
        data-testid={testId}
      >
        {value}
      </pre>
      <button type="button" className="btn btn-outline btn-sm absolute right-2 top-2 gap-1.5" onClick={copy} aria-label={`Copy ${label}`} data-testid={copyTestId}>
        {copied ? <Check size={14} className="text-success" /> : <Copy size={14} />}
        {buttonLabel}
      </button>
    </div>
  );
}

export interface AgentConnectCardProps {
  /** Server origin to put in the config (window.location.origin in the browser). */
  origin: string;
  /** A freshly created token to inline instead of the placeholder. */
  token?: string | null;
  /** That token's scope, printed next to the allow-tool line (and narrowing it). */
  scope?: TokenScopeName | null;
  /** Shown for step 1; when omitted a link to /settings#tokens is rendered. */
  onCreateToken?: () => void;
  /** Renders a close button; the caller remembers the dismissal. */
  onDismiss?: () => void;
  /** Hide step 1 (the settings page has the token form right below). */
  hideTokenStep?: boolean;
  className?: string;
}

/**
 * "Connect an agent" in three steps: a token, the MCP config for this host, and the sentence to say to
 * Copilot. Used by the Ask-an-agent dialog (first run) and the Settings › Agents section.
 */
export function AgentConnectCard({ origin, token, scope, onCreateToken, onDismiss, hideTokenStep, className }: AgentConnectCardProps) {
  const base = origin || "http://localhost:3000";
  const config = mcpHttpConfigFor(base, token ?? undefined);
  const stdioConfig = mcpConfigFor(base, token ?? undefined);
  return (
    <section className={cn("relative rounded-xl border border-violet-200 bg-violet-50/60 p-4 dark:border-violet-900 dark:bg-violet-950/30", className)} data-testid="agent-connect-card" aria-label="Connect an agent">
      {onDismiss && (
        <button type="button" className="icon-btn absolute right-2 top-2 h-7 w-7" onClick={onDismiss} aria-label="Dismiss setup steps" data-testid="agent-connect-dismiss">
          <X size={14} />
        </button>
      )}
      <h3 className="flex items-center gap-2 text-sm font-semibold text-ink">
        <Plug size={16} className="text-violet-600" /> Connect an agent
      </h3>
      <p className="mt-1 text-xs leading-5 text-ink-3">
        Requests you send from the editor are picked up by your own agent — GitHub Copilot CLI by default — through the Markdoc MCP server. Nothing runs on
        the Markdoc side; your agent does the work and proposes it back as suggestions.
      </p>
      <ol className="mt-3 flex flex-col gap-3 text-sm text-ink-2">
        {!hideTokenStep && (
          <li className="flex gap-3">
            <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-violet-600 text-[11px] font-semibold text-white">1</span>
            <div className="flex flex-1 flex-wrap items-center gap-2">
              <span>Create an API token for the agent.</span>
              {onCreateToken ? (
                <button type="button" className="btn btn-outline btn-sm gap-1.5" onClick={onCreateToken} data-testid="agent-connect-create-token">
                  <KeyRound size={14} /> Create token
                </button>
              ) : (
                <a className="btn btn-outline btn-sm gap-1.5" href="/settings#tokens" data-testid="agent-connect-create-token">
                  <KeyRound size={14} /> Create token
                </a>
              )}
            </div>
          </li>
        )}
        <li className="flex gap-3">
          <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-violet-600 text-[11px] font-semibold text-white">{hideTokenStep ? 1 : 2}</span>
          <div className="min-w-0 flex-1">
            <div className="mb-1.5">
              Add Markdoc to Copilot CLI: run <code className="rounded bg-surface px-1 py-0.5 font-mono text-xs">/mcp add</code> and paste this (or merge it into{" "}
              <code className="rounded bg-surface px-1 py-0.5 font-mono text-xs">~/.copilot/mcp-config.json</code>; VS Code takes the same shape in{" "}
              <code className="rounded bg-surface px-1 py-0.5 font-mono text-xs">.vscode/mcp.json</code>). It connects to this server over HTTP — no checkout needed.
              {!token && (
                <>
                  {" "}
                  Replace <code className="rounded bg-surface px-1 py-0.5 font-mono text-xs">{TOKEN_PLACEHOLDER}</code> with your token.
                </>
              )}
            </div>
            <CopyBlock value={config} label="MCP configuration" testId="agent-connect-config" />
            <details className="mt-2 text-xs text-ink-3">
              <summary className="cursor-pointer select-none" data-testid="agent-connect-stdio-toggle">
                Client without HTTP support? Run the server from a checkout (stdio)
              </summary>
              <div className="mt-2">
                <div className="mb-1.5">
                  Point <code className="rounded bg-surface px-1 py-0.5 font-mono text-xs">args</code> at your Markdoc checkout.
                </div>
                <CopyBlock value={stdioConfig} label="stdio MCP configuration" testId="agent-connect-config-stdio" />
              </div>
            </details>
            <CopilotPermissionsHint testIdPrefix="agent-connect" className="mt-2" scope={scope} />
          </div>
        </li>
        <li className="flex gap-3">
          <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-violet-600 text-[11px] font-semibold text-white">{hideTokenStep ? 2 : 3}</span>
          <div className="flex flex-1 flex-wrap items-center gap-2">
            <TerminalSquare size={14} className="text-ink-3" />
            <span>
              Ask Copilot: <q className="font-medium text-ink">Check Markdoc for requests</q>. It lists what you asked for, claims it and replies with suggestions you accept or reject here.
            </span>
          </div>
        </li>
      </ol>
    </section>
  );
}
