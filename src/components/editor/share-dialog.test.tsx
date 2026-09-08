// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { StrictMode, useEffect, useLayoutEffect, type RefCallback } from "react";
import { flushSync } from "react-dom";
import type { DocumentDto } from "@/server/dto";

const collaborators = vi.fn();
const addCollaborator = vi.fn();
const removeCollaborator = vi.fn();
const patchDocument = vi.fn();
const tokensList = vi.fn();
const tokensCreate = vi.fn();
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  api: {
    documents: {
      collaborators: (...args: unknown[]) => collaborators(...args),
      addCollaborator: (...args: unknown[]) => addCollaborator(...args),
      removeCollaborator: (...args: unknown[]) => removeCollaborator(...args),
      patch: (...args: unknown[]) => patchDocument(...args),
    },
    tokens: {
      list: (...args: unknown[]) => tokensList(...args),
      create: (...args: unknown[]) => tokensCreate(...args),
    },
    github: {
      searchUsers: async () => ({ users: [], limited: false }),
    },
  },
}));

const copyText = vi.fn();
vi.mock("@/lib/clipboard", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/clipboard")>();
  return { ...actual, copyText: (...args: unknown[]) => copyText(...args) };
});

import { ApiError } from "@/lib/api";
import { ShareDialog } from "./share-dialog";

const DOC_ID = "doc-919";
type CollaboratorResponse = {
  owner: { login: string | null; name: string | null; image: string | null } | null;
  linkAccess: DocumentDto["linkAccess"];
  collaborators: { login: string; name: string | null; image: string | null; role: "editor" | "commenter" | "viewer" }[];
  agents: never[];
};

const doc: DocumentDto = {
  id: DOC_ID,
  title: "Share me",
  storage: "local",
  linkAccess: "private",
  ownerId: "user-alice",
  gistId: null,
  gistFile: null,
  repoOwner: null,
  repoName: null,
  repoBranch: null,
  repoPath: null,
  publishedAt: null,
  hasUnpublishedChanges: false,
  githubUrl: null,
  createdAt: "2026-08-29T00:00:00.000Z",
  updatedAt: "2026-08-29T00:00:00.000Z",
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function collaboratorResponse(owner: string, collaborator: string): CollaboratorResponse {
  return {
    owner: { login: owner, name: owner, image: null },
    linkAccess: "private",
    collaborators: [{ login: collaborator, name: collaborator, image: null, role: "editor" }],
    agents: [],
  };
}

function collaboratorRows(...logins: string[]): CollaboratorResponse {
  return {
    owner: { login: "alice", name: "Alice", image: null },
    linkAccess: "private",
    collaborators: logins.map((login) => ({ login, name: login[0].toUpperCase() + login.slice(1), image: null, role: "editor" })),
    agents: [],
  };
}

function collaboratorRow(login: string) {
  return screen.getByText(`@${login}`).closest('[data-testid="collaborator-row"]') as HTMLElement;
}

/** `a` comes before `b` in document order. */
const precedes = (a: Element, b: Element) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

interface DirectReactEvent<T extends HTMLElement> {
  type: string;
  button: number;
  currentTarget: T;
  target: EventTarget;
  nativeEvent: unknown;
  defaultPrevented: boolean;
  preventDefault: ReturnType<typeof vi.fn>;
  stopPropagation: ReturnType<typeof vi.fn>;
}

type DirectHandler<T extends HTMLElement> = (event: DirectReactEvent<T>) => void;

interface CapturedControl<T extends HTMLElement> {
  element: T;
  handler: DirectHandler<T>;
}

function reactProp<T>(element: HTMLElement, name: string): T {
  const propsKey = Object.keys(element).find((key) => key.startsWith("__reactProps$"));
  if (!propsKey) throw new Error(`React props were not attached to ${element.tagName}`);
  const props = (element as unknown as Record<string, Record<string, unknown> | undefined>)[propsKey];
  const value = props?.[name];
  if (typeof value !== "function") throw new Error(`${name} was not attached to ${element.tagName}`);
  return value as T;
}

function reactRef<T extends HTMLElement>(element: T): RefCallback<T> {
  const fiberKey = Object.keys(element).find((key) => key.startsWith("__reactFiber$"));
  if (!fiberKey) throw new Error(`React fiber was not attached to ${element.tagName}`);
  const fiber = (element as unknown as Record<string, { ref?: unknown } | undefined>)[fiberKey];
  if (typeof fiber?.ref !== "function") throw new Error(`A callback ref was not attached to ${element.tagName}`);
  return fiber.ref as RefCallback<T>;
}

function captureClick(element: HTMLButtonElement): CapturedControl<HTMLButtonElement> {
  return { element, handler: reactProp<DirectHandler<HTMLButtonElement>>(element, "onClick") };
}

function captureChange(element: HTMLSelectElement): CapturedControl<HTMLSelectElement> {
  return { element, handler: reactProp<DirectHandler<HTMLSelectElement>>(element, "onChange") };
}

function captureSubmit(element: HTMLFormElement): CapturedControl<HTMLFormElement> {
  return { element, handler: reactProp<DirectHandler<HTMLFormElement>>(element, "onSubmit") };
}

function nativeMouse(target: HTMLElement, type = "click"): MouseEvent {
  const Constructor = target.ownerDocument.defaultView?.MouseEvent;
  if (!Constructor) throw new Error("Control has no owner-document MouseEvent");
  const event = new Constructor(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "target", { configurable: true, value: target });
  return event;
}

function traversedNativeMouse(target: HTMLElement, type = "click"): MouseEvent {
  const event = nativeMouse(target, type);
  const path: EventTarget[] = [];
  let current: Node | null = target;
  while (current) {
    path.push(current);
    current = current.parentNode;
  }
  path.push(target.ownerDocument.defaultView!);
  Object.defineProperty(event, "composedPath", {
    configurable: true,
    value: () => path,
  });
  return event;
}

function nativeKeyboard(target: HTMLElement, key = "Escape"): KeyboardEvent {
  const Constructor = target.ownerDocument.defaultView?.KeyboardEvent;
  if (!Constructor) throw new Error("Control has no owner-document KeyboardEvent");
  const event = new Constructor("keydown", { bubbles: true, cancelable: true, key });
  Object.defineProperty(event, "target", { configurable: true, value: target });
  return event;
}

function nativeChange(target: HTMLSelectElement, type = "change"): Event {
  const Constructor = target.ownerDocument.defaultView?.Event;
  if (!Constructor) throw new Error("Control has no owner-document Event");
  const event = new Constructor(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "target", { configurable: true, value: target });
  return event;
}

function nativeSubmit(form: HTMLFormElement, submitter: HTMLButtonElement | null = null): SubmitEvent {
  const Constructor = form.ownerDocument.defaultView?.SubmitEvent;
  if (!Constructor) throw new Error("Form has no owner-document SubmitEvent");
  const event = new Constructor("submit", { bubbles: true, cancelable: true, submitter });
  Object.defineProperty(event, "target", { configurable: true, value: form });
  return event;
}

function directInvoke<T extends HTMLElement>(
  control: CapturedControl<T>,
  currentTarget: T = control.element,
  overrides: Partial<{
    type: string;
    target: EventTarget;
    nativeEvent: unknown;
    defaultPrevented: boolean;
  }> = {},
): DirectReactEvent<T> {
  const nativeEvent =
    overrides.nativeEvent ??
    (currentTarget instanceof HTMLSelectElement
      ? nativeChange(currentTarget)
      : currentTarget instanceof HTMLFormElement
        ? nativeSubmit(currentTarget)
        : nativeMouse(currentTarget));
  const event: DirectReactEvent<T> = {
    type:
      overrides.type ??
      (currentTarget instanceof HTMLSelectElement
        ? "change"
        : currentTarget instanceof HTMLFormElement
          ? "submit"
          : "click"),
    button: 0,
    currentTarget,
    target: overrides.target ?? currentTarget,
    nativeEvent,
    defaultPrevented: overrides.defaultPrevented ?? false,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
  };
  control.handler(event);
  return event;
}

function fireNativeSubmit(form: HTMLFormElement, submitter: HTMLButtonElement | null = null) {
  fireEvent(form, nativeSubmit(form, submitter));
}

function eventCapture(options: unknown): boolean {
  if (typeof options === "boolean") return options;
  return Boolean((options as AddEventListenerOptions | undefined)?.capture);
}

function findAddedListener(
  calls: ReadonlyArray<readonly unknown[]>,
  type: string,
  capture: boolean,
  name?: string,
) {
  const call = [...calls].reverse().find(([addedType, listener, options]) =>
    addedType === type &&
    typeof listener === "function" &&
    eventCapture(options) === capture &&
    (!name || listener.name === name)
  );
  const listener = call?.[1];
  if (typeof listener !== "function") throw new Error(`No ${capture ? "capture" : "bubble"} ${type} listener was added`);
  return listener as EventListener;
}

function activeAddedListeners(
  additions: ReadonlyArray<readonly unknown[]>,
  removals: ReadonlyArray<readonly unknown[]>,
  type: string,
  capture: boolean,
  name: string,
) {
  return additions
    .filter(([addedType, listener, options]) =>
      addedType === type &&
      typeof listener === "function" &&
      listener.name === name &&
      eventCapture(options) === capture
    )
    .map(([, listener]) => listener as EventListener)
    .filter((listener) =>
      !removals.some(([removedType, removedListener, options]) =>
        removedType === type &&
        removedListener === listener &&
        eventCapture(options) === capture
      )
    );
}

function trackPresentationResources() {
  const NativeMutationObserver = window.MutationObserver;
  const observers: { disconnected: boolean; targets: Node[] }[] = [];
  class CapturingMutationObserver implements MutationObserver {
    private readonly native: MutationObserver;
    private readonly record: { disconnected: boolean; targets: Node[] };

    constructor(callback: MutationCallback) {
      this.native = new NativeMutationObserver(callback);
      this.record = { disconnected: false, targets: [] };
      observers.push(this.record);
    }

    disconnect() {
      this.record.disconnected = true;
      this.native.disconnect();
    }

    observe(target: Node, options?: MutationObserverInit) {
      this.record.targets.push(target);
      this.native.observe(target, options);
    }

    takeRecords() {
      return this.native.takeRecords();
    }
  }

  vi.stubGlobal("MutationObserver", CapturingMutationObserver);
  const additions = vi.spyOn(window, "addEventListener");
  const removals = vi.spyOn(window, "removeEventListener");
  return {
    observers,
    presentationObservers: () =>
      observers.filter(({ targets }) =>
        targets.length === 3 &&
        targets.some((target) =>
          target instanceof HTMLElement && target.getAttribute("role") === "dialog"
        )
      ),
    activeCapture: (type: "keydown" | "click") =>
      activeAddedListeners(
        additions.mock.calls,
        removals.mock.calls,
        type,
        true,
        "remember",
      ),
    restore: () => {
      removals.mockRestore();
      additions.mockRestore();
      vi.unstubAllGlobals();
    },
  };
}

function PassiveCleanupProbe({ onCleanup }: { onCleanup: () => void }) {
  useEffect(() => onCleanup, [onCleanup]);
  return null;
}

function renderDialog(props: Partial<{ isOwner: boolean; doc: DocumentDto }> = {}) {
  return render(<ShareDialog open onOpenChange={vi.fn()} doc={props.doc ?? doc} isOwner={props.isOwner ?? true} onDocChange={vi.fn()} />);
}

function ShareDialogBoundary({
  open = true,
  currentDoc = doc,
  present = true,
  instance = 0,
  boundary = 0,
  onBoundary,
  onOpenChange = vi.fn(),
  onDocChange = vi.fn(),
}: {
  open?: boolean;
  currentDoc?: DocumentDto;
  present?: boolean;
  instance?: number;
  boundary?: number;
  onBoundary?: () => void;
  onOpenChange?: (open: boolean) => void;
  onDocChange?: (doc: DocumentDto) => void;
}) {
  useLayoutEffect(() => {
    if (boundary > 0) onBoundary?.();
  }, [boundary, onBoundary]);
  return present ? <ShareDialog key={instance} open={open} onOpenChange={onOpenChange} doc={currentDoc} isOwner onDocChange={onDocChange} /> : null;
}

/** The dialog with its people list loaded (the link row sits under it). */
async function openDialog(props: Partial<{ isOwner: boolean; doc: DocumentDto }> = {}) {
  renderDialog(props);
  await screen.findAllByTestId("collaborator-row");
  return screen.getByRole("dialog");
}

async function expandAgentCard() {
  fireEvent.click(screen.getByTestId("share-agent-toggle"));
  await waitFor(() => expect(screen.getByTestId("token-add")).toBeEnabled());
}

beforeEach(() => {
  collaborators.mockReset().mockResolvedValue({
    owner: { login: "alice", name: "Alice", image: null },
    linkAccess: "private",
    collaborators: [{ login: "bob", name: "Bob", image: null, role: "editor" }],
    agents: [],
  });
  addCollaborator.mockReset().mockResolvedValue({ ok: true, login: "bob", role: "editor", pending: false });
  removeCollaborator.mockReset().mockResolvedValue({ ok: true });
  patchDocument.mockReset().mockResolvedValue({ document: { ...doc, linkAccess: "view" } });
  tokensList.mockReset().mockResolvedValue({ tokens: [] });
  tokensCreate.mockReset().mockImplementation(async (name: string, _expires: number, options: { scope: string; documentIds: string[] | null }) => ({
    token: { id: "tok-1", name, token: "mdk_one_time_secret", prefix: "mdk_one_", scope: options.scope, documentIds: options.documentIds, createdAt: "2026-09-05T00:00:00.000Z", expiresAt: null },
  }));
  copyText.mockReset().mockResolvedValue(true);
});

afterEach(() => {
  cleanup();
});

describe("ShareDialog exact control publications", () => {
  it("owns one exact Copy link activation after direct-root Strict Mode replay and reentrant clicks", async () => {
    const attempt = deferred<boolean>();
    render(
      <StrictMode>
        <ShareDialog open onOpenChange={vi.fn()} doc={doc} isOwner onDocChange={vi.fn()} />
      </StrictMode>,
    );
    await screen.findByText("@bob");
    const button = screen.getByTestId("copy-link") as HTMLButtonElement;
    const copy = captureClick(button);
    copyText.mockImplementationOnce(() => {
      fireEvent.click(button);
      return attempt.promise;
    });

    directInvoke(copy, button, { nativeEvent: traversedNativeMouse(button) });
    directInvoke(copy, button, { nativeEvent: traversedNativeMouse(button) });
    expect(copyText).toHaveBeenCalledExactlyOnceWith(`${window.location.origin}/d/${DOC_ID}`);

    await act(async () => {
      attempt.resolve(true);
      await attempt.promise;
    });
    expect(button).toHaveTextContent("Copied");
  });

  it("clears prior feedback while a newly claimed current copy is pending", async () => {
    const pending = deferred<boolean>();
    render(
      <StrictMode>
        <ShareDialog open onOpenChange={vi.fn()} doc={doc} isOwner onDocChange={vi.fn()} />
      </StrictMode>,
    );
    await screen.findByText("@bob");
    const copy = screen.getByTestId("copy-link");

    fireEvent.click(copy);
    await waitFor(() => expect(copy).toHaveTextContent("Copied"));
    copyText.mockReturnValueOnce(pending.promise);
    fireEvent.click(copy);

    expect(copy).toHaveTextContent("Copy link");
    expect(copyText).toHaveBeenCalledTimes(2);
    await act(async () => {
      pending.resolve(true);
      await pending.promise;
    });
    expect(copy).toHaveTextContent("Copied");
  });

  it("keeps the selected fallback after its transient label expires until success or close", async () => {
    const onDocChange = vi.fn();
    const onOpenChange = vi.fn((nextOpen: boolean) => {
      view.rerender(
        <StrictMode>
          <ShareDialog open={nextOpen} onOpenChange={onOpenChange} doc={doc} isOwner onDocChange={onDocChange} />
        </StrictMode>,
      );
    });
    const view = render(
      <StrictMode>
        <ShareDialog open onOpenChange={onOpenChange} doc={doc} isOwner onDocChange={onDocChange} />
      </StrictMode>,
    );
    await screen.findByText("@bob");
    const value = `${window.location.origin}/d/${DOC_ID}`;

    vi.useFakeTimers();
    try {
      copyText.mockResolvedValueOnce(false);
      fireEvent.click(screen.getByTestId("copy-link"));
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      const fallback = screen.getByTestId("copy-link-fallback") as HTMLInputElement;
      expect(fallback).toHaveValue(value);
      expect(fallback).toHaveFocus();
      expect(fallback.selectionStart).toBe(0);
      expect(fallback.selectionEnd).toBe(value.length);

      act(() => vi.advanceTimersByTime(2100));
      expect(screen.getByTestId("copy-link-fallback")).toBe(fallback);
      expect(fallback).toHaveValue(value);
      expect(fallback).toHaveFocus();
      expect(fallback.selectionStart).toBe(0);
      expect(fallback.selectionEnd).toBe(value.length);
      expect(screen.getByTestId("copy-link")).toHaveTextContent("Copy link");

      copyText.mockResolvedValueOnce(true);
      fireEvent.click(screen.getByTestId("copy-link"));
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(screen.queryByTestId("copy-link-fallback")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears a persistent fallback when the current Share visit closes", async () => {
    const onDocChange = vi.fn();
    const onOpenChange = vi.fn((nextOpen: boolean) => {
      view.rerender(
        <StrictMode>
          <ShareDialog open={nextOpen} onOpenChange={onOpenChange} doc={doc} isOwner onDocChange={onDocChange} />
        </StrictMode>,
      );
    });
    const view = render(
      <StrictMode>
        <ShareDialog open onOpenChange={onOpenChange} doc={doc} isOwner onDocChange={onDocChange} />
      </StrictMode>,
    );
    await screen.findByText("@bob");
    copyText.mockResolvedValueOnce(false);
    fireEvent.click(screen.getByTestId("copy-link"));
    await screen.findByTestId("copy-link-fallback");

    view.rerender(
      <StrictMode>
        <ShareDialog open={false} onOpenChange={onOpenChange} doc={doc} isOwner onDocChange={onDocChange} />
      </StrictMode>,
    );
    expect(screen.queryByTestId("copy-link-fallback")).toBeNull();
  });

  it("carries one pending success through a same-URL login rerender", async () => {
    let settle: ((value: unknown) => void) | null = null;
    copyText.mockImplementationOnce(() => ({
      then(onFulfilled: (value: unknown) => void) {
        settle = onFulfilled;
      },
    }));
    render(
      <StrictMode>
        <ShareDialog open onOpenChange={vi.fn()} doc={doc} isOwner onDocChange={vi.fn()} />
      </StrictMode>,
    );
    await screen.findByText("@bob");

    fireEvent.click(screen.getByTestId("copy-link"));
    expect(copyText).toHaveBeenCalledExactlyOnceWith(`${window.location.origin}/d/${DOC_ID}`);
    fireEvent.change(screen.getByTestId("share-login"), { target: { value: "same-url" } });
    expect(screen.getByTestId("share-login")).toHaveValue("same-url");

    act(() => {
      settle?.(true);
      settle?.(false);
    });
    await waitFor(() => expect(screen.getByTestId("copy-link")).toHaveTextContent("Copied"));
    expect(screen.queryByTestId("copy-link-fallback")).toBeNull();
  });

  it("carries one pending failure through a same-URL collaborator completion", async () => {
    const permission = deferred<{ ok: boolean }>();
    addCollaborator.mockReturnValueOnce(permission.promise);
    let settle: ((value: unknown) => void) | null = null;
    copyText.mockImplementationOnce(() => ({
      then(onFulfilled: (value: unknown) => void) {
        settle = onFulfilled;
      },
    }));
    render(
      <StrictMode>
        <ShareDialog open onOpenChange={vi.fn()} doc={doc} isOwner onDocChange={vi.fn()} />
      </StrictMode>,
    );
    await screen.findByText("@bob");

    fireEvent.click(screen.getByTestId("copy-link"));
    expect(copyText).toHaveBeenCalledExactlyOnceWith(`${window.location.origin}/d/${DOC_ID}`);
    const role = within(collaboratorRow("bob")).getByRole("combobox");
    fireEvent.change(role, { target: { value: "viewer" } });
    expect(role).toBeDisabled();
    await act(async () => {
      permission.resolve({ ok: true });
      await permission.promise;
    });
    await waitFor(() => expect(role).toHaveValue("viewer"));

    act(() => {
      settle?.(false);
      settle?.(true);
    });
    const fallback = await screen.findByTestId("copy-link-fallback");
    expect(fallback).toHaveValue(`${window.location.origin}/d/${DOC_ID}`);
    expect(screen.getByTestId("copy-link")).toHaveTextContent("Select & press Ctrl+C");
  });

  it("retires a pending copy across a failed intermediate publication and recovers fresh", async () => {
    let settle: ((value: unknown) => void) | null = null;
    copyText.mockImplementationOnce(() => ({
      then(onFulfilled: (value: unknown) => void) {
        settle = onFulfilled;
      },
    }));
    render(
      <StrictMode>
        <ShareDialog open onOpenChange={vi.fn()} doc={doc} isOwner onDocChange={vi.fn()} />
      </StrictMode>,
    );
    await screen.findByText("@bob");
    const input = screen.getByTestId("share-login");
    const done = screen.getByRole("button", { name: "Done" }) as HTMLButtonElement;

    fireEvent.click(screen.getByTestId("copy-link"));
    expect(copyText).toHaveBeenCalledTimes(1);
    done.disabled = true;
    fireEvent.change(input, { target: { value: "invalid-publication" } });

    act(() => settle?.(true));
    expect(screen.getByTestId("copy-link")).toHaveTextContent("Copy link");
    expect(screen.queryByTestId("copy-link-fallback")).toBeNull();

    done.disabled = false;
    fireEvent.change(input, { target: { value: "restored-publication" } });
    fireEvent.click(screen.getByTestId("copy-link"));
    await waitFor(() => expect(screen.getByTestId("copy-link")).toHaveTextContent("Copied"));
    expect(copyText).toHaveBeenCalledTimes(2);
    expect(copyText).toHaveBeenLastCalledWith(`${window.location.origin}/d/${DOC_ID}`);
  });

  it("owns each setup expand and collapse transition after direct-root Strict Mode replay", async () => {
    render(
      <StrictMode>
        <ShareDialog open onOpenChange={vi.fn()} doc={doc} isOwner onDocChange={vi.fn()} />
      </StrictMode>,
    );
    await screen.findByText("@bob");
    const toggle = screen.getByTestId("share-agent-toggle") as HTMLButtonElement;
    const collapsed = captureClick(toggle);

    directInvoke(collapsed, toggle, { nativeEvent: traversedNativeMouse(toggle) });
    directInvoke(collapsed, toggle, { nativeEvent: traversedNativeMouse(toggle) });
    await waitFor(() => expect(toggle).toHaveAttribute("aria-expanded", "true"));

    const expanded = captureClick(toggle);
    directInvoke(collapsed, toggle, { nativeEvent: traversedNativeMouse(toggle) });
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    directInvoke(expanded, toggle, { nativeEvent: traversedNativeMouse(toggle) });
    await waitFor(() => expect(toggle).toHaveAttribute("aria-expanded", "false"));
  });

  it("copies every currently displayed setup command once under direct-root Strict Mode", async () => {
    render(
      <StrictMode>
        <ShareDialog open onOpenChange={vi.fn()} doc={doc} isOwner onDocChange={vi.fn()} />
      </StrictMode>,
    );
    await screen.findByText("@bob");
    expect(copyText).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("share-agent-toggle"));
    await waitFor(() => expect(screen.getByTestId("token-add")).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Connect an MCP client" }));

    const copyBlock = async (testId: string, accessibleName: string) => {
      const value = screen.getByTestId(testId).textContent;
      const button = screen.getByRole("button", { name: accessibleName });
      fireEvent.click(button);
      await waitFor(() => expect(copyText).toHaveBeenLastCalledWith(value));
    };

    await copyBlock("agent-connect-config", "Copy MCP configuration");
    fireEvent.click(screen.getByText("Client without HTTP support? Run the server from a checkout (stdio)"));
    await copyBlock("agent-connect-config-stdio", "Copy stdio MCP configuration");
    fireEvent.click(screen.getByText("Optional Copilot CLI permissions"));
    const allowLine = screen.getByTestId("agent-connect-allow-line").textContent;
    fireEvent.click(screen.getByTestId("agent-connect-allow-copy"));
    await waitFor(() => expect(copyText).toHaveBeenLastCalledWith(allowLine));
    fireEvent.click(screen.getByTestId("agent-connect-tab-copilot-app"));
    await copyBlock("agent-connect-app-install", "Copy Copilot app install command");

    expect(copyText).toHaveBeenCalledTimes(4);
  });

  it("contains synchronous, asynchronous, then-getter, and then-call copy failures", async () => {
    const failures: Array<() => unknown> = [
      () => {
        throw new Error("synchronous clipboard failure");
      },
      () => Promise.reject(new Error("asynchronous clipboard failure")),
      () => Object.defineProperty({}, "then", {
        get() {
          throw new Error("then getter failure");
        },
      }),
      () => ({
        then() {
          throw new Error("then call failure");
        },
      }),
    ];
    const view = render(<StrictMode><ShareDialog key={0} open onOpenChange={vi.fn()} doc={doc} isOwner onDocChange={vi.fn()} /></StrictMode>);

    for (let index = 0; index < failures.length; index++) {
      if (index > 0) {
        view.rerender(
          <StrictMode>
            <ShareDialog key={index} open onOpenChange={vi.fn()} doc={doc} isOwner onDocChange={vi.fn()} />
          </StrictMode>,
        );
      }
      await screen.findByText("@bob");
      copyText.mockImplementationOnce(failures[index]!);
      fireEvent.click(screen.getByTestId("copy-link"));
      const fallback = await screen.findByTestId("copy-link-fallback");
      expect(fallback).toHaveValue(`${window.location.origin}/d/${DOC_ID}`);
      expect(fallback).toHaveFocus();
    }
    expect(copyText).toHaveBeenCalledTimes(failures.length);
  });

  it("retires removed copies, ignores late settlement, and recovers fresh", async () => {
    const oldAttempt = deferred<boolean>();
    const currentAttempt = deferred<boolean>();
    const nextDoc = { ...doc, id: "doc-920", title: "Current share" };
    const view = render(
      <StrictMode>
        <ShareDialog key="a" open onOpenChange={vi.fn()} doc={doc} isOwner onDocChange={vi.fn()} />
      </StrictMode>,
    );
    await screen.findByText("@bob");
    copyText.mockReturnValueOnce(oldAttempt.promise);
    fireEvent.click(screen.getByTestId("copy-link"));

    view.rerender(
      <StrictMode>
        <ShareDialog key="b" open onOpenChange={vi.fn()} doc={nextDoc} isOwner onDocChange={vi.fn()} />
      </StrictMode>,
    );
    await screen.findByRole("heading", { name: "Share “Current share”" });
    await act(async () => {
      oldAttempt.resolve(false);
      await oldAttempt.promise;
    });
    expect(screen.queryByTestId("copy-link-fallback")).toBeNull();
    expect(screen.getByTestId("copy-link")).toHaveTextContent("Copy link");

    copyText.mockReturnValueOnce(currentAttempt.promise);
    fireEvent.click(screen.getByTestId("copy-link"));
    expect(copyText).toHaveBeenLastCalledWith(`${window.location.origin}/d/${nextDoc.id}`);
    await act(async () => {
      currentAttempt.resolve(true);
      await currentAttempt.promise;
    });
    expect(screen.getByTestId("copy-link")).toHaveTextContent("Copied");
  });

  it("makes a successor published by a hostile then getter fresh and usable", async () => {
    const nextDoc = { ...doc, id: "doc-921", title: "Getter successor" };
    let thenCalls = 0;
    const view = render(
      <StrictMode>
        <ShareDialog key="getter-a" open onOpenChange={vi.fn()} doc={doc} isOwner onDocChange={vi.fn()} />
      </StrictMode>,
    );
    await screen.findByText("@bob");
    copyText.mockImplementationOnce(() => Object.defineProperty({}, "then", {
      get() {
        flushSync(() => {
          view.rerender(
            <StrictMode>
              <ShareDialog key="getter-b" open onOpenChange={vi.fn()} doc={nextDoc} isOwner onDocChange={vi.fn()} />
            </StrictMode>,
          );
        });
        return () => {
          thenCalls += 1;
        };
      },
    }));

    fireEvent.click(screen.getByTestId("copy-link"));
    await screen.findByRole("heading", { name: "Share “Getter successor”" });
    expect(thenCalls).toBe(0);
    expect(screen.queryByTestId("copy-link-fallback")).toBeNull();
    expect(screen.getByTestId("copy-link")).toHaveTextContent("Copy link");

    fireEvent.click(screen.getByTestId("copy-link"));
    await waitFor(() => expect(screen.getByTestId("copy-link")).toHaveTextContent("Copied"));
    expect(copyText).toHaveBeenLastCalledWith(`${window.location.origin}/d/${nextDoc.id}`);
  });

  it("publishes a fresh exact successor for direct-root Strict Mode replay", async () => {
    let done: CapturedControl<HTMLButtonElement> | null = null;
    const onClose = vi.fn(() => {
      if (done) directInvoke(done);
    });
    render(
      <StrictMode>
        <ShareDialog open onOpenChange={onClose} doc={doc} isOwner onDocChange={vi.fn()} />
      </StrictMode>,
    );
    await screen.findByText("@bob");

    done = captureClick(screen.getByRole("button", { name: "Done" }));
    directInvoke(done);
    directInvoke(done);

    expect(onClose).toHaveBeenCalledExactlyOnceWith(false);
  });

  it("owns one direct-root Strict Mode Add submit after replay", async () => {
    const pending = deferred<unknown>();
    addCollaborator.mockReturnValueOnce(pending.promise);
    render(
      <StrictMode>
        <ShareDialog open onOpenChange={vi.fn()} doc={doc} isOwner onDocChange={vi.fn()} />
      </StrictMode>,
    );
    await screen.findByText("@bob");
    fireEvent.change(screen.getByTestId("share-login"), { target: { value: "strict-add" } });
    fireEvent.change(screen.getByTestId("share-role"), { target: { value: "commenter" } });
    const addButton = screen.getByTestId("share-add") as HTMLButtonElement;
    const submit = captureSubmit(addButton.form!);

    directInvoke(submit, submit.element, { nativeEvent: nativeSubmit(submit.element, addButton) });
    directInvoke(submit, submit.element, { nativeEvent: nativeSubmit(submit.element, addButton) });

    expect(addCollaborator).toHaveBeenCalledExactlyOnceWith(DOC_ID, "strict-add", "commenter");
    await act(async () => {
      pending.resolve({});
      await pending.promise;
    });
  });

  it("owns one direct-root Strict Mode Retry click after replay", async () => {
    collaborators.mockRejectedValue(new ApiError(503, "Try again"));
    render(
      <StrictMode>
        <ShareDialog open onOpenChange={vi.fn()} doc={doc} isOwner onDocChange={vi.fn()} />
      </StrictMode>,
    );
    const retry = captureClick(await screen.findByRole("button", { name: "Retry" }) as HTMLButtonElement);
    const callsBeforeRetry = collaborators.mock.calls.length;

    directInvoke(retry);
    directInvoke(retry);

    expect(collaborators).toHaveBeenCalledTimes(callsBeforeRetry + 1);
  });

  it("keeps direct-root Strict Mode new-role replay and stale/current handlers exact", async () => {
    render(
      <StrictMode>
        <ShareDialog open onOpenChange={vi.fn()} doc={doc} isOwner onDocChange={vi.fn()} />
      </StrictMode>,
    );
    await screen.findByText("@bob");
    const stale = captureChange(screen.getByTestId("share-role") as HTMLSelectElement);
    stale.element.value = "viewer";
    act(() => directInvoke(stale));
    expect(screen.getByTestId("share-role")).toHaveValue("viewer");

    const current = captureChange(screen.getByTestId("share-role") as HTMLSelectElement);
    current.element.value = "commenter";
    act(() => directInvoke(stale, current.element));
    expect(current.element).toHaveValue("commenter");
    act(() => directInvoke(current));
    expect(screen.getByTestId("share-role")).toHaveValue("commenter");
  });

  it("owns one direct-root Strict Mode collaborator-role change after replay", async () => {
    const pending = deferred<unknown>();
    addCollaborator.mockReturnValueOnce(pending.promise);
    render(
      <StrictMode>
        <ShareDialog open onOpenChange={vi.fn()} doc={doc} isOwner onDocChange={vi.fn()} />
      </StrictMode>,
    );
    await screen.findByText("@bob");
    const row = collaboratorRow("bob");
    const roleControl = captureChange(within(row).getByRole("combobox") as HTMLSelectElement);
    roleControl.element.value = "viewer";

    directInvoke(roleControl);
    directInvoke(roleControl);

    expect(addCollaborator).toHaveBeenCalledExactlyOnceWith(DOC_ID, "bob", "viewer");
    await act(async () => {
      pending.resolve({});
      await pending.promise;
    });
  });

  it("owns one direct-root Strict Mode Remove click after replay", async () => {
    const pending = deferred<unknown>();
    removeCollaborator.mockReturnValueOnce(pending.promise);
    render(
      <StrictMode>
        <ShareDialog open onOpenChange={vi.fn()} doc={doc} isOwner onDocChange={vi.fn()} />
      </StrictMode>,
    );
    await screen.findByText("@bob");
    const remove = captureClick(
      within(collaboratorRow("bob")).getByRole("button", { name: "Remove bob" }),
    );

    directInvoke(remove);
    directInvoke(remove);

    expect(removeCollaborator).toHaveBeenCalledExactlyOnceWith(DOC_ID, "bob");
    await act(async () => {
      pending.resolve({});
      await pending.promise;
    });
  });

  it("owns one direct-root Strict Mode link-access change after replay", async () => {
    const pending = deferred<{ document: DocumentDto }>();
    patchDocument.mockReturnValueOnce(pending.promise);
    const onDocChange = vi.fn();
    render(
      <StrictMode>
        <ShareDialog open onOpenChange={vi.fn()} doc={doc} isOwner onDocChange={onDocChange} />
      </StrictMode>,
    );
    await screen.findByText("@bob");
    const linkAccess = captureChange(screen.getByTestId("link-access") as HTMLSelectElement);
    linkAccess.element.value = "comment";

    directInvoke(linkAccess);
    directInvoke(linkAccess);

    expect(patchDocument).toHaveBeenCalledExactlyOnceWith(DOC_ID, { linkAccess: "comment" });
    await act(async () => {
      pending.resolve({ document: { ...doc, linkAccess: "comment" } });
      await pending.promise;
    });
    expect(onDocChange).toHaveBeenCalledOnce();
  });

  it("accepts one genuine direct-root Strict Mode Escape close after replay", async () => {
    const onClose = vi.fn();
    render(
      <StrictMode>
        <ShareDialog open onOpenChange={onClose} doc={doc} isOwner onDocChange={vi.fn()} />
      </StrictMode>,
    );
    await screen.findByText("@bob");
    const input = screen.getByTestId("share-login");
    input.focus();

    fireEvent.keyDown(input, { key: "Escape", code: "Escape" });
    fireEvent.keyDown(input, { key: "Escape", code: "Escape" });

    expect(onClose).toHaveBeenCalledExactlyOnceWith(false);
  });

  it("accepts one genuine direct-root Strict Mode outside close after replay", async () => {
    const onClose = vi.fn();
    render(
      <StrictMode>
        <ShareDialog open onOpenChange={onClose} doc={doc} isOwner onDocChange={vi.fn()} />
      </StrictMode>,
    );
    await screen.findByText("@bob");

    fireEvent.pointerDown(document.body);
    fireEvent.click(document.body);
    fireEvent.pointerDown(document.body);
    fireEvent.click(document.body);

    expect(onClose).toHaveBeenCalledExactlyOnceWith(false);
  });

  it.each(["Escape", "header Close", "outside"] as const)(
    "keeps exact %s provenance through a trusted-order microtask before Radix dismissal",
    async (kind) => {
      const windowAdd = vi.spyOn(window, "addEventListener");
      const documentAdd = vi.spyOn(document, "addEventListener");
      const onClose = vi.fn();
      const view = render(
        <StrictMode>
          <ShareDialog open onOpenChange={onClose} doc={doc} isOwner onDocChange={vi.fn()} />
        </StrictMode>,
      );
      try {
        await screen.findByText("@bob");
        const input = screen.getByTestId("share-login");
        const close = captureClick(screen.getByRole("button", { name: "Close" }));
        let event: KeyboardEvent | MouseEvent;
        let dismiss: EventListener | (() => void);
        if (kind === "Escape") {
          event = nativeKeyboard(input);
          dismiss = findAddedListener(documentAdd.mock.calls, "keydown", true);
        } else if (kind === "header Close") {
          event = nativeMouse(close.element);
          dismiss = () => directInvoke(close, close.element, { nativeEvent: event });
        } else {
          fireEvent.pointerDown(document.body);
          event = nativeMouse(document.body);
          dismiss = findAddedListener(documentAdd.mock.calls, "click", false);
        }
        const remember = findAddedListener(
          windowAdd.mock.calls,
          event.type,
          true,
          "remember",
        );

        remember.call(window, event);
        await Promise.resolve();
        dismiss.call(kind === "header Close" ? undefined : document, event);
        dismiss.call(kind === "header Close" ? undefined : document, event);

        expect(onClose).toHaveBeenCalledExactlyOnceWith(false);
      } finally {
        view.unmount();
        documentAdd.mockRestore();
        windowAdd.mockRestore();
      }
    },
  );

  it("expires late, fabricated, and crossed dismissal provenance without poisoning the current Close control", async () => {
    const windowAdd = vi.spyOn(window, "addEventListener");
    const onClose = vi.fn();
    const view = render(
      <StrictMode>
        <ShareDialog open onOpenChange={onClose} doc={doc} isOwner onDocChange={vi.fn()} />
      </StrictMode>,
    );
    try {
      await screen.findByText("@bob");
      const close = captureClick(screen.getByRole("button", { name: "Close" }));
      const rememberClick = findAddedListener(windowAdd.mock.calls, "click", true, "remember");
      const rememberKeydown = findAddedListener(windowAdd.mock.calls, "keydown", true, "remember");

      directInvoke(close);
      expect(onClose).not.toHaveBeenCalled();

      const late = nativeMouse(close.element);
      rememberClick.call(window, late);
      await new Promise((resolve) => setTimeout(resolve, 0));
      directInvoke(close, close.element, { nativeEvent: late });
      expect(onClose).not.toHaveBeenCalled();

      const crossed = nativeMouse(close.element);
      rememberClick.call(window, crossed);
      rememberKeydown.call(window, nativeKeyboard(screen.getByTestId("share-login"), "Enter"));
      directInvoke(close, close.element, { nativeEvent: crossed });
      expect(onClose).not.toHaveBeenCalled();

      fireEvent.click(close.element);
      expect(onClose).toHaveBeenCalledExactlyOnceWith(false);
    } finally {
      view.unmount();
      windowAdd.mockRestore();
    }
  });

  it("retires every superseded Strict Mode listener and observer without poisoning the replacement", async () => {
    const resources = trackPresentationResources();
    const staleClose = vi.fn();
    const currentClose = vi.fn();
    const view = render(
      <StrictMode>
        <ShareDialog key="stale" open onOpenChange={staleClose} doc={doc} isOwner onDocChange={vi.fn()} />
      </StrictMode>,
    );
    try {
      await screen.findByText("@bob");
      await act(async () => Promise.resolve());
      const staleDone = captureClick(screen.getByRole("button", { name: "Done" }));
      const staleObservers = resources.presentationObservers().filter(({ disconnected }) => !disconnected);
      expect(staleObservers).toHaveLength(1);
      expect(resources.activeCapture("keydown")).toHaveLength(1);
      expect(resources.activeCapture("click")).toHaveLength(1);

      view.rerender(
        <StrictMode>
          <ShareDialog key="current" open onOpenChange={currentClose} doc={doc} isOwner onDocChange={vi.fn()} />
        </StrictMode>,
      );
      await screen.findByText("@bob");
      await act(async () => Promise.resolve());
      const currentDone = captureClick(screen.getByRole("button", { name: "Done" }));
      expect(staleObservers.every(({ disconnected }) => disconnected)).toBe(true);
      expect(resources.presentationObservers().filter(({ disconnected }) => !disconnected)).toHaveLength(1);
      expect(resources.activeCapture("keydown")).toHaveLength(1);
      expect(resources.activeCapture("click")).toHaveLength(1);

      directInvoke(staleDone, currentDone.element);
      expect(staleClose).not.toHaveBeenCalled();
      expect(currentClose).not.toHaveBeenCalled();
      expect(resources.activeCapture("keydown")).toHaveLength(1);
      expect(resources.activeCapture("click")).toHaveLength(1);

      directInvoke(currentDone);
      await act(async () => Promise.resolve());
      expect(currentClose).toHaveBeenCalledExactlyOnceWith(false);
      expect(resources.presentationObservers().every(({ disconnected }) => disconnected)).toBe(true);
      expect(resources.activeCapture("keydown")).toHaveLength(0);
      expect(resources.activeCapture("click")).toHaveLength(0);
    } finally {
      view.unmount();
      resources.restore();
    }
  });

  it("releases the active Strict Mode listener and observer lineage on unmount", async () => {
    const resources = trackPresentationResources();
    const view = render(
      <StrictMode>
        <ShareDialog open onOpenChange={vi.fn()} doc={doc} isOwner onDocChange={vi.fn()} />
      </StrictMode>,
    );
    try {
      await screen.findByText("@bob");
      await act(async () => Promise.resolve());
      expect(resources.presentationObservers().filter(({ disconnected }) => !disconnected)).toHaveLength(1);
      expect(resources.activeCapture("keydown")).toHaveLength(1);
      expect(resources.activeCapture("click")).toHaveLength(1);

      view.unmount();
      await act(async () => Promise.resolve());
      expect(resources.presentationObservers().every(({ disconnected }) => disconnected)).toBe(true);
      expect(resources.activeCapture("keydown")).toHaveLength(0);
      expect(resources.activeCapture("click")).toHaveLength(0);
    } finally {
      view.unmount();
      resources.restore();
    }
  });

  it("releases the superseded runtime when its replacement fails publication and leaves the next replacement current", async () => {
    const resources = trackPresentationResources();
    const onClose = vi.fn();
    const rejectedList = deferred<CollaboratorResponse>();
    const disabledDescriptor = Object.getOwnPropertyDescriptor(HTMLButtonElement.prototype, "disabled");
    if (!disabledDescriptor?.get) throw new Error("HTMLButtonElement.disabled has no native getter");
    let rejectDone = false;
    Object.defineProperty(HTMLButtonElement.prototype, "disabled", {
      ...disabledDescriptor,
      get(this: HTMLButtonElement) {
        if (rejectDone) return true;
        return disabledDescriptor.get?.call(this);
      },
    });
    const view = render(
      <StrictMode>
        <ShareDialog key={0} open onOpenChange={onClose} doc={doc} isOwner onDocChange={vi.fn()} />
      </StrictMode>,
    );
    try {
      await screen.findByText("@bob");
      await act(async () => Promise.resolve());
      const supersededObservers = resources.presentationObservers().filter(({ disconnected }) => !disconnected);
      expect(supersededObservers).toHaveLength(1);

      collaborators
        .mockReturnValueOnce(rejectedList.promise)
        .mockResolvedValueOnce(collaboratorRows("bob"));
      rejectDone = true;
      view.rerender(
        <StrictMode>
          <ShareDialog key={1} open onOpenChange={onClose} doc={doc} isOwner onDocChange={vi.fn()} />
        </StrictMode>,
      );
      await act(async () => Promise.resolve());
      rejectDone = false;
      const rejectedDone = captureClick(screen.getByRole("button", { name: "Done" }));
      expect(supersededObservers.every(({ disconnected }) => disconnected)).toBe(true);
      expect(resources.presentationObservers().filter(({ disconnected }) => !disconnected)).toHaveLength(0);
      expect(resources.activeCapture("keydown")).toHaveLength(0);
      expect(resources.activeCapture("click")).toHaveLength(0);
      directInvoke(rejectedDone);
      expect(onClose).not.toHaveBeenCalled();

      view.rerender(
        <StrictMode>
          <ShareDialog key={2} open onOpenChange={onClose} doc={doc} isOwner onDocChange={vi.fn()} />
        </StrictMode>,
      );
      await waitFor(() => expect(resources.activeCapture("keydown")).toHaveLength(1));
      rejectedList.resolve(collaboratorRows("stale"));
      await act(async () => rejectedList.promise);
      const currentDone = captureClick(screen.getByRole("button", { name: "Done" }));
      directInvoke(rejectedDone, currentDone.element);
      expect(onClose).not.toHaveBeenCalled();
      expect(resources.activeCapture("keydown")).toHaveLength(1);
      expect(resources.activeCapture("click")).toHaveLength(1);

      directInvoke(currentDone);
      await act(async () => Promise.resolve());
      expect(onClose).toHaveBeenCalledExactlyOnceWith(false);
      expect(resources.presentationObservers().every(({ disconnected }) => disconnected)).toBe(true);
      expect(resources.activeCapture("keydown")).toHaveLength(0);
      expect(resources.activeCapture("click")).toHaveLength(0);
    } finally {
      rejectDone = false;
      view.unmount();
      resources.restore();
      Object.defineProperty(HTMLButtonElement.prototype, "disabled", disabledDescriptor);
    }
  });

  it("retires restored direct-root Strict Mode detach history without poisoning its successor", async () => {
    const onClose = vi.fn();
    render(
      <StrictMode>
        <ShareDialog open onOpenChange={onClose} doc={doc} isOwner onDocChange={vi.fn()} />
      </StrictMode>,
    );
    await screen.findByText("@bob");
    const staleDone = captureClick(screen.getByRole("button", { name: "Done" }));
    const footer = staleDone.element.parentElement!;
    staleDone.element.remove();
    footer.append(staleDone.element);

    directInvoke(staleDone);
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.change(screen.getByTestId("share-login"), { target: { value: "successor" } });
    const currentDone = captureClick(screen.getByRole("button", { name: "Done" }));
    directInvoke(staleDone, currentDone.element);
    directInvoke(currentDone);

    expect(onClose).toHaveBeenCalledExactlyOnceWith(false);
  });

  it("accepts one native keyboard SubmitEvent and rejects fabricated or wrong-submitter events without event work", async () => {
    const pending = deferred<unknown>();
    addCollaborator.mockReturnValueOnce(pending.promise);
    await openDialog();
    fireEvent.change(screen.getByTestId("share-login"), { target: { value: "  native-user  " } });
    fireEvent.change(screen.getByTestId("share-role"), { target: { value: "commenter" } });
    const addButton = screen.getByTestId("share-add") as HTMLButtonElement;
    const form = addButton.form!;
    const submit = captureSubmit(form);
    const wrongSubmitter = document.createElement("button");
    const consumedNative = nativeSubmit(form);
    consumedNative.preventDefault();

    const rejected = [
      directInvoke(submit, form, { nativeEvent: { type: "submit", target: form, submitter: null } }),
      directInvoke(submit, form, { type: "click" }),
      directInvoke(submit, form, { nativeEvent: nativeSubmit(form, wrongSubmitter) }),
      directInvoke(submit, form, { nativeEvent: consumedNative }),
      directInvoke(submit, form, { defaultPrevented: true }),
    ];
    for (const event of rejected) {
      expect(event.preventDefault).not.toHaveBeenCalled();
      expect(event.stopPropagation).not.toHaveBeenCalled();
    }
    expect(addCollaborator).not.toHaveBeenCalled();

    const accepted = directInvoke(submit, form, { nativeEvent: nativeSubmit(form) });
    const repeated = directInvoke(submit, form, { nativeEvent: nativeSubmit(form) });
    expect(accepted.preventDefault).toHaveBeenCalledOnce();
    expect(repeated.preventDefault).not.toHaveBeenCalled();
    expect(addCollaborator).toHaveBeenCalledExactlyOnceWith(DOC_ID, "native-user", "commenter");

    await act(async () => {
      pending.resolve({});
      await pending.promise;
    });
  });

  it.each(["stale first", "current first"] as const)(
    "rebinds same DOM and callback refs before parent layout with %s ordering",
    async (order) => {
      collaborators.mockResolvedValue(collaboratorRows("bob"));
      const staleClose = vi.fn();
      const currentClose = vi.fn();
      const view = render(<ShareDialogBoundary onOpenChange={staleClose} />);
      await screen.findByText("@bob");
      const staleRoot = screen.getByTestId("share-presentation");
      const staleRootRef = reactRef(staleRoot);
      const staleDone = captureClick(screen.getByRole("button", { name: "Done" }));

      view.rerender(
        <ShareDialogBoundary
          boundary={1}
          onOpenChange={currentClose}
          onBoundary={() => {
            const currentRoot = screen.getByTestId("share-presentation");
            const currentDone = captureClick(screen.getByRole("button", { name: "Done" }));
            expect(currentRoot).toBe(staleRoot);
            expect(currentDone.element).toBe(staleDone.element);

            staleRootRef(currentRoot);
            staleRootRef(null);
            if (order === "stale first") {
              directInvoke(staleDone, currentDone.element);
              directInvoke(currentDone);
            } else {
              directInvoke(currentDone);
              directInvoke(staleDone, currentDone.element);
            }
          }}
        />,
      );

      expect(staleClose).not.toHaveBeenCalled();
      expect(currentClose).toHaveBeenCalledExactlyOnceWith(false);
    },
  );

  it.each(["stale first", "current first"] as const)(
    "isolates an equal-looking keyed replacement with %s ordering",
    async (order) => {
      collaborators.mockResolvedValue(collaboratorRows("bob"));
      const staleClose = vi.fn();
      const currentClose = vi.fn();
      const view = render(<ShareDialogBoundary instance={1} onOpenChange={staleClose} />);
      await screen.findByText("@bob");
      const staleDone = captureClick(screen.getByRole("button", { name: "Done" }));

      view.rerender(
        <ShareDialogBoundary
          instance={2}
          boundary={1}
          onOpenChange={currentClose}
          onBoundary={() => {
            directInvoke(staleDone);
            expect(staleClose).not.toHaveBeenCalled();
          }}
        />,
      );

      await screen.findByText("@bob");
      const currentDone = captureClick(screen.getByRole("button", { name: "Done" }));
      expect(currentDone.element).not.toBe(staleDone.element);
      if (order === "stale first") {
        directInvoke(staleDone, currentDone.element);
        directInvoke(currentDone);
      } else {
        directInvoke(currentDone);
        directInvoke(staleDone, currentDone.element);
      }
      expect(staleClose).not.toHaveBeenCalled();
      expect(currentClose).toHaveBeenCalledExactlyOnceWith(false);
    },
  );

  it("retires removed controls before parent layout and before passive cleanup", async () => {
    collaborators.mockResolvedValue(collaboratorRows("bob"));
    const onClose = vi.fn();
    let passiveCleanups = 0;
    const staleDone: { current: CapturedControl<HTMLButtonElement> | null } = { current: null };

    function Boundary({ present, boundary }: { present: boolean; boundary: number }) {
      useLayoutEffect(() => {
        if (boundary > 0) {
          if (!staleDone.current) throw new Error("The stale Done control was not captured");
          directInvoke(staleDone.current);
          expect(passiveCleanups).toBe(0);
        }
      }, [boundary]);
      return (
        <>
          {present ? <ShareDialog open onOpenChange={onClose} doc={doc} isOwner onDocChange={vi.fn()} /> : null}
          <PassiveCleanupProbe onCleanup={() => passiveCleanups++} />
        </>
      );
    }

    const view = render(<Boundary present boundary={0} />);
    await screen.findByText("@bob");
    staleDone.current = captureClick(screen.getByRole("button", { name: "Done" }));
    view.rerender(<Boundary present={false} boundary={1} />);

    expect(onClose).not.toHaveBeenCalled();
    expect(staleDone.current.element.isConnected).toBe(false);
  });

  it("rejects wrong-row, cross-action, foreign-realm and fabricated events without poisoning current controls", async () => {
    const roleRequest = deferred<unknown>();
    const removeRequest = deferred<unknown>();
    collaborators.mockResolvedValueOnce(collaboratorRows("bob", "charlie"));
    addCollaborator.mockReset().mockReturnValueOnce(roleRequest.promise);
    removeCollaborator.mockReset().mockReturnValueOnce(removeRequest.promise);
    await openDialog();

    const bobRow = collaboratorRow("bob");
    const charlieRow = collaboratorRow("charlie");
    const bobRole = captureChange(within(bobRow).getByRole("combobox") as HTMLSelectElement);
    const charlieRole = captureChange(within(charlieRow).getByRole("combobox") as HTMLSelectElement);
    const bobRemove = captureClick(within(bobRow).getByRole("button", { name: "Remove bob" }));
    const done = captureClick(screen.getByRole("button", { name: "Done" }));
    const iframe = document.createElement("iframe");
    document.body.append(iframe);

    charlieRole.element.value = "viewer";
    const wrongRow = directInvoke(bobRole, charlieRole.element);
    const crossAction = directInvoke(done, bobRemove.element);
    const fabricated = directInvoke(bobRemove, bobRemove.element, {
      nativeEvent: { type: "click", target: bobRemove.element },
    });
    const ForeignMouseEvent = (iframe.contentWindow as unknown as { MouseEvent: typeof MouseEvent }).MouseEvent;
    const foreignNative = new ForeignMouseEvent("click", { bubbles: true, cancelable: true });
    Object.defineProperty(foreignNative, "target", { configurable: true, value: bobRemove.element });
    const foreignRealm = directInvoke(bobRemove, bobRemove.element, { nativeEvent: foreignNative });
    for (const event of [wrongRow, crossAction, fabricated, foreignRealm]) {
      expect(event.preventDefault).not.toHaveBeenCalled();
      expect(event.stopPropagation).not.toHaveBeenCalled();
    }
    expect(addCollaborator).not.toHaveBeenCalled();
    expect(removeCollaborator).not.toHaveBeenCalled();

    directInvoke(charlieRole);
    expect(addCollaborator).toHaveBeenCalledExactlyOnceWith(DOC_ID, "charlie", "viewer");
    expect(removeCollaborator).not.toHaveBeenCalled();
    iframe.remove();

    await act(async () => {
      roleRequest.resolve({});
      await roleRequest.promise;
    });
    const currentBobRemove = captureClick(
      within(collaboratorRow("bob")).getByRole("button", { name: "Remove bob" }),
    );
    directInvoke(currentBobRemove);
    expect(removeCollaborator).toHaveBeenCalledExactlyOnceWith(DOC_ID, "bob");
    await act(async () => {
      removeRequest.resolve({});
      await removeRequest.promise;
    });
  });

  it("rejects detached, replaced, reordered and in-place-mutated destinations with zero callbacks", async () => {
    const response = collaboratorRows("bob", "charlie");
    collaborators.mockResolvedValueOnce(response);
    const onClose = vi.fn();
    render(<ShareDialog open onOpenChange={onClose} doc={doc} isOwner onDocChange={vi.fn()} />);
    await screen.findByText("@charlie");
    const root = screen.getByTestId("share-presentation");
    const list = root.querySelector("ul")!;
    const rows = screen.getAllByTestId("collaborator-row");
    const bobRemove = captureClick(within(rows[0]).getByRole("button", { name: "Remove bob" }));
    const done = captureClick(screen.getByRole("button", { name: "Done" }));
    const clone = done.element.cloneNode(true) as HTMLButtonElement;
    done.element.parentElement!.replaceChild(clone, done.element);

    directInvoke(done, clone);
    expect(onClose).not.toHaveBeenCalled();
    expect(removeCollaborator).not.toHaveBeenCalled();
    clone.parentElement!.replaceChild(done.element, clone);

    list.append(rows[0]);
    directInvoke(bobRemove);
    expect(removeCollaborator).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();

    response.collaborators.reverse();
    directInvoke(done);
    expect(onClose).not.toHaveBeenCalled();
    expect(removeCollaborator).not.toHaveBeenCalled();
  });

  it("binds Retry and link access to exact native controls and current option values", async () => {
    collaborators.mockRejectedValueOnce(new ApiError(503, "Try again"));
    renderDialog();
    const retryButton = await screen.findByRole("button", { name: "Retry" }) as HTMLButtonElement;
    const retry = captureClick(retryButton);
    const wrongTarget = document.createElement("span");
    document.body.append(wrongTarget);
    const rejectedRetry = directInvoke(retry, retry.element, {
      target: wrongTarget,
      nativeEvent: nativeMouse(wrongTarget),
    });
    expect(rejectedRetry.preventDefault).not.toHaveBeenCalled();
    expect(collaborators).toHaveBeenCalledOnce();
    directInvoke(retry);
    directInvoke(retry);
    expect(collaborators).toHaveBeenCalledTimes(2);
    wrongTarget.remove();

    cleanup();
    collaborators.mockReset().mockResolvedValue(collaboratorRows("bob"));
    const linkRequest = deferred<{ document: DocumentDto }>();
    patchDocument.mockReturnValueOnce(linkRequest.promise);
    const onDocChange = vi.fn();
    render(<ShareDialog open onOpenChange={vi.fn()} doc={doc} isOwner onDocChange={onDocChange} />);
    await screen.findByText("@bob");
    const link = captureChange(screen.getByTestId("link-access") as HTMLSelectElement);
    link.element.value = "view";
    const malformed = directInvoke(link, link.element, { nativeEvent: { type: "change", target: link.element } });
    expect(malformed.preventDefault).not.toHaveBeenCalled();
    expect(patchDocument).not.toHaveBeenCalled();
    directInvoke(link);
    directInvoke(link);
    expect(patchDocument).toHaveBeenCalledExactlyOnceWith(DOC_ID, { linkAccess: "view" });

    await act(async () => {
      linkRequest.resolve({ document: { ...doc, linkAccess: "view" } });
      await linkRequest.promise;
    });
    expect(onDocChange).toHaveBeenCalledOnce();
  });
});

describe("ShareDialog collaborator list recovery", () => {
  it("shows a neutral loading state until the initial collaborator request settles", () => {
    collaborators.mockReturnValueOnce(deferred<CollaboratorResponse>().promise);

    renderDialog();

    expect(screen.getByRole("status")).toHaveTextContent("Loading collaborators…");
    expect(screen.queryByText("Nobody else has been added yet.")).toBeNull();
    expect(collaborators).toHaveBeenCalledOnce();
    expect(collaborators).toHaveBeenCalledWith(DOC_ID);
  });

  it("shows the collaborator API reason and Retry instead of an add-collaborator error or empty list", async () => {
    collaborators.mockRejectedValueOnce(new ApiError(503, "Collaborator directory unavailable"));

    renderDialog();

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Collaborator directory unavailable");
    expect(alert).not.toHaveTextContent("Could not add collaborator");
    expect(within(alert).getByRole("button", { name: "Retry" })).toBeEnabled();
    expect(screen.queryByText("Nobody else has been added yet.")).toBeNull();
  });

  it("guards Retry to one request, exposes its pending state, and recovers the list", async () => {
    const retry = deferred<CollaboratorResponse>();
    collaborators.mockRejectedValueOnce("offline").mockReturnValueOnce(retry.promise);
    renderDialog();
    const retryButton = await screen.findByRole("button", { name: "Retry" });

    fireEvent.click(retryButton);
    fireEvent.click(retryButton);

    expect(collaborators).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("button", { name: "Retrying…" })).toBeDisabled();
    retry.resolve(collaboratorResponse("Recovered owner", "Recovered collaborator"));
    expect(await screen.findByText("Recovered collaborator")).toBeInTheDocument();
    expect(screen.getByText("Recovered owner")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("makes a late initial-list success inert at the synchronous Done boundary", async () => {
    const pending = deferred<CollaboratorResponse>();
    collaborators.mockReturnValueOnce(pending.promise);
    const onOpenChange = vi.fn();
    render(<ShareDialog open onOpenChange={onOpenChange} doc={doc} isOwner onDocChange={vi.fn()} />);
    const loading = screen.getByTestId("collaborator-list-loading");
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(onOpenChange).toHaveBeenCalledOnce();
    expect(onOpenChange).toHaveBeenCalledWith(false);

    await act(async () => {
      pending.resolve(collaboratorResponse("Stale owner", "Stale collaborator"));
      await pending.promise;
    });
    expect(collaborators).toHaveBeenCalledOnce();
    expect(screen.getByTestId("collaborator-list-loading")).toBe(loading);
    expect(screen.queryByText("Stale owner")).toBeNull();
    expect(screen.queryByText("Stale collaborator")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("makes a late initial-list failure and finalizer inert at the synchronous Done boundary", async () => {
    const pending = deferred<CollaboratorResponse>();
    collaborators.mockReturnValueOnce(pending.promise);
    const onOpenChange = vi.fn();
    render(<ShareDialog open onOpenChange={onOpenChange} doc={doc} isOwner onDocChange={vi.fn()} />);
    const loading = screen.getByTestId("collaborator-list-loading");
    fireEvent.click(screen.getByRole("button", { name: "Done" }));

    await act(async () => {
      pending.reject(new ApiError(503, "Closed list failed"));
      await pending.promise.catch(() => undefined);
    });
    expect(onOpenChange).toHaveBeenCalledOnce();
    expect(collaborators).toHaveBeenCalledOnce();
    expect(screen.getByTestId("collaborator-list-loading")).toBe(loading);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("keeps a reopened visit's load when a closed Retry succeeds late", async () => {
    const oldRetry = deferred<CollaboratorResponse>();
    const reopenedLoad = deferred<CollaboratorResponse>();
    collaborators.mockRejectedValueOnce(new ApiError(503, "Initial list failed")).mockReturnValueOnce(oldRetry.promise).mockReturnValueOnce(reopenedLoad.promise);
    const onOpenChange = vi.fn();
    const view = render(<ShareDialog open onOpenChange={onOpenChange} doc={doc} isOwner onDocChange={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
    expect(screen.getByRole("button", { name: "Retrying…" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    view.rerender(<ShareDialog open={false} onOpenChange={onOpenChange} doc={doc} isOwner onDocChange={vi.fn()} />);
    view.rerender(<ShareDialog open onOpenChange={onOpenChange} doc={doc} isOwner onDocChange={vi.fn()} />);
    await waitFor(() => expect(collaborators).toHaveBeenCalledTimes(3));

    await act(async () => {
      oldRetry.resolve(collaboratorResponse("Stale owner", "Stale collaborator"));
      await oldRetry.promise;
    });
    expect(screen.getByTestId("collaborator-list-loading")).toBeInTheDocument();
    expect(screen.queryByText("Stale owner")).toBeNull();
    expect(screen.queryByText("Stale collaborator")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();

    reopenedLoad.resolve(collaboratorResponse("Current owner", "Current collaborator"));
    expect(await screen.findByText("Current collaborator")).toBeInTheDocument();
    expect(screen.getByText("Current owner")).toBeInTheDocument();
    expect(collaborators).toHaveBeenCalledTimes(3);
  });

  it("keeps a reopened dialog's newer error when the closed instance succeeds late, then recovers current rows", async () => {
    const closedRequest = deferred<CollaboratorResponse>();
    const reopenedRequest = deferred<CollaboratorResponse>();
    const retry = deferred<CollaboratorResponse>();
    collaborators.mockReturnValueOnce(closedRequest.promise).mockReturnValueOnce(reopenedRequest.promise).mockReturnValueOnce(retry.promise);
    const view = render(<ShareDialog open onOpenChange={vi.fn()} doc={doc} isOwner onDocChange={vi.fn()} />);
    expect(screen.getByRole("status")).toBeInTheDocument();

    view.rerender(<ShareDialog open={false} onOpenChange={vi.fn()} doc={doc} isOwner onDocChange={vi.fn()} />);
    view.rerender(<ShareDialog open onOpenChange={vi.fn()} doc={doc} isOwner onDocChange={vi.fn()} />);
    await waitFor(() => expect(collaborators).toHaveBeenCalledTimes(2));
    reopenedRequest.reject(new ApiError(503, "Reopened request failed"));
    expect(await screen.findByRole("alert")).toHaveTextContent("Reopened request failed");

    await act(async () => {
      closedRequest.resolve(collaboratorResponse("Stale owner", "Stale collaborator"));
      await closedRequest.promise;
    });
    expect(screen.getByRole("alert")).toHaveTextContent("Reopened request failed");
    expect(screen.queryByText("Stale owner")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    retry.resolve(collaboratorResponse("Current owner", "Current collaborator"));
    expect(await screen.findByText("Current collaborator")).toBeInTheDocument();
    expect(screen.getByText("Current owner")).toBeInTheDocument();
  });

  it("does not let an old document's late error replace the switched document's owner and collaborators", async () => {
    const oldRequest = deferred<CollaboratorResponse>();
    const newRequest = deferred<CollaboratorResponse>();
    const nextDoc = { ...doc, id: "doc-920", title: "Next document" };
    collaborators.mockReturnValueOnce(oldRequest.promise).mockReturnValueOnce(newRequest.promise);
    const view = render(<ShareDialog open onOpenChange={vi.fn()} doc={doc} isOwner onDocChange={vi.fn()} />);

    view.rerender(<ShareDialog open onOpenChange={vi.fn()} doc={nextDoc} isOwner onDocChange={vi.fn()} />);
    await waitFor(() => expect(collaborators).toHaveBeenCalledTimes(2));
    expect(collaborators).toHaveBeenNthCalledWith(2, nextDoc.id);
    newRequest.resolve(collaboratorResponse("Next owner", "Next collaborator"));
    expect(await screen.findByText("Next collaborator")).toBeInTheDocument();

    await act(async () => {
      oldRequest.reject(new ApiError(503, "Old document failed"));
      await Promise.resolve();
    });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("Next owner")).toBeInTheDocument();
    expect(screen.getByText("Next collaborator")).toBeInTheDocument();
  });

  it("keeps add errors separate when a successful add refresh cannot load the collaborator list", async () => {
    await openDialog();
    addCollaborator.mockRejectedValueOnce(new ApiError(422, "That account cannot be added"));
    fireEvent.change(screen.getByTestId("share-login"), { target: { value: "charlie" } });
    fireEvent.click(screen.getByTestId("share-add"));
    expect(await screen.findByTestId("share-add-error")).toHaveTextContent("That account cannot be added");
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();

    collaborators.mockRejectedValueOnce("offline");
    fireEvent.click(screen.getByTestId("share-add"));
    const listAlert = await screen.findByTestId("collaborator-list-error");
    expect(listAlert).toHaveTextContent("Could not load collaborators");
    expect(listAlert).not.toHaveTextContent("That account cannot be added");
    expect(screen.queryByTestId("share-add-error")).toBeNull();
    expect(within(listAlert).getByRole("button", { name: "Retry" })).toBeEnabled();
    expect(screen.getByTestId("share-login")).toHaveValue("");
    expect(addCollaborator).toHaveBeenCalledTimes(2);
    expect(collaborators).toHaveBeenCalledTimes(2);
  });
});

describe("ShareDialog authority layout boundaries", () => {
  let unhandled: unknown[];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  const flush = async (...promises: Promise<unknown>[]) => {
    await act(async () => {
      await Promise.allSettled(promises);
      await Promise.resolve();
    });
  };

  beforeEach(() => {
    unhandled = [];
    process.on("unhandledRejection", onUnhandled);
  });

  afterEach(() => {
    process.off("unhandledRejection", onUnhandled);
  });

  it.each(["success", "failure"] as const)(
    "retires an initial-list $settlement before a document replacement's parent layout effect",
    async (settlement) => {
      const oldList = deferred<CollaboratorResponse>();
      const currentList = deferred<CollaboratorResponse>();
      const retry = deferred<CollaboratorResponse>();
      const nextDoc = { ...doc, id: "doc-boundary-next", title: "Boundary next" };
      collaborators.mockReset().mockReturnValueOnce(oldList.promise).mockReturnValueOnce(currentList.promise).mockReturnValueOnce(retry.promise);
      const view = render(<ShareDialogBoundary />);
      expect(collaborators).toHaveBeenCalledOnce();

      view.rerender(
        <ShareDialogBoundary
          currentDoc={nextDoc}
          boundary={1}
          onBoundary={() => {
            expect(collaborators).toHaveBeenCalledTimes(2);
            expect(collaborators).toHaveBeenLastCalledWith(nextDoc.id);
            if (settlement === "success") oldList.resolve(collaboratorResponse("Stale owner", "Stale collaborator"));
            else oldList.reject(new ApiError(503, "Retired initial list failed"));
          }}
        />,
      );
      await flush(oldList.promise);

      expect(screen.getByTestId("collaborator-list-loading")).toBeInTheDocument();
      expect(screen.queryByText("Stale owner")).toBeNull();
      expect(screen.queryByText("Stale collaborator")).toBeNull();
      expect(screen.queryByRole("alert")).toBeNull();

      currentList.reject(new ApiError(503, "Current list failed"));
      await flush(currentList.promise);
      expect(await screen.findByRole("alert")).toHaveTextContent("Current list failed");
      const retryButton = screen.getByRole("button", { name: "Retry" });
      fireEvent.click(retryButton);
      fireEvent.click(retryButton);
      expect(collaborators).toHaveBeenCalledTimes(3);
      expect(collaborators).toHaveBeenLastCalledWith(nextDoc.id);

      retry.resolve(collaboratorResponse("Current owner", "Current collaborator"));
      await flush(retry.promise);
      expect(await screen.findByText("Current collaborator")).toBeInTheDocument();
      expect(screen.getByText("Current owner")).toBeInTheDocument();
      expect(collaborators.mock.calls.map(([id]) => id)).toEqual([DOC_ID, nextDoc.id, nextDoc.id]);
      expect(unhandled).toEqual([]);
    },
  );

  it.each(["success", "failure"] as const)(
    "retires a Retry $settlement before a same-document instance replacement's parent layout effect",
    async (settlement) => {
      const retiredRetry = deferred<CollaboratorResponse>();
      const replacementList = deferred<CollaboratorResponse>();
      collaborators
        .mockReset()
        .mockRejectedValueOnce(new ApiError(503, "Initial list failed"))
        .mockReturnValueOnce(retiredRetry.promise)
        .mockReturnValueOnce(replacementList.promise);
      const view = render(<ShareDialogBoundary />);
      fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
      expect(collaborators).toHaveBeenCalledTimes(2);

      view.rerender(
        <ShareDialogBoundary
          instance={1}
          boundary={1}
          onBoundary={() => {
            expect(collaborators).toHaveBeenCalledTimes(3);
            if (settlement === "success") retiredRetry.resolve(collaboratorResponse("Stale retry owner", "Stale retry collaborator"));
            else retiredRetry.reject(new ApiError(503, "Retired Retry failed"));
          }}
        />,
      );
      await flush(retiredRetry.promise);

      expect(screen.getByTestId("collaborator-list-loading")).toBeInTheDocument();
      expect(screen.queryByText("Stale retry owner")).toBeNull();
      expect(screen.queryByText("Stale retry collaborator")).toBeNull();
      expect(screen.queryByRole("alert")).toBeNull();
      replacementList.resolve(collaboratorResponse("Replacement owner", "Replacement collaborator"));
      await flush(replacementList.promise);
      expect(await screen.findByText("Replacement collaborator")).toBeInTheDocument();
      expect(collaborators).toHaveBeenCalledTimes(3);
      expect(collaborators).toHaveBeenNthCalledWith(3, DOC_ID);
      expect(unhandled).toEqual([]);
    },
  );

  const replacementCases = [
    { label: "same-document instance replacement", currentDoc: doc, instance: 1 },
    { label: "document replacement", currentDoc: { ...doc, id: "doc-operation-next", title: "Operation next" }, instance: 0 },
  ];

  it.each(replacementCases)(
    "retires Add, role, removal, and link-access work before a $label parent layout effect",
    async ({ currentDoc, instance }) => {
      const oldAdd = deferred<unknown>();
      const oldRole = deferred<unknown>();
      const oldRemove = deferred<unknown>();
      const oldLink = deferred<{ document: DocumentDto }>();
      const currentList = deferred<CollaboratorResponse>();
      const currentAdd = deferred<unknown>();
      const currentRole = deferred<unknown>();
      const currentRemove = deferred<unknown>();
      const currentLink = deferred<{ document: DocumentDto }>();
      const refresh = deferred<CollaboratorResponse>();
      collaborators
        .mockReset()
        .mockResolvedValueOnce(collaboratorRows("bob", "charlie"))
        .mockReturnValueOnce(currentList.promise)
        .mockReturnValueOnce(refresh.promise);
      addCollaborator
        .mockReset()
        .mockReturnValueOnce(oldAdd.promise)
        .mockReturnValueOnce(oldRole.promise)
        .mockReturnValueOnce(currentAdd.promise)
        .mockReturnValueOnce(currentRole.promise);
      removeCollaborator.mockReset().mockReturnValueOnce(oldRemove.promise).mockReturnValueOnce(currentRemove.promise);
      patchDocument.mockReset().mockReturnValueOnce(oldLink.promise).mockReturnValueOnce(currentLink.promise);
      const onDocChange = vi.fn();
      const view = render(<ShareDialogBoundary onDocChange={onDocChange} />);
      await screen.findByText("@charlie");

      fireEvent.change(screen.getByTestId("share-login"), { target: { value: "old-user" } });
      fireEvent.click(screen.getByTestId("share-add"));
      fireEvent.change(within(collaboratorRow("bob")).getByRole("combobox"), { target: { value: "viewer" } });
      fireEvent.click(within(collaboratorRow("charlie")).getByRole("button", { name: "Remove charlie" }));
      fireEvent.change(screen.getByTestId("link-access"), { target: { value: "view" } });

      view.rerender(
        <ShareDialogBoundary
          currentDoc={currentDoc}
          instance={instance}
          boundary={1}
          onDocChange={onDocChange}
          onBoundary={() => {
            expect(collaborators).toHaveBeenCalledTimes(2);
            expect(collaborators).toHaveBeenLastCalledWith(currentDoc.id);
            oldLink.resolve({ document: { ...doc, linkAccess: "view" } });
            oldRemove.reject(new ApiError(503, "Retired removal failed"));
            oldAdd.resolve({});
            oldRole.resolve({});
          }}
        />,
      );
      await flush(oldLink.promise, oldRemove.promise, oldAdd.promise, oldRole.promise);

      expect(collaborators).toHaveBeenCalledTimes(2);
      expect(screen.getByTestId("collaborator-list-loading")).toBeInTheDocument();
      expect(screen.queryByText("@old-user")).toBeNull();
      expect(screen.queryByRole("alert")).toBeNull();
      expect(onDocChange).not.toHaveBeenCalled();

      currentList.resolve(collaboratorRows("bob", "charlie"));
      await flush(currentList.promise);
      await screen.findByText("@charlie");
      fireEvent.change(screen.getByTestId("share-login"), { target: { value: "current-user" } });
      fireEvent.change(screen.getByTestId("share-role"), { target: { value: "commenter" } });
      fireEvent.click(screen.getByTestId("share-add"));
      fireEvent.change(within(collaboratorRow("bob")).getByRole("combobox"), { target: { value: "viewer" } });
      fireEvent.click(within(collaboratorRow("charlie")).getByRole("button", { name: "Remove charlie" }));
      fireEvent.change(screen.getByTestId("link-access"), { target: { value: "edit" } });

      expect(addCollaborator).toHaveBeenNthCalledWith(1, DOC_ID, "old-user", "editor");
      expect(addCollaborator).toHaveBeenNthCalledWith(2, DOC_ID, "bob", "viewer");
      expect(addCollaborator).toHaveBeenNthCalledWith(3, currentDoc.id, "current-user", "commenter");
      expect(addCollaborator).toHaveBeenNthCalledWith(4, currentDoc.id, "bob", "viewer");
      expect(removeCollaborator).toHaveBeenNthCalledWith(1, DOC_ID, "charlie");
      expect(removeCollaborator).toHaveBeenNthCalledWith(2, currentDoc.id, "charlie");
      expect(patchDocument).toHaveBeenNthCalledWith(1, DOC_ID, { linkAccess: "view" });
      expect(patchDocument).toHaveBeenNthCalledWith(2, currentDoc.id, { linkAccess: "edit" });

      const confirmedDoc = { ...currentDoc, linkAccess: "edit" as const };
      currentRemove.resolve({});
      currentRole.resolve({});
      currentLink.resolve({ document: confirmedDoc });
      await flush(currentRemove.promise, currentRole.promise, currentLink.promise);
      expect(within(collaboratorRow("bob")).getByRole("combobox")).toHaveValue("viewer");
      expect(screen.queryByText("@charlie")).toBeNull();
      expect(onDocChange).toHaveBeenCalledOnce();
      expect(onDocChange).toHaveBeenCalledWith(confirmedDoc);
      expect(screen.getByTestId("link-access")).toBeEnabled();

      currentAdd.resolve({});
      await flush(currentAdd.promise);
      await waitFor(() => expect(collaborators).toHaveBeenCalledTimes(3));
      expect(screen.getByTestId("share-login")).toHaveValue("");
      fireEvent.change(screen.getByTestId("share-login"), { target: { value: "queued-user" } });
      expect(screen.getByTestId("share-add")).toBeDisabled();
      refresh.resolve(collaboratorRows("bob", "current-user"));
      await flush(refresh.promise);
      expect(await screen.findByText("@current-user")).toBeInTheDocument();
      await waitFor(() => expect(screen.getByTestId("share-add")).toBeEnabled());
      expect(collaborators.mock.calls.map(([id]) => id)).toEqual([DOC_ID, currentDoc.id, currentDoc.id]);
      expect(addCollaborator).toHaveBeenCalledTimes(4);
      expect(removeCollaborator).toHaveBeenCalledTimes(2);
      expect(patchDocument).toHaveBeenCalledTimes(2);
      expect(unhandled).toEqual([]);
    },
  );

  it("retires every operation before explicit close calls onOpenChange", async () => {
    const pendingAdd = deferred<unknown>();
    const pendingRole = deferred<unknown>();
    const pendingRemove = deferred<unknown>();
    const pendingLink = deferred<unknown>();
    collaborators.mockResolvedValueOnce(collaboratorRows("bob", "charlie"));
    addCollaborator.mockReset().mockReturnValueOnce(pendingAdd.promise).mockReturnValueOnce(pendingRole.promise);
    removeCollaborator.mockReset().mockReturnValueOnce(pendingRemove.promise);
    patchDocument.mockReset().mockReturnValueOnce(pendingLink.promise);
    const onDocChange = vi.fn();
    const onOpenChange = vi.fn((nextOpen: boolean) => {
      if (nextOpen) return;
      pendingLink.reject(new ApiError(503, "Closed link failed"));
      pendingRemove.resolve({});
      pendingRole.resolve({});
      pendingAdd.resolve({});
    });
    render(<ShareDialog open onOpenChange={onOpenChange} doc={doc} isOwner onDocChange={onDocChange} />);
    await screen.findByText("@charlie");
    const loginInput = screen.getByTestId("share-login");
    const bobRole = within(collaboratorRow("bob")).getByRole("combobox");
    const charlieRemove = within(collaboratorRow("charlie")).getByRole("button", { name: "Remove charlie" });
    const linkAccess = screen.getByTestId("link-access");

    fireEvent.change(loginInput, { target: { value: "close-user" } });
    fireEvent.click(screen.getByTestId("share-add"));
    fireEvent.change(bobRole, { target: { value: "viewer" } });
    fireEvent.click(charlieRemove);
    fireEvent.change(linkAccess, { target: { value: "view" } });
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    await flush(pendingLink.promise, pendingRemove.promise, pendingRole.promise, pendingAdd.promise);

    expect(onOpenChange).toHaveBeenCalledOnce();
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(collaborators).toHaveBeenCalledOnce();
    expect(loginInput).toHaveValue("close-user");
    expect(screen.getByTestId("share-add")).toBeDisabled();
    expect(bobRole).toHaveValue("editor");
    expect(bobRole).toBeDisabled();
    expect(screen.getByText("@charlie")).toBeInTheDocument();
    expect(charlieRemove).toBeDisabled();
    expect(linkAccess).toBeDisabled();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(onDocChange).not.toHaveBeenCalled();
    expect(unhandled).toEqual([]);
  });

  it("retires Add before a same-document close boundary and admits one independent operation after reopen", async () => {
    const retiredAdd = deferred<unknown>();
    const reopenedList = deferred<CollaboratorResponse>();
    const currentAdd = deferred<unknown>();
    const refresh = deferred<CollaboratorResponse>();
    collaborators
      .mockReset()
      .mockResolvedValueOnce(collaboratorRows("bob"))
      .mockReturnValueOnce(reopenedList.promise)
      .mockReturnValueOnce(refresh.promise);
    addCollaborator.mockReset().mockReturnValueOnce(retiredAdd.promise).mockReturnValueOnce(currentAdd.promise);
    const view = render(<ShareDialogBoundary />);
    await screen.findByText("@bob");
    fireEvent.change(screen.getByTestId("share-login"), { target: { value: "retired-user" } });
    fireEvent.click(screen.getByTestId("share-add"));

    view.rerender(
      <ShareDialogBoundary
        open={false}
        boundary={1}
        onBoundary={() => {
          expect(collaborators).toHaveBeenCalledOnce();
          retiredAdd.resolve({});
        }}
      />,
    );
    await flush(retiredAdd.promise);
    expect(collaborators).toHaveBeenCalledOnce();

    view.rerender(
      <ShareDialogBoundary
        boundary={2}
        onBoundary={() => {
          expect(collaborators).toHaveBeenCalledTimes(2);
          expect(collaborators).toHaveBeenLastCalledWith(DOC_ID);
        }}
      />,
    );
    reopenedList.resolve(collaboratorRows("bob"));
    await flush(reopenedList.promise);
    expect(await screen.findByText("@bob")).toBeInTheDocument();
    expect(screen.getByTestId("share-login")).toHaveValue("retired-user");
    fireEvent.change(screen.getByTestId("share-login"), { target: { value: "current-user" } });
    fireEvent.click(screen.getByTestId("share-add"));
    expect(addCollaborator).toHaveBeenNthCalledWith(1, DOC_ID, "retired-user", "editor");
    expect(addCollaborator).toHaveBeenNthCalledWith(2, DOC_ID, "current-user", "editor");

    currentAdd.resolve({});
    await flush(currentAdd.promise);
    await waitFor(() => expect(collaborators).toHaveBeenCalledTimes(3));
    fireEvent.change(screen.getByTestId("share-login"), { target: { value: "queued-user" } });
    expect(screen.getByTestId("share-add")).toBeDisabled();
    refresh.resolve(collaboratorRows("bob", "current-user"));
    await flush(refresh.promise);
    expect(await screen.findByText("@current-user")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId("share-add")).toBeEnabled());
    expect(collaborators).toHaveBeenCalledTimes(3);
    expect(unhandled).toEqual([]);
  });

  it.each(["success", "failure"] as const)(
    "retires a pending initial-list $settlement before the parent layout effect after unmount",
    async (settlement) => {
      const pendingList = deferred<CollaboratorResponse>();
      collaborators.mockReset().mockReturnValueOnce(pendingList.promise);
      const view = render(<ShareDialogBoundary />);

      view.rerender(
        <ShareDialogBoundary
          present={false}
          boundary={1}
          onBoundary={() => {
            if (settlement === "success") pendingList.resolve(collaboratorResponse("Unmounted owner", "Unmounted collaborator"));
            else pendingList.reject(new ApiError(503, "Unmounted list failed"));
          }}
        />,
      );
      await flush(pendingList.promise);

      expect(collaborators).toHaveBeenCalledOnce();
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(screen.queryByText("Unmounted owner")).toBeNull();
      expect(screen.queryByRole("alert")).toBeNull();
      expect(unhandled).toEqual([]);
    },
  );

  it("retires Add and permission settlements before the parent layout effect after unmount", async () => {
    const pendingAdd = deferred<unknown>();
    const pendingRole = deferred<unknown>();
    const pendingRemove = deferred<unknown>();
    const pendingLink = deferred<unknown>();
    collaborators.mockResolvedValueOnce(collaboratorRows("bob", "charlie"));
    addCollaborator.mockReset().mockReturnValueOnce(pendingAdd.promise).mockReturnValueOnce(pendingRole.promise);
    removeCollaborator.mockReset().mockReturnValueOnce(pendingRemove.promise);
    patchDocument.mockReset().mockReturnValueOnce(pendingLink.promise);
    const onDocChange = vi.fn();
    const view = render(<ShareDialogBoundary onDocChange={onDocChange} />);
    await screen.findByText("@charlie");
    fireEvent.change(screen.getByTestId("share-login"), { target: { value: "unmounted-user" } });
    fireEvent.click(screen.getByTestId("share-add"));
    fireEvent.change(within(collaboratorRow("bob")).getByRole("combobox"), { target: { value: "viewer" } });
    fireEvent.click(within(collaboratorRow("charlie")).getByRole("button", { name: "Remove charlie" }));
    fireEvent.change(screen.getByTestId("link-access"), { target: { value: "view" } });

    view.rerender(
      <ShareDialogBoundary
        present={false}
        boundary={1}
        onDocChange={onDocChange}
        onBoundary={() => {
          pendingLink.reject(new ApiError(503, "Unmounted link failed"));
          pendingRemove.resolve({});
          pendingRole.resolve({});
          pendingAdd.resolve({});
        }}
      />,
    );
    await flush(pendingLink.promise, pendingRemove.promise, pendingRole.promise, pendingAdd.promise);

    expect(collaborators).toHaveBeenCalledOnce();
    expect(addCollaborator).toHaveBeenCalledTimes(2);
    expect(removeCollaborator).toHaveBeenCalledOnce();
    expect(patchDocument).toHaveBeenCalledOnce();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(onDocChange).not.toHaveBeenCalled();
    expect(unhandled).toEqual([]);
  });
});

describe("ShareDialog layout", () => {
  it("puts the copy-link row under the people list, before General access and the agent card; the footer is just Done", async () => {
    const dialog = await openDialog();
    const login = screen.getByTestId("share-login");
    const row = screen.getByTestId("collaborator-row");
    const copyLink = screen.getByTestId("copy-link");
    const linkAccess = screen.getByTestId("link-access");
    const toggle = screen.getByTestId("share-agent-toggle");
    expect(precedes(login, row)).toBe(true);
    expect(precedes(row, copyLink)).toBe(true);
    expect(precedes(copyLink, linkAccess)).toBe(true);
    expect(precedes(linkAccess, toggle)).toBe(true);

    // The row shows the editor link, truncated, next to the button; the hint says who can open it.
    const linkRow = screen.getByTestId("editor-link");
    expect(within(linkRow).getByText(`${window.location.origin}/d/${DOC_ID}`, { selector: "code" })).toBeInTheDocument();
    expect(linkRow).toContainElement(copyLink);
    expect(screen.getByTestId("copy-link-hint")).toHaveTextContent("Anyone listed above can open this link.");

    const footer = screen.getByTestId("share-footer");
    expect(within(footer).getAllByRole("button")).toHaveLength(1);
    expect(within(footer).getByRole("button", { name: "Done" })).toBeInTheDocument();
    expect(footer).not.toContainElement(copyLink);
    expect(within(dialog).queryByTestId("copy-link-fallback")).toBeNull();
  });

  it("reuses the General access description as the hint when the link is not restricted", async () => {
    await openDialog({ doc: { ...doc, linkAccess: "view" } });
    expect(screen.getByTestId("copy-link-hint")).toHaveTextContent("Signed-out visitors can read the document.");
    expect(screen.getByTestId("reader-link")).toHaveTextContent(`/p/${DOC_ID}`);
  });

  it("shows the link row to non-owners too", async () => {
    await openDialog({ isOwner: false });
    expect(screen.queryByTestId("share-login")).toBeNull();
    expect(screen.getByTestId("copy-link")).toBeInTheDocument();
    expect(screen.getByTestId("editor-link")).toHaveTextContent(`/d/${DOC_ID}`);
  });

  it("Copy link flips to Copied, and shows the selectable field when both copy paths fail", async () => {
    await openDialog();
    fireEvent.click(screen.getByTestId("copy-link"));
    await waitFor(() => expect(screen.getByTestId("copy-link")).toHaveTextContent("Copied"));
    expect(copyText).toHaveBeenCalledWith(`${window.location.origin}/d/${DOC_ID}`);

    copyText.mockResolvedValue(false);
    fireEvent.click(screen.getByTestId("copy-link"));
    const field = await screen.findByTestId("copy-link-fallback");
    expect(field).toHaveValue(`${window.location.origin}/d/${DOC_ID}`);
    expect(field).toHaveFocus();
    expect(screen.getByTestId("editor-link")).toContainElement(field);
  });
});

describe("ShareDialog · add a collaborator", () => {
  it("shows the server's validation reason, not the bare 'Invalid request', when the handle is rejected", async () => {
    addCollaborator.mockRejectedValueOnce(new ApiError(400, "Invalid request", [{ path: ["login"], message: "Enter a GitHub handle" }]));
    await openDialog();
    fireEvent.change(screen.getByTestId("share-login"), { target: { value: "someone.else" } });
    fireEvent.click(screen.getByTestId("share-add"));

    expect(await screen.findByText("Enter a GitHub handle")).toBeInTheDocument();
    expect(screen.queryByText("Invalid request")).toBeNull();
    expect(addCollaborator).toHaveBeenCalledWith(DOC_ID, "someone.else", "editor");
    expect(screen.getByTestId("share-login")).toHaveValue("someone.else");
  });

  it("owns one trimmed login and role per activation, suppresses a duplicate, and retries a current failure", async () => {
    const failed = deferred<unknown>();
    const retry = deferred<unknown>();
    const refresh = deferred<CollaboratorResponse>();
    addCollaborator.mockReset().mockReturnValueOnce(failed.promise).mockReturnValueOnce(retry.promise);
    collaborators.mockResolvedValueOnce(collaboratorRows("bob")).mockReturnValueOnce(refresh.promise);
    await openDialog();
    const input = screen.getByTestId("share-login");
    const role = screen.getByTestId("share-role");
    const form = screen.getByTestId("share-add").closest("form") as HTMLFormElement;
    fireEvent.change(input, { target: { value: "  charlie  " } });
    fireEvent.change(role, { target: { value: "commenter" } });

    fireNativeSubmit(form);
    fireNativeSubmit(form);
    expect(addCollaborator).toHaveBeenCalledOnce();
    expect(addCollaborator).toHaveBeenCalledWith(DOC_ID, "charlie", "commenter");
    expect(screen.getByTestId("share-add")).toBeDisabled();
    await act(async () => {
      failed.reject(new ApiError(422, "Charlie cannot be added"));
      await failed.promise.catch(() => undefined);
    });

    expect(await screen.findByTestId("share-add-error")).toHaveTextContent("Charlie cannot be added");
    expect(input).toHaveValue("  charlie  ");
    expect(screen.getByTestId("share-add")).toBeEnabled();
    fireNativeSubmit(form);
    expect(addCollaborator).toHaveBeenCalledTimes(2);
    expect(addCollaborator).toHaveBeenNthCalledWith(2, DOC_ID, "charlie", "commenter");
    expect(screen.queryByTestId("share-add-error")).toBeNull();

    await act(async () => {
      retry.resolve({});
      await retry.promise;
    });
    await waitFor(() => expect(collaborators).toHaveBeenCalledTimes(2));
    expect(input).toHaveValue("");
    expect(screen.getByTestId("share-add")).toBeDisabled();
    fireEvent.change(input, { target: { value: "delta" } });
    expect(screen.getByTestId("share-add")).toBeDisabled();
    refresh.resolve(collaboratorRows("bob", "charlie"));
    expect(await screen.findByText("@charlie")).toBeInTheDocument();
    expect(screen.getByTestId("share-add")).toBeEnabled();
    expect(screen.queryByTestId("share-add-error")).toBeNull();
  });

  it("makes a late Add success inert at the synchronous Done boundary", async () => {
    const pending = deferred<unknown>();
    addCollaborator.mockReset().mockReturnValueOnce(pending.promise);
    const onOpenChange = vi.fn();
    render(<ShareDialog open onOpenChange={onOpenChange} doc={doc} isOwner onDocChange={vi.fn()} />);
    await screen.findByTestId("collaborator-row");
    const input = screen.getByTestId("share-login");
    fireEvent.change(input, { target: { value: "charlie" } });
    fireEvent.click(screen.getByTestId("share-add"));
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(onOpenChange).toHaveBeenCalledOnce();
    expect(onOpenChange).toHaveBeenCalledWith(false);

    await act(async () => {
      pending.resolve({});
      await pending.promise;
    });
    expect(addCollaborator).toHaveBeenCalledWith(DOC_ID, "charlie", "editor");
    expect(collaborators).toHaveBeenCalledOnce();
    expect(input).toHaveValue("charlie");
    expect(screen.getByTestId("share-add")).toBeDisabled();
    expect(screen.getByText("@bob")).toBeInTheDocument();
    expect(screen.queryByText("@charlie")).toBeNull();
    expect(screen.queryByTestId("share-add-error")).toBeNull();
  });

  it("makes a late Add failure and finalizer inert at the synchronous Done boundary", async () => {
    const pending = deferred<unknown>();
    addCollaborator.mockReset().mockReturnValueOnce(pending.promise);
    const onOpenChange = vi.fn();
    render(<ShareDialog open onOpenChange={onOpenChange} doc={doc} isOwner onDocChange={vi.fn()} />);
    await screen.findByTestId("collaborator-row");
    const input = screen.getByTestId("share-login");
    fireEvent.change(input, { target: { value: "charlie" } });
    fireEvent.click(screen.getByTestId("share-add"));
    fireEvent.click(screen.getByRole("button", { name: "Done" }));

    await act(async () => {
      pending.reject(new ApiError(503, "Closed Add failed"));
      await pending.promise.catch(() => undefined);
    });
    expect(onOpenChange).toHaveBeenCalledOnce();
    expect(collaborators).toHaveBeenCalledOnce();
    expect(input).toHaveValue("charlie");
    expect(screen.getByTestId("share-add")).toBeDisabled();
    expect(screen.queryByTestId("share-add-error")).toBeNull();
    expect(screen.getByText("@bob")).toBeInTheDocument();
  });

  it("keeps a reopened visit's Add and list owners when old work settles", async () => {
    const oldList = deferred<CollaboratorResponse>();
    const reopenedList = deferred<CollaboratorResponse>();
    const refreshedList = deferred<CollaboratorResponse>();
    const oldAdd = deferred<unknown>();
    const currentAdd = deferred<unknown>();
    collaborators.mockReset().mockReturnValueOnce(oldList.promise).mockReturnValueOnce(reopenedList.promise).mockReturnValueOnce(refreshedList.promise);
    addCollaborator.mockReset().mockReturnValueOnce(oldAdd.promise).mockReturnValueOnce(currentAdd.promise);
    const onOpenChange = vi.fn();
    const view = render(<ShareDialog open onOpenChange={onOpenChange} doc={doc} isOwner onDocChange={vi.fn()} />);
    fireEvent.change(screen.getByTestId("share-login"), { target: { value: "old-user" } });
    fireEvent.click(screen.getByTestId("share-add"));
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    view.rerender(<ShareDialog open={false} onOpenChange={onOpenChange} doc={doc} isOwner onDocChange={vi.fn()} />);
    view.rerender(<ShareDialog open onOpenChange={onOpenChange} doc={doc} isOwner onDocChange={vi.fn()} />);
    await waitFor(() => expect(collaborators).toHaveBeenCalledTimes(2));
    reopenedList.resolve(collaboratorRows("bob"));
    expect(await screen.findByText("@bob")).toBeInTheDocument();

    const input = screen.getByTestId("share-login");
    fireEvent.change(input, { target: { value: "current-user" } });
    fireEvent.change(screen.getByTestId("share-role"), { target: { value: "viewer" } });
    fireEvent.click(screen.getByTestId("share-add"));
    expect(addCollaborator).toHaveBeenNthCalledWith(1, DOC_ID, "old-user", "editor");
    expect(addCollaborator).toHaveBeenNthCalledWith(2, DOC_ID, "current-user", "viewer");

    await act(async () => {
      oldAdd.resolve({});
      oldList.reject(new ApiError(503, "Old list failed"));
      await Promise.allSettled([oldAdd.promise, oldList.promise]);
    });
    expect(collaborators).toHaveBeenCalledTimes(2);
    expect(input).toHaveValue("current-user");
    expect(screen.getByTestId("share-add")).toBeDisabled();
    expect(screen.getByText("@bob")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();

    await act(async () => {
      currentAdd.resolve({});
      await currentAdd.promise;
    });
    await waitFor(() => expect(collaborators).toHaveBeenCalledTimes(3));
    expect(input).toHaveValue("");
    expect(screen.getByTestId("share-add")).toBeDisabled();
    refreshedList.resolve(collaboratorRows("bob", "current-user"));
    expect(await screen.findByText("@current-user")).toBeInTheDocument();
    expect(collaborators).toHaveBeenCalledTimes(3);
  });

  it("handles late Add resolution and list rejection after unmount without effects or unhandled rejections", async () => {
    const list = deferred<CollaboratorResponse>();
    const add = deferred<unknown>();
    collaborators.mockReset().mockReturnValueOnce(list.promise);
    addCollaborator.mockReset().mockReturnValueOnce(add.promise);
    const view = render(<ShareDialog open onOpenChange={vi.fn()} doc={doc} isOwner onDocChange={vi.fn()} />);
    fireEvent.change(screen.getByTestId("share-login"), { target: { value: "charlie" } });
    fireEvent.click(screen.getByTestId("share-add"));
    const unhandled = vi.fn();
    const onUnhandled = (reason: unknown) => unhandled(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      view.unmount();
      await act(async () => {
        add.resolve({});
        list.reject(new ApiError(503, "Late list failed"));
        await Promise.allSettled([add.promise, list.promise]);
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).not.toHaveBeenCalled();
      expect(addCollaborator).toHaveBeenCalledOnce();
      expect(collaborators).toHaveBeenCalledOnce();
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});

describe("ShareDialog · permission actions", () => {
  it("owns role and Remove synchronously per login while other collaborator rows remain independent", async () => {
    const bobRole = deferred<unknown>();
    const charlieRole = deferred<unknown>();
    collaborators.mockResolvedValueOnce(collaboratorRows("bob", "charlie"));
    addCollaborator.mockReset().mockReturnValueOnce(bobRole.promise).mockReturnValueOnce(charlieRole.promise);
    await openDialog();
    const bobRow = collaboratorRow("bob");
    const charlieRow = collaboratorRow("charlie");
    const bobSelect = within(bobRow).getByRole("combobox", { name: "Role for bob" });
    const charlieSelect = within(charlieRow).getByRole("combobox", { name: "Role for charlie" });

    fireEvent.change(bobSelect, { target: { value: "viewer" } });
    fireEvent.change(bobSelect, { target: { value: "commenter" } });
    fireEvent.click(within(bobRow).getByRole("button", { name: "Remove bob" }));

    expect(addCollaborator).toHaveBeenCalledOnce();
    expect(addCollaborator).toHaveBeenCalledWith(DOC_ID, "bob", "viewer");
    expect(removeCollaborator).not.toHaveBeenCalled();
    expect(bobSelect).toBeDisabled();
    expect(within(bobRow).getByRole("button", { name: "Remove bob" })).toBeDisabled();
    expect(charlieSelect).toBeEnabled();
    expect(within(charlieRow).getByRole("button", { name: "Remove charlie" })).toBeEnabled();

    fireEvent.change(charlieSelect, { target: { value: "commenter" } });
    expect(addCollaborator).toHaveBeenCalledTimes(2);
    expect(addCollaborator).toHaveBeenNthCalledWith(2, DOC_ID, "charlie", "commenter");
    expect(charlieSelect).toBeDisabled();

    await act(async () => {
      bobRole.resolve({});
      charlieRole.resolve({});
      await Promise.all([bobRole.promise, charlieRole.promise]);
    });
    await waitFor(() => expect(within(collaboratorRow("bob")).getByRole("combobox")).toHaveValue("viewer"));
    expect(within(collaboratorRow("charlie")).getByRole("combobox")).toHaveValue("commenter");
  });

  it("keeps a failed role confirmed and makes the same role change retryable", async () => {
    const failed = deferred<unknown>();
    const retry = deferred<unknown>();
    addCollaborator.mockReset().mockReturnValueOnce(failed.promise).mockReturnValueOnce(retry.promise);
    await openDialog();
    const row = collaboratorRow("bob");
    const select = within(row).getByRole("combobox", { name: "Role for bob" });

    fireEvent.change(select, { target: { value: "viewer" } });
    expect(select).toBeDisabled();
    expect(select).toHaveValue("editor");
    await act(async () => {
      failed.reject(new ApiError(409, "Bob's role changed elsewhere"));
      await failed.promise.catch(() => undefined);
    });

    expect(await screen.findByTestId("share-action-error")).toHaveTextContent("Bob's role changed elsewhere");
    expect(select).toBeEnabled();
    expect(select).toHaveValue("editor");
    fireEvent.change(select, { target: { value: "viewer" } });
    expect(addCollaborator).toHaveBeenCalledTimes(2);
    expect(screen.queryByTestId("share-action-error")).toBeNull();

    await act(async () => {
      retry.resolve({});
      await retry.promise;
    });
    await waitFor(() => expect(select).toHaveValue("viewer"));
  });

  it("suppresses duplicate Remove, surfaces failure, and removes the row on retry", async () => {
    const failed = deferred<unknown>();
    const retry = deferred<unknown>();
    removeCollaborator.mockReset().mockReturnValueOnce(failed.promise).mockReturnValueOnce(retry.promise);
    await openDialog();
    const row = collaboratorRow("bob");
    const remove = within(row).getByRole("button", { name: "Remove bob" });

    fireEvent.click(remove);
    fireEvent.click(remove);
    expect(removeCollaborator).toHaveBeenCalledOnce();
    expect(removeCollaborator).toHaveBeenCalledWith(DOC_ID, "bob");
    expect(remove).toBeDisabled();
    expect(within(row).getByRole("combobox", { name: "Role for bob" })).toBeDisabled();
    await act(async () => {
      failed.reject(new ApiError(503, "Permission service unavailable"));
      await failed.promise.catch(() => undefined);
    });

    expect(await screen.findByTestId("share-action-error")).toHaveTextContent("Permission service unavailable");
    expect(screen.getByText("@bob")).toBeInTheDocument();
    expect(remove).toBeEnabled();
    fireEvent.click(remove);
    expect(removeCollaborator).toHaveBeenCalledTimes(2);
    expect(screen.queryByTestId("share-action-error")).toBeNull();

    await act(async () => {
      retry.resolve({});
      await retry.promise;
    });
    await waitFor(() => expect(screen.queryByText("@bob")).toBeNull());
  });

  it("locks every link choice, retries a failure, and commits only the server-confirmed document", async () => {
    const failed = deferred<unknown>();
    const retry = deferred<{ document: DocumentDto }>();
    const serverDocument = { ...doc, title: "Server-confirmed title", linkAccess: "comment" as const };
    patchDocument.mockReset().mockReturnValueOnce(failed.promise).mockReturnValueOnce(retry.promise);
    const onDocChange = vi.fn();
    const view = render(<ShareDialog open onOpenChange={vi.fn()} doc={doc} isOwner onDocChange={onDocChange} />);
    await screen.findByTestId("collaborator-row");
    const select = screen.getByTestId("link-access");

    fireEvent.change(select, { target: { value: "view" } });
    fireEvent.change(select, { target: { value: "edit" } });
    expect(patchDocument).toHaveBeenCalledOnce();
    expect(patchDocument).toHaveBeenCalledWith(DOC_ID, { linkAccess: "view" });
    expect(select).toBeDisabled();
    expect(select).toHaveValue("private");
    for (const option of within(select).getAllByRole("option")) expect(option).toBeDisabled();

    await act(async () => {
      failed.reject(new ApiError(409, "Link access changed elsewhere"));
      await failed.promise.catch(() => undefined);
    });
    expect(await screen.findByTestId("share-action-error")).toHaveTextContent("Link access changed elsewhere");
    expect(select).toBeEnabled();
    expect(select).toHaveValue("private");
    fireEvent.change(select, { target: { value: "view" } });
    expect(patchDocument).toHaveBeenCalledTimes(2);
    expect(patchDocument).toHaveBeenNthCalledWith(2, DOC_ID, { linkAccess: "view" });

    await act(async () => {
      retry.resolve({ document: serverDocument });
      await retry.promise;
    });
    await waitFor(() => expect(onDocChange).toHaveBeenCalledWith(serverDocument));
    expect(onDocChange).toHaveBeenCalledOnce();
    view.rerender(<ShareDialog open onOpenChange={vi.fn()} doc={serverDocument} isOwner onDocChange={onDocChange} />);
    expect(select).toHaveValue("comment");
    expect(select).toBeEnabled();
  });

  it("invalidates permission operations synchronously when a close handler runs", async () => {
    const roleRequest = deferred<unknown>();
    const linkRequest = deferred<unknown>();
    addCollaborator.mockReset().mockReturnValueOnce(roleRequest.promise);
    patchDocument.mockReset().mockReturnValueOnce(linkRequest.promise);
    const onOpenChange = vi.fn();
    const onDocChange = vi.fn();
    render(<ShareDialog open onOpenChange={onOpenChange} doc={doc} isOwner onDocChange={onDocChange} />);
    await screen.findByTestId("collaborator-row");
    const roleSelect = within(collaboratorRow("bob")).getByRole("combobox", { name: "Role for bob" });
    const linkSelect = screen.getByTestId("link-access");
    fireEvent.change(roleSelect, { target: { value: "viewer" } });
    fireEvent.change(linkSelect, { target: { value: "view" } });
    expect(roleSelect).toBeDisabled();
    expect(linkSelect).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(onOpenChange).toHaveBeenCalledOnce();
    expect(onOpenChange).toHaveBeenCalledWith(false);
    await act(async () => {
      roleRequest.resolve({});
      linkRequest.reject(new ApiError(503, "Closed link request failed"));
      await Promise.allSettled([roleRequest.promise, linkRequest.promise]);
    });

    expect(within(collaboratorRow("bob")).getByRole("combobox")).toHaveValue("editor");
    expect(onDocChange).not.toHaveBeenCalled();
    expect(screen.queryByTestId("share-action-error")).toBeNull();
    expect(roleSelect).toBeDisabled();
    expect(linkSelect).toBeDisabled();
  });

  it("does not let a closed dialog's role success or finalizer affect a reopened same-login Remove", async () => {
    const oldRole = deferred<unknown>();
    const currentRemove = deferred<unknown>();
    addCollaborator.mockReset().mockReturnValueOnce(oldRole.promise);
    removeCollaborator.mockReset().mockReturnValueOnce(currentRemove.promise);
    const view = render(<ShareDialog open onOpenChange={vi.fn()} doc={doc} isOwner onDocChange={vi.fn()} />);
    await screen.findByTestId("collaborator-row");
    fireEvent.change(within(collaboratorRow("bob")).getByRole("combobox"), { target: { value: "viewer" } });

    view.rerender(<ShareDialog open={false} onOpenChange={vi.fn()} doc={doc} isOwner onDocChange={vi.fn()} />);
    view.rerender(<ShareDialog open onOpenChange={vi.fn()} doc={doc} isOwner onDocChange={vi.fn()} />);
    await waitFor(() => expect(collaborators).toHaveBeenCalledTimes(2));
    const reopenedRow = await screen.findByTestId("collaborator-row");
    fireEvent.click(within(reopenedRow).getByRole("button", { name: "Remove bob" }));
    expect(within(reopenedRow).getByRole("combobox")).toBeDisabled();

    await act(async () => {
      oldRole.resolve({});
      await oldRole.promise;
    });
    expect(within(collaboratorRow("bob")).getByRole("combobox")).toHaveValue("editor");
    expect(within(collaboratorRow("bob")).getByRole("combobox")).toBeDisabled();
    expect(within(collaboratorRow("bob")).getByRole("button", { name: "Remove bob" })).toBeDisabled();

    await act(async () => {
      currentRemove.reject(new ApiError(503, "Current Remove failed"));
      await currentRemove.promise.catch(() => undefined);
    });
    expect(await screen.findByTestId("share-action-error")).toHaveTextContent("Current Remove failed");
    expect(screen.getByText("@bob")).toBeInTheDocument();
  });

  it("does not let an old document's Remove error replace the current link error or rows", async () => {
    const oldRemove = deferred<unknown>();
    removeCollaborator.mockReset().mockReturnValueOnce(oldRemove.promise);
    patchDocument.mockRejectedValueOnce(new ApiError(503, "Current link change failed"));
    const nextDoc = { ...doc, id: "doc-920", title: "Next document" };
    const view = render(<ShareDialog open onOpenChange={vi.fn()} doc={doc} isOwner onDocChange={vi.fn()} />);
    await screen.findByTestId("collaborator-row");
    fireEvent.click(within(collaboratorRow("bob")).getByRole("button", { name: "Remove bob" }));

    view.rerender(<ShareDialog open onOpenChange={vi.fn()} doc={nextDoc} isOwner onDocChange={vi.fn()} />);
    await waitFor(() => expect(collaborators).toHaveBeenCalledTimes(2));
    await screen.findByTestId("collaborator-row");
    fireEvent.change(screen.getByTestId("link-access"), { target: { value: "view" } });
    expect(await screen.findByTestId("share-action-error")).toHaveTextContent("Current link change failed");

    await act(async () => {
      oldRemove.reject(new ApiError(503, "Old Remove failed"));
      await oldRemove.promise.catch(() => undefined);
    });
    expect(screen.getByTestId("share-action-error")).toHaveTextContent("Current link change failed");
    expect(screen.getByText("@bob")).toBeInTheDocument();
    expect(removeCollaborator).toHaveBeenCalledOnce();
  });

  it("does not let an old document's link success call onDocChange or unlock its successor", async () => {
    const oldLink = deferred<{ document: DocumentDto }>();
    const currentLink = deferred<{ document: DocumentDto }>();
    patchDocument.mockReset().mockReturnValueOnce(oldLink.promise).mockReturnValueOnce(currentLink.promise);
    const onDocChange = vi.fn();
    const nextDoc = { ...doc, id: "doc-920", title: "Next document" };
    const view = render(<ShareDialog open onOpenChange={vi.fn()} doc={doc} isOwner onDocChange={onDocChange} />);
    await screen.findByTestId("collaborator-row");
    fireEvent.change(screen.getByTestId("link-access"), { target: { value: "view" } });

    view.rerender(<ShareDialog open onOpenChange={vi.fn()} doc={nextDoc} isOwner onDocChange={onDocChange} />);
    await waitFor(() => expect(collaborators).toHaveBeenCalledTimes(2));
    fireEvent.change(screen.getByTestId("link-access"), { target: { value: "edit" } });
    expect(patchDocument).toHaveBeenNthCalledWith(2, nextDoc.id, { linkAccess: "edit" });
    expect(screen.getByTestId("link-access")).toBeDisabled();

    await act(async () => {
      oldLink.resolve({ document: { ...doc, linkAccess: "view" } });
      await oldLink.promise;
    });
    expect(onDocChange).not.toHaveBeenCalled();
    expect(screen.getByTestId("link-access")).toBeDisabled();
    expect(screen.getByTestId("link-access")).toHaveValue("private");

    await act(async () => {
      currentLink.reject(new ApiError(503, "Current link request failed"));
      await currentLink.promise.catch(() => undefined);
    });
    expect(await screen.findByTestId("share-action-error")).toHaveTextContent("Current link request failed");
    expect(screen.getByTestId("link-access")).toBeEnabled();
  });

  it("handles late permission resolves and rejections after unmount without effects or unhandled rejections", async () => {
    const roleRequest = deferred<unknown>();
    const removeRequest = deferred<unknown>();
    const linkRequest = deferred<unknown>();
    collaborators.mockResolvedValueOnce(collaboratorRows("bob", "charlie"));
    addCollaborator.mockReset().mockReturnValueOnce(roleRequest.promise);
    removeCollaborator.mockReset().mockReturnValueOnce(removeRequest.promise);
    patchDocument.mockReset().mockReturnValueOnce(linkRequest.promise);
    const onDocChange = vi.fn();
    const view = render(<ShareDialog open onOpenChange={vi.fn()} doc={doc} isOwner onDocChange={onDocChange} />);
    await screen.findByText("@charlie");
    fireEvent.change(within(collaboratorRow("bob")).getByRole("combobox"), { target: { value: "viewer" } });
    fireEvent.click(within(collaboratorRow("charlie")).getByRole("button", { name: "Remove charlie" }));
    fireEvent.change(screen.getByTestId("link-access"), { target: { value: "view" } });
    expect(addCollaborator).toHaveBeenCalledOnce();
    expect(removeCollaborator).toHaveBeenCalledOnce();
    expect(patchDocument).toHaveBeenCalledOnce();

    const unhandled = vi.fn();
    const onUnhandled = (reason: unknown) => unhandled(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      view.unmount();
      await act(async () => {
        roleRequest.resolve({});
        removeRequest.reject(new ApiError(503, "Late Remove failed"));
        linkRequest.reject(new ApiError(503, "Late link failed"));
        await Promise.allSettled([roleRequest.promise, removeRequest.promise, linkRequest.promise]);
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).not.toHaveBeenCalled();
      expect(onDocChange).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});

describe("ShareDialog · collaborate with an agent", () => {
  it("opens two destinations with management first and creation scoped to this document", async () => {
    await openDialog();
    const toggle = screen.getByTestId("share-agent-toggle");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(toggle).toHaveAttribute("aria-controls");
    expect(screen.queryByTestId("token-manager")).toBeNull();
    expect(screen.getByTestId("share-agent-card")).toHaveTextContent("Connect Copilot CLI or any MCP client as a collaborator");

    await expandAgentCard();
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(document.getElementById(toggle.getAttribute("aria-controls")!)).toContainElement(screen.getByTestId("token-manager"));
    expect(within(screen.getByRole("navigation", { name: "Token access" })).getAllByRole("button")).toHaveLength(2);
    expect(screen.queryByTestId("agent-connect-config")).toBeNull();
    fireEvent.click(screen.getByTestId("token-add"));
    const group = screen.getByRole("group", { name: "Scope" });
    const radios = within(group).getAllByRole("radio");
    expect(radios).toHaveLength(3);
    expect(radios.map((r) => r.getAttribute("data-testid"))).toEqual(["token-scope-read", "token-scope-comment", "token-scope-full"]);
    expect(screen.getByTestId("token-scope-comment")).toBeChecked();
    expect(group).toHaveTextContent("Comment & suggest");
    expect(screen.getByTestId("token-restrict")).toBeChecked();
    expect(screen.getByRole("link", { name: "Open all your tokens in Settings" })).toHaveAttribute("href", `/settings?next=${encodeURIComponent(`/d/${DOC_ID}`)}#tokens`);
  });

  it("creates a full-scope token for this document, displays the secret once and never puts it in setup", async () => {
    await openDialog();
    await expandAgentCard();
    fireEvent.click(screen.getByTestId("token-add"));
    fireEvent.click(screen.getByTestId("token-scope-full"));
    fireEvent.click(screen.getByTestId("token-create"));
    await screen.findByTestId("token-created");
    expect(tokensCreate).toHaveBeenCalledTimes(1);
    expect(tokensCreate).toHaveBeenCalledWith("GitHub Copilot CLI", 90, { scope: "full", documentIds: [DOC_ID] });
    expect(screen.getByTestId("token-create")).toBeDisabled();
    expect(screen.getByTestId("share-agent-toggle")).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByTestId("token-scope-chip")).toHaveTextContent("full");
    expect(copyText).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Connect an MCP client" }));
    expect(screen.getByTestId("agent-connect-config")).toHaveTextContent("MARKDOC_TOKEN");
    expect(screen.getByTestId("agent-connect-config").textContent?.includes(screen.getByTestId("copy-token").textContent!)).toBe(false);
  });

  it("keeps explicit unrestricted creation available", async () => {
    await openDialog();
    await expandAgentCard();
    fireEvent.click(screen.getByTestId("token-add"));
    fireEvent.click(screen.getByTestId("token-restrict"));
    expect(screen.getByTestId("token-restrict")).not.toBeChecked();
    fireEvent.click(screen.getByTestId("token-scope-read"));
    fireEvent.click(screen.getByTestId("token-create"));

    await waitFor(() => expect(tokensCreate).toHaveBeenCalledTimes(1));
    expect(tokensCreate).toHaveBeenCalledWith("GitHub Copilot CLI", 90, { scope: "read", documentIds: null });
    await waitFor(() => expect(screen.getByTestId("token-scope-chip")).toHaveTextContent("read"));
    expect(screen.getByTestId("token-created")).toHaveTextContent("All documents you can access");
  });

  it("keeps the comment default: Create a token with nothing changed mints a comment-scoped token for this document", async () => {
    await openDialog();
    await expandAgentCard();
    fireEvent.click(screen.getByTestId("token-add"));
    fireEvent.click(screen.getByTestId("token-create"));
    await waitFor(() => expect(tokensCreate).toHaveBeenCalledWith("GitHub Copilot CLI", 90, { scope: "comment", documentIds: [DOC_ID] }));
    await waitFor(() => expect(screen.getByTestId("token-scope-chip")).toHaveTextContent("comment"));
  });

  it("shows every existing token with management instead of guessing the newest is usable", async () => {
    tokensList.mockResolvedValue({
      tokens: [
        { id: "t-old", name: "Old bot", prefix: "mdk_old_", scope: "read", documentIds: null, createdAt: "2026-01-01T00:00:00.000Z", lastUsedAt: null, lastMcpSeenAt: null, lastMcpCallAt: null, expiresAt: null },
        { id: "t-new", name: "Newer bot", prefix: "mdk_new_", scope: "comment", documentIds: null, createdAt: "2026-08-01T00:00:00.000Z", lastUsedAt: null, lastMcpSeenAt: null, lastMcpCallAt: null, expiresAt: null },
      ],
    });
    await openDialog();
    await expandAgentCard();
    expect(screen.getAllByTestId("token-row")).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Rename Old bot" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Replace Newer bot" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Connect an MCP client" }));
    expect(screen.getByTestId("agent-connect-config")).toHaveTextContent("MARKDOC_TOKEN");
    expect(screen.getByRole("button", { name: "Replace Newer bot" })).toBeVisible();
  });
});
