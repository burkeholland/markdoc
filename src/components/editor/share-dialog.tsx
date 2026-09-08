"use client";

import {
  memo,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent as ReactChangeEvent,
  type FormEvent as ReactFormEvent,
  type MouseEvent as ReactMouseEvent,
  type RefObject,
} from "react";
import { BookOpen, Bot, Check, ChevronDown, Copy, Globe, Link2, Loader2, Lock, Trash2 } from "lucide-react";
import type { DocumentDto } from "@/server/dto";
import type { Role } from "@/server/db/schema";
import { api, apiErrorText, type CollaboratorDto } from "@/lib/api";
import { useCopy } from "@/lib/hooks";
import { Avatar, Dialog, DialogContent } from "@/components/ui/primitives";
import { CollaboratorLoginInput } from "@/components/editor/collaborator-login-input";
import { TokensPanel } from "@/components/settings/tokens-panel";
import { cn } from "@/lib/utils";

type CollaboratorRole = Exclude<Role, "owner">;

const ROLE_OPTIONS = Object.freeze([
  Object.freeze({ value: "editor" as const, label: "Editor" }),
  Object.freeze({ value: "commenter" as const, label: "Commenter" }),
  Object.freeze({ value: "viewer" as const, label: "Viewer" }),
]);
const LINK_OPTIONS = Object.freeze([
  Object.freeze({ value: "private" as const, label: "Restricted", description: "Only people added above can open this document." }),
  Object.freeze({ value: "view" as const, label: "Anyone with the link can view", description: "Signed-out visitors can read the document." }),
  Object.freeze({ value: "comment" as const, label: "Anyone with the link can comment", description: "Signed-in visitors can comment; others can read." }),
  Object.freeze({ value: "edit" as const, label: "Anyone with the link can edit", description: "Signed-in visitors can edit; others can read." }),
]);

type CollaboratorOwner = { login: string | null; name: string | null; image: string | null };
type CollaboratorListState =
  | { documentId: string; status: "loading" }
  | { documentId: string; status: "error"; message: string; retrying: boolean }
  | { documentId: string; status: "loaded"; owner: CollaboratorOwner | null; collaborators: CollaboratorDto[] };
type ShareVisit = { documentId: string };
type CollaboratorListRequest = { visit: ShareVisit; request: number; documentId: string };
type AddCollaboratorOperation = {
  visit: ShareVisit;
  request: number;
  documentId: string;
  login: string;
  role: CollaboratorRole;
};
type PermissionContext = { documentId: string };
type PermissionOperation = { context: PermissionContext; documentId: string };
type CollaboratorPermissionOperation = PermissionOperation & { login: string; kind: "role" | "remove" };
type LinkPermissionOperation = PermissionOperation & { kind: "link" };

interface CollaboratorPublication {
  readonly index: number;
  readonly source: CollaboratorDto;
  readonly login: string;
  readonly name: string | null;
  readonly image: string | null;
  readonly createdAt: string;
  readonly role: CollaboratorRole;
  readonly operation: CollaboratorPermissionOperation | null;
  readonly pending: boolean;
}

type CollaboratorListPublication =
  | { readonly status: "none"; readonly source: CollaboratorListState | null }
  | { readonly status: "loading"; readonly source: Extract<CollaboratorListState, { status: "loading" }>; readonly documentId: string }
  | {
      readonly status: "error";
      readonly source: Extract<CollaboratorListState, { status: "error" }>;
      readonly documentId: string;
      readonly message: string;
      readonly retrying: boolean;
    }
  | {
      readonly status: "loaded";
      readonly source: Extract<CollaboratorListState, { status: "loaded" }>;
      readonly documentId: string;
      readonly sourceOwner: CollaboratorOwner | null;
      readonly owner: Readonly<CollaboratorOwner> | null;
      readonly sourceCollaborators: CollaboratorDto[];
      readonly collaborators: readonly CollaboratorPublication[];
    };

interface PermissionOperationPublication {
  readonly source: PermissionOperation;
  readonly context: PermissionContext;
  readonly documentId: string;
}

interface CollaboratorPermissionOperationPublication extends PermissionOperationPublication {
  readonly source: CollaboratorPermissionOperation;
  readonly login: string;
  readonly kind: CollaboratorPermissionOperation["kind"];
}

interface LinkPermissionOperationPublication extends PermissionOperationPublication {
  readonly source: LinkPermissionOperation;
  readonly kind: "link";
}

interface CollaboratorListRequestPublication {
  readonly source: CollaboratorListRequest;
  readonly visit: ShareVisit;
  readonly request: number;
  readonly documentId: string;
}

interface AddCollaboratorOperationPublication extends CollaboratorListRequestPublication {
  readonly source: AddCollaboratorOperation;
  readonly login: string;
  readonly role: CollaboratorRole;
}

interface SharePresentation {
  readonly mount: symbol;
  readonly open: boolean;
  readonly visit: ShareVisit | null;
  readonly permissionContext: PermissionContext | null;
  readonly sourceDocument: DocumentDto;
  readonly document: Readonly<DocumentDto>;
  readonly isOwner: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onDocChange: (doc: DocumentDto) => void;
  readonly sourceList: CollaboratorListState | null;
  readonly list: CollaboratorListPublication;
  readonly sourcePermissionOperations: Map<string, CollaboratorPermissionOperation>;
  readonly permissionOperations: readonly CollaboratorPermissionOperationPublication[];
  readonly linkPermissionOwner: LinkPermissionOperationPublication | null;
  readonly linkPermissionOperation: LinkPermissionOperationPublication | null;
  readonly permissionFeedbackOwner: PermissionOperationPublication | null;
  readonly sourceLogin: string;
  readonly login: string;
  readonly newRole: CollaboratorRole;
  readonly busy: boolean;
  readonly addEligible: boolean;
  readonly listPending: CollaboratorListRequestPublication | null;
  readonly addPending: AddCollaboratorOperationPublication | null;
  readonly sourceAddError: { documentId: string; message: string } | null;
  readonly addError: string | null;
  readonly sourceActionError: { operation: PermissionOperation; message: string } | null;
  readonly actionError: string | null;
  readonly linkAccess: DocumentDto["linkAccess"];
}

interface CollaboratorRowElements {
  row: HTMLLIElement | null;
  role: HTMLSelectElement | null;
  remove: HTMLButtonElement | null;
}

interface SharePresentationRuntime {
  active: boolean;
  retired: boolean;
  published: boolean;
  predecessor: SharePresentation | null;
  dialog: HTMLDivElement | null;
  overlay: HTMLDivElement | null;
  portalParent: HTMLElement | null;
  close: HTMLButtonElement | null;
  root: HTMLDivElement | null;
  form: HTMLFormElement | null;
  loginControl: HTMLDivElement | null;
  login: HTMLInputElement | null;
  newRole: HTMLSelectElement | null;
  add: HTMLButtonElement | null;
  addError: HTMLDivElement | null;
  actionError: HTMLDivElement | null;
  people: HTMLDivElement | null;
  list: HTMLUListElement | null;
  listState: HTMLLIElement | null;
  retry: HTMLButtonElement | null;
  owner: HTMLLIElement | null;
  empty: HTMLLIElement | null;
  editorLink: HTMLDivElement | null;
  linkHint: HTMLParagraphElement | null;
  rows: CollaboratorRowElements[];
  general: HTMLDivElement | null;
  linkAccess: HTMLSelectElement | null;
  agent: HTMLDivElement | null;
  footer: HTMLDivElement | null;
  done: HTMLButtonElement | null;
  claims: Set<string>;
  mutated: boolean;
  observer: MutationObserver | null;
  observerRetirement: object | null;
  removeCloseCapture: (() => void) | null;
  closeProvenance: ShareCloseProvenance | null;
  closeProvenanceRetirement: { provenance: ShareCloseProvenance; timer: number } | null;
}

interface SharePresentationLineage {
  current: SharePresentation;
}

type ShareCloseProvenance =
  | { readonly kind: "escape"; readonly event: KeyboardEvent }
  | { readonly kind: "outside" | "close-button"; readonly event: MouseEvent };

interface ShareLiveFacts {
  open: boolean;
  doc: DocumentDto;
  isOwner: boolean;
  onOpenChange: (open: boolean) => void;
  onDocChange: (doc: DocumentDto) => void;
  collaboratorList: CollaboratorListState | null;
  collaboratorPermissionOperations: Map<string, CollaboratorPermissionOperation>;
  linkPermissionOperation: LinkPermissionOperation | null;
  login: string;
  role: CollaboratorRole;
  busy: boolean;
  addError: { documentId: string; message: string } | null;
  actionError: { operation: PermissionOperation; message: string } | null;
  listPending: CollaboratorListRequest | null;
  addPending: AddCollaboratorOperation | null;
  permissionFeedbackOwner: PermissionOperation | null;
}

type ShareDomChange =
  | { kind: "new-role"; value: CollaboratorRole }
  | { kind: "collaborator-role"; row: CollaboratorPublication; value: CollaboratorRole }
  | { kind: "link-access"; value: DocumentDto["linkAccess"] };

function snapshotPermissionOperation(operation: PermissionOperation | null): PermissionOperationPublication | null {
  if (!operation) return null;
  return Object.freeze({
    source: operation,
    context: operation.context,
    documentId: operation.documentId,
  });
}

function snapshotCollaboratorPermissionOperation(operation: CollaboratorPermissionOperation): CollaboratorPermissionOperationPublication {
  return Object.freeze({
    source: operation,
    context: operation.context,
    documentId: operation.documentId,
    login: operation.login,
    kind: operation.kind,
  });
}

function snapshotLinkPermissionOperation(operation: LinkPermissionOperation | null): LinkPermissionOperationPublication | null {
  if (!operation) return null;
  return Object.freeze({
    source: operation,
    context: operation.context,
    documentId: operation.documentId,
    kind: operation.kind,
  });
}

function snapshotListRequest(operation: CollaboratorListRequest | null): CollaboratorListRequestPublication | null {
  if (!operation) return null;
  return Object.freeze({
    source: operation,
    visit: operation.visit,
    request: operation.request,
    documentId: operation.documentId,
  });
}

function snapshotAddOperation(operation: AddCollaboratorOperation | null): AddCollaboratorOperationPublication | null {
  if (!operation) return null;
  return Object.freeze({
    source: operation,
    visit: operation.visit,
    request: operation.request,
    documentId: operation.documentId,
    login: operation.login,
    role: operation.role,
  });
}

function permissionOperationIsCurrent(
  operation: PermissionOperation | null,
  publication: PermissionOperationPublication | null,
): boolean {
  return (
    operation === publication?.source &&
    operation?.context === publication.context &&
    operation?.documentId === publication.documentId
  ) || (operation === null && publication === null);
}

function collaboratorPermissionOperationIsCurrent(
  operation: CollaboratorPermissionOperation,
  publication: CollaboratorPermissionOperationPublication,
): boolean {
  return (
    operation === publication.source &&
    operation.context === publication.context &&
    operation.documentId === publication.documentId &&
    operation.login === publication.login &&
    operation.kind === publication.kind
  );
}

function linkPermissionOperationIsCurrent(
  operation: LinkPermissionOperation | null,
  publication: LinkPermissionOperationPublication | null,
): boolean {
  return (
    operation === publication?.source &&
    operation?.context === publication.context &&
    operation?.documentId === publication.documentId &&
    operation?.kind === publication.kind
  ) || (operation === null && publication === null);
}

function shallowDocumentIsCurrent(source: DocumentDto, publication: Readonly<DocumentDto>): boolean {
  const sourceKeys = Object.keys(source);
  const publicationKeys = Object.keys(publication);
  if (sourceKeys.length !== publicationKeys.length) return false;
  return publicationKeys.every((key) => source[key as keyof DocumentDto] === publication[key as keyof DocumentDto]);
}

function snapshotList(
  source: CollaboratorListState | null,
  documentId: string,
  operations: Map<string, CollaboratorPermissionOperation>,
): CollaboratorListPublication {
  if (!source || source.documentId !== documentId) return Object.freeze({ status: "none", source });
  if (source.status === "loading") {
    return Object.freeze({ status: "loading", source, documentId: source.documentId });
  }
  if (source.status === "error") {
    return Object.freeze({
      status: "error",
      source,
      documentId: source.documentId,
      message: source.message,
      retrying: source.retrying,
    });
  }
  const collaborators = Object.freeze(
    source.collaborators.map((collaborator, index) => {
      const operation = operations.get(collaborator.login) ?? null;
      return Object.freeze({
        index,
        source: collaborator,
        login: collaborator.login,
        name: collaborator.name,
        image: collaborator.image,
        createdAt: collaborator.createdAt,
        role: collaborator.role,
        operation,
        pending: operation?.documentId === documentId,
      });
    }),
  );
  return Object.freeze({
    status: "loaded",
    source,
    documentId: source.documentId,
    sourceOwner: source.owner,
    owner: source.owner
      ? Object.freeze({ login: source.owner.login, name: source.owner.name, image: source.owner.image })
      : null,
    sourceCollaborators: source.collaborators,
    collaborators,
  });
}

function collaboratorListIsCurrent(
  source: CollaboratorListState | null,
  publication: CollaboratorListPublication,
  documentId: string,
  operations: Map<string, CollaboratorPermissionOperation>,
): boolean {
  if (source !== publication.source) return false;
  if (!source || source.documentId !== documentId) return publication.status === "none";
  if (source.status !== publication.status || source.documentId !== publication.documentId) return false;
  if (publication.status === "loading") return true;
  if (publication.status === "error") {
    if (source.status !== "error") return false;
    return source.message === publication.message && source.retrying === publication.retrying;
  }
  if (source.status !== "loaded") return false;
  if (
    source.owner !== publication.sourceOwner ||
    source.collaborators !== publication.sourceCollaborators ||
    source.collaborators.length !== publication.collaborators.length
  ) {
    return false;
  }
  if (source.owner) {
    if (
      !publication.owner ||
      source.owner.login !== publication.owner.login ||
      source.owner.name !== publication.owner.name ||
      source.owner.image !== publication.owner.image
    ) {
      return false;
    }
  } else if (publication.owner) {
    return false;
  }
  return publication.collaborators.every((row, index) => {
    const collaborator = source.collaborators[index];
    const operation = operations.get(row.login) ?? null;
    return (
      collaborator === row.source &&
      collaborator.login === row.login &&
      collaborator.name === row.name &&
      collaborator.image === row.image &&
      collaborator.createdAt === row.createdAt &&
      collaborator.role === row.role &&
      operation === row.operation &&
      (operation?.documentId === documentId) === row.pending
    );
  });
}

function listRequestIsCurrent(
  current: CollaboratorListRequest | null,
  published: CollaboratorListRequestPublication | null,
): boolean {
  return (
    current === published?.source &&
    current?.visit === published.visit &&
    current?.request === published.request &&
    current?.documentId === published.documentId
  ) || (current === null && published === null);
}

function addOperationIsCurrent(
  current: AddCollaboratorOperation | null,
  published: AddCollaboratorOperationPublication | null,
): boolean {
  return (
    current === published?.source &&
    current?.visit === published.visit &&
    current?.request === published.request &&
    current?.documentId === published.documentId &&
    current?.login === published.login &&
    current?.role === published.role
  ) || (current === null && published === null);
}

function isExactNativeClick(event: ReactMouseEvent<HTMLButtonElement>, control: HTMLButtonElement): boolean {
  const ownerWindow = control.ownerDocument.defaultView;
  const target = event.target;
  return (
    event.type === "click" &&
    !event.defaultPrevented &&
    ownerWindow !== null &&
    event.nativeEvent instanceof ownerWindow.MouseEvent &&
    event.nativeEvent.type === "click" &&
    !event.nativeEvent.defaultPrevented &&
    event.currentTarget === control &&
    target instanceof ownerWindow.Node &&
    target === event.nativeEvent.target &&
    control.contains(target)
  );
}

function isExactNativeChange(event: ReactChangeEvent<HTMLSelectElement>, control: HTMLSelectElement): boolean {
  const ownerWindow = control.ownerDocument.defaultView;
  return (
    event.type === "change" &&
    !event.defaultPrevented &&
    ownerWindow !== null &&
    event.nativeEvent instanceof ownerWindow.Event &&
    event.nativeEvent.type === "change" &&
    !event.nativeEvent.defaultPrevented &&
    event.currentTarget === control &&
    event.target === control &&
    event.nativeEvent.target === control
  );
}

function isExactNativeSubmit(
  event: ReactFormEvent<HTMLFormElement>,
  form: HTMLFormElement,
  add: HTMLButtonElement,
): boolean {
  const ownerWindow = form.ownerDocument.defaultView;
  if (
    event.type !== "submit" ||
    event.defaultPrevented ||
    ownerWindow === null ||
    typeof ownerWindow.SubmitEvent !== "function" ||
    !(event.nativeEvent instanceof ownerWindow.SubmitEvent) ||
    event.nativeEvent.type !== "submit" ||
    event.nativeEvent.defaultPrevented ||
    event.currentTarget !== form ||
    event.target !== form ||
    event.nativeEvent.target !== form
  ) {
    return false;
  }
  return event.nativeEvent.submitter === null || event.nativeEvent.submitter === add;
}

function optionValueIsRole(value: string): value is CollaboratorRole {
  return ROLE_OPTIONS.some((option) => option.value === value);
}

function optionValueIsLinkAccess(value: string): value is DocumentDto["linkAccess"] {
  return LINK_OPTIONS.some((option) => option.value === value);
}

function roleSelectIsExact(
  select: HTMLSelectElement,
  value: CollaboratorRole,
  disabled: boolean,
): boolean {
  const ownerWindow = select.ownerDocument.defaultView;
  if (
    !ownerWindow ||
    !(select instanceof ownerWindow.HTMLSelectElement) ||
    !select.isConnected ||
    select.disabled !== disabled ||
    select.value !== value ||
    select.options.length !== ROLE_OPTIONS.length ||
    select.selectedOptions.length !== 1 ||
    select.selectedOptions.item(0)?.value !== value
  ) {
    return false;
  }
  return ROLE_OPTIONS.every((option, index) => {
    const element = select.options.item(index);
    return (
      element instanceof ownerWindow.HTMLOptionElement &&
      element.parentElement === select &&
      element.value === option.value &&
      element.textContent === option.label &&
      !element.disabled
    );
  });
}

function linkSelectIsExact(
  select: HTMLSelectElement,
  value: DocumentDto["linkAccess"],
  disabled: boolean,
): boolean {
  const ownerWindow = select.ownerDocument.defaultView;
  if (
    !ownerWindow ||
    !(select instanceof ownerWindow.HTMLSelectElement) ||
    !select.isConnected ||
    select.disabled !== disabled ||
    select.value !== value ||
    select.options.length !== LINK_OPTIONS.length ||
    select.selectedOptions.length !== 1 ||
    select.selectedOptions.item(0)?.value !== value
  ) {
    return false;
  }
  return LINK_OPTIONS.every((option, index) => {
    const element = select.options.item(index);
    return (
      element instanceof ownerWindow.HTMLOptionElement &&
      element.parentElement === select &&
      element.value === option.value &&
      element.textContent === option.label &&
      element.disabled === disabled
    );
  });
}

function presentationFactsAreExactReplay(previous: SharePresentation, next: SharePresentation): boolean {
  const previousKeys = Object.keys(previous) as (keyof SharePresentation)[];
  const nextKeys = Object.keys(next) as (keyof SharePresentation)[];
  return (
    previousKeys.length === nextKeys.length &&
    previousKeys.every((key) => previous[key] === next[key])
  );
}

function runtimeElementsAreExactReplay(
  previous: SharePresentationRuntime,
  next: SharePresentationRuntime,
): boolean {
  const elementKeys = [
    "dialog",
    "overlay",
    "portalParent",
    "close",
    "root",
    "form",
    "loginControl",
    "login",
    "newRole",
    "add",
    "addError",
    "actionError",
    "people",
    "list",
    "listState",
    "retry",
    "owner",
    "empty",
    "editorLink",
    "linkHint",
    "general",
    "linkAccess",
    "agent",
    "footer",
    "done",
  ] as const;
  return (
    elementKeys.every((key) => previous[key] === next[key]) &&
    previous.rows.length === next.rows.length &&
    previous.rows.every(
      (row, index) =>
        row.row === next.rows[index]?.row &&
        row.role === next.rows[index]?.role &&
        row.remove === next.rows[index]?.remove,
    )
  );
}

function mutationTouchesPresentation(runtime: SharePresentationRuntime, record: MutationRecord): boolean {
  if (record.target === runtime.portalParent && record.type === "childList") {
    const placementNodes = new Set<Node | null>([
      runtime.overlay,
      runtime.dialog,
    ]);
    return (
      [...record.addedNodes, ...record.removedNodes].some((node) => placementNodes.has(node)) ||
      (record.previousSibling === runtime.overlay && record.nextSibling === runtime.dialog)
    );
  }

  const changedNodes = [...record.addedNodes, ...record.removedNodes];
  const ownedElements = [
    runtime.dialog,
    runtime.overlay,
    runtime.close,
    runtime.root,
    runtime.form,
    runtime.loginControl,
    runtime.login,
    runtime.newRole,
    runtime.add,
    runtime.addError,
    runtime.actionError,
    runtime.people,
    runtime.list,
    runtime.listState,
    runtime.retry,
    runtime.owner,
    runtime.empty,
    runtime.editorLink,
    runtime.linkHint,
    ...runtime.rows.flatMap((row) => [row.row, row.role, row.remove]),
    runtime.general,
    runtime.linkAccess,
    runtime.agent,
    runtime.footer,
    runtime.done,
  ].filter((element) => element !== null);
  if (
    changedNodes.some((node) =>
      ownedElements.some((element) => node === element || (node instanceof Element && node.contains(element))),
    )
  ) {
    return true;
  }

  const target = record.target;
  if (
    record.type === "attributes" &&
    ((target === runtime.overlay &&
      (record.attributeName === "aria-hidden" || record.attributeName === "data-aria-hidden")) ||
      (target === runtime.dialog &&
        (record.attributeName === "aria-describedby" ||
          record.attributeName === "aria-labelledby" ||
          record.attributeName === "style")))
  ) {
    return false;
  }
  if (runtime.loginControl?.contains(target) || runtime.agent?.contains(target)) {
    return record.type === "attributes" && (target === runtime.loginControl || target === runtime.agent);
  }
  return ownedElements.some(
    (element) =>
      target === element ||
      ((element instanceof HTMLButtonElement || element instanceof HTMLSelectElement) &&
        element.contains(target)),
  );
}

function drainPresentationMutations(runtime: SharePresentationRuntime): boolean {
  const records = runtime.observer?.takeRecords() ?? [];
  if (records.some((record) => mutationTouchesPresentation(runtime, record))) runtime.mutated = true;
  return !runtime.mutated;
}

function stopPresentationObservation(runtime: SharePresentationRuntime): boolean {
  const clean = drainPresentationMutations(runtime);
  runtime.observer?.disconnect();
  runtime.observer = null;
  runtime.observerRetirement = null;
  return clean;
}

function clearShareCloseProvenance(
  runtime: SharePresentationRuntime,
  expected?: ShareCloseProvenance,
) {
  if (expected && runtime.closeProvenance !== expected) return;
  runtime.closeProvenance = null;
  const retirement = runtime.closeProvenanceRetirement;
  if (!retirement || (expected && retirement.provenance !== expected)) return;
  runtime.closeProvenanceRetirement = null;
  runtime.dialog?.ownerDocument.defaultView?.clearTimeout(retirement.timer);
}

function captureRuntimeDerivedElements(runtime: SharePresentationRuntime) {
  const ownerWindow = runtime.root?.ownerDocument.defaultView;
  const dialog = runtime.root?.parentElement;
  runtime.dialog = ownerWindow && dialog instanceof ownerWindow.HTMLDivElement ? dialog : null;
  const overlay = runtime.dialog?.previousElementSibling;
  runtime.overlay = ownerWindow && overlay instanceof ownerWindow.HTMLDivElement ? overlay : null;
  const portalParent = runtime.dialog?.parentElement;
  runtime.portalParent = ownerWindow && portalParent instanceof ownerWindow.HTMLElement ? portalParent : null;
  const close = runtime.dialog?.firstElementChild?.lastElementChild;
  runtime.close = ownerWindow && close instanceof ownerWindow.HTMLButtonElement ? close : null;
  const loginControl = runtime.form?.firstElementChild;
  runtime.loginControl = ownerWindow && loginControl instanceof ownerWindow.HTMLDivElement ? loginControl : null;
  const login = runtime.loginControl?.querySelector('[data-testid="share-login"]');
  runtime.login = ownerWindow && login instanceof ownerWindow.HTMLInputElement ? login : null;
}

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
  const [mount] = useState(() => Symbol("share-dialog"));
  const activePresentationRef = useRef<SharePresentation | null>(null);
  const presentationRuntimesRef = useRef(new WeakMap<SharePresentation, SharePresentationRuntime>());
  const presentationLineagesRef = useRef(new WeakMap<SharePresentation, SharePresentationLineage>());
  const publishPresentationRef = useRef<
    ((source: SharePresentation, expected?: SharePresentation) => SharePresentation | null) | null
  >(null);
  const shareVisit = useRef<ShareVisit | null>(null);
  const [collaboratorList, setCollaboratorList] = useState<CollaboratorListState | null>(null);
  const listRequest = useRef(0);
  const listPending = useRef<CollaboratorListRequest | null>(null);
  const [listPendingOperation, setListPendingOperation] = useState<CollaboratorListRequest | null>(null);
  const [login, setLogin] = useState("");
  const [role, setRole] = useState<CollaboratorRole>("editor");
  const [busy, setBusy] = useState(false);
  const addRequest = useRef(0);
  const addPending = useRef<AddCollaboratorOperation | null>(null);
  const [addPendingOperation, setAddPendingOperation] = useState<AddCollaboratorOperation | null>(null);
  const [addError, setAddError] = useState<{ documentId: string; message: string } | null>(null);
  const permissionContext = useRef<PermissionContext | null>(null);
  const collaboratorPermissionOwners = useRef(new Map<string, CollaboratorPermissionOperation>());
  const linkPermissionOwner = useRef<LinkPermissionOperation | null>(null);
  const permissionFeedbackOwner = useRef<PermissionOperation | null>(null);
  const [permissionFeedbackOperation, setPermissionFeedbackOperation] = useState<PermissionOperation | null>(null);
  const [collaboratorPermissionOperations, setCollaboratorPermissionOperations] = useState<Map<string, CollaboratorPermissionOperation>>(() => new Map());
  const [linkPermissionOperation, setLinkPermissionOperation] = useState<LinkPermissionOperation | null>(null);
  const [actionError, setActionError] = useState<{ operation: PermissionOperation; message: string } | null>(null);
  const liveFactsRef = useRef<ShareLiveFacts | null>(null);
  const visit = useMemo<ShareVisit | null>(
    () => (open ? Object.freeze({ documentId: doc.id }) : null),
    [doc.id, open],
  );
  const currentPermissionContext = useMemo<PermissionContext | null>(
    () => (open ? Object.freeze({ documentId: doc.id }) : null),
    [doc.id, open],
  );
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

  const retireShareRequests = useCallback((expectedVisit?: ShareVisit) => {
    if (expectedVisit && shareVisit.current !== expectedVisit) return;
    shareVisit.current = null;
    listRequest.current += 1;
    listPending.current = null;
    addRequest.current += 1;
    addPending.current = null;
  }, []);

  const retirePermissionOperations = useCallback((expectedContext?: PermissionContext) => {
    if (expectedContext && permissionContext.current !== expectedContext) return;
    permissionContext.current = null;
    collaboratorPermissionOwners.current.clear();
    linkPermissionOwner.current = null;
    permissionFeedbackOwner.current = null;
  }, []);

  const loadCollaborators = useCallback(async (documentId: string, mode: "load" | "retry" = "load", supersede = false) => {
    const visit = shareVisit.current;
    if (!visit || visit.documentId !== documentId) return;
    if (!supersede && listPending.current?.visit === visit) return;

    const ownership = { visit, request: ++listRequest.current, documentId };
    listPending.current = ownership;
    setListPendingOperation(ownership);
    setCollaboratorList((current) =>
      mode === "retry" && current?.documentId === documentId && current.status === "error"
        ? { ...current, retrying: true }
        : { documentId, status: "loading" },
    );
    try {
      const res = await api.documents.collaborators(documentId);
      if (shareVisit.current !== visit || listPending.current !== ownership || listRequest.current !== ownership.request) return;
      setCollaboratorList({ documentId, status: "loaded", owner: res.owner, collaborators: res.collaborators });
    } catch (e) {
      if (shareVisit.current !== visit || listPending.current !== ownership || listRequest.current !== ownership.request) return;
      setCollaboratorList({ documentId, status: "error", message: apiErrorText(e, "Could not load collaborators"), retrying: false });
    } finally {
      if (shareVisit.current === visit && listPending.current === ownership) {
        listPending.current = null;
        setListPendingOperation((current) => (current === ownership ? null : current));
      }
    }
  }, []);

  useLayoutEffect(() => {
    retireShareRequests();
    setListPendingOperation(null);
    setAddPendingOperation(null);
    setBusy(false);
    setAddError(null);
    if (!open) {
      setCollaboratorList(null);
      return;
    }
    if (!visit) return;
    shareVisit.current = visit;
    setCollaboratorList({ documentId: doc.id, status: "loading" });
    void loadCollaborators(doc.id);
    return () => retireShareRequests(visit);
  }, [open, doc.id, loadCollaborators, retireShareRequests, visit]);

  useLayoutEffect(() => {
    retirePermissionOperations();
    setCollaboratorPermissionOperations(new Map());
    setLinkPermissionOperation(null);
    setPermissionFeedbackOperation(null);
    setActionError(null);

    if (!open) return;
    if (!currentPermissionContext) return;
    permissionContext.current = currentPermissionContext;
    return () => retirePermissionOperations(currentPermissionContext);
  }, [open, doc.id, currentPermissionContext, retirePermissionOperations]);

  const currentAddError = addError?.documentId === doc.id ? addError.message : null;
  const currentActionError = actionError?.operation.documentId === doc.id ? actionError.message : null;
  const currentLinkPermissionOperation = linkPermissionOperation?.documentId === doc.id ? linkPermissionOperation : null;

  const add = async (
    acceptedVisit: ShareVisit,
    documentId: string,
    trimmedLogin: string,
    selectedRole: CollaboratorRole,
  ) => {
    if (
      shareVisit.current !== acceptedVisit ||
      acceptedVisit.documentId !== documentId ||
      !trimmedLogin ||
      addPending.current
    ) {
      return;
    }
    const ownership = {
      visit: acceptedVisit,
      request: ++addRequest.current,
      documentId,
      login: trimmedLogin,
      role: selectedRole,
    };
    addPending.current = ownership;
    setAddPendingOperation(ownership);
    setBusy(true);
    setAddError(null);
    try {
      await api.documents.addCollaborator(ownership.documentId, ownership.login, ownership.role);
      if (shareVisit.current !== acceptedVisit || addPending.current !== ownership || addRequest.current !== ownership.request) return;
      setLogin("");
      await loadCollaborators(ownership.documentId, "load", true);
    } catch (e) {
      if (shareVisit.current === acceptedVisit && addPending.current === ownership && addRequest.current === ownership.request) {
        setAddError({ documentId: ownership.documentId, message: apiErrorText(e, "Could not add collaborator") });
      }
    } finally {
      if (shareVisit.current === acceptedVisit && addPending.current === ownership && addRequest.current === ownership.request) {
        addPending.current = null;
        setAddPendingOperation((current) => (current === ownership ? null : current));
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
    setPermissionFeedbackOperation(operation);
    setActionError(null);
  };

  const setPermissionError = (operation: PermissionOperation, message: string) => {
    if (permissionContext.current === operation.context && permissionFeedbackOwner.current === operation) {
      setActionError({ operation, message });
    }
  };

  const beginCollaboratorPermission = (
    context: PermissionContext,
    documentId: string,
    login: string,
    kind: CollaboratorPermissionOperation["kind"],
  ) => {
    if (
      permissionContext.current !== context ||
      context.documentId !== documentId ||
      collaboratorPermissionOwners.current.has(login)
    ) {
      return null;
    }
    const operation = { context, documentId, login, kind };
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

  const changeRole = async (
    context: PermissionContext,
    documentId: string,
    login: string,
    next: CollaboratorRole,
  ) => {
    const operation = beginCollaboratorPermission(context, documentId, login, "role");
    if (!operation) return;
    try {
      await api.documents.addCollaborator(operation.documentId, login, next);
      if (!isCollaboratorPermissionCurrent(operation)) return;
      setCollaboratorList((current) =>
        current?.documentId === operation.documentId && current.status === "loaded"
          ? { ...current, collaborators: current.collaborators.map((x) => (x.login === login ? { ...x, role: next } : x)) }
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

  const remove = async (context: PermissionContext, documentId: string, login: string) => {
    const operation = beginCollaboratorPermission(context, documentId, login, "remove");
    if (!operation) return;
    try {
      await api.documents.removeCollaborator(operation.documentId, login);
      if (!isCollaboratorPermissionCurrent(operation)) return;
      setCollaboratorList((current) =>
        current?.documentId === operation.documentId && current.status === "loaded"
          ? { ...current, collaborators: current.collaborators.filter((x) => x.login !== login) }
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

  const setLink = async (
    context: PermissionContext,
    documentId: string,
    value: DocumentDto["linkAccess"],
    acceptedOnDocChange: (doc: DocumentDto) => void,
  ) => {
    if (
      permissionContext.current !== context ||
      context.documentId !== documentId ||
      linkPermissionOwner.current
    ) {
      return;
    }
    const operation: LinkPermissionOperation = { context, documentId, kind: "link" };
    linkPermissionOwner.current = operation;
    claimPermissionFeedback(operation);
    setLinkPermissionOperation(operation);
    try {
      const res = await api.documents.patch(operation.documentId, { linkAccess: value });
      if (!isLinkPermissionCurrent(operation)) return;
      acceptedOnDocChange(res.document);
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

  const publishedList = snapshotList(collaboratorList, doc.id, collaboratorPermissionOperations);
  const publishedPermissionOperations = Object.freeze(
    Array.from(collaboratorPermissionOperations.values(), snapshotCollaboratorPermissionOperation),
  );
  const presentation: SharePresentation = Object.freeze({
    mount,
    open,
    visit,
    permissionContext: currentPermissionContext,
    sourceDocument: doc,
    document: Object.freeze({ ...doc }),
    isOwner,
    onOpenChange,
    onDocChange,
    sourceList: collaboratorList,
    list: publishedList,
    sourcePermissionOperations: collaboratorPermissionOperations,
    permissionOperations: publishedPermissionOperations,
    linkPermissionOwner: snapshotLinkPermissionOperation(linkPermissionOperation),
    linkPermissionOperation: snapshotLinkPermissionOperation(linkPermissionOperation),
    permissionFeedbackOwner: snapshotPermissionOperation(permissionFeedbackOperation),
    sourceLogin: login,
    login: login.trim(),
    newRole: role,
    busy,
    addEligible: isOwner && open && !busy && login.trim().length > 0,
    listPending: snapshotListRequest(listPendingOperation),
    addPending: snapshotAddOperation(addPendingOperation),
    sourceAddError: addError,
    addError: currentAddError,
    sourceActionError: actionError,
    actionError: currentActionError,
    linkAccess: doc.linkAccess,
  });
  const liveFacts = useMemo<ShareLiveFacts>(
    () => ({
      open,
      doc,
      isOwner,
      onOpenChange,
      onDocChange,
      collaboratorList,
      collaboratorPermissionOperations,
      linkPermissionOperation,
      login,
      role,
      busy,
      addError,
      actionError,
      listPending: listPendingOperation,
      addPending: addPendingOperation,
      permissionFeedbackOwner: permissionFeedbackOperation,
    }),
    [
      actionError,
      addError,
      addPendingOperation,
      busy,
      collaboratorList,
      collaboratorPermissionOperations,
      doc,
      isOwner,
      linkPermissionOperation,
      listPendingOperation,
      login,
      onDocChange,
      onOpenChange,
      open,
      permissionFeedbackOperation,
      role,
    ],
  );

  useLayoutEffect(() => {
    liveFactsRef.current = liveFacts;
    return () => {
      if (liveFactsRef.current === liveFacts) liveFactsRef.current = null;
    };
  }, [liveFacts]);

  const runtimeFor = useCallback((candidate: SharePresentation, predecessor: SharePresentation | null = null) => {
    const runtimes = presentationRuntimesRef.current;
    let runtime = runtimes.get(candidate);
    if (!runtime) {
      runtime = {
        active: false,
        retired: false,
        published: false,
        predecessor,
        dialog: null,
        overlay: null,
        portalParent: null,
        close: null,
        root: null,
        form: null,
        loginControl: null,
        login: null,
        newRole: null,
        add: null,
        addError: null,
        actionError: null,
        people: null,
        list: null,
        listState: null,
        retry: null,
        owner: null,
        empty: null,
        editorLink: null,
        linkHint: null,
        rows: candidate.list.status === "loaded"
          ? candidate.list.collaborators.map(() => ({ row: null, role: null, remove: null }))
          : [],
        general: null,
        linkAccess: null,
        agent: null,
        footer: null,
        done: null,
        claims: new Set(),
        mutated: false,
        observer: null,
        observerRetirement: null,
        removeCloseCapture: null,
        closeProvenance: null,
        closeProvenanceRetirement: null,
      };
      runtimes.set(candidate, runtime);
    }
    return runtime;
  }, []);

  const lineageFor = useCallback((candidate: SharePresentation) => {
    const lineages = presentationLineagesRef.current;
    let lineage = lineages.get(candidate);
    if (!lineage) {
      lineage = { current: candidate };
      lineages.set(candidate, lineage);
    }
    return lineage;
  }, []);

  const currentPresentation = useCallback(
    (candidate: SharePresentation) => presentationLineagesRef.current.get(candidate)?.current ?? candidate,
    [],
  );

  const runtimeForBinding = useCallback(
    (source: SharePresentation) => {
      const lineage = lineageFor(source);
      let candidate = lineage.current;
      let runtime = runtimeFor(candidate);
      if (runtime.retired) {
        const predecessor = candidate;
        candidate = Object.freeze({ ...candidate });
        lineage.current = candidate;
        presentationLineagesRef.current.set(candidate, lineage);
        runtime = runtimeFor(candidate, predecessor);
      }
      return { candidate, runtime };
    },
    [lineageFor, runtimeFor],
  );

  const retirePresentation = useCallback((candidate: SharePresentation) => {
    const runtime = presentationRuntimesRef.current.get(candidate);
    if (runtime && !runtime.retired) {
      runtime.active = false;
      runtime.retired = true;
      clearShareCloseProvenance(runtime);
      runtime.removeCloseCapture?.();
      runtime.removeCloseCapture = null;
      if (runtime.observer) {
        const retirement = {};
        runtime.observerRetirement = retirement;
        queueMicrotask(() => {
          if (runtime.observerRetirement === retirement) stopPresentationObservation(runtime);
        });
      }
    }
    if (activePresentationRef.current === candidate) activePresentationRef.current = null;
  }, []);

  const retirePresentationLineage = useCallback(
    (candidate: SharePresentation) => {
      const lineage = presentationLineagesRef.current.get(candidate);
      const current = lineage?.current;
      const active = activePresentationRef.current;
      retirePresentation(candidate);
      if (current && current !== candidate) retirePresentation(current);
      if (
        lineage &&
        active &&
        active !== candidate &&
        active !== current &&
        presentationLineagesRef.current.get(active) === lineage
      ) {
        retirePresentation(active);
      }
    },
    [retirePresentation],
  );

  const schedulePresentationPublication = useCallback(
    (source: SharePresentation, expected: SharePresentation) => {
      queueMicrotask(() => publishPresentationRef.current?.(source, expected));
    },
    [],
  );

  const bindElement = useCallback(
    <
      K extends Exclude<
        keyof SharePresentationRuntime,
        | "active"
        | "retired"
        | "published"
        | "predecessor"
        | "dialog"
        | "overlay"
        | "portalParent"
        | "close"
        | "loginControl"
        | "login"
        | "rows"
        | "claims"
        | "mutated"
        | "observer"
        | "observerRetirement"
        | "removeCloseCapture"
        | "closeProvenance"
        | "closeProvenanceRetirement"
      >
    >(
      source: SharePresentation,
      kind: K,
      element: SharePresentationRuntime[K],
    ) => {
      if (!element) return;
      const { candidate, runtime } = runtimeForBinding(source);
      const existing = runtime[kind];
      if (existing && existing !== element) {
        retirePresentation(candidate);
        return;
      }
      runtime[kind] = element;
      captureRuntimeDerivedElements(runtime);
      schedulePresentationPublication(source, candidate);
    },
    [retirePresentation, runtimeForBinding, schedulePresentationPublication],
  );

  const bindRowElement = useCallback(
    <K extends keyof CollaboratorRowElements>(
      source: SharePresentation,
      row: CollaboratorPublication,
      kind: K,
      element: CollaboratorRowElements[K],
    ) => {
      if (!element) return;
      const { candidate, runtime } = runtimeForBinding(source);
      const elements = runtime.rows[row.index];
      if (
        candidate.list.status !== "loaded" ||
        candidate.list.collaborators[row.index] !== row ||
        !elements
      ) {
        retirePresentation(candidate);
        return;
      }
      const existing = elements[kind];
      if (existing && existing !== element) {
        retirePresentation(candidate);
        return;
      }
      elements[kind] = element;
      captureRuntimeDerivedElements(runtime);
      schedulePresentationPublication(source, candidate);
    },
    [retirePresentation, runtimeForBinding, schedulePresentationPublication],
  );

  const presentationFactsAreCurrent = useCallback((candidate: SharePresentation) => {
    const live = liveFactsRef.current;
    if (
      !live ||
      candidate.mount !== mount ||
      !candidate.open ||
      live.open !== candidate.open ||
      live.doc !== candidate.sourceDocument ||
      !shallowDocumentIsCurrent(live.doc, candidate.document) ||
      live.isOwner !== candidate.isOwner ||
      live.onOpenChange !== candidate.onOpenChange ||
      live.onDocChange !== candidate.onDocChange ||
      shareVisit.current !== candidate.visit ||
      candidate.visit?.documentId !== candidate.document.id ||
      permissionContext.current !== candidate.permissionContext ||
      candidate.permissionContext?.documentId !== candidate.document.id ||
      live.collaboratorList !== candidate.sourceList ||
      !collaboratorListIsCurrent(
        live.collaboratorList,
        candidate.list,
        candidate.document.id,
        live.collaboratorPermissionOperations,
      ) ||
      live.collaboratorPermissionOperations !== candidate.sourcePermissionOperations ||
      live.collaboratorPermissionOperations.size !== candidate.permissionOperations.length ||
      collaboratorPermissionOwners.current.size !== candidate.permissionOperations.length ||
      live.listPending !== candidate.listPending?.source && !(live.listPending === null && candidate.listPending === null) ||
      live.addPending !== candidate.addPending?.source && !(live.addPending === null && candidate.addPending === null) ||
      !listRequestIsCurrent(listPending.current, candidate.listPending) ||
      !addOperationIsCurrent(addPending.current, candidate.addPending) ||
      live.login !== candidate.sourceLogin ||
      live.login.trim() !== candidate.login ||
      live.role !== candidate.newRole ||
      live.busy !== candidate.busy ||
      (live.isOwner && live.open && !live.busy && live.login.trim().length > 0) !== candidate.addEligible ||
      live.addError !== candidate.sourceAddError ||
      (live.addError?.documentId === live.doc.id ? live.addError.message : null) !== candidate.addError ||
      live.actionError !== candidate.sourceActionError ||
      (live.actionError?.operation.documentId === live.doc.id ? live.actionError.message : null) !== candidate.actionError ||
      live.doc.linkAccess !== candidate.linkAccess ||
      !linkPermissionOperationIsCurrent(linkPermissionOwner.current, candidate.linkPermissionOwner) ||
      !linkPermissionOperationIsCurrent(live.linkPermissionOperation, candidate.linkPermissionOperation) ||
      live.permissionFeedbackOwner !== candidate.permissionFeedbackOwner?.source &&
        !(live.permissionFeedbackOwner === null && candidate.permissionFeedbackOwner === null) ||
      !permissionOperationIsCurrent(permissionFeedbackOwner.current, candidate.permissionFeedbackOwner)
    ) {
      return false;
    }

    const liveEntries = Array.from(live.collaboratorPermissionOperations.entries());
    for (let index = 0; index < candidate.permissionOperations.length; index++) {
      const publication = candidate.permissionOperations[index];
      const entry = liveEntries[index];
      if (
        !entry ||
        entry[0] !== publication.login ||
        !collaboratorPermissionOperationIsCurrent(entry[1], publication) ||
        collaboratorPermissionOwners.current.get(publication.login) !== publication.source
      ) {
        return false;
      }
    }
    return true;
  }, [mount]);

  const presentationDomIsValid = useCallback(
    (candidate: SharePresentation, change?: ShareDomChange) => {
      const runtime = presentationRuntimesRef.current.get(candidate);
      const dialog = runtime?.dialog;
      const root = runtime?.root;
      const ownerWindow = root?.ownerDocument.defaultView;
      if (
        !runtime ||
        runtime.retired ||
        !drainPresentationMutations(runtime) ||
        !ownerWindow ||
        !(dialog instanceof ownerWindow.HTMLDivElement) ||
        !dialog.isConnected ||
        dialog.getAttribute("role") !== "dialog" ||
        !(runtime.overlay instanceof ownerWindow.HTMLDivElement) ||
        !runtime.overlay.isConnected ||
        runtime.overlay.parentElement !== runtime.portalParent ||
        runtime.overlay.nextElementSibling !== dialog ||
        !(runtime.portalParent instanceof ownerWindow.HTMLElement) ||
        dialog.parentElement !== runtime.portalParent ||
        !(runtime.close instanceof ownerWindow.HTMLButtonElement) ||
        runtime.close.type !== "button" ||
        runtime.close.disabled ||
        runtime.close.getAttribute("aria-label") !== "Close" ||
        runtime.close.parentElement !== dialog.firstElementChild ||
        dialog.firstElementChild?.lastElementChild !== runtime.close ||
        dialog.children.length !== 2 ||
        !(root instanceof ownerWindow.HTMLDivElement) ||
        !root.isConnected ||
        root.parentElement !== dialog ||
        dialog.lastElementChild !== root
      ) {
        return false;
      }

      const expectedRootChildren: Element[] = [];
      if (candidate.isOwner) {
        if (!(runtime.form instanceof ownerWindow.HTMLFormElement)) return false;
        expectedRootChildren.push(runtime.form);
      } else if (runtime.form || runtime.newRole || runtime.add) {
        return false;
      }
      if (candidate.addError) {
        if (!(runtime.addError instanceof ownerWindow.HTMLDivElement)) return false;
        expectedRootChildren.push(runtime.addError);
      } else if (runtime.addError) {
        return false;
      }
      if (candidate.actionError) {
        if (!(runtime.actionError instanceof ownerWindow.HTMLDivElement)) return false;
        expectedRootChildren.push(runtime.actionError);
      } else if (runtime.actionError) {
        return false;
      }
      if (
        !(runtime.people instanceof ownerWindow.HTMLDivElement) ||
        !(runtime.general instanceof ownerWindow.HTMLDivElement) ||
        !(runtime.agent instanceof ownerWindow.HTMLDivElement) ||
        !(runtime.footer instanceof ownerWindow.HTMLDivElement)
      ) {
        return false;
      }
      expectedRootChildren.push(runtime.people, runtime.general, runtime.agent, runtime.footer);
      if (
        root.children.length !== expectedRootChildren.length ||
        expectedRootChildren.some((element, index) => root.children.item(index) !== element)
      ) {
        return false;
      }

      if (candidate.isOwner) {
        const form = runtime.form;
        const loginControl = runtime.loginControl;
        const loginInput = runtime.login;
        const newRole = runtime.newRole;
        const addButton = runtime.add;
        if (
          !(form instanceof ownerWindow.HTMLFormElement) ||
          !form.isConnected ||
          form.parentElement !== root ||
          form.children.length !== 3 ||
          !(loginControl instanceof ownerWindow.HTMLDivElement) ||
          loginControl.parentElement !== form ||
          form.firstElementChild !== loginControl ||
          !(loginInput instanceof ownerWindow.HTMLInputElement) ||
          loginInput.parentElement !== loginControl ||
          loginControl.querySelectorAll('[data-testid="share-login"]').length !== 1 ||
          loginInput.value !== candidate.sourceLogin ||
          loginInput.disabled ||
          loginInput.form !== form ||
          !(newRole instanceof ownerWindow.HTMLSelectElement) ||
          newRole.parentElement !== form ||
          form.children.item(1) !== newRole ||
          newRole.form !== form ||
          !(addButton instanceof ownerWindow.HTMLButtonElement) ||
          addButton.parentElement !== form ||
          form.lastElementChild !== addButton ||
          addButton.type !== "submit" ||
          addButton.disabled === candidate.addEligible ||
          !roleSelectIsExact(
            newRole,
            change?.kind === "new-role" ? change.value : candidate.newRole,
            false,
          )
        ) {
          return false;
        }
      }

      if (
        runtime.addError &&
        (runtime.addError.parentElement !== root ||
          runtime.addError.getAttribute("role") !== "alert" ||
          runtime.addError.textContent !== candidate.addError)
      ) {
        return false;
      }
      if (
        runtime.actionError &&
        (runtime.actionError.parentElement !== root ||
          runtime.actionError.getAttribute("role") !== "alert" ||
          runtime.actionError.textContent !== candidate.actionError)
      ) {
        return false;
      }

      const people = runtime.people;
      const list = runtime.list;
      const editorLink = runtime.editorLink;
      const linkHint = runtime.linkHint;
      if (
        !(list instanceof ownerWindow.HTMLUListElement) ||
        !list.isConnected ||
        list.parentElement !== people ||
        people.children.item(1) !== list ||
        !(editorLink instanceof ownerWindow.HTMLDivElement) ||
        editorLink.parentElement !== people ||
        people.children.item(2) !== editorLink ||
        !(linkHint instanceof ownerWindow.HTMLParagraphElement) ||
        linkHint.parentElement !== people ||
        people.children.item(3) !== linkHint ||
        people.children.length !== 4
      ) {
        return false;
      }

      const expectedListChildren: Element[] = [];
      if (candidate.list.status === "none" || candidate.list.status === "loading") {
        if (
          !(runtime.listState instanceof ownerWindow.HTMLLIElement) ||
          runtime.listState.getAttribute("role") !== "status" ||
          runtime.retry ||
          runtime.owner ||
          runtime.empty ||
          runtime.rows.length !== 0
        ) {
          return false;
        }
        expectedListChildren.push(runtime.listState);
      } else if (candidate.list.status === "error") {
        if (
          !(runtime.listState instanceof ownerWindow.HTMLLIElement) ||
          runtime.listState.getAttribute("role") !== "alert" ||
          !(runtime.retry instanceof ownerWindow.HTMLButtonElement) ||
          runtime.retry.parentElement !== runtime.listState ||
          runtime.retry.disabled !== candidate.list.retrying ||
          runtime.retry.type !== "button" ||
          runtime.retry.textContent?.trim() !== (candidate.list.retrying ? "Retrying…" : "Retry") ||
          runtime.owner ||
          runtime.empty ||
          runtime.rows.length !== 0
        ) {
          return false;
        }
        expectedListChildren.push(runtime.listState);
      } else {
        if (runtime.listState || runtime.retry || runtime.rows.length !== candidate.list.collaborators.length) {
          return false;
        }
        if (candidate.list.owner) {
          if (!(runtime.owner instanceof ownerWindow.HTMLLIElement)) return false;
          expectedListChildren.push(runtime.owner);
        } else if (runtime.owner) {
          return false;
        }
        for (const row of candidate.list.collaborators) {
          const elements = runtime.rows[row.index];
          if (
            !elements ||
            !(elements.row instanceof ownerWindow.HTMLLIElement) ||
            !elements.row.isConnected ||
            elements.row.parentElement !== list ||
            elements.row.dataset.login !== row.login
          ) {
            return false;
          }
          expectedListChildren.push(elements.row);
          if (candidate.isOwner) {
            const roleElement = elements.role;
            const removeElement = elements.remove;
            const expectedValue =
              change?.kind === "collaborator-role" && change.row === row ? change.value : row.role;
            if (
              !(roleElement instanceof ownerWindow.HTMLSelectElement) ||
              roleElement.parentElement !== elements.row ||
              elements.row.children.item(elements.row.children.length - 2) !== roleElement ||
              roleElement.form !== null ||
              !roleSelectIsExact(roleElement, expectedValue, row.pending) ||
              !(removeElement instanceof ownerWindow.HTMLButtonElement) ||
              removeElement.parentElement !== elements.row ||
              elements.row.lastElementChild !== removeElement ||
              removeElement.form !== null ||
              removeElement.type !== "button" ||
              removeElement.disabled !== row.pending ||
              removeElement.getAttribute("aria-label") !== `Remove ${row.login}`
            ) {
              return false;
            }
          } else if (elements.role || elements.remove) {
            return false;
          }
        }
        if (candidate.list.collaborators.length === 0) {
          if (!(runtime.empty instanceof ownerWindow.HTMLLIElement)) return false;
          expectedListChildren.push(runtime.empty);
        } else if (runtime.empty) {
          return false;
        }
      }
      if (
        list.children.length !== expectedListChildren.length ||
        expectedListChildren.some((element, index) => list.children.item(index) !== element)
      ) {
        return false;
      }

      const linkPending =
        candidate.linkPermissionOperation?.documentId === candidate.document.id;
      if (candidate.isOwner) {
        const linkAccessElement = runtime.linkAccess;
        if (
          !(linkAccessElement instanceof ownerWindow.HTMLSelectElement) ||
          !linkAccessElement.isConnected ||
          !runtime.general.contains(linkAccessElement) ||
          runtime.general.querySelectorAll('[data-testid="link-access"]').length !== 1 ||
          linkAccessElement.form !== null ||
          !linkSelectIsExact(
            linkAccessElement,
            change?.kind === "link-access" ? change.value : candidate.linkAccess,
            linkPending,
          )
        ) {
          return false;
        }
      } else if (runtime.linkAccess || runtime.general.querySelector('[data-testid="link-access"]')) {
        return false;
      }

      const done = runtime.done;
      if (
        !(done instanceof ownerWindow.HTMLButtonElement) ||
        !done.isConnected ||
        done.parentElement !== runtime.footer ||
        done.form !== null ||
        runtime.footer.children.length !== 1 ||
        runtime.footer.firstElementChild !== done ||
        done.type !== "button" ||
        done.disabled ||
        done.textContent?.trim() !== "Done"
      ) {
        return false;
      }
      return true;
    },
    [],
  );

  const presentationIsCurrent = useCallback(
    (source: SharePresentation, change?: ShareDomChange) => {
      const candidate = currentPresentation(source);
      return (
        activePresentationRef.current === candidate &&
        presentationRuntimesRef.current.get(candidate)?.active === true &&
        presentationFactsAreCurrent(candidate) &&
        presentationDomIsValid(candidate, change)
      );
    },
    [currentPresentation, presentationDomIsValid, presentationFactsAreCurrent],
  );

  const claim = useCallback(
    (source: SharePresentation, key: string, change?: ShareDomChange) => {
      const candidate = currentPresentation(source);
      const runtime = presentationRuntimesRef.current.get(candidate);
      if (!runtime || runtime.claims.has(key)) return false;
      if (!presentationIsCurrent(source, change)) {
        retirePresentation(candidate);
        return false;
      }
      runtime.claims.add(key);
      return true;
    },
    [currentPresentation, presentationIsCurrent, retirePresentation],
  );

  const startPresentationObservation = useCallback((runtime: SharePresentationRuntime) => {
    const ownerWindow = runtime.root?.ownerDocument.defaultView;
    if (!ownerWindow || !runtime.dialog || !runtime.overlay || !runtime.portalParent) return false;
    const Observer = ownerWindow.MutationObserver;
    if (typeof Observer !== "function") return false;
    const observer = new Observer((records) => {
      if (records.some((record) => mutationTouchesPresentation(runtime, record))) runtime.mutated = true;
    });
    observer.observe(runtime.dialog, { attributes: true, characterData: true, childList: true, subtree: true });
    observer.observe(runtime.overlay, { attributes: true, characterData: true, childList: true, subtree: true });
    observer.observe(runtime.portalParent, { childList: true });
    runtime.observer = observer;
    runtime.observerRetirement = null;
    return true;
  }, []);

  const startCloseCapture = useCallback((candidate: SharePresentation, runtime: SharePresentationRuntime) => {
    const dialog = runtime.dialog;
    const close = runtime.close;
    const ownerWindow = dialog?.ownerDocument.defaultView;
    if (!ownerWindow || !dialog || !close) return false;
    const remember = (event: Event) => {
      clearShareCloseProvenance(runtime);
      if (!runtime.active || runtime.retired || activePresentationRef.current !== candidate) return;
      const target = event.target;
      let provenance: ShareCloseProvenance | null = null;
      if (
        event instanceof ownerWindow.KeyboardEvent &&
        event.type === "keydown" &&
        event.key === "Escape" &&
        target instanceof ownerWindow.Node &&
        dialog.contains(target)
      ) {
        provenance = { kind: "escape", event };
      } else if (
        event instanceof ownerWindow.MouseEvent &&
        event.type === "click" &&
        target instanceof ownerWindow.Node
      ) {
        if (close.contains(target)) provenance = { kind: "close-button", event };
        else if (!dialog.contains(target)) provenance = { kind: "outside", event };
      }
      if (!provenance) return;
      runtime.closeProvenance = provenance;
      const retirement = { provenance, timer: -1 };
      runtime.closeProvenanceRetirement = retirement;
      retirement.timer = ownerWindow.setTimeout(() => {
        if (runtime.closeProvenanceRetirement !== retirement) return;
        runtime.closeProvenanceRetirement = null;
        if (runtime.closeProvenance === provenance) runtime.closeProvenance = null;
      }, 0);
    };
    const forget = (event: Event) => {
      const provenance = runtime.closeProvenance;
      if (provenance?.event === event) clearShareCloseProvenance(runtime, provenance);
    };
    ownerWindow.addEventListener("keydown", remember, true);
    ownerWindow.addEventListener("click", remember, true);
    ownerWindow.addEventListener("keydown", forget);
    ownerWindow.addEventListener("click", forget);
    runtime.removeCloseCapture = () => {
      ownerWindow.removeEventListener("keydown", remember, true);
      ownerWindow.removeEventListener("click", remember, true);
      ownerWindow.removeEventListener("keydown", forget);
      ownerWindow.removeEventListener("click", forget);
    };
    return true;
  }, []);

  const publishPresentation = useCallback(
    (source: SharePresentation, expected?: SharePresentation) => {
      const candidate = currentPresentation(source);
      if (expected && candidate !== expected) return null;
      const existing = activePresentationRef.current;
      const runtime = presentationRuntimesRef.current.get(candidate);
      if (!runtime || runtime.retired || (runtime.predecessor && existing && existing !== runtime.predecessor)) {
        if (runtime) retirePresentationLineage(candidate);
        return null;
      }
      if (runtime.published && runtime.active && existing === candidate) return candidate;
      captureRuntimeDerivedElements(runtime);

      const predecessor = runtime.predecessor;
      if (predecessor) {
        const previousRuntime = presentationRuntimesRef.current.get(predecessor);
        if (
          !previousRuntime ||
          !previousRuntime.retired ||
          previousRuntime.claims.size > 0 ||
          !presentationFactsAreExactReplay(predecessor, candidate) ||
          !runtimeElementsAreExactReplay(previousRuntime, runtime) ||
          !stopPresentationObservation(previousRuntime)
        ) {
          retirePresentationLineage(candidate);
          return null;
        }
      }
      if (!presentationFactsAreCurrent(candidate)) {
        retirePresentationLineage(candidate);
        return null;
      }
      if (existing && existing !== candidate) retirePresentationLineage(existing);
      if (!presentationDomIsValid(candidate)) {
        retirePresentationLineage(candidate);
        return null;
      }
      if (!startPresentationObservation(runtime)) {
        retirePresentationLineage(candidate);
        return null;
      }
      runtime.active = true;
      runtime.published = true;
      activePresentationRef.current = candidate;
      if (!startCloseCapture(candidate, runtime)) {
        retirePresentationLineage(candidate);
        return null;
      }
      return candidate;
    },
    [
      currentPresentation,
      presentationDomIsValid,
      presentationFactsAreCurrent,
      retirePresentationLineage,
      startCloseCapture,
      startPresentationObservation,
    ],
  );
  useLayoutEffect(() => {
    publishPresentationRef.current = publishPresentation;
    return () => {
      if (publishPresentationRef.current === publishPresentation) publishPresentationRef.current = null;
    };
  }, [publishPresentation]);

  const claimAdd = (
    source: SharePresentation,
    form: HTMLFormElement,
    addButton: HTMLButtonElement,
  ) => {
    const candidate = currentPresentation(source);
    const runtime = presentationRuntimesRef.current.get(candidate);
    const accepted = candidate.visit
      ? Object.freeze({
          visit: candidate.visit,
          documentId: candidate.document.id,
          login: candidate.login,
          role: candidate.newRole,
        })
      : null;
    if (
      !candidate.isOwner ||
      !candidate.addEligible ||
      !accepted ||
      candidate.addPending ||
      candidate.busy ||
      !candidate.login ||
      runtime?.form !== form ||
      runtime.add !== addButton ||
      addButton.disabled ||
      addButton.form !== form ||
      !claim(source, "add")
    ) {
      return null;
    }
    return accepted;
  };

  const claimRetry = (source: SharePresentation, button: HTMLButtonElement) => {
    const candidate = currentPresentation(source);
    const runtime = presentationRuntimesRef.current.get(candidate);
    const documentId = candidate.document.id;
    if (
      candidate.list.status !== "error" ||
      candidate.list.retrying ||
      candidate.listPending ||
      runtime?.retry !== button ||
      button.disabled ||
      !claim(source, "retry")
    ) {
      return null;
    }
    return documentId;
  };

  const claimNewRole = (
    source: SharePresentation,
    select: HTMLSelectElement,
    nextRole: CollaboratorRole,
  ) => {
    const candidate = currentPresentation(source);
    const runtime = presentationRuntimesRef.current.get(candidate);
    if (
      !candidate.isOwner ||
      nextRole === candidate.newRole ||
      runtime?.newRole !== select ||
      select.disabled ||
      !claim(source, "new-role", { kind: "new-role", value: nextRole })
    ) {
      return false;
    }
    return true;
  };

  const claimCollaboratorRole = (
    source: SharePresentation,
    row: CollaboratorPublication,
    select: HTMLSelectElement,
    nextRole: CollaboratorRole,
  ) => {
    const candidate = currentPresentation(source);
    const runtime = presentationRuntimesRef.current.get(candidate);
    const accepted = candidate.permissionContext
      ? Object.freeze({
          context: candidate.permissionContext,
          documentId: candidate.document.id,
          login: row.login,
          role: nextRole,
        })
      : null;
    if (
      !candidate.isOwner ||
      !accepted ||
      row.pending ||
      row.operation ||
      nextRole === row.role ||
      runtime?.rows[row.index]?.role !== select ||
      select.disabled ||
      !claim(source, `role:${row.index}`, {
        kind: "collaborator-role",
        row,
        value: nextRole,
      })
    ) {
      return null;
    }
    return accepted;
  };

  const claimRemove = (
    source: SharePresentation,
    row: CollaboratorPublication,
    button: HTMLButtonElement,
  ) => {
    const candidate = currentPresentation(source);
    const runtime = presentationRuntimesRef.current.get(candidate);
    const accepted = candidate.permissionContext
      ? Object.freeze({
          context: candidate.permissionContext,
          documentId: candidate.document.id,
          login: row.login,
        })
      : null;
    if (
      !candidate.isOwner ||
      !accepted ||
      row.pending ||
      row.operation ||
      runtime?.rows[row.index]?.remove !== button ||
      button.disabled ||
      !claim(source, `remove:${row.index}`)
    ) {
      return null;
    }
    return accepted;
  };

  const claimLinkAccess = (
    source: SharePresentation,
    select: HTMLSelectElement,
    value: DocumentDto["linkAccess"],
  ) => {
    const candidate = currentPresentation(source);
    const runtime = presentationRuntimesRef.current.get(candidate);
    const accepted = candidate.permissionContext
      ? Object.freeze({
          context: candidate.permissionContext,
          documentId: candidate.document.id,
          value,
          onDocChange: candidate.onDocChange,
        })
      : null;
    if (
      !candidate.isOwner ||
      !accepted ||
      candidate.linkPermissionOwner ||
      candidate.linkPermissionOperation ||
      value === candidate.linkAccess ||
      runtime?.linkAccess !== select ||
      select.disabled ||
      !claim(source, "link-access", { kind: "link-access", value })
    ) {
      return null;
    }
    return accepted;
  };

  const claimDone = (candidate: SharePresentation, button: HTMLButtonElement) => {
    const runtime = presentationRuntimesRef.current.get(currentPresentation(candidate));
    return runtime?.done === button && !button.disabled && claim(candidate, "done");
  };

  const claimNativeClose = (source: SharePresentation) => {
    const candidate = currentPresentation(source);
    const runtime = presentationRuntimesRef.current.get(candidate);
    const provenance = runtime?.closeProvenance;
    const ownerWindow = runtime?.dialog?.ownerDocument.defaultView;
    const target = provenance?.event.target;
    if (
      !runtime ||
      !provenance ||
      !ownerWindow ||
      !(target instanceof ownerWindow.Node) ||
      (provenance.kind === "escape"
        ? !(
            provenance.event instanceof ownerWindow.KeyboardEvent &&
            provenance.event.type === "keydown" &&
            provenance.event.key === "Escape" &&
            runtime.dialog?.contains(target)
          )
        : !(
            provenance.event instanceof ownerWindow.MouseEvent &&
            provenance.event.type === "click" &&
            (provenance.kind === "close-button"
              ? runtime.close?.contains(target)
              : !runtime.dialog?.contains(target))
          )) ||
      !claim(source, "close")
    ) {
      return null;
    }
    clearShareCloseProvenance(runtime, provenance);
    return candidate;
  };

  const closePresentation = (
    source: SharePresentation,
    acceptedOnOpenChange = source.onOpenChange,
  ) => {
    const candidate = currentPresentation(source);
    if (!presentationIsCurrent(source)) return;
    retirePresentationLineage(candidate);
    retireShareRequests(candidate.visit ?? undefined);
    retirePermissionOperations(candidate.permissionContext ?? undefined);
    acceptedOnOpenChange(false);
  };

  const handleOpenChange = (nextOpen: boolean) => {
    if (nextOpen) {
      if (presentationIsCurrent(presentation)) presentation.onOpenChange(true);
      return;
    }
    const candidate = claimNativeClose(presentation);
    if (candidate) closePresentation(candidate);
  };

  useLayoutEffect(() => {
    publishPresentation(presentation);
    return () => retirePresentationLineage(presentation);
  }, [presentation, publishPresentation, retirePresentationLineage]);

  const linkOption = LINK_OPTIONS.find((option) => option.value === presentation.linkAccess);

  return (
    <Dialog open={presentation.open} onOpenChange={handleOpenChange}>
      <DialogContent title={`Share “${presentation.document.title}”`} description="Collaborators sign in with GitHub. Add people by their GitHub handle." className="max-h-[calc(100dvh-2rem)] overflow-y-auto">
        <div
          ref={(element) => bindElement(presentation, "root", element)}
          className="contents"
          data-testid="share-presentation"
        >
        {presentation.isOwner && (
          <form
            ref={(element) => bindElement(presentation, "form", element)}
            className="flex gap-2"
            onSubmit={(e) => {
              const runtime = presentationRuntimesRef.current.get(currentPresentation(presentation));
              const addButton = runtime?.add;
              if (
                !addButton ||
                !isExactNativeSubmit(e, e.currentTarget, addButton)
              ) {
                return;
              }
              const accepted = claimAdd(presentation, e.currentTarget, addButton);
              if (!accepted) return;
              e.preventDefault();
              void add(accepted.visit, accepted.documentId, accepted.login, accepted.role);
            }}
          >
            <CollaboratorLoginInput
              value={presentation.sourceLogin}
              onChange={setLogin}
              exclude={[
                ...(presentation.list.status === "loaded" && presentation.list.owner?.login
                  ? [presentation.list.owner.login]
                  : []),
                ...(presentation.list.status === "loaded"
                  ? presentation.list.collaborators.map((collaborator) => collaborator.login)
                  : []),
              ]}
              onPick={() => {
                if (!presentationIsCurrent(presentation)) return;
                presentationRuntimesRef.current.get(currentPresentation(presentation))?.newRole?.focus();
              }}
            />
            <select
              ref={(element) => bindElement(presentation, "newRole", element)}
              className="select"
              value={presentation.newRole}
              onChange={(event) => {
                const nextRole = event.currentTarget.value;
                if (
                  !optionValueIsRole(nextRole) ||
                  !isExactNativeChange(event, event.currentTarget) ||
                  !claimNewRole(presentation, event.currentTarget, nextRole)
                ) {
                  return;
                }
                setRole(nextRole);
              }}
              aria-label="Role for new collaborator"
              data-testid="share-role"
            >
              {ROLE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <button
              ref={(element) => bindElement(presentation, "add", element)}
              type="submit"
              className="btn btn-primary"
              disabled={!presentation.addEligible}
              data-testid="share-add"
            >
              {presentation.busy ? <Loader2 size={16} className="animate-spin" /> : "Add"}
            </button>
          </form>
        )}
        {presentation.addError && (
          <div
            ref={(element) => bindElement(presentation, "addError", element)}
            className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-danger dark:bg-red-950/40"
            role="alert"
            aria-atomic="true"
            data-testid="share-add-error"
          >
            {presentation.addError}
          </div>
        )}
        {presentation.actionError && (
          <div
            ref={(element) => bindElement(presentation, "actionError", element)}
            className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-danger dark:bg-red-950/40"
            role="alert"
            aria-atomic="true"
            data-testid="share-action-error"
          >
            {presentation.actionError}
          </div>
        )}

        <div ref={(element) => bindElement(presentation, "people", element)} className="mt-5">
          <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-ink-3">People with access</div>
          <ul
            ref={(element) => bindElement(presentation, "list", element)}
            className="flex flex-col divide-y divide-line rounded-xl border border-line"
          >
            {(presentation.list.status === "none" || presentation.list.status === "loading") && (
              <li
                ref={(element) => bindElement(presentation, "listState", element)}
                className="flex items-center justify-center gap-2 px-3 py-4 text-sm text-ink-3"
                role="status"
                aria-live="polite"
                aria-atomic="true"
                data-testid="collaborator-list-loading"
              >
                <Loader2 size={15} className="animate-spin" aria-hidden="true" />
                Loading collaborators…
              </li>
            )}
            {presentation.list.status === "error" && (
              <li
                ref={(element) => bindElement(presentation, "listState", element)}
                className="bg-red-50 px-3 py-3 text-sm text-danger dark:bg-red-950/40"
                role="alert"
                aria-atomic="true"
                data-testid="collaborator-list-error"
              >
                <div>{presentation.list.message}</div>
                <button
                  ref={(element) => bindElement(presentation, "retry", element)}
                  type="button"
                  className="btn btn-outline btn-sm mt-2 gap-1.5"
                  onClick={(event) => {
                    const documentId = presentation.document.id;
                    if (!isExactNativeClick(event, event.currentTarget)) return;
                    const acceptedDocumentId = claimRetry(presentation, event.currentTarget);
                    if (!acceptedDocumentId || acceptedDocumentId !== documentId) return;
                    void loadCollaborators(acceptedDocumentId, "retry");
                  }}
                  disabled={presentation.list.retrying}
                >
                  {presentation.list.retrying && <Loader2 size={13} className="animate-spin" aria-hidden="true" />}
                  {presentation.list.retrying ? "Retrying…" : "Retry"}
                </button>
              </li>
            )}
            {presentation.list.status === "loaded" && presentation.list.owner && (
              <li
                ref={(element) => bindElement(presentation, "owner", element)}
                className="flex items-center gap-3 px-3 py-2.5"
              >
                <Avatar name={presentation.list.owner.name ?? presentation.list.owner.login ?? "Owner"} src={presentation.list.owner.image} size={32} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium text-ink">{presentation.list.owner.name ?? presentation.list.owner.login}</div>
                  {presentation.list.owner.login && <div className="truncate text-xs text-ink-3">@{presentation.list.owner.login}</div>}
                </div>
                <span className="text-xs font-medium text-ink-3">Owner</span>
              </li>
            )}
            {presentation.list.status === "loaded" && presentation.list.collaborators.map((collaborator) => {
              return (
                <li
                  ref={(element) => bindRowElement(presentation, collaborator, "row", element)}
                  key={collaborator.login}
                  className="flex items-center gap-3 px-3 py-2.5"
                  data-testid="collaborator-row"
                  data-login={collaborator.login}
                >
                  <Avatar name={collaborator.name ?? collaborator.login} src={collaborator.image ?? `https://avatars.githubusercontent.com/${collaborator.login}?s=64`} size={32} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium text-ink">{collaborator.name ?? collaborator.login}</div>
                    <div className="truncate text-xs text-ink-3">@{collaborator.login}</div>
                  </div>
                  {presentation.isOwner ? (
                    <>
                      <select
                        ref={(element) => bindRowElement(presentation, collaborator, "role", element)}
                        className="select h-8 text-xs"
                        value={collaborator.role}
                        onChange={(event) => {
                          const nextRole = event.currentTarget.value;
                          if (!optionValueIsRole(nextRole) || !isExactNativeChange(event, event.currentTarget)) return;
                          const accepted = claimCollaboratorRole(
                            presentation,
                            collaborator,
                            event.currentTarget,
                            nextRole,
                          );
                          if (!accepted) return;
                          void changeRole(
                            accepted.context,
                            accepted.documentId,
                            accepted.login,
                            accepted.role,
                          );
                        }}
                        aria-label={`Role for ${collaborator.login}`}
                        disabled={collaborator.pending}
                      >
                        {ROLE_OPTIONS.map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                      <button
                        ref={(element) => bindRowElement(presentation, collaborator, "remove", element)}
                        type="button"
                        className="icon-btn h-8 w-8 text-ink-3 hover:text-danger"
                        onClick={(event) => {
                          const login = collaborator.login;
                          if (!isExactNativeClick(event, event.currentTarget)) return;
                          const accepted = claimRemove(presentation, collaborator, event.currentTarget);
                          if (!accepted || accepted.login !== login) return;
                          void remove(accepted.context, accepted.documentId, accepted.login);
                        }}
                        aria-label={`Remove ${collaborator.login}`}
                        disabled={collaborator.pending}
                      >
                        <Trash2 size={15} />
                      </button>
                    </>
                  ) : (
                    <span className="text-xs font-medium capitalize text-ink-3">{collaborator.role}</span>
                  )}
                </li>
              );
            })}
            {presentation.list.status === "loaded" && presentation.list.collaborators.length === 0 && (
              <li
                ref={(element) => bindElement(presentation, "empty", element)}
                className="px-3 py-3 text-sm text-ink-3"
              >
                Nobody else has been added yet.
              </li>
            )}
          </ul>
          {/* The link the people above open, in the same shape as the Reader link row under General access. */}
          <div
            ref={(element) => bindElement(presentation, "editorLink", element)}
            className="mt-2 flex items-center gap-2 rounded-lg bg-surface-2 px-2.5 py-1.5 text-xs"
            data-testid="editor-link"
          >
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
          <p
            ref={(element) => bindElement(presentation, "linkHint", element)}
            className="mt-1.5 text-xs text-ink-3"
            data-testid="copy-link-hint"
          >
            {presentation.linkAccess === "private" ? "Anyone listed above can open this link." : linkOption?.description}
          </p>
        </div>

        <div ref={(element) => bindElement(presentation, "general", element)} className="mt-5">
          <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-ink-3">General access</div>
          <div className="flex items-start gap-3 rounded-xl border border-line p-3">
            <span className={cn("mt-0.5 flex h-8 w-8 items-center justify-center rounded-full", presentation.linkAccess === "private" ? "bg-surface-3 text-ink-2" : "bg-green-50 text-green-700 dark:bg-green-950/40 dark:text-green-300")}>
              {presentation.linkAccess === "private" ? <Lock size={15} /> : <Globe size={15} />}
            </span>
            <div className="min-w-0 flex-1">
              {presentation.isOwner ? (
                <select
                  ref={(element) => bindElement(presentation, "linkAccess", element)}
                  className="select w-full"
                  value={presentation.linkAccess}
                  onChange={(event) => {
                    const value = event.currentTarget.value;
                    if (!optionValueIsLinkAccess(value) || !isExactNativeChange(event, event.currentTarget)) return;
                    const accepted = claimLinkAccess(presentation, event.currentTarget, value);
                    if (!accepted) return;
                    void setLink(
                      accepted.context,
                      accepted.documentId,
                      accepted.value,
                      accepted.onDocChange,
                    );
                  }}
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
              {presentation.linkAccess !== "private" && (
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

        <div ref={(element) => bindElement(presentation, "agent", element)} className="mt-5">
          <AgentCollaborateCard
            origin={origin}
            open={presentation.open}
            docId={presentation.document.id}
            onClose={() => closePresentation(presentation)}
          />
        </div>

        <div
          ref={(element) => bindElement(presentation, "footer", element)}
          className="mt-5 flex justify-end"
          data-testid="share-footer"
        >
          <button
            ref={(element) => bindElement(presentation, "done", element)}
            type="button"
            className="btn btn-primary shrink-0"
            onClick={(event) => {
              const closeCallback = presentation.onOpenChange;
              if (
                !isExactNativeClick(event, event.currentTarget) ||
                !claimDone(presentation, event.currentTarget)
              ) {
                return;
              }
              closePresentation(presentation, closeCallback);
            }}
          >
            Done
          </button>
        </div>
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
