import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { listToolNames } from "../../../../mcp/tools.mjs";

/**
 * `docs/agents.md` says how many MCP tools there are in words ("Twenty-seven tools") and lists each
 * one in the tools table; `GET /api/mcp` says it as a number. They drifted once (26 vs 27, #121),
 * so this pins both to `listToolNames()`.
 */
const WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
const inWords = (n: number) => (n < 20 ? WORDS[n] : `${TENS[Math.floor(n / 10)]}${n % 10 ? `-${WORDS[n % 10]}` : ""}`);

describe("docs/agents.md MCP tool count", () => {
  it("names the same number of tools as mcp/tools.mjs registers, in words and in the table", async () => {
    const docs = await readFile(fileURLToPath(new URL("../../../../docs/agents.md", import.meta.url)), "utf8");
    const names = listToolNames();
    const expected = inWords(names.length);
    const sentence = docs.match(/^([A-Z][a-z-]+) tools; every `id` is the document id/m);
    expect(sentence?.[1].toLowerCase(), `docs say "${sentence?.[0]}" but there are ${names.length} tools (${expected})`).toBe(expected);
    for (const name of names) expect(docs, `${name} missing from the tools table`).toContain(`\`${name}\``);
  });
});
