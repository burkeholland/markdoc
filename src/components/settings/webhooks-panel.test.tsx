// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useLayoutEffect } from "react";

import { WebhooksPanel } from "./webhooks-panel";

const fetchMock = vi.fn<typeof fetch>();

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function BoundaryHarness({
  cardKey = 0,
  present = true,
  boundary = 0,
  onBoundary,
}: {
  cardKey?: number;
  present?: boolean;
  boundary?: number;
  onBoundary?: () => void;
}) {
  useLayoutEffect(() => {
    if (boundary > 0) onBoundary?.();
  }, [boundary, onBoundary]);
  return present ? <WebhooksPanel key={cardKey} /> : null;
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

describe("Settings → Webhooks: action ownership", () => {
  it("owns duplicate Create synchronously, preserves a failed form, and keeps an accepted secret until it renders", async () => {
    const firstCreate = deferred<Response>();
    const secondCreate = deferred<Response>();
    const refresh = deferred<Response>();
    fetchMock
      .mockResolvedValueOnce(response({ webhooks: [] }))
      .mockReturnValueOnce(firstCreate.promise)
      .mockReturnValueOnce(secondCreate.promise)
      .mockReturnValueOnce(refresh.promise);
    render(<WebhooksPanel />);

    await screen.findByTestId("webhooks-empty");
    fireEvent.click(screen.getByTestId("webhook-add"));
    fireEvent.change(screen.getByTestId("webhook-url"), { target: { value: "https://receiver.example/retry-me" } });
    fireEvent.change(screen.getByTestId("webhook-docs"), { target: { value: "doc-one, doc-two" } });
    const form = screen.getByTestId("webhook-form");

    fireEvent.submit(form);
    fireEvent.submit(form);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId("webhook-create")).toBeDisabled();
    expect(screen.getByTestId("webhook-add")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    expect(screen.getByTestId("webhook-url")).toBeDisabled();
    expect(screen.getByTestId("webhook-docs")).toBeDisabled();
    expect(screen.getByTestId("webhook-event-request.created")).toBeDisabled();
    const cancel = screen.getByRole("button", { name: "Cancel" });
    const disclosure = screen.getByTestId("webhook-add");
    cancel.removeAttribute("disabled");
    disclosure.removeAttribute("disabled");
    fireEvent.click(cancel);
    fireEvent.click(disclosure);
    expect(form).toBeInTheDocument();

    await act(async () => firstCreate.resolve(response({ error: "Receiver rejected this URL" }, 422)));

    expect(await screen.findByTestId("webhook-action-error")).toHaveTextContent("Receiver rejected this URL");
    expect(screen.getByTestId("webhook-url")).toHaveValue("https://receiver.example/retry-me");
    expect(screen.getByTestId("webhook-docs")).toHaveValue("doc-one, doc-two");
    expect(screen.getByTestId("webhook-create")).toBeEnabled();

    fireEvent.submit(form);
    fireEvent.submit(form);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(screen.getByTestId("webhook-create")).toBeDisabled();

    await act(async () =>
      secondCreate.resolve(response({ webhook: { ...activeWebhook, id: "created-hook", secret: "whsec_single_display" } })),
    );

    const created = await screen.findByTestId("webhook-created");
    expect(within(created).getAllByTestId("webhook-secret")).toHaveLength(1);
    expect(screen.queryByTestId("webhook-form")).toBeNull();
    expect(screen.getByTestId("webhook-add")).toBeDisabled();
    expect(fetchMock).toHaveBeenCalledTimes(4);

    await act(async () => refresh.resolve(response({ webhooks: [{ ...activeWebhook, id: "created-hook" }] })));

    expect(screen.getByTestId("webhook-add")).toBeEnabled();
    expect(screen.getAllByTestId("webhook-secret")).toHaveLength(1);
    expect(fetchMock.mock.calls.filter(([url, init]) => url === "/api/webhooks" && init?.method === "POST")).toHaveLength(2);
  });

  it("suppresses duplicate and mixed same-row actions while another row remains independently usable", async () => {
    const firstRow = deferred<Response>();
    const secondRow = deferred<Response>();
    const confirmMock = vi.fn(() => true);
    vi.stubGlobal("confirm", confirmMock);
    fetchMock
      .mockResolvedValueOnce(response({ webhooks: [disabledWebhook, otherDisabledWebhook] }))
      .mockReturnValueOnce(firstRow.promise)
      .mockReturnValueOnce(secondRow.promise)
      .mockResolvedValueOnce(response({ webhooks: [disabledWebhook, otherDisabledWebhook] }))
      .mockResolvedValueOnce(response({ webhooks: [disabledWebhook, { ...otherDisabledWebhook, active: true, failures: 0 }] }));
    render(<WebhooksPanel />);

    const rows = await screen.findAllByTestId("webhook-row");
    fireEvent.click(within(rows[0]).getByTestId("webhook-test"));

    for (const control of [
      within(rows[0]).getByTestId("webhook-test"),
      within(rows[0]).getByTestId("webhook-enable"),
      within(rows[0]).getByTestId("webhook-delete"),
    ]) {
      control.removeAttribute("disabled");
      fireEvent.click(control);
    }

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(["/api/webhooks", "/api/webhooks/disabled-hook/test"]);
    expect(confirmMock).not.toHaveBeenCalled();
    expect(within(rows[1]).getByTestId("webhook-enable")).toBeEnabled();

    fireEvent.click(within(rows[1]).getByTestId("webhook-enable"));
    const duplicateEnable = within(rows[1]).getByTestId("webhook-enable");
    duplicateEnable.removeAttribute("disabled");
    fireEvent.click(duplicateEnable);

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/webhooks",
      "/api/webhooks/disabled-hook/test",
      "/api/webhooks/other-disabled-hook/enable",
    ]);

    await act(async () => firstRow.resolve(response({ ok: true })));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));
    expect(within(screen.getAllByTestId("webhook-row")[0]).getByTestId("webhook-test")).toBeEnabled();
    expect(within(screen.getAllByTestId("webhook-row")[1]).getByTestId("webhook-test")).toBeDisabled();

    await act(async () => secondRow.resolve(response({ webhook: { ...otherDisabledWebhook, active: true, failures: 0 } })));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(5));
    expect(within(screen.getAllByTestId("webhook-row")[1]).getByTestId("webhook-test")).toBeEnabled();
  });

  it.each([
    {
      label: "Test",
      hook: activeWebhook,
      control: "webhook-test",
      actionUrl: "/api/webhooks/active-hook/test",
      failure: response({ error: "Test delivery refused" }, 502),
      reason: "Test delivery refused",
      success: response({ ok: true }),
      refreshed: [activeWebhook],
    },
    {
      label: "Enable",
      hook: disabledWebhook,
      control: "webhook-enable",
      actionUrl: "/api/webhooks/disabled-hook/enable",
      failure: response({ error: "Receiver is still unavailable" }, 409),
      reason: "Receiver is still unavailable",
      success: response({ webhook: { ...disabledWebhook, active: true, failures: 0 } }),
      refreshed: [{ ...disabledWebhook, active: true, failures: 0 }],
    },
    {
      label: "Delete",
      hook: activeWebhook,
      control: "webhook-delete",
      actionUrl: "/api/webhooks/active-hook",
      failure: null,
      reason: "Could not delete webhook",
      success: response({ ok: true }),
      refreshed: [],
    },
  ])("shows the $label reason and accepts an exact same-action retry", async ({ hook, control, actionUrl, failure, reason, success, refreshed }) => {
    vi.stubGlobal("confirm", vi.fn(() => true));
    fetchMock.mockResolvedValueOnce(response({ webhooks: [hook] }));
    if (failure) fetchMock.mockResolvedValueOnce(failure);
    else fetchMock.mockRejectedValueOnce("offline");
    fetchMock.mockResolvedValueOnce(success).mockResolvedValueOnce(response({ webhooks: refreshed }));
    render(<WebhooksPanel />);

    fireEvent.click(await screen.findByTestId(control));

    expect(await screen.findByTestId("webhook-action-error")).toHaveTextContent(reason);
    expect(screen.getByTestId(control)).toBeEnabled();

    fireEvent.click(screen.getByTestId(control));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));

    expect(fetchMock.mock.calls.filter(([url]) => url === actionUrl)).toHaveLength(2);
    expect(fetchMock.mock.calls.filter(([url]) => url === "/api/webhooks")).toHaveLength(2);
    expect(screen.queryByTestId("webhook-action-error")).toBeNull();
  });

  it("owns confirmed Delete once, clears its matching one-time secret, and refreshes once", async () => {
    const deletion = deferred<Response>();
    const confirmMock = vi.fn(() => true);
    vi.stubGlobal("confirm", confirmMock);
    fetchMock
      .mockResolvedValueOnce(response({ webhooks: [] }))
      .mockResolvedValueOnce(response({ webhook: { ...activeWebhook, secret: "whsec_delete_me" } }))
      .mockResolvedValueOnce(response({ webhooks: [activeWebhook] }))
      .mockReturnValueOnce(deletion.promise)
      .mockResolvedValueOnce(response({ webhooks: [] }));
    render(<WebhooksPanel />);

    await screen.findByTestId("webhooks-empty");
    fireEvent.click(screen.getByTestId("webhook-add"));
    fireEvent.change(screen.getByTestId("webhook-url"), { target: { value: activeWebhook.url } });
    fireEvent.submit(screen.getByTestId("webhook-form"));
    await screen.findByTestId("webhook-row");
    expect(screen.getAllByTestId("webhook-secret")).toHaveLength(1);

    const deleteButton = screen.getByTestId("webhook-delete");
    fireEvent.click(deleteButton);
    deleteButton.removeAttribute("disabled");
    fireEvent.click(deleteButton);

    expect(confirmMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls.filter(([url, init]) => url === "/api/webhooks/active-hook" && init?.method === "DELETE")).toHaveLength(1);

    await act(async () => deletion.resolve(response({ ok: true })));

    expect(await screen.findByTestId("webhooks-empty")).toHaveTextContent("No webhooks yet.");
    expect(screen.queryByTestId("webhook-created")).toBeNull();
    expect(fetchMock.mock.calls.filter(([url, init]) => url === "/api/webhooks" && !init?.method)).toHaveLength(3);
  });

  it("keeps newer feedback and row ownership isolated from an older settlement and finalizer", async () => {
    const olderAction = deferred<Response>();
    const newerAction = deferred<Response>();
    const newerRetry = deferred<Response>();
    fetchMock
      .mockResolvedValueOnce(response({ webhooks: [activeWebhook, { ...activeWebhook, id: "other-active-hook", url: "https://receiver.example/other" }] }))
      .mockReturnValueOnce(olderAction.promise)
      .mockReturnValueOnce(newerAction.promise)
      .mockReturnValueOnce(newerRetry.promise)
      .mockResolvedValueOnce(response({ webhooks: [activeWebhook, { ...activeWebhook, id: "other-active-hook", url: "https://receiver.example/other" }] }));
    render(<WebhooksPanel />);

    let rows = await screen.findAllByTestId("webhook-row");
    fireEvent.click(within(rows[0]).getByTestId("webhook-test"));
    fireEvent.click(within(rows[1]).getByTestId("webhook-test"));

    await act(async () => newerAction.resolve(response({ error: "Newer action failed" }, 503)));
    expect(await screen.findByTestId("webhook-action-error")).toHaveTextContent("Newer action failed");
    rows = screen.getAllByTestId("webhook-row");
    expect(within(rows[0]).getByTestId("webhook-test")).toBeDisabled();
    expect(within(rows[1]).getByTestId("webhook-test")).toBeEnabled();

    await act(async () => olderAction.resolve(response({ error: "Older action failed" }, 503)));
    expect(screen.getByTestId("webhook-action-error")).toHaveTextContent("Newer action failed");
    rows = screen.getAllByTestId("webhook-row");
    expect(within(rows[0]).getByTestId("webhook-test")).toBeEnabled();
    expect(within(rows[1]).getByTestId("webhook-test")).toBeEnabled();

    fireEvent.click(within(rows[1]).getByTestId("webhook-test"));
    expect(within(rows[0]).getByTestId("webhook-test")).toBeEnabled();
    expect(within(rows[1]).getByTestId("webhook-test")).toBeDisabled();

    await act(async () => newerRetry.resolve(response({ ok: true })));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(5));
    expect(within(screen.getAllByTestId("webhook-row")[1]).getByTestId("webhook-test")).toBeEnabled();
  });

  it("invalidates every owner on unmount and handles late action resolutions and rejections", async () => {
    const testAction = deferred<Response>();
    const enableAction = deferred<Response>();
    const createAction = deferred<Response>();
    const unhandled = vi.fn();
    window.addEventListener("unhandledrejection", unhandled);
    fetchMock
      .mockResolvedValueOnce(response({ webhooks: [activeWebhook, disabledWebhook] }))
      .mockReturnValueOnce(testAction.promise)
      .mockReturnValueOnce(enableAction.promise)
      .mockReturnValueOnce(createAction.promise);
    const view = render(<WebhooksPanel />);

    const rows = await screen.findAllByTestId("webhook-row");
    fireEvent.click(within(rows[0]).getByTestId("webhook-test"));
    fireEvent.click(within(rows[1]).getByTestId("webhook-enable"));
    fireEvent.click(screen.getByTestId("webhook-add"));
    fireEvent.change(screen.getByTestId("webhook-url"), { target: { value: "https://receiver.example/late" } });
    fireEvent.submit(screen.getByTestId("webhook-form"));
    expect(fetchMock).toHaveBeenCalledTimes(4);

    view.unmount();
    testAction.reject(new Error("late test rejection"));
    enableAction.resolve(response({ webhook: { ...disabledWebhook, active: true, failures: 0 } }));
    createAction.resolve(response({ webhook: { ...activeWebhook, id: "late-created-hook", secret: "whsec_late" } }));
    await Promise.allSettled([testAction.promise, enableAction.promise, createAction.promise]);
    await Promise.resolve();
    await Promise.resolve();

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(unhandled).not.toHaveBeenCalled();
    window.removeEventListener("unhandledrejection", unhandled);
  });
});

describe("Settings → Webhooks: layout retirement", () => {
  it.each([
    {
      label: "success",
      settle: (pending: ReturnType<typeof deferred<Response>>) => pending.resolve(response({ webhooks: [disabledWebhook] })),
    },
    {
      label: "failure",
      settle: (pending: ReturnType<typeof deferred<Response>>) => pending.resolve(response({ error: "Retired list failed" }, 503)),
    },
  ])("retires an initial list $label before replacing the card", async ({ settle }) => {
    const retiredList = deferred<Response>();
    const currentList = deferred<Response>();
    const currentAction = deferred<Response>();
    fetchMock.mockReturnValueOnce(retiredList.promise).mockReturnValueOnce(currentList.promise).mockReturnValueOnce(currentAction.promise);
    const view = render(<BoundaryHarness cardKey={1} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    view.rerender(<BoundaryHarness cardKey={2} boundary={1} onBoundary={() => settle(retiredList)} />);
    await act(async () => {
      await retiredList.promise;
      await Promise.resolve();
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    expect(screen.getByText("Loading…")).toBeInTheDocument();
    expect(screen.queryByTestId("webhooks-list-error")).toBeNull();
    expect(screen.queryByTestId("webhook-row")).toBeNull();

    await act(async () => currentList.resolve(response({ webhooks: [activeWebhook] })));
    const testButton = within(await screen.findByTestId("webhook-row")).getByTestId("webhook-test");
    fireEvent.click(testButton);
    expect(testButton).toBeDisabled();
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(["/api/webhooks", "/api/webhooks", "/api/webhooks/active-hook/test"]);

    await act(async () => currentAction.resolve(response({ error: "Current test failed" }, 503)));
    expect(await screen.findByTestId("webhook-action-error")).toHaveTextContent("Current test failed");
    expect(screen.getByTestId("webhook-test")).toBeEnabled();
  });

  it.each([
    {
      label: "success",
      settle: (pending: ReturnType<typeof deferred<Response>>) => pending.resolve(response({ webhooks: [activeWebhook] })),
    },
    {
      label: "failure",
      settle: (pending: ReturnType<typeof deferred<Response>>) => pending.resolve(response({ error: "Retired Retry failed" }, 503)),
    },
  ])("retires a pending Retry $label without clearing the replacement Retry owner", async ({ settle }) => {
    const retiredRetry = deferred<Response>();
    const currentRetry = deferred<Response>();
    fetchMock
      .mockResolvedValueOnce(response({ error: "Retired initial failure" }, 503))
      .mockReturnValueOnce(retiredRetry.promise)
      .mockResolvedValueOnce(response({ error: "Current initial failure" }, 503))
      .mockReturnValueOnce(currentRetry.promise);
    const view = render(<BoundaryHarness cardKey={1} />);

    fireEvent.click(within(await screen.findByTestId("webhooks-list-error")).getByRole("button", { name: "Retry" }));
    view.rerender(<BoundaryHarness cardKey={2} boundary={1} onBoundary={() => settle(retiredRetry)} />);
    await act(async () => {
      await Promise.allSettled([retiredRetry.promise]);
      await Promise.resolve();
    });

    const currentRetryButton = within(await screen.findByTestId("webhooks-list-error")).getByRole("button", { name: "Retry" });
    expect(screen.getByTestId("webhooks-list-error")).toHaveTextContent("Current initial failure");
    fireEvent.click(currentRetryButton);
    fireEvent.click(currentRetryButton);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(screen.getByRole("button", { name: "Retrying…" })).toBeDisabled();

    await act(async () => currentRetry.resolve(response({ webhooks: [] })));
    expect(await screen.findByTestId("webhooks-empty")).toHaveTextContent("No webhooks yet.");
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(["/api/webhooks", "/api/webhooks", "/api/webhooks", "/api/webhooks"]);
  });

  it.each([
    {
      label: "success with a returned secret",
      settle: (pending: ReturnType<typeof deferred<Response>>) =>
        pending.resolve(response({ webhook: { ...activeWebhook, id: "retired-created-hook", secret: "whsec_retired" } })),
    },
    {
      label: "failure",
      settle: (pending: ReturnType<typeof deferred<Response>>) => pending.reject(new Error("Retired create failed")),
    },
  ])("retires an Add $label at the removed-card boundary", async ({ settle }) => {
    const retiredCreate = deferred<Response>();
    fetchMock
      .mockResolvedValueOnce(response({ webhooks: [] }))
      .mockReturnValueOnce(retiredCreate.promise)
      .mockResolvedValue(response({ webhooks: [activeWebhook] }));
    const view = render(<BoundaryHarness />);

    await screen.findByTestId("webhooks-empty");
    fireEvent.click(screen.getByTestId("webhook-add"));
    fireEvent.change(screen.getByTestId("webhook-url"), { target: { value: "https://receiver.example/retired-create" } });
    fireEvent.submit(screen.getByTestId("webhook-form"));
    expect(fetchMock).toHaveBeenCalledTimes(2);

    view.rerender(<BoundaryHarness present={false} boundary={1} onBoundary={() => settle(retiredCreate)} />);
    await act(async () => {
      await Promise.allSettled([retiredCreate.promise]);
      await Promise.resolve();
    });

    expect(screen.queryByTestId("webhooks-card")).toBeNull();
    expect(screen.queryByTestId("webhook-created")).toBeNull();
    expect(screen.queryByTestId("webhook-action-error")).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    {
      label: "Test success",
      hook: activeWebhook,
      control: "webhook-test",
      actionUrl: "/api/webhooks/active-hook/test",
      settle: (pending: ReturnType<typeof deferred<Response>>) => pending.resolve(response({ ok: true })),
    },
    {
      label: "Test failure",
      hook: activeWebhook,
      control: "webhook-test",
      actionUrl: "/api/webhooks/active-hook/test",
      settle: (pending: ReturnType<typeof deferred<Response>>) => pending.resolve(response({ error: "Retired test failed" }, 503)),
    },
    {
      label: "Enable success",
      hook: disabledWebhook,
      control: "webhook-enable",
      actionUrl: "/api/webhooks/disabled-hook/enable",
      settle: (pending: ReturnType<typeof deferred<Response>>) =>
        pending.resolve(response({ webhook: { ...disabledWebhook, active: true, failures: 0 } })),
    },
    {
      label: "Enable failure",
      hook: disabledWebhook,
      control: "webhook-enable",
      actionUrl: "/api/webhooks/disabled-hook/enable",
      settle: (pending: ReturnType<typeof deferred<Response>>) => pending.resolve(response({ error: "Retired enable failed" }, 503)),
    },
    {
      label: "Delete success",
      hook: activeWebhook,
      control: "webhook-delete",
      actionUrl: "/api/webhooks/active-hook",
      settle: (pending: ReturnType<typeof deferred<Response>>) => pending.resolve(response({ ok: true })),
    },
    {
      label: "Delete failure",
      hook: activeWebhook,
      control: "webhook-delete",
      actionUrl: "/api/webhooks/active-hook",
      settle: (pending: ReturnType<typeof deferred<Response>>) => pending.reject(new Error("Retired delete failed")),
    },
  ])("retires a pending $label at the removed-card boundary", async ({ hook, control, actionUrl, settle }) => {
    const retiredAction = deferred<Response>();
    vi.stubGlobal("confirm", vi.fn(() => true));
    fetchMock
      .mockResolvedValueOnce(response({ webhooks: [hook] }))
      .mockReturnValueOnce(retiredAction.promise)
      .mockResolvedValue(response({ webhooks: [activeWebhook] }));
    const view = render(<BoundaryHarness />);

    fireEvent.click(await screen.findByTestId(control));
    expect(fetchMock).toHaveBeenCalledTimes(2);

    view.rerender(<BoundaryHarness present={false} boundary={1} onBoundary={() => settle(retiredAction)} />);
    await act(async () => {
      await Promise.allSettled([retiredAction.promise]);
      await Promise.resolve();
    });

    expect(screen.queryByTestId("webhooks-card")).toBeNull();
    expect(screen.queryByTestId("webhook-action-error")).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.filter(([url]) => url === actionUrl)).toHaveLength(1);
  });
});
