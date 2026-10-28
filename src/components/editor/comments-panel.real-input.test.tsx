// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("@hocuspocus/provider", async () => {
  const { Awareness } = await import("y-protocols/awareness");
  class HocuspocusProvider {
    awareness: InstanceType<typeof Awareness>;
    constructor(readonly opts: { document: import("yjs").Doc }) {
      this.awareness = new Awareness(opts.document);
    }
    destroy() {
      this.awareness.destroy();
    }
  }
  return { HocuspocusProvider };
});

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    api: {
      documents: {
        collaborators: vi.fn().mockResolvedValue({ owner: null, collaborators: [], agents: [] }),
        reviews: vi.fn().mockResolvedValue({ reviews: [] }),
        comment: vi.fn().mockResolvedValue({ id: "via-api" }),
        createRequest: vi.fn().mockResolvedValue({ request: { id: "req" } }),
      },
      tokens: { list: vi.fn().mockResolvedValue({ tokens: [] }) },
    },
  };
});

vi.mock("@/lib/notifications-store", () => ({
  markRefsRead: vi.fn(),
  useUnreadRefs: () => new Set<string>(),
}));

import { CollabSession as BaseCollabSession } from "@/editor/collab/session";
import { makeCollabUser } from "@/editor/collab/shared";
import { api } from "@/lib/api";
import type { ReviewDto } from "@/server/reviews";
import { TooltipProvider } from "@/components/ui/primitives";
import { CommentsPanel } from "./comments-panel";

class CollabSession extends BaseCollabSession {
  override get contentReady() {
    return true;
  }
}

type CollaboratorsResponse = Awaited<ReturnType<typeof api.documents.collaborators>>;

const TEXT = "The quick brown fox jumps over the lazy dog.";
const AGENT = {
  name: "Copilot CLI",
  login: "alice/Copilot-CLI",
  ownerLogin: "alice",
  ownerName: "Alice",
  present: false,
  collaboratorsMayAsk: false,
};

let session: CollabSession | null = null;

Element.prototype.scrollIntoView ??= () => {};

afterEach(() => {
  cleanup();
  session?.destroy();
  session = null;
  vi.restoreAllMocks();
});

function mount(opts: { agents?: boolean } = {}) {
  const user = makeCollabUser("alice", "Alice", null, "alice");
  session = new CollabSession({ docId: "real-input", user, role: "owner", getToken: async () => "token", autoConnect: false });
  session.keepAlive();
  session.synced = true;
  session.ytext.insert(0, TEXT);
  vi.mocked(api.documents.collaborators).mockResolvedValue({
    owner: { login: "alice", name: "Alice", image: null },
    collaborators: opts.agents ? [{ login: "bob", name: "Bob", image: null }] : [],
    agents: opts.agents ? [AGENT] : [],
  } as unknown as CollaboratorsResponse);
  vi.mocked(api.documents.reviews).mockResolvedValue({ reviews: [] } as Awaited<ReturnType<typeof api.documents.reviews>>);
  const s = session;
  const view = render(
    <TooltipProvider>
      <CommentsPanel session={s} onClose={() => {}} onReveal={() => {}} onToast={() => {}} />
    </TooltipProvider>,
  );
  return { session: s, user, view };
}

function addThread(s: CollabSession, body = "Looks off.") {
  return s.comments.add({ from: 4, to: 9, body, author: makeCollabUser("bob", "Bob") });
}

describe("CommentsPanel real input", () => {
  it("resolves a thread with a real click", async () => {
    const { session: s } = mount();
    let id = "";
    act(() => {
      id = addThread(s);
    });
    const resolve = await screen.findByTestId("comment-resolve");
    await userEvent.click(resolve);
    await waitFor(() => expect(s.comments.list().find((t) => t.id === id)?.resolved).toBe(true));
  });

  it("opens the reaction picker, moves focus with arrows, and toggles a reaction with Enter", async () => {
    const { session: s } = mount();
    act(() => {
      addThread(s);
    });
    const add = await screen.findByTestId("reaction-add");
    await userEvent.hover(add);
    await waitFor(() => expect(screen.getByTestId("reaction-add")).toHaveAttribute("data-state", "closed"));
    await userEvent.click(screen.getByTestId("reaction-add"));
    const options = await waitFor(() => {
      const found = [...document.querySelectorAll<HTMLButtonElement>("[data-testid='reaction-option']")];
      expect(found.length).toBeGreaterThan(2);
      return found;
    });
    act(() => options[0].focus());
    await userEvent.keyboard("{ArrowRight}");
    expect(document.activeElement).toBe(options[1]);
    await userEvent.keyboard("{ArrowLeft}{ArrowLeft}");
    expect(document.activeElement).toBe(options[options.length - 1]);
    await userEvent.keyboard("{Home}");
    expect(document.activeElement).toBe(options[0]);
    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(screen.getAllByTestId("reaction-chip")).toHaveLength(1));
    await userEvent.click(screen.getByTestId("reaction-chip"));
    await waitFor(() => expect(screen.queryAllByTestId("reaction-chip")).toHaveLength(0));
  });

  it("opens the comment menu on the first item with ArrowDown and the last with ArrowUp, and deletes", async () => {
    const { session: s, user } = mount();
    act(() => {
      s.comments.add({ from: 4, to: 9, body: "Mine.", author: user });
    });
    const trigger = await screen.findByRole("button", { name: "Comment actions" });
    act(() => trigger.focus());
    await userEvent.keyboard("{ArrowDown}");
    const menuItems = () => [...document.querySelectorAll<HTMLElement>("[role='menuitem']")];
    let items = await waitFor(() => {
      expect(menuItems().length).toBeGreaterThan(1);
      return menuItems();
    });
    expect(document.activeElement).toBe(items[0]);
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(menuItems()).toHaveLength(0));
    act(() => trigger.focus());
    await userEvent.keyboard("{ArrowUp}");
    items = await waitFor(() => {
      expect(menuItems().length).toBeGreaterThan(1);
      return menuItems();
    });
    expect(document.activeElement).toBe(items[items.length - 1]);
    await userEvent.click(items.find((item) => /Delete/.test(item.textContent ?? ""))!);
    const confirm = screen.queryByRole("button", { name: /^Delete/ });
    if (confirm) await userEvent.click(confirm);
    await waitFor(() => expect(s.comments.list()).toHaveLength(0));
  });

  it("submits a new comment with Enter and keeps Shift+Enter as a newline", async () => {
    const { session: s } = mount();
    act(() => s.setPendingComment({ from: 4, to: 9 }));
    const box = await screen.findByTestId("comment-composer");
    await userEvent.click(box);
    await userEvent.keyboard("First{Shift>}{Enter}{/Shift}second");
    expect(s.comments.list()).toHaveLength(0);
    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(s.comments.list()).toHaveLength(1));
    expect(s.comments.list()[0].body).toBe("First\nsecond");
  });

  it("moves the mention highlight with arrows and picks with Enter", async () => {
    const { session: s } = mount({ agents: true });
    act(() => s.setPendingComment({ from: 4, to: 9 }));
    const box = await screen.findByTestId<HTMLTextAreaElement>("comment-composer");
    await waitFor(() => expect(api.documents.collaborators).toHaveBeenCalled());
    await userEvent.click(box);
    await userEvent.keyboard("@");
    const list = await screen.findByRole("listbox", { name: "Mention someone" });
    const options = await within(list).findAllByRole("option");
    expect(options.length).toBeGreaterThan(1);
    const selected = () => within(list).getAllByRole("option").findIndex((o) => o.getAttribute("aria-selected") === "true");
    expect(selected()).toBe(0);
    await userEvent.keyboard("{ArrowDown}");
    expect(selected()).toBe(1);
    await userEvent.keyboard("{ArrowUp}{ArrowUp}");
    expect(selected()).toBe(options.length - 1);
    await userEvent.keyboard("{Home}");
    expect(selected()).toBe(0);
    const label = options[0].textContent ?? "";
    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(screen.queryByRole("listbox", { name: "Mention someone" })).toBeNull());
    expect(box.value.startsWith("@")).toBe(true);
    expect(box.value.length).toBeGreaterThan(1);
    expect(label.length).toBeGreaterThan(0);
  });

  it("moves the request mode with arrow keys", async () => {
    const { session: s } = mount({ agents: true });
    act(() => s.setPendingComment({ from: 4, to: 9 }));
    const box = await screen.findByTestId<HTMLTextAreaElement>("comment-composer");
    await waitFor(() => expect(api.documents.collaborators).toHaveBeenCalled());
    fireEvent.change(box, { target: { value: "@alice/Copilot-CLI tighten this" } });
    const row = await screen.findByTestId("composer-agent-row");
    const radios = within(row).getAllByRole("radio");
    const checked = () => radios.findIndex((r) => r.getAttribute("aria-checked") === "true");
    const start = checked();
    act(() => radios[start].focus());
    await userEvent.keyboard("{ArrowRight}");
    const next = (start + 1) % radios.length;
    expect(document.activeElement).toBe(radios[next]);
    expect(checked()).toBe(next);
    await userEvent.keyboard("{ArrowLeft}");
    expect(checked()).toBe(start);
    await userEvent.keyboard("{End}");
    expect(checked()).toBe(radios.length - 1);
    await userEvent.keyboard("{Home}");
    expect(checked()).toBe(0);
  });

  it("accepts and rejects a whole review with real clicks", async () => {
    const { session: s } = mount();
    const agent = makeCollabUser("agent:alice:Copilot", "Copilot");
    const suggest = (quote: string, proposed: string) =>
      s.comments.add({ from: TEXT.indexOf(quote), to: TEXT.indexOf(quote) + quote.length, body: `Tighter.\n\n\`\`\`suggestion\n${proposed}\n\`\`\``, author: agent });
    let accepted: string[] = [];
    let rejected: string[] = [];
    act(() => {
      accepted = [suggest("quick", "fast"), suggest("brown", "red")];
      rejected = [suggest("lazy", "sleepy")];
    });
    const dto = (id: string, threadIds: string[]): ReviewDto => ({
      id,
      documentId: "real-input",
      authorId: "alice",
      authorName: "Copilot",
      collabAuthorId: "agent:alice:Copilot",
      agent: "Copilot",
      verdict: "request_changes",
      summary: `Review ${id}.`,
      threadIds,
      createdAt: new Date().toISOString(),
    });
    vi.mocked(api.documents.reviews).mockResolvedValue({ reviews: [dto("r-accept", accepted), dto("r-reject", rejected)] } as Awaited<ReturnType<typeof api.documents.reviews>>);
    cleanup();
    render(
      <TooltipProvider>
        <CommentsPanel session={s} onClose={() => {}} onReveal={() => {}} onToast={() => {}} />
      </TooltipProvider>,
    );
    const card = (id: string) => screen.getAllByTestId("review-card").find((c) => c.getAttribute("data-review-id") === id)!;
    await waitFor(() => expect(screen.getAllByTestId("review-card")).toHaveLength(2));
    await userEvent.click(within(card("r-accept")).getByTestId("review-accept-all"));
    await waitFor(() => expect(s.ytext.toString()).toBe("The fast red fox jumps over the lazy dog."));
    await userEvent.click(within(card("r-reject")).getByTestId("review-reject-all"));
    await waitFor(() =>
      expect(s.comments.list().find((t) => t.id === rejected[0])?.suggestionState).toBe("rejected"),
    );
    expect(s.ytext.toString()).toBe("The fast red fox jumps over the lazy dog.");
  });
});
