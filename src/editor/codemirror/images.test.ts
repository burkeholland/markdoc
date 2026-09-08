// @vitest-environment jsdom
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { yCollab } from "y-codemirror.next";
import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";
import { codeImageUpload } from "./images";
import type { ImageUploader } from "../prosemirror/images";

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

function pngFile(name: string) {
  return new File([new Uint8Array([137, 80, 78, 71])], name, { type: "image/png" });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function makeEditor(doc: string, upload: ImageUploader, onError = vi.fn(), cursor = doc.length) {
  const ydoc = new Y.Doc();
  const ytext = ydoc.getText("content");
  ytext.insert(0, doc);
  const awareness = new Awareness(ydoc);
  const session: TestSession = { canEdit: true, ytext };
  const editable = new Compartment();
  const imageExtension = new Compartment();
  const view = new EditorView({
    state: EditorState.create({
      doc,
      selection: { anchor: cursor },
      extensions: [
        yCollab(ytext, awareness),
        editable.of(EditorState.readOnly.of(false)),
        imageExtension.of(codeImageUpload(session, upload, { onError })),
      ],
    }),
    parent: document.body,
  });
  views.push(view);
  awarenesses.push(awareness);
  docs.push(ydoc);
  return { view, ydoc, ytext, session, editable, imageExtension, onError };
}

function paste(view: EditorView, files: File[]) {
  const event = new Event("paste", { bubbles: true, cancelable: true }) as ClipboardEvent;
  Object.defineProperty(event, "clipboardData", { value: { files, items: [] } });
  view.contentDOM.dispatchEvent(event);
  return event.defaultPrevented;
}

function drop(view: EditorView, files: File[], pos: number) {
  vi.spyOn(view, "posAtCoords").mockReturnValue(pos);
  const event = new Event("drop", { bubbles: true, cancelable: true }) as DragEvent;
  Object.defineProperties(event, {
    dataTransfer: { value: { files, items: [] } },
    clientX: { value: 10 },
    clientY: { value: 20 },
  });
  view.contentDOM.dispatchEvent(event);
  return event.defaultPrevented;
}

describe("codeImageUpload", () => {
  it("preserves exact file, URL, and alt association through reverse three-file settlement", async () => {
    const pending = [deferred<{ url: string; alt?: string }>(), deferred<{ url: string; alt?: string }>(), deferred<{ url: string; alt?: string }>()];
    const files = [pngFile("First.png"), pngFile("Second.png"), pngFile("Third.png")];
    const byFile = new Map(files.map((file, index) => [file, pending[index]]));
    const upload = vi.fn((file: File) => byFile.get(file)!.promise);
    const { view, ytext } = makeEditor("start end", upload, vi.fn(), 5);

    expect(paste(view, files)).toBe(true);
    expect(upload.mock.calls.map(([file]) => file)).toEqual(files);
    ytext.insert(0, "Remote ");
    pending[2].resolve({ url: "/third", alt: "Third alt" });
    pending[1].resolve({ url: "/second", alt: "Second alt" });
    await flush();
    expect(view.state.doc.toString()).toBe("Remote start end");

    const dispatch = vi.spyOn(view, "dispatch");
    pending[0].resolve({ url: "/first", alt: "First alt" });
    await flush();
    expect(view.state.doc.toString()).toBe(
      "Remote start ![First alt](/first) ![Second alt](/second) ![Third alt](/third) end",
    );
    expect(ytext.toString()).toBe(view.state.doc.toString());
    expect(upload).toHaveBeenCalledTimes(3);
    expect(dispatch).toHaveBeenCalledTimes(3);
  });

  it("waits behind a pending first member, then skips one failed middle member", async () => {
    const pending = [deferred<{ url: string }>(), deferred<{ url: string }>(), deferred<{ url: string }>()];
    const onError = vi.fn();
    const files = [pngFile("First.png"), pngFile("Middle.png"), pngFile("Third.png")];
    const byFile = new Map(files.map((file, index) => [file, pending[index]]));
    const upload = vi.fn((file: File) => byFile.get(file)!.promise);
    const { view } = makeEditor("Hello", upload, onError);

    expect(drop(view, files, 5)).toBe(true);
    pending[2].resolve({ url: "/third" });
    pending[1].reject(new Error("middle failed"));
    await flush();
    expect(view.state.doc.toString()).toBe("Hello");
    expect(onError).not.toHaveBeenCalled();

    pending[0].resolve({ url: "/first" });
    await flush();
    expect(view.state.doc.toString()).toBe("Hello ![First](/first) ![Third](/third)");
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith("middle failed", files[1]);
  });

  it("retires old work on permission loss while a current batch remains independent", async () => {
    const oldPending = [deferred<{ url: string }>(), deferred<{ url: string }>()];
    const freshPending = deferred<{ url: string }>();
    const upload = vi
      .fn<(file: File) => Promise<{ url: string }>>()
      .mockImplementationOnce(() => oldPending[0].promise)
      .mockImplementationOnce(() => oldPending[1].promise)
      .mockImplementationOnce(() => freshPending.promise);
    const onError = vi.fn();
    const { view, session, editable } = makeEditor("Hello", upload, onError);
    paste(view, [pngFile("Old success.png"), pngFile("Old failure.png")]);

    session.canEdit = false;
    view.dispatch({ effects: editable.reconfigure(EditorState.readOnly.of(true)) });
    session.canEdit = true;
    view.dispatch({ effects: editable.reconfigure(EditorState.readOnly.of(false)) });
    paste(view, [pngFile("Fresh.png")]);
    const dispatch = vi.spyOn(view, "dispatch");

    oldPending[0].resolve({ url: "/stale-success" });
    oldPending[1].reject(new Error("stale failure"));
    await flush();
    expect(dispatch).not.toHaveBeenCalled();
    expect(view.state.doc.toString()).toBe("Hello");
    expect(onError).not.toHaveBeenCalled();

    freshPending.resolve({ url: "/fresh" });
    await flush();
    expect(view.state.doc.toString()).toBe("Hello ![Fresh](/fresh)");
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(upload).toHaveBeenCalledTimes(3);
  });

  it("does not handle image gestures while the view is read-only", () => {
    const upload = vi.fn();
    const { view, editable } = makeEditor("Hello", upload);
    view.dispatch({ effects: editable.reconfigure(EditorState.readOnly.of(true)) });

    paste(view, [pngFile("Nope.png")]);
    expect(upload).not.toHaveBeenCalled();
    expect(view.state.doc.toString()).toBe("Hello");
  });

  it("retires a replaced plugin and lets the replacement own its batch", async () => {
    const oldPending = deferred<{ url: string }>();
    const freshPending = deferred<{ url: string }>();
    const oldError = vi.fn();
    const freshError = vi.fn();
    const oldUpload = vi.fn(() => oldPending.promise);
    const freshUpload = vi.fn(() => freshPending.promise);
    const { view, session, imageExtension } = makeEditor("Hello", oldUpload, oldError);
    paste(view, [pngFile("Old.png")]);

    view.dispatch({ effects: imageExtension.reconfigure(codeImageUpload(session, freshUpload, { onError: freshError })) });
    paste(view, [pngFile("Fresh.png")]);
    const dispatch = vi.spyOn(view, "dispatch");
    oldPending.reject(new Error("old failure"));
    freshPending.resolve({ url: "/fresh" });
    await flush();

    expect(view.state.doc.toString()).toBe("Hello ![Fresh](/fresh)");
    expect(oldError).not.toHaveBeenCalled();
    expect(freshError).not.toHaveBeenCalled();
    expect(oldUpload).toHaveBeenCalledTimes(1);
    expect(freshUpload).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("isolates editor instances and has zero late dispatch or error effects after destroy", async () => {
    const firstPending = [deferred<{ url: string }>(), deferred<{ url: string }>()];
    const secondPending = deferred<{ url: string }>();
    const firstUpload = vi
      .fn<(file: File) => Promise<{ url: string }>>()
      .mockImplementationOnce(() => firstPending[0].promise)
      .mockImplementationOnce(() => firstPending[1].promise);
    const secondUpload = vi.fn(() => secondPending.promise);
    const firstError = vi.fn();
    const secondError = vi.fn();
    const first = makeEditor("First", firstUpload, firstError);
    const second = makeEditor("Second", secondUpload, secondError);
    paste(first.view, [pngFile("Late success.png"), pngFile("Late failure.png")]);
    paste(second.view, [pngFile("Current.png")]);
    const dispatch = vi.spyOn(first.view, "dispatch");

    first.view.destroy();
    firstPending[0].resolve({ url: "/late-success" });
    firstPending[1].reject(new Error("late failure"));
    secondPending.resolve({ url: "/current" });
    await flush();

    expect(dispatch).not.toHaveBeenCalled();
    expect(firstError).not.toHaveBeenCalled();
    expect(first.ytext.toString()).toBe("First");
    expect(second.view.state.doc.toString()).toBe("Second ![Current](/current)");
    expect(secondError).not.toHaveBeenCalled();
  });
});
