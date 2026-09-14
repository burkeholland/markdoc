export function fenceFor(text: string): string {
  const runs = text.match(/`{3,}/g);
  if (!runs) return "```";
  const longest = runs.reduce((a, b) => (b.length > a.length ? b : a));
  return longest + "`";
}
