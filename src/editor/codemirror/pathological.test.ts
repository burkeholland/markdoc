import { describe, expect, it } from "vitest";
import { parser } from "@lezer/markdown";
import { pathologicalParagraphs } from "./pathological";

const guarded = parser.configure(pathologicalParagraphs);
const soup = "[".repeat(40_000) + "a" + "]".repeat(40_000);

function topLevel(tree: ReturnType<typeof guarded.parse>): string[] {
  const out: string[] = [];
  for (let n = tree.topNode.firstChild; n; n = n.nextSibling) out.push(`${n.name}:${n.from}-${n.to}`);
  return out;
}

describe("pathologicalParagraphs (code pane, #115)", () => {
  it("takes the bracket-soup paragraph as one opaque leaf in milliseconds and parses the rest normally", () => {
    const src = `# T\n\nbefore\n\n${soup}\n\nafter *em*\n`;
    const started = performance.now();
    const tree = guarded.parse(src);
    expect(performance.now() - started).toBeLessThan(500);
    expect(topLevel(tree)).toEqual(["ATXHeading1:0-3", "Paragraph:5-11", `UnrenderableParagraph:13-${13 + soup.length}`, `Paragraph:${15 + soup.length}-${25 + soup.length}`]);
  });

  it("keeps a soft-wrapped paragraph together and stops at blank lines and fences", () => {
    const tree = guarded.parse(`lead\n${soup}\nmore\n\nafter\n\`\`\`\n]\n\`\`\``);
    expect(topLevel(tree)[0]).toBe(`UnrenderableParagraph:0-${5 + soup.length + 5}`);
    expect(topLevel(tree).slice(1)).toEqual([`Paragraph:${soup.length + 12}-${soup.length + 17}`, `FencedCode:${soup.length + 18}-${soup.length + 27}`]);
  });

  it("leaves ordinary documents exactly as the stock parser reads them", () => {
    const normal = "# Hi\n\nSome [link](x) and **bold** _it_.\n\n- a\n- b\n\n> q\n\n```js\nx]\n```\n\n| a | b |\n|---|---|\n| ] | * |\n";
    expect(guarded.parse(normal).toString()).toBe(parser.parse(normal).toString());
    expect(guarded.parse("a]".repeat(1000)).toString()).toBe(parser.parse("a]".repeat(1000)).toString());
  });
});
