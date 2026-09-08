// @vitest-environment jsdom
import type { ComponentProps } from "react";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/link", () => ({
  default: ({ children, ...props }: ComponentProps<"a">) => <a {...props}>{children}</a>,
}));
vi.mock("@/components/ui/relative-time", () => ({
  RelativeTime: () => <time>Updated</time>,
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

afterEach(cleanup);

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
    expect(titleLink.tagName).toBe("A");
    expect(titleLink).toHaveAttribute("href", "#reader-article");
    expect(titleLink).toHaveAttribute("title", title);
    expect(titleLink).toHaveAccessibleName(title);
    expect(titleLink.textContent).toBe(title);
    expect(titleLink.children).toHaveLength(0);
    expect(titleLink).toHaveClass("min-w-0", "flex-1", "truncate", "text-sm", "font-medium", "text-ink", "transition-colors", "hover:text-accent");
    expect(within(header).getAllByText(title, { exact: true })).toHaveLength(1);
    expect(header.querySelectorAll('a[href="#reader-article"]')).toHaveLength(1);
    expect(Object.keys(reactProps(titleLink)).filter((name) => /^on[A-Z]/.test(name))).toEqual([]);

    expect(skip).toHaveAttribute("href", "#reader-article");
    expect(document.querySelectorAll('[data-testid="reader-skip-link"][href="#reader-article"]')).toHaveLength(1);
    expect(document.querySelectorAll("#reader-article")).toHaveLength(1);
    expect(article).toHaveAttribute("tabindex", "-1");
    expect(precedes(skip, logo)).toBe(true);
    expect(precedes(logo, titleLink)).toBe(true);
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
