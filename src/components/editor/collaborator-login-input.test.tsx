// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode, useRef, useState } from "react";

type SearchAnswer = {
  users: { login: string; name: string | null; avatarUrl: string }[];
  limited: boolean;
  reason?: "no-github-token";
};
const searchUsers = vi.fn<(q: string, init?: RequestInit) => Promise<SearchAnswer>>();
vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    api: {
      ...actual.api,
      github: {
        ...actual.api.github,
        searchUsers: (...args: [string, RequestInit?]) => searchUsers(...args),
      },
    },
  };
});

import { ApiError } from "@/lib/api";
import { CollaboratorLoginInput, SHIELD_MS, SUGGEST_DEBOUNCE_MS, isValidLogin, suggestQuery } from "./collaborator-login-input";

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

function input() {
  return screen.getByTestId("share-login") as HTMLInputElement;
}

function listOptions() {
  return screen.getAllByTestId("share-login-option");
}

function options() {
  return listOptions().map((o) => o.getAttribute("data-login"));
}

function type(value: string) {
  const box = input();
  box.focus();
  fireEvent.change(box, { target: { value } });
}

/** Advances the debounce timer and lets any already-resolved promise microtasks settle. */
async function settle(ms = SUGGEST_DEBOUNCE_MS) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  searchUsers.mockReset();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
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

describe("isValidLogin()", () => {
  it("accepts a real-looking GitHub handle, trimmed and with an optional leading @", () => {
    expect(isValidLogin("octocat")).toBe(true);
    expect(isValidLogin("  @octocat  ")).toBe(true);
    expect(isValidLogin("zz-nobody")).toBe(true);
    expect(isValidLogin("a1-b2")).toBe(true);
  });

  it("rejects only what the server would reject: empty, too long, spaces, or bad characters", () => {
    expect(isValidLogin("")).toBe(false);
    expect(isValidLogin("   ")).toBe(false);
    expect(isValidLogin("bad name")).toBe(false);
    expect(isValidLogin("bad!")).toBe(false);
    expect(isValidLogin("a".repeat(40))).toBe(false);
  });

  // Matches exactly what POST /api/documents/[id]/collaborators accepts (min 1, max 39, letters/digits/hyphens,
  // leading @ optional) so Add is never stricter than the server, even for shapes SUGGEST_MIN_CHARS would not
  // search for (a 1-character login is too short to suggest but is still a submittable, real GitHub login).
  it("is never stricter than the server's own collaborators-route validation", () => {
    expect(isValidLogin("a")).toBe(true); // 1 character: too short to *suggest*, but a valid login to *add*
    expect(isValidLogin("@a")).toBe(true); // leading @
    expect(isValidLogin("abc-")).toBe(true); // trailing hyphen: the server's regex allows it
    expect(isValidLogin("-abc")).toBe(true); // leading hyphen: the server's regex allows it
    expect(isValidLogin("a".repeat(39))).toBe(true); // exactly 39 characters: the server's max
    expect(isValidLogin("a".repeat(40))).toBe(false); // 40 characters: over the server's max
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
    await settle();
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

  it("announces the pending debounced query immediately without disabling typing or exact-handle submission", async () => {
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
    expect(fireEvent.keyDown(input(), { key: "Enter" })).toBe(true); // not claimed: no active option
    fireEvent.submit(input().closest("form")!);
    expect(onSubmit).toHaveBeenCalledWith("octo");

    type("octopus");
    expect(input()).toHaveValue("octopus");
    expect(searchUsers.mock.calls[0][1]?.signal?.aborted).toBe(true);
  });

  it("drops the answer to a query that is no longer current, even when it arrives last", async () => {
    const pending = new Map<string, (r: SearchAnswer) => void>();
    searchUsers.mockImplementation((q) => new Promise((resolve) => pending.set(q, resolve)));
    render(<Harness />);
    type("oc");
    await settle();
    type("octo");
    await settle();
    expect([...pending.keys()]).toEqual(["oc", "octo"]);
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

  it("never suggests the owner or someone already listed, and caps the list at eight", async () => {
    const many = Array.from({ length: 12 }, (_, i) => `octo${i}`);
    searchUsers.mockImplementation(() => answer("octocat", "Octodog", ...many));
    render(<Harness exclude={["OCTOCAT", "octodog"]} />);
    type("octo");
    await settle();
    expect(options()).toEqual(many.slice(0, 8));
  });

  it("↓/↑ move the active option (with wraparound), Home/End jump to the ends, Enter picks without submitting and hands off to onPick", async () => {
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
    expect(input().getAttribute("aria-activedescendant")).toBe(selected[0]!.id);

    fireEvent.keyDown(input(), { key: "ArrowDown" });
    fireEvent.keyDown(input(), { key: "ArrowDown" });
    fireEvent.keyDown(input(), { key: "ArrowDown" }); // wraps back to the first
    fireEvent.keyDown(input(), { key: "ArrowUp" }); // …and up wraps to the last
    selected = listOptions().filter((o) => o.getAttribute("aria-selected") === "true");
    expect(selected.map((o) => o.getAttribute("data-login"))).toEqual(["octofox"]);

    fireEvent.keyDown(input(), { key: "Home" });
    selected = listOptions().filter((o) => o.getAttribute("aria-selected") === "true");
    expect(selected.map((o) => o.getAttribute("data-login"))).toEqual(["octocat"]);
    fireEvent.keyDown(input(), { key: "End" });
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

  it("a held/repeated Enter after picking does not pick a second time: the next Enter submits the typed handle instead", async () => {
    searchUsers.mockImplementation(() => answer("octocat", "octodog"));
    const onPick = vi.fn();
    const onSubmit = vi.fn();
    render(<Harness onPick={onPick} onSubmit={onSubmit} />);
    type("octo");
    await settle();
    fireEvent.keyDown(input(), { key: "ArrowDown" });

    const firstEnter = fireEvent.keyDown(input(), { key: "Enter" });
    expect(firstEnter).toBe(false); // picks: the form does not submit
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick).toHaveBeenCalledWith("octocat");
    expect(input().value).toBe("octocat");

    // A key-repeat (or a fast double press) lands with no option active: it must not pick again.
    const secondEnter = fireEvent.keyDown(input(), { key: "Enter" });
    expect(secondEnter).toBe(true); // nothing left to claim: the dialog's form submits the already-picked value
    expect(onPick).toHaveBeenCalledTimes(1);
    fireEvent.submit(input().closest("form")!);
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith("octocat");
  });

  it("Enter with no active option submits the typed handle; Escape closes only the list, then the dialog on the next press", async () => {
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
    // With the list already closed, Escape is left for the dialog to handle.
    expect(fireEvent.keyDown(input(), { key: "Escape" })).toBe(true);

    // ↓ reopens the list without another request; the arrows wrap, so one option is always active from here on.
    fireEvent.keyDown(input(), { key: "ArrowDown" });
    expect(options()).toEqual(["octocat"]);
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

  it("a click picks the option without stealing focus from the box first", async () => {
    searchUsers.mockImplementation(() => answer("octocat", "octodog"));
    const onPick = vi.fn();
    render(<Harness onPick={onPick} />);
    type("octo");
    await settle();
    const dog = listOptions()[1]!;
    expect(fireEvent.mouseDown(dog)).toBe(false); // focus stays in the box
    fireEvent.click(dog);
    expect(input().value).toBe("octodog");
    expect(onPick).toHaveBeenCalledWith("octodog");
    expect(screen.queryByTestId("share-login-suggestions")).toBeNull();
  });

  it("covers a just-picked option's footprint with a non-interactive shield, so a fast second click (a double-click or double-tap landing after the list already closed) does nothing instead of falling through to whatever is underneath", async () => {
    searchUsers.mockImplementation(() => answer("octocat", "octodog", "octofox"));
    const onPick = vi.fn();
    render(<Harness onPick={onPick} />);
    type("octo");
    await settle();
    expect(options()).toEqual(["octocat", "octodog", "octofox"]);

    fireEvent.click(listOptions()[1]!); // middle option
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick).toHaveBeenCalledWith("octodog");
    expect(input().value).toBe("octodog");
    expect(screen.queryByTestId("share-login-suggestions")).toBeNull();

    const shield = screen.getByTestId("share-login-shield");
    expect(shield).toHaveAttribute("aria-hidden", "true");
    // The shield shows the same three rows the real list just had, so the click lands on familiar content.
    expect(within(shield).getAllByText(/^@octo/).map((el) => el.textContent)).toEqual(["@octocat", "@octodog", "@octofox"]);

    // The fast second click/tap of the double click, landing on the shield instead of the real list. Its own
    // mousedown does not move focus either, same as a real option's.
    expect(fireEvent.mouseDown(within(shield).getByText("@octofox"))).toBe(false);
    fireEvent.click(within(shield).getByText("@octofox"));
    expect(onPick).toHaveBeenCalledTimes(1); // absorbed: nothing picked a second time
    expect(input().value).toBe("octodog"); // the field still holds the first pick, untouched

    // After the shield window elapses on its own, it is gone and the real list stays closed.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SHIELD_MS);
    });
    expect(screen.queryByTestId("share-login-shield")).toBeNull();
    expect(screen.queryByTestId("share-login-suggestions")).toBeNull();
  });

  it("an Enter pick never shows the click shield - a keyboard pick has no second click to absorb", async () => {
    searchUsers.mockImplementation(() => answer("octocat", "octodog"));
    render(<Harness />);
    type("octo");
    await settle();
    fireEvent.keyDown(input(), { key: "ArrowDown" });
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(input().value).toBe("octocat");
    expect(screen.queryByTestId("share-login-suggestions")).toBeNull();
    expect(screen.queryByTestId("share-login-shield")).toBeNull();
  });

  it("ends the click-shield as soon as the pointer leaves it, instead of waiting the full window", async () => {
    searchUsers.mockImplementation(() => answer("octocat"));
    render(<Harness />);
    type("octo");
    await settle();
    fireEvent.click(listOptions()[0]!);
    const shield = screen.getByTestId("share-login-shield");
    fireEvent.pointerLeave(shield);
    expect(screen.queryByTestId("share-login-shield")).toBeNull();
  });

  it("falls back to initials when a suggestion's avatar fails to load", async () => {
    searchUsers.mockImplementation(() => answer("octocat"));
    render(<Harness />);
    type("octo");
    await settle();
    const row = listOptions()[0]!;
    const image = row.querySelector("img")!;
    fireEvent.error(image);
    expect(row.querySelector("img")).toHaveAttribute("hidden");
    expect(within(row).getByText("OC")).toBeInTheDocument();
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
    expect(within(screen.getByRole("alert")).getByRole("button", { name: "Retrying…" })).toBeDisabled();

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

    await act(async () => {
      retried.resolve({ users: [user("octocat"), user("octodog")], limited: false });
    });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(options()).toEqual(["octocat", "octodog"]);
    expect(input()).toHaveAttribute("aria-expanded", "true");
  });

  it("after the route answers reason=no-github-token it asks no more while mounted: no hint, the box still types", async () => {
    searchUsers.mockImplementation(() => Promise.resolve({ users: [], limited: false, reason: "no-github-token" as const }));
    render(<Harness />);
    type("oc");
    await settle();
    expect(searchUsers).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("share-login-suggestions")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByText(/limit|token|GitHub/i)).toBeNull();

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

  it("aborts a pending answer on unmount and never applies it afterward", async () => {
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

  it("hides the list on blur, and a late answer that arrives while unfocused does not reopen it", async () => {
    const pending = deferred<SearchAnswer>();
    searchUsers.mockReturnValue(pending.promise);
    render(<Harness />);
    type("octo");
    await settle();

    fireEvent.blur(input());
    expect(screen.queryByTestId("share-login-suggestions")).toBeNull();
    await act(async () => {
      pending.resolve({ users: [user("octocat")], limited: false });
    });
    expect(screen.queryByTestId("share-login-suggestions")).toBeNull();
    // Refocusing shows what the (now-settled) answer actually contained.
    fireEvent.focus(input());
    expect(options()).toEqual(["octocat"]);
  });

  describe("typing a full handle key by key (issue #2244)", () => {
    /** The dialog's real surface: a plain controlled box, rendered under StrictMode so any double-invocation bug shows up. */
    function TypingHarness({ onValues }: { onValues: (values: string[]) => void }) {
      const [login, setLogin] = useState("");
      const values = useRef<string[]>([]);
      return (
        <CollaboratorLoginInput
          value={login}
          onChange={(next) => {
            values.current = [...values.current, next];
            onValues(values.current);
            setLogin(next);
          }}
          exclude={[]}
        />
      );
    }

    it("accepts every keystroke of a real handle with no dropped characters and no Maximum update depth error", async () => {
      vi.useRealTimers();
      searchUsers.mockImplementation(() => answer("octocat"));
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const typed = "zz-nobody";
      let values: string[] = [];
      const typingUser = userEvent.setup();

      render(
        <StrictMode>
          <TypingHarness onValues={(v) => (values = v)} />
        </StrictMode>,
      );
      const box = screen.getByTestId("share-login");

      await typingUser.type(box, typed);

      expect(box).toHaveValue(typed);
      expect(values).toEqual(Array.from({ length: typed.length }, (_, i) => typed.slice(0, i + 1)));
      const loopErrors = errorSpy.mock.calls.filter(
        ([message]) => typeof message === "string" && message.includes("Maximum update depth exceeded"),
      );
      expect(loopErrors).toEqual([]);

      await waitFor(() => expect(searchUsers).toHaveBeenCalled());
      errorSpy.mockRestore();
    });
  });
});
