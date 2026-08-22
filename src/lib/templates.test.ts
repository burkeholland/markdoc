import { describe, expect, it } from "vitest";
import { TEMPLATES, applyTemplate, getTemplate, todayIso, BLANK_TEMPLATE_ID } from "./templates";
import { parseMarkdown } from "@/editor/markdown/parse";

const VARS = { user: "octocat", date: "2026-08-22" };

describe("templates", () => {
  it("ships eight templates with unique ids, including blank", () => {
    expect(TEMPLATES).toHaveLength(8);
    const ids = TEMPLATES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain(BLANK_TEMPLATE_ID);
    for (const t of TEMPLATES) {
      expect(t.id).toMatch(/^[a-z0-9-]+$/);
      expect(t.name.trim()).not.toBe("");
      expect(t.description.trim()).not.toBe("");
      expect(t.content.trim()).not.toBe("");
    }
  });

  it("finds templates by id", () => {
    expect(getTemplate("meeting-notes")?.name).toBe("Meeting notes");
    expect(getTemplate("nope")).toBeUndefined();
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

  it("every template parses through the editor's Markdown parser with at least one heading", () => {
    for (const t of TEMPLATES) {
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
});
