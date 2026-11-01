// @vitest-environment jsdom
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { yCollab } from "y-codemirror.next";
import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";
import { codeVideoUpload } from "./videos";
import type { UploadedVideo, VideoUploader } from "@/lib/video-limits";

interface TestSession {
  canEdit: boolean;
  readonly ytext: Y.Text;
}

const views: EditorView[] = [];
const awarenesses: Awareness[] = [];
const docs: Y.Doc[] = [];
const rangeMethods = ["getClientRects", "getBoundingClientRect"] as const;
const originalRangeMethods = rangeMethods.map((name) => Object.getOwnPropertyDescriptor(Range.prototype, name));

beforeAll(() => {
  Object.defineProperties(Range.prototype, {
    getClientRects: { configurable: true, value: () => document.body.getClientRects() },
    getBoundingClientRect: { configurable: true, value: () => new DOMRect() },
  });
});

afterEach(() => {
  for (const view of views) view.destroy();
  for (const awareness of awarenesses) awareness.destroy();
  for (const doc of docs) doc.destroy();
  views.length = 0;
  awarenesses.length = 0;
  docs.length = 0;
});

afterAll(() => {
  rangeMethods.forEach((name, index) => {
    const original = originalRangeMethods[index];
    if (original) Object.defineProperty(Range.prototype, name, original);
    else Reflect.deleteProperty(Range.prototype, name);
  });
});

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

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function makeEditor(doc: string, upload: VideoUploader, cursor = doc.length) {
  const ydoc = new Y.Doc();
  const ytext = ydoc.getText("content");
  ytext.insert(0, doc);
  const awareness = new Awareness(ydoc);
  const session: TestSession = { canEdit: true, ytext };
  const view = new EditorView({
    state: EditorState.create({
      doc,
      selection: { anchor: cursor },
      extensions: [yCollab(ytext, awareness), codeVideoUpload(session, upload)],
    }),
    parent: document.body,
  });
  views.push(view);
  awarenesses.push(awareness);
  docs.push(ydoc);
  return { view, ytext };
}

function paste(view: EditorView, files: File[]) {
  const event = new Event("paste", { bubbles: true, cancelable: true }) as ClipboardEvent;
  Object.defineProperty(event, "clipboardData", { value: { files, items: [] } });
  view.contentDOM.dispatchEvent(event);
  return event.defaultPrevented;
}

describe("codeVideoUpload", () => {
  it("preserves paste order when multiple uploads settle out of order", async () => {
    const pending = [deferred<UploadedVideo>(), deferred<UploadedVideo>()];
    const files = [videoFile("First.mp4"), videoFile("Second.mp4")];
    const byFile = new Map(files.map((file, index) => [file, pending[index]]));
    const upload = vi.fn<VideoUploader>((file) => byFile.get(file)!.promise);
    const { view, ytext } = makeEditor("Hello", upload);

    expect(paste(view, files)).toBe(true);
    expect(upload.mock.calls.map(([file]) => file)).toEqual(files);

    pending[1].resolve({
      id: "1123456789abcdef",
      url: "/api/assets/1123456789abcdef.mp4",
      name: "Second.mp4",
      mime: "video/mp4",
      size: 12,
    });
    await flush();
    expect(view.state.doc.toString()).toBe("Hello");

    pending[0].resolve({
      id: "0123456789abcdef",
      url: "/api/assets/0123456789abcdef.mp4",
      name: "First.mp4",
      mime: "video/mp4",
      size: 12,
    });
    await flush();

    const first = "[First.mp4](/api/assets/0123456789abcdef.mp4)";
    const second = "[Second.mp4](/api/assets/1123456789abcdef.mp4)";
    expect(view.state.doc.toString().indexOf(first)).toBeLessThan(view.state.doc.toString().indexOf(second));
    expect(ytext.toString()).toBe(view.state.doc.toString());
  });

  it("aborts a cancelled upload and ignores a late completion", async () => {
    const pending = deferred<UploadedVideo>();
    let signal: AbortSignal | undefined;
    const upload = vi.fn<VideoUploader>((_file, uploadSignal) => {
      signal = uploadSignal;
      return pending.promise;
    });
    const { view } = makeEditor("Hello", upload);

    expect(paste(view, [videoFile("Cancelled.mp4")])).toBe(true);
    view.dom.querySelector<HTMLButtonElement>(".md-video-upload-cancel")!.click();

    expect(signal?.aborted).toBe(true);
    expect(view.dom.querySelectorAll(".md-video-upload")).toHaveLength(0);
    pending.resolve({
      id: "0123456789abcdef",
      url: "/api/assets/0123456789abcdef.mp4",
      name: "Cancelled.mp4",
      mime: "video/mp4",
      size: 12,
    });
    await flush();
    expect(view.state.doc.toString()).toBe("Hello");
  });
});
