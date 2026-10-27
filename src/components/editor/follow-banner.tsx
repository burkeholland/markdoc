"use client";

import { useEffect } from "react";
import { X } from "lucide-react";
import type { CollabSession } from "@/editor/collab/session";
import { jsonEqual, useSessionValue } from "./use-session";

const BANNER_CLASS =
  "flex h-8 min-w-0 shrink-0 items-center justify-center gap-2 px-3 text-[13px] font-medium text-white";
const MESSAGE_CLASS = "min-w-0 flex-initial truncate";
const SECTION_CLASS = "opacity-80";
const SEPARATOR_CLASS = "shrink-0 opacity-60";
const STOP_CLASS =
  "inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 hover:bg-white/20 focus-visible:outline focus-visible:outline-2 focus-visible:outline-white";
const SHORTCUT_CLASS = "opacity-70";

function followMessage(name: string, section: string | null) {
  return `Following ${name}${section ? ` · in ‘${section}’` : ""}`;
}

/**
 * Slim strip above the panes while the viewport is glued to a collaborator's cursor.
 * Coloured with that user's presence colour; Esc or the Stop button ends following.
 */
export function FollowBanner({ session }: { session: CollabSession }) {
  const followed = useSessionValue(
    session,
    (s) => {
      const followUserId = s.followUserId;
      if (!followUserId) return null;
      const user = s.presence().find((candidate) => candidate.id === followUserId);
      return user ? { id: user.id, name: user.name, color: user.color, section: user.section } : null;
    },
    jsonEqual,
  );
  const active = followed !== null;

  useEffect(() => {
    if (!active) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.key !== "Escape" ||
        event.defaultPrevented ||
        event.repeat ||
        event.isComposing ||
        event.ctrlKey ||
        event.altKey ||
        event.metaKey ||
        event.shiftKey
      ) {
        return;
      }
      event.preventDefault();
      session.follow(null);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [active, session]);

  if (!followed) return null;
  return (
    <div
      className={BANNER_CLASS}
      style={{ backgroundColor: followed.color }}
      role="status"
      data-testid="follow-banner"
      data-user-id={followed.id}
    >
      <span className={MESSAGE_CLASS} title={followMessage(followed.name, followed.section)}>
        Following {followed.name}
        {followed.section ? (
          <span className={SECTION_CLASS}>
            {" · in ‘"}{followed.section}{"’"}
          </span>
        ) : null}
      </span>
      <span className={SEPARATOR_CLASS}>·</span>
      <button type="button" className={STOP_CLASS} onClick={() => session.follow(null)} data-testid="follow-stop">
        <X size={13} />
        Stop <span className={SHORTCUT_CLASS}>(Esc)</span>
      </button>
    </div>
  );
}
