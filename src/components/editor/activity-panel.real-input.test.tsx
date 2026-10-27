// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CollabSession } from "@/editor/collab/session";
import type { ActivityItemDto } from "@/lib/api";
import { ActivityPanel } from "./activity-panel";

const activity = vi.fn();
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  api: { documents: { activity: (...args: unknown[]) => activity(...args) } },
}));

const session = (docId: string) => ({ docId }) as unknown as CollabSession;
const row = (id: string): ActivityItemDto => ({
  id,
  actorId: `user-${id}`,
  actorName: `Editor ${id}`,
  actorKind: "user",
  action: "edit",
  detail: {},
  createdAt: new Date().toISOString(),
});

beforeEach(() => activity.mockReset());
afterEach(cleanup);

describe("ActivityPanel real input", () => {
  it("honours synthetic clicks on Refresh, Load more and Close", async () => {
    activity
      .mockResolvedValueOnce({ items: [row("a")], nextBefore: "older" })
      .mockResolvedValueOnce({ items: [row("b")], nextBefore: null })
      .mockResolvedValueOnce({ items: [row("a")], nextBefore: null });
    const onClose = vi.fn();
    render(<ActivityPanel session={session("doc")} onClose={onClose} />);
    await act(async () => {});

    fireEvent.click(screen.getByTestId("activity-load-more"));
    await act(async () => {});
    expect(activity).toHaveBeenLastCalledWith("doc", { before: "older", limit: 50 });
    expect(screen.getAllByTestId("activity-row")).toHaveLength(2);

    fireEvent.click(screen.getByRole("button", { name: "Refresh activity" }));
    await act(async () => {});
    expect(activity).toHaveBeenCalledTimes(3);
    expect(activity).toHaveBeenLastCalledWith("doc", { limit: 50 });

    await userEvent.setup().click(screen.getByRole("button", { name: "Close activity" }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("retries after a failed first page via a synthetic click", async () => {
    activity.mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce({ items: [], nextBefore: null });
    render(<ActivityPanel session={session("doc")} onClose={() => {}} />);
    await act(async () => {});
    expect(screen.getByRole("alert")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await act(async () => {});
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("No activity yet")).toBeInTheDocument();
  });

  it("moves focus across the header with synthetic arrow keys", async () => {
    activity.mockResolvedValue({ items: [row("a")], nextBefore: null });
    render(<ActivityPanel session={session("doc")} onClose={() => {}} />);
    await act(async () => {});
    const refresh = screen.getByRole("button", { name: "Refresh activity" });
    const close = screen.getByRole("button", { name: "Close activity" });
    refresh.focus();
    fireEvent.keyDown(refresh, { key: "ArrowRight" });
    expect(close).toHaveFocus();
    await userEvent.setup().keyboard("{Home}");
    expect(refresh).toHaveFocus();
  });
});
