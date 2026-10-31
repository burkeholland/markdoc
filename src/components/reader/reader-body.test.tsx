// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { hydrateRoot } from "react-dom/client";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReaderBody } from "./reader-body";
import { stashReaderBody, takeReaderBody } from "./reader-body-handoff";

afterEach(() => {
  cleanup();
  sessionStorage.clear();
  vi.restoreAllMocks();
});

describe("reader body handoff (#2418)", () => {
  it("hands the HTML over once and drops entries nobody took", () => {
    const key = stashReaderBody("<p>one</p>", 1_000);
    expect(takeReaderBody(key)).toBe("<p>one</p>");
    expect(takeReaderBody(key)).toBeUndefined();

    const stale = stashReaderBody("<p>stale</p>", 1_000);
    stashReaderBody("<p>later</p>", 1_000 + 61_000);
    expect(takeReaderBody(stale)).toBeUndefined();
  });

  it("server-renders the stashed HTML and keeps it through hydration without the HTML as a prop", async () => {
    const props = { bodyKey: stashReaderBody("<p>Server body</p>"), empty: false, hideFirstH1: false };
    const container = document.createElement("div");
    container.innerHTML = renderToString(<ReaderBody {...props} />);
    document.body.append(container);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    await act(async () => {
      hydrateRoot(container, <ReaderBody {...props} />);
    });
    expect(container.querySelector('[data-testid="reader-body"]')!.innerHTML).toBe("<p>Server body</p>");
    expect(errors).not.toHaveBeenCalled();
    container.remove();
  });

  it("does not reload for an empty document", () => {
    const reload = vi.fn();
    vi.spyOn(window, "location", "get").mockReturnValue({ ...window.location, reload });
    render(<ReaderBody bodyKey="missing" empty hideFirstH1={false} />);
    expect(screen.getByTestId("reader-body").innerHTML).toBe("");
    expect(reload).not.toHaveBeenCalled();
  });

  it("reloads once when rendered without a server render (client navigation)", () => {
    const reload = vi.fn();
    vi.spyOn(window, "location", "get").mockReturnValue({ ...window.location, reload });
    render(<ReaderBody bodyKey="missing" empty={false} hideFirstH1={false} />);
    cleanup();
    render(<ReaderBody bodyKey="missing-again" empty={false} hideFirstH1={false} />);
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
