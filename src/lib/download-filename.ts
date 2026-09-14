type ExportExtension = "md" | "html" | "pdf";

/** Preserve the legacy ASCII basename, extending it to Unicode without emitting raw header bytes. */
export function exportContentDisposition(title: string, extension: ExportExtension): string {
  const ascii = title.replace(/[^\w\- ]+/g, "").trim() || "document";
  const unicode = title
    .replace(/[^\w\- \u0080-\u{10ffff}]+/gu, "")
    .replace(/[\p{Cc}\p{Cs}\p{Zl}\p{Zp}]/gu, "")
    .trim() || "document";
  const fallback = `attachment; filename="${ascii}.${extension}"`;
  if (unicode === ascii) return fallback;

  const encoded = encodeURIComponent(`${unicode}.${extension}`)
    .replace(/['()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${fallback}; filename*=UTF-8''${encoded}`;
}

function safeBasename(value: string): string | null {
  if (!value || value !== value.trim() || value === "." || value === "..") return null;
  return /[<>:"/\\|?*\p{Cc}\p{Cs}\p{Zl}\p{Zp}]/u.test(value) ? null : value;
}

function utf8Filename(value: string): string | null {
  const match = /^UTF-8'[a-z0-9-]*'((?:[a-z0-9!#$&+.^_`|~-]|%[0-9a-f]{2})+)$/i.exec(value);
  if (!match) return null;
  try {
    return safeBasename(decodeURIComponent(match[1]));
  } catch (error) {
    if (error instanceof URIError) return null;
    throw error;
  }
}

/** Read our UTF-8 attachment parameter, or a safe legacy quoted filename, without decoding twice. */
export function readDownloadFilename(disposition: string | null): string | null {
  let fallback: string | null = null;
  // Consume entire quoted values, including unrelated parameters, so their contents cannot act as parameters.
  const parameters = /;\s*([^=;\s]+)\s*=\s*("(?:[^"\\]|\\.)*"|[^;]*)/g;
  for (const match of (disposition ?? "").matchAll(parameters)) {
    const name = match[1].toLowerCase();
    const value = match[2].trim();
    if (name === "filename*") {
      const filename = utf8Filename(value);
      if (filename) return filename;
    } else if (name === "filename" && value.startsWith('"') && value.endsWith('"')) {
      fallback ??= safeBasename(value.slice(1, -1));
    }
  }
  return fallback;
}
