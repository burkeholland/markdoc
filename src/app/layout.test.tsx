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

describe("root metadata", () => {
  it("sets metadataBase from the public origin", () => {
    expect(metadata.metadataBase).toBeInstanceOf(URL);
    expect(metadata.metadataBase?.origin).toBe("https://example.test");
  });

  it("resolves the Open Graph image to an absolute URL on that origin", () => {
    const images = metadata.openGraph?.images;
    const first = Array.isArray(images) ? images[0] : images;
    expect(first).toBeDefined();
    const image = typeof first === "string" || first instanceof URL ? first : first!.url;
    expect(new URL(image, metadata.metadataBase!).href).toBe("https://example.test/brand/og.png");
  });
});
