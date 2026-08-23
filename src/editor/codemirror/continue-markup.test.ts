import { describe, expect, it } from "vitest";
import { EditorState, type StateCommand } from "@codemirror/state";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { exitOrContinueMarkup, markdownEditingKeymap } from "./continue-markup";

// Same markdown configuration as setup.ts, minus the view/collab pieces that need a DOM.
const extensions = [markdown({ base: markdownLanguage, codeLanguages: languages, addKeymap: false }), markdownEditingKeymap];

function editor(doc: string, cursor = doc.length) {
  let state = EditorState.create({ doc, selection: { anchor: cursor }, extensions });
  const run = (command: StateCommand) =>
    command({
      state,
      dispatch: (tr) => {
        state = tr.state;
      },
    });
  return {
    enter: () => run(exitOrContinueMarkup),
    get doc() {
      return state.doc.toString();
    },
    get cursor() {
      return state.selection.main.head;
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
