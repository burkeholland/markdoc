// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { StrictMode, useCallback, useLayoutEffect, useState, type ChangeEvent, type FocusEvent, type KeyboardEvent, type MouseEvent, type RefCallback } from "react";

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
import { CollaboratorLoginInput, SUGGEST_DEBOUNCE_MS, suggestQuery } from "./collaborator-login-input";

const user = (login: string) => ({
  login,
  name: null,
  avatarUrl: `https://avatars.githubusercontent.com/${login}?s=40`,
});
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

function ExactValueHarness({ onChange, onPick }: { onChange: (login: string) => void; onPick: (login: string) => void }) {
  const [login, setLogin] = useState("octocat");
  const change = useCallback(
    (next: string) => {
      onChange(next);
      setLogin(next);
    },
    [onChange],
  );
  return <CollaboratorLoginInput value={login} onChange={change} exclude={[]} onPick={onPick} />;
}

function DirectHarness({
  initialValue = "",
  onChange,
  onPick,
}: {
  initialValue?: string;
  onChange: (login: string) => void;
  onPick?: (login: string) => void;
}) {
  const [login, setLogin] = useState(initialValue);
  const change = useCallback(
    (next: string) => {
      onChange(next);
      setLogin(next);
    },
    [onChange],
  );
  return <CollaboratorLoginInput value={login} onChange={change} exclude={[]} onPick={onPick} />;
}

function KeyboardHarness({
  initialValue = "octo",
  onChange,
  onPick,
  onSubmit,
  onRoleChange,
  onDialogClose,
}: {
  initialValue?: string;
  onChange: (login: string) => void;
  onPick?: (login: string) => void;
  onSubmit?: (login: string) => void;
  onRoleChange?: (role: string) => void;
  onDialogClose?: () => void;
}) {
  return (
    <div
      data-testid="share-dialog-shell"
      onKeyDown={(event) => {
        if (event.key === "Escape" && !event.defaultPrevented) {
          onDialogClose?.();
        }
      }}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit?.(input().value);
        }}
      >
        <DirectHarness initialValue={initialValue} onChange={onChange} onPick={onPick} />
        <select
          aria-label="Role"
          defaultValue="editor"
          onChange={(event) => onRoleChange?.(event.currentTarget.value)}
        >
          <option value="editor">editor</option>
          <option value="commenter">commenter</option>
        </select>
        <button type="submit">Add</button>
      </form>
    </div>
  );
}

/**
 * Runs `onBoundary` from the parent's layout effect after a child query replacement or removal.
 * Promise settlements queued here happen before the retired child's passive cleanup.
 */
function BoundaryHarness({ value, present = true, boundary = 0, onBoundary }: { value: string; present?: boolean; boundary?: number; onBoundary?: () => void }) {
  useLayoutEffect(() => {
    if (boundary > 0) onBoundary?.();
  }, [boundary, onBoundary]);
  return present ? <CollaboratorLoginInput value={value} onChange={() => {}} exclude={[]} /> : null;
}

function AuthorityBoundary({
  instance,
  value,
  onChange,
  onPick,
  exclude,
  present = true,
  boundary = 0,
  onBoundary,
}: {
  instance: string;
  value: string;
  onChange: (value: string) => void;
  onPick?: (login: string) => void;
  exclude: string[];
  present?: boolean;
  boundary?: number;
  onBoundary?: () => void;
}) {
  useLayoutEffect(() => {
    if (boundary > 0) onBoundary?.();
  }, [boundary, onBoundary]);
  return present ? <CollaboratorLoginInput key={instance} value={value} onChange={onChange} onPick={onPick} exclude={exclude} /> : null;
}

type PendingSearch = {
  promise: Promise<SearchAnswer>;
  resolve: (value: SearchAnswer) => void;
  reject: (reason?: unknown) => void;
};

const boundarySettlements: {
  label: string;
  settle: (pending: PendingSearch) => void;
}[] = [
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
function keyboardEventImplementation(event: Event) {
  return Object.getOwnPropertySymbols(event)
    .map(
      (symbol) =>
        (event as unknown as Record<symbol, unknown>)[symbol],
    )
    .find(
      (
        candidate,
      ): candidate is {
        isTrusted: boolean;
        view: Window | null;
      } =>
        typeof candidate === "object" &&
        candidate !== null &&
        "isTrusted" in candidate &&
        typeof candidate.isTrusted === "boolean" &&
        "view" in candidate,
    );
}

function requiredKeyboardEventImplementation(event: Event) {
  const implementation = keyboardEventImplementation(event);
  if (!implementation) {
    throw new Error("The jsdom event implementation was unavailable");
  }
  return implementation;
}

function markKeyboardEventTrusted(event: Event) {
  const implementation = requiredKeyboardEventImplementation(event);
  const descriptor = Object.getOwnPropertyDescriptor(
    implementation,
    "isTrusted",
  );
  if (!descriptor?.writable) {
    throw new Error("Unable to set jsdom's internal event trust slot");
  }
  Object.defineProperty(implementation, "isTrusted", {
    configurable: true,
    enumerable: true,
    get: () => true,
    set: () => undefined,
  });
  if (!event.isTrusted) {
    throw new Error("The jsdom event trust slot did not update");
  }
}

const keyboardEvent = (
  target: HTMLElement,
  key: string,
  init: KeyboardEventInit = {},
  trusted = true,
) => {
  const ownerWindow = target.ownerDocument.defaultView;
  if (!ownerWindow) throw new Error("The keyboard target has no owner window");
  const { view: eventView, ...eventInit } = init;
  const event = new ownerWindow.KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    key,
    ...eventInit,
  });
  const implementation = requiredKeyboardEventImplementation(event);
  implementation.view =
    "view" in init ? (eventView ?? null) : ownerWindow;
  if (trusted) markKeyboardEventTrusted(event);
  return event;
};

const dispatchKeyDown = (
  target: HTMLElement,
  key: string,
  init: KeyboardEventInit = {},
  trusted = true,
) => {
  const event = keyboardEvent(target, key, init, trusted);
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
};

function reactHandler<T>(element: HTMLElement, name: string): T {
  const propsKey = Object.keys(element).find((key) => key.startsWith("__reactProps$"));
  if (!propsKey) throw new Error(`React props were not attached to ${element.tagName}`);
  const props = (element as unknown as Record<string, Record<string, unknown> | undefined>)[propsKey];
  const handler = props?.[name];
  if (typeof handler !== "function") throw new Error(`${name} was not attached to ${element.tagName}`);
  return handler as T;
}

function interceptReactHandler<E>(
  element: HTMLElement,
  name: string,
  invoke: (original: (event: E) => void, event: E) => void,
) {
  const propsKey = Object.keys(element).find((key) => key.startsWith("__reactProps$"));
  if (!propsKey) throw new Error(`React props were not attached to ${element.tagName}`);
  const record = element as unknown as Record<string, Record<string, unknown> | undefined>;
  const props = record[propsKey];
  const original = props?.[name];
  if (typeof original !== "function") throw new Error(`${name} was not attached to ${element.tagName}`);
  const intercepted = {
    ...props,
    [name]: (event: E) => invoke(original as (event: E) => void, event),
  };
  record[propsKey] = intercepted;
  return () => {
    if (record[propsKey] === intercepted) record[propsKey] = props;
  };
}

const REACT_KEY_PUBLIC_SCALARS = [
  "type",
  "nativeEvent",
  "target",
  "currentTarget",
  "eventPhase",
  "bubbles",
  "cancelable",
  "defaultPrevented",
  "isTrusted",
  "key",
  "code",
  "location",
  "locale",
  "charCode",
  "keyCode",
  "which",
  "detail",
  "timeStamp",
  "ctrlKey",
  "metaKey",
  "altKey",
  "shiftKey",
  "repeat",
  "isComposing",
  "view",
] as const;

const REACT_KEY_REQUIRED_METHODS = [
  "preventDefault",
  "isDefaultPrevented",
  "isPropagationStopped",
] as const;

function exposeReactKeyScalarsAsAccessors(event: object) {
  const record = event as Record<PropertyKey, unknown>;
  for (const property of REACT_KEY_PUBLIC_SCALARS) {
    let value = record[property];
    Object.defineProperty(event, property, {
      configurable: true,
      enumerable: true,
      get: () => value,
      set: (next) => {
        value = next;
      },
    });
  }
}

function isolateReactKeyWrapper(
  event: object,
  prototype: object | null,
  wrapMethods = false,
) {
  const record = event as Record<PropertyKey, unknown>;
  for (const property of REACT_KEY_REQUIRED_METHODS) {
    const original = record[property];
    if (typeof original !== "function") {
      throw new Error(`React ${property} was unavailable`);
    }
    Object.defineProperty(event, property, {
      configurable: true,
      enumerable: true,
      writable: true,
      value: wrapMethods
        ? function (this: object) {
            return Reflect.apply(original, this, []);
          }
        : original,
    });
  }
  Object.setPrototypeOf(event, prototype);
}

function alterNonPublicReactKeyFields(
  event: object,
  state: "absent" | "replaced" | "non-function",
) {
  const record = event as Record<PropertyKey, unknown>;
  for (const property of [
    "_reactName",
    "persist",
    "isPersistent",
    "stopPropagation",
  ]) {
    if (state === "absent") {
      Reflect.deleteProperty(event, property);
    } else {
      Object.defineProperty(event, property, {
        configurable: true,
        enumerable: true,
        writable: true,
        value:
          state === "replaced"
            ? property === "_reactName"
              ? Symbol("unrelated React name")
              : vi.fn()
            : null,
      });
    }
    expect(
      state === "absent"
        ? property in event
        : record[property] !== undefined,
    ).toBe(state !== "absent");
  }
}

type KeyDeliveryEvent = KeyboardEvent<HTMLInputElement | HTMLDivElement>;
type KeyBoundary = "root-capture" | "input-capture" | "input-bubble" | "root-bubble";
const KEY_BOUNDARIES: readonly KeyBoundary[] = [
  "root-capture",
  "input-capture",
  "input-bubble",
  "root-bubble",
];

function interceptKeyboardRoute(
  target: HTMLInputElement,
  invoke: (
    boundary: KeyBoundary,
    deliver: (event: KeyDeliveryEvent) => void,
    event: KeyDeliveryEvent,
  ) => void,
) {
  const root = target.parentElement;
  if (!root) throw new Error("The keyboard input root was unavailable");
  const restore = KEY_BOUNDARIES.map((boundary) =>
    interceptReactHandler<KeyDeliveryEvent>(
      boundary.startsWith("root") ? root : target,
      boundary.endsWith("capture") ? "onKeyDownCapture" : "onKeyDown",
      (deliver, event) => invoke(boundary, deliver, event),
    ),
  );
  return () => restore.toReversed().forEach((undo) => undo());
}

function independentKeyboardDelivery(
  source: KeyDeliveryEvent,
  wrapper: "plain" | "proxy" | "forwarding" = "plain",
) {
  const prototype = Object.create(null);
  const target = Object.create(prototype) as KeyDeliveryEvent;
  const event = wrapper === "proxy"
    ? new Proxy(target, {})
    : wrapper === "forwarding"
      ? Object.create(prototype) as KeyDeliveryEvent
      : target;
  const values = new Map<PropertyKey, unknown>();
  const original = source as unknown as Record<PropertyKey, unknown>;
  for (const property of REACT_KEY_PUBLIC_SCALARS) {
    values.set(property, original[property]);
  }
  const defaultQuery = vi.fn(function (this: object) {
    expect(this).toBe(event);
    return values.get("defaultPrevented");
  });
  const propagationQuery = vi.fn(function (this: object) {
    expect(this).toBe(event);
    return false;
  });
  const sourcePrevent = source.preventDefault;
  const preventDefault = vi.fn(function (this: object) {
    expect(this).toBe(event);
    // Keep React's enclosing form/dialog delivery in sync with this public wrapper.
    Reflect.apply(sourcePrevent, source, []);
    values.set("defaultPrevented", true);
    values.set("isDefaultPrevented", source.isDefaultPrevented);
  });
  values.set("preventDefault", preventDefault);
  values.set("isDefaultPrevented", defaultQuery);
  values.set("isPropagationStopped", propagationQuery);
  for (const property of [...REACT_KEY_PUBLIC_SCALARS, ...REACT_KEY_REQUIRED_METHODS]) {
    Object.defineProperty(target, property, {
      configurable: true,
      enumerable: true,
      get: () => values.get(property),
      set: (value) => values.set(property, value),
    });
    if (wrapper === "forwarding") {
      Object.defineProperty(event, property, {
        configurable: true,
        enumerable: true,
        get: () => Reflect.get(target, property),
        set: (value) => Reflect.set(target, property, value),
      });
    }
  }
  return { event, prototype, values, preventDefault, defaultQuery, propagationQuery };
}

function reactRef<T extends HTMLElement>(element: T, current = false): RefCallback<T> {
  type RefFiber = { ref?: unknown; memoizedProps?: unknown; alternate?: RefFiber | null };
  const fiberKey = Object.keys(element).find((key) => key.startsWith("__reactFiber$"));
  if (!fiberKey) throw new Error(`React fiber was not attached to ${element.tagName}`);
  let fiber = (element as unknown as Record<string, RefFiber | undefined>)[fiberKey];
  if (current) {
    const propsKey = Object.keys(element).find((key) => key.startsWith("__reactProps$"));
    if (!propsKey) throw new Error(`React props were not attached to ${element.tagName}`);
    const props = (element as unknown as Record<string, unknown>)[propsKey];
    if (fiber?.memoizedProps !== props) fiber = fiber?.alternate ?? undefined;
    if (fiber?.memoizedProps !== props) throw new Error(`The committed fiber was unavailable for ${element.tagName}`);
  }
  if (typeof fiber?.ref !== "function") throw new Error(`A callback ref was not attached to ${element.tagName}`);
  return fiber.ref as RefCallback<T>;
}

const mouseSource = (currentTarget: HTMLElement, preventDefault = vi.fn()) =>
  ({
    currentTarget,
    target: currentTarget,
    preventDefault,
  }) as unknown as MouseEvent<HTMLLIElement>;

const buttonMouseSource = (currentTarget: HTMLElement, preventDefault = vi.fn()) =>
  ({
    currentTarget,
    target: currentTarget,
    preventDefault,
  }) as unknown as MouseEvent<HTMLButtonElement>;

type DebounceTimerRecord = {
  callback: () => void;
  handle: ReturnType<typeof setTimeout>;
  pending: boolean;
  cleared: boolean;
};

function trackDebounceTimers(reuseHandle = false) {
  const records: DebounceTimerRecord[] = [];
  const nativeSetTimeout = globalThis.setTimeout.bind(globalThis);
  const nativeClearTimeout = globalThis.clearTimeout.bind(globalThis);
  const reused = 3102 as unknown as ReturnType<typeof setTimeout>;
  vi.spyOn(globalThis, "setTimeout").mockImplementation(((callback: TimerHandler, delay?: number, ...args: unknown[]) => {
    if (delay !== SUGGEST_DEBOUNCE_MS || typeof callback !== "function") return nativeSetTimeout(callback, delay, ...args);
    const record = {
      callback: () => callback(...args),
      handle: reuseHandle ? reused : ((3102 + records.length) as unknown as ReturnType<typeof setTimeout>),
      pending: true,
      cleared: false,
    };
    records.push(record);
    return record.handle;
  }) as typeof setTimeout);
  vi.spyOn(globalThis, "clearTimeout").mockImplementation((handle) => {
    const record = records.findLast((candidate) => candidate.pending && candidate.handle === handle);
    if (!record) {
      nativeClearTimeout(handle);
      return;
    }
    record.pending = false;
    record.cleared = true;
  });
  return {
    records,
    pending: () => records.filter((record) => record.pending),
    fire(record: DebounceTimerRecord) {
      record.callback();
    },
  };
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

  describe("native identity titles", () => {
    const firstIdentity = {
      ...user(`octocat-${"a".repeat(31)}`),
      name: `${'Ada <span data-person="north">Lovelace</span> & "Analyst" \'One\' '.repeat(4)}North`,
    };
    const secondIdentity = {
      ...user(`octodog-${"b".repeat(31)}`),
      name: `${'Grace <button title="south">Hopper</button> & "Admiral" \'Two\' '.repeat(4)}South`,
    };
    const focusable = "a[href], button, input, select, textarea, [tabindex], [contenteditable]";

    function expectIdentity(row: HTMLElement, candidate: SearchAnswer["users"][number]) {
      expect(row).toHaveAttribute("data-login", candidate.login);
      expect(row).toHaveAccessibleName(
        candidate.name ? `${candidate.name}@${candidate.login}` : `@${candidate.login}`,
      );
      expect(row.children).toHaveLength(candidate.name ? 3 : 2);
      expect(Array.from(row.querySelectorAll("*"), (element) => element.tagName)).toEqual(
        candidate.name
          ? ["SPAN", "SPAN", "SPAN", "IMG", "SPAN", "SPAN"]
          : ["SPAN", "SPAN", "SPAN", "IMG", "SPAN"],
      );
      expect(row.querySelectorAll(focusable)).toHaveLength(0);
      expect(row).not.toHaveAttribute("tabindex");
      expect(row.firstElementChild).toHaveAttribute("aria-hidden", "true");
      expect(row.querySelector(".avatar")).toHaveAttribute("title", candidate.login);
      expect(row.querySelector("img")).toHaveAttribute("src", candidate.avatarUrl);
      expect(row.querySelector("img")).toHaveAttribute("alt", candidate.login);
      if (candidate.name) {
        const name = row.children.item(1);
        expect(name?.textContent).toBe(candidate.name);
        expect(name).toHaveAttribute("title", candidate.name);
        expect(name).toHaveAttribute("class", "min-w-0 truncate text-[13px] text-ink");
        expect(name?.getAttributeNames().sort()).toEqual(["class", "title"]);
      }
      const login = row.lastElementChild;
      expect(login?.textContent).toBe(`@${candidate.login}`);
      expect(login).toHaveAttribute("title", `@${candidate.login}`);
      expect(login).toHaveAttribute(
        "class",
        `min-w-0 truncate ${candidate.name ? "text-xs text-ink-3" : "text-[13px] text-ink"}`,
      );
      expect(login?.getAttributeNames().sort()).toEqual(["class", "title"]);
    }

    it.each([
      { label: "first long name", candidate: firstIdentity },
      { label: "second long name", candidate: secondIdentity },
      { label: "null name", candidate: { ...firstIdentity, name: null } },
      { label: "empty name", candidate: { ...secondIdentity, name: "" } },
    ])("preserves literal text, hover highlighting, and one explicit pick for $label", async ({ candidate }) => {
      expect(candidate.login).toHaveLength(39);
      expect(suggestQuery(candidate.login)).toBe(candidate.login);
      if (candidate.name) expect(candidate.name.length).toBeGreaterThanOrEqual(200);
      searchUsers.mockResolvedValue({ users: [user("octo-other"), candidate], limited: false });
      const onChange = vi.fn();
      const onPick = vi.fn();
      const onSubmit = vi.fn();
      const rendered = render(
        <KeyboardHarness onChange={onChange} onPick={onPick} onSubmit={onSubmit} />,
      );
      const controls = Array.from(rendered.container.querySelectorAll(focusable));
      expect(controls).toHaveLength(3);
      input().focus();
      await settle();

      const list = screen.getByTestId("share-login-suggestions");
      const [other, row] = listOptions();
      const ids = listOptions().map((option) => option.id);
      expect(ids).toEqual([`${list.id}-option-0`, `${list.id}-option-1`]);
      expect(list.id).toBe(input().getAttribute("aria-controls"));
      expect(options()).toEqual(["octo-other", candidate.login]);
      expectIdentity(row, candidate);
      expect(other).toHaveAccessibleName("@octo-other");
      expect(listOptions().every((option) => option.getAttribute("aria-selected") === "false")).toBe(true);
      expect(input()).not.toHaveAttribute("aria-activedescendant");

      for (const label of Array.from(row.children).slice(1)) {
        fireEvent.mouseOver(label);
        expect(row).toHaveAttribute("aria-selected", "true");
        expect(row).toHaveClass("bg-surface-3");
        expect(other).toHaveAttribute("aria-selected", "false");
        expect(input()).toHaveAttribute("aria-activedescendant", row.id);
        expect(input()).toHaveFocus();
        expectIdentity(row, candidate);
        fireEvent.mouseOver(other);
        expect(other).toHaveAttribute("aria-selected", "true");
        expect(row).toHaveAttribute("aria-selected", "false");
        expect(input()).toHaveAttribute("aria-activedescendant", other.id);
      }
      await settle(1000);
      expect(listOptions().map((option) => option.id)).toEqual(ids);
      expect(listOptions()).toHaveLength(2);
      expect(Array.from(rendered.container.querySelectorAll(focusable))).toEqual(controls);
      expect(screen.queryByRole("tooltip")).toBeNull();
      expect(onChange).not.toHaveBeenCalled();
      expect(onPick).not.toHaveBeenCalled();
      expect(onSubmit).not.toHaveBeenCalled();
      expect(searchUsers.mock.calls.map(([query]) => query)).toEqual(["octo"]);

      const login = row.lastElementChild!;
      fireEvent.mouseOver(login);
      expect(fireEvent.mouseDown(login)).toBe(false);
      fireEvent.click(login);
      expect(input()).toHaveValue(candidate.login);
      expect(input()).toHaveFocus();
      expect(onChange).toHaveBeenCalledExactlyOnceWith(candidate.login);
      expect(onPick).toHaveBeenCalledExactlyOnceWith(candidate.login);
      expect(onSubmit).not.toHaveBeenCalled();
      expect(screen.queryByTestId("share-login-suggestions")).toBeNull();
      await settle(1000);
      expect(searchUsers).toHaveBeenCalledTimes(1);
    });

    it("follows same-login replacement, query cache reuse, removal, and a fresh reopening", async () => {
      const updatedIdentity = { ...firstIdentity, name: secondIdentity.name };
      const pendingUpdate = deferred<SearchAnswer>();
      searchUsers
        .mockResolvedValueOnce({ users: [firstIdentity], limited: false })
        .mockReturnValueOnce(pendingUpdate.promise)
        .mockResolvedValueOnce({ users: [secondIdentity], limited: false });
      const onChange = vi.fn();
      const onPick = vi.fn();
      const rendered = render(
        <DirectHarness initialValue="oc" onChange={onChange} onPick={onPick} />,
      );
      input().focus();
      await settle();
      const firstRow = listOptions()[0];
      const optionId = firstRow.id;
      expectIdentity(firstRow, firstIdentity);
      fireEvent.mouseOver(firstRow.lastElementChild!);
      expect(firstRow).toHaveAttribute("aria-selected", "true");

      type("octo");
      expect(screen.queryByTestId("share-login-suggestions")).toBeNull();
      expect(rendered.container.querySelectorAll("[title]")).toHaveLength(0);
      expect(input()).not.toHaveAttribute("aria-activedescendant");
      await settle();
      await act(async () => {
        pendingUpdate.resolve({ users: [updatedIdentity], limited: false });
      });
      expectIdentity(listOptions()[0], updatedIdentity);
      expect(listOptions()[0].id).toBe(optionId);
      expect(listOptions()[0]).toHaveAttribute("aria-selected", "false");
      expect(screen.queryByTitle(firstIdentity.name)).toBeNull();

      type("");
      expect(rendered.container.querySelectorAll("[title]")).toHaveLength(0);
      type("octo");
      await settle();
      expectIdentity(listOptions()[0], updatedIdentity);
      expect(listOptions()[0].id).toBe(optionId);
      fireEvent.blur(input());
      expect(rendered.container.querySelectorAll("[title]")).toHaveLength(0);
      fireEvent.focus(input());
      expectIdentity(listOptions()[0], updatedIdentity);
      expect(searchUsers.mock.calls.map(([query]) => query)).toEqual(["oc", "octo"]);

      type("octod");
      expect(rendered.container.querySelectorAll("[title]")).toHaveLength(0);
      await settle();
      expectIdentity(listOptions()[0], secondIdentity);
      expect(listOptions()[0].id).toBe(optionId);
      expect(screen.queryByTitle(`@${firstIdentity.login}`)).toBeNull();
      type("oc");
      await settle();
      expectIdentity(listOptions()[0], firstIdentity);
      expect(screen.queryByTitle(secondIdentity.name)).toBeNull();
      expect(searchUsers.mock.calls.map(([query]) => query)).toEqual(["oc", "octo", "octod"]);
      expect(onChange.mock.calls.map(([value]) => value)).toEqual(["octo", "", "octo", "octod", "oc"]);
      expect(onPick).not.toHaveBeenCalled();

      rendered.unmount();
      expect(screen.queryByTitle(firstIdentity.name)).toBeNull();
      const reopenedIdentity = { ...firstIdentity, name: "" };
      searchUsers.mockResolvedValueOnce({ users: [reopenedIdentity], limited: false });
      const reopenedChange = vi.fn();
      render(<DirectHarness initialValue="oc" onChange={reopenedChange} onPick={onPick} />);
      input().focus();
      await settle();
      const reopenedRow = listOptions()[0];
      expectIdentity(reopenedRow, reopenedIdentity);
      expect(screen.queryByTitle(firstIdentity.name)).toBeNull();
      expect(screen.queryByTitle(secondIdentity.name)).toBeNull();
      expect(reopenedRow).toHaveAttribute("aria-selected", "false");
      fireEvent.mouseOver(reopenedRow.lastElementChild!);
      expect(reopenedRow).toHaveAttribute("aria-selected", "true");
      expect(input()).toHaveAttribute("aria-activedescendant", reopenedRow.id);
      expect(reopenedChange).not.toHaveBeenCalled();
      expect(onPick).not.toHaveBeenCalled();
      expect(dispatchKeyDown(input(), "Enter").defaultPrevented).toBe(true);
      expect(reopenedChange).toHaveBeenCalledExactlyOnceWith(reopenedIdentity.login);
      expect(onPick).toHaveBeenCalledExactlyOnceWith(reopenedIdentity.login);
      expect(searchUsers.mock.calls.map(([query]) => query)).toEqual(["oc", "octo", "octod", "oc"]);
    });
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
    expect(dispatchKeyDown(input(), "Enter").defaultPrevented).toBe(false);
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
      pending.get("oc")!({
        users: [user("ocean"), user("ocelot")],
        limited: false,
      });
    });
    expect(options()).toEqual(["octocat"]);
  });

  it.each(boundarySettlements)("retires a pending $label at the query layout boundary", async ({ settle: settlePending }) => {
    const pending = deferred<SearchAnswer>();
    const replacement = deferred<SearchAnswer>();
    searchUsers
      .mockReturnValueOnce(pending.promise)
      .mockReturnValueOnce(replacement.promise)
      .mockImplementation(() => answer("ocean"));
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

    dispatchKeyDown(input(), "ArrowDown");
    let selected = listOptions().filter((o) => o.getAttribute("aria-selected") === "true");
    expect(selected.map((o) => o.getAttribute("data-login"))).toEqual(["octocat"]);
    expect(input().getAttribute("aria-activedescendant")).toBe(selected[0].id);

    dispatchKeyDown(input(), "ArrowDown");
    dispatchKeyDown(input(), "ArrowDown");
    dispatchKeyDown(input(), "ArrowDown"); // wraps back to the first
    dispatchKeyDown(input(), "ArrowUp"); // …and up wraps to the last
    selected = listOptions().filter((o) => o.getAttribute("aria-selected") === "true");
    expect(selected.map((o) => o.getAttribute("data-login"))).toEqual(["octofox"]);
    dispatchKeyDown(input(), "ArrowUp");
    dispatchKeyDown(input(), "ArrowUp");

    const notSubmitted = dispatchKeyDown(input(), "Enter");
    expect(notSubmitted.defaultPrevented).toBe(true); // preventDefault: the form does not submit
    expect(input().value).toBe("octocat");
    expect(onPick).toHaveBeenCalledWith("octocat");
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.queryByTestId("share-login-suggestions")).toBeNull();
    expect(input()).toHaveAttribute("aria-expanded", "false");
    // The picked login is not searched again.
    await settle(1000);
    expect(searchUsers).toHaveBeenCalledTimes(1);
  });

  it.each(["absent", "replaced", "non-function", "throwing"] as const)(
    "authenticates four independent accessor-backed keyboard deliveries with %s private members",
    async (privateMembers) => {
      searchUsers.mockImplementation(() => answer("octocat", "octodog", "octofox"));
      const onChange = vi.fn();
      const onPick = vi.fn();
      const onSubmit = vi.fn();
      const onRoleChange = vi.fn();
      const onDialogClose = vi.fn();
      render(
        <StrictMode>
          <KeyboardHarness
            onChange={onChange}
            onPick={onPick}
            onSubmit={onSubmit}
            onRoleChange={onRoleChange}
            onDialogClose={onDialogClose}
          />
        </StrictMode>,
      );
      const exactInput = input();
      exactInput.focus();
      await settle();
      const focus = vi.spyOn(window.HTMLElement.prototype, "focus");
      const nativePrevent = vi.spyOn(window.Event.prototype, "preventDefault");
      const nativeStop = vi.spyOn(window.Event.prototype, "stopPropagation");
      const forbiddenRead = vi.fn(() => { throw new Error("Private wrapper authority was read"); });
      const list = screen.getByTestId("share-login-suggestions");
      const scrollCalls = [
        vi.spyOn(window, "scrollTo"),
        vi.spyOn(window, "scrollBy"),
        ...[exactInput, list, ...listOptions()].flatMap((element) =>
          ["scrollTo", "scrollBy", "scrollIntoView"].map((method) => {
            const scroll = vi.fn();
            Object.defineProperty(element, method, { configurable: true, value: scroll });
            return scroll;
          }),
        ),
      ];
      document.documentElement.scrollTop = 31;
      list.scrollTop = 17;
      exactInput.setSelectionRange(1, 3);
      const setTimer = vi.spyOn(globalThis, "setTimeout");
      const clearTimer = vi.spyOn(globalThis, "clearTimeout");

      const dispatch = (key: string) => {
        const deliveries: ReturnType<typeof independentKeyboardDelivery>[] = [];
        const restore = interceptKeyboardRoute(exactInput, (_boundary, deliver, source) => {
          const delivery = independentKeyboardDelivery(source);
          deliveries.push(delivery);
          if (privateMembers === "throwing") {
            for (const property of ["_reactName", "persist", "isPersistent", "stopPropagation", "constructor"]) {
              Object.defineProperty(delivery.event, property, { get: forbiddenRead });
            }
          } else {
            alterNonPublicReactKeyFields(delivery.event, privateMembers);
          }
          deliver(delivery.event);
          delivery.values.set("currentTarget", null);
        });
        const native = dispatchKeyDown(exactInput, key);
        restore();
        expect(deliveries).toHaveLength(4);
        expect(new Set(deliveries.map(({ event }) => event)).size).toBe(4);
        expect(new Set(deliveries.map(({ prototype }) => prototype)).size).toBe(4);
        for (const method of REACT_KEY_REQUIRED_METHODS) {
          expect(new Set(deliveries.map(({ values }) => values.get(method))).size).toBe(4);
        }
        for (const delivery of deliveries.slice(0, 3)) {
          expect(delivery.preventDefault).not.toHaveBeenCalled();
        }
        expect(deliveries[3].preventDefault).toHaveBeenCalledOnce();
        expect(native.defaultPrevented).toBe(true);
        expect(forbiddenRead).not.toHaveBeenCalled();
        return native;
      };

      for (const [key, destination] of [
        ["ArrowDown", 0], ["ArrowDown", 1], ["ArrowDown", 2], ["ArrowDown", 0],
        ["ArrowUp", 2], ["ArrowUp", 1], ["ArrowUp", 0], ["ArrowUp", 2],
        ["Home", 0], ["End", 2],
      ] as const) {
        nativePrevent.mockClear();
        dispatch(key);
        expect(nativePrevent).toHaveBeenCalledOnce();
        expect(listOptions().filter((row) => row.getAttribute("aria-selected") === "true")).toEqual([listOptions()[destination]]);
        expect(exactInput).toHaveAttribute("aria-activedescendant", listOptions()[destination].id);
        expect(exactInput).toHaveFocus();
        expect([exactInput.selectionStart, exactInput.selectionEnd]).toEqual([1, 3]);
        expect(document.documentElement.scrollTop).toBe(31);
        expect(list.scrollTop).toBe(17);
      }
      nativePrevent.mockClear();
      dispatch("Escape");
      expect(nativePrevent).toHaveBeenCalledOnce();
      expect(screen.queryByTestId("share-login-suggestions")).toBeNull();
      expect(exactInput).toHaveValue("octo");
      expect(onChange).not.toHaveBeenCalled();
      expect(onPick).not.toHaveBeenCalled();
      expect(onSubmit).not.toHaveBeenCalled();
      expect(onRoleChange).not.toHaveBeenCalled();
      expect(onDialogClose).not.toHaveBeenCalled();
      expect(focus).not.toHaveBeenCalled();
      expect(nativeStop).not.toHaveBeenCalled();
      expect(setTimer).not.toHaveBeenCalled();
      expect(clearTimer).not.toHaveBeenCalled();
      scrollCalls.forEach((scroll) => expect(scroll).not.toHaveBeenCalled());
      expect(searchUsers).toHaveBeenCalledOnce();

      nativePrevent.mockClear();
      const nativeEnter = dispatchKeyDown(exactInput, "Enter");
      expect(nativeEnter.defaultPrevented).toBe(false);
      expect(nativePrevent).not.toHaveBeenCalled();
      fireEvent.submit(exactInput.closest("form")!);
      expect(onSubmit).toHaveBeenCalledExactlyOnceWith("octo");
      onSubmit.mockClear();
      dispatch("ArrowDown");
      nativePrevent.mockClear();
      dispatch("Enter");
      expect(nativePrevent).toHaveBeenCalledOnce();
      expect(exactInput).toHaveValue("octocat");
      expect(onChange).toHaveBeenCalledExactlyOnceWith("octocat");
      expect(onPick).toHaveBeenCalledExactlyOnceWith("octocat");
      expect(onSubmit).not.toHaveBeenCalled();
      expect(onRoleChange).not.toHaveBeenCalled();
      expect(onDialogClose).not.toHaveBeenCalled();
      expect(searchUsers).toHaveBeenCalledOnce();
      expect(setTimer).not.toHaveBeenCalled();
      expect(clearTimer).not.toHaveBeenCalled();
    },
  );

  it("accepts transparent proxies forwarding the actual React keyboard phase wrappers", async () => {
    searchUsers.mockImplementation(() => answer("octocat", "octodog"));
    const onChange = vi.fn();
    const onPick = vi.fn();
    render(<KeyboardHarness onChange={onChange} onPick={onPick} />);
    const exactInput = input();
    exactInput.focus();
    await settle();
    fireEvent.mouseOver(listOptions()[1]);
    const wrappers = new WeakMap<KeyDeliveryEvent, KeyDeliveryEvent>();
    const restore = interceptKeyboardRoute(exactInput, (_boundary, deliver, source) => {
      let wrapper = wrappers.get(source);
      if (!wrapper) {
        wrapper = new Proxy(source, {});
        wrappers.set(source, wrapper);
      }
      deliver(wrapper);
    });
    const nativePrevent = vi.spyOn(window.Event.prototype, "preventDefault");
    const event = dispatchKeyDown(exactInput, "Enter");
    restore();
    expect(event.defaultPrevented).toBe(true);
    expect(nativePrevent).toHaveBeenCalledOnce();
    expect(onChange).toHaveBeenCalledExactlyOnceWith("octodog");
    expect(onPick).toHaveBeenCalledExactlyOnceWith("octodog");
  });

  it.each(["proxy", "forwarding"] as const)(
    "accepts stable public keyboard %s wrappers without asserting React origin",
    async (wrapper) => {
      searchUsers.mockImplementation(() => answer("octocat", "octodog"));
      const onChange = vi.fn();
      const onPick = vi.fn();
      const onSubmit = vi.fn();
      render(<KeyboardHarness onChange={onChange} onPick={onPick} onSubmit={onSubmit} />);
      const exactInput = input();
      exactInput.focus();
      await settle();
      fireEvent.mouseOver(listOptions()[1]);
      const deliveries: ReturnType<typeof independentKeyboardDelivery>[] = [];
      const restore = interceptKeyboardRoute(exactInput, (_boundary, deliver, source) => {
        const delivery = independentKeyboardDelivery(source, wrapper);
        deliveries.push(delivery);
        deliver(delivery.event);
        delivery.values.set("currentTarget", null);
      });
      const nativePrevent = vi.spyOn(window.Event.prototype, "preventDefault");
      const event = dispatchKeyDown(exactInput, "Enter");
      restore();
      expect(event.defaultPrevented).toBe(true);
      expect(deliveries).toHaveLength(4);
      expect(nativePrevent).toHaveBeenCalledOnce();
      deliveries.slice(0, 3).forEach(({ preventDefault }) => expect(preventDefault).not.toHaveBeenCalled());
      expect(deliveries[3].preventDefault).toHaveBeenCalledOnce();
      expect(onChange).toHaveBeenCalledExactlyOnceWith("octodog");
      expect(onPick).toHaveBeenCalledExactlyOnceWith("octodog");
      expect(onSubmit).not.toHaveBeenCalled();
    },
  );

  it.each([
    { key: "ArrowDown", source: -1, destination: 0 },
    { key: "ArrowDown", source: 0, destination: 1 },
    { key: "ArrowDown", source: 1, destination: 2 },
    { key: "ArrowDown", source: 2, destination: 0 },
    { key: "ArrowUp", source: -1, destination: 2 },
    { key: "ArrowUp", source: 0, destination: 2 },
    { key: "ArrowUp", source: 1, destination: 0 },
    { key: "ArrowUp", source: 2, destination: 1 },
    { key: "Home", source: -1, destination: 0 },
    { key: "End", source: -1, destination: 2 },
  ])("moves $key from keyboard index $source to $destination once", async ({ key, source, destination }) => {
    searchUsers.mockImplementation(() => answer("octocat", "octodog", "octofox"));
    const onChange = vi.fn();
    const onPick = vi.fn();
    const onSubmit = vi.fn();
    render(<KeyboardHarness onChange={onChange} onPick={onPick} onSubmit={onSubmit} />);
    input().focus();
    await settle();
    if (source >= 0) fireEvent.mouseOver(listOptions()[source]);
    const nativePrevent = vi.spyOn(window.Event.prototype, "preventDefault");
    const event = dispatchKeyDown(input(), key);
    expect(event.defaultPrevented).toBe(true);
    expect(nativePrevent).toHaveBeenCalledOnce();
    expect(listOptions().filter((row) => row.getAttribute("aria-selected") === "true")).toEqual([listOptions()[destination]]);
    expect(onChange).not.toHaveBeenCalled();
    expect(onPick).not.toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(searchUsers).toHaveBeenCalledOnce();
  });

  it.each(KEY_BOUNDARIES)(
    "leaves the rightful %s keyboard delivery eligible after malformed, partial, and duplicate attempts",
    async (boundaryUnderTest) => {
      searchUsers.mockImplementation(() => answer("octocat", "octodog", "octofox"));
      const onChange = vi.fn();
      const onPick = vi.fn();
      render(<KeyboardHarness onChange={onChange} onPick={onPick} />);
      const exactInput = input();
      exactInput.focus();
      await settle();
      fireEvent.mouseOver(listOptions()[1]);
      const foreignInput = document.createElement("input");
      const foreignRoot = document.createElement("div");
      const root = exactInput.parentElement!;
      const partial = reactHandler<(event: KeyDeliveryEvent) => void>(root, "onKeyDown");
      const invalidPrevent = vi.fn();
      const throwingQuery = vi.fn(() => { throw new Error("Rejected public query"); });
      const throwingAccessor = vi.fn(() => { throw new Error("Rejected public accessor"); });
      let accepted: ReturnType<typeof independentKeyboardDelivery> | undefined;
      const restore = interceptKeyboardRoute(exactInput, (boundary, deliver, source) => {
        if (boundary === boundaryUnderTest) {
          for (const [property, value] of [
            ["target", foreignInput],
            ["currentTarget", boundary.startsWith("root") ? foreignRoot : foreignInput],
            ["eventPhase", boundary.endsWith("capture") ? 3 : 1],
            ["nativeEvent", keyboardEvent(exactInput, "Home")],
            ["key", 42],
            ["defaultPrevented", true],
            ["view", new Proxy(window, {})],
            ["isDefaultPrevented", () => true],
            ["isPropagationStopped", () => true],
            ["isDefaultPrevented", throwingQuery],
            ["preventDefault", null],
          ] as const) {
            const rejected = independentKeyboardDelivery(source);
            rejected.values.set("preventDefault", invalidPrevent);
            rejected.values.set(property, value);
            deliver(rejected.event);
          }
          const rejected = independentKeyboardDelivery(source);
          Object.defineProperty(rejected.event, "key", { get: throwingAccessor });
          deliver(rejected.event);
          if (boundary !== "root-bubble") partial(source);
        }
        const current = independentKeyboardDelivery(source);
        if (boundary === boundaryUnderTest) accepted = current;
        deliver(current.event);
        deliver(current.event);
        current.values.set("currentTarget", null);
      });
      const event = dispatchKeyDown(exactInput, "Home");
      restore();
      expect(event.defaultPrevented).toBe(true);
      expect(accepted).toBeDefined();
      expect(invalidPrevent).not.toHaveBeenCalled();
      expect(throwingQuery).toHaveBeenCalledOnce();
      expect(throwingAccessor).toHaveBeenCalled();
      expect(listOptions()[0]).toHaveAttribute("aria-selected", "true");
      expect(onChange).not.toHaveBeenCalled();
      expect(onPick).not.toHaveBeenCalled();
      expect(searchUsers).toHaveBeenCalledOnce();
    },
  );

  it.each(KEY_BOUNDARIES.flatMap((boundary) =>
    (["isDefaultPrevented", "isPropagationStopped"] as const).flatMap((query) =>
      REACT_KEY_REQUIRED_METHODS.map((replaced) => ({ boundary, query, replaced })),
    ),
  ))(
    "rejects keyboard $boundary $query replacing $replaced before another callback",
    async ({ boundary: affectedBoundary, query, replaced }) => {
      searchUsers.mockImplementation(() => answer("octocat", "octodog", "octofox"));
      const onChange = vi.fn();
      const onPick = vi.fn();
      render(<KeyboardHarness onChange={onChange} onPick={onPick} />);
      const exactInput = input();
      exactInput.focus();
      await settle();
      fireEvent.mouseOver(listOptions()[1]);
      const replacement = vi.fn(() => false);
      const nativePrevent = vi.spyOn(window.Event.prototype, "preventDefault");
      const restore = interceptKeyboardRoute(exactInput, (boundary, deliver, source) => {
        const delivery = independentKeyboardDelivery(source);
        if (boundary === affectedBoundary) {
          const retained = delivery.event[query];
          delivery.values.set(query, function (this: object) {
            const result = Reflect.apply(retained, this, []);
            delivery.values.set(replaced, replacement);
            return result;
          });
        }
        deliver(delivery.event);
        delivery.values.set("currentTarget", null);
      });
      const rejected = dispatchKeyDown(exactInput, "Enter");
      restore();
      expect(rejected.defaultPrevented).toBe(false);
      expect(nativePrevent).not.toHaveBeenCalled();
      expect(replacement).not.toHaveBeenCalled();
      expect(listOptions()[1]).toHaveAttribute("aria-selected", "true");
      expect(onChange).not.toHaveBeenCalled();
      expect(onPick).not.toHaveBeenCalled();
      const recovered = dispatchKeyDown(exactInput, "Enter");
      expect(recovered.defaultPrevented).toBe(true);
      expect(nativePrevent).toHaveBeenCalledOnce();
      expect(onChange).toHaveBeenCalledExactlyOnceWith("octodog");
      expect(onPick).toHaveBeenCalledExactlyOnceWith("octodog");
    },
  );

  it.each(KEY_BOUNDARIES.flatMap((boundary) =>
    (["isDefaultPrevented", "isPropagationStopped"] as const).map((query) => ({ boundary, query })),
  ))(
    "excludes reentry from every $boundary keyboard $query without poisoning the rightful route",
    async ({ boundary: affectedBoundary, query }) => {
      searchUsers.mockImplementation(() => answer("octocat", "octodog", "octofox"));
      const onChange = vi.fn();
      const onPick = vi.fn();
      const onSubmit = vi.fn();
      render(<KeyboardHarness onChange={onChange} onPick={onPick} onSubmit={onSubmit} />);
      const exactInput = input();
      exactInput.focus();
      await settle();
      fireEvent.mouseOver(listOptions()[1]);
      const nativePrevent = vi.spyOn(window.Event.prototype, "preventDefault");
      let reentries = 0;
      const restore = interceptKeyboardRoute(exactInput, (boundary, deliver, source) => {
        const delivery = independentKeyboardDelivery(source);
        if (boundary === affectedBoundary) {
          const retained = delivery.event[query];
          delivery.values.set(query, function (this: object) {
            reentries++;
            deliver(delivery.event);
            return Reflect.apply(retained, this, []);
          });
        }
        deliver(delivery.event);
        delivery.values.set("currentTarget", null);
      });
      const accepted = dispatchKeyDown(exactInput, "Enter");
      restore();
      expect(reentries).toBeGreaterThan(0);
      expect(accepted.defaultPrevented).toBe(true);
      expect(nativePrevent).toHaveBeenCalledOnce();
      expect(onChange).toHaveBeenCalledExactlyOnceWith("octodog");
      expect(onPick).toHaveBeenCalledExactlyOnceWith("octodog");
      expect(onSubmit).not.toHaveBeenCalled();
      expect(searchUsers).toHaveBeenCalledOnce();
    },
  );

  it.each(KEY_BOUNDARIES)(
    "excludes distinct-wrapper keyboard entry reentry at %s before nativeEvent is read",
    async (affectedBoundary) => {
      searchUsers.mockImplementation(() => answer("octocat", "octodog", "octofox"));
      const onChange = vi.fn();
      const onPick = vi.fn();
      const onSubmit = vi.fn();
      const onRoleChange = vi.fn();
      render(<KeyboardHarness onChange={onChange} onPick={onPick} onSubmit={onSubmit} onRoleChange={onRoleChange} />);
      const exactInput = input();
      exactInput.focus();
      await settle();
      fireEvent.mouseOver(listOptions()[1]);
      const nativePrevent = vi.spyOn(window.Event.prototype, "preventDefault");
      const setTimer = vi.spyOn(globalThis, "setTimeout");
      const clearTimer = vi.spyOn(globalThis, "clearTimeout");
      const scrollCalls = [
        vi.spyOn(window, "scrollTo"),
        vi.spyOn(window, "scrollBy"),
        ...[exactInput, screen.getByTestId("share-login-suggestions"), ...listOptions()].flatMap((element) =>
          ["scrollTo", "scrollBy", "scrollIntoView"].map((method) => {
            const scroll = vi.fn();
            Object.defineProperty(element, method, { configurable: true, value: scroll });
            return scroll;
          }),
        ),
      ];
      const deliveries: ReturnType<typeof independentKeyboardDelivery>[] = [];
      let nested: ReturnType<typeof independentKeyboardDelivery> | undefined;
      let nestedRead: ReturnType<typeof vi.fn> | undefined;
      let nestedPrevent: ReturnType<typeof vi.fn> | undefined;
      let attempted = false;
      const restore = interceptKeyboardRoute(exactInput, (boundary, deliver, source) => {
        const delivery = independentKeyboardDelivery(source);
        deliveries.push(delivery);
        if (boundary === affectedBoundary) {
          const native = source.nativeEvent;
          const inner = independentKeyboardDelivery(source);
          nested = inner;
          const read = vi.fn(() => native);
          nestedRead = read;
          nestedPrevent = vi.fn(function (this: object) {
            Reflect.apply(inner.preventDefault, this, []);
            throw new Error("Nested prevention must not cancel the rightful Enter");
          });
          inner.values.set("preventDefault", nestedPrevent);
          Object.defineProperty(inner.event, "nativeEvent", { get: read });
          Object.defineProperty(delivery.event, "nativeEvent", {
            get: () => {
              if (!attempted) {
                attempted = true;
                deliver(inner.event);
                // A rejected nested call must not clear the outer call's exclusion.
                deliver(inner.event);
              }
              return native;
            },
          });
        }
        deliver(delivery.event);
        delivery.values.set("currentTarget", null);
      });
      let accepted: globalThis.KeyboardEvent;
      try {
        accepted = dispatchKeyDown(exactInput, "Enter");
      } finally {
        restore();
      }
      expect(attempted).toBe(true);
      expect(deliveries).toHaveLength(4);
      expect(nestedRead).not.toHaveBeenCalled();
      expect(nestedPrevent).not.toHaveBeenCalled();
      expect(nested!.defaultQuery).not.toHaveBeenCalled();
      expect(nested!.propagationQuery).not.toHaveBeenCalled();
      expect(nested!.preventDefault).not.toHaveBeenCalled();
      deliveries.slice(0, 3).forEach(({ preventDefault }) => expect(preventDefault).not.toHaveBeenCalled());
      expect(deliveries[3].preventDefault).toHaveBeenCalledOnce();
      expect(accepted.defaultPrevented).toBe(true);
      expect(nativePrevent).toHaveBeenCalledOnce();
      expect(onChange).toHaveBeenCalledExactlyOnceWith("octodog");
      expect(onPick).toHaveBeenCalledExactlyOnceWith("octodog");
      expect(onSubmit).not.toHaveBeenCalled();
      expect(onRoleChange).not.toHaveBeenCalled();
      expect(searchUsers).toHaveBeenCalledOnce();
      expect(setTimer).not.toHaveBeenCalled();
      expect(clearTimer).not.toHaveBeenCalled();
      scrollCalls.forEach((scroll) => expect(scroll).not.toHaveBeenCalled());
    },
  );

  it.each(KEY_BOUNDARIES)(
    "retains keyboard entry reentry exclusion across publication replacement at %s",
    async (affectedBoundary) => {
      searchUsers.mockImplementation(() => answer("octocat", "octodog", "octofox"));
      const onChange = vi.fn();
      const onPick = vi.fn();
      const onSubmit = vi.fn();
      const renderView = () => (
        <StrictMode>
          <KeyboardHarness onChange={onChange} onPick={onPick} onSubmit={onSubmit} />
        </StrictMode>
      );
      const view = render(renderView());
      const exactInput = input();
      exactInput.focus();
      await settle();
      fireEvent.mouseOver(listOptions()[1]);
      const nativePrevent = vi.spyOn(window.Event.prototype, "preventDefault");
      const outerDeliveries: ReturnType<typeof independentKeyboardDelivery>[] = [];
      const nestedDeliveries: ReturnType<typeof independentKeyboardDelivery>[] = [];
      const nestedReads: ReturnType<typeof vi.fn>[] = [];
      const nestedEvents: globalThis.KeyboardEvent[] = [];
      let replaced = false;
      const restore = interceptKeyboardRoute(exactInput, (boundary, deliver, source) => {
        const delivery = independentKeyboardDelivery(source);
        outerDeliveries.push(delivery);
        if (boundary === affectedBoundary) {
          const native = source.nativeEvent;
          Object.defineProperty(delivery.event, "nativeEvent", {
            get: () => {
              if (!replaced) {
                replaced = true;
                flushSync(() => view.rerender(renderView()));
                expect(input()).toBe(exactInput);
                const restoreSuccessor = interceptKeyboardRoute(exactInput, (_nextBoundary, nextDeliver, nextSource) => {
                  const successor = independentKeyboardDelivery(nextSource);
                  const read = vi.fn(() => nextSource.nativeEvent);
                  Object.defineProperty(successor.event, "nativeEvent", { get: read });
                  nestedDeliveries.push(successor);
                  nestedReads.push(read);
                  nextDeliver(successor.event);
                  successor.values.set("currentTarget", null);
                });
                try {
                  for (let attempt = 0; attempt < 2; attempt++) {
                    const next = keyboardEvent(exactInput, "Enter");
                    nestedEvents.push(next);
                    exactInput.dispatchEvent(next);
                  }
                } finally {
                  restoreSuccessor();
                }
              }
              return native;
            },
          });
        }
        deliver(delivery.event);
        delivery.values.set("currentTarget", null);
      });
      let retired: globalThis.KeyboardEvent;
      try {
        retired = dispatchKeyDown(exactInput, "Enter");
      } finally {
        restore();
      }
      expect(replaced).toBe(true);
      expect(nestedEvents).toHaveLength(2);
      expect(nestedEvents[0]).not.toBe(nestedEvents[1]);
      expect(nestedDeliveries).toHaveLength(8);
      nestedEvents.forEach((event) => expect(event.defaultPrevented).toBe(false));
      nestedReads.forEach((read) => expect(read).not.toHaveBeenCalled());
      nestedDeliveries.forEach((delivery) => {
        expect(delivery.defaultQuery).not.toHaveBeenCalled();
        expect(delivery.propagationQuery).not.toHaveBeenCalled();
        expect(delivery.preventDefault).not.toHaveBeenCalled();
      });
      outerDeliveries.forEach(({ preventDefault }) => expect(preventDefault).not.toHaveBeenCalled());
      expect(retired.defaultPrevented).toBe(false);
      expect(nativePrevent).not.toHaveBeenCalled();
      expect(onChange).not.toHaveBeenCalled();
      expect(onPick).not.toHaveBeenCalled();
      expect(onSubmit).not.toHaveBeenCalled();
      expect(searchUsers).toHaveBeenCalledOnce();
      expect(listOptions()[1]).toHaveAttribute("aria-selected", "true");
      const recovered = dispatchKeyDown(exactInput, "Enter");
      expect(recovered.defaultPrevented).toBe(true);
      expect(nativePrevent).toHaveBeenCalledOnce();
      expect(onChange).toHaveBeenCalledExactlyOnceWith("octodog");
      expect(onPick).toHaveBeenCalledExactlyOnceWith("octodog");
      expect(onSubmit).not.toHaveBeenCalled();
      expect(searchUsers).toHaveBeenCalledOnce();
    },
  );

  it.each(KEY_BOUNDARIES)(
    "releases throwing keyboard entry reentry exclusion at %s without poisoning the pending pair",
    async (affectedBoundary) => {
      searchUsers.mockImplementation(() => answer("octocat", "octodog"));
      const onChange = vi.fn();
      const onPick = vi.fn();
      const onSubmit = vi.fn();
      render(<KeyboardHarness onChange={onChange} onPick={onPick} onSubmit={onSubmit} />);
      const exactInput = input();
      exactInput.focus();
      await settle();
      fireEvent.mouseOver(listOptions()[1]);
      const nativePrevent = vi.spyOn(window.Event.prototype, "preventDefault");
      const throwingRead = vi.fn(() => { throw new Error("Malformed nativeEvent accessor"); });
      const deliveries: ReturnType<typeof independentKeyboardDelivery>[] = [];
      let rejected: ReturnType<typeof independentKeyboardDelivery> | undefined;
      const restore = interceptKeyboardRoute(exactInput, (boundary, deliver, source) => {
        if (boundary === affectedBoundary) {
          rejected = independentKeyboardDelivery(source);
          Object.defineProperty(rejected.event, "nativeEvent", { get: throwingRead });
          deliver(rejected.event);
        }
        const delivery = independentKeyboardDelivery(source);
        deliveries.push(delivery);
        deliver(delivery.event);
        delivery.values.set("currentTarget", null);
      });
      let accepted: globalThis.KeyboardEvent;
      try {
        accepted = dispatchKeyDown(exactInput, "Enter");
      } finally {
        restore();
      }
      expect(throwingRead).toHaveBeenCalledOnce();
      expect(rejected!.defaultQuery).not.toHaveBeenCalled();
      expect(rejected!.propagationQuery).not.toHaveBeenCalled();
      expect(rejected!.preventDefault).not.toHaveBeenCalled();
      expect(deliveries).toHaveLength(4);
      deliveries.slice(0, 3).forEach(({ preventDefault }) => expect(preventDefault).not.toHaveBeenCalled());
      expect(deliveries[3].preventDefault).toHaveBeenCalledOnce();
      expect(accepted.defaultPrevented).toBe(true);
      expect(nativePrevent).toHaveBeenCalledOnce();
      expect(onChange).toHaveBeenCalledExactlyOnceWith("octodog");
      expect(onPick).toHaveBeenCalledExactlyOnceWith("octodog");
      expect(onSubmit).not.toHaveBeenCalled();
      expect(searchUsers).toHaveBeenCalledOnce();
    },
  );

  it("keeps two genuinely dispatched keyboard routes live across crossed deliveries without poisoning either", async () => {
    searchUsers.mockImplementation(() => answer("octocat", "octodog", "octofox"));
    const onChange = vi.fn();
    const onPick = vi.fn();
    const onSubmit = vi.fn();
    render(<KeyboardHarness onChange={onChange} onPick={onPick} onSubmit={onSubmit} />);
    const exactInput = input();
    exactInput.focus();
    await settle();
    fireEvent.mouseOver(listOptions()[0]);
    // Both destinations are already current: completing B must not stale A's selection.
    const first = keyboardEvent(exactInput, "Home", { code: "Home" });
    const second = keyboardEvent(exactInput, "Home", { code: "Numpad7", location: 3 });
    const finals: ReturnType<typeof independentKeyboardDelivery>[] = [];
    const crossed: ReturnType<typeof independentKeyboardDelivery>[] = [];
    const nativePrevent = vi.spyOn(window.Event.prototype, "preventDefault");
    let firstSource: KeyDeliveryEvent | undefined;
    let nested = false;
    const restore = interceptKeyboardRoute(exactInput, (boundary, deliver, source) => {
      if (boundary === "root-capture" && source.nativeEvent === second) {
        expect(firstSource).toBeDefined();
        expect(first.eventPhase).toBe(1);
        expect(second.eventPhase).toBe(1);
        const wrongSecond = independentKeyboardDelivery(firstSource!);
        wrongSecond.values.set("nativeEvent", second);
        const wrongFirst = independentKeyboardDelivery(source);
        wrongFirst.values.set("nativeEvent", first);
        crossed.push(wrongFirst, wrongSecond);
        deliver(wrongSecond.event);
        deliver(wrongFirst.event);
      }
      const delivery = independentKeyboardDelivery(source);
      if (boundary === "root-bubble") finals.push(delivery);
      deliver(delivery.event);
      if (boundary === "root-capture" && source.nativeEvent === first && !nested) {
        nested = true;
        firstSource = source;
        exactInput.dispatchEvent(second);
        expect(second.defaultPrevented).toBe(true);
        expect(first.defaultPrevented).toBe(false);
      }
      delivery.values.set("currentTarget", null);
    });
    act(() => { exactInput.dispatchEvent(first); });
    restore();
    expect(nested).toBe(true);
    expect(first.defaultPrevented).toBe(true);
    expect(second.defaultPrevented).toBe(true);
    expect(finals).toHaveLength(2);
    expect(nativePrevent).toHaveBeenCalledTimes(2);
    finals.forEach(({ preventDefault }) => expect(preventDefault).toHaveBeenCalledOnce());
    crossed.forEach(({ preventDefault }) => expect(preventDefault).not.toHaveBeenCalled());
    expect(listOptions()[0]).toHaveAttribute("aria-selected", "true");
    expect(onChange).not.toHaveBeenCalled();
    expect(onPick).not.toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(searchUsers).toHaveBeenCalledOnce();
    act(() => {
      exactInput.dispatchEvent(first);
      exactInput.dispatchEvent(second);
    });
    expect(nativePrevent).toHaveBeenCalledTimes(2);
    expect(listOptions()[0]).toHaveAttribute("aria-selected", "true");
    const successor = dispatchKeyDown(exactInput, "ArrowDown");
    expect(successor.defaultPrevented).toBe(true);
    expect(nativePrevent).toHaveBeenCalledTimes(3);
    expect(listOptions()[1]).toHaveAttribute("aria-selected", "true");
  });

  it.each([
    "capture default query",
    "input bubble default query",
    "final propagation query",
    "final prevention",
    "non-callable final default query",
    "final query replacing propagation",
  ] as const)(
    "rejects %s drift during final keyboard prevention without invoking stale callbacks",
    async (mutation) => {
      searchUsers.mockImplementation(() => answer("octocat", "octodog", "octofox"));
      const onChange = vi.fn();
      const onPick = vi.fn();
      const onSubmit = vi.fn();
      render(<KeyboardHarness onChange={onChange} onPick={onPick} onSubmit={onSubmit} />);
      const exactInput = input();
      exactInput.focus();
      await settle();
      fireEvent.mouseOver(listOptions()[1]);
      const deliveries = new Map<KeyBoundary, ReturnType<typeof independentKeyboardDelivery>>();
      const replacement = vi.fn(() => false);
      const nativePrevent = vi.spyOn(window.Event.prototype, "preventDefault");
      const restore = interceptKeyboardRoute(exactInput, (boundary, deliver, source) => {
        const delivery = independentKeyboardDelivery(source);
        deliveries.set(boundary, delivery);
        if (boundary === "root-bubble") {
          delivery.values.set("preventDefault", function (this: object) {
            Reflect.apply(delivery.preventDefault, this, []);
            if (mutation === "capture default query" || mutation === "input bubble default query") {
              deliveries.get(mutation === "capture default query" ? "root-capture" : "input-bubble")!.values.set("isDefaultPrevented", replacement);
            } else if (mutation === "final propagation query") {
              delivery.values.set("isPropagationStopped", replacement);
            } else if (mutation === "final prevention") {
              delivery.values.set("preventDefault", replacement);
            } else if (mutation === "non-callable final default query") {
              delivery.values.set("isDefaultPrevented", null);
            } else {
              delivery.values.set("isDefaultPrevented", () => {
                delivery.values.set("isPropagationStopped", replacement);
                return true;
              });
            }
          });
        }
        deliver(delivery.event);
        delivery.values.set("currentTarget", null);
      });
      const rejected = dispatchKeyDown(exactInput, "Enter");
      restore();
      expect(rejected.defaultPrevented).toBe(true);
      expect(nativePrevent).toHaveBeenCalledOnce();
      expect(deliveries.get("root-bubble")!.preventDefault).toHaveBeenCalledOnce();
      expect(replacement).not.toHaveBeenCalled();
      expect(listOptions()[1]).toHaveAttribute("aria-selected", "true");
      expect(exactInput).toHaveValue("octo");
      expect(onChange).not.toHaveBeenCalled();
      expect(onPick).not.toHaveBeenCalled();
      expect(onSubmit).not.toHaveBeenCalled();
      const successor = dispatchKeyDown(exactInput, "Enter");
      expect(successor.defaultPrevented).toBe(true);
      expect(nativePrevent).toHaveBeenCalledTimes(2);
      expect(onChange).toHaveBeenCalledExactlyOnceWith("octodog");
      expect(onPick).toHaveBeenCalledExactlyOnceWith("octodog");
      expect(onSubmit).not.toHaveBeenCalled();
    },
  );

  it("authenticates React 19's final keyboard default query replacement and fences prevention reentry", async () => {
    searchUsers.mockImplementation(() => answer("octocat", "octodog"));
    const onChange = vi.fn();
    const onPick = vi.fn();
    render(<KeyboardHarness onChange={onChange} onPick={onPick} />);
    const exactInput = input();
    exactInput.focus();
    await settle();
    fireEvent.mouseOver(listOptions()[1]);
    const postQuery = vi.fn(() => true);
    const nativePrevent = vi.spyOn(window.Event.prototype, "preventDefault");
    let final: ReturnType<typeof independentKeyboardDelivery> | undefined;
    const restore = interceptKeyboardRoute(exactInput, (boundary, deliver, source) => {
      const delivery = independentKeyboardDelivery(source);
      if (boundary === "root-bubble") {
        final = delivery;
        delivery.values.set("preventDefault", function (this: object) {
          deliver(delivery.event);
          Reflect.apply(delivery.preventDefault, this, []);
          delivery.values.set("isDefaultPrevented", postQuery);
          deliver(delivery.event);
        });
      }
      deliver(delivery.event);
      delivery.values.set("currentTarget", null);
    });
    const accepted = dispatchKeyDown(exactInput, "Enter");
    restore();
    expect(accepted.defaultPrevented).toBe(true);
    expect(nativePrevent).toHaveBeenCalledOnce();
    expect(final!.preventDefault).toHaveBeenCalledOnce();
    expect(postQuery).toHaveBeenCalled();
    expect(postQuery.mock.contexts.every((receiver) => receiver === final!.event)).toBe(true);
    expect(onChange).toHaveBeenCalledExactlyOnceWith("octodog");
    expect(onPick).toHaveBeenCalledExactlyOnceWith("octodog");
  });

  it.each(["onChange", "onPick"] as const)(
    "surfaces keyboard pick %s errors without replaying the claimed effect",
    async (callback) => {
      searchUsers.mockImplementation(() => answer("octocat", "octodog"));
      const failure = new Error("Keyboard pick callback failed");
      const callbacks = { onChange: vi.fn(), onPick: vi.fn() };
      callbacks[callback].mockImplementation(() => { throw failure; });
      render(<KeyboardHarness {...callbacks} />);
      const exactInput = input();
      exactInput.focus();
      await settle();
      fireEvent.mouseOver(listOptions()[1]);
      const errors: unknown[] = [];
      const onError = (event: ErrorEvent) => {
        if (event.error !== failure) return;
        errors.push(event.error);
        event.preventDefault();
      };
      window.addEventListener("error", onError);
      try {
        const accepted = dispatchKeyDown(exactInput, "Enter");
        expect(accepted.defaultPrevented).toBe(true);
        expect(errors).toEqual([failure]);
        expect(callbacks.onChange).toHaveBeenCalledExactlyOnceWith("octodog");
        expect(callbacks.onPick).toHaveBeenCalledTimes(callback === "onPick" ? 1 : 0);
        act(() => { exactInput.dispatchEvent(accepted); });
        expect(errors).toEqual([failure]);
        expect(callbacks.onChange).toHaveBeenCalledOnce();
        expect(callbacks.onPick).toHaveBeenCalledTimes(callback === "onPick" ? 1 : 0);
      } finally {
        window.removeEventListener("error", onError);
      }
    },
  );

  it.each((["isDefaultPrevented", "isPropagationStopped", "preventDefault"] as const).flatMap((callback) =>
    ([
      "query", "callbacks", "exclusions", "active index", "rerender",
      "input detach/restore", "root detach/restore", "list detach/restore",
      "row reorder/restore", "focus away/back", "partial Strict replay", "cleanup",
    ] as const).map((mutation) => ({ callback, mutation })),
  ))(
    "revalidates $mutation after keyboard $callback before another query or effect",
    async ({ callback, mutation }) => {
      searchUsers.mockImplementation(() => answer("octocat", "octodog", "octofox"));
      const onChange = vi.fn();
      const onPick = vi.fn();
      const replacementChange = vi.fn();
      const replacementPick = vi.fn();
      const host = document.createElement("div");
      const outside = document.createElement("button");
      document.body.append(outside, host);
      const root = createRoot(host);
      const view = (
        instance = "initial",
        value = "octo",
        change = onChange,
        pick = onPick,
        exclude: string[] = [],
      ) => (
        <StrictMode>
          <AuthorityBoundary instance={instance} value={value} onChange={change} onPick={pick} exclude={exclude} />
        </StrictMode>
      );
      try {
        await act(async () => root.render(view()));
        const exactInput = input();
        exactInput.focus();
        await settle();
        fireEvent.mouseOver(listOptions()[1]);
        const nativePrevent = vi.spyOn(window.Event.prototype, "preventDefault");
        let mutated = false;
        const restore = interceptKeyboardRoute(exactInput, (boundary, deliver, source) => {
          const delivery = independentKeyboardDelivery(source);
          if (boundary === "root-bubble") {
            const retained = delivery.event[callback];
            delivery.values.set(callback, function (this: object) {
              const result = Reflect.apply(retained, this, []);
              if (mutated) return result;
              mutated = true;
              if (mutation === "query") {
                flushSync(() => root.render(view("initial", "octof")));
              } else if (mutation === "callbacks") {
                flushSync(() => root.render(view("initial", "octo", replacementChange, replacementPick)));
              } else if (mutation === "exclusions") {
                flushSync(() => root.render(view("initial", "octo", onChange, onPick, ["octocat"])));
              } else if (mutation === "active index") {
                flushSync(() => fireEvent.mouseOver(listOptions()[0]));
              } else if (mutation === "rerender") {
                flushSync(() => root.render(view()));
              } else if (mutation.endsWith("detach/restore")) {
                const element = mutation.startsWith("input")
                  ? exactInput
                  : mutation.startsWith("root")
                    ? exactInput.parentElement!
                    : screen.getByTestId("share-login-suggestions");
                const parent = element.parentNode!;
                const next = element.nextSibling;
                element.remove();
                parent.insertBefore(element, next);
              } else if (mutation === "row reorder/restore") {
                const row = listOptions()[0];
                const list = row.parentNode!;
                const next = row.nextSibling;
                list.appendChild(row);
                list.insertBefore(row, next);
              } else if (mutation === "focus away/back") {
                flushSync(() => {
                  outside.focus();
                  exactInput.focus();
                });
              } else if (mutation === "partial Strict replay") {
                const row = listOptions()[0];
                const ref = reactRef(row, true);
                ref(null);
                ref(row);
              } else {
                flushSync(() => root.render(null));
              }
              return result;
            });
          }
          deliver(delivery.event);
          delivery.values.set("currentTarget", null);
        });
        const rejected = dispatchKeyDown(exactInput, "Enter");
        restore();
        expect(mutated).toBe(true);
        expect(rejected.defaultPrevented).toBe(callback === "preventDefault");
        expect(nativePrevent).toHaveBeenCalledTimes(callback === "preventDefault" ? 1 : 0);
        expect(onChange).not.toHaveBeenCalled();
        expect(onPick).not.toHaveBeenCalled();
        expect(replacementChange).not.toHaveBeenCalled();
        expect(replacementPick).not.toHaveBeenCalled();
        act(() => { exactInput.dispatchEvent(rejected); });
        expect(onChange).not.toHaveBeenCalled();
        expect(onPick).not.toHaveBeenCalled();
        await act(async () => root.render(view("successor")));
        input().focus();
        await settle();
        nativePrevent.mockClear();
        const recovered = dispatchKeyDown(input(), "End");
        expect(recovered.defaultPrevented).toBe(true);
        expect(nativePrevent).toHaveBeenCalledOnce();
        expect(listOptions()[2]).toHaveAttribute("aria-selected", "true");
        expect(onChange).not.toHaveBeenCalled();
        expect(onPick).not.toHaveBeenCalled();
      } finally {
        await act(async () => root.unmount());
        outside.remove();
        host.remove();
      }
    },
  );

  it.each(["focus", "DOM"] as const)(
    "rechecks keyboard method identities after an arbitrary %s observation",
    async (observation) => {
      searchUsers.mockImplementation(() => answer("octocat", "octodog", "octofox"));
      const onChange = vi.fn();
      const onPick = vi.fn();
      render(<KeyboardHarness onChange={onChange} onPick={onPick} />);
      const exactInput = input();
      exactInput.focus();
      await settle();
      fireEvent.mouseOver(listOptions()[1]);
      const replacement = vi.fn(() => false);
      let changed = false;
      let final: ReturnType<typeof independentKeyboardDelivery> | undefined;
      const nativePrevent = vi.spyOn(window.Event.prototype, "preventDefault");
      const restore = interceptKeyboardRoute(exactInput, (boundary, deliver, source) => {
        const delivery = independentKeyboardDelivery(source);
        if (boundary === "root-bubble") final = delivery;
        if (boundary === "root-bubble") {
          let armed = false;
          const defaultQuery = delivery.event.isDefaultPrevented;
          delivery.values.set("isDefaultPrevented", function (this: object) {
            armed = true;
            return Reflect.apply(defaultQuery, this, []);
          });
          const mutate = () => {
            if (armed && !changed) {
              changed = true;
              delivery.values.set("isPropagationStopped", replacement);
            }
          };
          if (observation === "focus") {
            const activeElement = document.activeElement;
            Object.defineProperty(document, "activeElement", {
              configurable: true,
              get() { mutate(); return activeElement; },
            });
          } else {
            const matches = exactInput.matches;
            vi.spyOn(exactInput, "matches").mockImplementation(function (this: HTMLInputElement, selectors: string) {
              mutate();
              return Reflect.apply(matches, this, [selectors]);
            });
          }
        }
        deliver(delivery.event);
        delivery.values.set("currentTarget", null);
      });
      try {
        const rejected = dispatchKeyDown(exactInput, "Enter");
        expect(changed).toBe(true);
        expect(rejected.defaultPrevented).toBe(false);
        expect(final!.preventDefault).not.toHaveBeenCalled();
        expect(replacement).not.toHaveBeenCalled();
        expect(nativePrevent).not.toHaveBeenCalled();
        expect(onChange).not.toHaveBeenCalled();
        expect(onPick).not.toHaveBeenCalled();
      } finally {
        restore();
        if (observation === "focus") Reflect.deleteProperty(document, "activeElement");
        else vi.mocked(exactInput.matches).mockRestore();
      }
      expect(dispatchKeyDown(exactInput, "Enter").defaultPrevented).toBe(true);
      expect(onChange).toHaveBeenCalledExactlyOnceWith("octodog");
      expect(onPick).toHaveBeenCalledExactlyOnceWith("octodog");
    },
  );

  it.each(["ArrowUp", "ArrowDown", "Home", "End", "Enter", "Escape"])(
    "leaves unsupported native keyboard $key facts inert and accepts a distinct clean route",
    async (key) => {
      searchUsers.mockImplementation(() => answer("octocat", "octodog", "octofox"));
      const onChange = vi.fn();
      const onPick = vi.fn();
      const onSubmit = vi.fn();
      render(<KeyboardHarness onChange={onChange} onPick={onPick} onSubmit={onSubmit} />);
      const exactInput = input();
      exactInput.focus();
      await settle();
      fireEvent.mouseOver(listOptions()[1]);
      const nativePrevent = vi.spyOn(window.Event.prototype, "preventDefault");
      for (const init of [
        { ctrlKey: true }, { altKey: true }, { shiftKey: true }, { metaKey: true },
        { repeat: true }, { isComposing: true }, { bubbles: false }, { cancelable: false },
        { view: new Proxy(window, {}) },
      ] satisfies KeyboardEventInit[]) {
        const event = dispatchKeyDown(exactInput, key, init);
        expect(event.defaultPrevented).toBe(false);
      }
      expect(dispatchKeyDown(exactInput, key, {}, false).defaultPrevented).toBe(false);
      for (const unsupported of ["ArrowLeft", "ArrowRight", "Tab", "a"]) {
        expect(dispatchKeyDown(exactInput, unsupported).defaultPrevented).toBe(false);
      }
      expect(nativePrevent).not.toHaveBeenCalled();
      expect(listOptions()[1]).toHaveAttribute("aria-selected", "true");
      expect(exactInput).toHaveValue("octo");
      expect(onChange).not.toHaveBeenCalled();
      expect(onPick).not.toHaveBeenCalled();
      expect(onSubmit).not.toHaveBeenCalled();
      const successor = dispatchKeyDown(exactInput, key);
      expect(successor.defaultPrevented).toBe(true);
      expect(nativePrevent).toHaveBeenCalledOnce();
      expect(onPick).toHaveBeenCalledTimes(key === "Enter" ? 1 : 0);
      expect(onSubmit).not.toHaveBeenCalled();
      expect(searchUsers).toHaveBeenCalledOnce();
    },
  );

  it("accepts null public keyboard view without inventing a Window facade", async () => {
    searchUsers.mockImplementation(() => answer("octocat", "octodog"));
    const onChange = vi.fn();
    render(<KeyboardHarness onChange={onChange} />);
    input().focus();
    await settle();
    const nativePrevent = vi.spyOn(window.Event.prototype, "preventDefault");
    const event = dispatchKeyDown(input(), "End", { view: null });
    expect(event.defaultPrevented).toBe(true);
    expect(nativePrevent).toHaveBeenCalledOnce();
    expect(listOptions()[1]).toHaveAttribute("aria-selected", "true");
    expect(onChange).not.toHaveBeenCalled();
  });

  it.each(["preventDefault", "stopPropagation"] as const)(
    "does not complete or replay a native keyboard route canceled by %s after capture",
    async (cancel) => {
      searchUsers.mockImplementation(() => answer("octocat", "octodog"));
      const onChange = vi.fn();
      const onPick = vi.fn();
      render(<KeyboardHarness onChange={onChange} onPick={onPick} />);
      const exactInput = input();
      exactInput.focus();
      await settle();
      fireEvent.mouseOver(listOptions()[1]);
      const nativePrevent = vi.spyOn(window.Event.prototype, "preventDefault");
      exactInput.addEventListener("keydown", (event) => event[cancel](), { capture: true, once: true });
      const canceled = dispatchKeyDown(exactInput, "Enter");
      expect(canceled.defaultPrevented).toBe(cancel === "preventDefault");
      expect(nativePrevent).toHaveBeenCalledTimes(cancel === "preventDefault" ? 1 : 0);
      expect(listOptions()[1]).toHaveAttribute("aria-selected", "true");
      expect(onChange).not.toHaveBeenCalled();
      expect(onPick).not.toHaveBeenCalled();
      act(() => { exactInput.dispatchEvent(canceled); });
      expect(nativePrevent).toHaveBeenCalledTimes(cancel === "preventDefault" ? 1 : 0);
      expect(onPick).not.toHaveBeenCalled();
      nativePrevent.mockClear();
      expect(dispatchKeyDown(exactInput, "Enter").defaultPrevented).toBe(true);
      expect(nativePrevent).toHaveBeenCalledOnce();
      expect(onChange).toHaveBeenCalledExactlyOnceWith("octodog");
      expect(onPick).toHaveBeenCalledExactlyOnceWith("octodog");
    },
  );

  it("rejects wrong-receiver terminal keyboard calls without releasing the rightful Window listener", async () => {
    searchUsers.mockImplementation(() => answer("octocat", "octodog"));
    const onChange = vi.fn();
    const onPick = vi.fn();
    const registered: EventListener[] = [];
    const add = window.addEventListener;
    vi.spyOn(window, "addEventListener").mockImplementation(function (
      this: Window,
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | AddEventListenerOptions,
    ) {
      if (type === "keydown" && typeof listener === "function" && options !== true && !(typeof options === "object" && options.capture)) {
        registered.push(listener);
      }
      Reflect.apply(add, this, [type, listener, options]);
    });
    render(<KeyboardHarness onChange={onChange} onPick={onPick} />);
    const exactInput = input();
    exactInput.focus();
    await settle();
    fireEvent.mouseOver(listOptions()[1]);
    const listener = registered.at(-1);
    expect(listener).toBeDefined();
    const facade = { document, window, self: window };
    let attempted = false;
    const restore = interceptKeyboardRoute(exactInput, (boundary, deliver, source) => {
      const delivery = independentKeyboardDelivery(source);
      if (boundary === "root-bubble") {
        delivery.values.set("preventDefault", function (this: object) {
          Reflect.apply(delivery.preventDefault, this, []);
          attempted = true;
          Reflect.apply(listener!, facade, [source.nativeEvent]);
          Reflect.apply(listener!, window, [source.nativeEvent]);
        });
      }
      deliver(delivery.event);
      delivery.values.set("currentTarget", null);
    });
    const nativePrevent = vi.spyOn(window.Event.prototype, "preventDefault");
    const event = dispatchKeyDown(exactInput, "Enter");
    restore();
    expect(attempted).toBe(true);
    expect(event.defaultPrevented).toBe(true);
    expect(nativePrevent).toHaveBeenCalledOnce();
    expect(onChange).toHaveBeenCalledExactlyOnceWith("octodog");
    expect(onPick).toHaveBeenCalledExactlyOnceWith("octodog");
  });

  it("uses React-public keydown authority for wraps, boundaries, pick, native Enter, and Escape isolation", async () => {
    searchUsers.mockImplementation(() =>
      answer("octocat", "octodog", "octofox"),
    );
    const onChange = vi.fn();
    const onPick = vi.fn();
    const onSubmit = vi.fn();
    const onRoleChange = vi.fn();
    const onDialogClose = vi.fn();
    const preventDefault = vi.spyOn(
      window.Event.prototype,
      "preventDefault",
    );
    const focus = vi.spyOn(window.HTMLElement.prototype, "focus");
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);

    try {
      await act(async () => {
        root.render(
          <StrictMode>
            <KeyboardHarness
              onChange={onChange}
              onPick={onPick}
              onSubmit={onSubmit}
              onRoleChange={onRoleChange}
              onDialogClose={onDialogClose}
            />
          </StrictMode>,
        );
      });
      const exactInput = input();
      exactInput.focus();
      await settle();
      preventDefault.mockClear();
      focus.mockClear();
      document.documentElement.scrollTop = 23;

      expect(onChange).not.toHaveBeenCalled();
      expect(onPick).not.toHaveBeenCalled();
      expect(onSubmit).not.toHaveBeenCalled();
      expect(onRoleChange).not.toHaveBeenCalled();
      expect(onDialogClose).not.toHaveBeenCalled();
      expect(searchUsers).toHaveBeenCalledOnce();

      const move = (key: string, destination: number) => {
        preventDefault.mockClear();
        const event = dispatchKeyDown(exactInput, key);
        expect(event.defaultPrevented).toBe(true);
        expect(preventDefault).toHaveBeenCalledOnce();
        expect(listOptions()[destination]).toHaveAttribute(
          "aria-selected",
          "true",
        );
        expect(exactInput).toHaveFocus();
        expect(focus).not.toHaveBeenCalled();
        expect(document.documentElement.scrollTop).toBe(23);
      };

      move("ArrowUp", 2);
      move("ArrowDown", 0);
      move("End", 2);
      move("Home", 0);
      expect(searchUsers).toHaveBeenCalledOnce();
      expect(onChange).not.toHaveBeenCalled();
      expect(onPick).not.toHaveBeenCalled();
      expect(onSubmit).not.toHaveBeenCalled();
      expect(onDialogClose).not.toHaveBeenCalled();

      preventDefault.mockClear();
      const closed = dispatchKeyDown(exactInput, "Escape");
      expect(closed.defaultPrevented).toBe(true);
      expect(preventDefault).toHaveBeenCalledOnce();
      expect(screen.queryByTestId("share-login-suggestions")).toBeNull();
      expect(onDialogClose).not.toHaveBeenCalled();

      preventDefault.mockClear();
      const dialogEscape = dispatchKeyDown(exactInput, "Escape");
      expect(dialogEscape.defaultPrevented).toBe(false);
      expect(preventDefault).not.toHaveBeenCalled();
      expect(onDialogClose).toHaveBeenCalledOnce();

      move("ArrowDown", 0);
      preventDefault.mockClear();
      const picked = dispatchKeyDown(exactInput, "Enter");
      expect(picked.defaultPrevented).toBe(true);
      expect(preventDefault).toHaveBeenCalledOnce();
      expect(onChange).toHaveBeenCalledExactlyOnceWith("octocat");
      expect(onPick).toHaveBeenCalledExactlyOnceWith("octocat");
      expect(onSubmit).not.toHaveBeenCalled();
      expect(onRoleChange).not.toHaveBeenCalled();
      expect(exactInput).toHaveValue("octocat");

      preventDefault.mockClear();
      const nativeEnter = dispatchKeyDown(exactInput, "Enter");
      expect(nativeEnter.defaultPrevented).toBe(false);
      expect(preventDefault).not.toHaveBeenCalled();
      fireEvent.submit(exactInput.closest("form")!);
      expect(onSubmit).toHaveBeenCalledExactlyOnceWith("octocat");
      expect(searchUsers).toHaveBeenCalledOnce();
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it("accepts independent capture and bubble wrappers, public methods, and scalar accessors", async () => {
    searchUsers.mockImplementation(() =>
      answer("octocat", "octodog", "octofox"),
    );
    const onChange = vi.fn();
    const onPick = vi.fn();
    const preventDefault = vi.spyOn(
      window.Event.prototype,
      "preventDefault",
    );
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);

    try {
      await act(async () => {
        root.render(
          <StrictMode>
            <DirectHarness
              initialValue="octo"
              onChange={onChange}
              onPick={onPick}
            />
          </StrictMode>,
        );
      });
      const exactInput = input();
      const inputRoot = exactInput.parentElement;
      if (!inputRoot) throw new Error("The input root was unavailable");
      exactInput.focus();
      await settle();
      fireEvent.mouseOver(listOptions()[1]);
      const capturePrototype = Object.create(null);
      const bubblePrototype = Object.create(null);
      let captureWrapper: object | null = null;
      let bubbleWrapper: object | null = null;
      const restoreCapture = interceptReactHandler<
        KeyboardEvent<HTMLDivElement>
      >(
        inputRoot,
        "onKeyDownCapture",
        (original, event) => {
          captureWrapper = event;
          exposeReactKeyScalarsAsAccessors(event);
          isolateReactKeyWrapper(event, capturePrototype);
          alterNonPublicReactKeyFields(event, "replaced");
          original(event);
        },
      );
      const restoreBubble = interceptReactHandler<
        KeyboardEvent<HTMLInputElement>
      >(
        exactInput,
        "onKeyDown",
        (original, event) => {
          bubbleWrapper = event;
          exposeReactKeyScalarsAsAccessors(event);
          isolateReactKeyWrapper(event, bubblePrototype, true);
          alterNonPublicReactKeyFields(event, "non-function");
          original(event);
        },
      );
      preventDefault.mockClear();

      const event = dispatchKeyDown(exactInput, "Home");
      restoreCapture();
      restoreBubble();

      expect(captureWrapper).not.toBeNull();
      expect(bubbleWrapper).not.toBeNull();
      expect(captureWrapper).not.toBe(bubbleWrapper);
      expect(Object.getPrototypeOf(captureWrapper)).toBe(
        capturePrototype,
      );
      expect(Object.getPrototypeOf(bubbleWrapper)).toBe(
        bubblePrototype,
      );
      for (const wrapper of [captureWrapper, bubbleWrapper]) {
        for (const property of REACT_KEY_PUBLIC_SCALARS) {
          expect(
            Object.getOwnPropertyDescriptor(wrapper!, property)?.get,
          ).toBeTypeOf("function");
        }
      }
      expect(event.defaultPrevented).toBe(true);
      expect(preventDefault).toHaveBeenCalledOnce();
      expect(listOptions()[0]).toHaveAttribute(
        "aria-selected",
        "true",
      );
      expect(onChange).not.toHaveBeenCalled();
      expect(onPick).not.toHaveBeenCalled();
      expect(searchUsers).toHaveBeenCalledOnce();
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it.each(["absent", "replaced", "non-function"] as const)(
    "does not depend on %s private or optional React wrapper fields",
    async (state) => {
      searchUsers.mockImplementation(() =>
        answer("octocat", "octodog", "octofox"),
      );
      const onChange = vi.fn();
      const preventDefault = vi.spyOn(
        window.Event.prototype,
        "preventDefault",
      );
      const host = document.createElement("div");
      document.body.append(host);
      const root = createRoot(host);

      try {
        await act(async () => {
          root.render(
            <StrictMode>
              <DirectHarness
                initialValue="octo"
                onChange={onChange}
              />
            </StrictMode>,
          );
        });
        const exactInput = input();
        const inputRoot = exactInput.parentElement;
        if (!inputRoot) {
          throw new Error("The input root was unavailable");
        }
        exactInput.focus();
        await settle();
        fireEvent.mouseOver(listOptions()[1]);
        const alter = <E,>(
          original: (event: E) => void,
          event: E,
        ) => {
          if (state === "absent") {
            isolateReactKeyWrapper(event as object, null);
          }
          alterNonPublicReactKeyFields(event as object, state);
          original(event);
        };
        const restoreCapture = interceptReactHandler<
          KeyboardEvent<HTMLDivElement>
        >(inputRoot, "onKeyDownCapture", alter);
        const restoreBubble = interceptReactHandler<
          KeyboardEvent<HTMLInputElement>
        >(exactInput, "onKeyDown", alter);
        preventDefault.mockClear();

        const event = dispatchKeyDown(exactInput, "End");
        restoreCapture();
        restoreBubble();

        expect(event.defaultPrevented).toBe(true);
        expect(preventDefault).toHaveBeenCalledOnce();
        expect(listOptions()[2]).toHaveAttribute(
          "aria-selected",
          "true",
        );
        expect(onChange).not.toHaveBeenCalled();
      } finally {
        await act(async () => root.unmount());
        host.remove();
      }
    },
  );

  it.each([1, 2, 5] as const)(
    "keeps the exact keyboard pair through %s nested microtask checkpoint(s)",
    async (checkpoints) => {
      searchUsers.mockImplementation(() =>
        answer("octocat", "octodog", "octofox"),
      );
      const onChange = vi.fn();
      const preventDefault = vi.spyOn(
        window.Event.prototype,
        "preventDefault",
      );
      const host = document.createElement("div");
      document.body.append(host);
      const root = createRoot(host);

      try {
        await act(async () => {
          root.render(
            <StrictMode>
              <DirectHarness
                initialValue="octo"
                onChange={onChange}
              />
            </StrictMode>,
          );
        });
        const exactInput = input();
        exactInput.focus();
        await settle();
        fireEvent.mouseOver(listOptions()[1]);
        const queued: VoidFunction[] = [];
        vi.spyOn(globalThis, "queueMicrotask").mockImplementation(
          (callback) => {
            queued.push(callback);
          },
        );
        for (let checkpoint = 0; checkpoint < checkpoints; checkpoint++) {
          queueMicrotask(() => undefined);
        }
        exactInput.addEventListener(
          "keydown",
          () => {
            for (
              let checkpoint = 0;
              checkpoint < checkpoints;
              checkpoint++
            ) {
              queued.splice(0).forEach((callback) => callback());
            }
          },
          { capture: true, once: true },
        );
        preventDefault.mockClear();
        const event = keyboardEvent(exactInput, "Home");

        act(() => {
          exactInput.dispatchEvent(event);
          while (queued.length > 0) {
            queued.splice(0).forEach((callback) => callback());
          }
        });

        expect(event.defaultPrevented).toBe(true);
        expect(preventDefault).toHaveBeenCalledOnce();
        expect(listOptions()[0]).toHaveAttribute(
          "aria-selected",
          "true",
        );
        expect(onChange).not.toHaveBeenCalled();
      } finally {
        await act(async () => root.unmount());
        host.remove();
      }
    },
  );

  it.each(REACT_KEY_REQUIRED_METHODS)(
    "rejects bubble-phase %s drift and accepts a clean successor",
    async (method) => {
      searchUsers.mockImplementation(() =>
        answer("octocat", "octodog", "octofox"),
      );
      const onChange = vi.fn();
      const preventDefault = vi.spyOn(
        window.Event.prototype,
        "preventDefault",
      );
      const host = document.createElement("div");
      document.body.append(host);
      const root = createRoot(host);

      try {
        await act(async () => {
          root.render(
            <StrictMode>
              <DirectHarness
                initialValue="octo"
                onChange={onChange}
              />
            </StrictMode>,
          );
        });
        const exactInput = input();
        exactInput.focus();
        await settle();
        fireEvent.mouseOver(listOptions()[1]);
        const restore = interceptReactHandler<
          KeyboardEvent<HTMLInputElement>
        >(exactInput, "onKeyDown", (original, event) => {
          original(event);
          Object.defineProperty(event, method, {
            configurable: true,
            enumerable: true,
            writable: true,
            value:
              method === "preventDefault"
                ? vi.fn()
                : vi.fn(() => false),
          });
        });
        preventDefault.mockClear();

        const rejected = dispatchKeyDown(exactInput, "Home");
        restore();

        expect(rejected.defaultPrevented).toBe(false);
        expect(preventDefault).not.toHaveBeenCalled();
        expect(listOptions()[1]).toHaveAttribute(
          "aria-selected",
          "true",
        );
        expect(onChange).not.toHaveBeenCalled();

        const recovered = dispatchKeyDown(exactInput, "Home");
        expect(recovered.defaultPrevented).toBe(true);
        expect(preventDefault).toHaveBeenCalledOnce();
        expect(listOptions()[0]).toHaveAttribute(
          "aria-selected",
          "true",
        );
      } finally {
        await act(async () => root.unmount());
        host.remove();
      }
    },
  );

  it.each([
    {
      stage: "React-root preparation",
      queryInvocation: 1,
      mutation: "default query replacing bubble propagation",
    },
    {
      stage: "document authentication",
      queryInvocation: 2,
      mutation: "default query replacing bubble propagation",
    },
    {
      stage: "Window settlement",
      queryInvocation: 3,
      mutation: "default query replacing bubble propagation",
    },
    {
      stage: "React-root preparation",
      queryInvocation: 1,
      mutation: "capture propagation replacing bubble propagation",
    },
    {
      stage: "document authentication",
      queryInvocation: 2,
      mutation: "capture propagation replacing bubble propagation",
    },
    {
      stage: "Window settlement",
      queryInvocation: 3,
      mutation: "capture propagation replacing bubble propagation",
    },
  ] as const)(
    "rejects late public query drift from $mutation at $stage before route settlement or any effect",
    async ({ queryInvocation, mutation }) => {
      searchUsers.mockImplementation(() =>
        answer("octocat", "octodog", "octofox"),
      );
      const onChange = vi.fn();
      const onPick = vi.fn();
      const onSubmit = vi.fn();
      const onRoleChange = vi.fn();
      const onDialogClose = vi.fn();
      const preventDefault = vi.spyOn(
        window.Event.prototype,
        "preventDefault",
      );
      const focus = vi.spyOn(window.HTMLElement.prototype, "focus");
      const stalePropagation = vi.fn(() => false);
      const host = document.createElement("div");
      document.body.append(host);
      const root = createRoot(host);

      try {
        await act(async () => {
          root.render(
            <StrictMode>
              <KeyboardHarness
                onChange={onChange}
                onPick={onPick}
                onSubmit={onSubmit}
                onRoleChange={onRoleChange}
                onDialogClose={onDialogClose}
              />
            </StrictMode>,
          );
        });
        const exactInput = input();
        const inputRoot = exactInput.parentElement;
        if (!inputRoot) {
          throw new Error("The input root was unavailable");
        }
        exactInput.focus();
        await settle();
        fireEvent.mouseOver(listOptions()[1]);
        let captureWrapper: KeyboardEvent<HTMLDivElement> | null =
          null;
        let bubbleWrapper: KeyboardEvent<HTMLInputElement> | null =
          null;
        let lateQueries = 0;
        const restoreCapture = interceptReactHandler<
          KeyboardEvent<HTMLDivElement>
        >(
          inputRoot,
          "onKeyDownCapture",
          (original, event) => {
            captureWrapper = event;
            if (
              mutation ===
              "capture propagation replacing bubble propagation"
            ) {
              const retainedPropagation =
                event.isPropagationStopped;
              Object.defineProperty(
                event,
                "isPropagationStopped",
                {
                  configurable: true,
                  enumerable: true,
                  writable: true,
                  value: function (this: object) {
                    const result = Reflect.apply(
                      retainedPropagation,
                      this,
                      [],
                    );
                    if (
                      event.nativeEvent.defaultPrevented &&
                      ++lateQueries === queryInvocation
                    ) {
                      if (!bubbleWrapper) {
                        throw new Error(
                          "The bubble wrapper was unavailable",
                        );
                      }
                      Object.defineProperty(
                        bubbleWrapper,
                        "isPropagationStopped",
                        {
                          configurable: true,
                          enumerable: true,
                          writable: true,
                          value: stalePropagation,
                        },
                      );
                    }
                    return result;
                  },
                },
              );
            }
            original(event);
          },
        );
        const restoreBubble = interceptReactHandler<
          KeyboardEvent<HTMLInputElement>
        >(
          exactInput,
          "onKeyDown",
          (original, event) => {
            bubbleWrapper = event;
            if (
              mutation ===
              "default query replacing bubble propagation"
            ) {
              const retainedPreventDefault = event.preventDefault;
              Object.defineProperty(event, "preventDefault", {
                configurable: true,
                enumerable: true,
                writable: true,
                value: function (this: object) {
                  const result = Reflect.apply(
                    retainedPreventDefault,
                    this,
                    [],
                  );
                  const record = this as Record<
                    PropertyKey,
                    unknown
                  >;
                  const currentDefaultQuery =
                    record.isDefaultPrevented;
                  if (
                    typeof currentDefaultQuery !== "function"
                  ) {
                    throw new Error(
                      "The post-prevention query was unavailable",
                    );
                  }
                  Object.defineProperty(
                    this,
                    "isDefaultPrevented",
                    {
                      configurable: true,
                      enumerable: true,
                      writable: true,
                      value: function (this: object) {
                        const queryResult = Reflect.apply(
                          currentDefaultQuery,
                          this,
                          [],
                        );
                        if (
                          ++lateQueries === queryInvocation
                        ) {
                          Object.defineProperty(
                            this,
                            "isPropagationStopped",
                            {
                              configurable: true,
                              enumerable: true,
                              writable: true,
                              value: stalePropagation,
                            },
                          );
                        }
                        return queryResult;
                      },
                    },
                  );
                  return result;
                },
              });
            }
            original(event);
          },
        );
        preventDefault.mockClear();
        focus.mockClear();
        document.documentElement.scrollTop = 29;

        const rejected = dispatchKeyDown(exactInput, "Enter");

        expect(captureWrapper).not.toBeNull();
        expect(bubbleWrapper).not.toBeNull();
        expect(captureWrapper).not.toBe(bubbleWrapper);
        expect(lateQueries).toBe(queryInvocation);
        expect(rejected.defaultPrevented).toBe(true);
        expect(preventDefault).toHaveBeenCalledOnce();
        expect(stalePropagation).toHaveBeenCalledTimes(
          queryInvocation === 1 ? 1 : 0,
        );
        expect(listOptions()[1]).toHaveAttribute(
          "aria-selected",
          "true",
        );
        expect(exactInput).toHaveAttribute(
          "aria-activedescendant",
          listOptions()[1].id,
        );
        expect(exactInput).toHaveValue("octo");
        expect(exactInput).toHaveFocus();
        expect(focus).not.toHaveBeenCalled();
        expect(document.documentElement.scrollTop).toBe(29);
        expect(
          screen.getByRole("combobox", { name: "Role" }),
        ).toHaveValue("editor");
        expect(
          screen.getByTestId("share-dialog-shell"),
        ).toBeInTheDocument();
        expect(onChange).not.toHaveBeenCalled();
        expect(onPick).not.toHaveBeenCalled();
        expect(onSubmit).not.toHaveBeenCalled();
        expect(onRoleChange).not.toHaveBeenCalled();
        expect(onDialogClose).not.toHaveBeenCalled();
        expect(searchUsers).toHaveBeenCalledOnce();

        act(() => {
          exactInput.dispatchEvent(rejected);
        });

        expect(preventDefault).toHaveBeenCalledOnce();
        expect(stalePropagation).toHaveBeenCalledTimes(
          queryInvocation === 1 ? 1 : 0,
        );
        expect(listOptions()[1]).toHaveAttribute(
          "aria-selected",
          "true",
        );
        expect(onChange).not.toHaveBeenCalled();
        expect(onPick).not.toHaveBeenCalled();
        expect(onSubmit).not.toHaveBeenCalled();
        expect(onRoleChange).not.toHaveBeenCalled();
        expect(onDialogClose).not.toHaveBeenCalled();
        expect(focus).not.toHaveBeenCalled();
        expect(document.documentElement.scrollTop).toBe(29);
        restoreCapture();
        restoreBubble();

        preventDefault.mockClear();
        const recovered = dispatchKeyDown(input(), "Enter");

        expect(recovered).not.toBe(rejected);
        expect(recovered.defaultPrevented).toBe(true);
        expect(preventDefault).toHaveBeenCalledOnce();
        expect(stalePropagation).toHaveBeenCalledTimes(
          queryInvocation === 1 ? 1 : 0,
        );
        expect(input()).toHaveValue("octodog");
        expect(input()).toHaveFocus();
        expect(focus).not.toHaveBeenCalled();
        expect(document.documentElement.scrollTop).toBe(29);
        expect(onChange).toHaveBeenCalledExactlyOnceWith(
          "octodog",
        );
        expect(onPick).toHaveBeenCalledExactlyOnceWith(
          "octodog",
        );
        expect(onSubmit).not.toHaveBeenCalled();
        expect(onRoleChange).not.toHaveBeenCalled();
        expect(onDialogClose).not.toHaveBeenCalled();
        expect(searchUsers).toHaveBeenCalledOnce();
      } finally {
        await act(async () => root.unmount());
        host.remove();
      }
    },
  );

  it("fences public prevention reentry without duplicating state or poisoning a clean successor", async () => {
    searchUsers.mockImplementation(() =>
      answer("octocat", "octodog", "octofox"),
    );
    const onChange = vi.fn();
    const preventDefault = vi.spyOn(
      window.Event.prototype,
      "preventDefault",
    );
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);

    try {
      await act(async () => {
        root.render(
          <StrictMode>
            <DirectHarness
              initialValue="octo"
              onChange={onChange}
            />
          </StrictMode>,
        );
      });
      const exactInput = input();
      exactInput.focus();
      await settle();
      fireEvent.mouseOver(listOptions()[1]);
      let reentered = false;
      const restore = interceptReactHandler<
        KeyboardEvent<HTMLInputElement>
      >(exactInput, "onKeyDown", (original, event) => {
        const retainedPreventDefault = event.preventDefault;
        Object.defineProperty(event, "preventDefault", {
          configurable: true,
          enumerable: true,
          writable: true,
          value: function (this: object) {
            if (!reentered) {
              reentered = true;
              original(event);
            }
            return Reflect.apply(retainedPreventDefault, this, []);
          },
        });
        original(event);
      });
      preventDefault.mockClear();

      const handled = dispatchKeyDown(exactInput, "Home");
      restore();

      expect(reentered).toBe(true);
      expect(handled.defaultPrevented).toBe(true);
      expect(preventDefault).toHaveBeenCalledOnce();
      expect(listOptions()[0]).toHaveAttribute(
        "aria-selected",
        "true",
      );
      expect(onChange).not.toHaveBeenCalled();

      preventDefault.mockClear();
      const recovered = dispatchKeyDown(exactInput, "Home");
      expect(recovered.defaultPrevented).toBe(true);
      expect(preventDefault).toHaveBeenCalledOnce();
      expect(listOptions()[0]).toHaveAttribute(
        "aria-selected",
        "true",
      );
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it("accepts the event-proven backing Window receiver behind the public owner Window", async () => {
    searchUsers.mockImplementation(() =>
      answer("octocat", "octodog", "octofox"),
    );
    const onChange = vi.fn();
    const preventDefault = vi.spyOn(
      window.Event.prototype,
      "preventDefault",
    );
    const actualWindow = window as Window & typeof globalThis;
    const publicWindow = new Proxy(actualWindow, {});
    Object.defineProperty(document, "defaultView", {
      configurable: true,
      value: publicWindow,
    });
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);

    try {
      await act(async () => {
        root.render(
          <StrictMode>
            <DirectHarness
              initialValue="octo"
              onChange={onChange}
            />
          </StrictMode>,
        );
      });
      const exactInput = input();
      exactInput.focus();
      await settle();
      fireEvent.mouseOver(listOptions()[1]);
      preventDefault.mockClear();
      let backingReceiverObserved = false;
      actualWindow.addEventListener(
        "keydown",
        function (event) {
          expect(this).not.toBe(publicWindow);
          backingReceiverObserved = true;
          requiredKeyboardEventImplementation(event).view =
            this as Window;
        },
        { capture: true, once: true },
      );
      const event = keyboardEvent(exactInput, "Home", {
        view: null,
      });

      act(() => {
        exactInput.dispatchEvent(event);
      });
      expect(document.defaultView).toBe(publicWindow);
      expect(document.defaultView).toBe(publicWindow);
      expect(backingReceiverObserved).toBe(true);
      expect(event.composedPath()).toEqual([]);
      expect(event.defaultPrevented).toBe(true);
      expect(preventDefault).toHaveBeenCalledOnce();
      expect(listOptions()[0]).toHaveAttribute(
        "aria-selected",
        "true",
      );
      expect(onChange).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      host.remove();
      Reflect.deleteProperty(document, "defaultView");
    }
  });

  it.each([
    { key: "Home", destination: 0 },
    { key: "End", destination: 2 },
  ])(
    "$key moves from every candidate to the exact boundary, including a no-op destination, without other Share work",
    async ({ key, destination }) => {
      searchUsers.mockImplementation(() => answer("octocat", "octodog", "octofox"));
      const onChange = vi.fn();
      const onPick = vi.fn();
      const onSubmit = vi.fn();
      const onRoleChange = vi.fn();
      const onDialogClose = vi.fn();
      const preventDefault = vi.spyOn(window.Event.prototype, "preventDefault");
      const focus = vi.spyOn(window.HTMLElement.prototype, "focus");
      const host = document.createElement("div");
      document.body.append(host);
      const root = createRoot(host);

      try {
        await act(async () => {
          root.render(
            <StrictMode>
              <KeyboardHarness
                onChange={onChange}
                onPick={onPick}
                onSubmit={onSubmit}
                onRoleChange={onRoleChange}
                onDialogClose={onDialogClose}
              />
            </StrictMode>,
          );
        });
        const exactInput = input();
        exactInput.focus();
        await settle();
        expect(options()).toEqual(["octocat", "octodog", "octofox"]);
        document.documentElement.scrollTop = 19;

        for (let source = 0; source < 3; source++) {
          fireEvent.mouseOver(listOptions()[source]);
          expect(listOptions()[source]).toHaveAttribute("aria-selected", "true");
          preventDefault.mockClear();
          focus.mockClear();

          const event = dispatchKeyDown(exactInput, key);

          const currentOptions = listOptions();
          expect(event.defaultPrevented).toBe(true);
          expect(preventDefault).toHaveBeenCalledOnce();
          expect(focus).not.toHaveBeenCalled();
          expect(input()).toBe(exactInput);
          expect(exactInput).toHaveFocus();
          expect(exactInput).toHaveValue("octo");
          expect(exactInput).toHaveAttribute("aria-expanded", "true");
          expect(currentOptions.filter((option) => option.getAttribute("aria-selected") === "true")).toEqual([
            currentOptions[destination],
          ]);
          expect(exactInput).toHaveAttribute("aria-activedescendant", currentOptions[destination].id);
          expect(screen.getByRole("combobox", { name: "Role" })).toHaveValue("editor");
          expect(screen.getByTestId("share-dialog-shell")).toBeInTheDocument();
          expect(document.documentElement.scrollTop).toBe(19);
          expect(onChange).not.toHaveBeenCalled();
          expect(onPick).not.toHaveBeenCalled();
          expect(onSubmit).not.toHaveBeenCalled();
          expect(onRoleChange).not.toHaveBeenCalled();
          expect(onDialogClose).not.toHaveBeenCalled();
          expect(searchUsers).toHaveBeenCalledOnce();
        }
      } finally {
        await act(async () => root.unmount());
        host.remove();
      }
    },
  );

  it.each(["Home", "End"])(
    "%s rejects modified, repeated, composing, non-cancelable, unfocused, stopped, prevented, closed, and empty-list keys",
    async (key) => {
      searchUsers.mockImplementation(() => answer("octocat", "octodog", "octofox"));
      const onChange = vi.fn();
      const cleanOnChange = vi.fn();
      const onPick = vi.fn();
      const onSubmit = vi.fn();
      const onRoleChange = vi.fn();
      const onDialogClose = vi.fn();
      const preventDefault = vi.spyOn(window.Event.prototype, "preventDefault");
      const focus = vi.spyOn(window.HTMLElement.prototype, "focus");
      const host = document.createElement("div");
      document.body.append(host);
      const root = createRoot(host);

      try {
        await act(async () => {
          root.render(
            <StrictMode>
              <KeyboardHarness
                onChange={onChange}
                onPick={onPick}
                onSubmit={onSubmit}
                onRoleChange={onRoleChange}
                onDialogClose={onDialogClose}
              />
            </StrictMode>,
          );
        });
        const exactInput = input();
        exactInput.focus();
        await settle();
        fireEvent.mouseOver(listOptions()[1]);
        const assertUnchanged = () => {
          const currentOptions = listOptions();
          expect(currentOptions[1]).toHaveAttribute("aria-selected", "true");
          expect(currentOptions.filter((option) => option.getAttribute("aria-selected") === "true")).toHaveLength(1);
          expect(exactInput).toHaveAttribute("aria-activedescendant", currentOptions[1].id);
          expect(exactInput).toHaveValue("octo");
          expect(onChange).not.toHaveBeenCalled();
          expect(cleanOnChange).not.toHaveBeenCalled();
          expect(onPick).not.toHaveBeenCalled();
          expect(onSubmit).not.toHaveBeenCalled();
          expect(onRoleChange).not.toHaveBeenCalled();
          expect(onDialogClose).not.toHaveBeenCalled();
          expect(searchUsers).toHaveBeenCalledOnce();
          expect(focus).not.toHaveBeenCalled();
        };
        const reject = (init: KeyboardEventInit) => {
          preventDefault.mockClear();
          focus.mockClear();
          const event = dispatchKeyDown(exactInput, key, init);
          expect(event.defaultPrevented).toBe(false);
          expect(preventDefault).not.toHaveBeenCalled();
          assertUnchanged();
        };

        for (const init of [
          { ctrlKey: true },
          { altKey: true },
          { metaKey: true },
          { shiftKey: true },
          { repeat: true },
          { isComposing: true },
          { cancelable: false },
          { bubbles: false },
        ] satisfies KeyboardEventInit[]) {
          reject(init);
        }

        const role = screen.getByRole("combobox", { name: "Role" });
        role.focus();
        reject({});
        exactInput.focus();

        const prevented = new window.KeyboardEvent("keydown", {
          bubbles: true,
          cancelable: true,
          key,
        });
        prevented.preventDefault();
        preventDefault.mockClear();
        focus.mockClear();
        act(() => {
          exactInput.dispatchEvent(prevented);
        });
        expect(preventDefault).not.toHaveBeenCalled();
        assertUnchanged();

        const stopped = new window.KeyboardEvent("keydown", {
          bubbles: true,
          cancelable: true,
          key,
        });
        stopped.stopPropagation();
        preventDefault.mockClear();
        focus.mockClear();
        act(() => {
          exactInput.dispatchEvent(stopped);
        });
        expect(preventDefault).not.toHaveBeenCalled();
        assertUnchanged();

        const fabricatedPrevent = vi.fn();
        const keydown = reactHandler<(event: KeyboardEvent<HTMLInputElement>) => void>(exactInput, "onKeyDown");
        focus.mockClear();
        act(() => {
          keydown({
            key,
            currentTarget: exactInput,
            target: exactInput,
            preventDefault: fabricatedPrevent,
          } as unknown as KeyboardEvent<HTMLInputElement>);
        });
        expect(fabricatedPrevent).not.toHaveBeenCalled();
        assertUnchanged();

        const iframe = document.createElement("iframe");
        document.body.append(iframe);
        const foreignWindow = iframe.contentWindow as
          | (Window & typeof globalThis)
          | null;
        if (!foreignWindow) throw new Error("The foreign keyboard realm was unavailable");
        preventDefault.mockClear();
        focus.mockClear();
        const foreignEvent = new foreignWindow.KeyboardEvent("keydown", {
          bubbles: true,
          cancelable: true,
          key,
        });
        act(() => {
          exactInput.dispatchEvent(foreignEvent);
        });
        expect(foreignEvent.defaultPrevented).toBe(false);
        expect(preventDefault).not.toHaveBeenCalled();
        assertUnchanged();
        iframe.remove();

        await act(async () => {
          root.render(
            <StrictMode>
              <KeyboardHarness
                onChange={cleanOnChange}
                onPick={onPick}
                onSubmit={onSubmit}
                onRoleChange={onRoleChange}
                onDialogClose={onDialogClose}
              />
            </StrictMode>,
          );
          await Promise.resolve();
        });
        const cleanInput = input();
        const cleanKeydown = reactHandler<
          (event: KeyboardEvent<HTMLInputElement>) => void
        >(cleanInput, "onKeyDown");
        expect(cleanKeydown).not.toBe(keydown);
        expect(cleanInput).toBe(exactInput);
        expect(cleanInput).toHaveFocus();
        expect(options()).toEqual(["octocat", "octodog", "octofox"]);
        expect(searchUsers).toHaveBeenCalledOnce();

        preventDefault.mockClear();
        focus.mockClear();
        const escaped = dispatchKeyDown(cleanInput, "Escape");
        expect(escaped.defaultPrevented).toBe(true);
        expect(preventDefault).toHaveBeenCalledOnce();
        expect(focus).not.toHaveBeenCalled();
        expect(screen.queryByTestId("share-login-suggestions")).toBeNull();
        preventDefault.mockClear();
        focus.mockClear();
        const closed = dispatchKeyDown(cleanInput, key);
        expect(closed.defaultPrevented).toBe(false);
        expect(preventDefault).not.toHaveBeenCalled();
        expect(focus).not.toHaveBeenCalled();
        expect(cleanInput).not.toHaveAttribute("aria-activedescendant");
        expect(cleanInput).toHaveValue("octo");
        expect(cleanOnChange).not.toHaveBeenCalled();
        expect(onPick).not.toHaveBeenCalled();
        expect(onSubmit).not.toHaveBeenCalled();
        expect(onRoleChange).not.toHaveBeenCalled();
        expect(onDialogClose).not.toHaveBeenCalled();
        expect(searchUsers).toHaveBeenCalledOnce();

        dispatchKeyDown(cleanInput, "ArrowDown");
        preventDefault.mockClear();
        focus.mockClear();
        const recovered = dispatchKeyDown(cleanInput, key);
        expect(recovered.defaultPrevented).toBe(true);
        expect(preventDefault).toHaveBeenCalledOnce();
        expect(focus).not.toHaveBeenCalled();
        expect(listOptions()[key === "Home" ? 0 : 2]).toHaveAttribute("aria-selected", "true");
        expect(cleanInput).toHaveFocus();
        expect(cleanInput).toHaveValue("octo");
        expect(cleanOnChange).not.toHaveBeenCalled();
        expect(onPick).not.toHaveBeenCalled();
        expect(onSubmit).not.toHaveBeenCalled();
        expect(onRoleChange).not.toHaveBeenCalled();
        expect(onDialogClose).not.toHaveBeenCalled();
        expect(searchUsers).toHaveBeenCalledOnce();
      } finally {
        await act(async () => root.unmount());
        host.remove();
      }

      searchUsers.mockImplementation(() => answer());
      const emptyHost = document.createElement("div");
      document.body.append(emptyHost);
      const emptyRoot = createRoot(emptyHost);
      try {
        await act(async () => {
          emptyRoot.render(
            <StrictMode>
              <DirectHarness initialValue="octo" onChange={onChange} onPick={onPick} />
            </StrictMode>,
          );
        });
        input().focus();
        await settle();
        preventDefault.mockClear();
        const empty = dispatchKeyDown(input(), key);
        expect(empty.defaultPrevented).toBe(false);
        expect(preventDefault).not.toHaveBeenCalled();
        expect(screen.queryByTestId("share-login-suggestions")).toBeNull();
      } finally {
        await act(async () => emptyRoot.unmount());
        emptyHost.remove();
      }
    },
  );

  it.each([
    { key: "Home", destination: 0 },
    { key: "End", destination: 2 },
  ])(
    "$key ignores wrong-source and duplicate keyboard deliveries without poisoning the rightful route",
    async ({ key, destination }) => {
      searchUsers.mockImplementation(() => answer("octocat", "octodog", "octofox"));
      const onChange = vi.fn();
      const onPick = vi.fn();
      const preventDefault = vi.spyOn(window.Event.prototype, "preventDefault");
      const host = document.createElement("div");
      document.body.append(host);
      const root = createRoot(host);

      try {
        await act(async () => {
          root.render(
            <StrictMode>
              <DirectHarness initialValue="octo" onChange={onChange} onPick={onPick} />
            </StrictMode>,
          );
        });
        const exactInput = input();
        exactInput.focus();
        await settle();
        fireEvent.mouseOver(listOptions()[1]);
        const restore = interceptReactHandler<KeyboardEvent<HTMLInputElement>>(
          exactInput,
          "onKeyDown",
          (current, event) => {
            const wrongInput = independentKeyboardDelivery(event);
            wrongInput.values.set("currentTarget", document.createElement("input"));
            const wrongRoot = independentKeyboardDelivery(event);
            wrongRoot.values.set("target", exactInput.parentElement);
            current(wrongInput.event as KeyboardEvent<HTMLInputElement>);
            current(wrongRoot.event as KeyboardEvent<HTMLInputElement>);
            current(event);
            current(event);
          },
        );
        preventDefault.mockClear();
        const event = dispatchKeyDown(exactInput, key);
        restore();

        expect(event.defaultPrevented).toBe(true);
        expect(preventDefault).toHaveBeenCalledOnce();
        expect(listOptions()[destination]).toHaveAttribute("aria-selected", "true");
        expect(onChange).not.toHaveBeenCalled();
        expect(onPick).not.toHaveBeenCalled();
        expect(searchUsers).toHaveBeenCalledOnce();

        preventDefault.mockClear();
        const recovered = dispatchKeyDown(exactInput, key);
        expect(recovered.defaultPrevented).toBe(true);
        expect(preventDefault).toHaveBeenCalledOnce();
        expect(listOptions()[destination]).toHaveAttribute("aria-selected", "true");
      } finally {
        await act(async () => root.unmount());
        host.remove();
      }
    },
  );

  it.each([
    { key: "Home", destination: 0 },
    { key: "End", destination: 2 },
  ])(
    "$key rejects a stale lookup, value, callback, and candidate-order generation before a fresh recovery",
    async ({ key, destination }) => {
      searchUsers.mockImplementation((query) =>
        query === "octo"
          ? answer("octocat", "octodog", "octofox")
          : answer("octofox", "octodog", "octocat"),
      );
      const onChangeA = vi.fn();
      const onChangeB = vi.fn();
      const onPickA = vi.fn();
      const onPickB = vi.fn();
      const preventDefault = vi.spyOn(window.Event.prototype, "preventDefault");
      const host = document.createElement("div");
      document.body.append(host);
      const root = createRoot(host);
      const view = (value: string, onChange: (login: string) => void, onPick: (login: string) => void) => (
        <StrictMode>
          <CollaboratorLoginInput value={value} onChange={onChange} onPick={onPick} exclude={[]} />
        </StrictMode>
      );

      try {
        await act(async () => root.render(view("octo", onChangeA, onPickA)));
        const exactInput = input();
        exactInput.focus();
        await settle();
        fireEvent.mouseOver(listOptions()[1]);
        const staleKeydown = reactHandler<(event: KeyboardEvent<HTMLInputElement>) => void>(
          exactInput,
          "onKeyDown",
        );

        await act(async () => root.render(view("octof", onChangeB, onPickB)));
        await settle();
        expect(input()).toBe(exactInput);
        expect(options()).toEqual(["octofox", "octodog", "octocat"]);
        fireEvent.mouseOver(listOptions()[1]);
        const restore = interceptReactHandler<KeyboardEvent<HTMLInputElement>>(
          exactInput,
          "onKeyDown",
          (_current, event) => {
            staleKeydown(event);
          },
        );
        preventDefault.mockClear();
        const stale = dispatchKeyDown(exactInput, key);
        restore();

        expect(stale.defaultPrevented).toBe(false);
        expect(preventDefault).not.toHaveBeenCalled();
        expect(listOptions()[1]).toHaveAttribute("aria-selected", "true");
        expect(exactInput).toHaveValue("octof");
        expect(onChangeA).not.toHaveBeenCalled();
        expect(onChangeB).not.toHaveBeenCalled();
        expect(onPickA).not.toHaveBeenCalled();
        expect(onPickB).not.toHaveBeenCalled();

        preventDefault.mockClear();
        const recovered = dispatchKeyDown(exactInput, key);
        expect(recovered.defaultPrevented).toBe(true);
        expect(preventDefault).toHaveBeenCalledOnce();
        expect(listOptions()[destination]).toHaveAttribute("aria-selected", "true");
        expect(searchUsers.mock.calls.map(([query]) => query)).toEqual(["octo", "octof"]);
      } finally {
        await act(async () => root.unmount());
        host.remove();
      }
    },
  );

  it.each([
    "detached input",
    "detached list",
    "detached row",
    "reordered rows",
    "replaced input",
    "replaced list",
    "replaced row",
  ] as const)(
    "Home/End reject %s restored before delivery and a complete current successor recovers",
    async (transition) => {
      searchUsers.mockImplementation(() => answer("octocat", "octodog", "octofox"));
      const onChangeA = vi.fn();
      const onChangeB = vi.fn();
      const onPickA = vi.fn();
      const onPickB = vi.fn();
      const preventDefault = vi.spyOn(window.Event.prototype, "preventDefault");
      const host = document.createElement("div");
      document.body.append(host);
      const root = createRoot(host);
      const view = (
        instance: string,
        onChange: (login: string) => void,
        onPick: (login: string) => void,
      ) => (
        <StrictMode>
          <AuthorityBoundary
            instance={instance}
            value="octo"
            onChange={onChange}
            onPick={onPick}
            exclude={[]}
          />
        </StrictMode>
      );

      try {
        await act(async () =>
          root.render(view("A", onChangeA, onPickA)),
        );
        const exactInput = input();
        exactInput.focus();
        await settle();
        fireEvent.mouseOver(listOptions()[1]);
        const staleKeydown = reactHandler<
          (event: KeyboardEvent<HTMLInputElement>) => void
        >(exactInput, "onKeyDown");
        const list = screen.getByTestId("share-login-suggestions");
        const rows = listOptions();
        const target =
          transition.endsWith("input")
            ? exactInput
            : transition.endsWith("list")
              ? list
              : rows[0];

        act(() => {
          if (transition === "reordered rows") {
            const next = rows[0].nextSibling;
            list.append(rows[0]);
            list.insertBefore(rows[0], next);
          } else if (transition.startsWith("detached")) {
            const parent = target.parentNode;
            const next = target.nextSibling;
            if (!parent) throw new Error("The restored target had no parent");
            target.remove();
            parent.insertBefore(target, next);
          } else {
            const replacement = target.cloneNode(true);
            const parent = target.parentNode;
            if (!parent) throw new Error("The replaced target had no parent");
            parent.replaceChild(replacement, target);
            parent.replaceChild(target, replacement);
          }
        });

        const restoreStale = interceptReactHandler<
          KeyboardEvent<HTMLInputElement>
        >(exactInput, "onKeyDown", (_current, event) => {
          staleKeydown(event);
        });
        preventDefault.mockClear();
        const rejected = dispatchKeyDown(exactInput, "Home");
        restoreStale();
        expect(rejected.defaultPrevented).toBe(false);
        expect(preventDefault).not.toHaveBeenCalled();
        expect(listOptions()[1]).toHaveAttribute("aria-selected", "true");
        expect(onChangeA).not.toHaveBeenCalled();
        expect(onPickA).not.toHaveBeenCalled();

        await act(async () => {
          await Promise.resolve();
          root.render(view("B", onChangeB, onPickB));
        });
        const successorInput = input();
        const successorKeydown = reactHandler<
          (event: KeyboardEvent<HTMLInputElement>) => void
        >(successorInput, "onKeyDown");
        expect(successorInput).not.toBe(exactInput);
        expect(successorKeydown).not.toBe(staleKeydown);
        successorInput.focus();
        await settle();
        preventDefault.mockClear();
        const home = dispatchKeyDown(successorInput, "Home");
        expect(home.defaultPrevented).toBe(true);
        expect(preventDefault).toHaveBeenCalledOnce();
        expect(listOptions()[0]).toHaveAttribute("aria-selected", "true");

        preventDefault.mockClear();
        const end = dispatchKeyDown(successorInput, "End");
        expect(end.defaultPrevented).toBe(true);
        expect(preventDefault).toHaveBeenCalledOnce();
        expect(listOptions()[2]).toHaveAttribute("aria-selected", "true");
        expect(successorInput).toHaveFocus();
        expect(successorInput).toHaveValue("octo");
        expect(onChangeA).not.toHaveBeenCalled();
        expect(onChangeB).not.toHaveBeenCalled();
        expect(onPickA).not.toHaveBeenCalled();
        expect(onPickB).not.toHaveBeenCalled();
        expect(searchUsers).toHaveBeenCalledTimes(2);
      } finally {
        await act(async () => root.unmount());
        host.remove();
      }
    },
  );

  it("rejects a partial Strict Mode ref replay and accepts one complete current Home successor", async () => {
    searchUsers.mockImplementation(() => answer("octocat", "octodog", "octofox"));
    const onChangeA = vi.fn();
    const onChangeB = vi.fn();
    const onPickA = vi.fn();
    const onPickB = vi.fn();
    const preventDefault = vi.spyOn(window.Event.prototype, "preventDefault");
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const view = (
      instance: string,
      onChange: (login: string) => void,
      onPick: (login: string) => void,
    ) => (
      <StrictMode>
        <AuthorityBoundary
          instance={instance}
          value="octo"
          onChange={onChange}
          onPick={onPick}
          exclude={[]}
        />
      </StrictMode>
    );

    try {
      await act(async () =>
        root.render(view("A", onChangeA, onPickA)),
      );
      const exactInput = input();
      exactInput.focus();
      await settle();
      fireEvent.mouseOver(listOptions()[1]);
      const staleKeydown = reactHandler<(event: KeyboardEvent<HTMLInputElement>) => void>(
        exactInput,
        "onKeyDown",
      );
      let retainedEvent: KeyboardEvent<HTMLInputElement> | null = null;
      const restoreCapture = interceptReactHandler<
        KeyboardEvent<HTMLInputElement>
      >(exactInput, "onKeyDown", (_current, event) => {
        retainedEvent = event;
      });
      preventDefault.mockClear();
      const capturedHome = dispatchKeyDown(exactInput, "Home");
      restoreCapture();
      expect(capturedHome.defaultPrevented).toBe(false);
      expect(preventDefault).not.toHaveBeenCalled();
      expect(retainedEvent).not.toBeNull();
      expect(listOptions()[1]).toHaveAttribute("aria-selected", "true");
      const row = listOptions()[0];
      const rowRef = reactRef(row);

      await act(async () => {
        rowRef(null);
        rowRef(row);
        await Promise.resolve();
      });
      preventDefault.mockClear();
      act(() => {
        staleKeydown(retainedEvent!);
      });
      expect(preventDefault).not.toHaveBeenCalled();
      expect(listOptions()[1]).toHaveAttribute("aria-selected", "true");
      expect(onChangeA).not.toHaveBeenCalled();
      expect(onPickA).not.toHaveBeenCalled();
      expect(searchUsers).toHaveBeenCalledOnce();

      await act(async () => {
        root.render(view("B", onChangeB, onPickB));
      });
      const successorInput = input();
      const successorKeydown = reactHandler<
        (event: KeyboardEvent<HTMLInputElement>) => void
      >(successorInput, "onKeyDown");
      expect(successorInput).not.toBe(exactInput);
      expect(successorKeydown).not.toBe(staleKeydown);
      successorInput.focus();
      await settle();
      preventDefault.mockClear();
      const home = dispatchKeyDown(successorInput, "Home");

      expect(home.defaultPrevented).toBe(true);
      expect(preventDefault).toHaveBeenCalledOnce();
      expect(listOptions()[0]).toHaveAttribute("aria-selected", "true");
      expect(successorInput).toHaveFocus();
      expect(successorInput).toHaveValue("octo");
      expect(onChangeA).not.toHaveBeenCalled();
      expect(onChangeB).not.toHaveBeenCalled();
      expect(onPickA).not.toHaveBeenCalled();
      expect(onPickB).not.toHaveBeenCalled();
      expect(searchUsers).toHaveBeenCalledTimes(2);
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it("does no Home/End prevention or state work after cleanup and a fresh mount recovers", async () => {
    searchUsers.mockImplementation(() => answer("octocat", "octodog", "octofox"));
    const onChange = vi.fn();
    const onPick = vi.fn();
    const preventDefault = vi.spyOn(window.Event.prototype, "preventDefault");
    const host = document.createElement("div");
    document.body.append(host);
    const firstRoot = createRoot(host);
    let retainedEvent: KeyboardEvent<HTMLInputElement> | null = null;

    await act(async () => {
      firstRoot.render(
        <StrictMode>
          <DirectHarness initialValue="octo" onChange={onChange} onPick={onPick} />
        </StrictMode>,
      );
    });
    const retiredInput = input();
    retiredInput.focus();
    await settle();
    fireEvent.mouseOver(listOptions()[1]);
    const staleKeydown = reactHandler<(event: KeyboardEvent<HTMLInputElement>) => void>(
      retiredInput,
      "onKeyDown",
    );
    const restore = interceptReactHandler<KeyboardEvent<HTMLInputElement>>(
      retiredInput,
      "onKeyDown",
      (_current, event) => {
        retainedEvent = event;
      },
    );
    preventDefault.mockClear();
    const held = dispatchKeyDown(retiredInput, "Home");
    restore();
    expect(held.defaultPrevented).toBe(false);
    expect(preventDefault).not.toHaveBeenCalled();
    expect(retainedEvent).not.toBeNull();

    await act(async () => firstRoot.unmount());
    preventDefault.mockClear();
    act(() => {
      staleKeydown(retainedEvent!);
    });
    expect(preventDefault).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
    expect(onPick).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);

    const nextRoot = createRoot(host);
    try {
      await act(async () => {
        nextRoot.render(
          <StrictMode>
            <DirectHarness initialValue="octo" onChange={onChange} onPick={onPick} />
          </StrictMode>,
        );
      });
      input().focus();
      await settle();
      preventDefault.mockClear();
      const recovered = dispatchKeyDown(input(), "End");
      expect(recovered.defaultPrevented).toBe(true);
      expect(preventDefault).toHaveBeenCalledOnce();
      expect(listOptions()[2]).toHaveAttribute("aria-selected", "true");
      expect(searchUsers).toHaveBeenCalledTimes(2);
    } finally {
      await act(async () => nextRoot.unmount());
      host.remove();
    }
  });

  it("Enter with no active option submits the typed handle; Escape closes only the list", async () => {
    searchUsers.mockImplementation(() => answer("octocat"));
    const onSubmit = vi.fn();
    render(<Harness onSubmit={onSubmit} />);
    type("octo");
    await settle();
    expect(options()).toEqual(["octocat"]);

    const escaped = dispatchKeyDown(input(), "Escape");
    expect(escaped.defaultPrevented).toBe(true); // claimed, so the dialog does not close on this Escape
    expect(screen.queryByTestId("share-login-suggestions")).toBeNull();
    expect(input().value).toBe("octo");
    // With the list closed, Escape is left to the dialog.
    expect(dispatchKeyDown(input(), "Escape").defaultPrevented).toBe(false);

    // ↓ reopens the list without another request; the arrows wrap, so one option is always active from here on.
    dispatchKeyDown(input(), "ArrowDown");
    expect(options()).toEqual(["octocat"]);
    dispatchKeyDown(input(), "ArrowUp");
    dispatchKeyDown(input(), "ArrowDown");
    expect(listOptions().filter((o) => o.getAttribute("aria-selected") === "true")).toHaveLength(1);
    expect(searchUsers).toHaveBeenCalledTimes(1);

    // A fresh answer starts with nothing active; Escape, then Enter submits what was typed.
    type("octopus");
    await settle();
    expect(listOptions().filter((o) => o.getAttribute("aria-selected") === "true")).toHaveLength(0);
    dispatchKeyDown(input(), "Escape");
    const submitted = dispatchKeyDown(input(), "Enter");
    expect(submitted.defaultPrevented).toBe(false);
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

  it("mints a current row publication after the avatar image falls back", async () => {
    searchUsers.mockImplementation(() => answer("octocat"));
    const onPick = vi.fn();
    render(<Harness onPick={onPick} />);
    type("octo");
    await settle();
    const retiredRow = screen.getByTestId("share-login-option");
    const image = retiredRow.querySelector("img");
    expect(image).not.toBeNull();

    fireEvent.error(image!);
    await act(async () => {
      await Promise.resolve();
    });
    const currentRow = screen.getByTestId("share-login-option");
    expect(currentRow.querySelector("img")).toHaveAttribute("hidden");
    expect(within(currentRow).getByText("OC")).toBeInTheDocument();

    fireEvent.click(currentRow);
    expect(onPick).toHaveBeenCalledOnce();
    expect(onPick).toHaveBeenCalledWith("octocat");
  });

  it("keeps the same input current after an exact-value pick whose controlled change is a no-op", async () => {
    searchUsers.mockImplementation((q) => answer(q));
    const onChange = vi.fn();
    const onPick = vi.fn();
    render(<ExactValueHarness onChange={onChange} onPick={onPick} />);
    const exactInput = input();
    exactInput.focus();
    await settle();
    expect(options()).toEqual(["octocat"]);
    const exactOption = screen.getByTestId("share-login-option");
    const capturedPick = reactHandler<(event: MouseEvent<HTMLLIElement>) => void>(exactOption, "onClick");

    fireEvent.click(exactOption);
    expect(onChange).toHaveBeenCalledOnce();
    expect(onChange).toHaveBeenCalledWith("octocat");
    expect(onPick).toHaveBeenCalledOnce();
    expect(onPick).toHaveBeenCalledWith("octocat");
    expect(screen.queryByTestId("share-login-suggestions")).toBeNull();
    expect(input()).toBe(exactInput);

    act(() => {
      capturedPick(mouseSource(exactOption));
      capturedPick(mouseSource(exactOption));
    });
    expect(onChange).toHaveBeenCalledOnce();
    expect(onPick).toHaveBeenCalledOnce();
    expect(searchUsers).toHaveBeenCalledTimes(1);

    fireEvent.change(exactInput, { target: { value: "octodog" } });
    fireEvent.focus(exactInput);
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(onChange).toHaveBeenLastCalledWith("octodog");
    expect(input()).toBe(exactInput);
    await settle();

    expect(searchUsers.mock.calls.map(([q]) => q)).toEqual(["octocat", "octodog"]);
    expect(options()).toEqual(["octodog"]);
    fireEvent.mouseOver(screen.getByTestId("share-login-option"));
    expect(screen.getByTestId("share-login-option")).toHaveAttribute("aria-selected", "true");
    expect(onPick).toHaveBeenCalledOnce();
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
    expect(dispatchKeyDown(input(), "Enter").defaultPrevented).toBe(false);
    fireEvent.submit(input().closest("form")!);
    expect(onSubmit).toHaveBeenCalledWith("octo");

    fireEvent.click(retry);
    expect(searchUsers).toHaveBeenCalledTimes(2);
    expect(searchUsers.mock.calls[1][0]).toBe("octo");
    expect(
      within(screen.getByRole("alert")).getByRole("button", {
        name: "Retrying…",
      }),
    ).toBeDisabled();
    fireEvent.click(
      within(screen.getByRole("alert")).getByRole("button", {
        name: "Retrying…",
      }),
    );
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
      retried.resolve({
        users: [user("octocat"), user("octodog")],
        limited: false,
      });
    });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(options()).toEqual(["octocat", "octodog"]);
    expect(input()).toHaveAttribute("aria-expanded", "true");
  });

  it("after the route answers reason=no-github-token it asks no more while mounted: one request for a whole share, no hint, the box still types (task #1481)", async () => {
    searchUsers.mockImplementation(() =>
      Promise.resolve({
        users: [],
        limited: false,
        reason: "no-github-token" as const,
      }),
    );
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
      pending.get("oc")!({
        users: [],
        limited: false,
        reason: "no-github-token",
      });
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
    searchUsers.mockRejectedValueOnce(new ApiError(503, "Old query failed")).mockReturnValueOnce(oldRetry.promise).mockRejectedValueOnce(new ApiError(503, "Current query failed"));
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

  it("keeps one timer for equal normalized exclusions with different array identity", async () => {
    const timers = trackDebounceTimers(true);
    const onChange = vi.fn();
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    searchUsers.mockImplementation(() => answer("octocat", "octodog"));
    let pendingAtBoundary = -1;

    try {
      await act(async () => {
        root.render(<AuthorityBoundary instance="same" value="octo" onChange={onChange} exclude={["@OCTOCAT", "octodog", "octodog"]} />);
      });
      expect(timers.records).toHaveLength(1);
      const exactTimer = timers.records[0];

      await act(async () => {
        root.render(
          <AuthorityBoundary
            instance="same"
            value="octo"
            onChange={onChange}
            exclude={["octodog", "octocat"]}
            boundary={1}
            onBoundary={() => {
              pendingAtBoundary = timers.pending().length;
            }}
          />,
        );
      });

      expect(pendingAtBoundary).toBe(1);
      expect(timers.records).toEqual([exactTimer]);
      expect(exactTimer.cleared).toBe(false);
      await act(async () => {
        timers.fire(exactTimer);
        await Promise.resolve();
      });
      expect(searchUsers).toHaveBeenCalledTimes(1);
      expect(searchUsers).toHaveBeenCalledWith("octo", expect.objectContaining({ signal: expect.any(AbortSignal) }));
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it("cancels only A's timer when callback replacement reuses its handle, and B still searches once", async () => {
    const timers = trackDebounceTimers(true);
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const onChangeA = vi.fn();
    const onChangeB = vi.fn();
    searchUsers.mockImplementation(() => answer("octocat"));
    let pendingAtBoundary = -1;
    let retiredClearedAtBoundary = false;

    try {
      await act(async () => {
        root.render(<AuthorityBoundary instance="same" value="octo" onChange={onChangeA} exclude={[]} />);
      });
      const retiredTimer = timers.records[0];
      expect(retiredTimer.pending).toBe(true);

      await act(async () => {
        root.render(
          <AuthorityBoundary
            instance="same"
            value="octo"
            onChange={onChangeB}
            exclude={[]}
            boundary={1}
            onBoundary={() => {
              pendingAtBoundary = timers.pending().length;
              retiredClearedAtBoundary = retiredTimer.cleared;
              timers.fire(retiredTimer);
            }}
          />,
        );
      });

      expect(pendingAtBoundary).toBe(0);
      expect(retiredClearedAtBoundary).toBe(true);
      expect(searchUsers).not.toHaveBeenCalled();
      expect(timers.records).toHaveLength(2);
      const currentTimer = timers.records[1];
      expect(currentTimer.handle).toBe(retiredTimer.handle);
      expect(currentTimer.pending).toBe(true);
      expect(currentTimer.cleared).toBe(false);

      await act(async () => {
        timers.fire(retiredTimer);
        timers.fire(currentTimer);
        await Promise.resolve();
      });
      expect(searchUsers).toHaveBeenCalledTimes(1);
      expect(searchUsers.mock.calls[0][0]).toBe("octo");
      expect(currentTimer.cleared).toBe(false);
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it.each(["stale-first", "current-first"] as const)("isolates equal-query requests and equal users across callback replacement ($order)", async (order) => {
    const retired = deferred<SearchAnswer>();
    const current = deferred<SearchAnswer>();
    searchUsers.mockReturnValueOnce(retired.promise).mockReturnValueOnce(current.promise);
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const onChangeA = vi.fn();
    const onChangeB = vi.fn();
    const onPickA = vi.fn();
    const onPickB = vi.fn();
    let abortedAtBoundary = false;
    let aborts = 0;
    let reusedInput = false;

    try {
      await act(async () => {
        root.render(<AuthorityBoundary instance="same" value="octo" onChange={onChangeA} onPick={onPickA} exclude={[]} />);
      });
      const exactInput = input();
      exactInput.focus();
      await settle();
      const retiredSignal = searchUsers.mock.calls[0][1]?.signal;
      retiredSignal?.addEventListener("abort", () => {
        aborts++;
      });

      await act(async () => {
        root.render(
          <AuthorityBoundary
            instance="same"
            value="octo"
            onChange={onChangeB}
            onPick={onPickB}
            exclude={[]}
            boundary={1}
            onBoundary={() => {
              abortedAtBoundary = retiredSignal?.aborted === true;
              reusedInput = input() === exactInput;
            }}
          />,
        );
      });
      expect(abortedAtBoundary).toBe(true);
      expect(aborts).toBe(1);
      expect(reusedInput).toBe(true);
      await settle();
      expect(searchUsers).toHaveBeenCalledTimes(2);
      const currentSignal = searchUsers.mock.calls[1][1]?.signal;
      expect(currentSignal?.aborted).toBe(false);

      const settleRetired = async () => {
        retired.resolve({ users: [{ ...user("octocat") }], limited: false });
        await retired.promise;
        await Promise.resolve();
      };
      const settleCurrent = async () => {
        current.resolve({ users: [{ ...user("octocat") }], limited: false });
        await current.promise;
        await Promise.resolve();
      };

      if (order === "stale-first") {
        await act(settleRetired);
        expect(options()).toEqual([]);
        expect(screen.getByRole("status")).toHaveTextContent("@octo");
        expect(currentSignal?.aborted).toBe(false);
        await act(settleCurrent);
      } else {
        await act(settleCurrent);
        expect(options()).toEqual(["octocat"]);
        await act(settleRetired);
      }

      expect(options()).toEqual(["octocat"]);
      expect(currentSignal?.aborted).toBe(false);
      expect(aborts).toBe(1);
      expect(onChangeA).not.toHaveBeenCalled();
      expect(onPickA).not.toHaveBeenCalled();
      expect(onChangeB).not.toHaveBeenCalled();
      expect(onPickB).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it.each([
    { label: "equal-query value replacement", value: " @octo ", exclude: [] },
    { label: "exclusion replacement", value: "octo", exclude: ["octocat"] },
  ])("retires the exact pending request for $label", async ({ value: nextValue, exclude: nextExclude }) => {
    const retired = deferred<SearchAnswer>();
    const current = deferred<SearchAnswer>();
    searchUsers.mockReturnValueOnce(retired.promise).mockReturnValueOnce(current.promise);
    const onChange = vi.fn();
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    let abortedAtBoundary = false;

    try {
      await act(async () => {
        root.render(<AuthorityBoundary instance="same" value="octo" onChange={onChange} exclude={[]} />);
      });
      input().focus();
      await settle();
      const retiredSignal = searchUsers.mock.calls[0][1]?.signal;

      await act(async () => {
        root.render(
          <AuthorityBoundary
            instance="same"
            value={nextValue}
            onChange={onChange}
            exclude={nextExclude}
            boundary={1}
            onBoundary={() => {
              abortedAtBoundary = retiredSignal?.aborted === true;
            }}
          />,
        );
      });
      expect(abortedAtBoundary).toBe(true);
      await settle();
      expect(searchUsers.mock.calls.map(([q]) => q)).toEqual(["octo", "octo"]);
      expect(searchUsers.mock.calls[1][1]?.signal?.aborted).toBe(false);

      await act(async () => {
        retired.resolve({ users: [user("retired-user")], limited: false });
        current.resolve({
          users: [user("octocat"), user("octodog")],
          limited: false,
        });
        await Promise.all([retired.promise, current.promise]);
      });
      expect(options()).toEqual(nextExclude.length ? ["octodog"] : ["octocat", "octodog"]);
      expect(onChange).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it("rejects sibling, foreign, detached, and mismatched input or control event sources before any work", async () => {
    searchUsers.mockImplementation(() => answer("octocat", "octodog"));
    const onChange = vi.fn();
    const onPick = vi.fn();
    const rendered = render(<AuthorityBoundary instance="same" value="octo" onChange={onChange} onPick={onPick} exclude={[]} />);
    const exactInput = input();
    exactInput.focus();
    await settle();
    const control = exactInput.parentElement as HTMLDivElement;
    const change = reactHandler<(event: ChangeEvent<HTMLInputElement>) => void>(exactInput, "onChange");
    const focus = reactHandler<(event: FocusEvent<HTMLInputElement>) => void>(exactInput, "onFocus");
    const keydown = reactHandler<(event: KeyboardEvent<HTMLInputElement>) => void>(exactInput, "onKeyDown");
    const blur = reactHandler<(event: FocusEvent<HTMLInputElement>) => void>(exactInput, "onBlur");
    const sibling = document.createElement("input");
    const foreign = document.createElement("input");
    const detached = document.createElement("input");
    const foreignControl = document.createElement("div");
    sibling.value = "sibling";
    foreign.value = "foreign";
    detached.value = "detached";
    control.append(sibling);
    document.body.append(foreign, foreignControl);
    const keyPrevents = [vi.fn(), vi.fn(), vi.fn()];

    act(() => {
      for (const source of [sibling, foreign, detached]) {
        change({
          currentTarget: source,
          target: source,
        } as ChangeEvent<HTMLInputElement>);
        focus({
          currentTarget: source,
          target: source,
        } as FocusEvent<HTMLInputElement>);
      }
      change({
        currentTarget: exactInput,
        target: sibling,
      } as unknown as ChangeEvent<HTMLInputElement>);
      for (const [index, key] of ["ArrowDown", "Enter", "Escape"].entries()) {
        keydown({
          key,
          currentTarget: sibling,
          target: sibling,
          preventDefault: keyPrevents[index],
        } as unknown as KeyboardEvent<HTMLInputElement>);
      }
      blur({
        currentTarget: foreignControl,
        target: foreignControl,
        relatedTarget: null,
      } as unknown as FocusEvent<HTMLInputElement>);
    });

    expect(onChange).not.toHaveBeenCalled();
    expect(onPick).not.toHaveBeenCalled();
    expect(keyPrevents.every((prevent) => prevent.mock.calls.length === 0)).toBe(true);
    expect(listOptions().every((option) => option.getAttribute("aria-selected") === "false")).toBe(true);
    expect(options()).toEqual(["octocat", "octodog"]);
    expect(exactInput).toHaveFocus();

    sibling.remove();
    foreign.remove();
    foreignControl.remove();
    const exactPrevent = vi.fn();
    act(() => {
      keydown({
        key: "ArrowDown",
        currentTarget: exactInput,
        target: exactInput,
        preventDefault: exactPrevent,
      } as unknown as KeyboardEvent<HTMLInputElement>);
    });
    expect(exactPrevent).not.toHaveBeenCalled();
    expect(listOptions().every((option) => option.getAttribute("aria-selected") === "false")).toBe(true);

    rendered.rerender(
      <AuthorityBoundary instance="same" value="octo" onChange={onChange} onPick={onPick} exclude={[]} />,
    );
    expect(input()).toBe(exactInput);
    expect(dispatchKeyDown(exactInput, "ArrowDown").defaultPrevented).toBe(true);
    expect(listOptions()[0]).toHaveAttribute("aria-selected", "true");
    expect(dispatchKeyDown(exactInput, "Enter").defaultPrevented).toBe(true);
    expect(onChange).toHaveBeenCalledOnce();
    expect(onChange).toHaveBeenCalledWith("octocat");
    expect(onPick).toHaveBeenCalledOnce();
    expect(onPick).toHaveBeenCalledWith("octocat");
  });

  it("binds every pointer handler to its exact ordered row and accepts only the exact React-delivered event", async () => {
    const octocat = {
      login: "octocat",
      name: "The Octocat",
      avatarUrl: "https://avatars.githubusercontent.com/octocat?s=40",
    };
    const octodog = {
      login: "octodog",
      name: "Octo Dog",
      avatarUrl: "https://avatars.githubusercontent.com/octodog?s=40",
    };
    searchUsers.mockResolvedValue({
      users: [octocat, octodog],
      limited: false,
    });
    const onChange = vi.fn();
    const onPick = vi.fn();
    const rendered = render(<AuthorityBoundary instance="same" value="octo" onChange={onChange} onPick={onPick} exclude={[]} />);
    input().focus();
    await settle();
    const list = screen.getByTestId("share-login-suggestions");
    const [first, second] = screen.getAllByTestId("share-login-option");
    const down = reactHandler<(event: MouseEvent<HTMLLIElement>) => void>(first, "onMouseDown");
    const enter = reactHandler<(event: MouseEvent<HTMLLIElement>) => void>(first, "onMouseOver");
    const click = reactHandler<(event: MouseEvent<HTMLLIElement>) => void>(first, "onClick");
    const staleListRef = reactRef(list);
    const staleRowRef = reactRef(first);
    const replacement = first.cloneNode(true) as HTMLLIElement;
    const foreign = document.createElement("li");
    const detached = document.createElement("li");
    list.append(replacement);
    document.body.append(foreign);
    const wrongPrevents = [vi.fn(), vi.fn(), vi.fn(), vi.fn()];

    act(() => {
      for (const [index, source] of [second, replacement, foreign, detached].entries()) {
        down(mouseSource(source, wrongPrevents[index]));
        enter(mouseSource(source));
        click(mouseSource(source));
      }
    });

    expect(wrongPrevents.every((prevent) => prevent.mock.calls.length === 0)).toBe(true);
    expect(onChange).not.toHaveBeenCalled();
    expect(onPick).not.toHaveBeenCalled();
    expect(listOptions().every((option) => option.getAttribute("aria-selected") === "false")).toBe(true);

    replacement.remove();
    foreign.remove();
    const exactPrevent = vi.fn();
    act(() => {
      down(mouseSource(first, exactPrevent));
      enter(mouseSource(first));
    });
    expect(exactPrevent).not.toHaveBeenCalled();
    expect(screen.getAllByTestId("share-login-option")[0]).toHaveAttribute("aria-selected", "false");

    rendered.rerender(
      <AuthorityBoundary instance="same" value="octo" onChange={onChange} onPick={onPick} exclude={[]} />,
    );
    const [currentFirst, currentSecond] = screen.getAllByTestId("share-login-option");
    expect(fireEvent.mouseDown(currentFirst)).toBe(false);
    fireEvent.mouseOver(currentFirst);
    expect(currentFirst).toHaveAttribute("aria-selected", "true");

    expect(currentFirst).toBe(first);
    expect(currentFirst.parentElement).toBe(list);
    const competingClick = reactHandler<(event: MouseEvent<HTMLLIElement>) => void>(currentSecond, "onClick");
    act(() => {
      staleListRef(null);
      staleRowRef(null);
      click(mouseSource(first));
    });
    expect(onChange).not.toHaveBeenCalled();
    expect(onPick).not.toHaveBeenCalled();
    const restoreClick = interceptReactHandler<MouseEvent<HTMLLIElement>>(
      currentFirst,
      "onClick",
      (currentClick, event) => {
        const proxy = new Proxy(event, {});
        const clone = Object.assign(
          Object.create(Object.getPrototypeOf(event)),
          event,
        ) as MouseEvent<HTMLLIElement>;
        currentClick(proxy);
        currentClick(clone);
        currentClick(event);
        competingClick(event);
        currentClick(event);
      },
    );
    fireEvent.click(currentFirst);
    restoreClick();
    act(() => click(mouseSource(first)));
    expect(onChange).toHaveBeenCalledOnce();
    expect(onChange).toHaveBeenCalledWith("octocat");
    expect(onPick).toHaveBeenCalledOnce();
    expect(onPick).toHaveBeenCalledWith("octocat");
    expect(screen.queryByTestId("share-login-suggestions")).toBeNull();
  });

  it("gates every captured A input and option handler while reused-DOM B remains usable", async () => {
    searchUsers.mockImplementation(() => answer("octocat", "octodog"));
    const onChangeA = vi.fn();
    const onPickA = vi.fn();
    const onChangeB = vi.fn();
    const onPickB = vi.fn();
    const rendered = render(<AuthorityBoundary instance="same" value="octo" onChange={onChangeA} onPick={onPickA} exclude={[]} />);
    const exactInput = input();
    exactInput.focus();
    await settle();
    const control = exactInput.parentElement as HTMLDivElement;
    const retiredList = screen.getByTestId("share-login-suggestions");
    const retiredOption = screen.getAllByTestId("share-login-option")[0];
    const staleRefs = {
      control: reactRef(control),
      input: reactRef(exactInput),
      list: reactRef(retiredList),
      row: reactRef(retiredOption),
    };
    const stale = {
      change: reactHandler<(event: ChangeEvent<HTMLInputElement>) => void>(exactInput, "onChange"),
      focus: reactHandler<(event: FocusEvent<HTMLInputElement>) => void>(exactInput, "onFocus"),
      keydown: reactHandler<(event: KeyboardEvent<HTMLInputElement>) => void>(exactInput, "onKeyDown"),
      blur: reactHandler<(event: FocusEvent<HTMLInputElement>) => void>(exactInput, "onBlur"),
      enter: reactHandler<(event: MouseEvent<HTMLLIElement>) => void>(retiredOption, "onMouseOver"),
      down: reactHandler<(event: MouseEvent<HTMLLIElement>) => void>(retiredOption, "onMouseDown"),
      click: reactHandler<(event: MouseEvent<HTMLLIElement>) => void>(retiredOption, "onClick"),
    };
    const keyPrevent = vi.fn();
    const pointerPrevent = vi.fn();
    let reusedInputAtBoundary = false;
    let reusedControlAtBoundary = false;
    let emptyAtBoundary = false;

    rendered.rerender(
      <AuthorityBoundary
        instance="same"
        value="octo"
        onChange={onChangeB}
        onPick={onPickB}
        exclude={["OCTOCAT"]}
        boundary={1}
        onBoundary={() => {
          reusedInputAtBoundary = input() === exactInput;
          reusedControlAtBoundary = input().parentElement === control;
          emptyAtBoundary = screen.queryByTestId("share-login-option") === null;
          stale.change({
            currentTarget: exactInput,
            target: exactInput,
          } as ChangeEvent<HTMLInputElement>);
          stale.focus({
            currentTarget: exactInput,
            target: exactInput,
          } as FocusEvent<HTMLInputElement>);
          stale.keydown({
            key: "ArrowDown",
            currentTarget: exactInput,
            target: exactInput,
            preventDefault: keyPrevent,
          } as unknown as KeyboardEvent<HTMLInputElement>);
          stale.blur({
            currentTarget: control,
            target: control,
            relatedTarget: null,
          } as unknown as FocusEvent<HTMLInputElement>);
          stale.enter(mouseSource(retiredOption));
          stale.down({
            currentTarget: retiredOption,
            target: retiredOption,
            preventDefault: pointerPrevent,
          } as unknown as MouseEvent<HTMLLIElement>);
          stale.click(mouseSource(retiredOption));
        }}
      />,
    );

    expect(reusedInputAtBoundary).toBe(true);
    expect(reusedControlAtBoundary).toBe(true);
    expect(emptyAtBoundary).toBe(true);
    expect(keyPrevent).not.toHaveBeenCalled();
    expect(pointerPrevent).not.toHaveBeenCalled();
    expect(onChangeA).not.toHaveBeenCalled();
    expect(onPickA).not.toHaveBeenCalled();
    expect(onChangeB).not.toHaveBeenCalled();
    expect(onPickB).not.toHaveBeenCalled();
    expect(options()).toEqual(["octodog"]);
    expect(input()).toHaveFocus();
    act(() => {
      staleRefs.control(null);
      staleRefs.input(null);
      staleRefs.list(null);
      staleRefs.row(null);
    });
    expect(options()).toEqual(["octodog"]);
    expect(input()).toBe(exactInput);
    expect(input().parentElement).toBe(control);

    const currentOption = screen.getByTestId("share-login-option");
    fireEvent.mouseOver(currentOption);
    expect(currentOption).toHaveAttribute("aria-selected", "true");
    expect(fireEvent.mouseDown(currentOption)).toBe(false);
    fireEvent.click(currentOption);
    expect(onChangeB).toHaveBeenCalledOnce();
    expect(onChangeB).toHaveBeenCalledWith("octodog");
    expect(onPickB).toHaveBeenCalledOnce();
    expect(onPickB).toHaveBeenCalledWith("octodog");
    act(() => {
      stale.enter(mouseSource(retiredOption));
      stale.down({
        currentTarget: retiredOption,
        target: retiredOption,
        preventDefault: pointerPrevent,
      } as unknown as MouseEvent<HTMLLIElement>);
      stale.click(mouseSource(retiredOption));
    });
    expect(onChangeB).toHaveBeenCalledOnce();
    expect(onPickB).toHaveBeenCalledOnce();
    expect(pointerPrevent).not.toHaveBeenCalled();
    expect(onChangeA).not.toHaveBeenCalled();
    expect(onPickA).not.toHaveBeenCalled();
    expect(screen.queryByTestId("share-login-suggestions")).toBeNull();
  });

  it("binds Retry to its exact error and callback set and starts one current request", async () => {
    const currentRetry = deferred<SearchAnswer>();
    searchUsers.mockRejectedValueOnce(new ApiError(503, "A failed")).mockRejectedValueOnce(new ApiError(503, "B failed")).mockReturnValueOnce(currentRetry.promise);
    const onChangeA = vi.fn();
    const onChangeB = vi.fn();
    const rendered = render(<AuthorityBoundary instance="same" value="octo" onChange={onChangeA} exclude={[]} />);
    input().focus();
    await settle();
    const retiredRetry = screen.getByRole("button", { name: "Retry" });
    const staleRetry = reactHandler<(event: MouseEvent<HTMLButtonElement>) => void>(retiredRetry, "onClick");
    const staleRetryRef = reactRef(retiredRetry);
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    let requestsAtBoundary = -1;

    rendered.rerender(
      <AuthorityBoundary
        instance="same"
        value="octo"
        onChange={onChangeB}
        exclude={[]}
        boundary={1}
        onBoundary={() => {
          staleRetry(buttonMouseSource(retiredRetry));
          staleRetry(buttonMouseSource(retiredRetry));
          requestsAtBoundary = searchUsers.mock.calls.length;
        }}
      />,
    );

    expect(requestsAtBoundary).toBe(1);
    expect(focus).not.toHaveBeenCalled();
    await settle();
    expect(searchUsers).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("alert")).toHaveTextContent("B failed");
    const mutatedRetryButton = screen.getByRole("button", { name: "Retry" });
    const retryB = reactHandler<(event: MouseEvent<HTMLButtonElement>) => void>(mutatedRetryButton, "onClick");
    const sibling = document.createElement("button");
    const foreign = document.createElement("button");
    const detached = document.createElement("button");
    screen.getByRole("alert").append(sibling);
    document.body.append(foreign);
    act(() => {
      staleRetryRef(null);
      retryB(buttonMouseSource(sibling));
      retryB(buttonMouseSource(foreign));
      retryB(buttonMouseSource(detached));
    });
    expect(searchUsers).toHaveBeenCalledTimes(2);
    expect(focus).not.toHaveBeenCalled();
    sibling.remove();
    foreign.remove();
    rendered.rerender(
      <AuthorityBoundary instance="same" value="octo" onChange={onChangeB} exclude={[]} />,
    );
    const currentRetryButton = screen.getByRole("button", { name: "Retry" });
    expect(currentRetryButton).toBe(mutatedRetryButton);
    const restoreRetry = interceptReactHandler<MouseEvent<HTMLButtonElement>>(
      currentRetryButton,
      "onClick",
      (currentRetryHandler, event) => {
        currentRetryHandler(event);
        currentRetryHandler(event);
      },
    );
    fireEvent.click(currentRetryButton);
    restoreRetry();
    expect(searchUsers).toHaveBeenCalledTimes(3);
    expect(searchUsers.mock.calls.map(([q]) => q)).toEqual(["octo", "octo", "octo"]);
    expect(focus).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Retrying…" })).toBeDisabled();

    await act(async () => {
      currentRetry.resolve({ users: [user("octodog")], limited: false });
      await currentRetry.promise;
    });
    expect(options()).toEqual(["octodog"]);
    expect(onChangeA).not.toHaveBeenCalled();
    expect(onChangeB).not.toHaveBeenCalled();
  });

  it.each(["DOM replacement", "removal"] as const)("retires A's exact request before the parent layout boundary on $transition", async (transition) => {
    const retired = deferred<SearchAnswer>();
    const current = deferred<SearchAnswer>();
    searchUsers.mockReturnValueOnce(retired.promise).mockReturnValueOnce(current.promise);
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const onChangeA = vi.fn();
    const onChangeB = vi.fn();
    let aborts = 0;
    let abortedAtBoundary = false;
    let stalePreventedAtBoundary = false;
    let inputAbsentAtBoundary = false;

    try {
      await act(async () => {
        root.render(<AuthorityBoundary instance="A" value="octo" onChange={onChangeA} exclude={[]} />);
      });
      const retiredInput = input();
      retiredInput.focus();
      await settle();
      const retiredSignal = searchUsers.mock.calls[0][1]?.signal;
      retiredSignal?.addEventListener("abort", () => {
        aborts++;
      });
      const staleChange = reactHandler<(event: ChangeEvent<HTMLInputElement>) => void>(retiredInput, "onChange");
      const staleKeydown = reactHandler<(event: KeyboardEvent<HTMLInputElement>) => void>(retiredInput, "onKeyDown");

      await act(async () => {
        root.render(
          <AuthorityBoundary
            instance="B"
            value="octo"
            onChange={onChangeB}
            exclude={[]}
            present={transition === "DOM replacement"}
            boundary={1}
            onBoundary={() => {
              abortedAtBoundary = retiredSignal?.aborted === true;
              const preventDefault = vi.fn();
              staleChange({
                currentTarget: retiredInput,
                target: retiredInput,
              } as ChangeEvent<HTMLInputElement>);
              staleKeydown({
                key: "ArrowDown",
                currentTarget: retiredInput,
                target: retiredInput,
                preventDefault,
              } as unknown as KeyboardEvent<HTMLInputElement>);
              stalePreventedAtBoundary = preventDefault.mock.calls.length > 0;
              inputAbsentAtBoundary = screen.queryByTestId("share-login") === null;
            }}
          />,
        );
      });

      expect(abortedAtBoundary).toBe(true);
      expect(aborts).toBe(1);
      expect(stalePreventedAtBoundary).toBe(false);
      expect(onChangeA).not.toHaveBeenCalled();
      expect(onChangeB).not.toHaveBeenCalled();
      expect(inputAbsentAtBoundary).toBe(transition === "removal");
      if (transition === "DOM replacement") expect(input()).not.toBe(retiredInput);

      await act(async () => {
        retired.resolve({ users: [user("retired-user")], limited: false });
        await retired.promise;
      });
      expect(screen.queryByText("@retired-user")).toBeNull();
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it("keeps genuine input current through direct-root Strict Mode replay and rejects its stale predecessor", async () => {
    searchUsers.mockImplementation(() => answer("octocat"));
    const onChange = vi.fn();
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);

    try {
      await act(async () => {
        root.render(
          <StrictMode>
            <DirectHarness onChange={onChange} />
          </StrictMode>,
        );
      });
      const exactInput = input();
      const staleChange = reactHandler<(event: ChangeEvent<HTMLInputElement>) => void>(
        exactInput,
        "onChange",
      );

      fireEvent.change(exactInput, { target: { value: "o" } });
      expect(onChange).toHaveBeenCalledOnce();
      expect(onChange).toHaveBeenCalledWith("o");
      act(() => {
        staleChange({
          currentTarget: exactInput,
          target: exactInput,
        } as ChangeEvent<HTMLInputElement>);
      });
      expect(onChange).toHaveBeenCalledTimes(1);

      fireEvent.change(exactInput, { target: { value: "octo" } });
      expect(onChange).toHaveBeenLastCalledWith("octo");
      expect(input()).toBe(exactInput);
      await settle();
      expect(searchUsers).toHaveBeenCalledOnce();
      expect(searchUsers).toHaveBeenCalledWith(
        "octo",
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it("keeps keyboard movement and pick exact through direct-root Strict Mode replay", async () => {
    searchUsers.mockImplementation(() => answer("octocat", "octodog"));
    const onChange = vi.fn();
    const onPick = vi.fn();
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);

    try {
      await act(async () => {
        root.render(
          <StrictMode>
            <DirectHarness initialValue="octo" onChange={onChange} onPick={onPick} />
          </StrictMode>,
        );
      });
      input().focus();
      await settle();
      const exactInput = input();
      const staleKeydown = reactHandler<(event: KeyboardEvent<HTMLInputElement>) => void>(
        exactInput,
        "onKeyDown",
      );

      expect(dispatchKeyDown(exactInput, "ArrowDown").defaultPrevented).toBe(true);
      expect(listOptions()[0]).toHaveAttribute("aria-selected", "true");
      act(() => {
        staleKeydown({
          key: "ArrowDown",
          currentTarget: exactInput,
          target: exactInput,
          preventDefault: vi.fn(),
        } as unknown as KeyboardEvent<HTMLInputElement>);
      });
      expect(listOptions()[0]).toHaveAttribute("aria-selected", "true");

      const restoreKeydown = interceptReactHandler<KeyboardEvent<HTMLInputElement>>(
        exactInput,
        "onKeyDown",
        (current, event) => {
          current(event);
          current(event);
        },
      );
      expect(dispatchKeyDown(exactInput, "Enter").defaultPrevented).toBe(true);
      restoreKeydown();
      expect(onChange).toHaveBeenCalledOnce();
      expect(onChange).toHaveBeenCalledWith("octocat");
      expect(onPick).toHaveBeenCalledOnce();
      expect(onPick).toHaveBeenCalledWith("octocat");
      expect(screen.queryByTestId("share-login-suggestions")).toBeNull();
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it("retires restored row mutations before one direct-root Strict Mode row pick", async () => {
    searchUsers.mockImplementation(() => answer("octocat", "octodog"));
    const onChange = vi.fn();
    const onPick = vi.fn();
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const view = () => (
      <StrictMode>
        <DirectHarness initialValue="octo" onChange={onChange} onPick={onPick} />
      </StrictMode>
    );

    try {
      await act(async () => root.render(view()));
      input().focus();
      await settle();
      const list = screen.getByTestId("share-login-suggestions");
      const retiredRow = screen.getAllByTestId("share-login-option")[0];
      const staleClick = reactHandler<(event: MouseEvent<HTMLLIElement>) => void>(
        retiredRow,
        "onClick",
      );

      retiredRow.remove();
      list.prepend(retiredRow);
      fireEvent.click(retiredRow);
      act(() => staleClick(mouseSource(retiredRow)));
      expect(onChange).not.toHaveBeenCalled();
      expect(onPick).not.toHaveBeenCalled();

      await act(async () => root.render(view()));
      const currentRow = screen.getAllByTestId("share-login-option")[0];
      expect(currentRow).not.toBe(retiredRow);
      const restoreClick = interceptReactHandler<MouseEvent<HTMLLIElement>>(
        currentRow,
        "onClick",
        (current, event) => {
          current(event);
          current(event);
        },
      );
      fireEvent.click(currentRow);
      restoreClick();
      expect(onChange).toHaveBeenCalledOnce();
      expect(onChange).toHaveBeenCalledWith("octocat");
      expect(onPick).toHaveBeenCalledOnce();
      expect(onPick).toHaveBeenCalledWith("octocat");
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it("binds direct-root Strict Mode Retry to one current genuine click", async () => {
    const retry = deferred<SearchAnswer>();
    searchUsers
      .mockRejectedValueOnce(new ApiError(503, "Try again"))
      .mockRejectedValueOnce(new ApiError(503, "Still unavailable"))
      .mockReturnValueOnce(retry.promise);
    const onChangeA = vi.fn();
    const onChangeB = vi.fn();
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);

    try {
      await act(async () => {
        root.render(
          <StrictMode>
            <DirectHarness initialValue="octo" onChange={onChangeA} />
          </StrictMode>,
        );
      });
      input().focus();
      await settle();
      const retiredRetry = screen.getByRole("button", { name: "Retry" });
      const staleRetry = reactHandler<(event: MouseEvent<HTMLButtonElement>) => void>(
        retiredRetry,
        "onClick",
      );

      await act(async () => {
        root.render(
          <StrictMode>
            <DirectHarness initialValue="octo" onChange={onChangeB} />
          </StrictMode>,
        );
      });
      act(() => staleRetry(buttonMouseSource(retiredRetry)));
      expect(searchUsers).toHaveBeenCalledTimes(1);
      await settle();
      expect(searchUsers).toHaveBeenCalledTimes(2);
      expect(screen.getByRole("alert")).toHaveTextContent("Still unavailable");

      const currentRetry = screen.getByRole("button", { name: "Retry" });
      const restoreRetry = interceptReactHandler<MouseEvent<HTMLButtonElement>>(
        currentRetry,
        "onClick",
        (current, event) => {
          current(event);
          current(event);
        },
      );
      fireEvent.click(currentRetry);
      restoreRetry();
      expect(searchUsers).toHaveBeenCalledTimes(3);
      expect(currentRetry).toBeDisabled();

      await act(async () => {
        retry.resolve({ users: [user("octodog")], limited: false });
        await retry.promise;
      });
      expect(options()).toEqual(["octodog"]);
      expect(onChangeA).not.toHaveBeenCalled();
      expect(onChangeB).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it("keeps direct-root Strict Mode dismissal and focus on fresh exact controls", async () => {
    searchUsers.mockImplementation(() => answer("octocat"));
    const onChange = vi.fn();
    const outside = document.createElement("button");
    const host = document.createElement("div");
    document.body.append(outside, host);
    const root = createRoot(host);

    try {
      await act(async () => {
        root.render(
          <StrictMode>
            <DirectHarness initialValue="octo" onChange={onChange} />
          </StrictMode>,
        );
      });
      const exactInput = input();
      exactInput.focus();
      await settle();
      expect(options()).toEqual(["octocat"]);
      const staleFocus = reactHandler<(event: FocusEvent<HTMLInputElement>) => void>(
        exactInput,
        "onFocus",
      );

      act(() => outside.focus());
      expect(screen.queryByTestId("share-login-suggestions")).toBeNull();
      act(() => {
        staleFocus({
          currentTarget: exactInput,
          target: exactInput,
        } as FocusEvent<HTMLInputElement>);
      });
      expect(screen.queryByTestId("share-login-suggestions")).toBeNull();

      act(() => exactInput.focus());
      expect(options()).toEqual(["octocat"]);
      expect(searchUsers).toHaveBeenCalledTimes(1);
      expect(onChange).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      outside.remove();
      host.remove();
    }
  });
});
