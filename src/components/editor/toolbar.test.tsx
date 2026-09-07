// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, within } from "@testing-library/react";
import {
  useEffect,
  useLayoutEffect,
  type ChangeEventHandler,
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
  }: {
    children: ReactNode;
    onCloseAutoFocus?: (event: { preventDefault: () => void }) => void;
  }) => (
    <div data-testid="heading-content" onBlur={onCloseAutoFocus}>
      {children}
    </div>
  ),
  MenuRadioGroup: ({
    children,
    onValueChange,
  }: {
    children: ReactNode;
    onValueChange?: (value: string) => void;
  }) => (
    <div role="radiogroup" onChange={onValueChange as unknown as ChangeEventHandler<HTMLDivElement>}>
      {children}
    </div>
  ),
  MenuRadioItem: ({
    children,
    value,
    className,
    ref,
  }: {
    children: ReactNode;
    value: string;
    className?: string;
    ref?: Ref<HTMLDivElement>;
  }) => (
    <div ref={ref} role="menuitemradio" aria-checked="false" data-value={value} className={className}>
      {children}
    </div>
  ),
}));

import { Toolbar } from "./toolbar";

type ToolbarProps = ComponentProps<typeof Toolbar>;
type ClickHandler = () => void;
type MouseDownHandler = (event: { preventDefault: () => void }) => void;
type HeadingChangeHandler = (value: string) => void;
type CloseHandler = (event: { preventDefault: () => void }) => void;
type FocusHandler = (event: { currentTarget: HTMLDivElement; target: Element }) => void;
type KeyHandler = (event: KeyEvent) => void;

interface KeyEvent {
  currentTarget: HTMLDivElement;
  key: string;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
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
  return {
    root,
    buttons,
    headingChange: reactHandler<HeadingChangeHandler>(screen.getByRole("radiogroup"), "onChange"),
    headingClose: reactHandler<CloseHandler>(screen.getByTestId("heading-content"), "onBlur"),
    focus: reactHandler<FocusHandler>(root, "onFocus"),
    keyDown: reactHandler<KeyHandler>(root, "onKeyDown"),
  };
}

function button(publication: ReturnType<typeof capturePublication>, label: (typeof BUTTON_LABELS)[number]) {
  const control = publication.buttons[label];
  if (!control) throw new Error(`${label} is not rendered`);
  return control;
}

function keyEvent(root: HTMLDivElement, key: string, modifiers: Partial<Pick<KeyEvent, "altKey" | "ctrlKey" | "metaKey" | "shiftKey">> = {}) {
  return {
    currentTarget: root,
    key,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    preventDefault: vi.fn(),
    ...modifiers,
  };
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

    f.actions.toggleMark.mockImplementation((kind: string) => {
      if (kind === "strong") button(publication, "Bold").click();
    });
    f.onImage.mockImplementation(() => button(publication, "Image").click());
    for (const label of BUTTON_LABELS.slice(1)) {
      const control = button(publication, label);
      control.click();
      control.click();
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

    const close = { preventDefault: vi.fn() };
    publication.headingClose(close);
    publication.headingClose(close);
    publication.headingClose({ preventDefault: vi.fn() });
    expect(close.preventDefault).toHaveBeenCalledOnce();
    expect(f.actions.focus).toHaveBeenCalledOnce();

    for (const label of ["Bold", "Text style", "Comment"] as const) {
      const event = { preventDefault: vi.fn() };
      const control = button(publication, label);
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
          if (order === "stale-before-current") {
            button(stale, "Bold").click();
            button(current, "Bold").click();
          } else {
            button(current, "Bold").click();
            button(stale, "Bold").click();
          }
        },
      });

      expect(passiveCleanup).toHaveBeenCalledOnce();
      expect(sharedToggle.mock.calls).toEqual([["strong"]]);
      button(stale, "Bold").click();
      expect(sharedToggle).toHaveBeenCalledOnce();
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
          button(stale, "Bold").click();
          stale.headingChange("4");
          const staleClose = { preventDefault: vi.fn() };
          stale.headingClose(staleClose);
          if (replacement === "callbacks") {
            button(stale, "Image").click();
            button(stale, "Table").click();
            button(stale, "Comment").click();
          }
          expect(staleClose.preventDefault).not.toHaveBeenCalled();
        },
      });

      expect(passiveCleanup).toHaveBeenCalledOnce();
      expect(f.actions.toggleMark).not.toHaveBeenCalled();
      expect(f.actions.setHeading).not.toHaveBeenCalled();
      expect(f.actions.focus).not.toHaveBeenCalled();
      button(current, "Bold").click();
      current.headingChange("4");
      const close = { preventDefault: vi.fn() };
      current.headingClose(close);
      if (replacement === "callbacks") {
        button(current, "Image").click();
        button(current, "Table").click();
        button(current, "Comment").click();
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
          if (order === "stale-before-current") {
            button(stale, "Bold").click();
            button(current, "Bold").click();
          } else {
            button(current, "Bold").click();
            button(stale, "Bold").click();
          }
        },
      });

      expect(sharedToggle.mock.calls).toEqual([["strong"]]);
      expect(passiveCleanup).toHaveBeenCalledOnce();
      button(stale, "Bold").click();
      expect(sharedToggle).toHaveBeenCalledOnce();
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
    const staleMouse = { preventDefault: vi.fn() };
    const staleKey = keyEvent(stale.root, "ArrowRight");
    const staleClose = { preventDefault: vi.fn() };

    rendered.update({
      toolbar: f.props,
      present: false,
      boundary: 1,
      onPassiveCleanup: passiveCleanup,
      onBoundary: () => {
        expect(passiveCleanup).not.toHaveBeenCalled();
        button(stale, "Bold").click();
        button(stale, "Bold").mouseDown(staleMouse);
        stale.headingChange("2");
        stale.headingClose(staleClose);
        stale.focus({ currentTarget: stale.root, target: button(stale, "Italic").element });
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
    button(stale, "Bold").click();
    button(current, "Bold").click();
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
        for (const label of ["Bold", "Undo", "Redo", "Comment"] as const) button(enabled, label).click();
        const mouse = { preventDefault: vi.fn() };
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
    button(current, "Bold").click();
    button(current, "Undo").click();
    button(current, "Redo").click();
    button(current, "Comment").click();
    expect(f.actions.toggleMark.mock.calls).toEqual([["strong"]]);
    expect(f.actions.undo).toHaveBeenCalledOnce();
    expect(f.actions.redo).toHaveBeenCalledOnce();
    expect(f.onComment).toHaveBeenCalledOnce();

    f.session.set({ canUndo: false, canRedo: false });
    rendered.update({ toolbar: f.props, boundary: 3 });
    f.session.set({ canUndo: true, canRedo: true });
    rendered.update({ toolbar: f.props, boundary: 4 });
    current = capturePublication();
    button(current, "Undo").click();
    button(current, "Redo").click();
    expect(f.actions.undo).toHaveBeenCalledTimes(2);
    expect(f.actions.redo).toHaveBeenCalledTimes(2);
  });

  it("allows format toggles from each later publication without reviving an earlier claim", () => {
    const f = fixture();
    const rendered = directRender({ toolbar: f.props });
    const first = capturePublication();
    button(first, "Bold").click();

    const pressed = { ...f.props, format: format({ strong: true }) };
    rendered.update({ toolbar: pressed, boundary: 1 });
    const second = capturePublication();
    button(first, "Bold").click();
    button(second, "Bold").click();

    const cleared = { ...f.props, format: format({ strong: false }) };
    rendered.update({ toolbar: cleared, boundary: 2 });
    const third = capturePublication();
    button(second, "Bold").click();
    button(third, "Bold").click();
    expect(f.actions.toggleMark.mock.calls).toEqual([["strong"], ["strong"], ["strong"]]);
  });

  it("fails closed when consumed format values or permissions change ahead of their replacement commit", () => {
    const f = fixture();
    const rendered = directRender({ toolbar: f.props });
    const stale = capturePublication();
    const staleMouse = { preventDefault: vi.fn() };
    const staleKey = keyEvent(stale.root, "ArrowRight");

    f.currentFormat.strong = true;
    button(stale, "Bold").click();
    button(stale, "Bold").mouseDown(staleMouse);
    stale.keyDown(staleKey);
    expect(f.actions.toggleMark).not.toHaveBeenCalled();
    expect(staleMouse.preventDefault).not.toHaveBeenCalled();
    expect(staleKey.preventDefault).not.toHaveBeenCalled();

    f.currentFormat.strong = false;
    f.session.mutate({ canUndo: false });
    button(stale, "Bold").click();
    button(stale, "Undo").click();
    expect(f.actions.toggleMark).not.toHaveBeenCalled();
    expect(f.actions.undo).not.toHaveBeenCalled();

    f.session.mutate({ canUndo: true });
    rendered.update({ toolbar: { ...f.props, format: format() }, boundary: 1 });
    const current = capturePublication();
    button(stale, "Bold").click();
    button(current, "Bold").click();
    expect(f.actions.toggleMark.mock.calls).toEqual([["strong"]]);
  });

  it("binds focus and roving keys to the exact enabled button set and publication", () => {
    const f = fixture({ session: controlledSession({ canUndo: false }) });
    const rendered = directRender({ toolbar: f.props });
    const stale = capturePublication();
    const italic = button(stale, "Italic").element;
    const strike = button(stale, "Strikethrough").element;
    italic.focus();
    stale.focus({ currentTarget: stale.root, target: italic.firstElementChild ?? italic });
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
        stale.focus({ currentTarget: stale.root, target: italic });
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
