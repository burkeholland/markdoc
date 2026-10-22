"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";
import { Dialog, DialogContent } from "@/components/ui/primitives";
import { hasConnected, isActiveKey, keyReaches, lastSeenAt } from "@/lib/agent-keys";
import { ConnectedBanner, InviteBlock, type DocRef } from "./agent-parts";
import { AgentSetup } from "./agent-setup";
import { useApiTokens } from "./use-api-tokens";

function AgentDialogBody({ doc }: { doc: DocRef }) {
  const { tokens, error, reload } = useApiTokens();
  const [settingUp, setSettingUp] = useState(false);

  // Keys an agent has already used that can open this document. A key limited to other documents does not count.
  const connected = (tokens ?? [])
    .filter((key) => isActiveKey(key) && keyReaches(key, doc.id) && hasConnected(key))
    .sort((a, b) => new Date(lastSeenAt(b) ?? 0).getTime() - new Date(lastSeenAt(a) ?? 0).getTime());

  if (tokens === null && !error) {
    return (
      <p className="flex items-center gap-2 py-6 text-sm text-ink-3" role="status">
        <Loader2 size={15} className="animate-spin" aria-hidden="true" /> Checking your agents…
      </p>
    );
  }

  // The wizard stays put once a key is made, and shows its own connected state; a returning user goes straight to the invite.
  if (settingUp || connected.length === 0) {
    return <AgentSetup tokens={tokens} reload={reload} doc={doc} onKeyCreated={() => setSettingUp(true)} />;
  }

  return (
    <div className="flex flex-col gap-5" data-testid="agent-connected">
      <ConnectedBanner names={connected.map((key) => key.name)} lastSeen={lastSeenAt(connected[0])} />
      <InviteBlock doc={doc} />
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-line pt-4">
        <button type="button" className="btn btn-outline btn-sm" onClick={() => setSettingUp(true)} data-testid="agent-connect-another">
          Connect another agent
        </button>
        <a
          className="inline-flex min-h-8 items-center text-sm font-medium text-accent hover:underline"
          href={`/settings?next=${encodeURIComponent(`/d/${doc.id}`)}#tokens`}
          data-testid="agent-manage-keys"
        >
          Manage keys
        </a>
      </div>
    </div>
  );
}

export interface AgentDialogProps {
  doc: DocRef;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** Connect an agent to Markdoc, then hand it this document. Opened from Share, the people popover, the palette and `/agent`. */
export function AgentDialog({ doc, open, onOpenChange }: AgentDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title="Connect an AI agent"
        description="It reads, comments and suggests edits. You accept or reject each one."
        className="max-h-[calc(100dvh-2rem)] overflow-y-auto"
      >
        <div data-testid="agent-dialog">
          <AgentDialogBody doc={doc} />
        </div>
      </DialogContent>
    </Dialog>
  );
}
