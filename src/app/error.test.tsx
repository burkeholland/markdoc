// @vitest-environment jsdom
import {
  StrictMode,
  createElement,
  useEffect,
  useLayoutEffect,
  type ComponentType,
  type ReactNode,
} from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

import AppError from "./error";
import GlobalError from "./global-error";

type BoundaryError = Error & { digest?: string };
interface BoundaryProps {
  error: BoundaryError;
  reset: () => void;
}

interface BoundaryDefinition {
  readonly name: string;
  readonly Component: ComponentType<BoundaryProps>;
}

interface DirectView {
  readonly host: HTMLDivElement;
  readonly root: Root;
}

type ElementRef<T extends HTMLElement> = (element: T | null) => void;

interface CapturedClick {
  readonly type: string;
  readonly currentTarget: EventTarget | null;
  readonly target: EventTarget | null;
  readonly nativeEvent: Event;
}

type ClickHandler = (event: CapturedClick) => void;

interface CapturedRetry {
  readonly actions: HTMLDivElement;
  readonly button: HTMLButtonElement;
  readonly click: ClickHandler;
  readonly actionsRef: ElementRef<HTMLDivElement>;
  readonly buttonRef: ElementRef<HTMLButtonElement>;
}

const BOUNDARIES: readonly BoundaryDefinition[] = [
  { name: "AppError", Component: AppError },
  { name: "GlobalError", Component: GlobalError },
];

const directViews: DirectView[] = [];

function reactProperty<T>(element: HTMLElement, name: string): T | undefined {
  const propsKey = Object.keys(element).find((key) => key.startsWith("__reactProps$"));
  if (!propsKey) throw new Error(`React props were not attached to ${element.tagName}`);
  const props = (element as unknown as Record<string, Record<string, unknown> | undefined>)[propsKey];
  return props?.[name] as T | undefined;
}

function reactHandler<T extends (...args: never[]) => unknown>(
  element: HTMLElement,
  name: string,
): T {
  const handler = reactProperty<T>(element, name);
  if (typeof handler !== "function") throw new Error(`${name} was not attached to ${element.tagName}`);
  return handler;
}

function reactRef<T extends HTMLElement>(element: HTMLElement): ElementRef<T> {
  const ref = reactProperty<ElementRef<T>>(element, "ref");
  if (typeof ref !== "function") throw new Error(`A callback ref was not attached to ${element.tagName}`);
  return ref;
}

function captureRetry(host: HTMLElement): CapturedRetry {
  const button = [...host.querySelectorAll("button")].find(
    (candidate) => candidate.textContent?.trim() === "Try again",
  );
  const actions = button?.parentElement;
  if (!(button instanceof HTMLButtonElement) || !(actions instanceof HTMLDivElement)) {
    throw new Error("The Retry action was not rendered");
  }
  return {
    actions,
    button,
    click: reactHandler<ClickHandler>(button, "onClick"),
    actionsRef: reactRef<HTMLDivElement>(actions),
    buttonRef: reactRef<HTMLButtonElement>(button),
  };
}

function nativeClick(target: EventTarget, ownerDocument: Document = document): MouseEvent {
  const MouseEventConstructor = ownerDocument.defaultView?.MouseEvent;
  if (!MouseEventConstructor) throw new Error("The owner document has no MouseEvent constructor");
  const event = new MouseEventConstructor("click", { bubbles: true });
  Object.defineProperty(event, "target", { configurable: true, value: target });
  return event;
}

function capturedClick(
  control: CapturedRetry,
  {
    type = "click",
    currentTarget = control.button,
    target = currentTarget,
    nativeTarget = target,
    nativeEvent,
  }: {
    type?: string;
    currentTarget?: EventTarget | null;
    target?: EventTarget | null;
    nativeTarget?: EventTarget | null;
    nativeEvent?: Event;
  } = {},
): CapturedClick {
  return {
    type,
    currentTarget,
    target,
    nativeEvent: nativeEvent ?? nativeClick(nativeTarget ?? control.button, control.button.ownerDocument),
  };
}

function renderDirect(node: ReactNode): DirectView {
  const host = document.createElement("div");
  document.body.append(host);
  const view = { host, root: createRoot(host) };
  directViews.push(view);
  act(() => view.root.render(node));
  return view;
}

function boundaryNode(
  definition: BoundaryDefinition,
  props: BoundaryProps,
  key?: string,
) {
  return createElement(definition.Component, { ...props, key });
}

function expectRejected(
  control: CapturedRetry,
  event: CapturedClick,
  reset: ReturnType<typeof vi.fn>,
  host: HTMLElement,
) {
  const activeElement = document.activeElement;
  const markup = host.innerHTML;
  act(() => control.click(event));
  expect(reset).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(activeElement);
  expect(host.innerHTML).toBe(markup);
}

function ParentBoundary({
  definition,
  boundaryProps,
  visit,
  mountKey,
  onLayout,
  onPassiveCleanup,
}: {
  definition: BoundaryDefinition;
  boundaryProps: BoundaryProps;
  visit: number;
  mountKey?: string;
  onLayout?: () => void;
  onPassiveCleanup?: () => void;
}) {
  useLayoutEffect(() => {
    onLayout?.();
  }, [onLayout, visit]);
  useEffect(
    () => () => {
      onPassiveCleanup?.();
    },
    [onPassiveCleanup, visit],
  );
  return boundaryNode(definition, boundaryProps, mountKey);
}

afterEach(() => {
  cleanup();
  for (const view of directViews.splice(0)) {
    act(() => view.root.unmount());
    view.host.remove();
  }
  vi.restoreAllMocks();
});

describe("error boundary presentation", () => {
  it("renders the route boundary copy, actions, and error details", () => {
    render(
      <AppError
        error={Object.assign(new Error("boom"), { digest: "abc123" })}
        reset={() => {}}
      />,
    );
    expect(screen.getByTestId("app-error")).toBeInTheDocument();
    expect(screen.getByText("Error")).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { level: 1, name: "Something went wrong" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toHaveAttribute("type", "button");
    expect(screen.getByRole("link", { name: "Back to your documents" })).toHaveAttribute("href", "/");
    expect(screen.getByTestId("app-error-digest")).toHaveTextContent("Reference: abc123");
    expect(screen.getByTestId("app-error").querySelector("pre")).toHaveTextContent("boom");
  });

  it("omits empty route-boundary error facts without changing the Details affordance", () => {
    render(<AppError error={new Error("")} reset={() => {}} />);
    expect(screen.queryByTestId("app-error-digest")).toBeNull();
    expect(screen.getByTestId("app-error").querySelector("pre")).toBeNull();
    expect(screen.getByText("Details")).toBeInTheDocument();
  });

  it("renders the root-layout boundary as a self-styled whole document", () => {
    const html = renderToStaticMarkup(
      <GlobalError
        error={Object.assign(new Error("boom"), { digest: "abc123" })}
        reset={() => {}}
      />,
    );
    expect(html).toContain('<html lang="en">');
    expect(html).toContain("Something went wrong");
    expect(html).toContain('data-testid="app-error"');
    expect(html).toMatch(/<button type="button"[^>]*>Try again<\/button>/);
    expect(html).toMatch(/<a href="\/"[^>]*>Back to your documents<\/a>/);
    expect(html).toContain("Reference: abc123");
    expect(html).toContain("boom");
    expect(html).toContain("prefers-color-scheme: dark");
    expect(html).not.toContain("class=");
  });
});

describe.each(BOUNDARIES)("$name Retry authority", (definition) => {
  it("lets the exact committed button invoke only its frozen reset once", () => {
    const currentRef: { value: CapturedRetry | null } = { value: null };
    const reset = vi.fn(() => {
      const current = currentRef.value;
      if (!current) throw new Error("The Retry control was not captured");
      current.click(capturedClick(current));
    });
    const view = renderDirect(boundaryNode(definition, { error: new Error("boom"), reset }));
    const current = captureRetry(view.host);
    currentRef.value = current;

    fireEvent.click(current.button);
    fireEvent.click(current.button);

    expect(reset).toHaveBeenCalledOnce();
  });

  it("rejects invalid controls, documents, descendants, state, and markup without consuming authority", () => {
    const reset = vi.fn();
    const view = renderDirect(boundaryNode(definition, { error: new Error("boom"), reset }));
    const current = captureRetry(view.host);
    const link = current.button.nextElementSibling;
    if (!(link instanceof HTMLAnchorElement)) throw new Error("The recovery link was not rendered");
    const focusOwner = document.createElement("button");
    const sibling = document.createElement("button");
    const detached = document.createElement("button");
    const iframe = document.createElement("iframe");
    document.body.append(focusOwner, sibling, iframe);
    const foreign = iframe.contentDocument?.createElement("button");
    if (!foreign || !iframe.contentDocument?.body) throw new Error("The foreign document was not created");
    iframe.contentDocument.body.append(foreign);
    focusOwner.focus();

    expectRejected(current, capturedClick(current, { currentTarget: sibling }), reset, view.host);
    expectRejected(current, capturedClick(current, { currentTarget: foreign }), reset, view.host);
    expectRejected(current, capturedClick(current, { currentTarget: detached }), reset, view.host);

    current.button.remove();
    expectRejected(current, capturedClick(current), reset, view.host);
    current.actions.insertBefore(current.button, link);

    const replacement = current.button.cloneNode(true);
    if (!(replacement instanceof HTMLButtonElement)) throw new Error("The replacement is not a button");
    current.actions.replaceChild(replacement, current.button);
    expectRejected(
      current,
      capturedClick(current, { currentTarget: replacement, target: replacement }),
      reset,
      view.host,
    );
    current.actions.replaceChild(current.button, replacement);

    const inserted = document.createElement("span");
    current.button.append(inserted);
    expectRejected(
      current,
      capturedClick(current, { target: inserted, nativeTarget: inserted }),
      reset,
      view.host,
    );
    inserted.remove();

    current.button.disabled = true;
    expectRejected(current, capturedClick(current), reset, view.host);
    current.button.disabled = false;

    current.button.setAttribute("aria-disabled", "true");
    expectRejected(current, capturedClick(current), reset, view.host);
    current.button.removeAttribute("aria-disabled");

    const buttonClass = current.button.getAttribute("class");
    current.button.className = `${buttonClass ?? ""} mutated`;
    expectRejected(current, capturedClick(current), reset, view.host);
    if (buttonClass === null) current.button.removeAttribute("class");
    else current.button.setAttribute("class", buttonClass);

    const href = link.getAttribute("href");
    link.setAttribute("href", "/mutated");
    expectRejected(current, capturedClick(current), reset, view.host);
    if (href === null) link.removeAttribute("href");
    else link.setAttribute("href", href);

    fireEvent.click(current.button);
    expect(reset).toHaveBeenCalledOnce();

    focusOwner.remove();
    sibling.remove();
    iframe.remove();
  });

  it("rejects forged, mismatched, wrong-source, and reused native events", () => {
    const resetA = vi.fn();
    const resetB = vi.fn();
    const error = new Error("boom");
    const view = renderDirect(boundaryNode(definition, { error, reset: resetA }));
    const stale = captureRetry(view.host);
    const sibling = document.createElement("button");
    document.body.append(sibling);

    expectRejected(
      stale,
      { ...capturedClick(stale), nativeEvent: new Event("click") },
      resetA,
      view.host,
    );
    expectRejected(
      stale,
      capturedClick(stale, { target: stale.button, nativeTarget: stale.actions }),
      resetA,
      view.host,
    );
    expectRejected(
      stale,
      capturedClick(stale, { currentTarget: sibling, target: stale.button }),
      resetA,
      view.host,
    );
    expectRejected(
      stale,
      capturedClick(stale, { type: "pointerdown" }),
      resetA,
      view.host,
    );

    const reusable = nativeClick(stale.button);
    expectRejected(
      stale,
      capturedClick(stale, {
        currentTarget: sibling,
        target: stale.button,
        nativeTarget: stale.button,
        nativeEvent: reusable,
      }),
      resetA,
      view.host,
    );
    act(() => stale.click(capturedClick(stale, { nativeEvent: reusable })));
    expect(resetA).toHaveBeenCalledOnce();

    act(() => view.root.render(boundaryNode(definition, { error, reset: resetB })));
    const current = captureRetry(view.host);
    expect(current.button).toBe(stale.button);
    expectRejected(
      current,
      capturedClick(current, { nativeEvent: reusable }),
      resetB,
      view.host,
    );
    fireEvent.click(current.button);
    expect(resetB).toHaveBeenCalledOnce();

    sibling.remove();
  });

  it.each(["error identity", "message", "digest", "reset"] as const)(
    "retires a same-element generation when its %s changes",
    (change) => {
      const resetA = vi.fn();
      const resetB = vi.fn();
      const errorA = Object.assign(new Error("first"), { digest: "digest-a" });
      const view = renderDirect(boundaryNode(definition, { error: errorA, reset: resetA }));
      const stale = captureRetry(view.host);
      let errorB: BoundaryError = errorA;
      let nextReset = resetA;
      if (change === "error identity") {
        errorB = Object.assign(new Error("first"), { digest: "digest-a" });
      } else if (change === "message") {
        errorA.message = "second";
      } else if (change === "digest") {
        errorA.digest = "digest-b";
      } else {
        nextReset = resetB;
      }

      act(() => view.root.render(boundaryNode(definition, { error: errorB, reset: nextReset })));
      const current = captureRetry(view.host);
      expect(current.button).toBe(stale.button);
      expectRejected(stale, capturedClick(stale), resetA, view.host);
      expect(resetB).not.toHaveBeenCalled();

      fireEvent.click(current.button);
      if (change === "reset") {
        expect(resetA).not.toHaveBeenCalled();
        expect(resetB).toHaveBeenCalledOnce();
      } else {
        expect(resetA).toHaveBeenCalledOnce();
        expect(resetB).not.toHaveBeenCalled();
      }
    },
  );

  it("re-proves mutable error facts immediately before claiming", () => {
    const reset = vi.fn();
    const error = Object.assign(new Error("original"), { digest: "digest" });
    const view = renderDirect(boundaryNode(definition, { error, reset }));
    const current = captureRetry(view.host);

    error.message = "mutated";
    expectRejected(current, capturedClick(current), reset, view.host);
    error.message = "original";
    error.digest = "mutated";
    expectRejected(current, capturedClick(current), reset, view.host);
    error.digest = "digest";

    fireEvent.click(current.button);
    expect(reset).toHaveBeenCalledOnce();
  });

  it("retires stale authority before parent layout and before passive cleanup", () => {
    const resetA = vi.fn();
    const resetB = vi.fn();
    let passiveCleanups = 0;
    const view = renderDirect(
      <ParentBoundary
        definition={definition}
        boundaryProps={{ error: new Error("first"), reset: resetA }}
        visit={0}
        onPassiveCleanup={() => passiveCleanups++}
      />,
    );
    const stale = captureRetry(view.host);

    act(() => {
      view.root.render(
        <ParentBoundary
          definition={definition}
          boundaryProps={{ error: new Error("second"), reset: resetB }}
          visit={1}
          onPassiveCleanup={() => passiveCleanups++}
          onLayout={() => {
            expect(passiveCleanups).toBe(0);
            const currentAtLayout = captureRetry(view.host);
            expect(currentAtLayout.button).toBe(stale.button);
            stale.click(capturedClick(stale, { currentTarget: currentAtLayout.button }));
          }}
        />,
      );
    });

    expect(passiveCleanups).toBe(1);
    expect(resetA).not.toHaveBeenCalled();
    expect(resetB).not.toHaveBeenCalled();
    fireEvent.click(captureRetry(view.host).button);
    expect(resetB).toHaveBeenCalledOnce();
  });

  it("isolates equal-looking remounts, detached controls, and late old refs", () => {
    const resetA = vi.fn();
    const resetB = vi.fn();
    const propsA = { error: new Error("same"), reset: resetA };
    const propsB = { error: new Error("same"), reset: resetB };
    const view = renderDirect(boundaryNode(definition, propsA, "a"));
    const stale = captureRetry(view.host);

    act(() => view.root.render(boundaryNode(definition, propsB, "b")));
    const current = captureRetry(view.host);
    expect(current.button).not.toBe(stale.button);
    expect(stale.button.isConnected).toBe(false);
    expectRejected(
      stale,
      capturedClick(stale, { currentTarget: current.button, target: current.button }),
      resetA,
      view.host,
    );
    expectRejected(
      current,
      capturedClick(current, { currentTarget: stale.button, target: stale.button }),
      resetB,
      view.host,
    );
    expectRejected(stale, capturedClick(stale), resetA, view.host);

    act(() => {
      stale.actionsRef(current.actions);
      stale.buttonRef(current.button);
      stale.actionsRef(null);
      stale.buttonRef(null);
    });

    fireEvent.click(current.button);
    expect(resetA).not.toHaveBeenCalled();
    expect(resetB).toHaveBeenCalledOnce();
  });

  it("keeps the committed control usable through Strict Mode ref and layout replays", () => {
    const reset = vi.fn();
    const view = renderDirect(
      <StrictMode>
        {boundaryNode(definition, { error: new Error("boom"), reset })}
      </StrictMode>,
    );

    fireEvent.click(captureRetry(view.host).button);
    expect(reset).toHaveBeenCalledOnce();
  });
});

describe("AppError and GlobalError isolation", () => {
  it("does not share authority, claims, or cleanup between boundaries", () => {
    const appReset = vi.fn();
    const globalReset = vi.fn();
    const appView = renderDirect(
      <AppError error={new Error("app")} reset={appReset} />,
    );
    const globalView = renderDirect(
      <GlobalError error={new Error("global")} reset={globalReset} />,
    );
    const app = captureRetry(appView.host);
    const global = captureRetry(globalView.host);

    expectRejected(
      app,
      capturedClick(app, { currentTarget: global.button, target: global.button }),
      appReset,
      appView.host,
    );
    expectRejected(
      global,
      capturedClick(global, { currentTarget: app.button, target: app.button }),
      globalReset,
      globalView.host,
    );
    fireEvent.click(app.button);
    act(() => {
      app.actionsRef(null);
      app.buttonRef(null);
    });

    fireEvent.click(global.button);
    expect(appReset).toHaveBeenCalledOnce();
    expect(globalReset).toHaveBeenCalledOnce();
  });
});
