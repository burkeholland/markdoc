import { describe, expect, it } from "vitest";
import { loginReturnPath } from "./return-path";

describe("loginReturnPath", () => {
  it.each([
    ["/", "/"],
    ["/settings", "/settings"],
    ["/d/document-1", "/d/document-1"],
    ["/p/reader-1?mode=focus#comments", "/p/reader-1?mode=focus#comments"],
    ["/d/document%20one?from=%2Fsettings#heading", "/d/document%20one?from=%2Fsettings#heading"],
    [new URLSearchParams("next=%2Fp%2Fencoded-reader%3Fmode%3Dfocus%23comments").get("next"), "/p/encoded-reader?mode=focus#comments"],
  ])("preserves the internal return path %j", (value, expected) => {
    expect(loginReturnPath(value ?? undefined)).toBe(expected);
  });

  it.each([
    undefined,
    ["/settings"],
    "",
    "settings",
    "//example.invalid/path",
    "///example.invalid/path",
    "https://example.invalid/path",
    "http://example.invalid/path",
    "\\\\example.invalid\\path",
    "/\\example.invalid/path",
    "/safe\\example.invalid",
    "/%2fexample.invalid/path",
    "/%2F%2Fexample.invalid/path",
    "/%5cexample.invalid/path",
    "/safe%5Cexample.invalid",
    "/malformed%",
    "/malformed%E0%A4%A",
    "/\n//example.invalid",
  ])("falls back for an unsafe or malformed value %j", (value) => {
    expect(loginReturnPath(value)).toBe("/");
  });
});
