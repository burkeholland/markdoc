import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Rules about the whole source tree that a link card depends on (#2317). They are read from the files,
 * since the thing to prove is that something is nowhere: a second place that makes a frame would not
 * pass through the allow-list, and a page that listens to messages would hear a provider's frame.
 */
const SRC = join(process.cwd(), "src");

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.(ts|tsx|mjs|js)$/.test(entry.name) && !/\.test\.[a-z]+$/.test(entry.name) ? [path] : [];
  });
}

const files = sources(SRC).map((path) => ({ name: relative(SRC, path).split(sep).join("/"), text: readFileSync(path, "utf8") }));
const withMatch = (pattern: RegExp) => files.filter((file) => pattern.test(file.text)).map((file) => file.name);

describe("what the source tree must not contain, for link cards (#2317)", () => {
  it("reads the tree it means to read", () => {
    expect(files.length).toBeGreaterThan(200);
    expect(files.map((file) => file.name)).toEqual(expect.arrayContaining(["editor/link-card-frame.ts", "components/reader/link-cards.tsx", "editor/prosemirror/nodeviews.ts", "proxy.ts"]));
  });

  it("a frame is made in one place only", () => {
    expect(withMatch(/createElement(NS)?\(\s*[^)]*["'`]i?frame["'`]/i)).toEqual(["editor/link-card-frame.ts"]);
    // Not written as markup either, in JSX or in a string.
    expect(withMatch(/<i?frame[\s>]/i)).toEqual([]);
  });

  it("no script element is made from code, and none with an address is written as markup", () => {
    expect(withMatch(/createElement(NS)?\(\s*[^)]*["'`]script["'`]/i)).toEqual([]);
    expect(withMatch(/<script[^>]*\ssrc\s*=/i)).toEqual([]);
  });

  it("no page listens to messages: a provider's frame can send them, and nothing hears them", () => {
    // The render worker and the worker pool talk over a thread's port, which no frame can reach.
    const threads = ["server/export/render-markdown.ts", "server/export/render-pool.ts"];
    expect(withMatch(/addEventListener\(\s*["'`]message["'`]|\.onmessage\s*=|\bonmessage\s*[:=]|onMessage=/).filter((name) => !threads.includes(name))).toEqual([]);
    expect(withMatch(/\.on\(\s*["'`]message["'`]/).filter((name) => !name.startsWith("server/"))).toEqual([]);
  });
});
