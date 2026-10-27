// @vitest-environment jsdom
import { useState, type ComponentProps } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { TooltipProvider } from "@/components/ui/primitives";
import type { Layout } from "@/lib/viewport";
import type { DocumentDto } from "@/server/dto";

vi.mock("@hocuspocus/provider", async () => {
  const { Awareness } = await import("y-protocols/awareness");
  return {
    HocuspocusProvider: class {
      awareness: InstanceType<typeof Awareness>;
      constructor(opts: { document: Y.Doc }) {
        this.awareness = new Awareness(opts.document);
      }
      destroy() {
        this.awareness.destroy();
      }
    },
  };
});

import { CollabSession } from "@/editor/collab/session";
import { makeCollabUser } from "@/editor/collab/shared";
import { Header, LayoutSegment, TitleEditor } from "./header";

type HeaderProps = ComponentProps<typeof Header>;

const DOC: DocumentDto = {
  id: "real-input-doc",
  title: "Plan",
  storage: "local",
  linkAccess: "private",
  linkPreview: false,
  ownerId: "owner-1",
  gistId: null,
  gistFile: null,
  repoOwner: null,
  repoName: null,
  repoBranch: null,
  repoPath: null,
  publishedAt: null,
  hasUnpublishedChanges: false,
  githubUrl: null,
  createdAt: "2026-09-08T00:00:00.000Z",
  updatedAt: "2026-09-08T00:00:00.000Z",
};

const sessions: CollabSession[] = [];

function createSession(role: CollabSession["role"] = "owner") {
  const session = new CollabSession({
    docId: DOC.id,
    user: makeCollabUser("owner-1", "Owner One", null, null),
    role,
    autoConnect: false,
    getToken: async () => {
      throw new Error("No provider connection permitted");
    },
  });
  session.keepAlive();
  session.localLoaded = true;
  session.synced = true;
  sessions.push(session);
  return session;
}

function headerProps(session: CollabSession, overrides: Partial<HeaderProps> = {}): HeaderProps {
  return {
    session,
    doc: DOC,
    commentsOpen: false,
    onToggleComments: vi.fn(),
    onOpenNotification: vi.fn(),
    onShare: vi.fn(),
    onPublish: vi.fn(),
    onPublishNow: vi.fn(),
    onPull: vi.fn(),
    onSync: vi.fn(),
    sync: null,
    onHistory: vi.fn(),
    onMoreMenuOpen: vi.fn(),
    onActivity: vi.fn(),
    onShortcuts: vi.fn(),
    onDelete: vi.fn(),
    onDuplicate: vi.fn(),
    onDownload: vi.fn(),
    onCopyMarkdown: vi.fn(),
    onNameVersion: vi.fn(),
    documentMutation: null,
    publishing: false,
    isOwner: true,
    githubConfigured: true,
    onHome: vi.fn(),
    layout: "rich",
    onLayout: vi.fn(),
    onOutline: vi.fn(),
    compact: false,
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  for (const session of sessions.splice(0)) session.destroy();
  vi.restoreAllMocks();
});

describe("TitleEditor with real input", () => {
  it("renames with a click, typing, and Enter, committing the trimmed title once", () => {
    const session = createSession();
    const setTitle = vi.spyOn(session, "setTitle");
    render(<TitleEditor session={session} fallback="Plan" />);

    fireEvent.click(screen.getByTestId("title"));
    const input = screen.getByTestId("title-input") as HTMLInputElement;
    expect(input).toHaveFocus();
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe("Plan".length);

    fireEvent.change(input, { target: { value: "  Roadmap  " } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.blur(input);

    expect(setTitle).toHaveBeenCalledTimes(1);
    expect(setTitle).toHaveBeenCalledWith("Roadmap");
    expect(screen.queryByTestId("title-input")).toBeNull();
  });

  it("cancels with Escape and ignores blank or unchanged drafts", () => {
    const session = createSession();
    const setTitle = vi.spyOn(session, "setTitle");
    render(<TitleEditor session={session} fallback="Plan" />);

    fireEvent.click(screen.getByTestId("title"));
    fireEvent.change(screen.getByTestId("title-input"), { target: { value: "Other" } });
    fireEvent.keyDown(screen.getByTestId("title-input"), { key: "Escape" });
    expect(screen.queryByTestId("title-input")).toBeNull();

    fireEvent.click(screen.getByTestId("title"));
    fireEvent.change(screen.getByTestId("title-input"), { target: { value: "   " } });
    fireEvent.blur(screen.getByTestId("title-input"));

    fireEvent.click(screen.getByTestId("title"));
    fireEvent.blur(screen.getByTestId("title-input"));

    expect(setTitle).not.toHaveBeenCalled();
  });

  it("does not open for read-only sessions and closes when the session is replaced", () => {
    const viewer = createSession("viewer");
    const { rerender } = render(<TitleEditor session={viewer} fallback="Plan" />);
    fireEvent.click(screen.getByTestId("title"));
    expect(screen.queryByTestId("title-input")).toBeNull();

    const first = createSession();
    rerender(<TitleEditor session={first} fallback="Plan" />);
    fireEvent.click(screen.getByTestId("title"));
    expect(screen.getByTestId("title-input")).toBeInTheDocument();

    const second = createSession();
    const setTitle = vi.spyOn(second, "setTitle");
    rerender(<TitleEditor session={second} fallback="Plan" />);
    expect(screen.queryByTestId("title-input")).toBeNull();
    expect(setTitle).not.toHaveBeenCalled();
  });
});

describe("LayoutSegment with real input", () => {
  function Harness({ onLayout }: { onLayout: (layout: Layout) => void }) {
    const [layout, setLayout] = useState<Layout>("rich");
    return (
      <LayoutSegment
        layout={layout}
        onLayout={(next) => {
          onLayout(next);
          setLayout(next);
        }}
      />
    );
  }

  it("switches panes with clicks and arrow, Home, and End keys, moving focus with the selection", async () => {
    const user = userEvent.setup();
    const onLayout = vi.fn();
    render(<Harness onLayout={onLayout} />);
    const preview = screen.getByRole("radio", { name: "Preview" });
    const markdown = screen.getByRole("radio", { name: "Markdown" });
    expect(preview).toHaveAttribute("tabindex", "0");
    expect(markdown).toHaveAttribute("tabindex", "-1");

    await user.click(markdown);
    expect(onLayout).toHaveBeenLastCalledWith("code");
    expect(markdown).toHaveAttribute("aria-checked", "true");

    await user.keyboard("{ArrowRight}");
    expect(onLayout).toHaveBeenLastCalledWith("rich");
    expect(preview).toHaveFocus();

    await user.keyboard("{End}");
    expect(onLayout).toHaveBeenLastCalledWith("code");
    expect(markdown).toHaveFocus();

    onLayout.mockClear();
    await user.keyboard("{End}");
    expect(onLayout).not.toHaveBeenCalled();
    await user.keyboard("{Home}");
    expect(onLayout).toHaveBeenCalledExactlyOnceWith("rich");
    expect(preview).toHaveFocus();
  });
});

describe("Header menus with real input", () => {
  function renderHeader(props: HeaderProps) {
    return render(
      <TooltipProvider>
        <Header {...props} />
      </TooltipProvider>,
    );
  }

  it("opens the More menu with a click, runs an item once, and returns focus to the trigger", async () => {
    const user = userEvent.setup();
    const props = headerProps(createSession());
    renderHeader(props);

    await user.click(screen.getByTestId("more-menu"));
    expect(props.onMoreMenuOpen).toHaveBeenCalledTimes(1);
    await user.click(await screen.findByTestId("menu-history"));

    expect(props.onHistory).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    await waitFor(() => expect(screen.getByTestId("more-menu")).toHaveFocus());
  });

  it("keeps permission and in-flight rules on More menu items", async () => {
    const user = userEvent.setup();
    const props = headerProps(createSession("viewer"), { isOwner: false, documentMutation: "duplicate" });
    renderHeader(props);

    await user.click(screen.getByTestId("more-menu"));
    expect(await screen.findByTestId("menu-history")).toBeInTheDocument();
    expect(screen.queryByTestId("menu-delete")).toBeNull();
    expect(screen.queryByRole("menuitem", { name: "Name current version" })).toBeNull();
    const duplicate = screen.getByTestId("menu-duplicate");
    expect(duplicate).toHaveAttribute("aria-disabled", "true");
    await user.click(duplicate);
    expect(props.onDuplicate).not.toHaveBeenCalled();

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(screen.getByTestId("more-menu")).toHaveFocus();
  });

  it("opens Publish options on ArrowUp at the last enabled item and runs it with Enter", async () => {
    const user = userEvent.setup();
    const props = headerProps(createSession());
    renderHeader(props);

    act(() => screen.getByTestId("publish-menu").focus());
    await user.keyboard("{ArrowUp}");
    const share = await screen.findByRole("menuitem", { name: "Share link…" });
    await waitFor(() => expect(share).toHaveFocus());

    await user.keyboard("{Enter}");
    expect(props.onShare).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  });
});
