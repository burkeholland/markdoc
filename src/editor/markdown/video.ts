export interface VideoAssetReference {
  id: string;
  extension: "mp4" | "webm";
  mime: "video/mp4" | "video/webm";
}

const VIDEO_ASSET_URL = /^\/api\/assets\/([0-9a-z]{16})\.(mp4|webm)$/i;
const LINK_LABEL_MARKDOWN_SPECIALS = new Set(["\\", "`", "*", "_", "~", "[", "]", "<", ">"]);

/** Only document-owned asset paths are rendered as video; arbitrary Markdown links stay links. */
export function parseVideoAssetUrl(value: string): VideoAssetReference | null {
  const match = VIDEO_ASSET_URL.exec(value);
  if (!match) return null;
  const extension = match[2].toLowerCase() as VideoAssetReference["extension"];
  return {
    id: match[1].toLowerCase(),
    extension,
    mime: extension === "mp4" ? "video/mp4" : "video/webm",
  };
}

export function isVideoAssetUrl(value: string): boolean {
  return parseVideoAssetUrl(value) !== null;
}

function escapeVideoLabel(value: string): string {
  const escaped = Array.from(value, (character) =>
    `${LINK_LABEL_MARKDOWN_SPECIALS.has(character) ? "\\" : ""}${character}`,
  ).join("");
  return escaped.replace(/&(?=[a-zA-Z][a-zA-Z0-9]*;|#\d+;|#[xX][0-9a-fA-F]+;)/g, "\\&");
}

export function videoAssetMarkdownLink(name: string, url: string): string | null {
  if (!parseVideoAssetUrl(url)) return null;
  return `[${escapeVideoLabel(name)}](${url})`;
}
