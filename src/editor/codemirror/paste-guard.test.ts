// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type * as Y from "yjs";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { ensureSyntaxTree } from "@codemirror/language";
import { codePasteGuard, type CodePasteGuardOptions } from "./paste-guard";

const TSV = "Name\tQty\tPrice\nApple\t3\t1.20\nPear\t5\t0.80\n";
const TABLE = "| Name  | Qty | Price |\n| ----- | --- | ----- |\n| Apple | 3   | 1.20  |\n| Pear  | 5   | 0.80  |";

let views: EditorView[] = [];
afterEach(() => {
  for (const v of views) v.destroy();
  views = [];
});

function editor(doc: string, cursor = doc.length, options: CodePasteGuardOptions = {}) {
  const view = new EditorView({
    state: EditorState.create({
      doc,
      selection: { anchor: cursor },
      extensions: [markdown({ base: markdownLanguage, addKeymap: false }), codePasteGuard(options)],
    }),
    parent: document.body,
  });
  views.push(view);
  ensureSyntaxTree(view.state, view.state.doc.length, 1000);
  return view;
}

/** Fire a paste event with the given text/plain payload; returns the document text afterwards. */
function paste(view: EditorView, text: string): string {
  // jsdom has no DataTransfer; a ClipboardEvent with a stubbed clipboardData is what the handler reads.
  const event = new Event("paste", { bubbles: true, cancelable: true }) as ClipboardEvent;
  Object.defineProperty(event, "clipboardData", { value: { getData: (type: string) => (type === "text/plain" ? text : "") } });
  view.contentDOM.dispatchEvent(event);
  return view.state.doc.toString();
}

describe("codePasteGuard TSV (#166)", () => {
  it("inserts tab-separated text as a Markdown table on its own lines", () => {
    const view = editor("Intro");
    expect(paste(view, TSV)).toBe("Intro\n" + TABLE);
    expect(view.state.selection.main.head).toBe(view.state.doc.length);
  });

  it("leaves a single line with tabs to the default paste", () => {
    const view = editor("Intro");
    expect(paste(view, "a\tb\tc")).toBe("Introa\tb\tc");
  });

  it("leaves ragged rows to the default paste", () => {
    const view = editor("Intro");
    expect(paste(view, "a\tb\nc\td\te")).toBe("Introa\tb\nc\td\te");
  });

  it("leaves TSV alone inside a fenced code block", () => {
    const view = editor("```\nx\n```", 5);
    expect(paste(view, "a\tb\nc\td")).toBe("```\nxa\tb\nc\td\n```");
  });

  it("notifies with an Undo action that runs the undo manager as one step", () => {
    const undoManager = { undo: vi.fn(), stopCapturing: vi.fn() } as unknown as Y.UndoManager;
    const notices: [string, { label: string; onClick: () => void } | undefined][] = [];
    const view = editor("Intro", 5, { onNotice: (m, a) => notices.push([m, a]), undoManager });
    paste(view, TSV);
    // Capturing is cut before and after the insert so the table is its own undo step.
    expect(undoManager.stopCapturing).toHaveBeenCalledTimes(2);
    expect(notices).toHaveLength(1);
    expect(notices[0][0]).toBe("Pasted tab-separated text as a table");
    expect(notices[0][1]?.label).toBe("Undo");
    notices[0][1]!.onClick();
    expect(undoManager.undo).toHaveBeenCalledTimes(1);
  });
});
