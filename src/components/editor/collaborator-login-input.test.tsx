// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";

const searchUsers = vi.fn<(q: string, init?: RequestInit) => Promise<{ users: { login: string; name: string | null; avatarUrl: string }[]; limited: boolean; reason?: "no-github-token" }>>();
vi.mock("@/lib/api", () => ({ api: { github: { searchUsers: (...args: [string, RequestInit?]) => searchUsers(...args) } } }));

import { CollaboratorLoginInput, SUGGEST_DEBOUNCE_MS, suggestQuery } from "./collaborator-login-input";

const user = (login: string) => ({ login, name: null, avatarUrl: `https://avatars.githubusercontent.com/${login}?s=40` });
const answer = (...logins: string[]) => Promise.resolve({ users: logins.map(user), limited: false });

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

  it("shows nothing — and no error — when GitHub is rate-limited or the request fails, and keeps working afterwards", async () => {
    searchUsers.mockImplementationOnce(() => Promise.resolve({ users: [], limited: true }));
    render(<Harness />);
    type("octo");
    await settle();
    expect(searchUsers).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("share-login-suggestions")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(input().value).toBe("octo");

    searchUsers.mockImplementationOnce(() => Promise.reject(new Error("network")));
    type("octop");
    await settle();
    expect(screen.queryByTestId("share-login-suggestions")).toBeNull();

    searchUsers.mockImplementation(() => answer("octopus"));
    type("octopu");
    await settle();
    expect(options()).toEqual(["octopus"]);
  });

  it("after the route answers reason=no-github-token it asks no more while mounted: one request for a whole share, no hint, the box still types (task #1481)", async () => {
    searchUsers.mockImplementation(() => Promise.resolve({ users: [], limited: false, reason: "no-github-token" as const }));
    render(<Harness />);
    type("oc");
    await settle();
    expect(searchUsers).toHaveBeenCalledTimes(1);
    expect(searchUsers.mock.calls[0][0]).toBe("oc");
    expect(screen.queryByTestId("share-login-suggestions")).toBeNull();
    // Nothing is said about it: no alert, no rate-limit style hint (the component has none), no stray text.
    expect(screen.queryByRole("alert")).toBeNull();
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

  it("a superseded no-github-token answer still settles it, and the in-flight later query shows nothing", async () => {
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
    await act(async () => {
      pending.get("octo")!({ users: [], limited: false, reason: "no-github-token" });
    });
    expect(screen.queryByTestId("share-login-suggestions")).toBeNull();
    type("octoc");
    await settle(SUGGEST_DEBOUNCE_MS * 2);
    expect(searchUsers).toHaveBeenCalledTimes(2);
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
});
