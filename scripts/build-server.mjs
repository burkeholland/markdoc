import { build } from "esbuild";

// Bundle the custom server (Next.js host + collaboration WebSocket) into plain JavaScript so
// production runs `node dist/server.mjs` without tsx. node_modules stay external.
await build({
  entryPoints: ["server/index.ts"],
  outfile: "dist/server.mjs",
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
});
