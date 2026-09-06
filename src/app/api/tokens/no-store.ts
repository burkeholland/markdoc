export function noStore<T extends unknown[]>(route: (...args: T) => Promise<Response>) {
  return async (...args: T) => {
    const response = await route(...args);
    response.headers.set("Cache-Control", "no-store");
    return response;
  };
}
