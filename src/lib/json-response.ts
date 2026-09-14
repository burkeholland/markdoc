interface JsonResponseOptions {
  fallback: string;
  emptyBody?: unknown;
  createError?: (message: string, body?: Record<string, unknown>) => Error;
}

function isErrorBody(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Decode once, keeping transport errors intact and parser diagnostics out of user-facing errors. */
export async function readJsonResponse(
  res: Response,
  { fallback, emptyBody = null, createError = (message) => new Error(message) }: JsonResponseOptions,
): Promise<unknown> {
  const text = await res.text();
  let data: unknown = emptyBody;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      throw createError(res.ok ? `Invalid JSON response (${res.status})` : fallback);
    }
  }
  if (!res.ok) {
    const body = isErrorBody(data) ? data : undefined;
    const message = body?.error;
    throw createError(typeof message === "string" && message.trim() ? message : fallback, body);
  }
  return data;
}
