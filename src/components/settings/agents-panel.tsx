"use client";

import { useState } from "react";
import { ArrowLeft } from "lucide-react";
import { AgentSetup } from "@/components/agents/agent-setup";
import { useApiTokens } from "@/components/agents/use-api-tokens";
import { useOrigin } from "@/components/agents/use-origin";
import type { ApiTokenDto } from "@/lib/api";
import { KeysList } from "./keys-list";

export interface AgentsPanelProps {
  /** The server's public origin; the browser's own origin replaces it after hydration. */
  origin: string;
  userLogin: string;
  /** A document path to return to (set when Settings was opened from the editor). */
  next?: string | null;
  /** The user's keys as rendered on the server, so the first paint already has the right layout. */
  initialTokens: ApiTokenDto[];
}

/** Settings → AI agents: connect an agent, then manage the keys behind the ones you have. */
export function AgentsPanel({ origin, userLogin, next, initialTokens }: AgentsPanelProps) {
  const liveOrigin = useOrigin(origin);
  const keys = useApiTokens(true, initialTokens);
  const [expanded, setExpanded] = useState(false);
  const hasKeys = (keys.tokens?.length ?? 0) > 0;
  const showSetup = !hasKeys || expanded;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-ink">AI agents</h1>
        <p className="mt-1 max-w-2xl text-sm leading-6 text-ink-3">
          Connect any MCP client. It reads your documents, comments and suggests edits; you accept or reject each change. Its work shows up
          as <strong className="font-medium text-ink-2">{userLogin} via AI agent</strong> (or whatever you name it).
        </p>
        {next && (
          <a className="btn btn-outline btn-sm mt-3 gap-1.5" href={next} data-testid="settings-back-to-document">
            <ArrowLeft size={14} aria-hidden="true" /> Back to the document
          </a>
        )}
      </div>

      <section id="connect" className="rounded-2xl border border-line bg-surface p-5" aria-labelledby="connect-heading" data-testid="agent-connect-section">
        <div className="flex items-center justify-between gap-3">
          <h2 id="connect-heading" className="text-base font-semibold text-ink">
            {hasKeys ? "Connect another agent" : "Connect an agent"}
          </h2>
          {hasKeys && (
            <button type="button" className="btn btn-outline btn-sm" aria-expanded={showSetup} onClick={() => setExpanded((value) => !value)} data-testid="agent-setup-toggle">
              {showSetup ? "Hide" : "Set up"}
            </button>
          )}
        </div>
        {showSetup && (
          <div className="mt-4">
            <AgentSetup origin={liveOrigin} tokens={keys.tokens} reload={keys.reload} onKeyCreated={() => setExpanded(true)} />
          </div>
        )}
      </section>

      {hasKeys && <KeysList {...keys} />}
    </div>
  );
}
