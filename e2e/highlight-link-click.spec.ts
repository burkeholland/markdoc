import type { BrowserContext, Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { createDocument, devLogin, openDocument, selectTextInRich, uniqueLogin } from "./helpers";

test.use({ trace: "off", screenshot: "off", video: "off" });

const MISSPELLING = "qzxvblort";
const STALE_ORIGIN = "stale origin";
const STALE_DESTINATION = "stale destination";
const MOVED_ORIGIN = "moving origin";
const MOVED_DESTINATION = "moving destination";
const COMMENT_TEXT = "plain annotation";
const SUGGESTION_TEXT = "plain suggestion";
const SELECTION_TEXT = "selection baseline";
const LINK_TEXT = "linked phrase";
const SAFE_DESTINATION = "https://example.invalid/final?mode=editor#verified";
const DOCUMENT = [
  "# Pointer routing",
  "",
  `${MISSPELLING} remains ordinary text beside ${SELECTION_TEXT}.`,
  "",
  `${STALE_ORIGIN} is separate from ${STALE_DESTINATION}.`,
  "",
  `${MOVED_ORIGIN} is separate from ${MOVED_DESTINATION}.`,
  "",
  `${COMMENT_TEXT} and ${SUGGESTION_TEXT} are not links.`,
  "",
  `A [${LINK_TEXT}](${SAFE_DESTINATION}) overlaps an annotation.`,
  "",
].join("\n");

const CASE_LABELS = [
  "typo-native-menu",
  "stale-reanchor",
  "pointerdown-move",
  "modified-non-link",
  "modified-safe-link",
  "platform-negative-controls",
  "modified-link-drag",
] as const;

type CaseLabel = (typeof CASE_LABELS)[number];

interface Counts {
  interactions: number;
  activations: number;
  wrongItems: number;
  wrongKinds: number;
  selectionChanges: number;
  focusChanges: number;
  textChanges: number;
  linkOpens: number;
}

interface EditorSnapshot {
  text: string;
  focus: "rich" | "code" | "other";
  selection: string;
  collapsed: boolean;
}

interface Observation {
  activations: Array<{ kind: "comment" | "suggestion"; id: string }>;
  opens: Array<{ url: string; target: string; features: string }>;
}

interface GestureDelta {
  before: EditorSnapshot;
  after: EditorSnapshot;
  activations: Observation["activations"];
  opens: Observation["opens"];
}

interface HitPoint {
  x: number;
  y: number;
  left: number;
  right: number;
}

const emptyCounts = (): Counts => ({
  interactions: 0,
  activations: 0,
  wrongItems: 0,
  wrongKinds: 0,
  selectionChanges: 0,
  focusChanges: 0,
  textChanges: 0,
  linkOpens: 0,
});

function summarize(counts: Record<CaseLabel, Counts>) {
  const cases = CASE_LABELS.map((label) => ({ label, ...counts[label] }));
  const totals = cases.reduce<Counts>(
    (sum, current) => ({
      interactions: sum.interactions + current.interactions,
      activations: sum.activations + current.activations,
      wrongItems: sum.wrongItems + current.wrongItems,
      wrongKinds: sum.wrongKinds + current.wrongKinds,
      selectionChanges: sum.selectionChanges + current.selectionChanges,
      focusChanges: sum.focusChanges + current.focusChanges,
      textChanges: sum.textChanges + current.textChanges,
      linkOpens: sum.linkOpens + current.linkOpens,
    }),
    emptyCounts(),
  );
  return { cases, totals };
}

async function addComment(page: Page, documentId: string, quote: string): Promise<string> {
  const response = await page.request.post(`/api/documents/${documentId}/comments`, {
    data: { action: "add", quote, body: "Synthetic routing control." },
  });
  expect(response.ok(), "synthetic comment creation").toBe(true);
  return ((await response.json()) as { id: string }).id;
}

async function addDeletionSuggestion(page: Page, text: string): Promise<string> {
  return page.evaluate((needle) => {
    type Suggestion = { id: string; groupId?: string; type: "insert" | "delete"; from: number; to: number };
    type Session = {
      user: { id: string; name: string };
      ydoc: { transact(run: () => void): void };
      ytext: { toString(): string };
      suggestions: {
        list(): Suggestion[];
        markDeleted(from: number, to: number, author: { id: string; name: string }): number;
      };
    };
    const session = (window as unknown as { __markdocSession: Session }).__markdocSession;
    const from = session.ytext.toString().indexOf(needle);
    if (from < 0) throw new Error("suggestion fixture unavailable");
    session.ydoc.transact(() => session.suggestions.markDeleted(from, from + needle.length, session.user));
    const suggestion = session.suggestions
      .list()
      .find((candidate) => candidate.type === "delete" && candidate.from === from && candidate.to === from + needle.length);
    if (!suggestion) throw new Error("suggestion fixture unavailable");
    return suggestion.groupId ?? suggestion.id;
  }, text);
}

async function installObservation(page: Page) {
  await page.evaluate(() => {
    type Session = {
      setActiveComment(id: string | null): void;
      setActiveSuggestion(id: string | null): void;
    };
    const session = (window as unknown as { __markdocSession: Session }).__markdocSession;
    const observation: Observation = { activations: [], opens: [] };
    const setActiveComment = session.setActiveComment.bind(session);
    const setActiveSuggestion = session.setActiveSuggestion.bind(session);
    session.setActiveComment = (id) => {
      if (id) observation.activations.push({ kind: "comment", id });
      setActiveComment(id);
    };
    session.setActiveSuggestion = (id) => {
      if (id) observation.activations.push({ kind: "suggestion", id });
      setActiveSuggestion(id);
    };
    (window as unknown as { __highlightLinkObservation: Observation }).__highlightLinkObservation = observation;
    window.open = ((url?: string | URL, target?: string, features?: string) => {
      observation.opens.push({
        url: url instanceof URL ? url.href : String(url ?? ""),
        target: target ?? "",
        features: features ?? "",
      });
      return null;
    }) as typeof window.open;
  });
}

const readObservation = (page: Page) =>
  page.evaluate(() => (window as unknown as { __highlightLinkObservation: Observation }).__highlightLinkObservation);

const editorSnapshot = (page: Page): Promise<EditorSnapshot> =>
  page.evaluate(() => {
    type RichView = {
      hasFocus(): boolean;
      state: { selection: { anchor: number; head: number; empty: boolean } };
    };
    type Session = { ytext: { toString(): string } };
    const rich = document.querySelector(".md-rich");
    const code = document.querySelector(".cm-content");
    const active = document.activeElement;
    const focus = rich?.contains(active) ? "rich" : code?.contains(active) ? "code" : "other";
    const richView = (window as unknown as { __markdocRichView?: RichView }).__markdocRichView;
    if (richView?.hasFocus()) {
      const { anchor, head, empty } = richView.state.selection;
      return {
        text: (window as unknown as { __markdocSession: Session }).__markdocSession.ytext.toString(),
        focus,
        selection: `rich:${anchor}:${head}`,
        collapsed: empty,
      };
    }
    const selection = document.getSelection();
    const path = (node: Node | null) => {
      const parts: number[] = [];
      while (node?.parentNode) {
        parts.push(Array.prototype.indexOf.call(node.parentNode.childNodes, node));
        node = node.parentNode;
      }
      return parts.reverse().join(".");
    };
    return {
      text: (window as unknown as { __markdocSession: Session }).__markdocSession.ytext.toString(),
      focus,
      selection: selection
        ? `dom:${path(selection.anchorNode)}:${selection.anchorOffset}:${path(selection.focusNode)}:${selection.focusOffset}`
        : "none",
      collapsed: selection?.isCollapsed ?? true,
    };
  });

async function hitPoint(
  page: Page,
  rootSelector: ".md-rich" | ".cm-content",
  text: string,
  expected: { id?: string; kind?: string; link?: boolean },
): Promise<HitPoint> {
  const read = () =>
    page.locator(rootSelector).evaluate(
      (root, options): HitPoint | null => {
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        let node: Node | null;
        while ((node = walker.nextNode())) {
          const index = node.textContent?.indexOf(options.text) ?? -1;
          if (index < 0) continue;
          const range = document.createRange();
          range.setStart(node, index);
          range.setEnd(node, index + options.text.length);
          const rect = Array.from(range.getClientRects()).find((candidate) => candidate.width > 0 && candidate.height > 0);
          if (!rect) continue;
          const x = rect.left + rect.width / 2;
          const y = rect.top + rect.height / 2;
          const hit = document.elementFromPoint(x, y);
          if (!(hit instanceof Element) || !root.contains(hit)) continue;
          const highlight = hit.closest<HTMLElement>("[data-highlight-kind][data-highlight-id]");
          if (options.id && highlight?.dataset.highlightId !== options.id) continue;
          if (options.kind && highlight?.dataset.highlightKind !== options.kind) continue;
          if (options.link && !hit.closest("a[href]") && root.matches(".md-rich")) continue;
          return { x, y, left: rect.left, right: rect.right };
        }
        return null;
      },
      { text, ...expected },
    );
  let point: HitPoint | null = null;
  await expect
    .poll(async () => {
      point = await read();
      return point !== null;
    }, { message: "expected editor hit point" })
    .toBe(true);
  return point!;
}

async function moveComment(page: Page, sourceId: string, destinationId: string) {
  await page.evaluate(
    ({ sourceId: fromId, destinationId: toId }) => {
      type SharedMap = { get(key: string): unknown; set(key: string, value: unknown): void };
      type Session = {
        comments: {
          get(id: string): { quote: string; range: { from: number; to: number } | null } | null;
          ymap: { get(id: string): SharedMap | undefined; delete(id: string): void };
        };
        ytext: { toString(): string };
      };
      const session = (window as unknown as { __markdocSession: Session }).__markdocSession;
      const source = session.comments.ymap.get(fromId);
      const destination = session.comments.ymap.get(toId);
      if (!source || !destination) throw new Error("comment fixture unavailable");
      source.set("anchor", destination.get("anchor"));
      source.set("quote", destination.get("quote"));
      session.comments.ymap.delete(toId);
    },
    { sourceId, destinationId },
  );
  await expect
    .poll(
      () =>
        page.evaluate((id) => {
          type Session = {
            comments: { get(id: string): { quote: string; range: { from: number; to: number } | null } | null };
            ytext: { toString(): string };
          };
          const session = (window as unknown as { __markdocSession: Session }).__markdocSession;
          const comment = session.comments.get(id);
          return Boolean(comment?.range && session.ytext.toString().slice(comment.range.from, comment.range.to) === comment.quote);
        }, sourceId),
      { message: "comment should own its final range" },
    )
    .toBe(true);
}

async function withModifier(page: Page, keys: string[], action: () => Promise<void>) {
  for (const key of keys) await page.keyboard.down(key);
  try {
    await action();
  } finally {
    for (const key of [...keys].reverse()) await page.keyboard.up(key);
  }
}

async function recordGesture(
  page: Page,
  context: BrowserContext,
  counts: Counts,
  expected: { kind: "comment" | "suggestion"; id: string } | null,
  action: () => Promise<void>,
): Promise<GestureDelta> {
  const before = await editorSnapshot(page);
  const observationBefore = await readObservation(page);
  const pageCount = context.pages().length;
  counts.interactions++;
  await action();
  const [after, observationAfter] = await Promise.all([editorSnapshot(page), readObservation(page)]);
  const activations = observationAfter.activations.slice(observationBefore.activations.length);
  const opens = observationAfter.opens.slice(observationBefore.opens.length);
  counts.activations += activations.length;
  counts.linkOpens += opens.length;
  counts.selectionChanges += Number(after.selection !== before.selection);
  counts.focusChanges += Number(after.focus !== before.focus);
  counts.textChanges += Number(after.text !== before.text);
  if (expected) {
    counts.wrongItems += activations.filter((activation) => activation.id !== expected.id).length;
    counts.wrongKinds += activations.filter((activation) => activation.kind !== expected.kind).length;
  } else {
    counts.wrongItems += activations.length;
    counts.wrongKinds += activations.length;
  }
  expect(after.text === before.text, "gesture must not edit document text").toBe(true);
  expect(context.pages().length, "window.open must be intercepted").toBe(pageCount);
  return { before, after, activations, opens };
}

async function expectActiveComment(page: Page, id: string) {
  await expect
    .poll(
      () =>
        page.evaluate((threadId) => {
          type Session = { activeCommentId: string | null };
          const session = (window as unknown as { __markdocSession: Session }).__markdocSession;
          const panel = document.querySelector('[data-testid="comments-panel"]');
          const card = Array.from(document.querySelectorAll<HTMLElement>('[data-testid="comment-thread"]')).find(
            (element) => element.dataset.threadId === threadId,
          );
          return session.activeCommentId === threadId && Boolean(panel && card?.classList.contains("border-accent"));
        }, id),
      { message: "correct comment should be active and revealed" },
    )
    .toBe(true);
}

async function closeComments(page: Page) {
  await page.getByTestId("comments-toggle").click();
  await expect(page.getByTestId("comments-panel")).toHaveCount(0);
  await page.evaluate(() => {
    const session = (window as unknown as { __markdocSession: { setActiveComment(id: string | null): void } }).__markdocSession;
    session.setActiveComment(null);
  });
}

test("final highlight ownership and modified editor links", async ({ browser }) => {
  const counts = Object.fromEntries(CASE_LABELS.map((label) => [label, emptyCounts()])) as Record<CaseLabel, Counts>;
  let context: BrowserContext | undefined;
  try {
    context = await browser.newContext();
    await context.route("**/*", async (route) => {
      const hostname = new URL(route.request().url()).hostname;
      if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]") await route.fallback();
      else await route.abort("blockedbyclient");
    });
    const page = await context.newPage();
    await devLogin(page, uniqueLogin("highlight-link"));
    await page.waitForLoadState("networkidle");
    expect(await page.evaluate(() => /Mac|iPhone|iPad/.test(navigator.platform)), "selector requires Windows/Linux Ctrl semantics").toBe(false);

    const documentId = await createDocument(page, DOCUMENT, "Pointer routing");
    const staleId = await addComment(page, documentId, STALE_ORIGIN);
    const staleDestinationId = await addComment(page, documentId, STALE_DESTINATION);
    const movedId = await addComment(page, documentId, MOVED_ORIGIN);
    const movedDestinationId = await addComment(page, documentId, MOVED_DESTINATION);
    const commentId = await addComment(page, documentId, COMMENT_TEXT);
    const linkCommentId = await addComment(page, documentId, LINK_TEXT);
    await openDocument(page, documentId);
    const suggestionId = await addDeletionSuggestion(page, SUGGESTION_TEXT);
    await hitPoint(page, ".md-rich", SUGGESTION_TEXT, { id: suggestionId, kind: "suggest-delete" });
    await installObservation(page);

    const typo = await hitPoint(page, ".md-rich", MISSPELLING, {});
    await expect(page.locator(".md-rich")).toHaveAttribute("spellcheck", "true");
    for (const action of [
      () => page.mouse.click(typo.x, typo.y),
      () => page.mouse.click(typo.x, typo.y, { button: "right" }),
    ]) {
      const delta = await recordGesture(page, context, counts["typo-native-menu"], null, action);
      expect(delta.activations.length, "ordinary spelling interaction activation count").toBe(0);
      expect(delta.opens.length, "ordinary spelling interaction link count").toBe(0);
      await expect(page.getByTestId("comments-panel")).toHaveCount(0);
    }

    const staleOld = await hitPoint(page, ".cm-content", STALE_ORIGIN, { id: staleId, kind: "comment" });
    await moveComment(page, staleId, staleDestinationId);
    let delta = await recordGesture(page, context, counts["stale-reanchor"], { kind: "comment", id: staleId }, () =>
      page.mouse.click(staleOld.x, staleOld.y),
    );
    expect(delta.activations.length, "stale source coordinate activation count").toBe(0);
    await expect(page.getByTestId("comments-panel")).toHaveCount(0);
    const staleCurrent = await hitPoint(page, ".cm-content", STALE_DESTINATION, { id: staleId, kind: "comment" });
    delta = await recordGesture(page, context, counts["stale-reanchor"], { kind: "comment", id: staleId }, () =>
      page.mouse.click(staleCurrent.x, staleCurrent.y),
    );
    expect(delta.activations.length, "current source coordinate activation count").toBe(1);
    expect(delta.opens.length, "current source coordinate link count").toBe(0);
    await expectActiveComment(page, staleId);
    await closeComments(page);

    const movedOld = await hitPoint(page, ".md-rich", MOVED_ORIGIN, { id: movedId, kind: "comment" });
    delta = await recordGesture(page, context, counts["pointerdown-move"], { kind: "comment", id: movedId }, async () => {
      await page.mouse.move(movedOld.x, movedOld.y);
      await page.mouse.down();
      await moveComment(page, movedId, movedDestinationId);
      await page.mouse.up();
    });
    expect(delta.activations.length, "moved pointerdown coordinate activation count").toBe(0);
    await expect(page.getByTestId("comments-panel")).toHaveCount(0);
    const movedCurrent = await hitPoint(page, ".md-rich", MOVED_DESTINATION, { id: movedId, kind: "comment" });
    delta = await recordGesture(page, context, counts["pointerdown-move"], { kind: "comment", id: movedId }, () =>
      page.mouse.click(movedCurrent.x, movedCurrent.y),
    );
    expect(delta.activations.length, "moved current coordinate activation count").toBe(1);
    expect(delta.opens.length, "moved current coordinate link count").toBe(0);
    await expectActiveComment(page, movedId);
    await closeComments(page);

    const nonLinkTargets = [
      {
        point: await hitPoint(page, ".md-rich", COMMENT_TEXT, { id: commentId, kind: "comment" }),
        expected: { kind: "comment" as const, id: commentId },
      },
      {
        point: await hitPoint(page, ".md-rich", SUGGESTION_TEXT, { id: suggestionId, kind: "suggest-delete" }),
        expected: { kind: "suggestion" as const, id: suggestionId },
      },
    ];
    for (const { point, expected } of nonLinkTargets) {
      await selectTextInRich(page, SELECTION_TEXT);
      delta = await recordGesture(page, context, counts["modified-non-link"], expected, () =>
        withModifier(page, ["Control"], () => page.mouse.click(point.x, point.y)),
      );
      expect(delta.activations.length, "modified non-link activation count").toBe(0);
      expect(delta.opens.length, "modified non-link link count").toBe(0);
      expect(delta.after.selection === delta.before.selection, "modified non-link selection").toBe(true);
      expect(delta.after.focus === delta.before.focus, "modified non-link focus").toBe(true);
      await expect(page.getByTestId("comments-panel")).toHaveCount(0);
    }

    await selectTextInRich(page, SELECTION_TEXT);
    const sourceLink = await hitPoint(page, ".cm-content", LINK_TEXT, { id: linkCommentId, kind: "comment" });
    delta = await recordGesture(page, context, counts["modified-safe-link"], { kind: "comment", id: linkCommentId }, () =>
      withModifier(page, ["Control"], () => page.mouse.click(sourceLink.x, sourceLink.y)),
    );
    expect(delta.activations.length, "modified safe-link activation count").toBe(0);
    expect(delta.opens.length, "modified safe-link open count").toBe(1);
    expect(delta.opens[0]?.url === SAFE_DESTINATION, "resolved safe-link destination").toBe(true);
    expect(delta.opens[0]?.target === "_blank", "safe-link target").toBe(true);
    expect(delta.opens[0]?.features === "noopener", "safe-link features").toBe(true);
    expect(delta.after.selection === delta.before.selection, "modified safe-link selection").toBe(true);
    expect(delta.after.focus === delta.before.focus, "modified safe-link focus").toBe(true);
    await expect(page.getByTestId("comments-panel")).toHaveCount(0);

    const negativeGestures: Array<{ keys: string[]; action: () => Promise<void> }> = [
      { keys: ["Meta"], action: () => page.mouse.click(sourceLink.x, sourceLink.y) },
      { keys: ["Control", "Alt"], action: () => page.mouse.click(sourceLink.x, sourceLink.y) },
      { keys: ["Control", "Shift"], action: () => page.mouse.click(sourceLink.x, sourceLink.y) },
      { keys: [], action: () => page.mouse.click(sourceLink.x, sourceLink.y, { button: "middle" }) },
      { keys: [], action: () => page.mouse.click(sourceLink.x, sourceLink.y, { button: "right" }) },
      { keys: [], action: () => page.mouse.dblclick(sourceLink.x, sourceLink.y) },
    ];
    // Negative gestures retain native editor behavior; in particular, double-click still selects a source token.
    for (const { keys, action } of negativeGestures) {
      await selectTextInRich(page, SELECTION_TEXT);
      delta = await recordGesture(page, context, counts["platform-negative-controls"], { kind: "comment", id: linkCommentId }, () =>
        withModifier(page, keys, action),
      );
      expect(delta.activations.length, "platform-negative activation count").toBe(0);
      expect(delta.opens.length, "platform-negative open count").toBe(0);
      await expect(page.getByTestId("comments-panel")).toHaveCount(0);
    }
    expect(delta.after.focus, "double-click native focus").toBe("code");
    expect(delta.after.collapsed, "double-click native selection").toBe(false);

    await selectTextInRich(page, SELECTION_TEXT);
    const richLink = await hitPoint(page, ".md-rich", LINK_TEXT, { id: linkCommentId, kind: "comment", link: true });
    const dragStart = { x: richLink.left + Math.min(3, (richLink.right - richLink.left) / 4), y: richLink.y };
    const dragEnd = { x: richLink.right - Math.min(3, (richLink.right - richLink.left) / 4), y: richLink.y };
    delta = await recordGesture(page, context, counts["modified-link-drag"], { kind: "comment", id: linkCommentId }, () =>
      withModifier(page, ["Control"], async () => {
        await page.mouse.move(dragStart.x, dragStart.y);
        await page.mouse.down();
        await page.mouse.move(dragEnd.x, dragEnd.y, { steps: 6 });
        await page.mouse.up();
      }),
    );
    expect(delta.activations.length, "modified link-drag activation count").toBe(0);
    expect(delta.opens.length, "modified link-drag open count").toBe(0);
    expect(delta.after.selection === delta.before.selection, "modified link-drag selection change").toBe(false);
    expect(delta.after.collapsed, "modified link-drag selected text").toBe(false);
    expect(counts["modified-link-drag"].selectionChanges, "modified link-drag selection change count").toBe(1);
    await expect(page.getByTestId("comments-panel")).toHaveCount(0);
  } finally {
    console.log(JSON.stringify(summarize(counts)));
    await context?.close();
  }
});
