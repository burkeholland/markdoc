// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const signOutSafely = vi.fn<() => Promise<boolean>>();
const clearAllLocalDocuments = vi.fn<() => Promise<number>>();
const navigateTo = vi.fn<(url: string) => void>();
vi.mock("@/lib/sign-out", () => ({ signOutSafely: () => signOutSafely() }));
vi.mock("@/editor/collab/offline", () => ({ clearAllLocalDocuments: () => clearAllLocalDocuments() }));
vi.mock("@/lib/nav", () => ({ navigateTo: (url: string) => navigateTo(url) }));

const { AccountSettings } = await import("./account-settings");

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  signOutSafely.mockReset().mockResolvedValue(true);
  clearAllLocalDocuments.mockReset().mockResolvedValue(0);
  navigateTo.mockReset();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the Account section of Settings (#2402)", () => {
  it("shows who is signed in, signs out, and links the zip export", async () => {
    const user = userEvent.setup();
    render(<AccountSettings login="octocat" name="Mona" image={null} isDemo={false} />);
    expect(screen.getByTestId("account-name").textContent).toBe("Mona");
    expect(screen.getByTestId("account-login").textContent).toBe("Signed in as @octocat");
    const exportLink = screen.getByRole("link", { name: /Export \.zip/ });
    expect(exportLink.getAttribute("href")).toBe("/api/me/export");
    expect(exportLink.hasAttribute("download")).toBe(true);
    await user.click(screen.getByRole("button", { name: /Sign out/ }));
    expect(signOutSafely).toHaveBeenCalledOnce();
  });

  it("deletes the account only once the login is typed, then clears this device and signs out", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    render(<AccountSettings login="octocat" name="Mona" image={null} isDemo={false} />);
    await user.click(screen.getByTestId("account-delete"));
    const submit = await screen.findByTestId("delete-account-submit");
    expect(submit).toBeDisabled();
    await user.type(screen.getByLabelText(/to confirm/), "octo");
    expect(submit).toBeDisabled();
    await user.type(screen.getByLabelText(/to confirm/), "cat");
    expect(submit).toBeEnabled();
    await user.click(submit);
    await waitFor(() => expect(navigateTo).toHaveBeenCalledWith("/api/auth/signout"));
    expect(fetchMock).toHaveBeenCalledWith("/api/me", expect.objectContaining({ method: "DELETE", body: JSON.stringify({ confirm: "octocat" }) }));
    expect(clearAllLocalDocuments).toHaveBeenCalledOnce();
  });

  it("shows the server's error and stays signed in when deletion fails", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: "Nope" }), { status: 403 }));
    render(<AccountSettings login="octocat" name={null} image={null} isDemo={false} />);
    await user.click(screen.getByTestId("account-delete"));
    await user.type(await screen.findByTestId("delete-account-confirm"), "octocat");
    await user.click(screen.getByTestId("delete-account-submit"));
    expect((await screen.findByTestId("delete-account-error")).textContent).toBe("Nope");
    expect(navigateTo).not.toHaveBeenCalled();
    expect(clearAllLocalDocuments).not.toHaveBeenCalled();
  });

  it("does not offer deletion for the shared demo account", () => {
    render(<AccountSettings login="markdoc-demo" name="Demo User" image={null} isDemo />);
    expect(screen.getByTestId("account-delete")).toBeDisabled();
    expect(screen.getByText("The shared demo account cannot be deleted.")).toBeTruthy();
  });
});
