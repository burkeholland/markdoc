// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { hydrateRoot } from "react-dom/client";
import { HydrationMarker } from "./hydration-marker";

const hydrated = () => document.documentElement.hasAttribute("data-hydrated");

describe("HydrationMarker", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    delete document.documentElement.dataset.hydrated;
  });

  it("renders nothing, on the server and in the browser", () => {
    expect(renderToString(<HydrationMarker />)).toBe("");
    const { container } = render(<HydrationMarker />);
    expect(container).toBeEmptyDOMElement();
  });

  it("sets html[data-hydrated] (empty value) after mount, not before", () => {
    expect(hydrated()).toBe(false);
    render(<HydrationMarker />);
    expect(document.documentElement.getAttribute("data-hydrated")).toBe("");
  });

  it("hydrates server markup without a mismatch and then sets the attribute", async () => {
    const element = <HydrationMarker />;
    const container = document.createElement("div");
    container.innerHTML = renderToString(element);
    document.body.appendChild(container);
    expect(hydrated()).toBe(false);

    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const root = await act(async () => hydrateRoot(container, element));
    expect(errors).not.toHaveBeenCalled();
    expect(hydrated()).toBe(true);
    act(() => root.unmount());
    container.remove();
  });

  it("leaves the attribute in place when it unmounts", () => {
    const { unmount } = render(<HydrationMarker />);
    expect(hydrated()).toBe(true);
    unmount();
    expect(hydrated()).toBe(true);
  });
});
