import { describe, expect, it } from "vitest";

process.env.PGLITE_DATA_DIR = "memory://";
process.env.AUTH_SECRET = "test-secret-test-secret-test-secret";
delete process.env.DATABASE_URL;

const { excerpt } = await import("@/server/documents");
const { htmlToMarkdown } = await import("@/server/import-file");

describe("excerpt (#158)", () => {
  it("keeps an image's alt text and drops its URL", () => {
    expect(excerpt("# Dropped doc\n\nHello ![pixel](./pixel.png) world.\n")).toBe("Hello pixel world.");
    expect(excerpt("# Dropped doc\n\nHello ![pixel](/api/assets/y7j816vpf1wvljmy) world.\n")).toBe("Hello pixel world.");
  });

  it("reads an imported HTML page as its rendered text: link text, no pipes, table cells joined by spaces", async () => {
    const md = await htmlToMarkdown(
      '<h1>HTML Title</h1><p>Para <strong>bold</strong> <a href="https://x.y">link</a></p><table><tr><th>a</th><th>b</th></tr><tr><td>1</td><td>2</td></tr></table>',
    );
    expect(excerpt(md)).toBe("Para bold link a b 1 2");
  });

  it("skips front matter, fenced code and headings and starts at the first real sentence", () => {
    const doc = [
      "",
      "---",
      "title: Notes",
      "tags: [a, b]",
      "---",
      "",
      "```js",
      "const hidden = '| not | shown |';",
      "```",
      "",
      "# Notes",
      "",
      "## Section",
      "",
      "> The first *real* sentence, with `code` and a <https://auto.link>.",
      "",
      "- [ ] a task",
    ].join("\n");
    expect(excerpt(doc)).toBe("The first real sentence, with code and a . a task");
  });

  it("falls back to heading text when the document has no prose, and is empty for an empty document", () => {
    expect(excerpt("# Only a title\n\n## And a section\n")).toBe("Only a title And a section");
    expect(excerpt("")).toBe("");
    expect(excerpt("\n\n")).toBe("");
  });

  it("is cut at 160 characters", () => {
    const long = "word ".repeat(100);
    const e = excerpt(long);
    expect(e.length).toBeLessThanOrEqual(160);
    expect(e.startsWith("word word")).toBe(true);
  });

  it("handles a 40k-`[` paragraph in well under 50 ms (#115 guard)", () => {
    const doc = `# Title\n\n${"[".repeat(40_000)}\n\nAfter the brackets.\n`;
    const t0 = performance.now();
    const e = excerpt(doc);
    const ms = performance.now() - t0;
    expect(e.startsWith("[[[")).toBe(true);
    expect(e.length).toBe(160);
    expect(ms).toBeLessThan(50);
  });
});
