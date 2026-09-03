const WORDS = [
  "native",
  "browser",
  "editing",
  "keeps",
  "document",
  "content",
  "selection",
  "collaboration",
  "source",
  "updates",
  "responsive",
  "today",
] as const;

export const TYPING_PERFORMANCE_PARAGRAPHS = 1_000;

function paragraph(index: number): string {
  const id = index.toString().padStart(4, "0");
  const words: string[] = [...WORDS];
  words[index % words.length] = index % 2 === 0 ? "**responsive**" : "[responsive](https://example.com/editor)";
  if (index % 7 === 0) words[(index + 3) % words.length] = "`selection`";
  return `Benchmark paragraph ${id} ${words.join(" ")}.`;
}

export function generateTypingPerformanceDocument(): string {
  const blocks: string[] = ["# Long-document typing benchmark"];
  for (let index = 0; index < TYPING_PERFORMANCE_PARAGRAPHS; index++) {
    if (index > 0 && index % 100 === 0) blocks.push(`## Section ${index / 100}`);
    if (index > 0 && index % 250 === 0) {
      blocks.push("- deterministic list item\n- collaboration list item\n- rendering list item");
      blocks.push("```ts\nconst responsiveness = \"measured\";\n```");
    }
    blocks.push(paragraph(index));
  }
  return blocks.join("\n\n");
}

export const TYPING_PERFORMANCE_DOCUMENT = generateTypingPerformanceDocument();
export const TYPING_PERFORMANCE_COMMENT_QUOTES = Array.from(
  { length: 20 },
  (_, index) => `Benchmark paragraph ${(index * 47).toString().padStart(4, "0")}`,
);
export const TYPING_PERFORMANCE_TEXT = "abcdefghijklmnopqrstuvwxyz".repeat(4).slice(0, 100);
export const TYPING_PERFORMANCE_WARMUP = "warmuptext";
