// @vitest-environment jsdom
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { renderDocumentHtml } from "./html";

const token = "longprose".repeat(32);
const url = `https://example.com/${token}?view=full&mode=read#section`;
const fencedCode = `  ${token}\n\tindent\n`;

function styleFor(rules: CSSRuleList, selector: string): CSSStyleDeclaration {
  const rule = Array.from(rules).find(
    (rule): rule is CSSStyleRule => rule instanceof CSSStyleRule && rule.selectorText === selector,
  );
  if (!rule) throw new Error(`Missing exported style rule: ${selector}`);
  return rule.style;
}

describe("standalone HTML prose layout", () => {
  beforeAll(async () => {
    const html = await renderDocumentHtml({
      title: "Long prose & code",
      assetBaseUrl: "https://example.com",
      markdown: [
        `## ${token}`,
        `Before ${token} after.  \nNext line.`,
        `[${url}](${url}) [Jump](#${token})`,
        `Inline \`${token}\`.`,
        `| Long value |\n| --- |\n| ${token} |`,
        `\`\`\`text\n${fencedCode}\`\`\``,
      ].join("\n\n"),
    });
    document.open();
    document.write(html);
    document.close();
  });

  afterAll(() => {
    document.head.replaceChildren();
    document.body.replaceChildren();
  });

  it("keeps literal prose, destinations, heading ids, table structure and code in a standalone page", () => {
    expect(token.length).toBeGreaterThanOrEqual(256);
    expect(document.doctype?.name).toBe("html");
    expect(document.documentElement.lang).toBe("en");
    expect(document.title).toBe("Long prose & code");
    expect(document.querySelector('meta[charset]')?.getAttribute("charset")).toBe("utf-8");
    expect(document.querySelector('meta[name="viewport"]')?.getAttribute("content"))
      .toBe("width=device-width, initial-scale=1");
    expect(document.head.querySelectorAll("style")).toHaveLength(1);
    expect(document.querySelector("script")).toBeNull();
    expect(document.body.children).toHaveLength(1);
    const main = document.querySelector("body > main.markdoc");
    expect(main).not.toBeNull();
    expect(main?.querySelector("h2")?.textContent).toBe(token);
    expect(main?.querySelector("h2")?.id).toBe(token);
    expect(main?.querySelector("p")?.textContent).toBe(`Before ${token} after.\nNext line.`);
    expect(main?.querySelectorAll("p > br")).toHaveLength(1);
    const links = main?.querySelectorAll("a");
    expect(links).toHaveLength(2);
    expect(links?.[0].textContent).toBe(url);
    expect(links?.[0].getAttribute("href")).toBe(url);
    expect(links?.[1].getAttribute("href")).toBe(`#${token}`);
    expect(main?.querySelector("p > code")?.textContent).toBe(token);
    expect(main?.querySelector("table > thead > tr > th")?.textContent).toBe("Long value");
    expect(main?.querySelector("table > tbody > tr > td")?.textContent).toBe(token);
    expect(main?.querySelector("pre > code")?.textContent).toBe(fencedCode);
  });

  it("scopes emergency wrapping to main while retaining screen scrolling and the print rules", () => {
    const sheet = document.styleSheets[0];
    const main = styleFor(sheet.cssRules, "main");
    expect(main.getPropertyValue("overflow-wrap")).toBe("anywhere");
    expect(main.getPropertyValue("max-width")).toBe("820px");
    const pre = styleFor(sheet.cssRules, "pre");
    expect(pre.getPropertyValue("white-space")).toBe("pre");
    expect(pre.getPropertyValue("overflow-x")).toBe("auto");
    expect(styleFor(sheet.cssRules, "table").getPropertyValue("table-layout")).toBe("");
    const print = Array.from(sheet.cssRules).find(
      (rule): rule is CSSMediaRule => rule instanceof CSSMediaRule && rule.conditionText === "print",
    );
    expect(print).toBeDefined();
    expect(Array.from(print!.cssRules, (rule) => rule.cssText)).toEqual([
      "@page { margin: 0.75in; }",
      "body { font-size: 11pt; color: rgb(28, 25, 23); }",
      "main { max-width: none; padding: 0px; }",
      "a { color: inherit; text-decoration: underline; }",
      "pre, blockquote, table, img, figure { break-inside: avoid; page-break-inside: avoid; }",
      "tr { break-inside: avoid; page-break-inside: avoid; }",
      "h1, h2, h3, h4, h5, h6 { break-after: avoid; page-break-after: avoid; }",
      "pre { white-space: pre-wrap; word-break: break-word; overflow: visible; }",
    ]);
    const rules = [...Array.from(sheet.cssRules), ...Array.from(print!.cssRules)];
    for (const rule of rules) {
      if (!(rule instanceof CSSStyleRule)) continue;
      expect(rule.style.getPropertyValue("overflow-wrap")).toBe(rule.style === main ? "anywhere" : "");
      expect(rule.style.getPropertyValue("word-break")).not.toBe("break-all");
      expect(rule.style.getPropertyValue("overflow")).not.toBe("hidden");
      expect(rule.style.getPropertyValue("text-overflow")).toBe("");
    }
  });
});
