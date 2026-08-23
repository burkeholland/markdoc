// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { hydrateRoot } from "react-dom/client";
import { RelativeTime, shortDate } from "./relative-time";

const NOW = new Date("2026-08-22T18:30:00Z").getTime();

describe("RelativeTime", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: NOW, toFake: ["Date", "setInterval", "clearInterval"] });
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("renders the absolute UTC date on the server, never relative text", () => {
    const html = renderToString(<RelativeTime date={new Date(NOW - 60_000)} prefix="Edited " />);
    expect(html).toContain('<time dateTime="2026-08-22T18:29:00.000Z"');
    expect(html).toContain(">Edited Aug 22</time>");
    expect(html).not.toContain("ago");
    expect(html).not.toContain("title=");
  });

  it("includes the year for dates outside the current year", () => {
    expect(shortDate(new Date("2025-12-31T23:59:00Z"), NOW)).toBe("Dec 31, 2025");
    expect(shortDate(new Date("2026-01-01T00:00:00Z"), NOW)).toBe("Jan 1");
  });

  it("hydrates without mismatch and then switches to relative text", async () => {
    const date = new Date(NOW - 60_000);
    const element = <RelativeTime date={date} prefix="Edited " />;
    const container = document.createElement("div");
    container.innerHTML = renderToString(element);
    document.body.appendChild(container);
    expect(container.textContent).toBe("Edited Aug 22");

    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const root = await act(async () => hydrateRoot(container, element));
    expect(errors).not.toHaveBeenCalled();

    const time = container.querySelector("time")!;
    expect(time.textContent).toBe("Edited 1 minute ago");
    expect(time.getAttribute("title")).toBeTruthy();
    expect(time.dataset.relative).toBe("true");
    act(() => root.unmount());
    container.remove();
  });

  it("re-renders every minute while mounted, sharing one interval", () => {
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    const date = new Date(NOW - 20_000);
    render(
      <>
        <RelativeTime date={date} prefix="A " />
        <RelativeTime date={date} prefix="B " />
        <RelativeTime date={date} prefix="C " />
      </>,
    );
    expect(screen.getByText("A just now")).toBeInTheDocument();
    expect(screen.getByText("C just now")).toBeInTheDocument();
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);

    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(screen.getByText("A 1 minute ago")).toBeInTheDocument();
    expect(screen.getByText("B 1 minute ago")).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(60_000 * 60);
    });
    expect(screen.getByText("A 1 hour ago")).toBeInTheDocument();
  });

  it("stops the ticker when the last instance unmounts", () => {
    const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");
    const { unmount } = render(<RelativeTime date={new Date(NOW)} />);
    expect(clearIntervalSpy).not.toHaveBeenCalled();
    unmount();
    expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
  });
});
