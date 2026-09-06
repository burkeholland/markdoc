import { describe, expect, it } from "vitest";
import { defaultSchema } from "rehype-sanitize";
import { resolveLinkHref, safeLinkHref } from "./links";

describe("editor link destination policy", () => {
  const base = "https://markdoc.test/d/document";

  it("uses every protocol already allowed by the reader sanitizer", () => {
    for (const protocol of defaultSchema.protocols!.href!) {
      const href = `${protocol}://example.test/path`;
      expect(resolveLinkHref(href, base)).toBe(new URL(href, base).href);
      expect(safeLinkHref(href)).toBe(href);
    }
  });

  it.each([null, undefined, 10, "", " ", "javascript:blocked", "JaVaScRiPt:blocked",
    "\tjava\nscript:blocked", "data:text/plain,blocked", "file:///blocked", "https://[invalid"])(
    "removes invalid hrefs from interactive DOM without opening them", (href) => {
      expect(resolveLinkHref(href, base)).toBeNull();
      expect(safeLinkHref(href)).toBeUndefined();
    },
  );

  it.each(["../relative", "/absolute", "#section", "?query=one", "//example.test/path", "path with spaces"])(
    "preserves relative DOM hrefs and resolves against the current document (%s)", (href) => {
      expect(safeLinkHref(href)).toBe(href);
      expect(resolveLinkHref(href, base)).toBe(new URL(href, base).href);
    },
  );
});
