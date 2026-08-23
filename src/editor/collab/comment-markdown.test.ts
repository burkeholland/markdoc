import { describe, expect, it } from "vitest";
import { createElement, Fragment } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parseCommentBody, parseInline, renderCommentBody, wrapLink, wrapSelection } from "./comment-markdown";

const html = (body: string) => renderToStaticMarkup(createElement(Fragment, null, renderCommentBody(body)));

describe("renderCommentBody", () => {
  it("renders bold, italic and code", () => {
    const out = html("a **bold** and *italic* and `code` word");
    expect(out).toContain("<strong>bold</strong>");
    expect(out).toContain("<em>italic</em>");
    expect(out).toContain('<code class="comment-code">code</code>');
    expect(out).toMatch(/^<p class="comment-paragraph">a /);
  });

  it("renders links with target=_blank and rel=noopener", () => {
    const out = html("see [the docs](https://example.com/a?b=1)");
    expect(out).toContain('href="https://example.com/a?b=1"');
    expect(out).toContain('target="_blank"');
    expect(out).toContain('rel="noopener noreferrer"');
    expect(out).toContain(">the docs</a>");
    expect(html("[mail me](mailto:a@b.co)")).toContain('href="mailto:a@b.co"');
  });

  it("auto-links bare URLs and leaves trailing punctuation out", () => {
    const out = html("look at https://example.com/path. ok");
    expect(out).toContain('<a href="https://example.com/path"');
    expect(out).toContain("</a>. ok");
    expect(html("(https://x.y/z)")).toContain('href="https://x.y/z"');
    expect(html("https://en.wikipedia.org/wiki/Foo_(bar)")).toContain('href="https://en.wikipedia.org/wiki/Foo_(bar)"');
  });

  it("chips mentions, also inside bold, but not e-mail addresses", () => {
    const out = html("hey **@alice** and *@bob-2*, not mail@bob.example");
    expect(out).toContain('<strong><span class="mention-chip rounded bg-accent-soft px-1 font-medium text-accent" title="alice" data-testid="mention-chip">@alice</span></strong>');
    expect(out).toContain('title="bob-2"');
    expect(out).not.toContain('title="bob.example"');
    expect(out).toContain("mail@bob.example");
  });

  it("escapes HTML and drops unsafe link schemes", () => {
    const out = html("<script>alert(1)</script> [x](javascript:alert(1)) [y](data:text/html,hi) <b>no</b>");
    expect(out).not.toContain("<script>");
    expect(out).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(out).not.toContain("<a ");
    expect(out).not.toContain("javascript:");
    expect(out).toContain("x"); // the label survives as text
    expect(out).toContain("&lt;b&gt;no&lt;/b&gt;");
  });

  it("does not render headings, lists or images", () => {
    const out = html("# Title\n- item\n![img](https://x.y/i.png)");
    expect(out).toContain("# Title");
    expect(out).toContain("- item");
    expect(out).not.toContain("<img");
    expect(out).not.toContain("<h1");
    expect(out).not.toContain("<li");
    // The image syntax is `!` followed by a regular link, which is still just a link.
    expect(out).toContain('!<a href="https://x.y/i.png"');
  });

  it("turns single newlines into <br> and blank lines into paragraphs", () => {
    const out = html("line one\nline two\n\nsecond para\r\n\r\nthird");
    expect(out).toBe('<p class="comment-paragraph">line one<br/>line two</p><p class="comment-paragraph">second para</p><p class="comment-paragraph">third</p>');
  });

  it("treats unbalanced markers and escapes as literal text", () => {
    expect(html("2 * 3 * 4")).toContain("2 * 3 * 4");
    expect(html("**unclosed")).toContain("**unclosed");
    expect(html("a \\*not italic\\*")).toContain("a *not italic*");
    expect(html("``")).toContain("``");
    expect(renderCommentBody("")).toBeNull();
  });

  it("exposes the parsed tree", () => {
    expect(parseInline("**b** c")).toEqual([{ type: "strong", children: [{ type: "text", value: "b" }] }, { type: "text", value: " c" }]);
    expect(parseCommentBody("a\n\nb")).toHaveLength(2);
  });
});

describe("composer shortcuts", () => {
  it("wraps the selection and places the selection inside the markers", () => {
    expect(wrapSelection("hello world", 6, 11, "**")).toEqual({ value: "hello **world**", selectionStart: 8, selectionEnd: 13 });
    expect(wrapSelection("hello", 5, 5, "*")).toEqual({ value: "hello**", selectionStart: 6, selectionEnd: 6 });
    expect(wrapSelection("ab", 2, 0, "`")).toEqual({ value: "`ab`", selectionStart: 1, selectionEnd: 3 });
  });

  it("unwraps when the selection is already wrapped", () => {
    expect(wrapSelection("hello **world**", 8, 13, "**")).toEqual({ value: "hello world", selectionStart: 6, selectionEnd: 11 });
    expect(wrapSelection("hello **world**", 6, 15, "**")).toEqual({ value: "hello world", selectionStart: 6, selectionEnd: 11 });
  });

  it("wraps as a link with the caret inside the parentheses", () => {
    expect(wrapLink("see docs", 4, 8)).toEqual({ value: "see [docs]()", selectionStart: 11, selectionEnd: 11 });
    expect(wrapLink("", 0, 0)).toEqual({ value: "[]()", selectionStart: 3, selectionEnd: 3 });
  });
});
