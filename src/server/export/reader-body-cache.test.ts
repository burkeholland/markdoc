import { afterEach, describe, expect, it, vi } from "vitest";

const render = vi.fn(async (markdown: string) => ({ html: `<p>${markdown}</p>`, headings: [] }));
vi.mock("./html", () => ({ renderMarkdownBody: (markdown: string) => render(markdown) }));

const { renderReaderBody, clearReaderBodyCache } = await import("./reader-body-cache");

afterEach(() => {
  clearReaderBodyCache();
  render.mockClear();
});

describe("renderReaderBody (#2418)", () => {
  it("renders an unchanged document once", async () => {
    const [a, b] = await Promise.all([renderReaderBody("one", "h1"), renderReaderBody("one", "h1")]);
    expect(await renderReaderBody("one", "h1")).toBe(a);
    expect(b).toBe(a);
    expect(render).toHaveBeenCalledTimes(1);
    await renderReaderBody("two", "h2");
    expect(render).toHaveBeenCalledTimes(2);
  });

  it("forgets failed renders and evicts the least recently used", async () => {
    render.mockRejectedValueOnce(new Error("boom"));
    await expect(renderReaderBody("bad", "bad")).rejects.toThrow("boom");
    await renderReaderBody("bad", "bad");
    expect(render).toHaveBeenCalledTimes(2);

    for (let i = 0; i < 17; i++) await renderReaderBody(`d${i}`, `k${i}`);
    render.mockClear();
    await renderReaderBody("d16", "k16");
    expect(render).not.toHaveBeenCalled();
    await renderReaderBody("bad", "bad");
    expect(render).toHaveBeenCalledTimes(1);
  });
});
