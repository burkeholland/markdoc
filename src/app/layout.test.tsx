import { describe, expect, it, vi } from "vitest";

// `metadata` is built when the module is evaluated, so the environment has to be in place before the import.
process.env.AUTH_URL = "https://example.test";
delete process.env.MARKDOC_URL;

// next/font/google is filled in by Next's compiler; outside it the exports are empty.
vi.mock("next/font/google", () => {
  const font = () => ({ className: "", variable: "", style: {} });
  return { Inter: font, JetBrains_Mono: font, Fraunces: font };
});

const { metadata } = await import("./layout");
const { metadata: notFoundMetadata } = await import("./not-found");

/** `metadata.metadataBase` as the URL it must be (the type also admits a string). */
function metadataBase(): URL {
  const base = metadata.metadataBase;
  if (!(base instanceof URL)) throw new Error(`metadataBase is ${String(base)}, not a URL`);
  return base;
}

describe("root metadata", () => {
  it("sets metadataBase from the public origin", () => {
    expect(metadataBase().origin).toBe("https://example.test");
  });

  it("resolves the Open Graph image to an absolute URL on that origin", () => {
    const images = metadata.openGraph?.images;
    const first = Array.isArray(images) ? images[0] : images;
    expect(first).toBeDefined();
    const image = typeof first === "string" || first instanceof URL ? first : first!.url;
    expect(new URL(image, metadataBase()).href).toBe("https://example.test/brand/og.png");
  });
});

// The not-found route is prerendered at build time, when the public origin is unknown, so any
// relative image it inherited would resolve against http://localhost:3000 (#928). Its own metadata
// replaces the inherited images with empty lists, which Next then emits as no image tags at all.
describe("not-found metadata", () => {
  it("lists no Open Graph or Twitter images", () => {
    expect(notFoundMetadata.openGraph?.images).toEqual([]);
    expect(notFoundMetadata.twitter?.images).toEqual([]);
  });

  it("carries no absolute URL and leaves metadataBase to the root layout", () => {
    expect(notFoundMetadata.metadataBase).toBeUndefined();
    expect(JSON.stringify(notFoundMetadata)).not.toMatch(/https?:\/\/|localhost/);
  });
});
