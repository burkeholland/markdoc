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

    await advance(10_000);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("checks immediately, suppresses every tick while pending, and retries failures on cadence", async () => {
    const first = deferred();
    fetchMock.mockReturnValueOnce(first.promise).mockResolvedValueOnce(response([])).mockReturnValueOnce(new Promise(() => {}));

    render(<CopilotChecklist hasAgentRequests={false} pollMs={1_000} />);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await advance(5_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await settle(() => first.reject(new Error("offline")));
    await advance(999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await advance(999);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await advance(1);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("keeps token, MCP, and Try milestones monotonic, then stops when all are done", async () => {
    fetchMock
      .mockResolvedValueOnce(response([seenToken]))
      .mockResolvedValueOnce(response([]))
      .mockResolvedValueOnce(response([calledToken]));
    const view = render(<CopilotChecklist hasAgentRequests={false} pollMs={1_000} />);

    await settle(() => {});
    expectProgress(2);

    await advance(1_000);
    expectProgress(2);
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
    await advance(10_000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("invalidates a pending settlement when props change and does not restart retired polling", async () => {
    const retired = deferred();
    const current = deferred();
    fetchMock.mockReturnValueOnce(retired.promise).mockReturnValueOnce(current.promise);
    const view = render(<CopilotChecklist hasAgentRequests={false} pollMs={1_000} />);
    expectProgress(0);

    view.rerender(<CopilotChecklist hasAgentRequests pollMs={1_000} />);
    expectProgress(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await settle(() => retired.resolve(response([calledToken])));
    expectProgress(1);
    await advance(1_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await settle(() => current.resolve(response([calledToken])));
    expectProgress(4);

    view.rerender(<CopilotChecklist hasAgentRequests={false} pollMs={3_000} />);
    await advance(12_000);
    expectProgress(4);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("ignores settlements and issues no more calls after unmount", async () => {
    const pending = deferred();
    fetchMock.mockReturnValueOnce(pending.promise);
    const view = render(<CopilotChecklist hasAgentRequests={false} pollMs={1_000} />);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    view.unmount();
    await settle(() => pending.resolve(response([calledToken])));
    await advance(10_000);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("copilot-checklist")).toBeNull();
  });
});
