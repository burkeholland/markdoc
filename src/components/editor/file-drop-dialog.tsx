"use client";
import { memo, useCallback, useLayoutEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { FilePlus2, Loader2, Replace, TextCursorInput } from "lucide-react";
import { Dialog, DialogContent } from "@/components/ui/primitives";
import { uploadImportFiles } from "@/lib/import-upload";

type FileDropAction = "replace" | "insert" | "new";
const FILE_DROP_ACTIONS: readonly FileDropAction[] = ["replace", "insert", "new"];

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

type FileDropRouter = ReturnType<typeof useRouter>;

interface FileDropOptionPublication {
  action: FileDropAction;
  eligible: boolean;
  ref: (element: HTMLButtonElement | null) => void;
  onClick: (event: ReactMouseEvent<HTMLButtonElement>) => void;
}

interface FileDropPublication {
  mount: symbol;
  pending: PendingFileDrop;
  file: File;
  at: number;
  canEdit: boolean;
  router: FileDropRouter;
  routerPush: FileDropRouter["push"];
  onClose: () => void;
  onReplace: (text: string) => void;
  onInsert: (text: string, at: number) => void;
  onError: (message: string) => void;
  onOpenChange: (open: boolean) => void;
  options: Record<FileDropAction, FileDropOptionPublication>;
}

interface FileDropPublicationRuntime {
  active: boolean;
  onOpenChange: ((open: boolean) => void) | null;
  elements: Record<FileDropAction, HTMLButtonElement | null>;
}

interface FileDropOperation {
  publication: FileDropPublication;
  action: FileDropAction;
}

/** Asks what to do with a Markdown file dropped on the editor: replace, insert at the drop point, or open as a new document. */
export const FileDropDialog = memo(function FileDropDialog({ pending, onClose, canEdit, onReplace, onInsert, onError }: FileDropDialogProps) {
  const router = useRouter();
  const routerPush = router.push;
  const [mount] = useState(() => Symbol("file-drop-dialog"));
  const activePublicationRef = useRef<FileDropPublication | null>(null);
  const publicationRuntimesRef = useRef(new WeakMap<FileDropPublication, FileDropPublicationRuntime>());
  const operationRef = useRef<FileDropOperation | null>(null);
  const [busy, setBusy] = useState<FileDropOperation | null>(null);

  const runtimeFor = useCallback((candidate: FileDropPublication) => {
    const runtimes = publicationRuntimesRef.current;
    let runtime = runtimes.get(candidate);
    if (!runtime) {
      runtime = {
        active: false,
        onOpenChange: null,
        elements: { replace: null, insert: null, new: null },
      };
      runtimes.set(candidate, runtime);
    }
    return runtime;
  }, []);

  const retirePublication = useCallback((candidate: FileDropPublication) => {
    const runtime = publicationRuntimesRef.current.get(candidate);
    if (runtime) {
      runtime.active = false;
      runtime.onOpenChange = null;
    }
    const wasActive = activePublicationRef.current === candidate;
    if (wasActive) activePublicationRef.current = null;
    if (operationRef.current?.publication === candidate) operationRef.current = null;
    return wasActive;
  }, []);

  const ownsPublication = useCallback(
    (candidate: FileDropPublication) => {
      const runtime = publicationRuntimesRef.current.get(candidate);
      return (
        activePublicationRef.current === candidate &&
        runtime?.active === true &&
        runtime.onOpenChange === candidate.onOpenChange &&
        candidate.mount === mount &&
        candidate.pending.file === candidate.file &&
        Object.is(candidate.pending.at, candidate.at) &&
        candidate.router.push === candidate.routerPush &&
        FILE_DROP_ACTIONS.every((action) => runtime.elements[action]?.isConnected === true)
      );
    },
    [mount],
  );

  const bindOption = useCallback(
    (candidate: FileDropPublication, action: FileDropAction, element: HTMLButtonElement | null) => {
      const runtime = runtimeFor(candidate);
      runtime.elements[action] = element;
      if (!element) retirePublication(candidate);
    },
    [retirePublication, runtimeFor],
  );

  const ownsOption = useCallback(
    (candidate: FileDropPublication, action: FileDropAction, element: HTMLButtonElement) => {
      const option = candidate.options[action];
      return (
        option.action === action &&
        option.eligible &&
        !element.disabled &&
        ownsPublication(candidate) &&
        publicationRuntimesRef.current.get(candidate)?.elements[action] === element
      );
    },
    [ownsPublication],
  );

  const ownsOperation = useCallback(
    (candidate: FileDropPublication, operation: FileDropOperation) =>
      operationRef.current === operation &&
      operation.publication === candidate &&
      ownsPublication(candidate),
    [ownsPublication],
  );

  const run = useCallback(
    async (candidate: FileDropPublication, action: FileDropAction, element: HTMLButtonElement) => {
      if (!ownsOption(candidate, action, element) || operationRef.current) return;
      const operation = { publication: candidate, action };
      operationRef.current = operation;
      setBusy(operation);
      try {
        if (action === "new") {
          const [doc] = await uploadImportFiles([candidate.file]);
          if (!ownsOperation(candidate, operation)) return;
          if (!doc) throw new Error("Import failed");
          candidate.routerPush.call(candidate.router, `/d/${doc.id}`);
        } else {
          const text = await readText(candidate.file);
          if (!ownsOperation(candidate, operation)) return;
          if (action === "replace") candidate.onReplace(text);
          else candidate.onInsert(text, candidate.at);
        }
        if (ownsOperation(candidate, operation)) candidate.onClose();
      } catch (err) {
        if (ownsOperation(candidate, operation)) {
          candidate.onError(err instanceof Error ? err.message : "Could not read the file");
        }
      } finally {
        if (ownsOperation(candidate, operation)) {
          operationRef.current = null;
          setBusy((current) => (current === operation ? null : current));
        }
      }
    },
    [ownsOperation, ownsOption],
  );

  const handleOpenChange = useCallback(
    (candidate: FileDropPublication, open: boolean) => {
      if (open || !ownsPublication(candidate) || operationRef.current?.publication === candidate) return;
      if (retirePublication(candidate)) candidate.onClose();
    },
    [ownsPublication, retirePublication],
  );

  const publication = useMemo<FileDropPublication | null>(() => {
    if (!pending) return null;
    const file = pending.file;
    const at = pending.at;
    const candidate: FileDropPublication = {
      mount,
      pending,
      file,
      at,
      canEdit,
      router,
      routerPush,
      onClose,
      onReplace,
      onInsert,
      onError,
      onOpenChange: (open) => handleOpenChange(candidate, open),
      options: {
        replace: {
          action: "replace",
          eligible: canEdit,
          ref: (element) => bindOption(candidate, "replace", element),
          onClick: (event) => void run(candidate, "replace", event.currentTarget),
        },
        insert: {
          action: "insert",
          eligible: canEdit,
          ref: (element) => bindOption(candidate, "insert", element),
          onClick: (event) => void run(candidate, "insert", event.currentTarget),
        },
        new: {
          action: "new",
          eligible: true,
          ref: (element) => bindOption(candidate, "new", element),
          onClick: (event) => void run(candidate, "new", event.currentTarget),
        },
      },
    };
    return candidate;
  }, [bindOption, canEdit, handleOpenChange, mount, onClose, onError, onInsert, onReplace, pending, router, routerPush, run]);

  useLayoutEffect(() => {
    const previous = activePublicationRef.current;
    if (previous && previous !== publication) retirePublication(previous);
    if (!publication) return;
    const runtime = runtimeFor(publication);
    runtime.onOpenChange = publication.onOpenChange;
    runtime.active = true;
    activePublicationRef.current = publication;
    return () => {
      retirePublication(publication);
    };
  }, [publication, retirePublication, runtimeFor]);

  const busyAction =
    publication &&
    busy === operationRef.current &&
    busy?.publication === publication
      ? busy.action
      : null;

  const option = (control: FileDropOptionPublication, icon: ReactNode, title: string, description: string) => (
    <button
      ref={control.ref}
      type="button"
      onClick={control.onClick}
      disabled={busyAction !== null || !control.eligible}
      className="flex w-full items-center gap-3 rounded-xl border border-line bg-surface p-3 text-left transition hover:border-accent disabled:cursor-default disabled:opacity-50"
      data-testid={`file-drop-${control.action}`}
    >
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-surface-3 text-ink-2">{busyAction === control.action ? <Loader2 size={16} className="animate-spin" /> : icon}</span>
      <span>
        <span className="block text-sm font-semibold text-ink">{title}</span>
        <span className="block text-xs text-ink-3">{description}</span>
      </span>
    </button>
  );

  return (
    <Dialog
      open={pending !== null}
      onOpenChange={publication?.onOpenChange}
    >
      <DialogContent title="Dropped file" description={pending ? `What should happen with “${pending.file.name}”?` : undefined}>
        {/* Every option changes the document; keep the opening focus on Close rather than an option Enter would fire. */}
        <div className="flex flex-col gap-2" data-testid="file-drop-dialog" data-focus-skip>
          {publication && (
            <>
              {option(publication.options.replace, <Replace size={16} />, "Replace document content", "The whole document becomes the file's text (undoable).")}
              {option(publication.options.insert, <TextCursorInput size={16} />, "Insert at cursor", "Put the file's text where you dropped it.")}
              {option(publication.options.new, <FilePlus2 size={16} />, "Open as new document", "Import the file as a separate document and open it.")}
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
});
