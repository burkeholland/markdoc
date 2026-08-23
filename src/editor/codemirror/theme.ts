import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { EditorView } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";

// Every colour is a CSS variable declared in globals.css (`:root` and `[data-theme="dark"]`), so
// the editor follows the app theme with no extension reconfiguration.
const ACCENT = "var(--color-accent)";

export const markdownHighlightStyle = HighlightStyle.define([
  { tag: [t.heading, t.heading1, t.heading2, t.heading3, t.heading4, t.heading5, t.heading6], color: ACCENT, fontWeight: "700" },
  { tag: t.link, color: ACCENT },
  { tag: t.url, color: ACCENT, textDecoration: "underline", textDecorationColor: "var(--cm-url-underline)" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strong, fontWeight: "700", color: "var(--cm-strong)" },
  { tag: t.strikethrough, textDecoration: "line-through", color: "var(--cm-muted)" },
  { tag: t.monospace, color: "var(--cm-code)" },
  { tag: t.quote, color: "var(--cm-muted)" },
  { tag: t.processingInstruction, color: "var(--cm-faint)" },
  { tag: t.labelName, color: "var(--cm-label)" },
  { tag: t.contentSeparator, color: "var(--cm-faint)" },
  { tag: t.atom, color: ACCENT },
  { tag: t.escape, color: "var(--cm-faint)" },
  { tag: [t.angleBracket, t.tagName], color: "var(--cm-tag)" },
  // code inside fences
  { tag: [t.keyword, t.modifier, t.operatorKeyword, t.controlKeyword, t.definitionKeyword], color: "var(--cm-keyword)" },
  { tag: [t.string, t.special(t.string), t.regexp], color: "var(--cm-string)" },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.definition(t.variableName)], color: "var(--cm-function)" },
  { tag: [t.variableName, t.propertyName, t.attributeName], color: "var(--cm-variable)" },
  { tag: [t.number, t.bool, t.null], color: "var(--cm-number)" },
  { tag: [t.comment, t.lineComment, t.blockComment], color: "var(--cm-muted)", fontStyle: "italic" },
  { tag: [t.typeName, t.className, t.namespace], color: "var(--cm-tag)" },
  { tag: [t.operator, t.punctuation, t.bracket], color: "var(--cm-punct)" },
  { tag: t.invalid, color: "var(--cm-label)" },
]);

export const editorTheme = EditorView.theme({
  "&": { color: "var(--cm-ink)", backgroundColor: "var(--color-surface)" },
  ".cm-content": { fontFamily: "var(--font-mono)" },
  ".cm-placeholder": { color: "var(--color-ink-4)", fontStyle: "normal" },
  ".cm-tooltip": {
    border: "1px solid var(--color-line)",
    borderRadius: "10px",
    backgroundColor: "var(--color-surface)",
    color: "var(--color-ink)",
    boxShadow: "var(--cm-tooltip-shadow)",
    fontFamily: "var(--font-sans)",
    fontSize: "13px",
  },
  ".cm-tooltip-autocomplete ul li[aria-selected]": { backgroundColor: "var(--color-surface-3)", color: "var(--color-ink)" },
  ".cm-panels": { backgroundColor: "var(--color-surface-2)", color: "var(--color-ink)", borderBottom: "1px solid var(--color-line)", fontFamily: "var(--font-sans)", fontSize: "13px" },
  ".cm-panel.cm-search input, .cm-panel.cm-search button": {
    fontFamily: "var(--font-sans)",
    borderRadius: "6px",
    border: "1px solid var(--color-line-2)",
    backgroundColor: "var(--color-surface)",
    color: "var(--color-ink)",
    padding: "2px 6px",
    margin: "2px",
  },
  ".cm-searchMatch": { backgroundColor: "var(--cm-search)" },
  ".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: "var(--cm-search-selected)" },
  ".cm-foldPlaceholder": { backgroundColor: "var(--color-surface-3)", border: "none", color: "var(--color-ink-3)" },
});

export const codeEditorTheme = [editorTheme, syntaxHighlighting(markdownHighlightStyle)];