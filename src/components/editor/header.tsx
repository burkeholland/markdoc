"use client";
import { Avatar, Menu, MenuContent, MenuItem, MenuLabel, MenuRadioGroup, MenuRadioItem, MenuSeparator, MenuTrigger, Popover, PopoverContent, PopoverTrigger, Tip } from "@/components/ui/primitives";
import { GitHubIcon } from "@/components/ui/github-icon";

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  Activity,
  Check,
  ChevronDown,
  CloudOff,
  Loader2,
  MessageSquare,
  MoreVertical,
  Pencil,
  Share2,
  UserPlus,
  History,
  Download,
  FileCode2,
  FileText,
  Copy,
  Files,
  Trash2,
  Keyboard,
  Command,
  ExternalLink,
  AlertTriangle,
  Eye,
  PenLine,
  MessageSquarePlus,
  LogOut,
  ArrowLeft,
  RefreshCw,
  UploadCloud,
  Link2,
  Star,
  BookOpen,
  PanelLeft,
  Code2,
  GitMerge,
  Bot,
} from "lucide-react";
import type { CollabSession, EditMode, PresenceUser, SaveState } from "@/editor/collab/session";
import type { SyncStatusDto } from "@/lib/api";
import { GITHUB_NOT_CONFIGURED, SYNC_LABELS } from "./labels";
import { isIdle } from "@/editor/collab/follow";
import { saveStateLabel } from "@/editor/collab/offline";
import type { DocumentDto } from "@/server/dto";
import { api, apiErrorText } from "@/lib/api";
import type { Layout } from "@/lib/viewport";

import { cn, shortcut } from "@/lib/utils";
import { jsonEqual, useOpenSettled, useSessionValue } from "./use-session";
import { NotificationsBell } from "@/components/notifications/notifications-bell";
import type { NotificationDto } from "@/lib/api";
import { pendingRequests, useAgentRequests } from "./agent-requests";
import { AgentBusyBadge, ConnectAgentButton, PresenceActivity, PresenceRequests, WaitingPlaceholder, busyAgentNames, isRecentActivity, pendingWorker, presenceAgentName, presenceNameOf, useAgentActivity, waitingLabel } from "./presence-agents";
import { signOutSafely } from "@/lib/sign-out";
import { Logo } from "@/components/ui/logo";
import { useEverTrue, useHydrated } from "@/lib/hooks";
import { lazyOnFirstUse } from "./lazy-on-first-use";
import { HEADER_BOX } from "./chrome-classes";
import { useEnterOnRelease, usePlaceHold } from "./press-once";

// On demand (#1150): the dialog, with its setup steps and copy blocks behind it, is fetched on its first
// open and then stays mounted (mount-once gate below), so Radix's close handling and focus return are unchanged.
const AgentDialog = lazyOnFirstUse(() => import("@/components/agents/agent-dialog"), (m) => m.AgentDialog);

type ManualSaveState =
  | { readonly session: CollabSession; readonly status: "pending" }
  | { readonly session: CollabSession; readonly status: "failed"; readonly message: string };

function saveStateVisual(state: SaveState): { className: string; icon: React.ReactNode } {
  switch (state) {
    case "saved":
      return { className: "text-success", icon: <Check size={16} strokeWidth={2.5} /> };
    case "pending":
      return { className: "text-ink-3", icon: <CloudOff size={16} /> };
    case "saving":
    case "connecting":
      return { className: "text-ink-3", icon: <Loader2 size={16} className="animate-spin" /> };
    case "reconnecting":
      return { className: "text-warning", icon: <Loader2 size={16} className="animate-spin" /> };
    case "offline":
      return { className: "text-warning", icon: <CloudOff size={16} /> };
    case "error":
      return { className: "text-danger", icon: <AlertTriangle size={16} /> };
  }
}

export function SaveIndicator({ session, compact }: { session: CollabSession; compact?: boolean }) {
  const liveState = useSessionValue(session, (s) => s.saveState);
  const liveUnsyncedChanges = useSessionValue(session, (s) => s.unsyncedChanges);
  const liveDirty = useSessionValue(session, (s) => s.dirty);
  const liveRecovered = useSessionValue(session, (s) => s.recovered);
  const liveProlonged = useSessionValue(session, (s) => s.prolongedOffline);
  const saveError = useSessionValue(session, (s) => s.saveError);
  // Pending and failure belong to the session they were started on, so a replaced session starts clean.
  const [manualSave, setManualSave] = useState<ManualSaveState | null>(null);
  // Blocks a second click that lands before React re-renders the button as disabled.
  const savingRef = useRef<CollabSession | null>(null);
  const current = manualSave?.session === session ? manualSave : null;
  const manualPending = current?.status === "pending";
  const manualError = current?.status === "failed" ? current.message : null;
  const canEdit = session.canEdit;

  // Same path as Ctrl+S (#2217): flush the session directly on every click or Enter/Space.
  const onSave = () => {
    if (!session.canEdit || savingRef.current === session) return;
    const saving = session;
    savingRef.current = saving;
    setManualSave({ session: saving, status: "pending" });
    saving.flushSave().then(
      () => {
        setManualSave((s) => (s?.session === saving ? null : s));
      },
      (error: unknown) => {
        const message = error instanceof Error ? error.message : "Save failed";
        setManualSave((s) => (s?.session === saving ? { session: saving, status: "failed", message } : s));
      },
    ).finally(() => {
      if (savingRef.current === saving) savingRef.current = null;
    });
  };

  // The server renders a fresh session ("Connecting…"); an offline client may already have
  // failed to connect by the time React hydrates. Match the server markup first, then switch.
  const hydrated = useHydrated();
  const state: SaveState = hydrated ? liveState : "connecting";
  const unsynced = hydrated ? Math.max(liveUnsyncedChanges, liveDirty ? 1 : 0) : 0;
  const recovered = hydrated && liveRecovered;
  const prolonged = hydrated && liveProlonged;
  const label = state === "error" && saveError
    ? "Save failed — retry"
    : saveStateLabel(state, unsynced, recovered, prolonged);
  const visual = saveStateVisual(state);
  const flash = state === "saved" && recovered;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md text-sm font-medium transition-colors",
        visual.className,
        flash && "save-state-recovered",
      )}
      data-testid="save-state"
      data-state={state}
      data-live-state={state}
      data-unsynced={unsynced}
      data-recovered={flash || undefined}
      data-prolonged={prolonged || undefined}
      role="status"
      title={manualError ?? saveError ?? (compact ? label : undefined)}
    >
      <button
        type="button"
        className="tap-target relative inline-flex min-h-6 min-w-6 items-center justify-center gap-1.5"
        disabled={!canEdit || manualPending}
        aria-busy={manualPending || undefined}
        aria-label="Save document"
        onClick={onSave}
      >
        {visual.icon}
        {/* Phones show the icon only; the server markup uses the same responsive label. */}
        <span className={cn(compact ? "sr-only" : "max-md:sr-only")}>{manualError ?? label}</span>
      </button>
    </span>
  );
}

interface TitleEditState {
  readonly generation: object;
  readonly session: CollabSession;
  readonly draft: string;
}

interface TitleRender {
  readonly identity: object;
  readonly mount: symbol;
  readonly session: CollabSession;
  readonly fallback: string;
  readonly title: string;
  readonly role: CollabSession["role"];
  readonly canEdit: boolean;
  readonly compact: boolean | undefined;
  readonly editing: boolean;
  readonly draft: string;
  readonly generation: object | null;
  readonly setTitle: CollabSession["setTitle"];
  readonly buttonClassName: string;
  readonly buttonTitle: string;
  readonly titleClassName: string;
  readonly iconClassName: string;
  readonly inputClassName: string;
  readonly inputLabel: string;
}

interface TitleDomSnapshot {
  readonly node: Node;
  readonly nodeValue: string | null;
  readonly attributes: readonly (readonly [string, string])[] | null;
  readonly children: readonly TitleDomSnapshot[];
}

interface TitleDisplayPresentation {
  readonly kind: "display";
  readonly render: TitleRender;
  readonly document: Document;
  readonly button: HTMLButtonElement;
  readonly title: HTMLSpanElement;
  readonly icon: SVGSVGElement | null;
  readonly snapshot: TitleDomSnapshot;
  readonly targets: WeakSet<Node>;
}

interface TitleInputPresentation {
  readonly kind: "input";
  readonly render: TitleRender;
  readonly document: Document;
  readonly input: HTMLInputElement;
  readonly snapshot: TitleDomSnapshot;
}

type TitlePresentation = TitleDisplayPresentation | TitleInputPresentation;

interface TitlePublicationRuntime {
  readonly presentation: TitlePresentation;
  readonly retireForElement: () => void;
  readonly retireForLayout: () => void;
  readonly isExactElementReplay: () => boolean;
  readonly isExactLayoutReplay: () => boolean;
}

class TitlePublicationAuthority {
  #active: TitlePresentation | null = null;
  #successorOf: TitlePresentation | null = null;
  #claimedEvents = new WeakSet<Event>();
  #claimedPresentations = new WeakSet<TitlePresentation>();
  #settledGenerations = new WeakSet<object>();
  #focusedInputs = new WeakMap<object, HTMLInputElement>();

  active() {
    return this.#active;
  }

  publish(presentation: TitlePresentation) {
    this.#active = presentation;
    this.#successorOf = null;
  }

  retire(presentation: TitlePresentation) {
    if (this.#active !== presentation) return;
    this.#active = null;
    this.#successorOf = presentation;
  }

  acceptsSuccessorOf(presentation: TitlePresentation) {
    return this.#active === null && this.#successorOf === presentation;
  }

  claim(presentation: TitlePresentation, event: Event, settle = false) {
    const generation = presentation.render.generation;
    if (
      this.#claimedEvents.has(event) ||
      this.#claimedPresentations.has(presentation) ||
      (settle && (!generation || this.#settledGenerations.has(generation)))
    ) {
      return false;
    }
    this.#claimedEvents.add(event);
    this.#claimedPresentations.add(presentation);
    if (settle && generation) this.#settledGenerations.add(generation);
    return true;
  }

  claimFocus(generation: object, input: HTMLInputElement) {
    if (this.#settledGenerations.has(generation) || this.#focusedInputs.get(generation) === input) return false;
    this.#focusedInputs.set(generation, input);
    return true;
  }
}

class TitleElementOwner<T extends Element> {
  #current: T | null = null;
  #last: T | null = null;

  constructor(
    private readonly onChange: (
      element: T | null,
      previous: T | null,
      last: T | null,
    ) => void,
  ) {}

  element = () => this.#current;

  capture: React.RefCallback<T> = (element) => {
    if (this.#current === element) return;
    const previous = this.#current;
    const last = this.#last;
    this.#current = element;
    if (element) this.#last = element;
    this.onChange(element, previous, last);
  };
}

function snapshotTitleDom(node: Node): TitleDomSnapshot {
  const ElementConstructor = node.ownerDocument?.defaultView?.Element;
  const attributes = ElementConstructor && node instanceof ElementConstructor
    ? Object.freeze(Array.from(node.attributes, (attribute) => Object.freeze([attribute.name, attribute.value] as const)))
    : null;
  const children = Object.freeze(Array.from(node.childNodes, snapshotTitleDom));
  return Object.freeze({ node, nodeValue: node.nodeValue, attributes, children });
}

function titleDomMatches(snapshot: TitleDomSnapshot): boolean {
  const { node, attributes, children } = snapshot;
  if (node.nodeValue !== snapshot.nodeValue || node.childNodes.length !== children.length) return false;
  if (attributes) {
    const ElementConstructor = node.ownerDocument?.defaultView?.Element;
    if (!ElementConstructor || !(node instanceof ElementConstructor) || node.attributes.length !== attributes.length) return false;
    for (let index = 0; index < attributes.length; index++) {
      const expected = attributes[index];
      const actual = node.attributes.item(index);
      if (!actual || actual.name !== expected[0] || actual.value !== expected[1]) return false;
    }
  }
  for (let index = 0; index < children.length; index++) {
    if (node.childNodes.item(index) !== children[index].node || !titleDomMatches(children[index])) return false;
  }
  return true;
}

function collectTitleTargets(snapshot: TitleDomSnapshot, targets: WeakSet<Node>) {
  targets.add(snapshot.node);
  for (const child of snapshot.children) collectTitleTargets(child, targets);
}

function titleRenderIsCurrent(render: TitleRender) {
  const { session } = render;
  const canEdit = session.canWrite;
  return (
    session.role === render.role &&
    canEdit === render.canEdit &&
    session.setTitle === render.setTitle &&
    (session.title || render.fallback) === render.title
  );
}

function titleDisplayIsExact(presentation: TitleDisplayPresentation) {
  const { render, document, button, title, icon, snapshot } = presentation;
  const ButtonElement = document.defaultView?.HTMLButtonElement;
  const SpanElement = document.defaultView?.HTMLSpanElement;
  const SvgElement = document.defaultView?.SVGSVGElement;
  if (
    !ButtonElement ||
    !SpanElement ||
    !(button instanceof ButtonElement) ||
    !(title instanceof SpanElement) ||
    !button.isConnected ||
    button.ownerDocument !== document ||
    title.ownerDocument !== document ||
    button.tagName !== "BUTTON" ||
    button.type !== "button" ||
    button.disabled ||
    button.getAttribute("aria-disabled") !== null ||
    button.className !== render.buttonClassName ||
    button.title !== render.buttonTitle ||
    button.dataset.testid !== "title" ||
    title.parentElement !== button ||
    title.tagName !== "SPAN" ||
    title.className !== render.titleClassName ||
    title.textContent !== render.title ||
    button.children.length !== (render.canEdit && !render.compact ? 2 : 1) ||
    button.children.item(0) !== title
  ) {
    return false;
  }
  if (render.canEdit && !render.compact) {
    if (
      !SvgElement ||
      !icon ||
      !(icon instanceof SvgElement) ||
      icon.ownerDocument !== document ||
      icon.parentElement !== button ||
      button.children.item(1) !== icon ||
      icon.tagName.toLowerCase() !== "svg" ||
      render.iconClassName.split(" ").some((token) => !icon.classList.contains(token))
    ) {
      return false;
    }
  } else if (icon !== null) {
    return false;
  }
  return titleDomMatches(snapshot);
}

function titleInputIsExact(presentation: TitleInputPresentation, changing = false) {
  const { render, document, input, snapshot } = presentation;
  const InputElement = document.defaultView?.HTMLInputElement;
  return Boolean(
    InputElement &&
    input instanceof InputElement &&
    input.isConnected &&
    input.ownerDocument === document &&
    input.tagName === "INPUT" &&
    input.type === "text" &&
    !input.disabled &&
    !input.readOnly &&
    input.getAttribute("aria-disabled") === null &&
    input.className === render.inputClassName &&
    input.getAttribute("aria-label") === render.inputLabel &&
    input.dataset.testid === "title-input" &&
    input.childNodes.length === 0 &&
    (changing || input.value === render.draft) &&
    titleDomMatches(snapshot)
  );
}

export function TitleEditor({ session, fallback, compact }: { session: CollabSession; fallback: string; compact?: boolean }) {
  const { title, canEdit } = useSessionValue(
    session,
    (current) => ({ title: current.title || fallback, canEdit: current.canWrite }),
    jsonEqual,
  );
  const role = session.role;
  const [mount] = useState(() => Symbol("title editor"));
  const [authority] = useState(() => new TitlePublicationAuthority());
  const [, setPublicationRevision] = useState(0);
  const [storedEdit, setStoredEdit] = useState<TitleEditState | null>(null);
  let edit = storedEdit;
  if (edit && (edit.session !== session || !canEdit)) {
    edit = null;
    setStoredEdit(null);
  }
  const editing = edit !== null;
  const draft = edit?.draft ?? title;
  const identity = Object.freeze({});
  const runtimeState: {
    layoutPassed: boolean;
    current: TitlePublicationRuntime | null;
    last: TitlePublicationRuntime | null;
    successorRequested: boolean;
  } = {
    layoutPassed: false,
    current: null,
    last: null,
    successorRequested: false,
  };
  const requestSuccessor = () => {
    setPublicationRevision((revision) => revision + 1);
  };
  const retireForElementChange = (
    element: Element | null,
    previous: Element | null,
    last: Element | null,
  ) => {
    if (element === null || (runtimeState.layoutPassed && element !== previous) || (element && last && element !== last)) {
      runtimeState.current?.retireForElement();
    }
    const runtime = runtimeState.last;
    if (
      !runtimeState.successorRequested &&
      runtime?.isExactElementReplay() &&
      authority.acceptsSuccessorOf(runtime.presentation) &&
      titleRenderIsCurrent(render) &&
      titleOwnersMatch(runtime.presentation)
    ) {
      runtimeState.successorRequested = true;
      requestSuccessor();
    }
  };
  const buttonOwner = new TitleElementOwner<HTMLButtonElement>(retireForElementChange);
  const titleOwner = new TitleElementOwner<HTMLSpanElement>(retireForElementChange);
  const iconOwner = new TitleElementOwner<SVGSVGElement>(retireForElementChange);
  const inputOwner = new TitleElementOwner<HTMLInputElement>(retireForElementChange);
  const buttonClassName = cn("group flex min-w-0 items-center gap-2 rounded-lg px-2 py-1 text-left", canEdit && "hover:bg-surface-3");
  const buttonTitle = canEdit ? "Rename" : title;
  const titleClassName = cn("doc-title truncate font-semibold leading-8 text-ink", compact ? "text-lg" : "text-lg md:text-[22px]");
  const iconClassName = "shrink-0 text-ink-4 opacity-0 transition-opacity group-hover:opacity-100 max-md:hidden";
  const inputClassName = "h-9 min-w-[12rem] max-w-[28rem] rounded-lg border border-accent bg-surface px-2 text-[22px] font-semibold text-ink outline-none ring-2 ring-accent/20";
  const inputLabel = "Document title";
  const render = Object.freeze<TitleRender>({
    identity,
    mount,
    session,
    fallback,
    title,
    role,
    canEdit,
    compact,
    editing,
    draft,
    generation: edit?.generation ?? null,
    setTitle: session.setTitle,
    buttonClassName,
    buttonTitle,
    titleClassName,
    iconClassName,
    inputClassName,
    inputLabel,
  });

  function titleOwnersMatch(presentation: TitlePresentation) {
    if (presentation.render !== render) return false;
    if (presentation.kind === "input") {
      return inputOwner.element() === presentation.input && titleInputIsExact(presentation);
    }
    return (
      buttonOwner.element() === presentation.button &&
      titleOwner.element() === presentation.title &&
      iconOwner.element() === presentation.icon &&
      titleDisplayIsExact(presentation)
    );
  }

  function createRuntime(presentation: TitlePresentation): TitlePublicationRuntime {
    type Retirement = "element" | "layout";
    let retired = false;
    let retirement: Retirement | null = null;
    const matches = () => titleOwnersMatch(presentation);
    const retire = (reason: Retirement) => {
      if (retired) return;
      retired = true;
      retirement = reason;
      authority.retire(presentation);
      if (runtimeState.current?.presentation === presentation) runtimeState.current = null;
    };
    return Object.freeze({
      presentation,
      retireForElement: () => retire("element"),
      retireForLayout: () => retire("layout"),
      isExactElementReplay: () => retired && retirement === "element" && matches(),
      isExactLayoutReplay: () => retired && retirement === "layout" && matches(),
    });
  }

  useEffect(() => {
    document.title = `${title} · Markdoc`;
  }, [title]);

  useLayoutEffect(() => {
    runtimeState.layoutPassed = true;
    if (
      (runtimeState.last && !runtimeState.last.isExactLayoutReplay()) ||
      !titleRenderIsCurrent(render)
    ) {
      return;
    }
    let presentation: TitlePresentation;
    if (render.editing) {
      const input = inputOwner.element();
      if (!input) return;
      presentation = Object.freeze({
        kind: "input",
        render,
        document: input.ownerDocument,
        input,
        snapshot: snapshotTitleDom(input),
      });
      if (!titleInputIsExact(presentation)) return;
    } else {
      const button = buttonOwner.element();
      const titleElement = titleOwner.element();
      const icon = iconOwner.element();
      if (!button || !titleElement || (render.canEdit && !render.compact && !icon)) return;
      const snapshot = snapshotTitleDom(button);
      const targets = new WeakSet<Node>();
      collectTitleTargets(snapshot, targets);
      presentation = Object.freeze({
        kind: "display",
        render,
        document: button.ownerDocument,
        button,
        title: titleElement,
        icon,
        snapshot,
        targets,
      });
      if (!titleDisplayIsExact(presentation)) return;
    }
    const runtime = createRuntime(presentation);
    const previous = authority.active();
    if (previous && previous !== presentation) authority.retire(previous);
    runtimeState.current = runtime;
    runtimeState.last = runtime;
    authority.publish(presentation);
    if (
      presentation.kind === "input" &&
      presentation.render.generation &&
      authority.active() === presentation &&
      titleInputIsExact(presentation) &&
      authority.claimFocus(presentation.render.generation, presentation.input)
    ) {
      presentation.input.focus();
      if (
        authority.active() === presentation &&
        titleInputIsExact(presentation) &&
        presentation.document.activeElement === presentation.input
      ) {
        presentation.input.select();
      }
    }
    return runtime.retireForLayout;
  });

  const currentPresentation = (changing = false) => {
    const presentation = authority.active();
    if (
      !presentation ||
      presentation.render !== render ||
      presentation.render.identity !== identity ||
      presentation.render.mount !== mount ||
      presentation.render.session !== session ||
      !titleRenderIsCurrent(render)
    ) {
      return null;
    }
    return presentation.kind === "input"
      ? (titleInputIsExact(presentation, changing) ? presentation : null)
      : (titleDisplayIsExact(presentation) ? presentation : null);
  };

  const changePresentation = (event: React.ChangeEvent<HTMLInputElement>) => {
    const input = inputOwner.element();
    if (
      !input ||
      (event.type !== "input" && event.type !== "change") ||
      event.currentTarget !== input ||
      event.target !== input ||
      event.defaultPrevented
    ) {
      return null;
    }
    const ownerWindow = input.ownerDocument.defaultView;
    const nativeEvent = event.nativeEvent;
    if (
      !ownerWindow ||
      !(nativeEvent instanceof ownerWindow.Event) ||
      nativeEvent instanceof ownerWindow.MouseEvent ||
      nativeEvent instanceof ownerWindow.KeyboardEvent ||
      nativeEvent instanceof ownerWindow.FocusEvent ||
      (nativeEvent.type !== "input" && nativeEvent.type !== "change") ||
      nativeEvent.target !== input ||
      nativeEvent.defaultPrevented
    ) {
      return null;
    }
    const presentation = currentPresentation(true);
    if (
      !presentation ||
      presentation.kind !== "input" ||
      presentation.input !== input ||
      !authority.claim(presentation, nativeEvent)
    ) {
      return null;
    }
    return presentation;
  };

  const blurPresentation = (event: React.FocusEvent<HTMLInputElement>) => {
    const input = inputOwner.element();
    if (
      !input ||
      event.type !== "blur" ||
      event.currentTarget !== input ||
      event.target !== input ||
      event.defaultPrevented
    ) {
      return null;
    }
    const ownerWindow = input.ownerDocument.defaultView;
    const nativeEvent = event.nativeEvent;
    if (
      !ownerWindow ||
      !(nativeEvent instanceof ownerWindow.FocusEvent) ||
      (nativeEvent.type !== "blur" && nativeEvent.type !== "focusout") ||
      nativeEvent.target !== input ||
      nativeEvent.defaultPrevented
    ) {
      return null;
    }
    const presentation = currentPresentation();
    if (
      !presentation ||
      presentation.kind !== "input" ||
      presentation.input !== input ||
      !authority.claim(presentation, nativeEvent, true)
    ) {
      return null;
    }
    return presentation;
  };

  const keyboardPresentation = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Enter" && event.key !== "Escape") return null;
    const input = inputOwner.element();
    if (
      !input ||
      event.type !== "keydown" ||
      event.currentTarget !== input ||
      event.target !== input ||
      event.defaultPrevented ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey ||
      event.repeat
    ) {
      return null;
    }
    const ownerWindow = input.ownerDocument.defaultView;
    const nativeEvent = event.nativeEvent;
    if (
      !ownerWindow ||
      !(nativeEvent instanceof ownerWindow.KeyboardEvent) ||
      nativeEvent.type !== "keydown" ||
      nativeEvent.target !== input ||
      nativeEvent.key !== event.key ||
      nativeEvent.defaultPrevented ||
      nativeEvent.altKey ||
      nativeEvent.ctrlKey ||
      nativeEvent.metaKey ||
      nativeEvent.shiftKey ||
      nativeEvent.repeat ||
      nativeEvent.isComposing
    ) {
      return null;
    }
    const presentation = currentPresentation();
    if (
      !presentation ||
      presentation.kind !== "input" ||
      presentation.input !== input ||
      !authority.claim(presentation, nativeEvent, true)
    ) {
      return null;
    }
    return presentation;
  };

  const finish = (presentation: TitleInputPresentation, commit: boolean) => {
    const generation = presentation.render.generation;
    if (!generation) return;
    if (commit) {
      const next = presentation.render.draft.trim();
      if (next && next !== presentation.render.title) {
        presentation.render.setTitle.call(presentation.render.session, next);
      }
    }
    setStoredEdit((current) => current?.generation === generation ? null : current);
  };

  if (editing) {
    return (
      <input
        ref={inputOwner.capture}
        value={draft}
        onChange={(event) => {
          const presentation = changePresentation(event);
          const generation = presentation?.render.generation;
          if (!presentation || !generation) return;
          const nextDraft = presentation.input.value;
          setStoredEdit((current) => current?.generation === generation
            ? Object.freeze({ ...current, draft: nextDraft })
            : current);
        }}
        onBlur={(event) => {
          const presentation = blurPresentation(event);
          if (presentation) finish(presentation, true);
        }}
        onKeyDown={(event) => {
          const presentation = keyboardPresentation(event);
          if (!presentation) return;
          finish(presentation, event.key === "Enter");
        }}
        className={inputClassName}
        aria-label={inputLabel}
        data-testid="title-input"
      />
    );
  }
  return (
    <button
      ref={buttonOwner.capture}
      type="button"
      onClick={(event) => {
        const button = buttonOwner.element();
        if (
          !button ||
          event.type !== "click" ||
          event.currentTarget !== button ||
          event.defaultPrevented
        ) {
          return;
        }
        const ownerWindow = button.ownerDocument.defaultView;
        const nativeEvent = event.nativeEvent;
        const target = event.target;
        if (
          !ownerWindow ||
          !(nativeEvent instanceof ownerWindow.MouseEvent) ||
          nativeEvent.type !== "click" ||
          nativeEvent.button !== 0 ||
          !(target instanceof ownerWindow.Node) ||
          nativeEvent.target !== target ||
          nativeEvent.defaultPrevented
        ) {
          return;
        }
        const presentation = currentPresentation();
        if (
          !presentation ||
          presentation.kind !== "display" ||
          presentation.button !== button ||
          !presentation.render.canEdit ||
          button.disabled ||
          button.getAttribute("aria-disabled") !== null ||
          !presentation.targets.has(target) ||
          !button.contains(target) ||
          !authority.claim(presentation, nativeEvent)
        ) {
          return;
        }
        const nextEdit = Object.freeze<TitleEditState>({
          generation: Object.freeze({}),
          session: presentation.render.session,
          draft: presentation.render.title,
        });
        setStoredEdit((current) => current === null ? nextEdit : current);
      }}
      className={buttonClassName}
      title={buttonTitle}
      data-testid="title"
    >
      {/* Phones render `compact` only after hydration; the `max-md:` rules make the server markup match its size and
          set of controls so the header does not shift when the breakpoint flips (#1470). */}
      <span ref={titleOwner.capture} className={titleClassName}>{title}</span>
      {canEdit && !compact && <Pencil ref={iconOwner.capture} size={15} className={iconClassName} />}
    </button>
  );
}

/**
 * Personal star for the open document. Stars live on the dashboard, so the header asks the API for
 * the current state once the open has settled (the editor does not need it to become editable) and
 * stays hidden for anonymous visitors (who cannot star).
 */
type HeaderStarError = {
  action: "load" | "star" | "unstar";
  message: string;
};

type HeaderStarAuthority = {
  mount: symbol;
  docId: string;
};

type HeaderStarOperation = {
  authority: HeaderStarAuthority;
  operation: number;
  retry: boolean;
} & (
  | { action: "load"; confirmed: null }
  | { action: "star" | "unstar"; confirmed: boolean }
);

interface HeaderStarState {
  docId: string;
  confirmed: boolean | null;
  starred: boolean | null;
  pending: "load" | "toggle" | null;
  error: HeaderStarError | null;
}

const emptyHeaderStarState = (docId: string): HeaderStarState => ({
  docId,
  confirmed: null,
  starred: null,
  pending: null,
  error: null,
});

export function HeaderStar({ docId, ready }: { docId: string; ready: boolean }) {
  const [state, setState] = useState<HeaderStarState>(() => emptyHeaderStarState(docId));
  const [mount] = useState(() => Symbol("header-star"));
  const authority = useRef<HeaderStarAuthority | null>(null);
  const owner = useRef<HeaderStarOperation | null>(null);
  const nextOperation = useRef(0);

  const owns = useCallback(
    (operation: HeaderStarOperation) => authority.current === operation.authority && owner.current === operation,
    [],
  );

  useLayoutEffect(() => {
    const currentAuthority: HeaderStarAuthority | null = ready ? { mount, docId } : null;
    authority.current = currentAuthority;
    owner.current = null;
    setState((current) => {
      if (current.docId === docId && current.confirmed === null && current.starred === null && current.pending === null && current.error === null) return current;
      return emptyHeaderStarState(docId);
    });
    return () => {
      if (authority.current === currentAuthority) authority.current = null;
      if (owner.current?.authority === currentAuthority) owner.current = null;
    };
  }, [docId, mount, ready]);

  const start = useCallback(
    (request: { action: "load"; confirmed: null; retry: boolean } | { action: "star" | "unstar"; confirmed: boolean; retry: boolean }) => {
      const currentAuthority = authority.current;
      if (!ready || !currentAuthority || currentAuthority.mount !== mount || currentAuthority.docId !== docId || owner.current) return;
      const operation: HeaderStarOperation = {
        authority: currentAuthority,
        operation: ++nextOperation.current,
        ...request,
      };
      owner.current = operation;

      if (operation.action === "load") {
        setState((previous) => ({
          docId: operation.authority.docId,
          confirmed: null,
          starred: null,
          pending: "load",
          error: operation.retry && previous.docId === operation.authority.docId && previous.error?.action === "load" ? previous.error : null,
        }));
      } else {
        setState({
          docId: operation.authority.docId,
          confirmed: operation.confirmed,
          starred: operation.action === "star",
          pending: "toggle",
          error: null,
        });
      }

      void (async () => {
        try {
          const result = operation.action === "load"
            ? await api.documents.starred(operation.authority.docId)
            : operation.action === "star"
              ? await api.documents.star(operation.authority.docId)
              : await api.documents.unstar(operation.authority.docId);
          if (!owns(operation)) return;
          setState({
            docId: operation.authority.docId,
            confirmed: result.starred,
            starred: result.starred,
            pending: null,
            error: null,
          });
        } catch (error: unknown) {
          if (!owns(operation)) return;
          setState({
            docId: operation.authority.docId,
            confirmed: operation.confirmed,
            starred: operation.confirmed,
            pending: null,
            error: {
              action: operation.action,
              message: apiErrorText(
                error,
                operation.action === "load"
                  ? "Could not load star status"
                  : operation.action === "star"
                    ? "Could not star document"
                    : "Could not unstar document",
              ),
            },
          });
        } finally {
          if (authority.current === operation.authority && owner.current === operation) owner.current = null;
        }
      })();
    },
    [docId, mount, owns, ready],
  );

  useEffect(() => {
    if (ready) start({ action: "load", confirmed: null, retry: false });
  }, [ready, start]);

  if (!ready) return null;
  const current = state.docId === docId ? state : emptyHeaderStarState(docId);
  if (current.starred === null) {
    if (current.error?.action !== "load") return null;
    const retrying = current.pending === "load";
    return (
      <>
        <span className="sr-only" role="alert" aria-atomic="true">
          {current.error.message}. Retry star status.
        </span>
        <Tip label={retrying ? "Retrying star status…" : `${current.error.message}. Retry.`}>
          <button
            type="button"
            onClick={() => start({ action: "load", confirmed: null, retry: true })}
            disabled={retrying}
            className="icon-btn h-8 w-8 shrink-0 text-danger max-md:hidden"
            aria-label={retrying ? "Retrying star status" : "Retry star status"}
            aria-busy={retrying || undefined}
            data-testid="header-star"
            data-state={retrying ? "retrying" : "error"}
          >
            <RefreshCw size={17} className={retrying ? "animate-spin" : undefined} />
          </button>
        </Tip>
      </>
    );
  }

  const toggle = () => {
    if (current.confirmed === null) return;
    start({
      action: current.starred ? "unstar" : "star",
      confirmed: current.confirmed,
      retry: retryAction !== null,
    });
  };

  const retryAction = current.error?.action === "star" || current.error?.action === "unstar" ? current.error.action : null;
  const label = current.pending === "toggle"
    ? current.starred ? "Starring document…" : "Unstarring document…"
    : retryAction
      ? retryAction === "star" ? "Retry star document" : "Retry unstar document"
      : current.starred ? "Unstar document" : "Star document";

  return (
    <>
      {current.error && (
        <span className="sr-only" role="alert" aria-atomic="true">
          {current.error.message}. {label}.
        </span>
      )}
      <Tip label={label}>
        <button
          type="button"
          onClick={toggle}
          disabled={current.pending === "toggle"}
          className={cn("icon-btn h-8 w-8 shrink-0 max-md:hidden", current.error ? "text-danger" : current.starred ? "text-amber-500" : "text-ink-4")}
          aria-pressed={current.starred}
          aria-label={label}
          aria-busy={current.pending === "toggle" || undefined}
          data-testid="header-star"
          data-starred={current.starred}
          data-state={current.pending ?? (current.error ? "error" : "ready")}
        >
          <Star size={17} fill={current.starred ? "currentColor" : "none"} />
        </button>
      </Tip>
    </>
  );
}

/** Bot avatar for agents in the presence list (same badge style as agent comments in the comments panel). */
function AgentAvatar({ name, color, size }: { name: string; color: string; size: number }) {
  return (
    <span
      className="inline-flex shrink-0 items-center justify-center rounded-full bg-violet-100 text-violet-700 ring-2 ring-surface dark:bg-violet-950 dark:text-violet-300"
      style={{ width: size, height: size, boxShadow: `0 0 0 2px ${color}` }}
      aria-label={`${name} (agent)`}
      role="img"
    >
      <Bot size={Math.round(size * 0.55)} aria-hidden="true" />
    </span>
  );
}

/** How long an optimistically cancelled request stays hidden before it may come back (the server refused). */
const CANCEL_GRACE_MS = 8_000;

export interface PresenceStackProps {
  session: CollabSession;
  onJump?: (user: PresenceUser) => void;
  /** Cancel an open request from the popover's Requests section; without it the rows show but not Cancel (embed / read-only). */
  onCancelRequest?: (requestId: string) => void;
  /** Opens the "Connect an AI agent" dialog; the popover offers it while no agent is present. */
  onConnectAgent?: () => void;
}

interface PresenceVisit {
  session: CollabSession;
  onJump: PresenceStackProps["onJump"];
  onCancelRequest: PresenceStackProps["onCancelRequest"];
  onConnectAgent: PresenceStackProps["onConnectAgent"];
}

interface PresenceVisitState {
  visit: PresenceVisit;
  open: boolean;
  cancelling: ReadonlySet<string>;
  now: number;
}

interface CancellationGraceOwner {
  visit: PresenceVisit;
  requestId: string;
  timer: ReturnType<typeof setTimeout> | null;
}

interface FreshnessOwner {
  visit: PresenceVisit;
  timer: ReturnType<typeof setInterval> | null;
}

interface PendingRequestsOwner {
  visit: PresenceVisit;
  ids: ReadonlySet<string>;
}

/**
 * Everyone in the document, agents included: agents are bot avatars with a spinner badge while they work,
 * and the popover carries their status, the open requests and the way to put an agent here (task #981).
 */
export function PresenceStack({ session, onJump, onCancelRequest, onConnectAgent }: PresenceStackProps) {
  const visit = useMemo<PresenceVisit>(
    () => ({ session, onJump, onCancelRequest, onConnectAgent }),
    [session, onJump, onCancelRequest, onConnectAgent],
  );
  const users = useSessionValue(session, (s) => s.presence(), jsonEqual);
  const followUserId = useSessionValue(session, (s) => s.followUserId);
  const requests = useAgentRequests(session);
  const activity = useAgentActivity(session);
  const initialState = useMemo<PresenceVisitState>(
    () => ({ visit, open: false, cancelling: new Set(), now: 0 }),
    [visit],
  );
  const [storedState, setStoredState] = useState<PresenceVisitState>(
    () => ({ ...initialState, now: Date.now() }),
  );
  const state = storedState.visit === visit ? storedState : initialState;
  const activeVisit = useRef<PresenceVisit | null>(null);
  const cancellationGrace = useRef(new Map<string, CancellationGraceOwner>());
  const freshnessOwner = useRef<FreshnessOwner | null>(null);
  const pendingRequestsOwner = useRef<PendingRequestsOwner | null>(null);
  const ownsVisit = useCallback((owner: PresenceVisit) => activeVisit.current === owner, []);
  const retireVisit = useCallback((owner: PresenceVisit) => {
    if (activeVisit.current !== owner) return;
    activeVisit.current = null;
    if (pendingRequestsOwner.current?.visit === owner) pendingRequestsOwner.current = null;
    for (const [requestId, grace] of cancellationGrace.current) {
      if (grace.visit !== owner) continue;
      if (grace.timer !== null) clearTimeout(grace.timer);
      if (cancellationGrace.current.get(requestId) === grace) cancellationGrace.current.delete(requestId);
    }
    const freshness = freshnessOwner.current;
    if (freshness?.visit === owner) {
      freshnessOwner.current = null;
      if (freshness.timer !== null) clearInterval(freshness.timer);
    }
  }, []);
  const updateState = useCallback(
    (update: (current: PresenceVisitState) => PresenceVisitState) => {
      if (!ownsVisit(visit)) return;
      setStoredState((current) => {
        if (!ownsVisit(visit) || current.visit !== visit) return current;
        return update(current);
      });
    },
    [ownsVisit, visit],
  );
  const finishCancellation = useCallback(
    (grace: CancellationGraceOwner) => {
      if (!ownsVisit(grace.visit) || cancellationGrace.current.get(grace.requestId) !== grace) return;
      cancellationGrace.current.delete(grace.requestId);
      if (grace.timer !== null) {
        clearTimeout(grace.timer);
        grace.timer = null;
      }
      setStoredState((current) => {
        if (!ownsVisit(grace.visit) || current.visit !== grace.visit || !current.cancelling.has(grace.requestId)) return current;
        const cancelling = new Set(current.cancelling);
        cancelling.delete(grace.requestId);
        return { ...current, cancelling };
      });
    },
    [ownsVisit],
  );
  useLayoutEffect(() => {
    activeVisit.current = visit;
    setStoredState((current) => (current.visit === visit ? current : { ...initialState, now: Date.now() }));
    return () => retireVisit(visit);
  }, [initialState, retireVisit, visit]);

  // Cancel is optimistic: the row and the placeholder go at once; the mirror catches up a moment later. If the
  // server refuses (editor-shell toasts the error) the request is still pending after the grace period and returns.
  const pending = pendingRequests(requests).filter((r) => !state.cancelling.has(r.id));
  useLayoutEffect(() => {
    if (!ownsVisit(visit)) return;
    const owner: PendingRequestsOwner = {
      visit,
      ids: new Set(pendingRequests(requests).map((request) => request.id)),
    };
    pendingRequestsOwner.current = owner;
    for (const grace of cancellationGrace.current.values()) {
      if (grace.visit === visit && !owner.ids.has(grace.requestId)) finishCancellation(grace);
    }
    return () => {
      if (pendingRequestsOwner.current === owner) pendingRequestsOwner.current = null;
    };
  }, [finishCancellation, ownsVisit, requests, visit]);
  const cancelRequest = (id: string) => {
    const currentPending = pendingRequestsOwner.current;
    if (!ownsVisit(visit) || !visit.onCancelRequest || currentPending?.visit !== visit || !currentPending.ids.has(id)) return;
    const existing = cancellationGrace.current.get(id);
    if (existing?.visit === visit) return;
    const grace: CancellationGraceOwner = { visit, requestId: id, timer: null };
    cancellationGrace.current.set(id, grace);
    grace.timer = setTimeout(() => finishCancellation(grace), CANCEL_GRACE_MS);
    updateState((current) => {
      if (current.cancelling.has(id)) return current;
      const cancelling = new Set(current.cancelling);
      cancelling.add(id);
      return { ...current, cancelling };
    });
    visit.onCancelRequest(id);
  };
  // Idle dimming is time-based; re-evaluate it every 15 s while the stack is mounted. A fresh agent
  // activity ("proposed changes · 12 s ago") ticks every 5 s for the 45 s it shows.
  const now = state.now;
  const activityFresh = isRecentActivity(activity, now);
  useLayoutEffect(() => {
    if (!ownsVisit(visit)) return;
    const owner: FreshnessOwner = { visit, timer: null };
    freshnessOwner.current = owner;
    const currentNow = Date.now();
    const tick = () => {
      if (!ownsVisit(visit) || freshnessOwner.current !== owner) return;
      updateState((current) => {
        const nextNow = Date.now();
        return current.now === nextNow ? current : { ...current, now: nextNow };
      });
    };
    tick();
    owner.timer = setInterval(tick, isRecentActivity(activity, currentNow) ? 5_000 : 15_000);
    return () => {
      if (freshnessOwner.current !== owner) return;
      freshnessOwner.current = null;
      if (owner.timer !== null) clearInterval(owner.timer);
    };
  }, [activity, activityFresh, ownsVisit, updateState, visit]);
  const shown = users.slice(0, 3);
  const extra = users.length - shown.length;
  const others = users.filter((u) => !u.isLocal);
  const agents = users.filter((u) => u.isAgent);
  const busy = busyAgentNames(requests, activity, now);
  // Someone else's agent reads "Burke's Copilot CLI" everywhere (docs/agents.md, UI conventions); your own keeps its plain name.
  const viewer = session.user.login ?? null;
  const ownerNameOf = (login: string) => presenceNameOf(users, login);
  const agentName = (u: PresenceUser) => presenceAgentName(u, viewer);
  // No agent in presence but requests pending: the stack shows a dashed placeholder. It reads "waiting" until an
  // agent claims one (agents may claim over REST/MCP before they ever announce themselves), then "working".
  const noAgent = agents.length === 0 && pending.length > 0;
  const unseenWorker = noAgent ? pendingWorker(pending, viewer, ownerNameOf) : null;
  const waiting = noAgent && !unseenWorker;
  const nameOf = (userId: string) => users.find((u) => !u.isAgent && u.id === userId)?.name ?? null;
  const jump = (u: PresenceUser) => {
    if (!ownsVisit(visit) || u.cursor === null) return;
    visit.onJump?.(u);
    updateState((current) => (current.open ? { ...current, open: false } : current));
  };
  const follow = (u: PresenceUser) => {
    if (!ownsVisit(visit)) return;
    visit.session.follow(followUserId === u.id ? null : u.id);
    updateState((current) => (current.open ? { ...current, open: false } : current));
  };
  const connectAgent = () => {
    if (!ownsVisit(visit)) return;
    updateState((current) => (current.open ? { ...current, open: false } : current));
    visit.onConnectAgent?.();
  };
  const changeOpen = (open: boolean) => {
    updateState((current) => (current.open === open ? current : { ...current, open }));
  };
  const roleLabel: Record<string, string> = { owner: "Owner", editor: "Editor", commenter: "Commenter", viewer: "Viewer" };
  const label = (u: PresenceUser) => (u.isLocal ? `${u.name} (you)` : u.isAgent ? `${agentName(u)} (agent${u.status ? `: ${u.status}` : ""})` : u.name);
  return (
    <Popover open={state.open} onOpenChange={changeOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="flex items-center -space-x-2 rounded-full focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
          data-testid="presence"
          aria-label={`${users.length} ${users.length === 1 ? "person" : "people"} here: ${users.map(label).join(", ")}${waiting ? `; ${waitingLabel(pending.length)}` : ""}`}
        >
          {shown.map((u) => (
            <Tip key={u.id} label={u.isAgent && busy.has(u.name) ? `${label(u)} — working` : label(u)}>
              <span
                className={cn("relative inline-flex transition-opacity", !u.isLocal && isIdle(u.idleSince, now) && "opacity-40")}
                data-testid="presence-avatar"
                data-user-id={u.id}
                data-idle={!u.isLocal && isIdle(u.idleSince, now) ? "" : undefined}
                data-agent={u.isAgent ? "" : undefined}
                data-busy={u.isAgent && busy.has(u.name) ? "" : undefined}
              >
                {u.isAgent ? <AgentAvatar name={u.name} color={u.color} size={36} /> : <Avatar name={u.name} src={u.avatar} color={u.color} size={36} />}
                {u.isAgent && busy.has(u.name) && <AgentBusyBadge name={agentName(u)} />}
              </span>
            </Tip>
          ))}
          {extra > 0 && (
            <Tip label={users.slice(3).map((u) => (u.isAgent ? agentName(u) : u.name)).join(", ")}>
              <span className="avatar text-[13px]">+{extra}</span>
            </Tip>
          )}
          {noAgent && (
            <Tip label={unseenWorker ? `${unseenWorker} (agent) — working` : waitingLabel(pending.length)}>
              <span className="relative inline-flex">
                <WaitingPlaceholder count={pending.length} workingBy={unseenWorker} size={36} />
              </span>
            </Tip>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-2" data-testid="presence-popover">
        <div className="px-2 pb-1.5 pt-1 text-[11px] font-semibold uppercase tracking-wide text-ink-3">
          {users.length === 1 ? "Only you are here" : `${users.length} people here`}
        </div>
        <ul className="flex flex-col gap-0.5">
          {users.map((u) => {
            const idle = !u.isLocal && isIdle(u.idleSince, now);
            const following = followUserId === u.id;
            const working = u.isAgent && busy.has(u.name);
            const humanLocation = u.isAgent
              ? undefined
              : `${idle ? "Idle · " : ""}${u.cursor === null ? "no cursor" : u.section ? `in ‘${u.section}’` : "at the top"}`;
            return (
              <li key={u.id} className={cn("flex items-center gap-2.5 rounded-lg px-2 py-1.5", idle && !working && "opacity-60")} data-testid="presence-row" data-user-id={u.id} data-agent={u.isAgent ? "" : undefined}>
                <span className="relative inline-flex shrink-0">
                  {u.isAgent ? <AgentAvatar name={u.name} color={u.color} size={28} /> : <Avatar name={u.name} src={u.avatar} color={u.color} size={28} />}
                  {working && <AgentBusyBadge name={agentName(u)} />}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5 text-sm font-medium text-ink">
                    <span className="truncate" title={u.isLocal ? `${u.name} (you)` : u.isAgent ? agentName(u) : u.name}>{u.isLocal ? `${u.name} (you)` : u.isAgent ? agentName(u) : u.name}</span>
                    {u.isAgent && <span className="rounded-md bg-violet-100 px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide text-violet-700 dark:bg-violet-950 dark:text-violet-300">Agent</span>}
                    {u.role && <span className="rounded-md bg-surface-2 px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide text-ink-3">{roleLabel[u.role] ?? u.role}</span>}
                  </div>
                  <div className="truncate text-xs text-ink-3" data-testid="presence-section" title={humanLocation}>
                    {u.isAgent ? (
                      <>
                        <span data-testid="presence-status">{idle && !working ? "Idle" : u.status ?? "working"}</span>
                        {activityFresh && activity.name === u.name && (
                          <>
                            {" · "}
                            <PresenceActivity activity={activity} now={now} />
                          </>
                        )}
                      </>
                    ) : (
                      humanLocation
                    )}
                  </div>
                </div>
                {!u.isLocal && !u.isAgent && (
                  <div className="flex shrink-0 items-center gap-1">
                    <button type="button" className="btn btn-sm btn-outline h-7 px-2 text-xs" onClick={() => jump(u)} disabled={u.cursor === null} data-testid="presence-jump">
                      Jump
                    </button>
                    <button
                      type="button"
                      className={cn("btn btn-sm h-7 px-2 text-xs", following ? "btn-primary" : "btn-outline")}
                      onClick={() => follow(u)}
                      aria-pressed={following}
                      data-testid="presence-follow"
                    >
                      {following ? "Following" : "Follow"}
                    </button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
        {pending.length > 0 && <PresenceRequests session={session} pending={pending} nameOf={nameOf} ownerNameOf={ownerNameOf} onCancel={onCancelRequest ? cancelRequest : undefined} />}
        {waiting && (
          <p className="px-2 pb-1 pt-1.5 text-xs text-ink-3" data-testid="presence-waiting-note">
            {waitingLabel(pending.length)} — none is sitting in this document.
          </p>
        )}
        {agents.length === 0 && onConnectAgent && (
          <div className={cn("px-1 pb-1", waiting ? "pt-1" : "pt-1.5")}>
            <ConnectAgentButton onClick={connectAgent} primary={waiting} />
          </div>
        )}
        {others.length === 0 && pending.length === 0 && <div className="px-2 pb-1 pt-1.5 text-xs text-ink-3">Share the document to work on it together.</div>}
      </PopoverContent>
    </Popover>
  );
}

interface ModeSwitcherDomSnapshot {
  readonly node: Node;
  readonly nodeValue: string | null;
  readonly attributes: readonly (readonly [string, string])[] | null;
  readonly children: readonly ModeSwitcherDomSnapshot[];
}

interface ModeSwitcherPlacementSnapshot {
  readonly node: Node;
  readonly parent: Node | null;
  readonly previousSibling: Node | null;
  readonly nextSibling: Node | null;
}

const MODE_SWITCHER_DYNAMIC_ATTRIBUTES = new Set([
  "data-align",
  "data-highlighted",
  "data-radix-popper-align",
  "data-radix-popper-side",
  "data-side",
  "style",
  "tabindex",
]);

function snapshotModeSwitcherDom(node: Node): ModeSwitcherDomSnapshot {
  const ElementConstructor = node.ownerDocument?.defaultView?.Element;
  const attributes = ElementConstructor && node instanceof ElementConstructor
    ? Object.freeze(
        Array.from(node.attributes)
          .filter((attribute) => !MODE_SWITCHER_DYNAMIC_ATTRIBUTES.has(attribute.name))
          .map((attribute) => Object.freeze([attribute.name, attribute.value] as const)),
      )
    : null;
  return Object.freeze({
    node,
    nodeValue: node.nodeValue,
    attributes,
    children: Object.freeze(Array.from(node.childNodes, snapshotModeSwitcherDom)),
  });
}

function modeSwitcherDomSnapshotMatches(snapshot: ModeSwitcherDomSnapshot): boolean {
  const { node, attributes, children } = snapshot;
  if (node.nodeValue !== snapshot.nodeValue || node.childNodes.length !== children.length) return false;
  if (attributes) {
    const ElementConstructor = node.ownerDocument?.defaultView?.Element;
    if (!ElementConstructor || !(node instanceof ElementConstructor)) return false;
    const current = Array.from(node.attributes).filter(
      (attribute) => !MODE_SWITCHER_DYNAMIC_ATTRIBUTES.has(attribute.name),
    );
    if (current.length !== attributes.length) return false;
    for (let index = 0; index < attributes.length; index++) {
      const expected = attributes[index]!;
      const actual = current[index];
      if (!actual || actual.name !== expected[0] || actual.value !== expected[1]) return false;
    }
  }
  for (let index = 0; index < children.length; index++) {
    if (
      node.childNodes.item(index) !== children[index]!.node
      || !modeSwitcherDomSnapshotMatches(children[index]!)
    ) {
      return false;
    }
  }
  return true;
}

function snapshotModeSwitcherPlacement(
  roots: readonly Node[],
): readonly ModeSwitcherPlacementSnapshot[] {
  const visited = new Set<Node>();
  const placements: ModeSwitcherPlacementSnapshot[] = [];
  for (const root of roots) {
    for (let node: Node | null = root; node && !visited.has(node); node = node.parentNode) {
      visited.add(node);
      placements.push(Object.freeze({
        node,
        parent: node.parentNode,
        previousSibling: node.previousSibling,
        nextSibling: node.nextSibling,
      }));
    }
  }
  return Object.freeze(placements);
}

function modeSwitcherPlacementMatches(snapshot: ModeSwitcherPlacementSnapshot) {
  return (
    snapshot.node.parentNode === snapshot.parent
    && snapshot.node.previousSibling === snapshot.previousSibling
    && snapshot.node.nextSibling === snapshot.nextSibling
  );
}

const MODE_ICONS: Record<EditMode, React.ReactNode> = {
  editing: <PenLine size={15} />,
  suggesting: <MessageSquarePlus size={15} />,
  viewing: <Eye size={15} />,
};
const MODE_LABELS: Record<EditMode, string> = { editing: "Editing", suggesting: "Suggesting", viewing: "Viewing" };

export function ModeSwitcher({ session }: { session: CollabSession }) {
  const mode = useSessionValue(session, (s) => s.mode);
  const editable = session.role === "owner" || session.role === "editor";
  const [open, setOpen] = useState(false);
  return (
    <Menu open={open} onOpenChange={setOpen}>
      <MenuTrigger
        asChild
        // Radix's trigger opens on Enter, Space and ArrowDown; ArrowUp opens it too, and Radix then focuses the first enabled row.
        onKeyDown={(event) => {
          if (event.key !== "ArrowUp" || open) return;
          event.preventDefault();
          setOpen(true);
        }}
      >
        <button
          type="button"
          className={cn(
            "btn btn-sm gap-1.5 border",
            mode === "suggesting" ? "border-green-200 bg-green-50 text-green-800 dark:border-green-900 dark:bg-green-950/40 dark:text-green-300" : "border-line-2 bg-surface text-ink-2 hover:bg-surface-2",
          )}
          data-testid="mode-switcher"
        >
          {MODE_ICONS[mode]}
          <span>{MODE_LABELS[mode]}</span>
          <ChevronDown size={14} className="text-ink-4" />
        </button>
      </MenuTrigger>
      <MenuContent align="end" className="w-64">
        <MenuRadioGroup value={mode} onValueChange={(value) => session.setMode(value as EditMode)}>
          <MenuRadioItem value="editing" disabled={!editable} description="Edit the document directly">
            Editing
          </MenuRadioItem>
          <MenuRadioItem value="suggesting" disabled={!editable} description="Edits become suggestions others can accept">
            Suggesting
          </MenuRadioItem>
          <MenuRadioItem value="viewing" description="Read or print the final document">
            Viewing
          </MenuRadioItem>
        </MenuRadioGroup>
        <MenuSeparator />
        <MenuItem
          icon={<BookOpen size={15} />}
          onSelect={() => window.open(`/p/${session.docId}`, "_blank", "noopener")}
          data-testid="mode-reader"
        >
          Open reader view
        </MenuItem>
      </MenuContent>
    </Menu>
  );
}

export type ExportFormat = "md" | "html" | "pdf";

/** Editing / Suggesting / Viewing as menu rows — the phone header has no room for the ModeSwitcher pill. */
function ModeItems({ session }: { session: CollabSession }) {
  const mode = useSessionValue(session, (s) => s.mode);
  const editable = session.role === "owner" || session.role === "editor";
  return (
    <>
      <MenuLabel>Mode</MenuLabel>
      <MenuRadioGroup value={mode} onValueChange={(v) => session.setMode(v as EditMode)}>
        <MenuRadioItem value="editing" disabled={!editable}>
          Editing
        </MenuRadioItem>
        <MenuRadioItem value="suggesting" disabled={!editable}>
          Suggesting
        </MenuRadioItem>
        <MenuRadioItem value="viewing">Viewing</MenuRadioItem>
      </MenuRadioGroup>
    </>
  );
}

export interface HeaderProps {
  session: CollabSession;
  doc: DocumentDto;
  commentsOpen: boolean;
  onToggleComments: (focusPanel?: boolean) => void;
  /** Open the thread/suggestion/document a notification points at (the item is already marked read). */
  onOpenNotification: (n: NotificationDto) => void;
  onShare: () => void;
  onPublish: () => void;
  onPublishNow: () => void;
  onPull: () => void;
  /** Opens the Sync dialog (both sides changed). */
  onSync: () => void;
  /** Three-way status against the linked GitHub file; null while unknown or when not linked. */
  sync: SyncStatusDto | null;
  onHistory: () => void;
  /** The ⋯ menu opened; the shell warms what its items need (the version list, task #487). */
  onMoreMenuOpen?: () => void;
  onActivity: () => void;
  onShortcuts: () => void;
  onCommandPalette?: () => void;
  onDelete: () => void;
  onDuplicate: () => void;
  onDownload: (format: ExportFormat, withSuggestions: boolean) => void;
  onCopyMarkdown: () => void;
  onNameVersion: () => void;
  documentMutation: "delete" | "duplicate" | null;
  publishing: boolean;
  isOwner: boolean;
  /** The server has a GitHub OAuth app; without it the GitHub entries are disabled and say why (#162). */
  githubConfigured: boolean;
  onHome: () => void;
  /** Pane layout shown by the segmented control on phones. */
  layout: Layout;
  onLayout: (layout: Layout) => void;
  /** Opens the outline drawer (phones only). */
  onOutline: () => void;
  /** Phone layout: icon-only save state, segmented pane control, secondary actions folded into the menu. */
  compact: boolean;
  /** "Jump" in the presence popover: scroll both panes to a collaborator's cursor. */
  onJumpToUser?: (user: PresenceUser) => void;
  /** Cancel an open request from the presence popover's Requests section; the Cancel buttons are hidden when omitted. */
  onCancelRequest?: (requestId: string) => void;
  /** Bumped by Share's agent row, the command palette and the `/agent` slash item: opens the "Connect an AI agent" dialog. */
  connectAgentNonce?: number;
  /** Canvas mode: hide navigation, sharing, publishing, and account menus. */
  embed?: boolean;
}

type LayoutSegmentPane = Extract<Layout, "rich" | "code">;

const LAYOUT_SEGMENT_OPTIONS = Object.freeze([
  Object.freeze({ value: "rich", label: "Preview", iconName: "eye", Icon: Eye }),
  Object.freeze({ value: "code", label: "Markdown", iconName: "code-xml", Icon: Code2 }),
] as const);
const LAYOUT_SEGMENT_CLASS_NAME = "inline-flex h-9 shrink-0 rounded-lg border border-line-2 bg-surface p-0.5 md:hidden";
const LAYOUT_SEGMENT_ROW_BASE_CLASS_NAME = "inline-flex h-8 w-8 items-center justify-center rounded-md transition-colors";
const LAYOUT_SEGMENT_ROW_ACTIVE_CLASS_NAME = "bg-accent-soft text-accent";
const LAYOUT_SEGMENT_ROW_INACTIVE_CLASS_NAME = "text-ink-3 hover:text-ink";

interface LayoutSegmentDomSnapshot {
  readonly node: Node;
  readonly nodeValue: string | null;
  readonly attributes: readonly (readonly [string, string])[] | null;
  readonly children: readonly LayoutSegmentDomSnapshot[];
}

interface LayoutSegmentPlacement {
  readonly document: Document;
  readonly parent: Node;
  readonly previousSibling: Node | null;
  readonly nextSibling: Node | null;
}

interface LayoutSegmentElementOwnerView {
  readonly element: () => Element | null;
}

interface LayoutSegmentRefReplay {
  readonly owner: LayoutSegmentElementOwnerView;
  readonly element: Element;
  detached: boolean;
  reattached: boolean;
}

interface LayoutSegmentRowAuthority {
  readonly index: number;
  readonly value: LayoutSegmentPane;
  readonly label: string;
  readonly iconName: string;
  readonly checked: boolean;
  readonly tabIndex: 0 | -1;
  readonly className: string;
  readonly size: number;
}

interface LayoutSegmentAuthority {
  readonly mount: symbol;
  readonly revision: number;
  readonly layout: Layout;
  readonly onLayout: (layout: Layout) => void;
  readonly rootClassName: string;
  readonly rows: readonly LayoutSegmentRowAuthority[];
}

interface LayoutSegmentPublication {
  readonly authority: LayoutSegmentAuthority;
  readonly root: HTMLDivElement;
  readonly ownerDocument: Document;
  readonly ownerRealm: Window & typeof globalThis;
  readonly dom: LayoutSegmentDomSnapshot;
  readonly placement: LayoutSegmentPlacement;
  readonly retire: () => boolean;
  readonly isRetired: () => boolean;
  readonly publishedDomMatches: () => boolean;
}

interface LayoutSegmentPublicationReplay {
  readonly source: LayoutSegmentPublication;
  readonly dom: LayoutSegmentDomSnapshot;
  readonly placement: LayoutSegmentPlacement;
  readonly historyIsClean: () => boolean;
  readonly release: () => void;
}

interface LayoutSegmentPublicationRuntime {
  readonly publication: LayoutSegmentPublication;
  readonly publish: () => boolean;
  readonly retireForElement: () => void;
  readonly retireForLayout: () => void;
  readonly noteRef: (
    owner: LayoutSegmentElementOwnerView,
    element: Element | null,
    previous: Element | null,
  ) => void;
  readonly isExactElementReplay: () => boolean;
  readonly isExactLayoutReplay: () => boolean;
  readonly replay: () => LayoutSegmentPublicationReplay | null;
}

interface LayoutSegmentDomGuard {
  readonly isClean: () => boolean;
  readonly release: () => void;
}

class LayoutSegmentElementOwner<T extends Element> implements LayoutSegmentElementOwnerView {
  #current: T | null = null;
  #last: T | null = null;

  constructor(
    private readonly onChange: (
      owner: LayoutSegmentElementOwnerView,
      element: T | null,
      previous: T | null,
      last: T | null,
    ) => void,
  ) {}

  readonly element = () => this.#current;
  readonly capture = (element: T | null) => {
    if (this.#current === element) return;
    const previous = this.#current;
    const last = this.#last;
    this.#current = element;
    if (element) this.#last = element;
    this.onChange(this, element, previous, last);
  };
}

class LayoutSegmentPublicationCoordinator {
  #active: LayoutSegmentPublication | null = null;
  #successorOf: LayoutSegmentPublication | null = null;
  #replay: LayoutSegmentPublicationReplay | null = null;
  #retired = new WeakSet<LayoutSegmentPublication>();
  #claimedPublications = new WeakSet<LayoutSegmentPublication>();
  #claimedActions = new WeakSet<object>();
  #claimedEvents = new WeakSet<object>();
  #claimedDeliveryParts = new WeakSet<object>();
  #activeDelivery: {
    readonly publication: LayoutSegmentPublication;
    readonly action: object;
    readonly events: readonly object[];
    readonly parts: readonly object[];
    readonly delivery: object;
  } | null = null;

  constructor(private readonly mount: symbol) {}

  active() {
    return this.#active;
  }

  replay() {
    return this.#replay;
  }

  acceptsSuccessorOf(publication: LayoutSegmentPublication) {
    return (
      this.#active === null
      && this.#successorOf === publication
      && this.#retired.has(publication)
      && !this.#claimedPublications.has(publication)
    );
  }

  stageReplay(replay: LayoutSegmentPublicationReplay) {
    if (!this.acceptsSuccessorOf(replay.source)) return false;
    this.#replay = replay;
    return true;
  }

  abandonReplay(publication: LayoutSegmentPublication) {
    if (this.#replay?.source === publication) this.#replay = null;
    if (this.#successorOf === publication) this.#successorOf = null;
  }

  publish(publication: LayoutSegmentPublication) {
    if (
      publication.authority.mount !== this.mount
      || this.#retired.has(publication)
    ) {
      return false;
    }
    const previous = this.#active;
    if (previous && previous !== publication) previous.retire();
    this.#active = publication;
    this.#successorOf = null;
    this.#replay = null;
    return true;
  }

  retire(publication: LayoutSegmentPublication) {
    if (this.#retired.has(publication)) return false;
    this.#retired.add(publication);
    if (this.#active === publication) {
      this.#active = null;
      this.#successorOf = publication;
    }
    return true;
  }

  isCurrent(publication: LayoutSegmentPublication) {
    return this.#active === publication && !this.#retired.has(publication);
  }

  hasClaimed(
    publication: LayoutSegmentPublication,
    action: object,
    event: object,
    nativeEvent: Event,
  ) {
    const active = this.#activeDelivery;
    return (
      this.#claimedPublications.has(publication)
      || this.#claimedActions.has(action)
      || this.#claimedEvents.has(event)
      || this.#claimedEvents.has(nativeEvent)
      || active?.publication === publication
      || active?.action === action
      || active?.events.includes(event)
      || active?.events.includes(nativeEvent)
    );
  }

  claim(
    publication: LayoutSegmentPublication,
    action: object,
    event: object,
    nativeEvent: Event,
  ) {
    if (
      !this.isCurrent(publication)
      || this.#activeDelivery
      || this.hasClaimed(publication, action, event, nativeEvent)
    ) {
      return false;
    }
    this.#claimedPublications.add(publication);
    this.#claimedActions.add(action);
    this.#claimedEvents.add(event);
    this.#claimedEvents.add(nativeEvent);
    return true;
  }

  claimDelivery(
    publication: LayoutSegmentPublication,
    action: object,
    events: readonly object[],
    parts: readonly object[],
    delivery: object,
  ) {
    const deliveryParts = [...parts, delivery];
    if (
      !this.isCurrent(publication)
      || this.#activeDelivery
      || this.#claimedPublications.has(publication)
      || this.#claimedActions.has(action)
      || events.some((event) => this.#claimedEvents.has(event))
      || deliveryParts.some((part) => this.#claimedDeliveryParts.has(part))
      || new Set([...events, ...deliveryParts]).size !== events.length + deliveryParts.length
    ) {
      return false;
    }
    this.#activeDelivery = Object.freeze({
      publication,
      action,
      events: Object.freeze([...events]),
      parts: Object.freeze(deliveryParts),
      delivery,
    });
    return true;
  }

  deliveryIsActive(delivery: object) {
    return this.#activeDelivery?.delivery === delivery;
  }

  commitDelivery(delivery: object) {
    const active = this.#activeDelivery;
    if (
      !active
      || active.delivery !== delivery
      || !this.isCurrent(active.publication)
      || this.#claimedPublications.has(active.publication)
      || this.#claimedActions.has(active.action)
      || active.events.some((event) => this.#claimedEvents.has(event))
      || active.parts.some((part) => this.#claimedDeliveryParts.has(part))
    ) {
      return false;
    }
    this.#claimedPublications.add(active.publication);
    this.#claimedActions.add(active.action);
    for (const event of active.events) this.#claimedEvents.add(event);
    for (const part of active.parts) this.#claimedDeliveryParts.add(part);
    this.#activeDelivery = null;
    return true;
  }

  finishDelivery(delivery: object) {
    if (this.#activeDelivery?.delivery === delivery) this.#activeDelivery = null;
  }
}

class LayoutSegmentPresentationCache {
  #current: {
    readonly authority: LayoutSegmentAuthority;
    readonly presentation: LayoutSegmentPresentation;
    readonly revision: number;
  } | null = null;

  resolve(
    authority: LayoutSegmentAuthority,
    revision: number,
    create: () => LayoutSegmentPresentation,
  ) {
    if (
      !this.#current
      || this.#current.revision !== revision
      || !layoutSegmentAuthoritiesMatch(this.#current.authority, authority)
    ) {
      this.#current = Object.freeze({
        authority,
        presentation: create(),
        revision,
      });
    }
    return this.#current.presentation;
  }
}

function layoutSegmentSnapshotAttributes(node: Node) {
  if (node.nodeType !== 1) return null;
  return Object.freeze(
    [...(node as Element).attributes]
      .map(({ name, value }) => Object.freeze([name, value] as const))
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

function layoutSegmentSnapshotDom(node: Node): LayoutSegmentDomSnapshot {
  return Object.freeze({
    node,
    nodeValue: node.nodeValue,
    attributes: layoutSegmentSnapshotAttributes(node),
    children: Object.freeze([...node.childNodes].map(layoutSegmentSnapshotDom)),
  });
}

function layoutSegmentDomMatches(snapshot: LayoutSegmentDomSnapshot): boolean {
  const { node } = snapshot;
  if (node.nodeValue !== snapshot.nodeValue) return false;
  const attributes = layoutSegmentSnapshotAttributes(node);
  if (attributes === null || snapshot.attributes === null) {
    if (attributes !== snapshot.attributes) return false;
  } else if (
    attributes.length !== snapshot.attributes.length
    || attributes.some(([name, value], index) => {
      const expected = snapshot.attributes?.[index];
      return !expected || name !== expected[0] || value !== expected[1];
    })
  ) {
    return false;
  }
  return (
    node.childNodes.length === snapshot.children.length
    && snapshot.children.every((child, index) =>
      node.childNodes.item(index) === child.node && layoutSegmentDomMatches(child))
  );
}

function layoutSegmentSnapshotContains(
  snapshot: LayoutSegmentDomSnapshot,
  node: Node,
): boolean {
  return snapshot.node === node
    || snapshot.children.some((child) => layoutSegmentSnapshotContains(child, node));
}

function layoutSegmentPlacement(root: HTMLDivElement): LayoutSegmentPlacement | null {
  const parent = root.parentNode;
  if (!parent) return null;
  return Object.freeze({
    document: root.ownerDocument,
    parent,
    previousSibling: root.previousSibling,
    nextSibling: root.nextSibling,
  });
}

function layoutSegmentPlacementMatches(
  root: HTMLDivElement,
  placement: LayoutSegmentPlacement,
) {
  return (
    root.ownerDocument === placement.document
    && root.parentNode === placement.parent
    && root.previousSibling === placement.previousSibling
    && root.nextSibling === placement.nextSibling
  );
}

function createLayoutSegmentDomGuard(
  root: HTMLDivElement,
  placement: LayoutSegmentPlacement,
): LayoutSegmentDomGuard | null {
  const MutationObserverConstructor = placement.document.defaultView?.MutationObserver;
  if (!MutationObserverConstructor) return null;
  let changed = false;
  const recordChanges = (records: readonly MutationRecord[]) => {
    if (changed) return;
    changed = records.some((record) => {
      if (record.target === root || root.contains(record.target)) return true;
      if (record.type !== "childList" || record.target !== placement.parent) return false;
      if (record.previousSibling === root || record.nextSibling === root) return true;
      return [...record.addedNodes, ...record.removedNodes].some((node) =>
        node === root || (node.nodeType === 1 && (node as Element).contains(root)));
    });
  };
  const observer = new MutationObserverConstructor(recordChanges);
  observer.observe(root, {
    attributes: true,
    characterData: true,
    childList: true,
    subtree: true,
  });
  observer.observe(placement.parent, { childList: true });
  return Object.freeze({
    isClean: () => {
      recordChanges(observer.takeRecords());
      return !changed;
    },
    release: () => {
      recordChanges(observer.takeRecords());
      observer.disconnect();
    },
  });
}

function createLayoutSegmentPublicationRuntime(
  authority: LayoutSegmentAuthority,
  coordinator: LayoutSegmentPublicationCoordinator,
  root: HTMLDivElement,
  owners: readonly LayoutSegmentElementOwnerView[],
): LayoutSegmentPublicationRuntime {
  type Retirement = "element" | "layout" | "other";
  const placement = layoutSegmentPlacement(root);
  if (!placement) throw new Error("Cannot publish a pane switch without a committed parent");
  const ownerRealm = placement.document.defaultView;
  if (!ownerRealm) throw new Error("Cannot publish a pane switch without an owner realm");
  const dom = layoutSegmentSnapshotDom(root);
  let retired = false;
  let retirement: Retirement | null = null;
  let established = false;
  let layoutRetired = false;
  let invalidReplay = false;
  let replayRefs: LayoutSegmentRefReplay[] = [];
  let domGuard: LayoutSegmentDomGuard | null = null;
  const publishedDomMatches = () =>
    Boolean(
      domGuard
      && domGuard.isClean()
      && root === dom.node
      && root.isConnected
      && layoutSegmentPlacementMatches(root, placement)
      && layoutSegmentDomMatches(dom)
    );
  const retire = (reason: Retirement) => {
    if (retired) return false;
    retired = true;
    retirement = reason;
    coordinator.retire(publication);
    queueMicrotask(() => {
      if (coordinator.replay()?.source !== publication) domGuard?.release();
    });
    return true;
  };
  const publication: LayoutSegmentPublication = Object.freeze({
    authority,
    root,
    ownerDocument: root.ownerDocument,
    ownerRealm,
    dom,
    placement,
    retire: () => retire("other"),
    isRetired: () => retired,
    publishedDomMatches,
  });
  const refsHaveNoReplay = () =>
    !invalidReplay
    && replayRefs.every((entry) =>
      !entry.detached
      && !entry.reattached
      && entry.owner.element() === entry.element);
  const refsHaveExactReplay = () =>
    !invalidReplay
    && replayRefs.length > 0
    && replayRefs.every((entry) =>
      entry.detached
      && entry.reattached
      && entry.owner.element() === entry.element);

  return Object.freeze({
    publication,
    publish: () => {
      established = true;
      replayRefs = owners.map((owner) => {
        const element = owner.element();
        if (!element) throw new Error("Cannot publish a pane switch without every committed ref");
        return { owner, element, detached: false, reattached: false };
      });
      domGuard = createLayoutSegmentDomGuard(root, placement);
      if (!domGuard || !coordinator.publish(publication)) {
        domGuard?.release();
        return false;
      }
      return true;
    },
    retireForElement: () => {
      retire("element");
    },
    retireForLayout: () => {
      layoutRetired = true;
      retire("layout");
    },
    noteRef: (
      owner: LayoutSegmentElementOwnerView,
      element: Element | null,
      previous: Element | null,
    ) => {
      if (!established) return;
      const proof = replayRefs.find((entry) => entry.owner === owner);
      if (!proof) {
        invalidReplay = true;
        return;
      }
      if (element === null && previous === proof.element) {
        proof.detached = true;
        proof.reattached = false;
      } else if (
        element === proof.element
        && previous === null
        && proof.detached
      ) {
        proof.reattached = true;
      } else if (element !== previous) {
        invalidReplay = true;
      }
      if (
        !retired
        && replayRefs.every((entry) => entry.owner.element() === entry.element)
      ) {
        for (const entry of replayRefs) {
          entry.detached = false;
          entry.reattached = false;
        }
        invalidReplay = false;
      }
    },
    isExactElementReplay: () =>
      retired
      && retirement === "element"
      && layoutRetired
      && established
      && refsHaveExactReplay()
      && publishedDomMatches(),
    isExactLayoutReplay: () =>
      retired
      && retirement === "layout"
      && established
      && (refsHaveNoReplay() || refsHaveExactReplay())
      && publishedDomMatches(),
    replay: () =>
      domGuard
        ? Object.freeze({
            source: publication,
            dom,
            placement,
            historyIsClean: domGuard.isClean,
            release: domGuard.release,
          })
        : null,
  });
}

function layoutSegmentReplayAllowsPublication(
  coordinator: LayoutSegmentPublicationCoordinator,
  authority: LayoutSegmentAuthority,
  root: HTMLDivElement,
) {
  const replay = coordinator.replay();
  if (!replay) return true;
  const sameAuthority = layoutSegmentAuthoritiesMatch(
    replay.source.authority,
    authority,
    false,
  );
  const exactReplay = (
    sameAuthority
    && coordinator.acceptsSuccessorOf(replay.source)
    && replay.historyIsClean()
    && root === replay.dom.node
    && layoutSegmentPlacementMatches(root, replay.placement)
    && layoutSegmentDomMatches(replay.dom)
  );
  coordinator.abandonReplay(replay.source);
  replay.release();
  return !sameAuthority || exactReplay;
}

function layoutSegmentAuthoritiesMatch(
  previous: LayoutSegmentAuthority,
  current: LayoutSegmentAuthority,
  includeRevision = true,
) {
  return (
    previous.mount === current.mount
    && (!includeRevision || previous.revision === current.revision)
    && previous.layout === current.layout
    && previous.onLayout === current.onLayout
    && previous.rootClassName === current.rootClassName
    && previous.rows.length === current.rows.length
    && previous.rows.every((row, index) => {
      const candidate = current.rows[index];
      return Boolean(
        candidate
        && row.index === candidate.index
        && row.value === candidate.value
        && row.label === candidate.label
        && row.iconName === candidate.iconName
        && row.checked === candidate.checked
        && row.tabIndex === candidate.tabIndex
        && row.className === candidate.className
        && row.size === candidate.size
      );
    })
  );
}

interface LayoutSegmentIntrinsicGetter<T> {
  readonly read: (target: object) => T;
  readonly isCurrent: () => boolean;
}

interface LayoutSegmentIntrinsicMethod<A extends readonly unknown[], R> {
  readonly invoke: (target: object, ...args: A) => R;
  readonly isCurrent: () => boolean;
}

interface LayoutSegmentWindowMethod {
  readonly value: (...args: unknown[]) => unknown;
  readonly isCurrent: () => boolean;
}

interface LayoutSegmentUnforgeableGetter<T> {
  readonly read: (target: object) => T;
  readonly matches: (target: object) => boolean;
  readonly isCurrent: () => boolean;
}

function layoutSegmentDescriptorsMatch(
  current: PropertyDescriptor | undefined,
  expected: Readonly<PropertyDescriptor>,
) {
  if (!current) return false;
  if (
    current.configurable !== expected.configurable
    || current.enumerable !== expected.enumerable
  ) {
    return false;
  }
  if ("value" in expected) {
    return (
      "value" in current
      && current.value === expected.value
      && current.writable === expected.writable
    );
  }
  return (
    !("value" in current)
    && current.get === expected.get
    && current.set === expected.set
  );
}

function captureLayoutSegmentIntrinsicGetter<T>(
  prototype: object,
  property: string,
  getOwnPropertyDescriptor: typeof Object.getOwnPropertyDescriptor,
  getPrototypeOf: typeof Object.getPrototypeOf,
  apply: typeof Reflect.apply,
): LayoutSegmentIntrinsicGetter<T> | null {
  let current: object | null = prototype;
  while (current) {
    const descriptor = getOwnPropertyDescriptor(current, property);
    if (descriptor) {
      if (typeof descriptor.get !== "function") return null;
      const getter = descriptor.get;
      const expected = Object.freeze({ ...descriptor });
      return Object.freeze({
        read: (target: object) => apply(getter, target, []) as T,
        isCurrent: () =>
          layoutSegmentDescriptorsMatch(
            getOwnPropertyDescriptor(current!, property),
            expected,
          ),
      });
    }
    current = getPrototypeOf(current) as object | null;
  }
  return null;
}

function captureLayoutSegmentIntrinsicMethod<A extends readonly unknown[], R>(
  prototype: object,
  property: string,
  getOwnPropertyDescriptor: typeof Object.getOwnPropertyDescriptor,
  getPrototypeOf: typeof Object.getPrototypeOf,
  apply: typeof Reflect.apply,
): LayoutSegmentIntrinsicMethod<A, R> | null {
  let current: object | null = prototype;
  while (current) {
    const descriptor = getOwnPropertyDescriptor(current, property);
    if (descriptor) {
      if (typeof descriptor.value !== "function") return null;
      const method = descriptor.value as (...args: A) => R;
      const expected = Object.freeze({ ...descriptor });
      return Object.freeze({
        invoke: (target: object, ...args: A) => apply(method, target, args) as R,
        isCurrent: () =>
          layoutSegmentDescriptorsMatch(
            getOwnPropertyDescriptor(current!, property),
            expected,
          ),
      });
    }
    current = getPrototypeOf(current) as object | null;
  }
  return null;
}

function captureLayoutSegmentWindowMethod(
  ownerWindow: Window & typeof globalThis,
  property: "addEventListener" | "removeEventListener",
): LayoutSegmentWindowMethod | null {
  const getOwnPropertyDescriptor = ownerWindow.Object.getOwnPropertyDescriptor;
  const getPrototypeOf = ownerWindow.Object.getPrototypeOf;
  const reflectGet = ownerWindow.Reflect.get;
  const path: {
    readonly target: object;
    readonly descriptor: Readonly<PropertyDescriptor> | null;
    readonly prototype: object | null;
  }[] = [];
  let target: object | null = ownerWindow;
  let found = false;
  while (target) {
    const descriptor = getOwnPropertyDescriptor(target, property);
    const prototype = getPrototypeOf(target) as object | null;
    path.push(Object.freeze({
      target,
      descriptor: descriptor ? Object.freeze({ ...descriptor }) : null,
      prototype,
    }));
    if (descriptor) {
      found = true;
      break;
    }
    target = prototype;
  }
  const value = reflectGet(ownerWindow, property, ownerWindow);
  if (!found || typeof value !== "function") return null;
  const isCurrent = () =>
    ownerWindow.Object.getOwnPropertyDescriptor === getOwnPropertyDescriptor
    && ownerWindow.Object.getPrototypeOf === getPrototypeOf
    && ownerWindow.Reflect.get === reflectGet
    && path.every(({ target: entry, descriptor, prototype }) => {
      const current = getOwnPropertyDescriptor(entry, property);
      return (
        getPrototypeOf(entry) === prototype
        && (descriptor
          ? layoutSegmentDescriptorsMatch(current, descriptor)
          : current === undefined)
      );
    })
    && reflectGet(ownerWindow, property, ownerWindow) === value;
  return isCurrent()
    ? Object.freeze({
        value: value as (...args: unknown[]) => unknown,
        isCurrent,
      })
    : null;
}

function captureLayoutSegmentUnforgeableGetter<T>(
  owner: object,
  property: string,
  getOwnPropertyDescriptor: typeof Object.getOwnPropertyDescriptor,
  apply: typeof Reflect.apply,
): LayoutSegmentUnforgeableGetter<T> | null {
  const descriptor = getOwnPropertyDescriptor(owner, property);
  if (!descriptor?.get || "value" in descriptor) return null;
  const expected = Object.freeze({ ...descriptor });
  const getter = descriptor.get;
  const matches = (target: object) =>
    layoutSegmentDescriptorsMatch(
      getOwnPropertyDescriptor(target, property),
      expected,
    );
  return Object.freeze({
    read: (target: object) => apply(getter, target, []) as T,
    matches,
    isCurrent: () => matches(owner),
  });
}

interface LayoutSegmentNativeKeyboardFacts {
  readonly type: string;
  readonly currentTarget: EventTarget | null;
  readonly phase: number;
  readonly bubbles: boolean;
  readonly cancelable: boolean;
  readonly defaultPrevented: boolean;
  readonly cancelBubble: boolean;
  readonly target: EventTarget | null;
  readonly path: readonly EventTarget[];
  readonly isTrusted: boolean;
  readonly timeStamp: number;
  readonly view: EventTarget | null;
  readonly composed: boolean;
  readonly detail: number;
  readonly key: string;
  readonly code: string;
  readonly location: number;
  readonly repeat: boolean;
  readonly composing: boolean;
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
  readonly charCode: number;
  readonly keyCode: number;
  readonly which: number;
}

interface LayoutSegmentKeyboardAuthority {
  readonly view: Window & typeof globalThis;
  readonly capturingPhase: number;
  readonly bubblingPhase: number;
  readonly apply: typeof Reflect.apply;
  readonly readTarget: (event: object) => EventTarget | null | undefined;
  readonly readKeyboard: (
    event: object,
  ) => LayoutSegmentNativeKeyboardFacts | null;
  readonly activeElement: () => Element | null | undefined;
  readonly focus: LayoutSegmentIntrinsicMethod<readonly [FocusOptions?], void>;
  readonly addEventListener: LayoutSegmentWindowMethod;
  readonly removeEventListener: LayoutSegmentWindowMethod;
}

function captureLayoutSegmentKeyboardAuthority(
  publication: LayoutSegmentPublication,
): LayoutSegmentKeyboardAuthority | null {
  const { ownerDocument, ownerRealm: view } = publication;
  const objectConstructor = view.Object;
  const reflectObject = view.Reflect;
  const eventConstructor = view.Event;
  const uiEventConstructor = view.UIEvent;
  const keyboardConstructor = view.KeyboardEvent;
  const documentConstructor = view.Document;
  const htmlElementConstructor = view.HTMLElement;
  const eventPrototype = eventConstructor.prototype;
  const uiEventPrototype = uiEventConstructor.prototype;
  const keyboardPrototype = keyboardConstructor.prototype;
  const documentPrototype = documentConstructor.prototype;
  const htmlElementPrototype = htmlElementConstructor.prototype;
  const getOwnPropertyDescriptor = objectConstructor.getOwnPropertyDescriptor;
  const getPrototypeOf = objectConstructor.getPrototypeOf;
  const apply = reflectObject.apply;
  const getter = <T,>(prototype: object, property: string) =>
    captureLayoutSegmentIntrinsicGetter<T>(
      prototype,
      property,
      getOwnPropertyDescriptor,
      getPrototypeOf,
      apply,
    );
  const method = <A extends readonly unknown[], R>(
    prototype: object,
    property: string,
  ) =>
    captureLayoutSegmentIntrinsicMethod<A, R>(
      prototype,
      property,
      getOwnPropertyDescriptor,
      getPrototypeOf,
      apply,
    );
  const eventType = getter<string>(eventPrototype, "type");
  const eventTarget = getter<EventTarget | null>(eventPrototype, "target");
  const eventCurrentTarget = getter<EventTarget | null>(
    eventPrototype,
    "currentTarget",
  );
  const eventPhase = getter<number>(eventPrototype, "eventPhase");
  const eventBubbles = getter<boolean>(eventPrototype, "bubbles");
  const eventCancelable = getter<boolean>(eventPrototype, "cancelable");
  const eventDefaultPrevented = getter<boolean>(
    eventPrototype,
    "defaultPrevented",
  );
  const eventCancelBubble = getter<boolean>(eventPrototype, "cancelBubble");
  const eventComposed = getter<boolean>(eventPrototype, "composed");
  const eventTimeStamp = getter<number>(eventPrototype, "timeStamp");
  const eventPath = method<readonly [], EventTarget[]>(
    eventPrototype,
    "composedPath",
  );
  const eventView = getter<EventTarget | null>(uiEventPrototype, "view");
  const eventDetail = getter<number>(uiEventPrototype, "detail");
  const key = getter<string>(keyboardPrototype, "key");
  const code = getter<string>(keyboardPrototype, "code");
  const location = getter<number>(keyboardPrototype, "location");
  const repeat = getter<boolean>(keyboardPrototype, "repeat");
  const composing = getter<boolean>(keyboardPrototype, "isComposing");
  const altKey = getter<boolean>(keyboardPrototype, "altKey");
  const ctrlKey = getter<boolean>(keyboardPrototype, "ctrlKey");
  const metaKey = getter<boolean>(keyboardPrototype, "metaKey");
  const shiftKey = getter<boolean>(keyboardPrototype, "shiftKey");
  const charCode = getter<number>(keyboardPrototype, "charCode");
  const keyCode = getter<number>(keyboardPrototype, "keyCode");
  const which = getter<number>(keyboardPrototype, "which");
  const activeElement = getter<Element | null>(
    documentPrototype,
    "activeElement",
  );
  const focus = method<readonly [FocusOptions?], void>(
    htmlElementPrototype,
    "focus",
  );
  const addEventListener = captureLayoutSegmentWindowMethod(
    view,
    "addEventListener",
  );
  const removeEventListener = captureLayoutSegmentWindowMethod(
    view,
    "removeEventListener",
  );
  let probe: KeyboardEvent;
  try {
    probe = new keyboardConstructor("layout-segment-keyboard-proof");
  } catch {
    return null;
  }
  const trusted = captureLayoutSegmentUnforgeableGetter<boolean>(
    probe,
    "isTrusted",
    getOwnPropertyDescriptor,
    apply,
  );
  const getters = Object.freeze([
    eventType,
    eventTarget,
    eventCurrentTarget,
    eventPhase,
    eventBubbles,
    eventCancelable,
    eventDefaultPrevented,
    eventCancelBubble,
    eventComposed,
    eventTimeStamp,
    eventView,
    eventDetail,
    key,
    code,
    location,
    repeat,
    composing,
    altKey,
    ctrlKey,
    metaKey,
    shiftKey,
    charCode,
    keyCode,
    which,
    activeElement,
  ]);
  const methods = Object.freeze([eventPath, focus]);
  if (
    getters.some((intrinsic) => !intrinsic || !intrinsic.isCurrent())
    || methods.some((intrinsic) => !intrinsic || !intrinsic.isCurrent())
    || !eventType
    || !eventTarget
    || !eventCurrentTarget
    || !eventPhase
    || !eventBubbles
    || !eventCancelable
    || !eventDefaultPrevented
    || !eventCancelBubble
    || !eventComposed
    || !eventTimeStamp
    || !eventPath
    || !eventView
    || !eventDetail
    || !key
    || !code
    || !location
    || !repeat
    || !composing
    || !altKey
    || !ctrlKey
    || !metaKey
    || !shiftKey
    || !charCode
    || !keyCode
    || !which
    || !activeElement
    || !focus
    || !trusted
    || !trusted.isCurrent()
    || !addEventListener
    || !addEventListener.isCurrent()
    || !removeEventListener
    || !removeEventListener.isCurrent()
    || ownerDocument.defaultView !== view
  ) {
    return null;
  }
  let historyIsClean = true;
  const intrinsicsAreCurrent = () => {
    if (!historyIsClean) return false;
    historyIsClean = (
      ownerDocument.defaultView === view
      && objectConstructor === view.Object
      && reflectObject === view.Reflect
      && eventConstructor === view.Event
      && uiEventConstructor === view.UIEvent
      && keyboardConstructor === view.KeyboardEvent
      && documentConstructor === view.Document
      && htmlElementConstructor === view.HTMLElement
      && eventPrototype === eventConstructor.prototype
      && uiEventPrototype === uiEventConstructor.prototype
      && keyboardPrototype === keyboardConstructor.prototype
      && documentPrototype === documentConstructor.prototype
      && htmlElementPrototype === htmlElementConstructor.prototype
      && view.Object.getOwnPropertyDescriptor === getOwnPropertyDescriptor
      && view.Object.getPrototypeOf === getPrototypeOf
      && view.Reflect.apply === apply
      && getters.every((intrinsic) => intrinsic?.isCurrent() === true)
      && methods.every((intrinsic) => intrinsic?.isCurrent() === true)
      && trusted.isCurrent()
      && addEventListener.isCurrent()
      && removeEventListener.isCurrent()
    );
    return historyIsClean;
  };
  return Object.freeze({
    view,
    capturingPhase: eventConstructor.CAPTURING_PHASE,
    bubblingPhase: eventConstructor.BUBBLING_PHASE,
    apply,
    readTarget: (event: object) => {
      try {
        if (
          !intrinsicsAreCurrent()
          || getPrototypeOf(event) !== keyboardPrototype
          || !trusted.matches(event)
          || trusted.read(event) !== true
        ) {
          return undefined;
        }
        return eventTarget.read(event);
      } catch {
        return undefined;
      }
    },
    readKeyboard: (event: object) => {
      try {
        if (
          !intrinsicsAreCurrent()
          || getPrototypeOf(event) !== keyboardPrototype
          || !trusted.matches(event)
          || trusted.read(event) !== true
        ) {
          return null;
        }
        return Object.freeze({
          type: eventType.read(event),
          currentTarget: eventCurrentTarget.read(event),
          phase: eventPhase.read(event),
          bubbles: eventBubbles.read(event),
          cancelable: eventCancelable.read(event),
          defaultPrevented: eventDefaultPrevented.read(event),
          cancelBubble: eventCancelBubble.read(event),
          target: eventTarget.read(event),
          path: Object.freeze([...eventPath.invoke(event)]),
          isTrusted: trusted.read(event),
          timeStamp: eventTimeStamp.read(event),
          view: eventView.read(event),
          composed: eventComposed.read(event),
          detail: eventDetail.read(event),
          key: key.read(event),
          code: code.read(event),
          location: location.read(event),
          repeat: repeat.read(event),
          composing: composing.read(event),
          altKey: altKey.read(event),
          ctrlKey: ctrlKey.read(event),
          metaKey: metaKey.read(event),
          shiftKey: shiftKey.read(event),
          charCode: charCode.read(event),
          keyCode: keyCode.read(event),
          which: which.read(event),
        });
      } catch {
        return null;
      }
    },
    activeElement: () => {
      if (!intrinsicsAreCurrent()) return undefined;
      try {
        return activeElement.read(ownerDocument);
      } catch {
        return undefined;
      }
    },
    focus,
    addEventListener,
    removeEventListener,
  });
}

function layoutSegmentDestination(
  key: string,
  current: number,
  count: number,
): number | null {
  if (count < 2 || current < 0 || current >= count) return null;
  if (key === "ArrowRight" || key === "ArrowDown") return (current + 1) % count;
  if (key === "ArrowLeft" || key === "ArrowUp") return (current - 1 + count) % count;
  if (key === "Home") return current === 0 ? null : 0;
  if (key === "End") return current === count - 1 ? null : count - 1;
  return null;
}

interface LayoutSegmentWindowProof {
  readonly registration: LayoutSegmentKeyListener;
  readonly publication: LayoutSegmentPublication;
  readonly nativeEvent: KeyboardEvent;
  readonly receiver: EventTarget;
  readonly currentTarget: EventTarget;
  readonly terminal: EventTarget;
  readonly path: readonly EventTarget[];
}

interface LayoutSegmentKeyListener {
  readonly proofFor: (
    event: KeyboardEvent,
    publication: LayoutSegmentPublication,
  ) => LayoutSegmentWindowProof | null;
  readonly retains: (
    proof: LayoutSegmentWindowProof,
    publication: LayoutSegmentPublication,
  ) => boolean;
  readonly activate: (publication: LayoutSegmentPublication) => boolean;
  readonly release: (publication: LayoutSegmentPublication) => void;
  readonly isCurrent: () => boolean;
}

interface LayoutSegmentReactKeyboardMethods {
  readonly preventDefault: (...args: never[]) => unknown;
  readonly isDefaultPrevented: (...args: never[]) => unknown;
  readonly isPropagationStopped: (...args: never[]) => unknown;
}

function isLayoutSegmentReactMethod(
  value: unknown,
): value is LayoutSegmentReactKeyboardMethods["isDefaultPrevented"] {
  return typeof value === "function";
}

interface LayoutSegmentReactKeyboardSnapshot {
  readonly event: React.KeyboardEvent<HTMLButtonElement>;
  readonly nativeEvent: KeyboardEvent;
  readonly target: HTMLButtonElement;
  readonly currentTarget: HTMLButtonElement;
  readonly phase: number;
  readonly view: React.KeyboardEvent<HTMLButtonElement>["view"];
  readonly composing: unknown;
  readonly methods: LayoutSegmentReactKeyboardMethods;
}

interface LayoutSegmentMovement {
  readonly identity: symbol;
  readonly publication: LayoutSegmentPublication;
  readonly sourceRow: LayoutSegmentRowPresentation;
  readonly destinationRow: LayoutSegmentRowPresentation;
  readonly source: HTMLButtonElement;
  readonly destination: HTMLButtonElement;
  readonly key: string;
}

interface LayoutSegmentKeyPair {
  readonly publication: LayoutSegmentPublication;
  readonly action: object;
  readonly native: LayoutSegmentNativeKeyboardFacts;
  readonly nativeEvent: KeyboardEvent;
  readonly capture: LayoutSegmentReactKeyboardSnapshot;
  readonly windowProof: LayoutSegmentWindowProof;
  readonly sourceRow: LayoutSegmentRowPresentation;
  readonly destinationRow: LayoutSegmentRowPresentation;
  readonly source: HTMLButtonElement;
  readonly destination: HTMLButtonElement;
  readonly key: string;
  readonly movement: LayoutSegmentMovement;
  readonly publicationClaim: object;
  readonly sourceClaim: object;
  readonly destinationClaim: object;
  readonly captureClaim: object;
  readonly nativeClaim: object;
  readonly windowClaim: object;
}

interface LayoutSegmentPairingStore {
  readonly isDisposed: () => boolean;
  readonly isInvalid: (event: KeyboardEvent) => boolean;
  readonly has: (event: KeyboardEvent) => boolean;
  readonly stage: (
    event: KeyboardEvent,
    pair: LayoutSegmentKeyPair,
  ) => boolean;
  readonly get: (event: KeyboardEvent) => LayoutSegmentKeyPair | null;
  readonly begin: (
    event: KeyboardEvent,
    pair: LayoutSegmentKeyPair,
  ) => boolean;
  readonly finish: (
    event: KeyboardEvent,
    pair: LayoutSegmentKeyPair,
  ) => void;
  readonly consume: (
    event: KeyboardEvent,
    pair: LayoutSegmentKeyPair,
  ) => boolean;
  readonly invalidate: (event: KeyboardEvent) => void;
  readonly dispose: () => void;
}

interface LayoutSegmentKeyDelivery {
  readonly pair: LayoutSegmentKeyPair;
  readonly bubble: LayoutSegmentReactKeyboardSnapshot;
}

function createLayoutSegmentPairingStore(): LayoutSegmentPairingStore {
  let pairs: WeakMap<KeyboardEvent, LayoutSegmentKeyPair> | null = new WeakMap();
  let active: WeakMap<KeyboardEvent, LayoutSegmentKeyPair> | null = new WeakMap();
  let invalid: WeakSet<KeyboardEvent> | null = new WeakSet();
  let disposed = false;
  return Object.freeze({
    isDisposed: () => disposed,
    isInvalid: (event: KeyboardEvent) =>
      disposed || !invalid || invalid.has(event),
    has: (event: KeyboardEvent) =>
      !disposed && Boolean(pairs?.has(event)),
    stage: (event: KeyboardEvent, pair: LayoutSegmentKeyPair) => {
      if (disposed || !pairs || pairs.has(event)) return false;
      pairs.set(event, pair);
      return !disposed;
    },
    get: (event: KeyboardEvent) => {
      if (disposed || !pairs) return null;
      return pairs.get(event) ?? null;
    },
    begin: (event: KeyboardEvent, pair: LayoutSegmentKeyPair) => {
      if (disposed || !active || active.has(event)) return false;
      active.set(event, pair);
      return !disposed;
    },
    finish: (event: KeyboardEvent, pair: LayoutSegmentKeyPair) => {
      if (disposed || !active || active.get(event) !== pair) return;
      active.delete(event);
    },
    consume: (event: KeyboardEvent, pair: LayoutSegmentKeyPair) => {
      if (disposed || !pairs || pairs.get(event) !== pair) return false;
      return pairs.delete(event) && !disposed;
    },
    invalidate: (event: KeyboardEvent) => {
      if (disposed || !pairs || !invalid) return;
      pairs.delete(event);
      invalid.add(event);
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      pairs = null;
      active = null;
      invalid = null;
    },
  });
}

function createLayoutSegmentKeyListener(
  authority: LayoutSegmentKeyboardAuthority,
): LayoutSegmentKeyListener {
  const proofs = new WeakMap<KeyboardEvent, LayoutSegmentWindowProof>();
  const invalidEvents = new WeakSet<Event>();
  let publication: LayoutSegmentPublication | null = null;
  let active = false;
  let released = false;
  const listener: EventListener = function (this: EventTarget, event: Event) {
    const current = publication;
    if (
      !current
      || !active
      || released
      || current.ownerRealm !== authority.view
      || invalidEvents.has(event)
    ) {
      return;
    }
    if (proofs.has(event as KeyboardEvent)) {
      proofs.delete(event as KeyboardEvent);
      invalidEvents.add(event);
      return;
    }
    const eventTarget = authority.readTarget(event);
    if (
      !eventTarget
      || !layoutSegmentSnapshotContains(
        current.dom,
        eventTarget as Node,
      )
    ) {
      return;
    }
    const nativeEvent = event as KeyboardEvent;
    const facts = authority.readKeyboard(nativeEvent);
    const terminal = facts?.path.at(-1);
    if (
      !facts
      || facts.type !== "keydown"
      || facts.currentTarget !== this
      || terminal !== this
      || facts.phase !== authority.capturingPhase
      || facts.path.at(-2) !== current.ownerDocument
      || (facts.view !== null
        && facts.view !== authority.view
        && facts.view !== this)
    ) {
      invalidEvents.add(event);
      return;
    }
    proofs.set(nativeEvent, Object.freeze({
      registration,
      publication: current,
      nativeEvent,
      receiver: this,
      currentTarget: this,
      terminal,
      path: Object.freeze([...facts.path]),
    }));
  };
  const proofFor = (
    event: KeyboardEvent,
    current: LayoutSegmentPublication,
  ) => {
    const proof = proofs.get(event);
    if (
      !proof
      || !active
      || released
      || publication !== current
      || proof.registration !== registration
      || proof.publication !== current
      || proof.nativeEvent !== event
      || proof.receiver !== proof.currentTarget
      || proof.receiver !== proof.terminal
      || invalidEvents.has(event)
    ) {
      return null;
    }
    const facts = authority.readKeyboard(event);
    return (
      facts
      && facts.path.length === proof.path.length
      && facts.path.every((entry, index) => entry === proof.path[index])
      && facts.path.at(-2) === current.ownerDocument
      && facts.path.at(-1) === proof.receiver
    )
      ? proof
      : null;
  };
  const registration: LayoutSegmentKeyListener = Object.freeze({
    proofFor,
    retains: (
      proof: LayoutSegmentWindowProof,
      current: LayoutSegmentPublication,
    ) =>
      publication === current
      && proofFor(proof.nativeEvent, current) === proof
      && current.ownerRealm === authority.view
      && authority.addEventListener.isCurrent()
      && authority.removeEventListener.isCurrent(),
    activate: (current: LayoutSegmentPublication) => {
      if (
        publication
        || active
        || released
        || current.ownerRealm !== authority.view
        || !authority.addEventListener.isCurrent()
        || !authority.removeEventListener.isCurrent()
      ) {
        return false;
      }
      publication = current;
      active = true;
      try {
        authority.apply(
          authority.addEventListener.value,
          authority.view,
          ["keydown", listener, true],
        );
      } catch {
        publication = null;
        active = false;
        return false;
      }
      if (registration.isCurrent()) return true;
      publication = null;
      active = false;
      try {
        authority.apply(
          authority.removeEventListener.value,
          authority.view,
          ["keydown", listener, true],
        );
      } catch {
        return false;
      }
      return false;
    },
    release: (current: LayoutSegmentPublication) => {
      if (publication !== current || released) return;
      released = true;
      const wasActive = active;
      active = false;
      publication = null;
      if (!wasActive) return;
      try {
        authority.apply(
          authority.removeEventListener.value,
          authority.view,
          ["keydown", listener, true],
        );
      } catch {
        return;
      }
    },
    isCurrent: () =>
      active
      && !released
      && publication?.ownerRealm === authority.view
      && authority.addEventListener.isCurrent()
      && authority.removeEventListener.isCurrent(),
  });
  return registration;
}

function layoutSegmentNativeFactsMatch(
  previous: LayoutSegmentNativeKeyboardFacts,
  current: LayoutSegmentNativeKeyboardFacts,
  defaultPrevented = false,
) {
  return (
    previous.type === current.type
    && previous.currentTarget === current.currentTarget
    && previous.bubbles === current.bubbles
    && previous.cancelable === current.cancelable
    && current.defaultPrevented === defaultPrevented
    && previous.cancelBubble === current.cancelBubble
    && previous.target === current.target
    && previous.path.length === current.path.length
    && previous.path.every((entry, index) => entry === current.path[index])
    && previous.isTrusted === current.isTrusted
    && previous.timeStamp === current.timeStamp
    && previous.view === current.view
    && previous.composed === current.composed
    && previous.detail === current.detail
    && previous.key === current.key
    && previous.code === current.code
    && previous.location === current.location
    && previous.repeat === current.repeat
    && previous.composing === current.composing
    && previous.altKey === current.altKey
    && previous.ctrlKey === current.ctrlKey
    && previous.metaKey === current.metaKey
    && previous.shiftKey === current.shiftKey
    && previous.charCode === current.charCode
    && previous.keyCode === current.keyCode
    && previous.which === current.which
  );
}

function layoutSegmentReactMethodsRemainExact(
  event: React.KeyboardEvent<HTMLButtonElement>,
  methods: LayoutSegmentReactKeyboardMethods,
  currentIsDefaultPrevented: (...args: never[]) => unknown,
  expectedIsDefaultPrevented = methods.isDefaultPrevented,
) {
  return (
    event.preventDefault === methods.preventDefault
    && event.isDefaultPrevented === currentIsDefaultPrevented
    && event.isPropagationStopped === methods.isPropagationStopped
    && currentIsDefaultPrevented === expectedIsDefaultPrevented
  );
}

function captureLayoutSegmentReactKeyboard(
  event: React.KeyboardEvent<HTMLButtonElement>,
  publication: LayoutSegmentPublication,
  native: LayoutSegmentNativeKeyboardFacts,
  nativeEvent: KeyboardEvent,
  target: HTMLButtonElement,
  currentTarget: HTMLButtonElement,
  windowProof: LayoutSegmentWindowProof,
): LayoutSegmentReactKeyboardSnapshot | null {
  try {
    const wrapper = event;
    const preventDefault = wrapper.preventDefault;
    const isDefaultPrevented = wrapper.isDefaultPrevented;
    const isPropagationStopped = wrapper.isPropagationStopped;
    const composing = (
      wrapper as React.KeyboardEvent<HTMLButtonElement> & {
        isComposing?: unknown;
      }
    ).isComposing;
    const view = wrapper.view;
    if (
      typeof preventDefault !== "function"
      || typeof isDefaultPrevented !== "function"
      || typeof isPropagationStopped !== "function"
      || wrapper === (nativeEvent as unknown)
      || wrapper.nativeEvent !== nativeEvent
      || wrapper.type !== native.type
      || wrapper.type !== "keydown"
      || wrapper.target !== target
      || wrapper.currentTarget !== currentTarget
      || wrapper.eventPhase !== native.phase
      || wrapper.bubbles !== native.bubbles
      || wrapper.cancelable !== native.cancelable
      || wrapper.defaultPrevented !== native.defaultPrevented
      || wrapper.isTrusted !== native.isTrusted
      || wrapper.timeStamp !== native.timeStamp
      || wrapper.key !== native.key
      || wrapper.code !== native.code
      || wrapper.location !== native.location
      || wrapper.repeat !== native.repeat
      || (composing !== undefined && composing !== native.composing)
      || wrapper.altKey !== native.altKey
      || wrapper.ctrlKey !== native.ctrlKey
      || wrapper.metaKey !== native.metaKey
      || wrapper.shiftKey !== native.shiftKey
      || wrapper.detail !== native.detail
      || wrapper.charCode !== native.charCode
      || wrapper.keyCode !== native.keyCode
      || wrapper.which !== native.which
      || (view !== null
        && !Object.is(view, publication.ownerRealm)
        && !Object.is(view, windowProof.receiver))
    ) {
      return null;
    }
    const methods = Object.freeze({
      preventDefault,
      isDefaultPrevented,
      isPropagationStopped,
    });
    if (
      !layoutSegmentReactMethodsRemainExact(
        wrapper,
        methods,
        isDefaultPrevented,
      )
    ) {
      return null;
    }
    return Object.freeze({
      event: wrapper,
      nativeEvent,
      target,
      currentTarget,
      phase: native.phase,
      view,
      composing,
      methods,
    });
  } catch {
    return null;
  }
}

function layoutSegmentReactKeyboardRemainsExact(
  snapshot: LayoutSegmentReactKeyboardSnapshot,
  publication: LayoutSegmentPublication,
  native: LayoutSegmentNativeKeyboardFacts,
  currentTarget: HTMLButtonElement | null,
  defaultPrevented = false,
  expectedIsDefaultPrevented = snapshot.methods.isDefaultPrevented,
) {
  try {
    const event = snapshot.event;
    const currentIsDefaultPrevented = event.isDefaultPrevented;
    const composing = (
      event as React.KeyboardEvent<HTMLButtonElement> & {
        isComposing?: unknown;
      }
    ).isComposing;
    return (
      typeof currentIsDefaultPrevented === "function"
      && event.nativeEvent === snapshot.nativeEvent
      && event.type === native.type
      && event.target === snapshot.target
      && event.target === native.target
      && event.currentTarget === currentTarget
      && event.eventPhase === snapshot.phase
      && event.eventPhase === native.phase
      && event.bubbles === native.bubbles
      && event.cancelable === native.cancelable
      && event.defaultPrevented === defaultPrevented
      && event.isTrusted === native.isTrusted
      && event.timeStamp === native.timeStamp
      && event.key === native.key
      && event.code === native.code
      && event.location === native.location
      && event.repeat === native.repeat
      && composing === snapshot.composing
      && (composing === undefined || composing === native.composing)
      && event.altKey === native.altKey
      && event.ctrlKey === native.ctrlKey
      && event.metaKey === native.metaKey
      && event.shiftKey === native.shiftKey
      && event.detail === native.detail
      && event.charCode === native.charCode
      && event.keyCode === native.keyCode
      && event.which === native.which
      && event.view === snapshot.view
      && (event.view === null
        || Object.is(event.view, publication.ownerRealm)
        || Object.is(event.view, native.path.at(-1)))
      && layoutSegmentReactMethodsRemainExact(
        event,
        snapshot.methods,
        currentIsDefaultPrevented,
        expectedIsDefaultPrevented,
      )
    );
  } catch {
    return false;
  }
}

interface LayoutSegmentRowPresentation {
  readonly authority: LayoutSegmentRowAuthority;
  readonly captureButton: (element: HTMLButtonElement | null) => void;
  readonly captureIcon: (element: SVGSVGElement | null) => void;
  readonly buttonOwner: LayoutSegmentElementOwner<HTMLButtonElement>;
  readonly iconOwner: LayoutSegmentElementOwner<SVGSVGElement>;
  readonly keyboardAction: object;
  readonly onKeyDownCapture: (
    event: React.KeyboardEvent<HTMLButtonElement>,
  ) => void;
  readonly onKeyDown: (event: React.KeyboardEvent<HTMLButtonElement>) => void;
}

interface LayoutSegmentPresentation {
  readonly captureRoot: (element: HTMLDivElement | null) => void;
  readonly rows: readonly LayoutSegmentRowPresentation[];
  readonly establish: () => void | (() => void);
}

function layoutSegmentIconMatches(
  icon: SVGSVGElement,
  parent: HTMLButtonElement,
  iconName: string,
  size: number,
) {
  return (
    icon.isConnected
    && icon.ownerDocument === parent.ownerDocument
    && icon.parentElement === parent
    && parent.children.length === 1
    && parent.firstElementChild === icon
    && icon.tagName.toLowerCase() === "svg"
    && icon.classList.contains(`lucide-${iconName}`)
    && icon.getAttribute("width") === String(size)
    && icon.getAttribute("height") === String(size)
    && icon.getAttribute("aria-hidden") === "true"
  );
}

function createLayoutSegmentPresentation(
  authority: LayoutSegmentAuthority,
  coordinator: LayoutSegmentPublicationCoordinator,
  requestSuccessor: () => void,
): LayoutSegmentPresentation {
  let currentRuntime: LayoutSegmentPublicationRuntime | null = null;
  let lastRuntime: LayoutSegmentPublicationRuntime | null = null;
  let keyboardAuthority: LayoutSegmentKeyboardAuthority | null = null;
  let keyboardListener: LayoutSegmentKeyListener | null = null;
  let pairingStore: LayoutSegmentPairingStore | null = null;
  let successorRequested = false;
  let callbackActive = false;
  let committedLayout: Layout = authority.layout;
  let captureLayoutNavigation: (
    row: LayoutSegmentRowAuthority,
    event: React.KeyboardEvent<HTMLButtonElement>,
  ) => void = () => {};
  let completeLayoutNavigation: (
    row: LayoutSegmentRowAuthority,
    event: React.KeyboardEvent<HTMLButtonElement>,
  ) => void = () => {};
  const { mount, revision, layout, onLayout, rootClassName, rows } = authority;
  const disposePairingStore = () => {
    pairingStore?.dispose();
    pairingStore = null;
  };
  const releaseKeyboard = (publication: LayoutSegmentPublication) => {
    disposePairingStore();
    keyboardListener?.release(publication);
    keyboardAuthority = null;
    keyboardListener = null;
  };
  const onElementChange = (
    owner: LayoutSegmentElementOwnerView,
    element: Element | null,
    previous: Element | null,
    last: Element | null,
  ) => {
    const runtime = currentRuntime ?? lastRuntime;
    runtime?.noteRef(owner, element, previous);
    if (element === null || (element !== null && last !== null && element !== last)) {
      if (currentRuntime) releaseKeyboard(currentRuntime.publication);
      currentRuntime?.retireForElement();
      currentRuntime = null;
    }
    if (
      runtime?.isExactElementReplay()
      && coordinator.acceptsSuccessorOf(runtime.publication)
    ) {
      requestReplaySuccessor(runtime);
    }
  };
  const rootOwner = new LayoutSegmentElementOwner<HTMLDivElement>(onElementChange);
  const rowPresentations = rows.map((row) => {
    const buttonOwner = new LayoutSegmentElementOwner<HTMLButtonElement>(onElementChange);
    const iconOwner = new LayoutSegmentElementOwner<SVGSVGElement>(onElementChange);
    const keyboardAction = Object.freeze({
      identity: Symbol(`layout-segment-${row.value}-keyboard-action`),
    });
    const onKeyDownCapture = (
      event: React.KeyboardEvent<HTMLButtonElement>,
    ) => captureLayoutNavigation(row, event);
    const onKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) =>
      completeLayoutNavigation(row, event);
    return Object.freeze({
      authority: row,
      captureButton: buttonOwner.capture,
      captureIcon: iconOwner.capture,
      buttonOwner,
      iconOwner,
      keyboardAction,
      onKeyDownCapture,
      onKeyDown,
    });
  });
  const expectedOwners = () => Object.freeze([
    rootOwner,
    ...rowPresentations.flatMap(({ buttonOwner, iconOwner }) => [buttonOwner, iconOwner]),
  ]);
  const factsAreCurrent = () =>
    authority.mount === mount
    && authority.revision === revision
    && authority.layout === layout
    && authority.onLayout === onLayout
    && authority.rootClassName === rootClassName
    && authority.rows === rows
    && rootClassName === LAYOUT_SEGMENT_CLASS_NAME
    && rows.length === LAYOUT_SEGMENT_OPTIONS.length
    && rows.every((row, index) => {
      const option = LAYOUT_SEGMENT_OPTIONS[index];
      return Boolean(
        option
        && row.index === index
        && row.value === option.value
        && row.label === option.label
        && row.iconName === option.iconName
        && row.checked === (row.value === layout)
        && row.tabIndex === (row.checked ? 0 : -1)
        && row.className === cn(
          LAYOUT_SEGMENT_ROW_BASE_CLASS_NAME,
          row.checked
            ? LAYOUT_SEGMENT_ROW_ACTIVE_CLASS_NAME
            : LAYOUT_SEGMENT_ROW_INACTIVE_CLASS_NAME,
        )
        && row.size === 17
      );
    });
  const movementIsCurrent = (
    runtime: LayoutSegmentPublicationRuntime,
    publication: LayoutSegmentPublication,
    sourceRow: LayoutSegmentRowPresentation,
    destinationRow: LayoutSegmentRowPresentation,
    source: HTMLButtonElement,
    destination: HTMLButtonElement,
    key: string,
    expectedLayout: Layout,
  ) => {
    const events = keyboardAuthority;
    const listener = keyboardListener;
    const destinationIndex = layoutSegmentDestination(
      key,
      sourceRow.authority.index,
      rows.length,
    );
    return Boolean(
      events
      && listener
      && currentRuntime === runtime
      && !runtime.publication.isRetired()
      && publication === runtime.publication
      && publication.authority === authority
      && publication.ownerDocument.defaultView === publication.ownerRealm
      && authority.layout === layout
      && authority.onLayout === onLayout
      && committedLayout === expectedLayout
      && sourceRow.authority === rows[sourceRow.authority.index]
      && destinationRow.authority === rows[destinationRow.authority.index]
      && sourceRow.authority.checked
      && sourceRow.authority.value === layout
      && sourceRow.authority.tabIndex === 0
      && !destinationRow.authority.checked
      && destinationRow.authority.value !== layout
      && destinationRow.authority.tabIndex === -1
      && destinationIndex === destinationRow.authority.index
      && sourceRow.buttonOwner.element() === source
      && destinationRow.buttonOwner.element() === destination
      && source.ownerDocument === publication.ownerDocument
      && destination.ownerDocument === publication.ownerDocument
      && source.parentElement === publication.root
      && destination.parentElement === publication.root
      && publication.root.children.item(sourceRow.authority.index) === source
      && publication.root.children.item(destinationRow.authority.index) === destination
      && events.activeElement() === source
      && events.focus.isCurrent()
      && listener.isCurrent()
      && coordinator.isCurrent(publication)
      && factsAreCurrent()
      && exactDomIsCurrent()
      && publication.publishedDomMatches()
    );
  };
  const publicationAllowsEventAbort = (
    pairs: LayoutSegmentPairingStore,
    runtime: LayoutSegmentPublicationRuntime,
    publication: LayoutSegmentPublication,
    listener: LayoutSegmentKeyListener,
    pair: LayoutSegmentKeyPair,
  ) =>
    pairingStore === pairs
    && !pairs.isDisposed()
    && currentRuntime === runtime
    && runtime.publication === publication
    && pair.publication === publication
    && pair.action === pair.sourceRow.keyboardAction
    && rowPresentations[pair.sourceRow.authority.index] === pair.sourceRow
    && rowPresentations[pair.destinationRow.authority.index]
      === pair.destinationRow
    && listener.retains(pair.windowProof, publication)
    && movementIsCurrent(
      runtime,
      publication,
      pair.sourceRow,
      pair.destinationRow,
      pair.source,
      pair.destination,
      pair.key,
      committedLayout,
    );
  const invokeReactMethod = (
    events: LayoutSegmentKeyboardAuthority,
    method: (...args: never[]) => unknown,
    event: React.KeyboardEvent<HTMLButtonElement>,
  ) => {
    if (callbackActive) return null;
    callbackActive = true;
    try {
      return Object.freeze({ value: events.apply(method, event, []) });
    } catch {
      return null;
    } finally {
      callbackActive = false;
    }
  };
  const invokeLayout = (value: LayoutSegmentPane) => {
    if (callbackActive) return false;
    callbackActive = true;
    try {
      onLayout(value);
      return true;
    } catch {
      return false;
    } finally {
      callbackActive = false;
    }
  };
  const exactDomIsCurrent = () => {
    const root = rootOwner.element();
    return (
      !!root
      && root.isConnected
      && root.ownerDocument.defaultView !== null
      && root.tagName === "DIV"
      && root.getAttribute("class") === rootClassName
      && root.getAttribute("role") === "radiogroup"
      && root.getAttribute("aria-label") === "Pane"
      && root.dataset.testid === "layout-segment"
      && root.children.length === LAYOUT_SEGMENT_OPTIONS.length
      && root.childNodes.length === LAYOUT_SEGMENT_OPTIONS.length
      && rowPresentations.every((presentation, index) => {
        const row = presentation.authority;
        const button = presentation.buttonOwner.element();
        const icon = presentation.iconOwner.element();
        return (
          rows[index] === row
          && !!button
          && !!icon
          && button.isConnected
          && button.ownerDocument === root.ownerDocument
          && button.tagName === "BUTTON"
          && button.parentElement === root
          && root.children.item(index) === button
          && root.childNodes.item(index) === button
          && button.getAttribute("type") === "button"
          && button.type === "button"
          && !button.disabled
          && !button.matches(":disabled")
          && button.getAttribute("role") === "radio"
          && button.getAttribute("aria-checked") === String(row.checked)
          && button.getAttribute("aria-label") === row.label
          && button.getAttribute("title") === row.label
          && button.tabIndex === row.tabIndex
          && button.getAttribute("tabindex") === String(row.tabIndex)
          && button.getAttribute("class") === row.className
          && button.dataset.testid === `layout-segment-${row.value}`
          && button.childNodes.length === 1
          && layoutSegmentIconMatches(icon, button, row.iconName, row.size)
        );
      })
    );
  };
  captureLayoutNavigation = (
    row: LayoutSegmentRowAuthority,
    event: React.KeyboardEvent<HTMLButtonElement>,
  ) => {
    const pairs = pairingStore;
    if (!pairs || pairs.isDisposed() || callbackActive) return;
    let nativeEvent: KeyboardEvent;
    let eventCurrentTarget: EventTarget | null;
    try {
      nativeEvent = event.nativeEvent;
      eventCurrentTarget = event.currentTarget;
    } catch {
      return;
    }
    if (
      !nativeEvent
      || typeof nativeEvent !== "object"
      || pairs.isInvalid(nativeEvent)
      || pairs.has(nativeEvent)
    ) {
      return;
    }
    const runtime = currentRuntime;
    const publication = runtime?.publication;
    const events = keyboardAuthority;
    const listener = keyboardListener;
    const sourceRow = rowPresentations[row.index];
    const source = sourceRow?.buttonOwner.element();
    if (
      !runtime
      || !publication
      || !events
      || !listener
      || !sourceRow
      || !source
      || runtime.publication.isRetired()
      || sourceRow.authority !== row
      || sourceRow.keyboardAction
        !== rowPresentations[sourceRow.authority.index]?.keyboardAction
      || eventCurrentTarget !== source
    ) {
      return;
    }
    const native = events.readKeyboard(nativeEvent);
    const proof = native
      ? listener.proofFor(nativeEvent, publication)
      : null;
    const destinationIndex = native
      ? layoutSegmentDestination(native.key, row.index, rows.length)
      : null;
    const destinationRow = destinationIndex === null
      ? undefined
      : rowPresentations[destinationIndex];
    const destination = destinationRow?.buttonOwner.element();
    const capture = native && proof && destinationRow && destination
      ? captureLayoutSegmentReactKeyboard(
          event,
          publication,
          native,
          nativeEvent,
          source,
          source,
          proof,
        )
      : null;
    const nativeCurrentTarget = native?.currentTarget;
    if (
      !native
      || !proof
      || destinationIndex === null
      || !destinationRow
      || !destination
      || !capture
      || native.type !== "keydown"
      || native.phase !== events.capturingPhase
      || !native.bubbles
      || !native.cancelable
      || native.defaultPrevented
      || native.cancelBubble
      || !native.isTrusted
      || !native.composed
      || native.repeat
      || native.composing
      || native.altKey
      || native.ctrlKey
      || native.metaKey
      || native.shiftKey
      || native.target !== source
      || !(nativeCurrentTarget instanceof events.view.Node)
      || nativeCurrentTarget.ownerDocument !== publication.ownerDocument
      || !nativeCurrentTarget.contains(publication.root)
      || native.path[0] !== source
      || native.path.filter((entry) => entry === source).length !== 1
      || !native.path.includes(publication.root)
      || native.path.at(-1) !== proof.receiver
      || (native.view !== null
        && native.view !== publication.ownerRealm
        && native.view !== proof.receiver)
      || destinationRow.authority !== rows[destinationIndex]
      || coordinator.hasClaimed(
        publication,
        sourceRow.keyboardAction,
        capture.event,
        nativeEvent,
      )
      || !movementIsCurrent(
        runtime,
        publication,
        sourceRow,
        destinationRow,
        source,
        destination,
        native.key,
        layout,
      )
    ) {
      return;
    }
    const captureIsCurrent = () => {
      const currentNative = events.readKeyboard(nativeEvent);
      return Boolean(
        currentNative
        && currentNative.phase === events.capturingPhase
        && layoutSegmentNativeFactsMatch(native, currentNative)
        && listener.retains(proof, publication)
        && layoutSegmentReactKeyboardRemainsExact(
          capture,
          publication,
          native,
          source,
        )
        && pairingStore === pairs
        && !pairs.isDisposed()
        && !pairs.has(nativeEvent)
        && !callbackActive
        && movementIsCurrent(
          runtime,
          publication,
          sourceRow,
          destinationRow,
          source,
          destination,
          native.key,
          layout,
        )
      );
    };
    if (!captureIsCurrent()) return;
    const defaultResult = invokeReactMethod(
      events,
      capture.methods.isDefaultPrevented,
      capture.event,
    );
    if (defaultResult?.value !== false || !captureIsCurrent()) return;
    const propagationResult = invokeReactMethod(
      events,
      capture.methods.isPropagationStopped,
      capture.event,
    );
    if (propagationResult?.value !== false || !captureIsCurrent()) return;
    const movement = Object.freeze<LayoutSegmentMovement>({
      identity: Symbol("layout-segment-keyboard-movement"),
      publication,
      sourceRow,
      destinationRow,
      source,
      destination,
      key: native.key,
    });
    pairs.stage(nativeEvent, Object.freeze({
      publication,
      action: sourceRow.keyboardAction,
      native,
      nativeEvent,
      capture,
      windowProof: proof,
      sourceRow,
      destinationRow,
      source,
      destination,
      key: native.key,
      movement,
      publicationClaim: Object.freeze({ publication }),
      sourceClaim: Object.freeze({ sourceRow, source }),
      destinationClaim: Object.freeze({ destinationRow, destination }),
      captureClaim: Object.freeze({ capture }),
      nativeClaim: Object.freeze({ nativeEvent }),
      windowClaim: Object.freeze({ listener, proof, receiver: proof.receiver }),
    }));
  };
  completeLayoutNavigation = (
    row: LayoutSegmentRowAuthority,
    event: React.KeyboardEvent<HTMLButtonElement>,
  ) => {
    const pairs = pairingStore;
    if (!pairs || pairs.isDisposed() || callbackActive) return;
    let nativeEvent: KeyboardEvent;
    let eventCurrentTarget: EventTarget | null;
    try {
      nativeEvent = event.nativeEvent;
      eventCurrentTarget = event.currentTarget;
    } catch {
      return;
    }
    if (
      !nativeEvent
      || typeof nativeEvent !== "object"
      || pairs.isInvalid(nativeEvent)
    ) {
      return;
    }
    const pair = pairs.get(nativeEvent);
    if (!pair || pair.nativeEvent !== nativeEvent) return;
    const runtime = currentRuntime;
    const publication = runtime?.publication;
    const events = keyboardAuthority;
    const listener = keyboardListener;
    if (
      !runtime
      || !publication
      || !events
      || !listener
      || pair.publication !== publication
      || pair.sourceRow.authority !== row
      || pair.action !== pair.sourceRow.keyboardAction
      || pair.source !== eventCurrentTarget
      || !pairs.begin(nativeEvent, pair)
    ) {
      return;
    }
    let delivery: LayoutSegmentKeyDelivery | null = null;
    let claimed = false;
    let committed = false;
    try {
      const native = events.readKeyboard(nativeEvent);
      const proof = native
        ? listener.proofFor(nativeEvent, publication)
        : null;
      const bubble = native && proof
        ? captureLayoutSegmentReactKeyboard(
            event,
            publication,
            native,
            nativeEvent,
            pair.source,
            pair.source,
            proof,
          )
        : null;
      if (
        !native
        || !proof
        || !bubble
        || bubble.event === pair.capture.event
        || native.phase !== events.bubblingPhase
        || pair.native.phase !== events.capturingPhase
        || native.currentTarget !== pair.native.currentTarget
        || proof !== pair.windowProof
        || proof.receiver !== native.path.at(-1)
        || !layoutSegmentNativeFactsMatch(pair.native, native)
      ) {
        return;
      }
      const deliveryIsCurrent = (
        currentNative: LayoutSegmentNativeKeyboardFacts,
        expectedLayout: Layout,
        defaultPrevented = false,
        activeDelivery: LayoutSegmentKeyDelivery | null = null,
        bubbleDefault = bubble.methods.isDefaultPrevented,
      ) => Boolean(
        pairingStore === pairs
        && !pairs.isDisposed()
        && !callbackActive
        && listener.retains(pair.windowProof, publication)
        && (!activeDelivery
          || coordinator.deliveryIsActive(activeDelivery))
        && layoutSegmentNativeFactsMatch(
          pair.native,
          currentNative,
          defaultPrevented,
        )
        && currentNative.phase === events.bubblingPhase
        && layoutSegmentReactKeyboardRemainsExact(
          pair.capture,
          publication,
          pair.native,
          null,
        )
        && layoutSegmentReactKeyboardRemainsExact(
          bubble,
          publication,
          currentNative,
          pair.source,
          defaultPrevented,
          bubbleDefault,
        )
        && movementIsCurrent(
          runtime,
          publication,
          pair.sourceRow,
          pair.destinationRow,
          pair.source,
          pair.destination,
          pair.key,
          expectedLayout,
        )
      );
      const cancellationIsCurrent = (
        snapshot: LayoutSegmentReactKeyboardSnapshot,
        property: "isDefaultPrevented" | "isPropagationStopped",
        expectedMethod: (...args: never[]) => unknown,
        expected: boolean,
        currentNative: LayoutSegmentNativeKeyboardFacts,
        expectedLayout: Layout,
        activeDelivery: LayoutSegmentKeyDelivery | null = null,
        bubbleDefault = bubble.methods.isDefaultPrevented,
      ) => {
        if (
          !deliveryIsCurrent(
            currentNative,
            expectedLayout,
            currentNative.defaultPrevented,
            activeDelivery,
            bubbleDefault,
          )
        ) {
          return false;
        }
        let method: unknown;
        try {
          method = snapshot.event[property];
        } catch {
          return false;
        }
        if (
          !isLayoutSegmentReactMethod(method)
          || method !== expectedMethod
          || !deliveryIsCurrent(
            currentNative,
            expectedLayout,
            currentNative.defaultPrevented,
            activeDelivery,
            bubbleDefault,
          )
        ) {
          return false;
        }
        const result = invokeReactMethod(events, method, snapshot.event);
        const after = events.readKeyboard(nativeEvent);
        let currentMethod: unknown;
        try {
          currentMethod = snapshot.event[property];
        } catch {
          return false;
        }
        return Boolean(
          result?.value === expected
          && after
          && currentMethod === method
          && deliveryIsCurrent(
            after,
            expectedLayout,
            currentNative.defaultPrevented,
            activeDelivery,
            bubbleDefault,
          )
        );
      };
      const wrappersAreCurrent = (
        currentNative: LayoutSegmentNativeKeyboardFacts,
        expectedLayout: Layout,
        activeDelivery: LayoutSegmentKeyDelivery | null = null,
        bubbleDefault = bubble.methods.isDefaultPrevented,
      ) => {
        if (
          !deliveryIsCurrent(
            currentNative,
            expectedLayout,
            currentNative.defaultPrevented,
            activeDelivery,
            bubbleDefault,
          )
        ) {
          return false;
        }
        return (
          cancellationIsCurrent(
            pair.capture,
            "isDefaultPrevented",
            pair.capture.methods.isDefaultPrevented,
            false,
            currentNative,
            expectedLayout,
            activeDelivery,
            bubbleDefault,
          )
          && cancellationIsCurrent(
            pair.capture,
            "isPropagationStopped",
            pair.capture.methods.isPropagationStopped,
            false,
            currentNative,
            expectedLayout,
            activeDelivery,
            bubbleDefault,
          )
          && cancellationIsCurrent(
            bubble,
            "isDefaultPrevented",
            bubbleDefault,
            currentNative.defaultPrevented,
            currentNative,
            expectedLayout,
            activeDelivery,
            bubbleDefault,
          )
          && cancellationIsCurrent(
            bubble,
            "isPropagationStopped",
            bubble.methods.isPropagationStopped,
            false,
            currentNative,
            expectedLayout,
            activeDelivery,
            bubbleDefault,
          )
        );
      };
      if (
        !deliveryIsCurrent(native, layout)
        || !wrappersAreCurrent(native, layout)
      ) {
        return;
      }
      delivery = Object.freeze<LayoutSegmentKeyDelivery>({ pair, bubble });
      if (
        !coordinator.claimDelivery(
          publication,
          pair.action,
          [pair.capture.event, bubble.event, pair.nativeEvent],
          [
            pair.movement,
            pair.windowProof,
            pair.publicationClaim,
            pair.sourceClaim,
            pair.destinationClaim,
            pair.captureClaim,
            pair.nativeClaim,
            pair.windowClaim,
          ],
          delivery,
        )
        || !deliveryIsCurrent(native, layout, false, delivery)
        || !wrappersAreCurrent(native, layout, delivery)
        || !pairs.consume(nativeEvent, pair)
        || !deliveryIsCurrent(native, layout, false, delivery)
      ) {
        pairs.invalidate(nativeEvent);
        return;
      }
      claimed = true;
      const prevention = invokeReactMethod(
        events,
        bubble.methods.preventDefault,
        bubble.event,
      );
      const preventedNative = events.readKeyboard(nativeEvent);
      let postPreventionBubbleDefault: unknown;
      try {
        postPreventionBubbleDefault = bubble.event.isDefaultPrevented;
      } catch {
        return;
      }
      if (
        !prevention
        || !preventedNative
        || !isLayoutSegmentReactMethod(postPreventionBubbleDefault)
        || !deliveryIsCurrent(
          preventedNative,
          layout,
          true,
          delivery,
          postPreventionBubbleDefault,
        )
        || !wrappersAreCurrent(
          preventedNative,
          layout,
          delivery,
          postPreventionBubbleDefault,
        )
      ) {
        return;
      }
      if (
        !deliveryIsCurrent(
          preventedNative,
          layout,
          true,
          delivery,
          postPreventionBubbleDefault,
        )
        || !invokeLayout(pair.destinationRow.authority.value)
      ) {
        return;
      }
      committedLayout = pair.destinationRow.authority.value;
      const selectedNative = events.readKeyboard(nativeEvent);
      if (
        !selectedNative
        || !deliveryIsCurrent(
          selectedNative,
          committedLayout,
          true,
          delivery,
          postPreventionBubbleDefault,
        )
        || !wrappersAreCurrent(
          selectedNative,
          committedLayout,
          delivery,
          postPreventionBubbleDefault,
        )
        || !deliveryIsCurrent(
          selectedNative,
          committedLayout,
          true,
          delivery,
          postPreventionBubbleDefault,
        )
      ) {
        return;
      }
      events.focus.invoke(pair.destination, { preventScroll: true });
      if (!coordinator.commitDelivery(delivery)) return;
      committed = true;
    } finally {
      pairs.finish(nativeEvent, pair);
      if (delivery) coordinator.finishDelivery(delivery);
      if (claimed && !committed) {
        pairs.invalidate(nativeEvent);
        if (
          currentRuntime === runtime
          && !publicationAllowsEventAbort(
            pairs,
            runtime,
            publication,
            listener,
            pair,
          )
        ) {
          releaseKeyboard(publication);
          runtime.retireForElement();
          currentRuntime = null;
          if (!successorRequested) {
            successorRequested = true;
            requestSuccessor();
          }
        }
      }
    }
  };
  const requestReplaySuccessor = (runtime: LayoutSegmentPublicationRuntime) => {
    const replay = runtime.replay();
    if (
      successorRequested
      || !replay
      || !coordinator.acceptsSuccessorOf(runtime.publication)
      || !factsAreCurrent()
      || !exactDomIsCurrent()
      || !runtime.publication.publishedDomMatches()
      || !coordinator.stageReplay(replay)
    ) {
      return;
    }
    successorRequested = true;
    requestSuccessor();
  };
  const establish = () => {
    if (lastRuntime) {
      if (
        (lastRuntime.isExactLayoutReplay() || lastRuntime.isExactElementReplay())
        && coordinator.acceptsSuccessorOf(lastRuntime.publication)
      ) {
        requestReplaySuccessor(lastRuntime);
      }
      return undefined;
    }
    if (!factsAreCurrent() || !exactDomIsCurrent()) return undefined;
    const root = rootOwner.element();
    if (
      !root
      || !layoutSegmentReplayAllowsPublication(coordinator, authority, root)
    ) {
      return undefined;
    }
    const runtime = createLayoutSegmentPublicationRuntime(
      authority,
      coordinator,
      root,
      expectedOwners(),
    );
    currentRuntime = runtime;
    lastRuntime = runtime;
    keyboardAuthority = captureLayoutSegmentKeyboardAuthority(runtime.publication);
    keyboardListener = keyboardAuthority
      ? createLayoutSegmentKeyListener(keyboardAuthority)
      : null;
    if (
      !keyboardAuthority
      || !keyboardListener
      || !runtime.publish()
      || !keyboardListener.activate(runtime.publication)
    ) {
      keyboardListener?.release(runtime.publication);
      runtime.retireForElement();
      currentRuntime = null;
      keyboardAuthority = null;
      keyboardListener = null;
      return undefined;
    }
    pairingStore = createLayoutSegmentPairingStore();
    return () => {
      releaseKeyboard(runtime.publication);
      runtime.retireForLayout();
    };
  };

  return Object.freeze({
    captureRoot: rootOwner.capture,
    rows: Object.freeze(rowPresentations),
    establish,
  });
}

/** Preview | Markdown switch shown in the header below `md`; the status-bar menu covers wider windows. */
export function LayoutSegment({ layout, onLayout }: { layout: Layout; onLayout: (l: Layout) => void }) {
  const [mount] = useState(() => Symbol("layout segment"));
  const [coordinator] = useState(
    () => new LayoutSegmentPublicationCoordinator(mount),
  );
  const [presentationCache] = useState(
    () => new LayoutSegmentPresentationCache(),
  );
  const [publicationRevision, setPublicationRevision] = useState(0);
  const requestPublicationSuccessor = useCallback(() => {
    setPublicationRevision((revision) => revision + 1);
  }, []);
  const candidateRows = Object.freeze(
    LAYOUT_SEGMENT_OPTIONS.map((option, index) => {
      const checked = option.value === layout;
      return Object.freeze({
        index,
        value: option.value,
        label: option.label,
        iconName: option.iconName,
        checked,
        tabIndex: checked ? 0 as const : -1 as const,
        className: cn(
          LAYOUT_SEGMENT_ROW_BASE_CLASS_NAME,
          checked
            ? LAYOUT_SEGMENT_ROW_ACTIVE_CLASS_NAME
            : LAYOUT_SEGMENT_ROW_INACTIVE_CLASS_NAME,
        ),
        size: 17,
      });
    }),
  );
  const candidate: LayoutSegmentAuthority = Object.freeze({
    mount,
    revision: publicationRevision,
    layout,
    onLayout,
    rootClassName: LAYOUT_SEGMENT_CLASS_NAME,
    rows: candidateRows,
  });
  const presentation = presentationCache.resolve(
    candidate,
    publicationRevision,
    () => createLayoutSegmentPresentation(
      candidate,
      coordinator,
      requestPublicationSuccessor,
    ),
  );
  useLayoutEffect(() => presentation.establish(), [presentation]);
  const { captureRoot, rows } = presentation;

  return (
    <div ref={captureRoot} className={LAYOUT_SEGMENT_CLASS_NAME} role="radiogroup" aria-label="Pane" data-testid="layout-segment">
      {rows.map((row) => {
        const option = LAYOUT_SEGMENT_OPTIONS[row.authority.index];
        if (!option) return null;
        return (
          <button
            ref={row.captureButton}
            key={row.authority.value}
            type="button"
            role="radio"
            aria-checked={row.authority.checked}
            aria-label={row.authority.label}
            title={row.authority.label}
            tabIndex={row.authority.tabIndex}
            className={row.authority.className}
            onClick={() => onLayout(row.authority.value)}
            onKeyDownCapture={row.onKeyDownCapture}
            onKeyDown={row.onKeyDown}
            data-testid={`layout-segment-${row.authority.value}`}
          >
            <option.Icon ref={row.captureIcon} size={row.authority.size} />
          </button>
        );
      })}
    </div>
  );
}

/** Menu entry text for a GitHub action; says why it is disabled when the server has no GitHub OAuth app (#162). */
function GitHubEntryLabel({ configured, children }: { configured: boolean; children: React.ReactNode }) {
  if (configured) return <>{children}</>;
  return (
    <span className="flex flex-col">
      <span>{children}</span>
      <span className="text-xs text-ink-3">{GITHUB_NOT_CONFIGURED}</span>
    </span>
  );
}

/** Marks the plain Publish button that stands in the status chip's place until the first status arrives. */
const STATUS_CHIP_PLACE = "data-status-chip-place";

/** What one press on the status chip does, per sync status. */
function statusChipAction(status: SyncStatusDto["status"]): "publish" | "pull" | "sync" {
  if (status === "remote-ahead") return "pull";
  if (status === "diverged" || status === "remote-unreadable") return "sync";
  return "publish";
}

const STATUS_CHIP_LABELS: Record<SyncStatusDto["status"], string> = {
  "in-sync": "Up to date",
  "local-ahead": "Publish",
  "remote-ahead": "Pull",
  diverged: "Both changed",
  "remote-unreadable": SYNC_LABELS["remote-unreadable"],
};

/**
 * The status chip of a document linked to GitHub. It stands where the Publish button is otherwise, says
 * how the document and its GitHub file compare, and one press does what that calls for: commit (or
 * update the gist), pull, or open Sync.
 *
 * A plain button. A press runs the action of the status in this render, which is the label on screen
 * when it lands. A status that has gone stale by then is caught by the server: it refuses the publish or
 * the pull, and the editor opens Sync on its own, with its choices off.
 *
 * While a publish or a pull runs the chip is `aria-disabled`, not `disabled`: a disabled button drops
 * focus to the page under the key that pressed it. A press on a chip that is off does nothing.
 */
export function PublishStatusButton({
  sync,
  publishing,
  onPublishNow,
  onPull,
  onSync,
}: Pick<HeaderProps, "sync" | "publishing" | "onPublishNow" | "onPull" | "onSync"> & { sync: SyncStatusDto }) {
  const action = statusChipAction(sync.status);
  // A held Enter is one press: without this its repeats would press the chip again as soon as the request has ended.
  const enterOnRelease = useEnterOnRelease();
  // A press can put a dialog over the chip, and a click on the page behind a dialog closes it. So the chip's
  // place is kept for the rest of the pointer gesture; the box goes when focus is back on the chip.
  const hold = usePlaceHold(true);
  // The chip takes the place of the plain Publish button when the first status arrives. That button opens
  // the Publish menu, and focus that was on it would fall to the page with it. It goes to the arrow beside
  // the chip instead, which opens the same menu: a key aimed at Publish must not press the chip, whose
  // press pulls or publishes. Focus anywhere else is left alone. Read while this render is pending: once
  // React commits, the button is gone and focus is on <body>.
  const [replacesFocused] = useState(() => typeof document !== "undefined" && !!document.activeElement?.hasAttribute(STATUS_CHIP_PLACE));
  const button = useRef<HTMLButtonElement | null>(null);
  useLayoutEffect(() => {
    const beside = button.current?.nextElementSibling;
    // An arrow that is disabled does not take focus: it then stays where the browser left it.
    if (replacesFocused && document.activeElement === document.body && beside instanceof HTMLElement) beside.focus({ preventScroll: true });
  }, [replacesFocused]);

  const onClick = (event: React.MouseEvent<HTMLButtonElement>) => {
    // The second click of a double-click, or of a double tap, is not a second press.
    if (publishing || event.detail > 1) return;
    hold.arm(event, event.currentTarget);
    if (action === "pull") onPull();
    else if (action === "sync") onSync();
    else onPublishNow();
  };

  return (
    <>
      <button
        ref={button}
        type="button"
        className="btn btn-primary gap-1.5 rounded-r-none pl-3 pr-3 aria-disabled:cursor-default aria-disabled:opacity-50 aria-disabled:hover:bg-accent"
        aria-disabled={publishing || undefined}
        data-testid="publish-button"
        title={SYNC_LABELS[sync.status]}
        onClick={onClick}
        onFocus={hold.disarm}
        onKeyDown={enterOnRelease.onKeyDown}
        onKeyUp={enterOnRelease.onKeyUp}
        onBlur={enterOnRelease.onBlur}
      >
        {publishing ? (
          <Loader2 size={16} className="animate-spin" />
        ) : sync.status === "remote-ahead" ? (
          <RefreshCw size={15} />
        ) : sync.status === "diverged" ? (
          <GitMerge size={15} />
        ) : sync.status === "remote-unreadable" ? (
          <AlertTriangle size={15} className="text-amber-200" />
        ) : (
          <span aria-hidden className={cn("inline-block h-2 w-2 rounded-full", sync.status === "in-sync" ? "bg-emerald-300" : "bg-amber-300")} />
        )}
        <span data-testid="publish-status" data-status={sync.status}>
          {STATUS_CHIP_LABELS[sync.status]}
        </span>
      </button>
      {hold.shield}
    </>
  );
}

type PublishMenuActionName =
  | "publish"
  | "pull"
  | "sync"
  | "open"
  | "change"
  | "connect"
  | "download"
  | "share";
type PublishMenuArrowKey = "ArrowDown" | "ArrowUp";
type PublishMenuNativeGetter = (this: object) => unknown;
type PublishMenuNativeMethod = (this: object, ...args: unknown[]) => unknown;

interface PublishMenuVisit {
  readonly mount: symbol;
  readonly session: CollabSession;
  readonly document: DocumentDto;
}

interface PublishMenuState {
  readonly visit: PublishMenuVisit;
  readonly open: boolean;
}

interface PublishMenuAction {
  readonly identity: object;
  readonly name: PublishMenuActionName;
  readonly enabled: boolean;
  readonly label: string;
  readonly callback: unknown;
}

interface PublishMenuRender {
  readonly identity: object;
  readonly visit: PublishMenuVisit;
  readonly props: HeaderProps;
  readonly session: CollabSession;
  readonly document: DocumentDto;
  readonly documentFields: readonly (readonly [string, unknown])[];
  readonly sync: SyncStatusDto | null;
  readonly syncFields: string | null;
  readonly role: CollabSession["role"];
  readonly linked: boolean;
  readonly canEdit: boolean;
  readonly isOwner: boolean;
  readonly githubConfigured: boolean;
  readonly publishing: boolean;
  readonly open: boolean;
  readonly actions: readonly PublishMenuAction[];
  readonly enabledActions: readonly PublishMenuAction[];
}

interface PublishMenuDom {
  readonly trigger: HTMLButtonElement;
  readonly content: HTMLDivElement | null;
  readonly actions: Readonly<Record<PublishMenuActionName, HTMLDivElement | null>>;
}

interface PublishMenuCapturedDescriptor {
  readonly owner: object;
  readonly property: PropertyKey;
  readonly descriptor: PropertyDescriptor;
  readonly isCurrent: () => boolean;
}

interface PublishMenuTrustedAuthority {
  readonly read: (event: object) => boolean;
  readonly matches: (event: object) => boolean;
  readonly isCurrent: () => boolean;
}

interface PublishMenuKeyboardAuthority {
  readonly ownerDocument: Document;
  readonly ownerWindow: Window & typeof globalThis;
  readonly customEventPrototype: object;
  readonly keyboardPrototype: object;
  readonly getOwnPropertyDescriptor: typeof Object.getOwnPropertyDescriptor;
  readonly getPrototypeOf: typeof Object.getPrototypeOf;
  readonly apply: typeof Reflect.apply;
  readonly trusted: PublishMenuTrustedAuthority;
  readonly event: Readonly<{
    type: PublishMenuNativeGetter;
    target: PublishMenuNativeGetter;
    currentTarget: PublishMenuNativeGetter;
    eventPhase: PublishMenuNativeGetter;
    bubbles: PublishMenuNativeGetter;
    cancelable: PublishMenuNativeGetter;
    defaultPrevented: PublishMenuNativeGetter;
    cancelBubble: PublishMenuNativeGetter;
    composed: PublishMenuNativeGetter;
    timeStamp: PublishMenuNativeGetter;
    composedPath: PublishMenuNativeMethod;
    preventDefault: PublishMenuNativeMethod;
  }>;
  readonly keyboard: Readonly<{
    key: PublishMenuNativeGetter;
    code: PublishMenuNativeGetter;
    location: PublishMenuNativeGetter;
    altKey: PublishMenuNativeGetter;
    ctrlKey: PublishMenuNativeGetter;
    metaKey: PublishMenuNativeGetter;
    shiftKey: PublishMenuNativeGetter;
    repeat: PublishMenuNativeGetter;
    isComposing: PublishMenuNativeGetter;
  }>;
  readonly ui: Readonly<{
    detail: PublishMenuNativeGetter;
    view: PublishMenuNativeGetter;
  }>;
  readonly activeElement: PublishMenuNativeGetter;
  readonly focus: PublishMenuNativeMethod;
  readonly addEventListener: PublishMenuNativeMethod;
  readonly removeEventListener: PublishMenuNativeMethod;
  readonly historyIsClean: () => boolean;
}

interface PublishMenuArrowAction {
  readonly identity: object;
  readonly publicationIdentity: object;
  readonly key: PublishMenuArrowKey;
  readonly destination: "first" | "last";
  readonly target: PublishMenuAction | null;
}

type PublishMenuKeyboardListener = (this: EventTarget, event: Event) => void;

interface PublishMenuKeyboardListenerRegistration {
  readonly identity: object;
  readonly publicationIdentity: object;
  readonly target: Window & typeof globalThis;
  readonly listener: PublishMenuKeyboardListener;
  readonly capture: true;
  readonly isCurrent: () => boolean;
}

interface PublishMenuNativeListenerProof {
  readonly publication: PublishMenuPublication;
  readonly registration: PublishMenuKeyboardListenerRegistration;
  readonly event: KeyboardEvent;
  readonly receiver: EventTarget;
  readonly currentTarget: EventTarget;
  readonly terminal: EventTarget;
  readonly eventPhase: number;
}

interface PublishMenuNativeSnapshot {
  readonly event: KeyboardEvent;
  readonly publication: PublishMenuPublication;
  readonly action: PublishMenuArrowAction;
  readonly listenerProof: PublishMenuNativeListenerProof;
  readonly path: readonly EventTarget[];
  readonly type: string;
  readonly target: EventTarget | null;
  readonly currentTarget: EventTarget | null;
  readonly eventPhase: number;
  readonly bubbles: boolean;
  readonly cancelable: boolean;
  readonly defaultPrevented: boolean;
  readonly cancelBubble: boolean;
  readonly composed: boolean;
  readonly timeStamp: number;
  readonly key: PublishMenuArrowKey;
  readonly code: string;
  readonly location: number;
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
  readonly repeat: boolean;
  readonly isComposing: boolean;
  readonly detail: number;
  readonly view: Window | null;
  readonly isTrusted: true;
}

interface PublishMenuReactProof {
  readonly event: React.KeyboardEvent<HTMLButtonElement>;
  readonly phase: "capture" | "bubble";
  readonly preventDefault: PublishMenuNativeMethod;
  readonly isDefaultPrevented: PublishMenuNativeMethod;
  readonly isPropagationStopped: PublishMenuNativeMethod;
}

type PublishMenuReactBoundary = "captureTrigger" | "captureBoundary" | "bubbleTrigger" | "bubbleBoundary";

interface PublishMenuKeyboardDelivery {
  readonly snapshot: PublishMenuNativeSnapshot;
  readonly proofs: Partial<Record<PublishMenuReactBoundary, PublishMenuReactProof>>;
  delegationTarget: EventTarget | null;
  claimed: boolean;
}

interface PublishMenuKeyboardStorage {
  current: WeakMap<KeyboardEvent, PublishMenuKeyboardDelivery> | null;
  readonly seen: WeakSet<KeyboardEvent>;
  reading: boolean;
}

interface PublishMenuClaimedArrow {
  readonly publication: PublishMenuPublication;
  readonly action: PublishMenuArrowAction;
  readonly authority: PublishMenuKeyboardAuthority;
  readonly listenerProof: PublishMenuNativeListenerProof;
  readonly nativeEvent: KeyboardEvent;
  readonly reactEvent: React.KeyboardEvent<HTMLButtonElement>;
  readonly reactProof: PublishMenuReactProof;
  readonly delivery: PublishMenuKeyboardDelivery;
  readonly retains: () => boolean;
}

interface PublishMenuOpenGuard {
  readonly isExact: (successor: PublishMenuPublication) => boolean;
  readonly dispose: () => void;
}

interface PublishMenuOpenIntent {
  readonly source: PublishMenuPublication;
  readonly action: PublishMenuArrowAction;
  readonly authority: PublishMenuKeyboardAuthority;
  readonly listenerProof: PublishMenuNativeListenerProof;
  readonly nativeEvent: KeyboardEvent;
  readonly reactEvent: React.KeyboardEvent<HTMLButtonElement>;
  readonly guard: PublishMenuOpenGuard;
}

interface PublishMenuReadyOpen extends PublishMenuOpenIntent {
  readonly publication: PublishMenuPublication;
  readonly target: HTMLDivElement;
}

interface PublishMenuAutoFocusProof {
  readonly event: Event;
  readonly publication: PublishMenuPublication;
  readonly content: HTMLDivElement;
  readonly path: readonly EventTarget[];
  readonly terminal: EventTarget;
}

interface PublishMenuPublication {
  readonly identity: object;
  readonly render: PublishMenuRender;
  readonly document: Document;
  readonly dom: PublishMenuDom;
  readonly keyboardAuthority: PublishMenuKeyboardAuthority | null;
  readonly keyboardListener: PublishMenuKeyboardListenerRegistration | null;
  readonly keyboardEvents: PublishMenuKeyboardStorage;
  readonly arrows: Readonly<Record<PublishMenuArrowKey, PublishMenuArrowAction>>;
  readonly triggerSnapshot: ModeSwitcherDomSnapshot;
  readonly contentSnapshot: ModeSwitcherDomSnapshot | null;
  readonly placements: readonly ModeSwitcherPlacementSnapshot[];
  readonly isExact: () => boolean;
  readonly recordElementChange: (
    owner: PublishMenuElementOwnerHandle,
    element: HTMLElement | null,
    previous: HTMLElement | null,
  ) => void;
  readonly isExactElementReplay: () => boolean;
  readonly retire: () => boolean;
  readonly dispose: () => void;
}

interface PublishMenuPublicationRuntime {
  readonly publication: PublishMenuPublication;
  readonly retireForLayout: () => void;
  readonly isExactElementReplay: () => boolean;
  readonly isExactLayoutReplay: () => boolean;
}

interface PublishMenuPresentation {
  readonly captureTrigger: React.RefCallback<HTMLButtonElement>;
  readonly captureContent: React.RefCallback<HTMLDivElement>;
  readonly captureActions: Readonly<Record<PublishMenuActionName, React.RefCallback<HTMLDivElement>>>;
  readonly establish: () => (() => void) | undefined;
  readonly onTriggerKeyDownCapture: (event: React.KeyboardEvent<HTMLButtonElement>) => void;
  readonly onBoundaryKeyDownCapture: (event: React.KeyboardEvent<HTMLButtonElement>) => void;
  readonly onTriggerKeyDown: (event: React.KeyboardEvent<HTMLButtonElement>) => void;
  readonly onTriggerArrowKeyDown: (event: React.KeyboardEvent<HTMLButtonElement>) => void;
  readonly onOpenChange: (open: boolean) => void;
  readonly onOpenAutoFocus: (event: Event) => void;
}

class PublishMenuElementOwner<T extends HTMLElement> {
  #current: T | null = null;
  #last: T | null = null;

  constructor(
    private readonly accepts: (element: T) => boolean,
    private readonly allowsReplacement: () => boolean,
    private readonly onChange: (
      owner: PublishMenuElementOwner<T>,
      element: T | null,
      previous: T | null,
    ) => void,
  ) {}

  readonly element = () => this.#current;

  readonly capture: React.RefCallback<T> = (element) => {
    if (this.#current === element) return;
    if (
      element
      && (
        !this.accepts(element)
        || (this.#current !== null && this.#current !== element)
        || (
          this.#current === null
          && this.#last !== null
          && this.#last !== element
          && !this.allowsReplacement()
        )
      )
    ) {
      return;
    }
    const previous = this.#current;
    if (element === null) {
      this.onChange(this, null, previous);
      this.#current = null;
      return;
    }
    this.#current = element;
    this.#last = element;
    this.onChange(this, element, previous);
  };
}

interface PublishMenuElementOwnerHandle {
  readonly element: () => HTMLElement | null;
}

interface PublishMenuOwners {
  readonly trigger: PublishMenuElementOwner<HTMLButtonElement>;
  readonly content: PublishMenuElementOwner<HTMLDivElement>;
  readonly actions: Readonly<Record<PublishMenuActionName, PublishMenuElementOwner<HTMLDivElement>>>;
}

class PublishMenuPublicationCoordinator {
  #active: PublishMenuPublication | null = null;
  #successorOf: PublishMenuPublication | null = null;
  #claimedNativeEvents = new WeakSet<Event>();
  #claimedReactEvents = new WeakSet<object>();
  #claimedPublications = new WeakSet<PublishMenuPublication>();
  #claimedDirections = new WeakSet<PublishMenuArrowAction>();
  #openIntent: PublishMenuOpenIntent | null = null;
  #readyOpen: PublishMenuReadyOpen | null = null;
  #successorRequested = new WeakSet<PublishMenuPublication>();

  constructor(private readonly requestSuccessor: () => void) {}

  active() {
    return this.#active;
  }

  allowsElementReplacement() {
    return this.#active === null;
  }

  acceptsSuccessorOf(publication: PublishMenuPublication) {
    return this.#active === null && this.#successorOf === publication;
  }

  publish(publication: PublishMenuPublication) {
    const previous = this.#active ?? this.#successorOf;
    this.#active = publication;
    this.#successorOf = null;
    const intent = this.#openIntent;
    if (intent) {
      const target = publishMenuOpenSuccessorTarget(intent, publication);
      if (target) {
        this.#readyOpen = Object.freeze({ ...intent, publication, target });
      } else {
        this.#clearOpenIntent(intent);
      }
    }
    if (previous && previous !== publication) previous.dispose();
  }

  retire(publication: PublishMenuPublication) {
    if (this.#active !== publication) return false;
    this.clearKeyboardEvents(publication);
    this.#active = null;
    this.#successorOf = publication;
    queueMicrotask(() => {
      if (this.#active !== null || this.#successorOf !== publication) return;
      this.#successorOf = null;
      if (this.#openIntent?.source === publication) this.#clearOpenIntent(this.#openIntent);
      publication.dispose();
    });
    return true;
  }

  elementChanged(
    owner: PublishMenuElementOwnerHandle,
    element: HTMLElement | null,
    previous: HTMLElement | null,
  ) {
    const publication = this.#active ?? this.#successorOf;
    if (!publication) return;
    publication.recordElementChange(owner, element, previous);
    if (
      !this.#successorRequested.has(publication)
      && this.acceptsSuccessorOf(publication)
      && publication.isExactElementReplay()
    ) {
      this.#successorRequested.add(publication);
      this.requestSuccessor();
    }
  }

  clearKeyboardEvents(publication: PublishMenuPublication) {
    publication.keyboardEvents.current = null;
  }

  runKeyboardDelivery<Value>(
    publication: PublishMenuPublication,
    callback: () => Value,
  ): Value | null {
    const storage = publication.keyboardEvents;
    if (this.#active !== publication || !storage.current || storage.reading) return null;
    storage.reading = true;
    try {
      return callback();
    } catch {
      // Throwing public event accessors cannot authorize this delivery.
      return null;
    } finally {
      storage.reading = false;
    }
  }

  #retains(publication: PublishMenuPublication, delivery: PublishMenuKeyboardDelivery) {
    return (
      this.#active === publication
      && publication.keyboardEvents.current?.get(delivery.snapshot.event) === delivery
      && delivery.snapshot.publication === publication
    );
  }

  stageNative(
    publication: PublishMenuPublication,
    registration: PublishMenuKeyboardListenerRegistration,
    receiver: EventTarget,
    event: Event,
  ) {
    return this.runKeyboardDelivery(publication, () => {
      const authority = publication.keyboardAuthority;
      if (
        this.#active === publication
        && (!publication.isExact() || (authority !== null && !authority.historyIsClean()))
      ) {
        publication.retire();
        return;
      }
      if (
        !authority
        || publication.keyboardListener !== registration
        || !registration.isCurrent()
        || !(event instanceof authority.ownerWindow.KeyboardEvent)
        || this.#claimedNativeEvents.has(event)
        || this.#claimedPublications.has(publication)
        || this.#active !== publication
      ) {
        return;
      }
      const snapshot = readPublishMenuNativeEvent(
        publication,
        authority,
        registration,
        receiver,
        event,
      );
      if (!snapshot) return;
      const storage = publication.keyboardEvents;
      if (this.#active !== publication || !storage.current) return;
      if (storage.seen.has(snapshot.event)) {
        // Only an authenticated new Window capture can release an abandoned pair.
        const previous = storage.current.get(snapshot.event);
        if (previous?.proofs.captureTrigger) storage.current.delete(snapshot.event);
        return;
      }
      const delivery: PublishMenuKeyboardDelivery = {
        snapshot,
        proofs: {},
        delegationTarget: null,
        claimed: false,
      };
      storage.seen.add(snapshot.event);
      storage.current.set(snapshot.event, delivery);
    });
  }

  stageReact(
    publication: PublishMenuPublication,
    boundary: PublishMenuReactBoundary,
    event: React.KeyboardEvent<HTMLButtonElement>,
  ) {
    if (!event || typeof event !== "object" || this.#claimedReactEvents.has(event)) return null;
    const nativeEvent = event.nativeEvent;
    const delivery = publication.keyboardEvents.current?.get(nativeEvent);
    const authority = publication.keyboardAuthority;
    const phase = boundary === "captureTrigger" || boundary === "captureBoundary"
      ? "capture" : "bubble";
    if (
      !delivery
      || !authority
      || delivery.claimed
      || delivery.proofs[boundary]
      || !this.#retains(publication, delivery)
      || (boundary === "captureBoundary" && !delivery.proofs.captureTrigger)
      || (phase === "bubble" && !delivery.proofs.captureBoundary)
      || (boundary === "bubbleBoundary" && !delivery.proofs.bubbleTrigger)
    ) {
      return null;
    }
    const retains = () => this.#retains(publication, delivery) && !delivery.claimed;
    const proof = capturePublishMenuReactProof(event, phase);
    if (
      !proof
      || !publishMenuReactDeliveryMatches(delivery, phase, retains, proof)
      || !retains()
    ) {
      return null;
    }
    const currentTarget = publishMenuNativeValue<EventTarget | null>(
      authority.event.currentTarget,
      nativeEvent,
      authority,
    );
    if (!retains() || currentTarget === null) return null;
    delivery.delegationTarget = currentTarget;
    delivery.proofs[boundary] = proof;
    return delivery;
  }

  claim(
    publication: PublishMenuPublication,
    event: React.KeyboardEvent<HTMLButtonElement>,
  ): PublishMenuClaimedArrow | null {
    if (!event || typeof event !== "object" || this.#claimedReactEvents.has(event)) return null;
    const delivery = this.stageReact(publication, "bubbleBoundary", event);
    const snapshot = delivery?.snapshot;
    const nativeEvent = snapshot?.event;
    const proof = delivery?.proofs.bubbleBoundary;
    const authority = publication.keyboardAuthority;
    const listenerProof = snapshot?.listenerProof;
    if (
      !delivery
      || !snapshot
      || !proof
      || !authority
      || !listenerProof
      || !nativeEvent
      || snapshot.publication !== publication
      || this.#claimedPublications.has(publication)
      || this.#claimedDirections.has(snapshot.action)
      || this.#claimedNativeEvents.has(nativeEvent)
      || this.#active !== publication
      || !publishMenuNativeListenerProofMatches(
        listenerProof,
        publication,
        nativeEvent,
        true,
      )
      || !publishMenuReactDeliveryMatches(
        delivery,
        "bubble",
        () => this.#retains(publication, delivery) && !delivery.claimed,
      )
      || !this.#retains(publication, delivery)
      || delivery.claimed
    ) {
      if (delivery && !delivery.claimed && delivery.proofs.bubbleBoundary === proof) {
        delete delivery.proofs.bubbleBoundary;
      }
      return null;
    }
    this.#claimedPublications.add(publication);
    this.#claimedDirections.add(snapshot.action);
    this.#claimedReactEvents.add(event);
    for (const participant of Object.values(delivery.proofs)) {
      this.#claimedReactEvents.add(participant.event);
    }
    this.#claimedNativeEvents.add(nativeEvent);
    delivery.claimed = true;
    return Object.freeze({
      publication,
      action: snapshot.action,
      authority,
      listenerProof,
      nativeEvent,
      reactEvent: event,
      reactProof: proof,
      delivery,
      retains: () => (
        this.#retains(publication, delivery)
        && delivery.claimed
        && this.#claimedPublications.has(publication)
        && this.#claimedDirections.has(snapshot.action)
        && this.#claimedNativeEvents.has(nativeEvent)
        && this.#claimedReactEvents.has(event)
      ),
    });
  }

  prepareOpen(claim: PublishMenuClaimedArrow) {
    const publication = claim.publication;
    if (
      !claim.retains()
      || publication.render.open
      || this.#active !== publication
      || !this.#claimedPublications.has(publication)
      || !this.#claimedDirections.has(claim.action)
      || !publishMenuNativeListenerProofMatches(
        claim.listenerProof,
        publication,
        claim.nativeEvent,
        true,
      )
      || !publishMenuArrowIsCurrent(publication, claim.action)
      || !publication.isExact()
    ) {
      return false;
    }
    const guard = createPublishMenuOpenGuard(publication);
    if (!guard) return false;
    if (!claim.retains()) {
      guard.dispose();
      return false;
    }
    if (this.#openIntent) this.#clearOpenIntent(this.#openIntent);
    this.#openIntent = Object.freeze({
      source: publication,
      action: claim.action,
      authority: claim.authority,
      listenerProof: claim.listenerProof,
      nativeEvent: claim.nativeEvent,
      reactEvent: claim.reactEvent,
      guard,
    });
    return true;
  }

  cancelOpen(publication: PublishMenuPublication) {
    if (this.#openIntent?.source === publication) this.#clearOpenIntent(this.#openIntent);
  }

  canCommitOpen(publication: PublishMenuPublication) {
    return (
      this.#active === null
      && this.#successorOf === publication
      && this.#openIntent?.source === publication
    );
  }

  consumeOpen(publication: PublishMenuPublication, event: Event) {
    const ready = this.#readyOpen;
    const authority = ready?.authority;
    const autoFocusProof = authority
      ? readPublishMenuAutoFocusEvent(publication, event, authority)
      : null;
    if (
      !ready
      || ready.publication !== publication
      || !authority
      || this.#active !== publication
      || !autoFocusProof
      || publishMenuActiveElement(authority) !== publication.dom.trigger
      || !publishMenuNativeListenerProofMatches(
        ready.listenerProof,
        ready.source,
        ready.nativeEvent,
        false,
      )
      || !publishMenuOpenSuccessorTarget(ready, publication)
      || this.#claimedNativeEvents.has(event)
    ) {
      return null;
    }
    this.#claimedNativeEvents.add(event);
    const result = Object.freeze({
      authority,
      autoFocusProof,
      target: ready.target,
      source: ready.source,
      listenerProof: ready.listenerProof,
      nativeEvent: ready.nativeEvent,
    });
    this.#clearOpenIntent(ready);
    return result;
  }

  #clearOpenIntent(intent: PublishMenuOpenIntent) {
    if (this.#openIntent === intent) this.#openIntent = null;
    if (this.#readyOpen?.source === intent.source) this.#readyOpen = null;
    intent.guard.dispose();
  }
}

function publishMenuDescriptorsMatch(
  current: PropertyDescriptor | undefined,
  expected: PropertyDescriptor,
) {
  if (
    !current
    || current.configurable !== expected.configurable
    || current.enumerable !== expected.enumerable
    || ("value" in current) !== ("value" in expected)
    || ("writable" in current) !== ("writable" in expected)
    || ("get" in current) !== ("get" in expected)
    || ("set" in current) !== ("set" in expected)
  ) {
    return false;
  }
  return "value" in expected
    ? current.value === expected.value && current.writable === expected.writable
    : current.get === expected.get && current.set === expected.set;
}

function capturePublishMenuDescriptor(
  owner: object,
  property: PropertyKey,
  getOwnPropertyDescriptor: typeof Object.getOwnPropertyDescriptor,
): PublishMenuCapturedDescriptor | null {
  const descriptor = getOwnPropertyDescriptor(owner, property);
  if (!descriptor) return null;
  const expected = Object.freeze({ ...descriptor });
  return Object.freeze({
    owner,
    property,
    descriptor: expected,
    isCurrent: () => publishMenuDescriptorsMatch(
      getOwnPropertyDescriptor(owner, property),
      expected,
    ),
  });
}

function capturePublishMenuGetter(
  owner: object,
  property: PropertyKey,
  getOwnPropertyDescriptor: typeof Object.getOwnPropertyDescriptor,
) {
  const capture = capturePublishMenuDescriptor(owner, property, getOwnPropertyDescriptor);
  const getter = capture?.descriptor.get;
  return capture && typeof getter === "function" && !("value" in capture.descriptor)
    ? Object.freeze({ capture, getter: getter as PublishMenuNativeGetter })
    : null;
}

function capturePublishMenuMethod(
  owner: object,
  property: PropertyKey,
  getOwnPropertyDescriptor: typeof Object.getOwnPropertyDescriptor,
) {
  const capture = capturePublishMenuDescriptor(owner, property, getOwnPropertyDescriptor);
  const method = capture?.descriptor.value;
  return capture && typeof method === "function"
    ? Object.freeze({ capture, method: method as PublishMenuNativeMethod })
    : null;
}

function capturePublishMenuTrustedAuthority(
  ownerWindow: Window & typeof globalThis,
  getOwnPropertyDescriptor: typeof Object.getOwnPropertyDescriptor,
  getPrototypeOf: typeof Object.getPrototypeOf,
  apply: typeof Reflect.apply,
): PublishMenuTrustedAuthority | null {
  let probe: KeyboardEvent;
  try {
    probe = new ownerWindow.KeyboardEvent("publish-menu-keyboard-probe");
  } catch {
    return null;
  }
  const descriptor = getOwnPropertyDescriptor(probe, "isTrusted");
  if (
    getPrototypeOf(probe) !== ownerWindow.KeyboardEvent.prototype
    || !descriptor
    || descriptor.configurable !== false
    || descriptor.enumerable !== true
    || typeof descriptor.get !== "function"
    || descriptor.set !== undefined
    || "value" in descriptor
    || "writable" in descriptor
  ) {
    return null;
  }
  const expected = Object.freeze({ ...descriptor });
  const getter = descriptor.get as PublishMenuNativeGetter;
  const matches = (event: object) => publishMenuDescriptorsMatch(
    getOwnPropertyDescriptor(event, "isTrusted"),
    expected,
  );
  const read = (event: object) => apply(getter, event, []) as boolean;
  try {
    if (read(probe) !== false) return null;
  } catch {
    return null;
  }
  return Object.freeze({
    read,
    matches,
    isCurrent: () => matches(probe),
  });
}

function capturePublishMenuKeyboardAuthority(
  ownerDocument: Document,
  ownerWindow: Window & typeof globalThis,
): PublishMenuKeyboardAuthority | null {
  const getOwnPropertyDescriptor = ownerWindow.Object.getOwnPropertyDescriptor;
  const getPrototypeOf = ownerWindow.Object.getPrototypeOf;
  const apply = ownerWindow.Reflect.apply;
  const eventPrototype = ownerWindow.Event.prototype;
  const customEventPrototype = ownerWindow.CustomEvent.prototype;
  const keyboardPrototype = ownerWindow.KeyboardEvent.prototype;
  const uiPrototype = ownerWindow.UIEvent.prototype;
  const documentPrototype = ownerWindow.Document.prototype;
  const htmlElementPrototype = ownerWindow.HTMLElement.prototype;
  const eventTargetPrototype = ownerWindow.EventTarget.prototype;
  const trusted = capturePublishMenuTrustedAuthority(
    ownerWindow,
    getOwnPropertyDescriptor,
    getPrototypeOf,
    apply,
  );
  const captures = {
    type: capturePublishMenuGetter(eventPrototype, "type", getOwnPropertyDescriptor),
    target: capturePublishMenuGetter(eventPrototype, "target", getOwnPropertyDescriptor),
    currentTarget: capturePublishMenuGetter(eventPrototype, "currentTarget", getOwnPropertyDescriptor),
    eventPhase: capturePublishMenuGetter(eventPrototype, "eventPhase", getOwnPropertyDescriptor),
    bubbles: capturePublishMenuGetter(eventPrototype, "bubbles", getOwnPropertyDescriptor),
    cancelable: capturePublishMenuGetter(eventPrototype, "cancelable", getOwnPropertyDescriptor),
    defaultPrevented: capturePublishMenuGetter(eventPrototype, "defaultPrevented", getOwnPropertyDescriptor),
    cancelBubble: capturePublishMenuGetter(eventPrototype, "cancelBubble", getOwnPropertyDescriptor),
    composed: capturePublishMenuGetter(eventPrototype, "composed", getOwnPropertyDescriptor),
    timeStamp: capturePublishMenuGetter(eventPrototype, "timeStamp", getOwnPropertyDescriptor),
    composedPath: capturePublishMenuMethod(eventPrototype, "composedPath", getOwnPropertyDescriptor),
    preventDefault: capturePublishMenuMethod(eventPrototype, "preventDefault", getOwnPropertyDescriptor),
    key: capturePublishMenuGetter(keyboardPrototype, "key", getOwnPropertyDescriptor),
    code: capturePublishMenuGetter(keyboardPrototype, "code", getOwnPropertyDescriptor),
    location: capturePublishMenuGetter(keyboardPrototype, "location", getOwnPropertyDescriptor),
    altKey: capturePublishMenuGetter(keyboardPrototype, "altKey", getOwnPropertyDescriptor),
    ctrlKey: capturePublishMenuGetter(keyboardPrototype, "ctrlKey", getOwnPropertyDescriptor),
    metaKey: capturePublishMenuGetter(keyboardPrototype, "metaKey", getOwnPropertyDescriptor),
    shiftKey: capturePublishMenuGetter(keyboardPrototype, "shiftKey", getOwnPropertyDescriptor),
    repeat: capturePublishMenuGetter(keyboardPrototype, "repeat", getOwnPropertyDescriptor),
    isComposing: capturePublishMenuGetter(keyboardPrototype, "isComposing", getOwnPropertyDescriptor),
    detail: capturePublishMenuGetter(uiPrototype, "detail", getOwnPropertyDescriptor),
    view: capturePublishMenuGetter(uiPrototype, "view", getOwnPropertyDescriptor),
    activeElement: capturePublishMenuGetter(documentPrototype, "activeElement", getOwnPropertyDescriptor),
    focus: capturePublishMenuMethod(htmlElementPrototype, "focus", getOwnPropertyDescriptor),
    addEventListener: capturePublishMenuMethod(
      eventTargetPrototype,
      "addEventListener",
      getOwnPropertyDescriptor,
    ),
    removeEventListener: capturePublishMenuMethod(
      eventTargetPrototype,
      "removeEventListener",
      getOwnPropertyDescriptor,
    ),
  };
  const values = Object.values(captures);
  if (
    !trusted
    || values.some((capture) => capture === null)
    || getPrototypeOf(customEventPrototype) !== eventPrototype
    || getPrototypeOf(keyboardPrototype) !== uiPrototype
    || getPrototypeOf(uiPrototype) !== eventPrototype
    || getPrototypeOf(eventPrototype) !== ownerWindow.Object.prototype
  ) {
    return null;
  }
  const descriptors = Object.freeze(values.map((capture) => capture!.capture));
  let historyIsClean = true;
  const checkHistory = () => {
    if (!historyIsClean) return false;
    historyIsClean = Boolean(
      ownerDocument.defaultView === ownerWindow
      && ownerWindow.Object.getOwnPropertyDescriptor === getOwnPropertyDescriptor
      && ownerWindow.Object.getPrototypeOf === getPrototypeOf
      && ownerWindow.Reflect.apply === apply
      && ownerWindow.Event.prototype === eventPrototype
      && ownerWindow.CustomEvent.prototype === customEventPrototype
      && ownerWindow.KeyboardEvent.prototype === keyboardPrototype
      && ownerWindow.UIEvent.prototype === uiPrototype
      && ownerWindow.Document.prototype === documentPrototype
      && ownerWindow.HTMLElement.prototype === htmlElementPrototype
      && ownerWindow.EventTarget.prototype === eventTargetPrototype
      && getPrototypeOf(customEventPrototype) === eventPrototype
      && getPrototypeOf(keyboardPrototype) === uiPrototype
      && getPrototypeOf(uiPrototype) === eventPrototype
      && getPrototypeOf(eventPrototype) === ownerWindow.Object.prototype
      && trusted.isCurrent()
      && descriptors.every((descriptor) => descriptor.isCurrent())
    );
    return historyIsClean;
  };
  return Object.freeze({
    ownerDocument,
    ownerWindow,
    customEventPrototype,
    keyboardPrototype,
    getOwnPropertyDescriptor,
    getPrototypeOf,
    apply,
    trusted,
    event: Object.freeze({
      type: captures.type!.getter,
      target: captures.target!.getter,
      currentTarget: captures.currentTarget!.getter,
      eventPhase: captures.eventPhase!.getter,
      bubbles: captures.bubbles!.getter,
      cancelable: captures.cancelable!.getter,
      defaultPrevented: captures.defaultPrevented!.getter,
      cancelBubble: captures.cancelBubble!.getter,
      composed: captures.composed!.getter,
      timeStamp: captures.timeStamp!.getter,
      composedPath: captures.composedPath!.method,
      preventDefault: captures.preventDefault!.method,
    }),
    keyboard: Object.freeze({
      key: captures.key!.getter,
      code: captures.code!.getter,
      location: captures.location!.getter,
      altKey: captures.altKey!.getter,
      ctrlKey: captures.ctrlKey!.getter,
      metaKey: captures.metaKey!.getter,
      shiftKey: captures.shiftKey!.getter,
      repeat: captures.repeat!.getter,
      isComposing: captures.isComposing!.getter,
    }),
    ui: Object.freeze({
      detail: captures.detail!.getter,
      view: captures.view!.getter,
    }),
    activeElement: captures.activeElement!.getter,
    focus: captures.focus!.method,
    addEventListener: captures.addEventListener!.method,
    removeEventListener: captures.removeEventListener!.method,
    historyIsClean: checkHistory,
  });
}

function publishMenuNativeValue<Value>(
  getter: PublishMenuNativeGetter,
  value: object,
  authority: PublishMenuKeyboardAuthority,
): Value {
  return authority.apply(getter, value, []) as Value;
}

function publishMenuNativeCall<Value>(
  method: PublishMenuNativeMethod,
  value: object,
  args: readonly unknown[],
  authority: PublishMenuKeyboardAuthority,
): Value {
  return authority.apply(method, value, args) as Value;
}

function publishMenuActiveElement(authority: PublishMenuKeyboardAuthority) {
  return publishMenuNativeValue<Element | null>(
    authority.activeElement,
    authority.ownerDocument,
    authority,
  );
}

function publishMenuNativeListenerProofMatches(
  proof: PublishMenuNativeListenerProof,
  publication: PublishMenuPublication,
  event: KeyboardEvent,
  requireCurrent: boolean,
) {
  const authority = publication.keyboardAuthority;
  const registration = publication.keyboardListener;
  return Boolean(
    authority
    && registration
    && Object.isFrozen(proof)
    && Object.isFrozen(registration)
    && proof.publication === publication
    && proof.registration === registration
    && proof.event === event
    && proof.receiver === proof.currentTarget
    && proof.receiver === proof.terminal
    && proof.eventPhase === authority.ownerWindow.Event.CAPTURING_PHASE
    && registration.publicationIdentity === publication.identity
    && registration.target === authority.ownerWindow
    && registration.listener === publication.keyboardListener.listener
    && registration.capture === true
    && (!requireCurrent || registration.isCurrent())
  );
}

function publishMenuTriggerPathMatches(
  path: readonly EventTarget[],
  trigger: HTMLButtonElement,
  ownerDocument: Document,
  terminal: EventTarget,
) {
  const expected: EventTarget[] = [];
  for (let current: Node | null = trigger; current; current = current.parentNode) {
    expected.push(current);
    if (current === ownerDocument) break;
  }
  return (
    expected.at(-1) === ownerDocument
    && path.length === expected.length + 1
    && expected.every((entry, index) => path[index] === entry)
    && path.at(-1) === terminal
  );
}

function publishMenuContentPathMatches(
  path: readonly EventTarget[],
  content: HTMLDivElement,
  ownerDocument: Document,
  terminal: EventTarget,
) {
  const expected: EventTarget[] = [];
  for (let current: Node | null = content; current; current = current.parentNode) {
    expected.push(current);
    if (current === ownerDocument) break;
  }
  return (
    expected.at(-1) === ownerDocument
    && path.length === expected.length + 1
    && expected.every((entry, index) => path[index] === entry)
    && path.at(-1) === terminal
    && !expected.includes(terminal)
  );
}

function publishMenuAutoFocusEventMatches(
  proof: PublishMenuAutoFocusProof,
  publication: PublishMenuPublication,
  event: Event,
  authority: PublishMenuKeyboardAuthority,
  defaultPrevented: boolean,
) {
  const content = publication.dom.content;
  const ownerWindow = publication.document.defaultView;
  if (
    !content
    || !ownerWindow
    || authority.ownerDocument !== publication.document
    || authority.ownerWindow !== ownerWindow
    || !authority.historyIsClean()
    || !(event instanceof ownerWindow.CustomEvent)
    || authority.getPrototypeOf(event) !== authority.customEventPrototype
    || !Object.isFrozen(proof)
    || proof.event !== event
    || proof.publication !== publication
    || proof.content !== content
  ) {
    return false;
  }
  try {
    const path = publishMenuNativeCall<EventTarget[]>(
      authority.event.composedPath,
      event,
      [],
      authority,
    );
    return (
      publishMenuNativeValue<string>(authority.event.type, event, authority)
        === "focusScope.autoFocusOnMount"
      && publishMenuNativeValue<EventTarget | null>(
        authority.event.target,
        event,
        authority,
      ) === content
      && publishMenuNativeValue<EventTarget | null>(
        authority.event.currentTarget,
        event,
        authority,
      ) === content
      && publishMenuNativeValue<number>(authority.event.eventPhase, event, authority)
        === ownerWindow.Event.AT_TARGET
      && !publishMenuNativeValue<boolean>(authority.event.bubbles, event, authority)
      && publishMenuNativeValue<boolean>(authority.event.cancelable, event, authority)
      && publishMenuNativeValue<boolean>(
        authority.event.defaultPrevented,
        event,
        authority,
      ) === defaultPrevented
      && !publishMenuNativeValue<boolean>(authority.event.cancelBubble, event, authority)
      && !publishMenuNativeValue<boolean>(authority.event.composed, event, authority)
      && path.length === proof.path.length
      && path.every((entry, index) => entry === proof.path[index])
      && publishMenuContentPathMatches(
        path,
        content,
        publication.document,
        proof.terminal,
      )
    );
  } catch {
    return false;
  }
}

function readPublishMenuAutoFocusEvent(
  publication: PublishMenuPublication,
  event: Event,
  authority: PublishMenuKeyboardAuthority,
): PublishMenuAutoFocusProof | null {
  const content = publication.dom.content;
  if (!content) return null;
  try {
    const path = Object.freeze([...publishMenuNativeCall<EventTarget[]>(
      authority.event.composedPath,
      event,
      [],
      authority,
    )]);
    const terminal = path.at(-1);
    if (!terminal) return null;
    const proof: PublishMenuAutoFocusProof = Object.freeze({
      event,
      publication,
      content,
      path,
      terminal,
    });
    return publishMenuAutoFocusEventMatches(proof, publication, event, authority, false)
      ? proof
      : null;
  } catch {
    return null;
  }
}

function publishMenuArrowIsCurrent(
  publication: PublishMenuPublication,
  action: PublishMenuArrowAction,
) {
  const target = action.key === "ArrowDown"
    ? publication.render.enabledActions.at(0)
    : publication.render.enabledActions.at(-1);
  return Boolean(
    publication.arrows[action.key] === action
    && Object.isFrozen(action)
    && action.publicationIdentity === publication.identity
    && action.destination === (action.key === "ArrowDown" ? "first" : "last")
    && action.target === (target ?? null)
    && Boolean(target?.enabled)
  );
}

function readPublishMenuNativeEvent(
  publication: PublishMenuPublication,
  authority: PublishMenuKeyboardAuthority,
  registration: PublishMenuKeyboardListenerRegistration,
  receiver: EventTarget,
  event: Event,
): PublishMenuNativeSnapshot | null {
  if (
    publication.keyboardAuthority !== authority
    || publication.keyboardListener !== registration
    || !registration.isCurrent()
    || !(event instanceof authority.ownerWindow.KeyboardEvent)
    || !authority.historyIsClean()
    || authority.getPrototypeOf(event) !== authority.keyboardPrototype
    || !authority.trusted.matches(event)
  ) {
    return null;
  }
  try {
    const keyboardEvent = event as KeyboardEvent;
    const type = publishMenuNativeValue<string>(authority.event.type, keyboardEvent, authority);
    const target = publishMenuNativeValue<EventTarget | null>(
      authority.event.target,
      keyboardEvent,
      authority,
    );
    const currentTarget = publishMenuNativeValue<EventTarget | null>(
      authority.event.currentTarget,
      keyboardEvent,
      authority,
    );
    const eventPhase = publishMenuNativeValue<number>(
      authority.event.eventPhase,
      keyboardEvent,
      authority,
    );
    const key = publishMenuNativeValue<string>(authority.keyboard.key, keyboardEvent, authority);
    const path = Object.freeze([...publishMenuNativeCall<EventTarget[]>(
      authority.event.composedPath,
      keyboardEvent,
      [],
      authority,
    )]);
    const terminal = path.at(-1);
    const view = publishMenuNativeValue<Window | null>(authority.ui.view, keyboardEvent, authority);
    const action = key === "ArrowDown" || key === "ArrowUp" ? publication.arrows[key] : null;
    const bubbles = publishMenuNativeValue<boolean>(
      authority.event.bubbles,
      keyboardEvent,
      authority,
    );
    const cancelable = publishMenuNativeValue<boolean>(
      authority.event.cancelable,
      keyboardEvent,
      authority,
    );
    const defaultPrevented = publishMenuNativeValue<boolean>(
      authority.event.defaultPrevented,
      keyboardEvent,
      authority,
    );
    const cancelBubble = publishMenuNativeValue<boolean>(
      authority.event.cancelBubble,
      keyboardEvent,
      authority,
    );
    if (
      !action
      || !terminal
      || type !== "keydown"
      || eventPhase !== authority.ownerWindow.Event.CAPTURING_PHASE
      || target !== publication.dom.trigger
      || currentTarget !== receiver
      || terminal !== receiver
      || !bubbles
      || !cancelable
      || defaultPrevented
      || cancelBubble
      || authority.trusted.read(keyboardEvent) !== true
      || publishMenuNativeValue<boolean>(authority.keyboard.altKey, keyboardEvent, authority)
      || publishMenuNativeValue<boolean>(authority.keyboard.ctrlKey, keyboardEvent, authority)
      || publishMenuNativeValue<boolean>(authority.keyboard.metaKey, keyboardEvent, authority)
      || publishMenuNativeValue<boolean>(authority.keyboard.shiftKey, keyboardEvent, authority)
      || publishMenuNativeValue<boolean>(authority.keyboard.repeat, keyboardEvent, authority)
      || publishMenuNativeValue<boolean>(authority.keyboard.isComposing, keyboardEvent, authority)
      || (view !== null && view !== authority.ownerWindow)
      || publishMenuActiveElement(authority) !== publication.dom.trigger
      || !publishMenuTriggerPathMatches(
        path,
        publication.dom.trigger,
        authority.ownerDocument,
        terminal,
      )
      || !publishMenuArrowIsCurrent(publication, action)
    ) {
      return null;
    }
    const listenerProof: PublishMenuNativeListenerProof = Object.freeze({
      publication,
      registration,
      event: keyboardEvent,
      receiver,
      currentTarget,
      terminal,
      eventPhase,
    });
    if (!publishMenuNativeListenerProofMatches(
      listenerProof,
      publication,
      keyboardEvent,
      true,
    )) {
      return null;
    }
    return Object.freeze({
      event: keyboardEvent,
      publication,
      action,
      listenerProof,
      path,
      type,
      target,
      currentTarget,
      eventPhase,
      bubbles,
      cancelable,
      defaultPrevented,
      cancelBubble,
      composed: publishMenuNativeValue<boolean>(
        authority.event.composed,
        keyboardEvent,
        authority,
      ),
      timeStamp: publishMenuNativeValue<number>(
        authority.event.timeStamp,
        keyboardEvent,
        authority,
      ),
      key: action.key,
      code: publishMenuNativeValue<string>(authority.keyboard.code, keyboardEvent, authority),
      location: publishMenuNativeValue<number>(
        authority.keyboard.location,
        keyboardEvent,
        authority,
      ),
      altKey: false,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      repeat: false,
      isComposing: false,
      detail: publishMenuNativeValue<number>(authority.ui.detail, keyboardEvent, authority),
      view,
      isTrusted: true,
    });
  } catch {
    return null;
  }
}

function capturePublishMenuReactProof(
  event: React.KeyboardEvent<HTMLButtonElement>,
  phase: PublishMenuReactProof["phase"],
): PublishMenuReactProof | null {
  if (!event || typeof event !== "object") return null;
  try {
    const preventDefault = event.preventDefault;
    const isDefaultPrevented = event.isDefaultPrevented;
    const isPropagationStopped = event.isPropagationStopped;
    if (
      typeof preventDefault !== "function"
      || typeof isDefaultPrevented !== "function"
      || typeof isPropagationStopped !== "function"
    ) {
      return null;
    }
    return Object.freeze({ event, phase, preventDefault, isDefaultPrevented, isPropagationStopped });
  } catch {
    return null;
  }
}

function publishMenuNativeEventMatches(
  delivery: PublishMenuKeyboardDelivery,
  phase: PublishMenuReactProof["phase"],
  defaultPrevented: boolean,
  requireCurrent = true,
) {
  const { snapshot } = delivery;
  const { event, publication } = snapshot;
  const authority = publication.keyboardAuthority;
  if (
    !authority
    || !authority.historyIsClean()
    || !publishMenuNativeListenerProofMatches(
      snapshot.listenerProof,
      publication,
      event,
      requireCurrent,
    )
    || authority.getPrototypeOf(event) !== authority.keyboardPrototype
    || !authority.trusted.matches(event)
    || authority.trusted.read(event) !== true
    || publishMenuActiveElement(authority) !== publication.dom.trigger
  ) {
    return false;
  }
  try {
    const path = publishMenuNativeCall<EventTarget[]>(
      authority.event.composedPath,
      event,
      [],
      authority,
    );
    const currentTarget = publishMenuNativeValue<EventTarget | null>(
      authority.event.currentTarget,
      event,
      authority,
    );
    return (
      publishMenuNativeValue<string>(authority.event.type, event, authority) === snapshot.type
      && publishMenuNativeValue<EventTarget | null>(
        authority.event.target,
        event,
        authority,
      ) === snapshot.target
      && publishMenuNativeValue<number>(
        authority.event.eventPhase,
        event,
        authority,
      ) === (phase === "capture"
        ? authority.ownerWindow.Event.CAPTURING_PHASE
        : authority.ownerWindow.Event.BUBBLING_PHASE)
      && currentTarget !== null
      && path.includes(currentTarget)
      && (!delivery.delegationTarget || delivery.delegationTarget === currentTarget)
      && publishMenuNativeValue<boolean>(
        authority.event.bubbles,
        event,
        authority,
      ) === snapshot.bubbles
      && publishMenuNativeValue<boolean>(
        authority.event.cancelable,
        event,
        authority,
      ) === snapshot.cancelable
      && publishMenuNativeValue<boolean>(
        authority.event.defaultPrevented, event, authority,
      ) === defaultPrevented
      && !publishMenuNativeValue<boolean>(authority.event.cancelBubble, event, authority)
      && publishMenuNativeValue<boolean>(
        authority.event.composed,
        event,
        authority,
      ) === snapshot.composed
      && publishMenuNativeValue<number>(
        authority.event.timeStamp,
        event,
        authority,
      ) === snapshot.timeStamp
      && publishMenuNativeValue<string>(authority.keyboard.key, event, authority) === snapshot.key
      && publishMenuNativeValue<string>(authority.keyboard.code, event, authority) === snapshot.code
      && publishMenuNativeValue<number>(
        authority.keyboard.location,
        event,
        authority,
      ) === snapshot.location
      && !publishMenuNativeValue<boolean>(authority.keyboard.altKey, event, authority)
      && !publishMenuNativeValue<boolean>(authority.keyboard.ctrlKey, event, authority)
      && !publishMenuNativeValue<boolean>(authority.keyboard.metaKey, event, authority)
      && !publishMenuNativeValue<boolean>(authority.keyboard.shiftKey, event, authority)
      && !publishMenuNativeValue<boolean>(authority.keyboard.repeat, event, authority)
      && !publishMenuNativeValue<boolean>(authority.keyboard.isComposing, event, authority)
      && publishMenuNativeValue<number>(authority.ui.detail, event, authority) === snapshot.detail
      && publishMenuNativeValue<Window | null>(authority.ui.view, event, authority) === snapshot.view
      && path.length === snapshot.path.length
      && path.every((entry, index) => entry === snapshot.path[index])
      && publishMenuArrowIsCurrent(publication, snapshot.action)
      && publication.isExact()
    );
  } catch {
    return false;
  }
}

function publishMenuReactMethodsMatch(
  proof: PublishMenuReactProof,
  defaultQuery = proof.isDefaultPrevented,
) {
  const event = proof.event;
  return (
    event.preventDefault === proof.preventDefault
    && event.isDefaultPrevented === defaultQuery
    && event.isPropagationStopped === proof.isPropagationStopped
  );
}

function publishMenuReactValuesMatch(
  delivery: PublishMenuKeyboardDelivery,
  proof: PublishMenuReactProof,
  phase: PublishMenuReactProof["phase"],
  currentDelivery: boolean,
  defaultPrevented: boolean,
  defaultQuery: PublishMenuNativeMethod,
) {
  const { snapshot } = delivery;
  const { event } = proof;
  const authority = snapshot.publication.keyboardAuthority;
  if (!authority) return false;
  const currentTarget = event.currentTarget;
  return (
      event !== (snapshot.event as unknown)
      && event.nativeEvent === snapshot.event
      && event.type === snapshot.type
      && (
        currentTarget === snapshot.publication.dom.trigger
        || (!currentDelivery && proof.phase === "capture" && phase === "bubble" && currentTarget === null)
      )
      && event.target === snapshot.publication.dom.trigger
      && event.eventPhase === (proof.phase === "capture"
        ? authority.ownerWindow.Event.CAPTURING_PHASE
        : authority.ownerWindow.Event.BUBBLING_PHASE)
      && event.bubbles === snapshot.bubbles
      && event.cancelable === snapshot.cancelable
      && event.defaultPrevented === defaultPrevented
      && event.isTrusted === snapshot.isTrusted
      && event.timeStamp === snapshot.timeStamp
      && event.key === snapshot.key
      && event.code === snapshot.code
      && event.location === snapshot.location
      && event.altKey === snapshot.altKey
      && event.ctrlKey === snapshot.ctrlKey
      && event.metaKey === snapshot.metaKey
      && event.shiftKey === snapshot.shiftKey
      && event.repeat === snapshot.repeat
      && event.detail === snapshot.detail
      && Object.is(event.view, snapshot.view)
      && publishMenuReactMethodsMatch(proof, defaultQuery)
  );
}

function publishMenuReactDeliveryMatches(
  delivery: PublishMenuKeyboardDelivery,
  phase: PublishMenuReactProof["phase"],
  retains: () => boolean,
  candidate?: PublishMenuReactProof,
  prevented?: Readonly<{
    event: React.KeyboardEvent<HTMLButtonElement>;
    isDefaultPrevented: PublishMenuNativeMethod;
  }>,
) {
  const authority = delivery.snapshot.publication.keyboardAuthority;
  if (!authority || !retains()) return false;
  try {
    const proofs = Object.values(delivery.proofs);
    if (candidate) proofs.push(candidate);
    const isPrevented = (proof: PublishMenuReactProof) => proof.event === prevented?.event;
    const defaultQuery = (proof: PublishMenuReactProof) => (
      isPrevented(proof) ? prevented!.isDefaultPrevented : proof.isDefaultPrevented
    );
    const valuesMatch = () => proofs.every((proof) => (
      retains()
      && publishMenuReactValuesMatch(
        delivery, proof, phase, proof === candidate, isPrevented(proof), defaultQuery(proof),
      )
      && retains()
    ));
    const methodsMatch = () => proofs.every((proof) => (
      publishMenuReactMethodsMatch(proof, defaultQuery(proof)) && retains()
    ));
    // As in the other public keyboard routes, exclude reentry and revalidate all
    // participants between queries; one wrapper's query may change another's methods.
    const revalidate = () => (
      retains()
      && valuesMatch()
      && publishMenuNativeEventMatches(delivery, phase, prevented !== undefined)
      && valuesMatch()
      && methodsMatch()
      && publishMenuNativeEventMatches(delivery, phase, prevented !== undefined)
      && retains()
    );
    if (!revalidate()) return false;
    const queried = new Set<object>();
    for (const proof of proofs) {
      if (queried.has(proof.event)) continue;
      queried.add(proof.event);
      const query = defaultQuery(proof);
      if (
        !revalidate()
        || proof.event.isDefaultPrevented !== query
        || !retains()
        || publishMenuNativeCall<boolean>(query, proof.event, [], authority) !== isPrevented(proof)
        || !revalidate()
        || proof.event.isPropagationStopped !== proof.isPropagationStopped
        || !retains()
        || publishMenuNativeCall<boolean>(
          proof.isPropagationStopped, proof.event, [], authority,
        ) !== false
        || !revalidate()
      ) {
        return false;
      }
    }
    return revalidate();
  } catch {
    return false;
  }
}

function preventPublishMenuArrow(claim: PublishMenuClaimedArrow) {
  const { authority, delivery, reactEvent, reactProof, retains } = claim;
  if (
    !publishMenuReactDeliveryMatches(delivery, "bubble", retains)
    || reactEvent.preventDefault !== reactProof.preventDefault
    || !retains()
  ) {
    return false;
  }
  publishMenuNativeCall<void>(reactProof.preventDefault, reactEvent, [], authority);
  // React replaces this query on the prevented wrapper only. Retain it before
  // calling any other public getter/query, never by adopting all current methods.
  const isDefaultPrevented = reactEvent.isDefaultPrevented;
  return (
    typeof isDefaultPrevented === "function"
    && retains()
    && publishMenuReactDeliveryMatches(
      delivery, "bubble", retains, undefined, { event: reactEvent, isDefaultPrevented },
    )
    && retains()
  );
}

function createPublishMenuOpenGuard(source: PublishMenuPublication): PublishMenuOpenGuard | null {
  const MutationObserverConstructor = source.document.defaultView?.MutationObserver;
  if (!MutationObserverConstructor || !source.isExact()) return null;
  const trigger = source.dom.trigger;
  const records: MutationRecord[] = [];
  const potentialGuards = new WeakSet<Node>();
  let observer: MutationObserver | null = new MutationObserverConstructor((pending) => {
    for (const record of pending) {
      if (record.type === "attributes") {
        if (
          record.target === trigger
          || (
            record.target instanceof source.document.defaultView!.HTMLSpanElement
            && (
              potentialGuards.has(record.target)
              || record.target.hasAttribute("data-radix-focus-guard")
            )
          )
        ) {
          records.push(record);
        }
        continue;
      }
      for (const node of [...record.addedNodes, ...record.removedNodes]) {
        if (node instanceof source.document.defaultView!.HTMLSpanElement) {
          potentialGuards.add(node);
        }
      }
      records.push(record);
    }
  });
  observer.observe(trigger, {
    attributeOldValue: true,
    attributes: true,
    characterData: true,
    childList: true,
    subtree: true,
  });
  for (let ancestor = trigger.parentNode; ancestor; ancestor = ancestor.parentNode) {
    observer.observe(ancestor, {
      attributeOldValue: ancestor === source.document.body,
      attributes: ancestor === source.document.body,
      childList: true,
      subtree: ancestor === source.document.body,
    });
  }
  let invalid = false;
  return Object.freeze({
    isExact: (successor: PublishMenuPublication) => {
      if (observer) {
        for (const record of observer.takeRecords()) {
          if (record.type === "attributes") {
            if (
              record.target === trigger
              || (
                record.target instanceof source.document.defaultView!.HTMLSpanElement
                && (
                  potentialGuards.has(record.target)
                  || record.target.hasAttribute("data-radix-focus-guard")
                )
              )
            ) {
              records.push(record);
            }
            continue;
          }
          for (const node of [...record.addedNodes, ...record.removedNodes]) {
            if (node instanceof source.document.defaultView!.HTMLSpanElement) {
              potentialGuards.add(node);
            }
          }
          records.push(record);
        }
      }
      const content = successor.dom.content;
      const ownerWindow = source.document.defaultView;
      if (
        invalid
        || !content
        || !ownerWindow
        || source.dom.trigger !== successor.dom.trigger
        || source.document !== successor.document
      ) {
        invalid = true;
        return false;
      }
      for (const record of records) {
        if (record.type === "attributes" && record.target === trigger) {
          const validTriggerChange =
            (record.attributeName === "aria-expanded"
              && record.oldValue === "false"
              && trigger.getAttribute("aria-expanded") === "true")
            || (record.attributeName === "data-state"
              && record.oldValue === "closed"
              && trigger.getAttribute("data-state") === "open")
            || (record.attributeName === "aria-controls"
              && record.oldValue === null
              && trigger.getAttribute("aria-controls") === content.id)
            || record.attributeName === "data-radix-popper-align"
            || record.attributeName === "data-radix-popper-side";
          if (!validTriggerChange) invalid = true;
          continue;
        }
        if (record.type === "attributes") {
          const element = record.target;
          if (
            !(element instanceof ownerWindow.HTMLSpanElement)
            || !element.hasAttribute("data-radix-focus-guard")
          ) {
            invalid = true;
          }
          continue;
        }
        const changed = [...record.addedNodes, ...record.removedNodes];
        const expected = changed.every((node) =>
          node.contains?.(content)
          || (
            node instanceof ownerWindow.HTMLSpanElement
            && (
              node.hasAttribute("data-radix-focus-guard")
              || record.target === source.document.body
            )
          ));
        if (!expected) invalid = true;
      }
      return !invalid;
    },
    dispose: () => {
      observer?.disconnect();
      observer = null;
    },
  });
}

function publishMenuRenderSuccessorMatches(
  before: PublishMenuRender,
  after: PublishMenuRender,
) {
  return (
    after.visit === before.visit
    && after.props === before.props
    && after.session === before.session
    && after.document === before.document
    && after.role === before.role
    && after.linked === before.linked
    && after.canEdit === before.canEdit
    && after.isOwner === before.isOwner
    && after.githubConfigured === before.githubConfigured
    && after.publishing === before.publishing
    && after.sync === before.sync
    && after.syncFields === before.syncFields
    && after.actions.length === before.actions.length
    && after.actions.every((action, index) => {
      const previous = before.actions[index];
      return Boolean(
        previous
        && action.name === previous.name
        && action.enabled === previous.enabled
        && action.label === previous.label
        && action.callback === previous.callback
      );
    })
  );
}

function publishMenuOpenSuccessorTarget(
  intent: PublishMenuOpenIntent,
  publication: PublishMenuPublication,
) {
  const { source, action, authority } = intent;
  const currentAction = publication.render.actions.find(
    (candidate) => candidate.name === action.target?.name,
  );
  const target = currentAction ? publication.dom.actions[currentAction.name] : null;
  return (
    !source.render.open
    && publication.render.open
    && source.document === publication.document
    && source.dom.trigger === publication.dom.trigger
    && authority.ownerDocument === publication.document
    && authority.ownerWindow === publication.document.defaultView
    && authority.historyIsClean()
    && publishMenuNativeListenerProofMatches(
      intent.listenerProof,
      source,
      intent.nativeEvent,
      false,
    )
    && publishMenuArrowIsCurrent(source, action)
    && publishMenuRenderSuccessorMatches(source.render, publication.render)
    && currentAction?.enabled
    && target?.ownerDocument === publication.document
    && target.parentElement === publication.dom.content
    && publication.isExact()
    && intent.guard.isExact(publication)
  )
    ? target
    : null;
}

function createPublishMenuOwners(
  coordinator: PublishMenuPublicationCoordinator,
): PublishMenuOwners {
  const changed = <T extends HTMLElement>(
    owner: PublishMenuElementOwner<T>,
    element: T | null,
    previous: T | null,
  ) => coordinator.elementChanged(owner, element, previous);
  const accepts = (tagName: string) => (element: HTMLElement) => element.tagName === tagName;
  const replacement = () => coordinator.allowsElementReplacement();
  const actionOwner = () =>
    new PublishMenuElementOwner<HTMLDivElement>(accepts("DIV"), replacement, changed);
  return Object.freeze({
    trigger: new PublishMenuElementOwner<HTMLButtonElement>(
      accepts("BUTTON"),
      replacement,
      changed,
    ),
    content: new PublishMenuElementOwner<HTMLDivElement>(accepts("DIV"), replacement, changed),
    actions: Object.freeze({
      publish: actionOwner(),
      pull: actionOwner(),
      sync: actionOwner(),
      open: actionOwner(),
      change: actionOwner(),
      connect: actionOwner(),
      download: actionOwner(),
      share: actionOwner(),
    }),
  });
}

function publishMenuFactsAreCurrent(render: PublishMenuRender) {
  const { document, props, session } = render;
  const canEdit = session.canWrite;
  const currentDocumentFields = snapshotMoreMenuDocument(document);
  const actions = publishMenuActions(props, render.linked, canEdit);
  return (
    render.visit.session === session
    && render.visit.document === document
    && session.docId === document.id
    && session.role === render.role
    && document.storage !== "local" === render.linked
    && canEdit === render.canEdit
    && props.isOwner === render.isOwner
    && props.githubConfigured === render.githubConfigured
    && props.publishing === render.publishing
    && props.sync === render.sync
    && (props.sync ? JSON.stringify(props.sync) : null) === render.syncFields
    && currentDocumentFields.length === render.documentFields.length
    && currentDocumentFields.every((field, index) => {
      const expected = render.documentFields[index];
      return expected?.[0] === field[0] && Object.is(expected[1], field[1]);
    })
    && actions.length === render.actions.length
    && actions.every((action, index) => {
      const expected = render.actions[index];
      return Boolean(
        expected
        && action.name === expected.name
        && action.enabled === expected.enabled
        && action.label === expected.label
        && action.callback === expected.callback
      );
    })
  );
}

function currentPublishMenuDom(
  render: PublishMenuRender,
  owners: PublishMenuOwners,
): PublishMenuDom | null {
  const trigger = owners.trigger.element();
  const ownerDocument = trigger?.ownerDocument;
  const ownerWindow = ownerDocument?.defaultView;
  if (
    !trigger
    || !ownerDocument
    || !ownerWindow
    || !(trigger instanceof ownerWindow.HTMLButtonElement)
    || !trigger.isConnected
    || trigger.type !== "button"
    || trigger.disabled
    || trigger.dataset.testid !== "publish-menu"
    || trigger.getAttribute("aria-label") !== "Publish options"
    || trigger.className !==
      "btn btn-primary rounded-l-none border-l border-white/20 px-1.5"
    || trigger.getAttribute("aria-haspopup") !== "menu"
    || trigger.getAttribute("aria-expanded") !== String(render.open)
    || trigger.getAttribute("data-state") !== (render.open ? "open" : "closed")
  ) {
    return null;
  }
  const actions = Object.fromEntries(
    Object.entries(owners.actions).map(([name, owner]) => [name, owner.element()]),
  ) as Record<PublishMenuActionName, HTMLDivElement | null>;
  const content = owners.content.element();
  if (!render.open) {
    if (content || Object.values(actions).some(Boolean)) return null;
    return Object.freeze({
      trigger,
      content: null,
      actions: Object.freeze(actions),
    });
  }
  if (
    !content
    || !(content instanceof ownerWindow.HTMLDivElement)
    || !content.isConnected
    || content.ownerDocument !== ownerDocument
    || content.getAttribute("role") !== "menu"
    || content.getAttribute("data-state") !== "open"
    || content.className !==
      "menu animate-fade-in max-h-[var(--radix-dropdown-menu-content-available-height)] overflow-y-auto w-72"
  ) {
    return null;
  }
  const publishedElements: HTMLDivElement[] = [];
  for (const action of render.actions) {
    const element = actions[action.name];
    if (
      !element
      || !(element instanceof ownerWindow.HTMLDivElement)
      || !element.isConnected
      || element.ownerDocument !== ownerDocument
      || element.parentElement !== content
      || element.getAttribute("role") !== "menuitem"
      || (element.getAttribute("aria-disabled") === "true") !== !action.enabled
      || element.textContent !== action.label
    ) {
      return null;
    }
    publishedElements.push(element);
  }
  const actualElements = Array.from(content.children).filter(
    (element): element is HTMLDivElement =>
      element instanceof ownerWindow.HTMLDivElement
      && element.getAttribute("role") === "menuitem",
  );
  if (
    actualElements.length !== publishedElements.length
    || actualElements.some((element, index) => element !== publishedElements[index])
    || Object.entries(actions).some(([name, element]) =>
      !render.actions.some((action) => action.name === name) && element !== null)
  ) {
    return null;
  }
  return Object.freeze({
    trigger,
    content,
    actions: Object.freeze(actions),
  });
}

function publishMenuDomIsSame(current: PublishMenuDom, published: PublishMenuDom) {
  return (
    current.trigger === published.trigger
    && current.content === published.content
    && Object.keys(current.actions).every((name) =>
      current.actions[name as PublishMenuActionName]
      === published.actions[name as PublishMenuActionName])
  );
}

function publishMenuActions(
  props: HeaderProps,
  linked: boolean,
  canEdit: boolean,
): readonly PublishMenuAction[] {
  const action = (
    name: PublishMenuActionName,
    enabled: boolean,
    label: string,
    callback: unknown,
  ): PublishMenuAction => Object.freeze({
    identity: Object.freeze({}),
    name,
    enabled,
    label,
    callback,
  });
  const { doc } = props;
  return Object.freeze(linked
    ? [
        action(
          "publish",
          canEdit,
          doc.storage === "gist" ? "Update gist" : "Commit to GitHub…",
          props.onPublishNow,
        ),
        action(
          "pull",
          canEdit && props.sync?.status !== "remote-unreadable",
          "Pull latest from GitHub",
          props.onPull,
        ),
        action("sync", canEdit, "Sync…", props.onSync),
        ...(doc.githubUrl
          ? [action("open", true, "Open on GitHub", doc.githubUrl)]
          : []),
        ...(props.isOwner
          ? [action("change", true, "Change connection…", props.onPublish)]
          : []),
      ]
    : [
        action(
          "connect",
          props.isOwner && props.githubConfigured,
          `Gist or repository…${props.githubConfigured ? "" : GITHUB_NOT_CONFIGURED}`,
          props.onPublish,
        ),
        action("download", true, "Download Markdown", props.onDownload),
        action("share", true, "Share link…", props.onShare),
      ]);
}

function createPublishMenuPresentation({
  render,
  coordinator,
  owners,
  commitOpen,
}: {
  render: PublishMenuRender;
  coordinator: PublishMenuPublicationCoordinator;
  owners: PublishMenuOwners;
  commitOpen: (state: PublishMenuState) => void;
}): PublishMenuPresentation {
  const runtimeState: {
    current: PublishMenuPublicationRuntime | null;
    last: PublishMenuPublicationRuntime | null;
  } = { current: null, last: null };

  const createRuntime = (dom: PublishMenuDom): PublishMenuPublicationRuntime => {
    type Retirement = "element" | "layout" | "mutation" | "other";
    const triggerSnapshot = snapshotModeSwitcherDom(dom.trigger);
    const contentSnapshot = dom.content ? snapshotModeSwitcherDom(dom.content) : null;
    const placements = snapshotModeSwitcherPlacement(
      dom.content ? [dom.trigger, dom.content] : [dom.trigger],
    );
    const placementNodes = new Set(placements.map(({ node }) => node));
    const expectedOwners = new Map<PublishMenuElementOwnerHandle, HTMLElement>([
      [owners.trigger, dom.trigger],
    ]);
    if (dom.content) {
      expectedOwners.set(owners.content, dom.content);
      for (const action of render.actions) {
        const element = dom.actions[action.name];
        if (element) expectedOwners.set(owners.actions[action.name], element);
      }
    }
    const detached = new Set<PublishMenuElementOwnerHandle>();
    const reattached = new Set<PublishMenuElementOwnerHandle>();
    let replayInvalid = false;
    let retired = false;
    let retirement: Retirement | null = null;
    let mutationSeen = false;
    const MutationObserverConstructor = dom.trigger.ownerDocument.defaultView?.MutationObserver;
    let observer: MutationObserver | null = null;
    const relevantMutation = (record: MutationRecord) => {
      if (
        record.type === "attributes"
        && record.attributeName
        && MODE_SWITCHER_DYNAMIC_ATTRIBUTES.has(record.attributeName)
      ) {
        return false;
      }
      const roots = dom.content ? [dom.trigger, dom.content] : [dom.trigger];
      if (roots.some((root) => record.target === root || root.contains(record.target))) return true;
      if (record.type !== "childList") return false;
      return (
        (record.previousSibling !== null && placementNodes.has(record.previousSibling))
        || (record.nextSibling !== null && placementNodes.has(record.nextSibling))
        || [...record.addedNodes, ...record.removedNodes].some((node) =>
          roots.some((root) => node === root || node.contains?.(root)))
      );
    };
    function inspectMutations(records: readonly MutationRecord[]) {
      if (records.some(relevantMutation)) {
        mutationSeen = true;
        retire("mutation");
      }
    }
    const mutationHistoryIsClean = () => {
      if (observer) inspectMutations(observer.takeRecords());
      return !mutationSeen;
    };
    const recordElementChange = (
      owner: PublishMenuElementOwnerHandle,
      element: HTMLElement | null,
      previous: HTMLElement | null,
    ) => {
      const expected = expectedOwners.get(owner);
      if (!expected || replayInvalid) return;
      if (!retired) retire("element");
      if (retirement !== "element") return;
      if (element === null) {
        if (previous !== expected || detached.has(owner) || reattached.size > 0) {
          replayInvalid = true;
          return;
        }
        detached.add(owner);
        return;
      }
      if (
        previous !== null
        || element !== expected
        || detached.size !== expectedOwners.size
        || !detached.has(owner)
        || reattached.has(owner)
      ) {
        replayInvalid = true;
        return;
      }
      reattached.add(owner);
    };
    const isExactElementReplay = () => (
      retired
      && retirement === "element"
      && !replayInvalid
      && detached.size === expectedOwners.size
      && reattached.size === expectedOwners.size
      && publication.isExact()
    );
    const publicationDocument = dom.trigger.ownerDocument;
    const ownerWindow = publicationDocument.defaultView;
    const keyboardAuthority = ownerWindow
      ? capturePublishMenuKeyboardAuthority(
          publicationDocument,
          ownerWindow as Window & typeof globalThis,
        )
      : null;
    const keyboardEvents: PublishMenuKeyboardStorage = {
      current: new WeakMap(),
      seen: new WeakSet(),
      reading: false,
    };
    const identity = Object.freeze({});
    const first = render.enabledActions.at(0) ?? null;
    const last = render.enabledActions.at(-1) ?? null;
    const arrows: Readonly<Record<PublishMenuArrowKey, PublishMenuArrowAction>> = Object.freeze({
      ArrowDown: Object.freeze({
        identity: Object.freeze({}),
        publicationIdentity: identity,
        key: "ArrowDown",
        destination: "first",
        target: first,
      }),
      ArrowUp: Object.freeze({
        identity: Object.freeze({}),
        publicationIdentity: identity,
        key: "ArrowUp",
        destination: "last",
        target: last,
      }),
    });
    let keyboardListenerAttached = false;
    const keyboardListener: PublishMenuKeyboardListener = function (event) {
      coordinator.stageNative(publication, keyboardListenerRegistration, this, event);
    };
    const keyboardListenerRegistration: PublishMenuKeyboardListenerRegistration = Object.freeze({
      identity: Object.freeze({}),
      publicationIdentity: identity,
      target: ownerWindow!,
      listener: keyboardListener,
      capture: true,
      isCurrent: () => Boolean(
        keyboardListenerAttached
        && !retired
        && publication.keyboardListener === keyboardListenerRegistration
        && coordinator.active() === publication
      ),
    });
    const releaseKeyboardListener = () => {
      if (!keyboardAuthority || !keyboardListenerAttached) return;
      publishMenuNativeCall<void>(
        keyboardAuthority.removeEventListener,
        keyboardListenerRegistration.target,
        ["keydown", keyboardListenerRegistration.listener, keyboardListenerRegistration.capture],
        keyboardAuthority,
      );
      keyboardListenerAttached = false;
    };
    const publication: PublishMenuPublication = Object.freeze({
      identity,
      render,
      document: publicationDocument,
      dom,
      keyboardAuthority,
      keyboardListener: keyboardAuthority ? keyboardListenerRegistration : null,
      keyboardEvents,
      arrows,
      triggerSnapshot,
      contentSnapshot,
      placements,
      isExact: () => {
        if (
          !mutationHistoryIsClean()
          || !keyboardAuthority?.historyIsClean()
          || !publishMenuFactsAreCurrent(render)
        ) {
          return false;
        }
        const current = currentPublishMenuDom(render, owners);
        return Boolean(
          current
          && publishMenuDomIsSame(current, dom)
          && placements.every(modeSwitcherPlacementMatches)
          && modeSwitcherDomSnapshotMatches(triggerSnapshot)
          && (!contentSnapshot || modeSwitcherDomSnapshotMatches(contentSnapshot))
        );
      },
      recordElementChange,
      isExactElementReplay,
      retire: () => retire("other"),
      dispose: () => {
        observer?.disconnect();
        observer = null;
        coordinator.clearKeyboardEvents(publication);
        releaseKeyboardListener();
      },
    });
    function retire(reason: Retirement) {
      if (retired) return false;
      retired = true;
      retirement = reason;
      releaseKeyboardListener();
      coordinator.retire(publication);
      if (runtimeState.current?.publication === publication) runtimeState.current = null;
      return true;
    }
    const runtime: PublishMenuPublicationRuntime = Object.freeze({
      publication,
      retireForLayout: () => retire(mutationSeen ? "mutation" : "layout"),
      isExactElementReplay,
      isExactLayoutReplay: () => (
        retired
        && retirement === "layout"
        && publication.isExact()
      ),
    });
    if (keyboardAuthority) {
      publishMenuNativeCall<void>(
        keyboardAuthority.addEventListener,
        keyboardListenerRegistration.target,
        ["keydown", keyboardListenerRegistration.listener, keyboardListenerRegistration.capture],
        keyboardAuthority,
      );
      keyboardListenerAttached = true;
    }
    if (MutationObserverConstructor) {
      observer = new MutationObserverConstructor(inspectMutations);
      observer.observe(dom.trigger, {
        attributes: true,
        characterData: true,
        childList: true,
        subtree: true,
      });
      for (let ancestor: Node | null = dom.trigger.parentNode; ancestor; ancestor = ancestor.parentNode) {
        observer.observe(ancestor, { childList: true });
      }
      if (dom.content) {
        observer.observe(dom.content, {
          attributes: true,
          characterData: true,
          childList: true,
          subtree: true,
        });
        for (let ancestor: Node | null = dom.content.parentNode; ancestor; ancestor = ancestor.parentNode) {
          observer.observe(ancestor, { childList: true });
        }
      }
    }
    return runtime;
  };

  const currentPublication = () => {
    const runtime = runtimeState.current;
    const publication = runtime?.publication;
    return runtime
      && publication
      && coordinator.active() === publication
      && publication.render === render
      && publication.isExact()
      ? publication
      : null;
  };
  const stageReact = (
    boundary: PublishMenuReactBoundary,
    event: React.KeyboardEvent<HTMLButtonElement>,
  ) => {
    const publication = runtimeState.current?.publication;
    if (!publication) return;
    coordinator.runKeyboardDelivery(publication, () => {
      if (currentPublication() === publication) coordinator.stageReact(publication, boundary, event);
    });
  };
  const onTriggerKeyDownCapture = (event: React.KeyboardEvent<HTMLButtonElement>) =>
    stageReact("captureTrigger", event);
  const onBoundaryKeyDownCapture = (event: React.KeyboardEvent<HTMLButtonElement>) =>
    stageReact("captureBoundary", event);
  const onTriggerKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) =>
    stageReact("bubbleTrigger", event);
  const onTriggerArrowKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    const publication = runtimeState.current?.publication;
    if (!publication) return;
    const opened = coordinator.runKeyboardDelivery(publication, () => {
      if (currentPublication() !== publication) return false;
      const claim = coordinator.claim(publication, event);
      if (!claim) return false;
      if (!coordinator.prepareOpen(claim) || !preventPublishMenuArrow(claim)) return false;
      if (
        !claim.retains()
        || !publication.retire()
        || !publishMenuNativeEventMatches(claim.delivery, "bubble", true, false)
        || !coordinator.canCommitOpen(publication)
      ) {
        return false;
      }
      commitOpen(Object.freeze({ visit: render.visit, open: true }));
      return true;
    });
    if (!opened && !publication.keyboardEvents.reading) coordinator.cancelOpen(publication);
  };
  const onOpenChange = (open: boolean) => {
    if (runtimeState.current?.publication.keyboardEvents.reading) return;
    if (render.open === open) return;
    const publication = currentPublication();
    if (publication) publication.retire();
    commitOpen(Object.freeze({ visit: render.visit, open }));
  };
  const onOpenAutoFocus = (event: Event) => {
    let publication = currentPublication();
    if (!publication) {
      establish();
      publication = currentPublication();
    }
    if (!publication) return;
    const ready = coordinator.consumeOpen(publication, event);
    if (!ready) return;
    if (
      !publishMenuAutoFocusEventMatches(
        ready.autoFocusProof,
        publication,
        event,
        ready.authority,
        false,
      )
      || !publishMenuNativeListenerProofMatches(
        ready.listenerProof,
        ready.source,
        ready.nativeEvent,
        false,
      )
    ) {
      return;
    }
    publishMenuNativeCall<void>(
      ready.authority.event.preventDefault,
      event,
      [],
      ready.authority,
    );
    if (
      !publishMenuAutoFocusEventMatches(
        ready.autoFocusProof,
        publication,
        event,
        ready.authority,
        true,
      )
      || !publishMenuNativeListenerProofMatches(
        ready.listenerProof,
        ready.source,
        ready.nativeEvent,
        false,
      )
      || !publication.isExact()
    ) {
      return;
    }
    publishMenuNativeCall<void>(
      ready.authority.focus,
      ready.target,
      [{ preventScroll: true }],
      ready.authority,
    );
  };
  function establish() {
    if (runtimeState.current) return undefined;
    if (
      (
        runtimeState.last
        && !runtimeState.last.isExactLayoutReplay()
        && !runtimeState.last.isExactElementReplay()
      )
      || !publishMenuFactsAreCurrent(render)
    ) {
      return undefined;
    }
    const dom = currentPublishMenuDom(render, owners);
    if (!dom) return undefined;
    const runtime = createRuntime(dom);
    runtimeState.current = runtime;
    runtimeState.last = runtime;
    coordinator.publish(runtime.publication);
    return runtime.retireForLayout;
  }
  return Object.freeze({
    captureTrigger: owners.trigger.capture,
    captureContent: owners.content.capture,
    captureActions: Object.freeze(
      Object.fromEntries(
        Object.entries(owners.actions).map(([name, owner]) => [name, owner.capture]),
      ) as Record<PublishMenuActionName, React.RefCallback<HTMLDivElement>>,
    ),
    establish,
    onTriggerKeyDownCapture,
    onBoundaryKeyDownCapture,
    onTriggerKeyDown,
    onTriggerArrowKeyDown,
    onOpenChange,
    onOpenAutoFocus,
  });
}

function PublishMenuOpenCommit({ presentation }: { presentation: PublishMenuPresentation }) {
  useLayoutEffect(() => presentation.establish(), [presentation]);
  return null;
}

function PublishMenuTriggerButton({
  onKeyDownCapture,
  onKeyDown,
  onDirectionalKeyDownCapture,
  onDirectionalTriggerKeyDown,
  onDirectionalKeyDown,
  ...props
}: React.ComponentProps<"button"> & {
  onDirectionalKeyDownCapture: React.KeyboardEventHandler<HTMLButtonElement>;
  onDirectionalTriggerKeyDown: React.KeyboardEventHandler<HTMLButtonElement>;
  onDirectionalKeyDown: React.KeyboardEventHandler<HTMLButtonElement>;
}) {
  const handlingKey = useRef(false);
  return (
    <button
      {...props}
      onKeyDownCapture={(event) => {
        if (handlingKey.current) return;
        handlingKey.current = true;
        try {
          onDirectionalKeyDownCapture(event);
          onKeyDownCapture?.(event);
        } finally {
          handlingKey.current = false;
        }
      }}
      onKeyDown={(event) => {
        if (handlingKey.current) return;
        handlingKey.current = true;
        try {
          let directional: boolean;
          try {
            const key = event.key;
            const nativeKey = event.nativeEvent.key;
            directional = key === "ArrowDown" || key === "ArrowUp"
              || nativeKey === "ArrowDown" || nativeKey === "ArrowUp";
          } catch {
            return;
          }
          if (directional) {
            onDirectionalTriggerKeyDown(event);
            onDirectionalKeyDown(event);
          } else {
            onKeyDown?.(event);
          }
        } finally {
          handlingKey.current = false;
        }
      }}
    />
  );
}

// The arrow shares Radix's trigger ref with the Publish button beside it. When the status chip takes that
// button's place its unmount clears the shared ref, and the menu can no longer hand focus back to the arrow on
// close. A ref whose identity follows the swap makes the arrow register again in the same commit (#2215).
const ARROW_BESIDE_PUBLISH = () => undefined;
const ARROW_BESIDE_STATUS = () => undefined;

function PublishMenu({ props }: { props: HeaderProps }) {
  const { doc, session, githubConfigured } = props;
  const linked = doc.storage !== "local";
  const canEdit = useSessionValue(session, (current) => current.canWrite);
  // The sync status the chip shows; null while the plain Publish button stands in its place.
  const chipSync = linked && canEdit ? props.sync : null;
  const [mount] = useState(() => Symbol("publish menu"));
  const [, setPublicationRevision] = useState(0);
  const [coordinator] = useState(
    () => new PublishMenuPublicationCoordinator(
      () => setPublicationRevision((revision) => revision + 1),
    ),
  );
  const [owners] = useState(() => createPublishMenuOwners(coordinator));
  const visit = useMemo<PublishMenuVisit>(
    () => Object.freeze({ mount, session, document: doc }),
    [doc, mount, session],
  );
  const initialState = useMemo<PublishMenuState>(
    () => Object.freeze({ visit, open: false }),
    [visit],
  );
  const [storedState, setStoredState] = useState(initialState);
  const state = storedState.visit === visit ? storedState : initialState;
  const actions = publishMenuActions(props, linked, canEdit);
  const render: PublishMenuRender = Object.freeze({
    identity: Object.freeze({}),
    visit,
    props,
    session,
    document: doc,
    documentFields: snapshotMoreMenuDocument(doc),
    sync: props.sync,
    syncFields: props.sync ? JSON.stringify(props.sync) : null,
    role: session.role,
    linked,
    canEdit,
    isOwner: props.isOwner,
    githubConfigured,
    publishing: props.publishing,
    open: state.open,
    actions,
    enabledActions: Object.freeze(actions.filter((action) => action.enabled)),
  });
  const presentation = createPublishMenuPresentation({
    render,
    coordinator,
    owners,
    commitOpen: setStoredState,
  });
  useLayoutEffect(() => presentation.establish(), [presentation]);
  const {
    captureTrigger,
    captureContent,
    captureActions: {
      publish: capturePublish,
      pull: capturePull,
      sync: captureSync,
      open: captureOpen,
      change: captureChange,
      connect: captureConnect,
      download: captureDownload,
      share: captureShare,
    },
    onTriggerKeyDownCapture,
    onBoundaryKeyDownCapture,
    onTriggerKeyDown,
    onTriggerArrowKeyDown,
    onOpenChange,
    onOpenAutoFocus,
  } = presentation;
  const openAutoFocusProps = { onOpenAutoFocus };

  return (
    <Menu open={state.open} onOpenChange={onOpenChange}>
      <div className="flex items-stretch max-md:hidden" data-sync-status={linked ? (props.sync?.status ?? "unknown") : undefined}>
        {chipSync ? (
          <PublishStatusButton sync={chipSync} publishing={props.publishing} onPublishNow={props.onPublishNow} onPull={props.onPull} onSync={props.onSync} />
        ) : (
          <MenuTrigger asChild>
            <button type="button" className="btn btn-primary gap-1.5 rounded-r-none pl-4 pr-3" disabled={props.publishing} data-testid="publish-button" {...{ [STATUS_CHIP_PLACE]: "" }}>
              {props.publishing ? <Loader2 size={16} className="animate-spin" /> : null}
              Publish
            </button>
          </MenuTrigger>
        )}
        <MenuTrigger asChild ref={chipSync ? ARROW_BESIDE_STATUS : ARROW_BESIDE_PUBLISH} onKeyDownCapture={onBoundaryKeyDownCapture}>
          <PublishMenuTriggerButton
            ref={captureTrigger}
            type="button"
            className="btn btn-primary rounded-l-none border-l border-white/20 px-1.5"
            disabled={props.publishing}
            aria-label="Publish options"
            data-testid="publish-menu"
            onDirectionalKeyDownCapture={onTriggerKeyDownCapture}
            onDirectionalTriggerKeyDown={onTriggerKeyDown}
            onDirectionalKeyDown={onTriggerArrowKeyDown}
          >
            <ChevronDown size={16} className="opacity-80" />
          </PublishMenuTriggerButton>
        </MenuTrigger>
      </div>
      {state.open && (
        <MenuContent
          ref={captureContent}
          align="end"
          className="w-72"
          {...openAutoFocusProps}
        >
          {linked ? (
            <>
            <MenuLabel>
              {doc.storage === "gist" ? "Gist" : `${doc.repoOwner}/${doc.repoName} · ${doc.repoBranch}`}
              {props.sync && <span className="ml-1 font-normal text-ink-3">· {SYNC_LABELS[props.sync.status]}</span>}
            </MenuLabel>
            <MenuItem ref={capturePublish} icon={<UploadCloud size={15} />} onSelect={props.onPublishNow} disabled={!canEdit}>
              {doc.storage === "gist" ? "Update gist" : "Commit to GitHub…"}
            </MenuItem>
            <MenuItem ref={capturePull} icon={<RefreshCw size={15} />} onSelect={props.onPull} disabled={!canEdit || props.sync?.status === "remote-unreadable"}>
              Pull latest from GitHub
            </MenuItem>
            <MenuItem ref={captureSync} icon={<GitMerge size={15} />} onSelect={props.onSync} disabled={!canEdit} data-testid="menu-sync">
              Sync…
            </MenuItem>
            {doc.githubUrl && (
              <MenuItem ref={captureOpen} icon={<ExternalLink size={15} />} onSelect={() => window.open(doc.githubUrl!, "_blank", "noopener")}>
                Open on GitHub
              </MenuItem>
            )}
            {props.isOwner && (
              <>
                <MenuSeparator />
                <MenuItem ref={captureChange} icon={<Link2 size={15} />} onSelect={props.onPublish}>
                  Change connection…
                </MenuItem>
              </>
            )}
            </>
          ) : (
            <>
            <MenuLabel>Publish to GitHub</MenuLabel>
            <MenuItem
              ref={captureConnect}
              icon={<GitHubIcon size={15} />}
              onSelect={props.onPublish}
              disabled={!props.isOwner || !githubConfigured}
              title={!githubConfigured ? GITHUB_NOT_CONFIGURED : undefined}
              data-testid="menu-publish-github"
            >
              <GitHubEntryLabel configured={githubConfigured}>Gist or repository…</GitHubEntryLabel>
            </MenuItem>
            <MenuSeparator />
            <MenuItem ref={captureDownload} icon={<Download size={15} />} onSelect={() => props.onDownload("md", false)}>
              Download Markdown
            </MenuItem>
            <MenuItem ref={captureShare} icon={<Share2 size={15} />} onSelect={props.onShare}>
              Share link…
            </MenuItem>
            </>
          )}
          <PublishMenuOpenCommit presentation={presentation} />
        </MenuContent>
      )}
    </Menu>
  );
}

type MoreMenuActionName = "history" | "name-version" | "duplicate" | "delete";

interface MoreMenuVisit {
  readonly mount: symbol;
  readonly session: CollabSession;
  readonly document: DocumentDto;
}

interface MoreMenuState {
  readonly visit: MoreMenuVisit;
  readonly open: boolean;
}

interface MoreMenuAction {
  readonly name: MoreMenuActionName;
  readonly callback: () => void;
  readonly eligible: boolean;
  readonly label: string;
  readonly testId: string | null;
  readonly className: string;
  readonly iconClassName: string;
  readonly busy: boolean;
}

interface MoreMenuRender {
  readonly identity: object;
  readonly visit: MoreMenuVisit;
  readonly props: HeaderProps;
  readonly session: CollabSession;
  readonly document: DocumentDto;
  readonly documentFields: readonly (readonly [string, unknown])[];
  readonly bindings: readonly unknown[];
  readonly docId: string;
  readonly role: CollabSession["role"];
  readonly mode: EditMode;
  readonly setMode: CollabSession["setMode"];
  readonly compact: boolean;
  readonly linked: boolean;
  readonly canEdit: boolean;
  readonly isOwner: boolean;
  readonly githubConfigured: boolean;
  readonly publishing: boolean;
  readonly documentMutation: HeaderProps["documentMutation"];
  readonly open: boolean;
  readonly actions: Readonly<Record<MoreMenuActionName, MoreMenuAction>>;
}

interface MoreMenuDom {
  readonly trigger: HTMLButtonElement;
  readonly content: HTMLDivElement | null;
  readonly actions: Readonly<Record<MoreMenuActionName, HTMLDivElement | null>>;
}

interface MoreMenuPublication {
  readonly render: MoreMenuRender;
  readonly document: Document;
  readonly dom: MoreMenuDom;
  readonly triggerSnapshot: ModeSwitcherDomSnapshot;
  readonly contentSnapshot: ModeSwitcherDomSnapshot | null;
  readonly placements: readonly ModeSwitcherPlacementSnapshot[];
  readonly isExact: () => boolean;
  readonly recordElementChange: (
    owner: MoreMenuElementOwnerHandle,
    element: HTMLElement | null,
    previous: HTMLElement | null,
  ) => void;
  readonly isExactElementReplay: () => boolean;
  readonly retire: () => boolean;
  readonly dispose: () => void;
}

interface MoreMenuPublicationRuntime {
  readonly publication: MoreMenuPublication;
  readonly retireForLayout: () => void;
  readonly isExactLayoutReplay: () => boolean;
}

interface MoreMenuDisclosureIntent {
  readonly publication: MoreMenuPublication;
  readonly open: boolean;
  readonly returnFocus: boolean;
  readonly events: readonly Event[];
}

interface MoreMenuSelectionIntent {
  readonly publication: MoreMenuPublication;
  readonly action: MoreMenuAction;
  readonly nativeEvent: MouseEvent;
  readonly target: Node;
  readonly path: readonly EventTarget[];
}

interface MoreMenuGenericSelectionIntent {
  readonly nativeEvent: MouseEvent;
  readonly target: Node;
  readonly item: HTMLElement;
  readonly path: readonly EventTarget[];
}

interface MoreMenuFocusIntent {
  readonly source: MoreMenuPublication;
  readonly visit: MoreMenuVisit;
  readonly target: HTMLButtonElement;
  readonly action: MoreMenuActionName | null;
  readonly modes: readonly EditMode[];
  readonly guard: MoreMenuFocusGuard;
}

interface MoreMenuFocusGuard {
  readonly isExact: (publication: MoreMenuPublication) => boolean;
  readonly dispose: () => void;
}

interface MoreMenuPresentation {
  readonly captureTrigger: React.RefCallback<HTMLButtonElement>;
  readonly captureContent: React.RefCallback<HTMLDivElement>;
  readonly captureHistory: React.RefCallback<HTMLDivElement>;
  readonly captureNameVersion: React.RefCallback<HTMLDivElement>;
  readonly captureDuplicate: React.RefCallback<HTMLDivElement>;
  readonly captureDelete: React.RefCallback<HTMLDivElement>;
  readonly establish: () => (() => void) | undefined;
  readonly onTriggerPointerDown: (event: React.PointerEvent<HTMLButtonElement>) => void;
  readonly onTriggerKeyDown: (event: React.KeyboardEvent<HTMLButtonElement>) => void;
  readonly onOpenChange: (open: boolean) => void;
  readonly onHistorySelect: (event: Event) => void;
  readonly onNameVersionSelect: (event: Event) => void;
  readonly onDuplicateSelect: (event: Event) => void;
  readonly onDeleteSelect: (event: Event) => void;
  readonly onEscapeKeyDown: (event: KeyboardEvent) => void;
  readonly onOutside: (event: CustomEvent<{ originalEvent: Event }>) => void;
  readonly onCloseAutoFocus: (event: Event) => void;
  readonly closeForPlainSelect: () => boolean;
}

class MoreMenuElementOwner<T extends HTMLElement> {
  #current: T | null = null;
  #last: T | null = null;

  constructor(
    private readonly accepts: (element: T) => boolean,
    private readonly allowsReplacement: () => boolean,
    private readonly onChange: (
      owner: MoreMenuElementOwner<T>,
      element: T | null,
      previous: T | null,
    ) => void,
  ) {}

  readonly element = () => this.#current;

  readonly capture: React.RefCallback<T> = (element) => {
    if (this.#current === element) return;
    if (
      element
      && (
        !this.accepts(element)
        || (this.#current !== null && this.#current !== element)
        || (
          this.#current === null
          && this.#last !== null
          && this.#last !== element
          && !this.allowsReplacement()
        )
      )
    ) {
      return;
    }
    const previous = this.#current;
    if (element === null) {
      this.onChange(this, null, previous);
      this.#current = null;
      return;
    }
    this.#current = element;
    this.#last = element;
    this.onChange(this, element, previous);
  };
}

interface MoreMenuElementOwnerHandle {
  readonly element: () => HTMLElement | null;
}

interface MoreMenuOwners {
  readonly trigger: MoreMenuElementOwner<HTMLButtonElement>;
  readonly content: MoreMenuElementOwner<HTMLDivElement>;
  readonly actions: Readonly<Record<MoreMenuActionName, MoreMenuElementOwner<HTMLDivElement>>>;
}

class MoreMenuPublicationCoordinator {
  #active: MoreMenuPublication | null = null;
  #successorOf: MoreMenuPublication | null = null;
  #disclosureIntent: MoreMenuDisclosureIntent | null = null;
  #selectionIntent: MoreMenuSelectionIntent | null = null;
  #focusIntent: MoreMenuFocusIntent | null = null;
  #claimedPublications = new WeakSet<MoreMenuPublication>();
  #claimedActions = new WeakSet<MoreMenuAction>();
  #claimedEvents = new WeakSet<Event>();
  #stagedNativeEvents = new WeakSet<Event>();
  #dispatchedSelectionCustomEvent: Event | null = null;
  #selectionCustomEvent: Event | null = null;
  #selectionTerminalRelease: (() => void) | null = null;
  #dispatchedOutsideCustomEvents = new WeakMap<Event, Event>();
  #outsideCustomEvents = new WeakMap<Event, Event>();
  #taintedOutsideNativeEvents = new WeakSet<Event>();
  #requestedSuccessors = new WeakSet<MoreMenuPublication>();
  #unpublishedChangeRequested = false;
  #dispatchObserverPublication: MoreMenuPublication | null = null;
  #dispatchObserverRestorers: Array<readonly [EventTarget, () => boolean]> = [];
  #observedOutsideTargets = new WeakSet<EventTarget>();
  #unsafeDispatchTargets = new WeakSet<EventTarget>();

  constructor(private readonly requestSuccessor: () => void) {}

  active() {
    return this.#active;
  }

  allowsElementReplacement() {
    return this.#active === null;
  }

  publish(publication: MoreMenuPublication) {
    const previous = this.#active ?? this.#successorOf;
    this.#clearDispatchObservers();
    this.#active = publication;
    this.#successorOf = null;
    this.#unpublishedChangeRequested = false;
    const focus = this.#focusIntent;
    const focusTarget = focus && moreMenuFocusSuccessorIsExact(focus, publication)
      ? focus.target
      : null;
    if (focus) this.#clearFocus(focus);
    if (previous && previous !== publication) previous.dispose();
    this.#dispatchObserverPublication = publication;
    for (const item of Object.values(publication.dom.actions)) {
      if (!item) continue;
      if (this.#unsafeDispatchTargets.has(item)) {
        this.#clearDispatchObservers(publication);
        publication.retire();
        return false;
      }
      const restore = installMoreMenuDispatchObserver(
        publication.document.defaultView,
        item,
        (target, event) => this.observeDispatchedCustom(publication, target, event),
      );
      if (!restore) {
        this.#unsafeDispatchTargets.add(item);
        this.#clearDispatchObservers(publication);
        publication.retire();
        return false;
      }
      this.#dispatchObserverRestorers.push([item, restore]);
    }
    focusTarget?.focus();
    return true;
  }

  retire(publication: MoreMenuPublication) {
    if (this.#active !== publication) return false;
    this.#active = null;
    this.#successorOf = publication;
    if (this.#disclosureIntent?.publication === publication) this.#disclosureIntent = null;
    if (this.#selectionIntent?.publication === publication) {
      this.#clearSelection(this.#selectionIntent);
    }
    queueMicrotask(() => {
      if (this.#active !== null || this.#successorOf !== publication) return;
      this.#successorOf = null;
      this.#clearDispatchObservers(publication);
      publication.dispose();
    });
    return true;
  }

  acceptsSuccessorOf(publication: MoreMenuPublication) {
    return this.#active === null && this.#successorOf === publication;
  }

  requestReplacement(publication: MoreMenuPublication) {
    if (
      !this.acceptsSuccessorOf(publication)
      || this.#requestedSuccessors.has(publication)
    ) {
      return;
    }
    this.#requestedSuccessors.add(publication);
    this.requestSuccessor();
  }

  elementChanged(
    owner: MoreMenuElementOwnerHandle,
    element: HTMLElement | null,
    previous: HTMLElement | null,
  ) {
    const focus = this.#focusIntent;
    if (focus && previous === focus.target && element !== focus.target) this.#clearFocus(focus);
    const publication = this.#active;
    if (!publication) {
      if (!this.#unpublishedChangeRequested) {
        this.#unpublishedChangeRequested = true;
        this.requestSuccessor();
      }
      return;
    }
    const exactBeforeChange = publication.isExact();
    publication.recordElementChange(owner, element, previous);
    if (
      !this.#requestedSuccessors.has(publication)
      && this.acceptsSuccessorOf(publication)
      && (exactBeforeChange || publication.isExactElementReplay())
    ) {
      this.#requestedSuccessors.add(publication);
      this.requestSuccessor();
    }
  }

  claimDisclosure(events: readonly Event[]) {
    const unique = new Set(events);
    if (
      unique.size !== events.length
      || events.some((event) => this.#claimedEvents.has(event))
    ) {
      return false;
    }
    for (const event of events) this.#claimedEvents.add(event);
    return true;
  }

  publishDisclosure(
    publication: MoreMenuPublication,
    open: boolean,
    events: readonly Event[],
    returnFocus = true,
  ) {
    const intent = Object.freeze({
      publication,
      open,
      returnFocus,
      events: Object.freeze([...events]),
    });
    this.#disclosureIntent = intent;
    queueMicrotask(() => {
      if (this.#disclosureIntent === intent) this.#disclosureIntent = null;
    });
  }

  consumeDisclosure(publication: MoreMenuPublication, open: boolean) {
    const intent = this.#disclosureIntent;
    if (
      intent?.publication !== publication
      || intent.open !== open
      || this.#active !== publication
      || !publication.isExact()
      || !intent.events.some((event) =>
        isLiveMoreMenuNativeEvent(event, publication.document))
    ) {
      return null;
    }
    this.#disclosureIntent = null;
    return intent;
  }

  stageSelection(
    publication: MoreMenuPublication,
    action: MoreMenuAction,
    nativeEvent: MouseEvent,
    target: Node,
    path: readonly EventTarget[],
  ) {
    const previousIntent = this.#selectionIntent;
    if (
      previousIntent
      && !isLiveMoreMenuNativeEvent(
        previousIntent.nativeEvent,
        previousIntent.publication.document,
      )
    ) {
      this.#clearSelection(previousIntent);
    }
    if (
      this.#active !== publication
      || this.#stagedNativeEvents.has(nativeEvent)
      || this.#claimedEvents.has(nativeEvent)
      || this.#claimedPublications.has(publication)
      || this.#claimedActions.has(action)
      || this.#selectionIntent !== null
      || this.#selectionTerminalRelease !== null
    ) {
      return false;
    }
    this.#stagedNativeEvents.add(nativeEvent);
    this.#dispatchedSelectionCustomEvent = null;
    this.#selectionCustomEvent = null;
    const intent = Object.freeze({
      publication,
      action,
      nativeEvent,
      target,
      path: Object.freeze([...path]),
    });
    const clearSelection = () => this.#clearSelection(intent);
    const terminalRelease = installMoreMenuNativeClickTerminal(
      publication,
      nativeEvent,
      target,
      intent.path,
      clearSelection,
      clearSelection,
    );
    if (!terminalRelease) return false;
    this.#selectionIntent = intent;
    this.#selectionTerminalRelease = terminalRelease;
    queueMicrotask(() => {
      const ownerWindow = publication.document.defaultView;
      if (
        this.#selectionIntent === intent
        && (
          !isLiveMoreMenuNativeEvent(nativeEvent, publication.document)
          || Boolean(
            ownerWindow
            && nativeEventGetter<boolean>(
              ownerWindow.Event.prototype,
              "cancelBubble",
              nativeEvent,
            ) === true
          )
        )
      ) {
        this.#clearSelection(intent);
      }
    });
    return true;
  }

  observeDispatchedCustom(
    publication: MoreMenuPublication,
    dispatchTarget: EventTarget,
    customEvent: Event,
  ): MoreMenuDispatchCompletion | null {
    if (this.#active !== publication || !publication.isExact()) return null;
    const intent = this.#selectionIntent;
    const item = intent && publication.dom.actions[intent.action.name];
    if (
      intent
      && intent.publication === publication
      && item
      && dispatchTarget === item
      && exactMoreMenuUndispatchedSelect(publication, item, customEvent)
      && moreMenuNativeClickIsAtRadixSelection(
        publication,
        item,
        intent.nativeEvent,
        intent.target,
        intent.path,
      )
    ) {
      const completeSelection: MoreMenuDispatchCompletion = (reachedTarget) => {
        if (
          !reachedTarget
          && this.#selectionIntent === intent
          && this.#dispatchedSelectionCustomEvent === customEvent
        ) {
          this.#clearSelection(intent);
        }
      };
      const dispatched = this.#dispatchedSelectionCustomEvent;
      if (dispatched) {
        if (dispatched === customEvent) return completeSelection;
        const ownerWindow = publication.document.defaultView;
        if (
          ownerWindow
          && nativeEventGetter<number>(
            ownerWindow.Event.prototype,
            "eventPhase",
            dispatched,
          ) !== ownerWindow.Event.NONE
        ) {
          return null;
        }
      }
      this.#dispatchedSelectionCustomEvent = customEvent;
      return completeSelection;
    }
    const outside = exactMoreMenuUndispatchedOutside(publication, customEvent);
    if (!outside || this.#taintedOutsideNativeEvents.has(outside.originalEvent)) return null;
    const ownerWindow = publication.document.defaultView;
    if (
      !ownerWindow
      || nativeEventGetter<EventTarget | null>(
        ownerWindow.Event.prototype,
        "target",
        outside.originalEvent,
      ) !== dispatchTarget
    ) {
      return null;
    }
    const completeOutside: MoreMenuDispatchCompletion = (reachedTarget) => {
      if (
        !reachedTarget
        && this.#dispatchedOutsideCustomEvents.get(outside.originalEvent) === customEvent
      ) {
        this.#taintedOutsideNativeEvents.add(outside.originalEvent);
        this.#dispatchedOutsideCustomEvents.delete(outside.originalEvent);
        this.#outsideCustomEvents.delete(outside.originalEvent);
      }
    };
    const dispatched = this.#dispatchedOutsideCustomEvents.get(outside.originalEvent);
    if (dispatched) {
      if (dispatched === customEvent) return completeOutside;
      const ownerWindow = publication.document.defaultView;
      if (
        ownerWindow
        && nativeEventGetter<number>(
          ownerWindow.Event.prototype,
          "eventPhase",
          dispatched,
        ) !== ownerWindow.Event.NONE
      ) {
        return null;
      }
    }
    this.#dispatchedOutsideCustomEvents.set(outside.originalEvent, customEvent);
    return completeOutside;
  }

  observeNativeOutsideTarget(publication: MoreMenuPublication, nativeEvent: Event) {
    if (
      this.#active !== publication
      || this.#dispatchObserverPublication !== publication
      || !publication.isExact()
    ) {
      return false;
    }
    const target = exactMoreMenuNativeOutsideAtCapture(publication, nativeEvent);
    if (!target || this.#observedOutsideTargets.has(target)) return Boolean(target);
    if (this.#unsafeDispatchTargets.has(target)) {
      publication.retire();
      return false;
    }
    const restore = installMoreMenuDispatchObserver(
      publication.document.defaultView,
      target,
      (dispatchTarget, event) =>
        this.observeDispatchedCustom(publication, dispatchTarget, event),
    );
    if (!restore) {
      this.#unsafeDispatchTargets.add(target);
      publication.retire();
      return false;
    }
    this.#observedOutsideTargets.add(target);
    this.#dispatchObserverRestorers.push([target, restore]);
    return true;
  }

  bindSelectionCustom(publication: MoreMenuPublication, customEvent: Event) {
    const intent = this.#selectionIntent;
    const item = intent && publication.dom.actions[intent.action.name];
    if (
      !intent
      || intent.publication !== publication
      || this.#active !== publication
      || !item
      || this.#dispatchedSelectionCustomEvent !== customEvent
      || !moreMenuNativeClickIsAtRadixSelection(
        publication,
        item,
        intent.nativeEvent,
        intent.target,
        intent.path,
      )
      || !exactMoreMenuCustomSelectAtWindow(publication, item, customEvent)
    ) {
      return false;
    }
    if (this.#selectionCustomEvent) {
      if (this.#selectionCustomEvent === customEvent) return true;
      const ownerWindow = publication.document.defaultView;
      if (
        !ownerWindow
        || nativeEventGetter<number>(
          ownerWindow.Event.prototype,
          "eventPhase",
          this.#selectionCustomEvent,
        ) !== ownerWindow.Event.NONE
      ) {
        return false;
      }
    }
    this.#selectionCustomEvent = customEvent;
    return true;
  }

  consumeSelection(
    publication: MoreMenuPublication,
    action: MoreMenuAction,
    customEvent: Event,
  ) {
    const intent = this.#selectionIntent;
    if (
      intent?.publication !== publication
      || intent.action !== action
      || this.#active !== publication
      || this.#claimedPublications.has(publication)
      || this.#claimedActions.has(action)
      || this.#claimedEvents.has(customEvent)
      || this.#claimedEvents.has(intent.nativeEvent)
      || this.#selectionCustomEvent !== customEvent
      || !moreMenuNativeClickIsAtRadixSelection(
        publication,
        publication.dom.actions[action.name],
        intent.nativeEvent,
        intent.target,
        intent.path,
      )
      || !publication.isExact()
    ) {
      return null;
    }
    this.#clearSelection(intent);
    this.#claimedPublications.add(publication);
    this.#claimedActions.add(action);
    this.#claimedEvents.add(customEvent);
    this.#claimedEvents.add(intent.nativeEvent);
    return intent;
  }

  #clearSelection(intent: MoreMenuSelectionIntent) {
    if (this.#selectionIntent !== intent) return;
    this.#selectionIntent = null;
    this.#dispatchedSelectionCustomEvent = null;
    this.#selectionCustomEvent = null;
    const release = this.#selectionTerminalRelease;
    this.#selectionTerminalRelease = null;
    release?.();
  }

  bindOutsideCustom(
    publication: MoreMenuPublication,
    customEvent: CustomEvent<{ originalEvent: Event }>,
  ) {
    if (
      this.#active !== publication
      || !publication.isExact()
    ) {
      return false;
    }
    const outside = exactMoreMenuOutside(publication, customEvent, "window");
    if (
      !outside
      || this.#dispatchedOutsideCustomEvents.get(outside.originalEvent) !== customEvent
    ) {
      return false;
    }
    const admitted = this.#outsideCustomEvents.get(outside.originalEvent);
    if (admitted) {
      if (admitted === customEvent) return true;
      const ownerWindow = publication.document.defaultView;
      if (
        ownerWindow
        && nativeEventGetter<number>(
          ownerWindow.Event.prototype,
          "eventPhase",
          admitted,
        ) !== ownerWindow.Event.NONE
      ) {
        return false;
      }
    }
    this.#outsideCustomEvents.set(outside.originalEvent, customEvent);
    return true;
  }

  claimOutsideCustom(
    publication: MoreMenuPublication,
    customEvent: CustomEvent<{ originalEvent: Event }>,
    originalEvent: Event,
  ) {
    if (
      this.#active !== publication
      || this.#outsideCustomEvents.get(originalEvent) !== customEvent
      || !this.claimDisclosure([customEvent, originalEvent])
    ) {
      return false;
    }
    this.#outsideCustomEvents.delete(originalEvent);
    this.#dispatchedOutsideCustomEvents.delete(originalEvent);
    return true;
  }

  #clearDispatchObservers(publication?: MoreMenuPublication) {
    if (
      publication
      && this.#dispatchObserverPublication !== publication
    ) {
      return;
    }
    for (const [target, restore] of this.#dispatchObserverRestorers.splice(0).reverse()) {
      if (!restore()) this.#unsafeDispatchTargets.add(target);
    }
    this.#dispatchObserverPublication = null;
    this.#observedOutsideTargets = new WeakSet<EventTarget>();
  }

  scheduleFocus(
    source: MoreMenuPublication,
    target: HTMLButtonElement,
    action: MoreMenuActionName | null,
    mode: EditMode = source.render.mode,
  ) {
    const previous = this.#focusIntent;
    if (previous) this.#clearFocus(previous);
    let pending: MoreMenuFocusIntent | null = null;
    const guard = createMoreMenuFocusGuard(source, target, () => {
      if (pending) this.#clearFocus(pending);
    });
    const intent: MoreMenuFocusIntent = Object.freeze({
      source,
      visit: source.render.visit,
      target,
      action,
      modes: Object.freeze(
        mode === source.render.mode ? [mode] : [source.render.mode, mode],
      ),
      guard,
    });
    pending = intent;
    this.#focusIntent = intent;
  }

  #clearFocus(intent: MoreMenuFocusIntent) {
    if (this.#focusIntent !== intent) return;
    this.#focusIntent = null;
    intent.guard.dispose();
  }
}

function createMoreMenuOwners(coordinator: MoreMenuPublicationCoordinator): MoreMenuOwners {
  const changed = <T extends HTMLElement>(
    owner: MoreMenuElementOwner<T>,
    element: T | null,
    previous: T | null,
  ) => coordinator.elementChanged(owner, element, previous);
  const accepts = <T extends HTMLElement>(tagName: string) => (element: T) =>
    element.tagName === tagName;
  const allowsReplacement = () => coordinator.allowsElementReplacement();
  const actionOwner = () =>
    new MoreMenuElementOwner<HTMLDivElement>(accepts("DIV"), allowsReplacement, changed);
  return Object.freeze({
    trigger: new MoreMenuElementOwner<HTMLButtonElement>(
      accepts("BUTTON"),
      allowsReplacement,
      changed,
    ),
    content: new MoreMenuElementOwner<HTMLDivElement>(
      accepts("DIV"),
      allowsReplacement,
      changed,
    ),
    actions: Object.freeze({
      history: actionOwner(),
      "name-version": actionOwner(),
      duplicate: actionOwner(),
      delete: actionOwner(),
    }),
  });
}

function snapshotMoreMenuDocument(document: DocumentDto) {
  return Object.freeze(
    Object.entries(document)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, value]) => Object.freeze([name, value] as const)),
  );
}

function moreMenuDocumentMatches(render: MoreMenuRender) {
  const fields = Object.entries(render.document)
    .sort(([left], [right]) => left.localeCompare(right));
  return (
    fields.length === render.documentFields.length
    && fields.every(([name, value], index) => {
      const expected = render.documentFields[index];
      return expected?.[0] === name && Object.is(expected[1], value);
    })
  );
}

function moreMenuBindings(props: HeaderProps): readonly unknown[] {
  return Object.freeze([
    props.onShare,
    props.onPublish,
    props.onPublishNow,
    props.onHistory,
    props.onMoreMenuOpen,
    props.onActivity,
    props.onShortcuts,
    props.onCommandPalette,
    props.onDelete,
    props.onDuplicate,
    props.onDownload,
    props.onCopyMarkdown,
    props.onNameVersion,
    props.onHome,
    props.compact,
    props.publishing,
    props.isOwner,
    props.githubConfigured,
  ]);
}

function moreMenuFactsAreCurrent(render: MoreMenuRender) {
  const {
    actions,
    document,
    props,
    session,
  } = render;
  const currentBindings = moreMenuBindings(props);
  const linked = document.storage !== "local";
  const canEdit = session.canWrite;
  const mutation = props.documentMutation;
  return (
    render.visit.session === session
    && render.visit.document === document
    && props.session === session
    && props.doc === document
    && session.docId === render.docId
    && session.role === render.role
    && session.mode === render.mode
    && session.setMode === render.setMode
    && linked === render.linked
    && canEdit === render.canEdit
    && props.compact === render.compact
    && props.isOwner === render.isOwner
    && props.githubConfigured === render.githubConfigured
    && props.publishing === render.publishing
    && mutation === render.documentMutation
    && currentBindings.length === render.bindings.length
    && currentBindings.every((value, index) => Object.is(value, render.bindings[index]))
    && moreMenuDocumentMatches(render)
    && actions.history.callback === props.onHistory
    && actions.history.eligible
    && actions.history.label === "Version history"
    && actions.history.testId === "menu-history"
    && actions.history.className === "menu-item"
    && actions.history.iconClassName === "lucide-rotate-ccw-clock"
    && !actions.history.busy
    && actions["name-version"].callback === props.onNameVersion
    && actions["name-version"].eligible === canEdit
    && actions["name-version"].label === "Name current version"
    && actions["name-version"].testId === null
    && actions["name-version"].className === "menu-item"
    && actions["name-version"].iconClassName === "lucide-pencil"
    && !actions["name-version"].busy
    && actions.duplicate.callback === props.onDuplicate
    && actions.duplicate.eligible === (mutation === null)
    && actions.duplicate.label === (mutation === "duplicate" ? "Making a copy…" : "Make a copy")
    && actions.duplicate.testId === "menu-duplicate"
    && actions.duplicate.className === "menu-item"
    && actions.duplicate.iconClassName === (mutation === "duplicate" ? "lucide-loader-circle" : "lucide-files")
    && actions.duplicate.busy === (mutation === "duplicate")
    && actions.delete.callback === props.onDelete
    && actions.delete.eligible === (props.isOwner && mutation === null)
    && actions.delete.label === (mutation === "delete" ? "Moving to trash…" : "Move to trash")
    && actions.delete.testId === "menu-delete"
    && actions.delete.className === "menu-item text-danger"
    && actions.delete.iconClassName === (mutation === "delete" ? "lucide-loader-circle" : "lucide-trash-2")
    && actions.delete.busy === (mutation === "delete")
  );
}

function moreMenuActionElementIsExact(
  render: MoreMenuRender,
  content: HTMLDivElement,
  action: MoreMenuAction,
  element: HTMLDivElement | null,
) {
  const shouldExist = action.name === "name-version"
    ? render.canEdit
    : action.name === "delete"
      ? render.isOwner
      : true;
  if (!shouldExist) return element === null;
  const ownerWindow = content.ownerDocument.defaultView;
  const disabled = action.name === "duplicate" || action.name === "delete"
    ? render.documentMutation !== null
    : false;
  if (
    !ownerWindow
    || !element
    || !(element instanceof ownerWindow.HTMLDivElement)
    || !element.isConnected
    || element.ownerDocument !== content.ownerDocument
    || element.parentElement !== content
    || element.getAttribute("role") !== "menuitem"
    || element.className !== action.className
    || element.textContent !== action.label
    || element.dataset.testid !== (action.testId ?? undefined)
    || (element.getAttribute("aria-disabled") === "true") !== disabled
    || element.hasAttribute("data-disabled") !== disabled
    || element.getAttribute("aria-busy") !== (action.busy ? "true" : null)
    || element.children.length !== 2
  ) {
    return false;
  }
  const iconBox = element.children.item(0);
  const label = element.children.item(1);
  const icon = iconBox?.firstElementChild;
  return Boolean(
    iconBox
    && iconBox.tagName === "SPAN"
    && iconBox.className === "flex h-4 w-4 items-center justify-center text-ink-3"
    && iconBox.children.length === 1
    && icon
    && icon.tagName.toLowerCase() === "svg"
    && icon.classList.contains(action.iconClassName)
    && icon.getAttribute("width") === "15"
    && icon.getAttribute("height") === "15"
    && icon.getAttribute("aria-hidden") === "true"
    && label
    && label.tagName === "SPAN"
    && label.className === "flex-1"
    && label.children.length === 0
    && label.textContent === action.label
  );
}

function currentMoreMenuDom(
  render: MoreMenuRender,
  owners: MoreMenuOwners,
): MoreMenuDom | null {
  const trigger = owners.trigger.element();
  const ownerDocument = trigger?.ownerDocument;
  const ownerWindow = ownerDocument?.defaultView;
  if (
    !trigger
    || !ownerDocument
    || !ownerWindow
    || !(trigger instanceof ownerWindow.HTMLButtonElement)
    || !trigger.isConnected
    || trigger.type !== "button"
    || trigger.disabled
    || trigger.className !== "icon-btn"
    || trigger.getAttribute("aria-label") !== "More"
    || trigger.dataset.testid !== "more-menu"
    || trigger.getAttribute("aria-haspopup") !== "menu"
    || trigger.getAttribute("aria-expanded") !== String(render.open)
    || trigger.getAttribute("data-state") !== (render.open ? "open" : "closed")
    || trigger.children.length !== 1
    || !trigger.firstElementChild?.classList.contains("lucide-ellipsis-vertical")
  ) {
    return null;
  }

  const content = owners.content.element();
  const actions: Readonly<Record<MoreMenuActionName, HTMLDivElement | null>> = Object.freeze({
    history: owners.actions.history.element(),
    "name-version": owners.actions["name-version"].element(),
    duplicate: owners.actions.duplicate.element(),
    delete: owners.actions.delete.element(),
  });
  if (!render.open) {
    if (content || Object.values(actions).some(Boolean)) return null;
    return Object.freeze({ trigger, content: null, actions });
  }
  if (
    !content
    || !(content instanceof ownerWindow.HTMLDivElement)
    || !content.isConnected
    || content.ownerDocument !== ownerDocument
    || content.getAttribute("role") !== "menu"
    || content.getAttribute("data-state") !== "open"
    || content.getAttribute("data-align") !== "end"
    || !content.classList.contains("menu")
    || !content.classList.contains("w-64")
    || !Object.values(render.actions).every((action) =>
      moreMenuActionElementIsExact(render, content, action, actions[action.name]))
  ) {
    return null;
  }
  const ordered = [
    actions.history,
    ...(render.canEdit ? [actions["name-version"]] : []),
    actions.duplicate,
    ...(render.isOwner ? [actions.delete] : []),
  ];
  if (
    ordered.some((element) => !element)
    || ordered.some((element, index) => {
      const next = ordered[index + 1];
      return Boolean(next && element && next.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING);
    })
  ) {
    return null;
  }
  return Object.freeze({ trigger, content, actions });
}

function moreMenuDomIsSame(current: MoreMenuDom, published: MoreMenuDom) {
  return (
    current.trigger === published.trigger
    && current.content === published.content
    && (Object.keys(current.actions) as MoreMenuActionName[]).every(
      (name) => current.actions[name] === published.actions[name],
    )
  );
}

function nativeEventGetter<T>(
  prototype: object,
  property: string,
  event: Event,
): T | undefined {
  const getter = Object.getOwnPropertyDescriptor(prototype, property)?.get;
  if (!getter) return undefined;
  try {
    return Reflect.apply(getter, event, []) as T;
  } catch (error) {
    if (
      error instanceof TypeError
      || (
        typeof error === "object"
        && error !== null
        && Reflect.get(error, "name") === "TypeError"
      )
    ) {
      return undefined;
    }
    throw error;
  }
}

function nativeEventPath(ownerWindow: Window & typeof globalThis, event: Event) {
  try {
    return Object.freeze(
      Reflect.apply(ownerWindow.Event.prototype.composedPath, event, []) as EventTarget[],
    );
  } catch (error) {
    if (
      error instanceof TypeError
      || (
        typeof error === "object"
        && error !== null
        && Reflect.get(error, "name") === "TypeError"
      )
    ) {
      return Object.freeze([] as EventTarget[]);
    }
    throw error;
  }
}

type MoreMenuDispatchCompletion = (reachedTarget: boolean) => void;

const moreMenuGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const moreMenuDefineProperty = Object.defineProperty;
const moreMenuIsExtensible = Object.isExtensible;
const moreMenuDeleteProperty = Reflect.deleteProperty;
const MORE_MENU_DESCRIPTOR_FAILURE = Symbol("more-menu-descriptor-failure");

function moreMenuOwnDescriptor(target: object, property: PropertyKey) {
  try {
    return moreMenuGetOwnPropertyDescriptor(target, property);
  } catch {
    return MORE_MENU_DESCRIPTOR_FAILURE;
  }
}

function moreMenuDescriptorMatches(
  current: PropertyDescriptor | undefined,
  expected: PropertyDescriptor | undefined,
) {
  if (!current || !expected) return current === expected;
  if (
    current.configurable !== expected.configurable
    || current.enumerable !== expected.enumerable
  ) {
    return false;
  }
  if ("value" in expected || "writable" in expected) {
    return (
      "value" in current
      && current.value === expected.value
      && current.writable === expected.writable
    );
  }
  return (
    !("value" in current)
    && current.get === expected.get
    && current.set === expected.set
  );
}

function installMoreMenuDispatchObserver(
  ownerWindow: (Window & typeof globalThis) | null,
  target: EventTarget,
  observe: (target: EventTarget, event: Event) => MoreMenuDispatchCompletion | null,
) {
  if (!ownerWindow || !(target instanceof ownerWindow.EventTarget)) return null;
  const descriptor = moreMenuOwnDescriptor(target, "dispatchEvent");
  if (
    descriptor === MORE_MENU_DESCRIPTOR_FAILURE
    || (descriptor && !descriptor.configurable)
  ) {
    return null;
  }
  if (!descriptor) {
    try {
      if (!moreMenuIsExtensible(target)) return null;
    } catch {
      return null;
    }
  }
  const eventTargetPrototype = ownerWindow.EventTarget.prototype;
  const nativeDispatch = eventTargetPrototype.dispatchEvent;
  const nativeAdd = eventTargetPrototype.addEventListener;
  const nativeRemove = eventTargetPrototype.removeEventListener;
  const observedDispatch = function (this: EventTarget, event: Event) {
    const completion = this === target ? observe(target, event) : null;
    if (!completion) return Reflect.apply(nativeDispatch, this, [event]) as boolean;
    let reachedTarget = false;
    const markTarget = (current: Event) => {
      if (current === event) reachedTarget = true;
    };
    const type = nativeEventGetter<string>(ownerWindow.Event.prototype, "type", event);
    if (!type) return Reflect.apply(nativeDispatch, this, [event]) as boolean;
    Reflect.apply(nativeAdd, target, [type, markTarget, { capture: true }]);
    try {
      return Reflect.apply(nativeDispatch, this, [event]) as boolean;
    } finally {
      Reflect.apply(nativeRemove, target, [type, markTarget, { capture: true }]);
      completion(reachedTarget);
    }
  };
  const installedDescriptor: PropertyDescriptor = {
    configurable: true,
    enumerable: false,
    value: observedDispatch,
    writable: true,
  };
  let restoredByObserver = false;
  const restoreObserved = () => {
    const current = moreMenuOwnDescriptor(target, "dispatchEvent");
    if (current === MORE_MENU_DESCRIPTOR_FAILURE) return false;
    if (restoredByObserver) return moreMenuDescriptorMatches(current, descriptor);
    if (!moreMenuDescriptorMatches(current, installedDescriptor)) {
      return false;
    }
    try {
      if (descriptor) moreMenuDefineProperty(target, "dispatchEvent", descriptor);
      else if (!moreMenuDeleteProperty(target, "dispatchEvent")) return false;
    } catch {
      return false;
    }
    const restored = moreMenuOwnDescriptor(target, "dispatchEvent");
    restoredByObserver = (
      restored !== MORE_MENU_DESCRIPTOR_FAILURE
      && moreMenuDescriptorMatches(restored, descriptor)
    );
    return restoredByObserver;
  };
  try {
    moreMenuDefineProperty(target, "dispatchEvent", installedDescriptor);
  } catch {
    return null;
  }
  const installed = moreMenuOwnDescriptor(target, "dispatchEvent");
  if (
    installed === MORE_MENU_DESCRIPTOR_FAILURE
    || !moreMenuDescriptorMatches(installed, installedDescriptor)
  ) {
    restoreObserved();
    return null;
  }
  return restoreObserved;
}

function exactMoreMenuUndispatchedSelect(
  publication: MoreMenuPublication,
  item: HTMLDivElement,
  event: Event,
) {
  const ownerWindow = publication.document.defaultView;
  if (!ownerWindow || !(event instanceof ownerWindow.CustomEvent)) return false;
  return Boolean(
    nativeEventGetter<string>(ownerWindow.Event.prototype, "type", event)
      === "menu.itemSelect"
    && nativeEventGetter<EventTarget | null>(
      ownerWindow.Event.prototype,
      "target",
      event,
    ) === null
    && nativeEventGetter<EventTarget | null>(
      ownerWindow.Event.prototype,
      "currentTarget",
      event,
    ) === null
    && nativeEventGetter<number>(
      ownerWindow.Event.prototype,
      "eventPhase",
      event,
    ) === ownerWindow.Event.NONE
    && nativeEventGetter<boolean>(
      ownerWindow.Event.prototype,
      "bubbles",
      event,
    ) === true
    && nativeEventGetter<boolean>(
      ownerWindow.Event.prototype,
      "cancelable",
      event,
    ) === true
    && nativeEventGetter<boolean>(
      ownerWindow.Event.prototype,
      "defaultPrevented",
      event,
    ) === false
    && nativeEventGetter<unknown>(
      ownerWindow.CustomEvent.prototype,
      "detail",
      event,
    ) === null
    && nativeEventPath(ownerWindow, event).length === 0
    && item.ownerDocument === publication.document
    && item.isConnected
  );
}

function isLiveMoreMenuNativeEvent(event: Event, document: Document) {
  const ownerWindow = document.defaultView;
  return Boolean(
    ownerWindow
    && event instanceof ownerWindow.Event
    && nativeEventGetter<number>(
      ownerWindow.Event.prototype,
      "eventPhase",
      event,
    ) !== ownerWindow.Event.NONE
    && nativeEventGetter<EventTarget | null>(
      ownerWindow.Event.prototype,
      "target",
      event,
    )
  );
}

function installMoreMenuNativeClickTerminal(
  publication: MoreMenuPublication,
  nativeEvent: MouseEvent,
  admittedTarget: Node,
  admittedPath: readonly EventTarget[],
  onTerminal: () => void,
  onInvalid: () => void,
) {
  const ownerWindow = publication.document.defaultView;
  if (!ownerWindow) return null;
  const eventTargetPrototype = ownerWindow.EventTarget.prototype;
  const nativeAdd = eventTargetPrototype.addEventListener;
  const nativeRemove = eventTargetPrototype.removeEventListener;
  let attached = false;
  const listener = (event: Event) => {
    if (
      event === nativeEvent
      && exactMoreMenuNativeClickTerminal(
        publication,
        nativeEvent,
        admittedTarget,
        admittedPath,
      )
    ) {
      onTerminal();
    } else {
      onInvalid();
    }
  };
  try {
    Reflect.apply(nativeAdd, ownerWindow, ["click", listener, false]);
    attached = true;
  } catch (error) {
    if (
      error instanceof TypeError
      || (
        typeof error === "object"
        && error !== null
        && Reflect.get(error, "name") === "TypeError"
      )
    ) {
      return null;
    }
    throw error;
  }
  return () => {
    if (!attached) return;
    attached = false;
    Reflect.apply(nativeRemove, ownerWindow, ["click", listener, false]);
  };
}

function exactMoreMenuNativeClickTerminal(
  publication: MoreMenuPublication,
  event: MouseEvent,
  admittedTarget: Node,
  admittedPath: readonly EventTarget[],
) {
  const ownerWindow = publication.document.defaultView;
  if (!ownerWindow || !(event instanceof ownerWindow.MouseEvent)) return false;
  const path = nativeEventPath(ownerWindow, event);
  const bodyIndex = path.indexOf(publication.document.body);
  const documentIndex = path.indexOf(publication.document);
  return Boolean(
    nativeEventGetter<string>(ownerWindow.Event.prototype, "type", event) === "click"
    && nativeEventGetter<number>(
      ownerWindow.MouseEvent.prototype,
      "button",
      event,
    ) === 0
    && nativeEventGetter<EventTarget | null>(
      ownerWindow.Event.prototype,
      "target",
      event,
    ) === admittedTarget
    && nativeEventGetter<EventTarget | null>(
      ownerWindow.Event.prototype,
      "currentTarget",
      event,
    ) === ownerWindow
    && nativeEventGetter<number>(
      ownerWindow.Event.prototype,
      "eventPhase",
      event,
    ) === ownerWindow.Event.BUBBLING_PHASE
    && nativeEventGetter<boolean>(
      ownerWindow.Event.prototype,
      "bubbles",
      event,
    ) === true
    && nativeEventGetter<boolean>(
      ownerWindow.Event.prototype,
      "cancelable",
      event,
    ) === true
    && nativeEventGetter<boolean>(
      ownerWindow.Event.prototype,
      "defaultPrevented",
      event,
    ) === false
    && admittedTarget.ownerDocument === publication.document
    && path.length === admittedPath.length
    && path.every((entry, index) => entry === admittedPath[index])
    && path[0] === admittedTarget
    && bodyIndex > 0
    && documentIndex > bodyIndex
    && documentIndex === path.length - 2
    && path[path.length - 1] === ownerWindow
    && publication.isExact()
  );
}

function exactMoreMenuNativeClick(
  publication: MoreMenuPublication,
  action: MoreMenuAction,
  item: HTMLDivElement,
  event: Event,
) {
  const ownerWindow = publication.document.defaultView;
  if (!ownerWindow || !(event instanceof ownerWindow.MouseEvent)) return null;
  const type = nativeEventGetter<string>(ownerWindow.Event.prototype, "type", event);
  const target = nativeEventGetter<EventTarget | null>(
    ownerWindow.Event.prototype,
    "target",
    event,
  );
  const currentTarget = nativeEventGetter<EventTarget | null>(
    ownerWindow.Event.prototype,
    "currentTarget",
    event,
  );
  const eventPhase = nativeEventGetter<number>(
    ownerWindow.Event.prototype,
    "eventPhase",
    event,
  );
  const bubbles = nativeEventGetter<boolean>(
    ownerWindow.Event.prototype,
    "bubbles",
    event,
  );
  const cancelable = nativeEventGetter<boolean>(
    ownerWindow.Event.prototype,
    "cancelable",
    event,
  );
  const defaultPrevented = nativeEventGetter<boolean>(
    ownerWindow.Event.prototype,
    "defaultPrevented",
    event,
  );
  const button = nativeEventGetter<number>(
    ownerWindow.MouseEvent.prototype,
    "button",
    event,
  );
  const path = nativeEventPath(ownerWindow, event);
  const content = publication.dom.content;
  if (
    type !== "click"
    || button !== 0
    || bubbles !== true
    || cancelable !== true
    || defaultPrevented !== false
    || currentTarget !== item
    || (eventPhase !== ownerWindow.Event.CAPTURING_PHASE && eventPhase !== ownerWindow.Event.AT_TARGET)
    || !(target instanceof ownerWindow.Node)
    || target.ownerDocument !== publication.document
    || !item.contains(target)
    || !content
    || path[0] !== target
    || path.indexOf(item) < 0
    || path.indexOf(content) <= path.indexOf(item)
    || !publication.isExact()
  ) {
    return null;
  }
  return Object.freeze({
    nativeEvent: event,
    target,
    path,
    action,
  });
}

function moreMenuNativeClickIsAtRadixSelection(
  publication: MoreMenuPublication,
  item: HTMLElement | null,
  event: MouseEvent,
  admittedTarget: Node,
  admittedPath: readonly EventTarget[],
) {
  const ownerWindow = publication.document.defaultView;
  const content = publication.dom.content;
  if (
    !ownerWindow
    || !item
    || !content
    || !(event instanceof ownerWindow.MouseEvent)
  ) {
    return false;
  }
  const target = nativeEventGetter<EventTarget | null>(
    ownerWindow.Event.prototype,
    "target",
    event,
  );
  const currentTarget = nativeEventGetter<EventTarget | null>(
    ownerWindow.Event.prototype,
    "currentTarget",
    event,
  );
  const path = nativeEventPath(ownerWindow, event);
  const bodyIndex = path.indexOf(publication.document.body);
  const documentIndex = path.indexOf(publication.document);
  const atReactDelegationBoundary = (
    currentTarget === publication.document.body
    || (
      currentTarget === publication.document
      && documentIndex === path.length - 2
      && path[path.length - 1] === ownerWindow
    )
  );
  return Boolean(
    nativeEventGetter<string>(ownerWindow.Event.prototype, "type", event) === "click"
    && nativeEventGetter<number>(
      ownerWindow.MouseEvent.prototype,
      "button",
      event,
    ) === 0
    && nativeEventGetter<boolean>(
      ownerWindow.Event.prototype,
      "bubbles",
      event,
    ) === true
    && nativeEventGetter<boolean>(
      ownerWindow.Event.prototype,
      "cancelable",
      event,
    ) === true
    && nativeEventGetter<boolean>(
      ownerWindow.Event.prototype,
      "defaultPrevented",
      event,
    ) === false
    && nativeEventGetter<number>(
      ownerWindow.Event.prototype,
      "eventPhase",
      event,
    ) === ownerWindow.Event.BUBBLING_PHASE
    && target === admittedTarget
    && target instanceof ownerWindow.Node
    && target.ownerDocument === publication.document
    // Direct roots delegate portal clicks from body; a document-hydrated root delegates from document.
    && atReactDelegationBoundary
    && item.contains(target)
    && path.length === admittedPath.length
    && path.every((entry, index) => entry === admittedPath[index])
    && path[0] === target
    && path.indexOf(item) >= 0
    && path.indexOf(content) > path.indexOf(item)
    && bodyIndex > path.indexOf(content)
    && documentIndex > bodyIndex
  );
}

function exactMoreMenuCustomSelect(
  publication: MoreMenuPublication,
  item: HTMLDivElement,
  event: Event,
) {
  const ownerWindow = publication.document.defaultView;
  if (!ownerWindow || !(event instanceof ownerWindow.CustomEvent)) return false;
  const type = nativeEventGetter<string>(ownerWindow.Event.prototype, "type", event);
  const target = nativeEventGetter<EventTarget | null>(
    ownerWindow.Event.prototype,
    "target",
    event,
  );
  const currentTarget = nativeEventGetter<EventTarget | null>(
    ownerWindow.Event.prototype,
    "currentTarget",
    event,
  );
  const eventPhase = nativeEventGetter<number>(
    ownerWindow.Event.prototype,
    "eventPhase",
    event,
  );
  const bubbles = nativeEventGetter<boolean>(
    ownerWindow.Event.prototype,
    "bubbles",
    event,
  );
  const cancelable = nativeEventGetter<boolean>(
    ownerWindow.Event.prototype,
    "cancelable",
    event,
  );
  const defaultPrevented = nativeEventGetter<boolean>(
    ownerWindow.Event.prototype,
    "defaultPrevented",
    event,
  );
  const detail = nativeEventGetter<unknown>(
    ownerWindow.CustomEvent.prototype,
    "detail",
    event,
  );
  const path = nativeEventPath(ownerWindow, event);
  const content = publication.dom.content;
  return Boolean(
    type === "menu.itemSelect"
    && target === item
    && currentTarget === item
    && eventPhase === ownerWindow.Event.AT_TARGET
    && bubbles === true
    && cancelable === true
    && defaultPrevented === false
    && detail === null
    && content
    && path[0] === item
    && path.indexOf(content) > path.indexOf(item)
    && publication.isExact()
  );
}

function exactMoreMenuCustomSelectAtWindow(
  publication: MoreMenuPublication,
  item: HTMLDivElement,
  event: Event,
) {
  const ownerWindow = publication.document.defaultView;
  const content = publication.dom.content;
  if (!ownerWindow || !content || !(event instanceof ownerWindow.CustomEvent)) return false;
  const path = nativeEventPath(ownerWindow, event);
  return Boolean(
    nativeEventGetter<string>(ownerWindow.Event.prototype, "type", event)
      === "menu.itemSelect"
    && nativeEventGetter<EventTarget | null>(
      ownerWindow.Event.prototype,
      "target",
      event,
    ) === item
    && nativeEventGetter<EventTarget | null>(
      ownerWindow.Event.prototype,
      "currentTarget",
      event,
    ) instanceof ownerWindow.Window
    && nativeEventGetter<number>(
      ownerWindow.Event.prototype,
      "eventPhase",
      event,
    ) === ownerWindow.Event.CAPTURING_PHASE
    && nativeEventGetter<boolean>(
      ownerWindow.Event.prototype,
      "bubbles",
      event,
    ) === true
    && nativeEventGetter<boolean>(
      ownerWindow.Event.prototype,
      "cancelable",
      event,
    ) === true
    && nativeEventGetter<boolean>(
      ownerWindow.Event.prototype,
      "defaultPrevented",
      event,
    ) === false
    && nativeEventGetter<unknown>(
      ownerWindow.CustomEvent.prototype,
      "detail",
      event,
    ) === null
    && path[0] === item
    && path.indexOf(content) > path.indexOf(item)
    && path.indexOf(publication.document) > path.indexOf(content)
    && path[path.length - 1] === nativeEventGetter<EventTarget | null>(
      ownerWindow.Event.prototype,
      "currentTarget",
      event,
    )
    && path.indexOf(publication.document) < path.length - 1
    && publication.isExact()
  );
}

function exactMoreMenuGenericNativeClick(
  publication: MoreMenuPublication,
  event: Event,
): MoreMenuGenericSelectionIntent | null {
  const ownerWindow = publication.document.defaultView;
  const content = publication.dom.content;
  if (!ownerWindow || !content || !(event instanceof ownerWindow.MouseEvent)) return null;
  const type = nativeEventGetter<string>(ownerWindow.Event.prototype, "type", event);
  const target = nativeEventGetter<EventTarget | null>(
    ownerWindow.Event.prototype,
    "target",
    event,
  );
  const currentTarget = nativeEventGetter<EventTarget | null>(
    ownerWindow.Event.prototype,
    "currentTarget",
    event,
  );
  const eventPhase = nativeEventGetter<number>(
    ownerWindow.Event.prototype,
    "eventPhase",
    event,
  );
  const bubbles = nativeEventGetter<boolean>(
    ownerWindow.Event.prototype,
    "bubbles",
    event,
  );
  const cancelable = nativeEventGetter<boolean>(
    ownerWindow.Event.prototype,
    "cancelable",
    event,
  );
  const defaultPrevented = nativeEventGetter<boolean>(
    ownerWindow.Event.prototype,
    "defaultPrevented",
    event,
  );
  const button = nativeEventGetter<number>(
    ownerWindow.MouseEvent.prototype,
    "button",
    event,
  );
  const path = nativeEventPath(ownerWindow, event);
  const contentIndex = path.indexOf(content);
  const item = path.slice(0, contentIndex).find((candidate): candidate is HTMLElement => (
    candidate instanceof ownerWindow.HTMLElement
    && ["menuitem", "menuitemradio", "menuitemcheckbox"].includes(
      candidate.getAttribute("role") ?? "",
    )
  ));
  if (
    type !== "click"
    || button !== 0
    || bubbles !== true
    || cancelable !== true
    || defaultPrevented !== false
    || currentTarget !== content
    || eventPhase !== ownerWindow.Event.CAPTURING_PHASE
    || !(target instanceof ownerWindow.Node)
    || target.ownerDocument !== publication.document
    || contentIndex < 1
    || !item
    || item.ownerDocument !== publication.document
    || !item.isConnected
    || !item.contains(target)
    || path[0] !== target
    || path.indexOf(item) < 0
    || !publication.isExact()
  ) {
    return null;
  }
  return Object.freeze({
    nativeEvent: event,
    target,
    item,
    path,
  });
}

function exactMoreMenuGenericCustomSelect(
  publication: MoreMenuPublication,
  item: HTMLElement,
  event: Event,
) {
  const ownerWindow = publication.document.defaultView;
  const content = publication.dom.content;
  if (!ownerWindow || !content || !(event instanceof ownerWindow.CustomEvent)) return false;
  const type = nativeEventGetter<string>(ownerWindow.Event.prototype, "type", event);
  const target = nativeEventGetter<EventTarget | null>(
    ownerWindow.Event.prototype,
    "target",
    event,
  );
  const currentTarget = nativeEventGetter<EventTarget | null>(
    ownerWindow.Event.prototype,
    "currentTarget",
    event,
  );
  const eventPhase = nativeEventGetter<number>(
    ownerWindow.Event.prototype,
    "eventPhase",
    event,
  );
  const bubbles = nativeEventGetter<boolean>(
    ownerWindow.Event.prototype,
    "bubbles",
    event,
  );
  const cancelable = nativeEventGetter<boolean>(
    ownerWindow.Event.prototype,
    "cancelable",
    event,
  );
  const defaultPrevented = nativeEventGetter<boolean>(
    ownerWindow.Event.prototype,
    "defaultPrevented",
    event,
  );
  const detail = nativeEventGetter<unknown>(
    ownerWindow.CustomEvent.prototype,
    "detail",
    event,
  );
  const path = nativeEventPath(ownerWindow, event);
  return Boolean(
    type === "menu.itemSelect"
    && target === item
    && currentTarget === content
    && eventPhase === ownerWindow.Event.CAPTURING_PHASE
    && bubbles === true
    && cancelable === true
    && defaultPrevented === false
    && detail === null
    && path[0] === item
    && path.indexOf(content) > path.indexOf(item)
    && publication.isExact()
  );
}

function moreMenuModeForGenericSelection(
  publication: MoreMenuPublication,
  item: HTMLElement,
): EditMode {
  if (!publication.render.compact || item.getAttribute("role") !== "menuitemradio") {
    return publication.render.mode;
  }
  const group = item.parentElement;
  const rows = group ? Array.from(group.children) : [];
  const modes = ["editing", "suggesting", "viewing"] as const;
  const labels = ["Editing", "Suggesting", "Viewing"] as const;
  const index = rows.indexOf(item);
  if (
    group?.getAttribute("role") !== "group"
    || rows.length !== modes.length
    || index < 0
    || !rows.every((row, rowIndex) => (
      row.getAttribute("role") === "menuitemradio"
      && row.lastElementChild?.tagName === "SPAN"
      && row.lastElementChild.className === "flex flex-col"
      && row.lastElementChild.children.length === 1
      && row.lastElementChild.firstElementChild?.tagName === "SPAN"
      && row.lastElementChild.firstElementChild.attributes.length === 0
      && row.lastElementChild.firstElementChild.textContent === labels[rowIndex]
    ))
  ) {
    return publication.render.mode;
  }
  return modes[index] ?? publication.render.mode;
}

function exactMoreMenuEscape(
  publication: MoreMenuPublication,
  event: KeyboardEvent,
) {
  const ownerWindow = publication.document.defaultView;
  const content = publication.dom.content;
  if (!ownerWindow || !content || !(event instanceof ownerWindow.KeyboardEvent)) return false;
  const target = nativeEventGetter<EventTarget | null>(
    ownerWindow.Event.prototype,
    "target",
    event,
  );
  const path = nativeEventPath(ownerWindow, event);
  return Boolean(
    nativeEventGetter<string>(ownerWindow.Event.prototype, "type", event) === "keydown"
    && nativeEventGetter<string>(
      ownerWindow.KeyboardEvent.prototype,
      "key",
      event,
    ) === "Escape"
    && nativeEventGetter<EventTarget | null>(
      ownerWindow.Event.prototype,
      "currentTarget",
      event,
    ) === publication.document
    && nativeEventGetter<number>(
      ownerWindow.Event.prototype,
      "eventPhase",
      event,
    ) === ownerWindow.Event.CAPTURING_PHASE
    && nativeEventGetter<boolean>(
      ownerWindow.Event.prototype,
      "bubbles",
      event,
    ) === true
    && nativeEventGetter<boolean>(
      ownerWindow.Event.prototype,
      "cancelable",
      event,
    ) === true
    && nativeEventGetter<boolean>(
      ownerWindow.Event.prototype,
      "defaultPrevented",
      event,
    ) === false
    && target instanceof ownerWindow.Node
    && target.ownerDocument === publication.document
    && content.contains(target)
    && path[0] === target
    && path.indexOf(content) >= 0
    && path.indexOf(publication.document) > path.indexOf(content)
  );
}

interface ExactMoreMenuOutside {
  readonly originalEvent: Event;
  readonly rightClick: boolean;
}

function moreMenuOutsideOriginalEvent(
  ownerWindow: Window & typeof globalThis,
  event: CustomEvent<{ originalEvent: Event }>,
) {
  const detail = nativeEventGetter<unknown>(
    ownerWindow.CustomEvent.prototype,
    "detail",
    event,
  );
  if (
    typeof detail !== "object"
    || detail === null
    || Reflect.ownKeys(detail).length !== 1
  ) {
    return null;
  }
  const descriptor = Object.getOwnPropertyDescriptor(detail, "originalEvent");
  return descriptor && "value" in descriptor && descriptor.value instanceof ownerWindow.Event
    ? descriptor.value
    : null;
}

function exactMoreMenuNativeOutsideAtCapture(
  publication: MoreMenuPublication,
  event: Event,
) {
  const ownerWindow = publication.document.defaultView;
  const content = publication.dom.content;
  const trigger = publication.dom.trigger;
  if (!ownerWindow || !content || !(event instanceof ownerWindow.Event)) return null;
  const type = nativeEventGetter<string>(ownerWindow.Event.prototype, "type", event);
  const pointerOutside = type === "pointerdown" && event instanceof ownerWindow.PointerEvent;
  const focusOutside = type === "focusin" && event instanceof ownerWindow.FocusEvent;
  const target = nativeEventGetter<EventTarget | null>(
    ownerWindow.Event.prototype,
    "target",
    event,
  );
  const path = nativeEventPath(ownerWindow, event);
  if (
    (!pointerOutside && !focusOutside)
    || nativeEventGetter<EventTarget | null>(
      ownerWindow.Event.prototype,
      "currentTarget",
      event,
    ) !== publication.document
    || nativeEventGetter<number>(
      ownerWindow.Event.prototype,
      "eventPhase",
      event,
    ) !== ownerWindow.Event.CAPTURING_PHASE
    || nativeEventGetter<boolean>(
      ownerWindow.Event.prototype,
      "bubbles",
      event,
    ) !== true
    || nativeEventGetter<boolean>(
      ownerWindow.Event.prototype,
      "cancelable",
      event,
    ) !== pointerOutside
    || nativeEventGetter<boolean>(
      ownerWindow.Event.prototype,
      "defaultPrevented",
      event,
    ) !== false
    || !(target instanceof ownerWindow.Node)
    || target.ownerDocument !== publication.document
    || !target.isConnected
    || content.contains(target)
    || trigger.contains(target)
    || path[0] !== target
    || path.indexOf(publication.document) < 0
  ) {
    return null;
  }
  if (pointerOutside) {
    const button = nativeEventGetter<number>(
      ownerWindow.MouseEvent.prototype,
      "button",
      event,
    );
    const ctrlKey = nativeEventGetter<boolean>(
      ownerWindow.MouseEvent.prototype,
      "ctrlKey",
      event,
    );
    if (button === undefined || ctrlKey === undefined) return null;
  }
  return target;
}

function exactMoreMenuUndispatchedOutside(
  publication: MoreMenuPublication,
  event: Event,
): ExactMoreMenuOutside | null {
  const ownerWindow = publication.document.defaultView;
  const content = publication.dom.content;
  const trigger = publication.dom.trigger;
  if (!ownerWindow || !content || !(event instanceof ownerWindow.CustomEvent)) return null;
  const type = nativeEventGetter<string>(ownerWindow.Event.prototype, "type", event);
  if (
    type !== "dismissableLayer.pointerDownOutside"
    && type !== "dismissableLayer.focusOutside"
  ) {
    return null;
  }
  const originalEvent = moreMenuOutsideOriginalEvent(
    ownerWindow,
    event as CustomEvent<{ originalEvent: Event }>,
  );
  if (!originalEvent) return null;
  const originalType = nativeEventGetter<string>(
    ownerWindow.Event.prototype,
    "type",
    originalEvent,
  );
  const pointerOutside = (
    type === "dismissableLayer.pointerDownOutside"
    && originalType === "pointerdown"
    && originalEvent instanceof ownerWindow.PointerEvent
  );
  const focusOutside = (
    type === "dismissableLayer.focusOutside"
    && originalType === "focusin"
    && originalEvent instanceof ownerWindow.FocusEvent
  );
  const target = nativeEventGetter<EventTarget | null>(
    ownerWindow.Event.prototype,
    "target",
    originalEvent,
  );
  const originalPath = nativeEventPath(ownerWindow, originalEvent);
  if (
    (!pointerOutside && !focusOutside)
    || nativeEventGetter<EventTarget | null>(
      ownerWindow.Event.prototype,
      "target",
      event,
    ) !== null
    || nativeEventGetter<EventTarget | null>(
      ownerWindow.Event.prototype,
      "currentTarget",
      event,
    ) !== null
    || nativeEventGetter<number>(
      ownerWindow.Event.prototype,
      "eventPhase",
      event,
    ) !== ownerWindow.Event.NONE
    || nativeEventGetter<boolean>(
      ownerWindow.Event.prototype,
      "bubbles",
      event,
    ) !== false
    || nativeEventGetter<boolean>(
      ownerWindow.Event.prototype,
      "cancelable",
      event,
    ) !== true
    || nativeEventGetter<boolean>(
      ownerWindow.Event.prototype,
      "defaultPrevented",
      event,
    ) !== false
    || nativeEventPath(ownerWindow, event).length !== 0
    || nativeEventGetter<EventTarget | null>(
      ownerWindow.Event.prototype,
      "currentTarget",
      originalEvent,
    ) !== publication.document
    || nativeEventGetter<number>(
      ownerWindow.Event.prototype,
      "eventPhase",
      originalEvent,
    ) !== ownerWindow.Event.BUBBLING_PHASE
    || nativeEventGetter<boolean>(
      ownerWindow.Event.prototype,
      "bubbles",
      originalEvent,
    ) !== true
    || nativeEventGetter<boolean>(
      ownerWindow.Event.prototype,
      "cancelable",
      originalEvent,
    ) !== pointerOutside
    || nativeEventGetter<boolean>(
      ownerWindow.Event.prototype,
      "defaultPrevented",
      originalEvent,
    ) !== false
    || !(target instanceof ownerWindow.Node)
    || target.ownerDocument !== publication.document
    || !target.isConnected
    || content.contains(target)
    || trigger.contains(target)
    || originalPath[0] !== target
    || originalPath.indexOf(publication.document) < 0
  ) {
    return null;
  }
  const button = pointerOutside
    ? nativeEventGetter<number>(
        ownerWindow.MouseEvent.prototype,
        "button",
        originalEvent,
      )
    : undefined;
  const ctrlKey = pointerOutside
    ? nativeEventGetter<boolean>(
        ownerWindow.MouseEvent.prototype,
        "ctrlKey",
        originalEvent,
      )
    : undefined;
  if (pointerOutside && (button === undefined || ctrlKey === undefined)) return null;
  return Object.freeze({
    originalEvent,
    rightClick: pointerOutside && (button === 2 || (button === 0 && ctrlKey === true)),
  });
}

function exactMoreMenuOutside(
  publication: MoreMenuPublication,
  event: CustomEvent<{ originalEvent: Event }>,
  boundary: "window" | "target" = "target",
): ExactMoreMenuOutside | null {
  const ownerWindow = publication.document.defaultView;
  const content = publication.dom.content;
  const trigger = publication.dom.trigger;
  if (!ownerWindow || !content || !(event instanceof ownerWindow.CustomEvent)) return null;
  const originalEvent = moreMenuOutsideOriginalEvent(ownerWindow, event);
  if (!originalEvent) return null;
  const type = nativeEventGetter<string>(ownerWindow.Event.prototype, "type", event);
  const target = nativeEventGetter<EventTarget | null>(
    ownerWindow.Event.prototype,
    "target",
    event,
  );
  const currentTarget = nativeEventGetter<EventTarget | null>(
    ownerWindow.Event.prototype,
    "currentTarget",
    event,
  );
  const originalType = nativeEventGetter<string>(
    ownerWindow.Event.prototype,
    "type",
    originalEvent,
  );
  const originalTarget = nativeEventGetter<EventTarget | null>(
    ownerWindow.Event.prototype,
    "target",
    originalEvent,
  );
  const originalCurrentTarget = nativeEventGetter<EventTarget | null>(
    ownerWindow.Event.prototype,
    "currentTarget",
    originalEvent,
  );
  const path = nativeEventPath(ownerWindow, event);
  const originalPath = nativeEventPath(ownerWindow, originalEvent);
  const pointerOutside = (
    type === "dismissableLayer.pointerDownOutside"
    && originalType === "pointerdown"
    && originalEvent instanceof ownerWindow.PointerEvent
  );
  const focusOutside = (
    type === "dismissableLayer.focusOutside"
    && originalType === "focusin"
    && originalEvent instanceof ownerWindow.FocusEvent
  );
  const exactCustomBoundary = boundary === "window"
    ? currentTarget instanceof ownerWindow.Window
      && currentTarget === path[path.length - 1]
      && nativeEventGetter<number>(
        ownerWindow.Event.prototype,
        "eventPhase",
        event,
      ) === ownerWindow.Event.CAPTURING_PHASE
    : currentTarget === target
      && nativeEventGetter<number>(
        ownerWindow.Event.prototype,
        "eventPhase",
        event,
      ) === ownerWindow.Event.AT_TARGET;
  if (
    (!pointerOutside && !focusOutside)
    || target !== originalTarget
    || !exactCustomBoundary
    || originalCurrentTarget !== publication.document
    || nativeEventGetter<number>(
      ownerWindow.Event.prototype,
      "eventPhase",
      originalEvent,
    ) !== ownerWindow.Event.BUBBLING_PHASE
    || nativeEventGetter<boolean>(
      ownerWindow.Event.prototype,
      "bubbles",
      event,
    ) !== false
    || nativeEventGetter<boolean>(
      ownerWindow.Event.prototype,
      "cancelable",
      event,
    ) !== true
    || nativeEventGetter<boolean>(
      ownerWindow.Event.prototype,
      "defaultPrevented",
      event,
    ) !== false
    || nativeEventGetter<boolean>(
      ownerWindow.Event.prototype,
      "bubbles",
      originalEvent,
    ) !== true
    || nativeEventGetter<boolean>(
      ownerWindow.Event.prototype,
      "cancelable",
      originalEvent,
    ) !== pointerOutside
    || nativeEventGetter<boolean>(
      ownerWindow.Event.prototype,
      "defaultPrevented",
      originalEvent,
    ) !== false
    || !(target instanceof ownerWindow.Node)
    || target.ownerDocument !== publication.document
    || !target.isConnected
    || content.contains(target)
    || trigger.contains(target)
    || path.length !== originalPath.length
    || !path.every((entry, index) => entry === originalPath[index])
    || path[0] !== target
    || path.indexOf(publication.document) < 0
    || !(path[path.length - 1] instanceof ownerWindow.Window)
    || path.indexOf(publication.document) >= path.length - 1
  ) {
    return null;
  }
  const button = pointerOutside
    ? nativeEventGetter<number>(
        ownerWindow.MouseEvent.prototype,
        "button",
        originalEvent,
      )
    : undefined;
  const ctrlKey = pointerOutside
    ? nativeEventGetter<boolean>(
        ownerWindow.MouseEvent.prototype,
        "ctrlKey",
        originalEvent,
      )
    : undefined;
  if (pointerOutside && (button === undefined || ctrlKey === undefined)) return null;
  return Object.freeze({
    originalEvent,
    rightClick: pointerOutside && (button === 2 || (button === 0 && ctrlKey === true)),
  });
}

function createMoreMenuFocusGuard(
  source: MoreMenuPublication,
  target: HTMLButtonElement,
  onInvalidated: () => void,
): MoreMenuFocusGuard {
  const placement = Object.freeze({
    node: target,
    parent: target.parentNode,
    previousSibling: target.previousSibling,
    nextSibling: target.nextSibling,
  });
  const Observer = source.document.defaultView?.MutationObserver;
  const initialDynamicAttributes = new Map(
    ["data-radix-popper-align", "data-radix-popper-side"].map(
      (name) => [name, target.getAttribute(name)],
    ),
  );
  const records: MutationRecord[] = [];
  let observer: MutationObserver | null = null;
  let invalid = false;
  const inspect = (pending: readonly MutationRecord[]) => {
    if (!invalid) records.push(...pending);
  };
  if (Observer) {
    observer = new Observer(inspect);
    observer.observe(target, {
      attributeOldValue: true,
      attributes: true,
      characterDataOldValue: true,
      characterData: true,
      childList: true,
      subtree: true,
    });
    if (placement.parent) observer.observe(placement.parent, { childList: true });
  }
  const expected = (
    record: MutationRecord,
    publication: MoreMenuPublication,
  ) => {
    if (record.target === target || target.contains(record.target)) {
      if (record.type !== "attributes" || record.target !== target) return false;
      if (record.attributeName === "aria-expanded") {
        return record.oldValue === "true" && target.getAttribute("aria-expanded") === "false";
      }
      if (record.attributeName === "aria-controls") {
        return Boolean(
          source.dom.content?.id
          && record.oldValue === source.dom.content.id
          && target.getAttribute("aria-controls") === null
        );
      }
      if (record.attributeName === "data-state") {
        return record.oldValue === "open" && target.getAttribute("data-state") === "closed";
      }
      if (record.attributeName && initialDynamicAttributes.has(record.attributeName)) {
        return (
          record.oldValue === initialDynamicAttributes.get(record.attributeName)
          && target.getAttribute(record.attributeName) === null
        );
      }
      return false;
    }
    return record.type === "childList"
      && record.target === placement.parent
      && record.previousSibling !== target
      && record.nextSibling !== target
      && [...record.addedNodes, ...record.removedNodes].every(
        (node) => node !== target && !node.contains(target),
      )
      && publication.document === source.document;
  };
  return Object.freeze({
    isExact: (publication: MoreMenuPublication) => {
      if (observer) inspect(observer.takeRecords());
      if (!records.every((record) => expected(record, publication))) {
        invalid = true;
        onInvalidated();
      }
      return (
        !invalid
        && target.isConnected
        && modeSwitcherPlacementMatches(placement)
        && publication.dom.trigger === target
        && publication.isExact()
      );
    },
    dispose: () => {
      observer?.disconnect();
      observer = null;
    },
  });
}

function moreMenuFocusSuccessorIsExact(
  intent: MoreMenuFocusIntent,
  publication: MoreMenuPublication,
) {
  const before = intent.source.render;
  const after = publication.render;
  const allowedMutation = intent.action === "duplicate"
    ? after.documentMutation === null || after.documentMutation === "duplicate"
    : intent.action === "delete"
      ? after.documentMutation === null || after.documentMutation === "delete"
      : after.documentMutation === before.documentMutation;
  return (
    before.open
    && !after.open
    && after.visit === intent.visit
    && after.session === before.session
    && after.document === before.document
    && after.docId === before.docId
    && after.role === before.role
    && intent.modes.includes(after.mode)
    && after.setMode === before.setMode
    && after.compact === before.compact
    && after.linked === before.linked
    && after.canEdit === before.canEdit
    && after.isOwner === before.isOwner
    && after.githubConfigured === before.githubConfigured
    && after.publishing === before.publishing
    && allowedMutation
    && after.bindings.length === before.bindings.length
    && after.bindings.every((value, index) => Object.is(value, before.bindings[index]))
    && publication.document === intent.source.document
    && publication.dom.trigger === intent.target
    && intent.target.ownerDocument === publication.document
    && intent.guard.isExact(publication)
  );
}

function createMoreMenuPresentation({
  render,
  coordinator,
  owners,
  commitOpen,
}: {
  render: MoreMenuRender;
  coordinator: MoreMenuPublicationCoordinator;
  owners: MoreMenuOwners;
  commitOpen: (state: MoreMenuState) => void;
}): MoreMenuPresentation {
  const runtimeState: {
    current: MoreMenuPublicationRuntime | null;
    last: MoreMenuPublicationRuntime | null;
  } = { current: null, last: null };

  const createRuntime = (dom: MoreMenuDom): MoreMenuPublicationRuntime => {
    type Retirement = "element" | "layout" | "mutation" | "other";
    const triggerSnapshot = snapshotModeSwitcherDom(dom.trigger);
    const contentSnapshot = dom.content ? snapshotModeSwitcherDom(dom.content) : null;
    const placements = snapshotModeSwitcherPlacement(
      dom.content ? [dom.trigger, dom.content] : [dom.trigger],
    );
    const placementNodes = new Set(placements.map(({ node }) => node));
    const expectedOwners = new Map<MoreMenuElementOwnerHandle, HTMLElement>([
      [owners.trigger, dom.trigger],
    ]);
    if (dom.content) {
      expectedOwners.set(owners.content, dom.content);
      for (const action of Object.values(render.actions)) {
        const element = dom.actions[action.name];
        if (element) expectedOwners.set(owners.actions[action.name], element);
      }
    }
    const detached = new Set<MoreMenuElementOwnerHandle>();
    const reattached = new Set<MoreMenuElementOwnerHandle>();
    const listeners: Array<readonly [HTMLDivElement, (event: Event) => void]> = [];
    let genericSelection: MoreMenuGenericSelectionIntent | null = null;
    let genericClickListener: ((event: Event) => void) | null = null;
    let genericSelectListener: ((event: Event) => void) | null = null;
    let selectionCustomListener: ((event: Event) => void) | null = null;
    let outsideCustomListener: ((event: Event) => void) | null = null;
    let nativeOutsideListener: ((event: Event) => void) | null = null;
    let blurListener: ((event: Event) => void) | null = null;
    let replayInvalid = false;
    let retired = false;
    let retirement: Retirement | null = null;
    let mutationSeen = false;
    let observer: MutationObserver | null = null;

    const relevantMutation = (record: MutationRecord) => {
      if (
        record.type === "attributes"
        && record.attributeName
        && MODE_SWITCHER_DYNAMIC_ATTRIBUTES.has(record.attributeName)
      ) {
        return false;
      }
      const roots = dom.content ? [dom.trigger, dom.content] : [dom.trigger];
      if (roots.some((root) => record.target === root || root.contains(record.target))) return true;
      if (record.type !== "childList") return false;
      return (
        (record.previousSibling !== null && placementNodes.has(record.previousSibling))
        || (record.nextSibling !== null && placementNodes.has(record.nextSibling))
        || [...record.addedNodes, ...record.removedNodes].some((node) =>
          roots.some((root) => node === root || node.contains?.(root)))
      );
    };
    function inspectMutations(records: readonly MutationRecord[]) {
      if (records.some(relevantMutation)) {
        mutationSeen = true;
        if (retire("mutation")) coordinator.requestReplacement(publication);
      }
    }
    const historyIsClean = () => {
      if (observer) inspectMutations(observer.takeRecords());
      return !mutationSeen;
    };
    const recordElementChange = (
      owner: MoreMenuElementOwnerHandle,
      element: HTMLElement | null,
      previous: HTMLElement | null,
    ) => {
      const expected = expectedOwners.get(owner);
      if (!expected || replayInvalid) return;
      if (!retired) retire("element");
      if (retirement !== "element") return;
      if (element === null) {
        if (
          previous !== expected
          || detached.has(owner)
          || reattached.size > 0
        ) {
          replayInvalid = true;
          return;
        }
        detached.add(owner);
        return;
      }
      if (
        previous !== null
        || element !== expected
        || detached.size !== expectedOwners.size
        || !detached.has(owner)
        || reattached.has(owner)
      ) {
        replayInvalid = true;
        return;
      }
      reattached.add(owner);
    };
    const isExactElementReplay = () => (
      retired
      && retirement === "element"
      && !replayInvalid
      && detached.size === expectedOwners.size
      && reattached.size === expectedOwners.size
      && publication.isExact()
    );
    const publication: MoreMenuPublication = Object.freeze({
      render,
      document: dom.trigger.ownerDocument,
      dom,
      triggerSnapshot,
      contentSnapshot,
      placements,
      isExact: () => {
        if (!historyIsClean() || !moreMenuFactsAreCurrent(render)) return false;
        const current = currentMoreMenuDom(render, owners);
        return Boolean(
          current
          && moreMenuDomIsSame(current, dom)
          && placements.every(modeSwitcherPlacementMatches)
          && modeSwitcherDomSnapshotMatches(triggerSnapshot)
          && (!contentSnapshot || modeSwitcherDomSnapshotMatches(contentSnapshot))
        );
      },
      recordElementChange,
      isExactElementReplay,
      retire: () => retire("other"),
      dispose: () => {
        observer?.disconnect();
        observer = null;
        for (const [item, listener] of listeners) {
          item.removeEventListener("click", listener, { capture: true });
        }
        listeners.length = 0;
        if (dom.content && genericClickListener && genericSelectListener) {
          dom.content.removeEventListener("click", genericClickListener, { capture: true });
          dom.content.removeEventListener(
            "menu.itemSelect",
            genericSelectListener,
            { capture: true },
          );
        }
        if (selectionCustomListener) {
          publication.document.defaultView?.removeEventListener(
            "menu.itemSelect",
            selectionCustomListener,
            { capture: true },
          );
        }
        if (outsideCustomListener) {
          publication.document.defaultView?.removeEventListener(
            "dismissableLayer.pointerDownOutside",
            outsideCustomListener,
            { capture: true },
          );
          publication.document.defaultView?.removeEventListener(
            "dismissableLayer.focusOutside",
            outsideCustomListener,
            { capture: true },
          );
        }
        if (nativeOutsideListener) {
          publication.document.removeEventListener("pointerdown", nativeOutsideListener, {
            capture: true,
          });
          publication.document.removeEventListener("focusin", nativeOutsideListener, {
            capture: true,
          });
        }
        const ownerWindow = publication.document.defaultView;
        if (ownerWindow && blurListener) ownerWindow.removeEventListener("blur", blurListener);
        genericClickListener = null;
        genericSelectListener = null;
        selectionCustomListener = null;
        outsideCustomListener = null;
        nativeOutsideListener = null;
        blurListener = null;
        genericSelection = null;
      },
    });
    function retire(reason: Retirement) {
      if (retired) return false;
      retired = true;
      retirement = reason;
      coordinator.retire(publication);
      if (runtimeState.current?.publication === publication) runtimeState.current = null;
      return true;
    }
    const runtime: MoreMenuPublicationRuntime = Object.freeze({
      publication,
      retireForLayout: () => {
        retire(mutationSeen ? "mutation" : "layout");
      },
      isExactLayoutReplay: () => (
        retired
        && retirement === "layout"
        && publication.isExact()
      ),
    });
    const Observer = publication.document.defaultView?.MutationObserver;
    if (Observer) {
      observer = new Observer(inspectMutations);
      observer.observe(dom.trigger, {
        attributes: true,
        characterData: true,
        childList: true,
        subtree: true,
      });
      for (let ancestor = dom.trigger.parentNode; ancestor; ancestor = ancestor.parentNode) {
        observer.observe(ancestor, { childList: true });
      }
      if (dom.content) {
        observer.observe(dom.content, {
          attributes: true,
          characterData: true,
          childList: true,
          subtree: true,
        });
        for (let ancestor = dom.content.parentNode; ancestor; ancestor = ancestor.parentNode) {
          observer.observe(ancestor, { childList: true });
        }
      }
    }
    selectionCustomListener = (event: Event) => {
      coordinator.bindSelectionCustom(publication, event);
    };
    outsideCustomListener = (event: Event) => {
      const ownerWindow = publication.document.defaultView;
      if (!ownerWindow || !(event instanceof ownerWindow.CustomEvent)) return;
      coordinator.bindOutsideCustom(
        publication,
        event as CustomEvent<{ originalEvent: Event }>,
      );
    };
    nativeOutsideListener = (event: Event) => {
      coordinator.observeNativeOutsideTarget(publication, event);
    };
    publication.document.defaultView?.addEventListener(
      "menu.itemSelect",
      selectionCustomListener,
      { capture: true },
    );
    publication.document.defaultView?.addEventListener(
      "dismissableLayer.pointerDownOutside",
      outsideCustomListener,
      { capture: true },
    );
    publication.document.defaultView?.addEventListener(
      "dismissableLayer.focusOutside",
      outsideCustomListener,
      { capture: true },
    );
    publication.document.addEventListener("pointerdown", nativeOutsideListener, {
      capture: true,
    });
    publication.document.addEventListener("focusin", nativeOutsideListener, {
      capture: true,
    });
    if (dom.content) {
      genericClickListener = (event: Event) => {
        const admission = exactMoreMenuGenericNativeClick(publication, event);
        if (
          !admission
          || Object.values(dom.actions).some((element) => element === admission.item)
        ) {
          return;
        }
        genericSelection = admission;
        queueMicrotask(() => {
          if (genericSelection === admission) genericSelection = null;
        });
      };
      genericSelectListener = (event: Event) => {
        const admission = genericSelection;
        if (
          !admission
          || coordinator.active() !== publication
          || !moreMenuNativeClickIsAtRadixSelection(
            publication,
            admission.item,
            admission.nativeEvent,
            admission.target,
            admission.path,
          )
          || !exactMoreMenuGenericCustomSelect(publication, admission.item, event)
          || !coordinator.claimDisclosure([admission.nativeEvent, event])
        ) {
          return;
        }
        genericSelection = null;
        close(
          publication,
          true,
          null,
          moreMenuModeForGenericSelection(publication, admission.item),
        );
      };
      dom.content.addEventListener("click", genericClickListener, { capture: true });
      dom.content.addEventListener(
        "menu.itemSelect",
        genericSelectListener,
        { capture: true },
      );
    }
    const ownerWindow = publication.document.defaultView;
    if (ownerWindow && render.open) {
      blurListener = (event: Event) => {
        const type = nativeEventGetter<string>(ownerWindow.Event.prototype, "type", event);
        const target = nativeEventGetter<EventTarget | null>(
          ownerWindow.Event.prototype,
          "target",
          event,
        );
        const currentTarget = nativeEventGetter<EventTarget | null>(
          ownerWindow.Event.prototype,
          "currentTarget",
          event,
        );
        const eventPhase = nativeEventGetter<number>(
          ownerWindow.Event.prototype,
          "eventPhase",
          event,
        );
        const bubbles = nativeEventGetter<boolean>(
          ownerWindow.Event.prototype,
          "bubbles",
          event,
        );
        const cancelable = nativeEventGetter<boolean>(
          ownerWindow.Event.prototype,
          "cancelable",
          event,
        );
        const defaultPrevented = nativeEventGetter<boolean>(
          ownerWindow.Event.prototype,
          "defaultPrevented",
          event,
        );
        const path = nativeEventPath(ownerWindow, event);
        if (
          type !== "blur"
          || !target
          || target !== currentTarget
          || path.length !== 1
          || path[0] !== target
          || eventPhase !== ownerWindow.Event.AT_TARGET
          || bubbles !== false
          || cancelable !== false
          || defaultPrevented !== false
          || !isLiveMoreMenuNativeEvent(event, publication.document)
          || coordinator.active() !== publication
          || !publication.isExact()
          || !coordinator.claimDisclosure([event])
        ) {
          return;
        }
        close(publication);
      };
      ownerWindow.addEventListener("blur", blurListener);
    }
    for (const action of Object.values(render.actions)) {
      const item = dom.actions[action.name];
      if (!item) continue;
      const listener = (event: Event) => {
        if (
          coordinator.active() !== publication
          || publication.render !== render
          || !action.eligible
        ) {
          return;
        }
        const admission = exactMoreMenuNativeClick(publication, action, item, event);
        if (!admission || !(admission.nativeEvent instanceof MouseEvent)) return;
        coordinator.stageSelection(
          publication,
          action,
          admission.nativeEvent,
          admission.target,
          admission.path,
        );
      };
      item.addEventListener("click", listener, { capture: true });
      listeners.push(Object.freeze([item, listener] as const));
    }
    return runtime;
  };

  const currentPublication = () => {
    const runtime = runtimeState.current;
    const publication = runtime?.publication;
    return runtime
      && publication
      && coordinator.active() === publication
      && publication.render === render
      && publication.isExact()
      ? publication
      : null;
  };
  function close(
    publication: MoreMenuPublication,
    returnFocus = true,
    action: MoreMenuActionName | null = null,
    mode: EditMode = publication.render.mode,
  ) {
    if (
      !render.open
      || coordinator.active() !== publication
      || !publication.isExact()
      || !publication.retire()
    ) {
      return false;
    }
    if (returnFocus) {
      coordinator.scheduleFocus(publication, publication.dom.trigger, action, mode);
    }
    commitOpen(Object.freeze({ visit: render.visit, open: false }));
    return true;
  }
  const onTriggerPointerDown = (event: React.PointerEvent<HTMLButtonElement>) => {
    const publication = currentPublication();
    const trigger = publication?.dom.trigger;
    const ownerWindow = publication?.document.defaultView;
    const nativeEvent = event.nativeEvent;
    const target = event.target;
    if (
      !publication
      || !trigger
      || !ownerWindow
      || event.type !== "pointerdown"
      || event.currentTarget !== trigger
      || event.defaultPrevented
      || event.button !== 0
      || event.ctrlKey
      || !(target instanceof ownerWindow.Node)
      || target.ownerDocument !== publication.document
      || !trigger.contains(target)
      || !(nativeEvent instanceof ownerWindow.PointerEvent)
      || nativeEvent.type !== "pointerdown"
      || nativeEvent.target !== target
      || nativeEvent.defaultPrevented
      || nativeEvent.button !== 0
      || nativeEvent.ctrlKey
      || !isLiveMoreMenuNativeEvent(nativeEvent, publication.document)
      || !nativeEvent.composedPath().includes(trigger)
      || !coordinator.claimDisclosure([nativeEvent])
    ) {
      return;
    }
    coordinator.publishDisclosure(publication, !render.open, [nativeEvent]);
  };
  const onTriggerKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (!["Enter", " ", "ArrowDown"].includes(event.key)) return;
    const publication = currentPublication();
    const trigger = publication?.dom.trigger;
    const ownerWindow = publication?.document.defaultView;
    const nativeEvent = event.nativeEvent;
    const target = event.target;
    if (
      !publication
      || !trigger
      || !ownerWindow
      || event.type !== "keydown"
      || event.currentTarget !== trigger
      || event.defaultPrevented
      || !(target instanceof ownerWindow.Node)
      || target.ownerDocument !== publication.document
      || !trigger.contains(target)
      || !(nativeEvent instanceof ownerWindow.KeyboardEvent)
      || nativeEvent.type !== "keydown"
      || nativeEvent.target !== target
      || nativeEvent.key !== event.key
      || nativeEvent.defaultPrevented
      || !isLiveMoreMenuNativeEvent(nativeEvent, publication.document)
      || !nativeEvent.composedPath().includes(trigger)
      || !coordinator.claimDisclosure([nativeEvent])
    ) {
      return;
    }
    coordinator.publishDisclosure(
      publication,
      event.key === "ArrowDown" ? true : !render.open,
      [nativeEvent],
    );
  };
  const onOpenChange = (open: boolean) => {
    const publication = currentPublication();
    const intent = publication && coordinator.consumeDisclosure(publication, open);
    if (!publication || !intent || render.open === open) return;
    if (open) {
      if (!publication.retire()) return;
      commitOpen(Object.freeze({ visit: render.visit, open: true }));
      render.props.onMoreMenuOpen?.();
    } else {
      close(publication, intent.returnFocus);
    }
  };
  const select = (action: MoreMenuAction, event: Event) => {
    const publication = currentPublication();
    const item = publication?.dom.actions[action.name];
    if (
      !publication
      || !item
      || !action.eligible
      || !exactMoreMenuCustomSelect(publication, item, event)
    ) {
      return;
    }
    const intent = coordinator.consumeSelection(publication, action, event);
    if (
      !intent
      || intent.target.ownerDocument !== publication.document
      || intent.path[0] !== intent.target
      || intent.path.indexOf(item) < 0
      || !close(publication, true, action.name)
    ) {
      return;
    }
    action.callback();
  };
  const onEscapeKeyDown = (event: KeyboardEvent) => {
    const publication = currentPublication();
    if (
      !publication
      || !exactMoreMenuEscape(publication, event)
      || !coordinator.claimDisclosure([event])
    ) {
      return;
    }
    coordinator.publishDisclosure(publication, false, [event]);
  };
  const onOutside = (event: CustomEvent<{ originalEvent: Event }>) => {
    const publication = currentPublication();
    const outside = publication && exactMoreMenuOutside(publication, event);
    if (
      !publication
      || !outside
      || !coordinator.claimOutsideCustom(
        publication,
        event,
        outside.originalEvent,
      )
    ) {
      return;
    }
    coordinator.publishDisclosure(
      publication,
      false,
      [event, outside.originalEvent],
      !outside.rightClick,
    );
  };
  function establish() {
    if (
      (runtimeState.last && !runtimeState.last.isExactLayoutReplay())
      || !moreMenuFactsAreCurrent(render)
    ) {
      return undefined;
    }
    const dom = currentMoreMenuDom(render, owners);
    if (!dom) return undefined;
    const runtime = createRuntime(dom);
    runtimeState.current = runtime;
    runtimeState.last = runtime;
    coordinator.publish(runtime.publication);
    return runtime.retireForLayout;
  }
  return Object.freeze({
    captureTrigger: owners.trigger.capture,
    captureContent: owners.content.capture,
    captureHistory: owners.actions.history.capture,
    captureNameVersion: owners.actions["name-version"].capture,
    captureDuplicate: owners.actions.duplicate.capture,
    captureDelete: owners.actions.delete.capture,
    establish,
    onTriggerPointerDown,
    onTriggerKeyDown,
    onOpenChange,
    onHistorySelect: (event: Event) => select(render.actions.history, event),
    onNameVersionSelect: (event: Event) => select(render.actions["name-version"], event),
    onDuplicateSelect: (event: Event) => select(render.actions.duplicate, event),
    onDeleteSelect: (event: Event) => select(render.actions.delete, event),
    onEscapeKeyDown,
    onOutside,
    onCloseAutoFocus: (event: Event) => event.preventDefault(),
    // Reused by a plain MenuItem's own onSelect (see the Header component's onMoreMenuPlainSelect)
    // so a mouse-driven close gets the exact same focus handoff Enter already gets through
    // genericSelectListener's `close(publication, true, null, mode)` call above - no new gate,
    // just the existing close path invoked from a different caller.
    closeForPlainSelect: () => {
      const publication = currentPublication();
      return publication ? close(publication) : false;
    },
  });
}

function MoreMenuOpenCommit({ presentation }: { presentation: MoreMenuPresentation }) {
  useLayoutEffect(() => presentation.establish(), [presentation]);
  return null;
}

export const Header = memo(function Header(props: HeaderProps) {
  const { session, doc, compact, githubConfigured, embed = false, connectAgentNonce = 0 } = props;
  const openComments = useSessionValue(session, (s) => s.comments.list().filter((c) => !c.resolved).length);
  const linked = doc.storage !== "local";
  const canEdit = useSessionValue(session, (current) => current.canWrite);
  const [moreMenuMount] = useState(() => Symbol("document more menu"));
  const [, setMoreMenuPublicationRevision] = useState(0);
  const [moreMenuCoordinator] = useState(
    () => new MoreMenuPublicationCoordinator(
      () => setMoreMenuPublicationRevision((revision) => revision + 1),
    ),
  );
  const [moreMenuOwners] = useState(() => createMoreMenuOwners(moreMenuCoordinator));
  const moreMenuVisit = useMemo<MoreMenuVisit>(
    () => Object.freeze({ mount: moreMenuMount, session, document: doc }),
    [doc, moreMenuMount, session],
  );
  const initialMoreMenuState = useMemo<MoreMenuState>(
    () => Object.freeze({ visit: moreMenuVisit, open: false }),
    [moreMenuVisit],
  );
  const [storedMoreMenuState, setStoredMoreMenuState] = useState(initialMoreMenuState);
  const moreMenuState = storedMoreMenuState.visit === moreMenuVisit
    ? storedMoreMenuState
    : initialMoreMenuState;
  const moreMenuRender: MoreMenuRender = Object.freeze({
    identity: Object.freeze({}),
    visit: moreMenuVisit,
    props,
    session,
    document: doc,
    documentFields: snapshotMoreMenuDocument(doc),
    bindings: moreMenuBindings(props),
    docId: doc.id,
    role: session.role,
    mode: session.mode,
    setMode: session.setMode,
    compact,
    linked,
    canEdit,
    isOwner: props.isOwner,
    githubConfigured,
    publishing: props.publishing,
    documentMutation: props.documentMutation,
    open: moreMenuState.open,
    actions: Object.freeze({
      history: Object.freeze({
        name: "history",
        callback: props.onHistory,
        eligible: true,
        label: "Version history",
        testId: "menu-history",
        className: "menu-item",
        iconClassName: "lucide-rotate-ccw-clock",
        busy: false,
      }),
      "name-version": Object.freeze({
        name: "name-version",
        callback: props.onNameVersion,
        eligible: canEdit,
        label: "Name current version",
        testId: null,
        className: "menu-item",
        iconClassName: "lucide-pencil",
        busy: false,
      }),
      duplicate: Object.freeze({
        name: "duplicate",
        callback: props.onDuplicate,
        eligible: props.documentMutation === null,
        label: props.documentMutation === "duplicate" ? "Making a copy…" : "Make a copy",
        testId: "menu-duplicate",
        className: "menu-item",
        iconClassName: props.documentMutation === "duplicate" ? "lucide-loader-circle" : "lucide-files",
        busy: props.documentMutation === "duplicate",
      }),
      delete: Object.freeze({
        name: "delete",
        callback: props.onDelete,
        eligible: props.isOwner && props.documentMutation === null,
        label: props.documentMutation === "delete" ? "Moving to trash…" : "Move to trash",
        testId: "menu-delete",
        className: "menu-item text-danger",
        iconClassName: props.documentMutation === "delete" ? "lucide-loader-circle" : "lucide-trash-2",
        busy: props.documentMutation === "delete",
      }),
    }),
  });
  const moreMenuPresentation = createMoreMenuPresentation({
    render: moreMenuRender,
    coordinator: moreMenuCoordinator,
    owners: moreMenuOwners,
    commitOpen: setStoredMoreMenuState,
  });
  useLayoutEffect(
    () => moreMenuPresentation.establish(),
    [moreMenuPresentation],
  );
  const {
    captureTrigger: captureMoreMenuTrigger,
    captureContent: captureMoreMenuContent,
    captureHistory,
    captureNameVersion,
    captureDuplicate,
    captureDelete,
    onTriggerPointerDown: onMoreMenuTriggerPointerDown,
    onTriggerKeyDown: onMoreMenuTriggerKeyDown,
    onOpenChange: onMoreMenuOpenChange,
    onHistorySelect,
    onNameVersionSelect,
    onDuplicateSelect,
    onDeleteSelect,
    onEscapeKeyDown: onMoreMenuEscapeKeyDown,
    onOutside: onMoreMenuOutside,
    onCloseAutoFocus: onMoreMenuCloseAutoFocus,
    closeForPlainSelect: closeMoreMenuForPlainSelect,
  } = moreMenuPresentation;
  // #2203 root cause: a plain MenuItem's own onSelect always runs (that's Radix's own
  // close-on-select contract), but on a REAL, trusted mouse click the menu's native-event close
  // path never fires: the capture-phase `genericClickListener` stages a one-shot `genericSelection`
  // admission token and queues a microtask to clear it, and that microtask always runs - clearing
  // the token - before Radix's separately-scheduled click handling gets around to dispatching its
  // internal "menu.itemSelect" custom event, so `genericSelectListener`'s admission check always
  // sees a cleared token and never calls `close()`. Enter doesn't hit this: Radix handles it by
  // calling the item's `.click()` from script, which drives the whole chain - including
  // "menu.itemSelect" - synchronously in one task, ahead of the queued microtask. So close the menu
  // ourselves, directly, before running the item's action, instead of depending on that race - and
  // reuse the menu's own `close()` (`closeForPlainSelect` above) so the mouse path gets the same
  // focus handoff Enter already gets, rather than just flipping state.
  const onMoreMenuPlainSelect = (action: () => void) => () => {
    if (!closeMoreMenuForPlainSelect()) {
      setStoredMoreMenuState(Object.freeze({ visit: moreMenuVisit, open: false }));
    }
    action();
  };
  const onMoreMenuWindowOpenSelect = (url: string) => onMoreMenuPlainSelect(
    () => window.open(url, "_blank", "noopener"),
  );
  // Star state and the notifications poll wait for the first sync: the socket handshake and the
  // collab-token call get the server to themselves on open (#118).
  const settled = useOpenSettled(session);
  // "Connect an AI agent": one dialog, opened from Share, the presence popover, the command palette and the slash menu.
  const [agentDialogOpen, setAgentDialogOpen] = useState(false);
  useEffect(() => {
    if (connectAgentNonce > 0) setAgentDialogOpen(true);
  }, [connectAgentNonce]);
  const agentDialogEverOpened = useEverTrue(agentDialogOpen);
  const liveTitle = useSessionValue(session, (s) => s.title || doc.title);
  const openAgentDialog = useCallback(() => setAgentDialogOpen(true), []);
  // Phones can paint the header while the HTML is still being parsed (a 4× slower CPU: `readyState` was "loading" at the
  // first frame in 2 of 3 runs), and then the right group is laid out with only its first children — 70 px, or 110 px
  // with the bell — and grows to 190 px once the comments toggle and ⋮ have arrived, pushing the title and the save chip
  // left (#1562: {x 268, w 110} → {x 188, w 190}, 0.0033–0.0050). Every child is already in the server markup, so the
  // group reserves its final phone width from the first byte: the 70 px pane segment plus 36 px icon buttons with 4 px
  // gaps — comments always, the bell when signed in, ⋮ outside embeds (the desktop-only children are `hidden`/
  // `max-md:hidden` below `md` and add nothing). In rem like the utilities it mirrors; from `md` the class is inert.
  const phoneRightMinWidth = embed
    ? "max-md:min-w-[calc(6.75rem+2px)]" // segment + comments: 110 px
    : session.user.login
      ? "max-md:min-w-[calc(11.75rem+2px)]" // segment + bell + comments + ⋮: 190 px
      : "max-md:min-w-[calc(9.25rem+2px)]"; // segment + comments + ⋮: 150 px

  return (
    <header className={HEADER_BOX} data-testid="header" data-embed={embed || undefined}>
      {compact ? (
        <button type="button" className="icon-btn h-9 w-9 shrink-0" onClick={props.onOutline} aria-label="Outline" title="Outline" data-testid="outline-button">
          <PanelLeft size={20} />
        </button>
      ) : embed ? (
        <span className="flex h-9 w-9 shrink-0 items-center justify-center md:h-10 md:w-10" aria-label="Markdoc" data-testid="embed-logo">
          <Logo className="h-8 w-8" />
        </span>
      ) : (
        // Below `md` the same 36 px box as the outline button that replaces it after hydration (#1470).
        <Link href="/" className="icon-btn h-9 w-9 shrink-0 md:h-10 md:w-10" aria-label="Back to documents" title="All documents">
          <Logo className="h-8 w-8" />
        </Link>
      )}
      <div className="flex min-w-0 flex-1 items-center gap-2 md:gap-4">
        <TitleEditor session={session} fallback={doc.title} compact={compact} />
        {!embed && !compact && <HeaderStar docId={doc.id} ready={settled} />}
        <SaveIndicator session={session} compact={compact} />
      </div>
      <div className={cn("flex shrink-0 items-center gap-1 md:gap-3", phoneRightMinWidth)} data-testid="header-right">
        <LayoutSegment layout={props.layout} onLayout={props.onLayout} />
        <div className="hidden items-center gap-3 md:flex">
          <ModeSwitcher session={session} />
          <PresenceStack session={session} onJump={props.onJumpToUser} onCancelRequest={props.onCancelRequest} onConnectAgent={openAgentDialog} />
        </div>
        {agentDialogEverOpened && <AgentDialog doc={{ id: doc.id, title: liveTitle }} open={agentDialogOpen} onOpenChange={setAgentDialogOpen} />}
        {!embed && session.user.login && <NotificationsBell currentDocId={doc.id} onOpen={props.onOpenNotification} ready={settled} />}
        {!embed && !compact && (
          <button type="button" className="btn btn-outline max-md:hidden" onClick={props.onShare} data-testid="share-button">
            <UserPlus size={17} />
            Share
          </button>
        )}
        <Tip label={props.commentsOpen ? "Hide comments" : "Show comments"} shortcut={shortcut("Mod-Alt-M")}>
          <button
            type="button"
            className="icon-btn relative"
            onClick={(event) => props.onToggleComments(event.detail === 0)}
            data-active={props.commentsOpen}
            aria-label="Comments"
            data-testid="comments-toggle"
          >
            <MessageSquare size={20} />
            {openComments > 0 && (
              <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 text-[10px] font-semibold text-on-accent" data-testid="comments-badge">
                {openComments}
              </span>
            )}
          </button>
        </Tip>
        {!embed && <Menu open={moreMenuState.open} onOpenChange={onMoreMenuOpenChange}>
          <MenuTrigger asChild>
            <button
              ref={captureMoreMenuTrigger}
              type="button"
              className="icon-btn"
              aria-label="More"
              data-testid="more-menu"
              onPointerDown={onMoreMenuTriggerPointerDown}
              onKeyDown={onMoreMenuTriggerKeyDown}
            >
              <MoreVertical size={20} />
            </button>
          </MenuTrigger>
          <MenuContent
            ref={captureMoreMenuContent}
            align="end"
            className="w-64"
            onEscapeKeyDown={onMoreMenuEscapeKeyDown}
            onPointerDownOutside={onMoreMenuOutside}
            onFocusOutside={onMoreMenuOutside}
            onCloseAutoFocus={onMoreMenuCloseAutoFocus}
          >
            {compact && (
              <>
                <MenuItem icon={<UserPlus size={15} />} onSelect={onMoreMenuPlainSelect(props.onShare)} data-testid="menu-share">
                  Share…
                </MenuItem>
                <MenuItem
                  icon={linked ? <UploadCloud size={15} /> : <GitHubIcon size={15} />}
                  onSelect={onMoreMenuPlainSelect(linked ? props.onPublishNow : props.onPublish)}
                  disabled={props.publishing || (linked ? !canEdit : !props.isOwner || !githubConfigured)}
                  title={!linked && !githubConfigured ? GITHUB_NOT_CONFIGURED : undefined}
                  data-testid="menu-publish"
                >
                  {linked ? (doc.storage === "gist" ? "Update gist" : "Commit to GitHub…") : <GitHubEntryLabel configured={githubConfigured}>Publish to GitHub…</GitHubEntryLabel>}
                </MenuItem>
                <MenuSeparator />
                <ModeItems session={session} />
                <MenuSeparator />
              </>
            )}
            <MenuItem ref={captureHistory} icon={<History size={15} />} onSelect={onHistorySelect} data-testid="menu-history">
              Version history
            </MenuItem>
            <MenuItem icon={<Activity size={15} />} onSelect={onMoreMenuPlainSelect(props.onActivity)} data-testid="menu-activity">
              Activity
            </MenuItem>
            {canEdit && (
              <MenuItem ref={captureNameVersion} icon={<Pencil size={15} />} onSelect={onNameVersionSelect}>
                Name current version
              </MenuItem>
            )}
            <MenuSeparator />
            <MenuItem icon={<Download size={15} />} onSelect={onMoreMenuPlainSelect(() => props.onDownload("md", false))} data-testid="download-md">
              Download Markdown
            </MenuItem>
            <MenuItem icon={<FileCode2 size={15} />} onSelect={onMoreMenuPlainSelect(() => props.onDownload("html", false))} data-testid="download-html">
              Download HTML
            </MenuItem>
            <MenuItem icon={<FileText size={15} />} onSelect={onMoreMenuPlainSelect(() => props.onDownload("pdf", false))} data-testid="download-pdf">
              Download PDF
            </MenuItem>
            <MenuItem icon={<Copy size={15} />} onSelect={onMoreMenuPlainSelect(props.onCopyMarkdown)}>
              Copy Markdown
            </MenuItem>
            <MenuItem
              ref={captureDuplicate}
              icon={props.documentMutation === "duplicate" ? <Loader2 size={15} className="animate-spin" /> : <Files size={15} />}
              onSelect={onDuplicateSelect}
              disabled={props.documentMutation !== null}
              aria-busy={props.documentMutation === "duplicate" || undefined}
              data-testid="menu-duplicate"
            >
              {props.documentMutation === "duplicate" ? "Making a copy…" : "Make a copy"}
            </MenuItem>
            <MenuItem icon={<BookOpen size={15} />} onSelect={onMoreMenuWindowOpenSelect(`/p/${doc.id}`)} data-testid="menu-reader">
              Open reader view
            </MenuItem>
            <MenuSeparator />
            {linked && doc.githubUrl && (
              <MenuItem icon={<ExternalLink size={15} />} onSelect={onMoreMenuWindowOpenSelect(doc.githubUrl)}>
                Open on GitHub
              </MenuItem>
            )}
            {props.isOwner && (
              <MenuItem
                icon={<GitHubIcon size={15} />}
                onSelect={onMoreMenuPlainSelect(props.onPublish)}
                disabled={!linked && !githubConfigured}
                title={!linked && !githubConfigured ? GITHUB_NOT_CONFIGURED : undefined}
                data-testid="menu-github"
              >
                {linked ? "GitHub connection…" : <GitHubEntryLabel configured={githubConfigured}>Connect to GitHub…</GitHubEntryLabel>}
              </MenuItem>
            )}
            {props.onCommandPalette && (
              <MenuItem icon={<Command size={15} />} onSelect={onMoreMenuPlainSelect(props.onCommandPalette)} shortcut={shortcut("Mod-K")} data-testid="menu-command-palette">
                Search commands
              </MenuItem>
            )}
            <MenuItem icon={<Keyboard size={15} />} onSelect={onMoreMenuPlainSelect(props.onShortcuts)}>
              Keyboard shortcuts
            </MenuItem>
            <MenuSeparator />
            <MenuItem icon={<ArrowLeft size={15} />} onSelect={onMoreMenuPlainSelect(props.onHome)}>
              All documents
            </MenuItem>
            <MenuItem icon={<LogOut size={15} />} onSelect={onMoreMenuPlainSelect(() => void signOutSafely())}>
              Sign out
            </MenuItem>
            {props.isOwner && (
              <>
                <MenuSeparator />
                <MenuItem
                  ref={captureDelete}
                  icon={props.documentMutation === "delete" ? <Loader2 size={15} className="animate-spin" /> : <Trash2 size={15} />}
                  className="text-danger"
                  onSelect={onDeleteSelect}
                  disabled={props.documentMutation !== null}
                  aria-busy={props.documentMutation === "delete" || undefined}
                  data-testid="menu-delete"
                >
                  {props.documentMutation === "delete" ? "Moving to trash…" : "Move to trash"}
                </MenuItem>
              </>
            )}
            <MoreMenuOpenCommit presentation={moreMenuPresentation} />
          </MenuContent>
        </Menu>}
        {!embed && !compact && <PublishMenu props={props} />}
      </div>
    </header>
  );
});
