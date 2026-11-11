// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OpeningDocument, OpeningDocumentBoundary } from "./opening-document";

let pending = false;
vi.mock("next/link", () => ({ useLinkStatus: () => ({ pending }) }));
vi.mock("@/components/editor/editor-chrome", () => ({ EditorChrome: () => null }));

const openingRef = { current: false };

function Page() {
  return (
    <OpeningDocumentBoundary pendingRef={openingRef}>
      <button type="button" data-testid="card">
        One
        <OpeningDocument />
      </button>
    </OpeningDocumentBoundary>
  );
}

function setPending(view: ReturnType<typeof render>, next: boolean) {
  pending = next;
  act(() => view.rerender(<Page />));
}

describe("OpeningDocumentBoundary", () => {
  afterEach(() => {
    pending = false;
    cleanup();
  });

  it("keeps an empty status line in the page and fills it when a document starts opening", () => {
    const view = render(<Page />);
    const status = screen.getByTestId("opening-status");
    expect(status).toBeEmptyDOMElement();
    expect(status.closest("[inert]")).toBeNull();

    setPending(view, true);
    // The same element, so a screen reader hears a change; and not inside the part that went inert.
    expect(screen.getByTestId("opening-status")).toBe(status);
    expect(status).toHaveTextContent("Opening the document…");
    expect(status.closest("[inert]")).toBeNull();
  });

  it("makes the dashboard inert, moves the keyboard to the cover and keeps it there", async () => {
    const view = render(<Page />);
    const card = screen.getByTestId("card");
    card.focus();
    expect(openingRef.current).toBe(false);

    setPending(view, true);
    const cover = screen.getByTestId("opening-document");
    expect(cover).toHaveFocus();
    // One paint after the cover, so the click's own frame does not pay for restyling the dashboard.
    await waitFor(() => expect(screen.getByTestId("opening-covered")).toHaveAttribute("inert"));
    expect(cover.closest("[inert]")).toBeNull();
    expect(openingRef.current, "the dashboard's window shortcuts read this and stand down").toBe(true);

    expect(fireEvent.keyDown(cover, { key: "Tab" }), "Tab is not left to the browser").toBe(false);
    expect(cover).toHaveFocus();
  });

  it("gives the keyboard back to the card when the navigation ends on the dashboard", async () => {
    const view = render(<Page />);
    const card = screen.getByTestId("card");
    card.focus();
    setPending(view, true);
    expect(card).not.toHaveFocus();
    await waitFor(() => expect(screen.getByTestId("opening-covered")).toHaveAttribute("inert"));

    setPending(view, false);
    expect(screen.queryByTestId("opening-document")).toBeNull();
    expect(screen.getByTestId("opening-covered")).not.toHaveAttribute("inert");
    expect(card).toHaveFocus();
    expect(openingRef.current).toBe(false);
    expect(screen.getByTestId("opening-status")).toBeEmptyDOMElement();
  });
});
