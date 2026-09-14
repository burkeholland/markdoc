"use client";

import { useSyncExternalStore } from "react";
import { formatDateTime, relativeTime } from "@/lib/utils";

type Listener = () => void;

interface SubscriberRegistration {
  readonly listener: Listener;
  readonly generation: TickerGeneration;
  active: boolean;
}

interface TickerGeneration {
  readonly identity: symbol;
  readonly callback: () => void;
  readonly visibilityCallback: () => void;
  readonly registrations: Set<SubscriberRegistration>;
  interval: ReturnType<typeof setInterval> | null;
  active: boolean;
}

let currentGeneration: TickerGeneration | null = null;
let currentSnapshot = 0;

function isCurrentGeneration(generation: TickerGeneration): boolean {
  return generation.active && currentGeneration?.identity === generation.identity;
}

function tick(generation: TickerGeneration): void {
  if (!isCurrentGeneration(generation)) return;

  currentSnapshot = Date.now();
  const registrations = [...generation.registrations];
  for (const registration of registrations) {
    if (!isCurrentGeneration(generation)) return;
    if (registration.active) registration.listener();
  }
}

function createGeneration(): TickerGeneration {
  const generation: TickerGeneration = {
    identity: Symbol("relative-time-ticker"),
    interval: null,
    callback: () => tick(generation),
    visibilityCallback: () => {
      if (document.visibilityState === "visible") tick(generation);
    },
    active: true,
    registrations: new Set(),
  };
  return generation;
}

function subscribe(listener: Listener): () => void {
  let generation = currentGeneration;
  if (!generation || !generation.active) {
    generation = createGeneration();
    currentGeneration = generation;
  }

  const registration: SubscriberRegistration = { listener, generation, active: true };
  generation.registrations.add(registration);
  if (generation.interval === null) {
    currentSnapshot = Date.now();
    generation.interval = setInterval(generation.callback, 60_000);
    document.addEventListener("visibilitychange", generation.visibilityCallback);
  }

  return () => {
    if (!registration.active) return;

    registration.active = false;
    generation.registrations.delete(registration);
    if (!generation.active || generation.registrations.size !== 0) return;

    generation.active = false;
    if (currentGeneration?.identity === generation.identity) currentGeneration = null;
    document.removeEventListener("visibilitychange", generation.visibilityCallback);
    if (generation.interval !== null) clearInterval(generation.interval);
  };
}

function getNow(): number {
  if (currentSnapshot === 0) currentSnapshot = Date.now();
  return currentSnapshot;
}

// The server (and the hydrating client) has no clock to agree on: render the absolute date.
function getServerNow(): number {
  return 0;
}

/** Absolute short date with its year, in UTC so the server and the hydrating client always agree ("Aug 22, 2026"). */
export function shortDate(date: Date): string {
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

export interface RelativeTimeProps {
  date: string | number | Date;
  /** Text rendered before the time, e.g. "Edited ". */
  prefix?: string;
  className?: string;
}

/**
 * "Edited 3 minutes ago" that stays in sync with the clock and never causes a hydration
 * mismatch: the server renders the absolute date ("Aug 22, 2026"), the client switches to relative
 * text right after mount and refreshes it every minute and when the tab becomes visible.
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
