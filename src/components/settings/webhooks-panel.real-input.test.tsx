// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { WebhooksPanel } from "./webhooks-panel";

const fetchMock = vi.fn<typeof fetch>();
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("adds a webhook with real typing, clicking and Enter", async () => {
  const user = userEvent.setup();
  fetchMock.mockImplementation(async (_url, init) =>
    init?.method === "POST"
      ? json({ webhook: { id: "n", url: "https://x.test", secret: "whsec_real" } })
      : json({ webhooks: [] }),
  );
  render(<WebhooksPanel />);
  await screen.findByTestId("webhooks-empty");
  await user.click(screen.getByTestId("webhook-add"));
  await user.click(screen.getByTestId("webhook-event-mention"));
  expect((screen.getByTestId("webhook-event-mention") as HTMLInputElement).checked).toBe(false);
  await user.type(screen.getByTestId("webhook-url"), "https://x.test{Enter}");
  expect((await screen.findByTestId("webhook-secret")).textContent).toBe("whsec_real");
});

it("Cancel button and keyboard row navigation work with real input", async () => {
  const user = userEvent.setup();
  vi.stubGlobal("confirm", vi.fn(() => false));
  fetchMock.mockResolvedValue(json({ webhooks: [{ id: "a", url: "https://a.test", events: ["mention"], documentIds: null, active: true, failures: 0, createdAt: new Date().toISOString(), lastDelivery: null }] }));
  render(<WebhooksPanel />);
  const row = await screen.findByTestId("webhook-row");
  await user.click(screen.getByTestId("webhook-add"));
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.queryByTestId("webhook-form")).toBeNull();
  within(row).getByTestId("webhook-test").focus();
  await user.keyboard("{ArrowRight}");
  expect(document.activeElement).toBe(within(row).getByTestId("webhook-delete"));
  await user.keyboard("{Enter}");
  expect(confirm).toHaveBeenCalledOnce();
});
