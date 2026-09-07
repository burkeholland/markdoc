"use client";

import { memo, useCallback, useEffect, useId, useRef, useState, type RefObject } from "react";
import { BookOpen, Bot, Check, ChevronDown, Copy, Globe, Link2, Loader2, Lock, Trash2 } from "lucide-react";
import type { DocumentDto } from "@/server/dto";
import type { Role } from "@/server/db/schema";
import { api, apiErrorText, type CollaboratorDto } from "@/lib/api";
import { useCopy } from "@/lib/hooks";
import { Avatar, Dialog, DialogContent } from "@/components/ui/primitives";
import { CollaboratorLoginInput } from "@/components/editor/collaborator-login-input";
import { TokensPanel } from "@/components/settings/tokens-panel";
import { cn } from "@/lib/utils";

const LINK_OPTIONS: { value: DocumentDto["linkAccess"]; label: string; description: string }[] = [
  { value: "private", label: "Restricted", description: "Only people added above can open this document." },
  { value: "view", label: "Anyone with the link can view", description: "Signed-out visitors can read the document." },
  { value: "comment", label: "Anyone with the link can comment", description: "Signed-in visitors can comment; others can read." },
  { value: "edit", label: "Anyone with the link can edit", description: "Signed-in visitors can edit; others can read." },
];

type CollaboratorOwner = { login: string | null; name: string | null; image: string | null };
type CollaboratorListState =
  | { documentId: string; status: "loading" }
  | { documentId: string; status: "error"; message: string; retrying: boolean }
  | { documentId: string; status: "loaded"; owner: CollaboratorOwner | null; collaborators: CollaboratorDto[] };
type PermissionContext = { documentId: string };
type PermissionOperation = { context: PermissionContext; documentId: string };
type CollaboratorPermissionOperation = PermissionOperation & { login: string; kind: "role" | "remove" };
type LinkPermissionOperation = PermissionOperation & { kind: "link" };

export const ShareDialog = memo(function ShareDialog({
  open,
  onOpenChange,
  doc,
  isOwner,
  onDocChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  doc: DocumentDto;
  isOwner: boolean;
  onDocChange: (doc: DocumentDto) => void;
}) {
  const [collaboratorList, setCollaboratorList] = useState<CollaboratorListState | null>(null);
  const listRequest = useRef(0);
  const listPending = useRef<{ request: number; documentId: string } | null>(null);
  const [login, setLogin] = useState("");
  const [role, setRole] = useState<Exclude<Role, "owner">>("editor");
  const roleSelect = useRef<HTMLSelectElement>(null);
  const [busy, setBusy] = useState(false);
  const addRequest = useRef(0);
  const addPending = useRef<{ request: number; documentId: string } | null>(null);
  const [addError, setAddError] = useState<{ documentId: string; message: string } | null>(null);
  const permissionContext = useRef<PermissionContext | null>(null);
  const collaboratorPermissionOwners = useRef(new Map<string, CollaboratorPermissionOperation>());
  const linkPermissionOwner = useRef<LinkPermissionOperation | null>(null);
  const permissionFeedbackOwner = useRef<PermissionOperation | null>(null);
  const [collaboratorPermissionOperations, setCollaboratorPermissionOperations] = useState<Map<string, CollaboratorPermissionOperation>>(() => new Map());
  const [linkPermissionOperation, setLinkPermissionOperation] = useState<LinkPermissionOperation | null>(null);
  const [actionError, setActionError] = useState<{ operation: PermissionOperation; message: string } | null>(null);
  const [origin, setOrigin] = useState("");
  useEffect(() => setOrigin(window.location.origin), []);
  const readerLink = `${origin}/p/${doc.id}`;
  const editorLink = `${origin}/d/${doc.id}`;
  const readerLinkEl = useRef<HTMLElement>(null);
  // Copy link has no visible text of its own; when both copy paths fail the URL is shown selected instead
  // and stays until it is copied or the dialog closes.
  const linkFallback = useRef<HTMLInputElement>(null);
  const link = useCopy(editorLink, linkFallback, "Copy link");
  const [showLinkFallback, setShowLinkFallback] = useState(false);
  useEffect(() => {
    if (link.status === "fallback") setShowLinkFallback(true);
    else if (link.status === "copied") setShowLinkFallback(false);
  }, [link.status]);
  useEffect(() => {
    if (!open) setShowLinkFallback(false);
  }, [open]);
  useEffect(() => {
    if (showLinkFallback) {
      linkFallback.current?.focus({ preventScroll: true });
      linkFallback.current?.select();
    }
  }, [showLinkFallback]);

  const loadCollaborators = useCallback(async (documentId: string, mode: "load" | "retry" = "load", supersede = false) => {
    if (!supersede && listPending.current?.documentId === documentId) return;

    const ownership = { request: ++listRequest.current, documentId };
    listPending.current = ownership;
    setCollaboratorList((current) =>
      mode === "retry" && current?.documentId === documentId && current.status === "error"
        ? { ...current, retrying: true }
        : { documentId, status: "loading" },
    );
    try {
      const res = await api.documents.collaborators(documentId);
      if (listPending.current !== ownership || listRequest.current !== ownership.request) return;
      setCollaboratorList({ documentId, status: "loaded", owner: res.owner, collaborators: res.collaborators });
    } catch (e) {
      if (listPending.current !== ownership || listRequest.current !== ownership.request) return;
      setCollaboratorList({ documentId, status: "error", message: apiErrorText(e, "Could not load collaborators"), retrying: false });
    } finally {
      if (listPending.current === ownership) listPending.current = null;
    }
  }, []);

  useEffect(() => {
    listRequest.current += 1;
    listPending.current = null;
    addRequest.current += 1;
    addPending.current = null;
    setBusy(false);
    setAddError(null);
    if (!open) {
      setCollaboratorList(null);
      return;
    }
    setCollaboratorList({ documentId: doc.id, status: "loading" });
    void loadCollaborators(doc.id);
    return () => {
      listRequest.current += 1;
      listPending.current = null;
      addRequest.current += 1;
      addPending.current = null;
    };
  }, [open, doc.id, loadCollaborators]);

  useEffect(() => {
    const context = open ? { documentId: doc.id } : null;
    const collaboratorOwners = collaboratorPermissionOwners.current;
    permissionContext.current = context;
    collaboratorOwners.clear();
    linkPermissionOwner.current = null;
    permissionFeedbackOwner.current = null;
    setCollaboratorPermissionOperations(new Map());
    setLinkPermissionOperation(null);
    setActionError(null);

    return () => {
      if (permissionContext.current !== context) return;
      permissionContext.current = null;
      collaboratorOwners.clear();
      linkPermissionOwner.current = null;
      permissionFeedbackOwner.current = null;
    };
  }, [open, doc.id]);

  const currentList = collaboratorList?.documentId === doc.id ? collaboratorList : null;
  const collabs = currentList?.status === "loaded" ? currentList.collaborators : null;
  const owner = currentList?.status === "loaded" ? currentList.owner : null;
  const currentAddError = addError?.documentId === doc.id ? addError.message : null;
  const currentActionError = actionError?.operation.documentId === doc.id ? actionError.message : null;
  const currentLinkPermissionOperation = linkPermissionOperation?.documentId === doc.id ? linkPermissionOperation : null;

  const add = async () => {
    if (!login.trim() || addPending.current) return;
    const documentId = doc.id;
    const ownership = { request: ++addRequest.current, documentId };
    addPending.current = ownership;
    setBusy(true);
    setAddError(null);
    try {
      await api.documents.addCollaborator(documentId, login.trim(), role);
      if (addPending.current !== ownership || addRequest.current !== ownership.request) return;
      setLogin("");
      await loadCollaborators(documentId, "load", true);
    } catch (e) {
      if (addPending.current === ownership && addRequest.current === ownership.request) {
        setAddError({ documentId, message: apiErrorText(e, "Could not add collaborator") });
      }
    } finally {
      if (addPending.current === ownership && addRequest.current === ownership.request) {
        addPending.current = null;
        setBusy(false);
      }
    }
  };

  const isCollaboratorPermissionCurrent = (operation: CollaboratorPermissionOperation) =>
    permissionContext.current === operation.context && collaboratorPermissionOwners.current.get(operation.login) === operation;

  const isLinkPermissionCurrent = (operation: LinkPermissionOperation) =>
    permissionContext.current === operation.context && linkPermissionOwner.current === operation;

  const claimPermissionFeedback = (operation: PermissionOperation) => {
    permissionFeedbackOwner.current = operation;
    setActionError(null);
  };

  const setPermissionError = (operation: PermissionOperation, message: string) => {
    if (permissionContext.current === operation.context && permissionFeedbackOwner.current === operation) {
      setActionError({ operation, message });
    }
  };

  const beginCollaboratorPermission = (login: string, kind: CollaboratorPermissionOperation["kind"]) => {
    const context = permissionContext.current;
    if (!context || context.documentId !== doc.id || collaboratorPermissionOwners.current.has(login)) return null;
    const operation = { context, documentId: doc.id, login, kind };
    collaboratorPermissionOwners.current.set(login, operation);
    claimPermissionFeedback(operation);
    setCollaboratorPermissionOperations((current) => new Map(current).set(login, operation));
    return operation;
  };

  const finishCollaboratorPermission = (operation: CollaboratorPermissionOperation) => {
    if (!isCollaboratorPermissionCurrent(operation)) return;
    collaboratorPermissionOwners.current.delete(operation.login);
    setCollaboratorPermissionOperations((current) => {
      if (current.get(operation.login) !== operation) return current;
      const next = new Map(current);
      next.delete(operation.login);
      return next;
    });
  };

  const changeRole = async (c: CollaboratorDto, next: Exclude<Role, "owner">) => {
    const operation = beginCollaboratorPermission(c.login, "role");
    if (!operation) return;
    try {
      await api.documents.addCollaborator(operation.documentId, c.login, next);
      if (!isCollaboratorPermissionCurrent(operation)) return;
      setCollaboratorList((current) =>
        current?.documentId === operation.documentId && current.status === "loaded"
          ? { ...current, collaborators: current.collaborators.map((x) => (x.login === c.login ? { ...x, role: next } : x)) }
          : current,
      );
    } catch (e) {
      if (isCollaboratorPermissionCurrent(operation)) {
        setPermissionError(operation, apiErrorText(e, "Could not change collaborator role"));
      }
    } finally {
      finishCollaboratorPermission(operation);
    }
  };

  const remove = async (c: CollaboratorDto) => {
    const operation = beginCollaboratorPermission(c.login, "remove");
    if (!operation) return;
    try {
      await api.documents.removeCollaborator(operation.documentId, c.login);
      if (!isCollaboratorPermissionCurrent(operation)) return;
      setCollaboratorList((current) =>
        current?.documentId === operation.documentId && current.status === "loaded"
          ? { ...current, collaborators: current.collaborators.filter((x) => x.login !== c.login) }
          : current,
      );
    } catch (e) {
      if (isCollaboratorPermissionCurrent(operation)) {
        setPermissionError(operation, apiErrorText(e, "Could not remove collaborator"));
      }
    } finally {
      finishCollaboratorPermission(operation);
    }
  };

  const setLink = async (value: DocumentDto["linkAccess"]) => {
    const context = permissionContext.current;
    if (!context || context.documentId !== doc.id || linkPermissionOwner.current) return;
    const operation: LinkPermissionOperation = { context, documentId: doc.id, kind: "link" };
    linkPermissionOwner.current = operation;
    claimPermissionFeedback(operation);
    setLinkPermissionOperation(operation);
    try {
      const res = await api.documents.patch(operation.documentId, { linkAccess: value });
      if (!isLinkPermissionCurrent(operation)) return;
      onDocChange(res.document);
    } catch (e) {
      if (isLinkPermissionCurrent(operation)) {
        setPermissionError(operation, apiErrorText(e, "Could not change link access"));
      }
    } finally {
      if (isLinkPermissionCurrent(operation)) {
        linkPermissionOwner.current = null;
        setLinkPermissionOperation((current) => (current === operation ? null : current));
      }
    }
  };

  const linkOption = LINK_OPTIONS.find((o) => o.value === doc.linkAccess);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title={`Share “${doc.title}”`} description="Collaborators sign in with GitHub. Add people by their GitHub handle." className="max-h-[calc(100dvh-2rem)] overflow-y-auto">
        {isOwner && (
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void add();
            }}
          >
            <CollaboratorLoginInput
              value={login}
              onChange={setLogin}
              exclude={[...(owner?.login ? [owner.login] : []), ...(collabs?.map((c) => c.login) ?? [])]}
              onPick={() => roleSelect.current?.focus()}
            />
            <select ref={roleSelect} className="select" value={role} onChange={(e) => setRole(e.target.value as Exclude<Role, "owner">)} aria-label="Role for new collaborator" data-testid="share-role">
              <option value="editor">Editor</option>
              <option value="commenter">Commenter</option>
              <option value="viewer">Viewer</option>
            </select>
            <button type="submit" className="btn btn-primary" disabled={busy || !login.trim()} data-testid="share-add">
              {busy ? <Loader2 size={16} className="animate-spin" /> : "Add"}
            </button>
          </form>
        )}
        {currentAddError && (
          <div className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-danger dark:bg-red-950/40" role="alert" aria-atomic="true" data-testid="share-add-error">
            {currentAddError}
          </div>
        )}
        {currentActionError && (
          <div className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-danger dark:bg-red-950/40" role="alert" aria-atomic="true" data-testid="share-action-error">
            {currentActionError}
          </div>
        )}

        <div className="mt-5">
          <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-ink-3">People with access</div>
          <ul className="flex flex-col divide-y divide-line rounded-xl border border-line">
            {(!currentList || currentList.status === "loading") && (
              <li className="flex items-center justify-center gap-2 px-3 py-4 text-sm text-ink-3" role="status" aria-live="polite" aria-atomic="true" data-testid="collaborator-list-loading">
                <Loader2 size={15} className="animate-spin" aria-hidden="true" />
                Loading collaborators…
              </li>
            )}
            {currentList?.status === "error" && (
              <li className="bg-red-50 px-3 py-3 text-sm text-danger dark:bg-red-950/40" role="alert" aria-atomic="true" data-testid="collaborator-list-error">
                <div>{currentList.message}</div>
                <button
                  type="button"
                  className="btn btn-outline btn-sm mt-2 gap-1.5"
                  onClick={() => void loadCollaborators(doc.id, "retry")}
                  disabled={currentList.retrying}
                >
                  {currentList.retrying && <Loader2 size={13} className="animate-spin" aria-hidden="true" />}
                  {currentList.retrying ? "Retrying…" : "Retry"}
                </button>
              </li>
            )}
            {owner && (
              <li className="flex items-center gap-3 px-3 py-2.5">
                <Avatar name={owner.name ?? owner.login ?? "Owner"} src={owner.image} size={32} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium text-ink">{owner.name ?? owner.login}</div>
                  {owner.login && <div className="truncate text-xs text-ink-3">@{owner.login}</div>}
                </div>
                <span className="text-xs font-medium text-ink-3">Owner</span>
              </li>
            )}
            {collabs?.map((c) => {
              const operation = collaboratorPermissionOperations.get(c.login);
              const pending = operation?.documentId === doc.id;
              return (
                <li key={c.login} className="flex items-center gap-3 px-3 py-2.5" data-testid="collaborator-row">
                  <Avatar name={c.name ?? c.login} src={c.image ?? `https://avatars.githubusercontent.com/${c.login}?s=64`} size={32} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium text-ink">{c.name ?? c.login}</div>
                    <div className="truncate text-xs text-ink-3">@{c.login}</div>
                  </div>
                  {isOwner ? (
                    <>
                      <select
                        className="select h-8 text-xs"
                        value={c.role}
                        onChange={(e) => void changeRole(c, e.target.value as Exclude<Role, "owner">)}
                        aria-label={`Role for ${c.login}`}
                        disabled={pending}
                      >
                        <option value="editor">Editor</option>
                        <option value="commenter">Commenter</option>
                        <option value="viewer">Viewer</option>
                      </select>
                      <button
                        type="button"
                        className="icon-btn h-8 w-8 text-ink-3 hover:text-danger"
                        onClick={() => void remove(c)}
                        aria-label={`Remove ${c.login}`}
                        disabled={pending}
                      >
                        <Trash2 size={15} />
                      </button>
                    </>
                  ) : (
                    <span className="text-xs font-medium capitalize text-ink-3">{c.role}</span>
                  )}
                </li>
              );
            })}
            {collabs && collabs.length === 0 && <li className="px-3 py-3 text-sm text-ink-3">Nobody else has been added yet.</li>}
          </ul>
          {/* The link the people above open, in the same shape as the Reader link row under General access. */}
          <div className="mt-2 flex items-center gap-2 rounded-lg bg-surface-2 px-2.5 py-1.5 text-xs" data-testid="editor-link">
            <Link2 size={13} className="shrink-0 text-ink-3" />
            <span className="shrink-0 text-ink-3">Link:</span>
            {showLinkFallback ? (
              <input
                ref={linkFallback}
                className="input h-7 min-w-0 flex-1 px-2 font-mono text-[11px]"
                value={editorLink}
                readOnly
                aria-label="Document link"
                onFocus={(e) => e.currentTarget.select()}
                data-testid="copy-link-fallback"
              />
            ) : (
              <code className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink-2">{editorLink}</code>
            )}
            <button type="button" className="btn btn-sm btn-ghost shrink-0 gap-1.5" onClick={link.copy} data-testid="copy-link">
              {link.copied ? <Check size={14} className="text-success" /> : <Copy size={14} />}
              {link.label}
            </button>
          </div>
          <p className="mt-1.5 text-xs text-ink-3" data-testid="copy-link-hint">
            {doc.linkAccess === "private" ? "Anyone listed above can open this link." : linkOption?.description}
          </p>
        </div>

        <div className="mt-5">
          <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-ink-3">General access</div>
          <div className="flex items-start gap-3 rounded-xl border border-line p-3">
            <span className={cn("mt-0.5 flex h-8 w-8 items-center justify-center rounded-full", doc.linkAccess === "private" ? "bg-surface-3 text-ink-2" : "bg-green-50 text-green-700 dark:bg-green-950/40 dark:text-green-300")}>
              {doc.linkAccess === "private" ? <Lock size={15} /> : <Globe size={15} />}
            </span>
            <div className="min-w-0 flex-1">
              {isOwner ? (
                <select
                  className="select w-full"
                  value={doc.linkAccess}
                  onChange={(e) => void setLink(e.target.value as DocumentDto["linkAccess"])}
                  aria-label="Link access"
                  data-testid="link-access"
                  disabled={currentLinkPermissionOperation !== null}
                >
                  {LINK_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value} disabled={currentLinkPermissionOperation !== null}>
                      {o.label}
                    </option>
                  ))}
                </select>
              ) : (
                <div className="text-sm font-medium text-ink">{linkOption?.label}</div>
              )}
              <p className="mt-1 text-xs text-ink-3">{linkOption?.description}</p>
              {doc.linkAccess !== "private" && (
                <div className="mt-2 flex items-center gap-2 rounded-lg bg-surface-2 px-2.5 py-1.5 text-xs" data-testid="reader-link">
                  <BookOpen size={13} className="shrink-0 text-ink-3" />
                  <span className="shrink-0 text-ink-3">Reader link:</span>
                  <code ref={readerLinkEl} className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink-2">
                    {readerLink}
                  </code>
                  <CopyButton text={readerLink} label="Copy" testId="copy-reader-link" target={readerLinkEl} />
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="mt-5">
          <AgentCollaborateCard origin={origin} open={open} docId={doc.id} onClose={() => onOpenChange(false)} />
        </div>

        <div className="mt-5 flex justify-end" data-testid="share-footer">
          <button type="button" className="btn btn-primary shrink-0" onClick={() => onOpenChange(false)}>
            Done
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
});

export function CopyButton({ text, label = "Copy", testId, target }: { text: string; label?: string; testId?: string; target?: RefObject<HTMLElement | null> }) {
  const { copy, label: buttonLabel, copied } = useCopy(text, target, label);
  return (
    <button type="button" className="btn btn-sm btn-ghost gap-1.5" data-testid={testId} onClick={copy}>
      {copied ? <Check size={14} className="text-success" /> : <Copy size={14} />}
      {buttonLabel}
    </button>
  );
}

/** The editor and Settings share one manager; closing this card discards its one-time secret. */
export function AgentCollaborateCard({ origin, open, docId, onClose }: { origin: string; open: boolean; docId: string; onClose?: () => void }) {
  const [expanded, setExpanded] = useState(false);
  const id = useId();
  const panelId = `${id}-panel`;

  return (
    <section className="rounded-xl border border-violet-200 bg-violet-50/60 dark:border-violet-900 dark:bg-violet-950/30" aria-label="Collaborate with an agent" data-testid="share-agent-card">
      <button
        type="button"
        className="flex w-full items-center gap-3 rounded-xl p-3 text-left hover:bg-violet-100/60 dark:hover:bg-violet-900/30"
        aria-expanded={expanded}
        aria-controls={panelId}
        onClick={() => setExpanded((v) => !v)}
        data-testid="share-agent-toggle"
      >
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-violet-100 text-violet-700 dark:bg-violet-900/60 dark:text-violet-300">
          <Bot size={15} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium text-ink">Collaborate with an agent</span>
          <span className="block truncate text-xs text-ink-3">Connect Copilot CLI or any MCP client as a collaborator</span>
        </span>
        <ChevronDown size={16} className={cn("shrink-0 text-ink-3 transition-transform", expanded && "rotate-180")} aria-hidden="true" />
      </button>
      <div id={panelId} hidden={!expanded} className="px-3 pb-3">
        <TokensPanel origin={origin} userLogin="you" documentId={docId} embedded open={open && expanded} onClose={onClose} />
      </div>
    </section>
  );
}
