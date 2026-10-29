import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IMPORT_REQUEST_TOO_LARGE, MAX_IMPORT_REQUEST_BYTES, uploadImportBatch, uploadImportFiles } from "./import-upload";

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const ok = (body: unknown, status = 201) => new Response(JSON.stringify(body), { status });
const doc = (id: string, warnings: string[] = []) => ({ documents: [{ id, title: id, warnings }], failed: [] });
const MiB = 1024 * 1024;
const blob = (size: number, name: string, type: string) => new File([new Uint8Array(size).fill(0x61)], name, { type });

function sent(call: number): FormData {
  const body = fetchMock.mock.calls[call][1]?.body;
  if (!(body instanceof FormData)) throw new Error("Expected FormData");
  return body;
}
const names = (form: FormData, field: string) => form.getAll(field).map((f) => (f as File).name);

describe("uploadImportBatch", () => {
  it("sends one request per document with only the images it references", async () => {
    fetchMock.mockResolvedValueOnce(ok(doc("one"))).mockResolvedValueOnce(ok(doc("two")));
    const documents = [
      new File(["# One\n![a](img/a.png)"], "one.md", { type: "text/markdown" }),
      new File(['<img src="B.JPG">'], "two.html", { type: "text/html" }),
    ];
    const images = [new File(["a"], "a.png", { type: "image/png" }), new File(["b"], "b.jpg", { type: "image/jpeg" })];
    const result = await uploadImportBatch(documents, images);
    expect(result).toEqual({ documents: [doc("one").documents[0], doc("two").documents[0]], failed: [] });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/import/file");
    expect(init?.method).toBe("POST");
    expect(init?.credentials).toBe("same-origin");
    expect(names(sent(0), "files")).toEqual(["one.md"]);
    expect(names(sent(0), "images")).toEqual(["a.png"]);
    expect(names(sent(1), "files")).toEqual(["two.html"]);
    expect(names(sent(1), "images")).toEqual(["b.jpg"]);
  });

  it("imports 20 files of 2 MiB each, each request under 10 MiB, reporting progress per file", async () => {
    fetchMock.mockImplementation(async () => ok(doc("d")));
    const documents = Array.from({ length: 20 }, (_, i) => blob(2 * MiB, `f${i}.md`, "text/markdown"));
    const progress: number[] = [];
    const result = await uploadImportBatch(documents, [], (index) => progress.push(index));
    expect(result.documents).toHaveLength(20);
    expect(result.failed).toEqual([]);
    expect(progress).toEqual(Array.from({ length: 20 }, (_, i) => i));
    for (let i = 0; i < 20; i++) {
      const size = [...sent(i).values()].reduce((n, f) => n + (f as File).size, 0);
      expect(size).toBeLessThan(MAX_IMPORT_REQUEST_BYTES);
    }
  });

  it("one bad file does not fail the others, and each failure keeps its own reason", async () => {
    fetchMock
      .mockResolvedValueOnce(ok(doc("first")))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "Unexpected error" }), { status: 500 }))
      .mockResolvedValueOnce(new Response("<html>413</html>", { status: 413 }))
      .mockResolvedValueOnce(ok(doc("last")));
    const documents = [
      new File(["# First"], "first.md"),
      new File(["# Broken"], "broken.md"),
      new File(["# Huge"], "huge.md"),
      new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])], "fake.md"),
      blob(2 * MiB + 1, "big.md", "text/markdown"),
      new File(["# Last"], "last.md"),
    ];
    const result = await uploadImportBatch(documents);
    expect(result.documents.map((d) => d.id)).toEqual(["first", "last"]);
    expect(result.failed).toEqual([
      { index: 1, name: "broken.md", error: "Unexpected error" },
      { index: 2, name: "huge.md", error: IMPORT_REQUEST_TOO_LARGE },
      { index: 3, name: "fake.md", error: "“fake.md” doesn't look like a text or Markdown file" },
      { index: 4, name: "big.md", error: "“big.md” is larger than 2 MB" },
    ]);
    // The binary and the oversized file never leave the browser.
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("refuses an image over 5 MB by name and keeps the request under 10 MB", async () => {
    fetchMock.mockResolvedValueOnce(ok(doc("pics", ["server note"])));
    const md = new File(["![](big.png) ![](a.png) ![](b.png) ![](c.png)"], "pics.md");
    const images = [
      blob(5 * MiB + 1, "big.png", "image/png"),
      blob(4 * MiB, "a.png", "image/png"),
      blob(4 * MiB, "b.png", "image/png"),
      blob(4 * MiB, "c.png", "image/png"),
    ];
    const [document] = (await uploadImportBatch([md], images)).documents;
    expect(names(sent(0), "images")).toEqual(["a.png", "b.png"]);
    expect(document.warnings).toEqual([
      "“big.png”: Images must be 5 MB or smaller",
      "“c.png” was not attached: this document's images together are larger than 9.5 MB",
      "server note",
    ]);
  });

  it("rejects with the error when the only file fails", async () => {
    await expect(uploadImportBatch([new File([new Uint8Array([0, 1, 2])], "bin.md")])).rejects.toThrow(/doesn't look like a text/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("uploadImportFiles", () => {
  it("returns only the successful documents", async () => {
    fetchMock.mockResolvedValueOnce(ok(doc("notes"))).mockResolvedValueOnce(new Response(JSON.stringify({ error: "Not imported" }), { status: 400 }));
    const docs = await uploadImportFiles([new File(["# Notes"], "notes.md"), new File(["# Other"], "other.md")]);
    expect(docs.map((d) => d.id)).toEqual(["notes"]);
  });

  it("propagates transport rejection of a single file without retrying", async () => {
    const failure = new Error("Upload interrupted");
    fetchMock.mockRejectedValue(failure);
    await expect(uploadImportFiles([new File(["# A"], "a.md")])).rejects.toBe(failure);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
