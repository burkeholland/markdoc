import { fromMarkdown } from "mdast-util-from-markdown";
import { frontmatterFromMarkdown } from "mdast-util-frontmatter";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { frontmatter } from "micromark-extension-frontmatter";
import { gfm } from "micromark-extension-gfm";
import type * as Md from "mdast";

const CLOSED_FRONTMATTER = /^---[ \t]*\r?\n(?:[\s\S]*?\r?\n)?---[ \t]*(?:\r?\n|$)/;

/** Opening `---` on the first line and a closing `---` line somewhere after it. */
export function hasFrontmatter(src: string): boolean {
  return src.startsWith("---") && CLOSED_FRONTMATTER.test(src);
}

export function parseMdast(src: string): Md.Root {
  if (hasFrontmatter(src)) {
    return fromMarkdown(src, {
      extensions: [gfm(), frontmatter(["yaml"])],
      mdastExtensions: [gfmFromMarkdown(), frontmatterFromMarkdown(["yaml"])],
    });
  }
  return fromMarkdown(src, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
}

function nodeText(node: Md.RootContent | Md.PhrasingContent): string {
  switch (node.type) {
    case "text":
    case "inlineCode":
    case "code":
      return node.value;
    case "image":
    case "imageReference":
      return node.alt ?? "";
    case "html":
      return node.value.replace(/<[^>]*>/g, " ");
    case "break":
      return " ";
    case "paragraph":
    case "heading":
    case "emphasis":
    case "strong":
    case "delete":
    case "link":
    case "linkReference":
    case "tableCell":
      return node.children.map(nodeText).join("");
    default:
      return "children" in node ? node.children.map(nodeText).join(" ") : "";
  }
}

export function plainTextFromMarkdown(src: string): string {
  return parseMdast(src).children.map(nodeText).join(" ").replace(/\s+/g, " ").trim();
}
