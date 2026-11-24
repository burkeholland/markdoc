import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/auth", () => ({
  auth: vi.fn(async () => null),
  githubConfigured: false,
}));
vi.mock("@/server/http", () => ({
  embeddedDocumentPath: vi.fn(async () => null),
}));

import HomePage from "./page";

describe("Landing heading outline", () => {
  it("uses H1 followed by H2 feature headings", async () => {
    const markup = renderToStaticMarkup(await HomePage());
    const headings = [...markup.matchAll(/<h([1-6])\b[^>]*>(.*?)<\/h\1>/g)].map(([, level, text]) => [Number(level), text.replace(/<br\/>/g, " ")]);

    expect(headings).toEqual([
      [1, "Markdown, together."],
      [2, "Type in either side."],
      [2, "Comments stay on the words."],
      [2, "Every version, kept."],
      [2, "Save it to GitHub."],
      [2, "Start a doc. Bring your team."],
    ]);
  });

  it("keeps all entry points on the existing sign-in flow and section links on the page", async () => {
    const markup = renderToStaticMarkup(await HomePage());
    expect([...markup.matchAll(/href="\/login"/g)]).toHaveLength(3);
    expect(markup).toContain("Start writing");
    for (const [, id] of markup.matchAll(/href="#([^"]+)"/g)) {
      expect(markup).toContain(`id="${id}"`);
    }
    expect(markup).not.toMatch(/<(button|input)\b/);
  });
});
