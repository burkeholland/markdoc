"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Check, Copy, ExternalLink, KeyRound, Plug, TerminalSquare, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useCopy } from "@/lib/hooks";
import { AGENT_DOCS_URL, MCP_PATH, type TokenScopeName } from "@/lib/mcp";
import { CopilotPermissionsHint } from "@/components/settings/copilot-permissions-hint";

export const AGENT_CONNECT_DISMISSED_KEY = "markdoc:agent-connect-dismissed";

/** Placeholder shown where the user's token goes until one is inlined. */
export const TOKEN_PLACEHOLDER = "MARKDOC_TOKEN";
export const COPILOT_APP_INSTALL = "mkdir -p ~/.copilot/extensions/markdoc && cp -R extensions/markdoc/. ~/.copilot/extensions/markdoc/";
const COPILOT_APP_DOCS = "https://github.com/burkeholland/markdoc/blob/main/docs/agents.md#inside-the-copilot-app";
type ConnectTarget = "copilot-cli" | "mcp-clients" | "copilot-app";

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
 * Copilot. Used by the Keep-an-agent-here dialog (first run) and the Settings › Agents section.
 */
export function AgentConnectCard({ origin, token, scope, onCreateToken, onDismiss, hideTokenStep, className }: AgentConnectCardProps) {
  const base = origin || "http://localhost:3000";
  const config = mcpHttpConfigFor(base, token ?? undefined);
  const stdioConfig = mcpConfigFor(base, token ?? undefined);
  const [target, setTarget] = useState<ConnectTarget>("copilot-cli");
  const tabsId = useId();
  const targets: { id: ConnectTarget; label: string }[] = [
    { id: "copilot-cli", label: "Copilot CLI" },
    { id: "mcp-clients", label: "VS Code / other MCP clients" },
    { id: "copilot-app", label: "Copilot app" },
  ];
  const selectTarget = (next: ConnectTarget, focus = false) => {
    setTarget(next);
    if (focus) document.getElementById(`${tabsId}-${next}`)?.focus();
  };
  const moveTarget = (event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    let next = index;
    if (event.key === "ArrowRight") next = (index + 1) % targets.length;
    else if (event.key === "ArrowLeft") next = (index - 1 + targets.length) % targets.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = targets.length - 1;
    else return;
    event.preventDefault();
    selectTarget(targets[next].id, true);
  };
  return (
    <section className={cn("relative rounded-xl border border-violet-200 bg-violet-50/60 p-4 dark:border-violet-900 dark:bg-violet-950/30", className)} data-testid="agent-connect-card" aria-label="Connect an agent">
      {onDismiss && (
        <button type="button" className="icon-btn absolute right-2 top-2 h-7 w-7" onClick={onDismiss} aria-label="Dismiss setup steps" data-testid="agent-connect-dismiss">
          <X size={14} />
        </button>
      )}
      <div className={cn("flex items-center justify-between gap-3", onDismiss && "pr-7")}>
        <h3 className="flex items-center gap-2 text-sm font-semibold text-ink">
          <Plug size={16} className="text-violet-600" /> Connect an agent
        </h3>
        <a className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-accent hover:underline" href={AGENT_DOCS_URL} target="_blank" rel="noreferrer" data-testid="agent-docs-link">
          Agent docs <ExternalLink size={13} aria-hidden="true" />
        </a>
      </div>
      <p className="mt-1 text-xs leading-5 text-ink-3">
        Requests you send from the editor are picked up by your own agent — GitHub Copilot CLI by default — through the Markdoc MCP server. Nothing runs on
        the Markdoc side; your agent does the work and proposes it back as suggestions.
      </p>
      <div className="mt-3 flex flex-wrap gap-1 rounded-lg bg-surface-2 p-1" role="tablist" aria-label="Agent client">
        {targets.map((item, index) => (
          <button
            key={item.id}
            id={`${tabsId}-${item.id}`}
            type="button"
            role="tab"
            aria-selected={target === item.id}
            aria-controls={`${tabsId}-panel`}
            tabIndex={target === item.id ? 0 : -1}
            className={cn("rounded-md px-2.5 py-1.5 text-xs font-medium", target === item.id ? "bg-surface text-ink shadow-sm" : "text-ink-3 hover:text-ink")}
            onClick={() => selectTarget(item.id)}
            onKeyDown={(event) => moveTarget(event, index)}
            data-testid={`agent-connect-tab-${item.id}`}
          >
            {item.label}
          </button>
        ))}
      </div>
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
            {target === "copilot-app" ? (
              <div id={`${tabsId}-panel`} role="tabpanel" aria-labelledby={`${tabsId}-${target}`} data-testid="agent-connect-copilot-app">
                <p className="mb-1.5">
                  Copy the canvas extension from this checkout into Copilot&apos;s personal extensions directory, then start a new app session. Copilot asks for{" "}
                  <code className="rounded bg-surface px-1 py-0.5 font-mono text-xs">MARKDOC_URL</code> and{" "}
                  <code className="rounded bg-surface px-1 py-0.5 font-mono text-xs">MARKDOC_TOKEN</code>; use <code className="rounded bg-surface px-1 py-0.5 font-mono text-xs">{base}</code> for the URL.
                </p>
                <CopyBlock value={COPILOT_APP_INSTALL} label="Copilot app install command" testId="agent-connect-app-install" />
                <a className="mt-2 inline-flex text-xs font-medium text-accent hover:underline" href={COPILOT_APP_DOCS} target="_blank" rel="noreferrer">
                  Inside the Copilot app setup and limits
                </a>
              </div>
            ) : (
              <div id={`${tabsId}-panel`} role="tabpanel" aria-labelledby={`${tabsId}-${target}`}>
                <div className="mb-1.5">
                  {target === "copilot-cli" ? (
                    <>
                      Add Markdoc to Copilot CLI: run <code className="rounded bg-surface px-1 py-0.5 font-mono text-xs">/mcp add</code> and paste this, or merge it into{" "}
                      <code className="rounded bg-surface px-1 py-0.5 font-mono text-xs">~/.copilot/mcp-config.json</code>.
                    </>
                  ) : (
                    <>
                      Add this Streamable HTTP server to your client. VS Code puts the same shape under <code className="rounded bg-surface px-1 py-0.5 font-mono text-xs">servers</code> in{" "}
                      <code className="rounded bg-surface px-1 py-0.5 font-mono text-xs">.vscode/mcp.json</code>.
                    </>
                  )}{" "}
                  It connects to this server over HTTP — no checkout needed.
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
            )}
          </div>
        </li>
        <li className="flex gap-3">
          <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-violet-600 text-[11px] font-semibold text-white">{hideTokenStep ? 2 : 3}</span>
          <div className="flex flex-1 flex-wrap items-center gap-2">
            <TerminalSquare size={14} className="text-ink-3" />
            {target === "copilot-app" ? (
              <span>
                In a new Copilot app session, ask <q className="font-medium text-ink">Open my document in Markdoc</q> or run{" "}
                <code className="rounded bg-surface px-1 py-0.5 font-mono text-xs">/markdoc open &lt;id&gt;</code>. Requests, mentions, comments, and reviews made in the panel are pushed into that session.
              </span>
            ) : (
              <span>
                Ask Copilot: <q className="font-medium text-ink">Check Markdoc for requests</q>. It lists what you asked for, claims it and replies with suggestions you accept or reject here.
              </span>
            )}
          </div>
        </li>
      </ol>
    </section>
  );
}
