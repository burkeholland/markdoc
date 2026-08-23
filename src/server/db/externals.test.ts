import { describe, expect, it } from "vitest";
import nextConfig from "../../../next.config";

/**
 * Guards the fix for the Turbopack noise "Failed to generate static paths for /p/[id]" /
 * "Failed to load external module drizzle-orm/...".
 *
 * @auth/drizzle-adapter imports drizzle-orm/mysql-core and drizzle-orm/sqlite-core to detect the
 * dialect. While drizzle-orm was in serverExternalPackages, Turbopack emitted those subpaths as
 * runtime `import()` externals in every route chunk that reaches src/auth.ts (all of them, through
 * requireAccess/currentUser), and the dev server's background static-paths worker intermittently
 * failed to load them. Bundling drizzle-orm makes them ordinary modules in the chunk graph; it is
 * safe because drizzle-orm identifies its entities with Symbol.for + entityKind, so the custom
 * server's copy and the bundled copy share one database instance.
 */
describe("serverExternalPackages", () => {
  const externals = nextConfig.serverExternalPackages ?? [];

  it("does not externalise drizzle-orm (see comment above)", () => {
    expect(externals).not.toContain("drizzle-orm");
  });

  it("keeps the native/WASM and single-instance packages external", () => {
    for (const pkg of ["@electric-sql/pglite", "pg", "@hocuspocus/server", "ws", "yjs"]) {
      expect(externals).toContain(pkg);
    }
  });
});
