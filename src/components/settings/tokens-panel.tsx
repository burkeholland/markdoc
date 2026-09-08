"use client";

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
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

interface ManagerSession {
  authority: symbol;
  origin: string;
  userLogin: string;
  documentId?: string;
}

interface ManagerControlVisit {
  session: ManagerSession;
  embedded: boolean | undefined;
  next: string | null | undefined;
  onClose: (() => void) | undefined;
  hashListener: (() => void) | null;
}

interface TokensButtonControl {
  visit: ManagerControlVisit;
  element: HTMLButtonElement | null;
}

interface SecretPublication {
  value: CreatedApiTokenDto;
}

interface ManagerOperation {
  session: ManagerSession;
}

interface CreateOperation extends ManagerOperation {
  name: string;
  expires: string;
  scope: TokenScopeName;
  restrict: boolean;
  documentIds: string[];
}

interface TokenOperation extends ManagerOperation {
  id: string;
  kind: TokenMutationKind;
}

type DocumentListIntent = "initial" | "retry";

interface DocumentListInputs {
  readonly starred?: false;
  readonly trash?: false;
}

interface DocumentListRequest extends MountedOperation {
  id: number;
  inputs: Readonly<DocumentListInputs>;
  promise: ReturnType<typeof api.documents.list>;
}

interface DocumentListOperation extends MountedOperation {
  visit: number;
  requestId: number;
  intent: DocumentListIntent;
  request: DocumentListRequest;
}

/** Closing a host dialog unmounts all transient state, including late creation responses. */
export function TokensPanel({ open = true, ...props }: TokensPanelProps) {
  const managerKey = JSON.stringify([props.origin, props.userLogin, props.documentId ?? null]);
  return open ? <TokenManager key={managerKey} {...props} /> : null;
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
  const [documentPending, setDocumentPending] = useState<DocumentListOperation | null>(null);
  const [createPending, setCreatePending] = useState<CreateOperation | null>(null);
  const [pendingActions, setPendingActions] = useState<Record<string, TokenOperation>>({});
  const [error, setError] = useState<string | null>(null);
  const [conflictName, setConflictName] = useState<string | null>(null);
  const [switchErrors, setSwitchErrors] = useState<Record<string, string>>({});
  const [createdPublication, setCreatedPublication] = useState<SecretPublication | null>(null);
  const created = createdPublication?.value ?? null;
  const liveOrigin = useOrigin(origin);
  const id = useId();
  const documentMount = useRef(Symbol("token-manager-documents")).current;
  const documentMountActive = useRef(true);
  const documentVisitSeq = useRef(0);
  const documentRequestSeq = useRef(0);
  const documentVisit = useRef<number | null>(null);
  const documentOwner = useRef<DocumentListOperation | null>(null);
  const documentRequest = useRef<DocumentListRequest | null>(null);
  const managerSession = useRef<ManagerSession>({
    authority: Symbol("token-manager-session"),
    origin,
    userLogin,
    documentId,
  }).current;
  const activeManagerSession = useRef<ManagerSession | null>(null);
  const controlVisit = useMemo<ManagerControlVisit>(() => ({
    session: managerSession,
    embedded,
    next,
    onClose,
    hashListener: null,
  }), [embedded, managerSession, next, onClose]);
  const activeControlVisit = useRef<ManagerControlVisit | null>(null);
  const tokensButtonOwner = useRef<TokensButtonControl | null>(null);
  const tokensButtonControl = useMemo<TokensButtonControl>(() => ({
    visit: controlVisit,
    element: null,
  }), [controlVisit]);
  const createOwner = useRef<CreateOperation | null>(null);
  const tokenOwners = useRef(new Map<string, TokenOperation>());
  const latestTokenOperations = useRef(new Map<string, TokenOperation>());
  const createdRef = useRef<SecretPublication | null>(null);
  const loadSeq = useRef(0);
  const pendingFlips = useRef(new Map<string, { value: boolean; owner: TokenOperation }>());
  const updatedRows = useRef(new Map<string, ApiTokenDto>());
  const busy = createPending !== null;
  const secretWorkPending = busy || Object.values(pendingActions).some((operation) => operation.kind === "replace");
  const blockingTokenActionPending = Object.values(pendingActions).some((operation) => operation.kind !== "collaborators");
  const restrictionError = restrict && documentIds.length === 0 ? "Select at least one document when restricting a token." : null;
  const documentAuthorityUnavailable = restrict && !documentId && (documentPending !== null || documentError !== null);
  const showRestrictionError = Boolean(restrictionError) && !documentAuthorityUnavailable;
  const managementLink = documentId ? `/settings?next=${encodeURIComponent(`/d/${documentId}`)}#tokens` : "/settings#tokens";
  const matching = conflictName ? tokens?.find((t) => tokenState(t) === "Active" && agentMentionSlug(t.name).toLowerCase() === agentMentionSlug(conflictName).toLowerCase()) : null;
  const chooserVisible = destination === "tokens" && showCreate && restrict && !documentId;

  const isManagerSessionCurrent = useCallback((session: ManagerSession) =>
    activeManagerSession.current === session
    && activeManagerSession.current?.authority === session.authority
    && session.origin === origin
    && session.userLogin === userLogin
    && session.documentId === documentId, [documentId, origin, userLogin]);
  const isControlVisitCurrent = useCallback((visit: ManagerControlVisit) =>
    activeControlVisit.current === visit && isManagerSessionCurrent(visit.session), [isManagerSessionCurrent]);
  const retireControlVisit = useCallback((visit: ManagerControlVisit) => {
    if (activeControlVisit.current === visit) activeControlVisit.current = null;
    const listener = visit.hashListener;
    if (!listener) return;
    visit.hashListener = null;
    window.removeEventListener("hashchange", listener);
  }, []);
  const hasSecretWork = useCallback((visit: ManagerControlVisit) =>
    isControlVisitCurrent(visit)
    && (createOwner.current !== null || [...tokenOwners.current.values()].some((operation) => operation.kind === "replace")),
  [isControlVisitCurrent]);
  const bindTokensButton = useCallback((element: HTMLButtonElement | null) => {
    if (element) {
      tokensButtonControl.element = element;
      tokensButtonOwner.current = tokensButtonControl;
      return;
    }
    tokensButtonControl.element = null;
    if (tokensButtonOwner.current === tokensButtonControl) tokensButtonOwner.current = null;
  }, [tokensButtonControl]);
  const isDocumentCurrent = useCallback((operation: DocumentListOperation) =>
    documentMountActive.current
    && operation.mount === documentMount
    && documentVisit.current === operation.visit
    && operation.requestId === operation.request.id
    && documentOwner.current === operation, [documentMount]);
  const retireDocumentVisit = useCallback((updatePending = true, expectedVisit?: number) => {
    if (expectedVisit !== undefined && documentVisit.current !== expectedVisit) return;
    const owner = documentOwner.current;
    documentVisit.current = null;
    documentOwner.current = null;
    if (updatePending && owner) {
      setDocumentPending((current) => current === owner ? null : current);
    }
  }, []);
  const beginDocumentRequest = useCallback((intent: DocumentListIntent, visit: number) => {
    if (!documentMountActive.current || documentVisit.current !== visit || documentOwner.current) return;
    let request = documentRequest.current;
    if (!request) {
      const inputs = Object.freeze<DocumentListInputs>({});
      request = {
        mount: documentMount,
        id: ++documentRequestSeq.current,
        inputs,
        promise: api.documents.list(inputs),
      };
      documentRequest.current = request;
      const clearRequest = () => {
        if (documentRequest.current === request) documentRequest.current = null;
      };
      void request.promise.then(clearRequest, clearRequest);
    }
    const operation: DocumentListOperation = {
      mount: documentMount,
      visit,
      requestId: request.id,
      intent,
      request,
    };
    documentOwner.current = operation;
    setDocumentError(null);
    setDocumentPending(operation);
    void (async () => {
      try {
        const res = await operation.request.promise;
        if (!isDocumentCurrent(operation)) return;
        const accessibleIds = new Set(res.documents.map((entry) => entry.id));
        setDocuments(res.documents);
        setDocumentIds((current) => current.filter((documentId) => accessibleIds.has(documentId)));
      } catch (e) {
        if (!isDocumentCurrent(operation)) return;
        setDocumentError(apiErrorText(e, "Could not load documents"));
      } finally {
        if (!isDocumentCurrent(operation)) return;
        documentOwner.current = null;
        setDocumentPending((current) => current === operation ? null : current);
      }
    })();
  }, [documentMount, isDocumentCurrent]);
  const beginDocumentVisit = useCallback(() => {
    if (!documentMountActive.current || documentVisit.current !== null) return;
    const visit = ++documentVisitSeq.current;
    documentVisit.current = visit;
    beginDocumentRequest("initial", visit);
  }, [beginDocumentRequest]);
  const retryDocuments = useCallback(() => {
    const visit = documentVisit.current;
    if (visit === null || documentOwner.current) return;
    beginDocumentRequest("retry", visit);
  }, [beginDocumentRequest]);
  const selectDestination = useCallback((visit: ManagerControlVisit, value: "tokens" | "connect") => {
    if (!isControlVisitCurrent(visit) || hasSecretWork(visit)) return;
    setDestination((current) =>
      isControlVisitCurrent(visit) && !hasSecretWork(visit) && current !== value ? value : current);
  }, [hasSecretWork, isControlVisitCurrent]);
  const toggleCreate = useCallback((visit: ManagerControlVisit) => {
    if (!isControlVisitCurrent(visit)) return;
    setShowCreate((current) => isControlVisitCurrent(visit) ? !current : current);
  }, [isControlVisitCurrent]);
  const guardNavigation = useCallback((visit: ManagerControlVisit, event: { preventDefault: () => void }) => {
    if (isControlVisitCurrent(visit) && hasSecretWork(visit)) event.preventDefault();
  }, [hasSecretWork, isControlVisitCurrent]);
  const closeControlVisit = useCallback((visit: ManagerControlVisit) => {
    if (!isControlVisitCurrent(visit) || hasSecretWork(visit)) return;
    const ownedDocumentVisit = documentVisit.current;
    retireControlVisit(visit);
    if (ownedDocumentVisit !== null) retireDocumentVisit(true, ownedDocumentVisit);
    visit.onClose?.();
  }, [hasSecretWork, isControlVisitCurrent, retireControlVisit, retireDocumentVisit]);

  useLayoutEffect(() => {
    const owners = tokenOwners.current;
    const latestOperations = latestTokenOperations.current;
    const flips = pendingFlips.current;
    const rows = updatedRows.current;
    activeManagerSession.current = managerSession;
    return () => {
      if (activeManagerSession.current !== managerSession) return;
      activeManagerSession.current = null;
      loadSeq.current += 1;
      if (createOwner.current?.session === managerSession) createOwner.current = null;
      for (const [tokenId, operation] of owners) {
        if (operation.session === managerSession) owners.delete(tokenId);
      }
      for (const [tokenId, operation] of latestOperations) {
        if (operation.session === managerSession) latestOperations.delete(tokenId);
      }
      for (const [tokenId, pending] of flips) {
        if (pending.owner.session === managerSession) flips.delete(tokenId);
      }
      rows.clear();
      createdRef.current = null;
    };
  }, [managerSession]);
  useLayoutEffect(() => {
    documentMountActive.current = true;
    return () => {
      documentMountActive.current = false;
      retireDocumentVisit(false);
    };
  }, [retireDocumentVisit]);
  useLayoutEffect(() => {
    if (chooserVisible) beginDocumentVisit();
    else retireDocumentVisit();
    return () => {
      if (chooserVisible) retireDocumentVisit();
    };
  }, [beginDocumentVisit, chooserVisible, retireDocumentVisit]);

  const load = useCallback(async (ownerCurrent?: () => boolean) => {
    const session = activeManagerSession.current;
    if (!session || !isManagerSessionCurrent(session) || (ownerCurrent && !ownerCurrent())) return;
    const seq = ++loadSeq.current;
    updatedRows.current.clear();
    setLoadError(null);
    const current = () => isManagerSessionCurrent(session) && seq === loadSeq.current && (!ownerCurrent || ownerCurrent());
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
  }, [isManagerSessionCurrent]);
  useEffect(() => { void load(); }, [load]);
  useLayoutEffect(() => {
    activeControlVisit.current = controlVisit;
    if (controlVisit.embedded) return () => retireControlVisit(controlVisit);
    const readHash = () => {
      if (!isControlVisitCurrent(controlVisit) || hasSecretWork(controlVisit)) return;
      const value = window.location.hash === "#connect" ? "connect" : "tokens";
      setDestination((current) =>
        isControlVisitCurrent(controlVisit) && !hasSecretWork(controlVisit) && current !== value ? value : current);
    };
    controlVisit.hashListener = readHash;
    readHash();
    window.addEventListener("hashchange", readHash);
    return () => retireControlVisit(controlVisit);
  }, [controlVisit, hasSecretWork, isControlVisitCurrent, retireControlVisit]);

  const isCreateCurrent = (operation: CreateOperation) =>
    isManagerSessionCurrent(operation.session) && createOwner.current === operation;
  const isTokenCurrent = (operation: TokenOperation) =>
    isManagerSessionCurrent(operation.session) && tokenOwners.current.get(operation.id) === operation;
  const isLatestTokenOperation = (operation: TokenOperation) =>
    isManagerSessionCurrent(operation.session) && latestTokenOperations.current.get(operation.id) === operation;
  const tokenOperationBlocked = (tokenId: string, kind: TokenMutationKind) =>
    !isManagerSessionCurrent(managerSession)
    || tokenOwners.current.has(tokenId)
    || (kind === "replace" && (createdRef.current !== null || hasSecretWork(controlVisit)));
  const beginTokenOperation = (tokenId: string, kind: TokenMutationKind) => {
    const session = activeManagerSession.current;
    if (!session || !isManagerSessionCurrent(session) || tokenOperationBlocked(tokenId, kind)) return null;
    const operation: TokenOperation = { session, id: tokenId, kind };
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
    const publication = { value };
    createdRef.current = publication;
    setCreatedPublication(publication);
  };
  const clearCreated = (publication: SecretPublication) => {
    if (createdRef.current !== publication) return false;
    createdRef.current = null;
    setCreatedPublication((current) => current === publication ? null : current);
    return true;
  };
  const dismissCreated = (
    visit: ManagerControlVisit,
    publication: SecretPublication,
    buttonControl: TokensButtonControl,
  ) => {
    const button = buttonControl.element;
    if (!isControlVisitCurrent(visit)
      || createdRef.current !== publication
      || buttonControl.visit !== visit
      || tokensButtonOwner.current !== buttonControl
      || !button?.isConnected
      || !clearCreated(publication)) return;
    if (isControlVisitCurrent(visit)
      && tokensButtonOwner.current === buttonControl
      && buttonControl.element === button
      && button.isConnected) button.focus();
  };

  const create = async () => {
    const session = activeManagerSession.current;
    if (!session || !isManagerSessionCurrent(session)) return;
    if (documentAuthorityUnavailable) return;
    if (restrictionError) { setError(restrictionError); return; }
    if (createOwner.current || createdRef.current || [...tokenOwners.current.values()].some((operation) => operation.kind !== "collaborators")) return;
    const operation: CreateOperation = { session, name, expires, scope, restrict, documentIds: [...documentIds] };
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
        const publication = createdRef.current;
        if (publication?.value.id === token.id) showCreated({ ...publication.value, name: res.token.name });
      } else {
        if (action === "replace") {
          const res = await api.tokens.replace(token.id);
          if (!isTokenCurrent(operation)) return false;
          showCreated(res.token);
        } else {
          await api.tokens.revoke(token.id);
          if (!isTokenCurrent(operation)) return false;
          const publication = createdRef.current;
          if (publication?.value.id === token.id) clearCreated(publication);
        }
        tokensButtonOwner.current?.element?.focus();
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
    const pending = { value, owner: operation };
    pendingFlips.current.set(t.id, pending);
    const flip = (nextValue: boolean) => setTokens((rows) =>
      isLatestTokenOperation(operation)
        ? rows?.map((row) => row.id === t.id ? { ...row, collaboratorsMayAsk: nextValue } : row) ?? rows
        : rows);
    flip(value);
    setSwitchErrors((current) => {
      if (!isLatestTokenOperation(operation)) return current;
      if (!(t.id in current)) return current;
      const next = { ...current };
      delete next[t.id];
      return next;
    });
    try {
      const res = await api.tokens.update(t.id, { collaboratorsMayAsk: value });
      if (isTokenCurrent(operation) && pendingFlips.current.get(t.id) === pending) {
        updatedRows.current.set(t.id, res.token);
        setTokens((rows) => isLatestTokenOperation(operation) ? rows?.map((row) => row.id === t.id ? res.token : row) ?? rows : rows);
      }
    } catch (e) {
      if (!isTokenCurrent(operation) || pendingFlips.current.get(t.id) !== pending) return;
      flip(!value);
      setSwitchErrors((current) => isLatestTokenOperation(operation)
        ? { ...current, [t.id]: `Could not update “${t.name}”: ${apiErrorText(e, "The change was not saved")}` }
        : current);
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
          onClick={(event) => guardNavigation(controlVisit, event)} data-testid="settings-back-to-document">
          <ArrowLeft size={14} /> Back to the document
        </a>}
      </div>}
      <div className={cn("flex flex-wrap items-start gap-2", embedded && "sticky top-0 z-10 bg-surface py-2")}>
      <nav className="flex min-w-0 flex-wrap gap-2" aria-label="Token access">
        <button ref={bindTokensButton} type="button" className={cn("btn btn-sm", destination === "tokens" ? "btn-primary" : "btn-outline")}
         aria-pressed={destination === "tokens"} disabled={secretWorkPending}
         onClick={() => selectDestination(controlVisit, "tokens")}>Tokens</button>
        <button type="button" className={cn("btn btn-sm whitespace-normal text-left", destination === "connect" ? "btn-primary" : "btn-outline")}
         aria-pressed={destination === "connect"} disabled={secretWorkPending}
         onClick={() => selectDestination(controlVisit, "connect")}>Connect an MCP client</button>
      </nav>
      {onClose && <button type="button" className="btn btn-ghost btn-sm" disabled={secretWorkPending}
       onClick={() => closeControlVisit(controlVisit)}>Close token management</button>}
      </div>
      <p className="text-xs leading-5 text-ink-3">Existing secrets cannot be shown again. Rename changes only the name; replace creates a new secret.</p>
      {error && <p role="alert" aria-atomic="true" className="text-sm text-danger">{error}</p>}
      {conflictName && <p className="text-sm text-ink-2" data-testid="token-conflict">
        {matching ? `The matching token "${matching.name}" is in Your tokens below. Rename, replace or revoke it, or choose a different name for a separate token.`
          : "That name is reserved by an existing token, but it could not be matched to this list. Retry the list or open all your tokens in a signed-in browser session; do not create another until the scope and account are clear."}
        {!matching && <button type="button" className="btn btn-outline btn-sm mt-2" disabled={busy} onClick={() => void load()}>Refresh token list</button>}
      </p>}
      {createdPublication && <SecretNotice created={createdPublication.value}
        onDismiss={() => dismissCreated(controlVisit, createdPublication, tokensButtonControl)} />}
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
        onClick={(event) => guardNavigation(controlVisit, event)}>Open all your tokens in Settings</a>}
      {destination === "connect" ? <div id={embedded ? undefined : "connect"} className="min-w-0">
        <p className="mb-3 text-sm text-ink-2">Choose a client and copy its setup. Put your saved token in the Authorization header where it says MARKDOC_TOKEN. No connection is needed to read these instructions.</p>
        <AgentConnectCard origin={liveOrigin} scope={created?.scope} hideTokenStep />
      </div> : <>
        <button type="button" className="btn btn-outline w-fit gap-1.5" disabled={busy || tokens === null || Boolean(created) || blockingTokenActionPending}
          aria-expanded={showCreate} aria-controls={`${id}-create`} onClick={() => toggleCreate(controlVisit)} data-testid="token-add">
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
           <input type="checkbox" checked={restrict} disabled={busy} onChange={(e) => {
             if (e.target.checked) beginDocumentVisit();
             else retireDocumentVisit();
             setRestrict(e.target.checked);
           }} aria-invalid={Boolean(showRestrictionError)}
              aria-describedby={`${id}-access`} data-testid="token-restrict" />
            {documentId ? "Only this document" : "Only these documents"}
          </label>
          <p id={`${id}-access`} className="text-xs text-ink-3" data-testid="token-document-access">{restrict ? "Every other document answers 404 to this token." : "This token will access all documents you can access."}</p>
          {restrict && !documentId && <div className="max-h-48 overflow-y-auto" data-testid="token-documents">
           {documentPending && <p role="status" aria-live="polite" aria-atomic="true" className="text-xs text-ink-3" data-testid="token-documents-pending">
             {documentPending.intent === "retry" ? "Refreshing your documents..." : "Loading your documents..."}
           </p>}
           {documentError && <><p role="alert" aria-atomic="true" className="text-sm text-danger">{documentError}</p>
             <button type="button" className="btn btn-sm btn-outline" disabled={busy} onClick={retryDocuments}>Retry documents</button></>}
           {documents !== null && (documents.length === 0 ? <p className="text-xs text-ink-3">No documents yet.</p>
                  : documents.map((d) => <label key={d.id} className="flex items-start gap-2 text-sm text-ink-2">
                   <input type="checkbox" checked={documentIds.includes(d.id)} disabled={busy} onChange={() => setDocumentIds((ids) => ids.includes(d.id) ? ids.filter((value) => value !== d.id) : [...ids, d.id])} data-testid={`token-document-${d.id}`} />
                    <span className="min-w-0 break-words">{d.title}</span>
                  </label>))}
          </div>}
          {showRestrictionError && <p className="text-xs text-danger" role="alert" data-testid="token-document-error">{restrictionError}</p>}
          <label className="flex flex-col gap-1 text-xs font-medium text-ink-3">Expires
           <select className="select w-fit" value={expires} disabled={busy} onChange={(e) => setExpires(e.target.value)}>
              <option value="30">30 days</option><option value="90">90 days</option><option value="365">1 year</option><option value="never">Never</option>
            </select>
          </label>
          <button type="submit" className="btn btn-primary w-fit gap-1.5" disabled={busy || blockingTokenActionPending || Boolean(created) || tokens === null || !name.trim() || Boolean(restrictionError) || documentAuthorityUnavailable} data-testid="token-create">
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
  type RenameVisit = Readonly<{ identity: symbol; mount: symbol; tokenId: string }>;
  type RenameDraft = Readonly<{ visit: RenameVisit; value: string }>;
  type RowActionKind = "rename" | "replace" | "revoke" | "cancel" | "save";
  type RowActionFacts = Readonly<{ kind: RowActionKind; eligible: boolean }>;
  type TokenSnapshot = Readonly<{
    source: ApiTokenDto;
    id: string;
    name: string;
    prefix: string;
    scope: ApiTokenDto["scope"];
    documentIdsSource: string[] | null;
    documentIds: readonly string[] | null;
    collaboratorsMayAsk: boolean;
    createdAt: string;
    lastUsedAt: string | null;
    lastMcpSeenAt: string | null;
    lastMcpCallAt: string | null;
    expiresAt: string | null;
    revokedAt: string | null | undefined;
  }>;
  type RowFacts = Readonly<{
    identity: symbol;
    mount: symbol;
    token: TokenSnapshot;
    documentId: string | undefined;
    matching: boolean;
    disabled: boolean;
    replacementDisabled: boolean;
    onAction: (action: "rename" | "replace" | "revoke", name?: string) => Promise<boolean>;
    onCollaboratorsChange: () => void;
    switchError: string | null;
    renameVisit: RenameVisit | null;
    draft: string | null;
    state: "Active" | "Expired" | "Revoked";
    mismatch: boolean;
    actionsVisible: boolean;
    documentCount: string;
    metadata: string;
    mismatchText: string | null;
    expiredText: string | null;
    prefixDetails: string;
    timeDetails: string;
    mcpDetails: string;
    revokedDetails: string | null;
    documentDetails: string | null;
    renameLabel: string;
    replaceLabel: string;
    revokeLabel: string;
    switchLabelId: string;
    switchHelpId: string;
    rowClassName: string;
    rename: RowActionFacts | null;
    replace: RowActionFacts | null;
    revoke: RowActionFacts | null;
    cancel: RowActionFacts | null;
    save: RowActionFacts | null;
    inputEligible: boolean;
  }>;
  interface ElementSlot<T extends HTMLElement> {
    element: T | null;
  }
  interface RowCandidate {
    readonly facts: RowFacts;
    readonly row: ElementSlot<HTMLLIElement>;
    readonly header: ElementSlot<HTMLDivElement>;
    readonly metadata: ElementSlot<HTMLParagraphElement>;
    readonly mismatch: ElementSlot<HTMLParagraphElement>;
    readonly expired: ElementSlot<HTMLParagraphElement>;
    readonly actions: ElementSlot<HTMLDivElement>;
    readonly rename: ElementSlot<HTMLButtonElement>;
    readonly replace: ElementSlot<HTMLButtonElement>;
    readonly revoke: ElementSlot<HTMLButtonElement>;
    readonly form: ElementSlot<HTMLFormElement>;
    readonly input: ElementSlot<HTMLInputElement>;
    readonly save: ElementSlot<HTMLButtonElement>;
    readonly cancel: ElementSlot<HTMLButtonElement>;
    readonly details: ElementSlot<HTMLDetailsElement>;
    readonly detailsBody: ElementSlot<HTMLDivElement>;
    readonly collaborators: ElementSlot<HTMLButtonElement>;
    readonly switchError: ElementSlot<HTMLParagraphElement>;
  }
  type RowCommit = Readonly<{
    candidate: RowCandidate;
    facts: RowFacts;
    ownerDocument: Document;
    parent: HTMLUListElement;
    parentChildren: readonly Element[];
    tree: readonly Node[];
    row: HTMLLIElement;
    header: HTMLDivElement;
    metadata: HTMLParagraphElement;
    mismatch: HTMLParagraphElement | null;
    expired: HTMLParagraphElement | null;
    actions: HTMLDivElement | null;
    rename: HTMLButtonElement | null;
    replace: HTMLButtonElement | null;
    revoke: HTMLButtonElement | null;
    form: HTMLFormElement | null;
    input: HTMLInputElement | null;
    save: HTMLButtonElement | null;
    cancel: HTMLButtonElement | null;
    details: HTMLDetailsElement;
    detailsBody: HTMLDivElement;
    collaborators: HTMLButtonElement | null;
    switchError: HTMLParagraphElement | null;
    renameTargets: readonly Node[] | null;
    replaceTargets: readonly Node[] | null;
    revokeTargets: readonly Node[] | null;
    cancelTargets: readonly Node[] | null;
  }>;
  type SaveOwner = Readonly<{
    mount: symbol;
    visit: RenameVisit;
    token: ApiTokenDto;
    callback: RowFacts["onAction"];
    name: string;
    commit: RowCommit;
  }>;
  type FocusIntent = Readonly<{ mount: symbol; visit: RenameVisit; tokenId: string }>;
  type InputOverride = Readonly<{ input: HTMLInputElement; value: string }>;

  const slot = <T extends HTMLElement>(): ElementSlot<T> => ({ element: null });
  const [mount] = useState(() => Symbol("token-row-mount"));
  const [renameDraft, setRenameDraft] = useState<RenameDraft | null>(null);
  const [, setPresentationRevision] = useState(0);
  const activeMount = useRef<symbol | null>(null);
  const activeCommit = useRef<RowCommit | null>(null);
  const committedCandidates = useRef(new WeakSet<RowCandidate>());
  const detachedCandidates = useRef(new WeakSet<RowCandidate>());
  const repairRequestedCandidates = useRef(new WeakSet<RowCandidate>());
  const claimedEvents = useRef(new WeakSet<object>());
  const consumedCommits = useRef(new WeakSet<RowCommit>());
  const dispatchingCommits = useRef(new WeakSet<RowCommit>());
  const saveOwner = useRef<SaveOwner | null>(null);
  const returnFocus = useRef<FocusIntent | null>(null);
  const focusedRename = useRef<{ visit: RenameVisit; input: HTMLInputElement } | null>(null);
  const focusedMatch = useRef<HTMLLIElement | null>(null);
  const state = tokenState(t);
  const mismatch = Boolean(documentId && t.documentIds !== null && !t.documentIds.includes(documentId));
  const token = Object.freeze<TokenSnapshot>({
    source: t,
    id: t.id,
    name: t.name,
    prefix: t.prefix,
    scope: t.scope,
    documentIdsSource: t.documentIds,
    documentIds: t.documentIds ? Object.freeze([...t.documentIds]) : null,
    collaboratorsMayAsk: t.collaboratorsMayAsk,
    createdAt: t.createdAt,
    lastUsedAt: t.lastUsedAt,
    lastMcpSeenAt: t.lastMcpSeenAt,
    lastMcpCallAt: t.lastMcpCallAt,
    expiresAt: t.expiresAt,
    revokedAt: t.revokedAt,
  });
  const action = (kind: RowActionKind, eligible: boolean) => Object.freeze<RowActionFacts>({ kind, eligible });
  const actionsVisible = !t.revokedAt;
  const facts = Object.freeze<RowFacts>({
    identity: Symbol("token-row-presentation"),
    mount,
    token,
    documentId,
    matching,
    disabled,
    replacementDisabled,
    onAction,
    onCollaboratorsChange,
    switchError,
    renameVisit: renameDraft?.visit ?? null,
    draft: renameDraft?.value ?? null,
    state,
    mismatch,
    actionsVisible,
    documentCount: t.documentIds?.length
      ? `${t.documentIds.length} ${t.documentIds.length === 1 ? "document" : "documents"}`
      : "all documents",
    metadata: `Created ${relativeTime(t.createdAt)}${t.lastUsedAt ? ` · used ${relativeTime(t.lastUsedAt)}` : " · no recorded use"}${t.expiresAt ? ` · expires ${relativeTime(t.expiresAt)}` : " · no expiry"}`,
    mismatchText: mismatch
      ? "This token is scoped to other documents, not this one. Replacement keeps that restriction. Create a differently named token for this document."
      : null,
    expiredText: state === "Expired" ? "Create a new token to choose a new expiry." : null,
    prefixDetails: `Prefix: ${t.prefix}…`,
    timeDetails: `Created: ${t.createdAt}. Last used: ${t.lastUsedAt ?? "not recorded"}.`,
    mcpDetails: `Last MCP discovery: ${t.lastMcpSeenAt ?? "not recorded"}. Last MCP tool call: ${t.lastMcpCallAt ?? "not recorded"}.`,
    revokedDetails: t.revokedAt ? `Revoked: ${t.revokedAt}` : null,
    documentDetails: t.documentIds ? `Document IDs: ${t.documentIds.join(", ")}` : null,
    renameLabel: `Rename ${t.name}`,
    replaceLabel: `Replace ${t.name}`,
    revokeLabel: `Revoke ${t.name}`,
    switchLabelId: `token-${t.id}-may-ask-label`,
    switchHelpId: `token-${t.id}-may-ask-help`,
    rowClassName: cn("flex min-w-0 flex-col gap-2 p-3", matching && "ring-2 ring-inset ring-accent"),
    rename: actionsVisible ? action("rename", !disabled) : null,
    replace: actionsVisible ? action("replace", !disabled && !replacementDisabled && state === "Active") : null,
    revoke: actionsVisible ? action("revoke", !disabled) : null,
    cancel: renameDraft ? action("cancel", !disabled) : null,
    save: renameDraft ? action("save", !disabled && Boolean(renameDraft.value.trim())) : null,
    inputEligible: Boolean(renameDraft) && !disabled,
  });
  const candidate: RowCandidate = Object.freeze({
    facts,
    row: slot<HTMLLIElement>(),
    header: slot<HTMLDivElement>(),
    metadata: slot<HTMLParagraphElement>(),
    mismatch: slot<HTMLParagraphElement>(),
    expired: slot<HTMLParagraphElement>(),
    actions: slot<HTMLDivElement>(),
    rename: slot<HTMLButtonElement>(),
    replace: slot<HTMLButtonElement>(),
    revoke: slot<HTMLButtonElement>(),
    form: slot<HTMLFormElement>(),
    input: slot<HTMLInputElement>(),
    save: slot<HTMLButtonElement>(),
    cancel: slot<HTMLButtonElement>(),
    details: slot<HTMLDetailsElement>(),
    detailsBody: slot<HTMLDivElement>(),
    collaborators: slot<HTMLButtonElement>(),
    switchError: slot<HTMLParagraphElement>(),
  });

  const retireCandidate = (value: RowCandidate) => {
    if (activeCommit.current?.candidate === value) activeCommit.current = null;
  };
  const bindElement = <T extends HTMLElement>(owner: ElementSlot<T>, element: T | null) => {
    if (owner.element !== element) retireCandidate(candidate);
    owner.element = element;
    if (!element) {
      if (committedCandidates.current.has(candidate)) detachedCandidates.current.add(candidate);
      retireCandidate(candidate);
      return;
    }
    if (
      detachedCandidates.current.has(candidate)
      && !repairRequestedCandidates.current.has(candidate)
      && activeMount.current === mount
      && activeCommit.current === null
    ) {
      repairRequestedCandidates.current.add(candidate);
      setPresentationRevision((current) => current + 1);
    }
  };
  const nodesBelow = (root: Node): readonly Node[] => {
    const nodes: Node[] = [];
    const append = (node: Node) => {
      nodes.push(node);
      for (const child of node.childNodes) append(child);
    };
    append(root);
    return Object.freeze(nodes);
  };
  const arraysMatch = <T,>(current: readonly T[], frozen: readonly T[]) =>
    current.length === frozen.length && current.every((value, index) => value === frozen[index]);
  const tokenMatches = (snapshot: TokenSnapshot) =>
    t === snapshot.source
    && t.id === snapshot.id
    && t.name === snapshot.name
    && t.prefix === snapshot.prefix
    && t.scope === snapshot.scope
    && t.documentIds === snapshot.documentIdsSource
    && (t.documentIds
      ? snapshot.documentIds !== null && arraysMatch(t.documentIds, snapshot.documentIds)
      : snapshot.documentIds === null)
    && t.collaboratorsMayAsk === snapshot.collaboratorsMayAsk
    && t.createdAt === snapshot.createdAt
    && t.lastUsedAt === snapshot.lastUsedAt
    && t.lastMcpSeenAt === snapshot.lastMcpSeenAt
    && t.lastMcpCallAt === snapshot.lastMcpCallAt
    && t.expiresAt === snapshot.expiresAt
    && t.revokedAt === snapshot.revokedAt;
  const factsAreCurrent = (snapshot: RowFacts) =>
    activeMount.current === snapshot.mount
    && snapshot.mount === mount
    && tokenMatches(snapshot.token)
    && documentId === snapshot.documentId
    && matching === snapshot.matching
    && disabled === snapshot.disabled
    && replacementDisabled === snapshot.replacementDisabled
    && onAction === snapshot.onAction
    && onCollaboratorsChange === snapshot.onCollaboratorsChange
    && switchError === snapshot.switchError
    && (renameDraft?.visit ?? null) === snapshot.renameVisit
    && (renameDraft?.value ?? null) === snapshot.draft
    && tokenState(t) === snapshot.state
    && mismatch === snapshot.mismatch;
  const buttonIsExact = (
    button: HTMLButtonElement,
    commit: RowCommit,
    type: "button" | "submit",
    label: string,
    eligible: boolean,
  ) =>
    button.ownerDocument === commit.ownerDocument
    && button.isConnected
    && button.type === type
    && button.disabled === !eligible
    && button.getAttribute("aria-disabled") !== "true"
    && button.textContent?.trim() === label;
  const domIsExact = (commit: RowCommit, override?: InputOverride) => {
    const value = commit.facts;
    const ownerWindow = commit.ownerDocument.defaultView;
    if (
      !ownerWindow
      || !commit.row.isConnected
      || commit.row.ownerDocument !== commit.ownerDocument
      || commit.row.parentElement !== commit.parent
      || !arraysMatch(Array.from(commit.parent.children), commit.parentChildren)
      || !arraysMatch(nodesBelow(commit.row), commit.tree)
      || commit.row.tabIndex !== -1
      || commit.row.className !== value.rowClassName
      || commit.row.dataset.testid !== "token-row"
      || commit.row.getAttribute("data-token-match") !== (value.matching ? "true" : null)
      || !commit.header.isConnected
      || commit.header.parentElement !== commit.row
      || commit.header.className !== "flex min-w-0 flex-wrap items-center gap-2"
      || commit.header.children.length !== 4
      || commit.header.children.item(0)?.textContent !== value.token.name
      || commit.header.children.item(1)?.getAttribute("data-testid") !== "token-scope-chip"
      || commit.header.children.item(1)?.getAttribute("data-scope") !== value.token.scope
      || commit.header.children.item(1)?.getAttribute("title") !== `${TOKEN_SCOPE_LABEL[value.token.scope]}: ${TOKEN_SCOPE_SUMMARY[value.token.scope]}`
      || commit.header.children.item(1)?.textContent?.trim() !== value.token.scope
      || commit.header.children.item(2)?.textContent !== value.state
      || commit.header.children.item(3)?.getAttribute("data-testid") !== "token-documents-count"
      || commit.header.children.item(3)?.textContent !== value.documentCount
      || !commit.metadata.isConnected
      || commit.metadata.parentElement !== commit.row
      || commit.metadata.textContent !== value.metadata
    ) {
      return false;
    }

    const directChildren: Element[] = [commit.header, commit.metadata];
    if (value.mismatchText) {
      if (
        !commit.mismatch?.isConnected
        || commit.mismatch.parentElement !== commit.row
        || commit.mismatch.textContent !== value.mismatchText
      ) {
        return false;
      }
      directChildren.push(commit.mismatch);
    } else if (commit.mismatch) {
      return false;
    }
    if (value.expiredText) {
      if (
        !commit.expired?.isConnected
        || commit.expired.parentElement !== commit.row
        || commit.expired.textContent !== value.expiredText
      ) {
        return false;
      }
      directChildren.push(commit.expired);
    } else if (commit.expired) {
      return false;
    }

    if (value.actionsVisible) {
      if (
        !value.rename
        || !value.replace
        || !value.revoke
        || !commit.actions?.isConnected
        || commit.actions.parentElement !== commit.row
        || commit.actions.children.length !== 3
        || commit.actions.children.item(0) !== commit.rename
        || commit.actions.children.item(1) !== commit.replace
        || commit.actions.children.item(2) !== commit.revoke
        || !commit.rename
        || !commit.replace
        || !commit.revoke
        || !buttonIsExact(commit.rename, commit, "button", "Rename", value.rename.eligible)
        || commit.rename.getAttribute("aria-label") !== value.renameLabel
        || !buttonIsExact(commit.replace, commit, "button", "Replace", value.replace.eligible)
        || commit.replace.getAttribute("aria-label") !== value.replaceLabel
        || !buttonIsExact(commit.revoke, commit, "button", "Revoke", value.revoke.eligible)
        || commit.revoke.getAttribute("aria-label") !== value.revokeLabel
        || commit.revoke.dataset.testid !== "token-revoke"
      ) {
        return false;
      }
      directChildren.push(commit.actions);
    } else if (commit.actions || commit.rename || commit.replace || commit.revoke) {
      return false;
    }

    if (value.renameVisit) {
      const input = commit.input;
      const form = commit.form;
      const save = commit.save;
      const cancel = commit.cancel;
      const label = input?.parentElement;
      const guidance = label?.nextElementSibling;
      const buttons = guidance?.nextElementSibling;
      if (
        value.draft === null
        || !value.save
        || !value.cancel
        || !form?.isConnected
        || form.parentElement !== commit.row
        || form.children.length !== 3
        || form.children.item(0) !== label
        || form.children.item(1) !== guidance
        || form.children.item(2) !== buttons
        || label?.tagName !== "LABEL"
        || label.children.length !== 1
        || label.firstElementChild !== input
        || label.childNodes.item(0)?.textContent !== "Token name"
        || guidance?.textContent !== "This changes the agent name and @mention, not its secret or permissions."
        || buttons?.children.length !== 2
        || buttons.children.item(0) !== save
        || buttons.children.item(1) !== cancel
        || !input?.isConnected
        || input.ownerDocument !== commit.ownerDocument
        || input.form !== form
        || input.type !== "text"
        || input.maxLength !== 80
        || input.disabled !== !value.inputEligible
        || input.value !== (override?.input === input ? override.value : value.draft)
        || !save
        || !cancel
        || !buttonIsExact(save, commit, "submit", "Save name", value.save.eligible)
        || save.form !== form
        || !buttonIsExact(cancel, commit, "button", "Cancel rename", value.cancel.eligible)
        || cancel.form !== form
      ) {
        return false;
      }
      directChildren.push(form);
    } else if (commit.form || commit.input || commit.save || commit.cancel || value.draft !== null) {
      return false;
    }

    const summary = commit.details.firstElementChild;
    if (
      !commit.details.isConnected
      || commit.details.parentElement !== commit.row
      || commit.details.children.length !== 2
      || summary?.tagName !== "SUMMARY"
      || summary.textContent !== "Details & agent requests"
      || commit.details.lastElementChild !== commit.detailsBody
      || !commit.detailsBody.isConnected
      || commit.detailsBody.parentElement !== commit.details
    ) {
      return false;
    }
    const detailChildren: Element[] = [];
    const takeDetail = (text: string) => {
      const element = commit.detailsBody.children.item(detailChildren.length);
      if (element?.tagName !== "P" || element.textContent !== text) return false;
      detailChildren.push(element);
      return true;
    };
    if (
      !takeDetail(value.prefixDetails)
      || !takeDetail(value.timeDetails)
      || !takeDetail(value.mcpDetails)
      || (value.revokedDetails ? !takeDetail(value.revokedDetails) : false)
      || (value.documentDetails ? !takeDetail(value.documentDetails) : false)
    ) {
      return false;
    }
    if (value.actionsVisible) {
      const switchContainer = commit.detailsBody.children.item(detailChildren.length);
      const copy = switchContainer?.lastElementChild;
      if (
        !commit.collaborators?.isConnected
        || switchContainer?.children.length !== 2
        || switchContainer.firstElementChild !== commit.collaborators
        || commit.collaborators.parentElement !== switchContainer
        || commit.collaborators.type !== "button"
        || commit.collaborators.getAttribute("role") !== "switch"
        || commit.collaborators.getAttribute("aria-checked") !== String(value.token.collaboratorsMayAsk)
        || commit.collaborators.getAttribute("aria-labelledby") !== value.switchLabelId
        || commit.collaborators.getAttribute("aria-describedby") !== value.switchHelpId
        || commit.collaborators.disabled !== value.disabled
        || commit.collaborators.dataset.testid !== "token-collaborators-may-ask"
        || copy?.children.length !== 2
        || copy.children.item(0)?.id !== value.switchLabelId
        || copy.children.item(0)?.textContent !== "Collaborators may ask this agent"
        || copy.children.item(1)?.id !== value.switchHelpId
        || copy.children.item(1)?.textContent !== "Off: only you can send requests to it. On: people you share documents with can too."
      ) {
        return false;
      }
      detailChildren.push(switchContainer);
    } else if (commit.collaborators) {
      return false;
    }
    if (commit.detailsBody.children.length !== detailChildren.length) return false;
    directChildren.push(commit.details);

    if (value.switchError) {
      if (
        !commit.switchError?.isConnected
        || commit.switchError.parentElement !== commit.row
        || commit.switchError.getAttribute("role") !== "alert"
        || commit.switchError.getAttribute("aria-atomic") !== "true"
        || commit.switchError.dataset.testid !== "token-collaborators-may-ask-error"
        || commit.switchError.textContent !== value.switchError
      ) {
        return false;
      }
      directChildren.push(commit.switchError);
    } else if (commit.switchError) {
      return false;
    }
    return commit.row.children.length === directChildren.length
      && directChildren.every((element, index) => commit.row.children.item(index) === element);
  };
  const buildCommit = (): RowCommit | null => {
    const row = candidate.row.element;
    const header = candidate.header.element;
    const metadata = candidate.metadata.element;
    const details = candidate.details.element;
    const detailsBody = candidate.detailsBody.element;
    const parent = row?.parentElement;
    const ownerWindow = row?.ownerDocument.defaultView;
    if (
      !row
      || !header
      || !metadata
      || !details
      || !detailsBody
      || !ownerWindow?.HTMLUListElement
      || !(parent instanceof ownerWindow.HTMLUListElement)
    ) {
      return null;
    }
    const commit = Object.freeze<RowCommit>({
      candidate,
      facts,
      ownerDocument: row.ownerDocument,
      parent,
      parentChildren: Object.freeze(Array.from(parent.children)),
      tree: nodesBelow(row),
      row,
      header,
      metadata,
      mismatch: candidate.mismatch.element,
      expired: candidate.expired.element,
      actions: candidate.actions.element,
      rename: candidate.rename.element,
      replace: candidate.replace.element,
      revoke: candidate.revoke.element,
      form: candidate.form.element,
      input: candidate.input.element,
      save: candidate.save.element,
      cancel: candidate.cancel.element,
      details,
      detailsBody,
      collaborators: candidate.collaborators.element,
      switchError: candidate.switchError.element,
      renameTargets: candidate.rename.element ? nodesBelow(candidate.rename.element) : null,
      replaceTargets: candidate.replace.element ? nodesBelow(candidate.replace.element) : null,
      revokeTargets: candidate.revoke.element ? nodesBelow(candidate.revoke.element) : null,
      cancelTargets: candidate.cancel.element ? nodesBelow(candidate.cancel.element) : null,
    });
    return domIsExact(commit) ? commit : null;
  };
  const currentCommit = (value: RowCandidate, override?: InputOverride) => {
    const commit = activeCommit.current;
    return commit?.candidate === value
      && commit.facts === value.facts
      && factsAreCurrent(commit.facts)
      && domIsExact(commit, override)
      ? commit
      : null;
  };
  const clickControl = (
    commit: RowCommit,
    kind: Exclude<RowActionKind, "save">,
  ): { button: HTMLButtonElement | null; targets: readonly Node[] | null; action: RowActionFacts | null } => {
    if (kind === "rename") return { button: commit.rename, targets: commit.renameTargets, action: commit.facts.rename };
    if (kind === "replace") return { button: commit.replace, targets: commit.replaceTargets, action: commit.facts.replace };
    if (kind === "revoke") return { button: commit.revoke, targets: commit.revokeTargets, action: commit.facts.revoke };
    return { button: commit.cancel, targets: commit.cancelTargets, action: commit.facts.cancel };
  };
  const claimClick = (
    event: ReactMouseEvent<HTMLButtonElement>,
    kind: Exclude<RowActionKind, "save">,
    consume: boolean,
  ) => {
    const commit = currentCommit(candidate);
    if (!commit) return null;
    const { button, targets, action: expectedAction } = clickControl(commit, kind);
    const ownerWindow = commit.ownerDocument.defaultView;
    const nativeEvent = event.nativeEvent;
    const target = event.target;
    if (
      !button
      || !expectedAction?.eligible
      || !ownerWindow
      || event.type !== "click"
      || event.button !== 0
      || event.currentTarget !== button
      || event.defaultPrevented
      || !(nativeEvent instanceof ownerWindow.MouseEvent)
      || nativeEvent.type !== "click"
      || nativeEvent.button !== 0
      || nativeEvent.defaultPrevented
      || !(target instanceof ownerWindow.Node)
      || nativeEvent.target !== target
      || target.ownerDocument !== commit.ownerDocument
      || !button.contains(target)
      || targets?.includes(target) !== true
      || button.disabled
      || button.getAttribute("aria-disabled") === "true"
      || claimedEvents.current.has(event)
      || claimedEvents.current.has(nativeEvent)
      || consumedCommits.current.has(commit)
      || dispatchingCommits.current.has(commit)
    ) {
      return null;
    }
    claimedEvents.current.add(event);
    claimedEvents.current.add(nativeEvent);
    if (consume) consumedCommits.current.add(commit);
    else dispatchingCommits.current.add(commit);
    return commit;
  };
  const claimInput = (event: ChangeEvent<HTMLInputElement>) => {
    const input = candidate.input.element;
    const ownerWindow = input?.ownerDocument.defaultView;
    const nativeEvent = event.nativeEvent;
    const next = event.currentTarget.value;
    if (
      !input
      || !ownerWindow
      || (event.type !== "input" && event.type !== "change")
      || event.currentTarget !== input
      || event.target !== input
      || event.defaultPrevented
      || !(nativeEvent instanceof ownerWindow.Event)
      || (nativeEvent.type !== "input" && nativeEvent.type !== "change")
      || nativeEvent.target !== input
      || nativeEvent.defaultPrevented
      || next !== input.value
    ) {
      return null;
    }
    const commit = currentCommit(candidate, { input, value: next });
    if (
      !commit
      || commit.input !== input
      || !commit.facts.inputEligible
      || next === commit.facts.draft
      || claimedEvents.current.has(event)
      || claimedEvents.current.has(nativeEvent)
      || consumedCommits.current.has(commit)
      || dispatchingCommits.current.has(commit)
    ) {
      return null;
    }
    claimedEvents.current.add(event);
    claimedEvents.current.add(nativeEvent);
    consumedCommits.current.add(commit);
    return { commit, next };
  };
  const claimSubmit = (event: FormEvent<HTMLFormElement>) => {
    const form = candidate.form.element;
    const ownerWindow = form?.ownerDocument.defaultView;
    const nativeEvent = event.nativeEvent;
    if (
      !form
      || !ownerWindow?.SubmitEvent
      || event.type !== "submit"
      || event.currentTarget !== form
      || event.target !== form
      || event.defaultPrevented
      || !(nativeEvent instanceof ownerWindow.SubmitEvent)
      || nativeEvent.type !== "submit"
      || nativeEvent.target !== form
      || nativeEvent.defaultPrevented
    ) {
      return null;
    }
    const commit = currentCommit(candidate);
    const submitter = nativeEvent.submitter;
    if (
      !commit
      || commit.form !== form
      || !commit.save
      || !commit.facts.save?.eligible
      || (submitter !== null && submitter !== commit.save)
      || commit.save.disabled
      || commit.save.getAttribute("aria-disabled") === "true"
      || claimedEvents.current.has(event)
      || claimedEvents.current.has(nativeEvent)
      || consumedCommits.current.has(commit)
      || dispatchingCommits.current.has(commit)
    ) {
      return null;
    }
    claimedEvents.current.add(event);
    claimedEvents.current.add(nativeEvent);
    consumedCommits.current.add(commit);
    return commit;
  };
  const closeRename = (commit: RowCommit) => {
    const visit = commit.facts.renameVisit;
    if (!visit) return;
    returnFocus.current = Object.freeze({ mount, visit, tokenId: commit.facts.token.id });
    setRenameDraft((current) => current?.visit === visit ? null : current);
  };

  useLayoutEffect(() => {
    activeMount.current = mount;
    return () => {
      if (activeMount.current === mount) activeMount.current = null;
      const current = activeCommit.current;
      if (current?.facts.mount === mount) activeCommit.current = null;
      if (saveOwner.current?.mount === mount) saveOwner.current = null;
      if (returnFocus.current?.mount === mount) returnFocus.current = null;
    };
  }, [mount]);
  useLayoutEffect(() => {
    retireCandidate(candidate);
    const commit = buildCommit();
    if (!commit || !factsAreCurrent(facts)) return;
    committedCandidates.current.add(candidate);
    activeCommit.current = commit;
    return () => {
      if (activeCommit.current === commit) activeCommit.current = null;
    };
  });
  useLayoutEffect(() => {
    if (!renameDraft) {
      focusedRename.current = null;
      return;
    }
    const commit = currentCommit(candidate);
    if (
      commit?.facts.renameVisit === renameDraft.visit
      && commit.input?.isConnected
      && (focusedRename.current?.visit !== renameDraft.visit || focusedRename.current.input !== commit.input)
    ) {
      focusedRename.current = { visit: renameDraft.visit, input: commit.input };
      commit.input.focus();
    }
  });
  useLayoutEffect(() => {
    if (!matching) {
      focusedMatch.current = null;
      return;
    }
    const commit = currentCommit(candidate);
    if (!commit || focusedMatch.current === commit.row) return;
    focusedMatch.current = commit.row;
    commit.row.focus();
    commit.row.scrollIntoView?.({ block: "nearest" });
  });
  useLayoutEffect(() => {
    const intent = returnFocus.current;
    if (!intent) return;
    const commit = currentCommit(candidate);
    if (
      !commit
      || commit.facts.renameVisit
      || commit.facts.mount !== intent.mount
      || commit.facts.token.id !== intent.tokenId
      || !commit.rename
      || !commit.facts.rename?.eligible
    ) {
      return;
    }
    returnFocus.current = null;
    commit.rename.focus();
  });

  return (
    <li ref={(element) => bindElement(candidate.row, element)} tabIndex={-1} className={facts.rowClassName}
      data-testid="token-row" data-token-match={facts.matching || undefined}>
      <div ref={(element) => bindElement(candidate.header, element)} className="flex min-w-0 flex-wrap items-center gap-2">
        <span className="min-w-0 break-all text-sm font-semibold text-ink">{facts.token.name}</span>
        <ScopeChip scope={facts.token.scope} /><span className="text-xs text-ink-3">{facts.state}</span>
        <span className="text-xs text-ink-3" data-testid="token-documents-count">{facts.documentCount}</span>
      </div>
      <p ref={(element) => bindElement(candidate.metadata, element)} className="text-xs text-ink-3">{facts.metadata}</p>
      {facts.mismatchText && <p ref={(element) => bindElement(candidate.mismatch, element)} className="text-xs text-ink-2">{facts.mismatchText}</p>}
      {facts.expiredText && <p ref={(element) => bindElement(candidate.expired, element)} className="text-xs text-ink-3">{facts.expiredText}</p>}
      {facts.actionsVisible && <div ref={(element) => bindElement(candidate.actions, element)} className="flex flex-wrap gap-2">
        <button ref={(element) => bindElement(candidate.rename, element)} type="button" className="btn btn-outline btn-sm"
          disabled={!facts.rename?.eligible} onClick={(event) => {
            const commit = claimClick(event, "rename", true);
            if (!commit) return;
            const visit = Object.freeze<RenameVisit>({
              identity: Symbol("token-row-rename"),
              mount,
              tokenId: commit.facts.token.id,
            });
            setRenameDraft(Object.freeze({ visit, value: commit.facts.token.name }));
          }} aria-label={facts.renameLabel}>Rename</button>
        <button ref={(element) => bindElement(candidate.replace, element)} type="button" className="btn btn-outline btn-sm"
          disabled={!facts.replace?.eligible} onClick={(event) => {
            const commit = claimClick(event, "replace", false);
            if (!commit) return;
            try {
              void commit.facts.onAction("replace");
            } finally {
              dispatchingCommits.current.delete(commit);
            }
          }} aria-label={facts.replaceLabel}>Replace</button>
        <button ref={(element) => bindElement(candidate.revoke, element)} type="button" className="btn btn-outline btn-sm text-danger"
          disabled={!facts.revoke?.eligible} onClick={(event) => {
            const commit = claimClick(event, "revoke", false);
            if (!commit) return;
            try {
              void commit.facts.onAction("revoke");
            } finally {
              dispatchingCommits.current.delete(commit);
            }
          }} aria-label={facts.revokeLabel} data-testid="token-revoke">Revoke</button>
      </div>}
      {facts.renameVisit && <form ref={(element) => bindElement(candidate.form, element)} className="flex min-w-0 flex-col gap-2"
        onSubmit={(event) => {
          const commit = claimSubmit(event);
          const visit = commit?.facts.renameVisit;
          const name = commit?.facts.draft;
          if (!commit || !visit || typeof name !== "string" || saveOwner.current) return;
          const owner = Object.freeze<SaveOwner>({
            mount,
            visit,
            token: commit.facts.token.source,
            callback: commit.facts.onAction,
            name,
            commit,
          });
          saveOwner.current = owner;
          event.preventDefault();
          const settlement = owner.callback("rename", owner.name);
          void settlement.then((ok) => {
            if (saveOwner.current !== owner || activeMount.current !== owner.mount) return;
            const current = activeCommit.current;
            if (
              !current
              || current.facts.mount !== owner.mount
              || current.facts.renameVisit !== owner.visit
              || current.facts.token.id !== owner.token.id
            ) {
              saveOwner.current = null;
              return;
            }
            saveOwner.current = null;
            if (ok) closeRename(current);
          });
        }}>
        <label className="text-xs text-ink-2">Token name<input ref={(element) => bindElement(candidate.input, element)}
          className="input mt-1 w-full min-w-0" value={facts.draft ?? ""} maxLength={80} disabled={!facts.inputEligible}
          onChange={(event) => {
            const claimed = claimInput(event);
            if (!claimed || !claimed.commit.facts.renameVisit) return;
            setRenameDraft(Object.freeze({ visit: claimed.commit.facts.renameVisit, value: claimed.next }));
          }} /></label>
        <p className="text-xs text-ink-3">This changes the agent name and @mention, not its secret or permissions.</p>
        <div className="flex flex-wrap gap-2">
          <button ref={(element) => bindElement(candidate.save, element)} type="submit" className="btn btn-primary btn-sm" disabled={!facts.save?.eligible}>Save name</button>
          <button ref={(element) => bindElement(candidate.cancel, element)} type="button" className="btn btn-ghost btn-sm"
            disabled={!facts.cancel?.eligible} onClick={(event) => {
              const commit = claimClick(event, "cancel", true);
              if (commit) closeRename(commit);
            }}>Cancel rename</button>
        </div>
      </form>}
      <details ref={(element) => bindElement(candidate.details, element)} className="min-w-0 text-xs text-ink-3">
        <summary className="cursor-pointer">Details &amp; agent requests</summary>
        <div ref={(element) => bindElement(candidate.detailsBody, element)} className="mt-2 flex min-w-0 flex-col gap-2 break-words">
          <p className="break-all">{facts.prefixDetails}</p>
          <p>{facts.timeDetails}</p>
          <p>{facts.mcpDetails}</p>
          {facts.revokedDetails && <p>{facts.revokedDetails}</p>}
          {facts.documentDetails && <p className="break-all">{facts.documentDetails}</p>}
          {facts.actionsVisible && <div className="flex items-start gap-2">
            <button ref={(element) => bindElement(candidate.collaborators, element)} type="button" role="switch"
              aria-checked={facts.token.collaboratorsMayAsk === true} aria-labelledby={facts.switchLabelId}
              aria-describedby={facts.switchHelpId} className="switch mt-px" disabled={facts.disabled}
              onClick={facts.onCollaboratorsChange} data-testid="token-collaborators-may-ask" />
            <div><span id={facts.switchLabelId} className="font-medium text-ink-2">Collaborators may ask this agent</span>
              <p id={facts.switchHelpId}>Off: only you can send requests to it. On: people you share documents with can too.</p>
            </div>
          </div>}
        </div>
      </details>
      {facts.switchError && <p ref={(element) => bindElement(candidate.switchError, element)} className="text-xs text-danger"
        role="alert" aria-atomic="true" data-testid="token-collaborators-may-ask-error">{facts.switchError}</p>}
    </li>
  );
}
