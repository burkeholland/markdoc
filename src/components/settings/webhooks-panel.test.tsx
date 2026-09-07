// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import { WebhooksPanel } from "./webhooks-panel";

const fetchMock = vi.fn<typeof fetch>();

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const disabledWebhook = {
  id: "disabled-hook",
  url: "https://receiver.example/disabled",
  events: ["comment.added"],
  documentIds: null,
  active: false,
  failures: 20,
  createdAt: "2026-09-01T12:00:00.000Z",
  lastDelivery: { status: 500, at: "2026-09-01T12:01:00.000Z", attempt: 4, event: "comment.added" },
};

const activeWebhook = {
  ...disabledWebhook,
  id: "active-hook",
  url: "https://receiver.example/active",
  active: true,
  failures: 0,
  lastDelivery: null,
};

const otherDisabledWebhook = {
  ...disabledWebhook,
  id: "other-disabled-hook",
  url: "https://receiver.example/other-disabled",
};

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Settings → Webhooks: list recovery", () => {
  it("replaces a settled initial failure with its API reason and one atomic Retry alert", async () => {
    fetchMock.mockResolvedValueOnce(response({ error: "Webhook service unavailable" }, 503));
    render(<WebhooksPanel />);

    const errorBlock = await screen.findByTestId("webhooks-list-error");
    const alert = within(errorBlock).getByRole("alert");
    expect(alert).toHaveAttribute("aria-atomic", "true");
    expect(alert).toHaveTextContent("Webhook service unavailable");
    expect(within(errorBlock).getAllByRole("button", { name: "Retry" })).toHaveLength(1);
    expect(screen.queryByText("Loading…")).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("guards Retry while pending and recovers to the genuine empty state", async () => {
    const retry = deferred<Response>();
    fetchMock.mockResolvedValueOnce(response({ error: "Try again" }, 503)).mockReturnValueOnce(retry.promise);
    render(<WebhooksPanel />);

    const retryButton = within(await screen.findByTestId("webhooks-list-error")).getByRole("button", { name: "Retry" });
    fireEvent.click(retryButton);
    fireEvent.click(retryButton);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("button", { name: "Retrying…" })).toBeDisabled();
    expect(screen.queryByText("Loading…")).toBeNull();

    await act(async () => retry.resolve(response({ webhooks: [] })));
    expect(await screen.findByTestId("webhooks-empty")).toHaveTextContent("No webhooks yet.");
    expect(screen.queryByTestId("webhooks-list-error")).toBeNull();
  });

  it("recovers from an initial failure to the populated list", async () => {
    fetchMock.mockResolvedValueOnce(response({ error: "Try again" }, 503)).mockResolvedValueOnce(response({ webhooks: [activeWebhook] }));
    render(<WebhooksPanel />);

    fireEvent.click(within(await screen.findByTestId("webhooks-list-error")).getByRole("button", { name: "Retry" }));

    expect(await screen.findByTestId("webhook-row")).toHaveTextContent(activeWebhook.url);
    expect(screen.queryByTestId("webhooks-list-error")).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keeps cached rows visible when a later refresh fails with the fallback reason", async () => {
    fetchMock
      .mockResolvedValueOnce(response({ webhooks: [activeWebhook] }))
      .mockResolvedValueOnce(response({ ok: true }))
      .mockRejectedValueOnce("offline");
    render(<WebhooksPanel />);

    const row = await screen.findByTestId("webhook-row");
    fireEvent.click(within(row).getByTestId("webhook-test"));

    expect(await screen.findByTestId("webhooks-list-error")).toHaveTextContent("Failed to load webhooks");
    expect(screen.getByTestId("webhook-row")).toHaveTextContent(activeWebhook.url);
    expect(screen.queryByText("Loading…")).toBeNull();
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(["/api/webhooks", "/api/webhooks/active-hook/test", "/api/webhooks"]);
  });

  it("keeps list and action errors separate and clears only the list error after a successful Retry", async () => {
    fetchMock
      .mockResolvedValueOnce(response({ error: "List unavailable" }, 503))
      .mockResolvedValueOnce(response({ error: "Receiver URL is not allowed" }, 400))
      .mockResolvedValueOnce(response({ webhooks: [] }));
    render(<WebhooksPanel />);

    await screen.findByTestId("webhooks-list-error");
    fireEvent.click(screen.getByTestId("webhook-add"));
    fireEvent.change(screen.getByTestId("webhook-url"), { target: { value: "https://receiver.example/hook" } });
    fireEvent.click(screen.getByTestId("webhook-create"));

    expect(await screen.findByTestId("webhook-action-error")).toHaveTextContent("Receiver URL is not allowed");
    expect(screen.getByTestId("webhooks-list-error")).toHaveTextContent("List unavailable");

    fireEvent.click(within(screen.getByTestId("webhooks-list-error")).getByRole("button", { name: "Retry" }));
    await screen.findByTestId("webhooks-empty");

    expect(screen.queryByTestId("webhooks-list-error")).toBeNull();
    expect(screen.getByTestId("webhook-action-error")).toHaveTextContent("Receiver URL is not allowed");
  });

  it("ignores an older list success after a newer list failure", async () => {
    const firstEnable = deferred<Response>();
    const secondEnable = deferred<Response>();
    const staleList = deferred<Response>();
    fetchMock
      .mockResolvedValueOnce(response({ webhooks: [disabledWebhook, otherDisabledWebhook] }))
      .mockReturnValueOnce(firstEnable.promise)
      .mockReturnValueOnce(secondEnable.promise)
      .mockReturnValueOnce(staleList.promise)
      .mockResolvedValueOnce(response({ error: "Newest refresh failed" }, 503));
    render(<WebhooksPanel />);

    const rows = await screen.findAllByTestId("webhook-row");
    fireEvent.click(within(rows[0]).getByTestId("webhook-enable"));
    fireEvent.click(within(rows[1]).getByTestId("webhook-enable"));

    await act(async () => firstEnable.resolve(response({ webhook: { ...disabledWebhook, active: true, failures: 0 } })));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));
    await act(async () => secondEnable.resolve(response({ webhook: { ...otherDisabledWebhook, active: true, failures: 0 } })));
    expect(await screen.findByTestId("webhooks-list-error")).toHaveTextContent("Newest refresh failed");

    await act(async () => staleList.resolve(response({ webhooks: [{ ...disabledWebhook, active: true, failures: 0 }] })));

    expect(screen.getByTestId("webhooks-list-error")).toHaveTextContent("Newest refresh failed");
    expect(screen.getAllByTestId("webhook-row")).toHaveLength(2);
    expect(screen.getByText(disabledWebhook.url)).toBeInTheDocument();
    expect(screen.getByText(otherDisabledWebhook.url)).toBeInTheDocument();
  });
});

describe("Settings → Webhooks: the add form shows the validation reason (#1480)", () => {
  it("shows the URL rule, not the bare \"Invalid request\", when the server rejects the new webhook", async () => {
    // `handler()` answers a zod failure with `400 { error: "Invalid request", issues }`; the panel's `request()` turns
    // that into `new ApiError(400, "Invalid request", [{ path: ["url"], message: "Enter an https:// URL" }])`.
    fetchMock
      .mockResolvedValueOnce(response({ webhooks: [] }))
      .mockResolvedValueOnce(response({ error: "Invalid request", issues: [{ path: ["url"], message: "Enter an https:// URL" }] }, 400));
    render(<WebhooksPanel />);

    await screen.findByTestId("webhooks-empty");
    fireEvent.click(screen.getByTestId("webhook-add"));
    fireEvent.change(screen.getByTestId("webhook-url"), { target: { value: "not-a-url" } });
    fireEvent.click(screen.getByTestId("webhook-create"));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Enter an https:// URL");
    expect(alert).not.toHaveTextContent("Invalid request");
    const posts = fetchMock.mock.calls.filter(([, init]) => init?.method === "POST");
    expect(posts).toHaveLength(1);
    expect(JSON.parse(String(posts[0][1]?.body))).toMatchObject({ url: "not-a-url" });
  });
});

describe("Settings → Webhooks: event targets", () => {
  it("keeps each native checkbox inside a 24px hit row and lets the label toggle it", async () => {
    fetchMock.mockResolvedValueOnce(response({ webhooks: [] }));
    render(<WebhooksPanel />);

    await screen.findByTestId("webhooks-empty");
    fireEvent.click(screen.getByTestId("webhook-add"));

    const checkbox = screen.getByTestId("webhook-event-content.changed");
    const row = checkbox.closest("label");
    expect(row).not.toBeNull();
    expect(row).toHaveClass("min-h-6");
    expect(checkbox).not.toBeChecked();

    fireEvent.click(row!);
    expect(checkbox).toBeChecked();
  });
});

describe("Settings → Webhooks: enable a disabled webhook", () => {
  it("shows Enable only for inactive rows, locks that row while pending, and reloads the active row", async () => {
    const pending = deferred<Response>();
    fetchMock
      .mockResolvedValueOnce(response({ webhooks: [disabledWebhook, activeWebhook] }))
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce(response({ webhooks: [{ ...disabledWebhook, active: true, failures: 0 }] }));
    render(<WebhooksPanel />);

    const rows = await screen.findAllByTestId("webhook-row");
    expect(within(rows[0]).getByTestId("webhook-enable")).toBeEnabled();
    expect(within(rows[1]).queryByTestId("webhook-enable")).toBeNull();
    expect(screen.getAllByTestId("webhook-enable")).toHaveLength(1);

    fireEvent.click(within(rows[0]).getByTestId("webhook-enable"));
    expect(within(rows[0]).getByTestId("webhook-enable")).toBeDisabled();
    expect(within(rows[0]).getByTestId("webhook-test")).toBeDisabled();
    expect(within(rows[0]).getByTestId("webhook-delete")).toBeDisabled();
    expect(within(rows[1]).getByTestId("webhook-test")).toBeEnabled();
    expect(within(rows[1]).getByTestId("webhook-delete")).toBeEnabled();

    await act(async () => pending.resolve(response({ webhook: { ...disabledWebhook, active: true, failures: 0 } })));
    await waitFor(() => expect(screen.queryByTestId("webhook-enable")).toBeNull());
    expect(screen.getByTestId("webhook-status")).toHaveTextContent("enabled · last attempt 500 ·");
    expect(screen.getByTestId("webhook-status")).not.toHaveTextContent("failed ×0");
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(["/api/webhooks", "/api/webhooks/disabled-hook/enable", "/api/webhooks"]);
    expect(fetchMock.mock.calls[1][1]?.method).toBe("POST");
  });

  it("keeps both disabled rows locked while overlapping enable requests settle independently", async () => {
    const first = deferred<Response>();
    const second = deferred<Response>();
    fetchMock
      .mockResolvedValueOnce(response({ webhooks: [disabledWebhook, otherDisabledWebhook] }))
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
      .mockResolvedValueOnce(response({ webhooks: [disabledWebhook, { ...otherDisabledWebhook, active: true, failures: 0 }] }))
      .mockResolvedValueOnce(response({ webhooks: [{ ...disabledWebhook, active: true, failures: 0 }, { ...otherDisabledWebhook, active: true, failures: 0 }] }));
    render(<WebhooksPanel />);

    let rows = await screen.findAllByTestId("webhook-row");
    fireEvent.click(within(rows[0]).getByTestId("webhook-enable"));
    fireEvent.click(within(rows[1]).getByTestId("webhook-enable"));
    for (const row of rows) {
      expect(within(row).getByTestId("webhook-enable")).toBeDisabled();
      expect(within(row).getByTestId("webhook-test")).toBeDisabled();
      expect(within(row).getByTestId("webhook-delete")).toBeDisabled();
    }

    await act(async () => second.resolve(response({ webhook: { ...otherDisabledWebhook, active: true, failures: 0 } })));
    await waitFor(() => expect(screen.getAllByTestId("webhook-enable")).toHaveLength(1));
    rows = screen.getAllByTestId("webhook-row");
    expect(within(rows[0]).getByTestId("webhook-enable")).toBeDisabled();
    expect(within(rows[0]).getByTestId("webhook-test")).toBeDisabled();
    expect(within(rows[0]).getByTestId("webhook-delete")).toBeDisabled();
    expect(within(rows[1]).queryByTestId("webhook-enable")).toBeNull();
    expect(within(rows[1]).getByTestId("webhook-test")).toBeEnabled();
    expect(within(rows[1]).getByTestId("webhook-delete")).toBeEnabled();

    await act(async () => first.resolve(response({ webhook: { ...disabledWebhook, active: true, failures: 0 } })));
    await waitFor(() => expect(screen.queryByTestId("webhook-enable")).toBeNull());
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/webhooks",
      "/api/webhooks/disabled-hook/enable",
      "/api/webhooks/other-disabled-hook/enable",
      "/api/webhooks",
      "/api/webhooks",
    ]);
  });

  it("shows the server reason inline and leaves the disabled row available to retry", async () => {
    fetchMock
      .mockResolvedValueOnce(response({ webhooks: [disabledWebhook] }))
      .mockResolvedValueOnce(response({ error: "A webhook cannot point at Markdoc itself" }, 400));
    render(<WebhooksPanel />);

    fireEvent.click(await screen.findByTestId("webhook-enable"));
    expect(await screen.findByRole("alert")).toHaveTextContent("A webhook cannot point at Markdoc itself");
    expect(screen.getByTestId("webhook-enable")).toBeEnabled();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
