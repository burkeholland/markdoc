// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import {
  useLayoutEffect,
  type ChangeEvent,
  type FormEvent,
  type MouseEvent as ReactMouseEvent,
  type RefCallback,
} from "react";

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

function reactProp<T>(element: HTMLElement, name: string): T {
  const propsKey = Object.keys(element).find((key) => key.startsWith("__reactProps$"));
  if (!propsKey) throw new Error(`React props were not attached to ${element.dataset.testid ?? element.tagName}`);
  const props = (element as unknown as Record<string, Record<string, unknown> | undefined>)[propsKey];
  const value = props?.[name];
  if (typeof value !== "function") throw new Error(`${name} was not attached to ${element.dataset.testid ?? element.tagName}`);
  return value as T;
}

type ClickHandler = (event: ReactMouseEvent<HTMLButtonElement>) => void;
type InputChangeHandler = (event: ChangeEvent<HTMLInputElement>) => void;
type SubmitHandler = (event: FormEvent<HTMLFormElement>) => void;

function mouseEvent(currentTarget: HTMLButtonElement) {
  const nativeEvent = new window.MouseEvent("click", { bubbles: true, cancelable: true });
  Object.defineProperty(nativeEvent, "target", { configurable: true, value: currentTarget });
  return {
    type: "click",
    currentTarget,
    target: currentTarget,
    nativeEvent,
    defaultPrevented: false,
    preventDefault: vi.fn(),
  } as unknown as ReactMouseEvent<HTMLButtonElement>;
}

function submitEvent(
  currentTarget: HTMLFormElement,
  target: EventTarget,
  nativeTarget: EventTarget,
  submitter: HTMLElement | null,
) {
  const nativeEvent = new window.Event("submit", { bubbles: true, cancelable: true });
  Object.defineProperties(nativeEvent, {
    target: { configurable: true, value: nativeTarget },
    submitter: { configurable: true, value: submitter },
  });
  const preventDefault = vi.fn(() => nativeEvent.preventDefault());
  return {
    event: {
      type: "submit",
      currentTarget,
      target,
      nativeEvent,
      defaultPrevented: false,
      preventDefault,
    } as unknown as FormEvent<HTMLFormElement>,
    preventDefault,
  };
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
  vi.restoreAllMocks();
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

describe("Settings → Webhooks: exact committed controls", () => {
  it("rejects A handlers through B controls in both orders and ignores late A ref cleanup", async () => {
    fetchMock.mockImplementation(() => Promise.resolve(response({ webhooks: [] })));
    const view = render(<BoundaryHarness cardKey={1} />);
    await screen.findByTestId("webhooks-empty");

    const addA = screen.getByTestId("webhook-add") as HTMLButtonElement;
    const clickA = reactProp<ClickHandler>(addA, "onClick");
    const refA = reactProp<RefCallback<HTMLButtonElement>>(addA, "ref");

    view.rerender(<BoundaryHarness cardKey={2} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await screen.findByTestId("webhooks-empty");
    const addB = screen.getByTestId("webhook-add") as HTMLButtonElement;
    const clickB = reactProp<ClickHandler>(addB, "onClick");

    act(() => {
      clickA(mouseEvent(addB));
      clickB(mouseEvent(addA));
      clickB(mouseEvent(addA));
      clickA(mouseEvent(addB));
      refA(null);
    });

    expect(screen.queryByTestId("webhook-form")).toBeNull();
    fireEvent.click(addB);
    expect(screen.getByTestId("webhook-form")).toBeInTheDocument();
  });

  it("requires exact input targets and retires equal-looking draft handlers on the reused DOM", async () => {
    fetchMock.mockResolvedValueOnce(response({ webhooks: [] }));
    render(<WebhooksPanel />);
    await screen.findByTestId("webhooks-empty");
    fireEvent.click(screen.getByTestId("webhook-add"));

    const url = screen.getByTestId("webhook-url") as HTMLInputElement;
    const docs = screen.getByTestId("webhook-docs") as HTMLInputElement;
    const staleChange = reactProp<InputChangeHandler>(url, "onChange");

    url.value = "https://receiver.example/wrong-target";
    act(() => staleChange({ currentTarget: url, target: docs } as ChangeEvent<HTMLInputElement>));
    url.value = "";
    docs.value = "https://receiver.example/wrong-current";
    act(() => staleChange({ currentTarget: docs, target: docs } as ChangeEvent<HTMLInputElement>));
    docs.value = "";
    expect(url).toHaveValue("");
    expect(docs).toHaveValue("");

    fireEvent.change(url, { target: { value: "https://receiver.example/current" } });
    expect(url).toHaveValue("https://receiver.example/current");
    const currentChange = reactProp<InputChangeHandler>(url, "onChange");
    expect(currentChange).not.toBe(staleChange);

    url.value = "https://receiver.example/stale";
    act(() => staleChange({ currentTarget: url, target: url } as ChangeEvent<HTMLInputElement>));
    url.value = "https://receiver.example/current";
    expect(url).toHaveValue("https://receiver.example/current");

    url.value = "https://receiver.example/successor";
    act(() => currentChange({ currentTarget: url, target: url } as ChangeEvent<HTMLInputElement>));
    expect(url).toHaveValue("https://receiver.example/successor");
  });

  it("accepts only an exact native form submit and preserves keyboard submission", async () => {
    const create = deferred<Response>();
    fetchMock.mockResolvedValueOnce(response({ webhooks: [] })).mockReturnValueOnce(create.promise);
    render(<WebhooksPanel />);
    await screen.findByTestId("webhooks-empty");
    fireEvent.click(screen.getByTestId("webhook-add"));
    fireEvent.change(screen.getByTestId("webhook-url"), { target: { value: "https://receiver.example/native-submit" } });

    const form = screen.getByTestId("webhook-form") as HTMLFormElement;
    const createButton = screen.getByTestId("webhook-create") as HTMLButtonElement;
    const addButton = screen.getByTestId("webhook-add") as HTMLButtonElement;
    const submit = reactProp<SubmitHandler>(form, "onSubmit");
    const foreignForm = document.createElement("form");
    document.body.appendChild(foreignForm);

    const wrongCurrent = submitEvent(foreignForm, form, form, createButton);
    const wrongTarget = submitEvent(form, createButton, form, createButton);
    const wrongNativeTarget = submitEvent(form, form, foreignForm, createButton);
    const wrongSubmitter = submitEvent(form, form, form, addButton);
    act(() => {
      submit(wrongCurrent.event);
      submit(wrongTarget.event);
      submit(wrongNativeTarget.event);
      submit(wrongSubmitter.event);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(wrongCurrent.preventDefault).not.toHaveBeenCalled();
    expect(wrongTarget.preventDefault).not.toHaveBeenCalled();
    expect(wrongNativeTarget.preventDefault).not.toHaveBeenCalled();
    expect(wrongSubmitter.preventDefault).not.toHaveBeenCalled();

    createButton.disabled = true;
    const disabled = submitEvent(form, form, form, createButton);
    act(() => submit(disabled.event));
    createButton.disabled = false;
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const keyboardSubmit = submitEvent(form, form, form, null);
    act(() => submit(keyboardSubmit.event));
    expect(keyboardSubmit.preventDefault).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toEqual({
      url: "https://receiver.example/native-submit",
      events: ["request.created", "mention", "comment.added", "comment.replied"],
      documentIds: null,
    });
    foreignForm.remove();
  });

  it("rejects sibling, foreign, detached, cross-control, disabled, wrong-row, and reordered row sources", async () => {
    const pending = deferred<Response>();
    fetchMock
      .mockResolvedValueOnce(response({ webhooks: [disabledWebhook, otherDisabledWebhook] }))
      .mockReturnValueOnce(pending.promise);
    render(<WebhooksPanel />);
    const rows = await screen.findAllByTestId("webhook-row");
    const firstTest = within(rows[0]).getByTestId("webhook-test") as HTMLButtonElement;
    const secondTest = within(rows[1]).getByTestId("webhook-test") as HTMLButtonElement;
    const firstDelete = within(rows[0]).getByTestId("webhook-delete") as HTMLButtonElement;
    const click = reactProp<ClickHandler>(firstTest, "onClick");
    const detached = firstTest.cloneNode(true) as HTMLButtonElement;
    const foreign = document.createElement("button");
    document.body.appendChild(foreign);

    act(() => {
      click(mouseEvent(secondTest));
      click(mouseEvent(firstDelete));
      click(mouseEvent(detached));
      click(mouseEvent(foreign));
    });
    firstTest.disabled = true;
    act(() => click(mouseEvent(firstTest)));
    firstTest.disabled = false;

    const list = rows[0].parentElement!;
    list.insertBefore(rows[1], rows[0]);
    act(() => click(mouseEvent(firstTest)));
    list.insertBefore(rows[0], rows[1]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    act(() => click(mouseEvent(firstTest)));
    expect(fetchMock.mock.calls.map(([requestedUrl]) => requestedUrl)).toEqual([
      "/api/webhooks",
      "/api/webhooks/disabled-hook/test",
    ]);
    foreign.remove();
  });

  it("re-reads every mutable API row primitive before claiming a row action", async () => {
    interface MutableRow {
      id: string;
      url: string;
      events: string[];
      documentIds: string[] | null;
      active: boolean;
      failures: number;
      createdAt: string;
      lastDelivery: { status: number; at: string; attempt: number; event: string } | null;
    }

    const captured: { row: MutableRow | null } = { row: null };
    const originalParse = JSON.parse;
    vi.spyOn(JSON, "parse").mockImplementation((text: string) => {
      const parsed = originalParse(text) as { webhooks?: MutableRow[] };
      if (parsed.webhooks?.length === 1) captured.row = parsed.webhooks[0]!;
      return parsed;
    });
    const pending = deferred<Response>();
    fetchMock.mockResolvedValueOnce(response({ webhooks: [disabledWebhook] })).mockReturnValueOnce(pending.promise);
    render(<WebhooksPanel />);
    const testButton = await screen.findByTestId("webhook-test") as HTMLButtonElement;
    const click = reactProp<ClickHandler>(testButton, "onClick");
    const liveRow = captured.row;
    if (!liveRow?.lastDelivery) throw new Error("The parsed webhook row was not captured");

    const originalDelivery = { ...liveRow.lastDelivery };
    const mutations: Array<() => () => void> = [
      () => {
        const old = liveRow!.id;
        liveRow!.id = "mutated-id";
        return () => { liveRow!.id = old; };
      },
      () => {
        const old = liveRow!.url;
        liveRow!.url = "https://receiver.example/mutated";
        return () => { liveRow!.url = old; };
      },
      () => {
        const old = liveRow!.events[0]!;
        liveRow!.events[0] = "mutated.event";
        return () => { liveRow!.events[0] = old; };
      },
      () => {
        liveRow!.documentIds = ["mutated-document"];
        return () => { liveRow!.documentIds = null; };
      },
      () => {
        liveRow!.active = true;
        return () => { liveRow!.active = false; };
      },
      () => {
        liveRow!.failures = 19;
        return () => { liveRow!.failures = 20; };
      },
      () => {
        liveRow!.createdAt = "2026-09-02T12:00:00.000Z";
        return () => { liveRow!.createdAt = disabledWebhook.createdAt; };
      },
      () => {
        liveRow!.lastDelivery!.status = 201;
        return () => { liveRow!.lastDelivery!.status = originalDelivery.status; };
      },
      () => {
        liveRow!.lastDelivery!.at = "2026-09-02T12:01:00.000Z";
        return () => { liveRow!.lastDelivery!.at = originalDelivery.at; };
      },
      () => {
        liveRow!.lastDelivery!.attempt = 5;
        return () => { liveRow!.lastDelivery!.attempt = originalDelivery.attempt; };
      },
      () => {
        liveRow!.lastDelivery!.event = "mutated.event";
        return () => { liveRow!.lastDelivery!.event = originalDelivery.event; };
      },
    ];

    for (const mutate of mutations) {
      const restore = mutate();
      act(() => click(mouseEvent(testButton)));
      restore();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }

    act(() => click(mouseEvent(testButton)));
    expect(fetchMock.mock.calls.map(([requestedUrl]) => requestedUrl)).toEqual([
      "/api/webhooks",
      "/api/webhooks/disabled-hook/test",
    ]);
  });

  it("allows a later Delete after decline while blocking reentrant confirmation for the same event", async () => {
    const deletion = deferred<Response>();
    fetchMock.mockResolvedValueOnce(response({ webhooks: [activeWebhook] })).mockReturnValueOnce(deletion.promise);
    render(<WebhooksPanel />);
    const deleteButton = await screen.findByTestId("webhook-delete") as HTMLButtonElement;
    const click = reactProp<ClickHandler>(deleteButton, "onClick");
    const declinedEvent = mouseEvent(deleteButton);
    const confirmMock = vi
      .fn<(message?: string) => boolean>()
      .mockImplementationOnce(() => {
        click(declinedEvent);
        return false;
      })
      .mockReturnValueOnce(true);
    vi.stubGlobal("confirm", confirmMock);

    act(() => click(declinedEvent));
    expect(confirmMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    act(() => click(mouseEvent(deleteButton)));
    expect(confirmMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.map(([requestedUrl]) => requestedUrl)).toEqual([
      "/api/webhooks",
      "/api/webhooks/active-hook",
    ]);
  });

  it("binds Copy to the exact created secret DOM and ignores later mutation of the API object", async () => {
    const captured: { created: { id: string; secret: string; url: string } | null } = { created: null };
    const originalParse = JSON.parse;
    vi.spyOn(JSON, "parse").mockImplementation((text: string) => {
      const parsed = originalParse(text) as { webhook?: { id: string; secret?: string; url: string } };
      if (parsed.webhook?.secret) {
        captured.created = parsed.webhook as { id: string; secret: string; url: string };
      }
      return parsed;
    });
    const writeText = vi.fn(() => Promise.resolve());
    const navigatorWithClipboard = Object.create(window.navigator) as Navigator;
    Object.defineProperty(navigatorWithClipboard, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    vi.stubGlobal("navigator", navigatorWithClipboard);
    fetchMock
      .mockResolvedValueOnce(response({ webhooks: [] }))
      .mockResolvedValueOnce(response({ webhook: { ...activeWebhook, id: "created-hook", secret: "whsec_exact" } }))
      .mockResolvedValueOnce(response({ webhooks: [{ ...activeWebhook, id: "created-hook" }] }));
    render(<WebhooksPanel />);
    await screen.findByTestId("webhooks-empty");
    fireEvent.click(screen.getByTestId("webhook-add"));
    fireEvent.change(screen.getByTestId("webhook-url"), { target: { value: activeWebhook.url } });
    fireEvent.click(screen.getByTestId("webhook-create"));

    const createdRoot = await screen.findByTestId("webhook-created");
    const code = within(createdRoot).getByTestId("webhook-secret");
    const copyButton = within(createdRoot).getByRole("button", { name: "Copy secret" }) as HTMLButtonElement;
    const copy = reactProp<ClickHandler>(copyButton, "onClick");
    const createdSource = captured.created;
    if (!createdSource) throw new Error("The parsed created webhook was not captured");
    createdSource.id = "mutated-created-id";
    createdSource.url = "https://receiver.example/mutated-created";
    createdSource.secret = "whsec_mutated";

    const originalText = code.textContent;
    code.textContent = "whsec_dom_mutated";
    act(() => copy(mouseEvent(copyButton)));
    code.textContent = originalText;
    act(() => copy(mouseEvent(screen.getByTestId("webhook-add") as HTMLButtonElement)));
    expect(writeText).not.toHaveBeenCalled();

    const exactEvent = mouseEvent(copyButton);
    act(() => {
      copy(exactEvent);
      copy(exactEvent);
    });
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith("whsec_exact");
  });

  it("retires a publication on control replacement and requires a rendered successor", async () => {
    fetchMock.mockImplementation(() => Promise.resolve(response({ webhooks: [] })));
    const view = render(<BoundaryHarness cardKey={1} />);
    await screen.findByTestId("webhooks-empty");
    fireEvent.click(screen.getByTestId("webhook-add"));
    const cancel = screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement;
    const clickCancel = reactProp<ClickHandler>(cancel, "onClick");
    const cancelRef = reactProp<RefCallback<HTMLButtonElement>>(cancel, "ref");
    const replacement = cancel.cloneNode(true) as HTMLButtonElement;
    document.body.appendChild(replacement);

    act(() => {
      cancelRef(replacement);
      cancelRef(cancel);
      clickCancel(mouseEvent(cancel));
    });
    expect(screen.getByTestId("webhook-form")).toBeInTheDocument();
    replacement.remove();

    view.rerender(<BoundaryHarness cardKey={2} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByTestId("webhook-add"));
    expect(screen.getByTestId("webhook-form")).toBeInTheDocument();
  });
});
