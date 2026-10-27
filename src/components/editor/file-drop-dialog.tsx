"use client";

import { memo, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { FilePlus2, Loader2, Replace, TextCursorInput } from "lucide-react";
import { Dialog, DialogContent } from "@/components/ui/primitives";
import { uploadImportFiles } from "@/lib/import-upload";

type FileDropAction = "replace" | "insert" | "new";
const OPTION_CLASS_NAME =
  "flex w-full items-center gap-3 rounded-xl border border-line bg-surface p-3 text-left transition hover:border-accent disabled:cursor-default disabled:opacity-50";
const OPTION_ICON_CLASS_NAME =
  "flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-surface-3 text-ink-2";
const OPTION_TITLE_CLASS_NAME = "block text-sm font-semibold text-ink";
const OPTION_DESCRIPTION_CLASS_NAME = "block text-xs text-ink-3";
const OPTIONS_CLASS_NAME = "flex flex-col gap-2";

export interface PendingFileDrop {
  file: File;
  /** Source offset where the file was dropped. */
  at: number;
}

export interface FileDropDialogProps {
  pending: PendingFileDrop | null;
  onClose: () => void;
  canEdit: boolean;
  /** Replace the whole source or insert at `at`; the text is already LF-normalised. */
  onReplace: (text: string) => void;
  onInsert: (text: string, at: number) => void;
  onError: (message: string) => void;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} ${bytes === 1 ? "byte" : "bytes"}`;
  const units = ["KiB", "MiB", "GiB"];
  let size = bytes / 1024;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${Number(size.toFixed(1))} ${units[unit]}`;
}

function fileDropDescription(file: File): string {
  return `What should happen with “${file.name}” (${formatFileSize(file.size)})?`;
}

function readText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("Could not read the file"));
    reader.onload = () =>
      resolve(
        String(reader.result ?? "")
          .replace(/^\uFEFF/, "")
          .replace(/\r\n?/g, "\n"),
      );
    reader.readAsText(file);
  });
}


interface FileDropOption {
  action: FileDropAction;
  title: string;
  description: string;
  icon: ReactNode;
  needsEdit: boolean;
}

const FILE_DROP_OPTIONS: readonly FileDropOption[] = [
  {
    action: "replace",
    title: "Replace document content",
    description: "The whole document becomes the file's text (undoable).",
    icon: <Replace size={16} />,
    needsEdit: true,
  },
  {
    action: "insert",
    title: "Insert at cursor",
    description: "Put the file's text where you dropped it.",
    icon: <TextCursorInput size={16} />,
    needsEdit: true,
  },
  {
    action: "new",
    title: "Open as new document",
    description: "Import the file as a separate document and open it.",
    icon: <FilePlus2 size={16} />,
    needsEdit: false,
  },
];

export const FileDropDialog = memo(function FileDropDialog({
  pending,
  onClose,
  canEdit,
  onReplace,
  onInsert,
  onError,
}: FileDropDialogProps) {
  const router = useRouter();
  const [busy, setBusy] = useState<{ action: FileDropAction; pending: PendingFileDrop } | null>(null);
  const busyAction = busy && busy.pending === pending ? busy.action : null;
  // One action at a time: the ref is set before React renders again, so a double-click starts one.
  const operationRef = useRef<symbol | null>(null);
  const pendingRef = useRef(pending);
  const propsRef = useRef({ onClose, onReplace, onInsert, onError, canEdit, router });
  useEffect(() => {
    propsRef.current = { onClose, onReplace, onInsert, onError, canEdit, router };
  });
  // A new drop, or the dialog going away, lets go of the work for the old one: its result changes nothing.
  useEffect(() => {
    pendingRef.current = pending;
    operationRef.current = null;
    return () => {
      operationRef.current = null;
    };
  }, [pending]);

  const start = async (action: FileDropAction) => {
    const drop = pendingRef.current;
    if (!drop || operationRef.current || (action !== "new" && !propsRef.current.canEdit)) return;
    const operation = Symbol(action);
    operationRef.current = operation;
    setBusy({ action, pending: drop });
    const owns = () => operationRef.current === operation && pendingRef.current === drop;
    try {
      if (action === "new") {
        const [doc] = await uploadImportFiles([drop.file]);
        if (!owns()) return;
        if (!doc) throw new Error("Import failed");
        propsRef.current.router.push(`/d/${doc.id}`);
      } else {
        const text = await readText(drop.file);
        if (!owns()) return;
        if (action === "replace") propsRef.current.onReplace(text);
        else propsRef.current.onInsert(text, drop.at);
      }
      if (owns()) propsRef.current.onClose();
    } catch (error) {
      if (owns()) propsRef.current.onError(error instanceof Error ? error.message : "Could not read the file");
    } finally {
      if (owns()) {
        operationRef.current = null;
        setBusy(null);
      }
    }
  };

  const onOpenChange = (open: boolean) => {
    // Escape, Close and a click outside do nothing while the file is being read or imported.
    if (open || operationRef.current) return;
    onClose();
  };

  // Arrow keys, Home and End move focus between the enabled choices. They stop at the ends.
  const onOptionsKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.nativeEvent.isComposing) return;
    const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button")).filter((button) => !button.disabled);
    const from = buttons.findIndex((button) => button === event.target);
    if (from < 0) return;
    const to =
      event.key === "ArrowDown" || event.key === "ArrowRight"
        ? from + 1
        : event.key === "ArrowUp" || event.key === "ArrowLeft"
          ? from - 1
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? buttons.length - 1
              : -1;
    const next = buttons[to];
    if (!next || to === from) return;
    event.preventDefault();
    next.focus({ preventScroll: true });
  };

  return (
    <Dialog open={pending !== null} onOpenChange={onOpenChange}>
      {pending && (
        <DialogContent title="Dropped file" description={fileDropDescription(pending.file)}>
          {/* Every option changes the document; keep the opening focus on Close rather than an option Enter would fire. */}
          <div className={OPTIONS_CLASS_NAME} data-testid="file-drop-dialog" data-focus-skip onKeyDown={onOptionsKeyDown}>
            {FILE_DROP_OPTIONS.map((option) => (
              <button
                key={option.action}
                type="button"
                onClick={() => void start(option.action)}
                disabled={busyAction !== null || (option.needsEdit && !canEdit)}
                className={OPTION_CLASS_NAME}
                data-testid={`file-drop-${option.action}`}
              >
                <span className={OPTION_ICON_CLASS_NAME}>
                  {busyAction === option.action ? <Loader2 size={16} className="animate-spin" /> : option.icon}
                </span>
                <span>
                  <span className={OPTION_TITLE_CLASS_NAME}>{option.title}</span>
                  <span className={OPTION_DESCRIPTION_CLASS_NAME}>{option.description}</span>
                </span>
              </button>
            ))}
          </div>
        </DialogContent>
      )}
    </Dialog>
  );
});
