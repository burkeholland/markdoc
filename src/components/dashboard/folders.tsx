"use client";

import * as React from "react";
import { Check, Folder, FolderPlus, MoreVertical, Pencil, Trash2, X } from "lucide-react";
import { api, apiErrorText, type FolderDto } from "@/lib/api";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { FOLDER_NAME_MAX } from "@/lib/folder-name";
import { cn } from "@/lib/utils";

/**
 * The id of the folder being browsed, or one of the two pseudo-selections. `null` is "All documents"
 * (everything, filed or not) and `TOP_LEVEL` is "Not in a folder".
 */
export type FolderSelection = string | null | typeof TOP_LEVEL;
export const TOP_LEVEL = Symbol("top-level");

/** The MIME type carried by a card drag, holding the dragged document ids as JSON. */
export const DOCUMENT_DRAG_TYPE = "application/x-markdoc-documents";

/**
 * Document ids from a drop. Reads the custom type, and refuses anything else: a file dragged in from
 * the desktop is the import dropzone's business, not a move.
 *
 * `getData` is only readable on drop (it is empty during dragover, by design in the HTML drag spec),
 * so a drop target decides whether to highlight from `types` and only reads the payload here.
 */
export function documentIdsFromDrop(transfer: DataTransfer): string[] | null {
  const raw = transfer.getData(DOCUMENT_DRAG_TYPE);
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    const ids = parsed.filter((id): id is string => typeof id === "string" && id.length > 0);
    return ids.length > 0 ? ids : null;
  } catch {
    return null;
  }
}

/** Whether a dragover carries documents, which is all a target can know before the drop. */
export function dragCarriesDocuments(transfer: DataTransfer): boolean {
  return Array.from(transfer.types).includes(DOCUMENT_DRAG_TYPE);
}

export interface FoldersState {
  folders: FolderDto[];
  selection: FolderSelection;
  select: (selection: FolderSelection) => void;
  /** Reload from the server; the counts move whenever a document is filed or trashed. */
  refresh: () => Promise<void>;
  create: (name: string) => Promise<FolderDto | null>;
  rename: (id: string, name: string) => Promise<boolean>;
  /** Returns how many documents went to the trash, or null when the delete failed. */
  remove: (id: string) => Promise<number | null>;
  error: string | null;
  clearError: () => void;
}

/**
 * Folder list and mutations. The dashboard is server-rendered with its documents but fetches folders
 * on mount: folders are cheap (one row each) and this keeps the page's props unchanged.
 */
export function useFolders(onNotice: (message: string, kind?: "error" | "info") => void): FoldersState {
  const [folders, setFolders] = React.useState<FolderDto[]>([]);
  const [selection, setSelection] = React.useState<FolderSelection>(null);
  const [error, setError] = React.useState<string | null>(null);
  /**
   * False once the component is gone, so a reply that lands late does not write to a dead component.
   *
   * Set back to true on every mount, not just initialised once: Strict Mode mounts, unmounts and
   * remounts in development, and a cleanup-only effect would leave this false for the rest of the
   * component's life — every folder the server sent would then be dropped on the floor.
   */
  const live = React.useRef(true);
  React.useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  const refresh = React.useCallback(async () => {
    try {
      const { folders: next } = await api.folders.list();
      // Keep the array we already have when the answer is the same, rather than swapping in an equal
      // copy. Most refreshes are no-ops (the dashboard asks on mount and after every move), and a new
      // array identity would re-render the whole dashboard — which re-publishes the account menu's
      // listeners for nothing.
      if (live.current) setFolders((current) => (sameFolders(current, next) ? current : next));
    } catch (err) {
      if (live.current) setError(apiErrorText(err, "Could not load folders"));
    }
  }, []);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  const create = React.useCallback(
    async (name: string) => {
      try {
        const { folder } = await api.folders.create(name);
        if (live.current) {
          setFolders((current) => [...current, folder].sort(byName));
          setSelection(folder.id);
        }
        return folder;
      } catch (err) {
        onNotice(apiErrorText(err, "Could not create the folder"), "error");
        return null;
      }
    },
    [onNotice],
  );

  const rename = React.useCallback(
    async (id: string, name: string) => {
      try {
        const { folder } = await api.folders.rename(id, name);
        if (live.current) {
          // The reply's count is a placeholder (the rename route does not count), so keep the one we have.
          setFolders((current) => current.map((f) => (f.id === id ? { ...f, name: folder.name } : f)).sort(byName));
        }
        return true;
      } catch (err) {
        onNotice(apiErrorText(err, "Could not rename the folder"), "error");
        return false;
      }
    },
    [onNotice],
  );

  const remove = React.useCallback(
    async (id: string) => {
      try {
        const { trashed } = await api.folders.delete(id);
        if (live.current) {
          setFolders((current) => current.filter((f) => f.id !== id));
          setSelection((current) => (current === id ? null : current));
        }
        return trashed;
      } catch (err) {
        onNotice(apiErrorText(err, "Could not delete the folder"), "error");
        return null;
      }
    },
    [onNotice],
  );

  return {
    folders,
    selection,
    select: setSelection,
    refresh,
    create,
    rename,
    remove,
    error,
    clearError: () => setError(null),
  };
}

function byName(a: FolderDto, b: FolderDto): number {
  return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
}

/** Whether two folder lists say the same thing — same folders, same order, same counts and names. */
function sameFolders(a: readonly FolderDto[], b: readonly FolderDto[]): boolean {
  return (
    a.length === b.length &&
    a.every((folder, i) => folder.id === b[i].id && folder.name === b[i].name && folder.documentCount === b[i].documentCount)
  );
}

/** True when the two selections mean the same thing (`TOP_LEVEL` is a symbol, so `===` is enough). */
function sameSelection(a: FolderSelection, b: FolderSelection): boolean {
  return a === b;
}

const CHIP_CLASS =
  "inline-flex min-h-8 shrink-0 items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs font-medium transition outline-none focus-visible:border-accent";

function chipClass(selected: boolean, dropActive: boolean): string {
  return cn(
    CHIP_CLASS,
    selected ? "border-accent bg-accent-soft text-accent" : "border-line bg-surface text-ink-2 hover:border-accent hover:text-ink",
    // The drop highlight has to beat the selected styling, or dragging onto the open folder looks dead.
    dropActive && "border-accent border-dashed bg-accent-soft text-accent",
  );
}

export interface FolderRailProps {
  state: FoldersState;
  /** How many documents the person owns and has not filed, for the "Not in a folder" count. */
  unfiledCount: number;
  /** Total documents in the browsing list, for the "All documents" count. */
  totalCount: number;
  /** Move documents into a folder (or to the top level for `null`). Resolves once the move has landed. */
  onDropDocuments: (documentIds: string[], folderId: string | null) => Promise<void>;
}

/**
 * The folder row above the document list: "All documents", "Not in a folder", then each folder, then
 * "New folder". Every folder chip is also a drop target for dragged cards.
 *
 * Each chip is a real button, so the row is keyboard-operable with Tab and Enter, and the per-folder
 * menu is a Radix dropdown — arrow keys and Enter, no custom key handling (#2377).
 */
export function FolderRail({ state, unfiledCount, totalCount, onDropDocuments }: FolderRailProps) {
  const { folders, selection, select } = state;
  const [naming, setNaming] = React.useState<{ mode: "create" } | { mode: "rename"; folder: FolderDto } | null>(null);
  const [confirmDelete, setConfirmDelete] = React.useState<FolderDto | null>(null);
  const [dropTarget, setDropTarget] = React.useState<string | null | typeof TOP_LEVEL>(null);

  // A dragover fires continuously over a target's children, and dragleave fires when crossing between
  // them, so clearing on every dragleave flickers. Keyed clearing: only the target that set it clears it.
  const enterDrop = (key: string | null | typeof TOP_LEVEL) => setDropTarget(key);
  const leaveDrop = (key: string | null | typeof TOP_LEVEL) => setDropTarget((current) => (current === key ? null : current));

  const dropProps = (key: string | typeof TOP_LEVEL) => ({
    onDragOver: (event: React.DragEvent) => {
      if (!dragCarriesDocuments(event.dataTransfer)) return;
      // Both calls are required: without preventDefault the browser refuses the drop outright.
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      enterDrop(key);
    },
    onDragLeave: () => leaveDrop(key),
    onDrop: (event: React.DragEvent) => {
      const ids = documentIdsFromDrop(event.dataTransfer);
      leaveDrop(key);
      if (!ids) return;
      event.preventDefault();
      void onDropDocuments(ids, key === TOP_LEVEL ? null : key);
    },
  });

  const submitName = async (name: string) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    if (naming?.mode === "rename") await state.rename(naming.folder.id, trimmed);
    else await state.create(trimmed);
    setNaming(null);
  };

  return (
    <div className="mb-4" data-testid="folder-rail">
      <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Folders">
        <button
          type="button"
          className={chipClass(sameSelection(selection, null), false)}
          onClick={() => select(null)}
          aria-pressed={sameSelection(selection, null)}
          data-testid="folder-all"
        >
          All documents <span className="text-ink-4">{totalCount}</span>
        </button>
        <button
          type="button"
          className={chipClass(sameSelection(selection, TOP_LEVEL), dropTarget === TOP_LEVEL)}
          onClick={() => select(TOP_LEVEL)}
          aria-pressed={sameSelection(selection, TOP_LEVEL)}
          data-testid="folder-unfiled"
          {...dropProps(TOP_LEVEL)}
        >
          Not in a folder <span className="text-ink-4">{unfiledCount}</span>
        </button>
        {folders.map((folder) => (
          <span key={folder.id} className="inline-flex shrink-0 items-center">
            <button
              type="button"
              className={cn(chipClass(sameSelection(selection, folder.id), dropTarget === folder.id), "rounded-r-none border-r-0 pr-2")}
              onClick={() => select(folder.id)}
              aria-pressed={sameSelection(selection, folder.id)}
              data-testid="folder-chip"
              data-folder-id={folder.id}
              {...dropProps(folder.id)}
            >
              <Folder size={13} className="shrink-0" />
              <span className="max-w-40 truncate">{folder.name}</span>
              <span className="text-ink-4">{folder.documentCount}</span>
            </button>
            <Menu>
              <MenuTrigger asChild>
                <button
                  type="button"
                  className={cn(
                    chipClass(sameSelection(selection, folder.id), dropTarget === folder.id),
                    "rounded-l-none px-1.5",
                  )}
                  aria-label={`Actions for ${folder.name}`}
                  data-testid="folder-menu"
                >
                  <MoreVertical size={13} />
                </button>
              </MenuTrigger>
              <MenuContent className="w-44">
                <MenuLabel>{folder.name}</MenuLabel>
                <MenuItem icon={<Pencil size={14} />} onSelect={() => setNaming({ mode: "rename", folder })}>
                  Rename…
                </MenuItem>
                <MenuSeparator />
                <MenuItem icon={<Trash2 size={14} />} className="text-danger" onSelect={() => setConfirmDelete(folder)}>
                  Delete folder…
                </MenuItem>
              </MenuContent>
            </Menu>
          </span>
        ))}
        <button
          type="button"
          className={cn(CHIP_CLASS, "border-dashed border-line-2 text-ink-3 hover:border-accent hover:text-accent")}
          onClick={() => setNaming({ mode: "create" })}
          data-testid="new-folder"
        >
          <FolderPlus size={13} /> New folder
        </button>
      </div>

      <NameDialog
        key={naming?.mode === "rename" ? `rename-${naming.folder.id}` : "create"}
        open={naming !== null}
        mode={naming?.mode ?? "create"}
        initial={naming?.mode === "rename" ? naming.folder.name : ""}
        onCancel={() => setNaming(null)}
        onSubmit={submitName}
      />

      <Dialog open={confirmDelete !== null} onOpenChange={(open) => !open && setConfirmDelete(null)}>
        <DialogContent
          title={confirmDelete ? `Delete "${confirmDelete.name}"?` : "Delete folder?"}
          description={
            confirmDelete?.documentCount
              ? `Its ${confirmDelete.documentCount} document${confirmDelete.documentCount === 1 ? "" : "s"} go to the trash, where you can restore them for 30 days.`
              : "The folder is empty, so nothing else changes."
          }
        >
          <div className="flex justify-end gap-2" data-testid="delete-folder-confirm">
            <button type="button" className="btn btn-outline" onClick={() => setConfirmDelete(null)}>
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-danger"
              onClick={() => {
                const folder = confirmDelete;
                setConfirmDelete(null);
                if (folder) void state.remove(folder.id);
              }}
              data-testid="delete-folder-submit"
            >
              Delete folder
            </button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** The one text field behind "New folder" and "Rename". Submits on Enter, cancels on Escape. */
function NameDialog({
  open,
  mode,
  initial,
  onCancel,
  onSubmit,
}: {
  open: boolean;
  mode: "create" | "rename";
  initial: string;
  onCancel: () => void;
  onSubmit: (name: string) => void | Promise<void>;
}) {
  const [name, setName] = React.useState(initial);
  const [busy, setBusy] = React.useState(false);
  // The dialog is keyed by what it is naming, so a fresh mount already carries the right initial value;
  // this only has to catch `initial` changing under an open dialog.
  React.useEffect(() => setName(initial), [initial]);

  const submit = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    try {
      await onSubmit(name);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onCancel()}>
      <DialogContent
        title={mode === "rename" ? "Rename folder" : "New folder"}
        description={mode === "rename" ? undefined : "Folders hold your own documents. Sharing a folder is not here yet."}
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
          data-testid="folder-name-form"
        >
          <input
            className="input"
            autoFocus
            value={name}
            maxLength={FOLDER_NAME_MAX}
            onChange={(event) => setName(event.target.value)}
            aria-label="Folder name"
            placeholder="Folder name"
            data-testid="folder-name-input"
          />
          <div className="mt-4 flex justify-end gap-2">
            <button type="button" className="btn btn-outline" onClick={onCancel}>
              Cancel
            </button>
            <button type="submit" className="btn btn-primary" disabled={!name.trim() || busy} data-testid="folder-name-submit">
              {mode === "rename" ? "Rename" : "Create folder"}
            </button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The "Move to" rows for one document's card menu. A Radix dropdown, so arrow keys and Enter work
 * without any key handling of our own — the issue's "the menu must also work from the keyboard".
 */
export function MoveToItems({
  folders,
  currentFolderId,
  onMove,
}: {
  folders: FolderDto[];
  /**
   * Where the document is now, so that row is ticked and not offered again. `undefined` means there
   * is no single answer — a multi-select spanning folders — and then no row is ticked or disabled.
   */
  currentFolderId: string | null | undefined;
  onMove: (folderId: string | null) => void;
}) {
  const here = (folderId: string | null) => currentFolderId !== undefined && currentFolderId === folderId;
  return (
    <>
      <MenuLabel>Move to</MenuLabel>
      <MenuItem
        icon={here(null) ? <Check size={14} /> : undefined}
        disabled={here(null)}
        onSelect={() => onMove(null)}
        data-testid="move-to-top-level"
      >
        Not in a folder
      </MenuItem>
      {folders.map((folder) => (
        <MenuItem
          key={folder.id}
          icon={here(folder.id) ? <Check size={14} /> : <Folder size={14} />}
          disabled={here(folder.id)}
          onSelect={() => onMove(folder.id)}
          data-testid="move-to-folder"
          data-folder-id={folder.id}
        >
          <span className="truncate">{folder.name}</span>
        </MenuItem>
      ))}
      {folders.length === 0 && <MenuItem disabled>No folders yet</MenuItem>}
    </>
  );
}

/**
 * The bar shown while documents are selected: how many, where to move them, and a way out. Rendered
 * in the flow above the list rather than fixed to the viewport, so it never covers a card.
 */
export function SelectionBar({
  count,
  folders,
  onMove,
  onClear,
  busy,
}: {
  count: number;
  folders: FolderDto[];
  onMove: (folderId: string | null) => void;
  onClear: () => void;
  busy: boolean;
}) {
  return (
    <div
      className="mb-3 flex flex-wrap items-center gap-3 rounded-xl border border-accent bg-accent-soft px-3 py-2"
      role="status"
      data-testid="selection-bar"
    >
      <span className="text-sm font-medium text-accent">
        {count} document{count === 1 ? "" : "s"} selected
      </span>
      <div className="ml-auto flex items-center gap-2">
        <Menu>
          <MenuTrigger asChild>
            <button type="button" className="btn btn-sm btn-primary" disabled={busy} data-testid="selection-move">
              <Folder size={14} /> Move to…
            </button>
          </MenuTrigger>
          <MenuContent className="w-52">
            {/* A selection may span folders, so `undefined`: nothing is ticked and every row stays offered. */}
            <MoveToItems folders={folders} currentFolderId={undefined} onMove={onMove} />
          </MenuContent>
        </Menu>
        <button type="button" className="btn btn-sm btn-outline" onClick={onClear} data-testid="selection-clear">
          <X size={14} /> Clear
        </button>
      </div>
    </div>
  );
}
