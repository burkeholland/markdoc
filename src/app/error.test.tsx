// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import AppError from "./error";
import GlobalError from "./global-error";

afterEach(cleanup);

describe("AppError (src/app/error.tsx)", () => {
  it("renders the eyebrow, heading and both actions", () => {
    render(<AppError error={new Error("boom")} reset={() => {}} />);
    expect(screen.getByTestId("app-error")).toBeInTheDocument();
    expect(screen.getByText("Error")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: "Something went wrong" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toHaveAttribute("type", "button");
    expect(screen.getByRole("link", { name: "Back to your documents" })).toHaveAttribute("href", "/");
  });

  it("calls reset exactly once when Try again is clicked", () => {
    const reset = vi.fn();
    render(<AppError error={new Error("boom")} reset={reset} />);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(reset).toHaveBeenCalledTimes(1);
  });

  // Production server errors arrive with the message redacted and only a digest; client errors keep their message.
  it("shows the digest as a reference and the message in the details", () => {
    render(<AppError error={Object.assign(new Error("boom"), { digest: "abc123" })} reset={() => {}} />);
    expect(screen.getByTestId("app-error-digest")).toHaveTextContent("Reference: abc123");
    const pre = screen.getByTestId("app-error").querySelector("pre");
    expect(pre).not.toBeNull();
    expect(pre).toHaveTextContent("boom");
  });

  it("omits the reference and the message block when the error carries neither", () => {
    render(<AppError error={new Error("")} reset={() => {}} />);
    expect(screen.queryByTestId("app-error-digest")).toBeNull();
    expect(screen.getByTestId("app-error").querySelector("pre")).toBeNull();
    expect(screen.getByText("Details")).toBeInTheDocument();
  });
});

describe("GlobalError (src/app/global-error.tsx)", () => {
  // Static markup: the component renders its own <html>, which RTL's <div> container would warn about.
  it("renders a whole document with the same copy, actions and details", () => {
    const html = renderToStaticMarkup(<GlobalError error={Object.assign(new Error("boom"), { digest: "abc123" })} reset={() => {}} />);
    expect(html).toContain('<html lang="en">');
    expect(html).toContain("Something went wrong");
    expect(html).toContain('data-testid="app-error"');
    expect(html).toMatch(/<button type="button"[^>]*>Try again<\/button>/);
    expect(html).toMatch(/<a href="\/"[^>]*>Back to your documents<\/a>/);
    expect(html).toContain("Reference: abc123");
    expect(html).toContain("boom");
    expect(html).toContain("prefers-color-scheme: dark");
    expect(html).not.toContain("class=");
  });
});
