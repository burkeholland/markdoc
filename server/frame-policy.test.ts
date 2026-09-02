import { describe, expect, it } from "vitest";
import type { EmbedSessionClaims } from "@/server/session-cookie";
import { FRAME_ANCESTORS_NONE, frameAncestorsPolicy, framePolicyApplies } from "./frame-policy";

const NOW = Date.parse("2030-01-01T00:00:00.000Z");
const PARENT = "http://127.0.0.1:4749";
const EMBED: EmbedSessionClaims = {
  userId: "user-1",
  login: "reader",
  name: "Reader",
  image: null,
  tokenId: "token-1",
  documentId: "doc-1",
  parentOrigin: PARENT,
  expiresAt: NOW + 60_000,
};

function policy(path: string, embed: EmbedSessionClaims | null = EMBED, now = NOW): string | null {
  return frameAncestorsPolicy(new URL(path, "http://localhost:3297"), embed, now);
}

describe("frameAncestorsPolicy", () => {
  it("allows only the exact embed document with embed=1 to use its parent origin", () => {
    expect(policy("/d/doc-1?embed=1")).toBe(`frame-ancestors ${PARENT}`);
    expect(policy("/d/doc-1?mode=focus&embed=1")).toBe(`frame-ancestors ${PARENT}`);
  });

  it("keeps a wrong document and the same document without embed=1 unframeable", () => {
    for (const path of ["/d/doc-2?embed=1", "/d/doc-1", "/d/doc-1?embed=0", "/", "/login?next=%2Fd%2Fdoc-1"]) {
      expect(policy(path), path).toBe(FRAME_ANCESTORS_NONE);
    }
  });

  it("treats a missing or expired embed session as unframeable", () => {
    expect(policy("/d/doc-1?embed=1", null)).toBe(FRAME_ANCESTORS_NONE);
    expect(policy("/d/doc-1?embed=1", { ...EMBED, expiresAt: NOW }, NOW)).toBe(FRAME_ANCESTORS_NONE);
  });

  it.each(["/", "/login", "/p/doc-1", "/d/doc-1", "/settings", "/d/doc-1?mode=focus"])(
    "applies frame-ancestors none to the plain page %s",
    (path) => expect(policy(path, null)).toBe(FRAME_ANCESTORS_NONE),
  );

  it.each(["/api", "/api/health", "/api/assets/asset-1", "/embed/some-nonce", "/_next/static/chunks/app.js", "/_next/image", "/favicon.ico"])(
    "does not set a frame policy on %s",
    (path) => {
      expect(framePolicyApplies(new URL(path, "http://localhost").pathname)).toBe(false);
      expect(policy(path)).toBeNull();
    },
  );

  it("distinguishes page-like prefixes from excluded route prefixes", () => {
    for (const path of ["/apis", "/embedded"]) {
      expect(framePolicyApplies(path), path).toBe(true);
    }
  });
});
