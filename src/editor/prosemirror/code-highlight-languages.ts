// Loaded only through `import("./code-highlight-languages")` from code-highlight.ts, so the bundler
// emits highlight.js' 37 `common` grammars (~149 kB) as their own chunk, fetched the first time a
// document shows a code block with a recognised language. Nothing else may import this module.
import { common } from "lowlight";

export { common };
