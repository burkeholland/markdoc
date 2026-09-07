"use client";

import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { X } from "lucide-react";
import type { CollabSession } from "@/editor/collab/session";
import { jsonEqual, useSessionValue } from "./use-session";

interface FollowedSnapshot {
  followUserId: string;
  id: string;
  name: string;
  color: string;
  section: string | null;
}

interface FollowRender {
  mount: symbol;
  session: CollabSession;
  followed: FollowedSnapshot;
  follow: CollabSession["follow"];
}

interface FollowPublication {
  render: FollowRender;
  banner: HTMLDivElement;
  stop: HTMLButtonElement;
}

/**
 * Slim strip above the panes while the viewport is glued to a collaborator's cursor.
 * Coloured with that user's presence colour; Esc or the Stop button ends following.
 */
export function FollowBanner({ session }: { session: CollabSession }) {
  const [mount] = useState(() => Symbol("follow-banner"));
  const authority = useRef<FollowPublication | null>(null);
  const claimed = useRef(new WeakSet<FollowPublication>());
  const bannerRef = useRef<HTMLDivElement>(null);
  const stopRef = useRef<HTMLButtonElement>(null);
  const followed = useSessionValue(
    session,
    (s) => {
      const followUserId = s.followUserId;
      if (!followUserId) return null;
      const u = s.presence().find((p) => p.id === followUserId);
      return u ? { followUserId, id: u.id, name: u.name, color: u.color, section: u.section } : null;
    },
    jsonEqual,
  );

  const rendered = useMemo<FollowRender | null>(
    () => (followed ? { mount, session, followed, follow: session.follow } : null),
    [followed, mount, session],
  );

  useLayoutEffect(() => {
    const banner = bannerRef.current;
    const stop = stopRef.current;
    if (!rendered || !banner || !stop) return;

    const publication: FollowPublication = { render: rendered, banner, stop };
    authority.current = publication;

    return () => {
      if (authority.current === publication) authority.current = null;
    };
  }, [rendered]);

  const stopFollowing = () => {
    const publication = authority.current;
    if (
      !rendered ||
      !publication ||
      publication.render !== rendered ||
      publication.render.mount !== mount ||
      claimed.current.has(publication) ||
      bannerRef.current !== publication.banner ||
      stopRef.current !== publication.stop ||
      !publication.banner.isConnected ||
      !publication.stop.isConnected ||
      !publication.banner.contains(publication.stop)
    ) {
      return;
    }

    claimed.current.add(publication);
    authority.current = null;

    const { followed, session: publishedSession } = publication.render;
    if (publishedSession.followUserId !== followed.followUserId) return;
    const current = publishedSession.presence().find((user) => user.id === followed.id);
    if (
      !current ||
      current.id !== followed.id ||
      current.name !== followed.name ||
      current.color !== followed.color ||
      current.section !== followed.section
    ) {
      return;
    }
    publication.render.follow.call(publishedSession, null);
  };

  if (!followed) return null;
  return (
    <div
      ref={bannerRef}
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
        ref={stopRef}
        type="button"
        className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 hover:bg-white/20 focus-visible:outline focus-visible:outline-2 focus-visible:outline-white"
        onClick={stopFollowing}
        data-testid="follow-stop"
      >
        <X size={13} />
        Stop <span className="opacity-70">(Esc)</span>
      </button>
    </div>
  );
}
