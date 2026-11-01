import { describe, expect, it } from "vitest";
import { parseMarkdown } from "./parse";
import { videoAssetMarkdownLink } from "./video";

const VIDEO_URL = "/api/assets/0123456789abcdef.mp4";

describe("videoAssetMarkdownLink", () => {
  it.each([
    "_draft_.mp4",
    "`demo`.mp4",
    "~clip~.mp4",
    "[take].mp4",
    "literal&copy;.mp4",
    "<draft>.mp4",
  ])("round-trips Markdown syntax in the file name %s", (name) => {
    const markdown = videoAssetMarkdownLink(name, VIDEO_URL);
    expect(markdown).not.toBeNull();
    const video = parseMarkdown(markdown!).doc.firstChild;
    expect(video?.type.name).toBe("video");
    expect(video?.attrs).toEqual({ src: VIDEO_URL, name });
  });
});
