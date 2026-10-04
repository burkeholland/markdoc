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
import { CollaboratorLoginInput, SHIELD_MS, SUGGEST_DEBOUNCE_MS, isValidLogin, suggestQuery, type CollaboratorLoginInputHandle } from "./collaborator-login-input";

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

  // The server drops one leading @ before it measures the handle (#2252 item 2), so the @ never counts here either.
  // src/app/api/documents/collaborators.test.ts runs the same handles through the route and through this function.
  it("does not count one leading @ toward the 39 characters, and allows only one", () => {
    expect(isValidLogin(`@${"a".repeat(39)}`)).toBe(true);
    expect(isValidLogin(`@${"a".repeat(40)}`)).toBe(false);
    expect(isValidLogin("@")).toBe(false);
    expect(isValidLogin("@@name")).toBe(false);
    expect(isValidLogin("@ name")).toBe(false);
    expect(isValidLogin("trailing-space ")).toBe(true);
    expect(isValidLogin("UPPER-Case")).toBe(true);
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

    // The close is deferred a macrotask past blur (see handleBlur) so a Tab/click's own focus-move finishes
    // first; `settle(0)` flushes that timer here, same as a real blur followed by a beat with nothing refocused.
    fireEvent.blur(input());
    await settle(0);
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

  it("a keystroke that changes the query and an immediate Enter land in the same tick: the stale option is never picked", async () => {
    // The effect that would (asynchronously) clear the active option and the fetched list for the old query
    // has not run yet when Enter fires here - both events are dispatched inside one `act()`, so React defers
    // that passive effect until after both have already been processed, the same way a real browser can
    // deliver a keydown before React's next effect-flush task runs. What must stop the stale pick is the
    // render-time `candidates` derivation (gated on the fetched answer's query still matching what's typed
    // now), not the effect - this is exactly the "type past a highlighted suggestion" race from #2244's review.
    searchUsers.mockImplementation((q) => (q === "octop" ? answer("octopus", "octopi", "octoprint") : answer()));
    const onPick = vi.fn();
    const onSubmit = vi.fn();
    render(<Harness onPick={onPick} onSubmit={onSubmit} />);
    type("octop");
    await settle();
    expect(options()).toEqual(["octopus", "octopi", "octoprint"]);

    fireEvent.keyDown(input(), { key: "ArrowDown" });
    expect(input().getAttribute("aria-activedescendant")).toMatch(/-option-0$/);

    act(() => {
      fireEvent.change(input(), { target: { value: "octopx" } });
      fireEvent.keyDown(input(), { key: "Enter" });
    });

    // The typed text stands, nothing was picked, and the stale activedescendant is gone immediately -
    // all in the very render that processed the new value, before any effect for "octopx" has run.
    expect(input().value).toBe("octopx");
    expect(input()).not.toHaveAttribute("aria-activedescendant");
    expect(onPick).not.toHaveBeenCalled();

    fireEvent.submit(input().closest("form")!);
    expect(onSubmit).toHaveBeenCalledWith("octopx");
    expect(onSubmit).not.toHaveBeenCalledWith("octopus");
  });

  it("shrinking back to an already-cached query with an option active elsewhere: Enter submits the typed text, not a stale pick (#2244 review)", async () => {
    // "octo" is fetched and cached first, then "octop" is fetched and cached too, and an option of "octop"'s
    // list is made active. Backspacing to "octo" renders "octo"'s cached list on this very render (the cache
    // fallback in `candidates`), before the effect that would reset the active index for a new query has run -
    // the same one-render gap as the test above, just by shrinking back to a *different*, already-answered
    // query instead of typing further into a new one. The stale index (valid for "octop"'s list) must not be
    // read as still active just because it also happens to be in bounds for "octo"'s list.
    searchUsers.mockImplementation((q) => (q === "octop" ? answer("octopus", "octopod", "octoprint") : answer("octocat", "octodog", "octofox")));
    const onPick = vi.fn();
    const onSubmit = vi.fn();
    render(<Harness onPick={onPick} onSubmit={onSubmit} />);
    type("octo");
    await settle();
    expect(options()).toEqual(["octocat", "octodog", "octofox"]);

    type("octop");
    await settle();
    expect(options()).toEqual(["octopus", "octopod", "octoprint"]);

    fireEvent.keyDown(input(), { key: "ArrowDown" });
    expect(input().getAttribute("aria-activedescendant")).toMatch(/-option-0$/);

    act(() => {
      fireEvent.change(input(), { target: { value: "octo" } });
      fireEvent.keyDown(input(), { key: "Enter" });
    });

    expect(input().value).toBe("octo");
    expect(input()).not.toHaveAttribute("aria-activedescendant");
    expect(onPick).not.toHaveBeenCalled();

    fireEvent.submit(input().closest("form")!);
    expect(onSubmit).toHaveBeenCalledWith("octo");
    expect(onSubmit).not.toHaveBeenCalledWith("octocat");
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

  it("Enter with the list OPEN and no active option submits the typed handle (not just once the list is closed)", async () => {
    searchUsers.mockImplementation(() => answer("octocat", "octodog"));
    const onPick = vi.fn();
    const onSubmit = vi.fn();
    render(<Harness onPick={onPick} onSubmit={onSubmit} />);
    type("octo");
    await settle();
    // The list is still open and nothing is active - no arrow key was pressed.
    expect(options()).toEqual(["octocat", "octodog"]);
    expect(listOptions().filter((o) => o.getAttribute("aria-selected") === "true")).toHaveLength(0);

    const submitted = fireEvent.keyDown(input(), { key: "Enter" });
    expect(submitted).toBe(true); // not claimed by the list: the dialog's form submits the typed handle
    expect(onPick).not.toHaveBeenCalled();
    fireEvent.submit(input().closest("form")!);
    expect(onSubmit).toHaveBeenCalledWith("octo");
  });

  it("that Enter closes the list, so what the dialog answers under the field is not hidden behind it; ArrowDown shows it again without asking (#2252)", async () => {
    searchUsers.mockImplementation(() => answer("octocat", "octodog"));
    render(<Harness />);
    type("octo");
    await settle();
    expect(input()).toHaveAttribute("aria-expanded", "true");

    fireEvent.keyDown(input(), { key: "Enter" });
    expect(screen.queryByTestId("share-login-suggestions")).toBeNull();
    expect(input()).toHaveAttribute("aria-expanded", "false");
    expect(input().value).toBe("octo"); // the typed handle stays as typed
    expect(input()).toHaveFocus();

    // The suggestions are still there for the asking, and typing on brings a list back as before.
    fireEvent.keyDown(input(), { key: "ArrowDown" });
    expect(options()).toEqual(["octocat", "octodog"]);
    expect(listOptions()[0]).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(input(), { key: "Escape" });
    type("octoc");
    await settle();
    expect(options()).toEqual(["octocat", "octodog"]);
    expect(searchUsers).toHaveBeenCalledTimes(2);
  });

  it("lets the dialog put focus in the field through its ref", () => {
    function WithRef() {
      const handle = useRef<CollaboratorLoginInputHandle>(null);
      return (
        <>
          <CollaboratorLoginInput ref={handle} value="" onChange={() => {}} exclude={[]} />
          <button type="button" onClick={() => handle.current?.focus()}>
            Focus the field
          </button>
        </>
      );
    }
    render(<WithRef />);
    expect(input()).not.toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Focus the field" }));
    expect(input()).toHaveFocus();
  });

  describe("a key pressed in the first moments after the list appears (#2252 item 3)", () => {
    /**
     * In a browser the answer arrives outside any event: React commits the list in one task and runs that
     * commit's effects in a later one, a few ms apart. A key can land in between. `act()` would run both in
     * one go, so this lets the answer land without it and presses the key from a MutationObserver, whose
     * callback runs right after the commit that added the list and before those effects.
     */
    async function pressWhenTheListAppears(key: string, strict: boolean) {
      vi.useRealTimers();
      const pending = deferred<SearchAnswer>();
      searchUsers.mockReturnValue(pending.promise);
      const box = <Harness />;
      render(strict ? <StrictMode>{box}</StrictMode> : box);
      type("octo");
      await waitFor(() => expect(searchUsers).toHaveBeenCalledTimes(1));

      let pressed = false;
      const observer = new MutationObserver(() => {
        if (pressed || !screen.queryByTestId("share-login-suggestions")) return;
        pressed = true;
        // A plain DOM event, not fireEvent: fireEvent wraps the dispatch in act().
        input().dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
      });
      observer.observe(document.body, { childList: true, subtree: true });
      const environment = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
      const before = environment.IS_REACT_ACT_ENVIRONMENT;
      environment.IS_REACT_ACT_ENVIRONMENT = false; // these updates are meant to happen outside act()
      try {
        pending.resolve({ users: [user("octocat"), user("octodog"), user("octofox")], limited: false });
        await vi.waitFor(() => expect(pressed).toBe(true));
        // Let the effects of the list's commit (and anything they schedule) run.
        await new Promise((resolve) => setTimeout(resolve, 50));
      } finally {
        observer.disconnect();
        environment.IS_REACT_ACT_ENVIRONMENT = before;
      }
    }

    it.each([false, true])("ArrowDown keeps the highlight it set, and the next ArrowDown moves on from it (StrictMode: %s)", async (strict) => {
      await pressWhenTheListAppears("ArrowDown", strict);
      expect(options()).toEqual(["octocat", "octodog", "octofox"]);
      expect(listOptions()[0]).toHaveAttribute("aria-selected", "true");
      expect(input().getAttribute("aria-activedescendant")).toBe(listOptions()[0]!.id);

      fireEvent.keyDown(input(), { key: "ArrowDown" });
      expect(listOptions().map((o) => o.getAttribute("aria-selected"))).toEqual(["false", "true", "false"]);
    });

    it.each([false, true])("End keeps its highlight too, and Enter then picks that option (StrictMode: %s)", async (strict) => {
      await pressWhenTheListAppears("End", strict);
      expect(listOptions()[2]).toHaveAttribute("aria-selected", "true");
      fireEvent.keyDown(input(), { key: "Enter" });
      expect(input().value).toBe("octofox");
    });

    it("a new query still starts with nothing highlighted", async () => {
      await pressWhenTheListAppears("ArrowDown", false);
      vi.useFakeTimers();
      searchUsers.mockImplementation(() => answer("octopus", "octopod"));
      type("octop");
      await settle();
      expect(options()).toEqual(["octopus", "octopod"]);
      expect(listOptions().filter((o) => o.getAttribute("aria-selected") === "true")).toHaveLength(0);
      expect(input()).not.toHaveAttribute("aria-activedescendant");
    });
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

  it("a bare mouseover with no real pointer movement never activates the option under it, so a resting pointer cannot steal Enter (measured on real Chromium: an option appearing under an already-resting pointer gets a synthetic mouseover/pointerover, never a mousemove/pointermove)", async () => {
    searchUsers.mockImplementation(() => answer("octocat", "octodog"));
    render(<Harness />);
    type("octo");
    await settle();
    const cat = listOptions()[0]!;
    fireEvent.mouseOver(cat); // the synthetic hover a resting pointer gets when a new option renders under it
    expect(cat).toHaveAttribute("aria-selected", "false");
    expect(input()).not.toHaveAttribute("aria-activedescendant");
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(input().value).toBe("octo"); // the typed text — nothing was ever active to pick
  });

  it("a real mousemove onto an option still highlights it, so genuine pointer movement can still be picked with Enter (the fix narrows what activates an option, it does not remove hover)", async () => {
    searchUsers.mockImplementation(() => answer("octocat", "octodog"));
    render(<Harness />);
    type("octo");
    await settle();
    const dog = listOptions()[1]!;
    fireEvent.mouseMove(dog, { clientX: 40, clientY: 90 });
    expect(dog).toHaveAttribute("aria-selected", "true");
    expect(input()).toHaveAttribute("aria-activedescendant", dog.id);
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(input().value).toBe("octodog");
  });

  it("a repeated mousemove at the exact same coordinates (e.g. a re-render under a pointer that never actually moved) does not re-activate an option that something else made active since", async () => {
    searchUsers.mockImplementation(() => answer("octocat", "octodog"));
    render(<Harness />);
    type("octo");
    await settle();
    const [cat, dog] = listOptions();
    fireEvent.mouseMove(cat!, { clientX: 10, clientY: 20 }); // real movement onto the first option
    expect(cat).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(input(), { key: "ArrowDown" }); // moves the active option to the second, away from the pointer
    expect(dog).toHaveAttribute("aria-selected", "true");
    fireEvent.mouseMove(cat!, { clientX: 10, clientY: 20 }); // same coordinates the pointer already sat at
    expect(dog).toHaveAttribute("aria-selected", "true"); // unchanged: no real movement happened here
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

  it("ends the click-shield as soon as a mouse pointer leaves it, instead of waiting the full window", async () => {
    searchUsers.mockImplementation(() => answer("octocat"));
    render(<Harness />);
    type("octo");
    await settle();
    fireEvent.click(listOptions()[0]!);
    const shield = screen.getByTestId("share-login-shield");
    fireEvent.pointerLeave(shield, { pointerType: "mouse" });
    expect(screen.queryByTestId("share-login-shield")).toBeNull();
  });

  it("a touch pointerleave does not end the click-shield early - only the SHIELD_MS window does", async () => {
    // A touch's own pointerup fires a pointerleave moments later (observed 13-30ms in real browsers), which would
    // otherwise end the shield while a fast triple-tap's third tap is still in flight, well inside SHIELD_MS.
    searchUsers.mockImplementation(() => answer("octocat"));
    render(<Harness />);
    type("octo");
    await settle();
    fireEvent.click(listOptions()[0]!);
    const shield = screen.getByTestId("share-login-shield");
    fireEvent.pointerLeave(shield, { pointerType: "touch" });
    expect(screen.queryByTestId("share-login-shield")).not.toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(SHIELD_MS);
    });
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

  it("shows the API reason after rejection, keeps exact-handle submission available, and guards one Retry (aria-disabled, not disabled, so it never loses focus) to a real empty result", async () => {
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
    expect(retry).not.toHaveAttribute("aria-disabled");
    expect(fireEvent.keyDown(input(), { key: "Enter" })).toBe(true);
    fireEvent.submit(input().closest("form")!);
    expect(onSubmit).toHaveBeenCalledWith("octo");

    fireEvent.click(retry);
    expect(searchUsers).toHaveBeenCalledTimes(2);
    const retrying = within(screen.getByRole("alert")).getByRole("button", { name: "Retrying…" });
    // Not the native `disabled` attribute: disabling the focused button would drop focus to <body>.
    expect(retrying).not.toBeDisabled();
    expect(retrying).toHaveAttribute("aria-disabled", "true");
    expect(retrying).toHaveAttribute("aria-busy", "true");

    // A second click while the first retry is still in flight is ignored - one request, not two.
    fireEvent.click(retrying);
    expect(searchUsers).toHaveBeenCalledTimes(2);

    await act(async () => {
      retried.resolve({ users: [], limited: false });
    });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByTestId("share-login-suggestions")).toBeNull();
    expect(input().value).toBe("octo");
  });

  it("turns a limited response into truthful feedback and one Retry that restores populated suggestions, moving focus back to the handle field", async () => {
    const retried = deferred<SearchAnswer>();
    searchUsers.mockResolvedValueOnce({ users: [], limited: true }).mockReturnValueOnce(retried.promise);
    render(<Harness />);

    type("octo");
    await settle();
    expect(screen.getByRole("alert")).toHaveTextContent("GitHub suggestions for @octo are temporarily unavailable.");
    const retry = screen.getByRole("button", { name: "Retry" });
    // A real click focuses the button first (native default action); fireEvent.click alone doesn't move
    // jsdom's document.activeElement the way a real browser click does, so this mirrors it explicitly.
    retry.focus();
    fireEvent.click(retry);
    expect(searchUsers).toHaveBeenCalledTimes(2);

    await act(async () => {
      retried.resolve({ users: [user("octocat"), user("octodog")], limited: false });
    });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(options()).toEqual(["octocat", "octodog"]);
    expect(input()).toHaveAttribute("aria-expanded", "true");
    // A successful manual retry hands focus back to the handle field, not leaving it on the (now gone) button.
    expect(input()).toHaveFocus();
  });

  it("a successful retry does not steal focus (or reopen the list) if the user moved on while it was in flight", async () => {
    const retried = deferred<SearchAnswer>();
    searchUsers.mockResolvedValueOnce({ users: [], limited: true }).mockReturnValueOnce(retried.promise);
    render(<Harness />);

    type("octo");
    await settle();
    const retry = screen.getByRole("button", { name: "Retry" });
    retry.focus();
    fireEvent.click(retry);
    expect(searchUsers).toHaveBeenCalledTimes(2);

    // The user doesn't wait around: they move on to the role select while the retry is still in flight.
    const roleSelect = screen.getByTestId("role");
    roleSelect.focus();
    expect(roleSelect).toHaveFocus();

    await act(async () => {
      retried.resolve({ users: [user("octocat"), user("octodog")], limited: false });
    });
    // Focus must stay exactly where the user left it - not yanked back to the field - and the list must
    // not reopen over whatever they're doing now.
    expect(roleSelect).toHaveFocus();
    expect(screen.queryByTestId("share-login-suggestions")).toBeNull();
  });

  it("a successful retry opens the list if the user has already moved focus back onto the handle field themselves, not just when focus never left Retry", async () => {
    const retried = deferred<SearchAnswer>();
    searchUsers.mockResolvedValueOnce({ users: [], limited: true }).mockReturnValueOnce(retried.promise);
    render(<Harness />);

    type("octo");
    await settle();
    const retry = screen.getByRole("button", { name: "Retry" });
    retry.focus();
    fireEvent.click(retry);
    expect(searchUsers).toHaveBeenCalledTimes(2);

    // The user doesn't wait on the (now-disabled-looking) Retry button - they click straight back into the
    // field themselves while the retry is still in flight.
    input().focus();
    expect(input()).toHaveFocus();

    await act(async () => {
      retried.resolve({ users: [user("octocat"), user("octodog")], limited: false });
    });
    // Focus was already right where the user put it; the list should still open with the answer instead of
    // silently discarding it just because focus isn't on the (now-unmounted) Retry button anymore. There is no
    // dedicated branch for this: a successful lookup's cache write re-runs the query-debounce effect (which
    // depends on `cache`), and that effect's own cache-hit path calls `setOpen(focusedRef.current)` - this test
    // guards that interaction, not a specific line (proved by temporarily dropping `cache` from that effect's
    // dependency array, which reliably fails this exact test).
    expect(input()).toHaveFocus();
    expect(options()).toEqual(["octocat", "octodog"]);
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

    // Deferred close (see handleBlur): settle(0) flushes the post-blur macrotask with nothing refocused.
    fireEvent.blur(input());
    await settle(0);
    expect(screen.queryByTestId("share-login-suggestions")).toBeNull();
    await act(async () => {
      pending.resolve({ users: [user("octocat")], limited: false });
    });
    expect(screen.queryByTestId("share-login-suggestions")).toBeNull();
    // Refocusing shows what the (now-settled) answer actually contained.
    fireEvent.focus(input());
    expect(options()).toEqual(["octocat"]);
  });

  it("keeps the listbox mounted through the instant of blur, and a quick refocus (e.g. Shift+Tab back in) cancels the deferred close (issue: Tab moved focus to the dialog container instead of the next control while the list was open)", async () => {
    searchUsers.mockImplementation(() => answer("octocat"));
    render(<Harness />);
    type("octo");
    await settle();
    expect(options()).toEqual(["octocat"]);

    // Blur alone must not synchronously unmount the listbox: a real Tab/click's own native focus-move is
    // still in flight at this instant, and unmounting here is what raced it and sent focus to the dialog's
    // own container instead of the next control (see handleBlur's comment).
    fireEvent.blur(input());
    expect(screen.queryByTestId("share-login-suggestions")).not.toBeNull();

    // A refocus before the deferred close's timer fires (Shift+Tab straight back in) must cancel it outright,
    // not just briefly reopen something that was already closing.
    fireEvent.focus(input());
    await settle(0);
    expect(options()).toEqual(["octocat"]);

    // With nothing refocused, the deferred close still actually happens once its macrotask runs.
    fireEvent.blur(input());
    await settle(0);
    expect(screen.queryByTestId("share-login-suggestions")).toBeNull();
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
