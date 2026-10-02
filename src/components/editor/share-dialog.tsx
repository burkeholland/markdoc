"use client";

import { memo, useCallback, useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { BookOpen, Bot, Check, ChevronRight, Copy, Globe, Link2, Loader2, Lock, Trash2 } from "lucide-react";
import type { DocumentDto } from "@/server/dto";
import type { Role } from "@/server/db/schema";
import { api, apiErrorText, type CollaboratorDto } from "@/lib/api";
import { useCopy } from "@/lib/hooks";
import { Avatar, Dialog, DialogContent } from "@/components/ui/primitives";
import { CollaboratorLoginInput, isValidLogin } from "@/components/editor/collaborator-login-input";
import { cn } from "@/lib/utils";

type CollaboratorRole = Exclude<Role, "owner">;
type LinkAccess = DocumentDto["linkAccess"];
type Owner = { login: string | null; name: string | null; image: string | null };

const ROLE_OPTIONS: readonly { value: CollaboratorRole; label: string }[] = [
  { value: "editor", label: "Editor" },
  { value: "commenter", label: "Commenter" },
  { value: "viewer", label: "Viewer" },
];

const LINK_OPTIONS: readonly { value: LinkAccess; label: string; description: string }[] = [
  { value: "private", label: "Restricted", description: "Only people added above can open this document." },
  { value: "view", label: "Anyone with the link can view", description: "Signed-out visitors can read the document." },
  { value: "comment", label: "Anyone with the link can comment", description: "Signed-in visitors can comment; others can read." },
  { value: "edit", label: "Anyone with the link can edit", description: "Signed-in visitors can edit; others can read." },
];

type ListState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "loaded"; documentId: string; owner: Owner | null; collaborators: CollaboratorDto[] };

const ERROR_CLASS = "rounded-lg bg-red-50 px-3 py-2 text-sm text-danger wrap-anywhere dark:bg-red-950/40";

/** A URL with a Copy button. When both copy paths fail the URL is selected so the person can finish with Ctrl+C. */
function LinkRow({
  icon,
  url,
  label,
  copyLabel,
  testId,
  copyTestId,
}: {
  icon: ReactNode;
  url: string;
  label?: string;
  copyLabel: string;
  testId: string;
  copyTestId: string;
}) {
  const code = useRef<HTMLElement>(null);
  const { copy, label: buttonText, copied } = useCopy(url, code, copyLabel);
  return (
    <div className="flex items-center gap-2 text-xs" data-testid={testId}>
      <span className="shrink-0 text-ink-3" aria-hidden="true">
        {icon}
      </span>
      {label && <span className="shrink-0 text-ink-3">{label}</span>}
      <code ref={code} className="min-w-0 flex-1 select-text truncate font-mono text-[11px] text-ink-2" title={url}>
        {url}
      </code>
      <button type="button" className="btn btn-sm btn-ghost shrink-0 gap-1.5" onClick={copy} data-testid={copyTestId}>
        {copied ? <Check size={14} className="text-success" aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
        {buttonText}
      </button>
    </div>
  );
}

export const ShareDialog = memo(function ShareDialog({
  open,
  onOpenChange,
  doc,
  isOwner,
  onDocChange,
  onConnectAgent,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  doc: DocumentDto;
  isOwner: boolean;
  onDocChange: (doc: DocumentDto) => void;
  /** Shows the "Connect an AI agent" row; called once Share has closed. */
  onConnectAgent?: () => void;
}) {
  const [list, setList] = useState<ListState>({ status: "loading" });
  const [retry, setRetry] = useState(0);
  const [login, setLogin] = useState("");
  const [role, setRole] = useState<CollaboratorRole>("editor");
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [addNote, setAddNote] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyLogins, setBusyLogins] = useState<ReadonlySet<string>>(new Set());
  const [linkBusy, setLinkBusy] = useState(false);
  const [origin, setOrigin] = useState("");
  const previewId = useId();
  const roleSelect = useRef<HTMLSelectElement>(null);
  // Stable identity: the handle box keys its bindings on its callbacks, so a new function on every render would make it rebuild them.
  const focusRole = useCallback(() => roleSelect.current?.focus(), []);
  const adder = useRef(false);
  const connectAfterClose = useRef(false);
  const currentDoc = useRef(doc.id);

  useEffect(() => {
    currentDoc.current = doc.id;
  }, [doc.id]);
  useEffect(() => setOrigin(window.location.origin), []);

  // A response that arrives after the dialog closed, or for another document, is dropped.
  useEffect(() => {
    if (!open) return;
    let stale = false;
    const documentId = doc.id;
    setList((current) => (current.status === "loaded" && current.documentId === documentId ? current : { status: "loading" }));
    api.documents.collaborators(documentId).then(
      (res) => {
        if (!stale) setList({ status: "loaded", documentId, owner: res.owner, collaborators: res.collaborators });
      },
      (e) => {
        if (!stale) setList({ status: "error", message: apiErrorText(e, "Could not load the people with access.") });
      },
    );
    return () => {
      stale = true;
    };
  }, [open, doc.id, retry]);

  const setBusy = useCallback((who: string, busy: boolean) => {
    setBusyLogins((current) => {
      const next = new Set(current);
      if (busy) next.add(who);
      else next.delete(who);
      return next;
    });
  }, []);

  const collaborators = list.status === "loaded" ? list.collaborators : [];
  const owner = list.status === "loaded" ? list.owner : null;

  const add = async (event: FormEvent) => {
    event.preventDefault();
    const handle = login.trim();
    if (!isValidLogin(handle) || adder.current) return;
    adder.current = true;
    const documentId = doc.id;
    setAdding(true);
    setAddError(null);
    setAddNote(null);
    try {
      const result = await api.documents.addCollaborator(documentId, handle, role);
      if (currentDoc.current !== documentId) return;
      setLogin("");
      if (result.pending) setAddNote(`@${result.login} has not signed in to Markdoc yet. They get access on their first sign-in, so check the spelling.`);
      const res = await api.documents.collaborators(documentId).catch((e: unknown) => {
        if (currentDoc.current === documentId) setList({ status: "error", message: apiErrorText(e, "Added, but the list could not be refreshed.") });
        return null;
      });
      if (res && currentDoc.current === documentId) setList({ status: "loaded", documentId, owner: res.owner, collaborators: res.collaborators });
    } catch (e) {
      if (currentDoc.current === documentId) setAddError(apiErrorText(e, "Could not add this person."));
    } finally {
      adder.current = false;
      setAdding(false);
    }
  };

  const changeRole = async (person: CollaboratorDto, next: CollaboratorRole) => {
    if (busyLogins.has(person.login)) return;
    const documentId = doc.id;
    setBusy(person.login, true);
    setActionError(null);
    try {
      await api.documents.addCollaborator(documentId, person.login, next);
      if (currentDoc.current !== documentId) return;
      setList((current) =>
        current.status === "loaded" ? { ...current, collaborators: current.collaborators.map((c) => (c.login === person.login ? { ...c, role: next } : c)) } : current,
      );
    } catch (e) {
      if (currentDoc.current === documentId) setActionError(apiErrorText(e, `Could not change ${person.login}'s role.`));
    } finally {
      setBusy(person.login, false);
    }
  };

  const remove = async (person: CollaboratorDto) => {
    if (busyLogins.has(person.login)) return;
    const documentId = doc.id;
    setBusy(person.login, true);
    setActionError(null);
    try {
      await api.documents.removeCollaborator(documentId, person.login);
      if (currentDoc.current !== documentId) return;
      setList((current) => (current.status === "loaded" ? { ...current, collaborators: current.collaborators.filter((c) => c.login !== person.login) } : current));
    } catch (e) {
      if (currentDoc.current === documentId) setActionError(apiErrorText(e, `Could not remove ${person.login}.`));
    } finally {
      setBusy(person.login, false);
    }
  };

  // One link change at a time (access or preview): racing responses could land out of order and show a stale setting.
  const patchLink = async (body: { linkAccess?: LinkAccess; linkPreview?: boolean }, failure: string) => {
    if (linkBusy) return;
    const documentId = doc.id;
    setLinkBusy(true);
    setActionError(null);
    try {
      const res = await api.documents.patch(documentId, body);
      if (currentDoc.current === documentId) onDocChange(res.document);
    } catch (e) {
      if (currentDoc.current === documentId) setActionError(apiErrorText(e, failure));
    } finally {
      setLinkBusy(false);
    }
  };

  const linkOption = LINK_OPTIONS.find((option) => option.value === doc.linkAccess) ?? LINK_OPTIONS[0];
  const restricted = doc.linkAccess === "private";
  const editorLink = `${origin}/d/${doc.id}`;
  const readerLink = `${origin}/p/${doc.id}`;
  const excluded = [...(owner?.login ? [owner.login] : []), ...collaborators.map((c) => c.login)];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title={`Share “${doc.title}”`}
        description="Add people by GitHub handle. They sign in with GitHub."
        className="max-h-[calc(100dvh-2rem)] overflow-y-auto"
        onClosed={() => {
          if (!connectAfterClose.current) return;
          connectAfterClose.current = false;
          onConnectAgent?.();
        }}
      >
        <div className="flex flex-col gap-5" data-testid="share-presentation">
          {isOwner && (
            <div className="flex flex-col gap-2">
              <form className="flex gap-2" onSubmit={(e) => void add(e)}>
                <CollaboratorLoginInput value={login} onChange={setLogin} exclude={excluded} onPick={focusRole} />
                <select
                  ref={roleSelect}
                  className="select"
                  value={role}
                  onChange={(e) => setRole(e.target.value as CollaboratorRole)}
                  aria-label="Role for new collaborator"
                  data-testid="share-role"
                >
                  {ROLE_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
                <button type="submit" className="btn btn-primary" disabled={adding || !isValidLogin(login)} data-testid="share-add">
                  {adding ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : "Add"}
                </button>
              </form>
              {addError && (
                <div className={ERROR_CLASS} role="alert" data-testid="share-add-error">
                  {addError}
                </div>
              )}
              {addNote && (
                <p className="text-xs text-ink-3 wrap-anywhere" role="status" data-testid="share-add-note">
                  {addNote}
                </p>
              )}
            </div>
          )}

          <section aria-labelledby="share-people-heading">
            <h3 id="share-people-heading" className="pane-label mb-2">
              People with access
            </h3>
            <ul className="flex flex-col divide-y divide-line rounded-xl border border-line" aria-label="People with access">
              {list.status === "loading" && (
                <li className="flex items-center justify-center gap-2 px-3 py-4 text-sm text-ink-3" role="status" data-testid="collaborator-list-loading">
                  <Loader2 size={15} className="animate-spin" aria-hidden="true" /> Loading…
                </li>
              )}
              {list.status === "error" && (
                <li className="bg-red-50 px-3 py-3 text-sm text-danger dark:bg-red-950/40" role="alert" data-testid="collaborator-list-error">
                  <div className="wrap-anywhere">{list.message}</div>
                  <button type="button" className="btn btn-outline btn-sm mt-2" onClick={() => setRetry((n) => n + 1)} data-testid="collaborator-list-retry">
                    Retry
                  </button>
                </li>
              )}
              {list.status === "loaded" && owner && (
                <li className="flex items-center gap-3 px-3 py-2.5" data-testid="owner-row">
                  <Avatar name={owner.name ?? owner.login ?? "Owner"} src={owner.image} size={32} />
                  <div className="min-w-0 flex-1" title={[owner.name, owner.login && `@${owner.login}`].filter(Boolean).join(" ")}>
                    <div className="truncate text-sm font-medium text-ink">{owner.name ?? owner.login}</div>
                    {owner.login && <div className="truncate text-xs text-ink-3">@{owner.login}</div>}
                  </div>
                  <span className="text-xs font-medium text-ink-3">Owner</span>
                </li>
              )}
              {list.status === "loaded" &&
                collaborators.map((person) => {
                  const busy = busyLogins.has(person.login);
                  return (
                    <li key={person.login} className="flex items-center gap-3 px-3 py-2.5" data-testid="collaborator-row" aria-busy={busy || undefined}>
                      <Avatar name={person.name ?? person.login} src={person.image ?? `https://avatars.githubusercontent.com/${person.login}?s=64`} size={32} />
                      <div className="min-w-0 flex-1" title={[person.name, `@${person.login}`].filter(Boolean).join(" ")}>
                        <div className="truncate text-sm font-medium text-ink">{person.name ?? person.login}</div>
                        <div className="truncate text-xs text-ink-3">@{person.login}</div>
                      </div>
                      {isOwner ? (
                        <>
                          <select
                            className="select h-8 text-xs"
                            value={person.role}
                            disabled={busy}
                            onChange={(e) => void changeRole(person, e.target.value as CollaboratorRole)}
                            aria-label={`Role for ${person.login}`}
                          >
                            {ROLE_OPTIONS.map((option) => (
                              <option key={option.value} value={option.value}>
                                {option.label}
                              </option>
                            ))}
                          </select>
                          <button
                            type="button"
                            className="icon-btn h-8 w-8 text-ink-3 hover:text-danger"
                            disabled={busy}
                            onClick={() => void remove(person)}
                            aria-label={`Remove ${person.login}`}
                          >
                            <Trash2 size={15} aria-hidden="true" />
                          </button>
                        </>
                      ) : (
                        <span className="text-xs font-medium capitalize text-ink-3">{person.role}</span>
                      )}
                    </li>
                  );
                })}
              {list.status === "loaded" && collaborators.length === 0 && <li className="px-3 py-3 text-sm text-ink-3">Nobody else has been added yet.</li>}
            </ul>
            {actionError && (
              <div className={cn(ERROR_CLASS, "mt-2")} role="alert" data-testid="share-action-error">
                {actionError}
              </div>
            )}
          </section>

          <section aria-labelledby="share-link-heading" className="flex flex-col gap-3 rounded-xl border border-line p-3" data-testid="share-link-card">
            <h3 id="share-link-heading" className="sr-only">
              Link access
            </h3>
            <div className="flex items-start gap-3">
              <span
                className={cn(
                  "mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full",
                  restricted ? "bg-surface-3 text-ink-2" : "bg-green-50 text-green-700 dark:bg-green-950/40 dark:text-green-300",
                )}
                aria-hidden="true"
              >
                {restricted ? <Lock size={15} /> : <Globe size={15} />}
              </span>
              <div className="min-w-0 flex-1">
                {isOwner ? (
                  <select
                    className="select w-full"
                    value={doc.linkAccess}
                    disabled={linkBusy}
                    onChange={(e) => void patchLink({ linkAccess: e.target.value as LinkAccess }, "Could not change who can open the link.")}
                    aria-label="Link access"
                    data-testid="link-access"
                  >
                    {LINK_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                ) : (
                  <div className="text-sm font-medium text-ink">{linkOption.label}</div>
                )}
                <p className="mt-1 text-xs text-ink-3">{linkOption.description}</p>
                {/* A link-shared document always previews with its title and first lines: anyone with the link can read it.
                    The hint names all a preview shows: see document-metadata.ts and og/document-card-route.ts.
                    Saving marks the switch aria-disabled, not disabled, which would drop keyboard focus to the page;
                    patchLink ignores a toggle while one is saving. */}
                {restricted && (
                  <div className="mt-3 flex items-start gap-2.5">
                    <button
                      type="button"
                      role="switch"
                      aria-checked={doc.linkPreview === true}
                      aria-labelledby={`${previewId}-label`}
                      aria-describedby={`${previewId}-hint`}
                      aria-disabled={linkBusy || undefined}
                      className="switch mt-px"
                      disabled={!isOwner}
                      onClick={() => void patchLink({ linkPreview: !doc.linkPreview }, "Could not change the link preview.")}
                      data-testid="link-preview"
                    />
                    <div className="min-w-0 text-xs leading-5">
                      <div id={`${previewId}-label`} className="font-medium text-ink-2">
                        Show title and first lines in link previews
                      </div>
                      <div id={`${previewId}-hint`} className="text-ink-3" data-testid="link-preview-hint">
                        {isOwner
                          ? "Slack, Teams and other apps show the title, first lines, your name and when it was last updated."
                          : "Slack, Teams and other apps show the title, first lines, the owner's name and when it was last updated. Only the owner can change this."}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>
            <div className="flex flex-col gap-1.5 border-t border-line pt-3">
              <LinkRow icon={<Link2 size={13} />} url={editorLink} copyLabel="Copy link" testId="editor-link" copyTestId="copy-link" />
              {!restricted && (
                <LinkRow icon={<BookOpen size={13} />} url={readerLink} label="Reader page" copyLabel="Copy" testId="reader-link" copyTestId="copy-reader-link" />
              )}
            </div>
          </section>

          {onConnectAgent && (
            <button
              type="button"
              className="flex w-full items-center gap-3 rounded-xl border border-line px-3 py-2.5 text-left transition-colors hover:bg-surface-2"
              onClick={() => {
                connectAfterClose.current = true;
                onOpenChange(false);
              }}
              data-testid="share-connect-agent"
            >
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-surface-3 text-ink-2" aria-hidden="true">
                <Bot size={15} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium text-ink">Connect an AI agent</span>
                <span className="block truncate text-xs text-ink-3">Works with any MCP client</span>
              </span>
              <ChevronRight size={16} className="shrink-0 text-ink-3" aria-hidden="true" />
            </button>
          )}

          <div className="flex justify-end" data-testid="share-footer">
            <button type="button" className="btn btn-primary shrink-0" onClick={() => onOpenChange(false)}>
              Done
            </button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
});
