/** Keyboard helpers shared by the roving-tabindex widgets (outline list, formatting toolbar). */

export interface RovingOptions {
  /** Which arrow pair moves focus. Default `"vertical"` (↑/↓). */
  orientation?: "horizontal" | "vertical";
  /** Wrap from the last item to the first and back. Default `false` (clamp at the ends). */
  wrap?: boolean;
}

/**
 * Index the arrow/Home/End keys should focus next, or -1 if `key` is not a navigation key (or
 * there is nothing to focus). `current` is -1 when focus is not on any item yet.
 */
export function rovingIndex(key: string, current: number, count: number, { orientation = "vertical", wrap = false }: RovingOptions = {}): number {
  if (count === 0) return -1;
  const [prevKey, nextKey] = orientation === "horizontal" ? ["ArrowLeft", "ArrowRight"] : ["ArrowUp", "ArrowDown"];
  switch (key) {
    case nextKey:
      return wrap ? (current < 0 ? 0 : (current + 1) % count) : Math.min(count - 1, current + 1);
    case prevKey:
      return wrap ? (current < 0 ? count - 1 : (current - 1 + count) % count) : Math.max(0, current - 1);
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return -1;
  }
}
