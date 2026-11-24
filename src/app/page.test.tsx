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
  it("keeps just the hero and product preview above a minimal footer", async () => {
    const markup = renderToStaticMarkup(await HomePage());
    const headings = [...markup.matchAll(/<h([1-6])\b[^>]*>(.*?)<\/h\1>/g)].map(([, level, text]) => [Number(level), text.replace(/<br\/>/g, " ")]);

    expect(headings).toEqual([
      [1, "Markdown, together."],
    ]);
    expect(markup.match(/<section\b/g)).toHaveLength(2);
    expect(markup).toContain("<footer");
    expect(markup).toContain("Offline mode launch");
    expect(markup).toContain("Write, preview, edit, comment – all in realtime with your team or agent");
  });

  it("keeps both sign-in entry points without links to removed sections", async () => {
    const markup = renderToStaticMarkup(await HomePage());
    expect([...markup.matchAll(/href="\/login"/g)]).toHaveLength(2);
    expect(markup).toContain("Start writing");
    expect(markup).not.toContain('href="#');
    expect(markup).not.toMatch(/<(button|input)\b/);
  });
});
