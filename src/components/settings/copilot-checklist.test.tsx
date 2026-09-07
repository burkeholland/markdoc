// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiTokenDto } from "@/lib/api";
import { CopilotChecklist } from "./copilot-checklist";

const fetchMock = vi.fn<typeof fetch>();
type ChecklistToken = Pick<ApiTokenDto, "lastMcpSeenAt" | "lastMcpCallAt">;
const emptyToken: ChecklistToken = { lastMcpSeenAt: null, lastMcpCallAt: null };
const seenToken: ChecklistToken = { ...emptyToken, lastMcpSeenAt: "2026-09-07T15:00:00.000Z" };
const calledToken: ChecklistToken = { ...seenToken, lastMcpCallAt: "2026-09-07T15:01:00.000Z" };

function response(tokens: ChecklistToken[]) {
  return new Response(JSON.stringify({ tokens }), { headers: { "Content-Type": "application/json" } });
}

function deferred() {
  let resolve!: (value: Response) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<Response>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

async function settle(action: () => void) {
  await act(async () => {
    action();
    await Promise.resolve();
  });
}

function expectProgress(done: number) {
  expect(screen.getByTestId("copilot-checklist-progress")).toHaveTextContent(`${done} of 4`);
}

beforeEach(() => {
  vi.useFakeTimers();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("Copilot setup checklist polling", () => {
  it("uses the initial token milestones and honors disabled polling", async () => {
    render(<CopilotChecklist hasAgentRequests={false} initialTokens={[seenToken]} pollMs={0} />);
    expectProgress(2);
    expect(vi.getTimerCount()).toBe(0);

    await advance(10_000);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps one physical request across pending ticks and newer agent-request facts", async () => {
    const retired = deferred();
    const current = deferred();
    fetchMock.mockReturnValueOnce(retired.promise).mockReturnValueOnce(current.promise);
    const view = render(<CopilotChecklist hasAgentRequests={false} pollMs={1_000} />);
    expectProgress(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);

    await advance(5_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    view.rerender(<CopilotChecklist hasAgentRequests pollMs={1_000} />);
    expectProgress(1);
    expect(vi.getTimerCount()).toBe(1);
    await advance(2_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await settle(() => retired.resolve(response([calledToken])));
    expectProgress(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);

    await advance(999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await settle(() => current.resolve(response([calledToken])));
    expectProgress(4);
    expect(vi.getTimerCount()).toBe(0);
    await advance(10_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keeps one physical request across newer initial-token facts and stale failure", async () => {
    const retired = deferred();
    const current = deferred();
    fetchMock.mockReturnValueOnce(retired.promise).mockReturnValueOnce(current.promise);
    const view = render(<CopilotChecklist hasAgentRequests={false} pollMs={1_000} />);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);

    view.rerender(<CopilotChecklist hasAgentRequests={false} initialTokens={[seenToken]} pollMs={1_000} />);
    expectProgress(2);
    await advance(5_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);

    await settle(() => retired.reject(new Error("stale offline")));
    expectProgress(2);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);

    await advance(999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await settle(() => current.resolve(response([])));
    expectProgress(2);
    expect(vi.getTimerCount()).toBe(1);
  });

  it("retries a current transient failure on the next interval", async () => {
    const failed = deferred();
    const retried = deferred();
    fetchMock.mockReturnValueOnce(failed.promise).mockReturnValueOnce(retried.promise);
    render(<CopilotChecklist hasAgentRequests={false} pollMs={1_000} />);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await settle(() => failed.reject(new Error("offline")));
    expectProgress(0);
    expect(vi.getTimerCount()).toBe(1);
    await advance(999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await settle(() => retried.resolve(response([seenToken])));
    expectProgress(2);
    expect(vi.getTimerCount()).toBe(1);
  });

  it("keeps milestones monotonic and stops its only timer when all are done", async () => {
    fetchMock
      .mockResolvedValueOnce(response([seenToken]))
      .mockResolvedValueOnce(response([]))
      .mockResolvedValueOnce(response([calledToken]));
    const view = render(<CopilotChecklist hasAgentRequests={false} pollMs={1_000} />);

    await settle(() => {});
    expectProgress(2);
    expect(vi.getTimerCount()).toBe(1);

    await advance(1_000);
    expectProgress(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId("checklist-token")).toHaveAttribute("data-done", "true");
    expect(screen.getByTestId("checklist-config")).toHaveAttribute("data-done", "true");

    view.rerender(<CopilotChecklist hasAgentRequests initialTokens={[]} pollMs={1_000} />);
    expectProgress(3);
    expect(screen.getByTestId("checklist-try")).toHaveAttribute("data-done", "true");
    view.rerender(<CopilotChecklist hasAgentRequests={false} initialTokens={[]} pollMs={1_000} />);
    expectProgress(3);

    await advance(1_000);
    expectProgress(4);
    expect(screen.getByTestId("checklist-allow")).toHaveAttribute("data-done", "true");
    expect(vi.getTimerCount()).toBe(0);
    await advance(10_000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("replaces and disables intervals without overlapping or accepting retired requests", async () => {
    const oldInterval = deferred();
    const disabled = deferred();
    fetchMock.mockReturnValueOnce(oldInterval.promise).mockReturnValueOnce(disabled.promise);
    const view = render(<CopilotChecklist hasAgentRequests={false} pollMs={1_000} />);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);

    view.rerender(<CopilotChecklist hasAgentRequests={false} pollMs={3_000} />);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);
    await advance(2_999);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await settle(() => oldInterval.resolve(response([calledToken])));
    expectProgress(0);
    expect(vi.getTimerCount()).toBe(1);
    await advance(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    view.rerender(<CopilotChecklist hasAgentRequests={false} pollMs={0} />);
    expect(vi.getTimerCount()).toBe(0);
    await settle(() => disabled.resolve(response([calledToken])));
    expectProgress(0);
    await advance(10_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each(["success", "failure"] as const)("ignores post-unmount %s settlements and issues no more calls", async (settlement) => {
    const pending = deferred();
    fetchMock.mockReturnValueOnce(pending.promise);
    const view = render(<CopilotChecklist hasAgentRequests={false} pollMs={1_000} />);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);

    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
    await settle(() => {
      if (settlement === "success") pending.resolve(response([calledToken]));
      else pending.reject(new Error("unmounted offline"));
    });
    await advance(10_000);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("copilot-checklist")).toBeNull();
  });
});
