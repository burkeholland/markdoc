import { JSDOM } from "jsdom";
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
    const document = new JSDOM(renderToStaticMarkup(await HomePage())).window.document;

    expect(
      [...document.querySelectorAll("h1, h2, h3")].map((heading) => [heading.tagName, heading.textContent?.trim()]),
    ).toEqual([
      ["H1", "Markdown, together."],
      ["H2", "Two surfaces, one document"],
      ["H2", "Real-time collaboration"],
      ["H2", "Comments that stick"],
      ["H2", "Suggesting mode"],
      ["H2", "Version history"],
      ["H2", "GitHub-native storage"],
    ]);
  });
});
