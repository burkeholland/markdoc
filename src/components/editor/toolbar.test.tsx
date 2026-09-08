// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, within } from "@testing-library/react";
import {
  StrictMode,
  useEffect,
  useLayoutEffect,
  type ComponentProps,
  type ReactNode,
  type Ref,
} from "react";
import { createRoot, type Root } from "react-dom/client";
import type { CollabSession } from "@/editor/collab/session";
import type { EditorActions, FormatState } from "./actions";

vi.mock("@/components/ui/primitives", () => ({
  Tip: ({ children }: { children: ReactNode }) => children,
  Menu: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  MenuTrigger: ({ children }: { children: ReactNode }) => children,
  MenuContent: ({
    children,
    onCloseAutoFocus,
    ref,
    ...props
  }: {
    children: ReactNode;
    onCloseAutoFocus?: (event: { preventDefault: () => void }) => void;
    ref?: Ref<HTMLDivElement>;
    [key: string]: unknown;
  }) => (
    <div ref={ref} role="menu" data-testid="heading-content" onBlur={onCloseAutoFocus} {...props}>
      {children}
    </div>
  ),
  MenuRadioGroup: ({
    children,
  }: {
    children: ReactNode;
  }) => (
    <div role="radiogroup">
      {children}
    </div>
  ),
  MenuRadioItem: ({
    children,
    value,
    className,
    ref,
    disabled,
    onSelect,
    ...props
  }: {
    children: ReactNode;
    value: string;
    className?: string;
    ref?: Ref<HTMLDivElement>;
    disabled?: boolean;
    onSelect?: (event: Event) => void;
    [key: string]: unknown;
  }) => (
    <div
      ref={ref}
      role="menuitemradio"
      aria-checked="false"
      aria-disabled={disabled ? "true" : undefined}
      data-value={value}
      className={className}
      onClick={(event) => {
        if (!onSelect) return;
        const CustomEventConstructor = event.currentTarget.ownerDocument.defaultView?.CustomEvent;
        if (!CustomEventConstructor) throw new Error("Heading item has no owner-document CustomEvent");
        const nativeEvent = new CustomEventConstructor("menu.itemSelect", {
          bubbles: true,
          cancelable: true,
        });
        event.currentTarget.addEventListener("menu.itemSelect", onSelect, { once: true });
        event.currentTarget.dispatchEvent(nativeEvent);
      }}
      {...props}
    >
      {children}
    </div>
  ),
}));

import { Toolbar } from "./toolbar";

type ToolbarProps = ComponentProps<typeof Toolbar>;
type ControlEvent = {
  type: "click" | "mousedown";
  button: number;
  currentTarget: HTMLButtonElement;
  target: EventTarget;
  nativeEvent: MouseEvent;
  defaultPrevented: boolean;
  preventDefault: () => void;
};
type ClickHandler = (event: ControlEvent) => void;
type MouseDownHandler = (event: ControlEvent) => void;
type HeadingClickHandler = (event: { currentTarget: HTMLDivElement }) => void;
type CloseHandler = (event: Event) => void;
type FocusHandler = (event: {
  type: "focus";
  currentTarget: HTMLDivElement;
  target: Element;
  nativeEvent: FocusEvent;
  defaultPrevented: boolean;
}) => void;
type KeyHandler = (event: KeyEvent) => void;

interface KeyEvent {
  type: "keydown";
  currentTarget: HTMLDivElement;
  target: EventTarget;
  nativeEvent: KeyboardEvent;
  key: string;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  defaultPrevented: boolean;
  preventDefault: () => void;
}

const screen = within(document.documentElement);
const mounted: Array<{ root: Root; host: HTMLDivElement }> = [];

const BUTTON_LABELS = [
  "Text style",
  "Bold",
  "Italic",
  "Strikethrough",
  "Link",
  "Inline code",
  "Code block",
  "Bulleted list",
  "Numbered list",
  "Task list",
  "Quote",
  "Image",
  "Table",
  "Horizontal rule",
  "Undo",
  "Redo",
  "Comment",
] as const;

function reactHandler<T>(element: HTMLElement, name: string): T {
  const propsKey = Object.keys(element).find((key) => key.startsWith("__reactProps$"));
  if (!propsKey) throw new Error(`React props were not attached to ${element.getAttribute("aria-label") ?? element.tagName}`);
  const props = (element as unknown as Record<string, Record<string, unknown> | undefined>)[propsKey];
  const handler = props?.[name];
  if (typeof handler !== "function") throw new Error(`${name} was not attached to ${element.getAttribute("aria-label") ?? element.tagName}`);
  return handler as T;
}

function reactRef<T extends HTMLElement>(element: T): (node: T | null) => void {
  const propsKey = Object.keys(element).find((key) => key.startsWith("__reactProps$"));
  const props = propsKey
    ? (element as unknown as Record<string, { ref?: unknown }>)[propsKey]
    : undefined;
  if (typeof props?.ref === "function") return props.ref as (node: T | null) => void;
  const fiberKey = Object.keys(element).find((key) => key.startsWith("__reactFiber$"));
  if (!fiberKey) throw new Error(`React fiber was not attached to ${element.dataset.testid ?? element.tagName}`);
  const fiber = (element as unknown as Record<string, { ref?: unknown }>)[fiberKey];
  if (typeof fiber?.ref !== "function") throw new Error(`React ref was not attached to ${element.dataset.testid ?? element.tagName}`);
  return fiber.ref as (node: T | null) => void;
}

function format(overrides: Partial<FormatState> = {}): FormatState {
  return {
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
    tablePos: -1,
    tableAlign: null,
    ...overrides,
  };
}

function controlledSession(initial: Partial<PermissionState> = {}) {
  const state: PermissionState = {
    canEdit: true,
    canUndo: true,
    canRedo: true,
    canComment: true,
    ...initial,
  };
  const listeners = new Set<() => void>();
  const session = {
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    get canEdit() {
      return state.canEdit;
    },
    get canUndo() {
      return state.canUndo;
    },
    get canRedo() {
      return state.canRedo;
    },
    get canComment() {
      return state.canComment;
    },
  } as unknown as CollabSession;
  return {
    session,
    mutate(next: Partial<PermissionState>) {
      Object.assign(state, next);
    },
    set(next: Partial<PermissionState>) {
      this.mutate(next);
      for (const listener of listeners) listener();
    },
  };
}

interface PermissionState {
  canEdit: boolean;
  canUndo: boolean;
  canRedo: boolean;
  canComment: boolean;
}

function instrumentActions(shared: Partial<ActionSpies> = {}) {
  const spies: ActionSpies = {
    toggleMark: shared.toggleMark ?? vi.fn<(kind: "strong" | "em" | "code" | "strike") => void>(),
    openLinkDialog: shared.openLinkDialog ?? vi.fn<() => void>(),
    toggleCodeBlock: shared.toggleCodeBlock ?? vi.fn<() => void>(),
    toggleList: shared.toggleList ?? vi.fn<(kind: "bullet" | "ordered" | "task") => void>(),
    toggleQuote: shared.toggleQuote ?? vi.fn<() => void>(),
    horizontalRule: shared.horizontalRule ?? vi.fn<() => void>(),
    undo: shared.undo ?? vi.fn<() => void>(),
    redo: shared.redo ?? vi.fn<() => void>(),
    setHeading: shared.setHeading ?? vi.fn<(level: number) => void>(),
    focus: shared.focus ?? vi.fn<() => void>(),
  };
  return {
    actions: { ...spies } as unknown as EditorActions,
    ...spies,
  };
}

interface ActionSpies {
  toggleMark: ReturnType<typeof vi.fn<(kind: "strong" | "em" | "code" | "strike") => void>>;
  openLinkDialog: ReturnType<typeof vi.fn<() => void>>;
  toggleCodeBlock: ReturnType<typeof vi.fn<() => void>>;
  toggleList: ReturnType<typeof vi.fn<(kind: "bullet" | "ordered" | "task") => void>>;
  toggleQuote: ReturnType<typeof vi.fn<() => void>>;
  horizontalRule: ReturnType<typeof vi.fn<() => void>>;
  undo: ReturnType<typeof vi.fn<() => void>>;
  redo: ReturnType<typeof vi.fn<() => void>>;
  setHeading: ReturnType<typeof vi.fn<(level: number) => void>>;
  focus: ReturnType<typeof vi.fn<() => void>>;
}

type VoidSpy = ReturnType<typeof vi.fn<() => void>>;

function fixture({
  session = controlledSession(),
  actions = instrumentActions(),
  currentFormat = format(),
  onComment = vi.fn<() => void>(),
  onImage = vi.fn<() => void>(),
  onTable = vi.fn<() => void>(),
}: Partial<{
  session: ReturnType<typeof controlledSession>;
  actions: ReturnType<typeof instrumentActions>;
  currentFormat: FormatState;
  onComment: VoidSpy;
  onImage: VoidSpy;
  onTable: VoidSpy;
}> = {}) {
  const props: ToolbarProps = {
    session: session.session,
    actions: actions.actions,
    format: currentFormat,
    onComment,
    onImage,
    onTable,
  };
  return { props, session, actions, currentFormat, onComment, onImage, onTable };
}

function Boundary({
  toolbar,
  present = true,
  publicationKey = 0,
  boundary = 0,
  onBoundary,
  onPassiveCleanup,
}: {
  toolbar: ToolbarProps;
  present?: boolean;
  publicationKey?: number;
  boundary?: number;
  onBoundary?: () => void;
  onPassiveCleanup?: () => void;
}) {
  useLayoutEffect(() => {
    if (boundary > 0) onBoundary?.();
  }, [boundary, onBoundary]);
  useEffect(() => () => onPassiveCleanup?.(), [boundary, onPassiveCleanup]);
  return present ? <Toolbar key={publicationKey} {...toolbar} /> : null;
}

function LayoutCapture({ children, capture }: { children: ReactNode; capture: () => void }) {
  useLayoutEffect(() => {
    capture();
  }, [capture]);
  return children;
}

function directRender(props: ComponentProps<typeof Boundary>) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  mounted.push({ root, host });
  act(() => root.render(<Boundary {...props} />));
  return {
    update(next: ComponentProps<typeof Boundary>) {
      act(() => root.render(<Boundary {...next} />));
    },
  };
}

function capturePublication() {
  const root = screen.getByTestId("toolbar") as HTMLDivElement;
  const headingControls = Object.fromEntries(
    Object.entries(HEADINGS_BY_VALUE).map(([value, name]) => {
      const element = screen.getByRole("menuitemradio", { name });
      if (!(element instanceof HTMLDivElement)) throw new Error(`Heading ${value} is not a div`);
      return [value, {
        element,
        click: reactHandler<HeadingClickHandler>(element, "onClick"),
      }];
    }),
  );
  const buttons = Object.fromEntries(
    BUTTON_LABELS.flatMap((label) => {
      const element = screen.queryByRole("button", { name: label });
      return element
        ? [[label, {
            element: element as HTMLButtonElement,
            click: label === "Text style" ? () => undefined : reactHandler<ClickHandler>(element, "onClick"),
            mouseDown: reactHandler<MouseDownHandler>(element, "onMouseDown"),
          }]]
        : [];
    }),
  ) as Partial<Record<(typeof BUTTON_LABELS)[number], {
    element: HTMLButtonElement;
    click: ClickHandler;
    mouseDown: MouseDownHandler;
  }>>;
  const headingContent = screen.getByTestId("heading-content") as HTMLDivElement;
  const nodes = [
    root,
    ...Object.values(buttons).map(({ element }) => element),
    headingContent,
    ...Object.values(headingControls).map(({ element }) => element),
  ];
  return {
    root,
    buttons,
    headingChange: (value: string) => {
      const item = headingControls[value];
      item?.click({ currentTarget: item.element });
    },
    headingClose: reactHandler<CloseHandler>(screen.getByTestId("heading-content"), "onBlur"),
    headingContent,
    focus: reactHandler<FocusHandler>(root, "onFocus"),
    keyDown: reactHandler<KeyHandler>(root, "onKeyDown"),
    nodes,
    refs: nodes.map((node) => reactRef(node)),
  };
}

const HEADINGS_BY_VALUE: Record<string, string> = {
  "0": "Paragraph",
  "1": "Heading 1",
  "2": "Heading 2",
  "3": "Heading 3",
  "4": "Heading 4",
  "5": "Heading 5",
  "6": "Heading 6",
};

function button(publication: ReturnType<typeof capturePublication>, label: (typeof BUTTON_LABELS)[number]) {
  const control = publication.buttons[label];
  if (!control) throw new Error(`${label} is not rendered`);
  return control;
}

function activate(
  control: ReturnType<typeof button>,
  currentTarget: HTMLButtonElement = control.element,
) {
  control.click(controlEvent(control, currentTarget));
}

function controlEvent(
  control: ReturnType<typeof button>,
  currentTarget: HTMLButtonElement = control.element,
  type: "click" | "mousedown" = "click",
): ControlEvent {
  const target = currentTarget;
  const MouseEventConstructor = currentTarget.ownerDocument.defaultView?.MouseEvent;
  if (!MouseEventConstructor) throw new Error("Control has no owner-document MouseEvent");
  const nativeEvent = new MouseEventConstructor(type, {
    bubbles: true,
    cancelable: true,
    button: 0,
  });
  setNativeProvenance(nativeEvent, target);
  return {
    type,
    button: 0,
    currentTarget,
    target,
    nativeEvent,
    defaultPrevented: false,
    preventDefault: vi.fn(),
  };
}

function keyEvent(root: HTMLDivElement, key: string, modifiers: Partial<Pick<KeyEvent, "altKey" | "ctrlKey" | "metaKey" | "shiftKey">> = {}) {
  const target = root.ownerDocument.activeElement ?? root;
  const KeyboardEventConstructor = root.ownerDocument.defaultView?.KeyboardEvent;
  if (!KeyboardEventConstructor) throw new Error("Toolbar has no owner-document KeyboardEvent");
  const nativeEvent = new KeyboardEventConstructor("keydown", {
    bubbles: true,
    cancelable: true,
    key,
    ...modifiers,
  });
  setNativeProvenance(nativeEvent, target);
  return {
    type: "keydown" as const,
    currentTarget: root,
    target,
    nativeEvent,
    key,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    defaultPrevented: false,
    preventDefault: vi.fn(),
    ...modifiers,
  };
}

function focusEvent(root: HTMLDivElement, target: Element): Parameters<FocusHandler>[0] {
  const FocusEventConstructor = root.ownerDocument.defaultView?.FocusEvent;
  if (!FocusEventConstructor) throw new Error("Toolbar has no owner-document FocusEvent");
  const nativeEvent = new FocusEventConstructor("focusin", { bubbles: true });
  setNativeProvenance(nativeEvent, target);
  return {
    type: "focus",
    currentTarget: root,
    target,
    nativeEvent,
    defaultPrevented: false,
  };
}

function customEvent(
  source: HTMLElement,
  type: "menu.itemSelect" | "focusScope.autoFocusOnUnmount",
) {
  const CustomEventConstructor = source.ownerDocument.defaultView?.CustomEvent;
  if (!CustomEventConstructor) throw new Error("Control has no owner-document CustomEvent");
  const event = new CustomEventConstructor(type, { bubbles: true, cancelable: true });
  setNativeProvenance(event, source);
  vi.spyOn(event, "preventDefault");
  return event;
}

function setNativeProvenance(event: Event, target: EventTarget) {
  const nodes: EventTarget[] = [];
  if (target instanceof Node) {
    for (let current: Node | null = target; current; current = current.parentNode) nodes.push(current);
    const ownerDocument = target instanceof Document ? target : target.ownerDocument;
    if (ownerDocument) {
      nodes.push(ownerDocument);
      if (ownerDocument.defaultView) nodes.push(ownerDocument.defaultView);
    }
  } else {
    nodes.push(target);
  }
  Object.defineProperties(event, {
    target: { configurable: true, value: target },
    currentTarget: { configurable: true, value: target },
    eventPhase: { configurable: true, value: Event.AT_TARGET },
    composedPath: { configurable: true, value: () => nodes },
  });
}

afterEach(() => {
  for (const entry of mounted.splice(0)) {
    act(() => entry.root.unmount());
    entry.host.remove();
  }
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe("Toolbar publication authority", () => {
  it("keeps seven interaction families exact through direct-root Strict Mode replay", () => {
    const f = fixture();
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    mounted.push({ root, host });
    const layouts: ReturnType<typeof capturePublication>[] = [];
    const captureLayout = () => layouts.push(capturePublication());

    act(() => {
      root.render(
        <StrictMode>
          <LayoutCapture capture={captureLayout}>
            <Toolbar {...f.props} />
          </LayoutCapture>
        </StrictMode>,
      );
    });

    const stale = layouts[0];
    if (!stale) throw new Error("Strict Mode did not expose its first layout publication");
    const current = capturePublication();
    expect(current.root).toBe(stale.root);
    expect(button(current, "Bold").click).not.toBe(button(stale, "Bold").click);
    expect(current.refs[0]).not.toBe(stale.refs[0]);

    act(() => {
      stale.refs.forEach((ref, index) => ref(current.nodes[index] ?? null));
      [...stale.refs].reverse().forEach((ref) => ref(null));
    });

    const mouseDown = controlEvent(button(current, "Bold"), button(current, "Bold").element, "mousedown");
    button(stale, "Bold").mouseDown(mouseDown);
    button(current, "Bold").mouseDown(mouseDown);
    button(current, "Bold").mouseDown(mouseDown);
    expect(mouseDown.preventDefault).toHaveBeenCalledOnce();

    const bold = controlEvent(button(current, "Bold"));
    button(stale, "Bold").click(bold);
    button(current, "Bold").click(bold);
    button(current, "Bold").click(bold);
    activate(button(current, "Image"));
    activate(button(current, "Undo"));
    activate(button(current, "Redo"));
    activate(button(current, "Comment"));
    stale.headingChange("2");
    current.headingChange("2");

    const italic = button(current, "Italic").element;
    italic.focus();
    const right = keyEvent(current.root, "ArrowRight");
    stale.keyDown(right);
    current.keyDown(right);
    current.keyDown(right);

    const close = customEvent(current.headingContent, "focusScope.autoFocusOnUnmount");
    stale.headingClose(close);
    current.headingClose(close);
    current.headingClose(close);

    expect(f.actions.toggleMark.mock.calls).toEqual([["strong"]]);
    expect(f.onImage).toHaveBeenCalledOnce();
    expect(f.actions.undo).toHaveBeenCalledOnce();
    expect(f.actions.redo).toHaveBeenCalledOnce();
    expect(f.onComment).toHaveBeenCalledOnce();
    expect(f.actions.setHeading.mock.calls).toEqual([[2]]);
    expect(button(current, "Strikethrough").element).toHaveFocus();
    expect(right.preventDefault).toHaveBeenCalledOnce();
    expect(f.actions.focus).toHaveBeenCalledOnce();
    expect(close.preventDefault).toHaveBeenCalledOnce();
  });

  it.each([
    "partial replay",
    "detach and reinsert",
    "replace and restore",
    "reorder and restore",
    "mutate and restore",
  ] as const)("permanently retires after %s history", (change) => {
    const f = fixture();
    directRender({ toolbar: f.props });
    const stale = capturePublication();
    const rootRef = reactRef(stale.root);
    const bold = button(stale, "Bold").element;
    const italic = button(stale, "Italic").element;

    if (change === "partial replay") {
      act(() => {
        rootRef(null);
        rootRef(stale.root);
      });
    } else if (change === "detach and reinsert") {
      const parent = stale.root.parentNode;
      const next = stale.root.nextSibling;
      if (!parent) throw new Error("Toolbar root had no parent");
      stale.root.remove();
      parent.insertBefore(stale.root, next);
    } else if (change === "replace and restore") {
      const replacement = bold.cloneNode(true) as HTMLButtonElement;
      bold.replaceWith(replacement);
      replacement.replaceWith(bold);
    } else if (change === "reorder and restore") {
      const parent = bold.parentNode;
      if (!parent) throw new Error("Bold button had no parent");
      parent.append(bold);
      parent.insertBefore(bold, italic);
    } else {
      bold.setAttribute("aria-label", "Changed");
      bold.setAttribute("aria-label", "Bold");
    }

    const mouseDown = controlEvent(button(stale, "Bold"), bold, "mousedown");
    activate(button(stale, "Bold"));
    button(stale, "Bold").mouseDown(mouseDown);
    stale.headingChange("3");
    expect(f.actions.toggleMark).not.toHaveBeenCalled();
    expect(f.actions.setHeading).not.toHaveBeenCalled();
    expect(mouseDown.preventDefault).not.toHaveBeenCalled();
  });

  it("rejects fabricated native events without consuming the current action", () => {
    const f = fixture();
    directRender({ toolbar: f.props });
    const current = capturePublication();
    const bold = button(current, "Bold");
    const exact = controlEvent(bold);
    const fabricated = {
      ...exact,
      nativeEvent: {
        type: "click",
        target: bold.element,
        button: 0,
      },
    } as unknown as ControlEvent;

    bold.click(fabricated);
    bold.click(exact);
    bold.click(exact);
    expect(f.actions.toggleMark.mock.calls).toEqual([["strong"]]);
  });

  it("does not mint a replay successor after the first layout authority consumed work", () => {
    const f = fixture();
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    mounted.push({ root, host });
    let first: ReturnType<typeof capturePublication> | null = null;
    const captureLayout = () => {
      if (first) return;
      first = capturePublication();
      activate(button(first, "Bold"));
    };

    act(() => {
      root.render(
        <StrictMode>
          <LayoutCapture capture={captureLayout}>
            <Toolbar {...f.props} />
          </LayoutCapture>
        </StrictMode>,
      );
    });

    const retired = first;
    if (!retired) throw new Error("Strict Mode did not expose its first layout publication");
    activate(button(capturePublication(), "Bold"));
    expect(f.actions.toggleMark.mock.calls).toEqual([["strong"]]);
  });

  it("renders the existing controls and claims every exact command, heading, callback, and event once", () => {
    const f = fixture({
      currentFormat: format({
        strong: true,
        link: true,
        bullet: true,
        heading: 2,
        hasSelection: true,
      }),
    });
    directRender({ toolbar: f.props });
    const publication = capturePublication();

    expect(screen.getAllByRole("button").map((element) => element.getAttribute("aria-label") ?? element.textContent)).toEqual(BUTTON_LABELS);
    expect(button(publication, "Bold").element).toHaveAttribute("aria-pressed", "true");
    expect(button(publication, "Link").element).toHaveAttribute("aria-pressed", "true");
    expect(button(publication, "Bulleted list").element).toHaveAttribute("aria-pressed", "true");
    expect(button(publication, "Undo").element).toBeEnabled();
    expect(button(publication, "Redo").element).toBeEnabled();
    expect(button(publication, "Comment").element).toHaveClass("btn-outline");

    const foreign = document.createElement("button");
    document.body.append(foreign);
    const detached = document.createElement("button");
    const bold = button(publication, "Bold");
    const image = button(publication, "Image");
    const comment = button(publication, "Comment");
    bold.click(controlEvent(bold, button(publication, "Italic").element));
    bold.click(controlEvent(bold, foreign));
    image.click(controlEvent(image, detached));
    comment.click(controlEvent(comment, bold.element));
    expect(f.actions.toggleMark).not.toHaveBeenCalled();
    expect(f.onImage).not.toHaveBeenCalled();
    expect(f.onComment).not.toHaveBeenCalled();
    for (const [control, target] of [
      [bold, comment.element],
      [button(publication, "Text style"), foreign],
      [comment, detached],
    ] as const) {
      const event = controlEvent(control, target, "mousedown");
      control.mouseDown(event);
      expect(event.preventDefault).not.toHaveBeenCalled();
    }

    f.actions.toggleMark.mockImplementation((kind: string) => {
      if (kind === "strong") activate(button(publication, "Bold"));
    });
    f.onImage.mockImplementation(() => activate(button(publication, "Image")));
    for (const label of BUTTON_LABELS.slice(1)) {
      const control = button(publication, label);
      activate(control);
      activate(control);
    }
    publication.headingChange("3");
    publication.headingChange("3");
    publication.headingChange("6");
    for (const invalid of ["", "-1", "7", "03", "3.0", "NaN"]) publication.headingChange(invalid);

    expect(f.actions.toggleMark.mock.calls).toEqual([["strong"], ["em"], ["strike"], ["code"]]);
    expect(f.actions.openLinkDialog).toHaveBeenCalledOnce();
    expect(f.actions.toggleCodeBlock).toHaveBeenCalledOnce();
    expect(f.actions.toggleList.mock.calls).toEqual([["bullet"], ["ordered"], ["task"]]);
    expect(f.actions.toggleQuote).toHaveBeenCalledOnce();
    expect(f.onImage).toHaveBeenCalledOnce();
    expect(f.onTable).toHaveBeenCalledOnce();
    expect(f.actions.horizontalRule).toHaveBeenCalledOnce();
    expect(f.actions.undo).toHaveBeenCalledOnce();
    expect(f.actions.redo).toHaveBeenCalledOnce();
    expect(f.onComment).toHaveBeenCalledOnce();
    expect(f.actions.setHeading.mock.calls).toEqual([[3], [6]]);

    const close = customEvent(publication.headingContent, "focusScope.autoFocusOnUnmount");
    publication.headingClose(close);
    publication.headingClose(close);
    publication.headingClose(customEvent(publication.headingContent, "focusScope.autoFocusOnUnmount"));
    expect(close.preventDefault).toHaveBeenCalledOnce();
    expect(f.actions.focus).toHaveBeenCalledOnce();

    for (const label of ["Bold", "Text style", "Comment"] as const) {
      const control = button(publication, label);
      const event = controlEvent(control, control.element, "mousedown");
      control.mouseDown(event);
      control.mouseDown(event);
      expect(event.preventDefault).toHaveBeenCalledOnce();
    }
  });

  it.each(["stale-before-current", "current-before-stale"] as const)(
    "retires reused DOM publications at parent layout boundaries (%s)",
    (order) => {
      const sharedToggle = vi.fn<(kind: "strong" | "em" | "code" | "strike") => void>();
      const firstActions = instrumentActions({ toggleMark: sharedToggle });
      const secondActions = instrumentActions({ toggleMark: sharedToggle });
      const f = fixture({ actions: firstActions });
      const passiveCleanup = vi.fn();
      const rendered = directRender({ toolbar: f.props, onPassiveCleanup: passiveCleanup });
      const stale = capturePublication();
      const staleRoot = stale.root;
      const staleBold = button(stale, "Bold").element;
      let current!: ReturnType<typeof capturePublication>;
      let protectedTabs: number[] = [];
      let protectedFocus: Element | null = null;
      const rejectedMouseEvents: ControlEvent[] = [];
      let acceptedMouse!: ControlEvent;
      const foreign = document.createElement("button");
      document.body.append(foreign);
      const detached = document.createElement("button");

      const nextProps = {
        ...f.props,
        actions: secondActions.actions,
        format: format({ strong: true }),
        onComment: vi.fn<() => void>(),
        onImage: vi.fn<() => void>(),
        onTable: vi.fn<() => void>(),
      };
      rendered.update({
        toolbar: nextProps,
        boundary: 1,
        onPassiveCleanup: passiveCleanup,
        onBoundary: () => {
          expect(passiveCleanup).not.toHaveBeenCalled();
          current = capturePublication();
          expect(current.root).toBe(staleRoot);
          expect(button(current, "Bold").element).toBe(staleBold);
          protectedTabs = screen.getAllByRole("button").map((element) => (element as HTMLButtonElement).tabIndex);
          protectedFocus = document.activeElement;
          const currentBold = button(current, "Bold");
          const currentComment = button(current, "Comment");
          const staleBoldControl = button(stale, "Bold");
          const staleComment = button(stale, "Comment");
          currentBold.click(controlEvent(currentBold, currentComment.element));
          currentBold.click(controlEvent(currentBold, foreign));
          currentComment.click(controlEvent(currentComment, currentBold.element));
          currentComment.click(controlEvent(currentComment, detached));
          const currentWrongMouse = controlEvent(currentBold, currentComment.element, "mousedown");
          const staleExactMouse = controlEvent(staleBoldControl, currentBold.element, "mousedown");
          currentBold.mouseDown(currentWrongMouse);
          staleBoldControl.mouseDown(staleExactMouse);
          rejectedMouseEvents.push(currentWrongMouse, staleExactMouse);
          acceptedMouse = controlEvent(currentComment, currentComment.element, "mousedown");
          currentComment.mouseDown(acceptedMouse);
          currentComment.mouseDown(acceptedMouse);
          if (order === "stale-before-current") {
            activate(staleBoldControl, currentBold.element);
            activate(staleComment, currentComment.element);
            activate(currentBold);
            activate(currentComment);
          } else {
            activate(currentBold);
            activate(currentComment);
            activate(staleBoldControl, currentBold.element);
            activate(staleComment, currentComment.element);
          }
        },
      });

      expect(passiveCleanup).toHaveBeenCalledOnce();
      expect(sharedToggle.mock.calls).toEqual([["strong"]]);
      expect(nextProps.onComment).toHaveBeenCalledOnce();
      for (const event of rejectedMouseEvents) expect(event.preventDefault).not.toHaveBeenCalled();
      expect(acceptedMouse.preventDefault).toHaveBeenCalledOnce();
      activate(button(stale, "Bold"), button(current, "Bold").element);
      activate(button(stale, "Comment"), button(current, "Comment").element);
      const postCleanupMouse = controlEvent(button(stale, "Bold"), button(current, "Bold").element, "mousedown");
      button(stale, "Bold").mouseDown(postCleanupMouse);
      expect(postCleanupMouse.preventDefault).not.toHaveBeenCalled();
      activate(button(current, "Image"));
      expect(sharedToggle).toHaveBeenCalledOnce();
      expect(nextProps.onComment).toHaveBeenCalledOnce();
      expect(nextProps.onImage).toHaveBeenCalledOnce();
      expect(screen.getAllByRole("button").map((element) => (element as HTMLButtonElement).tabIndex)).toEqual(protectedTabs);
      expect(document.activeElement).toBe(protectedFocus);
      expect(screen.getAllByTestId("toolbar")).toHaveLength(1);
      expect(button(current, "Bold").element).toHaveAttribute("aria-pressed", "true");
    },
  );

  it.each(["session", "format", "permissions", "callbacks"] as const)(
    "retires a %s replacement before the parent layout effect while preserving the reused controls",
    (replacement) => {
      const f = fixture();
      const passiveCleanup = vi.fn();
      const rendered = directRender({ toolbar: f.props, onPassiveCleanup: passiveCleanup });
      const stale = capturePublication();
      const staleRoot = stale.root;
      const staleBold = button(stale, "Bold").element;
      const nextSession = replacement === "session" ? controlledSession() : f.session;
      const nextFormat = replacement === "format" ? format({ codeBlock: true }) : f.currentFormat;
      const nextImage = replacement === "callbacks" ? vi.fn<() => void>() : f.onImage;
      const nextTable = replacement === "callbacks" ? vi.fn<() => void>() : f.onTable;
      const nextComment = replacement === "callbacks" ? vi.fn<() => void>() : f.onComment;
      if (replacement === "permissions") f.session.set({ canUndo: false });
      let current!: ReturnType<typeof capturePublication>;

      rendered.update({
        toolbar: {
          ...f.props,
          session: nextSession.session,
          format: nextFormat,
          onImage: nextImage,
          onTable: nextTable,
          onComment: nextComment,
        },
        boundary: 1,
        onPassiveCleanup: passiveCleanup,
        onBoundary: () => {
          expect(passiveCleanup).not.toHaveBeenCalled();
          current = capturePublication();
          expect(current.root).toBe(staleRoot);
          expect(button(current, "Bold").element).toBe(staleBold);
          activate(button(stale, "Bold"));
          stale.headingChange("4");
          const staleClose = customEvent(stale.headingContent, "focusScope.autoFocusOnUnmount");
          stale.headingClose(staleClose);
          if (replacement === "callbacks") {
            activate(button(stale, "Image"));
            activate(button(stale, "Table"));
            activate(button(stale, "Comment"));
          }
          expect(staleClose.preventDefault).not.toHaveBeenCalled();
        },
      });

      expect(passiveCleanup).toHaveBeenCalledOnce();
      expect(f.actions.toggleMark).not.toHaveBeenCalled();
      expect(f.actions.setHeading).not.toHaveBeenCalled();
      expect(f.actions.focus).not.toHaveBeenCalled();
      activate(button(current, "Bold"));
      current.headingChange("4");
      const close = customEvent(current.headingContent, "focusScope.autoFocusOnUnmount");
      current.headingClose(close);
      if (replacement === "callbacks") {
        activate(button(current, "Image"));
        activate(button(current, "Table"));
        activate(button(current, "Comment"));
        expect(f.onImage).not.toHaveBeenCalled();
        expect(f.onTable).not.toHaveBeenCalled();
        expect(f.onComment).not.toHaveBeenCalled();
        expect(nextImage).toHaveBeenCalledOnce();
        expect(nextTable).toHaveBeenCalledOnce();
        expect(nextComment).toHaveBeenCalledOnce();
      }
      expect(f.actions.toggleMark.mock.calls).toEqual([["strong"]]);
      expect(f.actions.setHeading.mock.calls).toEqual([[4]]);
      expect(close.preventDefault).toHaveBeenCalledOnce();
      expect(f.actions.focus).toHaveBeenCalledOnce();
    },
  );

  it.each(["stale-before-current", "current-before-stale"] as const)(
    "isolates equal-value remounts, replaced DOM, and shared method identities (%s)",
    (order) => {
      const sharedToggle = vi.fn<(kind: "strong" | "em" | "code" | "strike") => void>();
      const first = fixture({ actions: instrumentActions({ toggleMark: sharedToggle }) });
      const secondActions = instrumentActions({ toggleMark: sharedToggle });
      const passiveCleanup = vi.fn();
      const rendered = directRender({ toolbar: first.props, onPassiveCleanup: passiveCleanup });
      const stale = capturePublication();
      let current!: ReturnType<typeof capturePublication>;
      let protectedTabs: number[] = [];
      let protectedFocus: Element | null = null;
      const rejectedMouseEvents: ControlEvent[] = [];
      let acceptedMouse!: ControlEvent;
      const foreign = document.createElement("button");
      document.body.append(foreign);
      const detached = document.createElement("button");

      rendered.update({
        toolbar: {
          ...first.props,
          actions: secondActions.actions,
          format: { ...first.currentFormat },
        },
        publicationKey: 1,
        boundary: 1,
        onPassiveCleanup: passiveCleanup,
        onBoundary: () => {
          expect(passiveCleanup).not.toHaveBeenCalled();
          current = capturePublication();
          expect(current.root).not.toBe(stale.root);
          expect(button(current, "Bold").element).not.toBe(button(stale, "Bold").element);
          protectedTabs = screen.getAllByRole("button").map((element) => (element as HTMLButtonElement).tabIndex);
          protectedFocus = document.activeElement;
          const staleBold = button(stale, "Bold");
          const staleComment = button(stale, "Comment");
          const currentBold = button(current, "Bold");
          const currentComment = button(current, "Comment");
          currentBold.click(controlEvent(currentBold, staleBold.element));
          staleBold.click(controlEvent(staleBold, currentBold.element));
          currentBold.click(controlEvent(currentBold, currentComment.element));
          currentComment.click(controlEvent(currentComment, staleComment.element));
          currentBold.click(controlEvent(currentBold, foreign));
          currentComment.click(controlEvent(currentComment, detached));
          const currentWrongMouse = controlEvent(currentBold, staleBold.element, "mousedown");
          const staleWrongMouse = controlEvent(staleBold, currentBold.element, "mousedown");
          currentBold.mouseDown(currentWrongMouse);
          staleBold.mouseDown(staleWrongMouse);
          rejectedMouseEvents.push(currentWrongMouse, staleWrongMouse);
          acceptedMouse = controlEvent(currentComment, currentComment.element, "mousedown");
          currentComment.mouseDown(acceptedMouse);
          currentComment.mouseDown(acceptedMouse);
          if (order === "stale-before-current") {
            activate(staleBold);
            activate(staleComment);
            activate(currentBold);
            activate(currentComment);
          } else {
            activate(currentBold);
            activate(currentComment);
            activate(staleBold);
            activate(staleComment);
          }
        },
      });

      expect(sharedToggle.mock.calls).toEqual([["strong"]]);
      expect(first.onComment).toHaveBeenCalledOnce();
      expect(passiveCleanup).toHaveBeenCalledOnce();
      for (const event of rejectedMouseEvents) expect(event.preventDefault).not.toHaveBeenCalled();
      expect(acceptedMouse.preventDefault).toHaveBeenCalledOnce();
      activate(button(stale, "Bold"), button(current, "Bold").element);
      activate(button(stale, "Comment"), button(current, "Comment").element);
      const postCleanupMouse = controlEvent(button(stale, "Bold"), button(current, "Bold").element, "mousedown");
      button(stale, "Bold").mouseDown(postCleanupMouse);
      expect(postCleanupMouse.preventDefault).not.toHaveBeenCalled();
      activate(button(current, "Image"));
      expect(sharedToggle).toHaveBeenCalledOnce();
      expect(first.onComment).toHaveBeenCalledOnce();
      expect(first.onImage).toHaveBeenCalledOnce();
      expect(screen.getAllByRole("button").map((element) => (element as HTMLButtonElement).tabIndex)).toEqual(protectedTabs);
      expect(document.activeElement).toBe(protectedFocus);
      expect(screen.getAllByTestId("toolbar")).toHaveLength(1);
      expect(stale.root.isConnected).toBe(false);
      expect(current.root.isConnected).toBe(true);
    },
  );

  it("retires every captured callback on removal and leaves the next mount independently usable", () => {
    const f = fixture();
    const passiveCleanup = vi.fn();
    const rendered = directRender({ toolbar: f.props, onPassiveCleanup: passiveCleanup });
    const stale = capturePublication();
    const staleTabs = screen.getAllByRole("button").map((element) => (element as HTMLButtonElement).tabIndex);
    const staleMouse = controlEvent(button(stale, "Bold"), button(stale, "Bold").element, "mousedown");
    const staleKey = keyEvent(stale.root, "ArrowRight");
    const staleClose = customEvent(stale.headingContent, "focusScope.autoFocusOnUnmount");

    rendered.update({
      toolbar: f.props,
      present: false,
      boundary: 1,
      onPassiveCleanup: passiveCleanup,
      onBoundary: () => {
        expect(passiveCleanup).not.toHaveBeenCalled();
        activate(button(stale, "Bold"));
        button(stale, "Bold").mouseDown(staleMouse);
        stale.headingChange("2");
        stale.headingClose(staleClose);
        stale.focus(focusEvent(stale.root, button(stale, "Italic").element));
        stale.keyDown(staleKey);
      },
    });

    expect(passiveCleanup).toHaveBeenCalledOnce();
    expect(f.actions.toggleMark).not.toHaveBeenCalled();
    expect(f.actions.setHeading).not.toHaveBeenCalled();
    expect(f.actions.focus).not.toHaveBeenCalled();
    expect(staleMouse.preventDefault).not.toHaveBeenCalled();
    expect(staleClose.preventDefault).not.toHaveBeenCalled();
    expect(staleKey.preventDefault).not.toHaveBeenCalled();
    expect(Object.values(stale.buttons).filter(Boolean).map(({ element }) => element.tabIndex)).toEqual(staleTabs);

    rendered.update({ toolbar: f.props, publicationKey: 2, boundary: 2, onPassiveCleanup: passiveCleanup });
    const current = capturePublication();
    activate(button(stale, "Bold"));
    activate(button(current, "Bold"));
    expect(f.actions.toggleMark.mock.calls).toEqual([["strong"]]);
  });

  it("fails closed across edit, history, and comment eligibility changes, then accepts later publications", () => {
    const f = fixture();
    const rendered = directRender({ toolbar: f.props });
    const enabled = capturePublication();
    f.session.set({ canEdit: false, canUndo: false, canRedo: false, canComment: false });
    rendered.update({
      toolbar: f.props,
      boundary: 1,
      onBoundary: () => {
        for (const label of ["Bold", "Undo", "Redo", "Comment"] as const) activate(button(enabled, label));
        const mouse = controlEvent(button(enabled, "Bold"), button(enabled, "Bold").element, "mousedown");
        button(enabled, "Bold").mouseDown(mouse);
        expect(mouse.preventDefault).not.toHaveBeenCalled();
      },
    });

    expect(button(capturePublication(), "Bold").element).toBeDisabled();
    expect(button(capturePublication(), "Undo").element).toBeDisabled();
    expect(button(capturePublication(), "Redo").element).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Comment" })).toBeNull();
    expect(screen.getAllByRole("button").every((element) => (element as HTMLButtonElement).tabIndex === -1)).toBe(true);
    expect(f.actions.toggleMark).not.toHaveBeenCalled();
    expect(f.actions.undo).not.toHaveBeenCalled();
    expect(f.actions.redo).not.toHaveBeenCalled();
    expect(f.onComment).not.toHaveBeenCalled();

    f.session.set({ canEdit: true, canUndo: true, canRedo: true, canComment: true });
    rendered.update({ toolbar: f.props, boundary: 2 });
    let current = capturePublication();
    activate(button(current, "Bold"));
    activate(button(current, "Undo"));
    activate(button(current, "Redo"));
    activate(button(current, "Comment"));
    expect(f.actions.toggleMark.mock.calls).toEqual([["strong"]]);
    expect(f.actions.undo).toHaveBeenCalledOnce();
    expect(f.actions.redo).toHaveBeenCalledOnce();
    expect(f.onComment).toHaveBeenCalledOnce();

    f.session.set({ canUndo: false, canRedo: false });
    rendered.update({ toolbar: f.props, boundary: 3 });
    f.session.set({ canUndo: true, canRedo: true });
    rendered.update({ toolbar: f.props, boundary: 4 });
    current = capturePublication();
    activate(button(current, "Undo"));
    activate(button(current, "Redo"));
    expect(f.actions.undo).toHaveBeenCalledTimes(2);
    expect(f.actions.redo).toHaveBeenCalledTimes(2);
  });

  it("allows format toggles from each later publication without reviving an earlier claim", () => {
    const f = fixture();
    const rendered = directRender({ toolbar: f.props });
    const first = capturePublication();
    activate(button(first, "Bold"));

    const pressed = { ...f.props, format: format({ strong: true }) };
    rendered.update({ toolbar: pressed, boundary: 1 });
    const second = capturePublication();
    activate(button(first, "Bold"));
    activate(button(second, "Bold"));

    const cleared = { ...f.props, format: format({ strong: false }) };
    rendered.update({ toolbar: cleared, boundary: 2 });
    const third = capturePublication();
    activate(button(second, "Bold"));
    activate(button(third, "Bold"));
    expect(f.actions.toggleMark.mock.calls).toEqual([["strong"], ["strong"], ["strong"]]);
  });

  it("fails closed when consumed format values or permissions change ahead of their replacement commit", () => {
    const f = fixture();
    const rendered = directRender({ toolbar: f.props });
    const stale = capturePublication();
    const staleMouse = controlEvent(button(stale, "Bold"), button(stale, "Bold").element, "mousedown");
    const staleKey = keyEvent(stale.root, "ArrowRight");

    f.currentFormat.strong = true;
    activate(button(stale, "Bold"));
    button(stale, "Bold").mouseDown(staleMouse);
    stale.keyDown(staleKey);
    expect(f.actions.toggleMark).not.toHaveBeenCalled();
    expect(staleMouse.preventDefault).not.toHaveBeenCalled();
    expect(staleKey.preventDefault).not.toHaveBeenCalled();

    f.currentFormat.strong = false;
    f.session.mutate({ canUndo: false });
    activate(button(stale, "Bold"));
    activate(button(stale, "Undo"));
    expect(f.actions.toggleMark).not.toHaveBeenCalled();
    expect(f.actions.undo).not.toHaveBeenCalled();

    f.session.mutate({ canUndo: true });
    rendered.update({ toolbar: { ...f.props, format: format() }, boundary: 1 });
    const current = capturePublication();
    activate(button(stale, "Bold"));
    activate(button(current, "Bold"));
    expect(f.actions.toggleMark.mock.calls).toEqual([["strong"]]);
  });

  it("binds focus and roving keys to the exact enabled button set and publication", () => {
    const f = fixture({ session: controlledSession({ canUndo: false }) });
    const rendered = directRender({ toolbar: f.props });
    const stale = capturePublication();
    const italic = button(stale, "Italic").element;
    const strike = button(stale, "Strikethrough").element;
    italic.focus();
    stale.focus(focusEvent(stale.root, italic.firstElementChild ?? italic));
    expect(italic.tabIndex).toBe(0);

    const focusStrike = vi.spyOn(strike, "focus");
    const right = keyEvent(stale.root, "ArrowRight");
    stale.keyDown(right);
    stale.keyDown(right);
    expect(right.preventDefault).toHaveBeenCalledOnce();
    expect(focusStrike).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(strike);

    for (const event of [
      keyEvent(stale.root, "ArrowRight", { shiftKey: true }),
      keyEvent(stale.root, "ArrowRight", { ctrlKey: true }),
      keyEvent(stale.root, "ArrowDown"),
    ]) {
      stale.keyDown(event);
      expect(event.preventDefault).not.toHaveBeenCalled();
    }

    const comment = button(stale, "Comment").element;
    const focusComment = vi.spyOn(comment, "focus");
    const end = keyEvent(stale.root, "End");
    stale.keyDown(end);
    expect(end.preventDefault).toHaveBeenCalledOnce();
    expect(focusComment).toHaveBeenCalledOnce();
    const heading = button(stale, "Text style").element;
    const focusHeading = vi.spyOn(heading, "focus");
    const home = keyEvent(stale.root, "Home");
    stale.keyDown(home);
    expect(home.preventDefault).toHaveBeenCalledOnce();
    expect(focusHeading).toHaveBeenCalledOnce();

    f.session.set({ canUndo: true, canRedo: false });
    let current!: ReturnType<typeof capturePublication>;
    const staleKey = keyEvent(stale.root, "End");
    const before = screen.getAllByRole("button").map((element) => (element as HTMLButtonElement).tabIndex);
    rendered.update({
      toolbar: f.props,
      boundary: 1,
      onBoundary: () => {
        current = capturePublication();
        stale.focus(focusEvent(stale.root, italic));
        stale.keyDown(staleKey);
      },
    });
    expect(staleKey.preventDefault).not.toHaveBeenCalled();
    expect(screen.getAllByRole("button").map((element) => (element as HTMLButtonElement).tabIndex)).toEqual(before);

    const currentEnd = keyEvent(current.root, "End");
    current.keyDown(currentEnd);
    expect(currentEnd.preventDefault).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(button(current, "Comment").element);
    expect(button(current, "Undo").element).toBeEnabled();
    expect(button(current, "Redo").element).toBeDisabled();
  });
});
