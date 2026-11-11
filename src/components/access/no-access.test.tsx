// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

let pathname = "/d/missing";
const signOut = vi.fn();
vi.mock("next/navigation", () => ({ usePathname: () => pathname }));
vi.mock("@/lib/sign-out", () => ({ signOutSafely: (path: string) => signOut(path) }));
const { NoAccess } = await import("./no-access");

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  signOut.mockReset();
  window.history.replaceState(null, "", "/");
});

describe.each(["document", "folder"] as const)("%s unavailable Share target", (resource) => {
  it("does not grant access or reveal a title, and only requests on an explicit action", async () => {
    pathname = `/${resource === "document" ? "d" : "f"}/missing`;
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ requested: true }), { status: 202 }));
    vi.stubGlobal("fetch", fetch);
    render(<NoAccess resource={resource} />);
    expect(screen.getByRole("heading")).toHaveTextContent(`You can't open this ${resource}`);
    expect(fetch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("no-access-request"));
    expect(await screen.findByText("Request sent")).toBeVisible();
    expect(fetch).toHaveBeenCalledExactlyOnceWith(`/api/${resource === "document" ? "documents" : "folders"}/missing/access-request`, { method: "POST" });
    expect(screen.getByTestId("no-access-status")).toHaveTextContent(`If this ${resource} exists`);
  });

  it("keeps the exact Share request when switching to the authorized account", async () => {
    pathname = `/${resource === "document" ? "d" : "f"}/target`;
    const next = `${pathname}?accessRequest=carol&notification=request-id`;
    window.history.replaceState(null, "", next);
    render(<NoAccess resource={resource} />);
    fireEvent.click(screen.getByTestId("no-access-switch"));
    await waitFor(() => expect(signOut).toHaveBeenCalledExactlyOnceWith(`/login?next=${encodeURIComponent(next)}`));
  });
});
