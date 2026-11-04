"use client";

import { memo, useCallback, useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import { BookOpen, Bot, Check, ChevronRight, Copy, Folder, Globe, Link2, Loader2, Lock, Trash2 } from "lucide-react";
import type { DocumentDto } from "@/server/dto";
import type { Role } from "@/server/db/schema";
import { ApiError, api, apiErrorText, type CollaboratorDto } from "@/lib/api";
import { useCopy } from "@/lib/hooks";
import { Avatar, Dialog, DialogContent } from "@/components/ui/primitives";
import { CollaboratorLoginInput, isValidLogin, type CollaboratorLoginInputHandle } from "@/components/editor/collaborator-login-input";
import { markNotificationRead } from "@/lib/notifications-store";
import { cn } from "@/lib/utils";

type CollaboratorRole = Exclude<Role, "owner">;
type LinkAccess = DocumentDto["linkAccess"];
type Owner = { login: string | null; name: string | null; image: string | null };
type People = Awaited<ReturnType<typeof api.documents.collaborators>>;
type AccessRequest = { login: string; name: string | null; notificationId: string | null };

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
  | { status: "loaded"; documentId: string; owner: Owner | null; collaborators: CollaboratorDto[]; folder: People["folder"] };

const ERROR_CLASS = "rounded-lg bg-red-50 px-3 py-2 text-sm text-danger wrap-anywhere dark:bg-red-950/40";

/** An add the server refused because the person already has another role: who, and the role they keep. */
type Refusal = { login: string; role: CollaboratorRole };

/** Reads `409 { code: "already-collaborator", login, role }` (POST /api/documents/[id]/collaborators); null for any other failure. */
function refusalOf(error: unknown): Refusal | null {
  if (!(error instanceof ApiError) || error.status !== 409 || error.body?.code !== "already-collaborator") return null;
  const { login, role } = error.body;
  const known = ROLE_OPTIONS.find((option) => option.value === role);
  return typeof login === "string" && known ? { login, role: known.value } : null;
}

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
      <button type="button" className="btn btn-sm btn-ghost shrink-0 gap-1.5 max-sm:min-h-11" onClick={copy} data-testid={copyTestId}>
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
  accessRequest,
  onAccessRequestClosed,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  doc: DocumentDto;
  isOwner: boolean;
  onDocChange: (doc: DocumentDto) => void;
  /** Shows the "Connect an AI agent" row; called once Share has closed. */
  onConnectAgent?: () => void;
  accessRequest?: AccessRequest | null;
  onAccessRequestClosed?: () => void;
}) {
  const [list, setList] = useState<ListState>({ status: "loading" });
  const [retry, setRetry] = useState(0);
  const [login, setLogin] = useState("");
  const [role, setRole] = useState<CollaboratorRole>("editor");
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [refused, setRefused] = useState<Refusal | null>(null);
  const [addNote, setAddNote] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyLogins, setBusyLogins] = useState<ReadonlySet<string>>(new Set());
  const [linkBusy, setLinkBusy] = useState(false);
  const [requestBusy, setRequestBusy] = useState(false);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [origin, setOrigin] = useState("");
  const previewId = useId();
  const roleSelect = useRef<HTMLSelectElement>(null);
  // Stable identity: the handle box keys its bindings on its callbacks, so a new function on every render would make it rebuild them.
  const focusRole = useCallback(() => roleSelect.current?.focus(), []);
  const loginInput = useRef<CollaboratorLoginInputHandle>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  const resolvingRequest = useRef(false);
  // What is shown under the field answers the handle that was submitted: it goes when the text changes.
  const changeLogin = useCallback((value: string) => {
    setLogin(value);
    setAddError(null);
    setRefused(null);
  }, []);
  const adder = useRef(false);
  const connectAfterClose = useRef(false);
  const currentDoc = useRef(doc.id);

  useEffect(() => {
    currentDoc.current = doc.id;
  }, [doc.id]);
  useEffect(() => setOrigin(window.location.origin), []);
  // A reopened dialog (or another document) starts without the last add's error.
  useEffect(() => {
    if (!open) return;
    setAddError(null);
    setRefused(null);
  }, [open, doc.id]);
  useEffect(() => {
    if (!open || !accessRequest) return;
    setRequestError(null);
  }, [open, doc.id, accessRequest]);

  /** Shows a list the server just sent. "Already has access" is only true while the person is in the list it points to. */
  const showPeople = useCallback((documentId: string, res: People) => {
    setList({ status: "loaded", documentId, owner: res.owner, collaborators: res.collaborators, folder: res.folder });
    setRefused((current) => (current && !res.collaborators.some((c) => c.login === current.login) ? null : current));
  }, []);

  // A response that arrives after the dialog closed, or for another document, is dropped.
  useEffect(() => {
    if (!open || accessRequest) return;
    let stale = false;
    const documentId = doc.id;
    setList((current) => (current.status === "loaded" && current.documentId === documentId ? current : { status: "loading" }));
    api.documents.collaborators(documentId).then(
      (res) => {
        if (!stale) showPeople(documentId, res);
      },
      (e) => {
        if (!stale) setList({ status: "error", message: apiErrorText(e, "Could not load the people with access.") });
      },
    );
    return () => {
      stale = true;
    };
  }, [open, doc.id, retry, showPeople, accessRequest]);

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
  const folder = list.status === "loaded" ? list.folder : null;

  const add = async (event: FormEvent) => {
    event.preventDefault();
    const handle = login.trim();
    if (!isValidLogin(handle) || adder.current) return;
    adder.current = true;
    const documentId = doc.id;
    setAdding(true);
    setAddError(null);
    setRefused(null);
    setAddNote(null);
    const refreshList = async (failure: string) => {
      const res = await api.documents.collaborators(documentId).catch((e: unknown) => {
        if (currentDoc.current === documentId) setList({ status: "error", message: apiErrorText(e, failure) });
        return null;
      });
      if (res && currentDoc.current === documentId) showPeople(documentId, res);
    };
    try {
      const result = await api.documents.addCollaborator(documentId, handle, role);
      if (currentDoc.current !== documentId) return;
      // Add is disabled again once the field is empty; a disabled button cannot keep focus, so a press on Add
      // hands focus to the field (ready for the next handle) instead of dropping it on the dialog.
      if (document.activeElement === addButton.current) loginInput.current?.focus();
      setLogin("");
      if (result.pending) setAddNote(`@${result.login} has not signed in to Markdoc yet. They get access on their first sign-in, so check the spelling.`);
      await refreshList("Added, but the list could not be refreshed.");
    } catch (e) {
      if (currentDoc.current !== documentId) return;
      const refusal = refusalOf(e);
      if (!refusal) {
        setAddError(apiErrorText(e, "Could not add this person."));
        return;
      }
      // Nothing changed on the server. The typed handle stays, and the message points at the person's row: show
      // the role the server just reported there, or fetch the list when this (stale) one does not have them.
      setRefused(refusal);
      const listed = list.status === "loaded" && list.documentId === documentId && list.collaborators.some((c) => c.login === refusal.login);
      if (listed) {
        setList((current) =>
          current.status === "loaded" ? { ...current, collaborators: current.collaborators.map((c) => (c.login === refusal.login ? { ...c, role: refusal.role } : c)) } : current,
        );
      } else {
        await refreshList("Could not load the people with access.");
      }
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
      // `change`: the owner picked a role for someone already listed, so the server may replace the old one.
      await api.documents.addCollaborator(documentId, person.login, next, { change: true });
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
      setRefused((current) => (current?.login === person.login ? null : current));
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

  const resolveAccessRequest = async (grant: boolean) => {
    if (!accessRequest || resolvingRequest.current) return;
    resolvingRequest.current = true;
    setRequestBusy(true);
    setRequestError(null);
    const documentId = doc.id;
    const login = accessRequest.login.replace(/^@/, "");
    try {
      if (grant) {
        try {
          await api.documents.addCollaborator(documentId, login, "viewer");
        } catch (e) {
          const refusal = refusalOf(e);
          if (refusal?.login.toLowerCase() !== login.toLowerCase()) {
            if (currentDoc.current === documentId) setRequestError(apiErrorText(e, "Could not grant access."));
            return;
          }
        }
      }
      if (accessRequest.notificationId) await markNotificationRead(accessRequest.notificationId);
      if (currentDoc.current === documentId) onOpenChange(false);
    } catch (e) {
      if (currentDoc.current === documentId) setRequestError(apiErrorText(e, "Could not mark this request as resolved."));
    } finally {
      resolvingRequest.current = false;
      setRequestBusy(false);
    }
  };

  const linkOption = LINK_OPTIONS.find((option) => option.value === doc.linkAccess) ?? LINK_OPTIONS[0];
  const restricted = doc.linkAccess === "private";
  const editorLink = `${origin}/d/${doc.id}`;
  const readerLink = `${origin}/p/${doc.id}`;
  const requestLogin = accessRequest?.login.replace(/^@/, "") ?? "";
  const requestName = accessRequest?.name?.trim();
  const requestLabel = requestName ? `${requestName} (@${requestLogin})` : `@${requestLogin}`;
  const validRequestLogin = Boolean(accessRequest && isValidLogin(requestLogin));
  const excluded = [...(owner?.login ? [owner.login] : []), ...collaborators.map((c) => c.login)];
  // The role comes from the person's row when it is listed, so the sentence and the row below never disagree.
  const refusedRole = refused ? (collaborators.find((c) => c.login === refused.login)?.role ?? refused.role) : null;
  const addProblem = refused
    ? `@${refused.login} already has access as ${ROLE_OPTIONS.find((option) => option.value === refusedRole)?.label}. Change the role in the list below.`
    : addError;
  // One press is one add: a held key's repeats (33 ms apart) never start another, in the field or on Add.
  const ignoreRepeatedEnter = (event: KeyboardEvent<HTMLFormElement>) => {
    if (event.key !== "Enter" || !event.repeat) return;
    event.preventDefault();
    event.stopPropagation();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title={accessRequest ? "Access request" : `Share “${doc.title}”`}
        description={accessRequest ? `${requestLabel} requested access to “${doc.title}”.` : "Add people by GitHub handle. They sign in with GitHub."}
        className="max-h-[calc(100dvh-2rem)] overflow-y-auto"
        closeButtonClassName="max-sm:min-h-11 max-sm:min-w-11"
        onClosed={() => {
          if (accessRequest) onAccessRequestClosed?.();
          if (!connectAfterClose.current) return;
          connectAfterClose.current = false;
          onConnectAgent?.();
        }}
      >
        {accessRequest ? (
          <div className="flex flex-col gap-4" data-testid="access-request">
            <p className="text-sm text-ink-2">Granting gives view access only.</p>
            {!validRequestLogin && <div className={ERROR_CLASS} role="alert">This request does not include a valid GitHub handle.</div>}
            {requestError && <div className={ERROR_CLASS} role="alert" data-testid="access-request-error">{requestError}</div>}
            {!isOwner && <p className="text-sm text-ink-3">Only the document owner can respond to this request.</p>}
            <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
              {isOwner ? (
                <>
                  <button
                    type="button"
                    className="btn btn-outline shrink-0 aria-disabled:opacity-50"
                    aria-disabled={requestBusy || undefined}
                    aria-busy={requestBusy || undefined}
                    onClick={() => void resolveAccessRequest(false)}
                    data-testid="access-request-deny"
                  >
                    Deny request
                  </button>
                  <button
                    type="button"
                    className="btn btn-primary shrink-0 gap-1.5 aria-disabled:opacity-50"
                    disabled={!validRequestLogin}
                    aria-disabled={requestBusy || undefined}
                    aria-busy={requestBusy || undefined}
                    onClick={() => void resolveAccessRequest(true)}
                    data-testid="access-request-grant"
                  >
                    {requestBusy && <Loader2 size={16} className="animate-spin" aria-hidden="true" />}
                    Grant view access
                  </button>
                </>
              ) : (
                <button type="button" className="btn btn-primary shrink-0" onClick={() => onOpenChange(false)}>
                  Done
                </button>
              )}
            </div>
          </div>
        ) : <div className="flex flex-col gap-5" data-testid="share-presentation">
          {isOwner && (
            <div className="flex flex-col gap-2">
              <form className="flex gap-2" onSubmit={(e) => void add(e)} onKeyDownCapture={ignoreRepeatedEnter}>
                <CollaboratorLoginInput ref={loginInput} value={login} onChange={changeLogin} exclude={excluded} onPick={focusRole} />
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
                {/* While an add runs: aria-disabled, not disabled, which would drop focus from a pressed Add to
                    the dialog (same as the link-preview switch below); `add` ignores a press meanwhile. */}
                <button
                  ref={addButton}
                  type="submit"
                  className="btn btn-primary aria-disabled:opacity-50 max-sm:min-h-11"
                  disabled={!isValidLogin(login)}
                  aria-disabled={adding || undefined}
                  aria-busy={adding || undefined}
                  data-testid="share-add"
                >
                  {adding ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : "Add"}
                </button>
              </form>
              {addProblem && (
                <div className={ERROR_CLASS} role="alert" data-testid="share-add-error" data-code={refused ? "already-collaborator" : undefined}>
                  {addProblem}
                </div>
              )}
              {addNote && (
                <p className="text-xs text-ink-3 wrap-anywhere" role="status" data-testid="share-add-note">
                  {addNote}
                </p>
              )}
            </div>
          )}

          {folder && (
            <div className="flex items-start gap-2.5 rounded-xl border border-line bg-surface-2 px-3 py-2.5 text-xs text-ink-3" data-testid="folder-inherited-access">
              <Folder size={14} className="mt-0.5 shrink-0 text-ink-2" aria-hidden="true" />
              <p>
                People shared with <span className="font-medium text-ink-2">{folder.name}</span> also have access to this document. Manage folder access from its menu on the dashboard.
              </p>
            </div>
          )}

          <section aria-labelledby="share-people-heading">
            <h3 id="share-people-heading" className="pane-label mb-2">
              People with access
            </h3>
            <ul className="flex flex-col divide-y divide-line rounded-xl border border-line" aria-label="People with access">
              {list.status === "loading" && (
                <li className="flex items-center justify-center gap-2 px-3 py-4 text-sm text-ink-3" data-testid="collaborator-list-loading">
                  <span role="status" className="flex items-center gap-2">
                    <Loader2 size={15} className="animate-spin" aria-hidden="true" /> Loading…
                  </span>
                </li>
              )}
              {list.status === "error" && (
                <li className="bg-red-50 px-3 py-3 text-sm text-danger dark:bg-red-950/40" data-testid="collaborator-list-error">
                  <div className="wrap-anywhere" role="alert">{list.message}</div>
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
                          {/* Busy: aria-disabled, not disabled, which would drop keyboard focus to the page in the
                              middle of a role change; changeRole and remove ignore a press while the row is busy. */}
                          <select
                            className="select h-8 text-xs aria-disabled:opacity-50"
                            value={person.role}
                            aria-disabled={busy || undefined}
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
                            className="icon-btn h-8 w-8 text-ink-3 hover:text-danger aria-disabled:opacity-40"
                            aria-disabled={busy || undefined}
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
            <button type="button" className="btn btn-primary shrink-0 max-sm:min-h-11" onClick={() => onOpenChange(false)}>
              Done
            </button>
          </div>
        </div>}
      </DialogContent>
    </Dialog>
  );
});
