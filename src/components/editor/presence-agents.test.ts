import { describe, expect, it } from "vitest";
import type { AgentRequestMirror } from "./agent-requests";
import { AGENT_ACTIVITY_SHOW_FOR_MS, activityVerb, busyAgentNames, isRecentActivity, pendingWorker, secondsAgo, waitingLabel } from "./presence-agents";

const NOW = 1_700_000_000_000;

function request(over: Partial<AgentRequestMirror>): AgentRequestMirror {
  return { id: "r1", status: "open", mode: "suggest", instruction: "Tighten this", claimedBy: null, result: null, userId: "u1", updatedAt: NOW - 10_000, ...over };
}

describe("busyAgentNames", () => {
  it("is empty without claimed requests or fresh activity", () => {
    expect(busyAgentNames([], null, NOW).size).toBe(0);
    expect(busyAgentNames([request({})], null, NOW).size).toBe(0);
    expect(busyAgentNames([], { name: "Copilot", userName: "alice", action: "edited", at: NOW - AGENT_ACTIVITY_SHOW_FOR_MS - 1 }, NOW).size).toBe(0);
  });

  it("names the agent holding a claimed request", () => {
    expect([...busyAgentNames([request({ status: "claimed", claimedBy: "Copilot CLI" })], null, NOW)]).toEqual(["Copilot CLI"]);
  });

  it("names the agent behind activity younger than 45 s", () => {
    const activity = { name: "Copilot", userName: "alice", action: "suggested", at: NOW - 12_000 };
    expect([...busyAgentNames([], activity, NOW)]).toEqual(["Copilot"]);
    expect(isRecentActivity(activity, NOW)).toBe(true);
    expect(isRecentActivity(activity, NOW + AGENT_ACTIVITY_SHOW_FOR_MS)).toBe(false);
  });

  it("a request the agent finished after its last write ends the activity-driven busy state", () => {
    const activity = { name: "Copilot", userName: "alice", action: "suggested", at: NOW - 12_000 };
    const done = request({ status: "done", claimedBy: "Copilot", updatedAt: NOW - 5_000, result: { suggestions: 2, comments: 0 } });
    expect(busyAgentNames([done], activity, NOW).size).toBe(0);
    // Another agent's completion, or one that predates the write, does not.
    expect([...busyAgentNames([request({ status: "done", claimedBy: "Other", updatedAt: NOW - 5_000 })], activity, NOW)]).toEqual(["Copilot"]);
    expect([...busyAgentNames([request({ status: "done", claimedBy: "Copilot", updatedAt: NOW - 20_000 })], activity, NOW)]).toEqual(["Copilot"]);
    // A cancelled request counts as finished too.
    expect(busyAgentNames([request({ status: "cancelled", claimedBy: "Copilot", updatedAt: NOW - 5_000 })], activity, NOW).size).toBe(0);
  });
});

describe("pendingWorker", () => {
  it("names the agent that claimed a pending request, if any", () => {
    expect(pendingWorker([request({})])).toBeNull();
    expect(pendingWorker([request({}), request({ id: "r2", status: "claimed", claimedBy: "Copilot CLI" })])).toBe("Copilot CLI");
  });
});

describe("presence wording", () => {
  it("turns actions into the verbs the row shows", () => {
    expect(activityVerb("suggested")).toBe("proposed changes");
    expect(activityVerb("commented")).toBe("commented");
    expect(activityVerb("reviewed")).toBe("reviewed suggestions");
    expect(activityVerb("edited")).toBe("edited");
    expect(activityVerb("anything-else")).toBe("edited");
  });

  it("counts seconds, says 'just now' at first and never goes negative", () => {
    expect(secondsAgo(NOW - 12_400, NOW)).toBe("12 s ago");
    expect(secondsAgo(NOW - 5_000, NOW)).toBe("5 s ago");
    expect(secondsAgo(NOW - 2_000, NOW)).toBe("just now");
    expect(secondsAgo(NOW + 3_000, NOW)).toBe("just now");
  });

  it("pluralises the waiting label", () => {
    expect(waitingLabel(1)).toBe("1 request waiting for an agent");
    expect(waitingLabel(3)).toBe("3 requests waiting for an agent");
  });
});
