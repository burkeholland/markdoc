// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const signOutSafely = vi.hoisted(() => vi.fn(async () => true));
let pathname = "/d/abc123";
vi.mock("next/navigation", () => ({ usePathname: () => pathname }));
vi.mock("@/lib/sign-out", () => ({ signOutSafely }));

const { default: DocumentNotFound } = await import("./not-found");

const fetchMock = vi.fn();

beforeEach(() => {
  pathname = "/d/abc123";
  fetchMock.mockReset();
  signOutSafely.mockClear();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("/d/[id] not-found (no access)", () => {
  it("offers request access, switch account and a link back to Documents", () => {
    render(<DocumentNotFound />);
    expect(screen.getByTestId("no-access")).toBeTruthy();
    expect(screen.getByTestId("no-access-request").textContent).toBe("Request access");
    expect(screen.getByTestId("no-access-switch").textContent).toBe("Switch account");
    expect(screen.getByTestId("no-access-documents").getAttribute("href")).toBe("/");
  });

  it("requests access for the document in the URL and confirms without revealing whether it exists", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ requested: true }), { status: 202 }));
    render(<DocumentNotFound />);
    fireEvent.click(screen.getByTestId("no-access-request"));
    await waitFor(() => expect(screen.getByTestId("no-access-request").textContent).toBe("Request sent"));
    expect(fetchMock).toHaveBeenCalledWith("/api/documents/abc123/access-request", { method: "POST" });
    expect(screen.getByTestId("no-access-status").textContent).toContain("If this document exists");
    expect((screen.getByTestId("no-access-request") as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows an error when the request fails", async () => {
    fetchMock.mockResolvedValue(new Response("{}", { status: 429 }));
    render(<DocumentNotFound />);
    fireEvent.click(screen.getByTestId("no-access-request"));
    await waitFor(() => expect(screen.getByTestId("no-access-status").textContent).toContain("Could not send"));
  });

  it("switch account signs out and returns to this document after login", async () => {
    render(<DocumentNotFound />);
    fireEvent.click(screen.getByTestId("no-access-switch"));
    await waitFor(() => expect(signOutSafely).toHaveBeenCalledWith("/login?next=%2Fd%2Fabc123"));
  });
});
