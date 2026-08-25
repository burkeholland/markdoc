import { build } from "esbuild";

// Bundle the custom server (Next.js host + collaboration WebSocket) into plain JavaScript so
// production runs `node dist/server.mjs` without tsx. node_modules stay external.
const shared = {
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  packages: "external",
  sourcemap: true,
  logLevel: "info",
  banner: {
    // Give bundled CommonJS-style helpers a `require` when they ask for one.
    js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);',
  },
};

await build({ ...shared, entryPoints: ["server/index.ts"], outfile: "dist/server.mjs" });

// The Markdown render worker (src/server/export/render-pool.ts starts it from dist/ in production).
await build({ ...shared, entryPoints: ["src/server/export/render-markdown.ts"], outfile: "dist/render-worker.mjs" });
