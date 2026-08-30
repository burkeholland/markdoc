// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import hljs from "highlight.js/lib/core";
import { common, createLowlight } from "lowlight";
import type { Node as PMNode } from "prosemirror-model";
import { EditorState, type Transaction } from "prosemirror-state";
import { EditorView } from "prosemirror-view";

type Module = typeof import("./code-highlight");

interface Harness {
  mod: Module;
  parse: (src: string) => PMNode;
  /** Lets the mocked grammar chunk resolve (or reject when `fail` was requested). */
  release: () => void;
  /** How often the chunk module was evaluated: 1 per `import()` that reached the module registry. */
  factoryCalls: () => number;
  /** How often the loader registered `common` into lowlight: 1 per resolved `import()` handler. */
  registerCalls: () => number;
  /** Waits for the import() machinery, which resolves mocks asynchronously. */
  tick: () => Promise<void>;
}

/**
 * Fresh module-under-test per test (its loader state is module-level) with `./code-highlight-languages`
 * replaced by a gated mock. The schema and parser are re-imported alongside it so node types match.
 */
async function load(options: { fail?: boolean } = {}): Promise<Harness> {
  let factoryCalls = 0;
  let registerCalls = 0;
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.doMock("./code-highlight-languages", async () => {
    factoryCalls += 1;
    await gate;
    if (options.fail) throw new Error("simulated chunk load failure");
    const actual = await vi.importActual<typeof import("./code-highlight-languages")>("./code-highlight-languages");
    // lowlight.register() enumerates the grammar object once per call; count that instead of the
    // factory, which the module registry would run only once even if import() were called twice.
    const counted = new Proxy(actual.common, {
      ownKeys(target) {
        registerCalls += 1;
        return Reflect.ownKeys(target);
      },
    });
    return { common: counted };
  });
  vi.resetModules();
  const mod = await import("./code-highlight");
  const { parseMarkdown } = await import("../markdown/parse");
  return {
    mod,
    parse: (src) => parseMarkdown(src).doc,
    release,
    factoryCalls: () => factoryCalls,
    registerCalls: () => registerCalls,
    tick: () => new Promise((resolve) => setTimeout(resolve, 0)),
  };
}

const views: EditorView[] = [];

function makeView(mod: Module, doc: PMNode) {
  const plugin = mod.codeHighlightPlugin();
  const state = EditorState.create({ doc, plugins: [plugin] });
  const dispatched: Transaction[] = [];
  const host = document.body.appendChild(document.createElement("div"));
  const view: EditorView = new EditorView(host, {
    state,
    dispatchTransaction(tr) {
      dispatched.push(tr);
      view.updateState(view.state.apply(tr));
    },
  });
  views.push(view);
  return {
    view,
    dispatched,
    decorations: () => plugin.getState(view.state)?.find() ?? [],
    coloured: () => view.dom.querySelectorAll('span[class*="hljs-"]').length,
  };
}

const JS_DOC = "# Title\n\n```js\nconst answer = 42;\nfunction f() { return answer; }\n```\n";

afterEach(() => {
  for (const view of views) {
    view.destroy();
    view.dom.parentElement?.remove();
  }
  views.length = 0;
  vi.doUnmock("./code-highlight-languages");
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("static language lists", () => {
  it("COMMON_LANGUAGES is exactly lowlight's common grammar set", async () => {
    const { mod } = await load();
    expect([...mod.COMMON_LANGUAGES].sort()).toEqual(Object.keys(common).sort());
    expect(mod.COMMON_LANGUAGES.size).toBe(37);
  });

  it("COMMON_LANGUAGE_ALIASES is exactly the aliases highlight.js declares on the common grammars", async () => {
    const { mod } = await load();
    const declared = new Set<string>();
    for (const [name, grammar] of Object.entries(common)) {
      hljs.registerLanguage(name, grammar);
      for (const alias of hljs.getLanguage(name)?.aliases ?? []) declared.add(alias);
    }
    expect([...mod.COMMON_LANGUAGE_ALIASES].sort()).toEqual([...declared].sort());
    for (const alias of mod.COMMON_LANGUAGE_ALIASES) expect(mod.COMMON_LANGUAGES.has(alias)).toBe(false);
  });
});

describe("normalizeLanguage", () => {
  it("answers before any grammar has loaded", async () => {
    const h = await load();
    expect(h.mod.grammarsLoaded()).toBe(false);
    expect(h.mod.normalizeLanguage("ts")).toBe("typescript");
    expect(h.mod.normalizeLanguage("nope")).toBeNull();
    expect(h.mod.normalizeLanguage("JS {1,3}")).toBe("javascript");
    expect(h.mod.normalizeLanguage("jsonc")).toBe("jsonc");
    expect(h.mod.normalizeLanguage("ps1")).toBeNull();
    expect(h.mod.normalizeLanguage(null)).toBeNull();
    expect(h.mod.normalizeLanguage("")).toBeNull();
    await h.tick();
    expect(h.factoryCalls()).toBe(0);
    expect(h.mod.grammarsLoaded()).toBe(false);
  });

  it("matches the previous eager createLowlight(common).registered() implementation for every alias and grammar name", async () => {
    const { mod } = await load();
    const eager = createLowlight(common);
    const previous = (lang: string | null | undefined): string | null => {
      if (!lang) return null;
      const key = lang.trim().toLowerCase().split(/[\s{]/)[0];
      const name = mod.ALIASES[key] ?? key;
      return eager.registered(name) ? name : null;
    };
    const inputs = [
      ...Object.keys(mod.ALIASES),
      ...mod.COMMON_LANGUAGES,
      ...mod.COMMON_LANGUAGE_ALIASES,
      ...Object.keys(mod.ALIASES).map((k) => k.toUpperCase()),
      " ts ",
      "js {1,2}",
      "html title=x",
      "vue",
      "svelte",
      "dockerfile",
      "powershell",
      "nope",
      "",
      "   ",
    ];
    const table = inputs.map((input) => [input, mod.normalizeLanguage(input)]);
    expect(table).toEqual(inputs.map((input) => [input, previous(input)]));
    expect(table.filter(([, out]) => out !== null).length).toBeGreaterThan(100);
    expect(Object.keys(mod.ALIASES).map((k) => mod.normalizeLanguage(k))).toEqual([
      "javascript", "javascript", "typescript", "typescript", "bash", "bash", "bash", "yaml", "markdown", "python", "ruby", "csharp",
      "csharp", "cpp", null, null, "xml", "xml", "xml", "go", "rust", "kotlin", null,
    ]);
  });
});

describe("codeHighlightPlugin", () => {
  it("a ```js block starts undecorated, imports the grammars once and colours in after the load transaction", async () => {
    const h = await load();
    const made = makeView(h.mod, h.parse(JS_DOC));
    expect(made.decorations()).toHaveLength(0);
    expect(made.coloured()).toBe(0);
    await h.tick();
    expect(h.factoryCalls()).toBe(1);
    expect(h.registerCalls()).toBe(0);
    expect(h.mod.grammarsLoaded()).toBe(false);
    expect(made.coloured()).toBe(0);

    h.release();
    await h.mod.ensureGrammars();

    expect(h.mod.grammarsLoaded()).toBe(true);
    expect(h.registerCalls()).toBe(1);
    expect(made.dispatched).toHaveLength(1);
    expect(made.dispatched[0].docChanged).toBe(false);
    const decorations = made.decorations();
    expect(decorations.length).toBeGreaterThan(0);
    expect(decorations.every((d) => d.inline)).toBe(true);
    expect(made.coloured()).toBeGreaterThan(0);
    expect(made.view.dom.querySelector("span.hljs-keyword")?.textContent).toBe("const");
  });

  it("a code block with an unknown language never triggers the import", async () => {
    const h = await load();
    const made = makeView(h.mod, h.parse("```brainfuck\n+++.\n```\n"));
    made.view.dispatch(made.view.state.tr.insertText("-", 1));
    await h.tick();
    expect(h.factoryCalls()).toBe(0);
    expect(made.decorations()).toHaveLength(0);
    expect(made.view.dom.querySelector("pre")).not.toBeNull();
  });

  it("a document without code blocks never triggers the import", async () => {
    const h = await load();
    const made = makeView(h.mod, h.parse("# Prose only\n\nA paragraph with `inline code` and a [link](https://example.com).\n"));
    made.view.dispatch(made.view.state.tr.insertText("more", made.view.state.doc.content.size - 1));
    await h.tick();
    expect(h.factoryCalls()).toBe(0);
    expect(made.decorations()).toHaveLength(0);
  });

  it("two code blocks share one import", async () => {
    const h = await load();
    const made = makeView(h.mod, h.parse("```js\nlet a = 1;\n```\n\ntext\n\n```python\ndef f():\n    return 1\n```\n"));
    await h.tick();
    expect(h.factoryCalls()).toBe(1);
    h.release();
    await h.mod.ensureGrammars();
    expect(h.factoryCalls()).toBe(1);
    expect(h.registerCalls()).toBe(1);
    expect(made.dispatched).toHaveLength(1);
    const pres = made.view.dom.querySelectorAll("pre");
    expect(pres).toHaveLength(2);
    for (const pre of pres) expect(pre.querySelectorAll('span[class*="hljs-"]').length).toBeGreaterThan(0);
  });

  it("typing a fenced block into a plain document triggers the import and decorates it once loaded", async () => {
    const h = await load();
    const made = makeView(h.mod, h.parse("Plain paragraph.\n"));
    await h.tick();
    expect(h.factoryCalls()).toBe(0);
    const { schema } = made.view.state;
    const codeBlock = schema.nodes.code_block.create({ language: "ts" }, schema.text("let x: number = 1;"));
    made.view.dispatch(made.view.state.tr.insert(made.view.state.doc.content.size, codeBlock));
    await h.tick();
    expect(h.factoryCalls()).toBe(1);
    expect(made.coloured()).toBe(0);
    h.release();
    await h.mod.ensureGrammars();
    expect(made.coloured()).toBeGreaterThan(0);
    expect(made.dispatched.filter((tr) => !tr.docChanged)).toHaveLength(1);
  });

  it("the plugin view does not dispatch after destroy()", async () => {
    const h = await load();
    const made = makeView(h.mod, h.parse(JS_DOC));
    await h.tick();
    expect(h.factoryCalls()).toBe(1);
    made.view.destroy();
    h.release();
    await h.mod.ensureGrammars();
    expect(h.mod.grammarsLoaded()).toBe(true);
    expect(made.dispatched).toHaveLength(0);
  });

  it("every view alive while the load is in flight is redecorated; views created afterwards highlight at init", async () => {
    const h = await load();
    const first = makeView(h.mod, h.parse(JS_DOC));
    const second = makeView(h.mod, h.parse("```ts\nconst n: number = 1;\n```\n"));
    await h.tick();
    expect(h.factoryCalls()).toBe(1);
    h.release();
    await h.mod.ensureGrammars();
    expect(first.coloured()).toBeGreaterThan(0);
    expect(second.coloured()).toBeGreaterThan(0);
    expect(first.dispatched).toHaveLength(1);
    expect(second.dispatched).toHaveLength(1);
    const third = makeView(h.mod, h.parse(JS_DOC));
    expect(third.coloured()).toBeGreaterThan(0);
    await h.tick();
    expect(third.dispatched).toHaveLength(0);
    expect(h.registerCalls()).toBe(1);
  });

  it("an edit inside a code block after the load re-highlights only that block", async () => {
    const h = await load();
    const made = makeView(h.mod, h.parse(JS_DOC));
    h.release();
    await h.mod.ensureGrammars();
    const before = made.coloured();
    const pre = made.view.dom.querySelector("pre")!;
    const codeStart = made.view.posAtDOM(pre, 0);
    made.view.dispatch(made.view.state.tr.insertText("let extra = true;\n", codeStart));
    expect(made.coloured()).toBeGreaterThan(before);
    expect(made.view.dom.querySelectorAll("span.hljs-keyword").length).toBeGreaterThanOrEqual(3);
  });
});

describe("highlightTokens and ensureGrammars", () => {
  it("highlightTokens returns [] before the load and tokens after it", async () => {
    const h = await load();
    expect(h.mod.highlightTokens("const a = 1;", "javascript")).toEqual([]);
    h.release();
    await h.mod.ensureGrammars();
    const tokens = h.mod.highlightTokens("const a = 1;", "javascript");
    expect(tokens[0]).toEqual({ from: 0, to: 5, classes: "hljs-keyword" });
    expect(h.mod.highlightTokens("{ \"a\": 1 }", "jsonc").length).toBeGreaterThan(0);
  });

  it("a failed chunk load leaves the block plain, never rejects, and retries only after the delay", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const h = await load({ fail: true });
    const made = makeView(h.mod, h.parse(JS_DOC));
    h.release();
    await expect(h.mod.ensureGrammars()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(h.factoryCalls()).toBe(1);
    expect(h.mod.grammarsLoaded()).toBe(false);
    expect(made.coloured()).toBe(0);
    expect(made.dispatched).toHaveLength(0);

    // Further passes before the delay reuse the failed attempt instead of re-requesting the chunk.
    const firstAttempt = h.mod.ensureGrammars();
    made.view.dispatch(made.view.state.tr.insertText("x", 12));
    expect(h.mod.ensureGrammars()).toBe(firstAttempt);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(h.mod.ensureGrammars()).toBe(firstAttempt);

    await vi.advanceTimersByTimeAsync(1);
    const retry = h.mod.ensureGrammars();
    expect(retry).not.toBe(firstAttempt);
    await retry;
    expect(warn).toHaveBeenCalledTimes(2);
    expect(h.mod.grammarsLoaded()).toBe(false);
  });
});
