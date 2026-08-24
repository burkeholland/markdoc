import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      // Loading data in effects (`useEffect(() => { void load() }, [...])`) sets state after an
      // await; the rule cannot see the async boundary and reports every such fetch.
      "react-hooks/set-state-in-effect": "off",
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

export default eslintConfig;


