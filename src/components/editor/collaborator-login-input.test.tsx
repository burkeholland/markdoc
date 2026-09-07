// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useLayoutEffect, useState } from "react";

type SearchAnswer = { users: { login: string; name: string | null; avatarUrl: string }[]; limited: boolean; reason?: "no-github-token" };
const searchUsers = vi.fn<(q: string, init?: RequestInit) => Promise<SearchAnswer>>();
vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    api: { ...actual.api, github: { ...actual.api.github, searchUsers: (...args: [string, RequestInit?]) => searchUsers(...args) } },
  };
});

import { ApiError } from "@/lib/api";
import { CollaboratorLoginInput, SUGGEST_DEBOUNCE_MS, suggestQuery } from "./collaborator-login-input";

const user = (login: string) => ({ login, name: null, avatarUrl: `https://avatars.githubusercontent.com/${login}?s=40` });
const answer = (...logins: string[]) => Promise.resolve({ users: logins.map(user), limited: false });
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

/** The dialog's form around the box: controlled value, Enter submits the typed handle unless an option takes it. */
function Harness({ exclude = [], onPick, onSubmit }: { exclude?: string[]; onPick?: (login: string) => void; onSubmit?: (login: string) => void }) {
  const [login, setLogin] = useState("");
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit?.(login);
      }}
    >
      <CollaboratorLoginInput value={login} onChange={setLogin} exclude={exclude} onPick={onPick} />
      <select aria-label="Role" data-testid="role">
        <option>editor</option>
      </select>
      <button type="submit">Add</button>
    </form>
  );
}

/**
 * Runs `onBoundary` from the parent's layout effect after a child query replacement or removal.
 * Promise settlements queued here happen before the retired child's passive cleanup.
 */
function BoundaryHarness({
  value,
  present = true,
  boundary = 0,
  onBoundary,
}: {
  value: string;
  present?: boolean;
  boundary?: number;
  onBoundary?: () => void;
}) {
  useLayoutEffect(() => {
    if (boundary > 0) onBoundary?.();
  }, [boundary, onBoundary]);
  return present ? <CollaboratorLoginInput value={value} onChange={() => {}} exclude={[]} /> : null;
}

type PendingSearch = {
  promise: Promise<SearchAnswer>;
  resolve: (value: SearchAnswer) => void;
  reject: (reason?: unknown) => void;
};

const boundarySettlements: { label: string; settle: (pending: PendingSearch) => void }[] = [
  {
    label: "normal success",
    settle: (pending) => pending.resolve({ users: [user("ocean")], limited: false }),
  },
  {
    label: "limited success",
    settle: (pending) => pending.resolve({ users: [], limited: true }),
  },
  {
    label: "no-token success",
    settle: (pending) => pending.resolve({ users: [], limited: false, reason: "no-github-token" }),
  },
  {
    label: "failure",
    settle: (pending) => pending.reject(new ApiError(503, "Retired failure")),
  },
];

const input = () => screen.getByTestId("share-login") as HTMLInputElement;
const type = (value: string) => {
  input().focus();
  fireEvent.change(input(), { target: { value } });
};
const settle = async (ms = SUGGEST_DEBOUNCE_MS) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};
const options = () => screen.queryAllByTestId("share-login-option").map((el) => el.getAttribute("data-login"));
/** The listbox's options only (the harness select has <option>s of its own). */
const listOptions = () => within(screen.getByTestId("share-login-suggestions")).getAllByRole("option");

beforeEach(() => {
  vi.useFakeTimers();
  searchUsers.mockReset();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("suggestQuery()", () => {
  it("searches trimmed prefixes of two or more login characters, without a leading @", () => {
    expect(suggestQuery("oc")).toBe("oc");
    expect(suggestQuery(" @Octo-Cat ")).toBe("Octo-Cat");
    expect(suggestQuery("o")).toBeNull();
    expect(suggestQuery("@o")).toBeNull();
    expect(suggestQuery("")).toBeNull();
    expect(suggestQuery("oc to")).toBeNull();
    expect(suggestQuery("bad!")).toBeNull();
    expect(suggestQuery("a".repeat(40))).toBeNull();
  });
});

describe("CollaboratorLoginInput", () => {
  it("is a combobox that stays closed and silent below two characters", async () => {
    render(<Harness />);
    expect(input()).toHaveAttribute("role", "combobox");
    expect(input()).toHaveAttribute("aria-autocomplete", "list");
    expect(input()).toHaveAttribute("aria-expanded", "false");
    expect(input().getAttribute("aria-controls")).toBeTruthy();
    type("o");
    await settle(1000);
    expect(searchUsers).not.toHaveBeenCalled();
    expect(screen.queryByTestId("share-login-suggestions")).toBeNull();
  });

  it("debounces a burst of keystrokes into one request for the settled query and lists its users", async () => {
    searchUsers.mockImplementation(() => answer("octocat", "octodog"));
    render(<Harness />);
    for (const value of ["o", "oc", "oct", "octo"]) {
      type(value);
      await settle(50);
    }
    expect(searchUsers).not.toHaveBeenCalled();
    await settle(SUGGEST_DEBOUNCE_MS);
    expect(searchUsers).toHaveBeenCalledTimes(1);
    expect(searchUsers.mock.calls[0][0]).toBe("octo");
    expect(searchUsers.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);

    const list = screen.getByTestId("share-login-suggestions");
    expect(list).toHaveAttribute("role", "listbox");
    expect(list.id).toBe(input().getAttribute("aria-controls"));
    expect(input()).toHaveAttribute("aria-expanded", "true");
    expect(options()).toEqual(["octocat", "octodog"]);
    expect(listOptions().map((o) => o.textContent)).toEqual(["@octocat", "@octodog"]);
    expect(listOptions().every((o) => o.getAttribute("aria-selected") === "false")).toBe(true);
    expect(input()).not.toHaveAttribute("aria-activedescendant");
  });

  it("announces the pending debounced query without disabling typing or exact-handle submission", async () => {
    const pending = deferred<SearchAnswer>();
    searchUsers.mockReturnValue(pending.promise);
    const onSubmit = vi.fn();
    render(<Harness onSubmit={onSubmit} />);

    type("octo");
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("Loading GitHub suggestions for @octo");
    expect(input()).toHaveAttribute("aria-describedby", status.id);
    expect(input()).not.toBeDisabled();
    expect(searchUsers).not.toHaveBeenCalled();

    await settle();
    expect(searchUsers).toHaveBeenCalledTimes(1);
    expect(fireEvent.keyDown(input(), { key: "Enter" })).toBe(true);
    fireEvent.submit(input().closest("form")!);
    expect(onSubmit).toHaveBeenCalledWith("octo");

    type("octopus");
    expect(input()).toHaveValue("octopus");
    expect(searchUsers.mock.calls[0][1]?.signal?.aborted).toBe(true);
  });

  it("drops the answer to a query that is no longer current, even when it arrives last", async () => {
    const pending = new Map<string, (r: { users: ReturnType<typeof user>[]; limited: boolean }) => void>();
    searchUsers.mockImplementation((q) => new Promise((resolve) => pending.set(q, resolve)));
    render(<Harness />);
    type("oc");
    await settle();
    type("octo");
    await settle();
    expect([...pending.keys()]).toEqual(["oc", "octo"]);
    // The stale request was aborted as well.
    expect(searchUsers.mock.calls[0][1]?.signal?.aborted).toBe(true);
    expect(searchUsers.mock.calls[1][1]?.signal?.aborted).toBe(false);

    await act(async () => {
      pending.get("octo")!({ users: [user("octocat")], limited: false });
    });
    expect(options()).toEqual(["octocat"]);
    await act(async () => {
      pending.get("oc")!({ users: [user("ocean"), user("ocelot")], limited: false });
    });
    expect(options()).toEqual(["octocat"]);
  });

  it.each(boundarySettlements)("retires a pending $label at the query layout boundary", async ({ settle: settlePending }) => {
    const pending = deferred<SearchAnswer>();
    const replacement = deferred<SearchAnswer>();
    searchUsers.mockReturnValueOnce(pending.promise).mockReturnValueOnce(replacement.promise).mockImplementation(() => answer("ocean"));
    const view = render(<BoundaryHarness value="oc" />);
    input().focus();
    await settle();
    const retiredSignal = searchUsers.mock.calls[0][1]?.signal;

    view.rerender(
      <BoundaryHarness
        value="octo"
        boundary={1}
        onBoundary={() => {
          expect(retiredSignal?.aborted).toBe(true);
          settlePending(pending);
        }}
      />,
    );
    await act(async () => {
      await Promise.allSettled([pending.promise]);
      await Promise.resolve();
    });

    expect(options()).toEqual([]);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByTestId("share-login-suggestions")).toBeNull();
    expect(input()).toHaveAttribute("aria-expanded", "false");
    expect(input()).not.toHaveAttribute("aria-activedescendant");
    expect(screen.getByRole("status")).toHaveTextContent("Loading GitHub suggestions for @octo");

    await settle();
    expect(searchUsers.mock.calls.map(([q]) => q)).toEqual(["oc", "octo"]);
    expect(searchUsers.mock.calls.filter(([q]) => q === "octo")).toHaveLength(1);
    expect(searchUsers.mock.calls[1][1]?.signal?.aborted).toBe(false);

    await act(async () => {
      replacement.resolve({ users: [user("octocat")], limited: false });
    });
    expect(options()).toEqual(["octocat"]);

    view.rerender(<BoundaryHarness value="oc" boundary={2} />);
    await settle();
    expect(searchUsers.mock.calls.map(([q]) => q)).toEqual(["oc", "octo", "oc"]);
    expect(options()).toEqual(["ocean"]);
  });

  it("↓/↑ move the active option, Enter picks it into the box without submitting and hands over to onPick", async () => {
    searchUsers.mockImplementation(() => answer("octocat", "octodog", "octofox"));
    const onPick = vi.fn();
    const onSubmit = vi.fn();
    render(<Harness onPick={onPick} onSubmit={onSubmit} />);
    type("octo");
    await settle();
    expect(options()).toHaveLength(3);

    fireEvent.keyDown(input(), { key: "ArrowDown" });
    let selected = listOptions().filter((o) => o.getAttribute("aria-selected") === "true");
    expect(selected.map((o) => o.getAttribute("data-login"))).toEqual(["octocat"]);
    expect(input().getAttribute("aria-activedescendant")).toBe(selected[0].id);

    fireEvent.keyDown(input(), { key: "ArrowDown" });
    fireEvent.keyDown(input(), { key: "ArrowDown" });
    fireEvent.keyDown(input(), { key: "ArrowDown" }); // wraps back to the first
    fireEvent.keyDown(input(), { key: "ArrowUp" }); // …and up wraps to the last
    selected = listOptions().filter((o) => o.getAttribute("aria-selected") === "true");
    expect(selected.map((o) => o.getAttribute("data-login"))).toEqual(["octofox"]);
    fireEvent.keyDown(input(), { key: "ArrowUp" });
    fireEvent.keyDown(input(), { key: "ArrowUp" });

    const notSubmitted = fireEvent.keyDown(input(), { key: "Enter" });
    expect(notSubmitted).toBe(false); // preventDefault: the form does not submit
    expect(input().value).toBe("octocat");
    expect(onPick).toHaveBeenCalledWith("octocat");
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.queryByTestId("share-login-suggestions")).toBeNull();
    expect(input()).toHaveAttribute("aria-expanded", "false");
    // The picked login is not searched again.
    await settle(1000);
    expect(searchUsers).toHaveBeenCalledTimes(1);
  });

  it("Enter with no active option submits the typed handle; Escape closes only the list", async () => {
    searchUsers.mockImplementation(() => answer("octocat"));
    const onSubmit = vi.fn();
    render(<Harness onSubmit={onSubmit} />);
    type("octo");
    await settle();
    expect(options()).toEqual(["octocat"]);

    const escaped = fireEvent.keyDown(input(), { key: "Escape" });
    expect(escaped).toBe(false); // claimed, so the dialog does not close on this Escape
    expect(screen.queryByTestId("share-login-suggestions")).toBeNull();
    expect(input().value).toBe("octo");
    // With the list closed, Escape is left to the dialog.
    expect(fireEvent.keyDown(input(), { key: "Escape" })).toBe(true);

    // ↓ reopens the list without another request; the arrows wrap, so one option is always active from here on.
    fireEvent.keyDown(input(), { key: "ArrowDown" });
    expect(options()).toEqual(["octocat"]);
    fireEvent.keyDown(input(), { key: "ArrowUp" });
    fireEvent.keyDown(input(), { key: "ArrowDown" });
    expect(listOptions().filter((o) => o.getAttribute("aria-selected") === "true")).toHaveLength(1);
    expect(searchUsers).toHaveBeenCalledTimes(1);

    // A fresh answer starts with nothing active; Escape, then Enter submits what was typed.
    type("octopus");
    await settle();
    expect(listOptions().filter((o) => o.getAttribute("aria-selected") === "true")).toHaveLength(0);
    fireEvent.keyDown(input(), { key: "Escape" });
    const submitted = fireEvent.keyDown(input(), { key: "Enter" });
    expect(submitted).toBe(true);
    fireEvent.submit(input().closest("form")!);
    expect(onSubmit).toHaveBeenCalledWith("octopus");
  });

  it("a click picks the option", async () => {
    searchUsers.mockImplementation(() => answer("octocat", "octodog"));
    const onPick = vi.fn();
    render(<Harness onPick={onPick} />);
    type("octo");
    await settle();
    const dog = screen.getAllByTestId("share-login-option")[1];
    expect(fireEvent.mouseDown(dog)).toBe(false); // focus stays in the box
    fireEvent.click(dog);
    expect(input().value).toBe("octodog");
    expect(onPick).toHaveBeenCalledWith("octodog");
    expect(screen.queryByTestId("share-login-suggestions")).toBeNull();
  });

  it("never suggests the owner or someone already listed, and caps the list at eight", async () => {
    const many = Array.from({ length: 12 }, (_, i) => `octo${i}`);
    searchUsers.mockImplementation(() => answer("octocat", "Octodog", ...many));
    render(<Harness exclude={["OCTOCAT", "octodog"]} />);
    type("octo");
    await settle();
    expect(options()).toEqual(many.slice(0, 8));
  });

  it("shows the API reason after rejection, keeps exact-handle submission available, and guards one Retry to a real empty result", async () => {
    const retried = deferred<SearchAnswer>();
    searchUsers.mockRejectedValueOnce(new ApiError(503, "GitHub account search is unavailable")).mockReturnValueOnce(retried.promise);
    const onSubmit = vi.fn();
    render(<Harness onSubmit={onSubmit} />);

    type("octo");
    await settle();
    expect(searchUsers).toHaveBeenCalledTimes(1);
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("GitHub suggestions for @octo: GitHub account search is unavailable");
    const retry = within(alert).getByRole("button", { name: "Retry" });
    expect(retry).not.toBeDisabled();
    expect(fireEvent.keyDown(input(), { key: "Enter" })).toBe(true);
    fireEvent.submit(input().closest("form")!);
    expect(onSubmit).toHaveBeenCalledWith("octo");

    fireEvent.click(retry);
    expect(searchUsers).toHaveBeenCalledTimes(2);
    expect(searchUsers.mock.calls[1][0]).toBe("octo");
    expect(within(screen.getByRole("alert")).getByRole("button", { name: "Retrying…" })).toBeDisabled();
    fireEvent.click(within(screen.getByRole("alert")).getByRole("button", { name: "Retrying…" }));
    expect(searchUsers).toHaveBeenCalledTimes(2);

    await act(async () => {
      retried.resolve({ users: [], limited: false });
    });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByTestId("share-login-suggestions")).toBeNull();
    expect(input().value).toBe("octo");
  });

  it("turns a limited response into truthful feedback and one Retry that restores populated suggestions", async () => {
    const retried = deferred<SearchAnswer>();
    searchUsers.mockResolvedValueOnce({ users: [], limited: true }).mockReturnValueOnce(retried.promise);
    render(<Harness />);

    type("octo");
    await settle();
    expect(screen.getByRole("alert")).toHaveTextContent("GitHub suggestions for @octo are temporarily unavailable.");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(searchUsers).toHaveBeenCalledTimes(2);
    expect(searchUsers.mock.calls.map(([q]) => q)).toEqual(["octo", "octo"]);
    expect(screen.getByRole("button", { name: "Retrying…" })).toBeDisabled();

    await act(async () => {
      retried.resolve({ users: [user("octocat"), user("octodog")], limited: false });
    });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(options()).toEqual(["octocat", "octodog"]);
    expect(input()).toHaveAttribute("aria-expanded", "true");
  });

  it("after the route answers reason=no-github-token it asks no more while mounted: one request for a whole share, no hint, the box still types (task #1481)", async () => {
    searchUsers.mockImplementation(() => Promise.resolve({ users: [], limited: false, reason: "no-github-token" as const }));
    render(<Harness />);
    type("oc");
    await settle();
    expect(searchUsers).toHaveBeenCalledTimes(1);
    expect(searchUsers.mock.calls[0][0]).toBe("oc");
    expect(screen.queryByTestId("share-login-suggestions")).toBeNull();
    // Nothing is said about it: no alert, pending state, rate-limit hint or stray text.
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByText(/limit|token|GitHub/i)).toBeNull();

    // Two more settled prefixes — past the debounce each — go nowhere.
    searchUsers.mockImplementation(() => answer("octocat"));
    type("octo");
    await settle(SUGGEST_DEBOUNCE_MS * 2);
    type("octocat");
    await settle(SUGGEST_DEBOUNCE_MS * 2);
    expect(searchUsers).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("share-login-suggestions")).toBeNull();
    expect(input().value).toBe("octocat");
    expect(input()).toHaveAttribute("aria-expanded", "false");
  });

  it("ignores a superseded no-github-token answer without suppressing the current or later query", async () => {
    const pending = new Map<string, (r: { users: ReturnType<typeof user>[]; limited: boolean; reason?: "no-github-token" }) => void>();
    searchUsers.mockImplementation((q) => new Promise((resolve) => pending.set(q, resolve)));
    render(<Harness />);
    type("oc");
    await settle();
    type("octo");
    await settle();
    expect(searchUsers).toHaveBeenCalledTimes(2);
    // The stale answer arrives first and carries the reason.
    await act(async () => {
      pending.get("oc")!({ users: [], limited: false, reason: "no-github-token" });
    });
    expect(searchUsers.mock.calls[1][1]?.signal?.aborted).toBe(false);
    await act(async () => {
      pending.get("octo")!({ users: [user("octocat")], limited: false });
    });
    expect(options()).toEqual(["octocat"]);
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    type("octoc");
    await settle();
    expect(searchUsers).toHaveBeenCalledTimes(3);
  });

  it("reuses the answer for a prefix typed again instead of asking twice, and closes when the box empties or loses focus", async () => {
    searchUsers.mockImplementation(() => answer("octocat"));
    render(<Harness />);
    type("octo");
    await settle();
    expect(options()).toEqual(["octocat"]);
    type("octoc");
    await settle();
    type("octo");
    await settle();
    expect(searchUsers).toHaveBeenCalledTimes(2);
    expect(options()).toEqual(["octocat"]);

    fireEvent.blur(input());
    expect(screen.queryByTestId("share-login-suggestions")).toBeNull();
    fireEvent.focus(input());
    expect(options()).toEqual(["octocat"]);

    type("");
    await settle();
    expect(screen.queryByTestId("share-login-suggestions")).toBeNull();
    expect(searchUsers).toHaveBeenCalledTimes(2);
  });

  it("keeps a newer query error when an aborted Retry for the old query later succeeds", async () => {
    const oldRetry = deferred<SearchAnswer>();
    searchUsers
      .mockRejectedValueOnce(new ApiError(503, "Old query failed"))
      .mockReturnValueOnce(oldRetry.promise)
      .mockRejectedValueOnce(new ApiError(503, "Current query failed"));
    render(<Harness />);

    type("oc");
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(searchUsers).toHaveBeenCalledTimes(2);
    type("octo");
    expect(screen.queryByText(/Old query failed/)).toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent("@octo");
    expect(searchUsers.mock.calls[1][1]?.signal?.aborted).toBe(true);
    await settle();
    expect(screen.getByRole("alert")).toHaveTextContent("Current query failed");

    await act(async () => {
      oldRetry.resolve({ users: [user("ocean")], limited: false });
    });
    expect(screen.getByRole("alert")).toHaveTextContent("Current query failed");
    expect(options()).toEqual([]);
    expect(searchUsers.mock.calls.map(([q]) => q)).toEqual(["oc", "oc", "octo"]);
  });

  it("retires a pending explicit Retry at the query layout boundary", async () => {
    const retried = deferred<SearchAnswer>();
    const replacement = deferred<SearchAnswer>();
    searchUsers
      .mockRejectedValueOnce(new ApiError(503, "Old query failed"))
      .mockReturnValueOnce(retried.promise)
      .mockReturnValueOnce(replacement.promise)
      .mockImplementation(() => answer("ocean"));
    const view = render(<BoundaryHarness value="oc" />);
    input().focus();
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    const retrySignal = searchUsers.mock.calls[1][1]?.signal;

    view.rerender(
      <BoundaryHarness
        value="octo"
        boundary={1}
        onBoundary={() => {
          expect(retrySignal?.aborted).toBe(true);
          retried.resolve({ users: [user("old-retry")], limited: false });
        }}
      />,
    );
    await act(async () => {
      await retried.promise;
      await Promise.resolve();
    });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(options()).toEqual([]);
    expect(screen.getByRole("status")).toHaveTextContent("@octo");

    await settle();
    expect(searchUsers.mock.calls.map(([q]) => q)).toEqual(["oc", "oc", "octo"]);
    expect(searchUsers.mock.calls.filter(([q]) => q === "octo")).toHaveLength(1);
    await act(async () => {
      replacement.resolve({ users: [user("octocat")], limited: false });
    });
    expect(options()).toEqual(["octocat"]);

    view.rerender(<BoundaryHarness value="oc" boundary={2} />);
    await settle();
    expect(searchUsers.mock.calls.map(([q]) => q)).toEqual(["oc", "oc", "octo", "oc"]);
    expect(options()).toEqual(["ocean"]);
  });

  it("does not let an answer reopen suggestions after a cached option is picked", async () => {
    const stale = deferred<SearchAnswer>();
    const onPick = vi.fn();
    searchUsers.mockImplementation((q) => (q === "oc" ? answer("ocean") : stale.promise));
    render(<Harness onPick={onPick} />);

    type("oc");
    await settle();
    expect(options()).toEqual(["ocean"]);
    type("oct");
    await settle();
    type("oc");
    expect(options()).toEqual(["ocean"]);
    fireEvent.click(screen.getByTestId("share-login-option"));
    expect(onPick).toHaveBeenCalledWith("ocean");
    expect(input()).toHaveValue("ocean");

    await act(async () => {
      stale.resolve({ users: [user("octocat")], limited: false });
    });
    expect(screen.queryByTestId("share-login-suggestions")).toBeNull();
    expect(input()).toHaveValue("ocean");
  });

  it("aborts and isolates pending success or failure when focus leaves the control", async () => {
    const pending = deferred<SearchAnswer>();
    searchUsers.mockReturnValue(pending.promise);
    render(<Harness />);
    type("octo");
    await settle();

    fireEvent.blur(input());
    expect(searchUsers.mock.calls[0][1]?.signal?.aborted).toBe(true);
    expect(screen.queryByRole("status")).toBeNull();
    await act(async () => {
      pending.reject(new ApiError(503, "Late failure"));
      await Promise.allSettled([pending.promise]);
    });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByTestId("share-login-suggestions")).toBeNull();
  });

  it("invalidates a pending Retry when focus leaves the control", async () => {
    const retried = deferred<SearchAnswer>();
    searchUsers.mockRejectedValueOnce(new ApiError(503, "Try later")).mockReturnValueOnce(retried.promise);
    render(<Harness />);
    type("octo");
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(screen.getByRole("button", { name: "Retrying…" })).toBeDisabled();

    fireEvent.blur(input());
    expect(searchUsers.mock.calls[1][1]?.signal?.aborted).toBe(true);
    expect(screen.queryByRole("alert")).toBeNull();
    await act(async () => {
      retried.resolve({ users: [user("octocat")], limited: false });
    });
    expect(screen.queryByTestId("share-login-suggestions")).toBeNull();
  });

  it("aborts and isolates a pending answer on unmount", async () => {
    const pending = deferred<SearchAnswer>();
    searchUsers.mockReturnValue(pending.promise);
    const view = render(<Harness />);
    type("octo");
    await settle();

    view.unmount();
    expect(searchUsers.mock.calls[0][1]?.signal?.aborted).toBe(true);
    await act(async () => {
      pending.resolve({ users: [user("octocat")], limited: false });
    });
    expect(screen.queryByTestId("share-login-suggestions")).toBeNull();
  });

  it("retires before a boundary failure settles during unmount without post-unmount UI work or an unhandled rejection", async () => {
    const pending = deferred<SearchAnswer>();
    const unhandled: unknown[] = [];
    const onUnhandled = (event: PromiseRejectionEvent) => unhandled.push(event.reason);
    window.addEventListener("unhandledrejection", onUnhandled);
    searchUsers.mockReturnValue(pending.promise);
    const view = render(<BoundaryHarness value="octo" />);
    input().focus();
    await settle();
    const retiredSignal = searchUsers.mock.calls[0][1]?.signal;

    try {
      view.rerender(
        <BoundaryHarness
          value="octo"
          present={false}
          boundary={1}
          onBoundary={() => {
            expect(retiredSignal?.aborted).toBe(true);
            pending.reject(new ApiError(503, "Failure at unmount boundary"));
          }}
        />,
      );
      await act(async () => {
        await Promise.allSettled([pending.promise]);
        await Promise.resolve();
      });
      expect(screen.queryByTestId("share-login")).toBeNull();
      expect(screen.queryByRole("status")).toBeNull();
      expect(screen.queryByRole("alert")).toBeNull();
      expect(screen.queryByTestId("share-login-suggestions")).toBeNull();
      expect(unhandled).toEqual([]);
    } finally {
      window.removeEventListener("unhandledrejection", onUnhandled);
    }
  });
});
