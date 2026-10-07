import { describe, expect, it } from "vitest";
import { hasLocalMatch } from "next/dist/shared/lib/match-local-pattern";
import { hasRemoteMatch } from "next/dist/shared/lib/match-remote-pattern";
import nextConfig from "../next.config";

/**
 * Next's image optimisation endpoint is off (#2287). Two settings in next.config.ts keep it closed; this file
 * holds each of them in place on its own. What the running server answers is e2e/image-endpoint-closed.spec.ts.
 */
describe("next.config.ts images", () => {
  const images = nextConfig.images ?? {};
  // What a caller could ask the endpoint for: public files, an uploaded image, the avatar host, any other host.
  const LOCAL = ["/brand/og.png", "/icon.svg", "/favicon.ico", "/api/assets/abc123", "/d/abc/opengraph-image", "/_next/static/chunks/a.js", "/"];
  const REMOTE = ["https://avatars.githubusercontent.com/u/1?s=80", "https://avatars.githubusercontent.com/octocat", "https://example.com/a.png", "http://localhost:3000/api/assets/abc123", "http://127.0.0.1/a.png"];

  it("switches the optimiser off: Next answers 404 for the endpoint before it reads a parameter", () => {
    expect(images.unoptimized).toBe(true);
    // A custom loader would move image work somewhere else; there is none.
    expect(images.loader).toBeUndefined();
    expect(images.loaderFile).toBeUndefined();
  });

  it("allows no local path and no remote host, so the endpoint stays closed without the switch", () => {
    expect(images.localPatterns).toEqual([]);
    expect(images.remotePatterns).toEqual([]);
    expect(images.domains).toBeUndefined();
    expect(images.dangerouslyAllowSVG).toBeUndefined();
    expect(images.dangerouslyAllowLocalIP).toBeUndefined();

    // Next adds its own static-import folders to a local list that is defined; the app has no such imports.
    const local = [...(images.localPatterns ?? []), { pathname: "/_next/static/media/**", search: "" }, { pathname: "/_next/static/immutable/media/**", search: "" }];
    for (const url of LOCAL) expect(hasLocalMatch(local, url), url).toBe(false);
    for (const url of REMOTE) expect(hasRemoteMatch(images.domains ?? [], images.remotePatterns ?? [], new URL(url)), url).toBe(false);
    // The same matchers do say yes when a pattern is there: the two loops above are not vacuous.
    expect(hasLocalMatch(undefined, "/api/assets/abc123")).toBe(true);
    expect(hasRemoteMatch([], [{ protocol: "https", hostname: "avatars.githubusercontent.com" }], new URL(REMOTE[0]))).toBe(true);
  });
});
