import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { EditorView } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";

const ACCENT = "#2563eb";

export const markdownHighlightStyle = HighlightStyle.define([
  { tag: [t.heading, t.heading1, t.heading2, t.heading3, t.heading4, t.heading5, t.heading6], color: ACCENT, fontWeight: "700" },
  { tag: t.link, color: ACCENT },
  { tag: t.url, color: ACCENT, textDecoration: "underline", textDecorationColor: "#93c5fd" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strong, fontWeight: "700", color: "#111827" },
  { tag: t.strikethrough, textDecoration: "line-through", color: "#6b7280" },
  { tag: t.monospace, color: "#be185d" },
  { tag: t.quote, color: "#6b7280" },
  { tag: t.processingInstruction, color: "#9ca3af" },
  { tag: t.labelName, color: "#dc2626" },
  { tag: t.contentSeparator, color: "#9ca3af" },
  { tag: t.atom, color: ACCENT },
  { tag: t.escape, color: "#9ca3af" },
  { tag: [t.angleBracket, t.tagName], color: "#0891b2" },
  // code inside fences
  { tag: [t.keyword, t.modifier, t.operatorKeyword, t.controlKeyword, t.definitionKeyword], color: "#7c3aed" },
  { tag: [t.string, t.special(t.string), t.regexp], color: "#16a34a" },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.definition(t.variableName)], color: "#2563eb" },
  { tag: [t.variableName, t.propertyName, t.attributeName], color: "#b45309" },
  { tag: [t.number, t.bool, t.null], color: "#ea580c" },
  { tag: [t.comment, t.lineComment, t.blockComment], color: "#9ca3af", fontStyle: "italic" },
  { tag: [t.typeName, t.className, t.namespace], color: "#0891b2" },
  { tag: [t.operator, t.punctuation, t.bracket], color: "#374151" },
  { tag: t.invalid, color: "#dc2626" },
]);

export const editorTheme = EditorView.theme({
  "&": { color: "#1f2937", backgroundColor: "#ffffff" },
  ".cm-content": { fontFamily: "var(--font-mono)" },
  ".cm-placeholder": { color: "#9ca3af", fontStyle: "normal" },
  ".cm-tooltip": {
    border: "1px solid #e5e7eb",
    borderRadius: "10px",
    backgroundColor: "#ffffff",
    boxShadow: "0 10px 30px rgba(0,0,0,0.12)",
    fontFamily: "var(--font-sans)",
    fontSize: "13px",
  },
  ".cm-panels": { backgroundColor: "#f9fafb", borderBottom: "1px solid #e5e7eb", fontFamily: "var(--font-sans)", fontSize: "13px" },
  ".cm-panel.cm-search input, .cm-panel.cm-search button": {
    fontFamily: "var(--font-sans)",
    borderRadius: "6px",
    border: "1px solid #d1d5db",
    padding: "2px 6px",
    margin: "2px",
  },
  ".cm-searchMatch": { backgroundColor: "#fde68a" },
  ".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: "#fbbf24" },
  ".cm-foldPlaceholder": { backgroundColor: "#f3f4f6", border: "none", color: "#6b7280" },
});

export const codeEditorTheme = [editorTheme, syntaxHighlighting(markdownHighlightStyle)];
