// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { EditorState, TextSelection } from "prosemirror-state";
import { Slice } from "prosemirror-model";
import { EditorView } from "prosemirror-view";
import { MarkdownBinding, markdownBindingPlugin } from "../sync/markdown-binding";
import { schema } from "../markdown/schema";
import { videoUploadKey, videoUploadPlugin, type VideoUploadOptions } from "./videos";
import type { UploadedVideo, VideoUploader } from "@/lib/video-limits";

const views: EditorView[] = [];

afterEach(() => {
  for (const view of views) view.destroy();
  views.length = 0;
  document.body.replaceChildren();
});

function makeEditor(markdown: string, upload: VideoUploader, options?: VideoUploadOptions) {
  const ydoc = new Y.Doc();
  const ytext = ydoc.getText("content");
  ytext.insert(0, markdown);
  const binding = new MarkdownBinding(ytext);
  const view = new EditorView(document.body.appendChild(document.createElement("div")), {
    state: EditorState.create({
      doc: binding.initialDoc(),
      plugins: [markdownBindingPlugin(binding), videoUploadPlugin({ canEdit: true }, upload, options)],
    }),
  });
  views.push(view);
  return { view, ytext };
}

function videoFile(name: string) {
  return new File([new Uint8Array(12)], name, { type: "video/mp4" });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function drop(view: EditorView, files: File[], pos: number) {
  vi.spyOn(view, "posAtCoords").mockReturnValue({ pos, inside: -1 });
  const event = { dataTransfer: { files, items: [] }, clientX: 0, clientY: 0 } as unknown as DragEvent;
  return view.someProp("handleDrop", (handler) => handler(view, event, Slice.empty, false)) ?? false;
}

function paste(view: EditorView, files: File[], pos: number) {
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos, pos)));
  const event = { clipboardData: { files, items: [] } } as unknown as ClipboardEvent;
  return view.someProp("handlePaste", (handler) => handler(view, event, Slice.empty)) ?? false;
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("videoUploadPlugin", () => {
  it("snaps a text drop to the following block and preserves upload order when requests settle out of order", async () => {
    const pending = [deferred<UploadedVideo>(), deferred<UploadedVideo>()];
    const files = [videoFile("First.mp4"), videoFile("Second.mp4")];
    const byFile = new Map(files.map((file, index) => [file, pending[index]]));
    const upload = vi.fn((file: File) => byFile.get(file)!.promise);
    const { view, ytext } = makeEditor("Hello", upload);
    const anchor = view.state.doc.content.size;

    expect(drop(view, files, 3)).toBe(true);
    expect(upload.mock.calls.map(([file]) => file)).toEqual(files);
    expect(videoUploadKey.getState(view.state)!.decorations.find()).toHaveLength(2);
    expect(videoUploadKey.getState(view.state)!.decorations.find().map(({ from }) => from)).toEqual([anchor, anchor]);
    expect(view.dom.querySelectorAll(".md-video-upload")).toHaveLength(2);

    pending[1].resolve({
      id: "1123456789abcdef",
      url: "/api/assets/1123456789abcdef.mp4",
      name: "Second.mp4",
      mime: "video/mp4",
      size: 12,
    });
    await flush();
    pending[0].resolve({
      id: "0123456789abcdef",
      url: "/api/assets/0123456789abcdef.mp4",
      name: "First.mp4",
      mime: "video/mp4",
      size: 12,
    });
    await flush();

    const videos: Array<{ src: string; name: string }> = [];
    view.state.doc.descendants((node) => {
      if (node.type === schema.nodes.video) videos.push({ src: node.attrs.src as string, name: node.attrs.name as string });
    });
    expect(videos).toEqual([
      { src: "/api/assets/0123456789abcdef.mp4", name: "First.mp4" },
      { src: "/api/assets/1123456789abcdef.mp4", name: "Second.mp4" },
    ]);
    expect(videoUploadKey.getState(view.state)!.decorations.find()).toHaveLength(0);
    expect(ytext.toString()).toContain("Hello\n\n[First.mp4](/api/assets/0123456789abcdef.mp4)");
    expect(ytext.toString()).toContain("[Second.mp4](/api/assets/1123456789abcdef.mp4)");
  });

  it("inserts a pasted video before the paragraph when the caret is at its start", async () => {
    const pending = deferred<UploadedVideo>();
    const upload = vi.fn(() => pending.promise);
    const onError = vi.fn();
    const { view, ytext } = makeEditor("Hello", upload, { onError });

    expect(paste(view, [videoFile("Start.mp4")], 1)).toBe(true);
    expect(videoUploadKey.getState(view.state)!.decorations.find().map(({ from }) => from)).toEqual([0]);
    pending.resolve({
      id: "0123456789abcdef",
      url: "/api/assets/0123456789abcdef.mp4",
      name: "Start.mp4",
      mime: "video/mp4",
      size: 12,
    });
    await flush();

    expect(ytext.toString()).toContain("[Start.mp4](/api/assets/0123456789abcdef.mp4)");
    expect(ytext.toString()).toContain("Hello");
    expect(onError).not.toHaveBeenCalled();
  });

  it("aborts a cancelled upload and ignores a late completion", async () => {
    const pending = deferred<UploadedVideo>();
    let signal: AbortSignal | undefined;
    const upload = vi.fn((_file: File, uploadSignal: AbortSignal) => {
      signal = uploadSignal;
      return pending.promise;
    });
    const { view } = makeEditor("Hello\n", upload);

    expect(drop(view, [videoFile("Cancelled.mp4")], view.state.doc.content.size)).toBe(true);
    view.dom.querySelector<HTMLButtonElement>(".md-video-upload-cancel")!.click();

    expect(signal?.aborted).toBe(true);
    expect(videoUploadKey.getState(view.state)!.decorations.find()).toHaveLength(0);
    pending.resolve({
      id: "0123456789abcdef",
      url: "/api/assets/0123456789abcdef.mp4",
      name: "Cancelled.mp4",
      mime: "video/mp4",
      size: 12,
    });
    await flush();

    let videoCount = 0;
    view.state.doc.descendants((node) => {
      if (node.type === schema.nodes.video) videoCount++;
    });
    expect(videoCount).toBe(0);
  });
});
