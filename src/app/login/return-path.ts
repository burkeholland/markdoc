const FALLBACK_RETURN_PATH = "/";
const RETURN_PATH_ORIGIN = "https://markdoc.invalid";
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;
const UNSAFE_PATH_CHARACTER = /[\u0000-\u001f\u007f\\]/;

export function loginReturnPath(value: string | string[] | undefined): string {
  if (typeof value !== "string" || !value.startsWith("/") || CONTROL_CHARACTER.test(value)) {
    return FALLBACK_RETURN_PATH;
  }

  const pathEnd = value.search(/[?#]/);
  const pathname = pathEnd === -1 ? value : value.slice(0, pathEnd);

  let decodedPathname: string;
  try {
    decodedPathname = decodeURIComponent(pathname);
  } catch {
    return FALLBACK_RETURN_PATH;
  }

  if (decodedPathname.startsWith("//") || UNSAFE_PATH_CHARACTER.test(decodedPathname)) {
    return FALLBACK_RETURN_PATH;
  }

  try {
    if (new URL(value, RETURN_PATH_ORIGIN).origin !== RETURN_PATH_ORIGIN) {
      return FALLBACK_RETURN_PATH;
    }
  } catch {
    return FALLBACK_RETURN_PATH;
  }

  return value;
}
