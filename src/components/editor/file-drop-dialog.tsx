"use client";
import { memo, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { FilePlus2, Loader2, Replace, TextCursorInput } from "lucide-react";
import { Dialog, DialogContent } from "@/components/ui/primitives";
import { uploadImportFiles } from "@/components/dashboard/import-dialog";

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

/** Asks what to do with a Markdown file dropped on the editor: replace, insert at the drop point, or open as a new document. */
export const FileDropDialog = memo(function FileDropDialog({ pending, onClose, canEdit, onReplace, onInsert, onError }: FileDropDialogProps) {
  const router = useRouter();
  const [busy, setBusy] = useState<"replace" | "insert" | "new" | null>(null);

  const run = async (action: "replace" | "insert" | "new") => {
    if (!pending) return;
    setBusy(action);
    try {
      if (action === "new") {
        const [doc] = await uploadImportFiles([pending.file]);
        if (!doc) throw new Error("Import failed");
        router.push(`/d/${doc.id}`);
      } else {
        const text = await readText(pending.file);
        if (action === "replace") onReplace(text);
        else onInsert(text, pending.at);
      }
      onClose();
    } catch (err) {
      onError(err instanceof Error ? err.message : "Could not read the file");
    } finally {
      setBusy(null);
    }
  };

  const option = (action: "replace" | "insert" | "new", icon: ReactNode, title: string, description: string, disabled?: boolean) => (
    <button
      type="button"
      onClick={() => void run(action)}
      disabled={busy !== null || disabled}
      className="flex w-full items-center gap-3 rounded-xl border border-line bg-surface p-3 text-left transition hover:border-accent disabled:cursor-default disabled:opacity-50"
      data-testid={`file-drop-${action}`}
    >
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-surface-3 text-ink-2">{busy === action ? <Loader2 size={16} className="animate-spin" /> : icon}</span>
      <span>
        <span className="block text-sm font-semibold text-ink">{title}</span>
        <span className="block text-xs text-ink-3">{description}</span>
      </span>
    </button>
  );

  return (
    <Dialog open={pending !== null} onOpenChange={(o) => !o && busy === null && onClose()}>
      <DialogContent title="Dropped file" description={pending ? `What should happen with “${pending.file.name}”?` : undefined}>
        <div className="flex flex-col gap-2" data-testid="file-drop-dialog">
          {option("replace", <Replace size={16} />, "Replace document content", "The whole document becomes the file's text (undoable).", !canEdit)}
          {option("insert", <TextCursorInput size={16} />, "Insert at cursor", "Put the file's text where you dropped it.", !canEdit)}
          {option("new", <FilePlus2 size={16} />, "Open as new document", "Import the file as a separate document and open it.")}
        </div>
      </DialogContent>
    </Dialog>
  );
});
