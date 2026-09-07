// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type * as Y from "yjs";

// A CollabSession normally opens a WebSocket through Hocuspocus; stand in a provider that only
// supplies the awareness instance so the find model can drive the bar offline (as session-find.test.ts).
vi.mock("@hocuspocus/provider", async () => {
  const { Awareness } = await import("y-protocols/awareness");
  class HocuspocusProvider {
    awareness: InstanceType<typeof Awareness>;
    constructor(opts: { document: Y.Doc }) {
      this.awareness = new Awareness(opts.document);
    }
    destroy() {
      this.awareness.destroy();
    }
  }
  return { HocuspocusProvider };
});

import { CollabSession } from "@/editor/collab/session";
import { makeCollabUser } from "@/editor/collab/shared";
import { TooltipProvider } from "@/components/ui/primitives";
import { FindBar } from "./find-bar";

const TEXT = "The cat sat on the mat. The cat ran.";

function makeSession(role: "owner" | "viewer"): CollabSession {
  const session = new CollabSession({ docId: "doc", user: makeCollabUser("a", "Alice"), role, getToken: async () => "token", autoConnect: false });
  session.ytext.insert(0, TEXT);
  session.setFind("cat");
  return session;
}

function renderBar(session: CollabSession, replaceVisible: boolean, onReplaceVisible = vi.fn()) {
  render(
    <TooltipProvider>
      <FindBar session={session} replaceVisible={replaceVisible} onReplaceVisible={onReplaceVisible} focusNonce={0} onReveal={() => {}} onClose={() => {}} />
    </TooltipProvider>,
  );
  return onReplaceVisible;
}

const sessions: CollabSession[] = [];
const session = (role: "owner" | "viewer") => {
  const s = makeSession(role);
  sessions.push(s);
  return s;
};

afterEach(() => {
  cleanup();
  while (sessions.length) sessions.pop()!.destroy();
});

describe("FindBar replace row", () => {
  it("shows the row to an editor with the toggle reading Hide replace and pointing at it", () => {
    const onReplaceVisible = renderBar(session("owner"), true);
    expect(screen.getByTestId("find-count")).toHaveTextContent("1 of 2");

    const row = screen.getByTestId("find-replace-row");
    expect(row).toHaveAttribute("id", "find-replace-row");
    expect(screen.getByTestId("replace-input")).toBeInTheDocument();
    expect(screen.getByTestId("replace-one")).toBeEnabled();
    expect(screen.getByTestId("replace-all")).toBeEnabled();

    const toggle = screen.getByTestId("find-toggle-replace");
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(toggle).toHaveAttribute("aria-controls", "find-replace-row");
    expect(toggle).toHaveTextContent(/^Hide replace$/);
    expect(toggle.querySelector("svg")).not.toBeNull();

    fireEvent.click(toggle);
    expect(onReplaceVisible).toHaveBeenCalledWith(false);
  });

  it("collapsed: no row, the toggle reads Replace and asks the shell to show it", () => {
    const onReplaceVisible = renderBar(session("owner"), false);
    expect(screen.queryByTestId("find-replace-row")).toBeNull();

    const toggle = screen.getByTestId("find-toggle-replace");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(toggle).toHaveTextContent(/^Replace$/);
    expect(toggle.querySelector("svg")).not.toBeNull();

    fireEvent.click(toggle);
    expect(onReplaceVisible).toHaveBeenCalledWith(true);
  });

  it("gives a viewer neither the row nor the toggle, even when the shell asks for the row", () => {
    renderBar(session("viewer"), true);
    expect(screen.getByTestId("find-bar")).toBeInTheDocument();
    expect(screen.getByTestId("find-count")).toHaveTextContent("1 of 2");
    expect(screen.queryByTestId("find-replace-row")).toBeNull();
    expect(screen.queryByTestId("find-toggle-replace")).toBeNull();
    expect(screen.queryByTestId("replace-input")).toBeNull();
  });
});

describe("FindBar invalid regular expressions", () => {
  it("explains invalid syntax and blocks navigation and replacement until corrected", async () => {
    const s = session("owner");
    const stepFind = vi.spyOn(s, "stepFind");
    const replaceActive = vi.spyOn(s, "replaceActive");
    const replaceAll = vi.spyOn(s, "replaceAll");
    renderBar(s, true);

    fireEvent.click(screen.getByTestId("find-regex"));
    const input = screen.getByTestId("find-input");
    fireEvent.change(input, { target: { value: "(" } });

    const error = await screen.findByTestId("find-regex-error");
    expect(error).toHaveTextContent("Invalid regular expression");
    expect(error).toHaveAttribute("role", "status");
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveAttribute("aria-describedby", error.id);
    expect(screen.queryByTestId("find-count")).toBeNull();
    expect(screen.getByTestId("find-prev")).toBeDisabled();
    expect(screen.getByTestId("find-next")).toBeDisabled();
    expect(screen.getByTestId("replace-one")).toBeDisabled();
    expect(screen.getByTestId("replace-all")).toBeDisabled();

    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    fireEvent.keyDown(screen.getByTestId("replace-input"), { key: "Enter" });
    fireEvent.keyDown(screen.getByTestId("replace-input"), { key: "Enter", shiftKey: true });
    expect(stepFind).not.toHaveBeenCalled();
    expect(replaceActive).not.toHaveBeenCalled();
    expect(replaceAll).not.toHaveBeenCalled();
    expect(s.ytext.toString()).toBe(TEXT);

    fireEvent.change(input, { target: { value: "cat" } });
    await waitFor(() => expect(screen.queryByTestId("find-regex-error")).toBeNull());
    expect(input).toHaveAttribute("aria-invalid", "false");
    expect(input).not.toHaveAttribute("aria-describedby");
    expect(screen.getByTestId("find-count")).toHaveTextContent("1 of 2");
    expect(screen.getByTestId("find-prev")).toBeEnabled();
    expect(screen.getByTestId("find-next")).toBeEnabled();
    expect(screen.getByTestId("replace-one")).toBeEnabled();
    expect(screen.getByTestId("replace-all")).toBeEnabled();
  });

  it("clears the error when regex mode is turned off and does not reject an empty query", async () => {
    const s = session("owner");
    renderBar(s, false);

    fireEvent.click(screen.getByTestId("find-regex"));
    const input = screen.getByTestId("find-input");
    fireEvent.change(input, { target: { value: "(" } });
    expect(await screen.findByTestId("find-regex-error")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("find-regex"));
    await waitFor(() => expect(screen.queryByTestId("find-regex-error")).toBeNull());
    expect(input).toHaveAttribute("aria-invalid", "false");
    expect(screen.getByTestId("find-count")).toHaveTextContent("0 of 0");

    fireEvent.click(screen.getByTestId("find-regex"));
    fireEvent.change(input, { target: { value: "" } });
    await waitFor(() => expect(screen.queryByTestId("find-regex-error")).toBeNull());
    expect(input).toHaveAttribute("aria-invalid", "false");
    expect(screen.getByTestId("find-count")).toHaveTextContent("");
  });
});
