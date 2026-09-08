"use client";
import { Dialog, DialogContent } from "@/components/ui/primitives";
import { memo, useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Check, CloudDownload, GitMerge, Loader2, Scale, UploadCloud } from "lucide-react";
import type { DocumentDto } from "@/server/dto";
import { apiErrorText, type SyncStatusDto } from "@/lib/api";
import { relativeTime } from "@/lib/utils";

type SyncActionKind = "merge" | "keep" | "take";
type SyncControlKind = SyncActionKind | "compare";
type SyncRefKind = SyncControlKind | "bridge" | "root" | "input";
interface SyncPresentation {
  mount: symbol;
  revision: number;
  replay: ReplayRequest | null;
  open: boolean;
  doc: DocumentDto;
  docId: string;
  storage: DocumentDto["storage"];
  repoPath: string | null;
  gistFile: string | null;
  repoOwner: string | null;
  repoName: string | null;
  repoBranch: string | null;
  publishedAt: string | null;
  sync: SyncStatusDto | null;
  syncLines: SyncStatusDto["lines"] | null;
  syncRemote: SyncStatusDto["remote"] | null;
  status: SyncStatusDto["status"];
  localChanged: boolean;
  remoteChanged: boolean;
  localLines: number;
  remoteLines: number;
  remoteUpdatedAt: string | null;
  remoteSha: string | null;
  remoteSize: number | null;
  remoteLimit: number | null;
  remoteUnreadable: boolean;
  actions: SyncActions;
  merge: SyncActions["merge"];
  keepMine: SyncActions["keepMine"];
  takeRemote: SyncActions["takeRemote"];
  compare: SyncActions["compare"];
  onOpenChange: (open: boolean) => void;
}
interface PublicationGeneration {
  presentation: SyncPresentation;
  message: string;
  busy: SyncActionKind | null;
  error: string | null;
  done: string | null;
  publications: PublicationSet | null;
}
interface ActionControlPublication {
  generation: PublicationGeneration;
  kind: SyncActionKind;
  invoke: () => Promise<string>;
}
interface CompareControlPublication {
  generation: PublicationGeneration;
  kind: "compare";
  invoke: SyncActions["compare"];
}
type ControlPublication = ActionControlPublication | CompareControlPublication;
type InputPublication = { generation: PublicationGeneration };
type DialogEventPublication = { generation: PublicationGeneration };
type RootPublication = { generation: PublicationGeneration };
type SyncPublication = ControlPublication | InputPublication | DialogEventPublication | RootPublication;
interface PublicationSet {
  dialogEvent: DialogEventPublication;
  root: RootPublication;
  input: InputPublication;
  controls: ReadonlyMap<SyncControlKind, ControlPublication>;
}
interface GenerationElements {
  elements: Map<SyncRefKind, HTMLElement>;
}
interface SyncDomTree {
  node: Node;
  nodeValue: string | null;
  attributes: readonly (readonly [string, string])[] | null;
  children: readonly SyncDomTree[];
}
interface CommittedPublication {
  generation: PublicationGeneration;
  bridge: HTMLDivElement;
  dialog: HTMLDivElement;
  root: HTMLDivElement;
  input: HTMLInputElement;
  close: HTMLButtonElement;
  controls: ReadonlyMap<SyncControlKind, HTMLButtonElement>;
  bridgeTree: SyncDomTree;
  rootTree: SyncDomTree;
  closeTree: SyncDomTree;
}
interface ReplayRequest {
  predecessor: SyncPresentation;
  commit: CommittedPublication;
  revision: number;
  consumed: boolean;
}
type OpenChangeClaim = {
  publication: DialogEventPublication;
  target: EventTarget | null;
  retired: boolean;
};
type ActionOwner = {
  presentation: SyncPresentation;
  publication: ActionControlPublication;
  retired: boolean;
};
type SuccessClose = {
  owner: ActionOwner;
  timer: ReturnType<typeof setTimeout>;
  retired: boolean;
};

function snapshotAttributes(node: Node) {
  if (node.nodeType !== 1) return null;
  return Object.freeze(
    [...(node as Element).attributes]
      .map(({ name, value }) => Object.freeze([name, value] as const))
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

function snapshotDom(node: Node): SyncDomTree {
  return Object.freeze({
    node,
    nodeValue: node.nodeValue,
    attributes: snapshotAttributes(node),
    children: Object.freeze([...node.childNodes].map(snapshotDom)),
  });
}

function domMatches(snapshot: SyncDomTree): boolean {
  const { node } = snapshot;
  if (node.nodeValue !== snapshot.nodeValue) return false;
  const attributes = snapshotAttributes(node);
  if (attributes === null || snapshot.attributes === null) {
    if (attributes !== snapshot.attributes) return false;
  } else if (
    attributes.length !== snapshot.attributes.length ||
    attributes.some(([name, value], index) => {
      const expected = snapshot.attributes?.[index];
      return !expected || name !== expected[0] || value !== expected[1];
    })
  ) {
    return false;
  }
  return node.childNodes.length === snapshot.children.length &&
    snapshot.children.every((child, index) =>
      node.childNodes.item(index) === child.node && domMatches(child));
}

function samePresentationFacts(left: SyncPresentation, right: SyncPresentation) {
  return left.mount === right.mount &&
    left.open === right.open &&
    left.doc === right.doc &&
    left.docId === right.docId &&
    left.storage === right.storage &&
    left.repoPath === right.repoPath &&
    left.gistFile === right.gistFile &&
    left.repoOwner === right.repoOwner &&
    left.repoName === right.repoName &&
    left.repoBranch === right.repoBranch &&
    left.publishedAt === right.publishedAt &&
    left.sync === right.sync &&
    left.syncLines === right.syncLines &&
    left.syncRemote === right.syncRemote &&
    left.status === right.status &&
    left.localChanged === right.localChanged &&
    left.remoteChanged === right.remoteChanged &&
    left.localLines === right.localLines &&
    left.remoteLines === right.remoteLines &&
    left.remoteUpdatedAt === right.remoteUpdatedAt &&
    left.remoteSha === right.remoteSha &&
    left.remoteSize === right.remoteSize &&
    left.remoteLimit === right.remoteLimit &&
    left.remoteUnreadable === right.remoteUnreadable &&
    left.actions === right.actions &&
    left.merge === right.merge &&
    left.keepMine === right.keepMine &&
    left.takeRemote === right.takeRemote &&
    left.compare === right.compare &&
    left.onOpenChange === right.onOpenChange;
}

export interface SyncActions {
  /** pull?merge=1 — resolves to the number of conflicts left in the document (0 = clean merge). */
  merge: () => Promise<number>;
  keepMine: (message: string) => Promise<void>;
  takeRemote: () => Promise<void>;
  compare: () => void;
}

/**
 * Three-way summary for a document whose GitHub file and local text both moved. An oversized remote
 * file cannot be read, so only the force-publish path remains available.
 */
export const SyncDialog = memo(function SyncDialog({
  open,
  onOpenChange,
  doc,
  sync,
  actions,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  doc: DocumentDto;
  sync: SyncStatusDto | null;
  actions: SyncActions;
}) {
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState<"merge" | "keep" | "take" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [publicationRevision, setPublicationRevision] = useState(0);
  const [mount] = useState(() => Symbol("sync-dialog"));
  const activePresentationRef = useRef<SyncPresentation | null>(null);
  const activePublicationRef = useRef<CommittedPublication | null>(null);
  const lastPublicationRef = useRef(new WeakMap<SyncPresentation, CommittedPublication>());
  const retiredPresentationRef = useRef(new WeakSet<SyncPresentation>());
  const retiredPublicationRef = useRef(new WeakSet<SyncPublication>());
  const retiredGenerationRef = useRef(new WeakSet<PublicationGeneration>());
  const generationElementsRef = useRef(new WeakMap<PublicationGeneration, GenerationElements>());
  const detachedElementsRef = useRef(new WeakMap<SyncPresentation, Set<HTMLElement>>());
  const reattachedElementsRef = useRef(new WeakMap<SyncPresentation, Set<HTMLElement>>());
  const latestGenerationRef = useRef<PublicationGeneration | null>(null);
  const replaySetupRef = useRef<{ presentation: SyncPresentation; active: boolean } | null>(null);
  const replayRequestRef = useRef<ReplayRequest | null>(null);
  const revisionRef = useRef(publicationRevision);
  const inFlightRef = useRef<ActionOwner | null>(null);
  const successCloseRef = useRef<SuccessClose | null>(null);
  const openChangeClaimRef = useRef<OpenChangeClaim | null>(null);
  revisionRef.current = publicationRevision;
  const docId = doc.id;
  const storage = doc.storage;
  const repoPath = doc.repoPath;
  const gistFile = doc.gistFile;
  const repoOwner = doc.repoOwner;
  const repoName = doc.repoName;
  const repoBranch = doc.repoBranch;
  const publishedAt = doc.publishedAt;
  const syncLines = sync?.lines ?? null;
  const syncRemote = sync?.remote ?? null;
  const status = sync?.status ?? "diverged";
  const localChanged = sync?.localChanged ?? false;
  const remoteChanged = sync?.remoteChanged ?? false;
  const localLines = syncLines?.local ?? 0;
  const remoteLines = syncLines?.remote ?? 0;
  const remoteUpdatedAt = syncRemote?.updatedAt ?? null;
  const remoteSha = syncRemote?.sha ?? null;
  const remoteSize = sync?.size ?? null;
  const remoteLimit = sync?.limit ?? null;
  const remoteUnreadable = status === "remote-unreadable";
  const merge = actions.merge;
  const keepMine = actions.keepMine;
  const takeRemote = actions.takeRemote;
  const compare = actions.compare;
  const presentation = useMemo<SyncPresentation>(
    () => {
      const request = replayRequestRef.current;
      const replay =
        request?.revision === publicationRevision && !request.consumed
          ? request
          : null;
      return {
        mount,
        revision: publicationRevision,
        replay,
        open,
        doc,
        docId,
        storage,
        repoPath,
        gistFile,
        repoOwner,
        repoName,
        repoBranch,
        publishedAt,
        sync,
        syncLines,
        syncRemote,
        status,
        localChanged,
        remoteChanged,
        localLines,
        remoteLines,
        remoteUpdatedAt,
        remoteSha,
        remoteSize,
        remoteLimit,
        remoteUnreadable,
        actions,
        merge,
        keepMine,
        takeRemote,
        compare,
        onOpenChange,
      };
    },
    [
      actions,
      compare,
      doc,
      docId,
      gistFile,
      keepMine,
      localChanged,
      localLines,
      merge,
      mount,
      onOpenChange,
      open,
      publishedAt,
      publicationRevision,
      remoteChanged,
      remoteLimit,
      remoteLines,
      remoteSha,
      remoteSize,
      remoteUnreadable,
      remoteUpdatedAt,
      repoBranch,
      repoName,
      repoOwner,
      repoPath,
      status,
      storage,
      sync,
      syncLines,
      syncRemote,
      takeRemote,
    ],
  );
  const initialMessageVisit = useMemo(
    () => (open ? { mount, docId, repoPath, gistFile, message: `Update ${repoPath ?? gistFile ?? "document"}` } : null),
    [docId, gistFile, mount, open, repoPath],
  );

  const expectedControlKinds = useCallback((candidate: SyncPresentation): readonly SyncControlKind[] =>
    candidate.remoteUnreadable
      ? ["keep"]
      : ["merge", "keep", "take", "compare"], []);
  const presentationFactsAreCurrent = useCallback(
    (candidate: SyncPresentation) => {
      const lines = candidate.sync?.lines ?? null;
      const remote = candidate.sync?.remote ?? null;
      return candidate.mount === mount &&
        candidate.open &&
        candidate.doc.id === candidate.docId &&
        candidate.doc.storage === candidate.storage &&
        candidate.doc.repoPath === candidate.repoPath &&
        candidate.doc.gistFile === candidate.gistFile &&
        candidate.doc.repoOwner === candidate.repoOwner &&
        candidate.doc.repoName === candidate.repoName &&
        candidate.doc.repoBranch === candidate.repoBranch &&
        candidate.doc.publishedAt === candidate.publishedAt &&
        lines === candidate.syncLines &&
        remote === candidate.syncRemote &&
        (candidate.sync?.status ?? "diverged") === candidate.status &&
        (candidate.sync?.localChanged ?? false) === candidate.localChanged &&
        (candidate.sync?.remoteChanged ?? false) === candidate.remoteChanged &&
        (lines?.local ?? 0) === candidate.localLines &&
        (lines?.remote ?? 0) === candidate.remoteLines &&
        (remote?.updatedAt ?? null) === candidate.remoteUpdatedAt &&
        (remote?.sha ?? null) === candidate.remoteSha &&
        (candidate.sync?.size ?? null) === candidate.remoteSize &&
        (candidate.sync?.limit ?? null) === candidate.remoteLimit &&
        (candidate.status === "remote-unreadable") === candidate.remoteUnreadable &&
        candidate.actions.merge === candidate.merge &&
        candidate.actions.keepMine === candidate.keepMine &&
        candidate.actions.takeRemote === candidate.takeRemote &&
        candidate.actions.compare === candidate.compare;
    },
    [mount],
  );
  const elementsFor = useCallback((generation: PublicationGeneration) => {
    let elements = generationElementsRef.current.get(generation);
    if (!elements) {
      elements = {
        elements: new Map<SyncRefKind, HTMLElement>(),
      };
      generationElementsRef.current.set(generation, elements);
    }
    return elements;
  }, []);
  const retireGeneration = useCallback((generation: PublicationGeneration) => {
    if (retiredGenerationRef.current.has(generation)) return;
    retiredGenerationRef.current.add(generation);
    const publications = generation.publications;
    if (publications) {
      retiredPublicationRef.current.add(publications.dialogEvent);
      retiredPublicationRef.current.add(publications.root);
      retiredPublicationRef.current.add(publications.input);
      for (const publication of publications.controls.values()) {
        retiredPublicationRef.current.add(publication);
      }
    }
    if (activePublicationRef.current?.generation === generation) {
      activePublicationRef.current = null;
    }
    const claim = openChangeClaimRef.current;
    if (claim?.publication.generation === generation) {
      claim.retired = true;
      openChangeClaimRef.current = null;
    }
  }, []);
  const snapshotDomMatches = useCallback(
    (commit: CommittedPublication, checkInputValue = true) => {
      const { generation } = commit;
      if (
        !commit.bridge.isConnected ||
        !commit.dialog.isConnected ||
        !commit.root.isConnected ||
        !commit.input.isConnected ||
        !commit.close.isConnected ||
        commit.root.closest('[role="dialog"]') !== commit.dialog ||
        !commit.dialog.contains(commit.root) ||
        !commit.dialog.contains(commit.input) ||
        !commit.dialog.contains(commit.close) ||
        commit.dialog.contains(commit.bridge) ||
        commit.dialog.getAttribute("role") !== "dialog" ||
        !commit.dialog.classList.contains("dialog") ||
        commit.dialog.querySelectorAll('button[aria-label="Close"]').length !== 1 ||
        commit.dialog.querySelector('button[aria-label="Close"]') !== commit.close ||
        !domMatches(commit.bridgeTree) ||
        !domMatches(commit.rootTree) ||
        !domMatches(commit.closeTree) ||
        (checkInputValue && commit.input.value !== generation.message)
      ) {
        return false;
      }
      return true;
    },
    [],
  );
  const publicationDomMatches = useCallback(
    (commit: CommittedPublication, checkInputValue = true) => {
      const { generation } = commit;
      const elements = generationElementsRef.current.get(generation);
      if (
        !elements ||
        elements.elements.get("bridge") !== commit.bridge ||
        elements.elements.get("root") !== commit.root ||
        elements.elements.get("input") !== commit.input ||
        !snapshotDomMatches(commit, checkInputValue)
      ) {
        return false;
      }
      for (const kind of expectedControlKinds(generation.presentation)) {
        if (elements.elements.get(kind) !== commit.controls.get(kind)) return false;
      }
      return true;
    },
    [expectedControlKinds, snapshotDomMatches],
  );
  const buildPublication = useCallback(
    (
      generation: PublicationGeneration,
      allowRetired = false,
    ): CommittedPublication | null => {
      if (
        (!allowRetired && retiredGenerationRef.current.has(generation)) ||
        (!allowRetired &&
          retiredPresentationRef.current.has(generation.presentation)) ||
        !presentationFactsAreCurrent(generation.presentation)
      ) {
        return null;
      }
      const observed = generationElementsRef.current.get(generation);
      if (!observed) return null;
      const bridge = observed.elements.get("bridge");
      const root = observed.elements.get("root");
      const input = observed.elements.get("input");
      if (
        !(bridge instanceof HTMLDivElement) ||
        !(root instanceof HTMLDivElement) ||
        !(input instanceof HTMLInputElement)
      ) {
        return null;
      }
      const dialog = root.closest('[role="dialog"]');
      const close = dialog?.querySelector('button[aria-label="Close"]');
      if (
        !(dialog instanceof HTMLDivElement) ||
        !(close instanceof HTMLButtonElement) ||
        !bridge.isConnected ||
        bridge.className !== "contents" ||
        !root.isConnected ||
        root.parentElement === null ||
        !dialog.contains(root) ||
        !dialog.contains(input) ||
        dialog.contains(bridge) ||
        dialog.querySelectorAll('[data-testid="sync-dialog"]').length !== 1 ||
        dialog.querySelector('[data-testid="sync-dialog"]') !== root ||
        dialog.querySelectorAll('button[aria-label="Close"]').length !== 1 ||
        root.className !== "flex flex-col gap-4" ||
        root.dataset.status !== generation.presentation.status ||
        input.className !== "input" ||
        input.value !== generation.message ||
        input.getAttribute("data-testid") !== "commit-message" ||
        input.closest("label")?.parentElement !== root ||
        close.type !== "button" ||
        close.disabled
      ) {
        return null;
      }
      const expectedKinds = expectedControlKinds(generation.presentation);
      const expectedIds: Record<SyncControlKind, string> = {
        merge: "sync-merge",
        keep: "sync-keep-mine",
        take: "sync-take-remote",
        compare: "sync-compare",
      };
      const expectedClasses: Record<SyncControlKind, string> = {
        merge: "btn btn-primary justify-start gap-2",
        keep: "btn btn-outline justify-start gap-2",
        take: "btn btn-outline justify-start gap-2",
        compare: "btn btn-ghost justify-start gap-2",
      };
      const controls = new Map<SyncControlKind, HTMLButtonElement>();
      for (const kind of expectedKinds) {
        const element = observed.elements.get(kind);
        const testId = expectedIds[kind];
        const expectedDisabled = kind === "compare"
          ? generation.busy !== null
          : generation.busy !== null || generation.done !== null;
        if (
          !(element instanceof HTMLButtonElement) ||
          !element.isConnected ||
          element.parentElement === null ||
          !root.contains(element) ||
          root.querySelectorAll(`[data-testid="${testId}"]`).length !== 1 ||
          root.querySelector(`[data-testid="${testId}"]`) !== element ||
          element.type !== "button" ||
          element.disabled !== expectedDisabled ||
          element.className !== expectedClasses[kind]
        ) {
          return null;
        }
        controls.set(kind, element);
      }
      const renderedControls = [...root.querySelectorAll<HTMLButtonElement>(
        'button[data-testid^="sync-"]',
      )];
      if (
        renderedControls.length !== expectedKinds.length ||
        renderedControls.some((element, index) =>
          element !== controls.get(expectedKinds[index]!))
      ) {
        return null;
      }
      return {
        generation,
        bridge,
        dialog,
        root,
        input,
        close,
        controls,
        bridgeTree: snapshotDom(bridge),
        rootTree: snapshotDom(root),
        closeTree: snapshotDom(close),
      };
    },
    [expectedControlKinds, presentationFactsAreCurrent],
  );
  const sameCommittedElements = useCallback(
    (left: CommittedPublication, right: CommittedPublication) => {
      if (
        left.bridge !== right.bridge ||
        left.dialog !== right.dialog ||
        left.root !== right.root ||
        left.input !== right.input ||
        left.close !== right.close ||
        left.controls.size !== right.controls.size
      ) {
        return false;
      }
      for (const [kind, element] of left.controls) {
        if (right.controls.get(kind) !== element) return false;
      }
      return true;
    },
    [],
  );
  const sawCompleteRefReplay = useCallback(
    (commit: CommittedPublication) => {
      // The outer bridge can replay before Radix commits its portal. Require every
      // exact element in the final presentation to detach and reattach before succession.
      const candidate = commit.generation.presentation;
      const detached = detachedElementsRef.current.get(candidate);
      const reattached = reattachedElementsRef.current.get(candidate);
      if (!detached || !reattached) return false;
      const required: HTMLElement[] = [
        commit.bridge,
        commit.root,
        commit.input,
        ...expectedControlKinds(candidate).map((kind) => commit.controls.get(kind)!),
      ];
      return required.every((element) =>
        detached.has(element) && reattached.has(element));
    },
    [expectedControlKinds],
  );
  const retirePresentation = useCallback(
    (candidate: SyncPresentation) => {
      if (retiredPresentationRef.current.has(candidate)) return false;
      retiredPresentationRef.current.add(candidate);
      const wasActive = activePresentationRef.current === candidate;
      if (wasActive) activePresentationRef.current = null;
      const commit = lastPublicationRef.current.get(candidate);
      if (commit) retireGeneration(commit.generation);
      const inFlight = inFlightRef.current;
      if (inFlight?.presentation === candidate) {
        inFlight.retired = true;
        inFlightRef.current = null;
      }
      const scheduledClose = successCloseRef.current;
      if (scheduledClose?.owner.presentation === candidate) {
        scheduledClose.retired = true;
        scheduledClose.owner.retired = true;
        clearTimeout(scheduledClose.timer);
        successCloseRef.current = null;
      }
      const claim = openChangeClaimRef.current;
      if (claim?.publication.generation.presentation === candidate) {
        claim.retired = true;
        openChangeClaimRef.current = null;
      }
      return wasActive;
    },
    [retireGeneration],
  );
  const maybeRequestReplay = useCallback(
    (candidate: SyncPresentation) => {
      const setup = replaySetupRef.current;
      const commit = lastPublicationRef.current.get(candidate);
      if (
        !setup?.active ||
        setup.presentation !== candidate ||
        !commit ||
        (replayRequestRef.current && !replayRequestRef.current.consumed) ||
        activePresentationRef.current ||
        activePublicationRef.current ||
        !retiredPresentationRef.current.has(candidate) ||
        !retiredGenerationRef.current.has(commit.generation) ||
        !presentationFactsAreCurrent(candidate) ||
        !publicationDomMatches(commit) ||
        !sawCompleteRefReplay(commit)
      ) {
        return;
      }
      const request: ReplayRequest = {
        predecessor: candidate,
        commit,
        revision: revisionRef.current + 1,
        consumed: false,
      };
      replayRequestRef.current = request;
      setPublicationRevision(request.revision);
    },
    [presentationFactsAreCurrent, publicationDomMatches, sawCompleteRefReplay],
  );
  const admitReplay = useCallback(
    (
      candidate: SyncPresentation,
      generation: PublicationGeneration,
      commit: CommittedPublication,
    ) => {
      const replayRequest = candidate.replay;
      if (!replayRequest) return true;
      if (replayRequest.consumed) {
        return activePresentationRef.current === candidate;
      }
      const predecessorCommit = replayRequest.commit;
      if (
        replayRequestRef.current !== replayRequest ||
        replayRequest.revision !== candidate.revision ||
        replayRequest.predecessor === candidate ||
        !retiredPresentationRef.current.has(replayRequest.predecessor) ||
        !retiredGenerationRef.current.has(predecessorCommit.generation) ||
        !samePresentationFacts(candidate, replayRequest.predecessor) ||
        generation.message !== predecessorCommit.generation.message ||
        generation.busy !== predecessorCommit.generation.busy ||
        generation.error !== predecessorCommit.generation.error ||
        generation.done !== predecessorCommit.generation.done ||
        !snapshotDomMatches(predecessorCommit) ||
        !sawCompleteRefReplay(predecessorCommit) ||
        !sameCommittedElements(commit, predecessorCommit)
      ) {
        return false;
      }
      replayRequest.consumed = true;
      return true;
    },
    [sameCommittedElements, sawCompleteRefReplay, snapshotDomMatches],
  );
  const publishGeneration = useCallback(
    (generation: PublicationGeneration) => {
      if (
        activePresentationRef.current !== generation.presentation ||
        retiredPresentationRef.current.has(generation.presentation)
      ) {
        return null;
      }
      const commit = buildPublication(generation);
      if (!commit) return null;
      if (!admitReplay(generation.presentation, generation, commit)) {
        retireGeneration(generation);
        retirePresentation(generation.presentation);
        return null;
      }
      activePublicationRef.current = commit;
      lastPublicationRef.current.set(generation.presentation, commit);
      return commit;
    },
    [admitReplay, buildPublication, retireGeneration, retirePresentation],
  );
  const activateGeneration = useCallback(
    (generation: PublicationGeneration) => {
      const candidate = generation.presentation;
      const previous = activePresentationRef.current;
      if (previous && previous !== candidate) retirePresentation(previous);
      activePresentationRef.current = candidate;
      const commit = buildPublication(generation);
      if (!commit) return true;
      if (!admitReplay(candidate, generation, commit)) {
        retireGeneration(generation);
        retirePresentation(candidate);
        return false;
      }
      activePublicationRef.current = commit;
      lastPublicationRef.current.set(candidate, commit);
      return true;
    },
    [
      admitReplay,
      buildPublication,
      retireGeneration,
      retirePresentation,
    ],
  );
  const setPublicationElement = useCallback(
    (
      publication: SyncPublication,
      kind: SyncRefKind,
      element: HTMLElement | null,
    ) => {
      const generation = publication.generation;
      const observed = elementsFor(generation);
      const previous = observed.elements.get(kind) ?? null;
      const candidate = generation.presentation;
      if (element === null) {
        if (previous) {
          observed.elements.delete(kind);
          let detached = detachedElementsRef.current.get(candidate);
          if (!detached) {
            detached = new Set<HTMLElement>();
            detachedElementsRef.current.set(candidate, detached);
          }
          detached.add(previous);
        }
        retireGeneration(generation);
      } else {
        if (previous && previous !== element) retireGeneration(generation);
        observed.elements.set(kind, element);
        if (detachedElementsRef.current.get(candidate)?.has(element)) {
          let reattached = reattachedElementsRef.current.get(candidate);
          if (!reattached) {
            reattached = new Set<HTMLElement>();
            reattachedElementsRef.current.set(candidate, reattached);
          }
          reattached.add(element);
        }
      }
      if (retiredPresentationRef.current.has(candidate)) {
        retireGeneration(generation);
        const replayCommit = buildPublication(generation, true);
        if (replayCommit) {
          lastPublicationRef.current.set(candidate, replayCommit);
        }
        maybeRequestReplay(candidate);
      } else if (!retiredGenerationRef.current.has(generation)) {
        publishGeneration(generation);
      }
    },
    [
      buildPublication,
      elementsFor,
      maybeRequestReplay,
      publishGeneration,
      retireGeneration,
    ],
  );
  const ownsPresentation = useCallback(
    (candidate: SyncPresentation) => {
      const commit = activePublicationRef.current;
      return activePresentationRef.current === candidate &&
        !retiredPresentationRef.current.has(candidate) &&
        candidate.mount === mount &&
        candidate.open &&
        !!commit &&
        commit.generation.presentation === candidate &&
        !retiredGenerationRef.current.has(commit.generation) &&
        presentationFactsAreCurrent(candidate) &&
        publicationDomMatches(commit);
    },
    [mount, presentationFactsAreCurrent, publicationDomMatches],
  );
  const ownsControl = useCallback(
    (
      publication: ControlPublication,
      element: HTMLButtonElement,
    ) => {
      const commit = activePublicationRef.current;
      return !retiredPublicationRef.current.has(publication) &&
        commit?.generation === publication.generation &&
        commit.controls.get(publication.kind) === element &&
        ownsPresentation(publication.generation.presentation);
    },
    [ownsPresentation],
  );
  const ownsInput = useCallback(
    (
      publication: InputPublication,
      element: HTMLInputElement,
    ) => {
      const commit = activePublicationRef.current;
      return !retiredPublicationRef.current.has(publication) &&
        commit?.generation === publication.generation &&
        commit.input === element &&
        publicationDomMatches(commit, false) &&
        activePresentationRef.current === publication.generation.presentation &&
        !retiredPresentationRef.current.has(publication.generation.presentation) &&
        presentationFactsAreCurrent(publication.generation.presentation);
    },
    [presentationFactsAreCurrent, publicationDomMatches],
  );
  const ownsDialogEvent = useCallback(
    (
      publication: DialogEventPublication,
      element: HTMLDivElement,
    ) => {
      const commit = activePublicationRef.current;
      return !retiredPublicationRef.current.has(publication) &&
        commit?.generation === publication.generation &&
        commit.bridge === element &&
        ownsPresentation(publication.generation.presentation);
    },
    [ownsPresentation],
  );
  const closePresentation = useCallback(
    (candidate: SyncPresentation) => {
      if (!ownsPresentation(candidate) || !retirePresentation(candidate)) return;
      candidate.onOpenChange(false);
    },
    [ownsPresentation, retirePresentation],
  );

  const run = async (
    publication: ActionControlPublication,
    element: HTMLButtonElement,
  ) => {
    const candidate = publication.generation.presentation;
    if (
      !ownsControl(publication, element) ||
      inFlightRef.current ||
      successCloseRef.current ||
      ((publication.kind === "merge" || publication.kind === "take") &&
        candidate.remoteUnreadable)
    ) {
      return;
    }

    const owner: ActionOwner = {
      presentation: candidate,
      publication,
      retired: false,
    };
    inFlightRef.current = owner;
    setBusy(publication.kind);
    setError(null);
    setDone(null);
    try {
      const note = await publication.invoke();
      if (
        owner.retired ||
        !ownsPresentation(candidate) ||
        inFlightRef.current !== owner
      ) {
        return;
      }
      setDone(note);
      const scheduledClose: SuccessClose = {
        owner,
        timer: setTimeout(() => {
          if (
            scheduledClose.retired ||
            owner.retired ||
            successCloseRef.current !== scheduledClose ||
            !ownsPresentation(candidate)
          ) {
            return;
          }
          scheduledClose.retired = true;
          owner.retired = true;
          successCloseRef.current = null;
          closePresentation(candidate);
        }, 900),
        retired: false,
      };
      successCloseRef.current = scheduledClose;
    } catch (e) {
      if (
        owner.retired ||
        !ownsPresentation(candidate) ||
        inFlightRef.current !== owner
      ) {
        return;
      }
      setError(apiErrorText(e, "Sync failed"));
    } finally {
      if (
        !owner.retired &&
        ownsPresentation(candidate) &&
        inFlightRef.current === owner
      ) {
        inFlightRef.current = null;
        setBusy(null);
        if (!successCloseRef.current || successCloseRef.current.owner !== owner) {
          owner.retired = true;
        }
      }
    }
  };

  const generation: PublicationGeneration = {
    presentation,
    message,
    busy,
    error,
    done,
    publications: null,
  };
  const dialogEventPublication: DialogEventPublication = { generation };
  const rootPublication: RootPublication = { generation };
  const inputPublication: InputPublication = { generation };
  const publishedMessage = message.trim();
  const mergePublication: ActionControlPublication = {
    generation,
    kind: "merge",
    invoke: async () => {
      const conflicts = await presentation.merge();
      return conflicts > 0
        ? `${conflicts} conflict${conflicts === 1 ? "" : "s"} to resolve in the editor`
        : "Merged — review, then publish";
    },
  };
  const keepPublication: ActionControlPublication = {
    generation,
    kind: "keep",
    invoke: async () =>
      (await presentation.keepMine(publishedMessage), "Published your version"),
  };
  const takePublication: ActionControlPublication = {
    generation,
    kind: "take",
    invoke: async () =>
      (await presentation.takeRemote(), "Replaced with GitHub's copy"),
  };
  const comparePublication: CompareControlPublication = {
    generation,
    kind: "compare",
    invoke: presentation.compare,
  };
  generation.publications = {
    dialogEvent: dialogEventPublication,
    root: rootPublication,
    input: inputPublication,
    controls: new Map<SyncControlKind, ControlPublication>([
      ["merge", mergePublication],
      ["keep", keepPublication],
      ["take", takePublication],
      ["compare", comparePublication],
    ]),
  };
  latestGenerationRef.current = generation;

  useLayoutEffect(() => {
    const previous = activePresentationRef.current;
    if (previous && previous !== presentation) retirePresentation(previous);
    if (!presentation.open) {
      return () => {
        retirePresentation(presentation);
      };
    }
    if (retiredPresentationRef.current.has(presentation)) {
      const setup = { presentation, active: true };
      replaySetupRef.current = setup;
      maybeRequestReplay(presentation);
      return () => {
        setup.active = false;
        if (replaySetupRef.current === setup) replaySetupRef.current = null;
        retirePresentation(presentation);
      };
    }

    const currentGeneration = latestGenerationRef.current;
    if (
      currentGeneration?.presentation === presentation &&
      activateGeneration(currentGeneration) &&
      !presentation.replay
    ) {
      setError(null);
      setDone(null);
      setBusy(null);
    }
    return () => {
      retirePresentation(presentation);
    };
  }, [
    activateGeneration,
    maybeRequestReplay,
    presentation,
    retirePresentation,
  ]);

  useLayoutEffect(() => {
    if (initialMessageVisit) setMessage(initialMessageVisit.message);
  }, [initialMessageVisit]);

  // Radix handles Escape and outside pointer events in document capture, before portal React capture.
  useLayoutEffect(() => {
    const authorizeNativeOpenChange = (event: KeyboardEvent | PointerEvent) => {
      if (event instanceof KeyboardEvent && event.key !== "Escape") return;
      const commit = activePublicationRef.current;
      const publication = commit?.generation.publications?.dialogEvent;
      if (
        !commit ||
        !publication ||
        !ownsDialogEvent(publication, commit.bridge)
      ) {
        return;
      }
      const previous = openChangeClaimRef.current;
      if (previous) previous.retired = true;
      const claim: OpenChangeClaim = {
        publication,
        target: event.target,
        retired: false,
      };
      openChangeClaimRef.current = claim;
      queueMicrotask(() => {
        if (openChangeClaimRef.current === claim) {
          claim.retired = true;
          openChangeClaimRef.current = null;
        }
      });
    };
    document.addEventListener("keydown", authorizeNativeOpenChange, true);
    document.addEventListener("pointerdown", authorizeNativeOpenChange, true);
    return () => {
      document.removeEventListener("keydown", authorizeNativeOpenChange, true);
      document.removeEventListener("pointerdown", authorizeNativeOpenChange, true);
    };
  }, [ownsDialogEvent]);

  const activateCompare = (
    publication: CompareControlPublication,
    element: HTMLButtonElement,
  ) => {
    const candidate = publication.generation.presentation;
    if (
      !ownsControl(publication, element) ||
      candidate.remoteUnreadable ||
      inFlightRef.current ||
      successCloseRef.current ||
      !retirePresentation(candidate)
    ) {
      return;
    }
    publication.invoke();
    candidate.onOpenChange(false);
  };
  const handleOpenChange = (nextOpen: boolean) => {
    if (nextOpen) {
      const commit = activePublicationRef.current;
      if (commit && ownsDialogEvent(dialogEventPublication, commit.bridge)) {
        presentation.onOpenChange(true);
      }
      return;
    }
    const claim = openChangeClaimRef.current;
    if (
      !claim ||
      claim.retired ||
      claim.publication !== dialogEventPublication
    ) {
      return;
    }
    claim.retired = true;
    openChangeClaimRef.current = null;
    closePresentation(presentation);
  };
  const authorizeOpenChange = (
    publication: DialogEventPublication,
    element: HTMLDivElement,
    target: EventTarget | null,
  ) => {
    if (!ownsDialogEvent(publication, element)) return;
    const previous = openChangeClaimRef.current;
    if (previous) previous.retired = true;
    openChangeClaimRef.current = {
      publication,
      target,
      retired: false,
    };
  };
  const releaseOpenChange = (
    publication: DialogEventPublication,
    target: EventTarget | null,
  ) => {
    const claim = openChangeClaimRef.current;
    if (
      claim?.publication === publication &&
      claim.target === target
    ) {
      claim.retired = true;
      openChangeClaimRef.current = null;
    }
  };
  const where = presentation.storage === "gist"
    ? "the gist"
    : `${presentation.repoOwner}/${presentation.repoName} (${presentation.repoBranch})`;
  const plural = (n: number) => `${n} line${n === 1 ? "" : "s"}`;
  const formatMb = (bytes: number) => {
    const mb = bytes / (1024 * 1024);
    return mb >= 10 ? String(Math.ceil(mb)) : String(Math.ceil(mb * 100) / 100);
  };
  const sizeMessage =
    presentation.remoteSize != null && presentation.remoteLimit != null
      ? `The GitHub file is ${formatMb(presentation.remoteSize)} MB, but Markdoc can read files up to ${formatMb(presentation.remoteLimit)} MB.`
      : "The GitHub file is too large for Markdoc to read.";

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <div
        ref={(element) =>
          setPublicationElement(dialogEventPublication, "bridge", element)}
        className="contents"
        onClickCapture={(event) => authorizeOpenChange(dialogEventPublication, event.currentTarget, event.target)}
        onClick={(event) => releaseOpenChange(dialogEventPublication, event.target)}
        onPointerDownCapture={(event) => authorizeOpenChange(dialogEventPublication, event.currentTarget, event.target)}
        onPointerDown={(event) => releaseOpenChange(dialogEventPublication, event.target)}
        onKeyDownCapture={(event) => authorizeOpenChange(dialogEventPublication, event.currentTarget, event.target)}
        onKeyDown={(event) => releaseOpenChange(dialogEventPublication, event.target)}
      >
        <DialogContent
          title="Sync with GitHub"
          description={presentation.remoteUnreadable ? `The file in ${where} cannot be read until it is made smaller or replaced.` : `This document and ${where} both changed since they were last in sync.`}
        >
          <div
            ref={(element) =>
              setPublicationElement(rootPublication, "root", element)}
            className="flex flex-col gap-4"
            data-testid="sync-dialog"
            data-status={presentation.status}
          >
          {presentation.remoteUnreadable ? (
            <div className="flex items-start gap-2 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:bg-amber-950/40 dark:text-amber-200" role="alert" data-testid="sync-remote-unreadable">
              <AlertTriangle size={16} className="mt-0.5 shrink-0" />
              <div>
                <div>{sizeMessage}</div>
                <div className="mt-1 text-xs">Merge, pull, and compare are unavailable. Keep mine will replace the GitHub file with this document.</div>
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-3 text-sm">
              <div className="rounded-xl border border-line bg-surface-2 p-3">
                <div className="text-xs font-medium uppercase tracking-wide text-ink-3">This document</div>
                <div className="mt-1 font-medium text-ink" data-testid="sync-local-lines">
                  {presentation.localChanged ? `${plural(presentation.localLines)} changed` : "No changes"}
                </div>
                <div className="text-xs text-ink-3">since {presentation.publishedAt ? relativeTime(presentation.publishedAt) : "the last sync"}</div>
              </div>
              <div className="rounded-xl border border-line bg-surface-2 p-3">
                <div className="text-xs font-medium uppercase tracking-wide text-ink-3">On GitHub</div>
                <div className="mt-1 font-medium text-ink" data-testid="sync-remote-lines">
                  {presentation.remoteChanged ? `${plural(presentation.remoteLines)} changed` : "No changes"}
                </div>
                <div className="truncate text-xs text-ink-3">
                  {presentation.remoteUpdatedAt ? `updated ${relativeTime(presentation.remoteUpdatedAt)}` : presentation.remoteSha ? `at ${presentation.remoteSha.slice(0, 7)}` : "\u00a0"}
                </div>
              </div>
            </div>
          )}

          <div className="flex flex-col gap-2">
            {!presentation.remoteUnreadable && (
              <button
                ref={(element) =>
                  setPublicationElement(mergePublication, "merge", element)}
                type="button"
                className="btn btn-primary justify-start gap-2"
                disabled={!!busy || !!done}
                data-testid="sync-merge"
                onClick={(event) => void run(mergePublication, event.currentTarget)}
              >
                {busy === "merge" ? <Loader2 size={16} className="animate-spin" /> : <GitMerge size={16} />}
                <span className="flex flex-col items-start">
                  <span>Merge</span>
                  <span className="text-xs font-normal opacity-80">Combine both sets of edits; conflicting lines are marked for you to resolve.</span>
                </span>
              </button>
            )}
            <button
              ref={(element) =>
                setPublicationElement(keepPublication, "keep", element)}
              type="button"
              className="btn btn-outline justify-start gap-2"
              disabled={!!busy || !!done}
              data-testid="sync-keep-mine"
              onClick={(event) => void run(keepPublication, event.currentTarget)}
            >
              {busy === "keep" ? <Loader2 size={16} className="animate-spin" /> : <UploadCloud size={16} />}
              <span className="flex flex-col items-start">
                <span>Keep mine</span>
                <span className="text-xs font-normal text-ink-3">Force-publish this document over the GitHub file.</span>
              </span>
            </button>
            {!presentation.remoteUnreadable && (
              <>
                <button
                  ref={(element) =>
                    setPublicationElement(takePublication, "take", element)}
                  type="button"
                  className="btn btn-outline justify-start gap-2"
                  disabled={!!busy || !!done}
                  data-testid="sync-take-remote"
                  onClick={(event) => void run(takePublication, event.currentTarget)}
                >
                  {busy === "take" ? <Loader2 size={16} className="animate-spin" /> : <CloudDownload size={16} />}
                  <span className="flex flex-col items-start">
                    <span>Take GitHub</span>
                    <span className="text-xs font-normal text-ink-3">Force-pull; your local edits are kept in version history.</span>
                  </span>
                </button>
                <button
                  ref={(element) =>
                    setPublicationElement(comparePublication, "compare", element)}
                  type="button"
                  className="btn btn-ghost justify-start gap-2"
                  disabled={!!busy}
                  data-testid="sync-compare"
                  onClick={(event) => activateCompare(comparePublication, event.currentTarget)}
                >
                  <Scale size={16} /> Compare GitHub with this document
                </button>
              </>
            )}
          </div>

          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium text-ink-2">{presentation.storage === "gist" ? "Description" : "Commit message"} <span className="font-normal text-ink-3">(for Keep mine)</span></span>
            <input
              ref={(element) =>
                setPublicationElement(inputPublication, "input", element)}
              className="input"
              value={message}
              onChange={(event) => {
                if (!ownsInput(inputPublication, event.currentTarget)) return;
                setMessage(event.currentTarget.value);
              }}
              data-testid="commit-message"
            />
          </label>

          {error && (
            <div className="flex items-center gap-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-danger dark:bg-red-950/40" role="alert">
              <AlertTriangle size={14} /> {error}
            </div>
          )}
          {done && (
            <div className="flex items-center gap-2 rounded-lg bg-surface-2 px-3 py-2 text-sm text-ink-2" data-testid="sync-done">
              <Check size={14} className="text-success" /> {done}
            </div>
          )}
          </div>
        </DialogContent>
      </div>
    </Dialog>
  );
});
