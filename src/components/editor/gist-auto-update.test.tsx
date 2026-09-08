// @vitest-environment jsdom
import {
  StrictMode,
  useEffect,
  useLayoutEffect,
  type ChangeEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type RefCallback,
} from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { api, ApiError } from "@/lib/api";
import { GIST_AUTO_UPDATE_NOTICE, type GistAutoUpdateDestination, type GistAutoUpdateStatus } from "@/lib/gist-auto-update";
import type { DocumentDto } from "@/server/dto";
import { GistAutoUpdateControl } from "./gist-auto-update";
import { CommitDialog } from "./github-dialog";

const DESTINATION: GistAutoUpdateDestination = {
  gistId: "gist-auto-test",
  filename: "notes.md",
  url: "https://gist.github.com/gist-auto-test",
  visibility: "secret",
  owner: "gist-owner",
};
const DOC: DocumentDto = {
  id: "doc-auto-test",
  title: "Local notes",
  storage: "gist",
  linkAccess: "private",
  ownerId: "owner-auto-test",
  gistId: DESTINATION.gistId,
  gistFile: DESTINATION.filename,
  repoOwner: null,
  repoName: null,
  repoBranch: null,
  repoPath: null,
  publishedAt: "2026-09-05T10:00:00.000Z",
  hasUnpublishedChanges: false,
  githubUrl: DESTINATION.url,
  createdAt: "2026-09-05T09:00:00.000Z",
  updatedAt: "2026-09-05T10:00:00.000Z",
};
const OFF: GistAutoUpdateStatus = { enabled: false, status: "off", syncedAt: null, message: null, pending: false, destination: null };
const PENDING: GistAutoUpdateStatus = { ...OFF, enabled: true, status: "pending", destination: DESTINATION };
let serverStatus: GistAutoUpdateStatus;
let visibility: DocumentVisibilityState;
const originalVisibility = Object.getOwnPropertyDescriptor(document, "visibilityState");

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const settle = () => act(async () => {});
const click = (name: string) => act(async () => { fireEvent.click(screen.getByRole("button", { name })); });
const advance = (milliseconds = 2_000) => act(async () => { await vi.advanceTimersByTimeAsync(milliseconds); });
const state = () => screen.getByTestId("gist-auto-update-state");
const setVisibility = (next: DocumentVisibilityState) => {
  visibility = next;
  act(() => document.dispatchEvent(new Event("visibilitychange")));
};
async function mount(doc = DOC) {
  const result = render(<GistAutoUpdateControl doc={doc} isOwner />);
  await settle();
  return result;
}
async function consent() {
  await click("Check linked gist");
  await act(async () => { fireEvent.click(screen.getByRole("checkbox", { name: "I acknowledge the sharing and overwrite risks." })); });
}
function GistBoundary({
  doc,
  show = true,
  mount = "initial",
  passiveVisit = 0,
  onLayout,
  onPassiveCleanup,
}: {
  doc: DocumentDto;
  show?: boolean;
  mount?: "initial" | "replacement";
  passiveVisit?: number;
  onLayout?: (doc: DocumentDto, show: boolean) => void;
  onPassiveCleanup?: (doc: DocumentDto, show: boolean) => void;
}) {
  useLayoutEffect(() => {
    onLayout?.(doc, show);
  }, [doc, onLayout, show]);
  useEffect(() => {
    return () => onPassiveCleanup?.(doc, show);
  }, [doc, onPassiveCleanup, passiveVisit, show]);
  if (!show) return null;
  return mount === "initial"
    ? <InitialGistControl doc={doc} />
    : <ReplacementGistControl doc={doc} />;
}

function InitialGistControl({ doc }: { doc: DocumentDto }) {
  return <GistAutoUpdateControl doc={doc} isOwner />;
}

function ReplacementGistControl({ doc }: { doc: DocumentDto }) {
  return <GistAutoUpdateControl doc={doc} isOwner />;
}

function GistParentCommit({ visit }: { visit: number }) {
  return (
    <div data-visit={visit}>
      <GistAutoUpdateControl doc={DOC} isOwner />
    </div>
  );
}

type ButtonHandler = (event: ReactMouseEvent<HTMLButtonElement>) => void;
type CheckboxHandler = (event: ChangeEvent<HTMLInputElement>) => void;

interface CapturedButton {
  element: HTMLButtonElement;
  onClick: ButtonHandler;
  ref: RefCallback<HTMLButtonElement>;
}

interface CapturedCheckbox {
  element: HTMLInputElement;
  onChange: CheckboxHandler;
  ref: RefCallback<HTMLInputElement>;
}

interface CapturedPresentation {
  root: HTMLElement;
  rootRef: RefCallback<HTMLElement>;
  buttons: CapturedButton[];
  checkbox: CapturedCheckbox | null;
}

interface DirectView {
  host: HTMLDivElement;
  root: Root;
}

const directViews: DirectView[] = [];
const mutationObservers: MutationObserver[] = [];

function renderDirect(node: ReactNode): DirectView {
  const host = document.createElement("div");
  document.body.append(host);
  const view = { host, root: createRoot(host) };
  directViews.push(view);
  act(() => view.root.render(node));
  return view;
}

function observeMutations(target: Node = document.body) {
  const observer = new MutationObserver(() => {});
  observer.observe(target, { attributes: true, characterData: true, childList: true, subtree: true });
  mutationObservers.push(observer);
  return observer;
}

function reactProp<T>(element: HTMLElement, name: string): T {
  const propsKey = Object.keys(element).find((key) => key.startsWith("__reactProps$"));
  if (!propsKey) throw new Error(`React props were not attached to ${element.dataset.testid ?? element.tagName}`);
  const props = (element as unknown as Record<string, Record<string, unknown> | undefined>)[propsKey];
  const value = props?.[name];
  if (typeof value !== "function") throw new Error(`${name} was not attached to ${element.dataset.testid ?? element.tagName}`);
  return value as T;
}

function captureButton(element: HTMLButtonElement): CapturedButton {
  return {
    element,
    onClick: reactProp<ButtonHandler>(element, "onClick"),
    ref: reactProp<RefCallback<HTMLButtonElement>>(element, "ref"),
  };
}

function capturePresentation(): CapturedPresentation {
  const root = screen.getByTestId("gist-auto-update");
  const checkboxElement = within(root).queryByRole("checkbox") as HTMLInputElement | null;
  return {
    root,
    rootRef: reactProp<RefCallback<HTMLElement>>(root, "ref"),
    buttons: within(root).getAllByRole("button").map((element) => captureButton(element as HTMLButtonElement)),
    checkbox: checkboxElement
      ? {
          element: checkboxElement,
          onChange: reactProp<CheckboxHandler>(checkboxElement, "onChange"),
          ref: reactProp<RefCallback<HTMLInputElement>>(checkboxElement, "ref"),
        }
      : null,
  };
}

function capturedButton(presentation: CapturedPresentation, name: string) {
  const button = presentation.buttons.find((candidate) => candidate.element.textContent?.trim() === name);
  if (!button) throw new Error(`Button "${name}" was not captured`);
  return button;
}

function setNativeProvenance(event: Event, target: EventTarget) {
  const path: EventTarget[] = [];
  if (target instanceof Node) {
    for (let current: Node | null = target; current; current = current.parentNode) path.push(current);
    const ownerDocument = target instanceof Document ? target : target.ownerDocument;
    if (ownerDocument) {
      path.push(ownerDocument);
      if (ownerDocument.defaultView) path.push(ownerDocument.defaultView);
    }
  } else {
    path.push(target);
  }
  Object.defineProperties(event, {
    target: { configurable: true, value: target },
    currentTarget: { configurable: true, value: target },
    eventPhase: { configurable: true, value: Event.AT_TARGET },
    composedPath: { configurable: true, value: () => path },
  });
}

function buttonEvent(currentTarget: HTMLElement, target: EventTarget = currentTarget) {
  const ownerDocument = currentTarget.ownerDocument;
  const MouseEventConstructor = ownerDocument.defaultView?.MouseEvent ?? MouseEvent;
  const nativeEvent = new MouseEventConstructor("click", {
    bubbles: true,
    button: 0,
    cancelable: true,
  });
  setNativeProvenance(nativeEvent, target);
  return {
    type: "click",
    button: 0,
    currentTarget,
    target,
    nativeEvent,
    defaultPrevented: false,
  } as ReactMouseEvent<HTMLButtonElement>;
}

function invokeButton(
  button: CapturedButton,
  currentTarget: HTMLElement = button.element,
  event = buttonEvent(currentTarget),
) {
  button.onClick(event);
}

function checkboxEvent(currentTarget: HTMLInputElement) {
  const ownerDocument = currentTarget.ownerDocument;
  const MouseEventConstructor = ownerDocument.defaultView?.MouseEvent ?? MouseEvent;
  const nativeEvent = new MouseEventConstructor("click", {
    bubbles: true,
    button: 0,
    cancelable: true,
  });
  setNativeProvenance(nativeEvent, currentTarget);
  return {
    type: "change",
    currentTarget,
    target: currentTarget,
    nativeEvent,
    defaultPrevented: false,
  } as unknown as ChangeEvent<HTMLInputElement>;
}

function invokeCheckbox(
  checkbox: CapturedCheckbox,
  checked: boolean,
  currentTarget: HTMLInputElement = checkbox.element,
) {
  currentTarget.checked = checked;
  checkbox.onChange(checkboxEvent(currentTarget));
}

function externalOperations() {
  return vi.mocked(api.documents.gistAutoUpdate).mock.calls.length
    + vi.mocked(api.documents.gistAutoUpdatePreview).mock.calls.length
    + vi.mocked(api.documents.setGistAutoUpdate).mock.calls.length
    + vi.mocked(api.documents.retryGistAutoUpdate).mock.calls.length;
}

beforeEach(() => {
  vi.useFakeTimers();
  visibility = "visible";
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
  serverStatus = { ...OFF };
  vi.spyOn(api.documents, "gistAutoUpdate").mockImplementation(async () => serverStatus);
  vi.spyOn(api.documents, "gistAutoUpdatePreview").mockResolvedValue({ destination: DESTINATION });
  vi.spyOn(api.documents, "setGistAutoUpdate").mockImplementation(async (_id, settings) => {
    serverStatus = settings.enabled ? { ...PENDING, destination: settings.destination } : { ...OFF };
    return serverStatus;
  });
  vi.spyOn(api.documents, "retryGistAutoUpdate").mockImplementation(async () => {
    serverStatus = { ...PENDING };
    return serverStatus;
  });
});
afterEach(() => {
  cleanup();
  for (const view of directViews.splice(0)) {
    act(() => view.root.unmount());
    view.host.remove();
  }
  for (const observer of mutationObservers.splice(0)) observer.disconnect();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  if (originalVisibility) Object.defineProperty(document, "visibilityState", originalVisibility);
  else Reflect.deleteProperty(document, "visibilityState");
  document.body.replaceChildren();
});

describe("gist auto-update owner opt-in", () => {
  it("defaults to off and only reads lightweight status until an explicit preview", async () => {
    await mount();
    expect(state()).toHaveTextContent("Off");
    expect(state()).toHaveAttribute("data-status", "off");
    expect(api.documents.gistAutoUpdate).toHaveBeenCalledExactlyOnceWith(DOC.id);
    expect(screen.getByRole("button", { name: "Enable auto-update" })).toBeDisabled();
    expect(screen.queryByRole("checkbox")).toBeNull();
    await advance(6_000);
    expect(api.documents.gistAutoUpdate).toHaveBeenCalledTimes(4);
    expect(api.documents.gistAutoUpdatePreview).not.toHaveBeenCalled();
    expect(api.documents.setGistAutoUpdate).not.toHaveBeenCalled();
    expect(api.documents.retryGistAutoUpdate).not.toHaveBeenCalled();
  });

  it("requires a fresh explicit destination preview and acknowledgement, never a cached status destination", async () => {
    serverStatus = { ...OFF, destination: { ...DESTINATION, visibility: "public", owner: "previous-account" } };
    await mount();
    const destination = screen.getByTestId("gist-auto-update-destination");
    expect(destination).not.toHaveTextContent("previous-account");
    await click("Enable auto-update");
    expect(api.documents.setGistAutoUpdate).not.toHaveBeenCalled();
    await click("Check linked gist");
    expect(api.documents.gistAutoUpdatePreview).toHaveBeenCalledExactlyOnceWith(DOC.id);
    expect(within(destination).getByRole("link")).toHaveAttribute("href", DESTINATION.url);
    expect(destination).toHaveTextContent(DESTINATION.filename);
    expect(destination).toHaveTextContent("Secret (unlisted, not private)");
    expect(destination).toHaveTextContent(`GitHub account: @${DESTINATION.owner}`);
    expect(screen.getByText(GIST_AUTO_UPDATE_NOTICE)).toBeInTheDocument();
    expect(screen.getByText(/not one atomic operation/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Enable auto-update" })).toBeDisabled();
    expect(api.documents.setGistAutoUpdate).not.toHaveBeenCalled();

    await act(async () => { fireEvent.click(screen.getByRole("checkbox")); });
    expect(api.documents.setGistAutoUpdate).not.toHaveBeenCalled();
    await click("Enable auto-update");
    expect(api.documents.setGistAutoUpdate).toHaveBeenCalledExactlyOnceWith(DOC.id, {
      enabled: true,
      acknowledgeRisk: true,
      destination: DESTINATION,
    });
    expect(state()).toHaveTextContent("Pending");
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.getByRole("button", { name: "Disable auto-update" })).toBeEnabled();
    await advance(8_000);
    expect(api.documents.setGistAutoUpdate).toHaveBeenCalledTimes(1);
  });

  it("shows public visibility and clears consent whenever the destination is rechecked", async () => {
    const destination = { ...DESTINATION, visibility: "public" as const };
    vi.mocked(api.documents.gistAutoUpdatePreview).mockResolvedValue({ destination });
    await mount();
    await consent();
    expect(screen.getByTestId("gist-auto-update-destination")).toHaveTextContent("Visibility: Public");
    expect(screen.getByRole("checkbox")).toBeChecked();
    await click("Recheck linked gist");
    expect(screen.getByRole("checkbox")).not.toBeChecked();
    expect(screen.getByRole("button", { name: "Enable auto-update" })).toBeDisabled();
    expect(api.documents.gistAutoUpdatePreview).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["non-owner", DOC, false],
    ["local", { ...DOC, storage: "local" }, true],
    ["repository", { ...DOC, storage: "repo" }, true],
    ["unpublished", { ...DOC, publishedAt: null }, true],
    ["missing gist", { ...DOC, gistId: null }, true],
    ["missing file", { ...DOC, gistFile: null }, true],
    ["missing URL", { ...DOC, githubUrl: null }, true],
  ] as const)("hides for %s documents without any API calls", async (_name, doc, isOwner) => {
    render(<GistAutoUpdateControl doc={doc} isOwner={isOwner} />);
    await settle();
    await advance();
    expect(screen.queryByTestId("gist-auto-update")).toBeNull();
    expect(api.documents.gistAutoUpdate).not.toHaveBeenCalled();
    expect(api.documents.gistAutoUpdatePreview).not.toHaveBeenCalled();
    expect(api.documents.setGistAutoUpdate).not.toHaveBeenCalled();
    expect(api.documents.retryGistAutoUpdate).not.toHaveBeenCalled();
  });

  it("does not fetch or write for document/save rerenders, or reset the checked consent", async () => {
    const { rerender } = await mount();
    await consent();
    for (let n = 0; n < 10; n++) {
      rerender(<GistAutoUpdateControl doc={{ ...DOC, title: `Edit ${n}`, updatedAt: `2026-09-05T10:00:0${n}.000Z`, publishedAt: `2026-09-05T10:00:0${n}.000Z`, hasUnpublishedChanges: true }} isOwner />);
    }
    await settle();
    expect(screen.getByRole("checkbox")).toBeChecked();
    expect(api.documents.gistAutoUpdate).toHaveBeenCalledTimes(1);
    expect(api.documents.gistAutoUpdatePreview).toHaveBeenCalledTimes(1);
    expect(api.documents.setGistAutoUpdate).not.toHaveBeenCalled();
    expect(api.documents.retryGistAutoUpdate).not.toHaveBeenCalled();
  });
});

describe("gist auto-update status and recovery", () => {
  it("distinguishes pending, syncing with a newer saved version, and synced-at", async () => {
    serverStatus = { ...PENDING, pending: true };
    await mount();
    expect(state()).toHaveTextContent("Pending");
    expect(screen.getByText("The latest saved version is waiting to publish.")).toBeInTheDocument();
    expect(screen.queryByTestId("gist-auto-update-pending")).toBeNull();
    serverStatus = { ...PENDING, status: "syncing", pending: true };
    await advance();
    expect(state()).toHaveTextContent("Syncing");
    expect(screen.getByTestId("gist-auto-update-pending")).toHaveTextContent("newest saved version is pending behind the current upload");
    const syncedAt = "2026-09-05T10:20:00.000Z";
    serverStatus = { ...PENDING, status: "synced", syncedAt };
    await advance();
    expect(state()).toHaveTextContent("Synced");
    expect(screen.queryByTestId("gist-auto-update-pending")).toBeNull();
    expect(screen.getByText(/Last synced at/).querySelector("time")).toHaveAttribute("datetime", syncedAt);
    expect(api.documents.setGistAutoUpdate).not.toHaveBeenCalled();
  });

  it.each(["failed", "conflict"] as const)("only retries %s after the owner requests the latest saved version", async (failure) => {
    serverStatus = { ...PENDING, status: failure, message: failure === "conflict" ? "Outside changes detected." : "GitHub is unavailable." };
    await mount();
    expect(state()).toHaveAttribute("data-status", failure);
    expect(screen.getByText(serverStatus.message!)).toBeInTheDocument();
    if (failure === "conflict") {
      expect(screen.getByText(/Manually reconcile/)).toHaveTextContent("Retry does not force an overwrite or resolve a known conflict");
    }
    await advance(20_000);
    expect(api.documents.gistAutoUpdate).toHaveBeenCalledTimes(1);
    expect(api.documents.retryGistAutoUpdate).not.toHaveBeenCalled();
    await click("Retry latest saved version");
    expect(api.documents.retryGistAutoUpdate).toHaveBeenCalledExactlyOnceWith(DOC.id);
    expect(api.documents.setGistAutoUpdate).not.toHaveBeenCalled();
    expect(state()).toHaveTextContent("Pending");
    await advance();
    expect(api.documents.retryGistAutoUpdate).toHaveBeenCalledTimes(1);
  });

  it("returns to conflict when the queued retry's strict preflight cannot reconcile it", async () => {
    const conflict: GistAutoUpdateStatus = { ...PENDING, status: "conflict", message: "Reconcile the outside changes first." };
    serverStatus = conflict;
    await mount();
    await click("Retry latest saved version");
    expect(state()).toHaveTextContent("Pending");
    serverStatus = conflict;
    await advance();
    expect(state()).toHaveTextContent("Conflict");
    expect(screen.getByRole("button", { name: "Retry latest saved version" })).toBeEnabled();
    await advance(20_000);
    expect(api.documents.retryGistAutoUpdate).toHaveBeenCalledTimes(1);
  });

  it("does not automatically retry a rejected retry request", async () => {
    serverStatus = { ...PENDING, status: "failed" };
    vi.mocked(api.documents.retryGistAutoUpdate).mockRejectedValue(new ApiError(503, "GitHub is unavailable."));
    await mount();
    await click("Retry latest saved version");
    expect(screen.getByRole("alert")).toHaveTextContent("GitHub is unavailable.");
    await advance(20_000);
    expect(api.documents.retryGistAutoUpdate).toHaveBeenCalledTimes(1);
    expect(api.documents.gistAutoUpdate).toHaveBeenCalledTimes(1);
  });

  it("disables explicitly during an upload without claiming that the upload was cancelled", async () => {
    serverStatus = { ...PENDING, status: "syncing", pending: true };
    const message = "Auto-update is off. An upload already in progress may finish.";
    vi.mocked(api.documents.setGistAutoUpdate).mockImplementationOnce(async () => {
      serverStatus = { ...OFF, message };
      return serverStatus;
    });
    await mount();
    expect(screen.getByText(/An update already in progress may still finish/)).toBeInTheDocument();
    await click("Disable auto-update");
    expect(api.documents.setGistAutoUpdate).toHaveBeenCalledExactlyOnceWith(DOC.id, { enabled: false });
    expect(state()).toHaveTextContent("Off");
    expect(screen.getByText(message)).toBeInTheDocument();
    expect(screen.queryByTestId("gist-auto-update-pending")).toBeNull();
    expect(screen.getByText(/An update already in progress may still finish/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Enable auto-update" })).toBeDisabled();
    expect(screen.queryByRole("checkbox")).toBeNull();
  });

  it.each([409, 503])("keeps Disable available after HTTP %i, without assuming success or retrying automatically", async (httpStatus) => {
    serverStatus = { ...PENDING };
    const message = httpStatus === 409 ? "Publishing configuration is busy. Try again after it finishes." : "Could not save the setting.";
    vi.mocked(api.documents.setGistAutoUpdate).mockRejectedValue(new ApiError(httpStatus, message));
    await mount();
    await click("Disable auto-update");
    expect(screen.getByRole("alert")).toHaveTextContent(message);
    expect(state()).not.toHaveAttribute("data-status", "off");
    expect(screen.getByRole("button", { name: "Disable auto-update" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Enable auto-update" })).toBeNull();
    await advance(20_000);
    expect(api.documents.setGistAutoUpdate).toHaveBeenCalledTimes(1);
  });

  it("can check a mutation's uncertain outcome without sending the mutation again", async () => {
    vi.mocked(api.documents.setGistAutoUpdate).mockRejectedValue(new Error("Response interrupted."));
    await mount();
    await consent();
    await click("Enable auto-update");
    expect(screen.getByRole("alert")).toHaveTextContent("Response interrupted.");
    serverStatus = { ...PENDING };
    await click("Refresh status");
    expect(state()).toHaveTextContent("Pending");
    expect(screen.getByRole("button", { name: "Disable auto-update" })).toBeEnabled();
    expect(api.documents.setGistAutoUpdate).toHaveBeenCalledTimes(1);
  });

  it("stops polling on status errors and only resumes after an explicit refresh", async () => {
    vi.mocked(api.documents.gistAutoUpdate).mockRejectedValueOnce(new ApiError(503, "Status unavailable."));
    await mount();
    expect(state()).toHaveTextContent("Failed");
    expect(screen.getByRole("alert")).toHaveTextContent("Status unavailable.");
    expect(screen.getByRole("button", { name: "Enable auto-update" })).toBeDisabled();
    await advance(20_000);
    expect(api.documents.gistAutoUpdate).toHaveBeenCalledTimes(1);
    await click("Refresh status");
    expect(state()).toHaveTextContent("Off");
    await advance();
    expect(api.documents.gistAutoUpdate).toHaveBeenCalledTimes(3);
    expect(api.documents.setGistAutoUpdate).not.toHaveBeenCalled();
  });

  it("requires an explicit new destination check after a preview failure", async () => {
    vi.mocked(api.documents.gistAutoUpdatePreview).mockRejectedValueOnce(new ApiError(403, "Cannot read this gist."));
    await mount();
    await click("Check linked gist");
    expect(screen.getByRole("alert")).toHaveTextContent("Cannot read this gist.");
    expect(screen.getByRole("button", { name: "Enable auto-update" })).toBeDisabled();
    await advance(20_000);
    expect(api.documents.gistAutoUpdatePreview).toHaveBeenCalledTimes(1);
    expect(api.documents.gistAutoUpdate).toHaveBeenCalledTimes(1);
    await click("Check linked gist");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("checkbox")).not.toBeChecked();
  });

  it("shows a wait-for-save activation refusal without turning the control on or retrying it", async () => {
    const message = "Wait for Markdoc to finish saving before enabling auto-update, then check the linked gist again. The auto-update setting has not changed.";
    vi.mocked(api.documents.setGistAutoUpdate).mockRejectedValueOnce(new ApiError(409, message));
    await mount();
    await consent();
    await click("Enable auto-update");
    expect(screen.getByRole("alert")).toHaveTextContent(message);
    expect(screen.queryByRole("button", { name: "Disable auto-update" })).toBeNull();
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.getByRole("button", { name: "Enable auto-update" })).toBeDisabled();
    await advance(10_000);
    expect(api.documents.setGistAutoUpdate).toHaveBeenCalledTimes(1);
    await click("Refresh status");
    expect(state()).toHaveTextContent("Off");
    await consent();
    await click("Enable auto-update");
    expect(state()).toHaveTextContent("Pending");
    expect(api.documents.setGistAutoUpdate).toHaveBeenCalledTimes(2);
  });

  it("preserves the manual Update gist description through a failed opt-in and never submits via its own controls", async () => {
    const onCommit = vi.fn().mockResolvedValue(undefined);
    vi.mocked(api.documents.setGistAutoUpdate).mockRejectedValue(new ApiError(409, "Review the changed gist first.", undefined, { status: "conflict" }));
    render(<CommitDialog open onOpenChange={vi.fn()} doc={DOC} isOwner onCommit={onCommit} />);
    await settle();
    fireEvent.change(screen.getByTestId("commit-message"), { target: { value: "Keep this manual description" } });
    await consent();
    for (const button of within(screen.getByTestId("gist-auto-update")).getAllByRole("button")) expect(button).toHaveAttribute("type", "button");
    await click("Enable auto-update");
    expect(state()).toHaveTextContent("Conflict");
    expect(screen.getByTestId("commit-message")).toHaveValue("Keep this manual description");
    expect(onCommit).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Enable auto-update" })).toBeDisabled();
    expect(screen.queryByRole("checkbox")).toBeNull();
    await advance(10_000);
    expect(api.documents.setGistAutoUpdate).toHaveBeenCalledTimes(1);
    await act(async () => { fireEvent.click(screen.getByTestId("commit-submit")); });
    expect(onCommit).toHaveBeenCalledExactlyOnceWith("Keep this manual description");
  });
});

describe("gist auto-update request lifetimes", () => {
  it("waits on a hidden mount, then checks once immediately and restores the settle-then-schedule cadence", async () => {
    visibility = "hidden";
    await mount();
    await advance(20_000);
    expect(api.documents.gistAutoUpdate).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    expect(state()).toHaveAttribute("data-status", "loading");

    setVisibility("visible");
    expect(api.documents.gistAutoUpdate).toHaveBeenCalledExactlyOnceWith(DOC.id);
    await settle();
    expect(state()).toHaveTextContent("Off");
    expect(vi.getTimerCount()).toBe(1);

    act(() => document.dispatchEvent(new Event("visibilitychange")));
    await advance(1_999);
    expect(api.documents.gistAutoUpdate).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(api.documents.gistAutoUpdate).toHaveBeenCalledTimes(2);
  });

  it("cancels a scheduled check while hidden and starts one current check per visibility return", async () => {
    await mount();
    expect(vi.getTimerCount()).toBe(1);

    setVisibility("hidden");
    expect(vi.getTimerCount()).toBe(0);
    await advance(20_000);
    expect(api.documents.gistAutoUpdate).toHaveBeenCalledTimes(1);

    setVisibility("visible");
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    expect(api.documents.gistAutoUpdate).toHaveBeenCalledTimes(2);
    await settle();
    expect(vi.getTimerCount()).toBe(1);
    await advance();
    expect(api.documents.gistAutoUpdate).toHaveBeenCalledTimes(3);
  });

  it.each(["resolve", "reject"] as const)("invalidates a pending automatic status %s while hidden without stale state, error, busy, or timer commits", async (outcome) => {
    const oldStatus = deferred<GistAutoUpdateStatus>();
    vi.mocked(api.documents.gistAutoUpdate).mockReturnValueOnce(oldStatus.promise);
    await mount();
    expect(api.documents.gistAutoUpdate).toHaveBeenCalledTimes(1);

    setVisibility("hidden");
    await act(async () => {
      if (outcome === "resolve") oldStatus.resolve(PENDING);
      else oldStatus.reject(new ApiError(503, "Stale hidden status error."));
    });
    await advance(20_000);

    expect(state()).toHaveAttribute("data-status", "loading");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByTestId("gist-auto-update-destination")).not.toHaveTextContent("GitHub account:");
    expect(screen.getByRole("button", { name: "Check linked gist" })).toBeDisabled();
    expect(api.documents.gistAutoUpdate).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);

    setVisibility("visible");
    expect(api.documents.gistAutoUpdate).toHaveBeenCalledTimes(2);
    await settle();
    expect(state()).toHaveTextContent("Off");
    expect(screen.getByRole("button", { name: "Check linked gist" })).toBeEnabled();
    expect(vi.getTimerCount()).toBe(1);
  });

  it("queues one visible resume behind an old request and keeps visibility events and timer ticks single-flight", async () => {
    const first = deferred<GistAutoUpdateStatus>();
    const second = deferred<GistAutoUpdateStatus>();
    const third = deferred<GistAutoUpdateStatus>();
    const requests = [first, second, third];
    let activeRequests = 0;
    let maxActiveRequests = 0;
    vi.mocked(api.documents.gistAutoUpdate).mockImplementation(() => {
      const request = requests.shift();
      if (!request) return Promise.resolve(OFF);
      activeRequests++;
      maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
      return request.promise.finally(() => { activeRequests--; });
    });

    await mount();
    setVisibility("hidden");
    setVisibility("visible");
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    await advance(20_000);
    expect(api.documents.gistAutoUpdate).toHaveBeenCalledTimes(1);

    await act(async () => { first.resolve(PENDING); });
    expect(api.documents.gistAutoUpdate).toHaveBeenCalledTimes(2);
    expect(state()).toHaveAttribute("data-status", "loading");
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    await advance(20_000);
    expect(api.documents.gistAutoUpdate).toHaveBeenCalledTimes(2);

    await act(async () => { second.resolve(OFF); });
    expect(state()).toHaveTextContent("Off");
    expect(vi.getTimerCount()).toBe(1);
    await advance();
    expect(api.documents.gistAutoUpdate).toHaveBeenCalledTimes(3);
    await advance(20_000);
    expect(api.documents.gistAutoUpdate).toHaveBeenCalledTimes(3);
    expect(maxActiveRequests).toBe(1);

    await act(async () => { third.resolve(OFF); });
    expect(vi.getTimerCount()).toBe(1);
  });

  it("invalidates an explicit preview while hidden and queues one current status behind it on return", async () => {
    const explicitPreview = deferred<{ destination: GistAutoUpdateDestination }>();
    await mount();
    vi.mocked(api.documents.gistAutoUpdatePreview).mockReturnValueOnce(explicitPreview.promise);
    await click("Check linked gist");
    expect(api.documents.gistAutoUpdatePreview).toHaveBeenCalledTimes(1);

    setVisibility("hidden");
    setVisibility("visible");
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    await advance(20_000);
    expect(api.documents.gistAutoUpdatePreview).toHaveBeenCalledTimes(1);
    expect(api.documents.gistAutoUpdate).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);

    await act(async () => { explicitPreview.resolve({ destination: DESTINATION }); });
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(api.documents.gistAutoUpdate).toHaveBeenCalledTimes(2);
    expect(state()).toHaveTextContent("Off");
    expect(vi.getTimerCount()).toBe(1);
    await advance(1_999);
    expect(api.documents.gistAutoUpdate).toHaveBeenCalledTimes(2);
    await advance(1);
    expect(api.documents.gistAutoUpdate).toHaveBeenCalledTimes(3);
  });

  it("serializes immediate duplicate and mixed explicit activation before React rerenders", async () => {
    const previewRequest = deferred<{ destination: GistAutoUpdateDestination }>();
    await mount();
    vi.mocked(api.documents.gistAutoUpdatePreview).mockReturnValueOnce(previewRequest.promise);

    act(() => {
      const check = screen.getByRole("button", { name: "Check linked gist" });
      fireEvent.click(check);
      fireEvent.click(check);
    });
    await settle();
    expect(api.documents.gistAutoUpdatePreview).toHaveBeenCalledTimes(1);

    await act(async () => { previewRequest.resolve({ destination: DESTINATION }); });
    fireEvent.click(screen.getByRole("checkbox"));
    const enableRequest = deferred<GistAutoUpdateStatus>();
    vi.mocked(api.documents.setGistAutoUpdate).mockReturnValueOnce(enableRequest.promise);
    act(() => {
      const enable = screen.getByRole("button", { name: "Enable auto-update" });
      const recheck = screen.getByRole("button", { name: "Recheck linked gist" });
      fireEvent.click(enable);
      fireEvent.click(enable);
      fireEvent.click(recheck);
    });
    await settle();
    expect(api.documents.setGistAutoUpdate).toHaveBeenCalledTimes(1);
    expect(api.documents.gistAutoUpdatePreview).toHaveBeenCalledTimes(1);

    await act(async () => { enableRequest.resolve(PENDING); });
    expect(state()).toHaveTextContent("Pending");
  });

  it("does not let an old status finalizer clear a current preview owner", async () => {
    const oldStatus = deferred<GistAutoUpdateStatus>();
    const currentPreview = deferred<{ destination: GistAutoUpdateDestination }>();
    await mount();
    vi.mocked(api.documents.gistAutoUpdate).mockReturnValueOnce(oldStatus.promise);
    await advance();
    vi.mocked(api.documents.gistAutoUpdatePreview).mockReturnValueOnce(currentPreview.promise);
    await click("Check linked gist");

    await act(async () => { oldStatus.resolve(PENDING); });
    expect(state()).toHaveTextContent("Off");
    expect(screen.getByTestId("gist-auto-update-preview")).toHaveAttribute("data-status", "checking");
    expect(screen.getByRole("button", { name: "Enable auto-update" })).toBeDisabled();
    expect(vi.getTimerCount()).toBe(0);

    await act(async () => { currentPreview.resolve({ destination: DESTINATION }); });
    expect(screen.getByRole("checkbox")).not.toBeChecked();
    expect(vi.getTimerCount()).toBe(1);
  });

  it.each(["resolve", "reject"] as const)("ignores a late poll that would %s after enabling", async (outcome) => {
    const poll = deferred<GistAutoUpdateStatus>();
    await mount();
    await consent();
    vi.mocked(api.documents.gistAutoUpdate).mockReturnValueOnce(poll.promise);
    await advance();
    expect(api.documents.gistAutoUpdate).toHaveBeenCalledTimes(2);
    await click("Enable auto-update");
    expect(state()).toHaveTextContent("Pending");
    await act(async () => {
      if (outcome === "resolve") poll.resolve(OFF);
      else poll.reject(new ApiError(503, "Stale status error."));
    });
    expect(state()).toHaveTextContent("Pending");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("button", { name: "Disable auto-update" })).toBeEnabled();
  });

  it("ignores a late enabled poll after an explicit disable", async () => {
    const poll = deferred<GistAutoUpdateStatus>();
    serverStatus = { ...PENDING };
    await mount();
    vi.mocked(api.documents.gistAutoUpdate).mockReturnValueOnce(poll.promise);
    await advance();
    await click("Disable auto-update");
    await act(async () => { poll.resolve(PENDING); });
    expect(state()).toHaveTextContent("Off");
    expect(screen.queryByRole("button", { name: "Disable auto-update" })).toBeNull();
  });

  it("ignores an old document's status response", async () => {
    const oldStatus = deferred<GistAutoUpdateStatus>();
    vi.mocked(api.documents.gistAutoUpdate).mockReturnValueOnce(oldStatus.promise);
    const { rerender } = await mount();
    const nextDoc = { ...DOC, id: "another-doc" };
    rerender(<GistAutoUpdateControl doc={nextDoc} isOwner />);
    await settle();
    await act(async () => { oldStatus.resolve(PENDING); });
    expect(state()).toHaveTextContent("Off");
    expect(api.documents.gistAutoUpdate).toHaveBeenNthCalledWith(2, nextDoc.id);
    await advance();
    expect(api.documents.gistAutoUpdate).toHaveBeenLastCalledWith(nextDoc.id);
  });

  it.each(["resolve", "reject"] as const)(
    "retires a replaced document before an old status can %s in the parent layout boundary",
    async (outcome) => {
      const oldStatus = deferred<GistAutoUpdateStatus>();
      const currentStatus = deferred<GistAutoUpdateStatus>();
      const nextDoc = { ...DOC, id: "layout-replacement-doc" };
      let oldPassiveCleaned = false;
      const onLayout = vi.fn((doc: DocumentDto) => {
        if (doc.id !== nextDoc.id) return;
        expect(oldPassiveCleaned).toBe(false);
        if (outcome === "resolve") oldStatus.resolve(PENDING);
        else oldStatus.reject(new ApiError(503, "Retired status failure."));
      });
      const onPassiveCleanup = vi.fn((doc: DocumentDto) => {
        if (doc.id === DOC.id) oldPassiveCleaned = true;
      });
      vi.mocked(api.documents.gistAutoUpdate)
        .mockReturnValueOnce(oldStatus.promise)
        .mockReturnValueOnce(currentStatus.promise);
      const { rerender } = render(
        <GistBoundary doc={DOC} onLayout={onLayout} onPassiveCleanup={onPassiveCleanup} />,
      );
      await settle();

      rerender(<GistBoundary doc={nextDoc} onLayout={onLayout} onPassiveCleanup={onPassiveCleanup} />);
      await settle();
      expect(api.documents.gistAutoUpdate).toHaveBeenCalledTimes(2);
      expect(api.documents.gistAutoUpdate).toHaveBeenNthCalledWith(2, nextDoc.id);
      expect(state()).toHaveAttribute("data-status", "loading");
      expect(screen.queryByRole("alert")).toBeNull();
      expect(screen.getByRole("button", { name: "Check linked gist" })).toBeDisabled();
      expect(vi.getTimerCount()).toBe(0);

      await act(async () => { currentStatus.resolve(OFF); });
      expect(state()).toHaveTextContent("Off");
      expect(screen.getByRole("button", { name: "Check linked gist" })).toBeEnabled();
      expect(vi.getTimerCount()).toBe(1);
    },
  );

  it.each(["resolve", "reject"] as const)(
    "retires removed DOM before an explicit enable can %s in the parent layout boundary",
    async (outcome) => {
      const enableRequest = deferred<GistAutoUpdateStatus>();
      let oldPassiveCleaned = false;
      const onLayout = vi.fn((_doc: DocumentDto, show: boolean) => {
        if (show) return;
        expect(oldPassiveCleaned).toBe(false);
        if (outcome === "resolve") enableRequest.resolve(PENDING);
        else enableRequest.reject(new ApiError(503, "Retired enable failure."));
      });
      const onPassiveCleanup = vi.fn((_doc: DocumentDto, show: boolean) => {
        if (show) oldPassiveCleaned = true;
      });
      vi.mocked(api.documents.setGistAutoUpdate).mockReturnValueOnce(enableRequest.promise);
      const { rerender } = render(
        <GistBoundary doc={DOC} onLayout={onLayout} onPassiveCleanup={onPassiveCleanup} />,
      );
      await settle();
      await consent();
      await click("Enable auto-update");
      expect(api.documents.setGistAutoUpdate).toHaveBeenCalledTimes(1);

      rerender(<GistBoundary doc={DOC} show={false} onLayout={onLayout} onPassiveCleanup={onPassiveCleanup} />);
      await settle();
      expect(screen.queryByTestId("gist-auto-update")).toBeNull();
      expect(vi.getTimerCount()).toBe(0);
      await advance(20_000);
      expect(api.documents.gistAutoUpdate).toHaveBeenCalledTimes(1);
      expect(api.documents.setGistAutoUpdate).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    { gistId: "new-gist", githubUrl: "https://gist.github.com/new-gist" },
    { gistFile: "renamed.md" },
    { githubUrl: "https://gist.github.com/new-owner/gist-auto-test" },
  ])("ignores an old preview after the destination changes: %j", async (change) => {
    const oldPreview = deferred<{ destination: GistAutoUpdateDestination }>();
    vi.mocked(api.documents.gistAutoUpdatePreview).mockReturnValueOnce(oldPreview.promise);
    const { rerender } = await mount();
    await click("Check linked gist");
    rerender(<GistAutoUpdateControl doc={{ ...DOC, ...change }} isOwner />);
    await settle();
    await act(async () => { oldPreview.resolve({ destination: DESTINATION }); });
    expect(state()).toHaveTextContent("Off");
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.getByRole("button", { name: "Enable auto-update" })).toBeDisabled();
    expect(screen.getByTestId("gist-auto-update-destination")).not.toHaveTextContent("GitHub account:");
  });

  it("does not apply an old document's successful mutation to a new document", async () => {
    const mutation = deferred<GistAutoUpdateStatus>();
    vi.mocked(api.documents.setGistAutoUpdate).mockReturnValueOnce(mutation.promise);
    const { rerender } = await mount();
    await consent();
    await click("Enable auto-update");
    rerender(<GistAutoUpdateControl doc={{ ...DOC, id: "another-doc" }} isOwner />);
    await settle();
    await act(async () => { mutation.resolve(PENDING); });
    expect(state()).toHaveTextContent("Off");
    expect(screen.getByRole("button", { name: "Enable auto-update" })).toBeDisabled();
    expect(api.documents.setGistAutoUpdate).toHaveBeenCalledTimes(1);
  });

  it.each(["status", "preview"] as const)("rejects a mismatched %s destination rather than offering opt-in", async (source) => {
    const destination = { ...DESTINATION, filename: "different.md" };
    if (source === "status") serverStatus = { ...PENDING, destination };
    else vi.mocked(api.documents.gistAutoUpdatePreview).mockResolvedValue({ destination });
    await mount();
    if (source === "preview") await click("Check linked gist");
    expect(state()).toHaveTextContent("Conflict");
    expect(screen.getByRole("alert")).toHaveTextContent("The linked gist changed.");
    expect(screen.getByRole("button", { name: "Enable auto-update" })).toBeDisabled();
    expect(api.documents.setGistAutoUpdate).not.toHaveBeenCalled();
    await advance(20_000);
    expect(api.documents.gistAutoUpdate).toHaveBeenCalledTimes(1);
  });

  it("clears the timer on unmount and never keeps polling a closed dialog", async () => {
    const { unmount } = await mount();
    expect(vi.getTimerCount()).toBe(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
    setVisibility("hidden");
    setVisibility("visible");
    await advance(20_000);
    expect(api.documents.gistAutoUpdate).toHaveBeenCalledTimes(1);
  });

  it.each(["status", "preview", "enable"] as const)("ignores an in-flight %s response after unmount", async (kind) => {
    const result = deferred<GistAutoUpdateStatus & { destination: GistAutoUpdateDestination }>();
    if (kind === "status") vi.mocked(api.documents.gistAutoUpdate).mockReturnValueOnce(result.promise);
    if (kind === "preview") vi.mocked(api.documents.gistAutoUpdatePreview).mockReturnValueOnce(result.promise);
    if (kind === "enable") vi.mocked(api.documents.setGistAutoUpdate).mockReturnValueOnce(result.promise);
    const { unmount } = await mount();
    if (kind === "preview") await click("Check linked gist");
    if (kind === "enable") {
      await consent();
      await click("Enable auto-update");
    }
    unmount();
    await act(async () => { result.resolve({ ...PENDING, destination: DESTINATION }); });
    expect(vi.getTimerCount()).toBe(0);
    await advance(20_000);
    expect(api.documents.gistAutoUpdate).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("gist-auto-update")).toBeNull();
  });
});

describe("gist auto-update settings publication ownership", () => {
  it("keeps every interaction family exact through direct-root Strict Mode replay", async () => {
    const layouts: CapturedPresentation[] = [];
    renderDirect(
      <StrictMode>
        <GistBoundary
          doc={DOC}
          onLayout={() => {
            if (layouts.length === 0) layouts.push(capturePresentation());
          }}
        />
      </StrictMode>,
    );
    await settle();

    const first = layouts[0];
    if (!first) throw new Error("Strict Mode did not expose its first settings publication");
    const current = capturePresentation();
    const staleCheck = capturedButton(first, "Check linked gist");
    const currentCheck = capturedButton(current, "Check linked gist");
    expect(current.root).toBe(first.root);
    expect(currentCheck.element).toBe(staleCheck.element);
    expect(currentCheck.onClick).not.toBe(staleCheck.onClick);
    expect(currentCheck.ref).not.toBe(staleCheck.ref);

    act(() => {
      first.rootRef(current.root);
      first.buttons.forEach((button, index) => button.ref(current.buttons[index]?.element ?? null));
      [...first.buttons].reverse().forEach((button) => button.ref(null));
      first.rootRef(null);
    });

    const checkEvent = buttonEvent(currentCheck.element);
    act(() => {
      staleCheck.onClick(checkEvent);
      currentCheck.onClick(checkEvent);
      currentCheck.onClick(checkEvent);
    });
    await settle();
    expect(api.documents.gistAutoUpdatePreview).toHaveBeenCalledOnce();

    const recheck = capturedButton(capturePresentation(), "Recheck linked gist");
    act(() => {
      const event = buttonEvent(recheck.element);
      recheck.onClick(event);
      recheck.onClick(event);
    });
    await settle();
    expect(api.documents.gistAutoUpdatePreview).toHaveBeenCalledTimes(2);

    const acknowledged = capturePresentation().checkbox;
    if (!acknowledged) throw new Error("Checked destination did not render acknowledgement");
    acknowledged.element.checked = true;
    const acknowledgementEvent = checkboxEvent(acknowledged.element);
    act(() => {
      acknowledged.onChange(acknowledgementEvent);
      acknowledged.onChange(acknowledgementEvent);
    });
    expect(screen.getByRole("checkbox")).toBeChecked();

    const enable = capturedButton(capturePresentation(), "Enable auto-update");
    act(() => {
      const event = buttonEvent(enable.element);
      enable.onClick(event);
      enable.onClick(event);
    });
    await settle();
    expect(api.documents.setGistAutoUpdate).toHaveBeenCalledExactlyOnceWith(DOC.id, {
      enabled: true,
      acknowledgeRisk: true,
      destination: DESTINATION,
    });

    const disable = capturedButton(capturePresentation(), "Disable auto-update");
    act(() => {
      const event = buttonEvent(disable.element);
      disable.onClick(event);
      disable.onClick(event);
    });
    await settle();
    expect(api.documents.setGistAutoUpdate).toHaveBeenCalledTimes(2);

    serverStatus = { ...PENDING, status: "failed", message: "Retry this version." };
    await advance();
    const retry = capturedButton(capturePresentation(), "Retry latest saved version");
    act(() => {
      const event = buttonEvent(retry.element);
      retry.onClick(event);
      retry.onClick(event);
    });
    await settle();
    expect(api.documents.retryGistAutoUpdate).toHaveBeenCalledOnce();

    vi.mocked(api.documents.gistAutoUpdate).mockRejectedValueOnce(new ApiError(503, "Status unavailable."));
    await advance();
    const refresh = capturedButton(capturePresentation(), "Refresh status");
    const statusCalls = vi.mocked(api.documents.gistAutoUpdate).mock.calls.length;
    act(() => {
      const event = buttonEvent(refresh.element);
      refresh.onClick(event);
      refresh.onClick(event);
    });
    await settle();
    expect(api.documents.gistAutoUpdate).toHaveBeenCalledTimes(statusCalls + 1);
  });

  it.each([
    "partial replay",
    "detach and reinsert",
    "replace and restore",
    "reorder and restore",
    "mutate and restore",
  ] as const)("permanently rejects controls after %s history", async (change) => {
    renderDirect(<StrictMode><GistAutoUpdateControl doc={DOC} isOwner /></StrictMode>);
    await settle();
    const presentation = capturePresentation();
    const check = capturedButton(presentation, "Check linked gist");

    if (change === "partial replay") {
      act(() => {
        presentation.rootRef(null);
        presentation.rootRef(presentation.root);
      });
    } else if (change === "detach and reinsert") {
      const parent = presentation.root.parentNode;
      const next = presentation.root.nextSibling;
      if (!parent) throw new Error("Settings root had no parent");
      presentation.root.remove();
      parent.insertBefore(presentation.root, next);
    } else if (change === "replace and restore") {
      const replacement = check.element.cloneNode(true) as HTMLButtonElement;
      check.element.replaceWith(replacement);
      replacement.replaceWith(check.element);
    } else if (change === "reorder and restore") {
      const parent = check.element.parentNode;
      const next = check.element.nextSibling;
      if (!parent) throw new Error("Check button had no parent");
      parent.append(check.element);
      parent.insertBefore(check.element, next);
    } else {
      check.element.setAttribute("aria-label", "Changed");
      check.element.removeAttribute("aria-label");
    }

    const operations = externalOperations();
    act(() => {
      invokeButton(check);
      invokeButton(check);
    });
    expect(externalOperations()).toBe(operations);
  });

  it("keeps current controls usable after an unrelated nonadjacent sibling mutation", async () => {
    const view = renderDirect(
      <StrictMode>
        <span data-testid="before-settings" />
        <GistAutoUpdateControl doc={DOC} isOwner />
        <span data-testid="after-settings" />
      </StrictMode>,
    );
    await settle();
    const check = capturedButton(capturePresentation(), "Check linked gist");
    const unrelated = document.createElement("span");
    view.host.append(unrelated);
    const operations = externalOperations();

    act(() => invokeButton(check));
    await settle();
    expect(externalOperations()).toBe(operations + 1);
  });

  it("keeps a stable checkbox publication exact through repeated parent commits and failed-poll recovery", async () => {
    const view = renderDirect(<StrictMode><GistParentCommit visit={0} /></StrictMode>);
    await settle();

    const check = capturedButton(capturePresentation(), "Check linked gist");
    const previewCalls = vi.mocked(api.documents.gistAutoUpdatePreview).mock.calls.length;
    act(() => {
      const event = buttonEvent(check.element);
      check.onClick(event);
      check.onClick(event);
    });
    await settle();
    expect(api.documents.gistAutoUpdatePreview).toHaveBeenCalledTimes(previewCalls + 1);
    vi.mocked(api.documents.gistAutoUpdate).mockRejectedValueOnce(new ApiError(503, "Status unavailable."));
    await advance();
    expect(state()).toHaveTextContent("Failed");

    const stable = capturePresentation();
    const stableCheckbox = stable.checkbox;
    if (!stableCheckbox) throw new Error("Checked destination did not render acknowledgement");
    const inputRecords: MutationRecord[] = [];
    const observer = new MutationObserver((records) => {
      inputRecords.push(...records.filter((record) => record.target === stableCheckbox.element));
    });
    observer.observe(stableCheckbox.element, { attributes: true, attributeOldValue: true });
    mutationObservers.push(observer);

    for (let visit = 1; visit <= 3; visit++) {
      act(() => view.root.render(<StrictMode><GistParentCommit visit={visit} /></StrictMode>));
      await settle();
    }

    const current = capturePresentation();
    if (!current.checkbox) throw new Error("Parent commits removed acknowledgement");
    expect(current.root).toBe(stable.root);
    expect(current.rootRef).toBe(stable.rootRef);
    expect(current.checkbox.element).toBe(stableCheckbox.element);
    expect(current.checkbox.ref).toBe(stableCheckbox.ref);
    for (const label of ["Refresh status", "Recheck linked gist", "Enable auto-update"]) {
      expect(capturedButton(current, label).ref).toBe(capturedButton(stable, label).ref);
    }
    expect(inputRecords.map((record) => [record.attributeName, record.oldValue])).toEqual([
      ["name", null],
      ["type", "checkbox"],
      ["name", ""],
      ["name", null],
      ["type", "checkbox"],
      ["name", ""],
      ["name", null],
      ["type", "checkbox"],
      ["name", ""],
    ]);
    expect(current.checkbox.element).not.toHaveAttribute("name");
    expect(current.checkbox.element).toHaveAttribute("type", "checkbox");

    const operationsBeforeAcknowledgement = externalOperations();
    act(() => {
      current.checkbox!.element.checked = true;
      const event = checkboxEvent(current.checkbox!.element);
      current.checkbox!.onChange(event);
      current.checkbox!.onChange(event);
    });
    expect(externalOperations()).toBe(operationsBeforeAcknowledgement);
    expect(screen.getByRole("checkbox")).toBeChecked();

    const statusCalls = vi.mocked(api.documents.gistAutoUpdate).mock.calls.length;
    const refresh = capturedButton(capturePresentation(), "Refresh status");
    act(() => {
      const event = buttonEvent(refresh.element);
      refresh.onClick(event);
      refresh.onClick(event);
    });
    await settle();
    expect(api.documents.gistAutoUpdate).toHaveBeenCalledTimes(statusCalls + 1);
    expect(state()).toHaveTextContent("Off");
    expect(screen.getByRole("button", { name: "Enable auto-update" })).toBeEnabled();

    const recheckCalls = vi.mocked(api.documents.gistAutoUpdatePreview).mock.calls.length;
    const recheck = capturedButton(capturePresentation(), "Recheck linked gist");
    act(() => {
      const event = buttonEvent(recheck.element);
      recheck.onClick(event);
      recheck.onClick(event);
    });
    await settle();
    expect(api.documents.gistAutoUpdatePreview).toHaveBeenCalledTimes(recheckCalls + 1);
    expect(screen.getByRole("checkbox")).not.toBeChecked();

    const acknowledgement = capturePresentation().checkbox;
    if (!acknowledgement) throw new Error("Rechecked destination did not render acknowledgement");
    act(() => {
      acknowledgement.element.checked = true;
      const event = checkboxEvent(acknowledgement.element);
      acknowledgement.onChange(event);
      acknowledgement.onChange(event);
    });

    const updateCalls = vi.mocked(api.documents.setGistAutoUpdate).mock.calls.length;
    const enable = capturedButton(capturePresentation(), "Enable auto-update");
    act(() => {
      const event = buttonEvent(enable.element);
      enable.onClick(event);
      enable.onClick(event);
    });
    await settle();
    expect(api.documents.setGistAutoUpdate).toHaveBeenCalledTimes(updateCalls + 1);

    const disable = capturedButton(capturePresentation(), "Disable auto-update");
    act(() => {
      const event = buttonEvent(disable.element);
      disable.onClick(event);
      disable.onClick(event);
    });
    await settle();
    expect(api.documents.setGistAutoUpdate).toHaveBeenCalledTimes(updateCalls + 2);
  });

  it.each(["exact", "non-exact"] as const)(
    "does not launder a hostile %s checkbox attribute sequence through a parent commit",
    async (sequence) => {
      const view = renderDirect(<StrictMode><GistParentCommit visit={0} /></StrictMode>);
      await settle();
      await consent();
      const acknowledgement = capturePresentation().checkbox;
      if (!acknowledgement) throw new Error("Checked destination did not render acknowledgement");

      act(() => {
        acknowledgement.element.setAttribute("name", "");
        if (sequence === "non-exact") {
          acknowledgement.element.setAttribute("type", "radio");
        }
        acknowledgement.element.setAttribute("type", "checkbox");
        acknowledgement.element.removeAttribute("name");
        view.root.render(<StrictMode><GistParentCommit visit={1} /></StrictMode>);
      });
      await settle();

      const operations = externalOperations();
      act(() => invokeButton(capturedButton(capturePresentation(), "Recheck linked gist")));
      expect(externalOperations()).toBe(operations);
    },
  );

  it.each(["name", "type", "React-like sequence"] as const)(
    "does not mistake restored checkbox %s mutation for React reconciliation",
    async (attribute) => {
      renderDirect(<StrictMode><GistAutoUpdateControl doc={DOC} isOwner /></StrictMode>);
      await settle();
      await consent();
      const presentation = capturePresentation();
      const recheck = capturedButton(presentation, "Recheck linked gist");
      const acknowledgement = presentation.checkbox;
      if (!acknowledgement) throw new Error("Checked destination did not render acknowledgement");

      if (attribute === "name") {
        acknowledgement.element.setAttribute("name", "changed");
        acknowledgement.element.removeAttribute("name");
      } else if (attribute === "type") {
        acknowledgement.element.setAttribute("type", "text");
        acknowledgement.element.setAttribute("type", "checkbox");
      } else {
        acknowledgement.element.setAttribute("name", "");
        acknowledgement.element.setAttribute("type", "checkbox");
        acknowledgement.element.removeAttribute("name");
      }
      const operations = externalOperations();

      act(() => invokeButton(recheck));
      expect(externalOperations()).toBe(operations);
    },
  );

  it("rejects a partial ref replay after a newly introduced checkbox has settled", async () => {
    renderDirect(<StrictMode><GistAutoUpdateControl doc={DOC} isOwner /></StrictMode>);
    await settle();
    await consent();
    const presentation = capturePresentation();
    const acknowledgement = presentation.checkbox;
    if (!acknowledgement) throw new Error("Checked destination did not render acknowledgement");
    const operations = externalOperations();

    act(() => {
      acknowledgement.ref(null);
      acknowledgement.ref(acknowledgement.element);
      invokeButton(capturedButton(presentation, "Recheck linked gist"));
    });
    expect(externalOperations()).toBe(operations);
  });

  it("rejects fabricated native events without consuming the exact current action", async () => {
    renderDirect(<StrictMode><GistAutoUpdateControl doc={DOC} isOwner /></StrictMode>);
    await settle();
    const check = capturedButton(capturePresentation(), "Check linked gist");
    const exact = buttonEvent(check.element);
    const fabricated = {
      ...exact,
      nativeEvent: {
        type: "click",
        target: check.element,
        button: 0,
      },
    } as unknown as ReactMouseEvent<HTMLButtonElement>;
    const operations = externalOperations();

    act(() => {
      check.onClick(fabricated);
      check.onClick(exact);
      check.onClick(exact);
    });
    await settle();
    expect(externalOperations()).toBe(operations + 1);
  });

  it("rejects a reentrant callback after synchronously claiming its presentation and event", async () => {
    renderDirect(<StrictMode><GistAutoUpdateControl doc={DOC} isOwner /></StrictMode>);
    await settle();
    const check = capturedButton(capturePresentation(), "Check linked gist");
    vi.mocked(api.documents.gistAutoUpdatePreview).mockImplementationOnce(async () => {
      check.onClick(buttonEvent(check.element));
      return { destination: DESTINATION };
    });
    const operations = externalOperations();

    act(() => invokeButton(check));
    await settle();
    expect(externalOperations()).toBe(operations + 1);
  });

  it.each([
    ["status", "Refresh status"],
    ["preview", "Check linked gist"],
    ["enable", "Enable auto-update"],
    ["retry", "Retry latest saved version"],
    ["disable", "Disable auto-update"],
  ] as const)("accepts %s only from its exact current button and synchronously rejects every competitor", async (kind, label) => {
    if (kind === "status") {
      vi.mocked(api.documents.gistAutoUpdate).mockRejectedValueOnce(new ApiError(503, "Status unavailable."));
    } else if (kind === "retry") {
      serverStatus = { ...PENDING, status: "failed", message: "Retry this version." };
    } else if (kind === "disable") {
      serverStatus = { ...PENDING };
    }

    renderDirect(<GistAutoUpdateControl doc={DOC} isOwner />);
    await settle();
    if (kind === "enable") await consent();

    const presentation = capturePresentation();
    const selected = capturedButton(presentation, label);
    const competitors = presentation.buttons.filter((button) => button !== selected);
    const foreign = document.createElement("button");
    const detached = document.createElement("button");
    document.body.append(foreign);

    const operationsBeforeWrongSources = externalOperations();
    const timersBeforeWrongSources = vi.getTimerCount();
    const observer = observeMutations(presentation.root);
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const markup = presentation.root.innerHTML;

    act(() => {
      for (const competitor of competitors) invokeButton(selected, competitor.element);
      if (presentation.checkbox) {
        invokeButton(selected, presentation.checkbox.element);
      }
      invokeButton(selected, foreign);
      invokeButton(selected, detached);
      invokeButton(selected, presentation.root);
    });

    expect(externalOperations()).toBe(operationsBeforeWrongSources);
    expect(vi.getTimerCount()).toBe(timersBeforeWrongSources);
    expect(presentation.root.innerHTML).toBe(markup);
    expect(observer.takeRecords()).toHaveLength(0);
    expect(focus).not.toHaveBeenCalled();

    await act(async () => {
      invokeButton(selected);
      invokeButton(selected);
      for (const competitor of competitors) invokeButton(competitor);
    });
    expect(externalOperations()).toBe(operationsBeforeWrongSources + 1);
    foreign.remove();
  });

  it.each([
    ["document", { ...DOC, id: "publication-document" }, "initial"],
    ["gist", { ...DOC, gistId: "publication-gist" }, "initial"],
    ["file", { ...DOC, gistFile: "publication.md" }, "initial"],
    ["url", { ...DOC, githubUrl: "https://gist.github.com/publication-url" }, "initial"],
    ["identity", { ...DOC, ownerId: "publication-owner" }, "initial"],
    ["equal-looking remount", DOC, "replacement"],
  ] as const)(
    "retires callbacks before the parent layout boundary for a %s replacement and keeps B usable",
    async (_change, nextDoc, nextMount) => {
      let replacing = false;
      let passiveCleanups = 0;
      const onPassiveCleanup = () => { passiveCleanups++; };
      let stale: CapturedPresentation | null = null;
      const observer = observeMutations();
      const focus = vi.spyOn(HTMLElement.prototype, "focus");
      const foreignCheckbox = document.createElement("input");
      foreignCheckbox.type = "checkbox";
      document.body.append(foreignCheckbox);
      const onLayout = () => {
        if (!replacing) return;
        expect(passiveCleanups).toBe(0);
        const current = capturePresentation();
        const currentPreview = capturedButton(current, "Check linked gist");
        observer.takeRecords();
        focus.mockClear();
        const operations = externalOperations();
        const timers = vi.getTimerCount();
        for (const button of stale!.buttons) {
          invokeButton(button);
          invokeButton(button, currentPreview.element);
          button.ref(currentPreview.element);
          button.ref(null);
        }
        if (stale!.checkbox) {
          invokeCheckbox(stale!.checkbox, true, foreignCheckbox);
          stale!.checkbox.ref(foreignCheckbox);
          stale!.checkbox.ref(null);
        }
        stale!.rootRef(current.root);
        stale!.rootRef(null);
        expect(externalOperations()).toBe(operations);
        expect(vi.getTimerCount()).toBe(timers);
        expect(observer.takeRecords()).toHaveLength(0);
        expect(focus).not.toHaveBeenCalled();
      };
      const view = renderDirect(
        <GistBoundary doc={DOC} onLayout={onLayout} onPassiveCleanup={onPassiveCleanup} />,
      );
      await settle();
      await consent();
      stale = capturePresentation();
      const operationsBeforeReplacement = externalOperations();

      replacing = true;
      act(() => {
        view.root.render(
          <GistBoundary
            doc={nextDoc}
            mount={nextMount}
            passiveVisit={1}
            onLayout={onLayout}
            onPassiveCleanup={onPassiveCleanup}
          />,
        );
      });
      await settle();

      expect(passiveCleanups).toBe(1);
      expect(externalOperations()).toBe(operationsBeforeReplacement + 1);
      const current = capturePresentation();
      const currentPreview = capturedButton(current, "Check linked gist");
      const operationsBeforeCurrent = externalOperations();
      await act(async () => {
        invokeButton(currentPreview);
        invokeButton(currentPreview);
        for (const button of stale!.buttons) invokeButton(button, currentPreview.element);
      });
      expect(externalOperations()).toBe(operationsBeforeCurrent + 1);
      foreignCheckbox.remove();
    },
  );

  it("retires removed controls before the parent layout boundary without timer, state, event, focus, or DOM work", async () => {
    let passiveCleanups = 0;
    let removing = false;
    const onPassiveCleanup = () => { passiveCleanups++; };
    let stale: CapturedPresentation | null = null;
    const observer = observeMutations();
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const onLayout = (_doc: DocumentDto, show: boolean) => {
      if (!removing || show) return;
      expect(passiveCleanups).toBe(0);
      expect(screen.queryByTestId("gist-auto-update")).toBeNull();
      observer.takeRecords();
      focus.mockClear();
      const operations = externalOperations();
      for (const button of stale!.buttons) {
        invokeButton(button);
        button.ref(null);
      }
      if (stale!.checkbox) {
        invokeCheckbox(stale!.checkbox, false);
        stale!.checkbox.ref(null);
      }
      stale!.rootRef(null);
      expect(externalOperations()).toBe(operations);
      expect(vi.getTimerCount()).toBe(0);
      expect(observer.takeRecords()).toHaveLength(0);
      expect(focus).not.toHaveBeenCalled();
    };
    const view = renderDirect(
      <GistBoundary doc={DOC} onLayout={onLayout} onPassiveCleanup={onPassiveCleanup} />,
    );
    await settle();
    await consent();
    stale = capturePresentation();
    const operations = externalOperations();

    removing = true;
    act(() => {
      view.root.render(
        <GistBoundary
          doc={DOC}
          show={false}
          passiveVisit={1}
          onLayout={onLayout}
          onPassiveCleanup={onPassiveCleanup}
        />,
      );
    });
    await settle();
    expect(passiveCleanups).toBe(1);
    expect(externalOperations()).toBe(operations);

    act(() => {
      for (const button of stale!.buttons) invokeButton(button);
      if (stale!.checkbox) invokeCheckbox(stale!.checkbox, false);
    });
    expect(externalOperations()).toBe(operations);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("accepts current acknowledgement true and false once and rejects wrong or retired checkbox sources", async () => {
    renderDirect(<GistAutoUpdateControl doc={DOC} isOwner />);
    await settle();
    await click("Check linked gist");
    const unchecked = capturePresentation();
    const staleCheckbox = unchecked.checkbox!;
    const enable = capturedButton(unchecked, "Enable auto-update");
    const foreign = document.createElement("input");
    const detached = document.createElement("input");
    foreign.type = "checkbox";
    detached.type = "checkbox";
    document.body.append(foreign);
    const operations = externalOperations();

    act(() => {
      invokeCheckbox(staleCheckbox, true, foreign);
      invokeCheckbox(staleCheckbox, true, detached);
      invokeCheckbox(staleCheckbox, true, enable.element as unknown as HTMLInputElement);
    });
    expect(staleCheckbox.element).not.toBeChecked();
    expect(enable.element).toBeDisabled();
    expect(externalOperations()).toBe(operations);
    foreign.remove();

    act(() => {
      invokeCheckbox(staleCheckbox, true);
      invokeCheckbox(staleCheckbox, true);
    });
    expect(screen.getByRole("checkbox")).toBeChecked();
    expect(screen.getByRole("button", { name: "Enable auto-update" })).toBeEnabled();

    const checked = capturePresentation();
    const currentCheckbox = checked.checkbox!;
    act(() => {
      invokeCheckbox(staleCheckbox, false, currentCheckbox.element);
      currentCheckbox.element.checked = true;
    });
    expect(screen.getByRole("button", { name: "Enable auto-update" })).toBeEnabled();

    act(() => {
      invokeCheckbox(currentCheckbox, false);
      invokeCheckbox(currentCheckbox, false);
    });
    expect(screen.getByRole("checkbox")).not.toBeChecked();
    expect(screen.getByRole("button", { name: "Enable auto-update" })).toBeDisabled();
  });

  it("does not let stale acknowledgement or Enable callbacks cross a preview destination replacement", async () => {
    renderDirect(<GistAutoUpdateControl doc={DOC} isOwner />);
    await settle();
    await consent();
    const stale = capturePresentation();
    const staleCheckbox = stale.checkbox!;
    const staleEnable = capturedButton(stale, "Enable auto-update");
    const recheck = capturedButton(stale, "Recheck linked gist");
    const replacementDestination = {
      ...DESTINATION,
      url: "https://gist.github.com/gist-auto-test?revision=2",
      visibility: "public" as const,
      owner: "replacement-owner",
    };
    vi.mocked(api.documents.gistAutoUpdatePreview).mockResolvedValueOnce({ destination: replacementDestination });

    await act(async () => invokeButton(recheck));
    const replacement = capturePresentation();
    const replacementCheckbox = replacement.checkbox!;
    const replacementEnable = capturedButton(replacement, "Enable auto-update");
    const mutationsBeforeStale = externalOperations();
    act(() => {
      invokeCheckbox(staleCheckbox, true, replacementCheckbox.element);
      replacementCheckbox.element.checked = false;
      invokeButton(staleEnable, replacementEnable.element);
    });
    expect(replacementEnable.element).toBeDisabled();
    expect(externalOperations()).toBe(mutationsBeforeStale);

    act(() => invokeCheckbox(replacementCheckbox, true));
    const currentEnable = capturedButton(capturePresentation(), "Enable auto-update");
    const request = deferred<GistAutoUpdateStatus>();
    vi.mocked(api.documents.setGistAutoUpdate).mockReturnValueOnce(request.promise);
    act(() => {
      invokeButton(staleEnable, currentEnable.element);
      invokeButton(currentEnable);
      invokeButton(currentEnable);
    });
    expect(api.documents.setGistAutoUpdate).toHaveBeenCalledExactlyOnceWith(DOC.id, {
      enabled: true,
      acknowledgeRisk: true,
      destination: replacementDestination,
    });
    await act(async () => request.resolve({ ...PENDING, destination: replacementDestination }));
  });

  it.each(["stale-before-current", "current-before-stale"] as const)(
    "keeps a reused Check/Recheck button bound only to B in %s order",
    async (order) => {
      const firstRequest = deferred<{ destination: GistAutoUpdateDestination }>();
      vi.mocked(api.documents.gistAutoUpdatePreview).mockReturnValueOnce(firstRequest.promise);
      renderDirect(<GistAutoUpdateControl doc={DOC} isOwner />);
      await settle();
      const stale = capturePresentation();
      const staleCheck = capturedButton(stale, "Check linked gist");

      act(() => invokeButton(staleCheck));
      await act(async () => firstRequest.resolve({ destination: DESTINATION }));
      const current = capturePresentation();
      const currentRecheck = capturedButton(current, "Recheck linked gist");
      expect(current.root).toBe(stale.root);
      expect(currentRecheck.element).toBe(staleCheck.element);

      const secondRequest = deferred<{ destination: GistAutoUpdateDestination }>();
      vi.mocked(api.documents.gistAutoUpdatePreview).mockReturnValueOnce(secondRequest.promise);
      const calls = vi.mocked(api.documents.gistAutoUpdatePreview).mock.calls.length;
      act(() => {
        const invokeStale = () => {
          invokeButton(staleCheck, currentRecheck.element);
          staleCheck.ref(currentRecheck.element);
          staleCheck.ref(null);
          stale.rootRef(current.root);
          stale.rootRef(null);
        };
        if (order === "stale-before-current") {
          invokeStale();
          invokeButton(currentRecheck);
        } else {
          invokeButton(currentRecheck);
          invokeStale();
        }
        invokeButton(currentRecheck);
      });
      expect(api.documents.gistAutoUpdatePreview).toHaveBeenCalledTimes(calls + 1);
      await act(async () => secondRequest.resolve({ destination: DESTINATION }));
      expect(screen.getByRole("button", { name: "Recheck linked gist" })).toBeEnabled();
    },
  );

  it.each(["root", "control"] as const)(
    "retires a publication when its exact %s DOM ref is replaced and stale detach cannot clear B",
    async (replacement) => {
      const view = renderDirect(<InitialGistControl doc={DOC} />);
      await settle();
      const stale = capturePresentation();
      const staleCheck = capturedButton(stale, "Check linked gist");
      const replacementRoot = document.createElement("section");
      const replacementButton = document.createElement("button");
      replacementRoot.append(replacementButton);
      document.body.append(replacementRoot);
      const operations = externalOperations();

      act(() => {
        if (replacement === "root") stale.rootRef(replacementRoot);
        else staleCheck.ref(replacementButton);
        invokeButton(staleCheck, replacement === "root" ? staleCheck.element : replacementButton);
      });
      expect(externalOperations()).toBe(operations);

      act(() => view.root.render(<ReplacementGistControl doc={DOC} />));
      await settle();
      const current = capturePresentation();
      const currentCheck = capturedButton(current, "Check linked gist");
      act(() => {
        stale.rootRef(null);
        staleCheck.ref(null);
        invokeButton(staleCheck, currentCheck.element);
      });
      expect(externalOperations()).toBe(operations + 1);

      await act(async () => {
        invokeButton(currentCheck);
        invokeButton(currentCheck);
      });
      expect(externalOperations()).toBe(operations + 2);
      replacementRoot.remove();
    },
  );

  it.each(["status", "status destination", "preview destination"] as const)(
    "rejects exact current controls after an API-owned %s mutates in place",
    async (mutation) => {
      const mutableStatus: GistAutoUpdateStatus = mutation === "status destination"
        ? { ...PENDING, destination: { ...DESTINATION } }
        : { ...OFF };
      const mutablePreview = { ...DESTINATION };
      serverStatus = mutableStatus;
      vi.mocked(api.documents.gistAutoUpdatePreview).mockResolvedValueOnce({ destination: mutablePreview });
      renderDirect(<GistAutoUpdateControl doc={DOC} isOwner />);
      await settle();

      if (mutation === "status destination") {
        const presentation = capturePresentation();
        const disable = capturedButton(presentation, "Disable auto-update");
        const operations = externalOperations();
        mutableStatus.destination!.owner = "mutated-status-owner";

        act(() => invokeButton(disable));
        expect(externalOperations()).toBe(operations);
        expect(disable.element).toBeEnabled();
        return;
      }

      if (mutation === "status") {
        const presentation = capturePresentation();
        const check = capturedButton(presentation, "Check linked gist");
        const operations = externalOperations();
        mutableStatus.status = "failed";

        act(() => invokeButton(check));
        expect(externalOperations()).toBe(operations);
        expect(check.element).toBeEnabled();
        return;
      }

      await click("Check linked gist");
      const presentation = capturePresentation();
      const acknowledgement = presentation.checkbox!;
      const operations = externalOperations();
      mutablePreview.owner = "mutated-preview-owner";

      act(() => invokeCheckbox(acknowledgement, true));
      expect(externalOperations()).toBe(operations);
      expect(screen.getByRole("button", { name: "Enable auto-update" })).toBeDisabled();
    },
  );

  it("freezes the accepted Enable destination before its API-owned preview mutates", async () => {
    const mutablePreview = { ...DESTINATION };
    vi.mocked(api.documents.gistAutoUpdatePreview).mockResolvedValueOnce({ destination: mutablePreview });
    renderDirect(<GistAutoUpdateControl doc={DOC} isOwner />);
    await settle();
    await consent();
    const enable = capturedButton(capturePresentation(), "Enable auto-update");

    act(() => {
      invokeButton(enable);
      mutablePreview.owner = "mutated-after-enable";
      mutablePreview.url = "https://gist.github.com/mutated-after-enable";
    });
    await settle();

    expect(api.documents.setGistAutoUpdate).toHaveBeenCalledExactlyOnceWith(DOC.id, {
      enabled: true,
      acknowledgeRisk: true,
      destination: DESTINATION,
    });
  });
});
