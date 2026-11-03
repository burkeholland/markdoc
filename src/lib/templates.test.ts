import { describe, expect, it } from "vitest";
import { TEMPLATES, PICKER_TEMPLATES, applyTemplate, getTemplate, todayIso, BLANK_TEMPLATE_ID, WELCOME_TEMPLATE_ID } from "./templates";
import { parseMarkdown } from "@/editor/markdown/parse";

const VARS = { user: "octocat", date: "2026-08-22" };

describe("templates", () => {
  it("ships eight picker templates with unique ids, including blank, plus the hidden welcome doc", () => {
    expect(PICKER_TEMPLATES).toHaveLength(8);
    expect(TEMPLATES).toHaveLength(9);
    const ids = TEMPLATES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain(BLANK_TEMPLATE_ID);
    expect(PICKER_TEMPLATES.map((t) => t.id)).not.toContain(WELCOME_TEMPLATE_ID);
    // Existing templates keep their order; the hidden one is appended.
    expect(ids.slice(0, 8)).toEqual(["blank", "meeting-notes", "project-readme", "design-doc", "weekly-status", "blog-post", "decision-record", "checklist"]);
    for (const t of TEMPLATES) {
      expect(t.id).toMatch(/^[a-z0-9-]+$/);
      expect(t.name.trim()).not.toBe("");
      expect(t.description.trim()).not.toBe("");
      if (t.id === BLANK_TEMPLATE_ID) expect(t.content).toBe("");
      else expect(t.content.trim()).not.toBe("");
    }
  });

  it("finds templates by id", () => {
    expect(getTemplate("meeting-notes")?.name).toBe("Meeting notes");
    expect(getTemplate("nope")).toBeUndefined();
  });

  it("keeps the blank template body empty", () => {
    expect(applyTemplate(getTemplate(BLANK_TEMPLATE_ID)!, VARS)).toEqual({ title: "Untitled", content: "" });
  });

  it("applyTemplate replaces every placeholder", () => {
    for (const t of TEMPLATES) {
      const { title, content } = applyTemplate(t, VARS);
      expect(title).not.toMatch(/\{\{/);
      expect(content).not.toMatch(/\{\{/);
      expect(title.trim()).not.toBe("");
    }
    const notes = applyTemplate(getTemplate("meeting-notes")!, VARS);
    expect(notes.content).toContain("**Date:** 2026-08-22");
    expect(notes.content).toContain("@octocat");
    const status = applyTemplate(getTemplate("weekly-status")!, VARS);
    expect(status.title).toBe("Weekly status 2026-08-22");
  });

  it("defaults the date to today", () => {
    const { content } = applyTemplate(getTemplate("meeting-notes")!, { user: "me" });
    expect(content).toContain(`**Date:** ${todayIso()}`);
    expect(todayIso(new Date("2026-01-05T23:59:00Z"))).toBe("2026-01-05");
  });

  it("every non-blank template parses through the editor's Markdown parser with at least one heading", () => {
    for (const t of TEMPLATES.filter((template) => template.id !== BLANK_TEMPLATE_ID)) {
      const { content } = applyTemplate(t, VARS);
      const result = parseMarkdown(content);
      expect(result.doc.childCount, t.id).toBeGreaterThan(0);
      expect(result.headings.length, t.id).toBeGreaterThan(0);
      expect(result.headings[0].level, t.id).toBe(1);
    }
  });

  it("exercises the GFM features the editor supports", () => {
    const all = TEMPLATES.map((t) => t.content).join("\n");
    expect(all).toMatch(/^- \[ \] /m); // task lists
    expect(all).toMatch(/^\| --- \|/m); // tables
    expect(all).toMatch(/^```\w+/m); // code fences
    expect(all).toMatch(/^> /m); // blockquotes
    expect(all).toMatch(/^1\. /m); // ordered lists
    expect(getTemplate("blog-post")!.content.startsWith("---\n")).toBe(true); // front matter
  });

  it("welcome doc: title, one h1 + four sections, three tasks, and the three 'try it' actions", () => {
    const welcome = getTemplate(WELCOME_TEMPLATE_ID)!;
    expect(welcome.showInPicker).toBe(false);
    const { title, content } = applyTemplate(welcome, VARS);
    expect(title).toBe("Welcome to Markdoc");
    const result = parseMarkdown(content);
    expect(result.headings.filter((h) => h.level === 1)).toHaveLength(1);
    expect(result.headings.filter((h) => h.level === 2)).toHaveLength(4);
    expect(content.match(/^- \[ \] /gm)).toHaveLength(3);
    expect(content).toContain("Type `/` here for a block menu");
    expect(content).toContain("Select this sentence and press Comment");
    expect(content).toContain("Type `/agent` here and follow the three steps");
    expect(content.trim().endsWith("Delete this doc when you're done — it's just a doc.")).toBe(true);
    expect(content).toContain("@octocat");
  });
});
