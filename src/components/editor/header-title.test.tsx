// @vitest-environment jsdom
import {
  StrictMode,
  useEffect,
  useLayoutEffect,
  type ChangeEvent,
  type FocusEvent as ReactFocusEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type RefCallback,
} from "react";
import { createRoot, type Root } from "react-dom/client";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CollabSession } from "@/editor/collab/session";
import { TitleEditor } from "./header";

type TitleRole = CollabSession["role"];

class TitleSession {
  version = 0;
  private currentTitle: string;
  private readonly listeners = new Set<() => void>();
  onSetTitle: (() => void) | null = null;

  constructor(
    title: string,
    public role: TitleRole = "owner",
  ) {
    this.currentTitle = title;
  }

  get title() {
    return this.currentTitle;
  }

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  setTitle = vi.fn((title: string) => {
    this.onSetTitle?.();
    this.currentTitle = title;
    this.publish();
  });

  setExternalTitle(title: string) {
    this.currentTitle = title;
    this.publish();
  }

  mutateTitle(title: string) {
    this.currentTitle = title;
  }

  mutateRole(role: TitleRole) {
    this.role = role;
  }

  replaceSetter() {
    this.setTitle = vi.fn((title: string) => {
      this.onSetTitle?.();
      this.currentTitle = title;
      this.publish();
    });
  }

  asCollabSession() {
    return this as unknown as CollabSession;
  }

  private publish() {
    this.version++;
    for (const listener of this.listeners) listener();
  }
}

function TitleMount({
  session,
  fallback,
  compact,
  onPassiveCleanup,
}: {
  session: TitleSession;
  fallback: string;
  compact?: boolean;
  onPassiveCleanup?: () => void;
}) {
  useEffect(() => onPassiveCleanup, [onPassiveCleanup]);
  return <TitleEditor session={session.asCollabSession()} fallback={fallback} compact={compact} />;
}

function TitleBoundary({
  session,
  fallback,
  compact,
  present = true,
  instance = "title",
  revision = 0,
  boundary = 0,
  onBoundary,
  onPassiveCleanup,
}: {
  session: TitleSession;
  fallback: string;
  compact?: boolean;
  present?: boolean;
  instance?: string;
  revision?: number;
  boundary?: number;
  onBoundary?: () => void;
  onPassiveCleanup?: () => void;
}) {
  void revision;
  useLayoutEffect(() => {
    if (boundary > 0) onBoundary?.();
  }, [boundary, onBoundary]);
  return present ? (
    <TitleMount
      key={instance}
      session={session}
      fallback={fallback}
      compact={compact}
      onPassiveCleanup={onPassiveCleanup}
    />
  ) : null;
}

interface ReactFiber {
  ref?: unknown;
}

function reactProperty<T>(element: Element, name: string): T | undefined {
  const propsKey = Object.keys(element).find((key) => key.startsWith("__reactProps$"));
  if (!propsKey) throw new Error(`React props were not attached while capturing ${name}`);
  const props = (element as unknown as Record<string, Record<string, unknown> | undefined>)[propsKey];
  return props?.[name] as T | undefined;
}

function reactHandler<T extends (...args: never[]) => unknown>(element: Element, name: string): T {
  const handler = reactProperty<T>(element, name);
  if (typeof handler !== "function") throw new Error(`${name} was not attached`);
  return handler;
}

function reactRef<T extends Element>(element: T): RefCallback<T> {
  const direct = reactProperty<RefCallback<T>>(element, "ref");
  if (typeof direct === "function") return direct;
  const fiberKey = Object.keys(element).find((key) => key.startsWith("__reactFiber$"));
  if (!fiberKey) throw new Error("React fiber was not attached while capturing ref");
  const fiber = (element as unknown as Record<string, ReactFiber>)[fiberKey];
  if (typeof fiber.ref !== "function") throw new Error("A callback ref was not attached");
  return fiber.ref as RefCallback<T>;
}

type ClickHandler = (event: ReactMouseEvent<HTMLButtonElement>) => void;
type ChangeHandler = (event: ChangeEvent<HTMLInputElement>) => void;
type BlurHandler = (event: ReactFocusEvent<HTMLInputElement>) => void;
type KeyHandler = (event: ReactKeyboardEvent<HTMLInputElement>) => void;

interface DisplayControl {
  button: HTMLButtonElement;
  title: HTMLSpanElement;
  icon: SVGSVGElement | null;
  click: ClickHandler;
  buttonRef: RefCallback<HTMLButtonElement>;
  titleRef: RefCallback<HTMLSpanElement>;
  iconRef: RefCallback<SVGSVGElement> | null;
}

interface InputControl {
  input: HTMLInputElement;
  change: ChangeHandler;
  blur: BlurHandler;
  keydown: KeyHandler;
  ref: RefCallback<HTMLInputElement>;
}

function captureDisplay(root: ParentNode = document): DisplayControl {
  const button = root.querySelector('[data-testid="title"]');
  if (!(button instanceof HTMLButtonElement)) throw new Error("The title button was not rendered");
  const title = button.firstElementChild;
  const icon = button.children.item(1);
  if (!(title instanceof HTMLSpanElement) || (icon !== null && !(icon instanceof SVGSVGElement))) {
    throw new Error("The title presentation was incomplete");
  }
  return {
    button,
    title,
    icon,
    click: reactHandler(button, "onClick"),
    buttonRef: reactRef(button),
    titleRef: reactRef(title),
    iconRef: icon ? reactRef(icon) : null,
  };
}

function captureInput(root: ParentNode = document): InputControl {
  const input = root.querySelector('[data-testid="title-input"]');
  if (!(input instanceof HTMLInputElement)) throw new Error("The title input was not rendered");
  return {
    input,
    change: reactHandler(input, "onChange"),
    blur: reactHandler(input, "onBlur"),
    keydown: reactHandler(input, "onKeyDown"),
    ref: reactRef(input),
  };
}

function nativeClick(
  button: HTMLButtonElement,
  {
    type = "click",
    target = button,
    nativeDocument = button.ownerDocument,
    mouseButton = 0,
  }: {
    type?: string;
    target?: EventTarget | null;
    nativeDocument?: Document;
    mouseButton?: number;
  } = {},
) {
  const MouseEventConstructor = nativeDocument.defaultView?.MouseEvent;
  if (!MouseEventConstructor) throw new Error("The click source has no owner-document MouseEvent");
  const event = new MouseEventConstructor(type, { bubbles: true, cancelable: true, button: mouseButton });
  Object.defineProperty(event, "target", { configurable: true, value: target });
  return event;
}

function directClick(
  control: DisplayControl,
  {
    currentTarget = control.button,
    target = currentTarget,
    type = "click",
    nativeTarget = target,
    nativeEvent = nativeClick(control.button, { target: nativeTarget }),
    defaultPrevented = false,
  }: {
    currentTarget?: EventTarget | null;
    target?: EventTarget | null;
    type?: string;
    nativeTarget?: EventTarget | null;
    nativeEvent?: Event;
    defaultPrevented?: boolean;
  } = {},
) {
  control.click({
    type,
    currentTarget,
    target,
    nativeEvent,
    defaultPrevented,
  } as unknown as ReactMouseEvent<HTMLButtonElement>);
}

function nativeInput(input: HTMLInputElement, type = "input", target: EventTarget | null = input) {
  const EventConstructor = input.ownerDocument.defaultView?.Event;
  if (!EventConstructor) throw new Error("The input has no owner-document Event");
  const event = new EventConstructor(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "target", { configurable: true, value: target });
  return event;
}

function directChange(
  control: InputControl,
  value: string,
  {
    currentTarget = control.input,
    target = currentTarget,
    type = "change",
    nativeTarget = target,
    nativeEvent = nativeInput(control.input, "input", nativeTarget),
    defaultPrevented = false,
    updateValue = true,
  }: {
    currentTarget?: EventTarget | null;
    target?: EventTarget | null;
    type?: string;
    nativeTarget?: EventTarget | null;
    nativeEvent?: Event;
    defaultPrevented?: boolean;
    updateValue?: boolean;
  } = {},
) {
  if (updateValue) control.input.value = value;
  control.change({
    type,
    currentTarget,
    target,
    nativeEvent,
    defaultPrevented,
  } as unknown as ChangeEvent<HTMLInputElement>);
}

function nativeFocus(input: HTMLInputElement, type = "focusout", target: EventTarget | null = input) {
  const FocusEventConstructor = input.ownerDocument.defaultView?.FocusEvent;
  if (!FocusEventConstructor) throw new Error("The input has no owner-document FocusEvent");
  const event = new FocusEventConstructor(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "target", { configurable: true, value: target });
  return event;
}

function directBlur(
  control: InputControl,
  {
    currentTarget = control.input,
    target = currentTarget,
    type = "blur",
    nativeTarget = target,
    nativeEvent = nativeFocus(control.input, "focusout", nativeTarget),
    defaultPrevented = false,
  }: {
    currentTarget?: EventTarget | null;
    target?: EventTarget | null;
    type?: string;
    nativeTarget?: EventTarget | null;
    nativeEvent?: Event;
    defaultPrevented?: boolean;
  } = {},
) {
  control.blur({
    type,
    currentTarget,
    target,
    nativeEvent,
    defaultPrevented,
  } as unknown as ReactFocusEvent<HTMLInputElement>);
}

function nativeKey(
  input: HTMLInputElement,
  key: string,
  {
    type = "keydown",
    target = input,
    ctrlKey = false,
    repeat = false,
  }: {
    type?: string;
    target?: EventTarget | null;
    ctrlKey?: boolean;
    repeat?: boolean;
  } = {},
) {
  const KeyboardEventConstructor = input.ownerDocument.defaultView?.KeyboardEvent;
  if (!KeyboardEventConstructor) throw new Error("The input has no owner-document KeyboardEvent");
  const event = new KeyboardEventConstructor(type, { bubbles: true, cancelable: true, key, ctrlKey, repeat });
  Object.defineProperty(event, "target", { configurable: true, value: target });
  return event;
}

function directKey(
  control: InputControl,
  key: string,
  {
    currentTarget = control.input,
    target = currentTarget,
    type = "keydown",
    nativeTarget = target,
    nativeKeyValue = key,
    nativeType = "keydown",
    nativeEvent = nativeKey(control.input, nativeKeyValue, { type: nativeType, target: nativeTarget }),
    defaultPrevented = false,
    ctrlKey = false,
    repeat = false,
  }: {
    currentTarget?: EventTarget | null;
    target?: EventTarget | null;
    type?: string;
    nativeTarget?: EventTarget | null;
    nativeKeyValue?: string;
    nativeType?: string;
    nativeEvent?: Event;
    defaultPrevented?: boolean;
    ctrlKey?: boolean;
    repeat?: boolean;
  } = {},
) {
  control.keydown({
    key,
    type,
    currentTarget,
    target,
    nativeEvent,
    defaultPrevented,
    altKey: false,
    ctrlKey,
    metaKey: false,
    shiftKey: false,
    repeat,
  } as unknown as ReactKeyboardEvent<HTMLInputElement>);
}

const roots = new Set<Root>();

function createDirectTitle(props: React.ComponentProps<typeof TitleBoundary>) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.add(root);
  act(() => root.render(<TitleBoundary {...props} />));
  return { host, root };
}

afterEach(() => {
  cleanup();
  for (const root of roots) act(() => root.unmount());
  roots.clear();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("TitleEditor exact presentation", () => {
  it("preserves fallback, compact, role, labels, classes, and live browser-title subscription", async () => {
    const viewer = new TitleSession("", "viewer");
    const view = render(<TitleEditor session={viewer.asCollabSession()} fallback="Fallback title" />);

    const readonly = captureDisplay();
    expect(readonly.button).toHaveAttribute("title", "Fallback title");
    expect(readonly.button).toHaveClass("group", "text-left");
    expect(readonly.title).toHaveTextContent("Fallback title");
    expect(readonly.title).toHaveClass("doc-title", "md:text-[22px]");
    expect(readonly.icon).toBeNull();
    fireEvent.click(readonly.button);
    expect(screen.queryByTestId("title-input")).toBeNull();
    await waitFor(() => expect(document.title).toBe("Fallback title · Markdoc"));

    act(() => viewer.setExternalTitle("Live viewer title"));
    expect(screen.getByTestId("title")).toHaveTextContent("Live viewer title");
    await waitFor(() => expect(document.title).toBe("Live viewer title · Markdoc"));

    const editor = new TitleSession("Compact editor", "editor");
    view.rerender(<TitleEditor session={editor.asCollabSession()} fallback="Unused" compact />);
    const compact = captureDisplay();
    expect(compact.button).toHaveAttribute("title", "Rename");
    expect(compact.button).toHaveClass("hover:bg-surface-3");
    expect(compact.title).toHaveClass("text-lg");
    expect(compact.title).not.toHaveClass("md:text-[22px]");
    expect(compact.icon).toBeNull();
  });

  it("focuses and selects the exact input, trims one Enter commit, and ignores its later blur", () => {
    const session = new TitleSession("Initial title");
    const focus = vi.spyOn(HTMLInputElement.prototype, "focus");
    const select = vi.spyOn(HTMLInputElement.prototype, "select");
    render(<TitleEditor session={session.asCollabSession()} fallback="Fallback" />);
    const display = captureDisplay();
    const iconTarget = display.icon?.firstElementChild ?? display.title;

    fireEvent.click(iconTarget);
    const input = captureInput();
    expect(input.input).toHaveFocus();
    expect(input.input.selectionStart).toBe(0);
    expect(input.input.selectionEnd).toBe("Initial title".length);
    expect(focus).toHaveBeenCalledTimes(1);
    expect(select).toHaveBeenCalledTimes(1);

    fireEvent.change(input.input, { target: { value: "  Renamed title  " } });
    const changed = captureInput();
    const staleBlur = input.blur;
    fireEvent.keyDown(changed.input, { key: "Enter" });
    expect(session.setTitle).toHaveBeenCalledExactlyOnceWith("Renamed title");
    expect(screen.getByTestId("title")).toHaveTextContent("Renamed title");

    act(() => staleBlur({
      type: "blur",
      currentTarget: input.input,
      target: input.input,
      nativeEvent: nativeFocus(input.input),
      defaultPrevented: false,
    } as unknown as ReactFocusEvent<HTMLInputElement>));
    expect(session.setTitle).toHaveBeenCalledTimes(1);
    expect(focus).toHaveBeenCalledTimes(1);
    expect(select).toHaveBeenCalledTimes(1);
  });

  it("cancels Escape without committing and keeps blank, unchanged, trimmed, and blur behavior", () => {
    const session = new TitleSession("Original");
    const view = render(<TitleEditor session={session.asCollabSession()} fallback="Fallback" />);

    fireEvent.click(screen.getByTestId("title"));
    const escaped = captureInput();
    fireEvent.change(escaped.input, { target: { value: "Discarded" } });
    const changed = captureInput();
    fireEvent.keyDown(changed.input, { key: "Escape" });
    act(() => directBlur(changed));
    expect(session.setTitle).not.toHaveBeenCalled();
    expect(screen.getByTestId("title")).toHaveTextContent("Original");

    for (const value of ["   ", " Original "]) {
      fireEvent.click(screen.getByTestId("title"));
      const input = captureInput();
      fireEvent.change(input.input, { target: { value } });
      fireEvent.blur(screen.getByTestId("title-input"));
      expect(session.setTitle).not.toHaveBeenCalled();
    }

    fireEvent.click(screen.getByTestId("title"));
    const input = captureInput();
    fireEvent.change(input.input, { target: { value: "  Blur commit  " } });
    fireEvent.blur(screen.getByTestId("title-input"));
    expect(session.setTitle).toHaveBeenCalledExactlyOnceWith("Blur commit");
    expect(screen.getByTestId("title")).toHaveTextContent("Blur commit");

    view.rerender(<TitleEditor session={session.asCollabSession()} fallback="Fallback" />);
    expect(screen.getByTestId("title")).toHaveTextContent("Blur commit");
  });

  it("rejects sibling, foreign, detached, disabled, replacement, inserted, crossed, and fabricated Rename sources", () => {
    const first = new TitleSession("Equal title");
    const second = new TitleSession("Equal title");
    render(
      <>
        <div data-testid="first-title"><TitleEditor session={first.asCollabSession()} fallback="Fallback" /></div>
        <div data-testid="second-title"><TitleEditor session={second.asCollabSession()} fallback="Fallback" /></div>
      </>,
    );
    const firstRoot = screen.getByTestId("first-title");
    const secondRoot = screen.getByTestId("second-title");
    const a = captureDisplay(firstRoot);
    const b = captureDisplay(secondRoot);
    const sibling = document.createElement("span");
    const detached = document.createElement("button");
    document.body.append(sibling);
    const frame = document.createElement("iframe");
    document.body.append(frame);
    const foreignDocument = frame.contentDocument;
    if (!foreignDocument) throw new Error("The foreign document was not created");
    const foreign = foreignDocument.createElement("button");
    foreignDocument.body.append(foreign);
    const replacement = b.button.cloneNode(true);
    if (!(replacement instanceof HTMLButtonElement)) throw new Error("Expected a button replacement");
    const parent = b.button.parentElement;
    if (!parent) throw new Error("The title button has no parent");
    const fabricated = new Event("click");
    Object.defineProperty(fabricated, "target", { configurable: true, value: b.button });

    act(() => {
      directClick(a, { currentTarget: b.button, target: b.button });
      directClick(b, { currentTarget: a.button, target: a.button });
      directClick(b, { currentTarget: detached, target: detached });
      directClick(b, { currentTarget: sibling, target: sibling });
      directClick(b, { currentTarget: foreign, target: foreign });
      directClick(b, { nativeEvent: fabricated });
      directClick(b, { type: "pointerdown" });
      directClick(b, { nativeTarget: sibling });
      directClick(b, { nativeEvent: nativeClick(b.button, { mouseButton: 1 }) });
      b.button.disabled = true;
      directClick(b);
      b.button.disabled = false;
      b.button.setAttribute("aria-disabled", "true");
      directClick(b);
      b.button.removeAttribute("aria-disabled");
    });

    const inserted = document.createElement("span");
    b.button.append(inserted);
    act(() => directClick(b, { target: inserted }));
    inserted.remove();
    parent.replaceChild(replacement, b.button);
    act(() => {
      directClick(b);
      directClick(b, { currentTarget: replacement, target: replacement });
    });
    parent.replaceChild(b.button, replacement);

    expect(firstRoot.querySelector('[data-testid="title-input"]')).toBeNull();
    expect(secondRoot.querySelector('[data-testid="title-input"]')).toBeNull();
    const accepted = nativeClick(b.button);
    act(() => {
      directClick(b, { nativeEvent: accepted });
      directClick(b, { nativeEvent: accepted });
    });
    expect(firstRoot.querySelector('[data-testid="title-input"]')).toBeNull();
    expect(secondRoot.querySelectorAll('[data-testid="title-input"]')).toHaveLength(1);
    expect(first.setTitle).not.toHaveBeenCalled();
    expect(second.setTitle).not.toHaveBeenCalled();
  });

  it.each([
    "same render facts",
    "session",
    "fallback",
    "title",
    "role",
    "compact",
    "setter",
  ] as const)("retires %s before parent layout and leaves only the current same-looking button usable", (transition) => {
    const original = new TitleSession(transition === "fallback" ? "" : "Same title");
    let currentSession = original;
    let fallback = transition === "fallback" ? "Same title" : "Fallback";
    let compact = false;
    let revision = 0;
    const direct = createDirectTitle({ session: currentSession, fallback, compact, revision });
    const stale = captureDisplay(direct.host);

    if (transition === "session") currentSession = new TitleSession("Same title");
    if (transition === "fallback") fallback = "Changed fallback";
    if (transition === "title") original.mutateTitle("Changed title");
    if (transition === "role") original.mutateRole("editor");
    if (transition === "compact") compact = true;
    if (transition === "setter") original.replaceSetter();
    revision++;
    let atBoundary!: DisplayControl;
    act(() => direct.root.render(
      <TitleBoundary
        session={currentSession}
        fallback={fallback}
        compact={compact}
        revision={revision}
        boundary={revision}
        onBoundary={() => {
          atBoundary = captureDisplay(direct.host);
          directClick(stale, { currentTarget: atBoundary.button, target: atBoundary.button });
          expect(direct.host.querySelector('[data-testid="title-input"]')).toBeNull();
        }}
      />,
    ));

    expect(atBoundary.button).toBe(stale.button);
    act(() => directClick(atBoundary));
    expect(direct.host.querySelectorAll('[data-testid="title-input"]')).toHaveLength(1);
  });

  it("retires draft and input replacements while preserving the current input and exact focus owner", () => {
    const session = new TitleSession("Draft owner");
    const focus = vi.spyOn(HTMLInputElement.prototype, "focus");
    const select = vi.spyOn(HTMLInputElement.prototype, "select");
    const direct = createDirectTitle({ session, fallback: "Fallback" });
    act(() => directClick(captureDisplay(direct.host)));
    const stale = captureInput(direct.host);
    expect(focus).toHaveBeenCalledTimes(1);
    expect(select).toHaveBeenCalledTimes(1);

    fireEvent.change(stale.input, { target: { value: "Current draft" } });
    const current = captureInput(direct.host);
    expect(current.input).toBe(stale.input);
    act(() => directChange(stale, "Stale draft", { updateValue: false }));
    expect(current.input).toHaveValue("Current draft");

    const replacement = current.input.cloneNode(true);
    if (!(replacement instanceof HTMLInputElement)) throw new Error("Expected an input replacement");
    const parent = current.input.parentElement;
    if (!parent) throw new Error("The title input has no parent");
    parent.replaceChild(replacement, current.input);
    act(() => {
      directChange(current, "Detached draft", { updateValue: false });
      directChange(current, "Replacement draft", {
        currentTarget: replacement,
        target: replacement,
        nativeTarget: replacement,
        updateValue: false,
      });
      directKey(current, "Enter");
      directBlur(current);
    });
    parent.replaceChild(current.input, replacement);
    expect(session.setTitle).not.toHaveBeenCalled();
    expect(focus).toHaveBeenCalledTimes(1);
    expect(select).toHaveBeenCalledTimes(1);

    const accepted = captureInput(direct.host);
    fireEvent.keyDown(accepted.input, { key: "Enter" });
    expect(session.setTitle).toHaveBeenCalledExactlyOnceWith("Current draft");
  });

  it("accepts only exact owner-document input, focus, and unmodified keyboard provenance without poisoning the current edit", () => {
    const session = new TitleSession("Provenance");
    render(<TitleEditor session={session.asCollabSession()} fallback="Fallback" />);
    fireEvent.click(screen.getByTestId("title"));
    const current = captureInput();
    const sibling = document.createElement("input");
    const detached = document.createElement("input");
    document.body.append(sibling);
    const frame = document.createElement("iframe");
    document.body.append(frame);
    const foreignDocument = frame.contentDocument;
    if (!foreignDocument) throw new Error("The foreign document was not created");
    const foreign = foreignDocument.createElement("input");
    foreignDocument.body.append(foreign);
    const fabricatedClick = nativeClick(document.createElement("button"), { target: current.input });

    act(() => {
      directChange(current, "Wrong sibling", { currentTarget: sibling, target: sibling, nativeTarget: sibling, updateValue: false });
      directChange(current, "Detached", { currentTarget: detached, target: detached, nativeTarget: detached, updateValue: false });
      directChange(current, "Foreign", { currentTarget: foreign, target: foreign, nativeTarget: foreign, updateValue: false });
      directChange(current, "Crossed", { target: sibling, nativeTarget: sibling, updateValue: false });
      directChange(current, "Mismatch", { nativeTarget: sibling, updateValue: false });
      directChange(current, "Wrong wrapper", { type: "click", updateValue: false });
      directChange(current, "Wrong native", { nativeEvent: fabricatedClick, updateValue: false });
      directBlur(current, { target: sibling, nativeTarget: sibling });
      directBlur(current, { nativeEvent: nativeInput(current.input, "change") });
      directKey(current, "Enter", { target: sibling, nativeTarget: sibling });
      directKey(current, "Enter", { nativeKeyValue: "Escape" });
      directKey(current, "Enter", {
        ctrlKey: true,
        nativeEvent: nativeKey(current.input, "Enter", { ctrlKey: true }),
      });
      directKey(current, "Enter", {
        repeat: true,
        nativeEvent: nativeKey(current.input, "Enter", { repeat: true }),
      });
      directKey(current, "Enter", { nativeEvent: nativeInput(current.input, "keydown") });
    });

    expect(screen.getByTestId("title-input")).toHaveValue("Provenance");
    expect(session.setTitle).not.toHaveBeenCalled();
    fireEvent.change(screen.getByTestId("title-input"), { target: { value: "Accepted provenance" } });
    const accepted = captureInput();
    fireEvent.blur(accepted.input);
    expect(session.setTitle).toHaveBeenCalledExactlyOnceWith("Accepted provenance");
  });

  it("claims settlement before setTitle reentrancy and commits an editing generation at most once", () => {
    const session = new TitleSession("Reentrant");
    render(<TitleEditor session={session.asCollabSession()} fallback="Fallback" />);
    fireEvent.click(screen.getByTestId("title"));
    fireEvent.change(screen.getByTestId("title-input"), { target: { value: "Committed once" } });
    const current = captureInput();
    session.onSetTitle = () => {
      directKey(current, "Enter", { nativeEvent: nativeKey(current.input, "Enter") });
      directBlur(current, { nativeEvent: nativeFocus(current.input) });
    };
    const enter = nativeKey(current.input, "Enter");

    act(() => {
      directKey(current, "Enter", { nativeEvent: enter });
      directKey(current, "Enter", { nativeEvent: enter });
      directBlur(current);
    });

    expect(session.setTitle).toHaveBeenCalledExactlyOnceWith("Committed once");
    expect(screen.getByTestId("title")).toHaveTextContent("Committed once");
  });

  it.each([
    ["stale before current", false],
    ["current before stale", true],
  ] as const)("isolates equal-looking keyed remount refs and passive cleanup, %s", (_label, currentFirst) => {
    const session = new TitleSession("Equal remount");
    const passiveCleanup = vi.fn();
    const direct = createDirectTitle({
      session,
      fallback: "Fallback",
      instance: "A",
      onPassiveCleanup: passiveCleanup,
    });
    const stale = captureDisplay(direct.host);
    let cleanupAtBoundary = -1;

    act(() => direct.root.render(
      <TitleBoundary
        session={session}
        fallback="Fallback"
        instance="B"
        boundary={1}
        onPassiveCleanup={passiveCleanup}
        onBoundary={() => {
          cleanupAtBoundary = passiveCleanup.mock.calls.length;
          directClick(stale);
          expect(stale.button.isConnected).toBe(false);
          expect(direct.host.querySelector('[data-testid="title-input"]')).toBeNull();
        }}
      />,
    ));
    expect(cleanupAtBoundary).toBe(0);
    expect(passiveCleanup).toHaveBeenCalledOnce();
    const current = captureDisplay(direct.host);
    expect(current.button).not.toBe(stale.button);

    act(() => {
      stale.buttonRef(current.button);
      stale.titleRef(current.title);
      stale.iconRef?.(current.icon);
      stale.iconRef?.(null);
      stale.titleRef(null);
      stale.buttonRef(null);
      if (currentFirst) directClick(current);
      directClick(stale, { currentTarget: current.button, target: current.button });
      if (!currentFirst) directClick(current);
    });
    expect(direct.host.querySelectorAll('[data-testid="title-input"]')).toHaveLength(1);
  });

  it("retires removal before passive cleanup and remains usable through Strict Mode replay", () => {
    const removedSession = new TitleSession("Removed");
    const passiveCleanup = vi.fn();
    const removed = createDirectTitle({
      session: removedSession,
      fallback: "Fallback",
      onPassiveCleanup: passiveCleanup,
    });
    const stale = captureDisplay(removed.host);
    let cleanupAtBoundary = -1;
    act(() => removed.root.render(
      <TitleBoundary
        session={removedSession}
        fallback="Fallback"
        present={false}
        boundary={1}
        onPassiveCleanup={passiveCleanup}
        onBoundary={() => {
          cleanupAtBoundary = passiveCleanup.mock.calls.length;
          directClick(stale);
        }}
      />,
    ));
    expect(cleanupAtBoundary).toBe(0);
    expect(passiveCleanup).toHaveBeenCalledOnce();
    expect(removed.host).toBeEmptyDOMElement();

    const strictSession = new TitleSession("Strict title");
    render(
      <StrictMode>
        <TitleEditor session={strictSession.asCollabSession()} fallback="Fallback" />
      </StrictMode>,
    );
    const strict = captureDisplay();
    const event = nativeClick(strict.button);
    act(() => {
      directClick(strict, { nativeEvent: event });
      directClick(strict, { nativeEvent: event });
    });
    expect(screen.getAllByTestId("title-input")).toHaveLength(1);
    fireEvent.change(screen.getByTestId("title-input"), { target: { value: "Strict commit" } });
    const strictInput = captureInput();
    expect(strictInput.input).toHaveValue("Strict commit");
    act(() => directKey(strictInput, "Enter"));
    expect(strictSession.setTitle).toHaveBeenCalledExactlyOnceWith("Strict commit");
  });

  it("cancels editing when its session or edit eligibility is replaced", () => {
    const first = new TitleSession("First session");
    const second = new TitleSession("Second session");
    const view = render(<TitleEditor session={first.asCollabSession()} fallback="Fallback" />);
    fireEvent.click(screen.getByTestId("title"));
    fireEvent.change(screen.getByTestId("title-input"), { target: { value: "Crossed draft" } });
    const stale = captureInput();

    view.rerender(<TitleEditor session={second.asCollabSession()} fallback="Fallback" />);
    expect(screen.queryByTestId("title-input")).toBeNull();
    expect(screen.getByTestId("title")).toHaveTextContent("Second session");
    act(() => {
      directKey(stale, "Enter");
      directBlur(stale);
    });
    expect(first.setTitle).not.toHaveBeenCalled();
    expect(second.setTitle).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("title"));
    expect(screen.getByTestId("title-input")).toHaveValue("Second session");

    second.mutateRole("viewer");
    view.rerender(<TitleEditor session={second.asCollabSession()} fallback="Fallback" />);
    expect(screen.queryByTestId("title-input")).toBeNull();
    expect(screen.getByTestId("title")).toHaveAttribute("title", "Second session");
    fireEvent.click(screen.getByTestId("title"));
    expect(screen.queryByTestId("title-input")).toBeNull();

    second.mutateRole("editor");
    view.rerender(<TitleEditor session={second.asCollabSession()} fallback="Fallback" />);
    fireEvent.click(screen.getByTestId("title"));
    expect(screen.getByTestId("title-input")).toHaveValue("Second session");
  });
});
