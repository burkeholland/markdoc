import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // A separate build directory lets a second dev server (e.g. the Playwright suite) run next to `npm run dev`.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  serverExternalPackages: ["@electric-sql/pglite", "pg", "drizzle-orm", "@hocuspocus/server", "ws", "yjs"],
  images: {
    remotePatterns: [{ protocol: "https", hostname: "avatars.githubusercontent.com" }],
  },
};

export default nextConfig;
