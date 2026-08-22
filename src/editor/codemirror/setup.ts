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
import { yCollab, yUndoManagerKeymap } from "y-codemirror.next";
import type { CollabSession } from "../collab/session";
import { codeEditorTheme } from "./theme";
import { sourceHighlights, highlightClickHandler } from "./highlights";
import { suggestingMode } from "./suggesting";
import { toggleInlineMark, setHeading, toggleLinePrefix } from "./commands";
import { codeImageUpload } from "./images";
import type { ImageUploader } from "../prosemirror/images";

export interface CodeEditorHandlers {
  onFocus?: () => void;
  onSelection?: (head: number, anchor: number) => void;
  onHighlightClick?: (kind: string, id: string | null) => void;
  /** Uploads a pasted or dropped image file; when absent, image files are left to the browser. */
  uploadImage?: ImageUploader;
  onImageError?: (message: string) => void;
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
    closeBrackets(),
    highlightSelectionMatches(),
    placeholder("Start writing Markdown…"),
    markdown({ base: markdownLanguage, codeLanguages: languages, addKeymap: true }),
    codeEditorTheme,
    wrapping.of(EditorView.lineWrapping),
    yCollab(session.ytext, session.awareness, { undoManager: session.undoManager }),
    sourceHighlights(),
    highlightClickHandler((kind, id) => handlers.onHighlightClick?.(kind, id)),
    editable.of([EditorState.readOnly.of(!session.canEdit), EditorView.editable.of(session.canEdit)]),
    suggesting.of(session.mode === "suggesting" ? suggestingMode(session) : []),
    formattingKeymap,
    handlers.uploadImage ? codeImageUpload(session, handlers.uploadImage, { onError: handlers.onImageError }) : [],
    // No searchKeymap: Mod-F is handled by the shared find bar in the editor shell.
    keymap.of([...yUndoManagerKeymap, ...closeBracketsKeymap, ...defaultKeymap, indentWithTab]),
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
        }
      }
    }),
    EditorView.contentAttributes.of({ "aria-label": "Markdown source", spellcheck: "true" }),
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
