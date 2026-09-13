// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import type { ComponentProps } from "react";
import { cleanup, render, screen, within } from "@testing-library/react";
import { compile } from "tailwindcss";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RelativeTimeProps } from "@/components/ui/relative-time";

vi.mock("next/link", () => ({
  default: ({ children, ...props }: ComponentProps<"a">) => <a {...props}>{children}</a>,
}));
vi.mock("@/components/ui/relative-time", () => ({
  RelativeTime: ({ date, prefix }: RelativeTimeProps) => <time dateTime={String(date)}>{prefix}{String(date)}</time>,
}));
vi.mock("./update-pill", () => ({
  UpdatePill: () => null,
}));
vi.mock("./download-menu", () => ({
  DownloadMenu: () => <button data-testid="reader-download">Download</button>,
}));
vi.mock("./scrollable-regions", () => ({
  ReaderScrollableRegions: () => null,
}));
vi.mock("./copy-link", () => ({
  ReaderCopyLink: () => <button data-testid="reader-copy-link">Copy link</button>,
}));

import { ReaderPage, type ReaderPageProps } from "./reader-page";

const BASE_PROPS: ReaderPageProps = {
  docId: "doc-3518",
  title: "Reader title",
  html: "<p>Safe body</p>",
  headings: [],
  initialHash: "hash",
  updatedAt: "2026-09-08T12:00:00.000Z",
  owner: null,
  signedIn: false,
  canOpenEditor: false,
  pollMs: 10_000,
};

const precedes = (a: Element, b: Element) =>
  Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

function renderReader(overrides: Partial<ReaderPageProps> = {}) {
  return render(<ReaderPage {...BASE_PROPS} {...overrides} />);
}

function reactProps(element: HTMLElement): Record<string, unknown> {
  const key = Object.keys(element).find((candidate) => candidate.startsWith("__reactProps$"));
  if (!key) throw new Error(`React props were not attached to ${element.dataset.testid ?? element.tagName}`);
  return (element as unknown as Record<string, Record<string, unknown>>)[key];
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("ReaderPage header title link", () => {
  it.each([
    { signedIn: false, canOpenEditor: false, logoName: "Sign in to Markdoc", logoHref: "/login" },
    { signedIn: false, canOpenEditor: true, logoName: "Sign in to Markdoc", logoHref: "/login" },
    { signedIn: true, canOpenEditor: false, logoName: "All documents", logoHref: "/" },
    { signedIn: true, canOpenEditor: true, logoName: "All documents", logoHref: "/" },
  ])(
    "keeps the signedIn=$signedIn, canOpenEditor=$canOpenEditor header variant intact",
    ({ signedIn, canOpenEditor, logoName, logoHref }) => {
      renderReader({ signedIn, canOpenEditor });

      const header = screen.getByTestId("reader-header");
      const logo = within(header).getByRole("link", { name: logoName });
      expect(logo).toHaveAttribute("href", logoHref);
      expect(within(header).queryByTestId("open-in-editor")).toBe(canOpenEditor ? screen.getByTestId("open-in-editor") : null);
      if (canOpenEditor) expect(screen.getByTestId("open-in-editor")).toHaveAttribute("href", "/d/doc-3518");
      expect(within(header).getByTestId("reader-copy-link")).toBeInTheDocument();
      expect(within(header).getByTestId("reader-download")).toBeInTheDocument();
    },
  );

  it("links one escaped long title to the one existing article target in keyboard order", () => {
    const title = `<img src=x onerror="alert(1)"> & ${"a very long title ".repeat(20).trim()}`;
    renderReader({ title, signedIn: true, canOpenEditor: true });

    const header = screen.getByTestId("reader-header");
    const skip = screen.getByTestId("reader-skip-link");
    const logo = within(header).getByRole("link", { name: "All documents" });
    const titleLink = screen.getByTestId("reader-header-title");
    const article = screen.getByTestId("reader-article");

    expect(header).toHaveClass("h-14");
    expect(screen.getAllByTestId("reader-header")).toHaveLength(1);
    expect(titleLink.tagName).toBe("A");
    expect(titleLink).toHaveAttribute("href", "#reader-article");
    expect(titleLink).toHaveAttribute("title", title);
    expect(titleLink).toHaveAccessibleName(title);
    expect(titleLink.textContent).toBe(title);
    expect(titleLink.children).toHaveLength(0);
    expect(titleLink).toHaveClass("min-w-0", "flex-1", "truncate", "text-sm", "font-medium", "text-ink", "transition-colors", "hover:text-accent");
    expect(titleLink).not.toHaveClass("wrap-anywhere");
    expect(within(header).getAllByText(title, { exact: true })).toHaveLength(1);
    expect(header.querySelectorAll('a[href="#reader-article"]')).toHaveLength(1);
    expect(Object.keys(reactProps(titleLink)).filter((name) => /^on[A-Z]/.test(name))).toEqual([]);

    expect(skip).toHaveAttribute("href", "#reader-article");
    expect(document.querySelectorAll('[data-testid="reader-skip-link"][href="#reader-article"]')).toHaveLength(1);
    expect(document.querySelectorAll("#reader-article")).toHaveLength(1);
    expect(article).toHaveAttribute("tabindex", "-1");
    expect(precedes(skip, logo)).toBe(true);
    expect(precedes(logo, titleLink)).toBe(true);
    expect(Array.from(screen.getByTestId("reader").querySelectorAll<HTMLElement>("a, button, [tabindex]"))
      .filter((element) => element.tabIndex >= 0)).toEqual([
      skip, logo, titleLink, screen.getByTestId("open-in-editor"),
      screen.getByTestId("reader-copy-link"), screen.getByTestId("reader-download"),
      within(article).getByRole("link", { name: "Markdoc" }),
    ]);
  });

  it("keeps an empty title as a valid native link", () => {
    renderReader({ title: "" });

    const titleLink = screen.getByTestId("reader-header-title");
    expect(titleLink).toHaveAttribute("href", "#reader-article");
    expect(titleLink).toHaveAttribute("title", "");
    expect(titleLink).toHaveAccessibleName("");
    expect(titleLink).toHaveTextContent("");
  });
});

describe("ReaderPage article wrapping", () => {
  it.each([
    { label: "unbroken", title: "T".repeat(240), name: "N".repeat(240) },
    { label: "multiword", title: "A reader article with an ordinary multiword title", name: "Alex Morgan Rivera" },
  ])("preserves the complete $label title and author with wrapping metadata in order", ({ title, name }) => {
    renderReader({ title, owner: { name, image: "/avatar.png" }, readingMinutes: 7 });

    const article = screen.getByTestId("reader-article");
    const heading = within(article).getByRole("heading", { level: 1 });
    const byline = screen.getByTestId("reader-byline");
    const author = within(byline).getByText(name, { exact: true });
    const avatar = byline.firstElementChild;
    const time = within(byline).getByText(`Updated ${BASE_PROPS.updatedAt}`, { exact: true });
    const readingTime = within(byline).getByTestId("reader-reading-time");

    expect(article).toHaveClass("min-w-0", "flex-1");
    expect(article.querySelectorAll("h1")).toHaveLength(1);
    expect(heading.textContent).toBe(title);
    expect(heading).toHaveClass("wrap-anywhere");
    expect(byline).toHaveClass("flex", "min-w-0", "flex-wrap", "wrap-anywhere");
    expect(author.textContent).toBe(name);
    expect(author).toHaveClass("min-w-0", "font-medium", "text-ink-2");
    for (const element of [heading, byline, author]) {
      expect(element).not.toHaveClass("truncate");
      expect(element).not.toHaveClass("break-all");
      expect(element).not.toHaveClass("whitespace-nowrap");
      expect(element.querySelectorAll("a, button, [tabindex]")).toHaveLength(0);
      expect(Object.keys(reactProps(element)).filter((key) => /^on[A-Z]/.test(key))).toEqual([]);
    }
    expect(avatar).toHaveClass("avatar", "shrink-0");
    expect(avatar).toHaveStyle({ width: "22px", height: "22px" });
    expect(avatar).toHaveAttribute("title", name);
    const image = within(byline).getByRole("img", { name });
    expect(image).toHaveAttribute("src", "/avatar.png");
    expect(image).toHaveAttribute("width", "22");
    expect(image).toHaveAttribute("height", "22");
    expect(time).toHaveAttribute("datetime", BASE_PROPS.updatedAt);
    expect(readingTime.textContent).toBe("7 min read");
    expect(within(byline).getAllByTestId("reader-reading-time")).toHaveLength(1);
    expect(Array.from(byline.children)).toEqual([
      avatar, author, author.nextElementSibling, time, time.nextElementSibling, readingTime,
    ]);
    expect(Array.from(byline.querySelectorAll('[aria-hidden="true"]')).map((element) => element.textContent)).toEqual(["·", "·"]);
  });

  it.each([
    { hasOwner: false, readingMinutes: 0 },
    { hasOwner: false, readingMinutes: 3 },
    { hasOwner: true, readingMinutes: 0 },
    { hasOwner: true, readingMinutes: undefined },
  ])("omits only absent metadata with owner=$hasOwner and minutes=$readingMinutes", ({ hasOwner, readingMinutes }) => {
    renderReader({ owner: hasOwner ? { name: "Alex Rivera", image: null } : null, readingMinutes });

    const byline = screen.getByTestId("reader-byline");
    const hasReadingTime = (readingMinutes ?? 0) > 0;
    expect(Array.from(byline.children).map((element) => element.textContent)).toEqual([
      ...(hasOwner ? ["AR", "Alex Rivera", "·"] : []),
      `Updated ${BASE_PROPS.updatedAt}`,
      ...(hasReadingTime ? ["·", `${readingMinutes} min read`] : []),
    ]);
    expect(byline.querySelectorAll(".avatar")).toHaveLength(hasOwner ? 1 : 0);
    expect(within(byline).queryAllByTestId("reader-reading-time")).toHaveLength(hasReadingTime ? 1 : 0);
  });

  it("replaces labels literally without injected elements or render-time focus, click, or fetch work", () => {
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const click = vi.spyOn(HTMLElement.prototype, "click");
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const { rerender } = renderReader({ title: "Previous title", owner: { name: "Previous author", image: null }, readingMinutes: 4 });
    const title = `<img src=x onerror="alert(1)"> & ' " ${"T".repeat(220)}`;
    const name = `<svg onload="alert(1)"> & ' " ${"N".repeat(220)}`;
    const updatedAt = "2026-09-13T20:00:00.000Z";

    rerender(<ReaderPage {...BASE_PROPS} title={title} owner={{ name, image: null }} updatedAt={updatedAt} readingMinutes={9} />);

    const heading = screen.getByTestId("reader-title");
    const byline = screen.getByTestId("reader-byline");
    const author = within(byline).getByText(name, { exact: true });
    expect(heading.textContent).toBe(title);
    expect(heading.children).toHaveLength(0);
    expect(author.textContent).toBe(name);
    expect(author.children).toHaveLength(0);
    expect(byline.querySelectorAll("svg, img, script")).toHaveLength(0);
    expect(screen.getByTestId("reader-header-title")).toHaveAttribute("title", title);
    expect(within(byline).getByText(`Updated ${updatedAt}`, { exact: true })).toHaveAttribute("datetime", updatedAt);
    expect(within(byline).getAllByText("9 min read", { exact: true })).toHaveLength(1);
    for (const oldLabel of ["Previous title", "Previous author", `Updated ${BASE_PROPS.updatedAt}`, "4 min read"]) {
      expect(screen.queryByText(oldLabel, { exact: true })).not.toBeInTheDocument();
    }

    rerender(<ReaderPage {...BASE_PROPS} title={title} updatedAt={updatedAt} readingMinutes={0} />);
    expect(Array.from(byline.children).map((element) => element.textContent)).toEqual([`Updated ${updatedAt}`]);
    expect(focus).not.toHaveBeenCalled();
    expect(click).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    { title: "Body title", hidden: true },
    { title: "A different article title", hidden: false },
  ])("preserves body HTML and the existing first-heading de-duplication flag ($hidden)", ({ title, hidden }) => {
    const html = '<h1 id="body-title">Body title</h1><p>Safe <strong>body</strong></p>';
    renderReader({ title, html, headings: [{ id: "body-title", text: "Body title", level: 1 }] });

    const body = screen.getByTestId("reader-body");
    expect(body.innerHTML).toBe(html);
    expect(body.getAttribute("data-hide-first-h1")).toBe(hidden ? "true" : null);
    expect(body).toHaveAttribute("data-reader-overflow-root");
    expect(screen.getByTestId("reader-title").textContent).toBe(title);
    expect(screen.getByTestId("reader-article")).toHaveAttribute("id", "reader-article");
    expect(screen.getByTestId("reader-article")).toHaveAttribute("tabindex", "-1");
    expect(screen.getByTestId("reader-skip-link")).toHaveAttribute("href", "#reader-article");
  });

  it("compiles the installed wrapping and flex utilities to their CSS declarations", async () => {
    const theme = readFileSync(createRequire(import.meta.url).resolve("tailwindcss/theme.css"), "utf8");
    const { build } = await compile(`${theme}\n@tailwind utilities;`);
    const css = build(["wrap-anywhere", "flex-wrap", "min-w-0", "shrink-0"]);

    expect(css).toMatch(/\.wrap-anywhere\s*\{\s*overflow-wrap:\s*anywhere;\s*\}/);
    expect(css).toMatch(/\.flex-wrap\s*\{\s*flex-wrap:\s*wrap;\s*\}/);
    expect(css).toMatch(/\.min-w-0\s*\{\s*min-width:\s*0px;\s*\}/);
    expect(css).toMatch(/\.shrink-0\s*\{\s*flex-shrink:\s*0;\s*\}/);
  });
});
