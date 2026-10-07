import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const bannedEverywhere = [
  {
    group: ["prosemirror-markdown", "prosemirror-markdown/*"],
    message: "vendored in src/editor/markdown/to-markdown.ts — the package drags markdown-it into the client",
  },
];

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      // Loading data in effects (`useEffect(() => { void load() }, [...])`) sets state after an
      // await; the rule cannot see the async boundary and reports every such fetch.
      "react-hooks/set-state-in-effect": "off",
      // The serializer core is vendored (src/editor/markdown/to-markdown.ts): the package's only entry point
      // builds a markdown-it parser at module top level, which put ~100 kB of never-run code in the shared
      // client chunk (task #1092). Importing it again would bring that back.
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            ...bannedEverywhere,
          ],
        },
      ],
    },
  },
  {
    // CodeMirror loads on demand with the code pane (task #1121): only src/editor/codemirror/** and code-pane.tsx
    // import its values, everything else on the editor's first-load path imports types — one stray value import
    // puts ~640 kB back into the /d/[id] entry JS and the build still succeeds. Values arrive via onReady(view, api).
    files: ["src/**/*.{ts,tsx,mts,js,jsx,mjs}"],
    ignores: ["src/editor/codemirror/**", "src/components/editor/code-pane.tsx", "src/**/*.test.{ts,tsx,mts,js,mjs}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            ...bannedEverywhere, // this entry replaces the global options for the files it matches; keep the ban
            {
              group: ["@codemirror/*", "@lezer/*", "y-codemirror.next", "@/editor/codemirror/*", "**/editor/codemirror/*", "**/editor/codemirror/**", "../codemirror/*", "./codemirror/*"],
              allowTypeImports: true,
              message: "CodeMirror loads on demand with the code pane (task #1121): import only types here and take values from the CodeApi the pane hands up through onReady(view, api)",
            },
          ],
        },
      ],
    },
  },
  {
    // `navigator.clipboard` is undefined on plain-HTTP origins (the LAN address, #993): every copy goes
    // through copyText, which falls back to execCommand. Only the lib itself (and its test) may touch it;
    // e2e specs read the clipboard to assert on it and are not app code.
    files: ["src/**/*.{ts,tsx,mts,js,jsx,mjs}", "server/**/*.{ts,mts,js,mjs}", "mcp/**/*.{ts,mts,js,mjs}"],
    ignores: ["src/lib/clipboard.ts", "src/lib/clipboard.test.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: 'MemberExpression[object.name="navigator"][property.name="clipboard"]',
          message: "use copyText from @/lib/clipboard",
        },
        {
          selector: 'MemberExpression[object.property.name="navigator"][property.name="clipboard"]',
          message: "use copyText from @/lib/clipboard",
        },
        {
          selector: 'MemberExpression[computed=true][property.value="clipboard"]',
          message: "use copyText from @/lib/clipboard",
        },
      ],
    },
  },
  globalIgnores([".next/**", ".next-*/**", "out/**", "build/**", "dist/**", "next-env.d.ts", "drizzle/**", "playwright-report/**", "test-results/**"]),
]);

// package.json "overrides" installs tinyglobby under the name fast-glob inside @next/eslint-plugin-next, so that
// fast-glob's dependency braces is not installed (#2294; the same swap as https://github.com/vercel/next.js/pull/89531).
// The plugin calls it in one place only, to expand settings.next.rootDir, and there tinyglobby returns other
// directories than fast-glob does. Nothing here sets rootDir, so that call never happens, and this check keeps it
// that way. scripts/lib/next-lint-fast-glob-override.test.ts watches the plugin itself. Delete the override, this
// check and that test once @next/eslint-plugin-next no longer depends on fast-glob.
export function assertNoNextRootDir(config) {
  if (config.some((entry) => entry?.settings?.next?.rootDir !== undefined)) {
    throw new Error("settings.next.rootDir cannot be set while package.json overrides fast-glob with tinyglobby (#2294).");
  }
}

assertNoNextRootDir(eslintConfig);

export default eslintConfig;


