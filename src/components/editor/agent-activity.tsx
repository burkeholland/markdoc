"use client";

import { useEffect, useState } from "react";
import { Bot } from "lucide-react";
import type { CollabSession } from "@/editor/collab/session";
import type { AgentActivity } from "@/server/agents";
import { Tip } from "@/components/ui/primitives";
import { relativeTime } from "@/lib/utils";
import { useSessionValue } from "./use-session";

const SHOW_FOR_MS = 45_000;

/** Small chip in the header while an agent (API token) is working on the document. */
export function AgentActivityChip({ session }: { session: CollabSession }) {
  const activity = useSessionValue(session, (s) => (s.meta.get("agentActivity") as AgentActivity | undefined) ?? null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!activity) return;
    const tick = setInterval(() => setNow(Date.now()), 5_000);
    return () => clearInterval(tick);
  }, [activity]);
  if (!activity || now - activity.at > SHOW_FOR_MS) return null;
  const verb = activity.action === "suggested" ? "proposed changes" : activity.action === "commented" ? "commented" : activity.action === "reviewed" ? "reviewed suggestions" : "edited";
  return (
    <Tip label={`${activity.name} (for ${activity.userName}) ${verb} ${relativeTime(activity.at, now)}`}>
      <span className="inline-flex h-9 items-center gap-1.5 rounded-full border border-violet-200 bg-violet-50 px-3 text-xs font-medium text-violet-800 animate-fade-in" data-testid="agent-activity">
        <Bot size={14} />
        <span className="max-w-40 truncate">{activity.name}</span>
        <span className="text-violet-500">{verb}</span>
      </span>
    </Tip>
  );
}
