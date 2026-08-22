// @vitest-environment jsdom
import { describe, expect, it, afterEach, vi } from "vitest";
import * as Y from "yjs";
import { EditorState, TextSelection } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { Slice } from "prosemirror-model";
import { MarkdownBinding, markdownBindingPlugin } from "../sync/markdown-binding";
import { imageUploadPlugin, imageUploadKey, findPlaceholder, altFromFileName, imageFiles, type ImageUploader } from "./images";

const views: EditorView[] = [];
afterEach(() => {
  for (const v of views) v.destroy();
  views.length = 0;
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
  return { view, ytext, session, onError };
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
});
