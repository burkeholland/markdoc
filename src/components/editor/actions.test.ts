// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EditorView as CMView } from "@codemirror/view";
import { EditorState } from "prosemirror-state";
import type { EditorView as PMView } from "prosemirror-view";
import type { CollabSession } from "@/editor/collab/session";
import { createCodeApi } from "@/editor/codemirror/api";
import { schema } from "@/editor/markdown/schema";
import { EditorActions } from "./actions";

const VIEWPORT = 600;
const LINE = 24;

interface Fixture {
  actions: EditorActions;
  code: CMView & { dispatch: ReturnType<typeof vi.fn>; focus: ReturnType<typeof vi.fn> };
  rich: PMView & { dispatch: ReturnType<typeof vi.fn>; focus: ReturnType<typeof vi.fn> };
  scroller: HTMLElement & { scrollTo: ReturnType<typeof vi.fn> };
  /** scrollTop as it was at the moment of each scrollTo call (i.e. after any instant jump). */
  scrollTopsAtScrollTo: number[];
  /** Where the commented line sits in the document, in px from the top of the scroll content. */
  lineTop: number;
}

/** Fake panes: a rich scroller whose target line is `lineTop` px down a 10 000 px document, and a code pane. */
function setup(opts: { surface?: "code" | "rich"; lineTop?: number; codeVisible?: boolean; richVisible?: boolean } = {}): Fixture {
  const lineTop = opts.lineTop ?? 8_000;
  const codeVisible = opts.codeVisible ?? true;
  const richVisible = opts.richVisible ?? true;
  const scrollTopsAtScrollTo: number[] = [];
  const doc = schema.node("doc", null, [schema.node("paragraph", null, [schema.text("Paragraph one. The quick brown fox.")])]);
  const state = EditorState.create({ doc });

  const scroller = document.createElement("div");
  Object.defineProperty(scroller, "clientHeight", { value: richVisible ? VIEWPORT : 0 });
  Object.defineProperty(scroller, "scrollHeight", { value: 10_000 });
  scroller.getBoundingClientRect = () => ({ top: 0, bottom: richVisible ? VIEWPORT : 0, height: richVisible ? VIEWPORT : 0, left: 0, right: 800, width: 800, x: 0, y: 0, toJSON: () => ({}) });
  const scrollTo = vi.fn((o: ScrollToOptions) => {
    scrollTopsAtScrollTo.push(scroller.scrollTop);
    scroller.scrollTop = Math.max(0, Math.min(10_000 - VIEWPORT, o.top ?? 0));
  });
  scroller.scrollTo = scrollTo as unknown as HTMLElement["scrollTo"];
  document.body.append(scroller);

  const richDom = document.createElement("div");
  const rich = {
    dom: richDom,
    state,
    isDestroyed: false,
    dispatch: vi.fn(),
    focus: vi.fn(),
    // The target line is at `lineTop` in document space; viewport-relative = lineTop - scrollTop.
    coordsAtPos: () => ({ top: lineTop - scroller.scrollTop, bottom: lineTop - scroller.scrollTop + LINE, left: 0, right: 0 }),
    domAtPos: () => ({ node: richDom, offset: 0 }),
  } as unknown as Fixture["rich"];
  document.body.append(richDom);

  const codeScroll = document.createElement("div");
  codeScroll.getBoundingClientRect = () => ({ top: 0, bottom: codeVisible ? VIEWPORT : 0, height: codeVisible ? VIEWPORT : 0, left: 0, right: 0, width: 0, x: 0, y: 0, toJSON: () => ({}) });
  const code = { state: { doc: { length: 1_000 } }, scrollDOM: codeScroll, dispatch: vi.fn(), focus: vi.fn() } as unknown as Fixture["code"];

  const session = {
    activeSurface: opts.surface ?? "rich",
    binding: { getSourceMap: () => ({ blocks: [{ from: 0, to: 35 }], segments: [], srcToPm: (n: number) => n + 1, pmToSrc: (n: number) => n - 1, blockIndexAt: () => 0 }) },
  } as unknown as CollabSession;
  const actions = new EditorActions(session, () => {});
  // The real API: the scroll effects asserted below come from CodeMirror itself (tests are not bundled).
  actions.setCodeView(code, createCodeApi());
  actions.setRichView(rich);
  actions.setRichScroller(scroller);
  return { actions, code, rich, scroller: scroller as unknown as Fixture["scroller"], scrollTopsAtScrollTo, lineTop };
}

/** scrollTop that centres the line. */
const centred = (lineTop: number) => lineTop + LINE / 2 - VIEWPORT / 2;

const cmScrollEffects = (code: Fixture["code"]) => {
  const spec = code.dispatch.mock.calls[0]?.[0] as { effects?: unknown } | undefined;
  const effects = spec?.effects;
  return Array.isArray(effects) ? effects.length : effects ? 1 : 0;
};

describe("EditorActions.revealSource (#992)", () => {
  let frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 1;
  let now = 0;
  beforeEach(() => {
    frames = new Map();
    now = 1_000;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      frames.set(nextFrame, cb);
      return nextFrame++;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => {
      frames.delete(id);
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });
  /** Run one animation frame, 100 ms after the previous one. */
  const frame = () => {
    now += 100;
    const pending = [...frames.values()];
    frames.clear();
    for (const cb of pending) cb(now);
  };

  it("scrolls the rich pane's own scroller so the commented line ends up centred, capping the glide to one viewport", () => {
    const { actions, scroller, rich, lineTop, scrollTopsAtScrollTo } = setup();
    actions.revealSource(16, { focus: true });

    expect(rich.focus).toHaveBeenCalled();
    expect(rich.dispatch).toHaveBeenCalledTimes(1);
    expect(scroller.scrollTo).toHaveBeenCalledTimes(1);
    const call = scroller.scrollTo.mock.calls[0][0] as ScrollToOptions;
    expect(call.behavior).toBe("smooth");
    expect(call.top).toBe(centred(lineTop));
    // 7 412 px away: jump instantly to one viewport short of the target, then glide the last 600 px.
    expect(scrollTopsAtScrollTo).toEqual([centred(lineTop) - VIEWPORT]);
    expect(scroller.scrollTop).toBe(centred(lineTop));
  });

  it("glides the whole way when the target is less than a viewport away", () => {
    const { actions, scroller, lineTop, scrollTopsAtScrollTo } = setup({ lineTop: 700 });
    actions.revealSource(16);
    expect(scroller.scrollTo).toHaveBeenCalledWith({ top: centred(lineTop), behavior: "smooth" });
    expect(scrollTopsAtScrollTo).toEqual([0]);
  });

  it("does not scroll at all when the line already sits in the middle of the pane", () => {
    const { actions, scroller, lineTop } = setup();
    scroller.scrollTop = centred(lineTop) + 40;
    actions.revealSource(16);
    expect(scroller.scrollTo).not.toHaveBeenCalled();
    expect(frames.size).toBe(0);
  });

  it("with scroll sync on, only the active surface scrolls itself", () => {
    const richActive = setup({ surface: "rich" });
    richActive.actions.setScrollSynced(true);
    richActive.actions.revealSource(16);
    expect(richActive.scroller.scrollTo).toHaveBeenCalledTimes(1);
    expect(cmScrollEffects(richActive.code)).toBe(0);
    expect(richActive.code.dispatch.mock.calls[0][0]).toMatchObject({ selection: { anchor: 16 } });

    const codeActive = setup({ surface: "code" });
    codeActive.actions.setScrollSynced(true);
    codeActive.actions.revealSource(16);
    expect(codeActive.scroller.scrollTo).not.toHaveBeenCalled();
    expect(cmScrollEffects(codeActive.code)).toBe(1);
  });

  it("with scroll sync off, both visible panes scroll", () => {
    const { actions, scroller, code } = setup({ surface: "rich" });
    actions.revealSource(16);
    expect(scroller.scrollTo).toHaveBeenCalledTimes(1);
    expect(cmScrollEffects(code)).toBe(1);
  });

  it("re-centres once, instantly, if something moved the pane off the target after the glide settled", () => {
    const { actions, scroller, lineTop } = setup();
    actions.revealSource(16);
    // A scroll-sync mirror (or layout shift) yanks the pane to a top-aligned position mid-flight.
    scroller.scrollTop = lineTop;
    frame(); // 100 ms: too early to call it settled
    frame(); // 200 ms
    expect(scroller.scrollTo).toHaveBeenCalledTimes(1);
    frame(); // 300 ms, unchanged for two frames: settled off target
    expect(scroller.scrollTo).toHaveBeenCalledTimes(2);
    expect(scroller.scrollTo.mock.calls[1][0]).toEqual({ top: centred(lineTop), behavior: "auto" });
    expect(frames.size).toBe(0);
  });

  it("does not mistake a glide that is slow to start for a settled one", () => {
    const { actions, scroller, lineTop } = setup();
    actions.revealSource(16);
    // The fake scrollTo landed instantly; pretend the animator has not moved yet, then glides late.
    scroller.scrollTop = centred(lineTop) - VIEWPORT;
    frame(); // 100 ms, no movement
    frame(); // 200 ms, still none: a real glide may take this long to move a pixel
    expect(scroller.scrollTo).toHaveBeenCalledTimes(1);
    scroller.scrollTop = centred(lineTop) - 300;
    frame(); // 300 ms, moving
    scroller.scrollTop = centred(lineTop);
    frame(); // 400 ms, arrived
    frame();
    frame(); // unchanged for two frames on target: nothing to correct
    expect(scroller.scrollTo).toHaveBeenCalledTimes(1);
    expect(frames.size).toBe(0);
  });

  it("leaves the pane alone once the glide settles on target", () => {
    const { actions, scroller } = setup();
    actions.revealSource(16);
    for (let i = 0; i < 6; i++) frame();
    expect(scroller.scrollTo).toHaveBeenCalledTimes(1);
    expect(frames.size).toBe(0);
  });

  it("stops watching when the user scrolls the pane", () => {
    const { actions, scroller, lineTop } = setup();
    actions.revealSource(16);
    scroller.dispatchEvent(new Event("wheel"));
    scroller.scrollTop = lineTop;
    for (let i = 0; i < 6; i++) frame();
    expect(scroller.scrollTo).toHaveBeenCalledTimes(1);
  });

  it("focuses and scrolls the code pane when the rich pane is hidden", () => {
    const { actions, scroller, code, rich } = setup({ richVisible: false, surface: "rich" });
    actions.revealSource(16, { focus: true });
    expect(code.focus).toHaveBeenCalled();
    expect(rich.focus).not.toHaveBeenCalled();
    expect(cmScrollEffects(code)).toBe(1);
    expect(scroller.scrollTo).not.toHaveBeenCalled();
  });

  it("leaves the hidden code pane alone in the text layout", () => {
    const { actions, scroller, code } = setup({ codeVisible: false });
    actions.revealSource(16);
    expect(cmScrollEffects(code)).toBe(0);
    expect(scroller.scrollTo).toHaveBeenCalledTimes(1);
  });
});
