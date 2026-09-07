// @vitest-environment jsdom
import { describe, expect, it, afterEach, vi } from "vitest";
import * as Y from "yjs";
import { EditorState, TextSelection } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { Slice } from "prosemirror-model";
import { MarkdownBinding, markdownBindingPlugin } from "../sync/markdown-binding";
import { schema } from "../markdown/schema";
import { imageUploadPlugin, imageUploadKey, findPlaceholder, altFromFileName, imageFiles, type ImageUploader } from "./images";

const views: EditorView[] = [];
afterEach(() => {
  for (const v of views) v.destroy();
  views.length = 0;
  vi.unstubAllGlobals();
});

function makeEditor(markdown: string, upload: ImageUploader, onError = vi.fn(), canEdit = true) {
  const ydoc = new Y.Doc();
  const ytext = ydoc.getText("content");
  ytext.insert(0, markdown);
  const binding = new MarkdownBinding(ytext);
  const session = { canEdit };
  const state = EditorState.create({
    doc: binding.initialDoc(),
    plugins: [markdownBindingPlugin(binding), imageUploadPlugin(session, upload, { onError })],
  });
  const view = new EditorView(document.createElement("div"), { state });
  views.push(view);
  return { view, ytext, binding, session, onError };
}

function pngFile(name = "Shot 1.png") {
  return new File([new Uint8Array([137, 80, 78, 71])], name, { type: "image/png" });
}

function paste(view: EditorView, files: File[]) {
  const event = { clipboardData: { files, items: [] } } as unknown as ClipboardEvent;
  return view.someProp("handlePaste", (f) => f(view, event, Slice.empty)) ?? false;
}

function drop(view: EditorView, files: File[]) {
  const event = { dataTransfer: { files, items: [] }, clientX: 0, clientY: 0 } as unknown as DragEvent;
  return view.someProp("handleDrop", (f) => f(view, event, Slice.empty, false)) ?? false;
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

function imageAttrs(view: EditorView) {
  const images: Array<{ src: string; alt: string }> = [];
  view.state.doc.descendants((node) => {
    if (node.type === schema.nodes.image) images.push({ src: node.attrs.src as string, alt: node.attrs.alt as string });
  });
  return images;
}

function previewSpies() {
  const createObjectURL = vi.fn((file: File) => `blob:${file.name}`);
  const revokeObjectURL = vi.fn();
  vi.stubGlobal("URL", { createObjectURL, revokeObjectURL });
  return { createObjectURL, revokeObjectURL };
}

describe("imageUploadPlugin", () => {
  it("shows a placeholder on paste and inserts the image once the upload resolves", async () => {
    const pending = deferred<{ url: string }>();
    const upload = vi.fn(() => pending.promise);
    const { view, ytext } = makeEditor("Hello world\n", upload);
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 6)));

    expect(paste(view, [pngFile()])).toBe(true);
    expect(upload).toHaveBeenCalledTimes(1);

    // Placeholder decoration is present; the shared text is untouched.
    const decos = imageUploadKey.getState(view.state)!;
    expect(decos.find()).toHaveLength(1);
    expect(view.dom.querySelector(".md-image-upload")).not.toBeNull();
    expect(ytext.toString()).toBe("Hello world\n");

    // Typing before the placeholder moves it along.
    view.dispatch(view.state.tr.insertText("XY", 1));
    const id = (decos.find()[0].spec as { id: object }).id;
    expect(findPlaceholder(view.state, id)).toBe(8);

    pending.resolve({ url: "/api/assets/abc123" });
    await flush();

    expect(imageUploadKey.getState(view.state)!.find()).toHaveLength(0);
    expect(view.dom.querySelector(".md-image-upload")).toBeNull();
    const img = view.dom.querySelector("img");
    expect(img?.getAttribute("src")).toBe("/api/assets/abc123");
    expect(img?.getAttribute("alt")).toBe("Shot 1");
    expect(ytext.toString()).toContain("![Shot 1](/api/assets/abc123)");
  });

  it("removes the placeholder and reports when the upload fails", async () => {
    const pending = deferred<{ url: string }>();
    const onError = vi.fn();
    const { view, ytext } = makeEditor("Hello\n", () => pending.promise, onError);
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 6)));
    expect(drop(view, [pngFile("x.png")])).toBe(true);
    expect(imageUploadKey.getState(view.state)!.find()).toHaveLength(1);

    pending.reject(new Error("Images must be 5 MB or smaller"));
    await flush();

    expect(imageUploadKey.getState(view.state)!.find()).toHaveLength(0);
    expect(view.dom.querySelector("img")).toBeNull();
    expect(ytext.toString()).toBe("Hello\n");
    expect(onError).toHaveBeenCalledWith("Images must be 5 MB or smaller", expect.any(File));
  });

  it("ignores pastes without image files and read-only sessions", () => {
    const upload = vi.fn();
    const { view } = makeEditor("Hello\n", upload);
    expect(paste(view, [])).toBe(false);
    expect(paste(view, [new File(["hi"], "notes.txt", { type: "text/plain" })])).toBe(false);
    const readOnly = makeEditor("Hello\n", upload, vi.fn(), false);
    expect(paste(readOnly.view, [pngFile()])).toBe(false);
    expect(upload).not.toHaveBeenCalled();
  });

  it("uses the alt from the uploader when provided", async () => {
    const { view } = makeEditor("Hello\n", async () => ({ url: "/api/assets/z", alt: "Chart" }));
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 6)));
    paste(view, [pngFile()]);
    await flush();
    expect(view.dom.querySelector("img")?.getAttribute("alt")).toBe("Chart");
  });

  it("derives alt text from the file name and filters image files", () => {
    expect(altFromFileName("Screenshot 2026-08-22.png")).toBe("Screenshot 2026-08-22");
    expect(altFromFileName(".png")).toBe("image");
    expect(altFromFileName("noext")).toBe("noext");
    const data = { files: [pngFile(), new File(["x"], "a.txt", { type: "text/plain" })], items: [] } as unknown as DataTransfer;
    expect(imageFiles(data).map((f) => f.name)).toEqual(["Shot 1.png"]);
    expect(imageFiles(null)).toEqual([]);
  });

  it("preserves a three-file batch through reverse settlement and collaborative edits", async () => {
    const previews = previewSpies();
    const pending = [deferred<{ url: string; alt?: string }>(), deferred<{ url: string; alt?: string }>(), deferred<{ url: string; alt?: string }>()];
    const files = [pngFile("First.png"), pngFile("Second.png"), pngFile("Third.png")];
    const byFile = new Map(files.map((file, index) => [file, pending[index]]));
    const upload = vi.fn((file: File) => byFile.get(file)!.promise);
    const { view, ytext } = makeEditor("Hello world\n", upload);
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 6)));

    expect(paste(view, files)).toBe(true);
    expect(upload.mock.calls.map(([file]) => file)).toEqual(files);
    expect(imageUploadKey.getState(view.state)!.find()).toHaveLength(3);
    expect(previews.createObjectURL.mock.calls.map(([file]) => file)).toEqual(files);
    expect([...view.dom.querySelectorAll<HTMLElement>(".md-image-upload")].map((placeholder) => placeholder.title)).toEqual([
      "Uploading First.png…",
      "Uploading Second.png…",
      "Uploading Third.png…",
    ]);

    view.dispatch(view.state.tr.insertText("Remote ", 1));
    pending[2].resolve({ url: "/third", alt: "Third alt" });
    pending[1].resolve({ url: "/second", alt: "Second alt" });
    await flush();
    expect(imageAttrs(view)).toEqual([]);

    const dispatch = vi.spyOn(view, "dispatch");
    pending[0].resolve({ url: "/first", alt: "First alt" });
    await flush();

    expect(imageAttrs(view)).toEqual([
      { src: "/first", alt: "First alt" },
      { src: "/second", alt: "Second alt" },
      { src: "/third", alt: "Third alt" },
    ]);
    expect(ytext.toString()).toContain("Remote Hello![First alt](/first)![Second alt](/second)![Third alt](/third) world");
    expect(imageUploadKey.getState(view.state)!.find()).toHaveLength(0);
    expect(previews.revokeObjectURL).toHaveBeenCalledTimes(3);
    expect(dispatch).toHaveBeenCalledTimes(3);
  });

  it("preserves two-file drop order when the second upload resolves first", async () => {
    const first = deferred<{ url: string }>();
    const second = deferred<{ url: string }>();
    const files = [pngFile("One.png"), pngFile("Two.png")];
    const pending = new Map([
      [files[0], first],
      [files[1], second],
    ]);
    const { view } = makeEditor("Hello\n", (file) => pending.get(file)!.promise);
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 6)));
    drop(view, files);

    second.resolve({ url: "/two" });
    await flush();
    expect(imageAttrs(view)).toEqual([]);
    first.resolve({ url: "/one" });
    await flush();
    expect(imageAttrs(view)).toEqual([
      { src: "/one", alt: "One" },
      { src: "/two", alt: "Two" },
    ]);
  });

  it("reports a failed first member once before inserting later successes in order", async () => {
    const pending = [deferred<{ url: string }>(), deferred<{ url: string }>(), deferred<{ url: string }>()];
    const files = [pngFile("First.png"), pngFile("Second.png"), pngFile("Third.png")];
    const byFile = new Map(files.map((file, index) => [file, pending[index]]));
    const upload = vi.fn((file: File) => byFile.get(file)!.promise);
    const onError = vi.fn();
    const { view } = makeEditor("Hello\n", upload, onError);
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 6)));
    paste(view, files);

    pending[2].resolve({ url: "/third" });
    pending[1].resolve({ url: "/second" });
    await flush();
    expect(imageAttrs(view)).toEqual([]);
    expect(onError).not.toHaveBeenCalled();

    pending[0].reject(new Error("first failed"));
    await flush();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith("first failed", files[0]);
    expect(imageAttrs(view)).toEqual([
      { src: "/second", alt: "Second" },
      { src: "/third", alt: "Third" },
    ]);
    expect(imageUploadKey.getState(view.state)!.find()).toHaveLength(0);
  });

  it("retires a mapped-away placeholder immediately and ignores its late settlement", async () => {
    const previews = previewSpies();
    const pending = deferred<{ url: string }>();
    const onError = vi.fn();
    const { view, ytext } = makeEditor("Hello world\n", () => pending.promise, onError);
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 6)));
    paste(view, [pngFile("Gone.png")]);
    const before = ytext.toString();

    view.dispatch(view.state.tr.delete(1, view.state.doc.content.size));
    expect(imageUploadKey.getState(view.state)!.find()).toHaveLength(0);
    expect(previews.revokeObjectURL).toHaveBeenCalledTimes(1);

    pending.resolve({ url: "/late" });
    await flush();
    expect(imageAttrs(view)).toEqual([]);
    expect(ytext.toString()).not.toContain("/late");
    expect(ytext.toString()).not.toBe(before);
    expect(onError).not.toHaveBeenCalled();
  });

  it("retires pending work on permission loss while a new batch can later complete", async () => {
    const previews = previewSpies();
    const oldPending = [deferred<{ url: string }>(), deferred<{ url: string }>()];
    const freshPending = deferred<{ url: string }>();
    const upload = vi
      .fn<(file: File) => Promise<{ url: string }>>()
      .mockImplementationOnce(() => oldPending[0].promise)
      .mockImplementationOnce(() => oldPending[1].promise)
      .mockImplementationOnce(() => freshPending.promise);
    const onError = vi.fn();
    const { view, session } = makeEditor("Hello\n", upload, onError);
    const oldFiles = [pngFile("Old one.png"), pngFile("Old two.png")];
    paste(view, oldFiles);

    session.canEdit = false;
    view.dispatch(view.state.tr);
    expect(imageUploadKey.getState(view.state)!.find()).toHaveLength(0);
    expect(previews.revokeObjectURL).toHaveBeenCalledTimes(2);

    session.canEdit = true;
    paste(view, [pngFile("Fresh.png")]);
    const dispatch = vi.spyOn(view, "dispatch");
    oldPending[0].resolve({ url: "/stale-success" });
    oldPending[1].reject(new Error("stale failure"));
    await flush();
    expect(imageAttrs(view)).toEqual([]);
    expect(onError).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();

    freshPending.resolve({ url: "/fresh" });
    await flush();
    expect(imageAttrs(view)).toEqual([{ src: "/fresh", alt: "Fresh" }]);
    expect(upload).toHaveBeenCalledTimes(3);
    expect(previews.revokeObjectURL).toHaveBeenCalledTimes(3);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("retires an old plugin on replacement without affecting the replacement batch", async () => {
    const previews = previewSpies();
    const oldPending = deferred<{ url: string }>();
    const freshPending = deferred<{ url: string }>();
    const oldError = vi.fn();
    const freshError = vi.fn();
    const oldUpload = vi.fn(() => oldPending.promise);
    const freshUpload = vi.fn(() => freshPending.promise);
    const { view, binding, session } = makeEditor("Hello\n", oldUpload, oldError);
    paste(view, [pngFile("Old.png")]);

    view.updateState(
      view.state.reconfigure({
        plugins: [markdownBindingPlugin(binding), imageUploadPlugin(session, freshUpload, { onError: freshError })],
      }),
    );
    expect(previews.revokeObjectURL).toHaveBeenCalledTimes(1);
    expect(view.dom.querySelector(".md-image-upload")).toBeNull();
    paste(view, [pngFile("Fresh.png")]);
    expect(imageUploadKey.getState(view.state)!.find()).toHaveLength(1);

    const dispatch = vi.spyOn(view, "dispatch");
    oldPending.reject(new Error("old failed"));
    freshPending.resolve({ url: "/fresh" });
    await flush();
    expect(oldError).not.toHaveBeenCalled();
    expect(freshError).not.toHaveBeenCalled();
    expect(imageAttrs(view)).toEqual([{ src: "/fresh", alt: "Fresh" }]);
    expect(imageUploadKey.getState(view.state)!.find()).toHaveLength(0);
    expect(previews.revokeObjectURL).toHaveBeenCalledTimes(2);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("keeps independent views isolated and dispatches nothing after destruction", async () => {
    const previews = previewSpies();
    const firstPending = deferred<{ url: string }>();
    const secondPending = deferred<{ url: string }>();
    const firstError = vi.fn();
    const secondError = vi.fn();
    const first = makeEditor("First\n", () => firstPending.promise, firstError);
    const second = makeEditor("Second\n", () => secondPending.promise, secondError);
    paste(first.view, [pngFile("First.png")]);
    paste(second.view, [pngFile("Second.png")]);
    const firstDispatch = vi.spyOn(first.view, "dispatch");

    first.view.destroy();
    expect(previews.revokeObjectURL).toHaveBeenCalledTimes(1);
    const dispatchesAfterDestroy = firstDispatch.mock.calls.length;
    firstPending.reject(new Error("late failure"));
    secondPending.resolve({ url: "/second" });
    await flush();

    expect(firstDispatch).toHaveBeenCalledTimes(dispatchesAfterDestroy);
    expect(firstError).not.toHaveBeenCalled();
    expect(first.ytext.toString()).toBe("First\n");
    expect(imageAttrs(second.view)).toEqual([{ src: "/second", alt: "Second" }]);
    expect(secondError).not.toHaveBeenCalled();
    expect(previews.revokeObjectURL).toHaveBeenCalledTimes(2);
  });
});
