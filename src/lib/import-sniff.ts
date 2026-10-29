// Content sniffing for imported documents, shared by the server (`@/server/import-file`) and the import
// dialog (checked before upload). Shipped to the browser: no `@/server/**` or Node-only imports here.

/** Leading bytes of common binary formats that are sometimes renamed `.md` / `.txt`. */
const MAGIC: readonly (readonly number[])[] = [
  [0x89, 0x50, 0x4e, 0x47], // PNG
  [0xff, 0xd8, 0xff], // JPEG
  [0x47, 0x49, 0x46, 0x38], // GIF
  [0x25, 0x50, 0x44, 0x46, 0x2d], // %PDF-
  [0x50, 0x4b, 0x03, 0x04], // ZIP (DOCX, XLSX, EPUB…)
  [0x50, 0x4b, 0x05, 0x06], // empty ZIP
  [0x1f, 0x8b], // gzip
  [0x42, 0x5a, 0x68], // bzip2
  [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c], // 7z
  [0x52, 0x61, 0x72, 0x21], // RAR
  [0xd0, 0xcf, 0x11, 0xe0], // legacy Office (DOC, XLS)
  [0x7f, 0x45, 0x4c, 0x46], // ELF
  [0x4d, 0x5a], // Windows executable ("MZ")
  [0x52, 0x49, 0x46, 0x46], // RIFF (WAV, AVI, WebP)
  [0x00, 0x00, 0x01, 0x00], // ICO
];

/** More than this share of undecodable or control characters means the bytes are not text. */
const MAX_NON_TEXT_RATIO = 0.05;

function hasUtf16Bom(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff));
}

/**
 * Whether `bytes` look like a binary file rather than UTF-8 / UTF-16 (with BOM) text: a known binary
 * signature, a NUL byte, or more than 5% of the decoded characters being invalid UTF-8 or control characters.
 */
export function looksBinary(bytes: Uint8Array): boolean {
  if (MAGIC.some((sig) => sig.length <= bytes.length && sig.every((b, i) => bytes[i] === b))) return true;
  if (hasUtf16Bom(bytes)) return false;
  if (bytes.includes(0)) return true;
  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  if (!text) return false;
  let bad = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 0xfffd || (c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0c && c !== 0x0d) || c === 0x7f) bad++;
  }
  return bad / text.length > MAX_NON_TEXT_RATIO;
}

export function notTextMessage(name: string): string {
  return `“${name}” doesn't look like a text or Markdown file`;
}
