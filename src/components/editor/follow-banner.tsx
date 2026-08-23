"use client";

import { X } from "lucide-react";
import type { CollabSession } from "@/editor/collab/session";
import { jsonEqual, useSessionValue } from "./use-session";

/**
 * Slim strip above the panes while the viewport is glued to a collaborator's cursor.
 * Coloured with that user's presence colour; Esc or the Stop button ends following.
 */
export function FollowBanner({ session }: { session: CollabSession }) {
  const followed = useSessionValue(
    session,
    (s) => {
      if (!s.followUserId) return null;
      const u = s.presence().find((p) => p.id === s.followUserId);
      return u ? { id: u.id, name: u.name, color: u.color, section: u.section } : null;
    },
    jsonEqual,
  );
  if (!followed) return null;
  return (
    <div
      className="flex h-8 shrink-0 items-center justify-center gap-2 px-3 text-[13px] font-medium text-white"
      style={{ backgroundColor: followed.color }}
      role="status"
      data-testid="follow-banner"
      data-user-id={followed.id}
    >
      <span>
        Following {followed.name}
        {followed.section ? <span className="opacity-80"> · in ‘{followed.section}’</span> : null}
      </span>
      <span className="opacity-60">·</span>
      <button
        type="button"
        className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 hover:bg-white/20 focus-visible:outline focus-visible:outline-2 focus-visible:outline-white"
        onClick={() => session.follow(null)}
        data-testid="follow-stop"
      >
        <X size={13} />
        Stop <span className="opacity-70">(Esc)</span>
      </button>
    </div>
  );
}
