import type { HeadingInfo } from "../markdown/parse";

/** A collaborator whose cursor has not moved for this long renders dimmed. */
export const IDLE_AFTER_MS = 60_000;

/** How often (at most) the local `lastActive` timestamp is published. */
export const ACTIVITY_THROTTLE_MS = 2_000;

/**
 * Text of the nearest heading at or above `offset`, or null before the first
 * heading. `headings` must be in document order (as `getHeadings()` returns them).
 */
export function sectionAt(headings: readonly HeadingInfo[], offset: number | null): string | null {
  if (offset === null || headings.length === 0) return null;
  let lo = 0;
  let hi = headings.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (headings[mid].from <= offset) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found === -1 ? null : headings[found].text;
}

/** Whether a user whose last activity was at `lastActive` counts as idle at `now`. */
export function isIdle(lastActive: number | null, now: number, threshold = IDLE_AFTER_MS): boolean {
  if (lastActive === null) return false;
  return now - lastActive >= threshold;
}

export type FollowEvent =
  | { type: "follow"; userId: string }
  | { type: "stop" }
  | { type: "user-scroll" }
  | { type: "typing" }
  | { type: "presence"; userIds: readonly string[] };

export interface FollowTransition {
  /** User being followed after the event. */
  userId: string | null;
  /** Set when following ended because the followed user left the document. */
  left: string | null;
}

/**
 * Pure state machine for "follow a collaborator": the session feeds it events and
 * applies the result. Following the same user twice is a no-op; following a new
 * user switches; any interaction by the local user (Esc/Stop, scrolling, typing)
 * stops; a presence update without the followed user stops and reports who left.
 */
export function followReducer(current: string | null, event: FollowEvent): FollowTransition {
  switch (event.type) {
    case "follow":
      return { userId: event.userId, left: null };
    case "stop":
    case "user-scroll":
    case "typing":
      return { userId: null, left: null };
    case "presence":
      if (current !== null && !event.userIds.includes(current)) return { userId: null, left: current };
      return { userId: current, left: null };
  }
}
