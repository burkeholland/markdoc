// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, within } from "@testing-library/react";
import {
  StrictMode,
  useEffect,
  useLayoutEffect,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { createRoot } from "react-dom/client";
import type { EditorView } from "prosemirror-view";
import type { CollabSession } from "@/editor/collab/session";
import type { EditorActions, FormatState, TableCommand } from "./actions";

const setup = vi.hoisted(() => ({
  hidden: vi.fn(() => false),
  tipChildren: [] as ReactNode[],
}));

vi.mock("@/editor/prosemirror/setup", () => ({
  isTableMenuHidden: setup.hidden,
  TABLE_MENU_EVENT: "markdoc:table-menu",
}));

vi.mock("@/components/ui/primitives", () => ({
  Tip: ({ children }: { children: ReactNode }) => {
    setup.tipChildren.push(children);
    return children;
  },
}));

import { TableMenu } from "./table-menu";

const TABLE_MENU_EVENT = "markdoc:table-menu";
const screen = within(document.documentElement);

interface OwnedListener {
  target: EventTarget;
  type: string;
  callback: EventListener;
  removed: number;
}

function controlledBrowser() {
  let nextFrame = 1;
  const frames = new Map<number, FrameRequestCallback>();
  const capturedFrames = new Map<number, FrameRequestCallback>();
  const request = vi.fn((callback: FrameRequestCallback) => {
    const id = nextFrame++;
    frames.set(id, callback);
    capturedFrames.set(id, callback);
    return id;
  });
  const cancel = vi.fn((id: number) => {
    frames.delete(id);
  });
  vi.stubGlobal("requestAnimationFrame", request);
  vi.stubGlobal("cancelAnimationFrame", cancel);

  const listeners: OwnedListener[] = [];
  const trackAdd = (target: EventTarget, type: string, callback: EventListenerOrEventListenerObject | null) => {
    if (typeof callback === "function" && callback.name === "schedule") {
      listeners.push({ target, type, callback, removed: 0 });
    }
  };
  const trackRemove = (target: EventTarget, type: string, callback: EventListenerOrEventListenerObject | null) => {
    if (typeof callback !== "function" || callback.name !== "schedule") return;
    const owned = listeners.findLast(
      (entry) => entry.target === target && entry.type === type && entry.callback === callback && entry.removed === 0,
    );
    if (owned) owned.removed++;
  };
  const add = EventTarget.prototype.addEventListener;
  const remove = EventTarget.prototype.removeEventListener;
  vi.spyOn(EventTarget.prototype, "addEventListener").mockImplementation(function (this: EventTarget, type, callback, options) {
    trackAdd(this, type, callback);
    add.call(this, type, callback, options);
  });
  vi.spyOn(EventTarget.prototype, "removeEventListener").mockImplementation(function (this: EventTarget, type, callback, options) {
    trackRemove(this, type, callback);
    remove.call(this, type, callback, options);
  });
  // jsdom's Window methods do not delegate through EventTarget.prototype.
  const windowAdd = window.addEventListener;
  const windowRemove = window.removeEventListener;
  vi.spyOn(window, "addEventListener").mockImplementation((type, callback, options) => {
    trackAdd(window, type, callback);
    windowAdd.call(window, type, callback, options);
  });
  vi.spyOn(window, "removeEventListener").mockImplementation((type, callback, options) => {
    trackRemove(window, type, callback);
    windowRemove.call(window, type, callback, options);
  });

  const flush = () => {
    const pending = [...frames];
    frames.clear();
    act(() => {
      for (const [, callback] of pending) callback(0);
    });
  };

  return { frames, capturedFrames, request, cancel, listeners, flush };
}

interface Fixture {
  view: EditorView;
  session: CollabSession;
  actions: EditorActions;
  format: FormatState;
  containerRef: RefObject<HTMLElement | null>;
  container: HTMLElement;
  editor: HTMLElement;
  stateRead: ReturnType<typeof vi.fn>;
  domRead: ReturnType<typeof vi.fn>;
  destroyedRead: ReturnType<typeof vi.fn>;
  nodeDOM: ReturnType<typeof vi.fn>;
  tableRect: ReturnType<typeof vi.fn>;
  hostRect: ReturnType<typeof vi.fn>;
  tableAction: ReturnType<typeof vi.fn<(command: TableCommand) => void>>;
  alignAction: ReturnType<typeof vi.fn<(align: "left" | "center" | "right" | null) => void>>;
}

function fixture({
  host,
  tableBox,
  align = null,
}: {
  host: DOMRect;
  tableBox: DOMRect;
  align?: FormatState["tableAlign"];
}): Fixture {
  const container = document.createElement("div");
  const editor = document.createElement("div");
  const wrapper = document.createElement("div");
  const table = document.createElement("table");
  wrapper.append(table);
  editor.append(wrapper);
  container.append(editor);
  document.body.append(container);
  Object.defineProperties(container, {
    clientWidth: { configurable: true, value: 800 },
    scrollTop: { configurable: true, value: 20, writable: true },
  });
  const hostRect = vi.fn(() => host);
  const tableRect = vi.fn(() => tableBox);
  Object.defineProperty(container, "getBoundingClientRect", { configurable: true, value: hostRect });
  Object.defineProperty(table, "getBoundingClientRect", { configurable: true, value: tableRect });

  const stateRead = vi.fn(() => ({ tableMenuHidden: false }));
  const domRead = vi.fn(() => editor);
  const destroyedRead = vi.fn(() => false);
  const nodeDOM = vi.fn(() => wrapper);
  const view = {
    get dom() {
      return domRead();
    },
    get state() {
      return stateRead();
    },
    get isDestroyed() {
      return destroyedRead();
    },
    nodeDOM,
  } as unknown as EditorView;

  const subscribers = new Set<() => void>();
  const session = {
    canEdit: true,
    activeSurface: "rich",
    subscribe: (listener: () => void) => {
      subscribers.add(listener);
      return () => subscribers.delete(listener);
    },
  } as unknown as CollabSession;
  const tableAction = vi.fn<(command: TableCommand) => void>();
  const alignAction = vi.fn<(value: "left" | "center" | "right" | null) => void>();
  const actions = {
    table: tableAction,
    setColumnAlign: alignAction,
  } as unknown as EditorActions;
  const format: FormatState = {
    strong: false,
    em: false,
    code: false,
    strike: false,
    link: false,
    heading: 0,
    bullet: false,
    ordered: false,
    task: false,
    quote: false,
    codeBlock: false,
    hasSelection: false,
    tablePos: 7,
    tableAlign: align,
  };
  return {
    view,
    session,
    actions,
    format,
    containerRef: { current: container },
    container,
    editor,
    stateRead,
    domRead,
    destroyedRead,
    nodeDOM,
    tableRect,
    hostRect,
    tableAction,
    alignAction,
  };
}

function Boundary({
  current,
  present = true,
  boundary = 0,
  mountKey,
  onBoundary,
  onPassiveCleanup,
}: {
  current: Fixture;
  present?: boolean;
  boundary?: number;
  mountKey?: number;
  onBoundary?: () => void;
  onPassiveCleanup?: () => void;
}) {
  useLayoutEffect(() => {
    if (boundary > 0) onBoundary?.();
  }, [boundary, onBoundary]);
  useEffect(() => onPassiveCleanup, [boundary, onPassiveCleanup]);
  return (
    <>
      {present ? (
        <TableMenu
          key={mountKey}
          view={current.view}
          session={current.session}
          actions={current.actions}
          format={current.format}
          containerRef={current.containerRef}
        />
      ) : null}
    </>
  );
}

interface DirectMouseEvent {
  currentTarget: HTMLButtonElement;
  preventDefault: () => void;
}

interface CapturedControl {
  element: HTMLButtonElement;
  click: (event: DirectMouseEvent) => void;
  mouseDown: (event: DirectMouseEvent) => void;
  buttonRef: (element: HTMLButtonElement | null) => void;
}

type CapturedTableKeyDown = (
  event: ReactKeyboardEvent<HTMLButtonElement>,
) => void;

type ReactKeyHandlerName = "onKeyDownCapture" | "onKeyDown";

const TABLE_BUTTON_IDS = [
  "table-row-before",
  "table-row-after",
  "table-col-before",
  "table-col-after",
  "table-delete-row",
  "table-delete-col",
  "table-align-left",
  "table-align-center",
  "table-align-right",
  "table-delete",
] as const;

function reactHandler<T>(element: HTMLElement, name: string): T {
  const propsKey = Object.keys(element).find((key) => key.startsWith("__reactProps$"));
  if (!propsKey) throw new Error(`React props were not attached to ${element.dataset.testid ?? element.tagName}`);
  const props = (element as unknown as Record<string, Record<string, unknown> | undefined>)[propsKey];
  const handler = props?.[name];
  if (typeof handler !== "function") throw new Error(`${name} was not attached to ${element.dataset.testid ?? element.tagName}`);
  return handler as T;
}

function tableEventImplementation(event: Event) {
  return Object.getOwnPropertySymbols(event)
    .map((symbol) => (event as unknown as Record<symbol, unknown>)[symbol])
    .find(
      (candidate): candidate is { isTrusted: boolean; view: Window | null } =>
        typeof candidate === "object"
        && candidate !== null
        && "isTrusted" in candidate
        && typeof candidate.isTrusted === "boolean"
        && "view" in candidate,
    );
}

function requiredTableEventImplementation(event: Event) {
  const implementation = tableEventImplementation(event);
  if (!implementation) throw new Error("The jsdom event implementation was unavailable");
  return implementation;
}

function markTableEventTrusted(event: Event) {
  const implementation = tableEventImplementation(event);
  const descriptor = implementation
    ? Object.getOwnPropertyDescriptor(implementation, "isTrusted")
    : undefined;
  if (!implementation || !descriptor?.writable) {
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

async function dispatchTableKey(
  button: HTMLButtonElement,
  key: string,
  init: KeyboardEventInit = {},
) {
  const event = tableKeyboardEvent(button, key, init);
  await act(async () => {
    button.dispatchEvent(event);
    await Promise.resolve();
  });
  return event;
}

function tableKeyboardEvent(
  button: HTMLButtonElement,
  key: string,
  init: KeyboardEventInit = {},
  trusted = true,
) {
  const ownerWindow = button.ownerDocument.defaultView!;
  const event = new ownerWindow.KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
    ...init,
  });
  const implementation = requiredTableEventImplementation(event);
  implementation.view = ownerWindow;
  if (trusted) markTableEventTrusted(event);
  return event;
}

function tableButtons() {
  return TABLE_BUTTON_IDS.map(
    (testId) => screen.getByTestId(testId) as HTMLButtonElement,
  );
}

function interceptReactKeyDown<T extends HTMLElement>(
  element: T,
  name: ReactKeyHandlerName,
  intercept: (
    original: (event: ReactKeyboardEvent<T>) => void,
    event: object,
  ) => void,
) {
  const propsKey = Object.keys(element).find((key) => key.startsWith("__reactProps$"));
  if (!propsKey) throw new Error("React props were not attached to the table keyboard boundary");
  const record = element as unknown as Record<string, Record<string, unknown>>;
  const props = record[propsKey];
  const original = props[name];
  if (typeof original !== "function") throw new Error(`The table ${name} handler was unavailable`);
  const replacement = {
    ...props,
    [name]: (event: object) => {
      intercept(original as (event: ReactKeyboardEvent<T>) => void, event);
    },
  };
  record[propsKey] = replacement;
  return () => {
    if (record[propsKey] === replacement) record[propsKey] = props;
  };
}

function interceptTableKeyDown(
  element: HTMLButtonElement,
  intercept: (original: CapturedTableKeyDown, event: object) => void,
) {
  return interceptReactKeyDown(element, "onKeyDown", intercept);
}

const REACT_KEY_PUBLIC_SCALARS = [
  "type",
  "nativeEvent",
  "target",
  "currentTarget",
  "bubbles",
  "cancelable",
  "defaultPrevented",
  "isTrusted",
  "key",
  "ctrlKey",
  "metaKey",
  "altKey",
  "shiftKey",
  "repeat",
  "isComposing",
  "view",
  "eventPhase",
] as const;

const REACT_KEY_REQUIRED_METHODS = [
  "preventDefault",
  "isDefaultPrevented",
  "isPropagationStopped",
] as const;

function exposeReactScalarsAsAccessors(event: object) {
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

function isolateReactWrapper(
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

function captureControl(testId: string): CapturedControl {
  const element = screen.getByTestId(testId) as HTMLButtonElement;
  return {
    element,
    click: reactHandler(element, "onClick"),
    mouseDown: reactHandler(element, "onMouseDown"),
    buttonRef: reactHandler(element, "ref"),
  };
}

function captureRenderedControl(testId: string, occurrence: number): Omit<CapturedControl, "element"> {
  const renders = setup.tipChildren.filter((child) => (
    (child as { props?: Record<string, unknown> }).props?.["data-testid"] === testId
  ));
  const props = (renders[occurrence] as { props?: Record<string, unknown> } | undefined)?.props;
  const click = props?.onClick;
  const mouseDown = props?.onMouseDown;
  const buttonRef = props?.ref;
  if (typeof click !== "function" || typeof mouseDown !== "function" || typeof buttonRef !== "function") {
    throw new Error(`${testId} render ${occurrence} did not expose complete control callbacks`);
  }
  return {
    click: click as CapturedControl["click"],
    mouseDown: mouseDown as CapturedControl["mouseDown"],
    buttonRef: buttonRef as CapturedControl["buttonRef"],
  };
}

function controlEvent(control: CapturedControl, preventDefault: () => void = vi.fn(), currentTarget = control.element): DirectMouseEvent {
  return { currentTarget, preventDefault };
}

function click(control: CapturedControl, currentTarget = control.element) {
  control.click(controlEvent(control, vi.fn(), currentTarget));
}

function mouseDown(control: CapturedControl, preventDefault: () => void, currentTarget = control.element) {
  control.mouseDown(controlEvent(control, preventDefault, currentTarget));
}

function captureRepresentativeControls() {
  return {
    table: captureControl("table-row-before"),
    alignment: captureControl("table-align-center"),
    deletion: captureControl("table-delete"),
  };
}

function observedControlWork(
  browser: ReturnType<typeof controlledBrowser>,
  fixtures: Fixture[],
  host: HTMLElement,
  focus: ReturnType<typeof vi.spyOn>,
) {
  return {
    requests: browser.request.mock.calls.length,
    cancellations: browser.cancel.mock.calls.length,
    pendingFrames: [...browser.frames.keys()],
    listeners: browser.listeners.map((listener) => listener.removed),
    fixtures: fixtures.map((current) => ({
      state: current.stateRead.mock.calls.length,
      dom: current.domRead.mock.calls.length,
      destroyed: current.destroyedRead.mock.calls.length,
      nodeDOM: current.nodeDOM.mock.calls.length,
      tableRect: current.tableRect.mock.calls.length,
      hostRect: current.hostRect.mock.calls.length,
      tableActions: current.tableAction.mock.calls.length,
      alignActions: current.alignAction.mock.calls.length,
    })),
    focus: focus.mock.calls.length,
    activeElement: document.activeElement,
    markup: host.innerHTML,
  };
}

function expectRetiredControlsDoNoWork({
  controls,
  browser,
  fixtures,
  host,
  focus,
}: {
  controls: ReturnType<typeof captureRepresentativeControls>;
  browser: ReturnType<typeof controlledBrowser>;
  fixtures: Fixture[];
  host: HTMLElement;
  focus: ReturnType<typeof vi.spyOn>;
}) {
  const before = observedControlWork(browser, fixtures, host, focus);
  const preventions = Object.values(controls).map(() => vi.fn());
  Object.values(controls).forEach((control, index) => {
    mouseDown(control, preventions[index]);
    click(control);
  });
  expect(preventions.every((preventDefault) => preventDefault.mock.calls.length === 0)).toBe(true);
  expect(observedControlWork(browser, fixtures, host, focus)).toEqual(before);
}

function expectWrongTargetDoesNoWork({
  control,
  currentTarget,
  browser,
  fixtures,
  host,
  focus,
}: {
  control: CapturedControl;
  currentTarget: HTMLButtonElement;
  browser: ReturnType<typeof controlledBrowser>;
  fixtures: Fixture[];
  host: HTMLElement;
  focus: ReturnType<typeof vi.spyOn>;
}) {
  const before = observedControlWork(browser, fixtures, host, focus);
  const preventDefault = vi.fn();
  control.mouseDown(controlEvent(control, preventDefault, currentTarget));
  control.click(controlEvent(control, vi.fn(), currentTarget));
  expect(preventDefault).not.toHaveBeenCalled();
  expect(observedControlWork(browser, fixtures, host, focus)).toEqual(before);
}

async function renderStrictControlsAtAncestorLayout({
  root,
  current,
  browser,
  onBoundary,
}: {
  root: ReturnType<typeof createRoot>;
  current: Fixture;
  browser: ReturnType<typeof controlledBrowser>;
  onBoundary: () => void;
}) {
  await act(async () => root.render(
    <StrictMode>
      <Boundary current={current} />
    </StrictMode>,
  ));
  const pending = [...browser.frames.values()];
  expect(pending).toHaveLength(1);
  browser.frames.clear();
  await act(async () => {
    pending[0](0);
    root.render(
      <StrictMode>
        <Boundary current={current} boundary={1} onBoundary={onBoundary} />
      </StrictMode>,
    );
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  setup.hidden.mockClear();
  setup.tipChildren.length = 0;
  document.body.replaceChildren();
});

describe("TableMenu geometry ownership", () => {
  it("keeps table, alignment, and delete controls usable through Strict Mode replay", () => {
    setup.tipChildren.length = 0;
    const browser = controlledBrowser();
    const current = fixture({
      host: new DOMRect(50, 120, 800, 600),
      tableBox: new DOMRect(400, 360, 500, 300),
      align: "center",
    });
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);

    try {
      act(() => root.render(
        <StrictMode>
          <Boundary current={current} />
        </StrictMode>,
      ));
      browser.flush();

      const retired = {
        table: captureRenderedControl("table-row-before", 1),
        alignment: captureRenderedControl("table-align-center", 1),
        deletion: captureRenderedControl("table-delete", 1),
      };
      const currentControls = captureRepresentativeControls();
      const pairs = [
        [retired.table, currentControls.table],
        [retired.alignment, currentControls.alignment],
        [retired.deletion, currentControls.deletion],
      ] as const;
      const stalePreventions = pairs.map(() => vi.fn());
      pairs.forEach(([control, currentControl], index) => {
        control.mouseDown(controlEvent(currentControl, stalePreventions[index]));
        control.click(controlEvent(currentControl));
      });
      expect(stalePreventions.every((preventDefault) => preventDefault.mock.calls.length === 0)).toBe(true);
      expect(current.tableAction).not.toHaveBeenCalled();
      expect(current.alignAction).not.toHaveBeenCalled();

      for (const [retiredControl, currentControl] of pairs) {
        retiredControl.buttonRef(null);
        retiredControl.buttonRef(currentControl.element);
      }
      const currentPreventions = pairs.map(() => vi.fn());
      pairs.forEach(([, control], index) => {
        mouseDown(control, currentPreventions[index]);
        click(control);
      });
      expect(currentPreventions.every((preventDefault) => preventDefault.mock.calls.length === 1)).toBe(true);
      expect(current.tableAction.mock.calls).toEqual([["rowBefore"], ["deleteTable"]]);
      expect(current.alignAction.mock.calls).toEqual([[null]]);
    } finally {
      act(() => root.unmount());
    }
  });

  it.each(["mutate-restore", "detach-reinsert"] as const)(
    "rejects Strict replay after transient committed DOM history: %s",
    async (change) => {
      const browser = controlledBrowser();
      const current = fixture({
        host: new DOMRect(50, 120, 800, 600),
        tableBox: new DOMRect(400, 360, 500, 300),
      });
      const host = document.createElement("div");
      document.body.append(host);
      const root = createRoot(host);
      let source!: CapturedControl;

      try {
        await renderStrictControlsAtAncestorLayout({
          root,
          current,
          browser,
          onBoundary: () => {
            const menu = screen.getByTestId("table-menu");
            source = captureControl("table-row-before");
            if (change === "mutate-restore") {
              source.element.setAttribute("data-transient", "changed");
              source.element.removeAttribute("data-transient");
            } else {
              const parent = menu.parentNode!;
              const next = menu.nextSibling;
              parent.removeChild(menu);
              parent.insertBefore(menu, next);
            }
          },
        });

        const stalePrevention = vi.fn();
        mouseDown(source, stalePrevention);
        click(source);
        expect(stalePrevention).not.toHaveBeenCalled();
        expect(current.tableAction).not.toHaveBeenCalled();

        act(() => root.render(
          <StrictMode>
            <Boundary current={current} boundary={2} />
          </StrictMode>,
        ));
        click(captureControl("table-row-before"));
        click(source);
        expect(current.tableAction.mock.calls).toEqual([["rowBefore"]]);
      } finally {
        act(() => root.unmount());
      }
    },
  );

  it.each(["mousedown", "click"] as const)(
    "does not replenish claims after a source %s before Strict cleanup",
    async (interaction) => {
      const browser = controlledBrowser();
      const current = fixture({
        host: new DOMRect(50, 120, 800, 600),
        tableBox: new DOMRect(400, 360, 500, 300),
      });
      const host = document.createElement("div");
      document.body.append(host);
      const root = createRoot(host);
      let source!: CapturedControl;

      try {
        await renderStrictControlsAtAncestorLayout({
          root,
          current,
          browser,
          onBoundary: () => {
            source = captureControl("table-row-before");
            source.element.dispatchEvent(new MouseEvent(interaction, {
              bubbles: true,
              cancelable: true,
            }));
          },
        });
        expect(current.tableAction).toHaveBeenCalledTimes(interaction === "click" ? 1 : 0);

        fireEvent.click(source.element);
        expect(current.tableAction).toHaveBeenCalledTimes(interaction === "click" ? 1 : 0);

        act(() => root.render(
          <StrictMode>
            <Boundary current={current} boundary={2} />
          </StrictMode>,
        ));
        click(captureControl("table-row-before"));
        click(source);
        expect(current.tableAction).toHaveBeenCalledTimes(interaction === "click" ? 2 : 1);
      } finally {
        act(() => root.unmount());
      }
    },
  );

  it("retires exact listeners and frames before parent layout boundaries while current events coalesce", () => {
    const browser = controlledBrowser();
    const first = fixture({
      host: new DOMRect(10, 100, 800, 600),
      tableBox: new DOMRect(110, 300, 500, 300),
    });
    const second = fixture({
      host: new DOMRect(50, 120, 800, 600),
      tableBox: new DOMRect(400, 360, 500, 300),
    });
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const errors: unknown[] = [];
    const onError = (event: ErrorEvent) => errors.push(event.error ?? event.message);
    const onRejection = (event: PromiseRejectionEvent) => errors.push(event.reason);
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    let passiveCleanups = 0;
    const recordPassiveCleanup = () => {
      passiveCleanups++;
    };

    try {
      act(() => root.render(<Boundary current={first} onPassiveCleanup={recordPassiveCleanup} />));
      expect(browser.request).toHaveBeenCalledTimes(1);
      expect(browser.listeners).toHaveLength(3);
      expect(browser.listeners.map(({ target, type }) => [target, type])).toEqual([
        [first.container, "scroll"],
        [window, "resize"],
        [first.editor, TABLE_MENU_EVENT],
      ]);
      browser.flush();
      const initial = screen.getByTestId("table-menu");
      expect(initial).toHaveStyle({ left: "100px", top: "172px", width: "372px" });
      expect(first.stateRead).toHaveBeenCalledTimes(1);
      expect(first.domRead).toHaveBeenCalledTimes(1);
      expect(first.destroyedRead).toHaveBeenCalledTimes(1);
      expect(first.nodeDOM).toHaveBeenCalledTimes(1);
      expect(first.tableRect).toHaveBeenCalledTimes(1);
      expect(first.hostRect).toHaveBeenCalledTimes(1);

      first.container.dispatchEvent(new Event("scroll"));
      window.dispatchEvent(new Event("resize"));
      first.editor.dispatchEvent(new Event(TABLE_MENU_EVENT));
      expect(browser.request).toHaveBeenCalledTimes(2);
      expect(browser.frames.size).toBe(1);
      const staleFrame = browser.capturedFrames.get(2)!;
      const oldReads = {
        state: first.stateRead.mock.calls.length,
        dom: first.domRead.mock.calls.length,
        destroyed: first.destroyedRead.mock.calls.length,
        nodeDOM: first.nodeDOM.mock.calls.length,
        table: first.tableRect.mock.calls.length,
        host: first.hostRect.mock.calls.length,
      };
      const oldListeners = [...browser.listeners];
      let replacementBoundaries = 0;

      act(() => {
        root.render(
          <Boundary
            current={second}
            boundary={1}
            onPassiveCleanup={recordPassiveCleanup}
            onBoundary={() => {
              replacementBoundaries++;
              expect(passiveCleanups).toBe(0);
              expect(oldListeners.every((listener) => listener.removed === 1)).toBe(true);
              expect(host.querySelector("[data-testid=table-menu]")).toBeNull();
              const scheduled = browser.request.mock.calls.length;
              first.container.dispatchEvent(new Event("scroll"));
              first.editor.dispatchEvent(new Event(TABLE_MENU_EVENT));
              window.dispatchEvent(new Event("resize"));
              for (const listener of oldListeners) listener.callback.call(listener.target, new Event(listener.type));
              expect(browser.request).toHaveBeenCalledTimes(scheduled);
            }}
          />,
        );
      });
      expect(replacementBoundaries).toBe(1);
      expect(passiveCleanups).toBe(1);
      expect(browser.listeners).toHaveLength(6);
      expect(browser.listeners.slice(3).map(({ target, type }) => [target, type])).toEqual([
        [second.container, "scroll"],
        [window, "resize"],
        [second.editor, TABLE_MENU_EVENT],
      ]);
      expect(browser.cancel).toHaveBeenNthCalledWith(1, 2);
      expect(browser.frames.size).toBe(1);
      expect(browser.request).toHaveBeenCalledTimes(3);
      expect(() => staleFrame(0)).not.toThrow();
      expect(host.querySelector("[data-testid=table-menu]")).toBeNull();
      expect(first.stateRead).toHaveBeenCalledTimes(oldReads.state);
      expect(first.domRead).toHaveBeenCalledTimes(oldReads.dom);
      expect(first.destroyedRead).toHaveBeenCalledTimes(oldReads.destroyed);
      expect(first.nodeDOM).toHaveBeenCalledTimes(oldReads.nodeDOM);
      expect(first.tableRect).toHaveBeenCalledTimes(oldReads.table);
      expect(first.hostRect).toHaveBeenCalledTimes(oldReads.host);

      browser.flush();
      const current = screen.getByTestId("table-menu");
      expect(current).toHaveStyle({ left: "350px", top: "212px", width: "372px" });
      expect(screen.queryAllByTestId("table-menu")).toHaveLength(1);
      expect(second.stateRead).toHaveBeenCalledTimes(1);
      expect(second.domRead).toHaveBeenCalledTimes(1);
      expect(second.destroyedRead).toHaveBeenCalledTimes(1);
      expect(second.nodeDOM).toHaveBeenCalledTimes(1);
      expect(second.tableRect).toHaveBeenCalledTimes(1);
      expect(second.hostRect).toHaveBeenCalledTimes(1);

      second.container.dispatchEvent(new Event("scroll"));
      second.container.dispatchEvent(new Event("scroll"));
      window.dispatchEvent(new Event("resize"));
      second.editor.dispatchEvent(new Event(TABLE_MENU_EVENT));
      second.editor.dispatchEvent(new Event(TABLE_MENU_EVENT));
      expect(browser.request).toHaveBeenCalledTimes(4);
      expect(browser.frames.size).toBe(1);
      browser.flush();
      expect(second.stateRead).toHaveBeenCalledTimes(2);
      expect(second.nodeDOM).toHaveBeenCalledTimes(2);
      expect(second.tableRect).toHaveBeenCalledTimes(2);
      expect(second.hostRect).toHaveBeenCalledTimes(2);
      expect(screen.getByTestId("table-menu")).toBe(current);

      second.container.dispatchEvent(new Event("scroll"));
      expect(browser.request).toHaveBeenCalledTimes(5);
      const removedFrame = browser.capturedFrames.get(5)!;
      const currentReads = {
        state: second.stateRead.mock.calls.length,
        dom: second.domRead.mock.calls.length,
        destroyed: second.destroyedRead.mock.calls.length,
        nodeDOM: second.nodeDOM.mock.calls.length,
        table: second.tableRect.mock.calls.length,
        host: second.hostRect.mock.calls.length,
      };
      let removalBoundaries = 0;
      act(() => {
        root.render(
          <Boundary
            current={second}
            present={false}
            boundary={2}
            onPassiveCleanup={recordPassiveCleanup}
            onBoundary={() => {
              removalBoundaries++;
              expect(passiveCleanups).toBe(1);
              expect(browser.listeners.slice(3).every((listener) => listener.removed === 1)).toBe(true);
              const scheduled = browser.request.mock.calls.length;
              second.container.dispatchEvent(new Event("scroll"));
              second.editor.dispatchEvent(new Event(TABLE_MENU_EVENT));
              window.dispatchEvent(new Event("resize"));
              expect(browser.request).toHaveBeenCalledTimes(scheduled);
            }}
          />,
        );
      });
      expect(removalBoundaries).toBe(1);
      expect(passiveCleanups).toBe(2);
      expect(browser.cancel).toHaveBeenNthCalledWith(2, 5);
      expect(browser.cancel).toHaveBeenCalledTimes(2);
      expect(browser.frames.size).toBe(0);
      expect(browser.listeners).toHaveLength(6);
      expect(browser.listeners.every((listener) => listener.removed === 1)).toBe(true);
      expect(host.querySelectorAll("[data-testid=table-menu]")).toHaveLength(0);
      expect(() => removedFrame(0)).not.toThrow();
      expect(second.stateRead).toHaveBeenCalledTimes(currentReads.state);
      expect(second.domRead).toHaveBeenCalledTimes(currentReads.dom);
      expect(second.destroyedRead).toHaveBeenCalledTimes(currentReads.destroyed);
      expect(second.nodeDOM).toHaveBeenCalledTimes(currentReads.nodeDOM);
      expect(second.tableRect).toHaveBeenCalledTimes(currentReads.table);
      expect(second.hostRect).toHaveBeenCalledTimes(currentReads.host);
      expect(first.tableAction).not.toHaveBeenCalled();
      expect(second.tableAction).not.toHaveBeenCalled();
      expect(first.alignAction).not.toHaveBeenCalled();
      expect(second.alignAction).not.toHaveBeenCalled();
      expect(setup.hidden).toHaveBeenCalledTimes(3);
      expect(errors).toEqual([]);
    } finally {
      act(() => root.unmount());
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    }
  });

  it("keeps every table button focus-safe and gives each control one exact action per publication", () => {
    const browser = controlledBrowser();
    const current = fixture({
      host: new DOMRect(50, 120, 800, 600),
      tableBox: new DOMRect(400, 360, 500, 300),
      align: "center",
    });
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const focus = vi.spyOn(HTMLElement.prototype, "focus");

    try {
      act(() => root.render(<Boundary current={current} />));
      browser.flush();
      const commands: Array<[string, TableCommand]> = [
        ["table-row-before", "rowBefore"],
        ["table-row-after", "rowAfter"],
        ["table-col-before", "colBefore"],
        ["table-col-after", "colAfter"],
        ["table-delete-row", "deleteRow"],
        ["table-delete-col", "deleteColumn"],
        ["table-delete", "deleteTable"],
      ];
      const alignments: Array<[string, "left" | "center" | "right" | null]> = [
        ["table-align-left", "left"],
        ["table-align-center", null],
        ["table-align-right", "right"],
      ];
      const frozenRow = captureControl("table-row-before");
      expectWrongTargetDoesNoWork({
        control: frozenRow,
        currentTarget: captureControl("table-row-after").element,
        browser,
        fixtures: [current],
        host,
        focus,
      });
      const replacementAction = vi.fn<(command: TableCommand) => void>();
      current.actions.table = replacementAction;
      click(frozenRow);
      current.actions.table = current.tableAction;
      expect(current.tableAction.mock.calls).toEqual([["rowBefore"]]);
      expect(replacementAction).not.toHaveBeenCalled();
      current.tableAction.mockClear();
      act(() => root.render(<Boundary current={current} boundary={1} />));

      const allControls = [...commands, ...alignments];
      const foreign = document.createElement("button");
      for (const [index, [testId]] of allControls.entries()) {
        const button = screen.getByTestId(testId);
        const captured = captureControl(testId);
        const other = captureControl(allControls[(index + 1) % allControls.length][0]);
        expectWrongTargetDoesNoWork({
          control: captured,
          currentTarget: other.element,
          browser,
          fixtures: [current],
          host,
          focus,
        });
        expectWrongTargetDoesNoWork({
          control: captured,
          currentTarget: foreign,
          browser,
          fixtures: [current],
          host,
          focus,
        });
        const pointer = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
        expect(button.dispatchEvent(pointer)).toBe(false);
        expect(pointer.defaultPrevented).toBe(true);
        fireEvent.click(button);
        expectWrongTargetDoesNoWork({
          control: captured,
          currentTarget: other.element,
          browser,
          fixtures: [current],
          host,
          focus,
        });
      }

      expect(current.tableAction.mock.calls).toEqual(commands.map(([, command]) => [command]));
      expect(current.tableAction).toHaveBeenCalledTimes(7);
      expect(current.alignAction.mock.calls).toEqual(alignments.map(([, alignment]) => [alignment]));
      expect(current.alignAction).toHaveBeenCalledTimes(3);
      expect(screen.getAllByRole("button")).toHaveLength(10);

      for (const [testId] of [...commands, ...alignments]) {
        const button = screen.getByTestId(testId);
        fireEvent.click(button);
        const control = captureControl(testId);
        control.click(controlEvent(control));
      }
      expect(current.tableAction).toHaveBeenCalledTimes(7);
      expect(current.alignAction).toHaveBeenCalledTimes(3);

      const menu = screen.getByTestId("table-menu");
      const rowBefore = screen.getByTestId("table-row-before");
      act(() => root.render(<Boundary current={current} boundary={2} />));
      expect(screen.getByTestId("table-menu")).toBe(menu);
      expect(screen.getByTestId("table-row-before")).toBe(rowBefore);
      click(captureControl("table-row-before"));
      expect(current.tableAction).toHaveBeenCalledTimes(8);
      expect(current.tableAction).toHaveBeenLastCalledWith("rowBefore");
    } finally {
      act(() => root.unmount());
    }
  });

  it.each([
    ["ArrowRight", 0, 1],
    ["ArrowDown", 1, 2],
    ["ArrowLeft", 2, 1],
    ["ArrowUp", 1, 0],
    ["Home", 7, 0],
    ["End", 0, 9],
    ["ArrowRight", 9, 0],
    ["ArrowLeft", 0, 9],
  ] as const)(
    "focuses the exact table control for %s from %s to %s without invoking an action",
    async (key, sourceIndex, destinationIndex) => {
      const order: string[] = [];
      const nativePreventDefault = Event.prototype.preventDefault;
      vi.spyOn(Event.prototype, "preventDefault").mockImplementation(function (this: Event) {
        order.push("prevent");
        nativePreventDefault.call(this);
      });
      const nativeFocus = HTMLElement.prototype.focus;
      const focus = vi.spyOn(HTMLElement.prototype, "focus").mockImplementation(function (
        this: HTMLElement,
        options?: FocusOptions,
      ) {
        order.push("focus");
        nativeFocus.call(this, options);
      });
      const browser = controlledBrowser();
      const current = fixture({
        host: new DOMRect(50, 120, 800, 600),
        tableBox: new DOMRect(400, 360, 500, 300),
        align: "center",
      });
      const host = document.createElement("div");
      document.body.append(host);
      const root = createRoot(host);

      try {
        await act(async () => root.render(
          <StrictMode>
            <Boundary current={current} />
          </StrictMode>,
        ));
        browser.flush();
        const menu = screen.getByTestId("table-menu");
        expect(menu).toHaveAttribute("role", "toolbar");
        expect(menu).toHaveAttribute("aria-label", "Table");
        expect(menu).toHaveAttribute("aria-orientation", "horizontal");
        expect(tableButtons().map((button) => button.dataset.testid)).toEqual(TABLE_BUTTON_IDS);
        const source = tableButtons()[sourceIndex];
        const destination = tableButtons()[destinationIndex];
        source.focus();
        focus.mockClear();
        order.length = 0;

        const event = await dispatchTableKey(source, key);

        expect(event.defaultPrevented).toBe(true);
        expect(destination).toHaveFocus();
        expect(focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
        expect(focus.mock.instances[0]).toBe(destination);
        expect(order).toEqual(["prevent", "focus"]);
        expect(current.tableAction).not.toHaveBeenCalled();
        expect(current.alignAction).not.toHaveBeenCalled();
      } finally {
        await act(async () => root.unmount());
      }
    },
  );

  it.each([
    ["ArrowRight", 0, 1],
    ["Home", 7, 0],
    ["End", 0, 9],
  ] as const)(
    "cancels %s synchronously before native dispatch returns",
    async (key, sourceIndex, destinationIndex) => {
      const browser = controlledBrowser();
      const current = fixture({
        host: new DOMRect(50, 120, 800, 600),
        tableBox: new DOMRect(400, 360, 500, 300),
      });
      const host = document.createElement("div");
      document.body.append(host);
      const root = createRoot(host);

      try {
        await act(async () => root.render(
          <StrictMode>
            <TableMenu
              view={current.view}
              session={current.session}
              actions={current.actions}
              format={current.format}
              containerRef={current.containerRef}
            />
          </StrictMode>,
        ));
        browser.flush();
        const menu = screen.getByTestId("table-menu");
        const source = tableButtons()[sourceIndex];
        const destination = tableButtons()[destinationIndex];
        const phaseProofs: Array<{
          boundary: "root" | "control";
          phase: "capture" | "bubble";
          wrapper: object;
          nativeEvent: unknown;
          target: unknown;
          currentTarget: unknown;
          eventPhase: unknown;
          scalars: readonly unknown[];
          methods: readonly unknown[];
        }> = [];
        const observe = (
          boundary: "root" | "control",
          phase: "capture" | "bubble",
        ) => (
          original: (event: ReactKeyboardEvent<HTMLElement>) => void,
          wrapper: object,
        ) => {
          const record = wrapper as Record<PropertyKey, unknown>;
          phaseProofs.push({
            boundary,
            phase,
            wrapper,
            nativeEvent: record.nativeEvent,
            target: record.target,
            currentTarget: record.currentTarget,
            eventPhase: record.eventPhase,
            scalars: REACT_KEY_PUBLIC_SCALARS.map((property) => (
              property === "currentTarget" ? null : record[property]
            )),
            methods: REACT_KEY_REQUIRED_METHODS.map((property) => record[property]),
          });
          original(wrapper as ReactKeyboardEvent<HTMLElement>);
        };
        const restores = [
          interceptReactKeyDown(menu, "onKeyDownCapture", observe("root", "capture")),
          interceptReactKeyDown(source, "onKeyDownCapture", observe("control", "capture")),
          interceptReactKeyDown(source, "onKeyDown", observe("control", "bubble")),
          interceptReactKeyDown(menu, "onKeyDown", observe("root", "bubble")),
        ];
        source.focus();
        const event = tableKeyboardEvent(source, key);
        let dispatchResult = true;
        const scrollBefore = current.container.scrollTop;

        act(() => {
          dispatchResult = source.dispatchEvent(event);
          if (dispatchResult) current.container.scrollTop += 40;
        });
        restores.forEach((restore) => restore());

        expect(dispatchResult).toBe(false);
        expect(event.defaultPrevented).toBe(true);
        expect(current.container.scrollTop).toBe(scrollBefore);
        expect(destination).toHaveFocus();
        expect(phaseProofs.map(({ boundary, phase }) => [boundary, phase])).toEqual([
          ["root", "capture"],
          ["control", "capture"],
          ["control", "bubble"],
          ["root", "bubble"],
        ]);
        const [rootCapture, controlCapture, controlBubble, rootBubble] = phaseProofs;
        expect(rootCapture).not.toBe(controlCapture);
        expect(controlBubble).not.toBe(rootBubble);
        expect(rootCapture.wrapper).toBe(controlCapture.wrapper);
        expect(controlBubble.wrapper).toBe(rootBubble.wrapper);
        expect(rootCapture.nativeEvent).toBe(event);
        expect(controlCapture.nativeEvent).toBe(event);
        expect(controlBubble.nativeEvent).toBe(event);
        expect(rootBubble.nativeEvent).toBe(event);
        expect(rootCapture.target).toBe(source);
        expect(controlCapture.target).toBe(source);
        expect(controlBubble.target).toBe(source);
        expect(rootBubble.target).toBe(source);
        expect(rootCapture.currentTarget).toBe(menu);
        expect(controlCapture.currentTarget).toBe(source);
        expect(controlBubble.currentTarget).toBe(source);
        expect(rootBubble.currentTarget).toBe(menu);
        expect(rootCapture.eventPhase).toBe(Event.CAPTURING_PHASE);
        expect(controlCapture.eventPhase).toBe(Event.CAPTURING_PHASE);
        expect(controlBubble.eventPhase).toBe(Event.BUBBLING_PHASE);
        expect(rootBubble.eventPhase).toBe(Event.BUBBLING_PHASE);
        expect(rootCapture.scalars).toEqual(controlCapture.scalars);
        expect(controlBubble.scalars).toEqual(rootBubble.scalars);
        expect(rootCapture.methods).toEqual(controlCapture.methods);
        expect(controlBubble.methods).toEqual(rootBubble.methods);
        expect(current.tableAction).not.toHaveBeenCalled();
        expect(current.alignAction).not.toHaveBeenCalled();
      } finally {
        await act(async () => root.unmount());
      }
    },
  );

  it.each([
    "wrapper",
    "phase",
    "currentTarget",
    "target",
    "nativeEvent",
    "method",
    "scalar",
  ] as const)(
    "rejects a control proof with mismatched %s while a clean successor recovers",
    async (mismatch) => {
      const focus = vi.spyOn(HTMLElement.prototype, "focus");
      const browser = controlledBrowser();
      const current = fixture({
        host: new DOMRect(50, 120, 800, 600),
        tableBox: new DOMRect(400, 360, 500, 300),
      });
      const host = document.createElement("div");
      document.body.append(host);
      const root = createRoot(host);

      try {
        await act(async () => root.render(<Boundary current={current} />));
        browser.flush();
        const menu = screen.getByTestId("table-menu");
        const source = tableButtons()[0];
        const other = tableButtons()[1];
        const restore = interceptReactKeyDown(
          source,
          "onKeyDownCapture",
          (original, wrapper) => {
            const record = wrapper as Record<PropertyKey, unknown>;
            if (mismatch === "wrapper") {
              original(Object.create(
                Object.getPrototypeOf(wrapper),
                Object.getOwnPropertyDescriptors(wrapper),
              ) as ReactKeyboardEvent<HTMLButtonElement>);
              return;
            }
            const property = mismatch === "scalar"
              ? "key"
              : mismatch === "phase"
                ? "eventPhase"
                : mismatch === "method"
                  ? "preventDefault"
                  : mismatch;
            Object.defineProperty(wrapper, property, {
              configurable: true,
              enumerable: true,
              writable: true,
              value: mismatch === "phase"
                ? Event.BUBBLING_PHASE
                : mismatch === "currentTarget"
                  ? menu
                  : mismatch === "target"
                    ? other
                    : mismatch === "nativeEvent"
                      ? tableKeyboardEvent(source, "ArrowRight")
                      : mismatch === "method"
                        ? vi.fn()
                        : "ArrowLeft",
            });
            original(record as unknown as ReactKeyboardEvent<HTMLButtonElement>);
          },
        );
        source.focus();
        focus.mockClear();

        const rejected = await dispatchTableKey(source, "ArrowRight");
        restore();

        expect(rejected.defaultPrevented).toBe(false);
        expect(source).toHaveFocus();
        expect(focus).not.toHaveBeenCalled();
        expect(current.tableAction).not.toHaveBeenCalled();
        expect(current.alignAction).not.toHaveBeenCalled();

        const recoveredSource = tableButtons()[0];
        recoveredSource.focus();
        focus.mockClear();
        const recovered = await dispatchTableKey(recoveredSource, "ArrowRight");
        expect(recovered.defaultPrevented).toBe(true);
        expect(tableButtons()[1]).toHaveFocus();
        expect(focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
        expect(current.tableAction).not.toHaveBeenCalled();
        expect(current.alignAction).not.toHaveBeenCalled();
      } finally {
        await act(async () => root.unmount());
      }
    },
  );

  it("rejects prevention deferred until a microtask as too late for native dispatch", async () => {
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const browser = controlledBrowser();
    const current = fixture({
      host: new DOMRect(50, 120, 800, 600),
      tableBox: new DOMRect(400, 360, 500, 300),
    });
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);

    try {
      await act(async () => root.render(
        <StrictMode>
          <TableMenu
            view={current.view}
            session={current.session}
            actions={current.actions}
            format={current.format}
            containerRef={current.containerRef}
          />
        </StrictMode>,
      ));
      browser.flush();
      const source = tableButtons()[0];
      const restore = interceptTableKeyDown(source, (original, wrapper) => {
        const record = wrapper as Record<PropertyKey, unknown>;
        const preventDefault = record.preventDefault;
        if (typeof preventDefault !== "function") {
          throw new Error("React preventDefault was unavailable");
        }
        Object.defineProperty(wrapper, "preventDefault", {
          configurable: true,
          enumerable: true,
          writable: true,
          value: function (this: object) {
            queueMicrotask(() => Reflect.apply(preventDefault, this, []));
          },
        });
        original(wrapper as ReactKeyboardEvent<HTMLButtonElement>);
      });
      source.focus();
      focus.mockClear();
      const event = tableKeyboardEvent(source, "ArrowRight");
      let dispatchResult = false;
      const scrollBefore = current.container.scrollTop;

      await act(async () => {
        dispatchResult = source.dispatchEvent(event);
        if (dispatchResult) current.container.scrollTop += 40;
        expect(event.defaultPrevented).toBe(false);
        expect(source).toHaveFocus();
        await Promise.resolve();
      });
      restore();

      expect(dispatchResult).toBe(true);
      expect(event.defaultPrevented).toBe(true);
      expect(current.container.scrollTop).toBe(scrollBefore + 40);
      expect(source).toHaveFocus();
      expect(focus).not.toHaveBeenCalled();
      expect(current.tableAction).not.toHaveBeenCalled();
      expect(current.alignAction).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
    }
  });

  it.each([
    ["isDefaultPrevented", "method"],
    ["isDefaultPrevented", "publication"],
    ["isDefaultPrevented", "dom"],
    ["isPropagationStopped", "method"],
    ["isPropagationStopped", "publication"],
    ["isPropagationStopped", "dom"],
  ] as const)(
    "rejects a %s query that mutates %s before focus and accepts a clean successor",
    async (query, mutationKind) => {
      const focus = vi.spyOn(HTMLElement.prototype, "focus");
      const browser = controlledBrowser();
      const current = fixture({
        host: new DOMRect(50, 120, 800, 600),
        tableBox: new DOMRect(400, 360, 500, 300),
      });
      const host = document.createElement("div");
      document.body.append(host);
      const root = createRoot(host);

      try {
        await act(async () => root.render(
          <StrictMode>
            <TableMenu
              view={current.view}
              session={current.session}
              actions={current.actions}
              format={current.format}
              containerRef={current.containerRef}
            />
          </StrictMode>,
        ));
        browser.flush();
        const source = tableButtons()[0];
        const mutate = vi.fn((wrapper: object) => {
          if (mutationKind === "method") {
            Object.defineProperty(wrapper, "preventDefault", {
              configurable: true,
              enumerable: true,
              writable: true,
              value: vi.fn(),
            });
          } else if (mutationKind === "publication") {
            current.format.tablePos = 11;
          } else {
            source.setAttribute("data-query-mutation", "true");
            source.removeAttribute("data-query-mutation");
          }
        });
        const restore = interceptTableKeyDown(source, (original, wrapper) => {
          const record = wrapper as Record<PropertyKey, unknown>;
          if (query === "isDefaultPrevented") {
            const preventDefault = record.preventDefault;
            if (typeof preventDefault !== "function") {
              throw new Error("React preventDefault was unavailable");
            }
            Object.defineProperty(wrapper, "preventDefault", {
              configurable: true,
              enumerable: true,
              writable: true,
              value: function (this: object) {
                Reflect.apply(preventDefault, this, []);
                Object.defineProperty(this, "isDefaultPrevented", {
                  configurable: true,
                  enumerable: true,
                  writable: true,
                  value: () => {
                    mutate(this);
                    return true;
                  },
                });
              },
            });
          } else {
            const isPropagationStopped = record.isPropagationStopped;
            if (typeof isPropagationStopped !== "function") {
              throw new Error("React isPropagationStopped was unavailable");
            }
            Object.defineProperty(wrapper, "isPropagationStopped", {
              configurable: true,
              enumerable: true,
              writable: true,
              value: function (this: Record<PropertyKey, unknown>) {
                if (this.defaultPrevented === true) mutate(this);
                return Reflect.apply(isPropagationStopped, this, []);
              },
            });
          }
          original(wrapper as ReactKeyboardEvent<HTMLButtonElement>);
        });
        source.focus();
        focus.mockClear();

        const rejected = tableKeyboardEvent(source, "ArrowRight");
        await act(async () => {
          source.dispatchEvent(rejected);
          if (mutationKind === "publication") current.format.tablePos = 7;
          await Promise.resolve();
        });
        restore();

        expect(mutate).toHaveBeenCalledTimes(1);
        expect(rejected.defaultPrevented).toBe(true);
        expect(source).toHaveFocus();
        expect(focus).not.toHaveBeenCalled();

        const recoveredSource = tableButtons()[0];
        recoveredSource.focus();
        focus.mockClear();
        const recovered = await dispatchTableKey(recoveredSource, "ArrowRight");
        expect(recovered.defaultPrevented).toBe(true);
        expect(tableButtons()[1]).toHaveFocus();
        expect(focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
        expect(current.tableAction).not.toHaveBeenCalled();
        expect(current.alignAction).not.toHaveBeenCalled();
      } finally {
        await act(async () => root.unmount());
      }
    },
  );

  it.each([
    ["capture", "persist", "absent"],
    ["capture", "persist", "replaced"],
    ["capture", "persist", "non-function"],
    ["capture", "stopPropagation", "absent"],
    ["capture", "stopPropagation", "replaced"],
    ["capture", "stopPropagation", "non-function"],
    ["bubble", "persist", "absent"],
    ["bubble", "persist", "replaced"],
    ["bubble", "persist", "non-function"],
    ["bubble", "stopPropagation", "absent"],
    ["bubble", "stopPropagation", "replaced"],
    ["bubble", "stopPropagation", "non-function"],
  ] as const)(
    "ignores %s wrapper %s when it is %s",
    async (phase, property, state) => {
      const focus = vi.spyOn(HTMLElement.prototype, "focus");
      const browser = controlledBrowser();
      const current = fixture({
        host: new DOMRect(50, 120, 800, 600),
        tableBox: new DOMRect(400, 360, 500, 300),
      });
      const host = document.createElement("div");
      document.body.append(host);
      const root = createRoot(host);

      try {
        await act(async () => root.render(<Boundary current={current} />));
        browser.flush();
        const menu = screen.getByTestId("table-menu");
        const source = tableButtons()[0];
        const restore = interceptReactKeyDown(
          phase === "capture" ? menu : source,
          phase === "capture" ? "onKeyDownCapture" : "onKeyDown",
          (original, event) => {
            if (state === "absent") {
              isolateReactWrapper(event, null);
              expect(property in event).toBe(false);
            } else {
              Object.defineProperty(event, property, {
                configurable: true,
                enumerable: true,
                writable: true,
                value: state === "replaced" ? vi.fn() : 7,
              });
            }
            original(event as ReactKeyboardEvent<typeof menu>);
          },
        );
        source.focus();
        focus.mockClear();

        const event = await dispatchTableKey(source, "ArrowRight");
        restore();

        expect(event.defaultPrevented).toBe(true);
        expect(tableButtons()[1]).toHaveFocus();
        expect(focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
        expect(current.tableAction).not.toHaveBeenCalled();
        expect(current.alignAction).not.toHaveBeenCalled();
      } finally {
        await act(async () => root.unmount());
      }
    },
  );

  it("accepts unrelated capture and bubble wrapper prototypes and method identities", async () => {
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const browser = controlledBrowser();
    const current = fixture({
      host: new DOMRect(50, 120, 800, 600),
      tableBox: new DOMRect(400, 360, 500, 300),
    });
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);

    try {
      await act(async () => root.render(<Boundary current={current} />));
      browser.flush();
      const menu = screen.getByTestId("table-menu");
      const source = tableButtons()[0];
      const capturePrototype = Object.create(null);
      const bubblePrototype = Object.create(null);
      let captureWrapper: object | null = null;
      let bubbleWrapper: object | null = null;
      const restoreCapture = interceptReactKeyDown(
        menu,
        "onKeyDownCapture",
        (original, event) => {
          captureWrapper = event;
          isolateReactWrapper(event, capturePrototype);
          original(event as ReactKeyboardEvent<HTMLDivElement>);
        },
      );
      const restoreBubble = interceptReactKeyDown(
        source,
        "onKeyDown",
        (original, event) => {
          bubbleWrapper = event;
          isolateReactWrapper(event, bubblePrototype, true);
          original(event as ReactKeyboardEvent<HTMLButtonElement>);
        },
      );
      source.focus();
      focus.mockClear();

      const event = await dispatchTableKey(source, "ArrowRight");
      restoreCapture();
      restoreBubble();

      expect(captureWrapper).not.toBeNull();
      expect(bubbleWrapper).not.toBeNull();
      expect(Object.getPrototypeOf(captureWrapper)).toBe(capturePrototype);
      expect(Object.getPrototypeOf(bubbleWrapper)).toBe(bubblePrototype);
      expect(event.defaultPrevented).toBe(true);
      expect(tableButtons()[1]).toHaveFocus();
      expect(focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
      expect(current.tableAction).not.toHaveBeenCalled();
      expect(current.alignAction).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
    }
  });

  it("accepts exact public scalar values from ordinary wrapper accessors", async () => {
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const browser = controlledBrowser();
    const current = fixture({
      host: new DOMRect(50, 120, 800, 600),
      tableBox: new DOMRect(400, 360, 500, 300),
    });
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);

    try {
      await act(async () => root.render(<Boundary current={current} />));
      browser.flush();
      const menu = screen.getByTestId("table-menu");
      const source = tableButtons()[0];
      const wrappers: object[] = [];
      const expose = (
        original: (event: ReactKeyboardEvent<HTMLElement>) => void,
        event: object,
      ) => {
        exposeReactScalarsAsAccessors(event);
        wrappers.push(event);
        original(event as ReactKeyboardEvent<HTMLElement>);
      };
      const restoreCapture = interceptReactKeyDown(
        menu,
        "onKeyDownCapture",
        expose,
      );
      const restoreBubble = interceptReactKeyDown(
        source,
        "onKeyDown",
        expose,
      );
      source.focus();
      focus.mockClear();

      const event = await dispatchTableKey(source, "ArrowRight");
      restoreCapture();
      restoreBubble();

      expect(wrappers).toHaveLength(2);
      for (const wrapper of wrappers) {
        for (const property of REACT_KEY_PUBLIC_SCALARS) {
          expect(Object.getOwnPropertyDescriptor(wrapper, property)?.get).toBeTypeOf("function");
        }
      }
      expect(event.defaultPrevented).toBe(true);
      expect(tableButtons()[1]).toHaveFocus();
      expect(focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
      expect(current.tableAction).not.toHaveBeenCalled();
      expect(current.alignAction).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
    }
  });

  it.each([1, 2] as const)(
    "keeps an exact native pair through %s pre-bubble microtask checkpoint(s)",
    async (checkpoints) => {
      const focus = vi.spyOn(HTMLElement.prototype, "focus");
      const browser = controlledBrowser();
      const current = fixture({
        host: new DOMRect(50, 120, 800, 600),
        tableBox: new DOMRect(400, 360, 500, 300),
      });
      const host = document.createElement("div");
      document.body.append(host);
      const root = createRoot(host);

      try {
        await act(async () => root.render(<Boundary current={current} />));
        browser.flush();
        const source = tableButtons()[0];
        const queued: VoidFunction[] = [];
        vi.spyOn(globalThis, "queueMicrotask").mockImplementation((callback) => {
          queued.push(callback);
        });
        source.addEventListener("keydown", () => {
          for (let checkpoint = 0; checkpoint < checkpoints; checkpoint++) {
            const pending = queued.splice(0);
            pending.forEach((callback) => callback());
          }
        }, { capture: true, once: true });
        source.focus();
        focus.mockClear();
        const event = tableKeyboardEvent(source, "ArrowRight");

        await act(async () => {
          source.dispatchEvent(event);
          while (queued.length > 0) {
            const pending = queued.splice(0);
            pending.forEach((callback) => callback());
          }
          await Promise.resolve();
        });

        expect(event.defaultPrevented).toBe(true);
        expect(tableButtons()[1]).toHaveFocus();
        expect(focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
        expect(current.tableAction).not.toHaveBeenCalled();
        expect(current.alignAction).not.toHaveBeenCalled();
      } finally {
        await act(async () => root.unmount());
      }
    },
  );

  it.each([
    ["capture", "preventDefault"],
    ["capture", "isDefaultPrevented"],
    ["capture", "isPropagationStopped"],
    ["bubble", "preventDefault"],
    ["bubble", "isDefaultPrevented"],
    ["bubble", "isPropagationStopped"],
  ] as const)(
    "rejects %s-phase drift in public %s and accepts a distinct clean successor",
    async (phase, method) => {
      const focus = vi.spyOn(HTMLElement.prototype, "focus");
      const browser = controlledBrowser();
      const current = fixture({
        host: new DOMRect(50, 120, 800, 600),
        tableBox: new DOMRect(400, 360, 500, 300),
      });
      const host = document.createElement("div");
      document.body.append(host);
      const root = createRoot(host);

      try {
        await act(async () => root.render(<Boundary current={current} />));
        browser.flush();
        const menu = screen.getByTestId("table-menu");
        const source = tableButtons()[0];
        const restore = interceptReactKeyDown(
          phase === "capture" ? source : menu,
          phase === "capture" ? "onKeyDownCapture" : "onKeyDown",
          (original, wrapper) => {
            Object.defineProperty(wrapper, method, {
              configurable: true,
              enumerable: true,
              writable: true,
              value: method === "preventDefault" ? vi.fn() : vi.fn(() => false),
            });
            original(wrapper as ReactKeyboardEvent<typeof source>);
          },
        );
        source.focus();
        focus.mockClear();

        const rejected = await dispatchTableKey(source, "ArrowRight");
        restore();

        expect(rejected.defaultPrevented).toBe(false);
        expect(source).toHaveFocus();
        expect(focus).not.toHaveBeenCalled();

        const recovered = await dispatchTableKey(source, "ArrowRight");
        expect(recovered.defaultPrevented).toBe(true);
        expect(tableButtons()[1]).toHaveFocus();
        expect(focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
        expect(current.tableAction).not.toHaveBeenCalled();
        expect(current.alignAction).not.toHaveBeenCalled();
      } finally {
        await act(async () => root.unmount());
      }
    },
  );

  it.each([
    ["Home", 0],
    ["End", 9],
    ["PageDown", 4],
  ] as const)("leaves a no-op %s on control %s to native behavior", async (key, sourceIndex) => {
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const browser = controlledBrowser();
    const current = fixture({
      host: new DOMRect(50, 120, 800, 600),
      tableBox: new DOMRect(400, 360, 500, 300),
    });
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);

    try {
      await act(async () => root.render(
        <StrictMode>
          <Boundary current={current} />
        </StrictMode>,
      ));
      browser.flush();
      const source = tableButtons()[sourceIndex];
      source.focus();
      focus.mockClear();

      const event = await dispatchTableKey(source, key);

      expect(event.defaultPrevented).toBe(false);
      expect(source).toHaveFocus();
      expect(focus).not.toHaveBeenCalled();
      expect(current.tableAction).not.toHaveBeenCalled();
      expect(current.alignAction).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
    }
  });

  it("rejects untrusted, modified, repeated, composing, canceled, malformed, and wrong-focus keys", async () => {
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const browser = controlledBrowser();
    const current = fixture({
      host: new DOMRect(50, 120, 800, 600),
      tableBox: new DOMRect(400, 360, 500, 300),
    });
    const host = document.createElement("div");
    const outside = document.createElement("button");
    document.body.append(outside, host);
    const root = createRoot(host);

    try {
      await act(async () => root.render(
        <StrictMode>
          <Boundary current={current} />
        </StrictMode>,
      ));
      browser.flush();
      const source = tableButtons()[0];
      const rejected: Array<{
        init?: KeyboardEventInit;
        trusted?: boolean;
        cancel?: boolean;
        wrongView?: boolean;
      }> = [
        { trusted: false },
        { init: { ctrlKey: true } },
        { init: { metaKey: true } },
        { init: { altKey: true } },
        { init: { shiftKey: true } },
        { init: { repeat: true } },
        { init: { isComposing: true } },
        { init: { bubbles: false } },
        { init: { cancelable: false } },
        { cancel: true },
        { wrongView: true },
      ];

      for (const setup of rejected) {
        source.focus();
        focus.mockClear();
        const event = tableKeyboardEvent(
          source,
          "ArrowRight",
          setup.init,
          setup.trusted ?? true,
        );
        if (setup.cancel) event.preventDefault();
        if (setup.wrongView) {
          const implementation = requiredTableEventImplementation(event);
          implementation.view = null;
        }
        await act(async () => {
          source.dispatchEvent(event);
          await Promise.resolve();
        });
        if (!setup.cancel) expect(event.defaultPrevented).toBe(false);
        expect(source).toHaveFocus();
        expect(focus).not.toHaveBeenCalled();
      }

      outside.focus();
      focus.mockClear();
      const wrongFocus = await dispatchTableKey(source, "ArrowRight");
      expect(wrongFocus.defaultPrevented).toBe(false);
      expect(outside).toHaveFocus();
      expect(focus).not.toHaveBeenCalled();

      source.focus();
      focus.mockClear();
      const accepted = await dispatchTableKey(source, "ArrowRight");
      expect(accepted.defaultPrevented).toBe(true);
      expect(tableButtons()[1]).toHaveFocus();
      expect(focus).toHaveBeenCalledTimes(1);
      expect(current.tableAction).not.toHaveBeenCalled();
      expect(current.alignAction).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      outside.remove();
    }
  });

  it("uses captured owner-realm path and focus intrinsics while rejecting native prevention drift", async () => {
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const browser = controlledBrowser();
    const current = fixture({
      host: new DOMRect(50, 120, 800, 600),
      tableBox: new DOMRect(400, 360, 500, 300),
    });
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);

    try {
      await act(async () => root.render(
        <StrictMode>
          <Boundary current={current} />
        </StrictMode>,
      ));
      browser.flush();
      const source = tableButtons()[0];
      const destination = tableButtons()[1];
      const publicPath = vi.fn(() => []);
      const publicPreventDefault = vi.fn();
      const publicFocus = vi.fn();
      const event = tableKeyboardEvent(source, "ArrowRight");
      Object.defineProperties(event, {
        composedPath: { configurable: true, value: publicPath },
        preventDefault: { configurable: true, value: publicPreventDefault },
      });
      Object.defineProperty(destination, "focus", {
        configurable: true,
        value: publicFocus,
      });
      source.focus();
      focus.mockClear();

      await act(async () => {
        source.dispatchEvent(event);
        await Promise.resolve();
      });

      expect(event.defaultPrevented).toBe(false);
      expect(source).toHaveFocus();
      expect(focus).not.toHaveBeenCalled();
      expect(publicPath).not.toHaveBeenCalled();
      expect(publicPreventDefault).not.toHaveBeenCalled();
      expect(publicFocus).not.toHaveBeenCalled();

      const accepted = tableKeyboardEvent(source, "ArrowRight");
      Object.defineProperty(accepted, "composedPath", {
        configurable: true,
        value: publicPath,
      });
      focus.mockClear();
      await act(async () => {
        source.dispatchEvent(accepted);
        await Promise.resolve();
      });
      expect(accepted.defaultPrevented).toBe(true);
      expect(destination).toHaveFocus();
      expect(focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
      expect(publicPath).not.toHaveBeenCalled();
      expect(publicFocus).not.toHaveBeenCalled();
      expect(current.tableAction).not.toHaveBeenCalled();
      expect(current.alignAction).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
    }
  });

  it("rejects a trusted foreign-realm key before a clean owner-realm successor", async () => {
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const browser = controlledBrowser();
    const current = fixture({
      host: new DOMRect(50, 120, 800, 600),
      tableBox: new DOMRect(400, 360, 500, 300),
    });
    const host = document.createElement("div");
    const frame = document.createElement("iframe");
    document.body.append(host, frame);
    const root = createRoot(host);

    try {
      await act(async () => root.render(<Boundary current={current} />));
      browser.flush();
      const source = tableButtons()[0];
      const foreignWindow = frame.contentWindow! as Window & typeof globalThis;
      const foreign = new foreignWindow.KeyboardEvent("keydown", {
        key: "ArrowRight",
        bubbles: true,
        cancelable: true,
      });
      const implementation = requiredTableEventImplementation(foreign);
      implementation.view = foreignWindow;
      markTableEventTrusted(foreign);
      source.focus();
      focus.mockClear();

      await act(async () => {
        source.dispatchEvent(foreign);
        await Promise.resolve();
      });
      expect(foreign.defaultPrevented).toBe(false);
      expect(source).toHaveFocus();
      expect(focus).not.toHaveBeenCalled();

      const accepted = await dispatchTableKey(source, "ArrowRight");
      expect(accepted.defaultPrevented).toBe(true);
      expect(tableButtons()[1]).toHaveFocus();
      expect(focus).toHaveBeenCalledTimes(1);
      expect(current.tableAction).not.toHaveBeenCalled();
      expect(current.alignAction).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      frame.remove();
    }
  });

  it("rejects fabricated and replaced wrappers, ignores stale callbacks and replayed events, then recovers", async () => {
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const browser = controlledBrowser();
    const current = fixture({
      host: new DOMRect(50, 120, 800, 600),
      tableBox: new DOMRect(400, 360, 500, 300),
    });
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);

    try {
      await act(async () => root.render(
        <StrictMode>
          <Boundary current={current} />
        </StrictMode>,
      ));
      browser.flush();
      const initial = tableButtons()[0];
      const stale = reactHandler<CapturedTableKeyDown>(initial, "onKeyDown");
      initial.focus();
      focus.mockClear();
      const fabricatedNative = tableKeyboardEvent(initial, "ArrowRight");
      stale({
        _reactName: "onKeyDown",
        type: "keydown",
        nativeEvent: fabricatedNative,
        target: initial,
        currentTarget: initial,
        bubbles: true,
        cancelable: true,
        defaultPrevented: false,
        isTrusted: true,
        key: "ArrowRight",
        ctrlKey: false,
        metaKey: false,
        altKey: false,
        shiftKey: false,
        repeat: false,
        isComposing: false,
        view: window,
      } as unknown as ReactKeyboardEvent<HTMLButtonElement>);
      expect(fabricatedNative.defaultPrevented).toBe(false);
      expect(focus).not.toHaveBeenCalled();

      const replaceWrapper = interceptTableKeyDown(initial, (original, event) => {
        original(Object.create(
          Object.getPrototypeOf(event),
          Object.getOwnPropertyDescriptors(event),
        ) as ReactKeyboardEvent<HTMLButtonElement>);
      });
      const replaced = await dispatchTableKey(initial, "ArrowRight");
      replaceWrapper();
      expect(replaced.defaultPrevented).toBe(false);
      expect(initial).toHaveFocus();
      expect(focus).not.toHaveBeenCalled();

      const afterWrapper = tableButtons()[0];
      const replacePredicate = interceptTableKeyDown(afterWrapper, (original, event) => {
        Object.defineProperty(event, "isDefaultPrevented", {
          configurable: true,
          enumerable: true,
          writable: true,
          value: () => true,
        });
        original(event as ReactKeyboardEvent<HTMLButtonElement>);
      });
      afterWrapper.focus();
      focus.mockClear();
      const predicate = await dispatchTableKey(afterWrapper, "ArrowRight");
      replacePredicate();
      expect(predicate.defaultPrevented).toBe(false);
      expect(afterWrapper).toHaveFocus();
      expect(focus).not.toHaveBeenCalled();

      const recovered = tableButtons()[0];
      const recoveredHandler = reactHandler<CapturedTableKeyDown>(recovered, "onKeyDown");
      expect(recoveredHandler).not.toBe(stale);
      const combineStale = interceptTableKeyDown(recovered, (original, event) => {
        stale(event as ReactKeyboardEvent<HTMLButtonElement>);
        original(event as ReactKeyboardEvent<HTMLButtonElement>);
      });
      recovered.focus();
      focus.mockClear();
      const accepted = await dispatchTableKey(recovered, "ArrowRight");
      combineStale();
      expect(accepted.defaultPrevented).toBe(true);
      expect(tableButtons()[1]).toHaveFocus();
      expect(focus).toHaveBeenCalledTimes(1);

      focus.mockClear();
      await act(async () => {
        tableButtons()[1].dispatchEvent(accepted);
        await Promise.resolve();
      });
      expect(focus).not.toHaveBeenCalled();
      expect(tableButtons()[1]).toHaveFocus();
      expect(current.tableAction).not.toHaveBeenCalled();
      expect(current.alignAction).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
    }
  });

  it("rejects reentrant native key delivery and accepts one clean successor", async () => {
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const browser = controlledBrowser();
    const current = fixture({
      host: new DOMRect(50, 120, 800, 600),
      tableBox: new DOMRect(400, 360, 500, 300),
    });
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);

    try {
      await act(async () => root.render(<Boundary current={current} />));
      browser.flush();
      const source = tableButtons()[0];
      const outer = tableKeyboardEvent(source, "ArrowRight");
      const inner = tableKeyboardEvent(source, "ArrowDown");
      let reentered = false;
      source.addEventListener("keydown", () => {
        if (reentered) return;
        reentered = true;
        source.dispatchEvent(inner);
      }, { capture: true, once: true });
      source.focus();
      focus.mockClear();

      await act(async () => {
        source.dispatchEvent(outer);
        await Promise.resolve();
      });

      expect(outer.defaultPrevented).toBe(false);
      expect(inner.defaultPrevented).toBe(false);
      expect(source).toHaveFocus();
      expect(focus).not.toHaveBeenCalled();

      const recovered = tableButtons()[0];
      recovered.focus();
      focus.mockClear();
      const accepted = await dispatchTableKey(recovered, "ArrowRight");
      expect(accepted.defaultPrevented).toBe(true);
      expect(tableButtons()[1]).toHaveFocus();
      expect(focus).toHaveBeenCalledTimes(1);
      expect(current.tableAction).not.toHaveBeenCalled();
      expect(current.alignAction).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
    }
  });

  it.each([
    "mutate and restore",
    "detach and reinsert",
    "reorder and restore",
    "replace and restore",
  ] as const)(
    "retires keyboard DOM history after %s and accepts a distinct clean successor",
    async (change) => {
      const focus = vi.spyOn(HTMLElement.prototype, "focus");
      const browser = controlledBrowser();
      const current = fixture({
        host: new DOMRect(50, 120, 800, 600),
        tableBox: new DOMRect(400, 360, 500, 300),
      });
      const host = document.createElement("div");
      document.body.append(host);
      const root = createRoot(host);

      try {
        await act(async () => root.render(
          <StrictMode>
            <Boundary current={current} />
          </StrictMode>,
        ));
        browser.flush();
        const menu = screen.getByTestId("table-menu");
        const source = tableButtons()[0];
        const stale = reactHandler<CapturedTableKeyDown>(source, "onKeyDown");
        if (change === "mutate and restore") {
          source.setAttribute("data-transient", "changed");
          source.removeAttribute("data-transient");
        } else if (change === "detach and reinsert") {
          const parent = menu.parentNode!;
          const next = menu.nextSibling;
          menu.remove();
          parent.insertBefore(menu, next);
        } else if (change === "reorder and restore") {
          const buttons = tableButtons();
          buttons[9].before(buttons[0]);
          buttons[1].before(buttons[0]);
        } else {
          const replacement = source.cloneNode(true) as HTMLButtonElement;
          source.replaceWith(replacement);
          replacement.replaceWith(source);
        }
        await act(async () => {});

        const recovered = tableButtons()[0];
        const recoveredHandler = reactHandler<CapturedTableKeyDown>(recovered, "onKeyDown");
        expect(recoveredHandler).not.toBe(stale);
        const combineStale = interceptTableKeyDown(recovered, (original, event) => {
          stale(event as ReactKeyboardEvent<HTMLButtonElement>);
          original(event as ReactKeyboardEvent<HTMLButtonElement>);
        });
        recovered.focus();
        focus.mockClear();
        const accepted = await dispatchTableKey(recovered, "ArrowRight");
        combineStale();

        expect(accepted.defaultPrevented).toBe(true);
        expect(tableButtons()[1]).toHaveFocus();
        expect(focus).toHaveBeenCalledTimes(1);
        expect(current.tableAction).not.toHaveBeenCalled();
        expect(current.alignAction).not.toHaveBeenCalled();
      } finally {
        await act(async () => root.unmount());
      }
    },
  );

  it("retires old session, format, editor, and owner-realm authority before a clean recovery", async () => {
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const browser = controlledBrowser();
    const current = fixture({
      host: new DOMRect(50, 120, 800, 600),
      tableBox: new DOMRect(400, 360, 500, 300),
    });
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);

    try {
      await act(async () => root.render(
        <StrictMode>
          <Boundary current={current} />
        </StrictMode>,
      ));
      browser.flush();

      const rejectDrift = async (change: () => void, restore: () => void) => {
        const source = tableButtons()[0];
        source.focus();
        focus.mockClear();
        const event = tableKeyboardEvent(source, "ArrowRight");
        await act(async () => {
          change();
          source.dispatchEvent(event);
          restore();
          await Promise.resolve();
        });
        expect(event.defaultPrevented).toBe(false);
        expect(focus).not.toHaveBeenCalled();
      };

      await rejectDrift(
        () => {
          current.format.tablePos = -1;
        },
        () => {
          current.format.tablePos = 7;
        },
      );
      await rejectDrift(
        () => {
          (current.session as unknown as { canEdit: boolean }).canEdit = false;
        },
        () => {
          (current.session as unknown as { canEdit: boolean }).canEdit = true;
        },
      );
      const foreignEditor = document.createElement("div");
      await rejectDrift(
        () => current.domRead.mockReturnValue(foreignEditor),
        () => current.domRead.mockReturnValue(current.editor),
      );

      const keyDescriptor = Object.getOwnPropertyDescriptor(
        KeyboardEvent.prototype,
        "key",
      );
      if (!keyDescriptor?.get) throw new Error("KeyboardEvent.key was unavailable");
      await rejectDrift(
        () => {
          Object.defineProperty(KeyboardEvent.prototype, "key", {
            ...keyDescriptor,
            get: () => "End",
          });
        },
        () => {
          Object.defineProperty(KeyboardEvent.prototype, "key", keyDescriptor);
        },
      );
      const keyboardParent = Object.getPrototypeOf(KeyboardEvent.prototype);
      await rejectDrift(
        () => {
          Object.setPrototypeOf(
            KeyboardEvent.prototype,
            Object.create(keyboardParent),
          );
        },
        () => {
          Object.setPrototypeOf(KeyboardEvent.prototype, keyboardParent);
        },
      );

      const recovered = tableButtons()[0];
      recovered.focus();
      focus.mockClear();
      const accepted = await dispatchTableKey(recovered, "ArrowRight");
      expect(accepted.defaultPrevented).toBe(true);
      expect(tableButtons()[1]).toHaveFocus();
      expect(focus).toHaveBeenCalledTimes(1);
      expect(current.tableAction).not.toHaveBeenCalled();
      expect(current.alignAction).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
    }
  });

  it.each(["stale-before-current", "current-before-stale"] as const)(
    "retires reused-DOM actions before the parent layout boundary and keeps the replacement usable (%s)",
    (order) => {
      const browser = controlledBrowser();
      const current = fixture({
        host: new DOMRect(50, 120, 800, 600),
        tableBox: new DOMRect(400, 360, 500, 300),
        align: "center",
      });
      const replacement = {
        ...current,
        actions: {
          table: current.actions.table,
          setColumnAlign: current.actions.setColumnAlign,
        } as EditorActions,
      };
      const host = document.createElement("div");
      document.body.append(host);
      const root = createRoot(host);
      const focus = vi.spyOn(HTMLElement.prototype, "focus");
      let passiveCleanups = 0;
      const onPassiveCleanup = () => {
        passiveCleanups++;
      };

      try {
        act(() => root.render(<Boundary current={current} onPassiveCleanup={onPassiveCleanup} />));
        browser.flush();
        const reusedMenu = screen.getByTestId("table-menu");
        const reusedRow = screen.getByTestId("table-row-before");
        const retired = captureRepresentativeControls();
        let boundaries = 0;

        act(() => {
          root.render(
            <Boundary
              current={replacement}
              boundary={1}
              onPassiveCleanup={onPassiveCleanup}
              onBoundary={() => {
                boundaries++;
                expect(passiveCleanups).toBe(0);
                expect(screen.getByTestId("table-menu")).toBe(reusedMenu);
                expect(screen.getByTestId("table-row-before")).toBe(reusedRow);
                expectRetiredControlsDoNoWork({ controls: retired, browser, fixtures: [current], host, focus });
              }}
            />,
          );
        });
        expect(boundaries).toBe(1);
        expect(passiveCleanups).toBe(1);
        expectRetiredControlsDoNoWork({ controls: retired, browser, fixtures: [current], host, focus });

        const replacementControls = captureRepresentativeControls();
        const pairs = [
          [retired.table, replacementControls.table],
          [retired.alignment, replacementControls.alignment],
          [retired.deletion, replacementControls.deletion],
        ] as const;
        const retiredPreventions = pairs.map(() => vi.fn());
        const currentPreventions = pairs.map(() => vi.fn());
        for (const [retiredControl, currentControl] of pairs) {
          retiredControl.buttonRef(null);
          retiredControl.buttonRef(currentControl.element);
        }
        const staleAttempt = () => {
          pairs.forEach(([retiredControl, currentControl], index) => {
            mouseDown(retiredControl, retiredPreventions[index], currentControl.element);
            click(retiredControl, currentControl.element);
          });
        };
        const currentAttempt = () => {
          pairs.forEach(([, currentControl], index) => {
            mouseDown(currentControl, currentPreventions[index]);
            click(currentControl);
          });
        };
        for (const attempt of order === "stale-before-current"
          ? [staleAttempt, currentAttempt]
          : [currentAttempt, staleAttempt]) {
          attempt();
        }
        expect(retiredPreventions.every((preventDefault) => preventDefault.mock.calls.length === 0)).toBe(true);
        expect(currentPreventions.every((preventDefault) => preventDefault.mock.calls.length === 1)).toBe(true);
        expect(current.tableAction.mock.calls).toEqual([["rowBefore"], ["deleteTable"]]);
        expect(current.alignAction.mock.calls).toEqual([[null]]);

        click(replacementControls.table);
        fireEvent.click(reusedRow);
        click(replacementControls.alignment);
        click(replacementControls.deletion);
        expect(current.tableAction.mock.calls).toEqual([["rowBefore"], ["deleteTable"]]);
        expect(current.alignAction.mock.calls).toEqual([[null]]);

        click(captureControl("table-align-left"));
        click(captureControl("table-delete-row"));
        expect(current.tableAction.mock.calls).toEqual([["rowBefore"], ["deleteTable"], ["deleteRow"]]);
        expect(current.alignAction.mock.calls).toEqual([[null], ["left"]]);

        let replacementBoundaries = 0;
        act(() => {
          root.render(
            <Boundary
              current={replacement}
              boundary={2}
              onPassiveCleanup={onPassiveCleanup}
              onBoundary={() => {
                replacementBoundaries++;
                expect(passiveCleanups).toBe(1);
                expectRetiredControlsDoNoWork({
                  controls: replacementControls,
                  browser,
                  fixtures: [current],
                  host,
                  focus,
                });
              }}
            />,
          );
        });
        expect(replacementBoundaries).toBe(1);
        expect(passiveCleanups).toBe(2);
        expect(screen.getByTestId("table-menu")).toBe(reusedMenu);
        expect(screen.getByTestId("table-row-before")).toBe(reusedRow);
        click(captureControl("table-row-before"));
        click(captureControl("table-row-before"));
        expect(current.tableAction.mock.calls).toEqual([["rowBefore"], ["deleteTable"], ["deleteRow"], ["rowBefore"]]);
      } finally {
        act(() => root.unmount());
      }
    },
  );

  it("retires format, eligibility, geometry, view, session, container, and removal publications without stale work", () => {
    const browser = controlledBrowser();
    const first = fixture({
      host: new DOMRect(10, 100, 800, 600),
      tableBox: new DOMRect(110, 300, 500, 300),
      align: "center",
    });
    const second = fixture({
      host: new DOMRect(50, 120, 800, 600),
      tableBox: new DOMRect(400, 360, 500, 300),
      align: "center",
    });
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    let passiveCleanups = 0;
    const onPassiveCleanup = () => {
      passiveCleanups++;
    };

    try {
      act(() => root.render(<Boundary current={first} onPassiveCleanup={onPassiveCleanup} />));
      browser.flush();
      const reusedMenu = screen.getByTestId("table-menu");
      const reusedRow = screen.getByTestId("table-row-before");
      const initial = captureRepresentativeControls();
      const equalFormat = { ...first, format: { ...first.format } };
      let formatBoundaries = 0;

      act(() => {
        root.render(
          <Boundary
            current={equalFormat}
            boundary={1}
            onPassiveCleanup={onPassiveCleanup}
            onBoundary={() => {
              formatBoundaries++;
              expect(passiveCleanups).toBe(0);
              expect(screen.getByTestId("table-menu")).toBe(reusedMenu);
              expect(screen.getByTestId("table-row-before")).toBe(reusedRow);
              expectRetiredControlsDoNoWork({ controls: initial, browser, fixtures: [first], host, focus });
            }}
          />,
        );
      });
      expect(formatBoundaries).toBe(1);
      expect(passiveCleanups).toBe(1);
      expectRetiredControlsDoNoWork({ controls: initial, browser, fixtures: [first], host, focus });

      const formatted = captureRepresentativeControls();
      equalFormat.format.tableAlign = "right";
      expectRetiredControlsDoNoWork({ controls: formatted, browser, fixtures: [first], host, focus });
      equalFormat.format.tableAlign = "center";

      (first.session as unknown as { canEdit: boolean }).canEdit = false;
      let editabilityBoundaries = 0;
      act(() => {
        root.render(
          <Boundary
            current={equalFormat}
            boundary={2}
            onPassiveCleanup={onPassiveCleanup}
            onBoundary={() => {
              editabilityBoundaries++;
              expect(passiveCleanups).toBe(1);
              expectRetiredControlsDoNoWork({ controls: formatted, browser, fixtures: [first], host, focus });
            }}
          />,
        );
      });
      expect(editabilityBoundaries).toBe(1);
      expect(passiveCleanups).toBe(2);
      const ineligibleEdit = captureRepresentativeControls();
      expectRetiredControlsDoNoWork({ controls: ineligibleEdit, browser, fixtures: [first], host, focus });
      browser.flush();
      expect(screen.queryByTestId("table-menu")).toBeNull();
      expectRetiredControlsDoNoWork({ controls: formatted, browser, fixtures: [first], host, focus });
      expectRetiredControlsDoNoWork({ controls: ineligibleEdit, browser, fixtures: [first], host, focus });

      (first.session as unknown as { canEdit: boolean }).canEdit = true;
      act(() => root.render(<Boundary current={equalFormat} boundary={3} onPassiveCleanup={onPassiveCleanup} />));
      browser.flush();
      const editable = captureRepresentativeControls();
      (first.session as unknown as { activeSurface: "code" | "rich" }).activeSurface = "code";
      let surfaceBoundaries = 0;
      act(() => {
        root.render(
          <Boundary
            current={equalFormat}
            boundary={4}
            onPassiveCleanup={onPassiveCleanup}
            onBoundary={() => {
              surfaceBoundaries++;
              expect(passiveCleanups).toBe(3);
              expectRetiredControlsDoNoWork({ controls: editable, browser, fixtures: [first], host, focus });
            }}
          />,
        );
      });
      expect(surfaceBoundaries).toBe(1);
      expect(passiveCleanups).toBe(4);
      const ineligibleSurface = captureRepresentativeControls();
      expectRetiredControlsDoNoWork({ controls: ineligibleSurface, browser, fixtures: [first], host, focus });
      browser.flush();
      expect(screen.queryByTestId("table-menu")).toBeNull();

      (first.session as unknown as { activeSurface: "code" | "rich" }).activeSurface = "rich";
      act(() => root.render(<Boundary current={equalFormat} boundary={5} onPassiveCleanup={onPassiveCleanup} />));
      browser.flush();
      const beforeDestruction = captureRepresentativeControls();
      first.destroyedRead.mockReturnValue(true);
      const destroyedPrevention = vi.fn();
      mouseDown(beforeDestruction.table, destroyedPrevention);
      click(beforeDestruction.table);
      expect(destroyedPrevention).not.toHaveBeenCalled();
      expect(first.tableAction).not.toHaveBeenCalled();
      expect(first.alignAction).not.toHaveBeenCalled();
      first.destroyedRead.mockReturnValue(false);
      const prevention = vi.fn();
      mouseDown(beforeDestruction.table, prevention);
      click(beforeDestruction.table);
      expect(prevention).toHaveBeenCalledOnce();
      expect(first.tableAction.mock.calls).toEqual([["rowBefore"]]);

      first.container.dispatchEvent(new Event("scroll"));
      const beforeGeometry = captureRepresentativeControls();
      const menuBeforeGeometry = screen.getByTestId("table-menu");
      const rowBeforeGeometry = screen.getByTestId("table-row-before");
      browser.flush();
      expect(screen.getByTestId("table-menu")).toBe(menuBeforeGeometry);
      expect(screen.getByTestId("table-row-before")).toBe(rowBeforeGeometry);
      expectRetiredControlsDoNoWork({ controls: beforeGeometry, browser, fixtures: [first], host, focus });
      const currentGeometry = captureRepresentativeControls();

      let replacementBoundaries = 0;
      act(() => {
        root.render(
          <Boundary
            current={second}
            boundary={6}
            onPassiveCleanup={onPassiveCleanup}
            onBoundary={() => {
              replacementBoundaries++;
              expect(passiveCleanups).toBe(5);
              expect(screen.queryByTestId("table-menu")).toBeNull();
              expectRetiredControlsDoNoWork({
                controls: currentGeometry,
                browser,
                fixtures: [first, second],
                host,
                focus,
              });
            }}
          />,
        );
      });
      expect(replacementBoundaries).toBe(1);
      expect(passiveCleanups).toBe(6);
      expectRetiredControlsDoNoWork({ controls: currentGeometry, browser, fixtures: [first, second], host, focus });
      browser.flush();
      const replacement = captureRepresentativeControls();
      click(replacement.alignment);
      click(replacement.deletion);
      expect(second.alignAction.mock.calls).toEqual([[null]]);
      expect(second.tableAction.mock.calls).toEqual([["deleteTable"]]);

      let removalBoundaries = 0;
      act(() => {
        root.render(
          <Boundary
            current={second}
            present={false}
            boundary={7}
            onPassiveCleanup={onPassiveCleanup}
            onBoundary={() => {
              removalBoundaries++;
              expect(passiveCleanups).toBe(6);
              expectRetiredControlsDoNoWork({
                controls: replacement,
                browser,
                fixtures: [first, second],
                host,
                focus,
              });
            }}
          />,
        );
      });
      expect(removalBoundaries).toBe(1);
      expect(passiveCleanups).toBe(7);
      expect(screen.queryByTestId("table-menu")).toBeNull();
      expectRetiredControlsDoNoWork({ controls: replacement, browser, fixtures: [first, second], host, focus });
    } finally {
      act(() => root.unmount());
    }
  });

  it("isolates an equal-value remount from the retired mount's callbacks and claims", () => {
    const browser = controlledBrowser();
    const current = fixture({
      host: new DOMRect(50, 120, 800, 600),
      tableBox: new DOMRect(400, 360, 500, 300),
      align: "center",
    });
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    let passiveCleanups = 0;
    const onPassiveCleanup = () => {
      passiveCleanups++;
    };

    try {
      act(() => root.render(<Boundary current={current} mountKey={0} onPassiveCleanup={onPassiveCleanup} />));
      browser.flush();
      const retired = captureRepresentativeControls();
      click(retired.table);
      expect(current.tableAction.mock.calls).toEqual([["rowBefore"]]);
      let boundaries = 0;
      act(() => {
        root.render(
          <Boundary
            current={current}
            mountKey={1}
            boundary={1}
            onPassiveCleanup={onPassiveCleanup}
            onBoundary={() => {
              boundaries++;
              expect(passiveCleanups).toBe(0);
              expect(screen.queryByTestId("table-menu")).toBeNull();
              expectRetiredControlsDoNoWork({ controls: retired, browser, fixtures: [current], host, focus });
            }}
          />,
        );
      });
      expect(boundaries).toBe(1);
      expect(passiveCleanups).toBe(1);
      expectRetiredControlsDoNoWork({ controls: retired, browser, fixtures: [current], host, focus });

      browser.flush();
      const remounted = captureRepresentativeControls();
      expect(remounted.table.element).not.toBe(retired.table.element);
      expect(retired.table.element.isConnected).toBe(false);
      for (const [retiredControl, remountedControl] of [
        [retired.table, remounted.table],
        [retired.alignment, remounted.alignment],
        [retired.deletion, remounted.deletion],
      ] as const) {
        expectWrongTargetDoesNoWork({
          control: retiredControl,
          currentTarget: remountedControl.element,
          browser,
          fixtures: [current],
          host,
          focus,
        });
      }
      click(remounted.table);
      click(remounted.alignment);
      expectRetiredControlsDoNoWork({ controls: retired, browser, fixtures: [current], host, focus });
      expect(current.tableAction.mock.calls).toEqual([["rowBefore"], ["rowBefore"]]);
      expect(current.alignAction.mock.calls).toEqual([[null]]);
    } finally {
      act(() => root.unmount());
    }
  });
});
