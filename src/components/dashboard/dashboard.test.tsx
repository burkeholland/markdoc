// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { startTransition, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DocumentSummaryDto, SearchResultDto } from "@/lib/api";

type SearchResponse = { query: string; documents: SearchResultDto[] };
type ListOptions = { starred?: boolean; trash?: boolean };
type ListResponse = { documents: DocumentSummaryDto[] };
type CreateResponse = { document: { id: string; title: string } };
const searchDocuments = vi.fn<(query: string, init?: RequestInit) => Promise<SearchResponse>>();
const listDocuments = vi.fn<(options?: ListOptions) => Promise<ListResponse>>();
const createDocument = vi.fn<(body?: { template?: string }) => Promise<CreateResponse>>();
const restoreDocument = vi.fn<(id: string) => Promise<{ ok: true }>>();
const purgeDocument = vi.fn<(id: string, options?: { permanent?: boolean }) => Promise<{ ok: true; permanent: boolean }>>();
const starDocument = vi.fn<(id: string) => Promise<{ starred: true }>>();
const unstarDocument = vi.fn<(id: string) => Promise<{ starred: false }>>();
const router = { push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn(), back: vi.fn(), forward: vi.fn() };

vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("@/components/dashboard/notifications-strip", () => ({ NotificationsStrip: () => null }));
vi.mock("@/components/ui/theme-toggle", () => ({ ThemeToggle: () => null }));
vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      documents: {
        ...actual.api.documents,
        search: (query: string, init?: RequestInit) => searchDocuments(query, init),
        list: (options?: ListOptions) => listDocuments(options),
        create: (body?: { template?: string }) => createDocument(body),
        restore: (id: string) => restoreDocument(id),
        delete: (id: string, options?: { permanent?: boolean }) => purgeDocument(id, options),
        star: (id: string) => starDocument(id),
        unstar: (id: string) => unstarDocument(id),
      },
    },
  };
});

import { ApiError } from "@/lib/api";
import { Dashboard } from "./dashboard";

const SEARCH_DEBOUNCE_MS = 250;
const USER = { id: "owner", name: "Owner", login: "owner", image: null };

function doc(id: string, title: string, excerpt = ""): DocumentSummaryDto {
  return {
    id,
    title,
    excerpt,
    storage: "local",
    updatedAt: "2026-09-07T12:00:00.000Z",
    createdAt: "2026-09-01T12:00:00.000Z",
    lastOpenedAt: null,
    deletedAt: null,
    ownerId: USER.id,
    ownerName: USER.name,
    ownerLogin: USER.login,
    role: "owner",
    repoOwner: null,
    repoName: null,
    repoPath: null,
    gistId: null,
    starred: false,
  };
}

function result(id: string, title: string, snippet: string | null): SearchResultDto {
  return { ...doc(id, title), snippet };
}

function trashedDoc(id: string, title: string): DocumentSummaryDto {
  return { ...doc(id, title), deletedAt: "2026-09-07T13:00:00.000Z" };
}

const DOCUMENTS = [
  doc("alpha-title", "Alpha planning", "Safe title match"),
  doc("notes", "Meeting notes", "An ordinary excerpt"),
];

function renderDashboard(children?: React.ReactNode, documents = DOCUMENTS) {
  return render(
    <>
      <Dashboard user={USER} documents={documents} githubAvailable githubConfigured />
      {children}
    </>,
  );
}

function TransitionUnmount({ children }: { children: React.ReactNode }) {
  const [mounted, setMounted] = useState(true);
  return (
    <>
      <button type="button" data-testid="unmount-dashboard" onClick={() => startTransition(() => setMounted(false))}>
        Unmount dashboard
      </button>
      {mounted ? children : null}
    </>
  );
}

function openTrash() {
  fireEvent.click(screen.getByTestId("filter-trash"));
}

function leaveTrash() {
  fireEvent.click(screen.getByTestId("filter-all"));
}

function trashButton(title: string, action: "restore-button" | "purge-button") {
  return within(screen.getByText(title).closest('[data-testid="trash-card"]')!).getByTestId(action);
}

async function settleSearch() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function documentStar(title: string) {
  const list = screen.getByTestId("document-list");
  const link = within(list).getByRole("link", { name: new RegExp(title) });
  return within(link.closest("li")!).getByTestId("star-toggle");
}

beforeEach(() => {
  vi.useFakeTimers();
  Object.defineProperty(Element.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
  searchDocuments.mockReset();
  searchDocuments.mockImplementation(async (query) => ({ query, documents: [] }));
  listDocuments.mockReset();
  listDocuments.mockResolvedValue({ documents: [] });
  createDocument.mockReset();
  createDocument.mockResolvedValue({ document: { id: "created", title: "Untitled" } });
  restoreDocument.mockReset();
  restoreDocument.mockResolvedValue({ ok: true });
  purgeDocument.mockReset();
  purgeDocument.mockResolvedValue({ ok: true, permanent: true });
  starDocument.mockReset();
  starDocument.mockResolvedValue({ starred: true });
  unstarDocument.mockReset();
  unstarDocument.mockResolvedValue({ starred: false });
  router.push.mockReset();
  router.replace.mockReset();
  router.refresh.mockReset();
  router.prefetch.mockReset();
  router.back.mockReset();
  router.forward.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("dashboard search shortcut", () => {
  it("has an explicit name and compact hint, then focuses and selects the query once for /", () => {
    renderDashboard(<button type="button">Outside search</button>);
    const search = screen.getByRole("textbox", { name: "Search documents" }) as HTMLInputElement;
    expect(screen.getByText("/", { selector: "kbd" })).toBeInTheDocument();
    fireEvent.change(search, { target: { value: "alpha" } });
    screen.getByRole("button", { name: "Outside search" }).focus();
    const focus = vi.spyOn(search, "focus");
    const select = vi.spyOn(search, "select");

    expect(fireEvent.keyDown(screen.getByRole("button", { name: "Outside search" }), { key: "/" })).toBe(false);

    expect(search).toHaveFocus();
    expect(search.selectionStart).toBe(0);
    expect(search.selectionEnd).toBe(5);
    expect(focus).toHaveBeenCalledTimes(1);
    expect(select).toHaveBeenCalledTimes(1);
  });

  it("does not claim / from typing controls, editable content, dialogs, the palette, or modifier shortcuts", () => {
    renderDashboard(
      <div>
        <input aria-label="Other input" />
        <textarea aria-label="Other textarea" />
        <select aria-label="Other select"><option>One</option></select>
        <div contentEditable tabIndex={0}>Editable content</div>
        <dialog open><button type="button">Dialog control</button></dialog>
        <div data-testid="command-palette"><button type="button">Palette control</button></div>
        <button type="button">Outside search</button>
      </div>,
    );
    const search = screen.getByRole("textbox", { name: "Search documents" });
    const contexts = [
      screen.getByRole("textbox", { name: "Other input" }),
      screen.getByRole("textbox", { name: "Other textarea" }),
      screen.getByRole("combobox", { name: "Other select" }),
      screen.getByText("Editable content"),
      screen.getByRole("button", { name: "Dialog control" }),
      screen.getByRole("button", { name: "Palette control" }),
    ];
    for (const target of contexts) {
      target.focus();
      expect(fireEvent.keyDown(target, { key: "/" })).toBe(true);
      expect(search).not.toHaveFocus();
      expect(target).toHaveFocus();
    }

    const outside = screen.getByRole("button", { name: "Outside search" });
    for (const modifier of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }]) {
      outside.focus();
      expect(fireEvent.keyDown(outside, { key: "/", ...modifier })).toBe(true);
      expect(search).not.toHaveFocus();
    }
  });
});

describe("dashboard content-search recovery", () => {
  it("keeps title matches, announces the server reason with Retry, and clears the obsolete error on a changed query", async () => {
    searchDocuments.mockRejectedValueOnce(new ApiError(503, "Search service unavailable"));
    renderDashboard();
    const search = screen.getByRole("textbox", { name: "Search documents" });
    fireEvent.change(search, { target: { value: "alpha" } });
    await settleSearch();

    const alert = screen.getByRole("alert");
    expect(alert).toHaveAttribute("aria-atomic", "true");
    expect(alert).toHaveTextContent("Content search failed: Search service unavailable. Showing title matches only.");
    expect(within(alert).getByRole("button", { name: "Retry" })).toBeEnabled();
    expect(screen.getByRole("link", { name: /Alpha planning/ })).toBeInTheDocument();
    expect(screen.queryByText('No matches for "alpha"')).toBeNull();

    fireEvent.change(search, { target: { value: "notes" } });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("issues one request for the exact current query and clears the alert only after a successful retry", async () => {
    const retry = deferred<SearchResponse>();
    searchDocuments
      .mockRejectedValueOnce(new ApiError(503, "Search service unavailable"))
      .mockReturnValueOnce(retry.promise);
    renderDashboard();
    const search = screen.getByRole("textbox", { name: "Search documents" });
    fireEvent.change(search, { target: { value: "alpha" } });
    await settleSearch();
    const alert = screen.getByRole("alert");

    fireEvent.click(within(alert).getByRole("button", { name: "Retry" }));

    expect(searchDocuments).toHaveBeenCalledTimes(2);
    expect(searchDocuments.mock.calls[1][0]).toBe("alpha");
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(within(screen.getByRole("alert")).getByRole("button", { name: "Retrying…" })).toBeDisabled();

    await act(async () => {
      retry.resolve({ query: "alpha", documents: [result("content-match", "Roadmap", "Body contains alpha milestones")] });
      await retry.promise;
    });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("link", { name: /Roadmap/ })).toBeInTheDocument();
    expect(screen.getByTestId("search-snippet")).toHaveTextContent("Body contains alpha milestones");
  });

  it("aborts superseded requests and ignores their late results and errors", async () => {
    const requests = new Map<string, ReturnType<typeof deferred<SearchResponse>>>();
    searchDocuments.mockImplementation((query) => {
      const request = deferred<SearchResponse>();
      requests.set(query, request);
      return request.promise;
    });
    renderDashboard();
    const search = screen.getByRole("textbox", { name: "Search documents" });

    fireEvent.change(search, { target: { value: "alpha" } });
    await settleSearch();
    fireEvent.change(search, { target: { value: "beta" } });
    expect(searchDocuments.mock.calls[0][1]?.signal?.aborted).toBe(true);
    await settleSearch();
    fireEvent.change(search, { target: { value: "gamma" } });
    expect(searchDocuments.mock.calls[1][1]?.signal?.aborted).toBe(true);
    await settleSearch();

    await act(async () => {
      requests.get("gamma")!.resolve({ query: "gamma", documents: [result("gamma", "Gamma result", "Current gamma content")] });
      await requests.get("gamma")!.promise;
    });
    await act(async () => {
      requests.get("alpha")!.resolve({ query: "alpha", documents: [result("stale", "Stale alpha result", "Old content")] });
      requests.get("beta")!.reject(new Error("Stale beta failure"));
      await Promise.allSettled([requests.get("alpha")!.promise, requests.get("beta")!.promise]);
    });

    expect(searchDocuments).toHaveBeenCalledTimes(3);
    expect(screen.getByRole("link", { name: /Gamma result/ })).toBeInTheDocument();
    expect(screen.queryByText(/Stale alpha result/)).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("dashboard create ownership", () => {
  it("gives immediate blank, welcome, template, and palette activations one request and one navigation", async () => {
    const pending = deferred<CreateResponse>();
    createDocument.mockReturnValueOnce(pending.promise);
    renderDashboard(undefined, []);
    const blank = screen.getByTestId("new-document");
    const welcome = screen.getByTestId("start-guided-doc");
    const template = screen.getByTestId("template-meeting-notes");

    act(() => {
      blank.click();
      welcome.click();
      template.click();
    });

    expect(createDocument).toHaveBeenCalledTimes(1);
    expect(createDocument).toHaveBeenLastCalledWith({});
    expect(blank).toBeDisabled();
    expect(welcome).toBeDisabled();
    expect(template).toBeDisabled();

    fireEvent.keyDown(window, { key: "p", ctrlKey: true, shiftKey: true });
    fireEvent.click(screen.getByTestId("palette-item-dash:new"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(createDocument).toHaveBeenCalledTimes(1);

    await act(async () => {
      pending.resolve({ document: { id: "one-created", title: "Untitled" } });
      await pending.promise;
    });

    expect(router.push).toHaveBeenCalledTimes(1);
    expect(router.push).toHaveBeenLastCalledWith("/d/one-created");
    expect(blank).toBeEnabled();
  });

  it("shows the current failure, restores every control, and retries to one navigation", async () => {
    const failed = deferred<CreateResponse>();
    const retry = deferred<CreateResponse>();
    createDocument.mockReturnValueOnce(failed.promise).mockReturnValueOnce(retry.promise);
    renderDashboard(undefined, []);

    fireEvent.click(screen.getByTestId("start-guided-doc"));
    expect(createDocument).toHaveBeenLastCalledWith({ template: "welcome" });
    await act(async () => {
      failed.reject(new ApiError(503, "Create service unavailable"));
      await Promise.allSettled([failed.promise]);
    });

    expect(screen.getByTestId("toast")).toHaveAttribute("data-kind", "error");
    expect(screen.getByTestId("toast")).toHaveTextContent("Create service unavailable");
    expect(screen.getByTestId("new-document")).toBeEnabled();
    expect(screen.getByTestId("start-guided-doc")).toBeEnabled();
    expect(screen.getByTestId("template-meeting-notes")).toBeEnabled();

    const retryButton = screen.getByTestId("template-meeting-notes");
    act(() => {
      retryButton.click();
      screen.getByTestId("new-document").click();
    });
    expect(createDocument).toHaveBeenCalledTimes(2);
    expect(createDocument).toHaveBeenLastCalledWith({ template: "meeting-notes" });

    await act(async () => {
      retry.resolve({ document: { id: "retry-created", title: "Meeting notes" } });
      await retry.promise;
    });

    expect(router.push).toHaveBeenCalledTimes(1);
    expect(router.push).toHaveBeenLastCalledWith("/d/retry-created");
    expect(console.error).toHaveBeenCalledTimes(1);
  });

  it("lets a replacement dashboard create while the old success and finalizer stay inert", async () => {
    const stale = deferred<CreateResponse>();
    const current = deferred<CreateResponse>();
    createDocument.mockReturnValueOnce(stale.promise).mockReturnValueOnce(current.promise);
    const view = render(<Dashboard user={USER} documents={DOCUMENTS} githubAvailable githubConfigured />);
    fireEvent.click(screen.getByTestId("new-document"));

    const replacementUser = { ...USER, id: "replacement-owner", login: "replacement-owner" };
    view.rerender(<Dashboard user={replacementUser} documents={DOCUMENTS} githubAvailable githubConfigured />);
    fireEvent.click(screen.getByTestId("new-document"));
    expect(createDocument).toHaveBeenCalledTimes(2);

    await act(async () => {
      stale.resolve({ document: { id: "stale-created", title: "Stale" } });
      await stale.promise;
    });
    expect(router.push).not.toHaveBeenCalled();
    expect(screen.getByTestId("new-document")).toBeDisabled();

    await act(async () => {
      current.resolve({ document: { id: "current-created", title: "Current" } });
      await current.promise;
    });
    expect(router.push).toHaveBeenCalledTimes(1);
    expect(router.push).toHaveBeenLastCalledWith("/d/current-created");
  });
});

describe("dashboard star recovery", () => {
  it("optimistically stars and unstars, disables the document while pending, and commits each response", async () => {
    const starring = deferred<{ starred: true }>();
    const unstarring = deferred<{ starred: false }>();
    starDocument.mockReturnValueOnce(starring.promise);
    unstarDocument.mockReturnValueOnce(unstarring.promise);
    renderDashboard();

    fireEvent.click(documentStar("Alpha planning"));

    expect(starDocument).toHaveBeenCalledOnce();
    expect(starDocument).toHaveBeenCalledWith("alpha-title");
    expect(documentStar("Alpha planning")).toHaveAttribute("aria-pressed", "true");
    expect(documentStar("Alpha planning")).toBeDisabled();
    expect(documentStar("Meeting notes")).toBeEnabled();

    await act(async () => {
      starring.resolve({ starred: true });
      await starring.promise;
    });
    expect(documentStar("Alpha planning")).toHaveAttribute("aria-pressed", "true");
    expect(documentStar("Alpha planning")).toBeEnabled();

    fireEvent.click(documentStar("Alpha planning"));

    expect(unstarDocument).toHaveBeenCalledOnce();
    expect(unstarDocument).toHaveBeenCalledWith("alpha-title");
    expect(documentStar("Alpha planning")).toHaveAttribute("aria-pressed", "false");
    expect(documentStar("Alpha planning")).toBeDisabled();

    await act(async () => {
      unstarring.resolve({ starred: false });
      await unstarring.promise;
    });
    expect(documentStar("Alpha planning")).toHaveAttribute("aria-pressed", "false");
    expect(documentStar("Alpha planning")).toBeEnabled();
  });

  it("suppresses synchronous duplicate activation across duplicate controls for one document", async () => {
    const pending = deferred<{ starred: false }>();
    unstarDocument.mockReturnValueOnce(pending.promise);
    renderDashboard(undefined, [{ ...doc("starred", "Starred document"), starred: true }]);
    const stripButton = within(screen.getByTestId("starred-strip")).getByRole("button", { name: "Unstar" });
    const listButton = documentStar("Starred document");

    act(() => {
      stripButton.click();
      listButton.click();
    });

    expect(unstarDocument).toHaveBeenCalledOnce();
    expect(unstarDocument).toHaveBeenCalledWith("starred");
    expect(starDocument).not.toHaveBeenCalled();
    expect(documentStar("Starred document")).toBeDisabled();

    await act(async () => {
      pending.resolve({ starred: false });
      await pending.promise;
    });
  });

  it("allows independent documents to mutate concurrently while keeping each document single-flight", async () => {
    const alpha = deferred<{ starred: true }>();
    const notes = deferred<{ starred: true }>();
    starDocument.mockReturnValueOnce(alpha.promise).mockReturnValueOnce(notes.promise);
    renderDashboard();

    fireEvent.click(documentStar("Alpha planning"));
    fireEvent.click(documentStar("Meeting notes"));

    expect(starDocument.mock.calls).toEqual([["alpha-title"], ["notes"]]);
    expect(documentStar("Alpha planning")).toBeDisabled();
    expect(documentStar("Meeting notes")).toBeDisabled();

    await act(async () => {
      alpha.resolve({ starred: true });
      await alpha.promise;
    });
    expect(documentStar("Alpha planning")).toBeEnabled();
    expect(documentStar("Meeting notes")).toBeDisabled();

    await act(async () => {
      notes.resolve({ starred: true });
      await notes.promise;
    });
    expect(documentStar("Meeting notes")).toBeEnabled();
  });

  it("rolls a failed toggle back with the API reason and retries the same action once", async () => {
    const first = deferred<{ starred: true }>();
    const retry = deferred<{ starred: true }>();
    starDocument.mockReturnValueOnce(first.promise).mockReturnValueOnce(retry.promise);
    renderDashboard();

    fireEvent.click(documentStar("Alpha planning"));
    expect(documentStar("Alpha planning")).toHaveAttribute("aria-pressed", "true");

    await act(async () => {
      first.reject(new ApiError(503, "Star service unavailable"));
      await Promise.allSettled([first.promise]);
    });

    expect(documentStar("Alpha planning")).toHaveAttribute("aria-pressed", "false");
    expect(documentStar("Alpha planning")).toBeEnabled();
    expect(screen.getByTestId("toast")).toHaveAttribute("data-kind", "error");
    expect(screen.getByTestId("toast")).toHaveTextContent("Star service unavailable");
    expect(console.error).not.toHaveBeenCalled();

    fireEvent.click(documentStar("Alpha planning"));

    expect(starDocument.mock.calls).toEqual([["alpha-title"], ["alpha-title"]]);
    expect(unstarDocument).not.toHaveBeenCalled();
    expect(documentStar("Alpha planning")).toHaveAttribute("aria-pressed", "true");
    expect(documentStar("Alpha planning")).toBeDisabled();

    await act(async () => {
      retry.resolve({ starred: true });
      await retry.promise;
    });
  });

  it("shares optimistic and pending state when a local match is replaced by the server result", async () => {
    const search = deferred<SearchResponse>();
    const starring = deferred<{ starred: true }>();
    searchDocuments.mockReturnValueOnce(search.promise);
    starDocument.mockReturnValueOnce(starring.promise);
    renderDashboard();
    const input = screen.getByRole("textbox", { name: "Search documents" });

    fireEvent.change(input, { target: { value: "alpha" } });
    fireEvent.click(documentStar("Alpha planning"));
    await settleSearch();

    await act(async () => {
      search.resolve({ query: "alpha", documents: [result("alpha-title", "Alpha planning", "Server alpha result")] });
      await search.promise;
    });

    expect(screen.getByTestId("search-snippet")).toHaveTextContent("Server alpha result");
    expect(documentStar("Alpha planning")).toHaveAttribute("aria-pressed", "true");
    expect(documentStar("Alpha planning")).toBeDisabled();
    fireEvent.click(documentStar("Alpha planning"));
    expect(starDocument).toHaveBeenCalledOnce();

    await act(async () => {
      starring.resolve({ starred: true });
      await starring.promise;
    });
    expect(documentStar("Alpha planning")).toBeEnabled();
  });

  it("isolates stale successes, errors, and finalizers after prop refresh removes and restores cards", async () => {
    const staleSuccess = deferred<{ starred: true }>();
    const staleError = deferred<{ starred: true }>();
    const currentAlpha = deferred<{ starred: true }>();
    const currentNotes = deferred<{ starred: true }>();
    starDocument
      .mockReturnValueOnce(staleSuccess.promise)
      .mockReturnValueOnce(staleError.promise)
      .mockReturnValueOnce(currentAlpha.promise)
      .mockReturnValueOnce(currentNotes.promise);
    const view = renderDashboard();

    fireEvent.click(documentStar("Alpha planning"));
    fireEvent.click(documentStar("Meeting notes"));
    view.rerender(<Dashboard user={USER} documents={[doc("alpha-title", "Alpha planning")]} githubAvailable githubConfigured />);
    expect(screen.queryByRole("link", { name: /Meeting notes/ })).toBeNull();
    view.rerender(<Dashboard user={USER} documents={DOCUMENTS.map((item) => ({ ...item }))} githubAvailable githubConfigured />);

    expect(documentStar("Alpha planning")).toHaveAttribute("aria-pressed", "false");
    expect(documentStar("Meeting notes")).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(documentStar("Alpha planning"));
    fireEvent.click(documentStar("Meeting notes"));

    await act(async () => {
      staleSuccess.resolve({ starred: true });
      staleError.reject(new ApiError(503, "Obsolete star failure"));
      await Promise.allSettled([staleSuccess.promise, staleError.promise]);
    });

    expect(documentStar("Alpha planning")).toHaveAttribute("aria-pressed", "true");
    expect(documentStar("Meeting notes")).toHaveAttribute("aria-pressed", "true");
    expect(documentStar("Alpha planning")).toBeDisabled();
    expect(documentStar("Meeting notes")).toBeDisabled();
    expect(screen.queryByText("Obsolete star failure")).toBeNull();
    expect(console.error).not.toHaveBeenCalled();

    await act(async () => {
      currentAlpha.resolve({ starred: true });
      currentNotes.resolve({ starred: true });
      await Promise.all([currentAlpha.promise, currentNotes.promise]);
    });
  });

  it("ignores a pending mutation after unmount", async () => {
    const pending = deferred<{ starred: true }>();
    starDocument.mockReturnValueOnce(pending.promise);
    const view = renderDashboard();
    fireEvent.click(documentStar("Alpha planning"));

    view.unmount();
    await act(async () => {
      pending.reject(new ApiError(503, "Unmounted star failure"));
      await Promise.allSettled([pending.promise]);
    });

    expect(console.error).not.toHaveBeenCalled();
  });
});

describe("dashboard trash recovery", () => {
  it("keeps the first load pending, then announces the API reason without false empty copy", async () => {
    const initial = deferred<ListResponse>();
    listDocuments.mockReturnValueOnce(initial.promise);
    renderDashboard();

    openTrash();
    expect(screen.getByText("Loading trash…")).toBeInTheDocument();
    expect(screen.queryByText("The trash is empty")).toBeNull();

    await act(async () => {
      initial.reject(new ApiError(503, "Trash service unavailable"));
      await Promise.allSettled([initial.promise]);
    });

    const alert = screen.getByRole("alert");
    expect(alert).toHaveAttribute("aria-atomic", "true");
    expect(alert).toHaveTextContent("Trash service unavailable");
    expect(within(alert).getByRole("button", { name: "Retry" })).toBeEnabled();
    expect(screen.queryByText("Loading trash…")).toBeNull();
    expect(screen.queryByText("The trash is empty")).toBeNull();
    expect(listDocuments).toHaveBeenCalledTimes(1);
    expect(listDocuments).toHaveBeenLastCalledWith({ trash: true });
  });

  it("guards one pending Retry and recovers to both successful empty and populated states", async () => {
    const retry = deferred<ListResponse>();
    listDocuments
      .mockRejectedValueOnce(new ApiError(503, "Trash service unavailable"))
      .mockReturnValueOnce(retry.promise)
      .mockResolvedValueOnce({ documents: [trashedDoc("restored-list", "Recovered document")] });
    renderDashboard();
    openTrash();
    await act(async () => {});

    const retryButton = within(screen.getByRole("alert")).getByRole("button", { name: "Retry" });
    fireEvent.click(retryButton);
    fireEvent.click(retryButton);

    expect(listDocuments).toHaveBeenCalledTimes(2);
    expect(listDocuments.mock.calls[1]?.[0]).toEqual({ trash: true });
    expect(screen.getByTestId("trash-view")).toHaveAttribute("aria-busy", "true");
    expect(within(screen.getByRole("alert")).getByRole("button", { name: "Retrying…" })).toBeDisabled();

    await act(async () => {
      retry.resolve({ documents: [] });
      await retry.promise;
    });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("The trash is empty")).toBeInTheDocument();

    leaveTrash();
    openTrash();
    await act(async () => {});
    expect(listDocuments).toHaveBeenCalledTimes(3);
    expect(screen.queryByText("The trash is empty")).toBeNull();
    expect(screen.getByText("Recovered document")).toBeInTheDocument();
  });

  it("keeps cached rows visible below a retryable refresh failure", async () => {
    listDocuments
      .mockResolvedValueOnce({ documents: [trashedDoc("cached", "Cached trash row")] })
      .mockRejectedValueOnce(new ApiError(503, "Refresh failed"));
    renderDashboard();
    openTrash();
    await act(async () => {});
    expect(screen.getByText("Cached trash row")).toBeInTheDocument();

    leaveTrash();
    openTrash();
    await act(async () => {});

    const alert = screen.getByRole("alert");
    const list = screen.getByTestId("trash-list");
    expect(alert).toHaveTextContent("Refresh failed");
    expect(within(alert).getByRole("button", { name: "Retry" })).toBeEnabled();
    expect(screen.getByText("Cached trash row")).toBeInTheDocument();
    expect(alert.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("isolates late rows and errors from earlier visits after leaving and re-entering Trash", async () => {
    const staleRows = deferred<ListResponse>();
    const staleError = deferred<ListResponse>();
    const current = deferred<ListResponse>();
    listDocuments
      .mockReturnValueOnce(staleRows.promise)
      .mockReturnValueOnce(staleError.promise)
      .mockReturnValueOnce(current.promise);
    renderDashboard();

    openTrash();
    leaveTrash();
    openTrash();
    leaveTrash();
    openTrash();
    expect(listDocuments).toHaveBeenCalledTimes(3);

    await act(async () => {
      current.resolve({ documents: [trashedDoc("current", "Current trash row")] });
      await current.promise;
    });
    await act(async () => {
      staleRows.resolve({ documents: [trashedDoc("stale", "Stale trash row")] });
      staleError.reject(new ApiError(503, "Stale visit failure"));
      await Promise.allSettled([staleRows.promise, staleError.promise]);
    });

    expect(screen.getByText("Current trash row")).toBeInTheDocument();
    expect(screen.queryByText("Stale trash row")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("owns two immediate Restore activations and commits the exact row once", async () => {
    const pending = deferred<{ ok: true }>();
    restoreDocument.mockReturnValueOnce(pending.promise);
    listDocuments.mockResolvedValueOnce({ documents: [trashedDoc("restore-me", "Restore me"), trashedDoc("keep-me", "Keep me")] });
    renderDashboard();
    openTrash();
    await act(async () => {});
    const restore = trashButton("Restore me", "restore-button");

    act(() => {
      restore.click();
      restore.click();
    });

    expect(restoreDocument).toHaveBeenCalledTimes(1);
    expect(restoreDocument).toHaveBeenLastCalledWith("restore-me");
    expect(trashButton("Keep me", "restore-button")).toBeDisabled();

    await act(async () => {
      pending.resolve({ ok: true });
      await pending.promise;
    });

    expect(screen.queryByText("Restore me")).toBeNull();
    expect(screen.getByText("Keep me")).toBeInTheDocument();
    expect(screen.getByTestId("toast")).toHaveTextContent("“Restore me” was restored.");
    expect(screen.getByTestId("toast")).toHaveAttribute("data-kind", "success");
    expect(router.refresh).toHaveBeenCalledTimes(1);
  });

  it("declines Delete without ownership, then keeps confirmed failure and retry single-owner", async () => {
    const failed = deferred<{ ok: true; permanent: boolean }>();
    const retry = deferred<{ ok: true; permanent: boolean }>();
    purgeDocument.mockReturnValueOnce(failed.promise).mockReturnValueOnce(retry.promise);
    const confirmDelete = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValue(true);
    listDocuments.mockResolvedValueOnce({ documents: [trashedDoc("purge-me", "Purge me"), trashedDoc("keep-me", "Keep me")] });
    renderDashboard();
    openTrash();
    await act(async () => {});
    const purge = trashButton("Purge me", "purge-button");

    fireEvent.click(purge);
    expect(confirmDelete).toHaveBeenCalledTimes(1);
    expect(purgeDocument).not.toHaveBeenCalled();
    expect(purge).toBeEnabled();

    fireEvent.click(purge);
    expect(confirmDelete).toHaveBeenCalledTimes(2);
    expect(purgeDocument).toHaveBeenCalledTimes(1);
    expect(purgeDocument).toHaveBeenLastCalledWith("purge-me", { permanent: true });
    await act(async () => {
      failed.reject(new ApiError(503, "Delete service unavailable"));
      await Promise.allSettled([failed.promise]);
    });

    expect(screen.getByTestId("toast")).toHaveTextContent("Delete service unavailable");
    expect(purge).toBeEnabled();
    act(() => {
      purge.click();
      purge.click();
    });
    expect(confirmDelete).toHaveBeenCalledTimes(3);
    expect(purgeDocument).toHaveBeenCalledTimes(2);

    await act(async () => {
      retry.resolve({ ok: true, permanent: true });
      await retry.promise;
    });

    expect(screen.queryByText("Purge me")).toBeNull();
    expect(screen.getByText("Keep me")).toBeInTheDocument();
    expect(router.refresh).not.toHaveBeenCalled();
  });

  it("lets a re-entered visit fail while an older success and finalizer stay inert", async () => {
    const staleSuccess = deferred<{ ok: true }>();
    const currentFailure = deferred<{ ok: true }>();
    const currentList = deferred<ListResponse>();
    restoreDocument.mockReturnValueOnce(staleSuccess.promise).mockReturnValueOnce(currentFailure.promise);
    listDocuments.mockResolvedValueOnce({ documents: [trashedDoc("same-row", "Same row")] }).mockReturnValueOnce(currentList.promise);
    renderDashboard();
    openTrash();
    await act(async () => {});

    fireEvent.click(trashButton("Same row", "restore-button"));
    leaveTrash();
    openTrash();
    fireEvent.click(trashButton("Same row", "restore-button"));
    expect(restoreDocument).toHaveBeenCalledTimes(2);

    await act(async () => {
      staleSuccess.resolve({ ok: true });
      await staleSuccess.promise;
    });
    expect(screen.getByText("Same row")).toBeInTheDocument();
    expect(screen.queryByTestId("toast")).toBeNull();
    expect(router.refresh).not.toHaveBeenCalled();
    expect(trashButton("Same row", "restore-button")).toBeDisabled();

    await act(async () => {
      currentFailure.reject(new ApiError(503, "Current restore failed"));
      await Promise.allSettled([currentFailure.promise]);
    });
    expect(screen.getByText("Same row")).toBeInTheDocument();
    expect(screen.getByTestId("toast")).toHaveTextContent("Current restore failed");
    expect(trashButton("Same row", "restore-button")).toBeEnabled();
    expect(router.refresh).not.toHaveBeenCalled();

    await act(async () => {
      currentList.resolve({ documents: [trashedDoc("same-row", "Stale list row")] });
      await currentList.promise;
    });
    expect(screen.getByText("Same row")).toBeInTheDocument();
    expect(screen.queryByText("Stale list row")).toBeNull();
  });

  it("lets current Restore win before an older failure without stale notice, refresh, or finalizer work", async () => {
    const staleFailure = deferred<{ ok: true }>();
    const currentSuccess = deferred<{ ok: true }>();
    const currentList = deferred<ListResponse>();
    restoreDocument.mockReturnValueOnce(staleFailure.promise).mockReturnValueOnce(currentSuccess.promise);
    listDocuments.mockResolvedValueOnce({ documents: [trashedDoc("same-row", "Same row"), trashedDoc("keep-me", "Keep me")] }).mockReturnValueOnce(currentList.promise);
    renderDashboard();
    openTrash();
    await act(async () => {});

    fireEvent.click(trashButton("Same row", "restore-button"));
    leaveTrash();
    openTrash();
    fireEvent.click(trashButton("Same row", "restore-button"));

    await act(async () => {
      currentSuccess.resolve({ ok: true });
      await currentSuccess.promise;
    });
    expect(screen.queryByText("Same row")).toBeNull();
    expect(screen.getByText("Keep me")).toBeInTheDocument();
    expect(screen.getByTestId("toast")).toHaveTextContent("“Same row” was restored.");
    expect(router.refresh).toHaveBeenCalledTimes(1);

    await act(async () => {
      staleFailure.reject(new ApiError(503, "Obsolete restore failed"));
      await Promise.allSettled([staleFailure.promise]);
      currentList.resolve({ documents: [trashedDoc("same-row", "Reintroduced row"), trashedDoc("keep-me", "Keep me")] });
      await currentList.promise;
    });
    expect(screen.queryByText("Reintroduced row")).toBeNull();
    expect(screen.getByTestId("toast")).toHaveTextContent("“Same row” was restored.");
    expect(router.refresh).toHaveBeenCalledTimes(1);
    expect(console.error).not.toHaveBeenCalled();
  });

  it("retires a pending list at the successful action boundary so it cannot reintroduce the row", async () => {
    const refresh = deferred<ListResponse>();
    const deletion = deferred<{ ok: true; permanent: boolean }>();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    listDocuments.mockResolvedValueOnce({ documents: [trashedDoc("pending-row", "Pending row")] }).mockReturnValueOnce(refresh.promise);
    purgeDocument.mockReturnValueOnce(deletion.promise);
    renderDashboard();
    openTrash();
    await act(async () => {});
    leaveTrash();
    openTrash();
    expect(screen.getByTestId("trash-view")).toHaveAttribute("aria-busy", "true");

    fireEvent.click(trashButton("Pending row", "purge-button"));
    expect(screen.getByTestId("trash-view")).not.toHaveAttribute("aria-busy");
    await act(async () => {
      deletion.resolve({ ok: true, permanent: true });
      await deletion.promise;
    });
    expect(screen.queryByText("Pending row")).toBeNull();

    await act(async () => {
      refresh.resolve({ documents: [trashedDoc("pending-row", "Reintroduced row")] });
      await refresh.promise;
    });
    expect(screen.queryByText("Reintroduced row")).toBeNull();
    expect(screen.getByText("The trash is empty")).toBeInTheDocument();
    expect(purgeDocument).toHaveBeenCalledTimes(1);
    expect(router.refresh).not.toHaveBeenCalled();
  });

  it("invalidates an action whose target disappears on a later visit", async () => {
    const stale = deferred<{ ok: true }>();
    restoreDocument.mockReturnValueOnce(stale.promise);
    listDocuments.mockResolvedValueOnce({ documents: [trashedDoc("removed-row", "Removed row")] }).mockResolvedValueOnce({ documents: [] });
    renderDashboard();
    openTrash();
    await act(async () => {});
    fireEvent.click(trashButton("Removed row", "restore-button"));

    leaveTrash();
    openTrash();
    await act(async () => {});
    expect(screen.getByText("The trash is empty")).toBeInTheDocument();

    await act(async () => {
      stale.reject(new ApiError(503, "Removed target failed"));
      await Promise.allSettled([stale.promise]);
    });
    expect(screen.getByText("The trash is empty")).toBeInTheDocument();
    expect(screen.queryByTestId("toast")).toBeNull();
    expect(router.refresh).not.toHaveBeenCalled();
    expect(console.error).not.toHaveBeenCalled();
  });

  it("ignores pending Create and Restore work after unmount", async () => {
    const create = deferred<CreateResponse>();
    const restore = deferred<{ ok: true }>();
    createDocument.mockReturnValueOnce(create.promise);
    restoreDocument.mockReturnValueOnce(restore.promise);
    listDocuments.mockResolvedValueOnce({ documents: [trashedDoc("unmounted-row", "Unmounted row")] });
    const view = renderDashboard();
    fireEvent.click(screen.getByTestId("new-document"));
    openTrash();
    await act(async () => {});
    fireEvent.click(trashButton("Unmounted row", "restore-button"));

    view.unmount();
    await act(async () => {
      create.reject(new ApiError(503, "Unmounted create failed"));
      restore.reject(new ApiError(503, "Unmounted restore failed"));
      await Promise.allSettled([create.promise, restore.promise]);
    });

    expect(router.push).not.toHaveBeenCalled();
    expect(router.refresh).not.toHaveBeenCalled();
    expect(console.error).not.toHaveBeenCalled();
  });

  it("retires pending Restore and Delete ownership at the layout unmount boundary", async () => {
    vi.useRealTimers();
    const restore = deferred<{ ok: true }>();
    const deletion = deferred<{ ok: true; permanent: boolean }>();
    const unhandled: unknown[] = [];
    const onUnhandled = (event: PromiseRejectionEvent) => {
      unhandled.push(event.reason);
      event.preventDefault();
    };
    window.addEventListener("unhandledrejection", onUnhandled);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    restoreDocument.mockReturnValueOnce(restore.promise);
    purgeDocument.mockReturnValueOnce(deletion.promise);
    listDocuments
      .mockResolvedValueOnce({ documents: [trashedDoc("restore-boundary", "Restore boundary")] })
      .mockResolvedValueOnce({ documents: [trashedDoc("delete-boundary", "Delete boundary")] });

    const unmountAndSettle = async (
      title: string,
      action: "restore-button" | "purge-button",
      settle: () => void,
      pending: Promise<unknown>,
    ) => {
      const view = render(
        <TransitionUnmount>
          <Dashboard user={USER} documents={DOCUMENTS} githubAvailable githubConfigured />
        </TransitionUnmount>,
      );
      openTrash();
      await act(async () => {});
      fireEvent.click(trashButton(title, action));
      const removed = deferred<void>();
      const settled = Promise.allSettled([pending]);
      let settledAtRemoval = false;
      let postRemovalMutations = 0;
      const observer = new MutationObserver((records) => {
        if (document.querySelector('[data-testid="trash-view"]')) return;
        if (!settledAtRemoval) {
          settledAtRemoval = true;
          settle();
          removed.resolve();
          return;
        }
        postRemovalMutations += records.length;
      });
      observer.observe(document.body, { childList: true, subtree: true });
      const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
      const previousActEnvironment = actEnvironment.IS_REACT_ACT_ENVIRONMENT;
      actEnvironment.IS_REACT_ACT_ENVIRONMENT = false;

      try {
        screen.getByTestId("unmount-dashboard").click();
        await removed.promise;
        await settled;
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(screen.queryByTestId("trash-view")).toBeNull();
        expect(screen.queryByTestId("trash-card")).toBeNull();
        expect(screen.queryByTestId("toast")).toBeNull();
        return postRemovalMutations;
      } finally {
        actEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
        observer.disconnect();
        view.unmount();
      }
    };

    try {
      const restoreMutations = await unmountAndSettle("Restore boundary", "restore-button", () => restore.resolve({ ok: true }), restore.promise);
      const deleteMutations = await unmountAndSettle(
        "Delete boundary",
        "purge-button",
        () => deletion.reject(new ApiError(503, "Unmounted delete failed")),
        deletion.promise,
      );

      expect(restoreDocument).toHaveBeenCalledTimes(1);
      expect(restoreDocument).toHaveBeenLastCalledWith("restore-boundary");
      expect(purgeDocument).toHaveBeenCalledTimes(1);
      expect(purgeDocument).toHaveBeenLastCalledWith("delete-boundary", { permanent: true });
      expect(restoreMutations + deleteMutations).toBe(0);
      expect(router.refresh).not.toHaveBeenCalled();
      expect(router.push).not.toHaveBeenCalled();
      expect(console.error).not.toHaveBeenCalled();
      expect(unhandled).toEqual([]);
    } finally {
      window.removeEventListener("unhandledrejection", onUnhandled);
    }
  });
});
