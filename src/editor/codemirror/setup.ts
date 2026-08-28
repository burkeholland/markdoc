import { Compartment, EditorState, type Extension } from "@codemirror/state";
import {
  EditorView,
  drawSelection,
  dropCursor,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
  placeholder,
  rectangularSelection,
  crosshairCursor,
} from "@codemirror/view";
import { defaultKeymap, indentWithTab } from "@codemirror/commands";
import { bracketMatching, indentOnInput } from "@codemirror/language";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { highlightSelectionMatches } from "@codemirror/search";
import { yCollab } from "y-codemirror.next";
import type { CollabSession } from "../collab/session";
import { codeEditorTheme } from "./theme";
import { sourceHighlights, highlightClickHandler } from "./highlights";
import { suggestingMode } from "./suggesting";
import { toggleInlineMark, setHeading, toggleLinePrefix } from "./commands";
import { codeImageUpload } from "./images";
import { codePasteGuard } from "./paste-guard";
import { pathologicalParagraphs } from "./pathological";
import { codeMarkdownFileDrop } from "./file-drop";
import type { MarkdownFileDropHandler } from "../prosemirror/file-drop";
import { createMarkdownEditingKeymap } from "./continue-markup";
import { markdownTyping } from "./markdown-typing";
import { remoteCaretInteractions } from "./remote-cursors";
import type { ImageUploader } from "../prosemirror/images";
import type { NoticeAction } from "../markdown/tsv";
import { preserveInactiveUndoScroll } from "./undo-scroll";

export interface CodeEditorHandlers {
  onFocus?: () => void;
  onSelection?: (head: number, anchor: number) => void;
  onHighlightClick?: (kind: string, id: string | null) => void;
  /** Uploads a pasted or dropped image file; when absent, image files are left to the browser. */
  uploadImage?: ImageUploader;
  onImageError?: (message: string) => void;
  /** Non-blocking notice for the user (a toast), e.g. when pasted text had to be inserted as code. */
  onNotice?: (message: string, action?: NoticeAction) => void;
  /** A dropped .md/.txt file with the source offset under the pointer. */
  onMarkdownFileDrop?: MarkdownFileDropHandler;
}

export interface CodeEditorSetup {
  extensions: Extension;
  /** Reconfigure read-only / suggesting mode at runtime. */
  setMode: (view: EditorView, canEdit: boolean, suggesting: boolean) => void;
  setLineWrapping: (view: EditorView, wrap: boolean) => void;
}

export function createCodeEditorSetup(session: CollabSession, handlers: CodeEditorHandlers = {}): CodeEditorSetup {
  const editable = new Compartment();
  const suggesting = new Compartment();
  const wrapping = new Compartment();

  const formattingKeymap = keymap.of([
    { key: "Mod-b", run: toggleInlineMark("**") },
    { key: "Mod-i", run: toggleInlineMark("*") },
    { key: "Mod-`", run: toggleInlineMark("`") },
    { key: "Mod-Shift-x", run: toggleInlineMark("~~") },
    { key: "Mod-Shift-7", run: toggleLinePrefix("ordered") },
    { key: "Mod-Shift-8", run: toggleLinePrefix("bullet") },
    { key: "Mod-Shift-9", run: toggleLinePrefix("task") },
    { key: "Mod-Shift-.", run: toggleLinePrefix("quote") },
    { key: "Mod-Alt-0", run: setHeading(0) },
    { key: "Mod-Alt-1", run: setHeading(1) },
    { key: "Mod-Alt-2", run: setHeading(2) },
    { key: "Mod-Alt-3", run: setHeading(3) },
    { key: "Mod-Alt-4", run: setHeading(4) },
    { key: "Mod-Alt-5", run: setHeading(5) },
    { key: "Mod-Alt-6", run: setHeading(6) },
  ]);
  const undo = () => {
    session.undo();
    return true;
  };
  const redo = () => {
    session.redo();
    return true;
  };
  const historyKeymap = [
    { key: "Mod-z", run: undo, preventDefault: true },
    { key: "Mod-y", mac: "Mod-Shift-z", run: redo, preventDefault: true },
    { key: "Mod-Shift-z", run: redo, preventDefault: true },
  ];

  const extensions: Extension = [
    lineNumbers(),
    highlightActiveLineGutter(),
    highlightActiveLine(),
    drawSelection(),
    dropCursor(),
    rectangularSelection(),
    crosshairCursor(),
    indentOnInput(),
    bracketMatching(),
    // Pairs ( [ { and quotes; markdownTyping scopes the list to Markdown (no backtick pairing),
    // opens fences on ```, wraps selections with * _ ` [ and indents list items with Tab.
    closeBrackets(),
    markdownTyping(),
    highlightSelectionMatches(),
    placeholder("Start writing Markdown…"),
    // Enter/Backspace come from markdownEditingKeymap (Enter on an empty `> ` or `- ` line exits the block).
    // pathologicalParagraphs keeps the #115 bracket soup out of the inline parser (seconds per keystroke otherwise).
    markdown({ base: markdownLanguage, codeLanguages: languages, addKeymap: false, extensions: [pathologicalParagraphs] }),
    createMarkdownEditingKeymap(() => session.undoManager.stopCapturing()),
    codeEditorTheme,
    wrapping.of(EditorView.lineWrapping),
    preserveInactiveUndoScroll(() => session.activeSurface === "code"),
    yCollab(session.ytext, session.awareness, { undoManager: session.undoManager }),
    remoteCaretInteractions(session),
    sourceHighlights(),
    highlightClickHandler((kind, id) => handlers.onHighlightClick?.(kind, id)),
    editable.of([EditorState.readOnly.of(!session.canEdit), EditorView.editable.of(session.canEdit)]),
    suggesting.of(session.mode === "suggesting" ? suggestingMode(session) : []),
    formattingKeymap,
    handlers.uploadImage ? codeImageUpload(session, handlers.uploadImage, { onError: handlers.onImageError }) : [],
    codePasteGuard({ onNotice: handlers.onNotice, undoManager: session.undoManager }),
    handlers.onMarkdownFileDrop ? codeMarkdownFileDrop(handlers.onMarkdownFileDrop) : [],
    // No searchKeymap: Mod-F is handled by the shared find bar in the editor shell.
    keymap.of([...historyKeymap, ...closeBracketsKeymap, ...defaultKeymap, indentWithTab]),
    EditorView.domEventHandlers({
      focus: () => {
        handlers.onFocus?.();
        return false;
      },
    }),
    EditorView.updateListener.of((update) => {
      if (update.selectionSet || update.focusChanged) {
        if (update.view.hasFocus) {
          const { head, anchor } = update.state.selection.main;
          handlers.onSelection?.(head, anchor);
          if (update.selectionSet) session.touchActivity();
        }
      }
    }),
    // tabindex="0" on `.cm-content`, the editor's single tab stop (task #321, verified in #361).
    // Why it is needed: CodeMirror gives `.cm-scroller` (overflow: auto) tabindex="-1", so the
    // scroller is not in the tab order itself, and axe's scrollable-region-focusable rule then wants
    // a *tabbable descendant*. axe's isNativelyFocusable() does not treat contenteditable as focusable
    // (only focusable-element does, and only for the scroller itself), so without an explicit
    // tabindex the contenteditable `.cm-content` is invisible to that check on every document tall
    // enough to scroll. Browsers already put contenteditable in the tab order, so this adds no second
    // tab stop; Tab reaches the source and PageUp/PageDown/arrows scroll it (CodeMirror's defaultKeymap).
    // Do not put tabindex="0" on `.cm-scroller` instead: that would be two tab stops for one editor.
    // The rich pane needs the same attribute on `.ProseMirror` for the same reason (prosemirror/setup.ts);
    // the #346 finding attributed to `.cm-scroller` was in fact the rich pane's scroller on a fixture
    // without links (a link inside the contenteditable happened to satisfy the rule on other fixtures).
    EditorView.contentAttributes.of({ "aria-label": "Markdown source", spellcheck: "true", tabindex: "0" }),
  ];

  return {
    extensions,
    setMode(view, canEdit, isSuggesting) {
      view.dispatch({
        effects: [
          editable.reconfigure([EditorState.readOnly.of(!canEdit), EditorView.editable.of(canEdit)]),
          suggesting.reconfigure(canEdit && isSuggesting ? suggestingMode(session) : []),
        ],
      });
    },
    setLineWrapping(view, wrap) {
      view.dispatch({ effects: wrapping.reconfigure(wrap ? EditorView.lineWrapping : []) });
    },
  };
}
