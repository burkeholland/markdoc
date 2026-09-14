// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView, keymap, runScopeHandlers } from "@codemirror/view";
import { defaultKeymap } from "@codemirror/commands";
import { closeBracketsKeymap } from "@codemirror/autocomplete";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { createMarkdownEditingKeymap, exitOrContinueMarkup } from "./continue-markup";

const extensions = [markdown({ base: markdownLanguage, codeLanguages: languages, addKeymap: false })];
const views: EditorView[] = [];

afterEach(() => {
  for (const view of views) view.destroy();
  views.length = 0;
});

function editor(
  doc: string,
  selection: number | { anchor: number; head: number } | EditorSelection = doc.length,
  beforeBackspace: () => void = () => {},
) {
  const view = new EditorView({
    state: EditorState.create({
      doc,
      selection: typeof selection === "number" ? { anchor: selection } : selection,
      extensions: [
        extensions,
        createMarkdownEditingKeymap(beforeBackspace),
        keymap.of([...closeBracketsKeymap, ...defaultKeymap]),
        EditorState.allowMultipleSelections.of(true),
      ],
    }),
    parent: document.body,
  });
  views.push(view);
  return {
    enter: () => exitOrContinueMarkup(view),
    // Use setup.ts's Backspace chain, including default indentation and selection handling.
    backspace: () => runScopeHandlers(view, new KeyboardEvent("keydown", { key: "Backspace" }), "editor"),
    get doc() {
      return view.state.doc.toString();
    },
    get cursor() {
      return view.state.selection.main.head;
    },
    get selection() {
      return view.state.selection;
    },
  };
}

describe("exitOrContinueMarkup", () => {
  it("continues a blockquote, then exits it on the empty marker line", () => {
    const ed = editor("> quote");
    expect(ed.enter()).toBe(true);
    expect(ed.doc).toBe("> quote\n> ");
    expect(ed.enter()).toBe(true);
    expect(ed.doc).toBe("> quote\n");
    expect(ed.cursor).toBe(ed.doc.length);
  });

  describe("list Backspace", () => {
    it("deletes a whole fallback indentation unit without losing text", () => {
      const beforeBackspace = vi.fn();
      const doc = "Paragraph above.\n\n  second bullet text";
      const ed = editor(doc, doc.indexOf("second bullet text"), beforeBackspace);

      expect(ed.backspace()).toBe(true);
      expect(ed.doc).toBe("Paragraph above.\n\nsecond bullet text");
      expect(ed.cursor).toBe(ed.doc.indexOf("second bullet text"));
      expect(beforeBackspace).toHaveBeenCalledTimes(1);
    });

    it("keeps the real fallback steps from an odd indentation column through joining", () => {
      const beforeBackspace = vi.fn();
      const doc = "first bullet text\n   second bullet text";
      const ed = editor(doc, doc.indexOf("second bullet text"), beforeBackspace);

      expect(ed.backspace()).toBe(true);
      expect(ed.doc).toBe("first bullet text\n  second bullet text");
      expect(ed.cursor).toBe(ed.doc.indexOf("second bullet text"));
      expect(beforeBackspace).toHaveBeenCalledTimes(1);
      expect(ed.backspace()).toBe(true);
      expect(ed.doc).toBe("first bullet text\nsecond bullet text");
      expect(ed.cursor).toBe(ed.doc.indexOf("second bullet text"));
      expect(beforeBackspace).toHaveBeenCalledTimes(2);
      expect(ed.backspace()).toBe(true);
      expect(ed.doc).toBe("first bullet textsecond bullet text");
      expect(ed.cursor).toBe("first bullet text".length);
      expect(beforeBackspace).toHaveBeenCalledTimes(3);
    });

    it("applies fallback deletion at every cursor with one undo boundary", () => {
      const beforeBackspace = vi.fn();
      const ed = editor(
        "abc\nxyz",
        EditorSelection.create([EditorSelection.cursor(3), EditorSelection.cursor(7)], 1),
        beforeBackspace,
      );

      expect(ed.backspace()).toBe(true);
      expect(ed.doc).toBe("ab\nxy");
      expect(ed.selection.ranges.map(({ anchor, head }) => ({ anchor, head }))).toEqual([
        { anchor: 2, head: 2 },
        { anchor: 5, head: 5 },
      ]);
      expect(ed.selection.mainIndex).toBe(1);
      expect(beforeBackspace).toHaveBeenCalledTimes(1);
    });

    it("deletes a reversed selection and a character at another cursor in the same keypress", () => {
      const beforeBackspace = vi.fn();
      const ed = editor(
        "abc\nxyz",
        EditorSelection.create([EditorSelection.range(3, 1), EditorSelection.cursor(7)], 1),
        beforeBackspace,
      );

      expect(ed.backspace()).toBe(true);
      expect(ed.doc).toBe("a\nxy");
      expect(ed.selection.ranges.map(({ anchor, head }) => ({ anchor, head }))).toEqual([
        { anchor: 1, head: 1 },
        { anchor: 4, head: 4 },
      ]);
      expect(ed.selection.mainIndex).toBe(1);
      expect(beforeBackspace).toHaveBeenCalledTimes(1);
    });

    for (const [name, firstMarker, secondMarker, markerPattern] of [
      ["bullet", "- ", "- ", /^- /gm],
      ["ordered", "1. ", "2. ", /^\d+\. /gm],
      ["task", "- [ ] ", "- [x] ", /^- \[[ x]\] /gm],
    ] as const) {
      const initial = `Paragraph above.\n\n${firstMarker}first bullet text\n${secondMarker}second bullet text\n\nParagraph below.`;

      it(`${name}: the first item becomes plain text and never regains its marker`, () => {
        const ed = editor(initial, initial.indexOf("first bullet text"));
        ed.backspace();
        expect(ed.doc).toBe(`Paragraph above.\n\nfirst bullet text\n${secondMarker}second bullet text\n\nParagraph below.`);
        expect(ed.cursor).toBe(ed.doc.indexOf("first bullet text"));
        ed.backspace();
        expect(ed.doc).toBe(`Paragraph above.\nfirst bullet text\n${secondMarker}second bullet text\n\nParagraph below.`);
        ed.backspace();
        expect(ed.doc).toBe(`Paragraph above.first bullet text\n${secondMarker}second bullet text\n\nParagraph below.`);
        expect((ed.doc.match(markerPattern) ?? []).length).toBe(1);
      });

      it(`${name}: end and selection deletion are narrow`, () => {
        const end = initial.indexOf("first bullet text") + "first bullet text".length;
        const atEnd = editor(initial, end);
        atEnd.backspace();
        expect(atEnd.doc).toBe(initial.replace("first bullet text", "first bullet tex"));

        const selected = editor(initial, {
          anchor: initial.indexOf("second bullet text"),
          head: initial.indexOf("second bullet text") + "second bullet text".length,
        });
        selected.backspace();
        expect(selected.doc).toBe(initial.replace("second bullet text", ""));
        selected.backspace();
        expect((selected.doc.match(markerPattern) ?? []).length).toBe(1);
        selected.backspace();
        expect((selected.doc.match(markerPattern) ?? []).length).toBe(1);
        expect(selected.doc).toContain("first bullet text");
      });

      it(`${name}: a later item joins the preceding item without losing either text`, () => {
        const beforeBackspace = vi.fn();
        const ed = editor(initial, initial.indexOf("second bullet text"), beforeBackspace);
        ed.backspace();
        expect(beforeBackspace).toHaveBeenCalledTimes(1);
        expect((ed.doc.match(markerPattern) ?? []).length).toBe(1);
        expect(ed.doc.match(/first bullet text/g)).toHaveLength(1);
        expect(ed.doc.match(/second bullet text/g)).toHaveLength(1);
        ed.backspace();
        expect(beforeBackspace).toHaveBeenCalledTimes(2);
        expect((ed.doc.match(markerPattern) ?? []).length).toBe(1);
        expect(ed.doc).toContain("\nsecond bullet text");
        ed.backspace();
        expect(beforeBackspace).toHaveBeenCalledTimes(3);
        expect(ed.doc).toContain(`${firstMarker}first bullet textsecond bullet text`);
        expect((ed.doc.match(markerPattern) ?? []).length).toBe(1);
        expect(ed.doc.match(/first bullet text/g)).toHaveLength(1);
        expect(ed.doc.match(/second bullet text/g)).toHaveLength(1);
      });

      it(`${name}: an empty first or second item loses its marker once`, () => {
        const firstEmpty = `Paragraph above.\n\n${firstMarker}\n${secondMarker}second bullet text`;
        const first = editor(firstEmpty, firstEmpty.indexOf("\n", "Paragraph above.".length) + 2 + firstMarker.length);
        first.backspace();
        expect((first.doc.match(markerPattern) ?? []).length).toBe(1);
        first.backspace();
        expect((first.doc.match(markerPattern) ?? []).length).toBe(1);

        const secondEmpty = `Paragraph above.\n\n${firstMarker}first bullet text\n${secondMarker}`;
        const second = editor(secondEmpty);
        second.backspace();
        expect((second.doc.match(markerPattern) ?? []).length).toBe(1);
        second.backspace();
        expect((second.doc.match(markerPattern) ?? []).length).toBe(1);
      });
    }

    it("starts an undo boundary for markup and fallback deletion", () => {
      const beforeBackspace = vi.fn();
      editor("- item", 2, beforeBackspace).backspace();
      editor("plain", 5, beforeBackspace).backspace();
      expect(beforeBackspace).toHaveBeenCalledTimes(2);
    });
  });

  it("exits a blockquote that follows other content", () => {
    const ed = editor("# Notes\n\n- [ ] Write documentation\n\n\n> A quote from the source");
    ed.enter();
    ed.enter();
    expect(ed.doc).toBe("# Notes\n\n- [ ] Write documentation\n\n\n> A quote from the source\n");
    // Outside the quote now, so the default Enter binding takes over.
    expect(ed.enter()).toBe(false);
  });

  it("exits one level of a nested blockquote at a time", () => {
    const ed = editor("> > deep");
    ed.enter();
    expect(ed.doc).toBe("> > deep\n> > ");
    ed.enter();
    expect(ed.doc).toBe("> > deep\n> ");
    ed.enter();
    expect(ed.doc).toBe("> > deep\n");
  });

  it("exits a bullet list on the empty marker line", () => {
    const ed = editor("- item");
    ed.enter();
    expect(ed.doc).toBe("- item\n- ");
    ed.enter();
    expect(ed.doc).toBe("- item\n");
  });

  it("exits a two-item tight list instead of loosening it", () => {
    const ed = editor("- a\n- b");
    ed.enter();
    expect(ed.doc).toBe("- a\n- b\n- ");
    ed.enter();
    expect(ed.doc).toBe("- a\n- b\n");
  });

  it("exits a task list on the empty marker line", () => {
    const ed = editor("- [ ] task");
    ed.enter();
    expect(ed.doc).toBe("- [ ] task\n- [ ] ");
    ed.enter();
    expect(ed.doc).toBe("- [ ] task\n");
  });

  it("exits an ordered list on the empty marker line", () => {
    const ed = editor("1. one");
    ed.enter();
    expect(ed.doc).toBe("1. one\n2. ");
    ed.enter();
    expect(ed.doc).toBe("1. one\n");
  });

  it("still continues the quote when Enter is pressed mid-line", () => {
    const ed = editor("> quoted text", "> quoted ".length);
    expect(ed.enter()).toBe(true);
    expect(ed.doc).toBe("> quoted\n> text");
  });

  it("leaves plain paragraphs to the default Enter binding", () => {
    const ed = editor("plain text");
    expect(ed.enter()).toBe(false);
    expect(ed.doc).toBe("plain text");
  });
});
