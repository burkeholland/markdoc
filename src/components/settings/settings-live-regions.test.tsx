// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

vi.mock("@/components/settings/copilot-checklist", () => ({
  CopilotChecklist: () => null,
}));

import { TokensPanel } from "./tokens-panel";
import { WebhooksPanel } from "./webhooks-panel";

const fetchMock = vi.fn<typeof fetch>();

const webhook = {
  id: "hook-1",
  url: "https://example.com/markdoc",
  events: ["mention"],
  documentIds: null,
  active: true,
  failures: 0,
  createdAt: "2026-08-28T00:00:00.000Z",
  lastDelivery: null,
};

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function renderTokens() {
  return render(<TokensPanel origin="https://markdoc.test" userLogin="alice" />);
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("settings result live regions", () => {
  it("announces a token load failure as one atomic alert", async () => {
    fetchMock.mockResolvedValueOnce(response({ error: "Token service temporarily unavailable" }, 503));

    renderTokens();

    const alert = await screen.findByRole("alert");
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(alert).toHaveTextContent(/^Token service temporarily unavailable$/);
    expect(alert).toHaveAttribute("aria-atomic", "true");
  });

  it("announces consecutive token creation failures and keeps focus on the submit button", async () => {
    fetchMock
      .mockResolvedValueOnce(response({ tokens: [] }))
      .mockResolvedValueOnce(response({ error: "Token name is already in use" }, 409))
      .mockResolvedValueOnce(response({ error: "Token service temporarily unavailable" }, 503));
    renderTokens();
    await screen.findByText("No tokens yet.");
    const create = screen.getByTestId("token-create");
    create.focus();

    fireEvent.click(create);
    expect(await screen.findByRole("alert")).toHaveTextContent(/^Token name is already in use$/);
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(create).toHaveFocus();

    fireEvent.click(create);
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/^Token service temporarily unavailable$/));
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(create).toHaveFocus();
  });

  it("announces a created token as a polite atomic status without duplicating its secret", async () => {
    fetchMock
      .mockResolvedValueOnce(response({ tokens: [] }))
      .mockResolvedValueOnce(
        response({
          token: {
            token: "mdk_one_time_secret",
            name: "GitHub Copilot CLI",
            scope: "comment",
            documentIds: null,
          },
        }),
      )
      .mockResolvedValueOnce(response({ tokens: [] }));
    renderTokens();
    await screen.findByText("No tokens yet.");

    fireEvent.click(screen.getByTestId("token-create"));

    const status = await screen.findByRole("status");
    expect(status).toBe(screen.getByTestId("token-created"));
    expect(status).toHaveAttribute("aria-live", "polite");
    expect(status).toHaveAttribute("aria-atomic", "true");
    expect(status).toHaveTextContent("Token “GitHub Copilot CLI” created. Copy it now; it will not be shown again.");
    expect(within(status).getAllByText("mdk_one_time_secret", { selector: "code" })).toHaveLength(1);
    expect(status).not.toHaveFocus();
  });

  it("announces a webhook load failure as one atomic alert", async () => {
    fetchMock.mockResolvedValueOnce(response({ error: "Webhook service temporarily unavailable" }, 503));

    render(<WebhooksPanel />);

    const alert = await screen.findByRole("alert");
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(alert).toHaveTextContent(/^Webhook service temporarily unavailable$/);
    expect(alert).toHaveAttribute("aria-atomic", "true");
  });

  it("announces consecutive webhook creation failures and keeps focus on the submit button", async () => {
    fetchMock
      .mockResolvedValueOnce(response({ webhooks: [] }))
      .mockResolvedValueOnce(response({ error: "Webhook URL is already registered" }, 409))
      .mockResolvedValueOnce(response({ error: "Webhook service temporarily unavailable" }, 503));
    render(<WebhooksPanel />);
    await screen.findByTestId("webhooks-empty");
    fireEvent.click(screen.getByTestId("webhook-add"));
    fireEvent.change(screen.getByTestId("webhook-url"), { target: { value: webhook.url } });
    const create = screen.getByTestId("webhook-create");
    create.focus();

    fireEvent.click(create);
    expect(await screen.findByRole("alert")).toHaveTextContent(/^Webhook URL is already registered$/);
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(create).toHaveFocus();

    fireEvent.click(create);
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/^Webhook service temporarily unavailable$/));
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(create).toHaveFocus();
  });

  it("announces a webhook test failure and keeps focus on Send test", async () => {
    fetchMock.mockResolvedValueOnce(response({ webhooks: [webhook] })).mockResolvedValueOnce(response({ error: "Test delivery timed out" }, 504));
    render(<WebhooksPanel />);
    const sendTest = await screen.findByTestId("webhook-test");
    sendTest.focus();

    fireEvent.click(sendTest);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/^Test delivery timed out$/);
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(sendTest).toHaveFocus();
  });

  it("announces a created webhook as a polite atomic status without duplicating its secret", async () => {
    fetchMock
      .mockResolvedValueOnce(response({ webhooks: [] }))
      .mockResolvedValueOnce(response({ webhook: { ...webhook, secret: "whsec_one_time_secret" } }))
      .mockResolvedValueOnce(response({ webhooks: [webhook] }));
    render(<WebhooksPanel />);
    await screen.findByTestId("webhooks-empty");
    fireEvent.click(screen.getByTestId("webhook-add"));
    fireEvent.change(screen.getByTestId("webhook-url"), { target: { value: webhook.url } });

    fireEvent.click(screen.getByTestId("webhook-create"));

    const status = await screen.findByRole("status");
    expect(status).toBe(screen.getByTestId("webhook-created"));
    expect(status).toHaveAttribute("aria-live", "polite");
    expect(status).toHaveAttribute("aria-atomic", "true");
    expect(status).toHaveTextContent("Webhook added. Copy the signing secret now; it will not be shown again.");
    expect(within(status).getAllByText("whsec_one_time_secret", { selector: "code" })).toHaveLength(1);
    expect(status).not.toHaveFocus();
  });
});
