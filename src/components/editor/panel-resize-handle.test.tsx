// @vitest-environment jsdom
import {
  StrictMode,
  useLayoutEffect,
  type ComponentProps,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { createRoot, type Root } from "react-dom/client";
import { act, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PanelResizeHandle,
  PANEL_BIG_STEP,
  PANEL_DEFAULT,
  PANEL_MAX,
  PANEL_MIN,
  PANEL_STEP,
  clampPanelWidth,
  panelMaxFor,
  parseStoredPanelWidth,
} from "./panel-resize-handle";

type HandleProps = ComponentProps<typeof PanelResizeHandle>;
type HandlePointer = (event: ReactPointerEvent<HTMLDivElement>) => void;
type HandleKeyboard = (event: ReactKeyboardEvent<HTMLDivElement>) => void;
type HandleDoubleClick = (event: ReactMouseEvent<HTMLDivElement>) => void;
type HandleRef<T extends HTMLElement> = (element: T | null) => void;

interface HandleHandlers {
  readonly pointerDown: HandlePointer;
  readonly pointerMove: HandlePointer;
  readonly pointerUp: HandlePointer;
  readonly pointerCancel: HandlePointer;
  readonly lostPointerCapture: HandlePointer;
  readonly keyDown: HandleKeyboard;
  readonly doubleClick: HandleDoubleClick;
}

interface BoundaryProps extends Partial<HandleProps> {
  readonly instance?: string;
  readonly present?: boolean;
  readonly boundary?: number;
  readonly onBoundary?: () => void;
}

const setPointerCapture = vi.fn();
const releasePointerCapture = vi.fn();
const roots = new Set<Root>();
const hosts = new Set<HTMLElement>();

function ResizeBoundary({
  instance = "resize",
  present = true,
  boundary = 0,
  onBoundary,
  width = PANEL_DEFAULT,
  min = PANEL_MIN,
  max = PANEL_MAX,
  onResize = vi.fn(),
  onReset = vi.fn(),
}: BoundaryProps) {
  useLayoutEffect(() => {
    if (boundary > 0) onBoundary?.();
  }, [boundary, onBoundary]);
  return present ? (
    <section data-testid="resize-higher-ancestor">
      <div data-testid="resize-parent">
        <PanelResizeHandle
          key={instance}
          width={width}
          min={min}
          max={max}
          onResize={onResize}
          onReset={onReset}
        />
      </div>
    </section>
  ) : null;
}

function strictView(props: BoundaryProps = {}, withSentinels = false) {
  const host = document.createElement("div");
  if (withSentinels) {
    const before = document.createElement("i");
    const after = document.createElement("i");
    before.dataset.sentinel = "before";
    after.dataset.sentinel = "after";
    document.body.append(before, host, after);
    hosts.add(before);
    hosts.add(after);
  } else {
    document.body.append(host);
  }
  hosts.add(host);
  const root = createRoot(host);
  roots.add(root);
  act(() => {
    root.render(
      <StrictMode>
        <ResizeBoundary {...props} />
      </StrictMode>,
    );
  });
  return { host, root };
}

function renderStrict(root: Root, props: BoundaryProps) {
  act(() => {
    root.render(
      <StrictMode>
        <ResizeBoundary {...props} />
      </StrictMode>,
    );
  });
}

function currentHandle(host?: HTMLElement) {
  const handle = host
    ? host.querySelector<HTMLElement>('[data-testid="panel-resize-handle"]')
    : screen.queryByTestId("panel-resize-handle");
  if (!(handle instanceof HTMLDivElement)) {
    throw new Error("The panel resize handle was not rendered");
  }
  return handle;
}

function currentLine(handle: HTMLDivElement) {
  const line = handle.firstElementChild;
  if (!(line instanceof HTMLSpanElement)) {
    throw new Error("The panel resize line was not rendered");
  }
  return line;
}

function reactPropsEntry(element: Element) {
  const key = Object.keys(element).find((candidate) =>
    candidate.startsWith("__reactProps$"));
  if (!key) throw new Error("React props were not attached to the handle");
  const record = element as unknown as Record<string, Record<string, unknown>>;
  return { key, record, props: record[key]! };
}

function reactHandler<T>(element: Element, name: string): T {
  const handler = reactPropsEntry(element).props[name];
  if (typeof handler !== "function") {
    throw new Error(`${name} was not attached to the handle`);
  }
  return handler as T;
}

function reactRef<T extends HTMLElement>(element: T): HandleRef<T> {
  const ref = reactPropsEntry(element).props.ref;
  if (typeof ref !== "function") {
    throw new Error("A callback ref was not attached to the handle");
  }
  return ref as HandleRef<T>;
}

function handlers(handle: HTMLDivElement): HandleHandlers {
  return {
    pointerDown: reactHandler(handle, "onPointerDown"),
    pointerMove: reactHandler(handle, "onPointerMove"),
    pointerUp: reactHandler(handle, "onPointerUp"),
    pointerCancel: reactHandler(handle, "onPointerCancel"),
    lostPointerCapture: reactHandler(handle, "onLostPointerCapture"),
    keyDown: reactHandler(handle, "onKeyDown"),
    doubleClick: reactHandler(handle, "onDoubleClick"),
  };
}

function intercept<T>(
  element: Element,
  name: string,
  invoke: (current: T, event: unknown) => void,
) {
  const { key, record, props } = reactPropsEntry(element);
  const current = props[name];
  if (typeof current !== "function") {
    throw new Error(`${name} was not attached to the handle`);
  }
  const intercepted = {
    ...props,
    [name]: (event: unknown) => invoke(current as T, event),
  };
  record[key] = intercepted;
  return () => {
    if (record[key] === intercepted) record[key] = props;
  };
}

function pointerDown(
  target: Element,
  pointerId: number,
  clientX: number,
  pointerType = "mouse",
) {
  fireEvent.pointerDown(target, {
    pointerId,
    pointerType,
    clientX,
    button: 0,
    buttons: 1,
    isPrimary: true,
  });
}

function pointerMove(
  target: Element,
  pointerId: number,
  clientX: number,
  pointerType = "mouse",
) {
  fireEvent.pointerMove(target, {
    pointerId,
    pointerType,
    clientX,
    button: -1,
    buttons: 1,
    isPrimary: true,
  });
}

function pointerUp(
  target: Element,
  pointerId: number,
  pointerType = "mouse",
) {
  fireEvent.pointerUp(target, {
    pointerId,
    pointerType,
    button: 0,
    buttons: 0,
    isPrimary: true,
  });
}

function pointerCancel(
  target: Element,
  pointerId: number,
  pointerType = "mouse",
) {
  fireEvent.pointerCancel(target, {
    pointerId,
    pointerType,
    button: 0,
    buttons: 0,
    isPrimary: true,
  });
}

function lostPointerCapture(
  target: Element,
  pointerId: number,
  pointerType = "mouse",
) {
  fireEvent.lostPointerCapture(target, {
    pointerId,
    pointerType,
    button: 0,
    buttons: 0,
    isPrimary: true,
  });
}

function doubleClick(target: Element) {
  fireEvent.doubleClick(target, {
    button: 0,
    buttons: 0,
    detail: 2,
  });
}

async function flushMutations() {
  await act(async () => {
    await Promise.resolve();
  });
}

function captureFirstStrictHandlers(
  props: BoundaryProps,
): {
  readonly view: ReturnType<typeof strictView>;
  readonly stale: HandleHandlers;
  readonly handle: HTMLDivElement;
  readonly current: HandleHandlers;
} {
  const stale: { value: HandleHandlers | null } = { value: null };
  const view = strictView({
    ...props,
    boundary: 1,
    onBoundary: () => {
      stale.value ??= handlers(currentHandle());
      props.onBoundary?.();
    },
  });
  const handle = currentHandle(view.host);
  const current = handlers(handle);
  const captured = stale.value;
  if (!captured) throw new Error("Strict Mode did not run the first layout");
  expect(current.pointerDown).not.toBe(captured.pointerDown);
  return { view, stale: captured, handle, current };
}

beforeEach(() => {
  Element.prototype.setPointerCapture = setPointerCapture;
  Element.prototype.releasePointerCapture = releasePointerCapture;
});

afterEach(() => {
  for (const root of roots) {
    act(() => root.unmount());
  }
  roots.clear();
  for (const host of hosts) host.remove();
  hosts.clear();
  Element.prototype.setPointerCapture = setPointerCapture;
  Element.prototype.releasePointerCapture = releasePointerCapture;
  setPointerCapture.mockReset();
  releasePointerCapture.mockReset();
  document.body.style.cursor = "";
  document.body.style.userSelect = "";
});

describe("PanelResizeHandle", () => {
  it("preserves the exact separator presentation and keyboard semantics after Strict Mode replay", () => {
    const onResize = vi.fn();
    const onReset = vi.fn();
    const { handle } = captureFirstStrictHandlers({ onResize, onReset });

    expect(handle).toHaveAttribute("role", "separator");
    expect(handle).toHaveAttribute("aria-orientation", "vertical");
    expect(handle).toHaveAttribute("aria-label", "Resize panel");
    expect(handle).toHaveAttribute("aria-valuemin", String(PANEL_MIN));
    expect(handle).toHaveAttribute("aria-valuemax", String(PANEL_MAX));
    expect(handle).toHaveAttribute("aria-valuenow", String(PANEL_DEFAULT));
    expect(handle).toHaveAttribute("aria-valuetext", `${PANEL_DEFAULT} pixels`);
    expect(handle).toHaveAttribute("tabindex", "0");
    expect(handle).not.toHaveAttribute("data-dragging");
    expect(handle.childNodes).toHaveLength(1);
    expect(currentLine(handle)).toHaveAttribute("aria-hidden", "true");

    fireEvent.keyDown(handle, { key: "ArrowLeft" });
    fireEvent.keyDown(handle, { key: "ArrowRight", shiftKey: true });
    fireEvent.keyDown(handle, { key: "Home" });
    fireEvent.keyDown(handle, { key: "End" });
    fireEvent.keyDown(handle, { key: "Enter" });
    doubleClick(handle);
    fireEvent.keyDown(handle, { key: "ArrowUp" });

    expect(onResize.mock.calls).toEqual([
      [PANEL_DEFAULT + PANEL_STEP],
      [PANEL_MIN],
      [PANEL_MIN],
      [PANEL_MAX],
    ]);
    expect(onReset).toHaveBeenCalledTimes(2);
  });

  it("claims a Strict Mode drag once before stale, repeated, and fabricated start work", () => {
    const onResize = vi.fn();
    const { stale, handle, current } = captureFirstStrictHandlers({ onResize });
    const stopIntercept = intercept<HandlePointer>(
      handle,
      "onPointerDown",
      (start, event) => {
        stale.pointerDown(event as ReactPointerEvent<HTMLDivElement>);
        start({ ...(event as object) } as ReactPointerEvent<HTMLDivElement>);
        start(event as ReactPointerEvent<HTMLDivElement>);
        stale.pointerDown(event as ReactPointerEvent<HTMLDivElement>);
        current.pointerDown(event as ReactPointerEvent<HTMLDivElement>);
      },
    );

    pointerDown(currentLine(handle), 11, 800);
    stopIntercept();
    expect(setPointerCapture).toHaveBeenCalledExactlyOnceWith(11);
    expect(setPointerCapture.mock.contexts[0]).toBe(handle);
    expect(handle).toHaveAttribute("data-dragging", "true");
    expect(document.body.style.cursor).toBe("col-resize");
    expect(document.body.style.userSelect).toBe("none");

    const stopMoveIntercept = intercept<HandlePointer>(
      handle,
      "onPointerMove",
      (move, event) => {
        stale.pointerMove(event as ReactPointerEvent<HTMLDivElement>);
        move({ ...(event as object) } as ReactPointerEvent<HTMLDivElement>);
        move(event as ReactPointerEvent<HTMLDivElement>);
        current.pointerMove(event as ReactPointerEvent<HTMLDivElement>);
      },
    );
    pointerMove(handle, 11, 760);
    stopMoveIntercept();
    expect(onResize).toHaveBeenCalledExactlyOnceWith(380);

    const stopUpIntercept = intercept<HandlePointer>(
      handle,
      "onPointerUp",
      (end, event) => {
        stale.pointerUp(event as ReactPointerEvent<HTMLDivElement>);
        end({ ...(event as object) } as ReactPointerEvent<HTMLDivElement>);
        end(event as ReactPointerEvent<HTMLDivElement>);
        current.pointerUp(event as ReactPointerEvent<HTMLDivElement>);
      },
    );
    pointerUp(handle, 11);
    stopUpIntercept();
    expect(releasePointerCapture).toHaveBeenCalledExactlyOnceWith(11);
    expect(handle).not.toHaveAttribute("data-dragging");
    expect(document.body.style.cursor).toBe("");
    expect(document.body.style.userSelect).toBe("");
  });

  it.each([
    ["pointer cancel", pointerCancel, 1],
    ["lost pointer capture", lostPointerCapture, 0],
  ] as const)(
    "ends a current drag once on %s and makes every later terminal event inert",
    (_, terminal, expectedReleases) => {
      const onResize = vi.fn();
      document.body.style.cursor = "wait";
      document.body.style.userSelect = "text";
      const { handle, stale } = captureFirstStrictHandlers({ onResize });
      pointerDown(handle, 12, 800, "pen");
      pointerMove(handle, 12, 730, "pen");
      terminal(handle, 12, "pen");
      pointerUp(handle, 12, "pen");
      pointerCancel(handle, 12, "pen");
      lostPointerCapture(handle, 12, "pen");

      expect(onResize).toHaveBeenCalledExactlyOnceWith(410);
      expect(releasePointerCapture).toHaveBeenCalledTimes(expectedReleases);
      expect(handle).not.toHaveAttribute("data-dragging");
      expect(document.body.style.cursor).toBe("wait");
      expect(document.body.style.userSelect).toBe("text");

      const replacement = currentHandle();
      const stop = intercept<HandleKeyboard>(
        replacement,
        "onKeyDown",
        (current, event) => {
          stale.keyDown(event as ReactKeyboardEvent<HTMLDivElement>);
          current(event as ReactKeyboardEvent<HTMLDivElement>);
        },
      );
      fireEvent.keyDown(replacement, { key: "ArrowLeft" });
      stop();
      expect(onResize).toHaveBeenLastCalledWith(356);
    },
  );

  it("freezes accepted drag geometry, callbacks, and range until the exact drag retires", () => {
    const oldResize = vi.fn();
    const newResize = vi.fn();
    const oldReset = vi.fn();
    const newReset = vi.fn();
    const view = strictView({
      width: 340,
      min: 280,
      max: 400,
      onResize: oldResize,
      onReset: oldReset,
    });
    const handle = currentHandle(view.host);
    pointerDown(handle, 19, 800);

    renderStrict(view.root, {
      width: 600,
      min: 500,
      max: 620,
      onResize: newResize,
      onReset: newReset,
    });
    expect(handle).toHaveAttribute("aria-valuenow", "340");
    pointerMove(handle, 19, 700);
    expect(oldResize).toHaveBeenCalledExactlyOnceWith(400);
    expect(newResize).not.toHaveBeenCalled();
    pointerUp(handle, 19);

    const current = currentHandle(view.host);
    expect(current).toBe(handle);
    expect(current).toHaveAttribute("aria-valuenow", "600");
    fireEvent.keyDown(current, { key: "ArrowLeft" });
    fireEvent.keyDown(current, { key: "Enter" });
    expect(newResize).toHaveBeenCalledExactlyOnceWith(616);
    expect(newReset).toHaveBeenCalledOnce();
    expect(oldReset).not.toHaveBeenCalled();
  });

  it.each(["handle", "line", "both"] as const)(
    "creates a distinct successor after an exact %s callback-ref replay",
    (part) => {
      const onResize = vi.fn();
      const view = strictView({ onResize });
      const handle = currentHandle(view.host);
      const line = currentLine(handle);
      const stale = handlers(handle);
      const handleRef = reactRef(handle);
      const lineRef = reactRef(line);

      act(() => {
        if (part === "handle" || part === "both") handleRef(null);
        if (part === "line" || part === "both") lineRef(null);
        if (part === "handle" || part === "both") handleRef(handle);
        if (part === "line" || part === "both") lineRef(line);
      });

      const current = handlers(handle);
      expect(current.keyDown).not.toBe(stale.keyDown);
      const stop = intercept<HandleKeyboard>(
        handle,
        "onKeyDown",
        (next, event) => {
          stale.keyDown(event as ReactKeyboardEvent<HTMLDivElement>);
          next(event as ReactKeyboardEvent<HTMLDivElement>);
          stale.keyDown(event as ReactKeyboardEvent<HTMLDivElement>);
        },
      );
      fireEvent.keyDown(handle, { key: "ArrowLeft" });
      stop();
      expect(onResize).toHaveBeenCalledExactlyOnceWith(356);
    },
  );

  it("rejects restored DOM mutation and then admits a clean fresh publication", async () => {
    const onResize = vi.fn();
    const view = strictView({ onResize });
    const handle = currentHandle(view.host);
    const stale = handlers(handle);
    handle.setAttribute("aria-label", "Changed");
    handle.setAttribute("aria-label", "Resize panel");
    await flushMutations();

    fireEvent.keyDown(handle, { key: "ArrowLeft" });
    expect(onResize).not.toHaveBeenCalled();

    renderStrict(view.root, { onResize, boundary: 2 });
    const current = currentHandle(view.host);
    expect(handlers(current).keyDown).not.toBe(stale.keyDown);
    fireEvent.keyDown(current, { key: "ArrowLeft" });
    expect(onResize).toHaveBeenCalledExactlyOnceWith(356);
  });

  it.each(["parent", "higher ancestor"] as const)(
    "permanently retires an owner after %s detach and exact reinsertion",
    async (level) => {
      const onResize = vi.fn();
      const view = strictView({ onResize });
      const handle = currentHandle(view.host);
      const stale = handlers(handle);
      const target = level === "parent"
        ? handle.parentElement
        : handle.parentElement?.parentElement;
      const parent = target?.parentNode;
      const next = target?.nextSibling ?? null;
      if (!target || !parent) throw new Error("Expected a connected ancestor");
      parent.removeChild(target);
      parent.insertBefore(target, next);
      await flushMutations();

      fireEvent.keyDown(handle, { key: "ArrowLeft" });
      expect(onResize).not.toHaveBeenCalled();

      renderStrict(view.root, {
        instance: `fresh-${level}`,
        onResize,
      });
      const current = currentHandle(view.host);
      expect(handlers(current).keyDown).not.toBe(stale.keyDown);
      fireEvent.keyDown(current, { key: "ArrowLeft" });
      expect(onResize).toHaveBeenCalledExactlyOnceWith(356);
    },
  );

  it("keeps a publication eligible through nonadjacent ancestor churn", async () => {
    const onResize = vi.fn();
    const view = strictView({ onResize }, true);
    const handle = currentHandle(view.host);
    const before = handlers(handle);
    const churn = document.createElement("div");
    document.body.append(churn);
    hosts.add(churn);
    await flushMutations();

    expect(handlers(handle).keyDown).toBe(before.keyDown);
    fireEvent.keyDown(handle, { key: "ArrowLeft" });
    expect(onResize).toHaveBeenCalledExactlyOnceWith(356);
  });

  it("retires A at replacement before B starts and isolates late A events from B ownership", () => {
    const oldResize = vi.fn();
    const currentResize = vi.fn();
    document.body.style.cursor = "help";
    document.body.style.userSelect = "text";
    const view = strictView({ instance: "a", onResize: oldResize });
    const oldHandle = currentHandle(view.host);
    const stale = handlers(oldHandle);
    pointerDown(oldHandle, 27, 800);

    renderStrict(view.root, {
      instance: "b",
      width: 500,
      onResize: currentResize,
    });
    const current = currentHandle(view.host);
    expect(current).not.toBe(oldHandle);
    expect(releasePointerCapture).toHaveBeenCalledExactlyOnceWith(27);
    expect(document.body.style.cursor).toBe("help");
    expect(document.body.style.userSelect).toBe("text");

    pointerDown(current, 27, 800, "touch");
    const stopMove = intercept<HandlePointer>(
      current,
      "onPointerMove",
      (move, event) => {
        stale.pointerMove(event as ReactPointerEvent<HTMLDivElement>);
        move(event as ReactPointerEvent<HTMLDivElement>);
      },
    );
    pointerMove(current, 27, 750, "touch");
    stopMove();
    expect(oldResize).not.toHaveBeenCalled();
    expect(currentResize).toHaveBeenCalledExactlyOnceWith(550);
    expect(current).toHaveAttribute("data-dragging", "true");

    const stopEnd = intercept<HandlePointer>(
      current,
      "onPointerUp",
      (end, event) => {
        stale.pointerUp(event as ReactPointerEvent<HTMLDivElement>);
        stale.pointerCancel(event as ReactPointerEvent<HTMLDivElement>);
        stale.lostPointerCapture(event as ReactPointerEvent<HTMLDivElement>);
        end(event as ReactPointerEvent<HTMLDivElement>);
      },
    );
    pointerUp(current, 27, "touch");
    stopEnd();
    expect(releasePointerCapture).toHaveBeenCalledTimes(2);
    expect(document.body.style.cursor).toBe("help");
    expect(document.body.style.userSelect).toBe("text");
  });

  it.each([
    {
      changed: "cursor",
      mutate: () => {
        document.body.style.cursor = "wait";
      },
      afterRetire: ["wait", "text"],
    },
    {
      changed: "userSelect",
      mutate: () => {
        document.body.style.userSelect = "contain";
      },
      afterRetire: ["help", "contain"],
    },
  ] as const)(
    "preserves external $changed ownership while restoring the other body style",
    async ({ mutate, afterRetire }) => {
      const oldResize = vi.fn();
      const currentResize = vi.fn();
      document.body.style.cursor = "help";
      document.body.style.userSelect = "text";
      const view = strictView({ instance: "a", onResize: oldResize });
      const oldHandle = currentHandle(view.host);
      const stale = handlers(oldHandle);
      pointerDown(oldHandle, 29, 800);

      mutate();
      await flushMutations();
      expect(releasePointerCapture).toHaveBeenCalledExactlyOnceWith(29);
      expect(releasePointerCapture.mock.contexts[0]).toBe(oldHandle);
      expect(document.body.style.cursor).toBe(afterRetire[0]);
      expect(document.body.style.userSelect).toBe(afterRetire[1]);
      expect(oldHandle).not.toHaveAttribute("data-dragging");

      renderStrict(view.root, {
        instance: "b",
        width: 500,
        onResize: currentResize,
      });
      const current = currentHandle(view.host);
      pointerDown(current, 29, 800, "touch");
      const stopMove = intercept<HandlePointer>(
        current,
        "onPointerMove",
        (move, event) => {
          stale.pointerMove(event as ReactPointerEvent<HTMLDivElement>);
          move(event as ReactPointerEvent<HTMLDivElement>);
        },
      );
      pointerMove(current, 29, 760, "touch");
      stopMove();
      expect(oldResize).not.toHaveBeenCalled();
      expect(currentResize).toHaveBeenCalledExactlyOnceWith(540);
      expect(current).toHaveAttribute("data-dragging", "true");
      expect(document.body.style.cursor).toBe("col-resize");
      expect(document.body.style.userSelect).toBe("none");

      const stopEnd = intercept<HandlePointer>(
        current,
        "onPointerUp",
        (end, event) => {
          stale.pointerUp(event as ReactPointerEvent<HTMLDivElement>);
          stale.pointerCancel(event as ReactPointerEvent<HTMLDivElement>);
          stale.lostPointerCapture(event as ReactPointerEvent<HTMLDivElement>);
          expect(current).toHaveAttribute("data-dragging", "true");
          expect(document.body.style.cursor).toBe("col-resize");
          expect(document.body.style.userSelect).toBe("none");
          end(event as ReactPointerEvent<HTMLDivElement>);
        },
      );
      pointerUp(current, 29, "touch");
      stopEnd();
      expect(releasePointerCapture).toHaveBeenCalledTimes(2);
      expect(releasePointerCapture.mock.contexts[1]).toBe(current);
      expect(document.body.style.cursor).toBe(afterRetire[0]);
      expect(document.body.style.userSelect).toBe(afterRetire[1]);
    },
  );

  it("restores exact body styles when capture and release throw", () => {
    document.body.style.cursor = "crosshair";
    document.body.style.userSelect = "all";
    const firstResize = vi.fn();
    setPointerCapture.mockImplementationOnce(() => {
      throw new Error("capture failed");
    });
    const first = strictView({ onResize: firstResize });
    const firstHandle = currentHandle(first.host);
    pointerDown(firstHandle, 31, 700);
    pointerMove(firstHandle, 31, 680);
    pointerUp(firstHandle, 31);
    expect(firstResize).toHaveBeenCalledExactlyOnceWith(360);
    expect(releasePointerCapture).not.toHaveBeenCalled();
    expect(document.body.style.cursor).toBe("crosshair");
    expect(document.body.style.userSelect).toBe("all");

    renderStrict(first.root, { instance: "release-throws" });
    releasePointerCapture.mockImplementationOnce(() => {
      throw new Error("release failed");
    });
    const secondHandle = currentHandle(first.host);
    pointerDown(secondHandle, 32, 700);
    pointerUp(secondHandle, 32);
    expect(releasePointerCapture).toHaveBeenCalledExactlyOnceWith(32);
    expect(document.body.style.cursor).toBe("crosshair");
    expect(document.body.style.userSelect).toBe("all");
  });

  it("releases only its own capture and styles on active unmount", () => {
    document.body.style.cursor = "zoom-in";
    document.body.style.userSelect = "contain";
    const view = strictView();
    const handle = currentHandle(view.host);
    pointerDown(handle, 39, 900);
    act(() => view.root.unmount());
    roots.delete(view.root);

    expect(releasePointerCapture).toHaveBeenCalledExactlyOnceWith(39);
    expect(releasePointerCapture.mock.contexts[0]).toBe(handle);
    expect(document.body.style.cursor).toBe("zoom-in");
    expect(document.body.style.userSelect).toBe("contain");
  });

  it("rejects crossed pointer identities, types, buttons, realms, and reused native events", () => {
    const onResize = vi.fn();
    const iframe = document.createElement("iframe");
    document.body.append(iframe);
    hosts.add(iframe);
    const foreignWindow = iframe.contentWindow as
      | (Window & typeof globalThis)
      | null;
    if (!foreignWindow) throw new Error("Expected an iframe realm");
    const view = strictView({ onResize });
    const handle = currentHandle(view.host);
    fireEvent.pointerDown(handle, {
      pointerId: 1,
      pointerType: "mouse",
      clientX: 800,
      button: 2,
      buttons: 2,
      isPrimary: true,
    });
    pointerDown(handle, 4, 800, "mouse");
    pointerMove(handle, 5, 700, "mouse");
    pointerMove(handle, 4, 700, "pen");
    fireEvent.pointerMove(handle, {
      pointerId: 4,
      pointerType: "mouse",
      clientX: 700,
      button: -1,
      buttons: 0,
      isPrimary: true,
    });
    expect(onResize).not.toHaveBeenCalled();

    const stop = intercept<HandlePointer>(
      handle,
      "onPointerMove",
      (move, event) => {
        const fabricated = {
          ...(event as object),
          nativeEvent: new foreignWindow.PointerEvent("pointermove", {
            bubbles: true,
            composed: true,
            pointerId: 4,
            pointerType: "mouse",
            clientX: 700,
            button: -1,
            buttons: 1,
          }),
        } as ReactPointerEvent<HTMLDivElement>;
        move(fabricated);
        move(event as ReactPointerEvent<HTMLDivElement>);
        move(event as ReactPointerEvent<HTMLDivElement>);
      },
    );
    pointerMove(handle, 4, 760, "mouse");
    stop();
    expect(onResize).toHaveBeenCalledExactlyOnceWith(380);
    pointerUp(handle, 4);
  });

  it("claims keyboard and double-click wrappers and native events once before prevention or callbacks", () => {
    const onResize = vi.fn();
    const onReset = vi.fn();
    const { handle, stale } = captureFirstStrictHandlers({ onResize, onReset });
    const stopKey = intercept<HandleKeyboard>(
      handle,
      "onKeyDown",
      (current, event) => {
        const keyboardEvent = event as ReactKeyboardEvent<HTMLDivElement>;
        stale.keyDown(keyboardEvent);
        current({ ...(event as object) } as ReactKeyboardEvent<HTMLDivElement>);
        expect(keyboardEvent.defaultPrevented).toBe(false);
        current(keyboardEvent);
        current(keyboardEvent);
      },
    );
    fireEvent.keyDown(handle, { key: "ArrowLeft" });
    stopKey();
    expect(onResize).toHaveBeenCalledExactlyOnceWith(356);

    const stopDouble = intercept<HandleDoubleClick>(
      handle,
      "onDoubleClick",
      (current, event) => {
        const mouseEvent = event as ReactMouseEvent<HTMLDivElement>;
        stale.doubleClick(mouseEvent);
        current({ ...(event as object) } as ReactMouseEvent<HTMLDivElement>);
        current(mouseEvent);
        current(mouseEvent);
      },
    );
    doubleClick(handle);
    stopDouble();
    expect(onReset).toHaveBeenCalledOnce();
  });
});

describe("panel width helpers", () => {
  it("uses 720 px or 60% of the viewport without dropping below the minimum", () => {
    expect(panelMaxFor(1440)).toBe(PANEL_MAX);
    expect(panelMaxFor(1200)).toBe(PANEL_MAX);
    expect(panelMaxFor(1199)).toBe(719);
    expect(panelMaxFor(1024)).toBe(614);
    expect(panelMaxFor(100)).toBe(PANEL_MIN);
  });

  it("rounds, clamps, and parses stored whole-pixel widths", () => {
    expect(clampPanelWidth(339.6, PANEL_MIN, PANEL_MAX)).toBe(340);
    expect(clampPanelWidth(10, PANEL_MIN, PANEL_MAX)).toBe(PANEL_MIN);
    expect(clampPanelWidth(5000, PANEL_MIN, PANEL_MAX)).toBe(PANEL_MAX);
    expect(parseStoredPanelWidth("500")).toBe(500);
    expect(parseStoredPanelWidth(" 420 ")).toBe(420);
    for (const invalid of [null, "", "abc", "500.5", "-300", "1e3", "{}"]) {
      expect(parseStoredPanelWidth(invalid)).toBeNull();
    }
    expect(PANEL_BIG_STEP).toBe(64);
  });
});
