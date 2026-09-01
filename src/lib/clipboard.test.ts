// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COPY_FALLBACK_HINT, canCopy, copyText, selectContents } from "./clipboard";

function setClipboard(value: unknown) {
  Object.defineProperty(navigator, "clipboard", { value, configurable: true, writable: true });
}

// jsdom does not implement `document.execCommand`, so the tests define it per test and must take it away
// again afterwards (or put back whatever the environment had) rather than leave a stub on the shared document.
const originalExecCommand = Object.getOwnPropertyDescriptor(document, "execCommand");

function setExecCommand(value: unknown) {
  Object.defineProperty(document, "execCommand", { value, configurable: true, writable: true });
}

function restoreExecCommand() {
  if (originalExecCommand) Object.defineProperty(document, "execCommand", originalExecCommand);
  else Reflect.deleteProperty(document, "execCommand");
}

describe("copyText", () => {
  let execCommand: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    execCommand = vi.fn().mockReturnValue(true);
    setExecCommand(execCommand);
  });

  afterEach(() => {
    restoreExecCommand();
    setClipboard(undefined);
    document.querySelectorAll("textarea").forEach((t) => t.remove());
  });

  it("uses navigator.clipboard.writeText when it resolves, exactly once, and skips the fallback", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    setClipboard({ writeText });
    await expect(copyText("hello")).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith("hello");
    expect(execCommand).not.toHaveBeenCalled();
    expect(document.querySelector("textarea")).toBeNull();
  });

  it("falls back to a textarea + execCommand('copy') when navigator.clipboard is undefined (insecure origin)", async () => {
    setClipboard(undefined);
    let seen: HTMLTextAreaElement | null = null;
    execCommand.mockImplementation((cmd: string) => {
      // The textarea is in the DOM, holds the text and is selected while the command runs.
      seen = document.querySelector("textarea");
      expect(cmd).toBe("copy");
      expect(seen?.value).toBe("token mdk_abc");
      expect(seen?.selectionStart).toBe(0);
      expect(seen?.selectionEnd).toBe("token mdk_abc".length);
      return true;
    });
    await expect(copyText("token mdk_abc")).resolves.toBe(true);
    expect(execCommand).toHaveBeenCalledTimes(1);
    expect(execCommand).toHaveBeenCalledWith("copy");
    expect(seen).not.toBeNull();
    expect(document.querySelector("textarea")).toBeNull();
  });

  it("runs the fallback synchronously inside the call when the API is absent (the click gesture is still live)", () => {
    setClipboard(undefined);
    const promise = copyText("now");
    // No await has happened yet, and execCommand already ran.
    expect(execCommand).toHaveBeenCalledWith("copy");
    expect(document.querySelector("textarea")).toBeNull();
    return expect(promise).resolves.toBe(true);
  });

  it("returns execCommand's result and never throws when the fallback refuses", async () => {
    setClipboard(undefined);
    execCommand.mockReturnValue(false);
    await expect(copyText("nope")).resolves.toBe(false);
    execCommand.mockImplementation(() => {
      throw new Error("blocked");
    });
    await expect(copyText("nope")).resolves.toBe(false);
    expect(document.querySelector("textarea")).toBeNull();
  });

  it("falls back when writeText rejects", async () => {
    const writeText = vi.fn().mockRejectedValue(new DOMException("Document is not focused", "NotAllowedError"));
    setClipboard({ writeText });
    await expect(copyText("again")).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(execCommand).toHaveBeenCalledTimes(1);
    expect(execCommand).toHaveBeenCalledWith("copy");
    expect(document.querySelector("textarea")).toBeNull();
  });

  it("falls back when writeText throws synchronously", async () => {
    setClipboard({
      writeText: () => {
        throw new TypeError("Illegal invocation");
      },
    });
    await expect(copyText("sync")).resolves.toBe(true);
    expect(execCommand).toHaveBeenCalledWith("copy");
  });

  it("gives focus back to the element that had it", async () => {
    setClipboard(undefined);
    const button = document.createElement("button");
    document.body.appendChild(button);
    button.focus();
    expect(document.activeElement).toBe(button);
    await copyText("focus");
    expect(document.activeElement).toBe(button);
    button.remove();
  });
});

describe("canCopy", () => {
  afterEach(() => {
    restoreExecCommand();
    setClipboard(undefined);
  });

  it("is true with the async API, true with execCommand only, false with neither", () => {
    setExecCommand(vi.fn());
    setClipboard({ writeText: vi.fn() });
    expect(canCopy()).toBe(true);
    setClipboard(undefined);
    expect(canCopy()).toBe(true);
    setExecCommand(undefined);
    expect(canCopy()).toBe(false);
  });
});

describe("selectContents", () => {
  it("selects an input with .select() and a <pre> with a range", () => {
    const input = document.createElement("input");
    input.value = "abc";
    document.body.appendChild(input);
    selectContents(input);
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(3);
    input.remove();

    const pre = document.createElement("pre");
    pre.textContent = "{ \"a\": 1 }";
    document.body.appendChild(pre);
    selectContents(pre);
    expect(window.getSelection()?.toString()).toBe("{ \"a\": 1 }");
    pre.remove();

    expect(() => selectContents(null)).not.toThrow();
  });

  it("exports the hint the buttons show", () => {
    expect(COPY_FALLBACK_HINT).toBe("Select & press Ctrl+C");
  });
});
