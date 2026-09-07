"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { ArrowLeft, Check, Copy, KeyRound, Loader2, Plus } from "lucide-react";
import { cn, relativeTime } from "@/lib/utils";
import { useCopy } from "@/lib/hooks";
import { ApiError, api, apiErrorText, type ApiTokenDto, type CreatedApiTokenDto, type DocumentSummaryDto } from "@/lib/api";
import { SCOPES, TOKEN_SCOPE_LABEL, TOKEN_SCOPE_SUMMARY, type TokenScopeName } from "@/lib/mcp";
import { agentMentionSlug } from "@/editor/collab/mentions";
import { AgentConnectCard, useOrigin } from "@/components/settings/agent-connect-card";

export function ScopeChip({ scope, className }: { scope: TokenScopeName; className?: string }) {
  return (
    <span className={cn("inline-flex rounded-full border border-line bg-surface-2 px-2 py-0.5 font-mono text-[11px] text-ink-2", className)}
      title={`${TOKEN_SCOPE_LABEL[scope]}: ${TOKEN_SCOPE_SUMMARY[scope]}`} data-testid="token-scope-chip" data-scope={scope}>
      {scope}
    </span>
  );
}

function SecretNotice({ created, onDismiss }: { created: CreatedApiTokenDto; onDismiss: () => void }) {
  const code = useRef<HTMLElement>(null);
  const { copy, label, copied } = useCopy(created.token, code);
  return (
    <div className="min-w-0 rounded-xl border border-green-200 bg-green-50 p-3 dark:border-green-900 dark:bg-green-950/40"
      role="status" aria-live="polite" aria-atomic="true" data-testid="token-created">
      <p className="text-sm font-medium text-green-900 dark:text-green-200">Token “{created.name}” created. Copy it now; it will not be shown again.</p>
      <p className="mt-1 text-xs text-ink-2">Store it now in a safe place. Only a hash is saved by Markdoc; the secret cannot be recovered or edited.</p>
      <p className="mt-1 text-xs text-ink-2"><ScopeChip scope={created.scope} /> {created.documentIds ? `${created.documentIds.length} document(s)` : "All documents you can access"}</p>
      <code ref={code} className="mt-2 block select-text break-all rounded-lg border border-line bg-surface px-3 py-2 font-mono text-xs text-ink" data-testid="copy-token">{created.token}</code>
      <div className="mt-2 flex flex-wrap gap-2">
        <button type="button" className="btn btn-outline btn-sm h-auto max-w-full gap-1.5 whitespace-normal text-left" onClick={copy} aria-label="Copy token" data-testid="copy-token-button">
          {copied ? <Check size={14} /> : <Copy size={14} />}{label}
        </button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onDismiss}>I stored it - hide secret</button>
      </div>
    </div>
  );
}

function tokenState(token: ApiTokenDto) {
  return token.revokedAt ? "Revoked" : token.expiresAt && new Date(token.expiresAt).getTime() < Date.now() ? "Expired" : "Active";
}

interface TokensPanelProps {
  origin: string;
  userLogin: string;
  next?: string | null;
  documentId?: string;
  embedded?: boolean;
  open?: boolean;
  onClose?: () => void;
}

type TokenMutationKind = "rename" | "replace" | "revoke" | "collaborators";

interface MountedOperation {
  mount: symbol;
}

interface CreateOperation extends MountedOperation {
  name: string;
  expires: string;
  scope: TokenScopeName;
  restrict: boolean;
  documentIds: string[];
}

interface TokenOperation extends MountedOperation {
  id: string;
  kind: TokenMutationKind;
}

/** Closing a host dialog unmounts all transient state, including late creation responses. */
export function TokensPanel({ open = true, ...props }: TokensPanelProps) {
  return open ? <TokenManager key={props.documentId ?? "settings"} {...props} /> : null;
}

function TokenManager({ origin, userLogin, next, documentId, embedded, onClose }: Omit<TokensPanelProps, "open">) {
  const [tokens, setTokens] = useState<ApiTokenDto[] | null>(null);
  const [loadError, setLoadError] = useState<{ message: string; permission: boolean } | null>(null);
  const [destination, setDestination] = useState<"tokens" | "connect">("tokens");
  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState("GitHub Copilot CLI");
  const [expires, setExpires] = useState("90");
  const [scope, setScope] = useState<TokenScopeName>("comment");
  const [restrict, setRestrict] = useState(Boolean(documentId));
  const [documentIds, setDocumentIds] = useState<string[]>(documentId ? [documentId] : []);
  const [documents, setDocuments] = useState<DocumentSummaryDto[] | null>(null);
  const [documentError, setDocumentError] = useState<string | null>(null);
  const [createPending, setCreatePending] = useState<CreateOperation | null>(null);
  const [pendingActions, setPendingActions] = useState<Record<string, TokenOperation>>({});
  const [error, setError] = useState<string | null>(null);
  const [conflictName, setConflictName] = useState<string | null>(null);
  const [switchErrors, setSwitchErrors] = useState<Record<string, string>>({});
  const [created, setCreated] = useState<CreatedApiTokenDto | null>(null);
  const liveOrigin = useOrigin(origin);
  const id = useId();
  const tokensButton = useRef<HTMLButtonElement>(null);
  const mounted = useRef<symbol | null>(null);
  const createOwner = useRef<CreateOperation | null>(null);
  const tokenOwners = useRef(new Map<string, TokenOperation>());
  const latestTokenOperations = useRef(new Map<string, TokenOperation>());
  const createdRef = useRef<CreatedApiTokenDto | null>(null);
  const loadSeq = useRef(0);
  const pendingFlips = useRef(new Map<string, { value: boolean; owner: TokenOperation }>());
  const updatedRows = useRef(new Map<string, ApiTokenDto>());
  const busy = createPending !== null;
  const secretWorkPending = busy || Object.values(pendingActions).some((operation) => operation.kind === "replace");
  const blockingTokenActionPending = Object.values(pendingActions).some((operation) => operation.kind !== "collaborators");
  const restrictionError = restrict && documentIds.length === 0 ? "Select at least one document when restricting a token." : null;
  const managementLink = documentId ? `/settings?next=${encodeURIComponent(`/d/${documentId}`)}#tokens` : "/settings#tokens";
  const matching = conflictName ? tokens?.find((t) => tokenState(t) === "Active" && agentMentionSlug(t.name).toLowerCase() === agentMentionSlug(conflictName).toLowerCase()) : null;

  useEffect(() => {
    const mount = Symbol("token-manager");
    const owners = tokenOwners.current;
    const latestOperations = latestTokenOperations.current;
    const flips = pendingFlips.current;
    mounted.current = mount;
    return () => {
      if (mounted.current === mount) mounted.current = null;
      if (createOwner.current?.mount === mount) createOwner.current = null;
      for (const [tokenId, operation] of owners) {
        if (operation.mount === mount) owners.delete(tokenId);
      }
      for (const [tokenId, operation] of latestOperations) {
        if (operation.mount === mount) latestOperations.delete(tokenId);
      }
      for (const [tokenId, pending] of flips) {
        if (pending.owner.mount === mount) flips.delete(tokenId);
      }
      createdRef.current = null;
    };
  }, []);
  const load = useCallback(async (ownerCurrent?: () => boolean) => {
    const mount = mounted.current;
    if (!mount || (ownerCurrent && !ownerCurrent())) return;
    const seq = ++loadSeq.current;
    updatedRows.current.clear();
    setLoadError(null);
    const current = () => mounted.current === mount && seq === loadSeq.current && (!ownerCurrent || ownerCurrent());
    try {
      const res = await api.tokens.list(true);
      if (!current()) return;
      // Keep rows added or revoked by this reload without overwriting newer metadata edits.
      setTokens(res.tokens.map((row) => {
        const updated = updatedRows.current.get(row.id) ?? row;
        return { ...updated, collaboratorsMayAsk: pendingFlips.current.get(row.id)?.value ?? updated.collaboratorsMayAsk };
      }));
    } catch (e) {
      if (!current()) return;
      setTokens(null);
      setLoadError({ message: apiErrorText(e, "Failed to load tokens"), permission: e instanceof ApiError && (e.status === 401 || e.status === 403) });
    }
  }, []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!restrict || documentId || documents !== null || documentError) return;
    let cancelled = false;
    api.documents.list().then((res) => { if (!cancelled) setDocuments(res.documents); })
      .catch((e) => { if (!cancelled) setDocumentError(apiErrorText(e, "Could not load documents")); });
    return () => { cancelled = true; };
  }, [restrict, documentId, documents, documentError]);
  useEffect(() => {
    if (embedded) return;
    const readHash = () => {
      if (createOwner.current || [...tokenOwners.current.values()].some((operation) => operation.kind === "replace")) return;
      setDestination(window.location.hash === "#connect" ? "connect" : "tokens");
    };
    readHash();
    window.addEventListener("hashchange", readHash);
    return () => window.removeEventListener("hashchange", readHash);
  }, [embedded]);

  const isCreateCurrent = (operation: CreateOperation) =>
    mounted.current === operation.mount && createOwner.current === operation;
  const isTokenCurrent = (operation: TokenOperation) =>
    mounted.current === operation.mount && tokenOwners.current.get(operation.id) === operation;
  const isLatestTokenOperation = (operation: TokenOperation) =>
    mounted.current === operation.mount && latestTokenOperations.current.get(operation.id) === operation;
  const hasSecretWork = () =>
    createOwner.current !== null || [...tokenOwners.current.values()].some((operation) => operation.kind === "replace");
  const tokenOperationBlocked = (tokenId: string, kind: TokenMutationKind) =>
    tokenOwners.current.has(tokenId)
    || (kind === "replace" && (createdRef.current !== null || hasSecretWork()));
  const beginTokenOperation = (tokenId: string, kind: TokenMutationKind) => {
    const mount = mounted.current;
    if (!mount || tokenOperationBlocked(tokenId, kind)) return null;
    const operation: TokenOperation = { mount, id: tokenId, kind };
    tokenOwners.current.set(tokenId, operation);
    latestTokenOperations.current.set(tokenId, operation);
    setPendingActions((current) => ({ ...current, [tokenId]: operation }));
    return operation;
  };
  const finishTokenOperation = (operation: TokenOperation) => {
    if (!isTokenCurrent(operation)) return;
    tokenOwners.current.delete(operation.id);
    setPendingActions((current) => {
      if (current[operation.id] !== operation) return current;
      const next = { ...current };
      delete next[operation.id];
      return next;
    });
  };
  const showCreated = (value: CreatedApiTokenDto) => {
    createdRef.current = value;
    setCreated(value);
  };
  const dismissCreated = () => {
    createdRef.current = null;
    setCreated(null);
  };

  const create = async () => {
    if (restrictionError) { setError(restrictionError); return; }
    const mount = mounted.current;
    if (!mount || createOwner.current || createdRef.current || [...tokenOwners.current.values()].some((operation) => operation.kind !== "collaborators")) return;
    const operation: CreateOperation = { mount, name, expires, scope, restrict, documentIds: [...documentIds] };
    createOwner.current = operation;
    setCreatePending(operation);
    setError(null);
    setConflictName(null);
    try {
      const res = await api.tokens.create(operation.name, operation.expires === "never" ? null : Number(operation.expires), {
        scope: operation.scope,
        documentIds: operation.restrict ? operation.documentIds : null,
      });
      if (!isCreateCurrent(operation)) return;
      showCreated(res.token);
      await load(() => isCreateCurrent(operation));
    } catch (e) {
      if (!isCreateCurrent(operation)) return;
      setError(apiErrorText(e, "Could not create token"));
      if (e instanceof ApiError && e.status === 409) {
        setConflictName(operation.name);
        await load(() => isCreateCurrent(operation));
      }
    } finally {
      if (isCreateCurrent(operation)) {
        createOwner.current = null;
        setCreatePending((current) => current === operation ? null : current);
      }
    }
  };

  const changeToken = async (token: ApiTokenDto, action: "rename" | "replace" | "revoke", newName?: string): Promise<boolean> => {
    if (tokenOperationBlocked(token.id, action)) return false;
    if (action === "revoke" && !window.confirm(`Revoke "${token.name}"? Every client using it will stop working immediately.`)) return false;
    if (action === "replace" && !window.confirm(`Replace "${token.name}"? Once the replacement is created, the old token stops working in every client. Update those clients with the new secret. Scope, documents and expiry stay unchanged. Continue?`)) return false;
    const operation = beginTokenOperation(token.id, action);
    if (!operation) return false;
    setError(null);
    try {
      if (action === "rename") {
        const res = await api.tokens.update(token.id, { name: newName });
        if (!isTokenCurrent(operation)) return false;
        updatedRows.current.set(token.id, res.token);
        setTokens((rows) => isLatestTokenOperation(operation) ? rows?.map((row) => row.id === token.id ? res.token : row) ?? null : rows);
        if (createdRef.current?.id === token.id) showCreated({ ...createdRef.current, name: res.token.name });
      } else {
        if (action === "replace") {
          const res = await api.tokens.replace(token.id);
          if (!isTokenCurrent(operation)) return false;
          showCreated(res.token);
        } else {
          await api.tokens.revoke(token.id);
          if (!isTokenCurrent(operation)) return false;
          if (createdRef.current?.id === token.id) dismissCreated();
        }
        tokensButton.current?.focus();
        await load(() => isTokenCurrent(operation));
      }
      return true;
    } catch (e) {
      if (isTokenCurrent(operation)) setError(apiErrorText(e, `Could not ${action} token`));
      return false;
    } finally {
      finishTokenOperation(operation);
    }
  };

  const setCollaboratorsMayAsk = async (t: ApiTokenDto, value: boolean) => {
    const operation = beginTokenOperation(t.id, "collaborators");
    if (!operation) return;
    const flip = (nextValue: boolean) => setTokens((rows) =>
      isLatestTokenOperation(operation) ? rows?.map((row) => row.id === t.id ? { ...row, collaboratorsMayAsk: nextValue } : row) ?? rows : rows);
    flip(value);
    setSwitchErrors((current) => {
      if (!(t.id in current)) return current;
      const next = { ...current };
      delete next[t.id];
      return next;
    });
    const pending = { value, owner: operation };
    pendingFlips.current.set(t.id, pending);
    try {
      const res = await api.tokens.update(t.id, { collaboratorsMayAsk: value });
      if (isTokenCurrent(operation) && pendingFlips.current.get(t.id) === pending) {
        updatedRows.current.set(t.id, res.token);
        setTokens((rows) => isLatestTokenOperation(operation) ? rows?.map((row) => row.id === t.id ? res.token : row) ?? rows : rows);
      }
    } catch (e) {
      if (!isTokenCurrent(operation) || pendingFlips.current.get(t.id) !== pending) return;
      flip(!value);
      setSwitchErrors((current) => ({ ...current, [t.id]: `Could not update “${t.name}”: ${apiErrorText(e, "The change was not saved")}` }));
    } finally {
      if (isTokenCurrent(operation) && pendingFlips.current.get(t.id) === pending) {
        pendingFlips.current.delete(t.id);
      }
      finishTokenOperation(operation);
    }
  };

  return (
    <div className="flex min-w-0 flex-col gap-4" id={embedded ? undefined : "tokens"} data-testid="token-manager">
      {!embedded && <div>
        <h1 className="flex items-center gap-2 text-xl font-semibold text-ink"><KeyRound size={20} /> Tokens &amp; MCP</h1>
        <p className="mt-1 text-sm text-ink-3">Manage tokens for {userLogin}. Agents can never do more than you can.</p>
        {next && <a className={cn("btn btn-outline btn-sm mt-3 gap-1.5", secretWorkPending && "pointer-events-none opacity-50")}
          href={next} aria-disabled={secretWorkPending || undefined} tabIndex={secretWorkPending ? -1 : undefined}
          onClick={(event) => { if (hasSecretWork()) event.preventDefault(); }} data-testid="settings-back-to-document">
          <ArrowLeft size={14} /> Back to the document
        </a>}
      </div>}
      <div className={cn("flex flex-wrap items-start gap-2", embedded && "sticky top-0 z-10 bg-surface py-2")}>
      <nav className="flex min-w-0 flex-wrap gap-2" aria-label="Token access">
        <button ref={tokensButton} type="button" className={cn("btn btn-sm", destination === "tokens" ? "btn-primary" : "btn-outline")}
         aria-pressed={destination === "tokens"} disabled={secretWorkPending}
         onClick={() => { if (!hasSecretWork()) setDestination("tokens"); }}>Tokens</button>
        <button type="button" className={cn("btn btn-sm whitespace-normal text-left", destination === "connect" ? "btn-primary" : "btn-outline")}
         aria-pressed={destination === "connect"} disabled={secretWorkPending}
         onClick={() => { if (!hasSecretWork()) setDestination("connect"); }}>Connect an MCP client</button>
      </nav>
      {onClose && <button type="button" className="btn btn-ghost btn-sm" disabled={secretWorkPending}
       onClick={() => { if (!hasSecretWork()) onClose(); }}>Close token management</button>}
      </div>
      <p className="text-xs leading-5 text-ink-3">Existing secrets cannot be shown again. Rename changes only the name; replace creates a new secret.</p>
      {error && <p role="alert" aria-atomic="true" className="text-sm text-danger">{error}</p>}
      {conflictName && <p className="text-sm text-ink-2" data-testid="token-conflict">
        {matching ? `The matching token "${matching.name}" is in Your tokens below. Rename, replace or revoke it, or choose a different name for a separate token.`
          : "That name is reserved by an existing token, but it could not be matched to this list. Retry the list or open all your tokens in a signed-in browser session; do not create another until the scope and account are clear."}
        {!matching && <button type="button" className="btn btn-outline btn-sm mt-2" disabled={busy} onClick={() => void load()}>Refresh token list</button>}
      </p>}
      {created && <SecretNotice created={created} onDismiss={() => { dismissCreated(); tokensButton.current?.focus(); }} />}
      <section className="min-w-0 rounded-xl border border-line bg-surface" aria-label="Your tokens">
        <h2 className="border-b border-line px-3 py-2 text-sm font-semibold text-ink">Your tokens</h2>
        {loadError ? <div className="p-3 text-sm">
          <p role="alert" aria-atomic="true" className="text-danger">{loadError.message}</p>
          <p className="mt-1 text-ink-3">{loadError.permission ? "Token management requires your signed-in browser session, not an agent or embedded session." : "The list could not be loaded. This does not mean you have no tokens."}</p>
          <button type="button" className="btn btn-outline btn-sm mt-2" onClick={() => void load()}>Retry token list</button>
        </div> : tokens === null ? <p className="p-3 text-sm text-ink-3">Loading tokens...</p>
          : tokens.length === 0 ? <p className="p-3 text-sm text-ink-3">No tokens yet.</p>
            : <ul className="divide-y divide-line">
              {tokens.map((t) => <TokenRow key={t.id} token={t} documentId={documentId} matching={matching?.id === t.id}
             disabled={Boolean(pendingActions[t.id])} replacementDisabled={Boolean(created) || secretWorkPending}
                onAction={(action, newName) => changeToken(t, action, newName)}
                onCollaboratorsChange={() => void setCollaboratorsMayAsk(t, !t.collaboratorsMayAsk)}
             switchError={switchErrors[t.id] ?? null} />)}
            </ul>}
      </section>
      {embedded && <a className={cn("w-fit text-sm font-medium text-accent hover:underline", secretWorkPending && "pointer-events-none opacity-50")}
        href={managementLink} aria-disabled={secretWorkPending || undefined} tabIndex={secretWorkPending ? -1 : undefined}
        onClick={(event) => { if (hasSecretWork()) event.preventDefault(); }}>Open all your tokens in Settings</a>}
      {destination === "connect" ? <div id={embedded ? undefined : "connect"} className="min-w-0">
        <p className="mb-3 text-sm text-ink-2">Choose a client and copy its setup. Put your saved token in the Authorization header where it says MARKDOC_TOKEN. No connection is needed to read these instructions.</p>
        <AgentConnectCard origin={liveOrigin} scope={created?.scope} hideTokenStep />
      </div> : <>
        <button type="button" className="btn btn-outline w-fit gap-1.5" disabled={busy || tokens === null || Boolean(created) || blockingTokenActionPending}
          aria-expanded={showCreate} aria-controls={`${id}-create`} onClick={() => setShowCreate((value) => !value)} data-testid="token-add">
          <Plus size={16} /> {showCreate ? "Cancel creation" : "Create token"}
        </button>
        {showCreate && <form id={`${id}-create`} className="flex min-w-0 flex-col gap-3 rounded-xl border border-line bg-surface p-3"
          onSubmit={(event) => { event.preventDefault(); void create(); }}>
          <label className="flex min-w-0 flex-col gap-1 text-xs font-medium text-ink-3">Name (shown as the agent)
           <input className="input w-full min-w-0" value={name} maxLength={80} disabled={busy} onChange={(e) => setName(e.target.value)} data-testid="token-name" />
          </label>
         <fieldset className="flex flex-col gap-1.5" disabled={busy} data-testid="token-scope">
            <legend className="mb-1 text-xs font-medium text-ink-3">Scope</legend>
            {SCOPES.map((s) => <label key={s} className="flex items-start gap-2 text-sm text-ink-2">
              <input type="radio" name={`${id}-scope`} checked={scope === s} onChange={() => setScope(s)} className="mt-1" data-testid={`token-scope-${s}`} />
              <span><span className="font-medium text-ink">{TOKEN_SCOPE_LABEL[s]}</span> — {TOKEN_SCOPE_SUMMARY[s]}</span>
            </label>)}
          </fieldset>
          <label className="flex items-center gap-2 text-sm text-ink-2">
           <input type="checkbox" checked={restrict} disabled={busy} onChange={(e) => setRestrict(e.target.checked)} aria-invalid={Boolean(restrictionError)}
              aria-describedby={`${id}-access`} data-testid="token-restrict" />
            {documentId ? "Only this document" : "Only these documents"}
          </label>
          <p id={`${id}-access`} className="text-xs text-ink-3" data-testid="token-document-access">{restrict ? "Every other document answers 404 to this token." : "This token will access all documents you can access."}</p>
          {restrict && !documentId && <div className="max-h-48 overflow-y-auto" data-testid="token-documents">
           {documentError ? <><p role="alert" className="text-sm text-danger">{documentError}</p><button type="button" className="btn btn-sm btn-outline" disabled={busy} onClick={() => setDocumentError(null)}>Retry documents</button></>
              : documents === null ? <p className="text-xs text-ink-3">Loading your documents...</p>
                : documents.length === 0 ? <p className="text-xs text-ink-3">No documents yet.</p>
                  : documents.map((d) => <label key={d.id} className="flex items-start gap-2 text-sm text-ink-2">
                   <input type="checkbox" checked={documentIds.includes(d.id)} disabled={busy} onChange={() => setDocumentIds((ids) => ids.includes(d.id) ? ids.filter((value) => value !== d.id) : [...ids, d.id])} data-testid={`token-document-${d.id}`} />
                    <span className="min-w-0 break-words">{d.title}</span>
                  </label>)}
          </div>}
          {restrictionError && <p className="text-xs text-danger" role="alert" data-testid="token-document-error">{restrictionError}</p>}
          <label className="flex flex-col gap-1 text-xs font-medium text-ink-3">Expires
           <select className="select w-fit" value={expires} disabled={busy} onChange={(e) => setExpires(e.target.value)}>
              <option value="30">30 days</option><option value="90">90 days</option><option value="365">1 year</option><option value="never">Never</option>
            </select>
          </label>
          <button type="submit" className="btn btn-primary w-fit gap-1.5" disabled={busy || blockingTokenActionPending || Boolean(created) || tokens === null || !name.trim() || Boolean(restrictionError)} data-testid="token-create">
            {busy && <Loader2 size={16} className="animate-spin" />} Create token
          </button>
        </form>}
      </>}
    </div>
  );
}

function TokenRow({ token: t, documentId, matching, disabled, replacementDisabled, onAction, onCollaboratorsChange, switchError }: {
  token: ApiTokenDto; documentId?: string; matching: boolean; disabled: boolean; replacementDisabled: boolean;
  onAction: (action: "rename" | "replace" | "revoke", name?: string) => Promise<boolean>;
  onCollaboratorsChange: () => void; switchError: string | null;
}) {
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(t.name);
  const renameButton = useRef<HTMLButtonElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const row = useRef<HTMLLIElement>(null);
  const returnToRename = useRef(false);
  const state = tokenState(t);
  const mismatch = documentId && t.documentIds !== null && !t.documentIds.includes(documentId);
  useEffect(() => {
    if (renaming) input.current?.focus();
    else if (returnToRename.current && !disabled) {
      renameButton.current?.focus();
      returnToRename.current = false;
    }
  }, [renaming, disabled]);
  useEffect(() => {
    if (matching) { row.current?.focus(); row.current?.scrollIntoView?.({ block: "nearest" }); }
  }, [matching]);
  const closeRename = () => { returnToRename.current = true; setRenaming(false); };
  return (
    <li ref={row} tabIndex={-1} className={cn("flex min-w-0 flex-col gap-2 p-3", matching && "ring-2 ring-inset ring-accent")}
      data-testid="token-row" data-token-match={matching || undefined}>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span className="min-w-0 break-all text-sm font-semibold text-ink">{t.name}</span>
        <ScopeChip scope={t.scope} /><span className="text-xs text-ink-3">{state}</span>
        <span className="text-xs text-ink-3" data-testid="token-documents-count">{t.documentIds?.length ? `${t.documentIds.length} ${t.documentIds.length === 1 ? "document" : "documents"}` : "all documents"}</span>
      </div>
      <p className="text-xs text-ink-3">Created {relativeTime(t.createdAt)}{t.lastUsedAt ? ` · used ${relativeTime(t.lastUsedAt)}` : " · no recorded use"}{t.expiresAt ? ` · expires ${relativeTime(t.expiresAt)}` : " · no expiry"}</p>
      {mismatch && <p className="text-xs text-ink-2">This token is scoped to other documents, not this one. Replacement keeps that restriction. Create a differently named token for this document.</p>}
      {state === "Expired" && <p className="text-xs text-ink-3">Create a new token to choose a new expiry.</p>}
      {!t.revokedAt && <div className="flex flex-wrap gap-2">
        <button ref={renameButton} type="button" className="btn btn-outline btn-sm" disabled={disabled} onClick={() => { setName(t.name); setRenaming(true); }} aria-label={`Rename ${t.name}`}>Rename</button>
        <button type="button" className="btn btn-outline btn-sm" disabled={disabled || replacementDisabled || state !== "Active"} onClick={() => void onAction("replace")} aria-label={`Replace ${t.name}`}>Replace</button>
        <button type="button" className="btn btn-outline btn-sm text-danger" disabled={disabled} onClick={() => void onAction("revoke")} aria-label={`Revoke ${t.name}`} data-testid="token-revoke">Revoke</button>
      </div>}
      {renaming && <form className="flex min-w-0 flex-col gap-2" onSubmit={(e) => { e.preventDefault(); void onAction("rename", name).then((ok) => { if (ok) closeRename(); }); }}>
        <label className="text-xs text-ink-2">Token name<input ref={input} className="input mt-1 w-full min-w-0" value={name} maxLength={80} disabled={disabled} onChange={(e) => setName(e.target.value)} /></label>
        <p className="text-xs text-ink-3">This changes the agent name and @mention, not its secret or permissions.</p>
        <div className="flex flex-wrap gap-2">
          <button type="submit" className="btn btn-primary btn-sm" disabled={disabled || !name.trim()}>Save name</button>
          <button type="button" className="btn btn-ghost btn-sm" disabled={disabled} onClick={closeRename}>Cancel rename</button>
        </div>
      </form>}
      <details className="min-w-0 text-xs text-ink-3">
        <summary className="cursor-pointer">Details &amp; agent requests</summary>
        <div className="mt-2 flex min-w-0 flex-col gap-2 break-words">
          <p className="break-all">Prefix: {t.prefix}…</p>
          <p>Created: {t.createdAt}. Last used: {t.lastUsedAt ?? "not recorded"}.</p>
          <p>Last MCP discovery: {t.lastMcpSeenAt ?? "not recorded"}. Last MCP tool call: {t.lastMcpCallAt ?? "not recorded"}.</p>
          {t.revokedAt && <p>Revoked: {t.revokedAt}</p>}
          {t.documentIds && <p className="break-all">Document IDs: {t.documentIds.join(", ")}</p>}
          {!t.revokedAt && <div className="flex items-start gap-2">
            <button type="button" role="switch" aria-checked={t.collaboratorsMayAsk === true} aria-labelledby={`token-${t.id}-may-ask-label`}
              aria-describedby={`token-${t.id}-may-ask-help`} className="switch mt-px" disabled={disabled} onClick={onCollaboratorsChange} data-testid="token-collaborators-may-ask" />
            <div><span id={`token-${t.id}-may-ask-label`} className="font-medium text-ink-2">Collaborators may ask this agent</span>
              <p id={`token-${t.id}-may-ask-help`}>Off: only you can send requests to it. On: people you share documents with can too.</p>
            </div>
          </div>}
        </div>
      </details>
      {switchError && <p className="text-xs text-danger" role="alert" aria-atomic="true" data-testid="token-collaborators-may-ask-error">{switchError}</p>}
    </li>
  );
}
