// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/auth", () => ({ auth: async () => ({ user: { id: "u1", login: "octocat", name: "Mona", image: null } }) }));
vi.mock("@/server/http", () => ({ embeddedDocumentPath: async () => null }));
vi.mock("@/server/public-origin", () => ({ publicOrigin: () => "http://localhost:3700" }));
vi.mock("@/server/tokens", () => ({ listApiTokens: async () => [], serializeApiTokenMetadata: (t: unknown) => t }));
vi.mock("@/server/account", () => ({ isDemoAccount: (login: string) => login === "markdoc-demo" }));
vi.mock("@/components/settings/agents-panel", () => ({ AgentsPanel: () => <div data-testid="agents-panel" /> }));
vi.mock("@/components/settings/advanced-settings", () => ({ AdvancedSettings: () => <div data-testid="advanced-settings" /> }));
vi.mock("next/navigation", () => ({ redirect: vi.fn(), useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));

const { default: SettingsPage } = await import("./page");

afterEach(cleanup);

describe("/settings layout (#2402)", () => {
  it("groups account settings apart from this-device settings, with the back link first", async () => {
    render(await SettingsPage({ searchParams: Promise.resolve({}) }));
    const back = screen.getByTestId("settings-back");
    expect(back.textContent).toContain("Documents");
    expect(screen.getAllByRole("link")[0]).toBe(back);

    const account = screen.getByRole("region", { name: "Account" });
    expect(within(account).getByTestId("account-login").textContent).toBe("Signed in as @octocat");
    expect(within(account).getByTestId("account-export")).toBeTruthy();
    expect(within(account).getByTestId("account-delete")).toBeEnabled();
    expect(within(account).getByTestId("agents-panel")).toBeTruthy();
    expect(within(account).getByTestId("advanced-settings")).toBeTruthy();

    const device = screen.getByRole("region", { name: "This device" });
    expect(within(device).getByTestId("theme-row")).toBeTruthy();
    expect(within(device).getByTestId("link-cards-row")).toBeTruthy();
    expect(account.compareDocumentPosition(device) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
