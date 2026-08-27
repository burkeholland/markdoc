import type { NextConfig } from "next";
import { devOrigins } from "./scripts/lib/dev-origins.mjs";

const nextConfig: NextConfig = {
  // Dev only: Next 403s `/_next/*` (chunks, HMR socket) for any browser origin other than localhost, so
  // a phone on the LAN loaded the HTML but none of the JS. Allow this machine's stable names and its
  // current numeric diagnostics (restart after DHCP only if using a numeric origin). ALLOWED_DEV_ORIGINS
  // adds more.
  allowedDevOrigins: devOrigins(),
  // A separate build directory lets a second dev server (e.g. the Playwright suite) run next to `npm run dev`.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  // Only packages that need native/WASM files or a single process-wide instance are left to Node's
  // loader; everything else is bundled. drizzle-orm is deliberately NOT listed: @auth/drizzle-adapter
  // imports drizzle-orm/mysql-core and drizzle-orm/sqlite-core for dialect detection, and with
  // drizzle-orm external Turbopack turned those into runtime `import()`s in every route chunk that
  // intermittently failed in dev ("Failed to generate static paths" / "Failed to load external
  // module"). Bundled, they are plain modules in the chunk graph. drizzle-orm is multi-copy safe
  // (Symbol.for + entityKind), so the custom server's copy and the bundled one share one db.
  serverExternalPackages: ["@electric-sql/pglite", "pg", "@hocuspocus/server", "ws", "yjs"],
  images: {
    remotePatterns: [{ protocol: "https", hostname: "avatars.githubusercontent.com" }],
  },
  // `next build` type-checks the whole tsconfig project, including playwright.config.ts and e2e/**, and
  // fails inside the container image (whose context has no test code). tsconfig.build.json extends the
  // base and excludes test-only files; `next dev` / `next typegen` / `npm run typecheck` keep tsconfig.json.
  typescript: {
    tsconfigPath: process.env.NODE_ENV === "production" ? "tsconfig.build.json" : "tsconfig.json",
  },
};

export default nextConfig;
