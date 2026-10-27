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

const hook = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  url: `https://${id}.example.com`,
  events: ["mention"],
  documentIds: null,
  active: true,
  failures: 0,
  createdAt: new Date().toISOString(),
  lastDelivery: null,
  ...extra,
});

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("confirm", vi.fn(() => true));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("WebhooksPanel", () => {
  it("lists webhooks and shows the empty state", async () => {
    fetchMock.mockResolvedValueOnce(response({ webhooks: [] }));
    render(<WebhooksPanel />);
    expect(await screen.findByTestId("webhooks-empty")).toBeTruthy();
  });

  it("creates a webhook with parsed document ids and shows the secret once", async () => {
    fetchMock.mockImplementation(async (url, init) => {
      if (init?.method === "POST") return response({ webhook: { ...hook("new"), secret: "whsec_1" } });
      return response({ webhooks: [] });
    });
    render(<WebhooksPanel />);
    await screen.findByTestId("webhooks-empty");
    fireEvent.click(screen.getByTestId("webhook-add"));
    fireEvent.change(screen.getByTestId("webhook-url"), { target: { value: "https://x.test" } });
    fireEvent.change(screen.getByTestId("webhook-docs"), { target: { value: "https://app/d/abc, def" } });
    fireEvent.submit(screen.getByTestId("webhook-form"));
    expect((await screen.findByTestId("webhook-secret")).textContent).toBe("whsec_1");
    const post = fetchMock.mock.calls.find(([, init]) => init?.method === "POST")!;
    expect(JSON.parse(String(post[1]!.body))).toMatchObject({ url: "https://x.test", documentIds: ["abc", "def"] });
    expect(screen.queryByTestId("webhook-form")).toBeNull();
  });

  it("ignores a second submit while create is in flight", async () => {
    const pending = deferred<Response>();
    fetchMock.mockImplementation((url, init) =>
      init?.method === "POST" ? pending.promise : Promise.resolve(response({ webhooks: [] })),
    );
    render(<WebhooksPanel />);
    await screen.findByTestId("webhooks-empty");
    fireEvent.click(screen.getByTestId("webhook-add"));
    fireEvent.change(screen.getByTestId("webhook-url"), { target: { value: "https://x.test" } });
    fireEvent.submit(screen.getByTestId("webhook-form"));
    fireEvent.submit(screen.getByTestId("webhook-form"));
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    await act(async () => pending.resolve(response({ error: "nope" }, 400)));
    expect((await screen.findByTestId("webhook-action-error")).textContent).toBeTruthy();
  });

  it("runs row actions one at a time and reloads", async () => {
    const pending = deferred<Response>();
    fetchMock.mockImplementation((url, init) =>
      init?.method === "POST" ? pending.promise : Promise.resolve(response({ webhooks: [hook("a", { active: false })] })),
    );
    render(<WebhooksPanel />);
    const row = await screen.findByTestId("webhook-row");
    fireEvent.click(within(row).getByTestId("webhook-test"));
    expect((within(row).getByTestId("webhook-enable") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(row).getByTestId("webhook-test"));
    expect(fetchMock.mock.calls.filter(([u]) => String(u).endsWith("/test"))).toHaveLength(1);
    await act(async () => pending.resolve(response({ ok: true })));
    await waitFor(() => expect((within(row).getByTestId("webhook-test") as HTMLButtonElement).disabled).toBe(false));
  });

  it("deletes only after confirmation", async () => {
    const confirmMock = vi.fn(() => false);
    vi.stubGlobal("confirm", confirmMock);
    fetchMock.mockResolvedValue(response({ webhooks: [hook("a")] }));
    render(<WebhooksPanel />);
    fireEvent.click(await screen.findByTestId("webhook-delete"));
    expect(confirmMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(false);
  });

  it("shows a list error with Retry that reloads", async () => {
    fetchMock.mockResolvedValueOnce(response({ error: "down" }, 500));
    fetchMock.mockResolvedValue(response({ webhooks: [] }));
    render(<WebhooksPanel />);
    const error = await screen.findByTestId("webhooks-list-error");
    fireEvent.click(within(error).getByRole("button", { name: "Retry" }));
    expect(await screen.findByTestId("webhooks-empty")).toBeTruthy();
    expect(screen.queryByTestId("webhooks-list-error")).toBeNull();
  });

  it("Escape cancels the form and arrows move between row actions", async () => {
    fetchMock.mockResolvedValue(response({ webhooks: [hook("a")] }));
    render(<WebhooksPanel />);
    const row = await screen.findByTestId("webhook-row");
    const test = within(row).getByTestId("webhook-test");
    test.focus();
    fireEvent.keyDown(test, { key: "ArrowRight" });
    expect(document.activeElement).toBe(within(row).getByTestId("webhook-delete"));
    fireEvent.keyDown(document.activeElement!, { key: "ArrowRight" });
    expect(document.activeElement).toBe(within(row).getByTestId("webhook-delete"));
    fireEvent.keyDown(document.activeElement!, { key: "Home" });
    expect(document.activeElement).toBe(test);
    fireEvent.keyDown(test, { key: "ArrowRight", ctrlKey: true });
    expect(document.activeElement).toBe(test);

    fireEvent.click(screen.getByTestId("webhook-add"));
    fireEvent.keyDown(screen.getByTestId("webhook-url"), { key: "Escape" });
    expect(screen.queryByTestId("webhook-form")).toBeNull();
  });
});
