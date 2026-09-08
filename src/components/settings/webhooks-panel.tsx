"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { Check, Copy, Loader2, Plus, Power, Send, Trash2, Webhook } from "lucide-react";
import { relativeTime } from "@/lib/utils";
import { useCopy } from "@/lib/hooks";
import { ApiError, apiErrorText } from "@/lib/api";

interface WebhookRow {
  id: string;
  url: string;
  events: string[];
  documentIds: string[] | null;
  active: boolean;
  failures: number;
  createdAt: string;
  lastDelivery: { status: number; at: string; attempt: number; event: string } | null;
}

interface MountGeneration {
  readonly identity: symbol;
}

interface Operation {
  readonly sequence: number;
  readonly generation: MountGeneration;
}

interface RowOperation extends Operation {
  readonly webhookId: string;
  readonly kind: "test" | "enable" | "delete";
}

interface CreatedWebhook {
  id: string;
  secret: string;
  url: string;
}

type DeliveryTone = "ok" | "bad" | "muted";
type PanelActionKind = "add" | "cancel" | "create" | "retry";
type RowActionKind = RowOperation["kind"];

type ActionFacts = Readonly<{
  kind: PanelActionKind;
  eligible: boolean;
  route: string | null;
}>;

type DraftInputFacts = Readonly<{
  kind: "url" | "docs";
  value: string;
  eligible: boolean;
}>;

type ChoiceFacts = Readonly<{
  kind: "choice";
  index: number;
  id: string;
  label: string;
  types: readonly string[];
  checked: boolean;
  eligible: boolean;
}>;

type DraftFacts = Readonly<{
  url: string;
  docs: string;
  choices: readonly string[];
  urlInput: DraftInputFacts;
  docsInput: DraftInputFacts;
  choiceInputs: readonly ChoiceFacts[];
}>;

type LastDeliveryFacts = Readonly<{
  status: number;
  at: string;
  attempt: number;
  event: string;
}>;

type RowActionFacts = Readonly<{
  kind: RowActionKind;
  eligible: boolean;
  route: string;
}>;

type WebhookRowFacts = Readonly<{
  index: number;
  id: string;
  url: string;
  events: readonly string[];
  documentIds: readonly string[] | null;
  active: boolean;
  failures: number;
  createdAt: string;
  lastDelivery: LastDeliveryFacts | null;
  details: string;
  statusText: string;
  statusTone: DeliveryTone;
  operation: RowOperation | null;
  enable: RowActionFacts | null;
  test: RowActionFacts;
  delete: RowActionFacts;
}>;

type CreatedFacts = Readonly<{
  id: string;
  secret: string;
  url: string;
}>;

type ListFacts = Readonly<{
  kind: "loading" | "unavailable" | "empty" | "rows";
  rows: readonly WebhookRowFacts[] | null;
}>;

type PanelPresentation = Readonly<{
  identity: symbol;
  generation: MountGeneration;
  adding: boolean;
  draft: DraftFacts;
  createOperation: Operation | null;
  retryOperation: Operation | null;
  feedbackOperation: Operation | null;
  listError: string | null;
  actionError: string | null;
  created: CreatedFacts | null;
  list: ListFacts;
  add: ActionFacts;
  create: ActionFacts | null;
  cancel: ActionFacts | null;
  retry: ActionFacts | null;
}>;

interface ElementSlot<T extends HTMLElement> {
  element: T | null;
  mouseTargets: readonly Node[] | null;
}

interface RowElements {
  root: ElementSlot<HTMLLIElement>;
  enable: ElementSlot<HTMLButtonElement>;
  test: ElementSlot<HTMLButtonElement>;
  delete: ElementSlot<HTMLButtonElement>;
}

interface PanelPublication {
  presentation: PanelPresentation;
  active: boolean;
  retired: boolean;
  card: ElementSlot<HTMLDivElement>;
  header: ElementSlot<HTMLDivElement>;
  guidance: ElementSlot<HTMLParagraphElement>;
  add: ElementSlot<HTMLButtonElement>;
  form: ElementSlot<HTMLFormElement>;
  url: ElementSlot<HTMLInputElement>;
  docs: ElementSlot<HTMLInputElement>;
  choices: ElementSlot<HTMLInputElement>[];
  create: ElementSlot<HTMLButtonElement>;
  cancel: ElementSlot<HTMLButtonElement>;
  listError: ElementSlot<HTMLDivElement>;
  listAlert: ElementSlot<HTMLSpanElement>;
  retry: ElementSlot<HTMLButtonElement>;
  actionError: ElementSlot<HTMLDivElement>;
  created: ElementSlot<HTMLDivElement>;
  listContent: ElementSlot<HTMLElement>;
  rowsList: ElementSlot<HTMLUListElement>;
  rows: RowElements[];
}

class PanelPublicationCoordinator {
  #current: PanelPublication | null = null;

  bind<T extends HTMLElement>(
    candidate: PanelPublication,
    owner: ElementSlot<T>,
    element: T | null,
  ) {
    if (candidate.active && owner.element !== element) this.retire(candidate);
    if (owner.element !== element) owner.mouseTargets = null;
    owner.element = element;
    if (!element) this.retire(candidate);
  }

  publish(candidate: PanelPublication) {
    const previous = this.#current;
    if (previous && previous !== candidate) this.retire(previous);
    candidate.active = true;
    this.#current = candidate;
  }

  retire(candidate: PanelPublication) {
    candidate.active = false;
    candidate.retired = true;
    if (this.#current === candidate) this.#current = null;
  }

  owns(candidate: PanelPublication) {
    return this.#current === candidate && candidate.active && !candidate.retired;
  }
}

interface InputDomOverride {
  input: HTMLInputElement;
  value?: string;
  checked?: boolean;
}

interface SecretRender {
  identity: symbol;
  panel: PanelPublication;
  created: CreatedFacts;
  copy: () => void;
  label: string;
  copied: boolean;
}

interface SecretPublication {
  render: SecretRender;
  root: HTMLDivElement;
  code: HTMLElement;
  button: HTMLButtonElement;
  mouseTargets: readonly Node[];
  claimed: boolean;
}

/** Checkbox labels; `suggestion` covers both decisions like the long-poll does. */
const EVENT_CHOICES = Object.freeze([
  Object.freeze({ id: "request.created", label: "request.created", types: Object.freeze(["request.created"]) }),
  Object.freeze({ id: "mention", label: "mention", types: Object.freeze(["mention"]) }),
  Object.freeze({ id: "comment.added", label: "comment.added", types: Object.freeze(["comment.added"]) }),
  Object.freeze({ id: "comment.replied", label: "comment.replied", types: Object.freeze(["comment.replied"]) }),
  Object.freeze({ id: "review.created", label: "review.created", types: Object.freeze(["review.created"]) }),
  Object.freeze({ id: "suggestion", label: "suggestion.accepted/rejected", types: Object.freeze(["suggestion.accepted", "suggestion.rejected"]) }),
  Object.freeze({ id: "content.changed", label: "content.changed", types: Object.freeze(["content.changed"]) }),
]);
const DEFAULT_CHOICES = Object.freeze(["request.created", "mention", "comment.added", "comment.replied"]);

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) } });
  const body = await res.text();
  const data = body ? JSON.parse(body) : null;
  if (!res.ok) {
    // Keep the 400's `issues` so the form can show the field's reason, not the bare "Invalid request".
    const err = (data ?? {}) as { error?: string; issues?: unknown };
    throw new ApiError(res.status, err.error ?? res.statusText, err.issues);
  }
  return data as T;
}

function deliveryLabel(h: WebhookRow): { text: string; tone: DeliveryTone } {
  if (!h.active) return { text: `disabled after ${h.failures} failures`, tone: "bad" };
  if (!h.lastDelivery) return { text: "no deliveries yet", tone: "muted" };
  const d = h.lastDelivery;
  const ok = d.status >= 200 && d.status < 300;
  if (ok) return { text: `${d.status} · ${relativeTime(d.at)}`, tone: "ok" };
  if (h.failures === 0) return { text: `enabled · last attempt ${d.status || "no response"} · ${relativeTime(d.at)}`, tone: "muted" };
  return { text: `failed ×${h.failures}${d.status ? ` · ${d.status}` : " · no response"} · ${relativeTime(d.at)}`, tone: "bad" };
}

function snapshotRow(h: WebhookRow, index: number, operation: RowOperation | null): WebhookRowFacts {
  const events = Object.freeze([...h.events]);
  const documentIds = h.documentIds ? Object.freeze([...h.documentIds]) : null;
  const lastDelivery = h.lastDelivery
    ? Object.freeze({
        status: h.lastDelivery.status,
        at: h.lastDelivery.at,
        attempt: h.lastDelivery.attempt,
        event: h.lastDelivery.event,
      })
    : null;
  const status = deliveryLabel(h);
  const eligible = operation === null;
  return Object.freeze({
    index,
    id: h.id,
    url: h.url,
    events,
    documentIds,
    active: h.active,
    failures: h.failures,
    createdAt: h.createdAt,
    lastDelivery,
    details: `${events.join(", ")}${
      documentIds
        ? ` · ${documentIds.length} document${documentIds.length === 1 ? "" : "s"}`
        : " · all documents"
    } · added ${relativeTime(h.createdAt)}`,
    statusText: status.text,
    statusTone: status.tone,
    operation,
    enable: h.active
      ? null
      : Object.freeze({ kind: "enable" as const, eligible, route: `/api/webhooks/${h.id}/enable` }),
    test: Object.freeze({ kind: "test" as const, eligible, route: `/api/webhooks/${h.id}/test` }),
    delete: Object.freeze({ kind: "delete" as const, eligible, route: `/api/webhooks/${h.id}` }),
  });
}

function arraysMatch(current: readonly string[], snapshot: readonly string[]): boolean {
  return current.length === snapshot.length && current.every((value, index) => value === snapshot[index]);
}

function rowMatchesSnapshot(row: WebhookRow, snapshot: WebhookRowFacts): boolean {
  const delivery = row.lastDelivery;
  const frozenDelivery = snapshot.lastDelivery;
  return (
    row.id === snapshot.id &&
    row.url === snapshot.url &&
    arraysMatch(row.events, snapshot.events) &&
    (row.documentIds
      ? snapshot.documentIds !== null && arraysMatch(row.documentIds, snapshot.documentIds)
      : snapshot.documentIds === null) &&
    row.active === snapshot.active &&
    row.failures === snapshot.failures &&
    row.createdAt === snapshot.createdAt &&
    (delivery
      ? frozenDelivery !== null &&
        delivery.status === frozenDelivery.status &&
        delivery.at === frozenDelivery.at &&
        delivery.attempt === frozenDelivery.attempt &&
        delivery.event === frozenDelivery.event
      : frozenDelivery === null)
  );
}

function createdMatchesSnapshot(created: CreatedWebhook | null, snapshot: CreatedFacts | null): boolean {
  return created
    ? snapshot !== null &&
        created.id === snapshot.id &&
        created.secret === snapshot.secret &&
        created.url === snapshot.url
    : snapshot === null;
}

function snapshotMouseTargets(control: HTMLButtonElement): readonly Node[] {
  return Object.freeze([control, ...Array.from(control.querySelectorAll("*"))]);
}

function isNativeReactMouseEvent(
  event: ReactMouseEvent<HTMLButtonElement>,
  control: HTMLButtonElement | null,
  mouseTargets: readonly Node[] | null,
): boolean {
  const ownerWindow = control?.ownerDocument.defaultView;
  const target = event.target;
  return (
    !!control &&
    !!ownerWindow &&
    event.currentTarget === control &&
    event.type === "click" &&
    !event.defaultPrevented &&
    event.nativeEvent instanceof ownerWindow.MouseEvent &&
    event.nativeEvent.type === "click" &&
    !event.nativeEvent.defaultPrevented &&
    event.nativeEvent.target === target &&
    target instanceof ownerWindow.Node &&
    control.contains(target) &&
    mouseTargets?.includes(target) === true
  );
}

function isNativeReactSubmitEvent(event: FormEvent<HTMLFormElement>): boolean {
  return (
    event.type === "submit" &&
    !event.defaultPrevented &&
    typeof window !== "undefined" &&
    event.nativeEvent instanceof window.Event &&
    event.nativeEvent.type === "submit" &&
    !event.nativeEvent.defaultPrevented
  );
}

function slot<T extends HTMLElement>(): ElementSlot<T> {
  return { element: null, mouseTargets: null };
}

function createPanelPublication(presentation: PanelPresentation): PanelPublication {
  return {
    presentation,
    active: false,
    retired: false,
    card: slot(),
    header: slot(),
    guidance: slot(),
    add: slot(),
    form: slot(),
    url: slot(),
    docs: slot(),
    choices: presentation.draft.choiceInputs.map(() => slot<HTMLInputElement>()),
    create: slot(),
    cancel: slot(),
    listError: slot(),
    listAlert: slot(),
    retry: slot(),
    actionError: slot(),
    created: slot(),
    listContent: slot(),
    rowsList: slot(),
    rows: presentation.list.rows?.map(() => ({
      root: slot<HTMLLIElement>(),
      enable: slot<HTMLButtonElement>(),
      test: slot<HTMLButtonElement>(),
      delete: slot<HTMLButtonElement>(),
    })) ?? [],
  };
}

function SecretField({
  panel,
  created,
  ownsPanel,
}: {
  panel: PanelPublication;
  created: CreatedFacts;
  ownsPanel: (
    publication: PanelPublication,
    override?: InputDomOverride,
    focus?: HTMLElement,
  ) => boolean;
}) {
  const codeTarget = useRef<HTMLElement>(null);
  const { copy, label, copied } = useCopy(created.secret, codeTarget);
  const activePublicationRef = useRef<SecretPublication | null>(null);
  const rootOwnerRef = useRef<{ render: SecretRender; element: HTMLDivElement } | null>(null);
  const codeOwnerRef = useRef<{ render: SecretRender; element: HTMLElement } | null>(null);
  const buttonOwnerRef = useRef<{ render: SecretRender; element: HTMLButtonElement } | null>(null);
  const render = Object.freeze<SecretRender>({
    identity: Symbol("webhook-secret-render"),
    panel,
    created,
    copy,
    label,
    copied,
  });

  const retire = (candidate: SecretPublication | null) => {
    if (candidate && activePublicationRef.current === candidate) activePublicationRef.current = null;
  };
  const bind = <T extends HTMLElement>(
    ownerRef: React.MutableRefObject<{ render: SecretRender; element: T } | null>,
    element: T | null,
  ) => {
    const owner = ownerRef.current;
    if (!element) {
      if (owner?.render === render) ownerRef.current = null;
      if (activePublicationRef.current?.render === render) retire(activePublicationRef.current);
      return;
    }
    if (owner?.render === render && owner.element !== element) retire(activePublicationRef.current);
    ownerRef.current = { render, element };
  };

  useLayoutEffect(() => {
    const root = rootOwnerRef.current?.render === render ? rootOwnerRef.current.element : null;
    const code = codeOwnerRef.current?.render === render ? codeOwnerRef.current.element : null;
    const button = buttonOwnerRef.current?.render === render ? buttonOwnerRef.current.element : null;
    if (!root || !code || !button) return;
    const publication: SecretPublication = {
      render,
      root,
      code,
      button,
      mouseTargets: snapshotMouseTargets(button),
      claimed: false,
    };
    activePublicationRef.current = publication;
    return () => retire(publication);
  });

  const currentPublication = (button: HTMLButtonElement) => {
    const publication = activePublicationRef.current;
    const createdRoot = panel.created.element;
    if (
      !publication ||
      publication.render !== render ||
      publication.claimed ||
      publication.button !== button ||
      rootOwnerRef.current?.render !== render ||
      rootOwnerRef.current.element !== publication.root ||
      codeOwnerRef.current?.render !== render ||
      codeOwnerRef.current.element !== publication.code ||
      buttonOwnerRef.current?.render !== render ||
      buttonOwnerRef.current.element !== publication.button ||
      !ownsPanel(panel, undefined, publication.button) ||
      !createdRoot ||
      !publication.root.isConnected ||
      !publication.code.isConnected ||
      !publication.button.isConnected ||
      publication.root.parentElement !== createdRoot ||
      createdRoot.children.item(1) !== publication.root ||
      publication.root.children.length !== 2 ||
      publication.root.children.item(0) !== publication.code ||
      publication.root.children.item(1) !== publication.button ||
      publication.code.parentElement !== publication.root ||
      publication.button.parentElement !== publication.root ||
      publication.code.textContent !== created.secret ||
      publication.code.dataset.testid !== "webhook-secret" ||
      publication.button.type !== "button" ||
      publication.button.disabled ||
      publication.button.getAttribute("aria-label") !== "Copy secret" ||
      publication.button.textContent?.trim() !== label
    ) {
      return null;
    }
    return publication;
  };

  return (
    <div
      ref={(element) => bind(rootOwnerRef, element)}
      className="flex items-center gap-2"
    >
      <code
        ref={(element) => {
          codeTarget.current = element;
          bind(codeOwnerRef, element);
        }}
        className="min-w-0 flex-1 select-text break-all rounded-lg border border-line bg-surface-2 px-3 py-2 font-mono text-[13px] text-ink"
        data-testid="webhook-secret"
      >
        {created.secret}
      </code>
      <button
        ref={(element) => bind(buttonOwnerRef, element)}
        type="button"
        className="btn btn-outline btn-sm shrink-0 gap-1.5"
        onClick={(event) => {
          const publication = currentPublication(event.currentTarget);
          if (
            !publication ||
            !isNativeReactMouseEvent(event, publication.button, publication.mouseTargets)
          ) {
            return;
          }
          publication.claimed = true;
          render.copy();
        }}
        aria-label="Copy secret"
      >
        {copied ? <Check size={14} className="text-success" /> : <Copy size={14} />}
        {label}
      </button>
    </div>
  );
}

export function WebhooksPanel() {
  const [hooks, setHooks] = useState<WebhookRow[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [url, setUrl] = useState("");
  const [choices, setChoices] = useState<string[]>(() => [...DEFAULT_CHOICES]);
  const [docs, setDocs] = useState("");
  const [createOperation, setCreateOperation] = useState<Operation | null>(null);
  const [rowOperations, setRowOperations] = useState<Map<string, RowOperation>>(() => new Map());
  const [error, setError] = useState<string | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [retryOperation, setRetryOperation] = useState<Operation | null>(null);
  const [feedbackOperation, setFeedbackOperation] = useState<Operation | null>(null);
  const [created, setCreated] = useState<CreatedWebhook | null>(null);
  const [mountGeneration] = useState<MountGeneration>(() => Object.freeze({ identity: Symbol("webhooks-mount") }));
  const activeMountRef = useRef<MountGeneration | null>(null);
  const operationSequence = useRef(0);
  const createOwner = useRef<Operation | null>(null);
  const rowOwners = useRef(new Map<string, RowOperation>());
  const feedbackOwner = useRef<Operation | null>(null);
  const retryOwner = useRef<Operation | null>(null);
  const listRequest = useRef(0);
  const [publicationCoordinator] = useState(() => new PanelPublicationCoordinator());
  const claimedActionsRef = useRef(new WeakSet<object>());
  const deleteClaimsRef = useRef(new Set<RowActionFacts>());
  const deleteEventsRef = useRef(new WeakSet<object>());

  useLayoutEffect(() => {
    const owners = rowOwners.current;
    const deleteClaims = deleteClaimsRef.current;
    activeMountRef.current = mountGeneration;
    return () => {
      if (activeMountRef.current !== mountGeneration) return;
      activeMountRef.current = null;
      listRequest.current += 1;
      if (retryOwner.current?.generation === mountGeneration) retryOwner.current = null;
      if (createOwner.current?.generation === mountGeneration) createOwner.current = null;
      for (const [webhookId, operation] of owners) {
        if (operation.generation === mountGeneration) owners.delete(webhookId);
      }
      if (feedbackOwner.current?.generation === mountGeneration) feedbackOwner.current = null;
      deleteClaims.clear();
    };
  }, [mountGeneration]);

  const load = useCallback(async (continuationIsCurrent: () => boolean = () => true) => {
    const generation = activeMountRef.current;
    if (!generation) return;
    const currentRequest = ++listRequest.current;
    try {
      const res = await request<{ webhooks: WebhookRow[] }>("/api/webhooks");
      if (generation !== activeMountRef.current || currentRequest !== listRequest.current || !continuationIsCurrent()) return;
      setHooks(res.webhooks);
      setListError(null);
    } catch (e) {
      if (generation !== activeMountRef.current || currentRequest !== listRequest.current || !continuationIsCurrent()) return;
      setListError(apiErrorText(e, "Failed to load webhooks"));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const isCreateCurrent = (operation: Operation) =>
    operation.generation === activeMountRef.current && createOwner.current === operation;

  const isRetryCurrent = (operation: Operation) =>
    operation.generation === activeMountRef.current && retryOwner.current === operation;

  const isRowCurrent = (operation: RowOperation) =>
    operation.generation === activeMountRef.current && rowOwners.current.get(operation.webhookId) === operation;

  const nextOperation = (): Operation | null => {
    const generation = activeMountRef.current;
    if (!generation) return null;
    return Object.freeze({
      sequence: ++operationSequence.current,
      generation,
    });
  };

  const claimFeedback = (operation: Operation) => {
    feedbackOwner.current = operation;
    setFeedbackOperation(operation);
    setError(null);
  };

  const beginRowOperation = (webhookId: string, kind: RowOperation["kind"]): RowOperation | null => {
    const generation = activeMountRef.current;
    if (!generation || rowOwners.current.has(webhookId)) return null;
    const operation = Object.freeze({
      sequence: ++operationSequence.current,
      generation,
      webhookId,
      kind,
    });
    claimFeedback(operation);
    rowOwners.current.set(webhookId, operation);
    setRowOperations((current) => new Map(current).set(webhookId, operation));
    return operation;
  };

  const finishRowOperation = (operation: RowOperation) => {
    if (!isRowCurrent(operation)) return;
    rowOwners.current.delete(operation.webhookId);
    setRowOperations((current) => {
      if (current.get(operation.webhookId) !== operation) return current;
      const next = new Map(current);
      next.delete(operation.webhookId);
      return next;
    });
  };

  const setOperationError = (operation: Operation, message: string) => {
    if (operation.generation === activeMountRef.current && feedbackOwner.current === operation) {
      setError(message);
    }
  };

  const startCreate = (presentation: PanelPresentation) => {
    if (createOwner.current) return;
    const operation = nextOperation();
    if (!operation) return;
    claimFeedback(operation);
    createOwner.current = operation;
    setCreateOperation(operation);
    const exactUrl = presentation.draft.url;
    const exactDocs = presentation.draft.docs;
    const exactChoices = presentation.draft.choiceInputs;
    const events = exactChoices.filter((choice) => choice.checked).flatMap((choice) => [...choice.types]);
    const documentIds = exactDocs
      .split(/[\s,]+/)
      .map((value) => value.trim().replace(/^.*\/d\//, ""))
      .filter(Boolean);
    void (async () => {
      try {
        const res = await request<{ webhook: WebhookRow & { secret: string } }>(presentation.create!.route!, {
          method: "POST",
          body: JSON.stringify({ url: exactUrl, events, documentIds: documentIds.length ? documentIds : null }),
        });
        if (!isCreateCurrent(operation)) return;
        setCreated({ id: res.webhook.id, secret: res.webhook.secret, url: res.webhook.url });
        setUrl("");
        setDocs("");
        setAdding(false);
        await load(() => isCreateCurrent(operation));
      } catch (e) {
        if (isCreateCurrent(operation)) {
          setOperationError(operation, apiErrorText(e, "Could not add webhook"));
        }
      } finally {
        if (isCreateCurrent(operation)) {
          createOwner.current = null;
          setCreateOperation((current) => (current === operation ? null : current));
        }
      }
    })();
  };

  const startRetry = (route: string) => {
    if (route !== "/api/webhooks" || retryOwner.current) return;
    const operation = nextOperation();
    if (!operation) return;
    retryOwner.current = operation;
    setRetryOperation(operation);
    void load(() => isRetryCurrent(operation)).finally(() => {
      if (!isRetryCurrent(operation)) return;
      retryOwner.current = null;
      setRetryOperation((current) => (current === operation ? null : current));
    });
  };

  const startTest = (row: WebhookRowFacts) => {
    const operation = beginRowOperation(row.id, "test");
    if (!operation) return;
    void (async () => {
      try {
        await request(row.test.route, { method: "POST" });
        if (!isRowCurrent(operation)) return;
        await load(() => isRowCurrent(operation));
      } catch (e) {
        if (isRowCurrent(operation)) {
          setOperationError(operation, apiErrorText(e, "Test failed"));
        }
      } finally {
        finishRowOperation(operation);
      }
    })();
  };

  const startEnable = (row: WebhookRowFacts) => {
    const operation = beginRowOperation(row.id, "enable");
    if (!operation || !row.enable) return;
    void (async () => {
      try {
        await request<{ webhook: WebhookRow }>(row.enable!.route, { method: "POST" });
        if (!isRowCurrent(operation)) return;
        await load(() => isRowCurrent(operation));
      } catch (e) {
        if (isRowCurrent(operation)) {
          setOperationError(operation, apiErrorText(e, "Could not enable webhook"));
        }
      } finally {
        finishRowOperation(operation);
      }
    })();
  };

  const startDelete = (row: WebhookRowFacts) => {
    const operation = beginRowOperation(row.id, "delete");
    if (!operation) return;
    void (async () => {
      try {
        await request(row.delete.route, { method: "DELETE" });
        if (!isRowCurrent(operation)) return;
        setCreated((current) => (current?.id === row.id ? null : current));
        await load(() => isRowCurrent(operation));
      } catch (e) {
        if (isRowCurrent(operation)) {
          setOperationError(operation, apiErrorText(e, "Could not delete webhook"));
        }
      } finally {
        finishRowOperation(operation);
      }
    })();
  };

  const retrying = retryOperation !== null;
  const choiceInputs = Object.freeze(
    EVENT_CHOICES.map((choice, index) =>
      Object.freeze<ChoiceFacts>({
        kind: "choice",
        index,
        id: choice.id,
        label: choice.label,
        types: choice.types,
        checked: choices.includes(choice.id),
        eligible: createOperation === null,
      }),
    ),
  );
  const draft = Object.freeze<DraftFacts>({
    url,
    docs,
    choices: Object.freeze([...choices]),
    urlInput: Object.freeze({ kind: "url", value: url, eligible: createOperation === null }),
    docsInput: Object.freeze({ kind: "docs", value: docs, eligible: createOperation === null }),
    choiceInputs,
  });
  const rowFacts = hooks
    ? Object.freeze(hooks.map((hook, index) => snapshotRow(hook, index, rowOperations.get(hook.id) ?? null)))
    : null;
  const list = Object.freeze<ListFacts>({
    kind: hooks === null ? (listError ? "unavailable" : "loading") : hooks.length === 0 ? "empty" : "rows",
    rows: rowFacts,
  });
  const createdFacts = created
    ? Object.freeze<CreatedFacts>({ id: created.id, secret: created.secret, url: created.url })
    : null;
  const presentation = Object.freeze<PanelPresentation>({
    identity: Symbol("webhooks-presentation"),
    generation: mountGeneration,
    adding,
    draft,
    createOperation,
    retryOperation,
    feedbackOperation,
    listError,
    actionError: error,
    created: createdFacts,
    list,
    add: Object.freeze({ kind: "add", eligible: createOperation === null, route: null }),
    create: adding
      ? Object.freeze({
          kind: "create",
          eligible: createOperation === null && url.trim().length > 0 && choices.length > 0,
          route: "/api/webhooks",
        })
      : null,
    cancel: adding
      ? Object.freeze({ kind: "cancel", eligible: createOperation === null, route: null })
      : null,
    retry: listError
      ? Object.freeze({ kind: "retry", eligible: !retrying, route: "/api/webhooks" })
      : null,
  });
  const publication = createPanelPublication(presentation);

  const bindElement = <T extends HTMLElement>(
    candidate: PanelPublication,
    owner: ElementSlot<T>,
    element: T | null,
  ) => {
    publicationCoordinator.bind(candidate, owner, element);
  };

  const domIsExact = (
    candidate: PanelPublication,
    override?: InputDomOverride,
    focus?: HTMLElement,
  ): boolean => {
    const facts = candidate.presentation;
    const card = candidate.card.element;
    const header = candidate.header.element;
    const guidance = candidate.guidance.element;
    const addButton = candidate.add.element;
    if (
      !card ||
      !header ||
      !guidance ||
      !addButton ||
      !card.isConnected ||
      !header.isConnected ||
      !guidance.isConnected ||
      !addButton.isConnected ||
      card.id !== "webhooks" ||
      card.dataset.testid !== "webhooks-card" ||
      card.children.item(0) !== header ||
      card.children.item(1) !== guidance ||
      header.parentElement !== card ||
      guidance.parentElement !== card ||
      header.lastElementChild !== addButton ||
      addButton.parentElement !== header ||
      addButton.type !== "button" ||
      ((!focus || focus === addButton) && addButton.disabled !== !facts.add.eligible) ||
      addButton.dataset.testid !== "webhook-add" ||
      addButton.textContent?.trim() !== "Add webhook"
    ) {
      return false;
    }

    const directChildren: HTMLElement[] = [header, guidance];
    const form = candidate.form.element;
    if (facts.adding) {
      const urlInput = candidate.url.element;
      const docsInput = candidate.docs.element;
      const createButton = candidate.create.element;
      const cancelButton = candidate.cancel.element;
      if (
        !facts.create ||
        !facts.cancel ||
        !form ||
        !urlInput ||
        !docsInput ||
        !createButton ||
        !cancelButton ||
        !form.isConnected ||
        !urlInput.isConnected ||
        !docsInput.isConnected ||
        !createButton.isConnected ||
        !cancelButton.isConnected ||
        form.parentElement !== card ||
        form.dataset.testid !== "webhook-form" ||
        form.getAttribute("aria-busy") !== (facts.createOperation ? "true" : null) ||
        form.children.length !== 4 ||
        urlInput.form !== form ||
        docsInput.form !== form ||
        createButton.form !== form ||
        cancelButton.form !== form ||
        form.children.item(0) !== urlInput.parentElement ||
        form.children.item(2) !== docsInput.parentElement ||
        form.children.item(3) !== createButton.parentElement ||
        createButton.parentElement !== cancelButton.parentElement ||
        createButton.parentElement?.children.length !== 2 ||
        createButton.parentElement.children.item(0) !== createButton ||
        createButton.parentElement.children.item(1) !== cancelButton ||
        urlInput.dataset.testid !== "webhook-url" ||
        ((!focus || focus === createButton || focus === urlInput) &&
          urlInput.value !== (override?.input === urlInput && override.value !== undefined ? override.value : facts.draft.url)) ||
        ((!focus || focus === createButton || focus === urlInput) &&
          urlInput.disabled !== !facts.draft.urlInput.eligible) ||
        !urlInput.required ||
        docsInput.dataset.testid !== "webhook-docs" ||
        ((!focus || focus === createButton || focus === docsInput) &&
          docsInput.value !== (override?.input === docsInput && override.value !== undefined ? override.value : facts.draft.docs)) ||
        ((!focus || focus === createButton || focus === docsInput) &&
          docsInput.disabled !== !facts.draft.docsInput.eligible) ||
        createButton.dataset.testid !== "webhook-create" ||
        createButton.type !== "submit" ||
        ((!focus || focus === createButton) && createButton.disabled !== !facts.create.eligible) ||
        createButton.textContent?.trim() !== "Add webhook" ||
        cancelButton.type !== "button" ||
        ((!focus || focus === cancelButton) && cancelButton.disabled !== !facts.cancel.eligible) ||
        cancelButton.textContent?.trim() !== "Cancel"
      ) {
        return false;
      }
      const fieldset = form.children.item(1);
      const choicesContainer = fieldset?.children.item(1);
      if (
        !(fieldset instanceof HTMLFieldSetElement) ||
        fieldset.disabled !== (facts.createOperation !== null) ||
        !choicesContainer ||
        choicesContainer.children.length !== facts.draft.choiceInputs.length ||
        candidate.choices.length !== facts.draft.choiceInputs.length
      ) {
        return false;
      }
      for (const choice of facts.draft.choiceInputs) {
        const input = candidate.choices[choice.index]?.element;
        const label: Element | null = choicesContainer.children.item(choice.index);
        if (
          !input ||
          !input.isConnected ||
          input.form !== form ||
          input.parentElement !== label ||
          label?.parentElement !== choicesContainer ||
          input.type !== "checkbox" ||
          input.dataset.testid !== `webhook-event-${choice.id}` ||
          ((!focus || focus === createButton || focus === input) &&
            input.checked !== (override?.input === input && override.checked !== undefined ? override.checked : choice.checked)) ||
          input.disabled ||
          ((!focus || focus === createButton || focus === input) &&
            input.matches(":disabled") !== !choice.eligible) ||
          label.textContent?.trim() !== choice.label
        ) {
          return false;
        }
      }
      directChildren.push(form);
    } else if (
      form ||
      candidate.url.element ||
      candidate.docs.element ||
      candidate.create.element ||
      candidate.cancel.element ||
      candidate.choices.some((choice) => choice.element)
    ) {
      return false;
    }

    const listErrorBlock = candidate.listError.element;
    const listAlert = candidate.listAlert.element;
    const retryButton = candidate.retry.element;
    if (facts.listError) {
      if (
        !facts.retry ||
        !listErrorBlock ||
        !listAlert ||
        !retryButton ||
        !listErrorBlock.isConnected ||
        !listAlert.isConnected ||
        !retryButton.isConnected ||
        listErrorBlock.parentElement !== card ||
        listErrorBlock.dataset.testid !== "webhooks-list-error" ||
        listErrorBlock.children.length !== 2 ||
        listErrorBlock.children.item(0) !== listAlert ||
        listErrorBlock.children.item(1) !== retryButton ||
        listAlert.parentElement !== listErrorBlock ||
        listAlert.getAttribute("role") !== "alert" ||
        listAlert.getAttribute("aria-atomic") !== "true" ||
        listAlert.textContent !== facts.listError ||
        retryButton.parentElement !== listErrorBlock ||
        retryButton.type !== "button" ||
        ((!focus || focus === retryButton) && retryButton.disabled !== !facts.retry.eligible) ||
        retryButton.getAttribute("aria-busy") !== (facts.retryOperation ? "true" : null) ||
        retryButton.textContent?.trim() !== (facts.retryOperation ? "Retrying…" : "Retry")
      ) {
        return false;
      }
      directChildren.push(listErrorBlock);
    } else if (listErrorBlock || listAlert || retryButton || facts.retry) {
      return false;
    }

    const actionError = candidate.actionError.element;
    if (facts.actionError) {
      if (
        !actionError ||
        !actionError.isConnected ||
        actionError.parentElement !== card ||
        actionError.dataset.testid !== "webhook-action-error" ||
        actionError.getAttribute("role") !== "alert" ||
        actionError.getAttribute("aria-atomic") !== "true" ||
        actionError.textContent !== facts.actionError
      ) {
        return false;
      }
      directChildren.push(actionError);
    } else if (actionError) {
      return false;
    }

    const createdRoot = candidate.created.element;
    if (facts.created) {
      if (
        !createdRoot ||
        !createdRoot.isConnected ||
        createdRoot.parentElement !== card ||
        createdRoot.dataset.testid !== "webhook-created" ||
        createdRoot.getAttribute("role") !== "status" ||
        createdRoot.getAttribute("aria-live") !== "polite" ||
        createdRoot.getAttribute("aria-atomic") !== "true" ||
        createdRoot.children.length !== 3 ||
        createdRoot.children.item(0)?.textContent !== "Webhook added. Copy the signing secret now; it will not be shown again."
      ) {
        return false;
      }
      directChildren.push(createdRoot);
    } else if (createdRoot) {
      return false;
    }

    const listContent = candidate.listContent.element;
    const rowsList = candidate.rowsList.element;
    if (facts.list.kind === "unavailable") {
      if (listContent || rowsList || candidate.rows.length !== 0) return false;
    } else if (facts.list.kind === "loading") {
      if (
        !listContent ||
        !listContent.isConnected ||
        listContent.parentElement !== card ||
        listContent.textContent !== "Loading…" ||
        rowsList ||
        candidate.rows.length !== 0
      ) {
        return false;
      }
      directChildren.push(listContent);
    } else if (facts.list.kind === "empty") {
      if (
        !listContent ||
        !listContent.isConnected ||
        listContent.parentElement !== card ||
        listContent.dataset.testid !== "webhooks-empty" ||
        listContent.textContent?.trim() !== "No webhooks yet." ||
        rowsList ||
        candidate.rows.length !== 0
      ) {
        return false;
      }
      directChildren.push(listContent);
    } else {
      const rows = facts.list.rows;
      if (
        !rows ||
        !listContent ||
        !rowsList ||
        listContent !== rowsList ||
        !rowsList.isConnected ||
        rowsList.parentElement !== card ||
        rowsList.children.length !== rows.length ||
        candidate.rows.length !== rows.length
      ) {
        return false;
      }
      for (const row of rows) {
        const elements = candidate.rows[row.index];
        const root = elements?.root.element;
        const enableButton = elements?.enable.element;
        const testButton = elements?.test.element;
        const deleteButton = elements?.delete.element;
        const status = root?.children.item(1);
        const content = root?.children.item(0);
        const expectedChildren = row.enable ? 5 : 4;
        const validateEligibility = !focus || (root?.contains(focus) ?? false);
        if (
          !elements ||
          !root ||
          !testButton ||
          !deleteButton ||
          !root.isConnected ||
          !testButton.isConnected ||
          !deleteButton.isConnected ||
          rowsList.children.item(row.index) !== root ||
          root.parentElement !== rowsList ||
          root.dataset.testid !== "webhook-row" ||
          root.children.length !== expectedChildren ||
          !content ||
          content.children.length !== 2 ||
          content.children.item(0)?.textContent !== row.url ||
          content.children.item(1)?.textContent !== row.details ||
          status?.getAttribute("data-testid") !== "webhook-status" ||
          status.textContent?.trim() !== row.statusText ||
          !status.classList.contains(row.statusTone === "ok" ? "text-success" : row.statusTone === "bad" ? "text-danger" : "text-ink-3") ||
          testButton.parentElement !== root ||
          testButton.type !== "button" ||
          testButton.dataset.testid !== "webhook-test" ||
          (validateEligibility && testButton.disabled !== !row.test.eligible) ||
          testButton.textContent?.trim() !== "Send test" ||
          deleteButton.parentElement !== root ||
          deleteButton.type !== "button" ||
          deleteButton.dataset.testid !== "webhook-delete" ||
          (validateEligibility && deleteButton.disabled !== !row.delete.eligible) ||
          deleteButton.getAttribute("aria-label") !== `Delete webhook ${row.url}` ||
          root.lastElementChild !== deleteButton
        ) {
          return false;
        }
        if (row.enable) {
          if (
            !enableButton ||
            !enableButton.isConnected ||
            enableButton.parentElement !== root ||
            enableButton.type !== "button" ||
            enableButton.dataset.testid !== "webhook-enable" ||
            (validateEligibility && enableButton.disabled !== !row.enable.eligible) ||
            enableButton.textContent?.trim() !== "Enable" ||
            root.children.item(2) !== enableButton ||
            root.children.item(3) !== testButton
          ) {
            return false;
          }
        } else if (enableButton || root.children.item(2) !== testButton) {
          return false;
        }
      }
      directChildren.push(rowsList);
    }

    return (
      card.children.length === directChildren.length &&
      directChildren.every((element, index) => card.children.item(index) === element)
    );
  };

  const factsAreCurrent = (candidate: PanelPublication): boolean => {
    const facts = candidate.presentation;
    if (
      activeMountRef.current !== facts.generation ||
      facts.generation !== mountGeneration ||
      facts.adding !== adding ||
      facts.draft.url !== url ||
      facts.draft.docs !== docs ||
      !arraysMatch(choices, facts.draft.choices) ||
      facts.createOperation !== createOperation ||
      facts.retryOperation !== retryOperation ||
      facts.feedbackOperation !== feedbackOperation ||
      feedbackOperation !== feedbackOwner.current ||
      facts.listError !== listError ||
      facts.actionError !== error ||
      !createdMatchesSnapshot(created, facts.created) ||
      (createOperation
        ? createOwner.current !== createOperation || createOperation.generation !== mountGeneration
        : createOwner.current !== null) ||
      (retryOperation
        ? retryOwner.current !== retryOperation || retryOperation.generation !== mountGeneration
        : retryOwner.current !== null)
    ) {
      return false;
    }
    const rows = facts.list.rows;
    if (hooks === null) {
      if (rows !== null) return false;
    } else {
      if (!rows || hooks.length !== rows.length || rowOperations.size !== rows.length - rows.filter((row) => row.operation === null).length) {
        return false;
      }
      for (const row of rows) {
        const current = hooks[row.index];
        const stateOperation = rowOperations.get(row.id) ?? null;
        const ownerOperation = rowOwners.current.get(row.id) ?? null;
        if (
          !current ||
          !rowMatchesSnapshot(current, row) ||
          stateOperation !== row.operation ||
          ownerOperation !== row.operation ||
          (row.operation &&
            (row.operation.generation !== mountGeneration ||
              row.operation.webhookId !== row.id))
        ) {
          return false;
        }
      }
    }
    return true;
  };

  const ownsPanel = (
    candidate: PanelPublication,
    override?: InputDomOverride,
    focus?: HTMLElement,
  ): boolean =>
    publicationCoordinator.owns(candidate) &&
    factsAreCurrent(candidate) &&
    domIsExact(candidate, override, focus);

  const ownsPanelAction = (
    candidate: PanelPublication,
    action: ActionFacts | RowActionFacts,
    element: HTMLButtonElement,
    owner: ElementSlot<HTMLButtonElement>,
  ): boolean =>
    action.eligible &&
    owner.element === element &&
    element.isConnected &&
    !element.disabled &&
    ownsPanel(candidate, undefined, element);

  const claimAction = (action: object): boolean => {
    if (claimedActionsRef.current.has(action)) return false;
    claimedActionsRef.current.add(action);
    return true;
  };

  useLayoutEffect(() => {
    if (
      publication.retired ||
      publication.presentation.generation !== activeMountRef.current ||
      !factsAreCurrent(publication) ||
      !domIsExact(publication)
    ) {
      publicationCoordinator.retire(publication);
      return;
    }
    const publishMouseTargets = (owner: ElementSlot<HTMLButtonElement>) => {
      owner.mouseTargets = owner.element ? snapshotMouseTargets(owner.element) : null;
    };
    publishMouseTargets(publication.add);
    publishMouseTargets(publication.cancel);
    publishMouseTargets(publication.retry);
    for (const row of publication.rows) {
      publishMouseTargets(row.enable);
      publishMouseTargets(row.test);
      publishMouseTargets(row.delete);
    }
    publicationCoordinator.publish(publication);
    return () => publicationCoordinator.retire(publication);
  });

  return (
    <div
      ref={(element) => bindElement(publication, publication.card, element)}
      className="rounded-2xl border border-line bg-surface"
      id="webhooks"
      data-testid="webhooks-card"
    >
      <div
        ref={(element) => bindElement(publication, publication.header, element)}
        className="flex items-center gap-2 border-b border-line px-5 py-3 text-sm font-semibold text-ink"
      >
        <Webhook size={16} className="text-ink-3" /> Webhooks
        <button
          ref={(element) => bindElement(publication, publication.add, element)}
          type="button"
          className="btn btn-outline btn-sm ml-auto gap-1.5"
          onClick={(event) => {
            if (
              !isNativeReactMouseEvent(event, publication.add.element, publication.add.mouseTargets) ||
              !ownsPanelAction(publication, presentation.add, event.currentTarget, publication.add) ||
              !claimAction(presentation.add)
            ) {
              return;
            }
            setAdding(!presentation.adding);
          }}
          disabled={!presentation.add.eligible}
          data-testid="webhook-add"
        >
          <Plus size={14} /> Add webhook
        </button>
      </div>
      <p
        ref={(element) => bindElement(publication, publication.guidance, element)}
        className="px-5 pt-3 text-sm leading-6 text-ink-3"
      >
        Push the events <code className="text-xs">markdoc_watch</code> returns to an HTTP endpoint instead of long-polling: a GitHub Actions job, a bot, a Slack bridge. Each
        delivery is a JSON <code className="text-xs">POST</code> with <code className="text-xs">X-Markdoc-Event</code>, <code className="text-xs">X-Markdoc-Delivery</code> and{" "}
        <code className="text-xs">X-Markdoc-Signature: sha256=&lt;HMAC of the body&gt;</code>; failures are retried after 10 s, 1 min and 10 min, and a hook is disabled after 20 in a row. After fixing the receiver, enable the same hook here without changing its signing secret.
      </p>

      {presentation.adding && (
        <form
          ref={(element) => bindElement(publication, publication.form, element)}
          className="m-5 flex flex-col gap-3 rounded-xl border border-line bg-surface-2 p-4"
          data-testid="webhook-form"
          aria-busy={presentation.createOperation !== null || undefined}
          onSubmit={(event) => {
            const nativeEvent = event.nativeEvent;
            const form = publication.form.element;
            const createButton = publication.create.element;
            const submitter = "submitter" in nativeEvent ? nativeEvent.submitter : null;
            if (
              !presentation.create ||
              !form ||
              !createButton ||
              !isNativeReactSubmitEvent(event) ||
              event.currentTarget !== form ||
              event.target !== form ||
              nativeEvent.target !== form ||
              (submitter !== null && submitter !== createButton) ||
              !ownsPanelAction(publication, presentation.create, createButton, publication.create) ||
              !claimAction(presentation.create)
            ) {
              return;
            }
            event.preventDefault();
            startCreate(presentation);
          }}
        >
          <label className="flex flex-col gap-1 text-xs font-medium text-ink-3">
            URL
            <input
              ref={(element) => bindElement(publication, publication.url, element)}
              className="input"
              value={presentation.draft.url}
              onChange={(event: ChangeEvent<HTMLInputElement>) => {
                const input = publication.url.element;
                const next = event.currentTarget.value;
                if (
                  !input ||
                  event.currentTarget !== input ||
                  event.target !== input ||
                  !presentation.draft.urlInput.eligible ||
                  next === presentation.draft.url ||
                  !ownsPanel(publication, { input, value: next }, input) ||
                  !claimAction(presentation.draft.urlInput)
                ) {
                  return;
                }
                setUrl(next);
              }}
              placeholder="https://example.com/markdoc"
              data-testid="webhook-url"
              disabled={!presentation.draft.urlInput.eligible}
              required
            />
          </label>
          <fieldset className="flex flex-col gap-1 text-xs font-medium text-ink-3" disabled={presentation.createOperation !== null}>
            <legend className="mb-1">Events</legend>
            <div className="flex flex-wrap gap-x-4 gap-y-1.5">
              {presentation.draft.choiceInputs.map((choice) => (
                <label key={choice.id} className="flex min-h-6 items-center gap-1.5 font-mono text-xs text-ink-2">
                  <input
                    ref={(element) => bindElement(publication, publication.choices[choice.index]!, element)}
                    type="checkbox"
                    checked={choice.checked}
                    onChange={(event: ChangeEvent<HTMLInputElement>) => {
                      const input = publication.choices[choice.index]?.element;
                      const checked = event.currentTarget.checked;
                      if (
                        !input ||
                        event.currentTarget !== input ||
                        event.target !== input ||
                        !choice.eligible ||
                        checked === choice.checked ||
                        !ownsPanel(publication, { input, checked }, input) ||
                        !claimAction(choice)
                      ) {
                        return;
                      }
                      setChoices(
                        checked
                          ? [...presentation.draft.choices, choice.id]
                          : presentation.draft.choices.filter((id) => id !== choice.id),
                      );
                    }}
                    data-testid={`webhook-event-${choice.id}`}
                  />
                  {choice.label}
                </label>
              ))}
            </div>
          </fieldset>
          <label className="flex flex-col gap-1 text-xs font-medium text-ink-3">
            Only these documents (optional: ids or links, comma or space separated)
            <input
              ref={(element) => bindElement(publication, publication.docs, element)}
              className="input"
              value={presentation.draft.docs}
              onChange={(event: ChangeEvent<HTMLInputElement>) => {
                const input = publication.docs.element;
                const next = event.currentTarget.value;
                if (
                  !input ||
                  event.currentTarget !== input ||
                  event.target !== input ||
                  !presentation.draft.docsInput.eligible ||
                  next === presentation.draft.docs ||
                  !ownsPanel(publication, { input, value: next }, input) ||
                  !claimAction(presentation.draft.docsInput)
                ) {
                  return;
                }
                setDocs(next);
              }}
              placeholder="Leave empty for every document you can see"
              data-testid="webhook-docs"
              disabled={!presentation.draft.docsInput.eligible}
            />
          </label>
          <div className="flex items-center gap-2">
            <button
              ref={(element) => bindElement(publication, publication.create, element)}
              type="submit"
              className="btn btn-primary btn-sm gap-1.5"
              disabled={!presentation.create?.eligible}
              data-testid="webhook-create"
            >
              {presentation.createOperation ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />} Add webhook
            </button>
            <button
              ref={(element) => bindElement(publication, publication.cancel, element)}
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={(event) => {
                if (
                  !presentation.cancel ||
                  !isNativeReactMouseEvent(event, publication.cancel.element, publication.cancel.mouseTargets) ||
                  !ownsPanelAction(publication, presentation.cancel, event.currentTarget, publication.cancel) ||
                  !claimAction(presentation.cancel)
                ) {
                  return;
                }
                setAdding(false);
              }}
              disabled={!presentation.cancel?.eligible}
            >
              Cancel
            </button>
          </div>
        </form>
      )}
      {presentation.listError && (
        <div
          ref={(element) => bindElement(publication, publication.listError, element)}
          className="mx-5 mt-3 flex items-center gap-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-danger dark:bg-red-950/40"
          data-testid="webhooks-list-error"
        >
          <span
            ref={(element) => bindElement(publication, publication.listAlert, element)}
            className="min-w-0 flex-1"
            role="alert"
            aria-atomic="true"
          >
            {presentation.listError}
          </span>
          <button
            ref={(element) => bindElement(publication, publication.retry, element)}
            type="button"
            className="btn btn-outline btn-sm shrink-0 gap-1.5"
            onClick={(event) => {
              if (
                !presentation.retry ||
                !isNativeReactMouseEvent(event, publication.retry.element, publication.retry.mouseTargets) ||
                !ownsPanelAction(publication, presentation.retry, event.currentTarget, publication.retry) ||
                !claimAction(presentation.retry)
              ) {
                return;
              }
              startRetry(presentation.retry.route!);
            }}
            disabled={!presentation.retry?.eligible}
            aria-busy={presentation.retryOperation !== null || undefined}
          >
            {presentation.retryOperation && <Loader2 size={14} className="animate-spin" />}
            {presentation.retryOperation ? "Retrying…" : "Retry"}
          </button>
        </div>
      )}
      {presentation.actionError && (
        <div
          ref={(element) => bindElement(publication, publication.actionError, element)}
          className="mx-5 mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-danger dark:bg-red-950/40"
          role="alert"
          aria-atomic="true"
          data-testid="webhook-action-error"
        >
          {presentation.actionError}
        </div>
      )}

      {presentation.created && (
        <div
          ref={(element) => bindElement(publication, publication.created, element)}
          className="m-5 rounded-xl border border-green-200 bg-green-50 p-4 dark:border-green-900 dark:bg-green-950/40"
          role="status"
          aria-live="polite"
          aria-atomic="true"
          data-testid="webhook-created"
        >
          <div className="mb-2 text-sm font-medium text-green-900 dark:text-green-200">Webhook added. Copy the signing secret now; it will not be shown again.</div>
          <SecretField panel={publication} created={presentation.created} ownsPanel={ownsPanel} />
          <p className="mt-2 text-xs text-ink-3">
            Verify each delivery with <code>HMAC-SHA256(secret, raw body)</code> against <code>X-Markdoc-Signature</code>. Press <em>Send test</em> below to see a delivery land.
          </p>
        </div>
      )}

      {presentation.list.kind === "loading" ? (
        <div
          ref={(element) => bindElement(publication, publication.listContent, element)}
          className="px-5 py-6 text-sm text-ink-3"
        >
          Loading…
        </div>
      ) : presentation.list.kind === "unavailable" ? null : presentation.list.kind === "empty" ? (
        <div
          ref={(element) => bindElement(publication, publication.listContent, element)}
          className="px-5 py-6 text-sm text-ink-3"
          data-testid="webhooks-empty"
        >
          No webhooks yet.
        </div>
      ) : (
        <ul
          ref={(element) => {
            bindElement(publication, publication.listContent, element);
            bindElement(publication, publication.rowsList, element);
          }}
          className="mt-3 divide-y divide-line border-t border-line"
        >
          {presentation.list.rows!.map((row) => {
            const rowElements = publication.rows[row.index]!;
            return (
              <li
                key={row.id}
                ref={(element) => bindElement(publication, rowElements.root, element)}
                className="flex items-center gap-4 px-5 py-3"
                data-testid="webhook-row"
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate font-mono text-sm text-ink">{row.url}</div>
                  <div className="truncate text-xs text-ink-3">{row.details}</div>
                </div>
                <div
                  className={`shrink-0 text-xs ${row.statusTone === "ok" ? "text-success" : row.statusTone === "bad" ? "text-danger" : "text-ink-3"}`}
                  data-testid="webhook-status"
                >
                  {row.statusText}
                </div>
                {row.enable && (
                  <button
                    ref={(element) => bindElement(publication, rowElements.enable, element)}
                    type="button"
                    className="btn btn-outline btn-sm gap-1.5"
                    onClick={(event) => {
                      if (
                        !row.enable ||
                        !isNativeReactMouseEvent(event, rowElements.enable.element, rowElements.enable.mouseTargets) ||
                        !ownsPanelAction(publication, row.enable, event.currentTarget, rowElements.enable) ||
                        !claimAction(row.enable)
                      ) {
                        return;
                      }
                      startEnable(row);
                    }}
                    disabled={!row.enable.eligible}
                    data-testid="webhook-enable"
                  >
                    {row.operation?.kind === "enable" ? <Loader2 size={14} className="animate-spin" /> : <Power size={14} />} Enable
                  </button>
                )}
                <button
                  ref={(element) => bindElement(publication, rowElements.test, element)}
                  type="button"
                  className="btn btn-outline btn-sm gap-1.5"
                  onClick={(event) => {
                    if (
                      !isNativeReactMouseEvent(event, rowElements.test.element, rowElements.test.mouseTargets) ||
                      !ownsPanelAction(publication, row.test, event.currentTarget, rowElements.test) ||
                      !claimAction(row.test)
                    ) {
                      return;
                    }
                    startTest(row);
                  }}
                  disabled={!row.test.eligible}
                  data-testid="webhook-test"
                >
                  {row.operation?.kind === "test" ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />} Send test
                </button>
                <button
                  ref={(element) => bindElement(publication, rowElements.delete, element)}
                  type="button"
                  className="icon-btn h-8 w-8 text-ink-3 hover:text-danger"
                  onClick={(event) => {
                    if (
                      !isNativeReactMouseEvent(event, rowElements.delete.element, rowElements.delete.mouseTargets) ||
                      !ownsPanelAction(publication, row.delete, event.currentTarget, rowElements.delete) ||
                      deleteEventsRef.current.has(event) ||
                      deleteClaimsRef.current.has(row.delete)
                    ) {
                      return;
                    }
                    deleteEventsRef.current.add(event);
                    deleteClaimsRef.current.add(row.delete);
                    if (!confirm(`Delete the webhook to ${row.url}?`)) {
                      deleteClaimsRef.current.delete(row.delete);
                      return;
                    }
                    startDelete(row);
                  }}
                  disabled={!row.delete.eligible}
                  aria-label={`Delete webhook ${row.url}`}
                  data-testid="webhook-delete"
                >
                  <Trash2 size={15} />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
