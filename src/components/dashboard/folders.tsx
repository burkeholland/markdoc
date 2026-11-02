"use client";

import * as React from "react";
import { Check, Folder, FolderPlus, MoreVertical, Pencil, Share2, Trash2, Users, X } from "lucide-react";
import { ApiError, api, apiErrorText, type CollaboratorDto, type FolderDto } from "@/lib/api";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { FOLDER_NAME_MAX } from "@/lib/folder-name";
import { cn } from "@/lib/utils";
import type { Role } from "@/server/db/schema";
import { Avatar } from "@/components/ui/primitives";
import { CollaboratorLoginInput, isValidLogin, type CollaboratorLoginInputHandle } from "@/components/editor/collaborator-login-input";

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
        // Select the folder so its empty state explains how to add documents.
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
    a.every(
      (folder, i) =>
        folder.id === b[i].id &&
        folder.name === b[i].name &&
        folder.documentCount === b[i].documentCount &&
        folder.role === b[i].role &&
        folder.ownerId === b[i].ownerId &&
        folder.ownerLogin === b[i].ownerLogin,
    )
  );
}

/** True when the two selections mean the same thing (`TOP_LEVEL` is a symbol, so `===` is enough). */
function sameSelection(a: FolderSelection, b: FolderSelection): boolean {
  return a === b;
}

const CHIP_CLASS =
  "inline-flex min-h-8 shrink-0 items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs font-medium transition focus-visible:border-accent";

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
  const ownedFolders = folders.filter((folder) => folder.role === "owner");
  const sharedFolders = folders.filter((folder) => folder.role !== "owner");
  const [naming, setNaming] = React.useState<{ mode: "create" } | { mode: "rename"; folder: FolderDto } | null>(null);
  const [confirmDelete, setConfirmDelete] = React.useState<FolderDto | null>(null);
  const [sharing, setSharing] = React.useState<FolderDto | null>(null);
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
        {ownedFolders.map((folder) => (
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
                <MenuItem icon={<Share2 size={14} />} onSelect={() => setSharing(folder)}>
                  Share…
                </MenuItem>
                <MenuSeparator />
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
        {sharedFolders.length > 0 && (
          <>
            <span className="px-1 text-[11px] font-medium text-ink-4">Shared with me</span>
            {sharedFolders.map((folder) => (
              <button
                key={folder.id}
                type="button"
                className={chipClass(sameSelection(selection, folder.id), false)}
                onClick={() => select(folder.id)}
                aria-pressed={sameSelection(selection, folder.id)}
                title={`Shared by ${folder.ownerLogin ? `@${folder.ownerLogin}` : folder.ownerName ?? "another person"} · ${folder.role}`}
                data-testid="shared-folder-chip"
                data-folder-id={folder.id}
              >
                <Users size={13} className="shrink-0" />
                <span className="max-w-40 truncate">{folder.name}</span>
                <span className="text-ink-4">{folder.documentCount}</span>
              </button>
            ))}
          </>
        )}
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
      <FolderShareDialog folder={sharing} onOpenChange={(open) => !open && setSharing(null)} />

      <Dialog open={confirmDelete !== null} onOpenChange={(open) => !open && setConfirmDelete(null)}>
        <DialogContent
          title={confirmDelete ? `Delete "${confirmDelete.name}"?` : "Delete folder?"}
          description={
            confirmDelete?.documentCount
              ? confirmDelete.documentCount === 1
                ? "Its 1 document goes to the trash, where you can restore it for 30 days."
                : `Its ${confirmDelete.documentCount} documents go to the trash, where you can restore them for 30 days.`
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
        description={mode === "rename" ? undefined : "Organize your documents, then share a folder from its menu."}
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

type FolderRole = Exclude<Role, "owner">;
type FolderPeople = Awaited<ReturnType<typeof api.folders.collaborators>>;

const FOLDER_ROLE_OPTIONS: readonly { value: FolderRole; label: string }[] = [
  { value: "editor", label: "Editor" },
  { value: "commenter", label: "Commenter" },
  { value: "viewer", label: "Viewer" },
];

function folderShareRefusal(error: unknown): string | null {
  if (!(error instanceof ApiError) || error.status !== 409 || error.body?.code !== "already-collaborator") return null;
  const { login, role } = error.body;
  if (typeof login !== "string" || !FOLDER_ROLE_OPTIONS.some((option) => option.value === role)) return null;
  const label = FOLDER_ROLE_OPTIONS.find((option) => option.value === role)?.label;
  return `@${login} already has access as ${label}. Change the role in the list below.`;
}

function FolderShareDialog({ folder, onOpenChange }: { folder: FolderDto | null; onOpenChange: (open: boolean) => void }) {
  const [people, setPeople] = React.useState<FolderPeople | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [retry, setRetry] = React.useState(0);
  const [login, setLogin] = React.useState("");
  const [role, setRole] = React.useState<FolderRole>("editor");
  const [adding, setAdding] = React.useState(false);
  const [addError, setAddError] = React.useState<string | null>(null);
  const [addNote, setAddNote] = React.useState<string | null>(null);
  const [actionError, setActionError] = React.useState<string | null>(null);
  const [busyLogins, setBusyLogins] = React.useState<ReadonlySet<string>>(new Set());
  const roleSelect = React.useRef<HTMLSelectElement>(null);
  const loginInput = React.useRef<CollaboratorLoginInputHandle>(null);
  const currentFolder = React.useRef<string | null>(folder?.id ?? null);
  const focusRole = React.useCallback(() => roleSelect.current?.focus(), []);
  const folderId = folder?.id ?? null;

  React.useEffect(() => {
    currentFolder.current = folder?.id ?? null;
  }, [folder?.id]);

  React.useEffect(() => {
    if (!folderId) return;
    let stale = false;
    setLoading(true);
    setLoadError(null);
    api.folders.collaborators(folderId).then(
      (result) => {
        if (!stale) setPeople(result);
      },
      (error: unknown) => {
        if (!stale) setLoadError(apiErrorText(error, "Could not load folder access."));
      },
    ).finally(() => {
      if (!stale) setLoading(false);
    });
    return () => {
      stale = true;
    };
  }, [folderId, retry]);

  const setBusy = React.useCallback((who: string, busy: boolean) => {
    setBusyLogins((current) => {
      const next = new Set(current);
      if (busy) next.add(who);
      else next.delete(who);
      return next;
    });
  }, []);

  const refresh = async (folderId: string) => {
    try {
      const result = await api.folders.collaborators(folderId);
      if (currentFolder.current === folderId) setPeople(result);
    } catch (error) {
      if (currentFolder.current === folderId) setLoadError(apiErrorText(error, "Could not refresh folder access."));
    }
  };

  const add = async (event: React.FormEvent) => {
    event.preventDefault();
    const target = folder;
    const handle = login.trim();
    if (!target || !isValidLogin(handle) || adding) return;
    setAdding(true);
    setAddError(null);
    setAddNote(null);
    try {
      const result = await api.folders.addCollaborator(target.id, handle, role);
      if (currentFolder.current !== target.id) return;
      setLogin("");
      if (result.pending) setAddNote(`@${result.login} gets access on their first sign-in. Check the spelling.`);
      await refresh(target.id);
    } catch (error) {
      if (currentFolder.current !== target.id) return;
      setAddError(folderShareRefusal(error) ?? apiErrorText(error, "Could not share this folder."));
    } finally {
      setAdding(false);
    }
  };

  const changeRole = async (person: CollaboratorDto, next: FolderRole) => {
    const target = folder;
    if (!target || busyLogins.has(person.login)) return;
    setBusy(person.login, true);
    setActionError(null);
    try {
      await api.folders.addCollaborator(target.id, person.login, next, { change: true });
      if (currentFolder.current === target.id) {
        setPeople((current) =>
          current ? { ...current, collaborators: current.collaborators.map((item) => (item.login === person.login ? { ...item, role: next } : item)) } : current,
        );
      }
    } catch (error) {
      if (currentFolder.current === target.id) setActionError(apiErrorText(error, `Could not change ${person.login}'s role.`));
    } finally {
      setBusy(person.login, false);
    }
  };

  const remove = async (person: CollaboratorDto) => {
    const target = folder;
    if (!target || busyLogins.has(person.login)) return;
    setBusy(person.login, true);
    setActionError(null);
    try {
      await api.folders.removeCollaborator(target.id, person.login);
      if (currentFolder.current === target.id) {
        setPeople((current) =>
          current ? { ...current, collaborators: current.collaborators.filter((item) => item.login !== person.login) } : current,
        );
      }
    } catch (error) {
      if (currentFolder.current === target.id) setActionError(apiErrorText(error, `Could not remove ${person.login}.`));
    } finally {
      setBusy(person.login, false);
    }
  };

  const excluded = [...(people?.owner?.login ? [people.owner.login] : []), ...(people?.collaborators ?? []).map((person) => person.login)];

  return (
    <Dialog open={folder !== null} onOpenChange={onOpenChange}>
      <DialogContent
        title={`Share “${folder?.name ?? "folder"}”`}
        description="Everyone you add gets this role on every document in the folder, including new ones."
        className="max-h-[calc(100dvh-2rem)] overflow-y-auto"
      >
        <div className="flex flex-col gap-4" data-testid="folder-share-dialog">
          <form className="flex gap-2" onSubmit={(event) => void add(event)}>
            <CollaboratorLoginInput
              ref={loginInput}
              value={login}
              onChange={(value) => {
                setLogin(value);
                setAddError(null);
              }}
              exclude={excluded}
              onPick={focusRole}
            />
            <select ref={roleSelect} className="select" value={role} onChange={(event) => setRole(event.target.value as FolderRole)} aria-label="Role for new folder collaborator">
              {FOLDER_ROLE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
            <button type="submit" className="btn btn-primary" disabled={!isValidLogin(login) || adding} data-testid="folder-share-add">
              {adding ? "Adding…" : "Add"}
            </button>
          </form>
          {addError && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-danger dark:bg-red-950/40" role="alert">{addError}</p>}
          {addNote && <p className="text-xs text-ink-3" role="status">{addNote}</p>}
          <section aria-label="People with folder access">
            {loading ? (
              <p className="py-4 text-center text-sm text-ink-3" role="status">Loading…</p>
            ) : loadError ? (
              <div className="rounded-lg bg-red-50 px-3 py-3 text-sm text-danger dark:bg-red-950/40" role="alert">
                {loadError}
                <button type="button" className="btn btn-outline btn-sm ml-2" onClick={() => setRetry((value) => value + 1)}>Retry</button>
              </div>
            ) : (
              <ul className="flex flex-col divide-y divide-line rounded-xl border border-line">
                {people?.owner && (
                  <li className="flex items-center gap-3 px-3 py-2.5">
                    <Avatar name={people.owner.name ?? people.owner.login ?? "Owner"} src={people.owner.image} size={32} />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium text-ink">{people.owner.name ?? people.owner.login}</div>
                      {people.owner.login && <div className="truncate text-xs text-ink-3">@{people.owner.login}</div>}
                    </div>
                    <span className="text-xs font-medium text-ink-3">Owner</span>
                  </li>
                )}
                {(people?.collaborators ?? []).map((person) => (
                  <li key={person.login} className="flex items-center gap-3 px-3 py-2.5" aria-busy={busyLogins.has(person.login) || undefined}>
                    <Avatar name={person.name ?? person.login} src={person.image ?? `https://avatars.githubusercontent.com/${person.login}?s=64`} size={32} />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium text-ink">{person.name ?? person.login}</div>
                      <div className="truncate text-xs text-ink-3">@{person.login}</div>
                    </div>
                    <select
                      className="select h-8 text-xs"
                      value={person.role}
                      aria-label={`Role for ${person.login}`}
                      aria-disabled={busyLogins.has(person.login) || undefined}
                      onChange={(event) => void changeRole(person, event.target.value as FolderRole)}
                    >
                      {FOLDER_ROLE_OPTIONS.map((option) => (
                        <option key={option.value} value={option.value}>{option.label}</option>
                      ))}
                    </select>
                    <button
                      type="button"
                      className="icon-btn h-8 w-8 text-ink-3 hover:text-danger"
                      aria-label={`Remove ${person.login}`}
                      aria-disabled={busyLogins.has(person.login) || undefined}
                      onClick={() => void remove(person)}
                    >
                      <Trash2 size={15} aria-hidden="true" />
                    </button>
                  </li>
                ))}
                {people?.collaborators.length === 0 && <li className="px-3 py-3 text-sm text-ink-3">No one else has access yet.</li>}
              </ul>
            )}
            {actionError && <p className="mt-2 text-sm text-danger" role="alert">{actionError}</p>}
          </section>
          <div className="flex justify-end">
            <button type="button" className="btn btn-primary" onClick={() => onOpenChange(false)}>Done</button>
          </div>
        </div>
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
  const ownedFolders = folders.filter((folder) => folder.role === "owner");
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
      {ownedFolders.map((folder) => (
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
      {ownedFolders.length === 0 && <MenuItem disabled>No folders yet</MenuItem>}
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
