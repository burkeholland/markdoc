// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { startTransition, useEffect, useLayoutEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DocumentSummaryDto, SearchResultDto } from "@/lib/api";
import type { PendingNotice } from "@/lib/notice";

type SearchResponse = { query: string; documents: SearchResultDto[] };
type ListOptions = { starred?: boolean; trash?: boolean };
type ListResponse = { documents: DocumentSummaryDto[] };
type CreateResponse = { document: { id: string; title: string } };
const searchDocuments = vi.fn<(query: string, init?: RequestInit) => Promise<SearchResponse>>();
const listDocuments = vi.fn<(options?: ListOptions) => Promise<ListResponse>>();
const createDocument = vi.fn<(body?: { template?: string }) => Promise<CreateResponse>>();
const restoreDocument = vi.fn<(id: string) => Promise<{ ok: true }>>();
const purgeDocument = vi.fn<(id: string, options?: { permanent?: boolean }) => Promise<{ ok: true; permanent: boolean }>>();
const starDocument = vi.fn<(id: string) => Promise<{ starred: true }>>();
const unstarDocument = vi.fn<(id: string) => Promise<{ starred: false }>>();
const takePendingNotice = vi.fn<() => PendingNotice | null>();
const router = { push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn(), back: vi.fn(), forward: vi.fn() };

vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("@/components/dashboard/notifications-strip", () => ({ NotificationsStrip: () => null }));
vi.mock("@/components/ui/theme-toggle", () => ({ ThemeToggle: () => null }));
vi.mock("@/lib/notice", () => ({ takePendingNotice: () => takePendingNotice() }));
vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      documents: {
        ...actual.api.documents,
        search: (query: string, init?: RequestInit) => searchDocuments(query, init),
        list: (options?: ListOptions) => listDocuments(options),
        create: (body?: { template?: string }) => createDocument(body),
        restore: (id: string) => restoreDocument(id),
        delete: (id: string, options?: { permanent?: boolean }) => purgeDocument(id, options),
        star: (id: string) => starDocument(id),
        unstar: (id: string) => unstarDocument(id),
      },
    },
  };
});

import { ApiError } from "@/lib/api";
import { PICKER_TEMPLATES, type Template } from "@/lib/templates";
import { Dashboard, TemplateGrid } from "./dashboard";

const SEARCH_DEBOUNCE_MS = 250;
const USER = { id: "owner", name: "Owner", login: "owner", image: null };

function doc(id: string, title: string, excerpt = ""): DocumentSummaryDto {
  return {
    id,
    title,
    excerpt,
    storage: "local",
    updatedAt: "2026-09-07T12:00:00.000Z",
    createdAt: "2026-09-01T12:00:00.000Z",
    lastOpenedAt: null,
    deletedAt: null,
    ownerId: USER.id,
    ownerName: USER.name,
    ownerLogin: USER.login,
    role: "owner",
    repoOwner: null,
    repoName: null,
    repoPath: null,
    gistId: null,
    starred: false,
  };
}

function result(id: string, title: string, snippet: string | null): SearchResultDto {
  return { ...doc(id, title), snippet };
}

function trashedDoc(id: string, title: string): DocumentSummaryDto {
  return { ...doc(id, title), deletedAt: "2026-09-07T13:00:00.000Z" };
}

const DOCUMENTS = [
  doc("alpha-title", "Alpha planning", "Safe title match"),
  doc("notes", "Meeting notes", "An ordinary excerpt"),
];

function renderDashboard(children?: React.ReactNode, documents = DOCUMENTS) {
  return render(
    <>
      <Dashboard user={USER} documents={documents} githubAvailable githubConfigured />
      {children}
    </>,
  );
}

function TransitionUnmount({ children }: { children: React.ReactNode }) {
  const [mounted, setMounted] = useState(true);
  return (
    <>
      <button type="button" data-testid="unmount-dashboard" onClick={() => startTransition(() => setMounted(false))}>
        Unmount dashboard
      </button>
      {mounted ? children : null}
    </>
  );
}

function PassiveCleanupProbe({ onCleanup }: { onCleanup: () => void }) {
  useEffect(() => onCleanup, [onCleanup]);
  return null;
}

function TemplateGridBoundary({
  onPick,
  busy,
  compact,
  present = true,
  mountKey = "grid",
  boundary = 0,
  onBoundary,
  onPassiveCleanup,
}: {
  onPick: (template: Template) => void;
  busy: string | null;
  compact?: boolean;
  present?: boolean;
  mountKey?: string;
  boundary?: number;
  onBoundary?: () => void;
  onPassiveCleanup: () => void;
}) {
  useLayoutEffect(() => {
    if (boundary > 0) onBoundary?.();
  }, [boundary, onBoundary]);
  return present ? (
    <>
      <TemplateGrid key={mountKey} onPick={onPick} busy={busy} compact={compact} />
      <PassiveCleanupProbe key={`${mountKey}:${boundary}`} onCleanup={onPassiveCleanup} />
    </>
  ) : (
    <button type="button" data-testid="grid-replacement">Replacement control</button>
  );
}

function DashboardBoundary({
  user = USER,
  documents = DOCUMENTS,
  present = true,
  boundary = 0,
  onBoundary,
  onPassiveCleanup = () => {},
}: {
  user?: typeof USER;
  documents?: DocumentSummaryDto[];
  present?: boolean;
  boundary?: number;
  onBoundary?: () => void;
  onPassiveCleanup?: () => void;
}) {
  useLayoutEffect(() => {
    if (boundary > 0) onBoundary?.();
  }, [boundary, onBoundary]);
  return present ? (
    <>
      <Dashboard user={user} documents={documents} githubAvailable githubConfigured />
      <PassiveCleanupProbe key={user.id} onCleanup={onPassiveCleanup} />
    </>
  ) : null;
}

function openTrash() {
  fireEvent.click(screen.getByTestId("filter-trash"));
}

function leaveTrash() {
  fireEvent.click(screen.getByTestId("filter-all"));
}

function trashButton(title: string, action: "restore-button" | "purge-button") {
  return within(screen.getByText(title).closest('[data-testid="trash-card"]')!).getByTestId(action);
}

async function settleSearch() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
  });
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

function controlledSearch<T>() {
  type Chain = {
    then: (handler: (value: T) => unknown) => Chain;
    catch: (handler: (reason: unknown) => unknown) => Chain;
    finally: (handler: () => unknown) => Chain;
  };
  let success: ((value: T) => unknown) | undefined;
  let failure: ((reason: unknown) => unknown) | undefined;
  let finalizer: (() => unknown) | undefined;
  const chain: Chain = {
    then(handler) {
      success = handler;
      return chain;
    },
    catch(handler) {
      failure = handler;
      return chain;
    },
    finally(handler) {
      finalizer = handler;
      return chain;
    },
  };
  return {
    promise: chain as unknown as Promise<T>,
    resolve: (value: T) => success?.(value),
    reject: (reason: unknown) => failure?.(reason),
    finalize: () => finalizer?.(),
  };
}

function documentStar(title: string) {
  const list = screen.getByTestId("document-list");
  const link = within(list).getByRole("link", { name: new RegExp(title) });
  return within(link.closest("li")!).getByTestId("star-toggle");
}

type CapturedClickEvent = {
  readonly currentTarget: HTMLButtonElement;
  preventDefault: ReturnType<typeof vi.fn>;
  stopPropagation: ReturnType<typeof vi.fn>;
};

type CapturedClick = (event?: unknown) => void;
type CapturedTemplateClick = (event: CapturedClickEvent) => void;

function captureClick(element: HTMLElement): CapturedClick {
  const propsKey = Object.keys(element).find((key) => key.startsWith("__reactProps$"));
  if (!propsKey) throw new Error("React props were not attached to the button");
  const props = (element as unknown as Record<string, { onClick?: CapturedClick } | undefined>)[propsKey];
  if (!props?.onClick) throw new Error("The button did not have an onClick handler");
  return props.onClick;
}

function captureTemplateClick(element: HTMLButtonElement): CapturedTemplateClick {
  const propsKey = Object.keys(element).find((key) => key.startsWith("__reactProps$"));
  if (!propsKey) throw new Error("React props were not attached to the template button");
  const props = (element as unknown as Record<string, { onClick?: CapturedTemplateClick } | undefined>)[propsKey];
  if (!props?.onClick) throw new Error("The template button did not have an onClick handler");
  return props.onClick;
}

function templateButton(host: HTMLElement, id: string): HTMLButtonElement {
  const button = host.querySelector<HTMLButtonElement>(`[data-testid="template-${id}"]`);
  if (!button) throw new Error(`Template button ${id} was not rendered`);
  return button;
}

function templateGrid(host: HTMLElement): HTMLUListElement {
  const grid = host.querySelector<HTMLUListElement>('[data-testid="template-grid"]');
  if (!grid) throw new Error("Template grid was not rendered");
  return grid;
}

function capturedActivationEvent(button: HTMLButtonElement) {
  return {
    currentTarget: button,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
  };
}

function invokeCapturedClick(callback: CapturedTemplateClick, source: HTMLButtonElement) {
  const event = capturedActivationEvent(source);
  callback(event);
  return event;
}

function expectInertCapturedClick(callback: CapturedTemplateClick, source: HTMLButtonElement, host: HTMLElement) {
  const event = capturedActivationEvent(source);
  const activeElement = document.activeElement;
  const markup = host.innerHTML;
  callback(event);
  expect(event.preventDefault).not.toHaveBeenCalled();
  expect(event.stopPropagation).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(activeElement);
  expect(host.innerHTML).toBe(markup);
}

type KeydownCallback = (event: KeyboardEvent) => void;

function eventCapture(options?: boolean | AddEventListenerOptions | EventListenerOptions): boolean {
  return typeof options === "boolean" ? options : options?.capture === true;
}

function trackWindowKeydownListeners() {
  const add = vi.spyOn(window, "addEventListener");
  const remove = vi.spyOn(window, "removeEventListener");
  const added = (capture: boolean) =>
    add.mock.calls
      .filter(([type, listener, options]) => type === "keydown" && typeof listener === "function" && eventCapture(options) === capture)
      .map(([, listener]) => listener as KeydownCallback);
  const removalCount = (callback: KeydownCallback, capture: boolean) =>
    remove.mock.calls.filter(
      ([type, listener, options]) => type === "keydown" && listener === callback && eventCapture(options) === capture,
    ).length;
  const active = (capture: boolean) => added(capture).filter((callback) => removalCount(callback, capture) === 0);
  return { active, added, removalCount };
}

function shortcutEvent(init: KeyboardEventInit) {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  const preventDefault = vi.spyOn(event, "preventDefault");
  const stopPropagation = vi.spyOn(event, "stopPropagation");
  return { event, preventDefault, stopPropagation };
}

beforeEach(() => {
  vi.useFakeTimers();
  Object.defineProperty(Element.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
  searchDocuments.mockReset();
  searchDocuments.mockImplementation(async (query) => ({ query, documents: [] }));
  listDocuments.mockReset();
  listDocuments.mockResolvedValue({ documents: [] });
  createDocument.mockReset();
  createDocument.mockResolvedValue({ document: { id: "created", title: "Untitled" } });
  restoreDocument.mockReset();
  restoreDocument.mockResolvedValue({ ok: true });
  purgeDocument.mockReset();
  purgeDocument.mockResolvedValue({ ok: true, permanent: true });
  starDocument.mockReset();
  starDocument.mockResolvedValue({ starred: true });
  unstarDocument.mockReset();
  unstarDocument.mockResolvedValue({ starred: false });
  takePendingNotice.mockReset();
  takePendingNotice.mockReturnValue(null);
  router.push.mockReset();
  router.replace.mockReset();
  router.refresh.mockReset();
  router.prefetch.mockReset();
  router.back.mockReset();
  router.forward.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("TemplateGrid publication ownership", () => {
  it("preserves presentation and gives each committed idle publication one exact template activation", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const onPick = vi.fn<(template: Template) => void>();
    const first = PICKER_TEMPLATES[0];
    const second = PICKER_TEMPLATES[1];

    try {
      await act(async () => {
        root.render(<TemplateGrid onPick={onPick} busy={null} />);
      });

      const grid = templateGrid(host);
      expect(grid).toHaveClass("grid", "gap-3", "sm:grid-cols-2", "lg:grid-cols-3");
      expect(grid).not.toHaveClass("grid-cols-2", "sm:grid-cols-3", "lg:grid-cols-4");
      expect(Array.from(grid.children, (card) => card.firstElementChild?.getAttribute("data-testid"))).toEqual(
        PICKER_TEMPLATES.map((template) => `template-${template.id}`),
      );
      for (const template of PICKER_TEMPLATES) {
        const button = templateButton(host, template.id);
        const iconClass = `lucide-${template.icon.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase()}`;
        expect(button).toHaveTextContent(template.name);
        expect(button).toHaveTextContent(template.description);
        expect(button.querySelector("svg")).toHaveClass(iconClass);
        expect(button).toBeEnabled();
        expect(button).not.toHaveAttribute("aria-busy");
      }

      const firstButton = templateButton(host, first.id);
      const secondButton = templateButton(host, second.id);
      const staleFirstActivation = captureTemplateClick(firstButton);
      const competingActivation = captureTemplateClick(secondButton);
      invokeCapturedClick(staleFirstActivation, firstButton);
      invokeCapturedClick(staleFirstActivation, firstButton);
      invokeCapturedClick(competingActivation, secondButton);
      expect(onPick).toHaveBeenCalledTimes(1);
      expect(onPick).toHaveBeenLastCalledWith(first);

      await act(async () => {
        root.render(<TemplateGrid compact onPick={onPick} busy={second.id} />);
      });
      expect(templateGrid(host)).toHaveClass("grid-cols-2", "sm:grid-cols-3", "lg:grid-cols-4");
      for (const template of PICKER_TEMPLATES) expect(templateButton(host, template.id)).toBeDisabled();
      const busyButton = templateButton(host, second.id);
      expect(busyButton).toHaveAttribute("aria-busy", "true");
      expect(busyButton.querySelector("svg")).toHaveClass("animate-spin");
      const busyActivation = captureTemplateClick(busyButton);
      invokeCapturedClick(staleFirstActivation, firstButton);
      invokeCapturedClick(busyActivation, busyButton);
      expect(onPick).toHaveBeenCalledTimes(1);

      await act(async () => {
        root.render(<TemplateGrid compact onPick={onPick} busy={null} />);
      });
      const idleAgainButton = templateButton(host, second.id);
      const idleAgainActivation = captureTemplateClick(idleAgainButton);
      invokeCapturedClick(busyActivation, busyButton);
      invokeCapturedClick(idleAgainActivation, idleAgainButton);
      invokeCapturedClick(idleAgainActivation, idleAgainButton);
      expect(onPick).toHaveBeenCalledTimes(2);
      expect(onPick).toHaveBeenLastCalledWith(second);
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it.each(
    (["sibling card", "foreign connected button", "detached published button", "replacement button"] as const).flatMap((source) =>
      (["wrong-before-current", "current-before-wrong"] as const).map((order) => ({ source, order })),
    ),
  )("rejects a $source without claiming the current publication in $order order", async ({ source, order }) => {
    const host = document.createElement("div");
    const focusOwner = document.createElement("button");
    document.body.append(focusOwner, host);
    const root = createRoot(host);
    const onPick = vi.fn<(template: Template) => void>();
    const template = PICKER_TEMPLATES[0];
    let cleanupWrongSource = () => {};

    try {
      await act(async () => {
        root.render(<TemplateGrid onPick={onPick} busy={null} />);
      });
      const exactButton = templateButton(host, template.id);
      const exactActivation = captureTemplateClick(exactButton);
      const card = exactButton.parentElement;
      if (!(card instanceof HTMLLIElement)) throw new Error("Template button was not rendered in a card");
      focusOwner.focus();

      const prepareWrongSource = () => {
        if (source === "sibling card") return templateButton(host, PICKER_TEMPLATES[1].id);
        if (source === "foreign connected button") {
          const foreign = document.createElement("button");
          document.body.append(foreign);
          cleanupWrongSource = () => foreign.remove();
          return foreign;
        }
        if (source === "detached published button") {
          exactButton.remove();
          cleanupWrongSource = () => card.replaceChildren(exactButton);
          return exactButton;
        }
        const replacement = document.createElement("button");
        card.replaceChildren(replacement);
        cleanupWrongSource = () => card.replaceChildren(exactButton);
        return replacement;
      };
      const invokeWrongSource = (wrongSource: HTMLButtonElement) => {
        expectInertCapturedClick(exactActivation, wrongSource, host);
        if (source === "sibling card") {
          expectInertCapturedClick(captureTemplateClick(wrongSource), exactButton, host);
        }
      };

      if (order === "wrong-before-current") {
        const wrongSource = prepareWrongSource();
        invokeWrongSource(wrongSource);
        expect(onPick).not.toHaveBeenCalled();
        cleanupWrongSource();
        cleanupWrongSource = () => {};
        invokeCapturedClick(exactActivation, exactButton);
      } else {
        invokeCapturedClick(exactActivation, exactButton);
        const wrongSource = prepareWrongSource();
        invokeWrongSource(wrongSource);
      }

      expect(onPick).toHaveBeenCalledTimes(1);
      expect(onPick).toHaveBeenLastCalledWith(template);
    } finally {
      cleanupWrongSource();
      await act(async () => root.unmount());
      focusOwner.remove();
      host.remove();
    }
  });

  it.each(["wrong-before-current", "current-before-wrong"] as const)(
    "binds reused DOM to the new callback before the parent layout boundary in %s order",
    async (order) => {
      const host = document.createElement("div");
      const focusOwner = document.createElement("button");
      document.body.append(focusOwner, host);
      const root = createRoot(host);
      const stalePick = vi.fn<(template: Template) => void>();
      const currentPick = vi.fn<(template: Template) => void>();
      const passiveCleanup = vi.fn();
      const template = PICKER_TEMPLATES[0];

      try {
        await act(async () => {
          root.render(
            <TemplateGridBoundary onPick={stalePick} busy={null} onPassiveCleanup={passiveCleanup} />,
          );
        });
        const button = templateButton(host, template.id);
        const staleActivation = captureTemplateClick(button);
        let currentActivation!: CapturedTemplateClick;
        focusOwner.focus();
        let boundaryReached!: () => void;
        const atBoundary = new Promise<void>((resolve) => {
          boundaryReached = resolve;
        });

        root.render(
          <TemplateGridBoundary
            onPick={currentPick}
            busy={null}
            boundary={1}
            onPassiveCleanup={passiveCleanup}
            onBoundary={() => {
              expect(passiveCleanup).not.toHaveBeenCalled();
              const currentButton = templateButton(host, template.id);
              expect(currentButton).toBe(button);
              currentActivation = captureTemplateClick(currentButton);
              if (order === "wrong-before-current") {
                expectInertCapturedClick(staleActivation, currentButton, host);
                expect(currentPick).not.toHaveBeenCalled();
                invokeCapturedClick(currentActivation, button);
              } else {
                invokeCapturedClick(currentActivation, button);
                expectInertCapturedClick(staleActivation, currentButton, host);
              }
              expect(stalePick).not.toHaveBeenCalled();
              expect(currentPick).toHaveBeenCalledTimes(1);
              expect(currentPick).toHaveBeenLastCalledWith(template);
              expect(document.activeElement).toBe(focusOwner);
              boundaryReached();
            }}
          />,
        );
        await atBoundary;
        await act(async () => {});
        expect(passiveCleanup).toHaveBeenCalledTimes(1);

        const currentButton = templateButton(host, template.id);
        expectInertCapturedClick(staleActivation, currentButton, host);
        expectInertCapturedClick(currentActivation, button, host);
        expect(stalePick).not.toHaveBeenCalled();
        expect(currentPick).toHaveBeenCalledTimes(1);
      } finally {
        await act(async () => root.unmount());
        focusOwner.remove();
        host.remove();
      }
    },
  );

  it("retires idle authority at the busy boundary and makes the next idle publication independently usable", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const onPick = vi.fn<(template: Template) => void>();
    const passiveCleanup = vi.fn();
    const template = PICKER_TEMPLATES[0];

    try {
      await act(async () => {
        root.render(<TemplateGridBoundary onPick={onPick} busy={null} onPassiveCleanup={passiveCleanup} />);
      });
      const button = templateButton(host, template.id);
      const idleActivation = captureTemplateClick(button);
      let busyBoundaryReached!: () => void;
      const atBusyBoundary = new Promise<void>((resolve) => {
        busyBoundaryReached = resolve;
      });

      root.render(
        <TemplateGridBoundary
          onPick={onPick}
          busy={template.id}
          boundary={1}
          onPassiveCleanup={passiveCleanup}
          onBoundary={() => {
            expect(passiveCleanup).not.toHaveBeenCalled();
            const busyButton = templateButton(host, template.id);
            expect(busyButton).toBe(button);
            expect(busyButton).toBeDisabled();
            invokeCapturedClick(idleActivation, button);
            invokeCapturedClick(captureTemplateClick(busyButton), busyButton);
            expect(onPick).not.toHaveBeenCalled();
            busyBoundaryReached();
          }}
        />,
      );
      await atBusyBoundary;
      await act(async () => {});

      let idleBoundaryReached!: () => void;
      const atIdleBoundary = new Promise<void>((resolve) => {
        idleBoundaryReached = resolve;
      });
      root.render(
        <TemplateGridBoundary
          onPick={onPick}
          busy={null}
          boundary={2}
          onPassiveCleanup={passiveCleanup}
          onBoundary={() => {
            expect(passiveCleanup).toHaveBeenCalledTimes(1);
            const currentButton = templateButton(host, template.id);
            const currentActivation = captureTemplateClick(currentButton);
            invokeCapturedClick(idleActivation, button);
            invokeCapturedClick(currentActivation, currentButton);
            expect(onPick).toHaveBeenCalledTimes(1);
            expect(onPick).toHaveBeenLastCalledWith(template);
            idleBoundaryReached();
          }}
        />,
      );
      await atIdleBoundary;
      await act(async () => {});
      expect(passiveCleanup).toHaveBeenCalledTimes(2);
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it("retires noncompact authority before the compact parent layout boundary while reusing callback and DOM identities", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const onPick = vi.fn<(template: Template) => void>();
    const passiveCleanup = vi.fn();
    const template = PICKER_TEMPLATES[0];

    try {
      await act(async () => {
        root.render(<TemplateGridBoundary onPick={onPick} busy={null} compact={false} onPassiveCleanup={passiveCleanup} />);
      });
      const oldGrid = templateGrid(host);
      const oldButton = templateButton(host, template.id);
      const staleActivation = captureTemplateClick(oldButton);
      let boundaryReached!: () => void;
      const atBoundary = new Promise<void>((resolve) => {
        boundaryReached = resolve;
      });

      root.render(
        <TemplateGridBoundary
          onPick={onPick}
          busy={null}
          compact
          boundary={1}
          onPassiveCleanup={passiveCleanup}
          onBoundary={() => {
            expect(passiveCleanup).not.toHaveBeenCalled();
            expect(templateGrid(host)).toBe(oldGrid);
            expect(templateButton(host, template.id)).toBe(oldButton);
            expect(templateGrid(host)).toHaveClass("grid-cols-2", "sm:grid-cols-3", "lg:grid-cols-4");
            invokeCapturedClick(staleActivation, oldButton);
            invokeCapturedClick(captureTemplateClick(oldButton), oldButton);
            expect(onPick).toHaveBeenCalledTimes(1);
            expect(onPick).toHaveBeenLastCalledWith(template);
            boundaryReached();
          }}
        />,
      );
      await atBoundary;
      await act(async () => {});
      invokeCapturedClick(staleActivation, oldButton);
      expect(onPick).toHaveBeenCalledTimes(1);
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it("binds reordered replacement template fields and replacement card DOM to the new publication", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const onPick = vi.fn<(template: Template) => void>();
    const passiveCleanup = vi.fn();
    const originals = [...PICKER_TEMPLATES];
    const original = originals[0];
    const replacement: Template = {
      ...original,
      id: "replacement-template",
      name: "Replacement template",
      description: "Replacement description",
      icon: "Scale",
    };

    try {
      await act(async () => {
        root.render(<TemplateGridBoundary onPick={onPick} busy={null} onPassiveCleanup={passiveCleanup} />);
      });
      const oldCard = templateButton(host, original.id).parentElement;
      const oldButton = templateButton(host, original.id);
      const staleActivation = captureTemplateClick(oldButton);
      PICKER_TEMPLATES.splice(0, PICKER_TEMPLATES.length, originals[1], replacement, ...originals.slice(2));
      let boundaryReached!: () => void;
      const atBoundary = new Promise<void>((resolve) => {
        boundaryReached = resolve;
      });

      root.render(
        <TemplateGridBoundary
          onPick={onPick}
          busy={null}
          boundary={1}
          onPassiveCleanup={passiveCleanup}
          onBoundary={() => {
            expect(passiveCleanup).not.toHaveBeenCalled();
            const grid = templateGrid(host);
            const replacementButton = templateButton(host, replacement.id);
            expect(grid.children.item(0)?.firstElementChild).toBe(templateButton(host, originals[1].id));
            expect(replacementButton.parentElement).not.toBe(oldCard);
            expect(replacementButton).not.toBe(oldButton);
            expect(oldButton.isConnected).toBe(false);
            expect(replacementButton).toHaveTextContent(replacement.name);
            expect(replacementButton).toHaveTextContent(replacement.description);
            expect(replacementButton.querySelector("svg")).toHaveClass("lucide-scale");
            invokeCapturedClick(staleActivation, oldButton);
            invokeCapturedClick(captureTemplateClick(replacementButton), replacementButton);
            expect(onPick).toHaveBeenCalledTimes(1);
            expect(onPick).toHaveBeenLastCalledWith(replacement);
            boundaryReached();
          }}
        />,
      );
      await atBoundary;
      await act(async () => {});
      invokeCapturedClick(staleActivation, oldButton);
      expect(onPick).toHaveBeenCalledTimes(1);
    } finally {
      await act(async () => root.unmount());
      PICKER_TEMPLATES.splice(0, PICKER_TEMPLATES.length, ...originals);
      host.remove();
    }
  });

  it.each(["wrong-before-current", "current-before-wrong"] as const)(
    "binds an equal-looking replacement DOM to only its own callback in %s order",
    async (order) => {
      const host = document.createElement("div");
      const focusOwner = document.createElement("button");
      document.body.append(focusOwner, host);
      const root = createRoot(host);
      const onPick = vi.fn<(template: Template) => void>();
      const passiveCleanup = vi.fn();
      const template = PICKER_TEMPLATES[0];

      try {
        await act(async () => {
          root.render(<TemplateGridBoundary mountKey="a" onPick={onPick} busy={null} onPassiveCleanup={passiveCleanup} />);
        });
        const oldMarkup = host.innerHTML;
        const oldButton = templateButton(host, template.id);
        const staleActivation = captureTemplateClick(oldButton);
        let currentButton!: HTMLButtonElement;
        let currentActivation!: CapturedTemplateClick;
        focusOwner.focus();
        let boundaryReached!: () => void;
        const atBoundary = new Promise<void>((resolve) => {
          boundaryReached = resolve;
        });

        root.render(
          <TemplateGridBoundary
            mountKey="b"
            onPick={onPick}
            busy={null}
            boundary={1}
            onPassiveCleanup={passiveCleanup}
            onBoundary={() => {
              expect(passiveCleanup).not.toHaveBeenCalled();
              currentButton = templateButton(host, template.id);
              currentActivation = captureTemplateClick(currentButton);
              expect(currentButton).not.toBe(oldButton);
              expect(oldButton.isConnected).toBe(false);
              expect(host.innerHTML).toBe(oldMarkup);
              if (order === "wrong-before-current") {
                expectInertCapturedClick(staleActivation, currentButton, host);
                expectInertCapturedClick(currentActivation, oldButton, host);
                expect(onPick).not.toHaveBeenCalled();
                invokeCapturedClick(currentActivation, currentButton);
              } else {
                invokeCapturedClick(currentActivation, currentButton);
                expectInertCapturedClick(staleActivation, currentButton, host);
                expectInertCapturedClick(currentActivation, oldButton, host);
              }
              expect(onPick).toHaveBeenCalledTimes(1);
              expect(onPick).toHaveBeenLastCalledWith(template);
              boundaryReached();
            }}
          />,
        );
        await atBoundary;
        await act(async () => {});
        expect(passiveCleanup).toHaveBeenCalledTimes(1);
        expectInertCapturedClick(staleActivation, currentButton, host);
        expectInertCapturedClick(currentActivation, oldButton, host);
        expectInertCapturedClick(currentActivation, currentButton, host);
        expect(onPick).toHaveBeenCalledTimes(1);
      } finally {
        await act(async () => root.unmount());
        focusOwner.remove();
        host.remove();
      }
    },
  );

  it("makes a removed publication inert at the parent boundary and leaves a later mount usable", async () => {
    const host = document.createElement("div");
    const focusOwner = document.createElement("button");
    document.body.append(focusOwner, host);
    const root = createRoot(host);
    const onPick = vi.fn<(template: Template) => void>();
    const passiveCleanup = vi.fn();
    const template = PICKER_TEMPLATES[0];

    try {
      await act(async () => {
        root.render(<TemplateGridBoundary onPick={onPick} busy={null} onPassiveCleanup={passiveCleanup} />);
      });
      const oldButton = templateButton(host, template.id);
      const staleActivation = captureTemplateClick(oldButton);
      focusOwner.focus();
      let removalBoundaryReached!: () => void;
      const atRemovalBoundary = new Promise<void>((resolve) => {
        removalBoundaryReached = resolve;
      });

      root.render(
        <TemplateGridBoundary
          present={false}
          onPick={onPick}
          busy={null}
          boundary={1}
          onPassiveCleanup={passiveCleanup}
          onBoundary={() => {
            expect(passiveCleanup).not.toHaveBeenCalled();
            const replacement = host.querySelector<HTMLButtonElement>('[data-testid="grid-replacement"]');
            expect(replacement).toBeTruthy();
            const markup = host.innerHTML;
            const event = capturedActivationEvent(oldButton);
            staleActivation(event);
            expect(onPick).not.toHaveBeenCalled();
            expect(event.preventDefault).not.toHaveBeenCalled();
            expect(event.stopPropagation).not.toHaveBeenCalled();
            expect(document.activeElement).toBe(focusOwner);
            expect(host.innerHTML).toBe(markup);
            removalBoundaryReached();
          }}
        />,
      );
      await atRemovalBoundary;
      await act(async () => {});
      expect(passiveCleanup).toHaveBeenCalledTimes(1);
      staleActivation(capturedActivationEvent(oldButton));

      let mountBoundaryReached!: () => void;
      const atMountBoundary = new Promise<void>((resolve) => {
        mountBoundaryReached = resolve;
      });
      root.render(
        <TemplateGridBoundary
          mountKey="later"
          onPick={onPick}
          busy={null}
          boundary={2}
          onPassiveCleanup={passiveCleanup}
          onBoundary={() => {
            const currentButton = templateButton(host, template.id);
            const currentActivation = captureTemplateClick(currentButton);
            invokeCapturedClick(staleActivation, oldButton);
            invokeCapturedClick(currentActivation, currentButton);
            expect(onPick).toHaveBeenCalledTimes(1);
            expect(onPick).toHaveBeenLastCalledWith(template);
            mountBoundaryReached();
          }}
        />,
      );
      await atMountBoundary;
      await act(async () => {});
      invokeCapturedClick(staleActivation, oldButton);
      expect(onPick).toHaveBeenCalledTimes(1);
    } finally {
      await act(async () => root.unmount());
      focusOwner.remove();
      host.remove();
    }
  });
});

describe("dashboard search shortcut", () => {
  it("has an explicit name and compact hint, then focuses and selects the query once for /", () => {
    renderDashboard(<button type="button">Outside search</button>);
    const search = screen.getByRole("textbox", { name: "Search documents" }) as HTMLInputElement;
    expect(screen.getByText("/", { selector: "kbd" })).toBeInTheDocument();
    fireEvent.change(search, { target: { value: "alpha" } });
    screen.getByRole("button", { name: "Outside search" }).focus();
    const focus = vi.spyOn(search, "focus");
    const select = vi.spyOn(search, "select");

    expect(fireEvent.keyDown(screen.getByRole("button", { name: "Outside search" }), { key: "/" })).toBe(false);

    expect(search).toHaveFocus();
    expect(search.selectionStart).toBe(0);
    expect(search.selectionEnd).toBe(5);
    expect(focus).toHaveBeenCalledTimes(1);
    expect(select).toHaveBeenCalledTimes(1);
  });

  it("does not claim / from typing controls, editable content, dialogs, the palette, or modifier shortcuts", () => {
    renderDashboard(
      <div>
        <input aria-label="Other input" />
        <textarea aria-label="Other textarea" />
        <select aria-label="Other select"><option>One</option></select>
        <div contentEditable tabIndex={0}>Editable content</div>
        <dialog open><button type="button">Dialog control</button></dialog>
        <div data-testid="command-palette"><button type="button">Palette control</button></div>
        <button type="button">Outside search</button>
      </div>,
    );
    const search = screen.getByRole("textbox", { name: "Search documents" }) as HTMLInputElement;
    const contexts = [
      screen.getByRole("textbox", { name: "Other input" }),
      screen.getByRole("textbox", { name: "Other textarea" }),
      screen.getByRole("combobox", { name: "Other select" }),
      screen.getByText("Editable content"),
      screen.getByRole("button", { name: "Dialog control" }),
      screen.getByRole("button", { name: "Palette control" }),
    ];
    for (const target of contexts) {
      target.focus();
      expect(fireEvent.keyDown(target, { key: "/" })).toBe(true);
      expect(search).not.toHaveFocus();
      expect(target).toHaveFocus();
    }

    const outside = screen.getByRole("button", { name: "Outside search" });
    for (const modifier of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }]) {
      outside.focus();
      expect(fireEvent.keyDown(outside, { key: "/", ...modifier })).toBe(true);
      expect(search).not.toHaveFocus();
    }
  });
});

describe("dashboard shortcut ownership", () => {
  it.each([
    ["Mod-K", { key: "k", ctrlKey: true }],
    ["Mod-Shift-P", { key: "p", ctrlKey: true, shiftKey: true }],
  ] as const)("keeps one exact current listener per class and opens once for %s", async (_name, init) => {
    const listeners = trackWindowKeydownListeners();
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);

    try {
      await act(async () => {
        root.render(<Dashboard user={USER} documents={DOCUMENTS} githubAvailable githubConfigured />);
      });
      expect(listeners.active(false)).toHaveLength(1);
      expect(listeners.active(true)).toHaveLength(1);

      const search = screen.getByRole("textbox", { name: "Search documents" }) as HTMLInputElement;
      if (init.key === "k") {
        const ignored = shortcutEvent(init);
        act(() => {
          search.dispatchEvent(ignored.event);
        });
        expect(ignored.preventDefault).not.toHaveBeenCalled();
        expect(ignored.stopPropagation).not.toHaveBeenCalled();
        expect(screen.queryByTestId("command-palette")).toBeNull();
      }

      const accepted = shortcutEvent(init);
      act(() => {
        screen.getByTestId("new-document").dispatchEvent(accepted.event);
      });
      expect(accepted.preventDefault).toHaveBeenCalledOnce();
      expect(accepted.stopPropagation).toHaveBeenCalledOnce();
      expect(screen.getByTestId("command-palette")).toBeInTheDocument();
      expect(listeners.active(false)).toHaveLength(1);
      expect(listeners.active(true)).toHaveLength(1);

      const repeat = shortcutEvent(init);
      act(() => {
        screen.getByTestId("new-document").dispatchEvent(repeat.event);
      });
      expect(repeat.preventDefault).not.toHaveBeenCalled();
      expect(repeat.stopPropagation).not.toHaveBeenCalled();

      const focus = vi.spyOn(search, "focus");
      const select = vi.spyOn(search, "select");
      const slash = shortcutEvent({ key: "/" });
      act(() => {
        screen.getByTestId("new-document").dispatchEvent(slash.event);
      });
      expect(slash.preventDefault).not.toHaveBeenCalled();
      expect(focus).not.toHaveBeenCalled();
      expect(select).not.toHaveBeenCalled();
      expect(screen.getByTestId("command-palette")).toBeInTheDocument();
      expect(searchDocuments).not.toHaveBeenCalled();
      expect(createDocument).not.toHaveBeenCalled();
      expect(router.push).not.toHaveBeenCalled();
      expect(router.refresh).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      expect(listeners.active(false)).toHaveLength(0);
      expect(listeners.active(true)).toHaveLength(0);
      host.remove();
    }
  });

  it.each([
    ["different user", { ...USER, id: "replacement-shortcut-owner", login: "replacement-shortcut-owner" }],
    ["equal user values", { ...USER }],
  ])("retires captured callbacks before a %s replacement boundary and leaves the new visit usable", async (_name, replacementUser) => {
    const listeners = trackWindowKeydownListeners();
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    let passiveCleanups = 0;
    const onPassiveCleanup = () => {
      passiveCleanups++;
    };

    try {
      await act(async () => {
        root.render(<DashboardBoundary onPassiveCleanup={onPassiveCleanup} />);
      });
      const staleSearch = listeners.active(false)[0];
      const stalePalette = listeners.active(true)[0];
      const staleInput = screen.getByRole("textbox", { name: "Search documents" }) as HTMLInputElement;
      const staleFocus = vi.spyOn(staleInput, "focus");
      const staleSelect = vi.spyOn(staleInput, "select");
      const staleSlashAtBoundary = shortcutEvent({ key: "/" });
      const stalePaletteAtBoundary = shortcutEvent({ key: "p", ctrlKey: true, shiftKey: true });
      let boundaryReached!: () => void;
      const atBoundary = new Promise<void>((resolve) => {
        boundaryReached = resolve;
      });

      root.render(
        <DashboardBoundary
          user={replacementUser}
          boundary={1}
          onPassiveCleanup={onPassiveCleanup}
          onBoundary={() => {
            expect(passiveCleanups).toBe(0);
            expect(listeners.removalCount(staleSearch, false)).toBe(1);
            expect(listeners.removalCount(stalePalette, true)).toBe(1);
            expect(listeners.active(false)).toHaveLength(1);
            expect(listeners.active(true)).toHaveLength(1);
            staleSearch(staleSlashAtBoundary.event);
            stalePalette(stalePaletteAtBoundary.event);
            expect(staleSlashAtBoundary.preventDefault).not.toHaveBeenCalled();
            expect(stalePaletteAtBoundary.preventDefault).not.toHaveBeenCalled();
            expect(stalePaletteAtBoundary.stopPropagation).not.toHaveBeenCalled();
            boundaryReached();
          }}
        />,
      );
      await atBoundary;
      await act(async () => {});

      const currentSearch = listeners.active(false)[0];
      const currentPalette = listeners.active(true)[0];
      expect(currentSearch).not.toBe(staleSearch);
      expect(currentPalette).not.toBe(stalePalette);
      expect(staleFocus).not.toHaveBeenCalled();
      expect(staleSelect).not.toHaveBeenCalled();
      const currentInput = screen.getByRole("textbox", { name: "Search documents" }) as HTMLInputElement;
      const currentFocus = vi.spyOn(currentInput, "focus");
      const currentSelect = vi.spyOn(currentInput, "select");
      const currentSlash = shortcutEvent({ key: "/" });
      act(() => currentSearch(currentSlash.event));
      expect(currentSlash.preventDefault).toHaveBeenCalledOnce();
      expect(currentSlash.stopPropagation).not.toHaveBeenCalled();
      expect(currentFocus).toHaveBeenCalledOnce();
      expect(currentSelect).toHaveBeenCalledOnce();

      const currentPaletteEvent = shortcutEvent({ key: "k", ctrlKey: true });
      act(() => currentPalette(currentPaletteEvent.event));
      expect(currentPaletteEvent.preventDefault).toHaveBeenCalledOnce();
      expect(currentPaletteEvent.stopPropagation).toHaveBeenCalledOnce();
      expect(screen.getByTestId("command-palette")).toBeInTheDocument();

      const staleSlashAfterCurrent = shortcutEvent({ key: "/" });
      const stalePaletteAfterCurrent = shortcutEvent({ key: "p", ctrlKey: true, shiftKey: true });
      act(() => {
        stalePalette(stalePaletteAfterCurrent.event);
        staleSearch(staleSlashAfterCurrent.event);
      });
      expect(staleSlashAfterCurrent.preventDefault).not.toHaveBeenCalled();
      expect(stalePaletteAfterCurrent.preventDefault).not.toHaveBeenCalled();
      expect(stalePaletteAfterCurrent.stopPropagation).not.toHaveBeenCalled();
      expect(staleFocus).toHaveBeenCalledOnce();
      expect(staleSelect).toHaveBeenCalledOnce();
      expect(currentFocus).toHaveBeenCalledOnce();
      expect(currentSelect).toHaveBeenCalledOnce();
      expect(listeners.active(false)).toEqual([currentSearch]);
      expect(listeners.active(true)).toEqual([currentPalette]);
      expect(searchDocuments).not.toHaveBeenCalled();
      expect(listDocuments).not.toHaveBeenCalled();
      expect(createDocument).not.toHaveBeenCalled();
      expect(starDocument).not.toHaveBeenCalled();
      expect(router.push).not.toHaveBeenCalled();
      expect(router.refresh).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it("retires both captured listeners before removal and keeps their callback orders inert", async () => {
    const listeners = trackWindowKeydownListeners();
    const host = document.createElement("div");
    const focusOwner = document.createElement("button");
    focusOwner.textContent = "Persistent shortcut focus";
    document.body.append(focusOwner, host);
    const root = createRoot(host);
    let passiveCleanups = 0;

    try {
      await act(async () => {
        root.render(
          <DashboardBoundary
            onPassiveCleanup={() => {
              passiveCleanups++;
            }}
          />,
        );
      });
      const staleSearch = listeners.active(false)[0];
      const stalePalette = listeners.active(true)[0];
      const staleInput = screen.getByRole("textbox", { name: "Search documents" }) as HTMLInputElement;
      const staleFocus = vi.spyOn(staleInput, "focus");
      const staleSelect = vi.spyOn(staleInput, "select");
      const boundarySlash = shortcutEvent({ key: "/" });
      const boundaryPalette = shortcutEvent({ key: "k", ctrlKey: true });
      let boundaryReached!: () => void;
      const atBoundary = new Promise<void>((resolve) => {
        boundaryReached = resolve;
      });

      root.render(
        <DashboardBoundary
          present={false}
          boundary={1}
          onPassiveCleanup={() => {
            passiveCleanups++;
          }}
          onBoundary={() => {
            expect(passiveCleanups).toBe(0);
            expect(listeners.active(false)).toHaveLength(0);
            expect(listeners.active(true)).toHaveLength(0);
            focusOwner.focus();
            staleSearch(boundarySlash.event);
            stalePalette(boundaryPalette.event);
            expect(boundarySlash.preventDefault).not.toHaveBeenCalled();
            expect(boundaryPalette.preventDefault).not.toHaveBeenCalled();
            expect(boundaryPalette.stopPropagation).not.toHaveBeenCalled();
            boundaryReached();
          }}
        />,
      );
      await atBoundary;
      await act(async () => {});
      const removedMarkup = host.innerHTML;
      const removedSlash = shortcutEvent({ key: "/" });
      const removedPalette = shortcutEvent({ key: "p", ctrlKey: true, shiftKey: true });
      act(() => {
        stalePalette(removedPalette.event);
        staleSearch(removedSlash.event);
      });

      expect(host.innerHTML).toBe(removedMarkup);
      expect(focusOwner).toHaveFocus();
      expect(staleFocus).not.toHaveBeenCalled();
      expect(staleSelect).not.toHaveBeenCalled();
      expect(removedSlash.preventDefault).not.toHaveBeenCalled();
      expect(removedPalette.preventDefault).not.toHaveBeenCalled();
      expect(removedPalette.stopPropagation).not.toHaveBeenCalled();
      expect(searchDocuments).not.toHaveBeenCalled();
      expect(listDocuments).not.toHaveBeenCalled();
      expect(createDocument).not.toHaveBeenCalled();
      expect(starDocument).not.toHaveBeenCalled();
      expect(router.push).not.toHaveBeenCalled();
      expect(router.refresh).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      host.remove();
      focusOwner.remove();
    }
  });
});

describe("dashboard content-search recovery", () => {
  it("keeps title matches, announces the server reason with Retry, and clears the obsolete error on a changed query", async () => {
    searchDocuments.mockRejectedValueOnce(new ApiError(503, "Search service unavailable"));
    renderDashboard();
    const search = screen.getByRole("textbox", { name: "Search documents" });
    fireEvent.change(search, { target: { value: "alpha" } });
    await settleSearch();

    const alert = screen.getByRole("alert");
    expect(alert).toHaveAttribute("aria-atomic", "true");
    expect(alert).toHaveTextContent("Content search failed: Search service unavailable. Showing title matches only.");
    expect(within(alert).getByRole("button", { name: "Retry" })).toBeEnabled();
    expect(screen.getByRole("link", { name: /Alpha planning/ })).toBeInTheDocument();
    expect(screen.queryByText('No matches for "alpha"')).toBeNull();

    fireEvent.change(search, { target: { value: "notes" } });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("issues one request for the exact current query and clears the alert only after a successful retry", async () => {
    const retry = deferred<SearchResponse>();
    searchDocuments
      .mockRejectedValueOnce(new ApiError(503, "Search service unavailable"))
      .mockReturnValueOnce(retry.promise);
    renderDashboard();
    const search = screen.getByRole("textbox", { name: "Search documents" });
    fireEvent.change(search, { target: { value: "alpha" } });
    await settleSearch();
    const alert = screen.getByRole("alert");

    const retryButton = within(alert).getByRole("button", { name: "Retry" });
    act(() => {
      retryButton.click();
      retryButton.click();
    });

    expect(searchDocuments).toHaveBeenCalledTimes(2);
    expect(searchDocuments.mock.calls[1][0]).toBe("alpha");
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(within(screen.getByRole("alert")).getByRole("button", { name: "Retrying…" })).toBeDisabled();

    await act(async () => {
      retry.resolve({ query: "alpha", documents: [result("content-match", "Roadmap", "Body contains alpha milestones")] });
      await retry.promise;
    });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("link", { name: /Roadmap/ })).toBeInTheDocument();
    expect(screen.getByTestId("search-snippet")).toHaveTextContent("Body contains alpha milestones");
  });

  it("aborts superseded requests and ignores their late results and errors", async () => {
    const requests = new Map<string, ReturnType<typeof deferred<SearchResponse>>>();
    searchDocuments.mockImplementation((query) => {
      const request = deferred<SearchResponse>();
      requests.set(query, request);
      return request.promise;
    });
    renderDashboard();
    const search = screen.getByRole("textbox", { name: "Search documents" });

    fireEvent.change(search, { target: { value: "alpha" } });
    await settleSearch();
    fireEvent.change(search, { target: { value: "beta" } });
    expect(searchDocuments.mock.calls[0][1]?.signal?.aborted).toBe(true);
    await settleSearch();
    fireEvent.change(search, { target: { value: "gamma" } });
    expect(searchDocuments.mock.calls[1][1]?.signal?.aborted).toBe(true);
    await settleSearch();

    await act(async () => {
      requests.get("gamma")!.resolve({ query: "gamma", documents: [result("gamma", "Gamma result", "Current gamma content")] });
      await requests.get("gamma")!.promise;
    });
    await act(async () => {
      requests.get("alpha")!.resolve({ query: "alpha", documents: [result("stale", "Stale alpha result", "Old content")] });
      requests.get("beta")!.reject(new Error("Stale beta failure"));
      await Promise.allSettled([requests.get("alpha")!.promise, requests.get("beta")!.promise]);
    });

    expect(searchDocuments).toHaveBeenCalledTimes(3);
    expect(screen.getByRole("link", { name: /Gamma result/ })).toBeInTheDocument();
    expect(screen.queryByText(/Stale alpha result/)).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it.each(["success", "failure"] as const)(
    "retires an old user search before its %s settles at the replacement layout boundary",
    async (settlement) => {
      const oldSearch = deferred<SearchResponse>();
      const currentSearch = deferred<SearchResponse>();
      const passiveCleanup = vi.fn();
      const replacementUser = { ...USER, id: "replacement-owner", name: "Replacement owner", login: "replacement-owner" };
      searchDocuments.mockReturnValueOnce(oldSearch.promise).mockReturnValueOnce(currentSearch.promise);
      const view = render(<DashboardBoundary onPassiveCleanup={passiveCleanup} />);
      fireEvent.change(screen.getByRole("textbox", { name: "Search documents" }), { target: { value: "alpha" } });
      await settleSearch();
      const oldSignal = searchDocuments.mock.calls[0][1]?.signal;

      view.rerender(
        <DashboardBoundary
          user={replacementUser}
          documents={[]}
          boundary={1}
          onPassiveCleanup={passiveCleanup}
          onBoundary={() => {
            expect(passiveCleanup).not.toHaveBeenCalled();
            expect(oldSignal?.aborted).toBe(true);
            if (settlement === "success") {
              oldSearch.resolve({ query: "alpha", documents: [result("old-result", "Old user result", "Old user content")] });
            } else {
              oldSearch.reject(new ApiError(503, "Old user search failed"));
            }
          }}
        />,
      );
      await act(async () => {
        await Promise.allSettled([oldSearch.promise]);
        await Promise.resolve();
      });

      expect(searchDocuments).toHaveBeenCalledTimes(1);
      expect(screen.queryByText("Old user result")).toBeNull();
      expect(screen.queryByRole("alert")).toBeNull();
      expect(screen.queryByTestId("search-loading")).toBeNull();
      expect(screen.getByText('Searching for "alpha"…')).toBeInTheDocument();
      expect(console.error).not.toHaveBeenCalled();

      await settleSearch();
      expect(searchDocuments).toHaveBeenCalledTimes(2);
      expect(searchDocuments.mock.calls[1][0]).toBe("alpha");
      expect(searchDocuments.mock.calls[1][1]?.signal?.aborted).toBe(false);
      expect(screen.getByTestId("search-loading")).toBeInTheDocument();

      await act(async () => {
        currentSearch.resolve({ query: "alpha", documents: [result("current-result", "Current user result", "Current user content")] });
        await currentSearch.promise;
      });
      expect(screen.getByRole("link", { name: /Current user result/ })).toBeInTheDocument();
      expect(screen.queryByRole("alert")).toBeNull();
      expect(screen.queryByTestId("search-loading")).toBeNull();
    },
  );

  it.each(["success", "failure"] as const)(
    "retires a search before its %s settles at the removal layout boundary",
    async (settlement) => {
      const oldSearch = deferred<SearchResponse>();
      const passiveCleanup = vi.fn();
      searchDocuments.mockReturnValueOnce(oldSearch.promise);
      const view = render(<DashboardBoundary onPassiveCleanup={passiveCleanup} />);
      fireEvent.change(screen.getByRole("textbox", { name: "Search documents" }), { target: { value: "alpha" } });
      await settleSearch();
      const oldSignal = searchDocuments.mock.calls[0][1]?.signal;

      view.rerender(
        <DashboardBoundary
          present={false}
          boundary={1}
          onPassiveCleanup={passiveCleanup}
          onBoundary={() => {
            expect(passiveCleanup).not.toHaveBeenCalled();
            expect(oldSignal?.aborted).toBe(true);
            if (settlement === "success") {
              oldSearch.resolve({ query: "alpha", documents: [result("removed-result", "Removed result", "Removed content")] });
            } else {
              oldSearch.reject(new ApiError(503, "Removed search failed"));
            }
          }}
        />,
      );
      await act(async () => {
        await Promise.allSettled([oldSearch.promise]);
        await Promise.resolve();
      });

      expect(searchDocuments).toHaveBeenCalledTimes(1);
      expect(screen.queryByRole("textbox", { name: "Search documents" })).toBeNull();
      expect(screen.queryByText("Removed result")).toBeNull();
      expect(screen.queryByRole("alert")).toBeNull();
      expect(screen.queryByTestId("search-loading")).toBeNull();
      expect(console.error).not.toHaveBeenCalled();
    },
  );

  it("keeps the replacement request pending when the old request finalizes", async () => {
    const oldSearch = controlledSearch<SearchResponse>();
    const currentSearch = deferred<SearchResponse>();
    const replacementUser = { ...USER, id: "replacement-finalizer", name: "Replacement owner", login: "replacement-finalizer" };
    searchDocuments.mockReturnValueOnce(oldSearch.promise).mockReturnValueOnce(currentSearch.promise);
    const view = render(<DashboardBoundary />);
    fireEvent.change(screen.getByRole("textbox", { name: "Search documents" }), { target: { value: "alpha" } });
    await settleSearch();

    view.rerender(
      <DashboardBoundary
        user={replacementUser}
        documents={[]}
        boundary={1}
        onBoundary={() => oldSearch.resolve({ query: "alpha", documents: [result("stale-finalizer", "Stale finalizer", "Old content")] })}
      />,
    );
    await act(async () => {
      await Promise.resolve();
    });
    await settleSearch();

    expect(searchDocuments).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId("search-loading")).toBeInTheDocument();
    act(() => {
      oldSearch.finalize();
    });
    expect(screen.getByTestId("search-loading")).toBeInTheDocument();
    expect(screen.queryByText("Stale finalizer")).toBeNull();

    await act(async () => {
      currentSearch.resolve({ query: "alpha", documents: [result("finalizer-current", "Current finalizer result", "Current content")] });
      await currentSearch.promise;
    });
    expect(screen.queryByTestId("search-loading")).toBeNull();
    expect(screen.getByRole("link", { name: /Current finalizer result/ })).toBeInTheDocument();
    expect(console.error).not.toHaveBeenCalled();
  });
});

describe("dashboard notice ownership", () => {
  it("retires the exact old-user timer before the parent layout boundary and leaves a same-value replacement notice independent", async () => {
    const pending: PendingNotice = { message: "Account notice", kind: "success" };
    takePendingNotice.mockReturnValueOnce(pending).mockReturnValueOnce({ ...pending });
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    let passiveCleanups = 0;
    const onPassiveCleanup = () => {
      passiveCleanups++;
    };

    try {
      await act(async () => {
        root.render(<DashboardBoundary onPassiveCleanup={onPassiveCleanup} />);
      });
      expect(takePendingNotice).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId("toast")).toHaveTextContent(pending.message);
      const oldDismiss = captureClick(screen.getByRole("button", { name: "Dismiss" }));
      const oldTimerIndex = setTimeoutSpy.mock.calls.findIndex(([, delay]) => delay === 5000);
      expect(oldTimerIndex).toBeGreaterThanOrEqual(0);
      const oldTimerCallback = setTimeoutSpy.mock.calls[oldTimerIndex][0];
      const oldTimer = setTimeoutSpy.mock.results[oldTimerIndex]?.value;
      expect(typeof oldTimerCallback).toBe("function");
      const timersBeforeRetirement = vi.getTimerCount();
      expect(timersBeforeRetirement).toBeGreaterThanOrEqual(1);

      const replacementUser = { ...USER, id: "replacement-notice-owner", login: "replacement-notice-owner" };
      let boundaryReached!: () => void;
      const atBoundary = new Promise<void>((resolve) => {
        boundaryReached = resolve;
      });
      root.render(
        <DashboardBoundary
          user={replacementUser}
          boundary={1}
          onPassiveCleanup={onPassiveCleanup}
          onBoundary={() => {
            expect(passiveCleanups).toBe(0);
            expect(vi.getTimerCount()).toBe(timersBeforeRetirement - 1);
            expect(clearTimeoutSpy).toHaveBeenCalledWith(oldTimer);
            expect(screen.queryByTestId("toast")).toBeNull();
            boundaryReached();
          }}
        />,
      );
      await atBoundary;
      await act(async () => {});

      expect(takePendingNotice).toHaveBeenCalledTimes(2);
      expect(screen.getByTestId("toast")).toHaveTextContent(pending.message);
      expect(screen.getByTestId("toast")).toHaveAttribute("data-kind", pending.kind);
      const currentDismiss = captureClick(screen.getByRole("button", { name: "Dismiss" }));
      const currentTimerIndexes = setTimeoutSpy.mock.calls
        .map(([, delay], index) => (delay === 5000 ? index : -1))
        .filter((index) => index >= 0);
      expect(currentTimerIndexes).toHaveLength(2);
      const currentTimer = setTimeoutSpy.mock.results[currentTimerIndexes[1]]?.value;
      expect(clearTimeoutSpy).not.toHaveBeenCalledWith(currentTimer);
      expect(vi.getTimerCount()).toBe(timersBeforeRetirement);

      const search = screen.getByRole("textbox", { name: "Search documents" });
      search.focus();
      const documentListBefore = screen.getByTestId("document-list").textContent;
      const timersBeforeStaleCallbacks = vi.getTimerCount();
      act(() => {
        if (typeof oldTimerCallback === "function") oldTimerCallback();
        oldDismiss();
      });
      expect(screen.getByTestId("toast")).toHaveTextContent(pending.message);
      expect(screen.getByTestId("document-list")).toHaveTextContent(documentListBefore ?? "");
      expect(search).toHaveFocus();
      expect(vi.getTimerCount()).toBe(timersBeforeStaleCallbacks);
      expect(router.push).not.toHaveBeenCalled();
      expect(router.refresh).not.toHaveBeenCalled();
      expect(searchDocuments).not.toHaveBeenCalled();
      expect(createDocument).not.toHaveBeenCalled();

      await act(async () => {
        root.render(<DashboardBoundary user={replacementUser} boundary={2} onPassiveCleanup={onPassiveCleanup} />);
      });
      expect(takePendingNotice).toHaveBeenCalledTimes(2);
      act(() => currentDismiss());
      expect(screen.queryByTestId("toast")).toBeNull();
      expect(clearTimeoutSpy.mock.calls.filter(([timer]) => timer === currentTimer)).toHaveLength(1);
      act(() => currentDismiss());
      expect(screen.queryByTestId("toast")).toBeNull();
      expect(clearTimeoutSpy.mock.calls.filter(([timer]) => timer === currentTimer)).toHaveLength(1);
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it("retires a removed visit before the parent layout boundary and keeps captured callbacks inert", async () => {
    takePendingNotice.mockReturnValueOnce({ message: "Removed notice", kind: "info" });
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");
    const host = document.createElement("div");
    const focusOwner = document.createElement("button");
    focusOwner.textContent = "Persistent focus owner";
    document.body.append(focusOwner, host);
    const root = createRoot(host);
    let passiveCleanups = 0;
    const onPassiveCleanup = () => {
      passiveCleanups++;
    };

    try {
      await act(async () => {
        root.render(<DashboardBoundary onPassiveCleanup={onPassiveCleanup} />);
      });
      const staleDismiss = captureClick(screen.getByRole("button", { name: "Dismiss" }));
      const timerIndex = setTimeoutSpy.mock.calls.findIndex(([, delay]) => delay === 5000);
      expect(timerIndex).toBeGreaterThanOrEqual(0);
      const staleTimerCallback = setTimeoutSpy.mock.calls[timerIndex][0];
      const staleTimer = setTimeoutSpy.mock.results[timerIndex]?.value;
      const timersBeforeRetirement = vi.getTimerCount();

      let boundaryReached!: () => void;
      const atBoundary = new Promise<void>((resolve) => {
        boundaryReached = resolve;
      });
      root.render(
        <DashboardBoundary
          present={false}
          boundary={1}
          onPassiveCleanup={onPassiveCleanup}
          onBoundary={() => {
            expect(passiveCleanups).toBe(0);
            expect(vi.getTimerCount()).toBe(timersBeforeRetirement - 1);
            expect(clearTimeoutSpy).toHaveBeenCalledWith(staleTimer);
            focusOwner.focus();
            boundaryReached();
          }}
        />,
      );
      await atBoundary;
      await act(async () => {});
      const removedMarkup = host.innerHTML;

      act(() => {
        staleDismiss();
        if (typeof staleTimerCallback === "function") staleTimerCallback();
      });
      expect(host.innerHTML).toBe(removedMarkup);
      expect(screen.queryByTestId("toast")).toBeNull();
      expect(focusOwner).toHaveFocus();
      expect(takePendingNotice).toHaveBeenCalledTimes(1);
      expect(searchDocuments).not.toHaveBeenCalled();
      expect(listDocuments).not.toHaveBeenCalled();
      expect(createDocument).not.toHaveBeenCalled();
      expect(starDocument).not.toHaveBeenCalled();
      expect(router.push).not.toHaveBeenCalled();
      expect(router.refresh).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      host.remove();
      focusOwner.remove();
    }
  });

  it("keeps the pending notice through 4,999 ms and clears that exact publication once at 5,000 ms", async () => {
    takePendingNotice.mockReturnValueOnce({ message: "Timed notice", kind: "info" });
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    renderDashboard();

    expect(takePendingNotice).toHaveBeenCalledOnce();
    expect(setTimeoutSpy.mock.calls.filter(([, delay]) => delay === 5000)).toHaveLength(1);
    expect(screen.getByTestId("toast")).toHaveTextContent("Timed notice");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4999);
    });
    expect(screen.getByTestId("toast")).toHaveTextContent("Timed notice");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(screen.queryByTestId("toast")).toBeNull();
    expect(router.push).not.toHaveBeenCalled();
    expect(router.refresh).not.toHaveBeenCalled();
    expect(searchDocuments).not.toHaveBeenCalled();
  });

  it("does not let a pending timer or Dismiss clear a newer Restore success", async () => {
    takePendingNotice.mockReturnValueOnce({ message: "Moved to trash.", kind: "success" });
    listDocuments.mockResolvedValueOnce({ documents: [trashedDoc("restore-notice", "Restore notice")] });
    renderDashboard();
    const staleDismiss = captureClick(screen.getByRole("button", { name: "Dismiss" }));

    openTrash();
    await act(async () => {});
    fireEvent.click(trashButton("Restore notice", "restore-button"));
    await act(async () => {});

    expect(screen.getByTestId("toast")).toHaveTextContent("“Restore notice” was restored.");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    act(() => staleDismiss());
    expect(screen.getByTestId("toast")).toHaveTextContent("“Restore notice” was restored.");
    expect(router.refresh).toHaveBeenCalledOnce();
    expect(router.push).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByTestId("toast")).toBeNull();
  });

  it("uses identity when a Create error replaces an equal pending notice and keeps the action error persistent", async () => {
    const sameNotice: PendingNotice = { message: "Same publication", kind: "error" };
    const failed = deferred<CreateResponse>();
    takePendingNotice.mockReturnValueOnce(sameNotice);
    createDocument.mockReturnValueOnce(failed.promise);
    renderDashboard(undefined, []);
    const staleDismiss = captureClick(screen.getByRole("button", { name: "Dismiss" }));

    fireEvent.click(screen.getByTestId("new-document"));
    await act(async () => {
      failed.reject(new ApiError(503, sameNotice.message));
      await Promise.allSettled([failed.promise]);
    });
    const currentDismiss = captureClick(screen.getByTestId("toast").querySelector('button[aria-label="Dismiss"]')!);
    expect(screen.getByTestId("toast")).toHaveTextContent(sameNotice.message);

    act(() => staleDismiss());
    expect(screen.getByTestId("toast")).toHaveTextContent(sameNotice.message);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(screen.getByTestId("toast")).toHaveTextContent(sameNotice.message);
    expect(screen.getByTestId("toast")).toHaveAttribute("data-kind", sameNotice.kind);
    expect(router.push).not.toHaveBeenCalled();
    expect(router.refresh).not.toHaveBeenCalled();

    act(() => currentDismiss());
    expect(screen.queryByTestId("toast")).toBeNull();
  });

  it("keeps stale pending callbacks inert when the current Import error is dismissed first", async () => {
    takePendingNotice.mockReturnValueOnce({ message: "Previous page notice", kind: "info" });
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    renderDashboard();
    const staleDismiss = captureClick(screen.getByRole("button", { name: "Dismiss" }));
    const timerIndex = setTimeoutSpy.mock.calls.findIndex(([, delay]) => delay === 5000);
    const staleTimerCallback = setTimeoutSpy.mock.calls[timerIndex][0];

    const input = screen.getByTestId("import-file-input");
    fireEvent.change(input, {
      target: { files: [new File(["image"], "only-image.png", { type: "image/png" })] },
    });
    expect(screen.getByTestId("toast")).toHaveTextContent("Drop a Markdown, text or HTML file together with the images.");
    expect(screen.getByTestId("toast")).toHaveAttribute("data-kind", "error");

    const currentDismiss = captureClick(screen.getByTestId("toast").querySelector('button[aria-label="Dismiss"]')!);
    act(() => currentDismiss());
    expect(screen.queryByTestId("toast")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await act(async () => {});
    expect(screen.queryByTestId("import-dialog")).toBeNull();
    act(() => {
      staleDismiss();
      if (typeof staleTimerCallback === "function") staleTimerCallback();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(screen.queryByTestId("toast")).toBeNull();
    expect(router.push).not.toHaveBeenCalled();
    expect(router.refresh).not.toHaveBeenCalled();
    expect(createDocument).not.toHaveBeenCalled();
  });
});

describe("dashboard create ownership", () => {
  it("gives immediate blank, welcome, template, and palette activations one request and one navigation", async () => {
    const pending = deferred<CreateResponse>();
    createDocument.mockReturnValueOnce(pending.promise);
    renderDashboard(undefined, []);
    const blank = screen.getByTestId("new-document");
    const welcome = screen.getByTestId("start-guided-doc");
    const template = screen.getByTestId("template-meeting-notes");

    act(() => {
      blank.click();
      welcome.click();
      template.click();
    });

    expect(createDocument).toHaveBeenCalledTimes(1);
    expect(createDocument).toHaveBeenLastCalledWith({});
    expect(blank).toBeDisabled();
    expect(welcome).toBeDisabled();
    expect(template).toBeDisabled();

    fireEvent.keyDown(window, { key: "p", ctrlKey: true, shiftKey: true });
    fireEvent.click(screen.getByTestId("palette-item-dash:new"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(createDocument).toHaveBeenCalledTimes(1);

    await act(async () => {
      pending.resolve({ document: { id: "one-created", title: "Untitled" } });
      await pending.promise;
    });

    expect(router.push).toHaveBeenCalledTimes(1);
    expect(router.push).toHaveBeenLastCalledWith("/d/one-created");
    expect(blank).toBeEnabled();
  });

  it("shows the current failure, restores every control, and retries to one navigation", async () => {
    const failed = deferred<CreateResponse>();
    const retry = deferred<CreateResponse>();
    createDocument.mockReturnValueOnce(failed.promise).mockReturnValueOnce(retry.promise);
    renderDashboard(undefined, []);

    fireEvent.click(screen.getByTestId("start-guided-doc"));
    expect(createDocument).toHaveBeenLastCalledWith({ template: "welcome" });
    await act(async () => {
      failed.reject(new ApiError(503, "Create service unavailable"));
      await Promise.allSettled([failed.promise]);
    });

    expect(screen.getByTestId("toast")).toHaveAttribute("data-kind", "error");
    expect(screen.getByTestId("toast")).toHaveTextContent("Create service unavailable");
    expect(screen.getByTestId("new-document")).toBeEnabled();
    expect(screen.getByTestId("start-guided-doc")).toBeEnabled();
    expect(screen.getByTestId("template-meeting-notes")).toBeEnabled();

    const retryButton = screen.getByTestId("template-meeting-notes");
    act(() => {
      retryButton.click();
      screen.getByTestId("new-document").click();
    });
    expect(createDocument).toHaveBeenCalledTimes(2);
    expect(createDocument).toHaveBeenLastCalledWith({ template: "meeting-notes" });

    await act(async () => {
      retry.resolve({ document: { id: "retry-created", title: "Meeting notes" } });
      await retry.promise;
    });

    expect(router.push).toHaveBeenCalledTimes(1);
    expect(router.push).toHaveBeenLastCalledWith("/d/retry-created");
    expect(console.error).toHaveBeenCalledTimes(1);
  });

  it("lets a replacement dashboard create while the old success and finalizer stay inert", async () => {
    const stale = deferred<CreateResponse>();
    const current = deferred<CreateResponse>();
    createDocument.mockReturnValueOnce(stale.promise).mockReturnValueOnce(current.promise);
    const view = render(<Dashboard user={USER} documents={DOCUMENTS} githubAvailable githubConfigured />);
    fireEvent.click(screen.getByTestId("new-document"));

    const replacementUser = { ...USER, id: "replacement-owner", login: "replacement-owner" };
    view.rerender(<Dashboard user={replacementUser} documents={DOCUMENTS} githubAvailable githubConfigured />);
    fireEvent.click(screen.getByTestId("new-document"));
    expect(createDocument).toHaveBeenCalledTimes(2);

    await act(async () => {
      stale.resolve({ document: { id: "stale-created", title: "Stale" } });
      await stale.promise;
    });
    expect(router.push).not.toHaveBeenCalled();
    expect(screen.getByTestId("new-document")).toBeDisabled();

    await act(async () => {
      current.resolve({ document: { id: "current-created", title: "Current" } });
      await current.promise;
    });
    expect(router.push).toHaveBeenCalledTimes(1);
    expect(router.push).toHaveBeenLastCalledWith("/d/current-created");
  });
});

describe("dashboard star recovery", () => {
  it("optimistically stars and unstars, disables the document while pending, and commits each response", async () => {
    const starring = deferred<{ starred: true }>();
    const unstarring = deferred<{ starred: false }>();
    starDocument.mockReturnValueOnce(starring.promise);
    unstarDocument.mockReturnValueOnce(unstarring.promise);
    renderDashboard();

    fireEvent.click(documentStar("Alpha planning"));

    expect(starDocument).toHaveBeenCalledOnce();
    expect(starDocument).toHaveBeenCalledWith("alpha-title");
    expect(documentStar("Alpha planning")).toHaveAttribute("aria-pressed", "true");
    expect(documentStar("Alpha planning")).toBeDisabled();
    expect(documentStar("Meeting notes")).toBeEnabled();

    await act(async () => {
      starring.resolve({ starred: true });
      await starring.promise;
    });
    expect(documentStar("Alpha planning")).toHaveAttribute("aria-pressed", "true");
    expect(documentStar("Alpha planning")).toBeEnabled();

    fireEvent.click(documentStar("Alpha planning"));

    expect(unstarDocument).toHaveBeenCalledOnce();
    expect(unstarDocument).toHaveBeenCalledWith("alpha-title");
    expect(documentStar("Alpha planning")).toHaveAttribute("aria-pressed", "false");
    expect(documentStar("Alpha planning")).toBeDisabled();

    await act(async () => {
      unstarring.resolve({ starred: false });
      await unstarring.promise;
    });
    expect(documentStar("Alpha planning")).toHaveAttribute("aria-pressed", "false");
    expect(documentStar("Alpha planning")).toBeEnabled();
  });

  it("suppresses synchronous duplicate activation across duplicate controls for one document", async () => {
    const pending = deferred<{ starred: false }>();
    unstarDocument.mockReturnValueOnce(pending.promise);
    renderDashboard(undefined, [{ ...doc("starred", "Starred document"), starred: true }]);
    const stripButton = within(screen.getByTestId("starred-strip")).getByRole("button", { name: "Unstar" });
    const listButton = documentStar("Starred document");

    act(() => {
      stripButton.click();
      listButton.click();
    });

    expect(unstarDocument).toHaveBeenCalledOnce();
    expect(unstarDocument).toHaveBeenCalledWith("starred");
    expect(starDocument).not.toHaveBeenCalled();
    expect(documentStar("Starred document")).toBeDisabled();

    await act(async () => {
      pending.resolve({ starred: false });
      await pending.promise;
    });
  });

  it("allows independent documents to mutate concurrently while keeping each document single-flight", async () => {
    const alpha = deferred<{ starred: true }>();
    const notes = deferred<{ starred: true }>();
    starDocument.mockReturnValueOnce(alpha.promise).mockReturnValueOnce(notes.promise);
    renderDashboard();

    fireEvent.click(documentStar("Alpha planning"));
    fireEvent.click(documentStar("Meeting notes"));

    expect(starDocument.mock.calls).toEqual([["alpha-title"], ["notes"]]);
    expect(documentStar("Alpha planning")).toBeDisabled();
    expect(documentStar("Meeting notes")).toBeDisabled();

    await act(async () => {
      alpha.resolve({ starred: true });
      await alpha.promise;
    });
    expect(documentStar("Alpha planning")).toBeEnabled();
    expect(documentStar("Meeting notes")).toBeDisabled();

    await act(async () => {
      notes.resolve({ starred: true });
      await notes.promise;
    });
    expect(documentStar("Meeting notes")).toBeEnabled();
  });

  it("rolls a failed toggle back with the API reason and retries the same action once", async () => {
    const first = deferred<{ starred: true }>();
    const retry = deferred<{ starred: true }>();
    starDocument.mockReturnValueOnce(first.promise).mockReturnValueOnce(retry.promise);
    renderDashboard();

    fireEvent.click(documentStar("Alpha planning"));
    expect(documentStar("Alpha planning")).toHaveAttribute("aria-pressed", "true");

    await act(async () => {
      first.reject(new ApiError(503, "Star service unavailable"));
      await Promise.allSettled([first.promise]);
    });

    expect(documentStar("Alpha planning")).toHaveAttribute("aria-pressed", "false");
    expect(documentStar("Alpha planning")).toBeEnabled();
    expect(screen.getByTestId("toast")).toHaveAttribute("data-kind", "error");
    expect(screen.getByTestId("toast")).toHaveTextContent("Star service unavailable");
    expect(console.error).not.toHaveBeenCalled();

    fireEvent.click(documentStar("Alpha planning"));

    expect(starDocument.mock.calls).toEqual([["alpha-title"], ["alpha-title"]]);
    expect(unstarDocument).not.toHaveBeenCalled();
    expect(documentStar("Alpha planning")).toHaveAttribute("aria-pressed", "true");
    expect(documentStar("Alpha planning")).toBeDisabled();

    await act(async () => {
      retry.resolve({ starred: true });
      await retry.promise;
    });
  });

  it("shares optimistic and pending state when a local match is replaced by the server result", async () => {
    const search = deferred<SearchResponse>();
    const starring = deferred<{ starred: true }>();
    searchDocuments.mockReturnValueOnce(search.promise);
    starDocument.mockReturnValueOnce(starring.promise);
    renderDashboard();
    const input = screen.getByRole("textbox", { name: "Search documents" });

    fireEvent.change(input, { target: { value: "alpha" } });
    fireEvent.click(documentStar("Alpha planning"));
    await settleSearch();

    await act(async () => {
      search.resolve({ query: "alpha", documents: [result("alpha-title", "Alpha planning", "Server alpha result")] });
      await search.promise;
    });

    expect(screen.getByTestId("search-snippet")).toHaveTextContent("Server alpha result");
    expect(documentStar("Alpha planning")).toHaveAttribute("aria-pressed", "true");
    expect(documentStar("Alpha planning")).toBeDisabled();
    fireEvent.click(documentStar("Alpha planning"));
    expect(starDocument).toHaveBeenCalledOnce();

    await act(async () => {
      starring.resolve({ starred: true });
      await starring.promise;
    });
    expect(documentStar("Alpha planning")).toBeEnabled();
  });

  it("isolates stale successes, errors, and finalizers after prop refresh removes and restores cards", async () => {
    const staleSuccess = deferred<{ starred: true }>();
    const staleError = deferred<{ starred: true }>();
    const currentAlpha = deferred<{ starred: true }>();
    const currentNotes = deferred<{ starred: true }>();
    starDocument
      .mockReturnValueOnce(staleSuccess.promise)
      .mockReturnValueOnce(staleError.promise)
      .mockReturnValueOnce(currentAlpha.promise)
      .mockReturnValueOnce(currentNotes.promise);
    const view = renderDashboard();

    fireEvent.click(documentStar("Alpha planning"));
    fireEvent.click(documentStar("Meeting notes"));
    view.rerender(<Dashboard user={USER} documents={[doc("alpha-title", "Alpha planning")]} githubAvailable githubConfigured />);
    expect(screen.queryByRole("link", { name: /Meeting notes/ })).toBeNull();
    view.rerender(<Dashboard user={USER} documents={DOCUMENTS.map((item) => ({ ...item }))} githubAvailable githubConfigured />);

    expect(documentStar("Alpha planning")).toHaveAttribute("aria-pressed", "false");
    expect(documentStar("Meeting notes")).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(documentStar("Alpha planning"));
    fireEvent.click(documentStar("Meeting notes"));

    await act(async () => {
      staleSuccess.resolve({ starred: true });
      staleError.reject(new ApiError(503, "Obsolete star failure"));
      await Promise.allSettled([staleSuccess.promise, staleError.promise]);
    });

    expect(documentStar("Alpha planning")).toHaveAttribute("aria-pressed", "true");
    expect(documentStar("Meeting notes")).toHaveAttribute("aria-pressed", "true");
    expect(documentStar("Alpha planning")).toBeDisabled();
    expect(documentStar("Meeting notes")).toBeDisabled();
    expect(screen.queryByText("Obsolete star failure")).toBeNull();
    expect(console.error).not.toHaveBeenCalled();

    await act(async () => {
      currentAlpha.resolve({ starred: true });
      currentNotes.resolve({ starred: true });
      await Promise.all([currentAlpha.promise, currentNotes.promise]);
    });
  });

  it("ignores a pending mutation after unmount", async () => {
    const pending = deferred<{ starred: true }>();
    starDocument.mockReturnValueOnce(pending.promise);
    const view = renderDashboard();
    fireEvent.click(documentStar("Alpha planning"));

    view.unmount();
    await act(async () => {
      pending.reject(new ApiError(503, "Unmounted star failure"));
      await Promise.allSettled([pending.promise]);
    });

    expect(console.error).not.toHaveBeenCalled();
  });
});

describe("dashboard trash recovery", () => {
  it("keeps the first load pending, then announces the API reason without false empty copy", async () => {
    const initial = deferred<ListResponse>();
    listDocuments.mockReturnValueOnce(initial.promise);
    renderDashboard();

    openTrash();
    expect(screen.getByText("Loading trash…")).toBeInTheDocument();
    expect(screen.queryByText("The trash is empty")).toBeNull();

    await act(async () => {
      initial.reject(new ApiError(503, "Trash service unavailable"));
      await Promise.allSettled([initial.promise]);
    });

    const alert = screen.getByRole("alert");
    expect(alert).toHaveAttribute("aria-atomic", "true");
    expect(alert).toHaveTextContent("Trash service unavailable");
    expect(within(alert).getByRole("button", { name: "Retry" })).toBeEnabled();
    expect(screen.queryByText("Loading trash…")).toBeNull();
    expect(screen.queryByText("The trash is empty")).toBeNull();
    expect(listDocuments).toHaveBeenCalledTimes(1);
    expect(listDocuments).toHaveBeenLastCalledWith({ trash: true });
  });

  it("guards one pending Retry and recovers to both successful empty and populated states", async () => {
    const retry = deferred<ListResponse>();
    listDocuments
      .mockRejectedValueOnce(new ApiError(503, "Trash service unavailable"))
      .mockReturnValueOnce(retry.promise)
      .mockResolvedValueOnce({ documents: [trashedDoc("restored-list", "Recovered document")] });
    renderDashboard();
    openTrash();
    await act(async () => {});

    const retryButton = within(screen.getByRole("alert")).getByRole("button", { name: "Retry" });
    fireEvent.click(retryButton);
    fireEvent.click(retryButton);

    expect(listDocuments).toHaveBeenCalledTimes(2);
    expect(listDocuments.mock.calls[1]?.[0]).toEqual({ trash: true });
    expect(screen.getByTestId("trash-view")).toHaveAttribute("aria-busy", "true");
    expect(within(screen.getByRole("alert")).getByRole("button", { name: "Retrying…" })).toBeDisabled();

    await act(async () => {
      retry.resolve({ documents: [] });
      await retry.promise;
    });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("The trash is empty")).toBeInTheDocument();

    leaveTrash();
    openTrash();
    await act(async () => {});
    expect(listDocuments).toHaveBeenCalledTimes(3);
    expect(screen.queryByText("The trash is empty")).toBeNull();
    expect(screen.getByText("Recovered document")).toBeInTheDocument();
  });

  it("keeps cached rows visible below a retryable refresh failure", async () => {
    listDocuments
      .mockResolvedValueOnce({ documents: [trashedDoc("cached", "Cached trash row")] })
      .mockRejectedValueOnce(new ApiError(503, "Refresh failed"));
    renderDashboard();
    openTrash();
    await act(async () => {});
    expect(screen.getByText("Cached trash row")).toBeInTheDocument();

    leaveTrash();
    openTrash();
    await act(async () => {});

    const alert = screen.getByRole("alert");
    const list = screen.getByTestId("trash-list");
    expect(alert).toHaveTextContent("Refresh failed");
    expect(within(alert).getByRole("button", { name: "Retry" })).toBeEnabled();
    expect(screen.getByText("Cached trash row")).toBeInTheDocument();
    expect(alert.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("isolates late rows and errors from earlier visits after leaving and re-entering Trash", async () => {
    const staleRows = deferred<ListResponse>();
    const staleError = deferred<ListResponse>();
    const current = deferred<ListResponse>();
    listDocuments
      .mockReturnValueOnce(staleRows.promise)
      .mockReturnValueOnce(staleError.promise)
      .mockReturnValueOnce(current.promise);
    renderDashboard();

    openTrash();
    leaveTrash();
    openTrash();
    leaveTrash();
    openTrash();
    expect(listDocuments).toHaveBeenCalledTimes(3);

    await act(async () => {
      current.resolve({ documents: [trashedDoc("current", "Current trash row")] });
      await current.promise;
    });
    await act(async () => {
      staleRows.resolve({ documents: [trashedDoc("stale", "Stale trash row")] });
      staleError.reject(new ApiError(503, "Stale visit failure"));
      await Promise.allSettled([staleRows.promise, staleError.promise]);
    });

    expect(screen.getByText("Current trash row")).toBeInTheDocument();
    expect(screen.queryByText("Stale trash row")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("owns two immediate Restore activations and commits the exact row once", async () => {
    const pending = deferred<{ ok: true }>();
    restoreDocument.mockReturnValueOnce(pending.promise);
    listDocuments.mockResolvedValueOnce({ documents: [trashedDoc("restore-me", "Restore me"), trashedDoc("keep-me", "Keep me")] });
    renderDashboard();
    openTrash();
    await act(async () => {});
    const restore = trashButton("Restore me", "restore-button");

    act(() => {
      restore.click();
      restore.click();
    });

    expect(restoreDocument).toHaveBeenCalledTimes(1);
    expect(restoreDocument).toHaveBeenLastCalledWith("restore-me");
    expect(trashButton("Keep me", "restore-button")).toBeDisabled();

    await act(async () => {
      pending.resolve({ ok: true });
      await pending.promise;
    });

    expect(screen.queryByText("Restore me")).toBeNull();
    expect(screen.getByText("Keep me")).toBeInTheDocument();
    expect(screen.getByTestId("toast")).toHaveTextContent("“Restore me” was restored.");
    expect(screen.getByTestId("toast")).toHaveAttribute("data-kind", "success");
    expect(router.refresh).toHaveBeenCalledTimes(1);
  });

  it("declines Delete without ownership, then keeps confirmed failure and retry single-owner", async () => {
    const failed = deferred<{ ok: true; permanent: boolean }>();
    const retry = deferred<{ ok: true; permanent: boolean }>();
    purgeDocument.mockReturnValueOnce(failed.promise).mockReturnValueOnce(retry.promise);
    const confirmDelete = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValue(true);
    listDocuments.mockResolvedValueOnce({ documents: [trashedDoc("purge-me", "Purge me"), trashedDoc("keep-me", "Keep me")] });
    renderDashboard();
    openTrash();
    await act(async () => {});
    const purge = trashButton("Purge me", "purge-button");

    fireEvent.click(purge);
    expect(confirmDelete).toHaveBeenCalledTimes(1);
    expect(purgeDocument).not.toHaveBeenCalled();
    expect(purge).toBeEnabled();

    fireEvent.click(purge);
    expect(confirmDelete).toHaveBeenCalledTimes(2);
    expect(purgeDocument).toHaveBeenCalledTimes(1);
    expect(purgeDocument).toHaveBeenLastCalledWith("purge-me", { permanent: true });
    await act(async () => {
      failed.reject(new ApiError(503, "Delete service unavailable"));
      await Promise.allSettled([failed.promise]);
    });

    expect(screen.getByTestId("toast")).toHaveTextContent("Delete service unavailable");
    expect(purge).toBeEnabled();
    act(() => {
      purge.click();
      purge.click();
    });
    expect(confirmDelete).toHaveBeenCalledTimes(3);
    expect(purgeDocument).toHaveBeenCalledTimes(2);

    await act(async () => {
      retry.resolve({ ok: true, permanent: true });
      await retry.promise;
    });

    expect(screen.queryByText("Purge me")).toBeNull();
    expect(screen.getByText("Keep me")).toBeInTheDocument();
    expect(router.refresh).not.toHaveBeenCalled();
  });

  it("lets a re-entered visit fail while an older success and finalizer stay inert", async () => {
    const staleSuccess = deferred<{ ok: true }>();
    const currentFailure = deferred<{ ok: true }>();
    const currentList = deferred<ListResponse>();
    restoreDocument.mockReturnValueOnce(staleSuccess.promise).mockReturnValueOnce(currentFailure.promise);
    listDocuments.mockResolvedValueOnce({ documents: [trashedDoc("same-row", "Same row")] }).mockReturnValueOnce(currentList.promise);
    renderDashboard();
    openTrash();
    await act(async () => {});

    fireEvent.click(trashButton("Same row", "restore-button"));
    leaveTrash();
    openTrash();
    fireEvent.click(trashButton("Same row", "restore-button"));
    expect(restoreDocument).toHaveBeenCalledTimes(2);

    await act(async () => {
      staleSuccess.resolve({ ok: true });
      await staleSuccess.promise;
    });
    expect(screen.getByText("Same row")).toBeInTheDocument();
    expect(screen.queryByTestId("toast")).toBeNull();
    expect(router.refresh).not.toHaveBeenCalled();
    expect(trashButton("Same row", "restore-button")).toBeDisabled();

    await act(async () => {
      currentFailure.reject(new ApiError(503, "Current restore failed"));
      await Promise.allSettled([currentFailure.promise]);
    });
    expect(screen.getByText("Same row")).toBeInTheDocument();
    expect(screen.getByTestId("toast")).toHaveTextContent("Current restore failed");
    expect(trashButton("Same row", "restore-button")).toBeEnabled();
    expect(router.refresh).not.toHaveBeenCalled();

    await act(async () => {
      currentList.resolve({ documents: [trashedDoc("same-row", "Stale list row")] });
      await currentList.promise;
    });
    expect(screen.getByText("Same row")).toBeInTheDocument();
    expect(screen.queryByText("Stale list row")).toBeNull();
  });

  it("lets current Restore win before an older failure without stale notice, refresh, or finalizer work", async () => {
    const staleFailure = deferred<{ ok: true }>();
    const currentSuccess = deferred<{ ok: true }>();
    const currentList = deferred<ListResponse>();
    restoreDocument.mockReturnValueOnce(staleFailure.promise).mockReturnValueOnce(currentSuccess.promise);
    listDocuments.mockResolvedValueOnce({ documents: [trashedDoc("same-row", "Same row"), trashedDoc("keep-me", "Keep me")] }).mockReturnValueOnce(currentList.promise);
    renderDashboard();
    openTrash();
    await act(async () => {});

    fireEvent.click(trashButton("Same row", "restore-button"));
    leaveTrash();
    openTrash();
    fireEvent.click(trashButton("Same row", "restore-button"));

    await act(async () => {
      currentSuccess.resolve({ ok: true });
      await currentSuccess.promise;
    });
    expect(screen.queryByText("Same row")).toBeNull();
    expect(screen.getByText("Keep me")).toBeInTheDocument();
    expect(screen.getByTestId("toast")).toHaveTextContent("“Same row” was restored.");
    expect(router.refresh).toHaveBeenCalledTimes(1);

    await act(async () => {
      staleFailure.reject(new ApiError(503, "Obsolete restore failed"));
      await Promise.allSettled([staleFailure.promise]);
      currentList.resolve({ documents: [trashedDoc("same-row", "Reintroduced row"), trashedDoc("keep-me", "Keep me")] });
      await currentList.promise;
    });
    expect(screen.queryByText("Reintroduced row")).toBeNull();
    expect(screen.getByTestId("toast")).toHaveTextContent("“Same row” was restored.");
    expect(router.refresh).toHaveBeenCalledTimes(1);
    expect(console.error).not.toHaveBeenCalled();
  });

  it("retires a pending list at the successful action boundary so it cannot reintroduce the row", async () => {
    const refresh = deferred<ListResponse>();
    const deletion = deferred<{ ok: true; permanent: boolean }>();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    listDocuments.mockResolvedValueOnce({ documents: [trashedDoc("pending-row", "Pending row")] }).mockReturnValueOnce(refresh.promise);
    purgeDocument.mockReturnValueOnce(deletion.promise);
    renderDashboard();
    openTrash();
    await act(async () => {});
    leaveTrash();
    openTrash();
    expect(screen.getByTestId("trash-view")).toHaveAttribute("aria-busy", "true");

    fireEvent.click(trashButton("Pending row", "purge-button"));
    expect(screen.getByTestId("trash-view")).not.toHaveAttribute("aria-busy");
    await act(async () => {
      deletion.resolve({ ok: true, permanent: true });
      await deletion.promise;
    });
    expect(screen.queryByText("Pending row")).toBeNull();

    await act(async () => {
      refresh.resolve({ documents: [trashedDoc("pending-row", "Reintroduced row")] });
      await refresh.promise;
    });
    expect(screen.queryByText("Reintroduced row")).toBeNull();
    expect(screen.getByText("The trash is empty")).toBeInTheDocument();
    expect(purgeDocument).toHaveBeenCalledTimes(1);
    expect(router.refresh).not.toHaveBeenCalled();
  });

  it("invalidates an action whose target disappears on a later visit", async () => {
    const stale = deferred<{ ok: true }>();
    restoreDocument.mockReturnValueOnce(stale.promise);
    listDocuments.mockResolvedValueOnce({ documents: [trashedDoc("removed-row", "Removed row")] }).mockResolvedValueOnce({ documents: [] });
    renderDashboard();
    openTrash();
    await act(async () => {});
    fireEvent.click(trashButton("Removed row", "restore-button"));

    leaveTrash();
    openTrash();
    await act(async () => {});
    expect(screen.getByText("The trash is empty")).toBeInTheDocument();

    await act(async () => {
      stale.reject(new ApiError(503, "Removed target failed"));
      await Promise.allSettled([stale.promise]);
    });
    expect(screen.getByText("The trash is empty")).toBeInTheDocument();
    expect(screen.queryByTestId("toast")).toBeNull();
    expect(router.refresh).not.toHaveBeenCalled();
    expect(console.error).not.toHaveBeenCalled();
  });

  it("ignores pending Create and Restore work after unmount", async () => {
    const create = deferred<CreateResponse>();
    const restore = deferred<{ ok: true }>();
    createDocument.mockReturnValueOnce(create.promise);
    restoreDocument.mockReturnValueOnce(restore.promise);
    listDocuments.mockResolvedValueOnce({ documents: [trashedDoc("unmounted-row", "Unmounted row")] });
    const view = renderDashboard();
    fireEvent.click(screen.getByTestId("new-document"));
    openTrash();
    await act(async () => {});
    fireEvent.click(trashButton("Unmounted row", "restore-button"));

    view.unmount();
    await act(async () => {
      create.reject(new ApiError(503, "Unmounted create failed"));
      restore.reject(new ApiError(503, "Unmounted restore failed"));
      await Promise.allSettled([create.promise, restore.promise]);
    });

    expect(router.push).not.toHaveBeenCalled();
    expect(router.refresh).not.toHaveBeenCalled();
    expect(console.error).not.toHaveBeenCalled();
  });

  it("retires pending Restore and Delete ownership at the layout unmount boundary", async () => {
    vi.useRealTimers();
    const restore = deferred<{ ok: true }>();
    const deletion = deferred<{ ok: true; permanent: boolean }>();
    const unhandled: unknown[] = [];
    const onUnhandled = (event: PromiseRejectionEvent) => {
      unhandled.push(event.reason);
      event.preventDefault();
    };
    window.addEventListener("unhandledrejection", onUnhandled);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    restoreDocument.mockReturnValueOnce(restore.promise);
    purgeDocument.mockReturnValueOnce(deletion.promise);
    listDocuments
      .mockResolvedValueOnce({ documents: [trashedDoc("restore-boundary", "Restore boundary")] })
      .mockResolvedValueOnce({ documents: [trashedDoc("delete-boundary", "Delete boundary")] });

    const unmountAndSettle = async (
      title: string,
      action: "restore-button" | "purge-button",
      settle: () => void,
      pending: Promise<unknown>,
    ) => {
      const view = render(
        <TransitionUnmount>
          <Dashboard user={USER} documents={DOCUMENTS} githubAvailable githubConfigured />
        </TransitionUnmount>,
      );
      openTrash();
      await act(async () => {});
      fireEvent.click(trashButton(title, action));
      const removed = deferred<void>();
      const settled = Promise.allSettled([pending]);
      let settledAtRemoval = false;
      let postRemovalMutations = 0;
      const observer = new MutationObserver((records) => {
        if (document.querySelector('[data-testid="trash-view"]')) return;
        if (!settledAtRemoval) {
          settledAtRemoval = true;
          settle();
          removed.resolve();
          return;
        }
        postRemovalMutations += records.length;
      });
      observer.observe(document.body, { childList: true, subtree: true });
      const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
      const previousActEnvironment = actEnvironment.IS_REACT_ACT_ENVIRONMENT;
      actEnvironment.IS_REACT_ACT_ENVIRONMENT = false;

      try {
        screen.getByTestId("unmount-dashboard").click();
        await removed.promise;
        await settled;
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(screen.queryByTestId("trash-view")).toBeNull();
        expect(screen.queryByTestId("trash-card")).toBeNull();
        expect(screen.queryByTestId("toast")).toBeNull();
        return postRemovalMutations;
      } finally {
        actEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
        observer.disconnect();
        view.unmount();
      }
    };

    try {
      const restoreMutations = await unmountAndSettle("Restore boundary", "restore-button", () => restore.resolve({ ok: true }), restore.promise);
      const deleteMutations = await unmountAndSettle(
        "Delete boundary",
        "purge-button",
        () => deletion.reject(new ApiError(503, "Unmounted delete failed")),
        deletion.promise,
      );

      expect(restoreDocument).toHaveBeenCalledTimes(1);
      expect(restoreDocument).toHaveBeenLastCalledWith("restore-boundary");
      expect(purgeDocument).toHaveBeenCalledTimes(1);
      expect(purgeDocument).toHaveBeenLastCalledWith("delete-boundary", { permanent: true });
      expect(restoreMutations + deleteMutations).toBe(0);
      expect(router.refresh).not.toHaveBeenCalled();
      expect(router.push).not.toHaveBeenCalled();
      expect(console.error).not.toHaveBeenCalled();
      expect(unhandled).toEqual([]);
    } finally {
      window.removeEventListener("unhandledrejection", onUnhandled);
    }
  });
});
