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
    const headings = [...markup.matchAll(/<h([1-6])\b[^>]*>([^<]*)<\/h\1>/g)].map(([, level, text]) => [Number(level), text]);

    expect(headings).toEqual([
      [1, "Markdown, together."],
      [2, "Two surfaces, one document"],
      [2, "Real-time collaboration"],
      [2, "Comments that stick"],
      [2, "Suggesting mode"],
      [2, "Version history"],
      [2, "GitHub-native storage"],
    ]);
  });
});
