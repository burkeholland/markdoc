// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
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

function checklistWithBoundary(boundary: string, hasAgentRequests: boolean, pollMs = 1_000) {
  return (
    <>
      <span key={boundary} data-testid={`boundary-${boundary}`} />
      <CopilotChecklist hasAgentRequests={hasAgentRequests} pollMs={pollMs} />
    </>
  );
}

function reactHandler<T>(element: HTMLElement, name: string): T {
  const propsKey = Object.keys(element).find((key) => key.startsWith("__reactProps$"));
  if (!propsKey) throw new Error(`React props were not attached to ${element.dataset.testid ?? element.tagName}`);
  const props = (element as unknown as Record<string, Record<string, unknown> | undefined>)[propsKey];
  const handler = props?.[name];
  if (typeof handler !== "function") throw new Error(`${name} was not attached to ${element.dataset.testid ?? element.tagName}`);
  return handler as T;
}

interface RetryEvent {
  type: string;
  currentTarget: EventTarget | null;
  target: EventTarget | null;
  nativeEvent: Event;
  defaultPrevented: boolean;
}

type RetryHandler = (event: RetryEvent) => void;

async function renderStrict(root: ReturnType<typeof createRoot>, checklist: React.ReactNode) {
  await act(async () => {
    root.render(<StrictMode>{checklist}</StrictMode>);
  });
}

function replayHandlerOnNextClick(handler: RetryHandler, button: HTMLButtonElement) {
  button.addEventListener("click", (nativeEvent) => {
    handler({
      type: "click",
      currentTarget: button,
      target: nativeEvent.target,
      nativeEvent,
      defaultPrevented: nativeEvent.defaultPrevented,
    });
  }, { capture: true, once: true });
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

  it("retires a pending visit across newer agent-request facts and reads the current facts immediately", async () => {
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
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(1);
    await advance(2_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await settle(() => retired.resolve(response([calledToken])));
    expectProgress(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(1);

    await settle(() => current.resolve(response([calledToken])));
    expectProgress(4);
    expect(vi.getTimerCount()).toBe(0);
    await advance(10_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("snapshots mutable initial-token facts and retires the prior visit", async () => {
    const retired = deferred();
    const current = deferred();
    fetchMock.mockReturnValueOnce(retired.promise).mockReturnValueOnce(current.promise);
    const initialTokens: ChecklistToken[] = [];
    const view = render(<CopilotChecklist hasAgentRequests={false} initialTokens={initialTokens} pollMs={1_000} />);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);

    initialTokens.push(seenToken);
    view.rerender(<CopilotChecklist hasAgentRequests={false} initialTokens={initialTokens} pollMs={1_000} />);
    expectProgress(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await advance(5_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(1);

    await settle(() => retired.reject(new Error("stale offline")));
    expectProgress(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(1);

    await settle(() => current.resolve(response([])));
    expectProgress(2);
    expect(vi.getTimerCount()).toBe(1);
  });

  it.each(["immutable", "in-place"] as const)(
    "retires polling without a new request when %s initial-token facts complete the checklist",
    async (update) => {
      const retired = deferred();
      const unexpected = deferred();
      fetchMock.mockReturnValueOnce(retired.promise).mockReturnValueOnce(unexpected.promise);
      const initialTokens: ChecklistToken[] = [];
      const host = document.createElement("div");
      document.body.append(host);
      const root = createRoot(host);

      try {
        await act(async () =>
          root.render(
            <CopilotChecklist hasAgentRequests={false} initialTokens={initialTokens} pollMs={1_000} />,
          ),
        );
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(vi.getTimerCount()).toBe(1);

        const completedTokens = update === "immutable" ? [calledToken] : initialTokens;
        if (update === "in-place") initialTokens.push(calledToken);
        await act(async () =>
          root.render(<CopilotChecklist hasAgentRequests={false} initialTokens={completedTokens} pollMs={1_000} />),
        );

        expect(host.querySelector('[data-testid="copilot-checklist-progress"]')).toHaveTextContent("4 of 4");
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(vi.getTimerCount()).toBe(0);

        await settle(() => retired.resolve(response([])));
        await advance(10_000);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        await act(async () => root.unmount());
        host.remove();
      }
    },
  );

  it("starts one immediate current read when incoming initial-token facts advance without completing", async () => {
    const retired = deferred();
    const current = deferred();
    fetchMock.mockReturnValueOnce(retired.promise).mockReturnValueOnce(current.promise);
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);

    try {
      await act(async () =>
        root.render(<CopilotChecklist hasAgentRequests={false} initialTokens={[]} pollMs={1_000} />),
      );
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(1);

      await act(async () =>
        root.render(<CopilotChecklist hasAgentRequests={false} initialTokens={[seenToken]} pollMs={1_000} />),
      );
      expect(host.querySelector('[data-testid="copilot-checklist-progress"]')).toHaveTextContent("2 of 4");
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(vi.getTimerCount()).toBe(1);

      await advance(10_000);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      await settle(() => retired.resolve(response([calledToken])));
      expect(host.querySelector('[data-testid="copilot-checklist-progress"]')).toHaveTextContent("2 of 4");
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(vi.getTimerCount()).toBe(1);
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
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
    const retired = deferred();
    const completed = deferred();
    fetchMock
      .mockResolvedValueOnce(response([seenToken]))
      .mockResolvedValueOnce(response([]))
      .mockReturnValueOnce(retired.promise)
      .mockReturnValueOnce(completed.promise);
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
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(screen.getByTestId("checklist-try")).toHaveAttribute("data-done", "true");
    view.rerender(<CopilotChecklist hasAgentRequests={false} initialTokens={[]} pollMs={1_000} />);
    expectProgress(3);
    expect(fetchMock).toHaveBeenCalledTimes(4);

    await settle(() => retired.resolve(response([calledToken])));
    expectProgress(3);
    await settle(() => completed.resolve(response([calledToken])));
    expectProgress(4);
    expect(screen.getByTestId("checklist-allow")).toHaveAttribute("data-done", "true");
    expect(vi.getTimerCount()).toBe(0);
    await advance(10_000);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("replaces and disables intervals without overlapping or accepting retired requests", async () => {
    const oldInterval = deferred();
    const currentInterval = deferred();
    const disabled = deferred();
    fetchMock
      .mockReturnValueOnce(oldInterval.promise)
      .mockReturnValueOnce(currentInterval.promise)
      .mockReturnValueOnce(disabled.promise);
    const view = render(<CopilotChecklist hasAgentRequests={false} pollMs={1_000} />);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);

    view.rerender(<CopilotChecklist hasAgentRequests={false} pollMs={3_000} />);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(1);
    await advance(2_999);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await settle(() => oldInterval.resolve(response([calledToken])));
    expectProgress(0);
    expect(vi.getTimerCount()).toBe(1);
    await settle(() => currentInterval.resolve(response([])));
    await advance(1);
    expect(fetchMock).toHaveBeenCalledTimes(3);

    view.rerender(<CopilotChecklist hasAgentRequests={false} pollMs={0} />);
    expect(vi.getTimerCount()).toBe(0);
    await settle(() => disabled.resolve(response([calledToken])));
    expectProgress(0);
    await advance(10_000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it.each(["success", "failure"] as const)(
    "invalidates a stale %s after DOM replacement but before passive effects, then polls once",
    async (settlement) => {
      const stale = deferred();
      const current = deferred();
      fetchMock.mockReturnValueOnce(stale.promise).mockReturnValueOnce(current.promise);
      const host = document.createElement("div");
      document.body.append(host);
      const root = createRoot(host);
      await act(async () => root.render(checklistWithBoundary("old", false)));
      expect(fetchMock).toHaveBeenCalledTimes(1);

      const replaced = new Promise<void>((resolve) => {
        const observer = new MutationObserver(() => {
          observer.disconnect();
          if (settlement === "success") stale.resolve(response([calledToken]));
          else stale.reject(new Error("stale before passive effects"));
          resolve();
        });
        observer.observe(host, { childList: true });
      });
      root.render(checklistWithBoundary("new", true));
      try {
        await replaced;
        await act(async () => {});

        expect(host.querySelector('[data-testid="copilot-checklist-progress"]')).toHaveTextContent("1 of 4");
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(vi.getTimerCount()).toBe(1);

        await settle(() => current.resolve(response([])));
        expect(host.querySelector('[data-testid="copilot-checklist-progress"]')).toHaveTextContent("1 of 4");
      } finally {
        await act(async () => root.unmount());
        host.remove();
      }
    },
  );

  it("gives Strict Mode replay an immediate current request and keeps exact cadence ownership", async () => {
    const replayed = deferred();
    const current = deferred();
    const next = deferred();
    const completed = deferred();
    fetchMock
      .mockReturnValueOnce(replayed.promise)
      .mockReturnValueOnce(current.promise)
      .mockReturnValueOnce(next.promise)
      .mockReturnValueOnce(completed.promise);
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);

    try {
      await act(async () => {
        root.render(
          <StrictMode>
            <CopilotChecklist hasAgentRequests={false} pollMs={1_000} />
          </StrictMode>,
        );
      });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(vi.getTimerCount()).toBe(1);

      await settle(() => replayed.resolve(response([calledToken])));
      expect(host.querySelector('[data-testid="copilot-checklist-progress"]')).toHaveTextContent("0 of 4");
      await advance(1_000);
      expect(fetchMock).toHaveBeenCalledTimes(2);

      await settle(() => current.resolve(response([seenToken])));
      expect(host.querySelector('[data-testid="copilot-checklist-progress"]')).toHaveTextContent("2 of 4");
      await advance(999);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      await advance(1);
      expect(fetchMock).toHaveBeenCalledTimes(3);

      await advance(1_000);
      expect(fetchMock).toHaveBeenCalledTimes(3);
      await settle(() => next.resolve(response([])));
      expect(host.querySelector('[data-testid="copilot-checklist-progress"]')).toHaveTextContent("2 of 4");
      await advance(1_000);
      expect(fetchMock).toHaveBeenCalledTimes(4);

      await settle(() => completed.resolve(response([calledToken])));
      expect(host.querySelector('[data-testid="copilot-checklist-progress"]')).toHaveTextContent("4 of 4");
      expect(vi.getTimerCount()).toBe(0);
      await advance(10_000);
      expect(fetchMock).toHaveBeenCalledTimes(4);
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it("rejects crossed settlements from Strict Mode A-B-A remounts", async () => {
    const visits = Array.from({ length: 6 }, () => deferred());
    for (const visit of visits) fetchMock.mockReturnValueOnce(visit.promise);
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const keyedChecklist = (key: string) => (
      <StrictMode>
        <CopilotChecklist key={key} hasAgentRequests={false} pollMs={1_000} />
      </StrictMode>
    );

    try {
      await act(async () => root.render(keyedChecklist("A")));
      await act(async () => root.render(keyedChecklist("B")));
      await act(async () => root.render(keyedChecklist("A")));
      expect(fetchMock).toHaveBeenCalledTimes(6);
      expect(vi.getTimerCount()).toBe(1);

      for (const stale of visits.slice(0, -1)) {
        await settle(() => stale.resolve(response([calledToken])));
        expect(host.querySelector('[data-testid="copilot-checklist-progress"]')).toHaveTextContent("0 of 4");
      }

      await settle(() => visits.at(-1)!.resolve(response([seenToken])));
      expect(host.querySelector('[data-testid="copilot-checklist-progress"]')).toHaveTextContent("2 of 4");
      expect(vi.getTimerCount()).toBe(1);
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it.each(["completion", "disable", "unmount"] as const)(
    "stops all Strict Mode work after %s",
    async (stop) => {
      const replayed = deferred();
      const current = deferred();
      fetchMock.mockReturnValueOnce(replayed.promise).mockReturnValueOnce(current.promise);
      const host = document.createElement("div");
      document.body.append(host);
      const root = createRoot(host);
      let mounted = true;

      try {
        await act(async () => {
          root.render(
            <StrictMode>
              <CopilotChecklist hasAgentRequests={false} pollMs={1_000} />
            </StrictMode>,
          );
        });
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(vi.getTimerCount()).toBe(1);

        if (stop === "completion") {
          await settle(() => current.resolve(response([calledToken])));
          expect(host.querySelector('[data-testid="copilot-checklist-progress"]')).toHaveTextContent("4 of 4");
        } else if (stop === "disable") {
          await act(async () => {
            root.render(
              <StrictMode>
                <CopilotChecklist hasAgentRequests={false} pollMs={0} />
              </StrictMode>,
            );
          });
          await settle(() => current.resolve(response([calledToken])));
          expect(host.querySelector('[data-testid="copilot-checklist-progress"]')).toHaveTextContent("0 of 4");
        } else {
          await act(async () => root.unmount());
          mounted = false;
          await settle(() => current.resolve(response([calledToken])));
          expect(host.querySelector('[data-testid="copilot-checklist"]')).toBeNull();
        }

        expect(vi.getTimerCount()).toBe(0);
        await settle(() => replayed.resolve(response([calledToken])));
        await advance(10_000);
        expect(fetchMock).toHaveBeenCalledTimes(2);
      } finally {
        if (mounted) await act(async () => root.unmount());
        host.remove();
      }
    },
  );

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

  it("shows one current alert after the initial Strict Mode failure and retains completed milestones", async () => {
    const replayed = deferred();
    const current = deferred();
    fetchMock.mockReturnValueOnce(replayed.promise).mockReturnValueOnce(current.promise);
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);

    try {
      await renderStrict(
        root,
        <CopilotChecklist hasAgentRequests={false} initialTokens={[seenToken]} pollMs={1_000} />,
      );
      await settle(() => replayed.reject(new Error("replayed offline")));
      expect(screen.queryByRole("alert")).toBeNull();

      await settle(() => current.reject(new Error("current offline")));

      expect(screen.getAllByRole("alert")).toHaveLength(1);
      expect(screen.getByRole("alert")).toHaveTextContent("Couldn't check setup progress.");
      expect(screen.getByRole("button", { name: "Retry now" })).toBeEnabled();
      expectProgress(2);
      expect(screen.getByTestId("checklist-token")).toHaveAttribute("data-done", "true");
      expect(screen.getByTestId("checklist-config")).toHaveAttribute("data-done", "true");
      expect(vi.getTimerCount()).toBe(1);
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it("accepts one exact retry, disables it while pending, and rejects a repeated native click", async () => {
    const replayed = deferred();
    const failed = deferred();
    const retry = deferred();
    fetchMock
      .mockReturnValueOnce(replayed.promise)
      .mockReturnValueOnce(failed.promise)
      .mockReturnValueOnce(retry.promise);
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);

    try {
      await renderStrict(root, <CopilotChecklist hasAgentRequests={false} pollMs={1_000} />);
      await settle(() => replayed.reject(new Error("replayed offline")));
      await settle(() => failed.reject(new Error("offline")));
      const button = screen.getByRole("button", { name: "Retry now" }) as HTMLButtonElement;

      await act(async () => {
        button.click();
        button.click();
      });

      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(button).toBeDisabled();
      expect(button).toHaveAttribute("aria-busy", "true");
      await advance(5_000);
      expect(fetchMock).toHaveBeenCalledTimes(3);

      await settle(() => retry.resolve(response([calledToken])));
      expectProgress(4);
      expect(screen.queryByRole("alert")).toBeNull();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it("leaves the alert after a failed retry and gives recovery one fresh exact callback", async () => {
    const replayed = deferred();
    const failed = deferred();
    const retryFailed = deferred();
    const recovered = deferred();
    fetchMock
      .mockReturnValueOnce(replayed.promise)
      .mockReturnValueOnce(failed.promise)
      .mockReturnValueOnce(retryFailed.promise)
      .mockReturnValueOnce(recovered.promise);
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);

    try {
      await renderStrict(root, <CopilotChecklist hasAgentRequests={false} pollMs={10_000} />);
      await settle(() => replayed.reject(new Error("replayed offline")));
      await settle(() => failed.reject(new Error("offline")));
      const button = screen.getByRole("button", { name: "Retry now" }) as HTMLButtonElement;
      const stale = reactHandler<RetryHandler>(button, "onClick");

      await act(async () => button.click());
      expect(button).toBeDisabled();
      await settle(() => retryFailed.reject(new Error("still offline")));

      expect(screen.getAllByRole("alert")).toHaveLength(1);
      expect(button).toBeEnabled();
      replayHandlerOnNextClick(stale, button);
      await act(async () => button.click());
      expect(fetchMock).toHaveBeenCalledTimes(4);
      expect(button).toBeDisabled();

      await settle(() => recovered.resolve(response([seenToken])));
      expectProgress(2);
      expect(screen.queryByRole("alert")).toBeNull();
      expect(vi.getTimerCount()).toBe(1);
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it("clears the current alert when the existing automatic cadence recovers", async () => {
    const replayed = deferred();
    const failed = deferred();
    const recovered = deferred();
    fetchMock
      .mockReturnValueOnce(replayed.promise)
      .mockReturnValueOnce(failed.promise)
      .mockReturnValueOnce(recovered.promise);
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);

    try {
      await renderStrict(root, <CopilotChecklist hasAgentRequests={false} pollMs={1_000} />);
      await settle(() => replayed.reject(new Error("replayed offline")));
      await settle(() => failed.reject(new Error("offline")));
      expect(screen.getByRole("button", { name: "Retry now" })).toBeEnabled();
      expect(vi.getTimerCount()).toBe(1);

      await advance(1_000);
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(vi.getTimerCount()).toBe(1);
      await settle(() => recovered.resolve(response([seenToken])));

      expectProgress(2);
      expect(screen.queryByRole("alert")).toBeNull();
      expect(vi.getTimerCount()).toBe(1);
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it("rejects a late retry settlement after a Strict Mode replacement and keeps the successor current", async () => {
    const firstReplay = deferred();
    const firstFailure = deferred();
    const lateRetry = deferred();
    const nextReplay = deferred();
    const nextFailure = deferred();
    const nextRetry = deferred();
    fetchMock
      .mockReturnValueOnce(firstReplay.promise)
      .mockReturnValueOnce(firstFailure.promise)
      .mockReturnValueOnce(lateRetry.promise)
      .mockReturnValueOnce(nextReplay.promise)
      .mockReturnValueOnce(nextFailure.promise)
      .mockReturnValueOnce(nextRetry.promise);
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);

    try {
      await renderStrict(root, <CopilotChecklist key="first" hasAgentRequests={false} pollMs={10_000} />);
      await settle(() => firstReplay.reject(new Error("first replay")));
      await settle(() => firstFailure.reject(new Error("first failure")));
      const retiredButton = screen.getByRole("button", { name: "Retry now" }) as HTMLButtonElement;
      await act(async () => retiredButton.click());
      expect(fetchMock).toHaveBeenCalledTimes(3);

      await renderStrict(root, <CopilotChecklist key="next" hasAgentRequests={false} pollMs={10_000} />);
      expect(retiredButton.isConnected).toBe(false);
      await settle(() => nextReplay.reject(new Error("next replay")));
      await settle(() => nextFailure.reject(new Error("next failure")));
      expect(fetchMock).toHaveBeenCalledTimes(5);
      expectProgress(0);
      expect(screen.getAllByRole("alert")).toHaveLength(1);

      await settle(() => lateRetry.resolve(response([calledToken])));
      expectProgress(0);
      expect(screen.getAllByRole("alert")).toHaveLength(1);
      const currentButton = screen.getByRole("button", { name: "Retry now" }) as HTMLButtonElement;
      expect(currentButton).toBeEnabled();
      await act(async () => currentButton.click());
      expect(fetchMock).toHaveBeenCalledTimes(6);
      await settle(() => nextRetry.resolve(response([seenToken])));
      expectProgress(2);
      expect(screen.queryByRole("alert")).toBeNull();
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it.each(["content", "placement"] as const)(
    "rejects a retry after its committed %s is mutated and restored",
    async (mutation) => {
      const replayed = deferred();
      const failed = deferred();
      fetchMock.mockReturnValueOnce(replayed.promise).mockReturnValueOnce(failed.promise);
      const host = document.createElement("div");
      document.body.append(host);
      const root = createRoot(host);

      try {
        await renderStrict(root, <CopilotChecklist hasAgentRequests={false} pollMs={1_000} />);
        await settle(() => replayed.reject(new Error("replayed offline")));
        await settle(() => failed.reject(new Error("offline")));
        const alert = screen.getByRole("alert");
        const button = screen.getByRole("button", { name: "Retry now" }) as HTMLButtonElement;

        if (mutation === "content") {
          const message = alert.firstElementChild!;
          const original = message.textContent;
          message.textContent = "restoring";
          message.textContent = original;
        } else {
          const section = screen.getByTestId("copilot-checklist");
          alert.remove();
          section.append(alert);
        }
        await act(async () => {});
        await act(async () => button.click());

        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(button).toBeEnabled();
        expectProgress(0);
        expect(screen.getAllByRole("alert")).toHaveLength(1);
        expect(vi.getTimerCount()).toBe(1);
      } finally {
        await act(async () => root.unmount());
        host.remove();
      }
    },
  );

  it("rejects settlement after pending controls are mutation-restored without changing current state", async () => {
    const replayed = deferred();
    const failed = deferred();
    const retry = deferred();
    fetchMock
      .mockReturnValueOnce(replayed.promise)
      .mockReturnValueOnce(failed.promise)
      .mockReturnValueOnce(retry.promise);
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);

    try {
      await renderStrict(root, <CopilotChecklist hasAgentRequests={false} initialTokens={[seenToken]} pollMs={10_000} />);
      await settle(() => replayed.reject(new Error("replayed offline")));
      await settle(() => failed.reject(new Error("offline")));
      const button = screen.getByRole("button", { name: "Retry now" }) as HTMLButtonElement;
      await act(async () => button.click());
      expect(button).toBeDisabled();

      const original = button.className;
      button.className = "mutated";
      button.className = original;
      await act(async () => {});
      await settle(() => retry.resolve(response([calledToken])));

      expectProgress(2);
      expect(screen.getAllByRole("alert")).toHaveLength(1);
      expect(button).toBeDisabled();
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(vi.getTimerCount()).toBe(1);
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it.each(["completion", "disable"] as const)(
    "retires a failure alert and its retry authority on %s",
    async (stop) => {
      const replayed = deferred();
      const failed = deferred();
      fetchMock.mockReturnValueOnce(replayed.promise).mockReturnValueOnce(failed.promise);
      const host = document.createElement("div");
      document.body.append(host);
      const root = createRoot(host);

      try {
        await renderStrict(root, <CopilotChecklist hasAgentRequests={false} pollMs={1_000} />);
        await settle(() => replayed.reject(new Error("replayed offline")));
        await settle(() => failed.reject(new Error("offline")));
        const retiredButton = screen.getByRole("button", { name: "Retry now" }) as HTMLButtonElement;
        const retiredHandler = reactHandler<RetryHandler>(retiredButton, "onClick");

        await renderStrict(
          root,
          <CopilotChecklist
            hasAgentRequests={false}
            initialTokens={stop === "completion" ? [calledToken] : []}
            pollMs={stop === "disable" ? 0 : 1_000}
          />,
        );

        expect(screen.queryByRole("alert")).toBeNull();
        expect(retiredButton.isConnected).toBe(false);
        expect(vi.getTimerCount()).toBe(0);
        const fabricated = new MouseEvent("click", { bubbles: true, cancelable: true });
        retiredHandler({
          type: "click",
          currentTarget: retiredButton,
          target: retiredButton,
          nativeEvent: fabricated,
          defaultPrevented: false,
        });
        await advance(10_000);
        expect(fetchMock).toHaveBeenCalledTimes(2);
      } finally {
        await act(async () => root.unmount());
        host.remove();
      }
    },
  );

  it("drops pending retry work on cleanup and gives a clean Strict Mode successor fresh authority", async () => {
    const firstReplay = deferred();
    const firstFailure = deferred();
    const retiredRetry = deferred();
    const nextReplay = deferred();
    const nextFailure = deferred();
    const nextRetry = deferred();
    fetchMock
      .mockReturnValueOnce(firstReplay.promise)
      .mockReturnValueOnce(firstFailure.promise)
      .mockReturnValueOnce(retiredRetry.promise)
      .mockReturnValueOnce(nextReplay.promise)
      .mockReturnValueOnce(nextFailure.promise)
      .mockReturnValueOnce(nextRetry.promise);
    const firstHost = document.createElement("div");
    const nextHost = document.createElement("div");
    document.body.append(firstHost, nextHost);
    const firstRoot = createRoot(firstHost);
    const nextRoot = createRoot(nextHost);
    let firstMounted = true;

    try {
      await renderStrict(firstRoot, <CopilotChecklist hasAgentRequests={false} pollMs={1_000} />);
      await settle(() => firstReplay.reject(new Error("first replay")));
      await settle(() => firstFailure.reject(new Error("first failure")));
      await act(async () => screen.getByRole("button", { name: "Retry now" }).click());
      await act(async () => firstRoot.unmount());
      firstMounted = false;
      expect(vi.getTimerCount()).toBe(0);

      await renderStrict(nextRoot, <CopilotChecklist hasAgentRequests={false} pollMs={1_000} />);
      await settle(() => nextReplay.reject(new Error("next replay")));
      await settle(() => nextFailure.reject(new Error("next failure")));
      expect(screen.getAllByRole("alert")).toHaveLength(1);
      expect(vi.getTimerCount()).toBe(1);

      await settle(() => retiredRetry.resolve(response([calledToken])));
      expectProgress(0);
      expect(screen.getAllByRole("alert")).toHaveLength(1);
      await act(async () => screen.getByRole("button", { name: "Retry now" }).click());
      expect(fetchMock).toHaveBeenCalledTimes(6);
      await settle(() => nextRetry.resolve(response([seenToken])));
      expectProgress(2);
      expect(screen.queryByRole("alert")).toBeNull();
    } finally {
      if (firstMounted) await act(async () => firstRoot.unmount());
      await act(async () => nextRoot.unmount());
      firstHost.remove();
      nextHost.remove();
    }
  });
});
