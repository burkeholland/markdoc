"use client";
import { memo, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { FilePlus2, Loader2, Replace, TextCursorInput } from "lucide-react";
import { Dialog, DialogContent } from "@/components/ui/primitives";
import { uploadImportFiles } from "@/lib/import-upload";

type FileDropAction = "replace" | "insert" | "new";

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

function readText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("Could not read the file"));
    reader.onload = () => resolve(String(reader.result ?? "").replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n"));
    reader.readAsText(file);
  });
}

interface FileDropOperation {
  pending: PendingFileDrop;
  action: FileDropAction;
}

/** Asks what to do with a Markdown file dropped on the editor: replace, insert at the drop point, or open as a new document. */
export const FileDropDialog = memo(function FileDropDialog({ pending, onClose, canEdit, onReplace, onInsert, onError }: FileDropDialogProps) {
  const router = useRouter();
  const pendingRef = useRef(pending);
  const operationRef = useRef<FileDropOperation | null>(null);
  const mountedRef = useRef(true);
  const [busy, setBusy] = useState<FileDropOperation | null>(null);
  const busyAction = busy === operationRef.current && busy?.pending === pending ? busy.action : null;

  useLayoutEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      pendingRef.current = null;
      operationRef.current = null;
    };
  }, []);

  useLayoutEffect(() => {
    pendingRef.current = pending;
    if (operationRef.current?.pending !== pending) operationRef.current = null;
  }, [pending]);

  const run = async (action: FileDropAction) => {
    const ownedPending = pending;
    if (!ownedPending || !mountedRef.current || pendingRef.current !== ownedPending || operationRef.current) return;
    const operation = { pending: ownedPending, action };
    operationRef.current = operation;
    setBusy(operation);
    const isCurrent = () => mountedRef.current && pendingRef.current === ownedPending && operationRef.current === operation;
    try {
      if (action === "new") {
        const [doc] = await uploadImportFiles([ownedPending.file]);
        if (!isCurrent()) return;
        if (!doc) throw new Error("Import failed");
        router.push(`/d/${doc.id}`);
      } else {
        const text = await readText(ownedPending.file);
        if (!isCurrent()) return;
        if (action === "replace") onReplace(text);
        else onInsert(text, ownedPending.at);
      }
      if (isCurrent()) onClose();
    } catch (err) {
      if (isCurrent()) onError(err instanceof Error ? err.message : "Could not read the file");
    } finally {
      if (operationRef.current === operation) operationRef.current = null;
      if (mountedRef.current) setBusy((current) => (current === operation ? null : current));
    }
  };

  const option = (action: FileDropAction, icon: ReactNode, title: string, description: string, disabled?: boolean) => (
    <button
      type="button"
      onClick={() => void run(action)}
      disabled={busyAction !== null || disabled}
      className="flex w-full items-center gap-3 rounded-xl border border-line bg-surface p-3 text-left transition hover:border-accent disabled:cursor-default disabled:opacity-50"
      data-testid={`file-drop-${action}`}
    >
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-surface-3 text-ink-2">{busyAction === action ? <Loader2 size={16} className="animate-spin" /> : icon}</span>
      <span>
        <span className="block text-sm font-semibold text-ink">{title}</span>
        <span className="block text-xs text-ink-3">{description}</span>
      </span>
    </button>
  );

  return (
    <Dialog
      open={pending !== null}
      onOpenChange={(open) => {
        const operation = operationRef.current;
        if (!open && (operation?.pending !== pending || pendingRef.current !== pending)) onClose();
      }}
    >
      <DialogContent title="Dropped file" description={pending ? `What should happen with “${pending.file.name}”?` : undefined}>
        {/* Every option changes the document; keep the opening focus on Close rather than an option Enter would fire. */}
        <div className="flex flex-col gap-2" data-testid="file-drop-dialog" data-focus-skip>
          {option("replace", <Replace size={16} />, "Replace document content", "The whole document becomes the file's text (undoable).", !canEdit)}
          {option("insert", <TextCursorInput size={16} />, "Insert at cursor", "Put the file's text where you dropped it.", !canEdit)}
          {option("new", <FilePlus2 size={16} />, "Open as new document", "Import the file as a separate document and open it.")}
        </div>
      </DialogContent>
    </Dialog>
  );
});
