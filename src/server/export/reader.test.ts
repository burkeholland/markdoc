import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";

process.env.PGLITE_DATA_DIR = "memory://";
delete process.env.DATABASE_URL;

const { renderDocumentHtml, renderMarkdownBody, contentHash } = await import("./html");

const BASE = "https://docs.example.com";

const FIXTURE = [
  "---",
  "title: front",
  "---",
  "# Reader Fixture",
  "",
  "Intro paragraph with **bold** and `code`.",
  "",
  "## First Section",
  "",
  "- one",
  "- two",
  "",
  "### Sub point",
  "",
  "```ts",
  "const x: number = 1;",
  "```",
  "",
  "## Second Section",
  "",
  "| A | B |",
  "| - | - |",
  "| 1 | 2 |",
  "",
  "![pic](/api/assets/abc123)",
  "",
  "- [x] done",
  "- [ ] todo",
  "",
].join("\n");

// Captured from renderDocumentHtml BEFORE the body renderer was split out (commit 15a728f):
// the body between <main> and </main>, and the SHA-256 of the whole page (styles included).
// Length and hash re-captured after the stylesheet's vertical-rhythm change (task #346); the body is unchanged.
// Re-captured again for the Ink & teal look (task #416): Fraunces @import + stone/teal colours in the <style>; body unchanged.
const FIXTURE_BODY_BEFORE = `<h1 id="reader-fixture">Reader Fixture</h1>
<p>Intro paragraph with <strong>bold</strong> and <code>code</code>.</p>
<h2 id="first-section">First Section</h2>
<ul>
<li>one</li>
<li>two</li>
</ul>
<h3 id="sub-point">Sub point</h3>
<pre><code class="hljs language-ts"><span class="hljs-keyword">const</span> <span class="hljs-attr">x</span>: <span class="hljs-built_in">number</span> = <span class="hljs-number">1</span>;
</code></pre>
<h2 id="second-section">Second Section</h2>
<table>
<thead>
<tr>
<th>A</th>
<th>B</th>
</tr>
</thead>
<tbody>
<tr>
<td>1</td>
<td>2</td>
</tr>
</tbody>
</table>
<p><img src="https://docs.example.com/api/assets/abc123" alt="pic"></p>
<ul class="contains-task-list">
<li class="task-list-item"><input type="checkbox" checked disabled> done</li>
<li class="task-list-item"><input type="checkbox" disabled> todo</li>
</ul>`;
const FIXTURE_SHA256_BEFORE = "5f47cd50108adb1b4d07dfcf609d476a2156c6c1ab00133f4161deec34523b92";
const FIXTURE_LENGTH_BEFORE = 5782;

describe("renderMarkdownBody", () => {
  it("returns h1-h6 headings whose ids match the anchors in the HTML", async () => {
    const { html, headings } = await renderMarkdownBody(FIXTURE, { assetBaseUrl: BASE });
    expect(headings).toEqual([
      { id: "reader-fixture", level: 1, text: "Reader Fixture" },
      { id: "first-section", level: 2, text: "First Section" },
      { id: "sub-point", level: 3, text: "Sub point" },
      { id: "second-section", level: 2, text: "Second Section" },
    ]);
    for (const h of headings) expect(html).toContain(`<h${h.level} id="${h.id}">`);
  });

  it("flattens inline markup in heading text and keeps ids unique", async () => {
    const { html, headings } = await renderMarkdownBody("## Use `code` and **bold**\n\n## Dup\n\n## Dup\n", { assetBaseUrl: BASE });
    expect(headings.map((h) => h.text)).toEqual(["Use code and bold", "Dup", "Dup"]);
    expect(headings.map((h) => h.id)).toEqual(["use-code-and-bold", "dup", "dup-1"]);
    expect(html).toContain('<h2 id="dup-1">Dup</h2>');
  });

  it("resolves asset images against the base URL and keeps hljs classes", async () => {
    const { html } = await renderMarkdownBody("![a](/api/assets/xyz)\n\n```js\nlet a = 1;\n```\n", { assetBaseUrl: "" });
    expect(html).toContain('<img src="/api/assets/xyz" alt="a">');
    expect(html).toContain('class="hljs language-js"');
    expect(html).toContain('class="hljs-keyword"');
  });

  it("strips scripts and event handlers (sanitized before injection)", async () => {
    const { html } = await renderMarkdownBody('<script>alert(1)</script>\n\n<img src="x" onerror="alert(1)">\n\n# Ok\n', { assetBaseUrl: BASE });
    expect(html).not.toContain("<script");
    expect(html).not.toContain("onerror");
    expect(html).toContain('<h1 id="ok">Ok</h1>');
  });
});

describe("renderDocumentHtml after the refactor", () => {
  it("produces byte-identical output for the fixture", async () => {
    const html = await renderDocumentHtml({ title: "Reader <Fixture>", markdown: FIXTURE, assetBaseUrl: BASE });
    expect(html.length).toBe(FIXTURE_LENGTH_BEFORE);
    expect(html).toContain(`<main class="markdoc">\n${FIXTURE_BODY_BEFORE}\n</main>`);
    expect(createHash("sha256").update(html).digest("hex")).toBe(FIXTURE_SHA256_BEFORE);
  });
});

describe("contentHash", () => {
  it("is stable for identical text and differs for different text", () => {
    expect(contentHash("# Hello\n")).toBe(contentHash("# Hello\n"));
    expect(contentHash("# Hello\n")).toMatch(/^[0-9a-f]{64}$/);
    expect(contentHash("# Hello\n")).not.toBe(contentHash("# Hello!\n"));
    expect(contentHash("")).toBe(contentHash(""));
  });
});
