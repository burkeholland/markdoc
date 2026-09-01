import { describe, expect, it } from "vitest";
import type { PresenceUser } from "@/editor/collab/session";
import { claimerName, type AgentRequestMirror } from "./agent-requests";
import { AGENT_ACTIVITY_SHOW_FOR_MS, activityVerb, busyAgentNames, isRecentActivity, pendingWorker, presenceAgentName, presenceNameOf, secondsAgo, waitingLabel } from "./presence-agents";

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

  it("labels someone else's agent with its owner for the viewer (#1296)", () => {
    const claimed = [request({ status: "claimed", claimedBy: "Copilot CLI", claimedByLogin: "burkeholland" })];
    expect(pendingWorker(claimed, "burkeholland")).toBe("Copilot CLI");
    expect(pendingWorker(claimed, "drew")).toBe("burkeholland's Copilot CLI");
    expect(pendingWorker(claimed, "drew", (login) => (login === "burkeholland" ? "Burke" : null))).toBe("Burke's Copilot CLI");
  });
});

describe("claimerName / presence names (#1296)", () => {
  const user = (over: Partial<PresenceUser>): PresenceUser => ({
    id: "u",
    name: "Someone",
    color: "#000",
    colorLight: "#fff",
    clientId: 1,
    cursor: null,
    section: null,
    idleSince: null,
    role: null,
    isLocal: false,
    isAgent: false,
    status: null,
    ownerLogin: null,
    ownerName: null,
    ...over,
  });
  const users = [
    user({ id: "u-drew", name: "Drew", login: "drew" }),
    user({ id: "agent:burke", name: "Copilot CLI", isAgent: true, ownerLogin: "burkeholland", ownerName: "Burke" }),
    user({ id: "agent:alice", name: "Scribe", isAgent: true, ownerLogin: "alice", ownerName: null }),
  ];

  it("reads the claimer as the viewer should: bare for their own token, owner-labelled for anyone else's", () => {
    expect(claimerName(request({ status: "claimed", claimedBy: null }), "drew")).toBe("An agent");
    expect(claimerName(request({ status: "claimed", claimedBy: "Copilot CLI" }), "drew")).toBe("Copilot CLI");
    const r = request({ status: "claimed", claimedBy: "Copilot CLI", claimedByLogin: "burkeholland" });
    expect(claimerName(r, "burkeholland")).toBe("Copilot CLI");
    expect(claimerName(r, "drew")).toBe("burkeholland's Copilot CLI");
    expect(claimerName(r, "drew", (login) => presenceNameOf(users, login))).toBe("Burke's Copilot CLI");
  });

  it("finds a display name in presence by login: a person by theirs, an agent's owner by the agent's", () => {
    expect(presenceNameOf(users, "drew")).toBe("Drew");
    expect(presenceNameOf(users, "BurkeHolland")).toBe("Burke");
    expect(presenceNameOf(users, "alice")).toBeNull();
    expect(presenceNameOf(users, "nobody")).toBeNull();
  });

  it("labels a present agent for the viewer", () => {
    expect(presenceAgentName(users[1], "burkeholland")).toBe("Copilot CLI");
    expect(presenceAgentName(users[1], "drew")).toBe("Burke's Copilot CLI");
    expect(presenceAgentName(users[2], "drew")).toBe("alice's Scribe");
    expect(presenceAgentName(users[0], "drew")).toBe("Drew");
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
