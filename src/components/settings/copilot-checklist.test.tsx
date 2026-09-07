// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiTokenDto } from "@/lib/api";
import { CopilotChecklist } from "./copilot-checklist";

const fetchMock = vi.fn<typeof fetch>();
type ChecklistToken = Pick<ApiTokenDto, "lastMcpSeenAt" | "lastMcpCallAt">;
const token: ChecklistToken = { lastMcpSeenAt: null, lastMcpCallAt: null };

function response(tokens: ChecklistToken[]) {
  return new Response(JSON.stringify({ tokens }), { headers: { "Content-Type": "application/json" } });
}

function deferred() {
  let resolve!: (value: Response) => void;
  const promise = new Promise<Response>((done) => {
    resolve = done;
  });
  return { promise, resolve };
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
  it("does not roll progress back when an older slow poll finishes last", async () => {
    const older = deferred();
    const newer = deferred();
    fetchMock.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);

    render(<CopilotChecklist hasAgentRequests={false} initialTokens={[token]} pollMs={1_000} />);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("copilot-checklist-progress")).toHaveTextContent("1 of 4");

    act(() => vi.advanceTimersByTime(1_000));
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await act(async () => newer.resolve(response([{ ...token, lastMcpSeenAt: "2026-09-07T15:00:00.000Z" }])));
    expect(screen.getByTestId("copilot-checklist-progress")).toHaveTextContent("2 of 4");
    expect(screen.getByTestId("checklist-config")).toHaveAttribute("data-done", "true");

    await act(async () => older.resolve(response([token])));
    expect(screen.getByTestId("copilot-checklist-progress")).toHaveTextContent("2 of 4");
    expect(screen.getByTestId("checklist-config")).toHaveAttribute("data-done", "true");
  });
});
