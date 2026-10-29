/** Largest picture the app stores (5 MiB). The server enforces it; the editor checks it first (#2345). */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** The words the server answers with, shown at once when the browser sees the file is too large. */
export const IMAGE_TOO_LARGE_MESSAGE = "Images must be 5 MB or smaller";

export const isImageTooLarge = (file: Blob) => file.size > MAX_IMAGE_BYTES;

/**
 * Splits files into the ones to upload and the ones over the limit, reporting each refused file
 * through `onTooLarge` before any request is sent.
 */
export function withoutOversizedImages(files: readonly File[], onTooLarge?: (message: string, file: File) => void): File[] {
  const ok: File[] = [];
  for (const file of files) {
    if (isImageTooLarge(file)) onTooLarge?.(IMAGE_TOO_LARGE_MESSAGE, file);
    else ok.push(file);
  }
  return ok;
}
