/** Preserve only Share context when authentication interrupts a resource link. */
export function shareReturnPath(path: string, search: Record<string, string | string[] | undefined>): string {
  const query = new URLSearchParams();
  for (const key of ["share", "accessRequest", "notification"]) {
    const value = search[key];
    if (typeof value === "string" && value.length <= 100) query.set(key, value);
  }
  return query.size ? `${path}?${query}` : path;
}
