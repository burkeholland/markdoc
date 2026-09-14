import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { uploadImportBatch, uploadImportFiles } from "./import-upload";

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function respond(body: unknown) {
  const res = new Response(JSON.stringify(body), { status: 200 });
  const read = vi.spyOn(res, "text");
  fetchMock.mockResolvedValue(res);
  return read;
}

describe("uploadImportBatch", () => {
  it("preserves partial successes and failures and uploads documents/images in order", async () => {
    const documents = [
      new File(["# First"], "first.md", { type: "text/markdown" }),
      new File(["# Second"], "second.md", { type: "text/markdown" }),
      new File(["# Third"], "third.md", { type: "text/markdown" }),
    ];
    const images = [
      new File(["first image"], "first.png", { type: "image/png" }),
      new File(["second image"], "second.jpg", { type: "image/jpeg" }),
    ];
    const body = {
      documents: [
        { id: "first-document", title: "First", warnings: ["Image not found"] },
        { id: "third-document", title: "Third", warnings: [] },
      ],
      failed: [{ index: 1, name: "second.md", error: "Could not import document" }],
    };
    const read = respond(body);
    expect(JSON.stringify(await uploadImportBatch(documents, images)) === JSON.stringify(body)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/import/file");
    expect(init?.method).toBe("POST");
    expect(init?.credentials).toBe("same-origin");
    expect(new Headers(init?.headers).has("Content-Type")).toBe(false);
    const form = init?.body;
    expect(form instanceof FormData).toBe(true);
    if (!(form instanceof FormData)) throw new Error("Expected FormData");
    expect([...form.keys()]).toEqual(["files", "files", "files", "images", "images"]);
    const uploaded = [...form.values()];
    const files = [...documents, ...images];
    for (const [index, file] of files.entries()) {
      const entry = uploaded[index];
      expect(entry instanceof File).toBe(true);
      if (!(entry instanceof File)) throw new Error("Expected uploaded File");
      expect(entry.name).toBe(file.name);
      expect(entry.type).toBe(file.type);
      expect(entry.size).toBe(file.size);
      expect(await entry.text() === await file.text()).toBe(true);
    }
  });

  it.each([
    { name: "missing fields", body: {} },
    { name: "null fields", body: { documents: null, failed: null } },
  ])("retains the existing defaults for $name", async ({ body }) => {
    const read = respond(body);
    expect(JSON.stringify(await uploadImportBatch([])) === JSON.stringify({ documents: [], failed: [] })).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("leaves response-record validation to the caller instead of repairing records", async () => {
    const body = {
      documents: [{ id: "", title: "Unvalidated", warnings: "not an array" }],
      failed: [{ index: 7, name: "different.md", error: "Not imported" }],
    };
    const read = respond(body);
    expect(JSON.stringify(await uploadImportBatch([new File(["# Notes"], "notes.md")])) === JSON.stringify(body)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledTimes(1);
  });
});

describe("uploadImportFiles", () => {
  it("returns only the successful documents using the same single upload", async () => {
    const documents = [{ id: "document-one", title: "Notes", warnings: ["Image not found"] }];
    const read = respond({ documents, failed: [{ index: 1, name: "other.md", error: "Not imported" }] });
    const files = [new File(["# Notes"], "notes.md"), new File(["# Other"], "other.md")];
    expect(JSON.stringify(await uploadImportFiles(files)) === JSON.stringify(documents)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("propagates transport rejection without retrying", async () => {
    const failure = new Error("Upload interrupted");
    fetchMock.mockRejectedValue(failure);
    const error: unknown = await uploadImportFiles([]).then(
      () => { throw new Error("Expected upload rejection"); },
      (error: unknown) => error,
    );
    expect(error === failure).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
