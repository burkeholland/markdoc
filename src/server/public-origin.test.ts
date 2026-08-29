import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { publicOrigin } from "./public-origin";

let warn: MockInstance<typeof console.warn>;

beforeEach(() => {
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  warn.mockRestore();
});

describe("publicOrigin", () => {
  it("prefers MARKDOC_URL over AUTH_URL", () => {
    expect(publicOrigin({ MARKDOC_URL: "https://docs.example", AUTH_URL: "https://auth.example", PORT: "4000" })).toBe("https://docs.example");
  });

  it("falls back to AUTH_URL when MARKDOC_URL is unset or blank", () => {
    expect(publicOrigin({ AUTH_URL: "https://auth.example" })).toBe("https://auth.example");
    expect(publicOrigin({ MARKDOC_URL: "   ", AUTH_URL: "https://auth.example" })).toBe("https://auth.example");
  });

  it("strips a trailing slash and keeps a non-default port", () => {
    expect(publicOrigin({ AUTH_URL: "https://auth.example/" })).toBe("https://auth.example");
    expect(publicOrigin({ MARKDOC_URL: " http://docs.example:8080/ " })).toBe("http://docs.example:8080");
  });

  it.each([
    ["a non-http(s) scheme", "ftp://docs.example"],
    ["a bare hostname", "docs.example"],
    ["a path", "https://docs.example/api/auth"],
    ["credentials", "https://user:pw@docs.example"],
    ["a query string", "https://docs.example?x=1"],
  ])("skips MARKDOC_URL with %s and moves on to AUTH_URL", (_label, value) => {
    expect(publicOrigin({ MARKDOC_URL: value, AUTH_URL: "https://auth.example" })).toBe("https://auth.example");
    expect(warn).toHaveBeenCalledTimes(1);
    const [message] = warn.mock.calls[0];
    expect(message).toContain("MARKDOC_URL");
    expect(message).not.toContain("docs.example");
  });

  it("falls through to the development default when every candidate is invalid, without throwing", () => {
    expect(publicOrigin({ MARKDOC_URL: "not a url", AUTH_URL: "file:///srv/markdoc", PORT: "3100" })).toBe("http://localhost:3100");
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("uses http://localhost:3000 in development when nothing is configured", () => {
    expect(publicOrigin({})).toBe("http://localhost:3000");
    expect(warn).not.toHaveBeenCalled();
  });

  it("uses PORT for the development default", () => {
    expect(publicOrigin({ PORT: "3001" })).toBe("http://localhost:3001");
  });

  it.each(["", "  ", "abc", "0", "65536", "-1", "80.5"])("ignores unusable PORT %j and uses 3000", (port) => {
    expect(publicOrigin({ PORT: port })).toBe("http://localhost:3000");
  });

  it("reads process.env by default", () => {
    vi.stubEnv("MARKDOC_URL", "https://env.example/");
    try {
      expect(publicOrigin()).toBe("https://env.example");
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
