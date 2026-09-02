// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { WebhooksPanel } from "./webhooks-panel";

const fetchMock = vi.fn<typeof fetch>();

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
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
