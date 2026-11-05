// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { EditorState } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { parseMarkdown } from "../markdown/parse";
import { createNodeViews } from "./nodeviews";

const views: EditorView[] = [];

afterEach(() => {
  for (const view of views.splice(0)) view.destroy();
  document.body.replaceChildren();
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
