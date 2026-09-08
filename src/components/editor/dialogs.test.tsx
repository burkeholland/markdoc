// @vitest-environment jsdom
import {
  useEffect,
  useLayoutEffect,
  type ChangeEvent,
  type FormEvent,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type RefCallback,
} from "react";
import { createRoot } from "react-dom/client";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const primitiveCapture = vi.hoisted(() => ({ latest: new Map<string, unknown>() }));

vi.mock("@/components/ui/primitives", async () => {
  const React = await import("react");
  const handlerNames = ["onChange", "onClick", "onFocus", "onKeyDown", "onMouseEnter", "onMouseLeave", "onSubmit"] as const;

  const collectHandlers = (node: ReactNode, title: string) => {
    React.Children.forEach(node, (child) => {
      if (!React.isValidElement<Record<string, unknown>>(child)) return;
      const props = child.props;
      const children = props.children as ReactNode;
      const label = child.type === "form" ? "form" : props["data-testid"] ?? props["aria-label"] ?? (typeof children === "string" ? children : null);
      if (typeof label === "string") {
        for (const handlerName of handlerNames) {
          const handler = props[handlerName];
          if (typeof handler === "function") primitiveCapture.latest.set(`${title}.${label}.${handlerName}`, handler);
        }
      }
      collectHandlers(children, title);
    });
  };

  return {
    Dialog({
      open,
      onOpenChange,
      children,
    }: {
      open: boolean;
      onOpenChange: (open: boolean) => void;
      children: ReactNode;
    }) {
      primitiveCapture.latest.set("dialog.onOpenChange", onOpenChange);
      return open ? React.createElement(React.Fragment, null, children) : null;
    },
    DialogContent({
      title,
      children,
      onClosed,
    }: {
      title: string;
      children: ReactNode;
      onClosed?: () => void;
    }) {
      collectHandlers(children, title);
      if (onClosed) primitiveCapture.latest.set(`${title}.onClosed`, onClosed);
      return React.createElement("div", { role: "dialog", "aria-label": title }, children);
    },
    Kbd({ children }: { children: ReactNode }) {
      return React.createElement("kbd", null, children);
    },
  };
});

import { ImageDialog, LinkDialog, TableDialog } from "./dialogs";

interface UploadResult {
  url: string;
  alt?: string;
}

interface LinkActions {
  onOpenChange: ReturnType<typeof vi.fn<(open: boolean) => void>>;
  onSubmit: ReturnType<typeof vi.fn<(href: string, text: string) => void>>;
  onRemove: ReturnType<typeof vi.fn<() => void>>;
}

interface ImageActions {
  onOpenChange: ReturnType<typeof vi.fn<(open: boolean) => void>>;
  onSubmit: ReturnType<typeof vi.fn<(src: string, alt: string) => void>>;
  onUpload: ReturnType<typeof vi.fn<(file: File) => Promise<UploadResult>>>;
}

interface TableActions {
  onOpenChange: ReturnType<typeof vi.fn<(open: boolean) => void>>;
  onSubmit: ReturnType<typeof vi.fn<(rows: number, cols: number) => void>>;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function captured<T>(key: string): T {
  const value = primitiveCapture.latest.get(key);
  expect(value, `captured handler ${key}`).toBeTypeOf("function");
  return value as T;
}

function reactProp<T>(element: HTMLElement, name: string): T {
  const propsKey = Object.keys(element).find((key) => key.startsWith("__reactProps$"));
  if (!propsKey) throw new Error(`React props were not attached to ${element.dataset.testid ?? element.tagName}`);
  const props = (element as unknown as Record<string, Record<string, unknown> | undefined>)[propsKey];
  const value = props?.[name];
  if (typeof value !== "function") throw new Error(`${name} was not attached to ${element.dataset.testid ?? element.tagName}`);
  return value as T;
}

type LinkChangeHandler = (event: ChangeEvent<HTMLInputElement>) => void;
type LinkSubmitHandler = (event: FormEvent<HTMLFormElement>) => void;
type LinkClickHandler = (event: ReactMouseEvent<HTMLButtonElement>) => void;

interface LinkControls {
  content: HTMLDivElement;
  form: HTMLFormElement;
  url: HTMLInputElement;
  text: HTMLInputElement;
  removeSlot: HTMLButtonElement | HTMLSpanElement;
  remove: HTMLButtonElement | null;
  cancel: HTMLButtonElement;
  apply: HTMLButtonElement;
  changeUrl: LinkChangeHandler;
  changeText: LinkChangeHandler;
  submit: LinkSubmitHandler;
  clickRemove: LinkClickHandler | null;
  clickCancel: LinkClickHandler;
  openChange: (open: boolean) => void;
  closed: () => void;
  formRef: RefCallback<HTMLFormElement>;
  urlRef: RefCallback<HTMLInputElement>;
  textRef: RefCallback<HTMLInputElement>;
  removeSlotRef: RefCallback<HTMLButtonElement | HTMLSpanElement>;
  cancelRef: RefCallback<HTMLButtonElement>;
  applyRef: RefCallback<HTMLButtonElement>;
}

function captureLinkControls(): LinkControls {
  const content = screen.getByRole("dialog") as HTMLDivElement;
  const url = screen.getByTestId("link-url") as HTMLInputElement;
  const text = screen.getByTestId("link-text") as HTMLInputElement;
  const apply = screen.getByTestId("link-submit") as HTMLButtonElement;
  const form = apply.form;
  if (!form) throw new Error("The Apply button has no form");
  const actions = form.children.item(2);
  const removeSlot = actions?.children.item(0);
  const closingActions = actions?.children.item(1);
  const cancel = closingActions?.children.item(0);
  if (
    !(removeSlot instanceof HTMLButtonElement || removeSlot instanceof HTMLSpanElement) ||
    !(cancel instanceof HTMLButtonElement)
  ) {
    throw new Error("The Link action controls were not rendered");
  }
  const remove = removeSlot instanceof HTMLButtonElement ? removeSlot : null;
  const title = content.getAttribute("aria-label");
  if (!title) throw new Error("The Link dialog has no accessible title");
  return {
    content,
    form,
    url,
    text,
    removeSlot,
    remove,
    cancel,
    apply,
    changeUrl: reactProp(url, "onChange"),
    changeText: reactProp(text, "onChange"),
    submit: reactProp(form, "onSubmit"),
    clickRemove: remove ? reactProp(remove, "onClick") : null,
    clickCancel: reactProp(cancel, "onClick"),
    openChange: captured("dialog.onOpenChange"),
    closed: captured(`${title}.onClosed`),
    formRef: reactProp(form, "ref"),
    urlRef: reactProp(url, "ref"),
    textRef: reactProp(text, "ref"),
    removeSlotRef: reactProp(removeSlot, "ref"),
    cancelRef: reactProp(cancel, "ref"),
    applyRef: reactProp(apply, "ref"),
  };
}

function nativeInputEvent(input: HTMLInputElement, type: "input" | "change" = "input", target: EventTarget | null = input) {
  const EventConstructor = input.ownerDocument.defaultView?.Event;
  if (!EventConstructor) throw new Error("The input has no owner-document Event");
  const event = new EventConstructor(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "target", { configurable: true, value: target });
  return event;
}

function directLinkChange(
  handler: LinkChangeHandler,
  input: HTMLInputElement,
  {
    currentTarget = input,
    target = input,
    type = "change",
    nativeType = "input",
    nativeTarget = target,
    nativeEvent = nativeInputEvent(input, nativeType, nativeTarget),
    defaultPrevented = false,
  }: {
    currentTarget?: HTMLInputElement;
    target?: EventTarget | null;
    type?: string;
    nativeType?: "input" | "change";
    nativeTarget?: EventTarget | null;
    nativeEvent?: Event;
    defaultPrevented?: boolean;
  } = {},
) {
  handler({
    type,
    currentTarget,
    target,
    nativeEvent,
    defaultPrevented,
  } as unknown as ChangeEvent<HTMLInputElement>);
}

function nativeClickEvent(button: HTMLButtonElement, type = "click", target: EventTarget | null = button) {
  const MouseEventConstructor = button.ownerDocument.defaultView?.MouseEvent;
  if (!MouseEventConstructor) throw new Error("The button has no owner-document MouseEvent");
  const event = new MouseEventConstructor(type, { bubbles: true, cancelable: true, button: 0 });
  Object.defineProperty(event, "target", { configurable: true, value: target });
  return event;
}

function directLinkClick(
  handler: LinkClickHandler,
  button: HTMLButtonElement,
  {
    currentTarget = button,
    target = button,
    type = "click",
    nativeType = "click",
    nativeTarget = target,
    nativeEvent = nativeClickEvent(button, nativeType, nativeTarget),
    defaultPrevented = false,
  }: {
    currentTarget?: HTMLButtonElement;
    target?: EventTarget | null;
    type?: string;
    nativeType?: string;
    nativeTarget?: EventTarget | null;
    nativeEvent?: Event;
    defaultPrevented?: boolean;
  } = {},
) {
  handler({
    type,
    currentTarget,
    target,
    nativeEvent,
    defaultPrevented,
  } as unknown as ReactMouseEvent<HTMLButtonElement>);
}

function nativeSubmitEvent(
  form: HTMLFormElement,
  submitter: HTMLElement | null = null,
  type = "submit",
  target: EventTarget | null = form,
) {
  const SubmitEventConstructor = form.ownerDocument.defaultView?.SubmitEvent;
  if (!SubmitEventConstructor) throw new Error("The form has no owner-document SubmitEvent");
  const event = new SubmitEventConstructor(type, { bubbles: true, cancelable: true, submitter });
  Object.defineProperty(event, "target", { configurable: true, value: target });
  return event;
}

function directLinkSubmit(
  controls: LinkControls,
  {
    currentTarget = controls.form,
    target = controls.form,
    type = "submit",
    submitter = controls.apply,
    nativeTarget = target,
    nativeEvent = nativeSubmitEvent(controls.form, submitter, type, nativeTarget),
    defaultPrevented = false,
  }: {
    currentTarget?: HTMLFormElement;
    target?: EventTarget | null;
    type?: string;
    submitter?: HTMLElement | null;
    nativeTarget?: EventTarget | null;
    nativeEvent?: Event;
    defaultPrevented?: boolean;
  } = {},
) {
  const preventDefault = vi.fn(() => nativeEvent.preventDefault());
  controls.submit({
    type,
    currentTarget,
    target,
    nativeEvent,
    defaultPrevented,
    preventDefault,
  } as unknown as FormEvent<HTMLFormElement>);
  return preventDefault;
}

function inputChange(value: string): ChangeEvent<HTMLInputElement> {
  return { target: { value } } as ChangeEvent<HTMLInputElement>;
}

function fileChange(file: File): ChangeEvent<HTMLInputElement> {
  return { target: { files: [file] } } as unknown as ChangeEvent<HTMLInputElement>;
}

function formSubmit(): FormEvent<HTMLFormElement> {
  return { preventDefault: vi.fn() } as unknown as FormEvent<HTMLFormElement>;
}

function keyDown(key: string): KeyboardEvent<HTMLDivElement> {
  return { key, ctrlKey: false, metaKey: false, preventDefault: vi.fn() } as unknown as KeyboardEvent<HTMLDivElement>;
}

function PassiveCleanupProbe({ visit, onCleanup }: { visit: string; onCleanup: () => void }) {
  useEffect(() => onCleanup, [onCleanup, visit]);
  return null;
}

function ParentLayoutBoundary({
  visit,
  present = true,
  boundary = 0,
  onBoundary,
  onPassiveCleanup,
  children,
}: {
  visit: string;
  present?: boolean;
  boundary?: number;
  onBoundary?: () => void;
  onPassiveCleanup: () => void;
  children: ReactNode;
}) {
  useLayoutEffect(() => {
    if (boundary > 0) onBoundary?.();
  }, [boundary, onBoundary]);
  if (!present) return null;
  return (
    <>
      {children}
      <PassiveCleanupProbe visit={visit} onCleanup={onPassiveCleanup} />
    </>
  );
}

function link(actions: LinkActions, initial: { href: string; text: string } | null = null, open = true) {
  return <LinkDialog open={open} initial={initial} {...actions} />;
}

function image(actions: ImageActions) {
  return <ImageDialog open {...actions} />;
}

function table(actions: TableActions) {
  return <TableDialog open {...actions} />;
}

function setFileInputValue(value: string) {
  Object.defineProperty(screen.getByTestId("image-file"), "value", { configurable: true, writable: true, value });
}

const unhandledRejections: unknown[] = [];
const recordUnhandledRejection = (reason: unknown) => {
  unhandledRejections.push(reason);
};

beforeEach(() => {
  primitiveCapture.latest.clear();
  unhandledRejections.length = 0;
  process.on("unhandledRejection", recordUnhandledRejection);
});

afterEach(async () => {
  cleanup();
  await Promise.resolve();
  process.off("unhandledRejection", recordUnhandledRejection);
  expect(unhandledRejections).toEqual([]);
});

describe("LinkDialog editor-action visits", () => {
  it.each(["replacement", "removal"] as const)(
    "retires a closing visit before parent layout $transition and keeps the current link usable",
    async (transition) => {
      const oldActions: LinkActions = { onOpenChange: vi.fn(), onSubmit: vi.fn(), onRemove: vi.fn() };
      const currentActions: LinkActions = { onOpenChange: vi.fn(), onSubmit: vi.fn(), onRemove: vi.fn() };
      const host = document.createElement("div");
      document.body.append(host);
      const root = createRoot(host);
      let passiveCleanups = 0;
      let passiveCleanupsAtBoundary = -1;
      const onPassiveCleanup = () => {
        passiveCleanups++;
      };

      try {
        await act(async () => {
          root.render(
            <ParentLayoutBoundary visit="old" onPassiveCleanup={onPassiveCleanup}>
              {link(oldActions, { href: "https://old.example/initial", text: "Old initial" })}
            </ParentLayoutBoundary>,
          );
        });
        fireEvent.change(screen.getByTestId("link-url"), { target: { value: "old.example/draft" } });
        fireEvent.change(screen.getByTestId("link-text"), { target: { value: "Old draft text" } });
        const old = captureLinkControls();
        directLinkSubmit(old, { submitter: null });
        expect(oldActions.onOpenChange).toHaveBeenCalledOnce();
        expect(oldActions.onSubmit).not.toHaveBeenCalled();

        let boundaryReached!: () => void;
        const atBoundary = new Promise<void>((resolve) => {
          boundaryReached = resolve;
        });
        root.render(
          <ParentLayoutBoundary
            visit="current"
            present={transition === "replacement"}
            boundary={1}
            onBoundary={() => {
              passiveCleanupsAtBoundary = passiveCleanups;
              boundaryReached();
            }}
            onPassiveCleanup={onPassiveCleanup}
          >
            {link(currentActions)}
          </ParentLayoutBoundary>,
        );
        await atBoundary;

        expect(passiveCleanupsAtBoundary).toBe(0);
        if (transition === "replacement") {
          expect(screen.getByTestId("link-url")).toHaveValue("");
          expect(screen.getByTestId("link-text")).toHaveValue("");
        } else {
          expect(screen.queryByRole("dialog")).toBeNull();
        }

        await act(async () => {
          old.url.value = "https://stale.example";
          directLinkChange(old.changeUrl, old.url);
          directLinkSubmit(old);
          directLinkClick(old.clickRemove!, old.remove!);
          old.openChange(false);
          old.closed();
        });
        expect(oldActions.onOpenChange).toHaveBeenCalledOnce();
        expect(oldActions.onSubmit).not.toHaveBeenCalled();
        expect(oldActions.onRemove).not.toHaveBeenCalled();
        expect(currentActions.onOpenChange).not.toHaveBeenCalled();
        expect(currentActions.onSubmit).not.toHaveBeenCalled();
        expect(currentActions.onRemove).not.toHaveBeenCalled();

        if (transition === "removal") {
          await act(async () => {
            root.render(
              <ParentLayoutBoundary visit="current" boundary={2} onPassiveCleanup={onPassiveCleanup}>
                {link(currentActions)}
              </ParentLayoutBoundary>,
            );
          });
        }
        fireEvent.change(screen.getByTestId("link-url"), { target: { value: " current.example/path " } });
        fireEvent.change(screen.getByTestId("link-text"), { target: { value: " Current text " } });
        const current = captureLinkControls();
        directLinkSubmit(current, { submitter: null });
        expect(currentActions.onSubmit).not.toHaveBeenCalled();
        current.closed();
        expect(currentActions.onSubmit).toHaveBeenCalledExactlyOnceWith("https://current.example/path", "Current text");
        expect(currentActions.onOpenChange).toHaveBeenCalledExactlyOnceWith(false);
      } finally {
        await act(async () => root.unmount());
        host.remove();
      }
    },
  );

  it("loads changed initial values without erasing ordinary-rerender drafts and exposes the current accessible form", () => {
    const actions: LinkActions = { onOpenChange: vi.fn(), onSubmit: vi.fn(), onRemove: vi.fn() };
    const rendered = render(link(actions, { href: "https://first.example", text: "First" }));
    expect(screen.getByRole("dialog", { name: "Edit link" })).toBeVisible();
    expect(screen.getByLabelText("URL")).toHaveAttribute("placeholder", "https://example.com");
    expect(screen.getByLabelText("URL")).toHaveAttribute("required");
    expect(screen.getByLabelText("URL")).toHaveFocus();
    expect(screen.getByLabelText("Text")).toHaveAttribute("placeholder", "Link text (optional)");

    fireEvent.change(screen.getByTestId("link-url"), { target: { value: "https://typed.example" } });
    fireEvent.change(screen.getByTestId("link-text"), { target: { value: "Typed" } });
    rendered.rerender(link(actions, { href: "https://first.example", text: "First" }));
    expect(screen.getByTestId("link-url")).toHaveValue("https://typed.example");
    expect(screen.getByTestId("link-text")).toHaveValue("Typed");

    rendered.rerender(link(actions, { href: "https://second.example", text: "Second" }));
    expect(screen.getByTestId("link-url")).toHaveValue("https://second.example");
    expect(screen.getByTestId("link-text")).toHaveValue("Second");
    const current = captureLinkControls();
    fireEvent.click(current.remove!);
    expect(actions.onRemove).not.toHaveBeenCalled();
    current.closed();
    current.closed();
    expect(actions.onRemove).toHaveBeenCalledOnce();
  });

  it.each([
    ["relative", " ../guide ", "../guide"],
    ["http", " http://example.test/guide ", "http://example.test/guide"],
    ["https domain", " example.test/path ", "https://example.test/path"],
    ["mailto", " mailto:reader@example.test ", "mailto:reader@example.test"],
    ["hash", " #details ", "#details"],
    ["path", " /docs/start ", "/docs/start"],
  ])("submits one frozen normalized %s URL and trimmed optional text from an exact keyboard submit", (_label, input, expected) => {
    const actions: LinkActions = { onOpenChange: vi.fn(), onSubmit: vi.fn(), onRemove: vi.fn() };
    render(link(actions));
    fireEvent.change(screen.getByTestId("link-url"), { target: { value: input } });
    fireEvent.change(screen.getByTestId("link-text"), { target: { value: "  Optional text  " } });
    const current = captureLinkControls();
    const prevented = directLinkSubmit(current, { submitter: null });
    expect(prevented).toHaveBeenCalledOnce();
    expect(actions.onOpenChange).toHaveBeenCalledExactlyOnceWith(false);
    expect(actions.onSubmit).not.toHaveBeenCalled();
    current.closed();
    expect(actions.onSubmit).toHaveBeenCalledExactlyOnceWith(expected, "Optional text");
  });

  it("keeps native required and disabled validation while allowing the first exact valid submission", () => {
    const actions: LinkActions = { onOpenChange: vi.fn(), onSubmit: vi.fn(), onRemove: vi.fn() };
    render(link(actions));
    const empty = captureLinkControls();
    expect(empty.url).toBeInvalid();
    expect(empty.apply).toBeDisabled();
    empty.form.requestSubmit();
    const rejected = directLinkSubmit(empty, { submitter: null });
    expect(rejected).not.toHaveBeenCalled();
    expect(actions.onOpenChange).not.toHaveBeenCalled();

    fireEvent.change(empty.url, { target: { value: "example.test" } });
    const current = captureLinkControls();
    expect(current.url).toBeValid();
    expect(current.apply).toBeEnabled();
    const accepted = directLinkSubmit(current);
    expect(accepted).toHaveBeenCalledOnce();
    current.closed();
    expect(actions.onSubmit).toHaveBeenCalledExactlyOnceWith("https://example.test", "");
  });

  it.each(["stale-before-current", "current-before-stale"] as const)(
    "keeps same-node callback replacement B usable in %s order and lets only B's close consume B's action",
    (order) => {
      const aActions: LinkActions = { onOpenChange: vi.fn(), onSubmit: vi.fn(), onRemove: vi.fn() };
      const bActions: LinkActions = { onOpenChange: vi.fn(), onSubmit: vi.fn(), onRemove: vi.fn() };
      const initial = { href: "https://same.example", text: "Same" };
      const rendered = render(link(aActions, initial));
      const a = captureLinkControls();
      rendered.rerender(link(bActions, { ...initial }));
      const b = captureLinkControls();
      expect(b.form).toBe(a.form);
      expect(b.url).toBe(a.url);
      expect(b.apply).toBe(a.apply);

      const lateCleanups = [
        a.formRef(a.form),
        a.urlRef(a.url),
        a.textRef(a.text),
        a.removeSlotRef(a.removeSlot),
        a.cancelRef(a.cancel),
        a.applyRef(a.apply),
      ];
      for (const cleanupRef of lateCleanups) {
        if (typeof cleanupRef === "function") cleanupRef();
      }
      a.formRef(null);
      a.urlRef(null);
      a.textRef(null);
      a.removeSlotRef(null);
      a.cancelRef(null);
      a.applyRef(null);

      let currentPrevented!: ReturnType<typeof directLinkSubmit>;
      let stalePrevented!: ReturnType<typeof directLinkSubmit>;
      act(() => {
        const runStale = () => {
          stalePrevented = directLinkSubmit(a);
        };
        const runCurrent = () => {
          currentPrevented = directLinkSubmit(b);
        };
        if (order === "stale-before-current") {
          runStale();
          runCurrent();
        } else {
          runCurrent();
          runStale();
        }
      });
      expect(stalePrevented).not.toHaveBeenCalled();
      expect(currentPrevented).toHaveBeenCalledOnce();
      a.closed();
      expect(bActions.onSubmit).not.toHaveBeenCalled();
      b.closed();
      a.closed();
      b.closed();
      expect(aActions.onOpenChange).not.toHaveBeenCalled();
      expect(aActions.onSubmit).not.toHaveBeenCalled();
      expect(bActions.onOpenChange).toHaveBeenCalledExactlyOnceWith(false);
      expect(bActions.onSubmit).toHaveBeenCalledExactlyOnceWith("https://same.example", "Same");
    },
  );

  it("retires initial, draft, remove mode, title, and open presentations while preserving current reset behavior", () => {
    const actions: LinkActions = { onOpenChange: vi.fn(), onSubmit: vi.fn(), onRemove: vi.fn() };
    const rendered = render(link(actions));
    const initial = captureLinkControls();
    expect(initial.remove).toBeNull();
    expect(initial.content).toHaveAccessibleName("Insert link");

    fireEvent.change(initial.url, { target: { value: "draft.example" } });
    const draftUrl = captureLinkControls();
    directLinkChange(initial.changeUrl, draftUrl.url);
    fireEvent.change(draftUrl.text, { target: { value: "Draft text" } });
    expect(screen.getByTestId("link-url")).toHaveValue("draft.example");
    expect(screen.getByTestId("link-text")).toHaveValue("Draft text");

    rendered.rerender(link(actions, { href: "https://edit.example", text: "Edit text" }));
    const edit = captureLinkControls();
    expect(edit.content).toHaveAccessibleName("Edit link");
    expect(edit.remove).not.toBeNull();
    expect(edit.url).toHaveValue("https://edit.example");
    expect(edit.text).toHaveValue("Edit text");
    directLinkChange(draftUrl.changeText, edit.text);
    directLinkClick(initial.clickCancel, edit.cancel);
    expect(actions.onOpenChange).not.toHaveBeenCalled();

    rendered.rerender(link(actions, { href: "https://edit.example", text: "Edit text" }, false));
    expect(screen.queryByRole("dialog")).toBeNull();
    edit.openChange(false);
    directLinkSubmit(edit);
    directLinkClick(edit.clickRemove!, edit.remove!);
    edit.closed();
    expect(actions.onOpenChange).not.toHaveBeenCalled();
    expect(actions.onSubmit).not.toHaveBeenCalled();
    expect(actions.onRemove).not.toHaveBeenCalled();

    rendered.rerender(link(actions, { href: "https://edit.example", text: "Edit text" }));
    const reopened = captureLinkControls();
    expect(reopened.url).toHaveValue("https://edit.example");
    expect(reopened.text).toHaveValue("Edit text");
    fireEvent.click(reopened.cancel);
    expect(actions.onOpenChange).toHaveBeenCalledExactlyOnceWith(false);
    reopened.closed();
    expect(actions.onSubmit).not.toHaveBeenCalled();
    expect(actions.onRemove).not.toHaveBeenCalled();
  });

  it.each([
    ["dialog content", "content"],
    ["form", "form"],
    ["URL input", "url"],
    ["Text input", "text"],
    ["Remove button", "removeSlot"],
    ["Cancel button", "cancel"],
    ["Apply button", "apply"],
    ["placeholder", "placeholder"],
  ] as const)("rejects a cloned or replaced exact %s and republishes one usable current dialog", (_label, part) => {
    const actions: LinkActions = { onOpenChange: vi.fn(), onSubmit: vi.fn(), onRemove: vi.fn() };
    const initial = part === "placeholder" ? null : { href: "https://current.example", text: "Current" };
    const rendered = render(link(actions, initial));
    const stale = captureLinkControls();
    const replace = <T extends HTMLElement>(original: T, attempt: (replacement: T) => void) => {
      const replacement = original.cloneNode(true) as T;
      original.replaceWith(replacement);
      attempt(replacement);
      stale.openChange(false);
      stale.closed();
      replacement.replaceWith(original);
    };
    if (part === "url") {
      replace(stale.url, (replacement) => {
        replacement.value = "https://replacement.example";
        directLinkChange(stale.changeUrl, replacement);
      });
    } else if (part === "text") {
      replace(stale.text, (replacement) => {
        replacement.value = "Replacement";
        directLinkChange(stale.changeText, replacement);
      });
    } else if (part === "form") {
      replace(stale.form, (replacement) => {
        directLinkSubmit(stale, { currentTarget: replacement, target: replacement, nativeTarget: replacement });
      });
    } else if (part === "removeSlot" || part === "placeholder") {
      replace(stale.removeSlot, (replacement) => {
        if (stale.clickRemove && replacement instanceof HTMLButtonElement) directLinkClick(stale.clickRemove, replacement);
        else directLinkClick(stale.clickCancel, stale.cancel);
      });
    } else if (part === "cancel") {
      replace(stale.cancel, (replacement) => directLinkClick(stale.clickCancel, replacement));
    } else if (part === "apply") {
      replace(stale.apply, () => directLinkSubmit(stale));
    } else {
      replace(stale.content, () => directLinkClick(stale.clickCancel, stale.cancel));
    }
    expect(actions.onOpenChange).not.toHaveBeenCalled();
    expect(actions.onSubmit).not.toHaveBeenCalled();
    expect(actions.onRemove).not.toHaveBeenCalled();

    rendered.rerender(link(actions, initial ? { ...initial } : null));
    const current = captureLinkControls();
    fireEvent.click(current.cancel);
    expect(actions.onOpenChange).toHaveBeenCalledExactlyOnceWith(false);
  });

  it("accepts only exact URL and Text native change provenance without poisoning the current controls", () => {
    const actions: LinkActions = { onOpenChange: vi.fn(), onSubmit: vi.fn(), onRemove: vi.fn() };
    render(link(actions, { href: "https://initial.example", text: "Initial" }));
    const current = captureLinkControls();
    const foreign = document.createElement("input");
    const detached = document.createElement("input");
    const sibling = document.createElement("input");
    document.body.append(foreign);
    current.form.append(sibling);

    try {
      directLinkChange(current.changeUrl, foreign);
      directLinkChange(current.changeUrl, detached);
      directLinkChange(current.changeUrl, sibling);
      directLinkChange(current.changeUrl, current.text);
      directLinkChange(current.changeText, current.url);
      current.form.removeChild(sibling);
      const stableMarkup = current.content.innerHTML;
      directLinkChange(current.changeUrl, current.url, { target: foreign, nativeTarget: foreign });
      directLinkChange(current.changeUrl, current.url, { type: "click" });
      directLinkChange(current.changeUrl, current.url, { nativeEvent: nativeClickEvent(current.cancel) });
      directLinkChange(current.changeUrl, current.url, {
        nativeEvent: nativeInputEvent(current.url, "input", current.text),
      });
      current.url.disabled = true;
      directLinkChange(current.changeUrl, current.url);
      current.url.disabled = false;
      current.changeUrl(inputChange("https://fabricated.example"));
      expect(current.content.innerHTML).toBe(stableMarkup);
      expect(actions.onOpenChange).not.toHaveBeenCalled();

      fireEvent.change(current.url, { target: { value: "accepted.example/path" } });
      const afterUrl = captureLinkControls();
      expect(afterUrl.url).toHaveValue("accepted.example/path");
      fireEvent.change(afterUrl.text, { target: { value: "Accepted text" } });
      expect(screen.getByTestId("link-text")).toHaveValue("Accepted text");
      expect(actions.onOpenChange).not.toHaveBeenCalled();
    } finally {
      foreign.remove();
      detached.remove();
      sibling.remove();
    }
  });

  it("requires exact native Apply provenance, claims before reentrancy, and runs one matching close action", () => {
    const actions: LinkActions = { onOpenChange: vi.fn(), onSubmit: vi.fn(), onRemove: vi.fn() };
    render(link(actions, { href: "https://apply.example", text: "Apply" }));
    const current = captureLinkControls();
    const foreignForm = document.createElement("form");
    const foreignButton = document.createElement("button");
    const detachedButton = document.createElement("button");
    foreignForm.append(foreignButton);
    document.body.append(foreignForm);

    try {
      const attempts = [
        directLinkSubmit(current, { currentTarget: foreignForm, target: foreignForm, nativeTarget: foreignForm }),
        directLinkSubmit(current, { target: foreignForm }),
        directLinkSubmit(current, { nativeTarget: foreignForm }),
        directLinkSubmit(current, { submitter: foreignButton }),
        directLinkSubmit(current, { submitter: detachedButton }),
        directLinkSubmit(current, { type: "change" }),
        directLinkSubmit(current, { nativeEvent: nativeInputEvent(current.url, "change", current.form) }),
        directLinkSubmit(current, { defaultPrevented: true }),
      ];
      expect(attempts.map((attempt) => attempt.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
      expect(actions.onOpenChange).not.toHaveBeenCalled();
      expect(actions.onSubmit).not.toHaveBeenCalled();

      let reentrantPrevention: ReturnType<typeof directLinkSubmit> | null = null;
      actions.onOpenChange.mockImplementationOnce(() => {
        reentrantPrevention = directLinkSubmit(current);
      });
      const accepted = directLinkSubmit(current);
      const repeated = directLinkSubmit(current);
      expect(accepted).toHaveBeenCalledOnce();
      expect(repeated).not.toHaveBeenCalled();
      expect(reentrantPrevention).not.toBeNull();
      expect(reentrantPrevention!).not.toHaveBeenCalled();
      expect(actions.onOpenChange).toHaveBeenCalledExactlyOnceWith(false);
      expect(actions.onSubmit).not.toHaveBeenCalled();
      current.closed();
      current.closed();
      expect(actions.onSubmit).toHaveBeenCalledExactlyOnceWith("https://apply.example", "Apply");
    } finally {
      foreignForm.remove();
      detachedButton.remove();
    }
  });

  it("requires exact native Remove and Cancel provenance and leaves rejected attempts harmless", () => {
    const removeActions: LinkActions = { onOpenChange: vi.fn(), onSubmit: vi.fn(), onRemove: vi.fn() };
    const rendered = render(link(removeActions, { href: "https://remove.example", text: "Remove" }));
    const current = captureLinkControls();
    const foreign = document.createElement("button");
    const detached = document.createElement("button");
    document.body.append(foreign);
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    focus.mockClear();

    try {
      directLinkClick(current.clickRemove!, current.remove!, { currentTarget: foreign });
      directLinkClick(current.clickRemove!, current.remove!, { target: foreign, nativeTarget: foreign });
      directLinkClick(current.clickRemove!, detached);
      directLinkClick(current.clickRemove!, current.remove!, { type: "mousedown" });
      directLinkClick(current.clickRemove!, current.remove!, { nativeType: "mousedown" });
      directLinkClick(current.clickRemove!, current.remove!, {
        nativeEvent: nativeInputEvent(current.url, "input", current.remove),
      });
      directLinkClick(current.clickRemove!, current.remove!, {
        nativeEvent: nativeClickEvent(current.remove!, "click", current.cancel),
      });
      directLinkClick(current.clickCancel, current.remove!);
      current.remove!.disabled = true;
      directLinkClick(current.clickRemove!, current.remove!);
      current.remove!.disabled = false;
      expect(removeActions.onOpenChange).not.toHaveBeenCalled();
      expect(removeActions.onRemove).not.toHaveBeenCalled();
      expect(focus).not.toHaveBeenCalled();

      directLinkClick(current.clickRemove!, current.remove!);
      directLinkClick(current.clickRemove!, current.remove!);
      expect(removeActions.onOpenChange).toHaveBeenCalledExactlyOnceWith(false);
      current.closed();
      current.closed();
      expect(removeActions.onRemove).toHaveBeenCalledOnce();
      expect(removeActions.onSubmit).not.toHaveBeenCalled();

      const cancelActions: LinkActions = { onOpenChange: vi.fn(), onSubmit: vi.fn(), onRemove: vi.fn() };
      rendered.rerender(link(cancelActions));
      const cancel = captureLinkControls();
      directLinkClick(cancel.clickCancel, cancel.cancel);
      directLinkClick(cancel.clickCancel, cancel.cancel);
      cancel.closed();
      expect(cancelActions.onOpenChange).toHaveBeenCalledExactlyOnceWith(false);
      expect(cancelActions.onSubmit).not.toHaveBeenCalled();
      expect(cancelActions.onRemove).not.toHaveBeenCalled();
    } finally {
      foreign.remove();
      detached.remove();
    }
  });

  it("retires an equal-looking keyed remount and cannot let late old refs or close callbacks clear the replacement", () => {
    const actions: LinkActions = { onOpenChange: vi.fn(), onSubmit: vi.fn(), onRemove: vi.fn() };
    const initial = { href: "https://equal.example", text: "Equal" };
    const rendered = render(<LinkDialog key="a" open initial={initial} {...actions} />);
    const a = captureLinkControls();
    rendered.rerender(<LinkDialog key="b" open initial={{ ...initial }} {...actions} />);
    const b = captureLinkControls();
    expect(b.form).not.toBe(a.form);

    a.formRef(a.form);
    a.urlRef(a.url);
    a.textRef(a.text);
    a.removeSlotRef(a.removeSlot);
    a.cancelRef(a.cancel);
    a.applyRef(a.apply);
    a.formRef(null);
    a.urlRef(null);
    a.textRef(null);
    a.removeSlotRef(null);
    a.cancelRef(null);
    a.applyRef(null);
    directLinkSubmit(a);
    a.openChange(false);
    a.closed();
    expect(actions.onOpenChange).not.toHaveBeenCalled();
    expect(actions.onSubmit).not.toHaveBeenCalled();

    directLinkSubmit(b);
    a.closed();
    expect(actions.onSubmit).not.toHaveBeenCalled();
    b.closed();
    expect(actions.onOpenChange).toHaveBeenCalledExactlyOnceWith(false);
    expect(actions.onSubmit).toHaveBeenCalledExactlyOnceWith("https://equal.example", "Equal");
  });
});

describe("ImageDialog editor-action visits", () => {
  it.each(
    (["replacement", "removal"] as const).flatMap((transition) =>
      (["success", "failure"] as const).map((settlement) => ({ transition, settlement })),
    ),
  )("retires an old upload $settlement before parent layout $transition without touching the current upload", async ({ transition, settlement }) => {
    const oldPending = deferred<UploadResult>();
    const currentPending = deferred<UploadResult>();
    const oldActions: ImageActions = { onOpenChange: vi.fn(), onSubmit: vi.fn(), onUpload: vi.fn(() => oldPending.promise) };
    const currentActions: ImageActions = { onOpenChange: vi.fn(), onSubmit: vi.fn(), onUpload: vi.fn(() => currentPending.promise) };
    const oldFile = new File(["old"], "old.png", { type: "image/png" });
    const currentFile = new File(["current"], "current.webp", { type: "image/webp" });
    const readOldUrl = vi.fn(() => "/api/assets/old");
    const readOldAlt = vi.fn(() => "Old upload");
    const oldResult = {} as UploadResult;
    Object.defineProperties(oldResult, {
      url: { get: readOldUrl },
      alt: { get: readOldAlt },
    });
    const readOldError = vi.fn(() => "Old upload failed");
    const oldError = new Error();
    Object.defineProperty(oldError, "message", { get: readOldError });
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    let passiveCleanups = 0;
    let passiveCleanupsAtBoundary = -1;
    const onPassiveCleanup = () => {
      passiveCleanups++;
    };

    try {
      await act(async () => {
        root.render(
          <ParentLayoutBoundary visit="old" onPassiveCleanup={onPassiveCleanup}>
            {image(oldActions)}
          </ParentLayoutBoundary>,
        );
      });
      fireEvent.change(screen.getByTestId("image-url"), { target: { value: "https://old.example/draft.png" } });
      fireEvent.change(screen.getByTestId("image-alt"), { target: { value: "Old alt draft" } });
      fireEvent.change(screen.getByTestId("image-file"), { target: { files: [oldFile] } });
      expect(oldActions.onUpload).toHaveBeenCalledOnce();
      expect(screen.getByTestId("image-upload")).toHaveTextContent("Uploading…");
      const oldUrlChange = captured<(event: ChangeEvent<HTMLInputElement>) => void>("Insert image.image-url.onChange");
      const oldAltChange = captured<(event: ChangeEvent<HTMLInputElement>) => void>("Insert image.image-alt.onChange");
      const oldFileChange = captured<(event: ChangeEvent<HTMLInputElement>) => void>("Insert image.image-file.onChange");
      const oldSubmit = captured<(event: FormEvent<HTMLFormElement>) => void>("Insert image.form.onSubmit");
      const oldClose = captured<(open: boolean) => void>("dialog.onOpenChange");
      const oldClosed = captured<() => void>("Insert image.onClosed");

      let boundaryReached!: () => void;
      const atBoundary = new Promise<void>((resolve) => {
        boundaryReached = resolve;
      });
      root.render(
        <ParentLayoutBoundary
          visit="current"
          present={transition === "replacement"}
          boundary={1}
          onBoundary={() => {
            passiveCleanupsAtBoundary = passiveCleanups;
            if (transition === "replacement") {
              const input = screen.getByTestId("image-file");
              setFileInputValue("current-selection");
              Object.defineProperty(input, "files", {
                configurable: true,
                value: [currentFile],
              });
              input.dispatchEvent(
                new Event("change", { bubbles: true, cancelable: true }),
              );
            }
            if (settlement === "success") oldPending.resolve(oldResult);
            else oldPending.reject(oldError);
            boundaryReached();
          }}
          onPassiveCleanup={onPassiveCleanup}
        >
          {image(currentActions)}
        </ParentLayoutBoundary>,
      );
      await atBoundary;
      await act(async () => {
        await Promise.allSettled([oldPending.promise]);
        await Promise.resolve();
      });

      expect(passiveCleanupsAtBoundary).toBe(0);
      expect(readOldUrl).not.toHaveBeenCalled();
      expect(readOldAlt).not.toHaveBeenCalled();
      expect(readOldError).not.toHaveBeenCalled();
      expect(oldActions.onSubmit).not.toHaveBeenCalled();
      expect(oldActions.onOpenChange).not.toHaveBeenCalled();

      if (transition === "replacement") {
        expect(currentActions.onUpload).toHaveBeenCalledOnce();
        expect(screen.getByTestId("image-url")).toHaveValue("");
        expect(screen.getByTestId("image-alt")).toHaveValue("");
        expect(screen.queryByRole("alert")).toBeNull();
        expect(screen.getByTestId("image-upload")).toHaveTextContent("Uploading…");
        expect(screen.getByTestId("image-file")).toHaveValue("current-selection");
      } else {
        expect(screen.queryByRole("dialog")).toBeNull();
      }

      await act(async () => {
        oldUrlChange(inputChange("https://stale.example/result.png"));
        oldAltChange(inputChange("Stale alt"));
        oldFileChange(fileChange(oldFile));
        oldSubmit(formSubmit());
        oldClose(false);
        oldClosed();
      });
      expect(oldActions.onUpload).toHaveBeenCalledOnce();
      expect(oldActions.onSubmit).not.toHaveBeenCalled();
      expect(oldActions.onOpenChange).not.toHaveBeenCalled();
      expect(currentActions.onOpenChange).not.toHaveBeenCalled();

      if (transition === "removal") {
        await act(async () => {
          root.render(
            <ParentLayoutBoundary visit="current" boundary={2} onPassiveCleanup={onPassiveCleanup}>
              {image(currentActions)}
            </ParentLayoutBoundary>,
          );
        });
        fireEvent.change(screen.getByTestId("image-file"), { target: { files: [currentFile] } });
        expect(currentActions.onUpload).toHaveBeenCalledOnce();
      }

      const currentInput = screen.getByTestId("image-file") as HTMLInputElement;
      if (transition === "removal") setFileInputValue("current-selection");
      await act(async () => currentPending.resolve({ url: "/api/assets/current", alt: "Current upload" }));
      expect(screen.getByTestId("image-url")).toHaveValue("/api/assets/current");
      expect(screen.getByTestId("image-alt")).toHaveValue("Current upload");
      expect(screen.queryByRole("alert")).toBeNull();
      expect(screen.getByTestId("image-upload")).toBeEnabled();
      expect(currentInput.value).toBe("");

      fireEvent.submit(screen.getByTestId("image-submit").closest("form")!);
      expect(currentActions.onSubmit).not.toHaveBeenCalled();
      if (transition === "replacement") oldClosed();
      captured<() => void>("Insert image.onClosed")();
      expect(currentActions.onSubmit).toHaveBeenCalledOnce();
      expect(currentActions.onSubmit).toHaveBeenCalledWith("/api/assets/current", "Current upload");
      expect(currentActions.onOpenChange).toHaveBeenCalledOnce();
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it.each(["replacement", "removal"] as const)("retires a deferred image insert while closing at $transition", async (transition) => {
    const oldActions: ImageActions = { onOpenChange: vi.fn(), onSubmit: vi.fn(), onUpload: vi.fn() };
    const currentActions: ImageActions = { onOpenChange: vi.fn(), onSubmit: vi.fn(), onUpload: vi.fn() };
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const onPassiveCleanup = vi.fn();

    try {
      await act(async () => {
        root.render(
          <ParentLayoutBoundary visit="old" onPassiveCleanup={onPassiveCleanup}>
            {image(oldActions)}
          </ParentLayoutBoundary>,
        );
      });
      fireEvent.change(screen.getByTestId("image-url"), { target: { value: " https://old.example/image.png " } });
      fireEvent.change(screen.getByTestId("image-alt"), { target: { value: " Old image " } });
      fireEvent.submit(screen.getByTestId("image-submit").closest("form")!);
      const oldClosed = captured<() => void>("Insert image.onClosed");
      expect(oldActions.onOpenChange).toHaveBeenCalledOnce();

      await act(async () => {
        root.render(
          <ParentLayoutBoundary visit="current" present={transition === "replacement"} boundary={1} onPassiveCleanup={onPassiveCleanup}>
            {image(currentActions)}
          </ParentLayoutBoundary>,
        );
      });
      oldClosed();
      expect(oldActions.onSubmit).not.toHaveBeenCalled();

      if (transition === "removal") {
        await act(async () => {
          root.render(
            <ParentLayoutBoundary visit="current" boundary={2} onPassiveCleanup={onPassiveCleanup}>
              {image(currentActions)}
            </ParentLayoutBoundary>,
          );
        });
      }
      expect(screen.getByTestId("image-url")).toHaveValue("");
      expect(screen.getByTestId("image-alt")).toHaveValue("");
      fireEvent.change(screen.getByTestId("image-url"), { target: { value: " /current.png " } });
      fireEvent.submit(screen.getByTestId("image-submit").closest("form")!);
      captured<() => void>("Insert image.onClosed")();
      expect(currentActions.onSubmit).toHaveBeenCalledOnce();
      expect(currentActions.onSubmit).toHaveBeenCalledWith("/current.png", "");
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });
});

describe("TableDialog editor-action visits", () => {
  it.each(["replacement", "removal"] as const)("retires hover, focus, cell, close, and after-close handlers at parent layout $transition", async (transition) => {
    const oldActions: TableActions = { onOpenChange: vi.fn(), onSubmit: vi.fn() };
    const currentActions: TableActions = { onOpenChange: vi.fn(), onSubmit: vi.fn() };
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    let passiveCleanups = 0;
    let passiveCleanupsAtBoundary = -1;
    const onPassiveCleanup = () => {
      passiveCleanups++;
    };

    try {
      await act(async () => {
        root.render(
          <ParentLayoutBoundary visit="old" onPassiveCleanup={onPassiveCleanup}>
            {table(oldActions)}
          </ParentLayoutBoundary>,
        );
      });
      fireEvent.mouseEnter(screen.getByRole("button", { name: "5 by 6" }));
      expect(screen.getByTestId("table-grid-label")).toHaveTextContent("5 rows × 6 columns");
      const oldHover = captured<() => void>("Insert table.5 by 6.onMouseEnter");
      const oldFocus = captured<() => void>("Insert table.5 by 6.onFocus");
      const oldCell = captured<() => void>("Insert table.5 by 6.onClick");
      const oldKey = captured<(event: KeyboardEvent<HTMLDivElement>) => void>("Insert table.table-grid.onKeyDown");
      const oldClose = captured<(open: boolean) => void>("dialog.onOpenChange");
      const oldClosed = captured<() => void>("Insert table.onClosed");
      fireEvent.click(screen.getByRole("button", { name: "5 by 6" }));
      expect(oldActions.onOpenChange).toHaveBeenCalledOnce();

      let boundaryReached!: () => void;
      const atBoundary = new Promise<void>((resolve) => {
        boundaryReached = resolve;
      });
      root.render(
        <ParentLayoutBoundary
          visit="current"
          present={transition === "replacement"}
          boundary={1}
          onBoundary={() => {
            passiveCleanupsAtBoundary = passiveCleanups;
            boundaryReached();
          }}
          onPassiveCleanup={onPassiveCleanup}
        >
          {table(currentActions)}
        </ParentLayoutBoundary>,
      );
      await atBoundary;

      expect(passiveCleanupsAtBoundary).toBe(0);
      if (transition === "replacement") {
        expect(screen.getByTestId("table-grid-label")).toHaveTextContent("1 rows × 1 columns");
        expect(screen.getAllByRole("gridcell")).toHaveLength(48);
        expect(screen.getAllByRole("button").filter((button) => button.tabIndex === 0)).toHaveLength(1);
      } else {
        expect(screen.queryByRole("dialog")).toBeNull();
      }

      await act(async () => {
        oldHover();
        oldFocus();
        oldKey(keyDown("ArrowRight"));
        oldCell();
        oldClose(false);
        oldClosed();
      });
      expect(oldActions.onOpenChange).toHaveBeenCalledOnce();
      expect(oldActions.onSubmit).not.toHaveBeenCalled();
      expect(currentActions.onOpenChange).not.toHaveBeenCalled();
      expect(currentActions.onSubmit).not.toHaveBeenCalled();

      if (transition === "removal") {
        await act(async () => {
          root.render(
            <ParentLayoutBoundary visit="current" boundary={2} onPassiveCleanup={onPassiveCleanup}>
              {table(currentActions)}
            </ParentLayoutBoundary>,
          );
        });
      }
      fireEvent.focus(screen.getByRole("button", { name: "3 by 4" }));
      expect(screen.getByTestId("table-grid-label")).toHaveTextContent("3 rows × 4 columns");
      fireEvent.click(screen.getByRole("button", { name: "3 by 4" }));
      expect(currentActions.onSubmit).not.toHaveBeenCalled();
      captured<() => void>("Insert table.onClosed")();
      expect(currentActions.onSubmit).toHaveBeenCalledOnce();
      expect(currentActions.onSubmit).toHaveBeenCalledWith(3, 4);
      expect(currentActions.onOpenChange).toHaveBeenCalledOnce();
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });
});
