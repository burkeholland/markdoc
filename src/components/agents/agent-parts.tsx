"use client";

import { useId } from "react";
import { Check } from "lucide-react";
import { RelativeTime } from "@/components/ui/relative-time";
import { CHECK_REQUESTS_PROMPT, joinDocumentPrompt } from "@/lib/agent-clients";
import { CopyBlock } from "./copy-block";

export type DocRef = { id: string; title: string };

export const inviteTitle = (doc?: DocRef) => (doc ? `Ask your agent to join “${doc.title}”` : "Ask your agent to check in");

/** "Copilot CLI is connected", with when it was last seen. Shared by the wizard's last state and the returning-user view. */
export function ConnectedBanner({ names, lastSeen }: { names: string[]; lastSeen: string | null }) {
  const shown = names.slice(0, 2);
  const more = names.length - shown.length;
  const label = `${shown.join(", ")}${more > 0 ? ` and ${more} more` : ""}`;
  return (
    <div className="flex items-center gap-3 rounded-xl bg-surface-2 px-3 py-2.5" role="status" data-testid="agent-connected-banner">
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent" aria-hidden="true">
        <Check size={16} strokeWidth={3} />
      </span>
      <div className="min-w-0 flex-1 text-sm">
        <p className="truncate font-medium text-ink" title={names.join(", ")}>
          {label} {names.length === 1 ? "is" : "are"} connected
        </p>
        {lastSeen && (
          <p className="text-xs text-ink-3">
            <RelativeTime date={lastSeen} prefix="Last seen " />
          </p>
        )}
      </div>
    </div>
  );
}

/** The explanation and the sentence to paste into an agent: join this document, or (without one) check in for requests. */
export function InviteBody({ doc, primary }: { doc?: DocRef; primary: boolean }) {
  return (
    <>
      <p className="text-sm text-ink-2">
        {doc
          ? "Paste this into your agent. While it runs, comments, @mentions and requests reach it within a minute."
          : "Paste this into your agent. It picks up what you asked for in the editor and replies with suggestions you accept or reject."}
      </p>
      <CopyBlock
        prose
        value={doc ? joinDocumentPrompt(doc) : CHECK_REQUESTS_PROMPT}
        label="Copy instruction for your agent"
        primary={primary}
        testId="agent-invite-prompt"
        copyTestId="agent-invite-copy"
      />
    </>
  );
}

/** The invite as its own section, for a screen where the agent is already connected. */
export function InviteBlock({ doc, headingLevel = 3 }: { doc?: DocRef; headingLevel?: 3 | 4 }) {
  const headingId = useId();
  const Heading = headingLevel === 3 ? "h3" : "h4";
  return (
    <section className="flex flex-col gap-2.5" aria-labelledby={headingId} data-testid="agent-invite">
      <Heading id={headingId} className="text-sm font-semibold text-ink">
        {inviteTitle(doc)}
      </Heading>
      <InviteBody doc={doc} primary />
    </section>
  );
}
