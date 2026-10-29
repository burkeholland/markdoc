import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, ApiError, apiErrorText, UPLOAD_TOO_LARGE_MESSAGE, uploadAsset } from "./api";
import { IMPORT_REQUEST_TOO_LARGE, uploadImportBatch } from "./import-upload";

const FALLBACK = "Could not add collaborator";
const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function respond(body: BodyInit | null, init?: ResponseInit) {
  const res = new Response(body, init);
  const read = vi.spyOn(res, "text");
  fetchMock.mockResolvedValue(res);
  return read;
}

async function captureError(pending: Promise<unknown>): Promise<Error> {
  const error: unknown = await pending.then(
    () => { throw new Error("Expected the request to reject"); },
    (error: unknown) => error,
  );
  // Assert booleans so a regression never prints a parser's response-body snippet.
  expect(error instanceof Error).toBe(true);
  if (!(error instanceof Error)) throw new Error("Expected an Error rejection");
  return error;
}

const requestPaths: { name: string; call: () => Promise<unknown>; apiError: boolean; context: string; tooLarge?: string }[] = [
  { name: "api request", call: () => api.documents.list(), apiError: true, context: "Request failed" },
  {
    name: "image upload",
    call: () => uploadAsset("document-one", new File(["image data"], "diagram.png", { type: "image/png" })),
    apiError: true,
    context: "Request failed",
    // A 413 that is not the app's JSON is the proxy refusing the body (#2339): it gets words, not a status.
    tooLarge: UPLOAD_TOO_LARGE_MESSAGE,
  },
  {
    name: "import upload",
    call: () => uploadImportBatch([new File(["# Notes"], "notes.md", { type: "text/markdown" })]),
    apiError: false,
    context: "Import failed",
    tooLarge: IMPORT_REQUEST_TOO_LARGE,
  },
];

describe.each(requestPaths)("$name response boundary", ({ call, apiError, context, tooLarge }) => {
  const failures = [
    { name: "HTML", text: "<html><body>Upload exceeds proxy limit</body></html>", status: 413, statusText: "Content Too Large" },
    { name: "plain text", text: "Upstream service unavailable", status: 502, statusText: "Bad Gateway" },
    { name: "empty", text: "", status: 503, statusText: "" },
    { name: "malformed JSON", text: '{"error":"Incomplete response', status: 502, statusText: "Bad Gateway" },
    { name: "whitespace", text: " \n\t ", status: 503, statusText: "Service Unavailable" },
  ];

  it.each(failures)("rejects $name HTTP failures without diagnostic content", async ({ text, status, statusText }) => {
    const read = respond(text, { status, statusText });
    const error = await captureError(call());
    const words = status === 413 ? tooLarge : undefined;

    expect(error instanceof ApiError).toBe(apiError);
    expect(error instanceof SyntaxError).toBe(false);
    expect(error.message === (words ?? `${context} (${status})`)).toBe(true);
    expect(error.message.trim().length > 0).toBe(true);
    expect(error.message.includes(String(status))).toBe(words === undefined);
    if (text) expect(error.message.includes(text)).toBe(false);
    expect(error.message.includes("<html>")).toBe(false);
    expect(error.cause === undefined).toBe(true);
    if (error instanceof ApiError) {
      expect(error.status).toBe(status);
      expect(error.body === undefined).toBe(true);
      expect(error.issues === undefined).toBe(true);
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it.each([
    { name: "null", body: null },
    { name: "empty array", body: [] },
    { name: "array", body: ["Service unavailable"] },
    { name: "string", body: "Service unavailable" },
    { name: "number", body: 42 },
    { name: "zero", body: 0 },
    { name: "true", body: true },
    { name: "false", body: false },
    { name: "missing error", body: {} },
    { name: "null error", body: { error: null } },
    { name: "empty error", body: { error: "" } },
    { name: "whitespace error", body: { error: " \n\t " } },
    { name: "number error", body: { error: 42 } },
    { name: "zero error", body: { error: 0 } },
    { name: "boolean error", body: { error: false } },
    { name: "array error", body: { error: ["Service unavailable"] } },
    { name: "object error", body: { error: { detail: "Service unavailable" } } },
  ])("uses the status fallback for a JSON $name", async ({ body }) => {
    const read = respond(JSON.stringify(body), { status: 503 });
    const error = await captureError(call());

    expect(error instanceof ApiError).toBe(apiError);
    expect(error instanceof TypeError).toBe(false);
    expect(error.message === `${context} (503)`).toBe(true);
    expect(error.message.includes("[object Object]")).toBe(false);
    if (error instanceof ApiError) expect(error.status).toBe(503);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it.each(["Forbidden", "Invalid request", "  Please try later.  "])("preserves the server message exactly (%#)", async (message) => {
    const body = {
      error: message,
      issues: [{ path: ["login"], message: "Enter a GitHub handle" }],
      detail: { operation: "collaborator" },
    };
    const read = respond(JSON.stringify(body), { status: 400 });
    const error = await captureError(call());

    expect(error instanceof ApiError).toBe(apiError);
    expect(error.message === message).toBe(true);
    expect(apiErrorText(error, FALLBACK) === (apiError ? body.issues[0].message : message)).toBe(true);
    if (error instanceof ApiError) {
      expect(error.status).toBe(400);
      expect(JSON.stringify(error.issues) === JSON.stringify(body.issues)).toBe(true);
      expect(JSON.stringify(error.body) === JSON.stringify(body)).toBe(true);
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it.each([
    { name: "HTML", text: "<html><body>Unexpected response page</body></html>", status: 200 },
    { name: "plain text", text: "Unexpected response page", status: 200 },
    { name: "malformed JSON", text: '{"documents":', status: 201 },
    { name: "whitespace", text: " \n\t ", status: 200 },
  ])("rejects a nonempty $name success body explicitly", async ({ text, status }) => {
    const read = respond(text, { status });
    const error = await captureError(call());

    expect(error instanceof ApiError).toBe(apiError);
    expect(error instanceof SyntaxError).toBe(false);
    expect(error.message === `Invalid JSON response (${status})`).toBe(true);
    expect(error.message.includes(text)).toBe(false);
    expect(error.cause === undefined).toBe(true);
    if (error instanceof ApiError) {
      expect(error.status).toBe(status);
      expect(error.body === undefined).toBe(true);
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it.each([200, 204, 205])("handles an empty success body (%s)", async (status) => {
    const read = respond(null, { status });
    if (apiError) expect((await call()) === null).toBe(true);
    // An import answer without the created document means the file was not imported.
    else expect((await captureError(call())).message).toBe(`Import failed (${status})`);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("preserves fetch rejection identity without reading or retrying", async () => {
    const failure = new Error("Network unavailable");
    const read = vi.spyOn(Response.prototype, "text");
    fetchMock.mockRejectedValue(failure);
    expect(await captureError(call()) === failure).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(read).not.toHaveBeenCalled();
  });

  it.each([200, 503])("preserves body-read rejection identity without retrying (%s)", async (status) => {
    const failure = new Error("Response read interrupted");
    const read = respond(null, { status }).mockRejectedValue(failure);
    expect(await captureError(call()) === failure).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledTimes(1);
  });
});

describe("api request contracts", () => {
  it("preserves JSON success and ordinary request options regardless of content type", async () => {
    const body = { document: { id: "document-one", title: "Notes" } };
    const read = respond(JSON.stringify(body), { status: 201, headers: { "Content-Type": "text/plain" } });
    const result = await api.documents.create({ title: "Notes" });
    expect(JSON.stringify(result) === JSON.stringify(body)).toBe(true);
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith("/api/documents", {
      method: "POST",
      body: JSON.stringify({ title: "Notes" }),
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
    });
    expect(read).toHaveBeenCalledTimes(1);
  });

  it.each([null, [], "ready", 42, false])("preserves valid JSON success values (%#)", async (body) => {
    const read = respond(JSON.stringify(body));
    expect(JSON.stringify(await api.documents.list()) === JSON.stringify(body)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it.each([
    { name: "publish", call: () => api.documents.publish("document-one") },
    { name: "pull", call: () => api.documents.pull("document-one", { merge: true }) },
  ])("preserves $name sync 409 information", async ({ call }) => {
    const body = {
      error: "GitHub changed",
      status: "conflict",
      remoteContent: "# Remote notes",
      merged: "# Merged notes",
      conflicts: 2,
      remote: { sha: "revision-one", revision: null, url: null, updatedAt: null },
      localChanged: true,
      remoteChanged: true,
      lines: { local: 3, remote: 4 },
    };
    const read = respond(JSON.stringify(body), { status: 409 });
    const error = await captureError(call());
    expect(error instanceof ApiError).toBe(true);
    if (!(error instanceof ApiError)) throw new Error("Expected ApiError");
    expect(error.status).toBe(409);
    expect(error.message === body.error).toBe(true);
    expect(JSON.stringify(error.body) === JSON.stringify(body)).toBe(true);
    expect(error.body?.status === "conflict").toBe(true);
    expect(error.body?.remoteContent === body.remoteContent).toBe(true);
    expect(error.body?.merged === body.merged).toBe(true);
    expect(error.body?.conflicts === body.conflicts).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("keeps validation issues when the server message is unusable", async () => {
    const body = { error: {}, issues: [{ message: "Enter a GitHub handle" }] };
    respond(JSON.stringify(body), { status: 400 });
    const error = await captureError(api.documents.addCollaborator("document-one", "", "viewer"));
    expect(error.message === "Request failed (400)").toBe(true);
    expect(apiErrorText(error, FALLBACK) === body.issues[0].message).toBe(true);
  });
});

describe("addCollaborator (#2252)", () => {
  const sent = () => JSON.parse(String(fetchMock.mock.calls[0][1]?.body)) as Record<string, unknown>;

  it("an add sends the handle and the role and nothing else: it never asks to change a role", async () => {
    respond(JSON.stringify({ ok: true, login: "octocat", role: "viewer", pending: false }), { status: 200 });
    await api.documents.addCollaborator("document-one", "octocat", "viewer");
    expect(fetchMock.mock.calls[0][0]).toBe("/api/documents/document-one/collaborators");
    expect(fetchMock.mock.calls[0][1]?.method).toBe("POST");
    expect(sent()).toEqual({ login: "octocat", role: "viewer" });
  });

  it.each([{}, { change: false }, { change: undefined }])("options %j send no change flag either", async (options) => {
    respond(JSON.stringify({ ok: true, login: "octocat", role: "viewer", pending: false }), { status: 200 });
    await api.documents.addCollaborator("document-one", "octocat", "viewer", options);
    expect(sent()).toEqual({ login: "octocat", role: "viewer" });
  });

  it("change: true is sent as a real boolean", async () => {
    respond(JSON.stringify({ ok: true, login: "octocat", role: "editor", pending: false }), { status: 200 });
    await api.documents.addCollaborator("document-one", "octocat", "editor", { change: true });
    expect(sent()).toEqual({ login: "octocat", role: "editor", change: true });
  });

  it("a refused add rejects with the status, the code and the role the person keeps", async () => {
    const body = { error: "octocat already has access as viewer. Send change: true to change the role.", code: "already-collaborator", login: "octocat", role: "viewer" };
    respond(JSON.stringify(body), { status: 409 });
    const error = await captureError(api.documents.addCollaborator("document-one", "octocat", "editor"));
    expect(error instanceof ApiError).toBe(true);
    if (!(error instanceof ApiError)) return;
    expect(error.status).toBe(409);
    expect(error.message).toBe(body.error);
    expect(error.body).toEqual(body);
  });
});

describe("uploadAsset", () => {
  it("preserves success and uploads the exact named image without a multipart content type", async () => {
    const file = new File(["image data"], "diagram.png", { type: "image/png" });
    const body = { id: "asset-one", url: "/assets/asset-one", name: file.name, mime: file.type, size: file.size, alt: "diagram" };
    const read = respond(JSON.stringify(body), { status: 201 });
    expect(JSON.stringify(await uploadAsset("document-one", file)) === JSON.stringify(body)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/documents/document-one/assets");
    expect(init?.method).toBe("POST");
    expect(init?.credentials).toBe("same-origin");
    expect(new Headers(init?.headers).has("Content-Type")).toBe(false);
    const form = init?.body;
    expect(form instanceof FormData).toBe(true);
    if (!(form instanceof FormData)) throw new Error("Expected FormData");
    expect([...form.keys()]).toEqual(["file"]);
    const uploaded = form.get("file");
    expect(uploaded instanceof File).toBe(true);
    if (!(uploaded instanceof File)) throw new Error("Expected uploaded File");
    expect(uploaded.name).toBe(file.name);
    expect(uploaded.type).toBe(file.type);
    expect(uploaded.size).toBe(file.size);
    expect(await uploaded.text() === await file.text()).toBe(true);
  });

  const picture = () => new File(["image data"], "holiday.png", { type: "image/png" });
  const NGINX_413 = "<html>\r\n<head><title>413 Request Entity Too Large</title></head>\r\n<body>\r\n<center><h1>413 Request Entity Too Large</h1></center>\r\n<hr><center>nginx/1.24.0 (Ubuntu)</center>\r\n</body>\r\n</html>\r\n";

  it("says the file is too large when the proxy refuses the body with its own 413 page (#2339)", async () => {
    respond(NGINX_413, { status: 413, statusText: "Request Entity Too Large", headers: { "Content-Type": "text/html" } });
    const error = await captureError(uploadAsset("document-one", picture()));
    expect(error instanceof ApiError).toBe(true);
    expect(error.message).toBe("The file is too large for the server to accept");
    expect(error.message).toBe(UPLOAD_TOO_LARGE_MESSAGE);
    expect(apiErrorText(error, "Upload failed")).toBe(UPLOAD_TOO_LARGE_MESSAGE);
    if (error instanceof ApiError) expect(error.status).toBe(413);
  });

  it("keeps the app's own message for a 413 it answered itself", async () => {
    respond(JSON.stringify({ error: "Images must be 5 MB or smaller" }), { status: 413 });
    const error = await captureError(uploadAsset("document-one", picture()));
    expect(error.message).toBe("Images must be 5 MB or smaller");
    if (error instanceof ApiError) expect(error.status).toBe(413);
  });

  it("keeps the status fallback for every other failure that is not the app's JSON", async () => {
    respond("<html><body>Bad Gateway</body></html>", { status: 502 });
    expect((await captureError(uploadAsset("document-one", picture()))).message).toBe("Request failed (502)");
  });

  it("does not change what another request says for the same 413 page", async () => {
    respond(NGINX_413, { status: 413 });
    expect((await captureError(api.documents.list())).message).toBe("Request failed (413)");
  });
});

describe("apiErrorText", () => {
  it("shows the first validation issue's message instead of the bare 'Invalid request'", () => {
    const err = new ApiError(400, "Invalid request", [{ path: ["login"], message: "Enter a GitHub handle" }]);
    expect(apiErrorText(err, FALLBACK)).toBe("Enter a GitHub handle");
    expect(err.message).toBe("Invalid request");
  });

  it("falls back to the ApiError message when issues is empty", () => {
    expect(apiErrorText(new ApiError(400, "Invalid request", []), FALLBACK)).toBe("Invalid request");
  });

  it("falls back to the ApiError message when issues is not an array", () => {
    expect(apiErrorText(new ApiError(400, "Invalid request", "weird"), FALLBACK)).toBe("Invalid request");
  });

  it("returns a plain Error's message", () => {
    expect(apiErrorText(new Error("boom"), FALLBACK)).toBe("boom");
  });

  it("returns the fallback for a non-Error", () => {
    expect(apiErrorText(undefined, FALLBACK)).toBe(FALLBACK);
  });
});
