// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { DOMSerializer } from "prosemirror-model";
import { EditorState, TextSelection, type Transaction } from "prosemirror-state";
import { history, undo } from "prosemirror-history";
import { EditorView } from "prosemirror-view";
import { parseMarkdown } from "../markdown/parse";
import { serializeMarkdown } from "../markdown/serialize";
import { createNodeViews } from "./nodeviews";

const views: EditorView[] = [];

afterEach(() => {
  for (const view of views.splice(0)) view.destroy();
  document.body.replaceChildren();
});

describe("code block wrapping", () => {
  const source = "1. Paste this:\n\n   ```markdown\n   Long prose with  spaces.\n     indented https://example.com/averylongtoken\n   ```\n\n```js\nconst answer = 42;\n```\n";

  function setup(canEdit = true) {
    const transactions: Transaction[] = [];
    const view: EditorView = new EditorView(document.body.appendChild(document.createElement("div")), {
      state: EditorState.create({ doc: parseMarkdown(source).doc, plugins: [history()] }),
      editable: () => canEdit,
      nodeViews: createNodeViews(() => canEdit),
      dispatchTransaction(tr) {
        transactions.push(tr);
        view.updateState(view.state.apply(tr));
      },
    });
    views.push(view);
    const blocks = view.dom.querySelectorAll<HTMLElement>("pre.md-code-block");
    const buttons = view.dom.querySelectorAll<HTMLButtonElement>(".md-code-wrap");
    return { view, blocks, buttons, transactions };
  }

  it.each([true, false])("toggles blocks independently without transactions (canEdit=%s)", async (canEdit) => {
    const { view, blocks, buttons, transactions } = setup(canEdit);
    const doc = view.state.doc;
    const selection = view.state.selection;
    expect(buttons).toHaveLength(2);
    expect(buttons[0].getAttribute("aria-label")).toBe("Wrap code block");
    expect(buttons[0].closest(".md-code-controls")?.getAttribute("contenteditable")).toBe("false");
    expect(buttons[0].disabled).toBe(false);
    expect(buttons[0].getAttribute("aria-pressed")).toBe("false");

    buttons[0].click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(blocks[0].classList.contains("md-code-wrapped")).toBe(true);
    expect(buttons[0].getAttribute("aria-pressed")).toBe("true");
    expect(blocks[1].classList.contains("md-code-wrapped")).toBe(false);
    expect(buttons[1].getAttribute("aria-pressed")).toBe("false");
    expect(view.state.doc).toBe(doc);
    expect(view.state.selection.eq(selection)).toBe(true);
    expect(transactions).toHaveLength(0);

    buttons[0].click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(buttons[0].getAttribute("aria-pressed")).toBe("false");
    expect(blocks[0].classList.contains("md-code-wrapped")).toBe(false);
    expect(transactions).toHaveLength(0);
  });

  it("preserves text, serialization, selection and undo while a wrapped block is edited", async () => {
    const { view, blocks, buttons, transactions } = setup();
    let position = 0;
    view.state.doc.descendants((node, pos) => {
      if (node.type.name === "code_block" && !position) position = pos + 1;
    });
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, position, position + 4)));
    const selection = view.state.selection;
    const before = serializeMarkdown(view.state.doc);
    buttons[0].dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    buttons[0].click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(view.state.selection.eq(selection)).toBe(true);
    expect(serializeMarkdown(view.state.doc)).toBe(before);
    expect(transactions).toHaveLength(1);
    expect(blocks[0].querySelector("code")?.textContent).toBe("Long prose with  spaces.\n  indented https://example.com/averylongtoken");

    const copied = document.createElement("div");
    copied.appendChild(DOMSerializer.fromSchema(view.state.schema).serializeFragment(view.state.doc.content));
    expect(copied.querySelector("button, input, .md-code-controls")).toBeNull();
    expect(copied.querySelector("code")?.textContent).toBe(blocks[0].querySelector("code")?.textContent);

    view.dispatch(view.state.tr.insertText("Edited ", position));
    expect(buttons[0].getAttribute("aria-pressed")).toBe("true");
    expect(blocks[0].querySelector("code")?.textContent).toContain("Edited Long");
    expect(undo(view.state, view.dispatch)).toBe(true);
    expect(serializeMarkdown(view.state.doc)).toBe(before);
    expect(buttons[0].getAttribute("aria-pressed")).toBe("true");
  });
});

describe("list item node view", () => {
  it("names task checkboxes after their task text", () => {
    const state = EditorState.create({
      doc: parseMarkdown("- [ ] Edit **this** task\n- [x] Another task").doc,
    });
    const view = new EditorView(document.body.appendChild(document.createElement("div")), {
      state,
      nodeViews: createNodeViews(() => true),
    });
    views.push(view);

    expect(
      Array.from(view.dom.querySelectorAll(".md-task-checkbox")).map((checkbox) => checkbox.getAttribute("aria-label")),
    ).toEqual(["Edit this task", "Another task"]);
  });
});
