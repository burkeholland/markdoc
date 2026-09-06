import { build } from "esbuild";
import { createRequire } from "node:module";

const resolve = createRequire(import.meta.url).resolve;
const authInterop = {
  name: "next-auth-node-esm",
  setup(builder) {
    // Auth.js uses extensionless Next subpaths that native Node ESM cannot resolve.
    // Bundle only that adapter and leave Next itself external with explicit .js entrypoints.
    builder.onResolve({ filter: /^next-auth(?:\/|$)/ }, ({ path }) => ({ path: resolve(path) }));
    builder.onResolve({ filter: /^next\/(?:server|headers|navigation)$/ }, ({ path }) => ({
      path: `${path}.js`,
      external: true,
    }));
  },
};

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

await build({
  ...shared,
  plugins: [authInterop],
  // Initialize Next's Node globals before the bundled adapter imports next/headers.
  banner: { js: `import "next/dist/server/node-environment.js"; ${shared.banner.js}` },
  entryPoints: ["server/index.ts"],
  outfile: "dist/server.mjs",
});

// The Markdown render worker (src/server/export/render-pool.ts starts it from dist/ in production).
await build({ ...shared, entryPoints: ["src/server/export/render-markdown.ts"], outfile: "dist/render-worker.mjs" });
