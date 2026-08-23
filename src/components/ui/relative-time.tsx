"use client";

import { useSyncExternalStore } from "react";
import { formatDateTime, relativeTime } from "@/lib/utils";

// One shared minute ticker for every mounted <RelativeTime>: the interval runs only while at
// least one component is subscribed, and its snapshot is the time of the last tick.
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;
let lastTick = 0;

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (timer === null) {
    // Fresh clock for the first subscriber; React re-renders if the snapshot changed since render.
    lastTick = Date.now();
    timer = setInterval(() => {
      lastTick = Date.now();
      for (const l of listeners) l();
    }, 60_000);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };
}

function getNow(): number {
  if (lastTick === 0) lastTick = Date.now();
  return lastTick;
}

// The server (and the hydrating client) has no clock to agree on: render the absolute date.
function getServerNow(): number {
  return 0;
}

/** Absolute short date, in UTC so the server and the hydrating client always agree ("Aug 22"). */
export function shortDate(date: Date, now = Date.now()): string {
  const sameYear = date.getUTCFullYear() === new Date(now).getUTCFullYear();
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: sameYear ? undefined : "numeric", timeZone: "UTC" });
}

export interface RelativeTimeProps {
  date: string | number | Date;
  /** Text rendered before the time, e.g. "Edited ". */
  prefix?: string;
  className?: string;
}

/**
 * "Edited 3 minutes ago" that stays in sync with the clock and never causes a hydration
 * mismatch: the server renders the absolute date ("Aug 22"), the client switches to relative
 * text right after mount and refreshes it every minute.
 */
export function RelativeTime({ date, prefix = "", className }: RelativeTimeProps) {
  const d = date instanceof Date ? date : new Date(date);
  const now = useSyncExternalStore(subscribe, getNow, getServerNow);
  const hydrated = now !== 0;
  const text = hydrated ? relativeTime(d, now) : shortDate(d);
  return (
    <time dateTime={d.toISOString()} title={hydrated ? formatDateTime(d) : undefined} className={className} data-relative={hydrated || undefined}>
      {prefix + text}
    </time>
  );
}
