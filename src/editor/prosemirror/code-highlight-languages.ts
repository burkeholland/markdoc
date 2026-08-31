// Loaded only through `import("./code-highlight-languages")` from code-highlight.ts, so the bundler
// emits highlight.js' core and its 37 `common` grammars (≈ 171 kB) as their own chunk, fetched the
// first time a document shows a code block with a recognised language. Nothing else may import this
// module.
import { common, createLowlight } from "lowlight";

/** The editor's one highlight.js instance; built here so the core never reaches the entry chunks. */
export const lowlight = createLowlight(common);
export type Lowlight = typeof lowlight;
