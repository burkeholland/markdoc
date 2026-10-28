// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import {
  StrictMode,
  useEffect,
  useLayoutEffect,
  type ComponentProps,
} from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { compile } from "tailwindcss";
import type { CollabSession } from "@/editor/collab/session";
import type { ActivityItemDto, ActivityPageDto } from "@/lib/api";
import { formatDateTime, formatDayHeading } from "@/lib/utils";

const activity = vi.fn();
const unhandledRejections: unknown[] = [];
const recordUnhandledRejection = (reason: unknown) => {
  unhandledRejections.push(reason);
};

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  api: {
    documents: {
      activity: (...args: unknown[]) => activity(...args),
    },
  },
}));

import { ActivityPanel } from "./activity-panel";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function session(docId: string): CollabSession {
  return { docId } as unknown as CollabSession;
}

function ActivityBoundary({
  documentId,
  present = true,
  boundary = 0,
  onBoundary,
}: {
  documentId: string;
  present?: boolean;
  boundary?: number;
  onBoundary?: () => void;
}) {
  useLayoutEffect(() => {
    if (boundary > 0) onBoundary?.();
  }, [boundary, onBoundary]);
  return present ? <ActivityPanel session={session(documentId)} onClose={() => {}} /> : null;
}

function ActivityVisitBoundary({
  session,
  onClose,
  present = true,
  instance = "activity",
  boundary = 0,
  onBoundary,
  onPassiveCleanup,
}: {
  session: CollabSession;
  onClose: () => void;
  present?: boolean;
  instance?: string;
  boundary?: number;
  onBoundary?: () => void;
  onPassiveCleanup?: () => void;
}) {
  useLayoutEffect(() => {
    if (boundary > 0) onBoundary?.();
  }, [boundary, onBoundary]);
  return present ? (
    <ActivityMount
      key={instance}
      session={session}
      onClose={onClose}
      onPassiveCleanup={onPassiveCleanup}
    />
  ) : null;
}

function ActivityMount({
  session,
  onClose,
  onPassiveCleanup,
}: {
  session: CollabSession;
  onClose: () => void;
  onPassiveCleanup?: () => void;
}) {
  useEffect(() => onPassiveCleanup, [onPassiveCleanup]);
  return <ActivityPanel session={session} onClose={onClose} />;
}

/** jsdom keeps event trust in an internal slot; a genuine keydown is trusted before dispatch. */
function markActivityEventTrusted(event: Event) {
  const implementation = Object.getOwnPropertySymbols(event)
    .map((symbol) => (event as unknown as Record<symbol, unknown>)[symbol])
    .find(
      (candidate): candidate is { isTrusted: boolean } =>
        typeof candidate === "object" &&
        candidate !== null &&
        "isTrusted" in candidate &&
        candidate.isTrusted === false,
    );
  const descriptor = implementation
    ? Object.getOwnPropertyDescriptor(implementation, "isTrusted")
    : undefined;
  if (!implementation || !descriptor?.writable) {
    throw new Error("Unable to set jsdom's internal Activity event trust slot");
  }
  Object.defineProperty(implementation, "isTrusted", {
    configurable: true,
    enumerable: true,
    get: () => true,
    set: () => undefined,
  });
  if (!event.isTrusted) throw new Error("The Activity event trust slot did not update");
}

function setActivityEventView(event: KeyboardEvent, view: Window) {
  const implementation = Object.getOwnPropertySymbols(event)
    .map((symbol) => (event as unknown as Record<symbol, unknown>)[symbol])
    .find(
      (candidate): candidate is { view: Window | null } =>
        typeof candidate === "object" &&
        candidate !== null &&
        "view" in candidate,
    );
  if (!implementation) {
    throw new Error("Unable to set jsdom's internal Activity event view slot");
  }
  implementation.view = view;
}

function activityKeyboardEvent(
  element: HTMLElement,
  key: string,
  init: Omit<KeyboardEventInit, "key"> = {},
  trusted = true,
) {
  const ownerWindow = element.ownerDocument.defaultView;
  if (!ownerWindow) throw new Error("The Activity header control has no owner window");
  const event = new ownerWindow.KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
    ...init,
  });
  if (trusted) markActivityEventTrusted(event);
  return event;
}

function activityKey(
  element: HTMLElement,
  key: string,
  init: Omit<KeyboardEventInit, "key"> = {},
) {
  const event = activityKeyboardEvent(element, key, init);
  act(() => {
    element.dispatchEvent(event);
  });
  return event;
}

function headerControl(
  name: "Refresh activity" | "Refreshing activity" | "Close activity",
) {
  const element = screen.getByRole("button", { name });
  if (!(element instanceof HTMLButtonElement)) {
    throw new Error(`Expected ${name} to be a header button`);
  }
  return element;
}

function activityPanel() {
  return screen.getByTestId("activity-panel");
}

function activityHeader() {
  const header = activityPanel().firstElementChild;
  if (!(header instanceof HTMLElement)) throw new Error("Activity has no header");
  return header;
}

function headerPage(id = "header"): ActivityPageDto {
  return { items: [row(id, `${id} editor`)], nextBefore: null };
}

const directRoots = new Set<Root>();


function createStrictActivity(
  props: ComponentProps<typeof ActivityVisitBoundary>,
) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  directRoots.add(root);
  act(() =>
    root.render(
      <StrictMode>
        <ActivityVisitBoundary {...props} />
      </StrictMode>,
    ),
  );
  return { host, root };
}

function row(id: string, actorName: string): ActivityItemDto {
  return {
    id,
    actorId: `user-${id}`,
    actorName,
    actorKind: "user",
    action: "edit",
    detail: {},
    createdAt: "2026-09-01T09:00:00.000Z",
  };
}

/** A settled direct-root Strict Mode Activity panel, with whatever `activity` was mocked to answer. */
async function mountHeaderView(docId: string, onClose: () => void = vi.fn()) {
  const collab = session(docId);
  const view = createStrictActivity({ session: collab, onClose });
  await act(async () => {});
  return { ...view, onClose, session: collab };
}

beforeEach(() => {
  activity.mockReset();
  unhandledRejections.length = 0;
  process.on("unhandledRejection", recordUnhandledRejection);
});

afterEach(async () => {
  cleanup();
  for (const root of directRoots) act(() => root.unmount());
  directRoots.clear();
  document.body.replaceChildren();
  await Promise.resolve();
  process.off("unhandledRejection", recordUnhandledRejection);
  vi.clearAllTimers();
  vi.restoreAllMocks();
  vi.useRealTimers();
  expect(unhandledRejections).toEqual([]);
});

describe("ActivityPanel text wrapping", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-08T12:05:00.000Z"));
  });

  afterEach(() => {
    // Restore timer spies before the outer cleanup switches back to real timers.
    vi.restoreAllMocks();
  });

  function observeInspection(onClose: () => void) {
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const click = vi.spyOn(HTMLElement.prototype, "click");
    const timeout = vi.spyOn(globalThis, "setTimeout");
    const interval = vi.spyOn(globalThis, "setInterval");
    const counts = () => [
      activity.mock.calls.length,
      focus.mock.calls.length,
      click.mock.calls.length,
      timeout.mock.calls.length,
      interval.mock.calls.length,
      vi.getTimerCount(),
    ];
    return (inspect: () => void) => {
      const before = counts();
      const focused = document.activeElement;
      const markup = activityPanel().innerHTML;
      inspect();
      expect(counts()).toEqual(before);
      expect(document.activeElement).toBe(focused);
      expect(activityPanel().innerHTML).toBe(markup);
      expect(onClose).not.toHaveBeenCalled();
    };
  }

  function expectWrappedRows(
    items: ActivityItemDto[],
    descriptions: string[],
    timestamps: string[],
  ) {
    const rows = screen.getAllByTestId("activity-row");
    expect(rows).toHaveLength(items.length);
    expect(activityPanel()).toHaveClass("w-[340px]", "shrink-0");
    expect(screen.queryAllByTestId("activity-agent-chip")).toHaveLength(
      items.filter((item) => item.actorKind === "agent").length,
    );

    for (const [index, item] of items.entries()) {
      const renderedRow = rows[index];
      const name = within(renderedRow).getByText(item.actorName, { exact: true });
      const description = within(renderedRow).getByText(descriptions[index], { exact: true });
      expect(renderedRow.tagName).toBe("LI");
      expect(renderedRow).toHaveAttribute("data-action", item.action);
      expect(renderedRow).toHaveAttribute("data-actor-kind", item.actorKind);
      expect(renderedRow).toHaveClass("flex", "items-start", "gap-2.5");
      expect(name).toHaveClass("wrap-anywhere", "font-medium", "text-ink");
      expect(description).toHaveClass("wrap-anywhere");
      expect(name.parentElement).toBe(description.parentElement);
      expect(name.parentElement).toHaveClass("flex", "flex-wrap");
      expect(name.parentElement?.parentElement).toHaveClass("min-w-0", "flex-1");
      for (const [element, text] of [[name, item.actorName], [description, descriptions[index]]] as const) {
        expect(element.textContent).toBe(text);
        expect(element.childElementCount).toBe(0);
        expect(element).not.toHaveClass("break-words", "break-all", "truncate", "overflow-hidden", "whitespace-nowrap");
      }
      expect(renderedRow.querySelectorAll("script, img, br, wbr")).toHaveLength(0);

      const avatar = renderedRow.firstElementChild;
      const chips = within(renderedRow).queryAllByTestId("activity-agent-chip");
      if (item.actorKind === "agent") {
        expect(avatar).toHaveAttribute("title", `${item.actorName} (agent)`);
        expect(avatar).toHaveClass("h-7", "w-7", "shrink-0");
        expect(chips).toHaveLength(1);
        expect(chips[0].textContent).toBe("agent");
        expect(chips[0]).toBe(name.nextElementSibling);
        expect(chips[0].nextElementSibling).toBe(description);
      } else {
        expect(avatar).toHaveAttribute("title", item.actorName);
        expect(avatar).toHaveStyle({ width: "28px", height: "28px" });
        expect(chips).toHaveLength(0);
        expect(name.nextElementSibling).toBe(description);
      }
      const time = renderedRow.querySelector("time");
      expect(time).toHaveAttribute("datetime", item.createdAt);
      expect(time).toHaveAttribute("title", formatDateTime(item.createdAt));
      expect(time?.textContent).toBe(timestamps[index]);
    }

    const days = [...new Set(items.map((item) => formatDayHeading(item.createdAt)))];
    const lists = within(activityPanel()).getAllByRole("list");
    expect(lists).toHaveLength(days.length);
    for (const [index, day] of days.entries()) {
      expect(lists[index].previousElementSibling?.textContent).toBe(day);
      expect(lists[index].children).toHaveLength(
        items.filter((item) => formatDayHeading(item.createdAt) === day).length,
      );
    }
    const refresh = screen.getByRole("button", { name: "Refresh activity" });
    const close = screen.getByRole("button", { name: "Close activity" });
    expect(refresh).toBeEnabled();
    expect(close).toBeEnabled();
    expect(refresh.nextElementSibling).toBe(close);
  }

  it.each([
    { label: "unbroken", human: "H".repeat(240), agent: "A".repeat(240), quote: "Q".repeat(240) },
    { label: "multiword", human: "Human Editor", agent: "Review Agent", quote: "an ordinary multiword comment" },
    { label: "literal markup", human: 'Human<em>&"\'</em>', agent: 'Agent<img>&"\'', quote: '<script>alert("quoted")</script>&<br><wbr>\'literal\'' },
  ])("preserves full $label names and descriptions with wrapping classes", async ({ label, human, agent, quote }) => {
    const items: ActivityItemDto[] = [
      { ...row("human", human), action: "comment.add", detail: { quote }, createdAt: "2026-09-08T12:04:00.000Z" },
      { ...row("agent", agent), actorKind: "agent", createdAt: "2026-09-07T12:05:00.000Z" },
    ];
    if (label === "unbroken") {
      for (const text of [human, agent, quote]) {
        expect(text.length).toBeGreaterThanOrEqual(200);
        expect(text).not.toMatch(/\s/);
      }
    }
    const onClose = vi.fn();
    const inspect = observeInspection(onClose);
    activity.mockResolvedValueOnce({ items, nextBefore: "older" });
    render(<ActivityPanel session={session(`wrapping-${label}`)} onClose={onClose} />);
    await act(async () => {});

    inspect(() => {
      expectWrappedRows(items, [`commented: \u201c${quote}\u201d`, "edited the document"], ["1 minute ago", "yesterday"]);
      expect(screen.getByRole("button", { name: "Load more" })).toBeEnabled();
      expect(screen.getByTestId("activity-load-more")).toHaveClass("w-full");
    });
    expect(activity).toHaveBeenCalledExactlyOnceWith(`wrapping-${label}`, { limit: 50 });
  });

  it("keeps wrapping through append and refresh, then discards old rows and pending work on replacement", async () => {
    const human = { ...row("human", "H".repeat(240)), createdAt: "2026-09-08T12:04:00.000Z" };
    const quote = "Q".repeat(240);
    const agent: ActivityItemDto = {
      ...row("agent", "A".repeat(240)), actorKind: "agent", action: "comment.add",
      detail: { quote }, createdAt: "2026-09-07T12:05:00.000Z",
    };
    const ordinary = { ...row("ordinary", "Current Human Editor"), createdAt: "2026-09-08T12:05:00.000Z" };
    const replacement: ActivityItemDto = { ...human, id: "replacement", actorName: "R".repeat(240), action: "comment.reply", detail: { quote } };
    const appended = deferred<ActivityPageDto>();
    const refreshed = deferred<ActivityPageDto>();
    const stalePage = deferred<ActivityPageDto>();
    const currentPage = deferred<ActivityPageDto>();
    activity
      .mockResolvedValueOnce({ items: [human], nextBefore: "older" })
      .mockReturnValueOnce(appended.promise)
      .mockReturnValueOnce(refreshed.promise)
      .mockReturnValueOnce(stalePage.promise)
      .mockReturnValueOnce(currentPage.promise);
    const onClose = vi.fn();
    const inspect = observeInspection(onClose);
    const rendered = render(<ActivityPanel session={session("wrapping-old")} onClose={onClose} />);
    await act(async () => {});
    inspect(() => expectWrappedRows([human], ["edited the document"], ["1 minute ago"]));

    const loadMore = screen.getByRole("button", { name: "Load more" });
    fireEvent.click(loadMore);
    fireEvent.click(loadMore);
    expect(activity).toHaveBeenCalledTimes(2);
    expect(activity).toHaveBeenLastCalledWith("wrapping-old", { before: "older", limit: 50 });
    expect(loadMore).toBeDisabled();
    appended.resolve({ items: [agent, human], nextBefore: "oldest" });
    await act(async () => {});
    inspect(() => expectWrappedRows(
      [human, agent], ["edited the document", `commented: \u201c${quote}\u201d`], ["1 minute ago", "yesterday"],
    ));

    const refresh = screen.getByRole("button", { name: "Refresh activity" });
    fireEvent.click(refresh);
    fireEvent.click(refresh);
    expect(activity).toHaveBeenCalledTimes(3);
    expect(activity).toHaveBeenLastCalledWith("wrapping-old", { limit: 50 });
    expect(refresh).toBeDisabled();
    refreshed.resolve({ items: [ordinary, human], nextBefore: "ignored-refresh-cursor" });
    await act(async () => {});
    inspect(() => expectWrappedRows(
      [ordinary, human, agent], ["edited the document", "edited the document", `commented: \u201c${quote}\u201d`],
      ["just now", "1 minute ago", "yesterday"],
    ));

    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    expect(activity).toHaveBeenCalledTimes(4);
    expect(activity).toHaveBeenLastCalledWith("wrapping-old", { before: "oldest", limit: 50 });
    rendered.rerender(<ActivityPanel session={session("wrapping-current")} onClose={onClose} />);
    expect(activity).toHaveBeenCalledTimes(5);
    expect(activity).toHaveBeenLastCalledWith("wrapping-current", { limit: 50 });
    expect(screen.queryAllByTestId("activity-row")).toHaveLength(0);
    currentPage.resolve({ items: [replacement], nextBefore: null });
    await act(async () => {});
    stalePage.resolve({ items: [human, agent], nextBefore: "stale-cursor" });
    await act(async () => {});
    inspect(() => {
      expectWrappedRows([replacement], [`replied: \u201c${quote}\u201d`], ["1 minute ago"]);
      expect(screen.queryByText(human.actorName)).toBeNull();
      expect(screen.queryByText(agent.actorName)).toBeNull();
      expect(screen.queryByText(ordinary.actorName)).toBeNull();
      expect(screen.queryByTestId("activity-load-more")).toBeNull();
    });

    const close = screen.getByRole("button", { name: "Close activity" });
    fireEvent.click(close);
    fireEvent.click(close);
    expect(onClose).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(activity).toHaveBeenCalledTimes(5);
  });

  it("emits overflow-wrap anywhere and the existing flex width constraints from installed Tailwind", async () => {
    const theme = readFileSync(createRequire(import.meta.url).resolve("tailwindcss/theme.css"), "utf8");
    const { build } = await compile(`${theme}\n@tailwind utilities;`);
    const css = build(["wrap-anywhere", "flex-wrap", "min-w-0", "flex-1"]);
    expect(css).toMatch(/\.wrap-anywhere\s*\{\s*overflow-wrap:\s*anywhere;\s*\}/);
    expect(css).toMatch(/\.flex-wrap\s*\{\s*flex-wrap:\s*wrap;\s*\}/);
    expect(css).toMatch(/\.min-w-0\s*\{\s*min-width:\s*0px;\s*\}/);
    expect(css).toMatch(/\.flex-1\s*\{\s*flex:\s*1;\s*\}/);
  });

  const errorMessages = [
    { label: "unbroken", message: "E".repeat(260) },
    { label: "ordinary", message: "Activity is temporarily unavailable. Please try again." },
    { label: "literal HTML and whitespace", message: ' \t<em>offline</em>  <script>alert("error")</script>\n<img src="x"><br><wbr>& "reason"\t ' },
  ];

  function expectWrappedError(surface: "list" | "page", text: string) {
    const panel = activityPanel();
    const scroll = panel.children.item(1);
    const content = scroll?.firstElementChild;
    const message = within(panel).getByText(text, { exact: true, normalizer: (value) => value });
    const errorClasses = "mb-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-danger dark:bg-red-950/40";
    expect(panel.className).toBe("flex w-[340px] shrink-0 flex-col border-l border-line bg-surface-2");
    expect(panel.children).toHaveLength(2);
    expect(scroll?.className).toBe("scrollbar-thin flex-1 overflow-y-auto p-3");
    expect(scroll?.children).toHaveLength(1);
    expect(content?.tagName).toBe("DIV");
    expect(content?.getAttributeNames()).toEqual([]);
    expect(message.tagName).toBe("DIV");
    expect(message.textContent).toBe(text);
    expect(message.childNodes).toHaveLength(1);
    expect(message.firstChild?.nodeType).toBe(Node.TEXT_NODE);
    expect(message.childElementCount).toBe(0);
    expect(message.getAttributeNames()).toEqual(["class"]);
    expect(message).not.toHaveFocus();
    expect(panel.querySelectorAll('script, img, br, wbr, [role="tooltip"]')).toHaveLength(0);
    if (surface === "list") {
      const alert = screen.getByRole("alert");
      const retry = within(alert).getByRole("button", { name: "Retry" });
      expect(message.className).toBe("wrap-anywhere");
      expect(alert.className).toBe(errorClasses);
      expect(alert.getAttributeNames().sort()).toEqual(["aria-atomic", "class", "role"]);
      expect(alert).toHaveAttribute("aria-atomic", "true");
      expect(content?.firstElementChild).toBe(alert);
      expect([...alert.childNodes]).toEqual([message, retry]);
      expect(retry.className).toBe("btn btn-outline btn-sm mt-2 gap-1.5");
      expect(retry).toHaveAttribute("type", "button");
      expect(retry).toBeEnabled();
    } else {
      expect(message.className).toBe(`${errorClasses} wrap-anywhere`);
      expect(message.parentElement).toBe(content);
      expect(content?.children.item(screen.queryByRole("alert") ? 1 : 0)).toBe(message);
    }
    return message;
  }

  it.each(errorMessages)("keeps the full $label list error through repeated failure and empty recovery", async ({ label, message }) => {
    if (label === "unbroken") {
      expect(message.length).toBeGreaterThanOrEqual(240);
      expect(message).not.toMatch(/\s/);
    }
    const repeated = deferred<ActivityPageDto>();
    const recovered = deferred<ActivityPageDto>();
    activity
      .mockRejectedValueOnce(new Error(message))
      .mockReturnValueOnce(repeated.promise)
      .mockReturnValueOnce(recovered.promise);
    const onClose = vi.fn();
    render(<ActivityPanel session={session(`list-error-${label}`)} onClose={onClose} />);
    await act(async () => {});
    const inspect = observeInspection(onClose);
    const alert = screen.getByRole("alert");

    for (const [index, request] of [repeated, recovered].entries()) {
      inspect(() => {
        expectWrappedError("list", message);
        expect(within(activityPanel()).getAllByRole("button")).toHaveLength(3);
        expect(activityPanel().querySelector(".animate-spin")).toBeNull();
        expect(screen.queryByText("No activity yet")).toBeNull();
        expect(screen.queryAllByTestId("activity-row")).toHaveLength(0);
      });
      const retry = screen.getByRole("button", { name: "Retry" });
      fireEvent.click(retry);
      fireEvent.click(retry);
      expect(activity).toHaveBeenCalledTimes(index + 2);
      expect(activity).toHaveBeenLastCalledWith(`list-error-${label}`, { limit: 50 });
      expect(screen.getByRole("button", { name: "Retrying…" })).toBeDisabled();
      expect(screen.getByRole("button", { name: "Refreshing activity" })).toBeDisabled();
      if (request === repeated) request.reject(new Error(message));
      else request.resolve({ items: [], nextBefore: null });
      await act(async () => {});
    }
    inspect(() => {
      expect(screen.getByText("No activity yet")).toBeInTheDocument();
      expect(screen.queryByRole("alert")).toBeNull();
      expect(alert).not.toBeInTheDocument();
      expect(activityPanel().querySelector(".wrap-anywhere")).toBeNull();
      expect(within(activityPanel()).getAllByRole("button")).toHaveLength(2);
      expect(screen.getByRole("button", { name: "Refresh activity" })).toBeEnabled();
    });
  });

  it.each(errorMessages)("keeps the full $label page error through repeated failure and cached-row recovery", async ({ label, message }) => {
    if (label === "unbroken") {
      expect(message.length).toBeGreaterThanOrEqual(240);
      expect(message).not.toMatch(/\s/);
    }
    const failed = deferred<ActivityPageDto>();
    const repeated = deferred<ActivityPageDto>();
    const recovered = deferred<ActivityPageDto>();
    activity
      .mockResolvedValueOnce({ items: [row("recent", "Recent editor")], nextBefore: "older-cursor" })
      .mockReturnValueOnce(failed.promise)
      .mockReturnValueOnce(repeated.promise)
      .mockReturnValueOnce(recovered.promise);
    const onClose = vi.fn();
    render(<ActivityPanel session={session(`page-error-${label}`)} onClose={onClose} />);
    await act(async () => {});
    const inspect = observeInspection(onClose);
    const recent = screen.getByTestId("activity-row");
    let error: HTMLElement | undefined;

    for (const [index, request] of [failed, repeated, recovered].entries()) {
      const loadMore = screen.getByRole("button", { name: "Load more" });
      fireEvent.click(loadMore);
      fireEvent.click(loadMore);
      expect(activity).toHaveBeenCalledTimes(index + 2);
      expect(activity).toHaveBeenLastCalledWith(`page-error-${label}`, { before: "older-cursor", limit: 50 });
      expect(screen.getByTestId("activity-load-more")).toBeDisabled();
      if (request === recovered) {
        request.resolve({ items: [row("older", "Earlier editor"), row("recent", "Duplicate editor")], nextBefore: null });
      } else {
        request.reject(new Error(message));
      }
      await act(async () => {});
      if (request !== recovered) {
        inspect(() => {
          error = expectWrappedError("page", message);
          expect(screen.queryByRole("alert")).toBeNull();
          expect(within(activityPanel()).getAllByRole("button")).toHaveLength(3);
          expect(screen.getByTestId("activity-row")).toBe(recent);
          expect(screen.getByRole("button", { name: "Load more" })).toBeEnabled();
        });
      }
    }
    inspect(() => {
      expect(error).not.toBeInTheDocument();
      expect(screen.queryByRole("alert")).toBeNull();
      expect(screen.queryByTestId("activity-load-more")).toBeNull();
      expect(screen.getAllByTestId("activity-row")).toHaveLength(2);
      expect(screen.getByText("Recent editor")).toBeInTheDocument();
      expect(screen.getByText("Earlier editor")).toBeInTheDocument();
      expect(screen.queryByText("Duplicate editor")).toBeNull();
      expect(within(activityPanel()).getAllByRole("button")).toHaveLength(2);
    });
  });

  it("retains expanded history and its cursor while wrapped list and page errors recover separately", async () => {
    const listMessage = "L".repeat(260);
    const pageMessage = "P".repeat(260);
    const refreshed = deferred<ActivityPageDto>();
    const paged = deferred<ActivityPageDto>();
    activity
      .mockResolvedValueOnce({ items: [row("recent", "Recent editor")], nextBefore: "older-cursor" })
      .mockResolvedValueOnce({ items: [row("older", "Earlier editor")], nextBefore: "deep-cursor" })
      .mockRejectedValueOnce(new Error(listMessage))
      .mockRejectedValueOnce(new Error(pageMessage))
      .mockReturnValueOnce(refreshed.promise)
      .mockReturnValueOnce(paged.promise);
    const onClose = vi.fn();
    render(<ActivityPanel session={session("wrapped-expanded-errors")} onClose={onClose} />);
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    await act(async () => {});
    const cachedRows = screen.getAllByTestId("activity-row");
    fireEvent.click(screen.getByRole("button", { name: "Refresh activity" }));
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    await act(async () => {});
    const inspect = observeInspection(onClose);
    inspect(() => {
      expectWrappedError("list", listMessage);
      expectWrappedError("page", pageMessage);
      expect(screen.getAllByTestId("activity-row")).toEqual(cachedRows);
      expect(within(activityPanel()).getAllByRole("button")).toHaveLength(4);
    });
    expect(activity).toHaveBeenCalledTimes(4);
    expect(activity).toHaveBeenLastCalledWith("wrapped-expanded-errors", { before: "deep-cursor", limit: 50 });

    const retry = screen.getByRole("button", { name: "Retry" });
    fireEvent.click(retry);
    fireEvent.click(retry);
    expect(activity).toHaveBeenCalledTimes(5);
    expect(activity).toHaveBeenLastCalledWith("wrapped-expanded-errors", { limit: 50 });
    refreshed.resolve({
      items: [row("fresh", "Newest editor"), row("recent", "Updated recent editor")],
      nextBefore: "ignored-refresh-cursor",
    });
    await act(async () => {});
    inspect(() => {
      expect(screen.queryByRole("alert")).toBeNull();
      expectWrappedError("page", pageMessage);
      expect(screen.getAllByTestId("activity-row").map((item) => item.textContent)).toEqual([
        expect.stringContaining("Newest editor"),
        expect.stringContaining("Updated recent editor"),
        expect.stringContaining("Earlier editor"),
      ]);
    });
    const loadMore = screen.getByRole("button", { name: "Load more" });
    fireEvent.click(loadMore);
    fireEvent.click(loadMore);
    expect(activity).toHaveBeenCalledTimes(6);
    expect(activity).toHaveBeenLastCalledWith("wrapped-expanded-errors", { before: "deep-cursor", limit: 50 });
    paged.resolve({ items: [row("oldest", "Oldest editor"), row("older", "Duplicate earlier editor")], nextBefore: null });
    await act(async () => {});
    inspect(() => {
      expect(screen.queryByText(pageMessage)).toBeNull();
      expect(screen.queryByRole("alert")).toBeNull();
      expect(screen.queryByTestId("activity-load-more")).toBeNull();
      expect(screen.getAllByTestId("activity-row")).toHaveLength(4);
      expect(screen.getByText("Earlier editor")).toBeInTheDocument();
      expect(screen.queryByText("Duplicate earlier editor")).toBeNull();
    });
  });

});

describe("ActivityPanel list recovery", () => {
  it("replaces an initial failure with an unfocused retry that makes one request and reaches the empty state", async () => {
    const retry = deferred<ActivityPageDto>();
    activity.mockRejectedValueOnce("offline").mockReturnValueOnce(retry.promise);

    render(<ActivityPanel session={session("activity-retry-empty")} onClose={vi.fn()} />);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Failed to load activity");
    expect(screen.getByTestId("activity-panel").querySelector(".animate-spin")).toBeNull();
    const retryButton = screen.getByRole("button", { name: "Retry" });
    expect(alert).not.toHaveFocus();
    expect(retryButton).not.toHaveFocus();
    expect(screen.getByRole("button", { name: "Close activity" })).toBeEnabled();

    fireEvent.click(retryButton);
    fireEvent.click(retryButton);
    expect(activity).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("button", { name: "Retrying…" })).toBeDisabled();

    retry.resolve({ items: [], nextBefore: null });
    expect(await screen.findByText("No activity yet")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(activity).toHaveBeenNthCalledWith(2, "activity-retry-empty", { limit: 50 });
  });

  it("keeps one first-page request through pending ticks and refreshes at the next tick after settlement", async () => {
    vi.useFakeTimers();
    const initial = deferred<ActivityPageDto>();
    const later = deferred<ActivityPageDto>();
    activity.mockReturnValueOnce(initial.promise).mockReturnValueOnce(later.promise);

    render(<ActivityPanel session={session("activity-coalesced")} onClose={vi.fn()} />);
    expect(activity).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(90_000);
    });
    expect(activity).toHaveBeenCalledTimes(1);

    initial.resolve({ items: [row("initial", "Initial editor")], nextBefore: null });
    await act(async () => {});
    expect(screen.getByText("Initial editor")).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(activity).toHaveBeenCalledTimes(2);
    expect(activity).toHaveBeenNthCalledWith(1, "activity-coalesced", { limit: 50 });
    expect(activity).toHaveBeenNthCalledWith(2, "activity-coalesced", { limit: 50 });

    later.resolve({ items: [row("later", "Later editor")], nextBefore: null });
    await act(async () => {});
    expect(screen.getByText("Later editor")).toBeInTheDocument();
  });

  it("keeps expanded rows through a refresh failure and a successful retry", async () => {
    vi.useFakeTimers();
    activity
      .mockResolvedValueOnce({ items: [row("recent", "Recent editor")], nextBefore: "older-than-recent" })
      .mockResolvedValueOnce({ items: [row("older", "Earlier editor")], nextBefore: null })
      .mockRejectedValueOnce("refresh unavailable")
      .mockResolvedValueOnce({ items: [row("fresh", "Newest editor")], nextBefore: null });

    render(<ActivityPanel session={session("activity-expanded")} onClose={vi.fn()} />);
    await act(async () => {});
    expect(screen.getByText("Recent editor")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    await act(async () => {});
    expect(screen.getByText("Earlier editor")).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(screen.getByRole("alert")).toHaveTextContent("Failed to load activity");
    expect(screen.getByText("Recent editor")).toBeInTheDocument();
    expect(screen.getByText("Earlier editor")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await act(async () => {});
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("Newest editor")).toBeInTheDocument();
    expect(screen.getByText("Recent editor")).toBeInTheDocument();
    expect(screen.getByText("Earlier editor")).toBeInTheDocument();
  });

  it("starts one page request for rapid activation and keeps the cursor retryable after failure", async () => {
    vi.useFakeTimers();
    const initial = deferred<ActivityPageDto>();
    const failedPage = deferred<ActivityPageDto>();
    const failedRefresh = deferred<ActivityPageDto>();
    const retriedPage = deferred<ActivityPageDto>();
    activity
      .mockReturnValueOnce(initial.promise)
      .mockReturnValueOnce(failedPage.promise)
      .mockReturnValueOnce(failedRefresh.promise)
      .mockReturnValueOnce(retriedPage.promise);

    render(<ActivityPanel session={session("activity-page-retry")} onClose={vi.fn()} />);
    initial.resolve({ items: [row("recent", "Recent editor")], nextBefore: "older-cursor" });
    await act(async () => {});

    const loadMore = screen.getByRole("button", { name: "Load more" });
    fireEvent.click(loadMore);
    fireEvent.click(loadMore);
    expect(activity).toHaveBeenCalledTimes(2);
    expect(activity).toHaveBeenNthCalledWith(2, "activity-page-retry", { before: "older-cursor", limit: 50 });

    failedPage.reject("page unavailable");
    await act(async () => {});
    expect(screen.getByText("Failed to load more")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Load more" })).toBeEnabled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(activity).toHaveBeenCalledTimes(3);
    failedRefresh.reject("refresh unavailable");
    await act(async () => {});
    expect(screen.getByRole("alert")).toHaveTextContent("Failed to load activity");

    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    expect(activity).toHaveBeenCalledTimes(4);
    expect(activity).toHaveBeenNthCalledWith(4, "activity-page-retry", { before: "older-cursor", limit: 50 });

    retriedPage.resolve({ items: [row("older", "Earlier editor"), row("recent", "Duplicate recent editor")], nextBefore: null });
    await act(async () => {});
    expect(screen.queryByText("Failed to load more")).toBeNull();
    expect(screen.getByRole("alert")).toHaveTextContent("Failed to load activity");
    expect(screen.getByText("Recent editor")).toBeInTheDocument();
    expect(screen.getByText("Earlier editor")).toBeInTheDocument();
    expect(screen.queryByText("Duplicate recent editor")).toBeNull();
    expect(screen.getAllByTestId("activity-row")).toHaveLength(2);
  });

  it("ignores an old-cursor success without appending, advancing, expanding, or unlocking the current page", async () => {
    vi.useFakeTimers();
    const oldPage = deferred<ActivityPageDto>();
    const currentPage = deferred<ActivityPageDto>();
    const laterPage = deferred<ActivityPageDto>();
    activity
      .mockResolvedValueOnce({ items: [row("initial", "Initial editor")], nextBefore: "old-cursor" })
      .mockReturnValueOnce(oldPage.promise)
      .mockResolvedValueOnce({ items: [row("fresh", "Fresh editor")], nextBefore: "current-cursor" })
      .mockReturnValueOnce(currentPage.promise)
      .mockReturnValueOnce(laterPage.promise);

    render(<ActivityPanel session={session("activity-stale-page-success")} onClose={vi.fn()} />);
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(screen.getByRole("button", { name: "Load more" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    expect(activity).toHaveBeenNthCalledWith(4, "activity-stale-page-success", { before: "current-cursor", limit: 50 });
    expect(screen.getByTestId("activity-load-more")).toBeDisabled();

    oldPage.resolve({ items: [row("stale", "Stale editor")], nextBefore: "stale-next" });
    await act(async () => {});
    expect(screen.queryByText("Stale editor")).toBeNull();
    expect(screen.getByText("Fresh editor")).toBeInTheDocument();
    expect(screen.getByTestId("activity-load-more")).toBeDisabled();
    fireEvent.click(screen.getByTestId("activity-load-more"));
    expect(activity).toHaveBeenCalledTimes(4);

    currentPage.resolve({ items: [row("current", "Current older editor"), row("fresh", "Duplicate fresh editor")], nextBefore: "later-cursor" });
    await act(async () => {});
    expect(screen.getByText("Current older editor")).toBeInTheDocument();
    expect(screen.queryByText("Duplicate fresh editor")).toBeNull();
    expect(screen.getByTestId("activity-load-more")).toBeEnabled();
    expect(screen.getAllByTestId("activity-row")).toHaveLength(2);

    fireEvent.click(screen.getByTestId("activity-load-more"));
    expect(activity).toHaveBeenCalledTimes(5);
    expect(activity).toHaveBeenNthCalledWith(5, "activity-stale-page-success", { before: "later-cursor", limit: 50 });
    laterPage.resolve({ items: [row("last", "Last editor")], nextBefore: null });
    await act(async () => {});
    expect(screen.getByText("Last editor")).toBeInTheDocument();
    expect(screen.queryByTestId("activity-load-more")).toBeNull();
  });

  it("ignores an old-cursor failure and finalizer while the current page is pending", async () => {
    vi.useFakeTimers();
    const oldPage = deferred<ActivityPageDto>();
    const currentPage = deferred<ActivityPageDto>();
    activity
      .mockResolvedValueOnce({ items: [row("initial", "Initial editor")], nextBefore: "old-cursor" })
      .mockReturnValueOnce(oldPage.promise)
      .mockResolvedValueOnce({ items: [row("fresh", "Fresh editor")], nextBefore: "current-cursor" })
      .mockReturnValueOnce(currentPage.promise);

    render(<ActivityPanel session={session("activity-stale-page-failure")} onClose={vi.fn()} />);
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));

    oldPage.reject("stale failure");
    await act(async () => {});
    expect(screen.queryByText("Failed to load more")).toBeNull();
    expect(screen.getByTestId("activity-load-more")).toBeDisabled();

    currentPage.reject("current failure");
    await act(async () => {});
    expect(screen.getByText("Failed to load more")).toBeInTheDocument();
    expect(screen.getByTestId("activity-load-more")).toBeEnabled();
  });

  it("ignores an older document response after the panel switches documents", async () => {
    const oldRequest = deferred<ActivityPageDto>();
    activity.mockImplementation((docId: string) =>
      docId === "activity-old"
        ? oldRequest.promise
        : Promise.resolve({ items: [row("new", "New document editor")], nextBefore: null }),
    );

    const rendered = render(<ActivityPanel session={session("activity-old")} onClose={vi.fn()} />);
    await waitFor(() => expect(activity).toHaveBeenCalledWith("activity-old", { limit: 50 }));
    rendered.rerender(<ActivityPanel session={session("activity-new")} onClose={vi.fn()} />);
    expect(await screen.findByText("New document editor")).toBeInTheDocument();

    oldRequest.resolve({ items: [row("old", "Old document editor")], nextBefore: null });
    await act(async () => {});
    expect(screen.getByText("New document editor")).toBeInTheDocument();
    expect(screen.queryByText("Old document editor")).toBeNull();
  });

  it.each(["success", "failure"] as const)(
    "retires an old document before its deferred %s settles at the replacement layout boundary",
    async (outcome) => {
      vi.useFakeTimers();
      const oldRequest = deferred<ActivityPageDto>();
      const currentRequest = deferred<ActivityPageDto>();
      const laterRequest = deferred<ActivityPageDto>();
      activity
        .mockReturnValueOnce(oldRequest.promise)
        .mockReturnValueOnce(currentRequest.promise)
        .mockReturnValueOnce(laterRequest.promise);

      const rendered = render(<ActivityBoundary documentId="activity-boundary-old" />);
      expect(activity).toHaveBeenCalledTimes(1);

      rendered.rerender(
        <ActivityBoundary
          documentId="activity-boundary-current"
          boundary={1}
          onBoundary={() => {
            if (outcome === "success") {
              oldRequest.resolve({ items: [row("retired", "Retired document editor")], nextBefore: "retired-cursor" });
            } else {
              oldRequest.reject("retired document failure");
            }
          }}
        />,
      );
      await act(async () => {
        await Promise.allSettled([oldRequest.promise]);
      });

      expect(activity).toHaveBeenCalledTimes(2);
      expect(screen.queryByText("Retired document editor")).toBeNull();
      expect(screen.queryByRole("alert")).toBeNull();
      expect(screen.getByTestId("activity-panel").querySelector(".animate-spin")).not.toBeNull();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(90_000);
      });
      expect(activity).toHaveBeenCalledTimes(2);

      currentRequest.resolve({ items: [row("current", "Current document editor")], nextBefore: null });
      await act(async () => {});
      expect(screen.getByText("Current document editor")).toBeInTheDocument();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000);
      });
      expect(activity).toHaveBeenCalledTimes(3);
      expect(activity).toHaveBeenNthCalledWith(3, "activity-boundary-current", { limit: 50 });
      laterRequest.resolve({ items: [row("later", "Later current editor")], nextBefore: null });
      await act(async () => {});
      expect(screen.getByText("Later current editor")).toBeInTheDocument();
      expect(vi.getTimerCount()).toBe(1);
    },
  );

  it("invalidates pending work synchronously when Close is activated", async () => {
    vi.useFakeTimers();
    const pending = deferred<ActivityPageDto>();
    const onClose = vi.fn();
    activity.mockReturnValueOnce(pending.promise);

    render(<ActivityPanel session={session("activity-close")} onClose={onClose} />);
    expect(vi.getTimerCount()).toBe(1);
    fireEvent.click(screen.getByRole("button", { name: "Close activity" }));
    expect(onClose).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(90_000);
    });
    expect(activity).toHaveBeenCalledOnce();

    pending.resolve({ items: [row("late", "Late editor")], nextBefore: null });
    await act(async () => {});
    expect(screen.queryByText("Late editor")).toBeNull();
  });

  it("retires page, refresh, and cadence work before settlements at the removal layout boundary", async () => {
    vi.useFakeTimers();
    const page = deferred<ActivityPageDto>();
    const refresh = deferred<ActivityPageDto>();
    activity
      .mockResolvedValueOnce({ items: [row("initial", "Initial editor")], nextBefore: "older-cursor" })
      .mockReturnValueOnce(page.promise)
      .mockReturnValueOnce(refresh.promise);

    const rendered = render(<ActivityBoundary documentId="activity-boundary-removal" />);
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(activity).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(1);
    let timersAtBoundary = -1;

    rendered.rerender(
      <ActivityBoundary
        documentId="activity-boundary-removal"
        present={false}
        boundary={1}
        onBoundary={() => {
          timersAtBoundary = vi.getTimerCount();
          page.resolve({ items: [row("retired-page", "Retired page editor")], nextBefore: "retired-next" });
          refresh.reject("retired refresh failure");
        }}
      />,
    );
    await act(async () => {
      await Promise.allSettled([page.promise, refresh.promise]);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(90_000);
    });

    expect(timersAtBoundary).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(activity).toHaveBeenCalledTimes(3);
    expect(screen.queryByTestId("activity-panel")).toBeNull();
    expect(screen.queryByText("Retired page editor")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(unhandledRejections).toEqual([]);
  });

  it("handles late page resolution and refresh rejection after unmount without committing", async () => {
    vi.useFakeTimers();
    const page = deferred<ActivityPageDto>();
    const refresh = deferred<ActivityPageDto>();
    activity
      .mockResolvedValueOnce({ items: [row("initial", "Initial editor")], nextBefore: "older-cursor" })
      .mockReturnValueOnce(page.promise)
      .mockReturnValueOnce(refresh.promise);

    const rendered = render(<ActivityPanel session={session("activity-unmount")} onClose={vi.fn()} />);
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(activity).toHaveBeenCalledTimes(3);

    rendered.unmount();
    page.resolve({ items: [row("late-page", "Late page editor")], nextBefore: null });
    refresh.reject("late refresh failure");
    await act(async () => {});
    expect(screen.queryByTestId("activity-panel")).toBeNull();
    expect(unhandledRejections).toEqual([]);
  });
});

describe("ActivityPanel manual refresh", () => {
  it("refreshes the current first page once, replaces its cursor, updates relative time, and sits immediately before Close", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-08T12:01:10.000Z"));
    const refreshed = deferred<ActivityPageDto>();
    const nextPage = deferred<ActivityPageDto>();
    const timedRow = {
      ...row("timed", "Initial timed editor"),
      createdAt: "2026-09-08T12:00:00.000Z",
    };
    const initialPage = {
      items: [timedRow],
      nextBefore: "initial-cursor",
    };
    activity
      .mockResolvedValueOnce(initialPage)
      .mockResolvedValueOnce(initialPage)
      .mockReturnValueOnce(refreshed.promise)
      .mockReturnValueOnce(nextPage.promise);

    createStrictActivity({
      session: session("manual-success"),
      onClose: vi.fn(),
    });
    await act(async () => {});

    expect(activity).toHaveBeenCalledTimes(2);
    const refresh = screen.getByRole("button", { name: "Refresh activity" });
    const close = screen.getByRole("button", { name: "Close activity" });
    expect(refresh.nextElementSibling).toBe(close);
    expect(screen.getByText("1 minute ago")).toBeInTheDocument();

    act(() => refresh.click());
    expect(activity).toHaveBeenCalledTimes(3);
    expect(activity).toHaveBeenLastCalledWith("manual-success", { limit: 50 });
    expect(
      screen.getByRole("button", { name: "Refreshing activity" }),
    ).toBeDisabled();

    vi.setSystemTime(new Date("2026-09-08T12:02:10.000Z"));
    refreshed.resolve({
      items: [{ ...timedRow, actorName: "Updated timed editor" }],
      nextBefore: "replacement-cursor",
    });
    await act(async () => {});

    expect(screen.getByText("Updated timed editor")).toBeInTheDocument();
    expect(screen.getByText("2 minutes ago")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Refresh activity" }),
    ).toBeEnabled();

    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    expect(activity).toHaveBeenCalledTimes(4);
    expect(activity).toHaveBeenLastCalledWith("manual-success", {
      before: "replacement-cursor",
      limit: 50,
    });
  });

  it("retains expanded history and its cursor across failure and a de-duplicated retry", async () => {
    const failedRefresh = deferred<ActivityPageDto>();
    const successfulRefresh = deferred<ActivityPageDto>();
    const deeperPage = deferred<ActivityPageDto>();
    const initialPage = {
      items: [row("recent", "Recent editor")],
      nextBefore: "older-cursor",
    };
    activity
      .mockResolvedValueOnce(initialPage)
      .mockResolvedValueOnce(initialPage)
      .mockResolvedValueOnce({
        items: [row("older", "Older editor")],
        nextBefore: "deep-cursor",
      })
      .mockReturnValueOnce(failedRefresh.promise)
      .mockReturnValueOnce(successfulRefresh.promise)
      .mockReturnValueOnce(deeperPage.promise);

    createStrictActivity({
      session: session("manual-expanded"),
      onClose: vi.fn(),
    });
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    await act(async () => {});
    expect(screen.getAllByTestId("activity-row")).toHaveLength(2);

    fireEvent.click(screen.getByRole("button", { name: "Refresh activity" }));
    expect(activity).toHaveBeenCalledTimes(4);
    failedRefresh.reject("refresh failed");
    await act(async () => {});

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Failed to load activity",
    );
    expect(screen.getByText("Recent editor")).toBeInTheDocument();
    expect(screen.getByText("Older editor")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Refresh activity" }),
    ).toBeEnabled();

    fireEvent.click(screen.getByRole("button", { name: "Refresh activity" }));
    expect(activity).toHaveBeenCalledTimes(5);
    successfulRefresh.resolve({
      items: [
        row("fresh", "Fresh editor"),
        row("recent", "Updated recent editor"),
      ],
      nextBefore: "ignored-first-page-cursor",
    });
    await act(async () => {});

    expect(screen.queryByRole("alert")).toBeNull();
    const rows = screen.getAllByTestId("activity-row");
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveTextContent("Fresh editor");
    expect(rows[1]).toHaveTextContent("Updated recent editor");
    expect(rows[2]).toHaveTextContent("Older editor");
    expect(screen.queryByText("Recent editor")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    expect(activity).toHaveBeenCalledTimes(6);
    expect(activity).toHaveBeenLastCalledWith("manual-expanded", {
      before: "deep-cursor",
      limit: 50,
    });
  });

  it.each([
    ["Close", "resolve"],
    ["cleanup", "reject"],
  ] as const)(
    "performs no late state work after %s during a manual request that later %ss",
    async (retirement, outcome) => {
      vi.useFakeTimers();
      const lateRequest = deferred<ActivityPageDto>();
      const initialPage = {
        items: [row("before-retirement", "Before retirement editor")],
        nextBefore: null,
      };
      activity
        .mockResolvedValueOnce(initialPage)
        .mockResolvedValueOnce(initialPage)
        .mockReturnValueOnce(lateRequest.promise);
      const onClose = vi.fn();
      const view = createStrictActivity({
        session: session(`manual-${retirement}`),
        onClose,
      });
      await act(async () => {});
      fireEvent.click(
        screen.getByRole("button", { name: "Refresh activity" }),
      );
      expect(activity).toHaveBeenCalledTimes(3);

      if (retirement === "Close") {
        fireEvent.click(
          screen.getByRole("button", { name: "Close activity" }),
        );
        expect(onClose).toHaveBeenCalledOnce();
        expect(vi.getTimerCount()).toBe(0);
      } else {
        act(() => view.root.unmount());
        directRoots.delete(view.root);
        expect(screen.queryByTestId("activity-panel")).toBeNull();
      }

      if (outcome === "resolve") {
        lateRequest.resolve({
          items: [row("late-retirement", "Late retirement editor")],
          nextBefore: null,
        });
      } else {
        lateRequest.reject("late retirement failure");
      }
      await act(async () => {});

      expect(screen.queryByText("Late retirement editor")).toBeNull();
      expect(screen.queryByRole("alert")).toBeNull();
      expect(unhandledRejections).toEqual([]);
    },
  );
});

describe("ActivityPanel exact action publications", () => {
  it.each(["stale-first", "current-first"] as const)(
    "gives the exact fresh Strict Mode visit sole cadence and request authority, %s",
    async (settlementOrder) => {
      const intervalCallbacks: Array<() => void> = [];
      const intervalHandles = [
        301 as unknown as ReturnType<typeof setInterval>,
        302 as unknown as ReturnType<typeof setInterval>,
      ];
      vi.spyOn(globalThis, "setInterval").mockImplementation((handler) => {
        intervalCallbacks.push(handler as () => void);
        const handle = intervalHandles[intervalCallbacks.length - 1];
        if (!handle) throw new Error("Unexpected Activity cadence");
        return handle;
      });
      const clearIntervalSpy = vi
        .spyOn(globalThis, "clearInterval")
        .mockImplementation(() => {});
      const staleRequest = deferred<ActivityPageDto>();
      const currentRequest = deferred<ActivityPageDto>();
      const cadenceRequest = deferred<ActivityPageDto>();
      activity
        .mockReturnValueOnce(staleRequest.promise)
        .mockReturnValueOnce(currentRequest.promise)
        .mockReturnValueOnce(cadenceRequest.promise);
      const stableSession = session(`strict-cadence-${settlementOrder}`);
      const onClose = vi.fn();
      const host = document.createElement("div");
      document.body.append(host);
      const root = createRoot(host);
      directRoots.add(root);

      act(() => {
        root.render(
          <StrictMode>
            <ActivityPanel session={stableSession} onClose={onClose} />
          </StrictMode>,
        );
      });

      expect(activity).toHaveBeenCalledTimes(2);
      expect(intervalCallbacks).toHaveLength(2);
      expect(clearIntervalSpy).toHaveBeenCalledOnce();
      expect(clearIntervalSpy).toHaveBeenCalledWith(intervalHandles[0]);
      act(() => {
        intervalCallbacks[0]?.();
        intervalCallbacks[1]?.();
        intervalCallbacks[1]?.();
      });
      expect(activity).toHaveBeenCalledTimes(2);

      const settleStale = async () => {
        staleRequest.resolve({
          items: [row("strict-stale", "Stale editor")],
          nextBefore: null,
        });
        await staleRequest.promise;
      };
      const settleCurrent = async () => {
        currentRequest.resolve({
          items: [row("strict-current", "Current editor")],
          nextBefore: null,
        });
        await currentRequest.promise;
      };

      if (settlementOrder === "stale-first") {
        await act(settleStale);
        expect(screen.queryByText("Stale editor")).toBeNull();
        await act(settleCurrent);
      } else {
        await act(settleCurrent);
        await act(settleStale);
      }
      expect(screen.getByText("Current editor")).toBeInTheDocument();
      expect(screen.queryByText("Stale editor")).toBeNull();

      act(() => {
        intervalCallbacks[0]?.();
        intervalCallbacks[1]?.();
        intervalCallbacks[1]?.();
      });
      expect(activity).toHaveBeenCalledTimes(3);
      expect(activity).toHaveBeenLastCalledWith(stableSession.docId, {
        limit: 50,
      });

      cadenceRequest.resolve({
        items: [row("strict-cadence", "Cadence editor")],
        nextBefore: null,
      });
      await act(async () => {});
      expect(screen.getByText("Cadence editor")).toBeInTheDocument();
      expect(screen.queryByText("Current editor")).toBeNull();
      expect(clearIntervalSpy).toHaveBeenCalledOnce();
      expect(onClose).not.toHaveBeenCalled();
    },
  );

});

describe("ActivityPanel header focus movement", () => {
  it.each([
    ["ArrowRight", "Refresh activity", "Close activity"],
    ["ArrowDown", "Refresh activity", "Close activity"],
    ["End", "Refresh activity", "Close activity"],
    ["ArrowLeft", "Close activity", "Refresh activity"],
    ["ArrowUp", "Close activity", "Refresh activity"],
    ["Home", "Close activity", "Refresh activity"],
  ] as const)(
    "moves %s from %s to %s once, without acting, fetching or scrolling",
    async (key, from, to) => {
      const focus = vi.spyOn(HTMLElement.prototype, "focus");
      const preventDefault = vi.spyOn(Event.prototype, "preventDefault");
      activity.mockResolvedValue(headerPage());
      const onClose = vi.fn();
      await mountHeaderView(`header-${key}-${from}`, onClose);
      const source = headerControl(from);
      const destination = headerControl(to);
      source.focus();
      focus.mockClear();
      preventDefault.mockClear();
      const requests = activity.mock.calls.length;
      const published = activityPanel().innerHTML;
      const scroll = activityPanel().lastElementChild;
      const scrollBefore = [window.scrollX, window.scrollY, scroll?.scrollTop ?? 0];

      const event = activityKey(source, key);

      expect(event.defaultPrevented).toBe(true);
      expect(destination).toHaveFocus();
      expect(preventDefault).toHaveBeenCalledOnce();
      expect(focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
      expect(focus.mock.instances[0]).toBe(destination);
      expect(activity).toHaveBeenCalledTimes(requests);
      expect(onClose).not.toHaveBeenCalled();
      expect(activityPanel().innerHTML).toBe(published);
      expect([
        window.scrollX,
        window.scrollY,
        activityPanel().lastElementChild?.scrollTop ?? 0,
      ]).toEqual(scrollBefore);
      expect(headerControl("Refresh activity")).toBeEnabled();
      expect(headerControl("Close activity")).toBeEnabled();
    },
  );

  it.each([
    ["ArrowLeft", "Numpad4", "Close activity", "Refresh activity"],
    ["ArrowUp", "Numpad8", "Close activity", "Refresh activity"],
    ["ArrowRight", "Numpad6", "Refresh activity", "Close activity"],
    ["ArrowDown", "Numpad2", "Refresh activity", "Close activity"],
    ["Home", "Numpad7", "Close activity", "Refresh activity"],
    ["End", "Numpad1", "Refresh activity", "Close activity"],
  ] as const)(
    "accepts %s from %s at the numpad location without acting",
    async (key, code, from, to) => {
      const focus = vi.spyOn(HTMLElement.prototype, "focus");
      const preventDefault = vi.spyOn(Event.prototype, "preventDefault");
      activity.mockResolvedValue(headerPage());
      const onClose = vi.fn();
      await mountHeaderView(`header-numpad-${code}`, onClose);
      const source = headerControl(from);
      const destination = headerControl(to);
      source.focus();
      focus.mockClear();
      preventDefault.mockClear();
      const requests = activity.mock.calls.length;

      const event = activityKeyboardEvent(source, key, {
        code,
        location: KeyboardEvent.DOM_KEY_LOCATION_NUMPAD,
      });
      const ownerWindow = source.ownerDocument.defaultView;
      if (!ownerWindow) throw new Error("Activity has no owner Window");
      setActivityEventView(event, ownerWindow);
      expect(event.view).toBe(ownerWindow);
      act(() => source.dispatchEvent(event));

      expect(event.code).toBe(code);
      expect(event.location).toBe(KeyboardEvent.DOM_KEY_LOCATION_NUMPAD);
      expect(event.defaultPrevented).toBe(true);
      expect(destination).toHaveFocus();
      expect(preventDefault).toHaveBeenCalledOnce();
      expect(focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
      expect(activity).toHaveBeenCalledTimes(requests);
      expect(onClose).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["ArrowLeft", "Refresh activity"],
    ["ArrowUp", "Refresh activity"],
    ["Home", "Refresh activity"],
    ["ArrowRight", "Close activity"],
    ["ArrowDown", "Close activity"],
    ["End", "Close activity"],
  ] as const)(
    "leaves %s on %s inert at the header boundary and keeps the panel usable",
    async (key, from) => {
      const focus = vi.spyOn(HTMLElement.prototype, "focus");
      const preventDefault = vi.spyOn(Event.prototype, "preventDefault");
      activity.mockResolvedValue(headerPage());
      const onClose = vi.fn();
      await mountHeaderView(`boundary-${key}-${from}`, onClose);
      const source = headerControl(from);
      source.focus();
      focus.mockClear();
      preventDefault.mockClear();
      const requests = activity.mock.calls.length;

      const event = activityKey(source, key);

      expect(event.defaultPrevented).toBe(false);
      expect(source).toHaveFocus();
      expect(preventDefault).not.toHaveBeenCalled();
      expect(focus).not.toHaveBeenCalled();
      expect(activity).toHaveBeenCalledTimes(requests);
      expect(onClose).not.toHaveBeenCalled();

      const accepted = activityKey(
        source,
        from === "Refresh activity" ? "ArrowRight" : "ArrowLeft",
      );
      expect(accepted.defaultPrevented).toBe(true);
      expect(focus).toHaveBeenCalledOnce();
    },
  );

  it.each([
    ["one", false, 1],
    ["nested", true, 2],
  ] as const)(
    "retains native delivery through %s microtask checkpoints before React",
    async (label, nested, expectedCheckpoints) => {
      const focus = vi.spyOn(HTMLElement.prototype, "focus");
      const preventDefault = vi.spyOn(Event.prototype, "preventDefault");
      activity.mockResolvedValue(headerPage());
      await mountHeaderView(`header-${label}-microtasks`);
      const refresh = headerControl("Refresh activity");
      const close = headerControl("Close activity");
      const ownerWindow = refresh.ownerDocument.defaultView;
      if (!ownerWindow) throw new Error("Activity has no owner Window");
      const scheduled: VoidFunction[] = [];
      let checkpoints = 0;
      const queueMicrotaskSpy = vi
        .spyOn(globalThis, "queueMicrotask")
        .mockImplementation((callback) => {
          scheduled.push(callback);
        });
      queueMicrotask(() => {
        checkpoints += 1;
        if (nested) {
          queueMicrotask(() => {
            checkpoints += 1;
          });
        }
      });
      const runCheckpoints = () => {
        if (nested) {
          while (scheduled.length > 0) scheduled.shift()?.();
        } else {
          scheduled.shift()?.();
        }
      };
      ownerWindow.addEventListener("keydown", runCheckpoints, true);
      refresh.focus();
      focus.mockClear();
      preventDefault.mockClear();

      const event = activityKeyboardEvent(refresh, "ArrowRight");
      try {
        act(() => refresh.dispatchEvent(event));
      } finally {
        ownerWindow.removeEventListener("keydown", runCheckpoints, true);
        while (scheduled.length > 0) scheduled.shift()?.();
        queueMicrotaskSpy.mockRestore();
      }

      expect(checkpoints).toBe(expectedCheckpoints);
      expect(event.defaultPrevented).toBe(true);
      expect(close).toHaveFocus();
      expect(preventDefault).toHaveBeenCalledOnce();
      expect(focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
    },
  );

  it("leaves every key inert while the refresh control is hidden", async () => {
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const preventDefault = vi.spyOn(Event.prototype, "preventDefault");
    const pending = deferred<ActivityPageDto>();
    activity.mockReturnValue(pending.promise);
    const onClose = vi.fn();
    await mountHeaderView("header-hidden-refresh", onClose);
    expect(screen.queryByRole("button", { name: "Refresh activity" })).toBeNull();
    expect(activityHeader().children).toHaveLength(2);
    const close = headerControl("Close activity");
    close.focus();
    focus.mockClear();
    preventDefault.mockClear();
    const requests = activity.mock.calls.length;

    for (const key of ["ArrowLeft", "ArrowUp", "ArrowRight", "ArrowDown", "Home", "End"]) {
      expect(activityKey(close, key).defaultPrevented).toBe(false);
    }

    expect(close).toHaveFocus();
    expect(focus).not.toHaveBeenCalled();
    expect(preventDefault).not.toHaveBeenCalled();
    expect(activity).toHaveBeenCalledTimes(requests);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("leaves every key inert while the refresh control is disabled", async () => {
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const preventDefault = vi.spyOn(Event.prototype, "preventDefault");
    const pending = deferred<ActivityPageDto>();
    activity
      .mockResolvedValueOnce(headerPage())
      .mockResolvedValueOnce(headerPage())
      .mockReturnValue(pending.promise);
    const onClose = vi.fn();
    await mountHeaderView("header-disabled-refresh", onClose);
    act(() => headerControl("Refresh activity").click());
    const refreshing = headerControl("Refreshing activity");
    const close = headerControl("Close activity");
    expect(refreshing).toBeDisabled();
    close.focus();
    focus.mockClear();
    preventDefault.mockClear();
    const requests = activity.mock.calls.length;

    for (const key of ["ArrowLeft", "ArrowUp", "Home", "ArrowRight", "End"]) {
      expect(activityKey(close, key).defaultPrevented).toBe(false);
      expect(activityKey(refreshing, key).defaultPrevented).toBe(false);
    }

    expect(close).toHaveFocus();
    expect(focus).not.toHaveBeenCalled();
    expect(preventDefault).not.toHaveBeenCalled();
    expect(activity).toHaveBeenCalledTimes(requests);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("keeps Tab order, Enter/Space activation and pointer actions unchanged", async () => {
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    activity.mockResolvedValue(headerPage());
    const onClose = vi.fn();
    await mountHeaderView("header-activation", onClose);
    const refresh = headerControl("Refresh activity");
    const close = headerControl("Close activity");
    expect(refresh.nextElementSibling).toBe(close);
    expect(refresh.hasAttribute("tabindex")).toBe(false);
    expect(close.hasAttribute("tabindex")).toBe(false);
    expect([refresh.tabIndex, close.tabIndex]).toEqual([0, 0]);
    close.focus();
    focus.mockClear();
    const requests = activity.mock.calls.length;

    for (const key of ["Enter", " ", "Tab", "Escape"]) {
      expect(activityKey(close, key).defaultPrevented).toBe(false);
    }

    expect(close).toHaveFocus();
    expect(focus).not.toHaveBeenCalled();
    expect(activity).toHaveBeenCalledTimes(requests);

    act(() => refresh.click());
    expect(activity).toHaveBeenCalledTimes(requests + 1);
    act(() => close.click());
    expect(onClose).toHaveBeenCalledOnce();
    await act(async () => {});
  });

  it.each([
    ["Alt-modified", { altKey: true }],
    ["Control-modified", { ctrlKey: true }],
    ["Meta-modified", { metaKey: true }],
    ["Shift-modified", { shiftKey: true }],
    ["repeating", { repeat: true }],
    ["composing", { isComposing: true }],
    ["non-bubbling", { bubbles: false }],
  ] as const)("rejects a %s key without prevention or focus", async (_name, init) => {
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const preventDefault = vi.spyOn(Event.prototype, "preventDefault");
    activity.mockResolvedValue(headerPage());
    await mountHeaderView(`header-modifier-${_name}`);
    const refresh = headerControl("Refresh activity");
    refresh.focus();
    focus.mockClear();
    preventDefault.mockClear();

    const event = activityKey(refresh, "ArrowRight", init);

    expect(event.defaultPrevented).toBe(false);
    expect(refresh).toHaveFocus();
    expect(focus).not.toHaveBeenCalled();
    expect(preventDefault).not.toHaveBeenCalled();

    const accepted = activityKey(refresh, "ArrowRight");
    expect(accepted.defaultPrevented).toBe(true);
    expect(headerControl("Close activity")).toHaveFocus();
  });

  it.each(["prevented", "propagation-stopped"] as const)(
    "rejects a previously %s key and keeps the publication usable",
    async (state) => {
      const focus = vi.spyOn(HTMLElement.prototype, "focus");
      const preventDefault = vi.spyOn(Event.prototype, "preventDefault");
      activity.mockResolvedValue(headerPage());
      await mountHeaderView(`header-${state}`);
      const refresh = headerControl("Refresh activity");
      refresh.focus();
      focus.mockClear();
      const event = activityKeyboardEvent(refresh, "ArrowRight");
      if (state === "prevented") event.preventDefault();
      else event.stopPropagation();
      preventDefault.mockClear();

      act(() => {
        refresh.dispatchEvent(event);
      });

      expect(refresh).toHaveFocus();
      expect(focus).not.toHaveBeenCalled();
      expect(preventDefault).not.toHaveBeenCalled();

      const accepted = activityKey(refresh, "ArrowRight");
      expect(accepted.defaultPrevented).toBe(true);
      expect(headerControl("Close activity")).toHaveFocus();
    },
  );

  it("claims the publication, movement, wrapper and native event before replay", async () => {
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const preventDefault = vi.spyOn(Event.prototype, "preventDefault");
    activity.mockResolvedValue(headerPage());
    const onClose = vi.fn();
    await mountHeaderView("header-replay", onClose);
    const refresh = headerControl("Refresh activity");
    const close = headerControl("Close activity");
    refresh.focus();
    focus.mockClear();
    preventDefault.mockClear();
    const requests = activity.mock.calls.length;
    const event = activityKeyboardEvent(refresh, "ArrowRight");

    act(() => {
      refresh.dispatchEvent(event);
      close.dispatchEvent(event);
      refresh.dispatchEvent(event);
    });

    expect(close).toHaveFocus();
    expect(focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(activity).toHaveBeenCalledTimes(requests);
    expect(onClose).not.toHaveBeenCalled();

    const successor = activityKey(close, "ArrowLeft");

    expect(successor.defaultPrevented).toBe(true);
    expect(refresh).toHaveFocus();
    expect(focus).toHaveBeenCalledTimes(2);
  });

  /**
   * A hostile native listener between the panel and React's delegation root can hand the control's
   * own bubble handler a complete React-like wrapper around the live, genuine, trusted native event
   * before React delivers its own. Neither that forgery nor React's real, now crossed, delivery may
   * prevent, focus, act, fetch or scroll; only a distinct clean event recovers.
   */
});
