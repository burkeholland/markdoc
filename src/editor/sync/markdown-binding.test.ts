// @vitest-environment jsdom
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import * as Y from "yjs";
import { EditorState, Plugin, TextSelection } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import type { Node as PMNode } from "prosemirror-model";
import { splitBlock, setBlockType } from "prosemirror-commands";
import {
  MarkdownBinding,
  markdownBindingPlugin,
  minimalReplaceTransaction,
  isStructuralChange,
  localDocChange,
  SOURCE_MAP_MAX_RETAINED_DOCUMENTS,
  STALE_OPERATION_MAX_SOURCE_UNITS,
  VERIFY_TRUST_AFTER,
  VERIFY_EVERY_NTH_WINDOW,
} from "./markdown-binding";
import { schema } from "../markdown/schema";
import { parseMarkdown } from "../markdown/parse";
import { serializeBlocks } from "../markdown/serialize";
import { insertHardBreak } from "../prosemirror/commands";
import { textChangeSpan } from "../markdown/incremental";
import { diffOps, diffOpsWords, applyOps } from "./text-diff";

function makeEditor(ytext: Y.Text) {
  const binding = new MarkdownBinding(ytext);
  const state = EditorState.create({ doc: binding.initialDoc(), plugins: [markdownBindingPlugin(binding)] });
  const view = new EditorView(document.createElement("div"), { state });
  return { binding, view };
}

function typeText(view: EditorView, text: string, at?: number) {
  const tr = view.state.tr;
  if (at !== undefined) tr.setSelection(TextSelection.create(tr.doc, at));
  tr.insertText(text);
  view.dispatch(tr);
}

const RAW_LINE_POSITIONS = [
  { label: "first", before: 0, after: 0 },
  { label: "middle", before: 500, after: 500 },
  { label: "late", before: 1_000, after: 0 },
] as const;

const STALE_MATRIX_BLOCK = "0abcdefgh9 **bold** [link](x) ![](i) `code` 😀";
const STALE_MATRIX_MARKERS = [
  ">",
  "# ",
  "- ",
  "* ",
  "1. ",
  "```",
  "---",
  "[x](y)",
  "![](x)",
  "**",
  "`x`",
  "😀",
] as const;
const STALE_MATRIX_LOCATIONS = [
  { label: "before", offset: 1 },
  { label: "at-start", offset: 2 },
  { label: "inside-start", offset: 3 },
  { label: "middle", offset: 5 },
  { label: "inside-end", offset: 7 },
  { label: "at-end", offset: 8 },
  { label: "after", offset: 9 },
] as const;
const STALE_MATRIX_CASES = ["insert", "delete", "replace"].flatMap((localOperation, localIndex) =>
  ["insert", "delete", "replace"].flatMap((remoteOperation, remoteIndex) =>
    ["first", "middle", "last"].flatMap((block, blockIndex) =>
      STALE_MATRIX_LOCATIONS.map((location, locationIndex) => ({
        label: `${localOperation}/${remoteOperation}/${location.label}/${block}`,
        localOperation,
        remoteOperation,
        blockIndex,
        remoteOffset: location.offset,
        localInsert:
          localOperation === "delete"
            ? ""
            : STALE_MATRIX_MARKERS[
                (localIndex * 63 + remoteIndex * 21 + blockIndex * 7 + locationIndex) %
                  STALE_MATRIX_MARKERS.length
              ],
      })),
    ),
  ),
);

function rawLineFixture(before: number, after: number, separator = ""): string {
  return [
    ...Array.from({ length: before }, (_, index) => `Prefix paragraph ${index}.`),
    `pl${separator}ain text`,
    "# H",
    ...Array.from({ length: after }, (_, index) => `Suffix paragraph ${index}.`),
  ].join("\n\n");
}

function expectParagraphFastPathRejected(binding: MarkdownBinding) {
  expect(binding["mapCache"]).toBeNull();
  expect(binding["headingsCache"]).toBeNull();
}

function expectCanonicalBinding(binding: MarkdownBinding, view: EditorView, source: string, headingLine: number) {
  const canonical = parseMarkdown(source);
  expect(binding.ytext.toString()).toBe(source);
  expect(view.state.doc.toJSON()).toEqual(canonical.doc.toJSON());
  expect(view.state.doc.textContent).toBe(canonical.doc.textContent);
  expect(binding.blocks).toEqual(canonical.map.blocks);

  const map = binding.getSourceMap();
  expect(map.blocks).toEqual(canonical.map.blocks);
  const sourceEndpoints = new Set([0, source.length]);
  for (const block of canonical.map.blocks) {
    sourceEndpoints.add(block.from);
    sourceEndpoints.add(block.to);
  }
  for (const offset of sourceEndpoints) expect(map.srcToPm(offset), `source endpoint ${offset}`).toBe(canonical.map.srcToPm(offset));

  const pmEndpoints = new Set([0, canonical.doc.content.size]);
  let pos = 0;
  canonical.doc.forEach((node) => {
    pmEndpoints.add(pos);
    pos += node.nodeSize;
    pmEndpoints.add(pos);
  });
  for (const endpoint of pmEndpoints) expect(map.pmToSrc(endpoint), `rich endpoint ${endpoint}`).toBe(canonical.map.pmToSrc(endpoint));

  expect(binding.getHeadings()).toEqual(canonical.headings);
  expect(binding.getHeadings().find((heading) => heading.text === "H")?.line).toBe(headingLine);
}

function expectCompleteCanonicalMap(binding: MarkdownBinding, view: EditorView, source: string) {
  const canonical = parseMarkdown(source);
  const map = binding.getSourceMap();
  expect(map.blocks).toEqual(canonical.map.blocks);
  expect(map.segments).toEqual(canonical.map.segments);
  for (let offset = 0; offset <= source.length; offset++) {
    expect(map.srcToPm(offset), `source offset ${offset}`).toBe(canonical.map.srcToPm(offset));
  }
  for (let pos = 0; pos <= view.state.doc.content.size; pos++) {
    expect(map.pmToSrc(pos), `rich position ${pos}`).toBe(canonical.map.pmToSrc(pos));
  }
}

describe("diffOps", () => {
  it("produces minimal operations", () => {
    expect(diffOps("hello world", "hello brave world", 10)).toEqual([{ index: 16, deleteCount: 0, insert: "brave " }]);
    expect(diffOps("abc", "axc")).toEqual([{ index: 1, deleteCount: 1, insert: "x" }]);
    expect(diffOps("same", "same")).toEqual([]);
  });

  it("produces word-level operations that apply cleanly", () => {
    const oldText = "# Draft\n\nSecond version by the agent.\n\n- Ship\n";
    const newText = "# Draft\n\nImproved version by the agent.\n\n- Ship it to everyone\n";
    const ops = diffOpsWords(oldText, newText);
    expect(ops).toEqual([
      { index: 9, deleteCount: 6, insert: "Improved" },
      { index: 47, deleteCount: 0, insert: " it to everyone" },
    ]);
    const ydoc = new Y.Doc();
    const ytext = ydoc.getText("t");
    ytext.insert(0, oldText);
    applyOps(ytext, ops);
    expect(ytext.toString()).toBe(newText);
    expect(diffOpsWords("same", "same")).toEqual([]);
  });
});

describe("MarkdownBinding", () => {
  let ydoc: Y.Doc;
  let ytext: Y.Text;
  const views: EditorView[] = [];
  const bindings: MarkdownBinding[] = [];

  beforeEach(() => {
    ydoc = new Y.Doc();
    ytext = ydoc.getText("content");
  });
  afterEach(() => {
    for (const v of views) v.destroy();
    for (const b of bindings) b.destroy();
    views.length = 0;
    bindings.length = 0;
  });

  const editor = (t: Y.Text = ytext) => {
    const e = makeEditor(t);
    views.push(e.view);
    bindings.push(e.binding);
    return e;
  };

  it("builds the initial document from the text", () => {
    ytext.insert(0, "# Title\n\nHello **world**.");
    const { view, binding } = editor();
    expect(view.state.doc.childCount).toBe(2);
    expect(view.state.doc.child(0).type.name).toBe("heading");
    expect(binding.blocks).toEqual([
      { from: 0, to: 7 },
      { from: 9, to: 25 },
    ]);
  });

  it("applies local typing to the text as a minimal diff", () => {
    ytext.insert(0, "# Title\n\nHello world.");
    const { view, binding } = editor();
    const updates: Uint8Array[] = [];
    ydoc.on("update", (u: Uint8Array) => updates.push(u));
    // Insert after "Hello" in the paragraph: heading nodeSize 7, paragraph starts at 7, text at 8.
    typeText(view, ",", 8 + 5);
    expect(ytext.toString()).toBe("# Title\n\nHello, world.");
    expect(binding.blocks).toEqual([
      { from: 0, to: 7 },
      { from: 9, to: 22 },
    ]);
    expect(updates.length).toBe(1);
  });

  it.each([
    ["first", 0],
    ["middle", 500],
    ["last", 999],
  ])("uses the optimized path without full-document work at the %s paragraph", (_label, paragraphIndex) => {
    const source = Array.from(
      { length: 1_000 },
      (_, index) => `Paragraph ${index} keeps long document typing ${index % 2 === 0 ? "**responsive**" : "[responsive](https://example.com)"} today.`,
    ).join("\n\n");
    ytext.insert(0, source);
    const binding = new MarkdownBinding(ytext);
    bindings.push(binding);
    const before = EditorState.create({ doc: binding.initialDoc() });
    const map = binding.getSourceMap();
    const paragraph = `Paragraph ${paragraphIndex}`;
    const sourceOffset = source.indexOf(paragraph) + paragraph.length;
    const position = map.srcToPm(sourceOffset);
    const tr = before.tr.insertText("x", position);
    const after = before.apply(tr);
    const change = localDocChange(tr, before.doc, after.doc);
    expect(change).toMatchObject({
      before: before.doc,
      after: after.doc,
      start: position,
      endA: position,
      endB: position + 1,
    });

    const fragment = Object.getPrototypeOf(before.doc.content) as {
      findDiffStart: (...args: unknown[]) => unknown;
      findDiffEnd: (...args: unknown[]) => unknown;
    };
    const findDiffStart = vi.spyOn(fragment, "findDiffStart");
    const findDiffEnd = vi.spyOn(fragment, "findDiffEnd");
    const materialize = vi.spyOn(ytext as unknown as { toString: () => string }, "toString");
    const parse = vi.fn(binding["parse"].bind(binding));
    const buildDoc = vi.fn(binding["buildDoc"].bind(binding));
    binding["parse"] = parse;
    binding["buildDoc"] = buildDoc;
    expect(binding.handleLocalTransaction(before, after, change)).toBe(true);
    const mapped = binding.getSourceMap();
    expect(findDiffStart).not.toHaveBeenCalled();
    expect(findDiffEnd).not.toHaveBeenCalled();
    expect(materialize).not.toHaveBeenCalled();
    expect(parse).not.toHaveBeenCalled();
    expect(buildDoc).not.toHaveBeenCalled();
    expect(binding["mapCache"]?.map).toBe(mapped);
    materialize.mockRestore();
    expect(ytext.toString()).toBe(source.slice(0, sourceOffset) + "x" + source.slice(sourceOffset));
    findDiffStart.mockRestore();
    findDiffEnd.mockRestore();
  });

  it("revalidates a local fast-path authorization after an intervening remote generation", async () => {
    ytext.insert(0, "a\n\nb");
    const { view, binding } = editor();
    binding.getSourceMap();
    const before = view.state;
    const tr = before.tr.insertText("x", 2);
    const after = before.apply(tr);
    const change = binding.authorizeLocalChange(localDocChange(tr, before.doc, after.doc)!);
    expect(change.authorization).not.toBeNull();

    const remote = new Y.Doc();
    Y.applyUpdate(remote, Y.encodeStateAsUpdate(ydoc));
    const vector = Y.encodeStateVector(ydoc);
    remote.getText("content").insert(remote.getText("content").length, "R");
    Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(remote, vector));
    expect(ytext.toString()).toBe("a\n\nbR");

    expect(binding.handleLocalTransaction(before, after, change)).toBe(true);
    await new Promise<void>((resolve) => queueMicrotask(resolve));

    expect(ytext.toString()).toBe("ax\n\nbR");
    const canonical = parseMarkdown("ax\n\nbR");
    expect(binding["currentDoc"]?.toJSON()).toEqual(canonical.doc.toJSON());
    expect(view.state.doc.toJSON()).toEqual(canonical.doc.toJSON());
    expectCompleteCanonicalMap(binding, view, "ax\n\nbR");
    remote.destroy();
  });

  it.each([
    ["delete", ""],
    ["replace", "LOCAL"],
  ])(
    "preserves a concurrent interior insert when a stale local %s removes only original items",
    async (_label, localInsert) => {
      ytext.insert(0, "abcd");
      const { view, binding } = editor();
      binding.getSourceMap();
      const before = view.state;
      const tr = before.tr.insertText(localInsert, 2, 4);
      const after = before.apply(tr);
      const change = binding.authorizeLocalChange(localDocChange(tr, before.doc, after.doc)!);
      expect(change.authorization).not.toBeNull();

      const remote = new Y.Doc();
      Y.applyUpdate(remote, Y.encodeStateAsUpdate(ydoc));
      const oracleLocal = new Y.Doc();
      Y.applyUpdate(oracleLocal, Y.encodeStateAsUpdate(ydoc));
      oracleLocal.clientID = ydoc.clientID;
      const oracleRemote = new Y.Doc();
      Y.applyUpdate(oracleRemote, Y.encodeStateAsUpdate(ydoc));
      oracleRemote.clientID = remote.clientID;
      const oracleLocalVector = Y.encodeStateVector(oracleLocal);
      const oracleRemoteVector = Y.encodeStateVector(oracleRemote);
      oracleLocal.transact(() => {
        const text = oracleLocal.getText("content");
        text.delete(1, 2);
        if (localInsert) text.insert(1, localInsert);
      });
      oracleRemote.getText("content").insert(2, "REMOTE");
      Y.applyUpdate(oracleLocal, Y.encodeStateAsUpdate(oracleRemote, oracleRemoteVector));
      Y.applyUpdate(oracleRemote, Y.encodeStateAsUpdate(oracleLocal, oracleLocalVector));
      const oracle = oracleLocal.getText("content").toString();
      expect(oracleRemote.getText("content").toString()).toBe(oracle);

      const remoteVector = Y.encodeStateVector(ydoc);
      remote.getText("content").insert(2, "REMOTE");
      Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(remote, remoteVector));
      expect(ytext.toString()).toBe("abREMOTEcd");
      const observedBindingWrites: string[] = [];
      const observer = (_event: Y.YTextEvent, transaction: Y.Transaction) => {
        if (transaction.origin === binding) observedBindingWrites.push(ytext.toString());
      };
      ytext.observe(observer);

      expect(binding.handleLocalTransaction(before, after, change)).toBe(true);
      await new Promise<void>((resolve) => queueMicrotask(resolve));
      Y.applyUpdate(remote, Y.encodeStateAsUpdate(ydoc));

      expect(oracle).toBe(localInsert ? "aREMOTELOCALd" : "aREMOTEd");
      expect(observedBindingWrites).toEqual([oracle]);
      expect(ytext.toString()).toBe(oracle);
      expect(remote.getText("content").toString()).toBe(oracle);
      expect(oracle.match(/REMOTE/g)).toHaveLength(1);
      if (localInsert) expect(oracle.match(/LOCAL/g)).toHaveLength(1);
      expect(oracle).not.toContain("b");
      expect(oracle).not.toContain("c");
      const canonical = parseMarkdown(oracle);
      expect(view.state.doc.toJSON()).toEqual(canonical.doc.toJSON());
      expect(binding["currentDoc"]?.toJSON()).toEqual(canonical.doc.toJSON());
      expect(binding.blocks).toEqual(canonical.map.blocks);
      expectCompleteCanonicalMap(binding, view, oracle);
      ytext.unobserve(observer);
      remote.destroy();
      oracleLocal.destroy();
      oracleRemote.destroy();
    },
  );

  it.each(STALE_MATRIX_CASES)(
    "preserves exact ownership for stale $label",
    async ({ localOperation, remoteOperation, blockIndex, remoteOffset, localInsert }) => {
      const source = [STALE_MATRIX_BLOCK, STALE_MATRIX_BLOCK, STALE_MATRIX_BLOCK].join("\n\n");
      ytext.insert(0, source);
      const { view, binding } = editor();
      const map = binding.getSourceMap();
      const blockStart = blockIndex * (STALE_MATRIX_BLOCK.length + 2);
      const rangeFrom = blockStart + 2;
      const rangeTo = blockStart + 8;
      const localFrom = map.srcToPm(rangeFrom);
      const localTo =
        localOperation === "insert" ? localFrom : map.srcToPm(rangeTo);
      const before = view.state;
      const tr =
        localOperation !== "insert" && remoteOffset % 2 === 1
          ? before.tr
              .setSelection(TextSelection.create(before.doc, localTo, localFrom))
              .insertText(localInsert)
          : before.tr.insertText(localInsert, localFrom, localTo);
      const after = before.apply(tr);
      const change = binding.authorizeLocalChange(localDocChange(tr, before.doc, after.doc)!);
      expect(change.authorization, `authorization for ${localOperation}`).not.toBeNull();

      const remote = new Y.Doc();
      Y.applyUpdate(remote, Y.encodeStateAsUpdate(ydoc));
      const oracleSeed = new Y.Doc();
      Y.applyUpdate(oracleSeed, Y.encodeStateAsUpdate(ydoc));
      const oracleLocal = new Y.Doc();
      Y.applyUpdate(oracleLocal, Y.encodeStateAsUpdate(oracleSeed));
      oracleLocal.clientID = ydoc.clientID;
      const oracleRemote = new Y.Doc();
      Y.applyUpdate(oracleRemote, Y.encodeStateAsUpdate(oracleSeed));
      oracleRemote.clientID = remote.clientID;
      const oracleRemoteVector = Y.encodeStateVector(oracleRemote);
      const oracleText = oracleLocal.getText("content");
      const oracleAnchor = Y.createRelativePositionFromTypeIndex(
        oracleText,
        localOperation === "insert" ? rangeFrom : rangeTo,
        localOperation === "insert" ? 0 : -1,
      );
      const oracleUnits =
        localOperation === "insert"
          ? []
          : Array.from({ length: rangeTo - rangeFrom }, (_, offset) => ({
              from: Y.createRelativePositionFromTypeIndex(
                oracleText,
                rangeFrom + offset,
              ),
              to: Y.createRelativePositionFromTypeIndex(
                oracleText,
                rangeFrom + offset + 1,
                -1,
              ),
            }));
      oracleRemote.transact(() => {
        const text = oracleRemote.getText("content");
        const position = blockStart + remoteOffset;
        if (remoteOperation !== "insert") text.delete(position, 1);
        if (remoteOperation !== "delete") text.insert(position, "REMOTE");
      });
      Y.applyUpdate(
        oracleLocal,
        Y.encodeStateAsUpdate(oracleRemote, oracleRemoteVector),
      );
      oracleLocal.transact(() => {
        const ranges = oracleUnits
          .map((unit) => {
            const from = Y.createAbsolutePositionFromRelativePosition(
              unit.from,
              oracleLocal,
              false,
            )!.index;
            const to = Y.createAbsolutePositionFromRelativePosition(
              unit.to,
              oracleLocal,
              false,
            )!.index;
            return { from: Math.min(from, to), to: Math.max(from, to) };
          })
          .filter((range) => range.to > range.from)
          .sort((left, right) => right.from - left.from);
        for (const range of ranges) {
          oracleText.delete(range.from, range.to - range.from);
        }
        if (localInsert) {
          const absolute = Y.createAbsolutePositionFromRelativePosition(
            oracleAnchor,
            oracleLocal,
            false,
          );
          expect(absolute).not.toBeNull();
          oracleText.insert(absolute!.index, localInsert);
        }
      });
      Y.applyUpdate(oracleRemote, Y.encodeStateAsUpdate(oracleLocal));
      const oracleSource = oracleLocal.getText("content").toString();
      expect(oracleRemote.getText("content").toString()).toBe(oracleSource);
      const expectedTargetText = oracleSource.slice(
        blockStart,
        oracleSource.indexOf(" **bold**", blockStart),
      );

      const remoteVector = Y.encodeStateVector(ydoc);
      remote.transact(() => {
        const text = remote.getText("content");
        const position = blockStart + remoteOffset;
        if (remoteOperation !== "insert") text.delete(position, 1);
        if (remoteOperation !== "delete") text.insert(position, "REMOTE");
      });
      Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(remote, remoteVector));
      const observedBindingWrites: string[] = [];
      const observer = (_event: Y.YTextEvent, transaction: Y.Transaction) => {
        if (transaction.origin === binding) observedBindingWrites.push(ytext.toString());
      };
      ytext.observe(observer);

      binding.handleLocalTransaction(before, after, change);
      await new Promise<void>((resolve) => queueMicrotask(resolve));
      Y.applyUpdate(remote, Y.encodeStateAsUpdate(ydoc));

      const finalSource = ytext.toString();
      const canonical = parseMarkdown(finalSource);
      const target = view.state.doc.child(blockIndex);
      expect(
        target.textContent.startsWith(expectedTargetText),
        JSON.stringify({ expectedTargetText, actualTargetText: target.textContent }),
      ).toBe(true);
      expect(remote.getText("content").toString()).toBe(finalSource);
      if (remoteOperation !== "delete") {
        expect(target.textContent.match(/REMOTE/g)).toHaveLength(1);
      }
      expect(observedBindingWrites).toHaveLength(1);
      if (observedBindingWrites.length > 0) {
        expect(parseMarkdown(observedBindingWrites[0]).doc.toJSON()).toEqual(
          canonical.doc.toJSON(),
        );
      }
      expect(view.state.doc.toJSON()).toEqual(canonical.doc.toJSON());
      expect(binding["currentDoc"]?.toJSON()).toEqual(canonical.doc.toJSON());
      expect(binding.blocks).toEqual(canonical.map.blocks);
      expectCompleteCanonicalMap(binding, view, finalSource);
      ytext.unobserve(observer);
      remote.destroy();
      oracleSeed.destroy();
      oracleLocal.destroy();
      oracleRemote.destroy();
    },
  );

  it("covers at least 120 deterministic stale operation combinations", () => {
    expect(STALE_MATRIX_CASES).toHaveLength(189);
  });

  it.each([
    ["delete after remote deletion", "", ""],
    ["replace after remote deletion", "", "LOCAL"],
    ["delete after remote replacement", "REMOTE", ""],
    ["replace after remote replacement", "REMOTE", "LOCAL"],
  ])(
    "preserves remote content when original selected items are absent: %s",
    async (_label, remoteInsert, localInsert) => {
      ytext.insert(0, "abcd");
      const { view, binding } = editor();
      binding.getSourceMap();
      const before = view.state;
      const tr = before.tr.insertText(localInsert, 2, 4);
      const after = before.apply(tr);
      const change = binding.authorizeLocalChange(localDocChange(tr, before.doc, after.doc)!);

      const remote = new Y.Doc();
      Y.applyUpdate(remote, Y.encodeStateAsUpdate(ydoc));
      const vector = Y.encodeStateVector(ydoc);
      remote.transact(() => {
        const text = remote.getText("content");
        text.delete(1, 2);
        if (remoteInsert) text.insert(1, remoteInsert);
      });
      Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(remote, vector));

      binding.handleLocalTransaction(before, after, change);
      await new Promise<void>((resolve) => queueMicrotask(resolve));
      Y.applyUpdate(remote, Y.encodeStateAsUpdate(ydoc));

      const finalSource = ytext.toString();
      const canonical = parseMarkdown(finalSource);
      if (remoteInsert) expect(finalSource.match(/REMOTE/g)).toHaveLength(1);
      if (localInsert) expect(finalSource.match(/LOCAL/g)).toHaveLength(1);
      expect(finalSource).not.toContain("b");
      expect(finalSource).not.toContain("c");
      expect(remote.getText("content").toString()).toBe(finalSource);
      expect(view.state.doc.toJSON()).toEqual(canonical.doc.toJSON());
      expectCompleteCanonicalMap(binding, view, finalSource);
      remote.destroy();
    },
  );

  it("keeps selective stale replacement as one undo step around remote history", async () => {
    ytext.insert(0, "abcd");
    const { view, binding } = editor();
    const undo = new Y.UndoManager(ytext, { trackedOrigins: new Set([binding]) });
    binding.getSourceMap();
    const before = view.state;
    const tr = before.tr.insertText("LOCAL", 2, 4);
    const after = before.apply(tr);
    const change = binding.authorizeLocalChange(localDocChange(tr, before.doc, after.doc)!);

    const remote = new Y.Doc();
    Y.applyUpdate(remote, Y.encodeStateAsUpdate(ydoc));
    let vector = Y.encodeStateVector(ydoc);
    remote.getText("content").insert(2, "REMOTE");
    Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(remote, vector));
    expect(binding.handleLocalTransaction(before, after, change)).toBe(true);
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(ytext.toString()).toBe("aREMOTELOCALd");

    undo.stopCapturing();
    undo.undo();
    expect(ytext.toString()).toBe("abREMOTEcd");
    undo.redo();
    expect(ytext.toString()).toBe("aREMOTELOCALd");
    vector = Y.encodeStateVector(ydoc);
    remote.getText("content").insert(remote.getText("content").length, "Q");
    Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(remote, vector));

    expect(ytext.toString()).toBe("aREMOTELOCALdQ");
    expect(view.state.doc.toJSON()).toEqual(parseMarkdown(ytext.toString()).doc.toJSON());
    expectCompleteCanonicalMap(binding, view, ytext.toString());
    undo.destroy();
    remote.destroy();
  });

  it("retains the collaborator's original Yjs insertion identity", async () => {
    ytext.insert(0, "abcd");
    const { view, binding } = editor();
    binding.getSourceMap();
    const before = view.state;
    const tr = before.tr.insertText("LOCAL", 2, 4);
    const after = before.apply(tr);
    const change = binding.authorizeLocalChange(localDocChange(tr, before.doc, after.doc)!);

    const remote = new Y.Doc();
    Y.applyUpdate(remote, Y.encodeStateAsUpdate(ydoc));
    const remoteOrigin = {};
    const remoteUndo = new Y.UndoManager(remote.getText("content"), {
      trackedOrigins: new Set([remoteOrigin]),
    });
    const vector = Y.encodeStateVector(ydoc);
    remote.transact(() => remote.getText("content").insert(2, "REMOTE"), remoteOrigin);
    remoteUndo.stopCapturing();
    Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(remote, vector));
    expect(binding.handleLocalTransaction(before, after, change)).toBe(true);
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    Y.applyUpdate(remote, Y.encodeStateAsUpdate(ydoc));
    expect(remote.getText("content").toString()).toBe("aREMOTELOCALd");

    const bindingVector = Y.encodeStateVector(ydoc);
    remoteUndo.undo();
    expect(remote.getText("content").toString()).toBe("aLOCALd");
    Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(remote, bindingVector));

    expect(ytext.toString()).toBe("aLOCALd");
    expect(view.state.doc.toJSON()).toEqual(parseMarkdown("aLOCALd").doc.toJSON());
    remoteUndo.destroy();
    remote.destroy();
  });

  it("passes selective stale operations to interceptors without consuming remote inserts", async () => {
    ytext.insert(0, "abcd");
    const { view, binding } = editor();
    const seen: Array<{ index: number; deleteCount: number; insert: string }> = [];
    binding.setInterceptor((ops, text, origin) => {
      seen.push(...ops);
      text.doc!.transact(() => applyOps(text, ops), origin);
      return true;
    });
    binding.getSourceMap();
    const before = view.state;
    const tr = before.tr.insertText("LOCAL", 2, 4);
    const after = before.apply(tr);
    const change = binding.authorizeLocalChange(localDocChange(tr, before.doc, after.doc)!);

    const remote = new Y.Doc();
    Y.applyUpdate(remote, Y.encodeStateAsUpdate(ydoc));
    const vector = Y.encodeStateVector(ydoc);
    remote.getText("content").insert(2, "REMOTE");
    Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(remote, vector));
    expect(binding.handleLocalTransaction(before, after, change)).toBe(true);
    await new Promise<void>((resolve) => queueMicrotask(resolve));

    expect(seen).toEqual([
      { index: 1, deleteCount: 1, insert: "" },
      { index: 7, deleteCount: 1, insert: "LOCAL" },
    ]);
    expect(ytext.toString()).toBe("aREMOTELOCALd");
    expect(view.state.doc.toJSON()).toEqual(parseMarkdown(ytext.toString()).doc.toJSON());
    remote.destroy();
  });

  it("preserves an interior remote insert when a metadata-only transaction is appended", async () => {
    ytext.insert(0, "abcd");
    const binding = new MarkdownBinding(ytext);
    bindings.push(binding);
    const initial = binding.initialDoc();
    binding.getSourceMap();
    const remote = new Y.Doc();
    Y.applyUpdate(remote, Y.encodeStateAsUpdate(ydoc));
    let appended = false;
    const appendRemote = new Plugin({
      appendTransaction(transactions, _oldState, newState) {
        if (appended || !transactions.some((transaction) => transaction.docChanged)) return null;
        appended = true;
        const vector = Y.encodeStateVector(ydoc);
        remote.getText("content").insert(2, "REMOTE");
        Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(remote, vector));
        return newState.tr.setMeta("remote-inserted", true);
      },
    });
    const state = EditorState.create({
      doc: initial,
      plugins: [appendRemote, markdownBindingPlugin(binding)],
    });
    const view = new EditorView(document.createElement("div"), { state });
    views.push(view);

    view.dispatch(view.state.tr.insertText("LOCAL", 2, 4));
    await new Promise<void>((resolve) => queueMicrotask(resolve));

    expect(ytext.toString()).toBe("aREMOTELOCALd");
    expect(view.state.doc.toJSON()).toEqual(parseMarkdown(ytext.toString()).doc.toJSON());
    expectCompleteCanonicalMap(binding, view, ytext.toString());
    remote.destroy();
  });

  it("selectively rebases across a hard break and a surrogate pair", async () => {
    const source = "abcdefgh\\\ntail 😀";
    ytext.insert(0, source);
    const { view, binding } = editor();
    const map = binding.getSourceMap();
    const before = view.state;
    const tr = before.tr.insertText("LOCAL", map.srcToPm(1), map.srcToPm(7));
    const after = before.apply(tr);
    const change = binding.authorizeLocalChange(localDocChange(tr, before.doc, after.doc)!);
    expect(change.authorization).not.toBeNull();

    const remote = new Y.Doc();
    Y.applyUpdate(remote, Y.encodeStateAsUpdate(ydoc));
    const vector = Y.encodeStateVector(ydoc);
    remote.getText("content").insert(4, "REMOTE");
    Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(remote, vector));
    expect(binding.handleLocalTransaction(before, after, change)).toBe(true);
    await new Promise<void>((resolve) => queueMicrotask(resolve));

    expect(ytext.toString()).toBe("aREMOTELOCALh\\\ntail 😀");
    expect(view.state.doc.toJSON()).toEqual(parseMarkdown(ytext.toString()).doc.toJSON());
    expectCompleteCanonicalMap(binding, view, ytext.toString());
    remote.destroy();
  });

  it("keeps local and remote intent when the surrounding block is structurally replaced", async () => {
    const source = "before\n\nabcdefgh\n\nafter";
    ytext.insert(0, source);
    const { view, binding } = editor();
    const map = binding.getSourceMap();
    const before = view.state;
    const tr = before.tr.insertText("LOCAL", map.srcToPm(9), map.srcToPm(15));
    const after = before.apply(tr);
    const change = binding.authorizeLocalChange(localDocChange(tr, before.doc, after.doc)!);
    expect(change.authorization).not.toBeNull();

    const remote = new Y.Doc();
    Y.applyUpdate(remote, Y.encodeStateAsUpdate(ydoc));
    const vector = Y.encodeStateVector(ydoc);
    remote.transact(() => {
      const text = remote.getText("content");
      text.delete(8, 8);
      text.insert(8, "# Remote");
    });
    Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(remote, vector));
    const observedBindingWrites: string[] = [];
    const observer = (_event: Y.YTextEvent, transaction: Y.Transaction) => {
      if (transaction.origin === binding) observedBindingWrites.push(ytext.toString());
    };
    ytext.observe(observer);

    expect(binding.handleLocalTransaction(before, after, change)).toBe(true);
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    Y.applyUpdate(remote, Y.encodeStateAsUpdate(ydoc));

    const finalSource = ytext.toString();
    const canonical = parseMarkdown(finalSource);
    expect(canonical.doc.textContent.match(/Remote/g)).toHaveLength(1);
    expect(canonical.doc.textContent.match(/LOCAL/g)).toHaveLength(1);
    expect(observedBindingWrites).toEqual([finalSource]);
    expect(remote.getText("content").toString()).toBe(finalSource);
    expect(view.state.doc.toJSON()).toEqual(canonical.doc.toJSON());
    expectCompleteCanonicalMap(binding, view, finalSource);
    ytext.unobserve(observer);
    remote.destroy();
  });

  it("bounds original-unit authorization without retaining a session history", () => {
    const source = `b${"a".repeat(STALE_OPERATION_MAX_SOURCE_UNITS)}c`;
    ytext.insert(0, source);
    const { binding } = editor();
    const before = EditorState.create({ doc: binding.initialDoc() });
    binding.getSourceMap();
    const within = before.tr.delete(2, 2 + STALE_OPERATION_MAX_SOURCE_UNITS);
    const withinAfter = before.apply(within);
    const withinChange = binding.authorizeLocalChange(
      localDocChange(within, before.doc, withinAfter.doc)!,
    );
    expect(withinChange.authorization?.originalUnits).toHaveLength(
      STALE_OPERATION_MAX_SOURCE_UNITS,
    );

    const beyond = before.tr.delete(1, 2 + STALE_OPERATION_MAX_SOURCE_UNITS);
    const beyondAfter = before.apply(beyond);
    const beyondChange = binding.authorizeLocalChange(
      localDocChange(beyond, before.doc, beyondAfter.doc)!,
    );
    expect(beyondChange.authorization).toBeNull();
    expect(
      Object.keys(binding).some((key) => /originalUnits/i.test(key)),
    ).toBe(false);
    expect(binding["localAuthorizationPending"]).toBe(false);
  });

  it.each([
    [">", "\\>a\n\nbR"],
    ["# ", "\\# a\n\nbR"],
    ["- ", "\\- a\n\nbR"],
    ["*", "\\*a\n\nbR"],
    ["`", "\\`a\n\nbR"],
  ])("replays a stale local %j insertion with canonical Markdown escaping", async (insert, expected) => {
    ytext.insert(0, "a\n\nb");
    const { view, binding } = editor();
    binding.getSourceMap();
    const before = view.state;
    const tr = before.tr.insertText(insert, 1);
    const after = before.apply(tr);
    const change = binding.authorizeLocalChange(localDocChange(tr, before.doc, after.doc)!);
    expect(change.authorization).not.toBeNull();

    const remote = new Y.Doc();
    Y.applyUpdate(remote, Y.encodeStateAsUpdate(ydoc));
    const vector = Y.encodeStateVector(ydoc);
    remote.getText("content").insert(remote.getText("content").length, "R");
    Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(remote, vector));

    expect(binding.handleLocalTransaction(before, after, change)).toBe(true);
    await new Promise<void>((resolve) => queueMicrotask(resolve));

    expect(ytext.toString()).toBe(expected);
    expect(view.state.doc.toJSON()).toEqual(parseMarkdown(expected).doc.toJSON());
    remote.destroy();
  });

  it.each([
    [">", "blockquote marker"],
    ["# ", "heading marker"],
    ["- ", "dash-list marker"],
    ["* ", "star-list marker"],
    ["1. ", "ordered-list marker"],
    ["```", "code-fence marker"],
    ["---", "thematic-break marker"],
    ["[x](y)", "link punctuation"],
    ["![](x)", "image punctuation"],
    ["**", "emphasis delimiter"],
  ])(
    "contextually serializes a stale %s moved to the start by a joined-client deletion",
    async (insert) => {
      ytext.insert(0, "za");
      const { view, binding } = editor();
      binding.getSourceMap();
      const before = view.state;
      const tr = before.tr.insertText(insert, 2);
      const after = before.apply(tr);
      const change = binding.authorizeLocalChange(localDocChange(tr, before.doc, after.doc)!);
      expect(change.authorization).not.toBeNull();

      const remote = new Y.Doc();
      Y.applyUpdate(remote, Y.encodeStateAsUpdate(ydoc));
      const vector = Y.encodeStateVector(ydoc);
      remote.getText("content").delete(0, 1);
      Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(remote, vector));
      expect(ytext.toString()).toBe("a");

      const intendedDoc = schema.nodes.doc.create(
        null,
        schema.nodes.paragraph.create(null, schema.text(`${insert}a`)),
      );
      const expected = serializeBlocks([intendedDoc.firstChild!]);
      const observedBindingWrites: string[] = [];
      const observer = (_event: Y.YTextEvent, transaction: Y.Transaction) => {
        if (transaction.origin === binding) observedBindingWrites.push(ytext.toString());
      };
      ytext.observe(observer);

      expect(binding.handleLocalTransaction(before, after, change)).toBe(true);
      await new Promise<void>((resolve) => queueMicrotask(resolve));

      expect(observedBindingWrites).toEqual([expected]);
      expect(ytext.toString()).toBe(expected);
      expect(view.state.doc.toJSON()).toEqual(intendedDoc.toJSON());
      expect(binding["currentDoc"]?.toJSON()).toEqual(intendedDoc.toJSON());
      expect(binding.blocks).toEqual(parseMarkdown(expected).map.blocks);
      expect(binding.getHeadings()).toEqual([]);
      expectCompleteCanonicalMap(binding, view, expected);
      ytext.unobserve(observer);
      remote.destroy();
    },
  );

  it("keeps contextual stale replay in binding undo history beside later joined-client edits", async () => {
    ytext.insert(0, "za");
    const { view, binding } = editor();
    const undo = new Y.UndoManager(ytext, { trackedOrigins: new Set([binding]) });
    binding.getSourceMap();
    const before = view.state;
    const tr = before.tr.insertText(">", 2);
    const after = before.apply(tr);
    const change = binding.authorizeLocalChange(localDocChange(tr, before.doc, after.doc)!);

    const remote = new Y.Doc();
    Y.applyUpdate(remote, Y.encodeStateAsUpdate(ydoc));
    let vector = Y.encodeStateVector(ydoc);
    remote.getText("content").delete(0, 1);
    Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(remote, vector));
    expect(binding.handleLocalTransaction(before, after, change)).toBe(true);
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(ytext.toString()).toBe("\\>a");

    undo.stopCapturing();
    vector = Y.encodeStateVector(ydoc);
    remote.getText("content").insert(remote.getText("content").length, "R");
    Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(remote, vector));
    expect(ytext.toString()).toBe("\\>aR");

    undo.undo();
    expect(ytext.toString()).toBe("aR");
    undo.redo();
    expect(ytext.toString()).toBe("\\>aR");
    vector = Y.encodeStateVector(ydoc);
    remote.getText("content").insert(remote.getText("content").length, "Q");
    Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(remote, vector));

    expect(ytext.toString()).toBe("\\>aRQ");
    expect(view.state.doc.toJSON()).toEqual(parseMarkdown("\\>aRQ").doc.toJSON());
    expect(binding["currentDoc"]?.toJSON()).toEqual(view.state.doc.toJSON());
    expectCompleteCanonicalMap(binding, view, "\\>aRQ");
    undo.destroy();
    remote.destroy();
  });

  it.each([
    {
      label: "a newline and heading inserted at its saved boundary",
      source: "za",
      sourceOffset: 1,
      remoteChange: (text: Y.Text) => text.insert(1, "\n\n# Remote\n\n"),
      expected: "z\n\n# Remote\n\n\\>a",
    },
    {
      label: "its complete surrounding block replaced by a heading",
      source: "before\n\nza\n\nafter",
      sourceOffset: 9,
      remoteChange: (text: Y.Text) => {
        text.delete(8, 2);
        text.insert(8, "# Remote");
      },
      expected: "before>\n\n# Remote\n\nafter",
    },
    {
      label: "its original block deleted so it moves to a different block",
      source: "za\n\nsecond",
      sourceOffset: 1,
      remoteChange: (text: Y.Text) => text.delete(0, 4),
      expected: "\\>second",
    },
    {
      label: "the remote client deletes the entire document",
      source: "za",
      sourceOffset: 1,
      remoteChange: (text: Y.Text) => text.delete(0, 2),
      expected: "\\>",
    },
  ])(
    "rebases stale rich intent when $label",
    async ({ source, sourceOffset, remoteChange, expected }) => {
      ytext.insert(0, source);
      const { view, binding } = editor();
      const map = binding.getSourceMap();
      const before = view.state;
      const position = map.srcToPm(sourceOffset);
      const tr = before.tr.insertText(">", position);
      const after = before.apply(tr);
      const change = binding.authorizeLocalChange(localDocChange(tr, before.doc, after.doc)!);
      expect(change.authorization).not.toBeNull();

      const remote = new Y.Doc();
      Y.applyUpdate(remote, Y.encodeStateAsUpdate(ydoc));
      const vector = Y.encodeStateVector(ydoc);
      remote.transact(() => remoteChange(remote.getText("content")));
      Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(remote, vector));

      const observedBindingWrites: string[] = [];
      const observer = (_event: Y.YTextEvent, transaction: Y.Transaction) => {
        if (transaction.origin === binding) observedBindingWrites.push(ytext.toString());
      };
      ytext.observe(observer);
      expect(binding.handleLocalTransaction(before, after, change)).toBe(true);
      await new Promise<void>((resolve) => queueMicrotask(resolve));

      const canonical = parseMarkdown(expected);
      expect(observedBindingWrites).toEqual([expected]);
      expect(ytext.toString()).toBe(expected);
      expect(view.state.doc.toJSON()).toEqual(canonical.doc.toJSON());
      expect(binding["currentDoc"]?.toJSON()).toEqual(canonical.doc.toJSON());
      expect(binding.blocks).toEqual(canonical.map.blocks);
      expect(binding.getHeadings()).toEqual(canonical.headings);
      expectCompleteCanonicalMap(binding, view, expected);
      ytext.unobserve(observer);
      remote.destroy();
    },
  );

  it("preserves local and remote edits when an earlier plugin appends during the same view update", async () => {
    ytext.insert(0, "a\n\nb");
    const binding = new MarkdownBinding(ytext);
    bindings.push(binding);
    const initial = binding.initialDoc();
    binding.getSourceMap();
    const remote = new Y.Doc();
    Y.applyUpdate(remote, Y.encodeStateAsUpdate(ydoc));
    let appended = false;
    const appendRemote = new Plugin({
      appendTransaction(transactions, _oldState, newState) {
        if (appended || !transactions.some((transaction) => transaction.docChanged)) return null;
        appended = true;
        const vector = Y.encodeStateVector(ydoc);
        remote.getText("content").insert(remote.getText("content").length, "R");
        Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(remote, vector));
        return newState.tr.insertText("R", newState.doc.content.size - 1);
      },
    });
    const state = EditorState.create({ doc: initial, plugins: [appendRemote, markdownBindingPlugin(binding)] });
    const view = new EditorView(document.createElement("div"), { state });
    views.push(view);

    view.dispatch(view.state.tr.insertText("x", 2));
    await new Promise<void>((resolve) => queueMicrotask(resolve));

    expect(ytext.toString()).toBe("ax\n\nbR");
    const canonical = parseMarkdown("ax\n\nbR");
    expect(view.state.doc.toJSON()).toEqual(canonical.doc.toJSON());
    expect(binding["currentDoc"]?.toJSON()).toEqual(canonical.doc.toJSON());
    remote.destroy();
  });

  it("keeps metadata-only appended transactions on the authorized plain-text path", () => {
    ytext.insert(0, "a\n\nb");
    const binding = new MarkdownBinding(ytext);
    bindings.push(binding);
    const initial = binding.initialDoc();
    binding.getSourceMap();
    let appended = false;
    const appendMetadata = new Plugin({
      appendTransaction(transactions, _oldState, newState) {
        if (appended || !transactions.some((transaction) => transaction.docChanged)) return null;
        appended = true;
        return newState.tr.setMeta("metadata-only", true);
      },
    });
    const state = EditorState.create({ doc: initial, plugins: [appendMetadata, markdownBindingPlugin(binding)] });
    const view = new EditorView(document.createElement("div"), { state });
    views.push(view);

    view.dispatch(view.state.tr.insertText("x", 2));

    expect(ytext.toString()).toBe("ax\n\nb");
    expect(binding["mapCache"]).not.toBeNull();
    expectCompleteCanonicalMap(binding, view, "ax\n\nb");
  });

  it("keeps generations current across undo, redo, and a later joined-client edit", () => {
    ytext.insert(0, "alpha\n\nomega");
    const { view, binding } = editor();
    const undo = new Y.UndoManager(ytext, { trackedOrigins: new Set([binding]) });
    binding.getSourceMap();

    view.dispatch(view.state.tr.insertText("X", 3));
    expect(ytext.toString()).toBe("alXpha\n\nomega");
    undo.stopCapturing();
    undo.undo();
    expect(ytext.toString()).toBe("alpha\n\nomega");
    undo.redo();
    expect(ytext.toString()).toBe("alXpha\n\nomega");

    const remote = new Y.Doc();
    Y.applyUpdate(remote, Y.encodeStateAsUpdate(ydoc));
    const vector = Y.encodeStateVector(ydoc);
    remote.getText("content").insert(remote.getText("content").length, "R");
    Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(remote, vector));
    binding.getSourceMap();
    view.dispatch(view.state.tr.insertText("Y", 4));

    expect(ytext.toString()).toBe("alXYpha\n\nomegaR");
    expect(view.state.doc.toJSON()).toEqual(parseMarkdown(ytext.toString()).doc.toJSON());
    expectCompleteCanonicalMap(binding, view, ytext.toString());
    undo.destroy();
    remote.destroy();
  });

  it("keeps mapped source positions exact through repeated plain-paragraph edits", () => {
    let source = "# Heading\n\nAlpha paragraph.\n\nMiddle paragraph text.\n\nTail **bold**.";
    ytext.insert(0, source);
    const { view, binding } = editor();
    binding.getSourceMap();

    const replaceSource = (from: number, to: number, text: string) => {
      const map = binding.getSourceMap();
      view.dispatch(view.state.tr.insertText(text, map.srcToPm(from), map.srcToPm(to)));
      source = source.slice(0, from) + text + source.slice(to);
      expect(ytext.toString()).toBe(source);
    };

    const middle = source.indexOf("Middle");
    replaceSource(middle, middle, "A quick ");
    const paragraph = source.indexOf("paragraph", middle);
    replaceSource(paragraph, paragraph + "paragraph".length, "section");
    const textEnd = source.indexOf(" text.", middle) + " text".length;
    replaceSource(textEnd, textEnd, "!");

    const mapped = binding.getSourceMap();
    const authoritative = parseMarkdown(source).map;
    const sourcePositions = [
      source.indexOf("Alpha") + 2,
      source.indexOf("quick") + 2,
      source.indexOf("section") + 3,
      source.indexOf("Tail") + 2,
      source.length,
    ];
    for (const offset of sourcePositions) {
      expect(mapped.srcToPm(offset)).toBe(authoritative.srcToPm(offset));
      expect(mapped.pmToSrc(mapped.srcToPm(offset))).toBe(offset);
    }
    const pmPositions = sourcePositions.map((offset) => authoritative.srcToPm(offset));
    for (const pos of pmPositions) expect(mapped.pmToSrc(pos)).toBe(authoritative.pmToSrc(pos));
    expect(mapped.blocks).toEqual(authoritative.blocks);
    expect(mapped.segments).toEqual(authoritative.segments);
  });

  it(
    "bounds source-map and local-intent history through 50,000 marked-document edits",
    () => {
      const paragraphCount = 1_000;
      const editCount = 50_000;
      const targetIndexes = [0, 500, 999] as const;
      const source = Array.from(
        { length: paragraphCount },
        (_, index) => `P${index} plain **bold** [link](x) ![](i) 😀.`,
      ).join("\n\n");
      ytext.insert(0, source);
      const binding = new MarkdownBinding(ytext);
      bindings.push(binding);
      let state = EditorState.create({ doc: binding.initialDoc() });
      binding.getSourceMap();

      const fragment = Object.getPrototypeOf(state.doc.content) as {
        findDiffStart: (...args: unknown[]) => unknown;
        findDiffEnd: (...args: unknown[]) => unknown;
      };
      const findDiffStart = vi.spyOn(fragment, "findDiffStart");
      const findDiffEnd = vi.spyOn(fragment, "findDiffEnd");
      const materialize = vi.spyOn(ytext as unknown as { toString: () => string }, "toString");
      const parse = vi.fn(binding["parse"].bind(binding));
      const buildDoc = vi.fn(binding["buildDoc"].bind(binding));
      binding["parse"] = parse;
      binding["buildDoc"] = buildDoc;
      const inserted = [0, 0, 0];
      let maxAuthorizedOriginalUnits = 0;

      for (let edit = 0; edit < editCount; edit++) {
        const target = edit % targetIndexes.length;
        const paragraphIndex = targetIndexes[target];
        const sourceOffset =
          binding.blocks[paragraphIndex].from +
          `P${paragraphIndex} plain`.length +
          inserted[target];
        const position = binding.getSourceMap().srcToPm(sourceOffset);
        const tr = state.tr.insertText("x", position);
        const next = state.apply(tr);
        const change = localDocChange(tr, state.doc, next.doc);
        expect(change).not.toBeNull();
        const authorized = binding.authorizeLocalChange(change!);
        maxAuthorizedOriginalUnits = Math.max(
          maxAuthorizedOriginalUnits,
          authorized.authorization?.originalUnits.length ?? 0,
        );
        expect(binding.handleLocalTransaction(state, next, authorized)).toBe(true);
        expect(binding["mapCache"]).not.toBeNull();
        state = next;
        inserted[target]++;
      }

      const expectedCompactions = Math.floor(editCount / SOURCE_MAP_MAX_RETAINED_DOCUMENTS);
      expect(expectedCompactions).toBeGreaterThanOrEqual(390);
      expect(maxAuthorizedOriginalUnits).toBe(0);
      expect(binding["localAuthorizationPending"]).toBe(false);
      expect(SOURCE_MAP_MAX_RETAINED_DOCUMENTS).toBeGreaterThan(120);
      expect(findDiffStart).not.toHaveBeenCalled();
      expect(findDiffEnd).not.toHaveBeenCalled();
      expect(materialize).not.toHaveBeenCalled();
      expect(parse).not.toHaveBeenCalled();
      expect(buildDoc).not.toHaveBeenCalled();
      expect(binding.sourceMapDiagnostics).toMatchObject({
        currentWrapperDepth: editCount % SOURCE_MAP_MAX_RETAINED_DOCUMENTS,
        maxWrapperDepth: SOURCE_MAP_MAX_RETAINED_DOCUMENTS - 1,
        currentRetainedDocuments: (editCount % SOURCE_MAP_MAX_RETAINED_DOCUMENTS) + 1,
        maxRetainedDocuments: SOURCE_MAP_MAX_RETAINED_DOCUMENTS,
        compactionCount: expectedCompactions,
      });
      expect(binding.sourceMapDiagnostics.maxCompactionDurationMs).toBeGreaterThanOrEqual(0);
      expect(binding.sourceMapDiagnostics.maxCompactionSegments).toBeGreaterThan(0);

      materialize.mockRestore();
      const finalSource = ytext.toString();
      const canonical = parseMarkdown(finalSource);
      const mapped = binding.getSourceMap();
      expect(mapped.blocks).toEqual(canonical.map.blocks);
      expect(mapped.segments).toEqual(canonical.map.segments);
      expect(binding.sourceMapDiagnostics.maxCompactionSegments).toBe(canonical.map.segments.length);

      const sourceOffsets = new Set<number>([0, finalSource.length]);
      const richPositions = new Set<number>([0, canonical.doc.content.size]);
      for (const segment of canonical.map.segments) {
        sourceOffsets.add(segment.srcFrom);
        sourceOffsets.add(segment.srcTo);
        richPositions.add(segment.pmFrom);
        richPositions.add(segment.pmTo);
      }
      for (let sample = 0; sample <= 257; sample++) {
        sourceOffsets.add(Math.floor((sample * finalSource.length) / 257));
        richPositions.add(Math.floor((sample * canonical.doc.content.size) / 257));
      }
      for (const offset of sourceOffsets) {
        expect(mapped.srcToPm(offset), `source offset ${offset}`).toBe(canonical.map.srcToPm(offset));
      }
      for (const position of richPositions) {
        expect(mapped.pmToSrc(position), `rich position ${position}`).toBe(
          canonical.map.pmToSrc(position),
        );
      }
      expect(state.doc.toJSON()).toEqual(canonical.doc.toJSON());

      console.info(
        "[source-map-long-session]",
        JSON.stringify({
          edits: editCount,
          paragraphs: paragraphCount,
          ...binding.sourceMapDiagnostics,
          finalSegments: mapped.segments.length,
          sourceSamples: sourceOffsets.size,
          richSamples: richPositions.size,
        }),
      );
      findDiffStart.mockRestore();
      findDiffEnd.mockRestore();
    },
    180_000,
  );

  it.each([
    ["after an empty-alt image", "![](x)a", 2, "![](x)Xa"],
    ["before an empty-alt image", "a![](x)", 2, "aX![](x)"],
    ["after linked text", "[a](x)b", 2, "[a](x)Xb"],
    ["before linked text", "a[b](x)", 2, "aX[b](x)"],
    ["after strong text", "**a**b", 2, "**a**Xb"],
    ["before strong text", "a**b**", 2, "aX**b**"],
    ["between adjacent images", "![](x)![](y)", 2, "![](x)X![](y)"],
  ])("falls back at the inline ownership boundary %s", async (_label, source, position, expected) => {
    ytext.insert(0, source);
    const { view, binding } = editor();
    binding.getSourceMap();

    view.dispatch(view.state.tr.replaceWith(position, position, schema.text("X")));
    expect(binding["mapCache"]).toBeNull();
    await new Promise<void>((resolve) => queueMicrotask(resolve));

    expect(ytext.toString()).toBe(expected);
    expect(view.state.doc.toJSON()).toEqual(parseMarkdown(expected).doc.toJSON());
    expectCompleteCanonicalMap(binding, view, expected);
  });

  it("keeps image segment ownership exact when following text receives an insertion", async () => {
    ytext.insert(0, "![](x)a");
    const { view, binding } = editor();
    binding.getSourceMap();

    view.dispatch(view.state.tr.insertText("X", 2, 2));
    await new Promise<void>((resolve) => queueMicrotask(resolve));

    expect(binding.getSourceMap().segments[0]).toEqual({ pmFrom: 1, pmTo: 2, srcFrom: 0, srcTo: 6 });
    expectCompleteCanonicalMap(binding, view, "![](x)Xa");
  });

  it("keeps surrogate-pair offsets exact on the plain-text fast path", () => {
    ytext.insert(0, "😀a");
    const { view, binding } = editor();
    binding.getSourceMap();

    view.dispatch(view.state.tr.insertText("X", 3, 3));

    expect(ytext.toString()).toBe("😀Xa");
    expect(binding["mapCache"]).not.toBeNull();
    expectCompleteCanonicalMap(binding, view, "😀Xa");
  });

  it("invalidates the mapped source map when an equivalent repeated-character diff starts elsewhere", () => {
    const source = "qxyz";
    ytext.insert(0, source);
    const { view, binding } = editor();
    binding.getSourceMap();

    typeText(view, "x", 2);

    const mapped = binding.getSourceMap();
    const authoritative = parseMarkdown("qxxyz").map;
    for (let offset = 0; offset <= ytext.length; offset++) {
      expect(mapped.srcToPm(offset)).toBe(authoritative.srcToPm(offset));
    }
    for (let pos = 0; pos <= view.state.doc.content.size; pos++) {
      expect(mapped.pmToSrc(pos)).toBe(authoritative.pmToSrc(pos));
    }
  });

  it("falls back at inline Markdown boundaries instead of retaining a stale rich document or source map", async () => {
    ytext.insert(0, "~~strike~~ tail");
    const { view, binding } = editor();
    binding.getSourceMap();
    typeText(view, " ", 1);
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    const strikeExpected = parseMarkdown(ytext.toString()).doc;
    expect(view.state.doc.eq(strikeExpected)).toBe(true);

    ytext.delete(0, ytext.length);
    ytext.insert(0, "hello **bold** tail");
    binding.getSourceMap();
    view.dispatch(view.state.tr.insertText("x", 5, 7));
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    const authoritative = parseMarkdown(ytext.toString());
    expect(view.state.doc.eq(authoritative.doc)).toBe(true);
    const mapped = binding.getSourceMap();
    for (let pos = 0; pos <= view.state.doc.content.size; pos++) {
      expect(mapped.pmToSrc(pos)).toBe(authoritative.map.pmToSrc(pos));
    }
  });

  it.each([
    ["heading", "#text", " ", "# text", "heading"],
    ["bullet list", "-text", " ", "- text", "bullet_list"],
    ["blockquote", "text", ">", ">text", "blockquote"],
  ])("reparses a hard-break continuation that becomes a %s", async (_label, before, insert, after, expectedType) => {
    const source = `Intro\\\n${before}`;
    ytext.insert(0, source);
    const { view, binding } = editor();
    const map = binding.getSourceMap();
    expect(view.state.doc.firstChild!.child(1).type).toBe(schema.nodes.hard_break);

    typeText(view, insert, map.srcToPm(source.indexOf("text")));
    await new Promise<void>((resolve) => queueMicrotask(resolve));

    expect(ytext.toString()).toBe(`Intro\\\n${after}`);
    const canonical = parseMarkdown(ytext.toString()).doc;
    expect(canonical.childCount).toBe(2);
    expect(canonical.child(1).type.name).toBe(expectedType);
    expect(view.state.doc.eq(canonical)).toBe(true);
  });

  it.each(RAW_LINE_POSITIONS)("reparses a composition-tagged raw newline inserted at the $label paragraph", async ({ before, after }) => {
    const source = rawLineFixture(before, after);
    ytext.insert(0, source);
    const { view, binding } = editor();
    const sourceOffset = source.indexOf("plain text") + 2;
    const pmOffset = binding.getSourceMap().srcToPm(sourceOffset);
    if (before === 0) {
      expect(source).toBe("plain text\n\n# H");
      expect(pmOffset).toBe(3);
    }

    view.dispatch(view.state.tr.insertText("\n", pmOffset).setMeta("composition", 1));
    expectParagraphFastPathRejected(binding);
    await new Promise<void>((resolve) => queueMicrotask(resolve));

    expectCanonicalBinding(binding, view, rawLineFixture(before, after, "\n"), before * 2 + 4);
  });

  it.each([
    ["CR", "\r", 3],
    ["CRLF", "\r\n", 4],
  ])("reparses composition-tagged %s bytes that reach a paragraph text node", async (_label, separator, headingLine) => {
    const source = rawLineFixture(0, 0);
    ytext.insert(0, source);
    const { view, binding } = editor();
    const pmOffset = binding.getSourceMap().srcToPm(2);

    view.dispatch(view.state.tr.insertText(separator, pmOffset).setMeta("composition", 1));
    expectParagraphFastPathRejected(binding);
    await new Promise<void>((resolve) => queueMicrotask(resolve));

    expectCanonicalBinding(binding, view, rawLineFixture(0, 0, separator), headingLine);
  });

  it.each(RAW_LINE_POSITIONS)("reparses a composition-tagged raw newline deleted at the $label paragraph", async ({ before, after }) => {
    const source = rawLineFixture(before, after, "\n");
    ytext.insert(0, source);
    const binding = new MarkdownBinding(ytext);
    bindings.push(binding);
    const canonical = binding.initialDoc();
    binding.getSourceMap();

    const children: PMNode[] = [];
    canonical.forEach((node, _offset, index) => {
      children.push(index === before ? schema.nodes.paragraph.create(null, schema.text("pl\nain text")) : node);
    });
    const staleDoc = schema.nodes.doc.create(null, children);
    const state = EditorState.create({ doc: staleDoc, plugins: [markdownBindingPlugin(binding)] });
    const view = new EditorView(document.createElement("div"), { state });
    views.push(view);
    const pmOffset = binding.getSourceMap().srcToPm(source.indexOf("pl\nain text") + 2);

    view.dispatch(view.state.tr.insertText("", pmOffset, pmOffset + 1).setMeta("composition", 1));
    expectParagraphFastPathRejected(binding);
    await new Promise<void>((resolve) => queueMicrotask(resolve));

    expectCanonicalBinding(binding, view, rawLineFixture(before, after), before * 2 + 3);
  });

  it("reflects text changes in the rich editor while preserving the selection", () => {
    ytext.insert(0, "# Title\n\nHello world.");
    const { view } = editor();
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 8 + 11)));
    // Someone edits the heading.
    ytext.insert(7, " Page");
    expect(view.state.doc.child(0).textContent).toBe("Title Page");
    expect(view.state.doc.child(1).textContent).toBe("Hello world.");
    // Selection moved by the 5 inserted characters.
    expect(view.state.selection.head).toBe(8 + 11 + 5);
  });

  it("keeps the selection when a remote user edits the same paragraph", () => {
    ytext.insert(0, "Hello world.");
    const { view } = editor();
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1 + 12)));
    ytext.insert(0, "Oh! ");
    expect(view.state.doc.textContent).toBe("Oh! Hello world.");
    expect(view.state.selection.head).toBe(1 + 16);
  });

  it("reproduces a table column removed in the text exactly in the rich editor (task #459)", () => {
    // Undo of "add column" in the table menu: one Y transaction deletes a cell from every row. The
    // diff starts inside the header's second cell and ends inside the last row; ProseMirror's fitted
    // replace kept the header's empty cell (a 4×3 header over 4×2 bodies, then padded by fixTables)
    // while the text already said 4×2.
    const before = "Intro.\n\n| Column 1 |     | c1  |\n| -------- | --- | --- |\n| c2       |     | c3  |\n|          |     |     |\n|          |     |     |\n\nAfter text.\n";
    const after = "Intro.\n\n| Column 1 | c1  |\n| -------- | --- |\n| c2       | c3  |\n|          |     |\n|          |     |\n\nAfter text.\n";
    const expected = parseMarkdown(after).doc;
    const fitted = minimalReplaceTransaction(EditorState.create({ doc: parseMarkdown(before).doc }), expected);
    expect(fitted.doc.eq(expected)).toBe(true);
    expect(fitted.doc.child(1).child(0).childCount).toBe(2);

    ytext.insert(0, before);
    const { view } = editor();
    // Caret at the end of "After text." keeps its place relative to the paragraph.
    const tail = view.state.doc.content.size - 2;
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, tail)));
    applyOps(ytext, diffOps(before, after));
    expect(view.state.doc.eq(expected)).toBe(true);
    expect(view.state.selection.head).toBe(view.state.doc.content.size - 2);
  });

  it("syncs two clients through Yjs updates in both directions", () => {
    ytext.insert(0, "# Doc\n\nFirst paragraph.");
    const other = new Y.Doc();
    Y.applyUpdate(other, Y.encodeStateAsUpdate(ydoc));
    ydoc.on("update", (u: Uint8Array) => Y.applyUpdate(other, u));
    other.on("update", (u: Uint8Array) => Y.applyUpdate(ydoc, u));
    const a = editor();
    const b = editor(other.getText("content"));

    typeText(a.view, " Really.", 6 + 16);
    expect(other.getText("content").toString()).toBe("# Doc\n\nFirst paragraph. Really.");
    expect(b.view.state.doc.child(1).textContent).toBe("First paragraph. Really.");

    // B edits the "code" side directly.
    other.getText("content").insert(other.getText("content").length, "\n\n- item");
    expect(a.view.state.doc.childCount).toBe(3);
    expect(a.view.state.doc.child(2).type.name).toBe("bullet_list");
    expect(a.binding.blocks[2]).toEqual({ from: 33, to: 39 });
  });

  it("turns a paragraph into a heading", () => {
    ytext.insert(0, "Intro\n\nBody text.");
    const { view } = editor();
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1)));
    setBlockType(schema.nodes.heading, { level: 2 })(view.state, view.dispatch);
    expect(ytext.toString()).toBe("## Intro\n\nBody text.");
  });

  it("keeps empty paragraphs as phantoms until they get content", () => {
    ytext.insert(0, "First.");
    const { view, binding } = editor();
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 7)));
    splitBlock(view.state, view.dispatch);
    expect(view.state.doc.childCount).toBe(2);
    expect(ytext.toString()).toBe("First.");
    expect(binding.blocks[1]).toEqual({ from: 6, to: 6, phantom: true });

    typeText(view, "Second.");
    expect(ytext.toString()).toBe("First.\n\nSecond.");
    expect(binding.blocks).toEqual([
      { from: 0, to: 6 },
      { from: 8, to: 15 },
    ]);
    expect(view.state.doc.childCount).toBe(2);
  });

  it("keeps a phantom paragraph across remote edits", () => {
    ytext.insert(0, "First.\n\nThird.");
    const { view } = editor();
    // Split after "First." to make an empty paragraph between the two.
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 7)));
    splitBlock(view.state, view.dispatch);
    expect(view.state.doc.childCount).toBe(3);
    expect(ytext.toString()).toBe("First.\n\nThird.");
    ytext.insert(0, "Zero.\n\n");
    const types: string[] = [];
    view.state.doc.forEach((n) => types.push(n.textContent));
    expect(types).toEqual(["Zero.", "First.", "", "Third."]);
  });

  it("deletes blocks from the text when removed in the rich editor", () => {
    ytext.insert(0, "One.\n\nTwo.\n\nThree.");
    const { view, binding } = editor();
    // Delete the second paragraph (positions 6..12).
    view.dispatch(view.state.tr.delete(6, 12));
    expect(ytext.toString()).toBe("One.\n\nThree.");
    expect(binding.blocks).toEqual([
      { from: 0, to: 4 },
      { from: 6, to: 12 },
    ]);
  });

  it("inserts a new block in the middle", () => {
    ytext.insert(0, "One.\n\nThree.");
    const { view, binding } = editor();
    view.dispatch(view.state.tr.insert(6, schema.nodes.paragraph.create(null, schema.text("Two."))));
    expect(ytext.toString()).toBe("One.\n\nTwo.\n\nThree.");
    expect(binding.blocks).toEqual([
      { from: 0, to: 4 },
      { from: 6, to: 10 },
      { from: 12, to: 18 },
    ]);
  });

  it("starts from an empty document", () => {
    const { view, binding } = editor();
    expect(view.state.doc.childCount).toBe(1);
    typeText(view, "Hello", 1);
    expect(ytext.toString()).toBe("Hello");
    expect(binding.blocks).toEqual([{ from: 0, to: 5 }]);
    // Delete everything again.
    view.dispatch(view.state.tr.delete(1, 6));
    expect(ytext.toString()).toBe("");
    typeText(view, "Again", 1);
    expect(ytext.toString()).toBe("Again");
  });

  it("drops the empty-document placeholder once content arrives from the server", () => {
    const { view, binding } = editor(); // text is empty at construction time, like before the provider syncs
    expect(view.state.doc.childCount).toBe(1);
    ytext.insert(0, "# Title\n\nBody.");
    expect(view.state.doc.childCount).toBe(2);
    expect(view.state.doc.child(0).type.name).toBe("heading");
    expect(binding.blocks).toEqual([
      { from: 0, to: 7 },
      { from: 9, to: 14 },
    ]);
    // Clearing the text brings a placeholder back.
    ytext.delete(0, ytext.length);
    expect(view.state.doc.childCount).toBe(1);
    expect(binding.blocks).toEqual([{ from: 0, to: 0, phantom: true }]);
  });

  it("falls back to a full re-sync when the markdown normalizes the structure", async () => {
    ytext.insert(0, "- a\n- b");
    const { view } = editor();
    // Insert a second bullet list right after the first: Markdown merges them.
    const list = schema.nodes.bullet_list.create(null, [
      schema.nodes.list_item.create(null, schema.nodes.paragraph.create(null, schema.text("c"))),
    ]);
    view.dispatch(view.state.tr.insert(view.state.doc.content.size, list));
    await new Promise<void>((r) => queueMicrotask(r));
    expect(ytext.toString()).toBe("- a\n- b\n\n- c");
    expect(view.state.doc.childCount).toBe(1);
    expect(view.state.doc.child(0).childCount).toBe(3);
  });

  it("Enter at the end of a quoted line keeps the caret in the quote and never re-syncs it away (task #415)", async () => {
    // Burke #1240: the empty paragraph splitBlock created inside the blockquote had no Markdown form,
    // the binding fell back to a full re-sync that dropped it, and the caret landed in the next block.
    ytext.insert(0, "# H1\n\n> A quote line.\n\n## Heading two\n");
    const { view, binding } = editor();
    const endOfQuote = 4 + 1 + 1 + "A quote line.".length;
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, endOfQuote)));
    splitBlock(view.state, view.dispatch);
    await new Promise<void>((r) => queueMicrotask(r));
    expect(ytext.toString()).toBe("# H1\n\n> A quote line.\n>\n>\n\n## Heading two\n");
    expect(view.state.doc.child(1).childCount).toBe(2);
    expect(view.state.selection.$from.node(-1).type.name).toBe("blockquote");
    expect(view.state.selection.$from.parent.content.size).toBe(0);
    expect(binding.blocks[1]).toEqual({ from: 6, to: 25 });
    // Typing lands in the new quote line, not at the top of the document or in the heading.
    typeText(view, "more");
    await new Promise<void>((r) => queueMicrotask(r));
    expect(ytext.toString()).toBe("# H1\n\n> A quote line.\n>\n> more\n\n## Heading two\n");
  });

  it("Shift+Enter inside a quote keeps the break in both panes, then the typed line follows it (task #434)", async () => {
    // The break has nothing after it when it is inserted; it must still survive the round trip, or
    // the binding re-syncs the quote without it and the next line is glued on: "> A quote line.second line".
    ytext.insert(0, "# H1\n\n> A quote line.\n\n## Heading two\n");
    const { view } = editor();
    const endOfQuote = 4 + 1 + 1 + "A quote line.".length;
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, endOfQuote)));
    insertHardBreak()(view.state, view.dispatch);
    await new Promise<void>((r) => queueMicrotask(r));
    expect(ytext.toString()).toBe("# H1\n\n> A quote line.<br>\n\n## Heading two\n");
    expect(view.state.doc.child(1).firstChild!.lastChild!.type.name).toBe("hard_break");
    expect(view.state.selection.$from.node(-1).type.name).toBe("blockquote");
    typeText(view, "second line");
    await new Promise<void>((r) => queueMicrotask(r));
    expect(ytext.toString()).toBe("# H1\n\n> A quote line.\\\n> second line\n\n## Heading two\n");
    expect(view.state.doc.child(1).firstChild!.childCount).toBe(3);
    expect(view.state.doc.child(1).firstChild!.child(1).type.name).toBe("hard_break");
    // Reload from the text: the same document comes back.
    expect(parseMarkdown(ytext.toString()).doc.eq(view.state.doc)).toBe(true);
  });

  it("Enter at the end of a code block keeps the blank last line (task #434)", async () => {
    ytext.insert(0, "```ts\nconst a = 1;\n```\n\nEnd.\n");
    const { view } = editor();
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1 + "const a = 1;".length)));
    typeText(view, "\n");
    await new Promise<void>((r) => queueMicrotask(r));
    expect(ytext.toString()).toBe("```ts\nconst a = 1;\n\n```\n\nEnd.\n");
    expect(view.state.doc.firstChild!.textContent).toBe("const a = 1;\n");
    typeText(view, "\n");
    await new Promise<void>((r) => queueMicrotask(r));
    expect(ytext.toString()).toBe("```ts\nconst a = 1;\n\n\n```\n\nEnd.\n");
    expect(view.state.doc.firstChild!.textContent).toBe("const a = 1;\n\n");
    expect(parseMarkdown(ytext.toString()).doc.eq(view.state.doc)).toBe(true);
  });

  it("maps positions between surfaces including phantoms", () => {
    ytext.insert(0, "First.\n\nThird.");
    const { view, binding } = editor();
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 7)));
    splitBlock(view.state, view.dispatch);
    const map = binding.getSourceMap();
    // "Third." now lives in block 2 (pm pos 10..), source offset 8.
    expect(map.srcToPm(8)).toBe(11);
    expect(map.pmToSrc(11)).toBe(8);
    expect(map.pmToSrc(9)).toBe(6); // inside the phantom → end of previous block
  });

  describe("typing in the trailing paragraph of a document with an unpadded table (task #475)", () => {
    const FIXTURE =
      "# Scout doc\n\nFirst paragraph with some words to select here.\n\n- item one\n- item two\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\nLast paragraph.\n";
    const TABLE_LINES = ["| a | b |", "| --- | --- |", "| 1 | 2 |"];
    const tick = () => new Promise<void>((r) => queueMicrotask(r));
    const typeChars = async (view: EditorView, text: string) => {
      for (const ch of text) {
        view.dispatch(view.state.tr.insertText(ch));
        await tick();
      }
    };
    /** Every Y.Text delta as { retain, insert, delete } so a test can check the exact writes. */
    const recordDeltas = (t: Y.Text) => {
      const deltas: { retain: number; insert: string; delete: number }[] = [];
      t.observe((event) => {
        let retain = 0;
        let insert = "";
        let del = 0;
        for (const d of event.delta) {
          if (d.retain) retain += d.retain;
          if (typeof d.insert === "string") insert += d.insert;
          if (d.delete) del += d.delete;
        }
        deltas.push({ retain, insert, delete: del });
      });
      return deltas;
    };
    /** Enter at the end of the document, then "/" and Backspace (the slash menu), as in the issue. */
    const makeTrailingParagraph = async (view: EditorView) => {
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, view.state.doc.content.size - 1)));
      splitBlock(view.state, view.dispatch);
      await tick();
      await typeChars(view, "/");
      view.dispatch(view.state.tr.delete(view.state.selection.from - 1, view.state.selection.from));
      await tick();
      expect(ytext.toString()).toBe(FIXTURE);
      expect(view.state.doc.childCount).toBe(6);
    };
    const tableLinesOf = (text: string) => text.split("\n").slice(7, 10);
    const lastParagraphEnd = FIXTURE.indexOf("Last paragraph.") + "Last paragraph.".length;

    it("editing mode: the text delta is exactly the typed word and the table is untouched", async () => {
      ytext.insert(0, FIXTURE);
      const { view } = editor();
      await makeTrailingParagraph(view);
      const deltas = recordDeltas(ytext);
      await typeChars(view, " suggested-words");
      expect(ytext.toString()).toBe(FIXTURE.trimEnd() + "\n\n suggested-words\n");
      expect(tableLinesOf(ytext.toString())).toEqual(TABLE_LINES);
      // One write per keystroke, each an insertion at or after the end of "Last paragraph.", never a delete.
      expect(deltas.map((d) => d.insert).join("")).toBe("\n\n suggested-words");
      expect(deltas.every((d) => d.delete === 0 && d.retain >= lastParagraphEnd)).toBe(true);
      expect(view.state.doc.childCount).toBe(6);
      expect(view.state.doc.lastChild!.textContent).toBe(" suggested-words");
    });

    it("suggesting mode: the interceptor sees only the typed word and the filled phantom does not come back", async () => {
      ytext.insert(0, FIXTURE);
      const { view, binding } = editor();
      await makeTrailingParagraph(view);
      const seen: { index: number; deleteCount: number; insert: string }[] = [];
      // Like richSuggestingPlugin: apply the ops verbatim under another origin and let the binding re-sync.
      binding.setInterceptor((ops, text, origin) => {
        seen.push(...ops);
        text.doc!.transact(() => applyOps(text, ops), origin);
        return true;
      });
      await typeChars(view, " suggested-words");
      expect(seen.map((op) => op.insert).join("")).toBe("\n\n suggested-words");
      expect(seen.every((op) => op.deleteCount === 0 && op.index >= lastParagraphEnd)).toBe(true);
      expect(tableLinesOf(ytext.toString())).toEqual(TABLE_LINES);
      expect(ytext.toString()).toBe(FIXTURE.trimEnd() + "\n\n suggested-words\n");
      // The empty paragraph the word was typed into is now a real block, not an extra blank line before it.
      expect(view.state.doc.childCount).toBe(6);
      expect(view.state.doc.lastChild!.textContent).toBe(" suggested-words");
    });

    it("control: typing at the end of the last paragraph stays a minimal diff", async () => {
      ytext.insert(0, FIXTURE);
      const { view } = editor();
      const deltas = recordDeltas(ytext);
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, view.state.doc.content.size - 1)));
      await typeChars(view, " suggested-words");
      expect(deltas.map((d) => d.insert).join("")).toBe(" suggested-words");
      expect(deltas.every((d) => d.delete === 0 && d.retain >= lastParagraphEnd)).toBe(true);
      expect(tableLinesOf(ytext.toString())).toEqual(TABLE_LINES);
    });
  });

  it("supports an interceptor taking over local changes", async () => {
    ytext.insert(0, "Hello world.");
    const { view, binding } = editor();
    const seen: unknown[] = [];
    binding.setInterceptor((ops, text, origin) => {
      seen.push(ops);
      text.doc!.transact(() => text.insert(text.length, " (intercepted)"), origin);
      return true;
    });
    typeText(view, "X", 1);
    await new Promise<void>((r) => queueMicrotask(r));
    expect(seen).toEqual([[{ index: 0, deleteCount: 0, insert: "X" }]]);
    expect(ytext.toString()).toBe("Hello world. (intercepted)");
    expect(view.state.doc.textContent).toBe("Hello world. (intercepted)");
  });

  describe("parse verification", () => {
    const DOC = "# Title\n\nFirst paragraph with words.\n\n- one\n- two\n\nLast paragraph.";
    let visibility: DocumentVisibilityState;

    beforeEach(() => {
      vi.useFakeTimers();
      visibility = "visible";
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
    });
    afterEach(() => {
      vi.useRealTimers();
      delete (document as unknown as { visibilityState?: unknown }).visibilityState;
    });

    /** Type `ch` at the end of the last paragraph through the text (the code pane / remote path) and let the quiet period elapse. */
    const typeAndPause = (ch: string) => {
      ytext.insert(ytext.length, ch);
      vi.advanceTimersByTime(1000);
    };
    /** Drive the binding until the incremental parser is trusted. */
    const N = VERIFY_TRUST_AFTER;
    const trust = (binding: MarkdownBinding) => {
      for (let i = 0; i < N; i++) typeAndPause("x");
      expect(binding.verifyStats).toMatchObject({ runs: N, matches: N, mismatches: 0, skipped: 0 });
    };

    it("detects structural edits", () => {
      const structural = (before: string, after: string) => {
        const span = textChangeSpan(before, after)!;
        return isStructuralChange(before, after, span);
      };
      expect(structural("Hello world", "Hello brave world")).toBe(false);
      expect(structural("Hello world", "Hello **brave** world")).toBe(false);
      expect(structural("Hello world", "Hello `brave` world")).toBe(false);
      expect(structural("Hello world", "Hello [world]")).toBe(true);
      expect(structural("Hello world", "Hello world[^1]")).toBe(true);
      expect(structural("a | b", "a | bc")).toBe(true);
      expect(structural("Hello", "# Hello")).toBe(true);
      expect(structural("Hello", "- Hello")).toBe(true);
      expect(structural("Hello", "> Hello")).toBe(true);
      expect(structural("Hello\n", "Hello\n---")).toBe(true);
      expect(structural("Hello world", "Hello\n\nworld")).toBe(true);
      expect(structural("```\ncode\n```", "```\ncod\n```")).toBe(false);
      expect(structural("```\ncode\n```", "\ncode\n```")).toBe(true);
      expect(structural("text\n\n    code", "text\n\n    cod")).toBe(true);
    });

    it("verifies an incremental parse after the quiet period and repairs drift", () => {
      ytext.insert(0, DOC);
      const { view, binding } = editor();
      typeAndPause("!");
      expect(binding.verifyStats).toMatchObject({ runs: 1, matches: 1, mismatches: 0 });

      // Inject a wrong incremental result and let the editor render it, as a drifted parse would.
      const wrong = parseMarkdown("# Wrong\n\nonly this");
      binding["parseCache"] = { text: ytext.toString(), result: wrong };
      binding.syncFromText();
      expect(view.state.doc.childCount).toBe(2);
      expect(view.state.doc.child(0).textContent).toBe("Wrong");

      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      expect(binding.verifyParse()).toBe(false);
      warn.mockRestore();
      expect(binding.verifyStats).toMatchObject({ runs: 2, matches: 1, mismatches: 1 });
      expect(view.state.doc.childCount).toBe(4);
      expect(view.state.doc.child(0).textContent).toBe("Title");
      expect(view.state.doc.child(3).textContent).toBe("Last paragraph.!");
      expect(binding.blocks.length).toBe(4);
    });

    it("skips the verification for routine edits once trusted, but not for structural ones", () => {
      ytext.insert(0, DOC);
      const { binding } = editor();
      trust(binding);

      typeAndPause("y");
      expect(binding.verifyStats).toMatchObject({ runs: N, skipped: 1 });
      typeAndPause(" more `code`");
      expect(binding.verifyStats).toMatchObject({ runs: N, skipped: 2 });

      typeAndPause(" [ref]");
      expect(binding.verifyStats).toMatchObject({ runs: N + 1, matches: N + 1, skipped: 2 });
      typeAndPause("\n\n## Heading");
      expect(binding.verifyStats).toMatchObject({ runs: N + 2, matches: N + 2, skipped: 2 });

      // A structural edit followed by a routine one within the same quiet period still verifies.
      ytext.insert(ytext.length, " [x]");
      typeAndPause("z");
      expect(binding.verifyStats).toMatchObject({ runs: N + 3, skipped: 2 });
    });

    it("still verifies a routine edit every 25th idle window once trusted", () => {
      ytext.insert(0, DOC);
      const { binding } = editor();
      trust(binding);
      for (let i = 0; i < VERIFY_EVERY_NTH_WINDOW - 1; i++) typeAndPause("r");
      expect(binding.verifyStats).toMatchObject({ runs: N, skipped: VERIFY_EVERY_NTH_WINDOW - 1 });
      typeAndPause("r");
      expect(binding.verifyStats).toMatchObject({ runs: N + 1, skipped: VERIFY_EVERY_NTH_WINDOW - 1 });
      typeAndPause("r");
      expect(binding.verifyStats).toMatchObject({ runs: N + 1, skipped: VERIFY_EVERY_NTH_WINDOW });
    });

    it("resets the trust after a mismatch", () => {
      ytext.insert(0, DOC);
      const { binding } = editor();
      trust(binding);
      binding["parseCache"] = { text: ytext.toString(), result: parseMarkdown("# Wrong") };
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      binding.verifyParse();
      warn.mockRestore();
      typeAndPause("q");
      expect(binding.verifyStats).toMatchObject({ runs: N + 2, mismatches: 1, skipped: 0 });
    });

    it("does not verify while the tab is hidden and catches up when it becomes visible", () => {
      ytext.insert(0, DOC);
      const { binding } = editor();
      visibility = "hidden";
      typeAndPause("h");
      vi.advanceTimersByTime(10000);
      expect(binding.verifyStats.runs).toBe(0);

      visibility = "visible";
      document.dispatchEvent(new Event("visibilitychange"));
      expect(binding.verifyStats.runs).toBe(0);
      vi.advanceTimersByTime(1000);
      expect(binding.verifyStats).toMatchObject({ runs: 1, matches: 1 });
    });

    it("cancels a pending verification when another keystroke arrives", () => {
      ytext.insert(0, DOC);
      const { binding } = editor();
      for (let i = 0; i < 5; i++) {
        ytext.insert(ytext.length, "k");
        vi.advanceTimersByTime(900);
      }
      expect(binding.verifyStats.runs).toBe(0);
      vi.advanceTimersByTime(100);
      expect(binding.verifyStats.runs).toBe(1);
    });
  });
});
