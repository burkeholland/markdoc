import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getAsset: vi.fn(),
  requireAccess: vi.fn(),
}));

vi.mock("@/server/assets", () => ({ getAsset: mocks.getAsset }));
vi.mock("@/server/http", () => ({
  handler: (fn: (...args: unknown[]) => Promise<Response>) => fn,
  requireAccess: mocks.requireAccess,
  HttpError: class HttpError extends Error {
    constructor(public status: number, message: string) {
      super(message);
    }
  },
}));

const { GET } = await import("./route");

describe("GET /api/assets/[id]", () => {
  beforeEach(() => vi.clearAllMocks());

  it("keeps uploaded SVGs sandboxed", async () => {
    const bytes = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>');
    mocks.getAsset.mockResolvedValue({
      id: "asset-1",
      documentId: "doc-1",
      name: "drawing.svg",
      mime: "image/svg+xml",
      size: bytes.byteLength,
      bytes,
    });

    const response = await GET(new Request("http://localhost:3610/api/assets/asset-1"), {
      params: Promise.resolve({ id: "asset-1" }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-security-policy")).toBe("sandbox; script-src 'none'");
    expect(mocks.requireAccess).toHaveBeenCalledWith("doc-1", "view");
  });
});
