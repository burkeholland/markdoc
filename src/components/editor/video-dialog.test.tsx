// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VideoDialog } from "./dialogs";

afterEach(cleanup);

describe("VideoDialog file selection", () => {
  it.each(["files", "index", "name"] as const)(
    "reports unreadable selected-file %s and stays usable",
    (getter) => {
      const onUpload = vi.fn(async () => ({
        id: "video-id",
        url: "/api/videos/video-id",
        name: "video.mp4",
        mime: "video/mp4" as const,
        size: 12,
      }));
      render(
        <VideoDialog
          open
          onOpenChange={vi.fn()}
          onSubmit={vi.fn()}
          onUpload={onUpload}
        />,
      );
      const input = screen.getByTestId("video-file") as HTMLInputElement;
      const selected = new File(["selected"], "selected.mp4", {
        type: "application/octet-stream",
      });

      if (getter === "files") {
        Object.defineProperty(input, "files", {
          configurable: true,
          get() {
            throw new Error("FileList getter failed");
          },
        });
      } else if (getter === "index") {
        const files = new Proxy(
          { length: 1, item: () => selected },
          {
            get(target, property, receiver) {
              if (property === "0") throw new Error("File index getter failed");
              return Reflect.get(target, property, receiver);
            },
          },
        );
        Object.defineProperty(input, "files", {
          configurable: true,
          value: files,
        });
      } else {
        Object.defineProperty(selected, "name", {
          configurable: true,
          get() {
            throw new Error("File name getter failed");
          },
        });
        Object.defineProperty(input, "files", {
          configurable: true,
          value: [selected],
        });
      }

      act(() => {
        input.dispatchEvent(
          new Event("change", { bubbles: true, cancelable: true }),
        );
      });

      expect(onUpload).not.toHaveBeenCalled();
      expect(screen.getByTestId("video-upload-error")).toHaveTextContent(
        "Could not read the selected file. Please choose it again.",
      );
      expect(screen.getByTestId("video-submit")).toBeDisabled();
    },
  );
});
