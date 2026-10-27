// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import {
  createElement,
  type ComponentType,
  type ReactNode,
} from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { compile } from "tailwindcss";

import AppError from "./error";
import GlobalError from "./global-error";

type BoundaryError = Error & { digest?: string };
interface BoundaryProps {
  error: BoundaryError;
  reset: () => void;
}

interface BoundaryDefinition {
  readonly name: string;
  readonly Component: ComponentType<BoundaryProps>;
}

interface DirectView {
  readonly host: HTMLDivElement;
  readonly root: Root;
}

const BOUNDARIES: readonly BoundaryDefinition[] = [
  { name: "AppError", Component: AppError },
  { name: "GlobalError", Component: GlobalError },
];

const directViews: DirectView[] = [];

function captureRetry(host: HTMLElement) {
  const button = [...host.querySelectorAll("button")].find((candidate) => candidate.textContent?.trim() === "Try again");
  const actions = button?.parentElement;
  if (!(button instanceof HTMLButtonElement) || !(actions instanceof HTMLDivElement)) {
    throw new Error("The Retry action was not rendered");
  }
  return { actions, button };
}

function renderDirect(node: ReactNode): DirectView {
  const host = document.createElement("div");
  document.body.append(host);
  const view = { host, root: createRoot(host) };
  directViews.push(view);
  act(() => view.root.render(node));
  return view;
}

function boundaryNode(
  definition: BoundaryDefinition,
  props: BoundaryProps,
  key?: string,
) {
  return createElement(definition.Component, { ...props, key });
}

afterEach(() => {
  cleanup();
  for (const view of directViews.splice(0)) {
    act(() => view.root.unmount());
    view.host.remove();
  }
  vi.restoreAllMocks();
});

describe("error boundary presentation", () => {
  it("renders the route boundary copy, actions, and error details", () => {
    render(
      <AppError
        error={Object.assign(new Error("boom"), { digest: "abc123" })}
        reset={() => {}}
      />,
    );
    expect(screen.getByTestId("app-error")).toBeInTheDocument();
    expect(screen.getByText("Error")).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { level: 1, name: "Something went wrong" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toHaveAttribute("type", "button");
    expect(screen.getByRole("link", { name: "Back to your documents" })).toHaveAttribute("href", "/");
    expect(screen.getByTestId("app-error-digest")).toHaveTextContent("Reference: abc123");
    expect(screen.getByTestId("app-error").querySelector("pre")).toHaveTextContent("boom");
  });

  it("omits empty route-boundary error facts without changing the Details affordance", () => {
    render(<AppError error={new Error("")} reset={() => {}} />);
    expect(screen.queryByTestId("app-error-digest")).toBeNull();
    expect(screen.getByTestId("app-error").querySelector("pre")).toBeNull();
    expect(screen.getByText("Details")).toBeInTheDocument();
  });

  it("renders the root-layout boundary as a self-styled whole document", () => {
    const html = renderToStaticMarkup(
      <GlobalError
        error={Object.assign(new Error("boom"), { digest: "abc123" })}
        reset={() => {}}
      />,
    );
    expect(html).toContain('<html lang="en">');
    expect(html).toContain("Something went wrong");
    expect(html).toContain('data-testid="app-error"');
    expect(html).toMatch(/<button type="button"[^>]*>Try again<\/button>/);
    expect(html).toMatch(/<a href="\/"[^>]*>Back to your documents<\/a>/);
    expect(html).toContain("Reference: abc123");
    expect(html).toContain("boom");
    expect(html).toContain("prefers-color-scheme: dark");
    expect(html).not.toContain("class=");
  });
});

describe.each(BOUNDARIES)("$name bounded details", (definition) => {
  it.each([
    { name: "ordinary", digest: "abc123", message: "Could not load this document." },
    { name: "unbroken", digest: "d".repeat(320), message: "m".repeat(320) },
    { name: "multiline", digest: "  first\t reference\nsecond  ", message: "\n  first\tline\n\nsecond  \n" },
    { name: "literal HTML", digest: '<a href="/">reference</a>', message: '<button autofocus>retry</button><br><script>throw 1</script>&amp;' },
  ])("preserves exact $name text in the native disclosure without new elements or tabstops", ({ digest, message }) => {
    const reset = vi.fn();
    const view = renderDirect(boundaryNode(definition, {
      error: Object.assign(new Error(message), { digest }),
      reset,
    }));
    const details = view.host.querySelector("details");
    const summary = details?.querySelector("summary");
    if (!details || !summary) throw new Error("The native disclosure was not rendered");

    expect(details.open).toBe(false);
    expect(details.hasAttribute("open")).toBe(false);
    expect(summary.textContent).toBe("Details");
    expect([...details.querySelectorAll("*")].map((element) => element.tagName)).toEqual(["SUMMARY", "P", "PRE"]);
    expect(details.querySelector("p")?.textContent).toBe(`Reference: ${digest}`);
    expect(details.querySelector("pre")?.textContent).toBe(message);
    expect(details.querySelector("[title], [tabindex], a, button, input, [contenteditable]")).toBeNull();

    const current = captureRetry(view.host);
    const actionMarkup = current.actions.outerHTML;
    fireEvent.click(summary);
    expect(details.open).toBe(true);
    expect(current.actions.outerHTML).toBe(actionMarkup);
    expect(reset).not.toHaveBeenCalled();
    fireEvent.click(summary);
    expect(details.open).toBe(false);
    fireEvent.click(current.button);
    expect(reset).toHaveBeenCalledOnce();
  });

  it.each([
    { name: "digest only", digest: "reference", message: "" },
    { name: "message only", digest: undefined, message: "message" },
    { name: "message with empty digest", digest: "", message: "message" },
    { name: "both", digest: "reference", message: "message" },
    { name: "neither", digest: undefined, message: "" },
    { name: "empty fields", digest: "", message: "" },
  ])("retains the omission rules and surrounding tree for $name", ({ digest, message }) => {
    const parse = (error: BoundaryError) => new DOMParser().parseFromString(
      renderToStaticMarkup(boundaryNode(definition, { error, reset: () => {} })),
      "text/html",
    );
    const empty = parse(new Error(""));
    const populated = parse(Object.assign(new Error(message), { digest }));
    const details = populated.querySelector("details");
    if (!details) throw new Error("The native disclosure was not rendered");
    expect(details.open).toBe(false);
    expect([...details.children].map((element) => element.tagName)).toEqual([
      "SUMMARY", ...(digest ? ["P"] : []), ...(message ? ["PRE"] : []),
    ]);
    expect(details.querySelector("p")?.textContent).toBe(digest ? `Reference: ${digest}` : undefined);
    expect(details.querySelector("pre")?.textContent).toBe(message || undefined);
    details.querySelector("p")?.remove();
    details.querySelector("pre")?.remove();
    expect(populated.documentElement.outerHTML).toBe(empty.documentElement.outerHTML);
  });

  it("replaces and removes facts on the same instance and retries with the latest reset", () => {
    const resetA = vi.fn();
    const resetB = vi.fn();
    const error: BoundaryError = Object.assign(new Error("old-message".repeat(32)), { digest: "old-reference".repeat(32) });
    const view = renderDirect(boundaryNode(definition, { error, reset: resetA }));
    const details = view.host.querySelector("details");
    const summary = details?.querySelector("summary");
    if (!details || !summary) throw new Error("The native disclosure was not rendered");
    fireEvent.click(summary);

    const replacement = { digest: " new-reference\n", message: "\nnew-message  " };
    Object.assign(error, replacement);
    act(() => view.root.render(boundaryNode(definition, { error, reset: resetB })));
    expect(view.host.querySelector("details")).toBe(details);
    expect(details.open).toBe(true);
    expect(details.querySelector("p")?.textContent).toBe(`Reference: ${replacement.digest}`);
    expect(details.querySelector("pre")?.textContent).toBe(replacement.message);
    expect(view.host.textContent).not.toContain("old-message");
    expect(view.host.textContent).not.toContain("old-reference");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(resetA).not.toHaveBeenCalled();
    expect(resetB).toHaveBeenCalledOnce();

    error.message = "";
    delete error.digest;
    act(() => view.root.render(boundaryNode(definition, { error, reset: resetB })));
    expect(details.children).toHaveLength(1);
    expect(details.firstElementChild).toBe(summary);
    expect(details.open).toBe(true);
  });

  it("keeps passive detail inspection free of application scheduling, network, and focus effects", () => {
    const reset = vi.fn();
    const view = renderDirect(boundaryNode(definition, {
      error: Object.assign(new Error("message".repeat(40)), { digest: "reference".repeat(40) }),
      reset,
    }));
    const details = view.host.querySelector("details");
    const summary = details?.querySelector("summary");
    if (!details || !summary) throw new Error("The native disclosure was not rendered");
    // Open first: the browser itself schedules the native details toggle notification.
    fireEvent.click(summary);
    const activeElement = document.activeElement;
    const markup = view.host.innerHTML;
    const effects = [
      vi.spyOn(globalThis, "setTimeout"),
      vi.spyOn(globalThis, "setInterval"),
      vi.spyOn(globalThis, "queueMicrotask"),
      vi.spyOn(window, "requestAnimationFrame"),
      vi.spyOn(globalThis, "fetch"),
      vi.spyOn(XMLHttpRequest.prototype, "send"),
      vi.spyOn(HTMLElement.prototype, "focus"),
    ];

    fireEvent(details, new Event("toggle"));
    fireEvent.mouseOver(summary);
    fireEvent.mouseOver(details.querySelector("pre")!);
    fireEvent.mouseOut(details);
    expect(document.activeElement).toBe(activeElement);
    expect(view.host.innerHTML).toBe(markup);
    expect(reset).not.toHaveBeenCalled();
    for (const effect of effects) expect(effect).not.toHaveBeenCalled();

    const link = view.host.querySelector("a");
    if (!link) throw new Error("The recovery link was not rendered");
    expect(link.getAttribute("href")).toBe("/");
    expect(link.hasAttribute("target")).toBe(false);
  });
});

describe("bounded details styling", () => {
  it("uses installed Tailwind declarations for the route width bound and unbroken text wrapping", async () => {
    render(<AppError error={Object.assign(new Error("m".repeat(320)), { digest: "d".repeat(320) })} reset={() => {}} />);
    const main = screen.getByTestId("app-error");
    const details = main.querySelector("details");
    expect(main).toHaveAttribute("class", "flex min-h-screen flex-col items-center justify-center bg-surface-2 px-4 py-4 text-center");
    expect(details).toHaveAttribute("class", "mt-6 w-full max-w-sm text-left text-xs text-ink-3");
    expect(details?.querySelector("p")).toHaveAttribute("class", "wrap-anywhere");
    expect(details?.querySelector("pre")).toHaveAttribute("class", "mt-1 whitespace-pre-wrap wrap-anywhere");
    expect(screen.getByRole("button", { name: "Try again" })).toHaveAttribute("class", "btn btn-primary max-sm:h-10");
    expect(screen.getByRole("link", { name: "Back to your documents" })).toHaveAttribute("class", "btn btn-ghost max-sm:h-10");

    const theme = readFileSync(createRequire(import.meta.url).resolve("tailwindcss/theme.css"), "utf8");
    const { build } = await compile(`${theme}\n@tailwind utilities;`);
    const css = build(["w-full", "max-w-sm", "wrap-anywhere", "whitespace-pre-wrap"]);
    expect(css).toMatch(/\.w-full\s*\{\s*width:\s*100%;\s*\}/);
    expect(css).toMatch(/\.max-w-sm\s*\{\s*max-width:\s*var\(--container-sm\);\s*\}/);
    expect(css).toMatch(/\.wrap-anywhere\s*\{\s*overflow-wrap:\s*anywhere;\s*\}/);
    expect(css).toMatch(/\.whitespace-pre-wrap\s*\{\s*white-space:\s*pre-wrap;\s*\}/);
  });

  it("bounds the standalone document with inline wrapping, preserving its palette and outer layout", () => {
    const html = renderToStaticMarkup(
      <GlobalError error={Object.assign(new Error("m".repeat(320)), { digest: "d".repeat(320) })} reset={() => {}} />,
    );
    const doc = new DOMParser().parseFromString(html, "text/html");
    expect(doc.documentElement.lang).toBe("en");
    expect(doc.body.getAttribute("style")).toBe('margin:0;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:1rem;background:var(--bg);color:var(--ink);text-align:center;font-family:ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif');
    expect(doc.querySelector("main")?.getAttribute("style")).toBe("width:100%;max-width:28rem");
    expect(doc.querySelector("details")?.getAttribute("style")).toBe("width:100%;overflow-wrap:anywhere;margin-top:1.5rem;font-size:0.75rem;text-align:left;color:var(--ink-3)");
    expect(doc.querySelector("pre")?.getAttribute("style")).toBe("margin:0.25rem 0 0;white-space:pre-wrap;overflow-wrap:anywhere;font-family:ui-monospace, SFMono-Regular, Menlo, monospace");
    expect(doc.querySelector("details > p")?.hasAttribute("style")).toBe(false);
    expect(doc.querySelectorAll("style")).toHaveLength(1);
    expect(doc.querySelector("style")?.textContent).toBe(`:root { --bg: #f7f5f0; --ink: #1c1917; --ink-2: #44403c; --ink-3: #57534e; --accent: #0f766e; --on-accent: #ffffff; }
@media (prefers-color-scheme: dark) {
  :root { --bg: #1c1f24; --ink: #e7e5e4; --ink-2: #d6d3d1; --ink-3: #a8a29e; --accent: #2dd4bf; --on-accent: #14161a; }
}`);
    expect(doc.querySelector("[class], link, script")).toBeNull();
  });
});
