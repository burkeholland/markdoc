// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/auth", () => ({ auth: async () => ({ user: { id: "u1", login: "octocat", name: "Mona", image: null } }) }));
vi.mock("@/server/http", () => ({ embeddedDocumentPath: async () => null }));
vi.mock("@/server/public-origin", () => ({ publicOrigin: () => "http://localhost:3700" }));
vi.mock("@/server/tokens", () => ({ listApiTokens: async () => [], serializeApiTokenMetadata: (t: unknown) => t }));
vi.mock("@/server/account", () => ({ isDemoAccount: (login: string) => login === "markdoc-demo" }));
vi.mock("@/components/settings/agents-panel", () => ({
  AgentsPanel: () => (
    <div data-testid="agents-panel">
      <h2 id="settings-agents">AI agents</h2>
    </div>
  ),
}));
vi.mock("@/components/settings/advanced-settings", () => ({ AdvancedSettings: () => <div data-testid="advanced-settings" /> }));
vi.mock("next/navigation", () => ({ redirect: vi.fn(), useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));

const { default: SettingsPage } = await import("./page");

afterEach(cleanup);

describe("/settings layout (#2402)", () => {
  it("provides a page heading and groups account, agent, and device settings", async () => {
    render(await SettingsPage({ searchParams: Promise.resolve({}) }));
    const back = screen.getByTestId("settings-back");
    expect(back.textContent).toContain("Documents");
    expect(screen.getAllByRole("link")[0]).toBe(back);

    const pageHeading = screen.getByRole("heading", { name: "Settings", level: 1 });
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent)).toEqual([
      "Account",
      "AI agents",
      "This device",
    ]);

    const account = screen.getByRole("region", { name: "Account" });
    expect(within(account).getByTestId("account-login").textContent).toBe("Signed in as @octocat");
    expect(within(account).getByTestId("account-export")).toBeTruthy();
    expect(within(account).getByTestId("account-delete")).toBeEnabled();

    const agents = screen.getByRole("region", { name: "AI agents" });
    expect(within(agents).getByTestId("agents-panel")).toBeTruthy();
    expect(within(agents).getByTestId("advanced-settings")).toBeTruthy();
    const device = screen.getByRole("region", { name: "This device" });
    expect(within(device).getByTestId("theme-row")).toBeTruthy();
    expect(within(device).getByTestId("link-cards-row")).toBeTruthy();

    const accountHeading = screen.getByRole("heading", { name: "Account", level: 2 });
    expect(pageHeading.compareDocumentPosition(accountHeading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(account.compareDocumentPosition(agents) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(agents.compareDocumentPosition(device) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
