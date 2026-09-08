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
import { AgentBusyBadge, KeepAgentHereButton, PresenceActivity, PresenceRequests, WaitingPlaceholder, busyAgentNames, isRecentActivity, pendingWorker, presenceAgentName, presenceNameOf, useAgentActivity, waitingLabel } from "./presence-agents";
import { signOutSafely } from "@/lib/sign-out";
import { Logo } from "@/components/ui/logo";
import { useEverTrue, useHydrated } from "@/lib/hooks";
import { lazyOnFirstUse } from "./lazy-on-first-use";
import { HEADER_BOX } from "./chrome-classes";

// On demand (#1150): the dialog, with the agent-connect card and copy blocks behind it, is fetched on its first
// open and then stays mounted (mount-once gate below), so Radix's close handling and focus return are unchanged.
const KeepAgentHereDialog = lazyOnFirstUse(() => import("./keep-agent-here"), (m) => m.KeepAgentHereDialog);

type ManualSaveOwner = {
  session: CollabSession;
  operation: number;
};

type ManualSaveState =
  | { owner: ManualSaveOwner; status: "pending" }
  | { owner: ManualSaveOwner; status: "failed"; message: string };

export function SaveIndicator({ session, compact }: { session: CollabSession; compact?: boolean }) {
  const liveState = useSessionValue(session, (s) => s.saveState);
  const liveUnsynced = useSessionValue(session, (s) => Math.max(s.unsyncedChanges, s.dirty ? 1 : 0));
  const liveRecovered = useSessionValue(session, (s) => s.recovered);
  const liveProlonged = useSessionValue(session, (s) => s.prolongedOffline);
  const saveError = useSessionValue(session, (s) => s.saveError);
  const [manualSave, setManualSave] = useState<ManualSaveState | null>(null);
  const manualSaveOwner = useRef<ManualSaveOwner | null>(null);
  const nextManualOperation = useRef(0);
  const currentManualSave = manualSave?.owner.session === session ? manualSave : null;
  const manualPending = currentManualSave?.status === "pending";
  const manualError = currentManualSave?.status === "failed" ? currentManualSave.message : null;
  useLayoutEffect(() => {
    manualSaveOwner.current = null;
    setManualSave(null);
    return () => {
      manualSaveOwner.current = null;
    };
  }, [session]);
  // The server renders a fresh session ("Connecting…"); an offline client may already have
  // failed to connect by the time React hydrates. Match the server markup first, then switch.
  const hydrated = useHydrated();
  const raw: SaveState = hydrated ? liveState : "connecting";
  // The session now waits for database acknowledgement; no cosmetic extra debounce is needed.
  const state = raw;
  const unsynced = hydrated ? liveUnsynced : 0;
  const recovered = hydrated && liveRecovered;
  const prolonged = hydrated && liveProlonged;
  const label = state === "error" && saveError ? "Save failed — retry" : saveStateLabel(state, unsynced, recovered, prolonged);
  const map: Record<SaveState, { icon: React.ReactNode; className: string }> = {
    saved: { icon: <Check size={16} strokeWidth={2.5} />, className: "text-success" },
    pending: { icon: <CloudOff size={16} />, className: "text-ink-3" },
    saving: { icon: <Loader2 size={16} className="animate-spin" />, className: "text-ink-3" },
    connecting: { icon: <Loader2 size={16} className="animate-spin" />, className: "text-ink-3" },
    reconnecting: { icon: <Loader2 size={16} className="animate-spin" />, className: "text-warning" },
    offline: { icon: <CloudOff size={16} />, className: "text-warning" },
    error: { icon: <AlertTriangle size={16} />, className: "text-danger" },
  };
  const m = map[state];
  const flash = state === "saved" && recovered;
  return (
    <span
      className={cn("inline-flex items-center gap-1.5 rounded-md text-sm font-medium transition-colors", m.className, flash && "save-state-recovered")}
      data-testid="save-state"
      data-state={state}
      data-live-state={raw}
      data-unsynced={unsynced}
      data-recovered={flash || undefined}
      data-prolonged={prolonged || undefined}
      role="status"
      title={manualError ?? saveError ?? (compact ? label : undefined)}
    >
      <button
        type="button"
        className="inline-flex items-center gap-1.5"
        disabled={!session.canEdit || manualPending}
        aria-busy={manualPending || undefined}
        aria-label="Save document"
        onClick={() => {
          if (!session.canEdit || manualSaveOwner.current) return;
          const owner = { session, operation: ++nextManualOperation.current };
          manualSaveOwner.current = owner;
          setManualSave({ owner, status: "pending" });
          void (async () => {
            try {
              await session.flushSave();
              if (manualSaveOwner.current?.session !== owner.session
                || manualSaveOwner.current.operation !== owner.operation) return;
              manualSaveOwner.current = null;
              setManualSave((current) => current?.owner.session === owner.session
                && current.owner.operation === owner.operation ? null : current);
            } catch (error: unknown) {
              if (manualSaveOwner.current?.session !== owner.session
                || manualSaveOwner.current.operation !== owner.operation) return;
              manualSaveOwner.current = null;
              setManualSave((current) => current?.owner.session === owner.session
                && current.owner.operation === owner.operation
                ? { owner, status: "failed", message: error instanceof Error ? error.message : "Save failed" }
                : current);
            }
          })();
        }}
      >
        {m.icon}
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
  const canEdit = session.role === "owner" || session.role === "editor";
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
  const title = useSessionValue(session, (current) => current.title || fallback);
  const role = session.role;
  const canEdit = role === "owner" || role === "editor";
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
  /** Opens the "Keep an agent here" dialog; the popover offers it while no agent is present. */
  onKeepAgent?: () => void;
}

interface PresenceVisit {
  session: CollabSession;
  onJump: PresenceStackProps["onJump"];
  onCancelRequest: PresenceStackProps["onCancelRequest"];
  onKeepAgent: PresenceStackProps["onKeepAgent"];
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
export function PresenceStack({ session, onJump, onCancelRequest, onKeepAgent }: PresenceStackProps) {
  const visit = useMemo<PresenceVisit>(
    () => ({ session, onJump, onCancelRequest, onKeepAgent }),
    [session, onJump, onCancelRequest, onKeepAgent],
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
  const keepAgent = () => {
    if (!ownsVisit(visit)) return;
    updateState((current) => (current.open ? { ...current, open: false } : current));
    visit.onKeepAgent?.();
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
            return (
              <li key={u.id} className={cn("flex items-center gap-2.5 rounded-lg px-2 py-1.5", idle && !working && "opacity-60")} data-testid="presence-row" data-user-id={u.id} data-agent={u.isAgent ? "" : undefined}>
                <span className="relative inline-flex shrink-0">
                  {u.isAgent ? <AgentAvatar name={u.name} color={u.color} size={28} /> : <Avatar name={u.name} src={u.avatar} color={u.color} size={28} />}
                  {working && <AgentBusyBadge name={agentName(u)} />}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5 text-sm font-medium text-ink">
                    <span className="truncate">{u.isLocal ? `${u.name} (you)` : u.isAgent ? agentName(u) : u.name}</span>
                    {u.isAgent && <span className="rounded-md bg-violet-100 px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide text-violet-700 dark:bg-violet-950 dark:text-violet-300">Agent</span>}
                    {u.role && <span className="rounded-md bg-surface-2 px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide text-ink-3">{roleLabel[u.role] ?? u.role}</span>}
                  </div>
                  <div className="truncate text-xs text-ink-3" data-testid="presence-section">
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
                      <>
                        {idle ? "Idle · " : ""}
                        {u.cursor === null ? "no cursor" : u.section ? `in ‘${u.section}’` : "at the top"}
                      </>
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
        {agents.length === 0 && onKeepAgent && (
          <div className={cn("px-1 pb-1", waiting ? "pt-1" : "pt-1.5")}>
            <KeepAgentHereButton onClick={keepAgent} primary={waiting} />
          </div>
        )}
        {others.length === 0 && pending.length === 0 && <div className="px-2 pb-1 pt-1.5 text-xs text-ink-3">Share the document to work on it together.</div>}
      </PopoverContent>
    </Popover>
  );
}

interface ModeSwitcherVisit {
  readonly mount: symbol;
  readonly session: CollabSession;
}

interface ModeSwitcherState {
  readonly visit: ModeSwitcherVisit;
  readonly open: boolean;
}

interface ModeSwitcherRowAuthority {
  readonly index: number;
  readonly value: EditMode;
  readonly label: string;
  readonly description: string;
  readonly eligible: boolean;
}

interface ModeSwitcherDom {
  readonly trigger: HTMLButtonElement | null;
  readonly content: HTMLDivElement | null;
  readonly group: HTMLDivElement | null;
  readonly rows: readonly (HTMLDivElement | null)[];
  readonly reader: HTMLDivElement | null;
}

interface ModeSwitcherAuthority {
  readonly visit: ModeSwitcherVisit;
  readonly session: CollabSession;
  readonly docId: string;
  readonly role: CollabSession["role"];
  readonly editable: boolean;
  readonly mode: EditMode;
  readonly open: boolean;
  readonly setMode: CollabSession["setMode"];
  readonly dom: ModeSwitcherDom;
  readonly reader: Readonly<{
    url: string;
    target: "_blank";
    features: "noopener";
  }>;
  readonly rows: readonly ModeSwitcherRowAuthority[];
}

interface ModeSwitcherRowPublication extends ModeSwitcherRowAuthority {
  readonly capture: (element: HTMLDivElement | null) => void;
  readonly onSelect: (event: Event) => void;
}

interface ModeSwitcherDisclosureIntent {
  readonly publication: ModeSwitcherPresentation;
  readonly open: boolean;
  readonly claim: () => boolean;
}

interface ModeSwitcherSelectionIntent {
  readonly publication: ModeSwitcherPresentation;
  readonly row: ModeSwitcherRowPublication;
  readonly claim: () => boolean;
}

interface ModeSwitcherFocusIntent {
  readonly publication: ModeSwitcherPresentation;
  readonly target: HTMLButtonElement;
}

interface ModeSwitcherCells {
  active: ModeSwitcherPresentation | null;
  disclosureIntent: ModeSwitcherDisclosureIntent | null;
  selectionIntent: ModeSwitcherSelectionIntent | null;
  focusIntent: ModeSwitcherFocusIntent | null;
  readonly issuedEvents: WeakSet<object>;
}

interface ModeSwitcherPresentation {
  readonly authority: ModeSwitcherAuthority;
  readonly rows: readonly ModeSwitcherRowPublication[];
  readonly captureTrigger: (element: HTMLButtonElement | null) => void;
  readonly captureContent: (element: HTMLDivElement | null) => void;
  readonly captureGroup: (element: HTMLDivElement | null) => void;
  readonly captureReader: (element: HTMLDivElement | null) => void;
  readonly establish: () => void;
  readonly retire: () => boolean;
  readonly onTriggerPointerDown: (event: React.PointerEvent<HTMLButtonElement>) => void;
  readonly onTriggerKeyDown: (event: React.KeyboardEvent<HTMLButtonElement>) => void;
  readonly onOpenChange: (open: boolean) => void;
  readonly onModeChange: (value: string) => void;
  readonly onReaderSelect: (event: Event) => void;
  readonly onEscapeKeyDown: (event: KeyboardEvent) => void;
  readonly onOutside: (event: CustomEvent<{ originalEvent: Event }>) => void;
}

function createModeSwitcherPresentation({
  authority,
  cells,
  commitOpen,
  captureTrigger,
  captureContent,
  captureGroup,
  captureRows,
  captureReader,
}: {
  authority: ModeSwitcherAuthority;
  cells: ModeSwitcherCells;
  commitOpen: (state: ModeSwitcherState) => void;
  captureTrigger: (element: HTMLButtonElement | null) => void;
  captureContent: (element: HTMLDivElement | null) => void;
  captureGroup: (element: HTMLDivElement | null) => void;
  captureRows: readonly ((element: HTMLDivElement | null) => void)[];
  captureReader: (element: HTMLDivElement | null) => void;
}): ModeSwitcherPresentation {
  const factsAreCurrent = () => {
    const currentEditable = authority.session.role === "owner" || authority.session.role === "editor";
    return (
      authority.visit.session === authority.session
      && authority.session.docId === authority.docId
      && authority.session.role === authority.role
      && currentEditable === authority.editable
      && authority.session.mode === authority.mode
      && authority.session.setMode === authority.setMode
    );
  };
  const exactDomIsCurrent = () => {
    const { trigger, content, group, reader } = authority.dom;
    if (
      !trigger
      || !trigger.isConnected
      || trigger.ownerDocument !== document
      || trigger.getAttribute("data-testid") !== "mode-switcher"
      || trigger.getAttribute("aria-expanded") !== String(authority.open)
      || trigger.getAttribute("data-state") !== (authority.open ? "open" : "closed")
    ) return false;

    if (!authority.open) {
      return content === null
        && group === null
        && reader === null
        && authority.dom.rows.every((element) => element === null);
    }
    if (
      !content
      || !group
      || !reader
      || !content.isConnected
      || !group.isConnected
      || !reader.isConnected
      || content.ownerDocument !== trigger.ownerDocument
      || content.getAttribute("role") !== "menu"
      || content.getAttribute("data-state") !== "open"
      || group.parentElement !== content
      || reader.parentElement !== content
      || reader.getAttribute("role") !== "menuitem"
      || content.children.length !== 3
      || content.firstElementChild !== group
      || content.lastElementChild !== reader
      || group.nextElementSibling?.nextElementSibling !== reader
      || group.children.length !== authority.rows.length
    ) return false;

    return rows.every((row) => {
      const source = authority.rows[row.index];
      const element = authority.dom.rows[row.index];
      return (
        source?.index === row.index
        && source.value === row.value
        && source.label === row.label
        && source.description === row.description
        && source.eligible === row.eligible
        && !!element
        && element.isConnected
        && element.parentElement === group
        && group.children.item(row.index) === element
        && element.getAttribute("role") === "menuitemradio"
        && element.getAttribute("aria-checked") === String(row.value === authority.mode)
        && (element.getAttribute("aria-disabled") === "true") === !row.eligible
      );
    });
  };
  const ownsPresentation = () => cells.active === publication && factsAreCurrent() && exactDomIsCurrent();
  const eventCapability = (event: object, prove: () => boolean) => {
    if (cells.issuedEvents.has(event) || !prove()) return null;
    cells.issuedEvents.add(event);
    let claimed = false;
    return () => {
      if (claimed || !prove()) return false;
      claimed = true;
      return true;
    };
  };
  const connectedControl = (element: HTMLElement | null, expected: HTMLElement | null) => {
    const content = authority.dom.content;
    return (
      ownsPresentation()
      && !!content
      && !!element
      && element === expected
      && element.isConnected
      && content.isConnected
      && content.contains(element)
    );
  };
  const preparedClose = (): ModeSwitcherDisclosureIntent | null => {
    if (!ownsPresentation() || !authority.open) return null;
    const { trigger, content } = authority.dom;
    if (!trigger || !content) return null;
    let used = false;
    return Object.freeze({
      publication,
      open: false,
      claim: () => {
        if (
          used
          || cells.active !== publication
          || authority.dom.trigger !== trigger
          || authority.dom.content !== content
          || !trigger.isConnected
          || !content.isConnected
        ) return false;
        used = true;
        return true;
      },
    });
  };
  const publishDisclosure = (event: object, open: boolean, prove: () => boolean) => {
    const claim = eventCapability(event, prove);
    if (!claim) return;
    cells.disclosureIntent = Object.freeze({ publication, open, claim });
  };
  const scheduleFocusReturn = (target: HTMLButtonElement) => {
    const intent: ModeSwitcherFocusIntent = Object.freeze({ publication, target });
    cells.focusIntent = intent;
    queueMicrotask(() => {
      if (
        cells.focusIntent !== intent
        || !target.isConnected
        || target.ownerDocument !== document
      ) return;
      cells.focusIntent = null;
      target.focus();
    });
  };
  const onTriggerPointerDown = (event: React.PointerEvent<HTMLButtonElement>) => {
    const source = event.currentTarget;
    if (event.defaultPrevented || event.button !== 0 || event.ctrlKey) return;
    publishDisclosure(event, !authority.open, () => (
      source === authority.dom.trigger
      && source.isConnected
      && ownsPresentation()
    ));
  };
  const onTriggerKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (event.defaultPrevented || !["Enter", " ", "ArrowDown"].includes(event.key)) return;
    const source = event.currentTarget;
    const open = event.key === "ArrowDown" ? true : !authority.open;
    publishDisclosure(event, open, () => (
      source === authority.dom.trigger
      && source.isConnected
      && ownsPresentation()
    ));
  };
  const onOpenChange = (open: boolean) => {
    const intent = cells.disclosureIntent;
    if (
      intent?.publication !== publication
      || intent.open !== open
      || !intent.claim()
    ) return;
    cells.disclosureIntent = null;
    if (authority.open === open) return;
    publication.retire();
    commitOpen(Object.freeze({ visit: authority.visit, open }));
  };
  const onModeChange = (value: string) => {
    const intent = cells.selectionIntent;
    if (
      intent?.publication !== publication
      || intent.row.value !== value
      || !intent.row.eligible
      || !intent.claim()
    ) return;
    const close = preparedClose();
    if (!close) return;
    const returnTarget = authority.dom.trigger;
    if (!returnTarget) return;
    cells.selectionIntent = null;
    cells.disclosureIntent = close;
    scheduleFocusReturn(returnTarget);
    onOpenChange(false);
    authority.setMode.call(authority.session, intent.row.value);
  };
  const onReaderSelect = (event: Event) => {
    const source = event.currentTarget;
    const claim = eventCapability(event, () => connectedControl(
      source instanceof HTMLDivElement ? source : null,
      authority.dom.reader,
    ));
    if (!claim || !claim()) return;
    const close = preparedClose();
    if (!close) return;
    const returnTarget = authority.dom.trigger;
    if (!returnTarget) return;
    cells.selectionIntent = null;
    cells.disclosureIntent = close;
    scheduleFocusReturn(returnTarget);
    onOpenChange(false);
    window.open(authority.reader.url, authority.reader.target, authority.reader.features);
  };
  const onEscapeKeyDown = (event: KeyboardEvent) => {
    const target = event.target;
    const content = authority.dom.content;
    if (
      event.defaultPrevented
      || event.key !== "Escape"
      || !content
      || !(target instanceof Node)
      || event.currentTarget instanceof Element
    ) return;
    publishDisclosure(event, false, () => (
      ownsPresentation()
      && authority.dom.content === content
      && content.isConnected
      && target.isConnected
      && content.contains(target)
    ));
  };
  const onOutside = (event: CustomEvent<{ originalEvent: Event }>) => {
    const originalTarget = event.detail?.originalEvent?.target;
    const { content, trigger } = authority.dom;
    if (
      event.defaultPrevented
      || !content
      || !trigger
      || !(originalTarget instanceof Node)
      || event.target !== originalTarget
      || event.currentTarget !== originalTarget
      || content.contains(originalTarget)
      || trigger.contains(originalTarget)
    ) return;
    publishDisclosure(event, false, () => (
      ownsPresentation()
      && authority.dom.content === content
      && authority.dom.trigger === trigger
      && content.isConnected
      && trigger.isConnected
      && originalTarget.isConnected
      && !content.contains(originalTarget)
      && !trigger.contains(originalTarget)
    ));
  };
  const retire = () => {
    const wasActive = cells.active === publication;
    if (wasActive) cells.active = null;
    if (cells.disclosureIntent?.publication === publication) cells.disclosureIntent = null;
    if (cells.selectionIntent?.publication === publication) cells.selectionIntent = null;
    return wasActive;
  };
  const establish = () => {
    const previous = cells.active;
    if (previous && previous !== publication) previous.retire();
    if (!factsAreCurrent() || !exactDomIsCurrent()) return;
    const focus = cells.focusIntent;
    if (
      focus
      && (
        focus.publication.authority.visit !== authority.visit
        || authority.open
        || focus.target !== authority.dom.trigger
      )
    ) cells.focusIntent = null;
    cells.active = publication;
  };
  const rows: readonly ModeSwitcherRowPublication[] = authority.rows.map((row, index) => {
    const rowPublication: ModeSwitcherRowPublication = Object.freeze({
      ...row,
      capture: captureRows[index]!,
      onSelect: (event: Event) => {
        if (!row.eligible) return;
        const source = event.currentTarget;
        const claim = eventCapability(event, () => (
          rowPublication === rows[row.index]
          && connectedControl(
            source instanceof HTMLDivElement ? source : null,
            authority.dom.rows[row.index],
          )
        ));
        if (claim) {
          cells.selectionIntent = Object.freeze({
            publication,
            row: rowPublication,
            claim,
          });
        }
      },
    });
    return rowPublication;
  });
  const publication: ModeSwitcherPresentation = Object.freeze({
    authority,
    rows: Object.freeze(rows),
    captureTrigger,
    captureContent,
    captureGroup,
    captureReader,
    establish,
    retire,
    onTriggerPointerDown,
    onTriggerKeyDown,
    onOpenChange,
    onModeChange,
    onReaderSelect,
    onEscapeKeyDown,
    onOutside,
  });
  return publication;
}

function useModeSwitcherElement<T extends HTMLElement>(
  cells: ModeSwitcherCells,
  republish: () => void,
) {
  const [element, setElement] = useState<T | null>(null);
  const attached = useRef<T | null>(null);
  const capture = useCallback<React.RefCallback<T>>((next) => {
    if (attached.current === next) return;
    attached.current = next;
    cells.active?.retire();
    setElement(next);
    republish();
  }, [cells, republish]);
  return [element, capture] as const;
}

function ModeSwitcherOpenCommit({ presentation }: { presentation: ModeSwitcherPresentation }) {
  useLayoutEffect(() => {
    presentation.establish();
    return () => {
      presentation.retire();
    };
  }, [presentation]);
  return null;
}

export function ModeSwitcher({ session }: { session: CollabSession }) {
  const mode = useSessionValue(session, (s) => s.mode);
  const editable = session.role === "owner" || session.role === "editor";
  const [mount] = useState(() => Symbol("mode switcher"));
  const visit = useMemo<ModeSwitcherVisit>(
    () => Object.freeze({ mount, session }),
    [mount, session],
  );
  const initialState = useMemo<ModeSwitcherState>(
    () => Object.freeze({ visit, open: false }),
    [visit],
  );
  const [storedState, setStoredState] = useState<ModeSwitcherState>(initialState);
  const [cells] = useState<ModeSwitcherCells>(() => ({
    active: null,
    disclosureIntent: null,
    selectionIntent: null,
    focusIntent: null,
    issuedEvents: new WeakSet(),
  }));
  const [, setDomRevision] = useState(0);
  const republishDom = useCallback(() => setDomRevision((current) => current + 1), []);
  const [triggerElement, captureTriggerElement] = useModeSwitcherElement<HTMLButtonElement>(cells, republishDom);
  const [contentElement, captureContentElement] = useModeSwitcherElement<HTMLDivElement>(cells, republishDom);
  const [groupElement, captureGroupElement] = useModeSwitcherElement<HTMLDivElement>(cells, republishDom);
  const [editingElement, captureEditing] = useModeSwitcherElement<HTMLDivElement>(cells, republishDom);
  const [suggestingElement, captureSuggesting] = useModeSwitcherElement<HTMLDivElement>(cells, republishDom);
  const [viewingElement, captureViewing] = useModeSwitcherElement<HTMLDivElement>(cells, republishDom);
  const [readerElement, captureReaderElement] = useModeSwitcherElement<HTMLDivElement>(cells, republishDom);
  const state = storedState.visit === visit ? storedState : initialState;
  const rows: readonly ModeSwitcherRowAuthority[] = Object.freeze([
    Object.freeze({ index: 0, value: "editing", label: "Editing", description: "Edit the document directly", eligible: editable }),
    Object.freeze({ index: 1, value: "suggesting", label: "Suggesting", description: "Edits become suggestions others can accept", eligible: editable }),
    Object.freeze({ index: 2, value: "viewing", label: "Viewing", description: "Read or print the final document", eligible: true }),
  ]);
  const authority: ModeSwitcherAuthority = Object.freeze({
    visit,
    session,
    docId: session.docId,
    role: session.role,
    editable,
    mode,
    open: state.open,
    setMode: session.setMode,
    dom: Object.freeze({
      trigger: triggerElement,
      content: contentElement,
      group: groupElement,
      rows: Object.freeze([editingElement, suggestingElement, viewingElement]),
      reader: readerElement,
    }),
    reader: Object.freeze({
      url: `/p/${session.docId}`,
      target: "_blank",
      features: "noopener",
    }),
    rows,
  });
  const presentation = createModeSwitcherPresentation({
    authority,
    cells,
    commitOpen: setStoredState,
    captureTrigger: captureTriggerElement,
    captureContent: captureContentElement,
    captureGroup: captureGroupElement,
    captureRows: Object.freeze([captureEditing, captureSuggesting, captureViewing]),
    captureReader: captureReaderElement,
  });

  useLayoutEffect(() => {
    presentation.establish();
    return () => {
      presentation.retire();
    };
  }, [presentation]);
  const {
    captureTrigger,
    captureContent,
    captureGroup,
    captureReader,
    onTriggerPointerDown,
    onTriggerKeyDown,
    onOpenChange,
    onModeChange,
    onReaderSelect,
    onEscapeKeyDown,
    onOutside,
    rows: publishedRows,
  } = presentation;

  const icons: Record<EditMode, React.ReactNode> = {
    editing: <PenLine size={15} />,
    suggesting: <MessageSquarePlus size={15} />,
    viewing: <Eye size={15} />,
  };
  const labels: Record<EditMode, string> = { editing: "Editing", suggesting: "Suggesting", viewing: "Viewing" };
  return (
    <Menu open={state.open} onOpenChange={onOpenChange}>
      <MenuTrigger asChild>
        <button
          ref={captureTrigger}
          type="button"
          className={cn(
            "btn btn-sm gap-1.5 border",
            mode === "suggesting" ? "border-green-200 bg-green-50 text-green-800 dark:border-green-900 dark:bg-green-950/40 dark:text-green-300" : "border-line-2 bg-surface text-ink-2 hover:bg-surface-2",
          )}
          onPointerDown={onTriggerPointerDown}
          onKeyDown={onTriggerKeyDown}
          data-testid="mode-switcher"
        >
          {icons[mode]}
          <span>{labels[mode]}</span>
          <ChevronDown size={14} className="text-ink-4" />
        </button>
      </MenuTrigger>
      {state.open && (
        <MenuContent
          ref={captureContent}
          align="end"
          className="w-64"
          onEscapeKeyDown={onEscapeKeyDown}
          onPointerDownOutside={onOutside}
          onFocusOutside={onOutside}
        >
          <MenuRadioGroup ref={captureGroup} value={mode} onValueChange={onModeChange}>
            {publishedRows.map((row) => (
              <MenuRadioItem
                key={row.value}
                ref={row.capture}
                value={row.value}
                disabled={!row.eligible}
                description={row.description}
                onSelect={row.onSelect}
              >
                {row.label}
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
          <MenuSeparator />
          <MenuItem
            ref={captureReader}
            icon={<BookOpen size={15} />}
            onSelect={onReaderSelect}
            data-testid="mode-reader"
          >
            Open reader view
          </MenuItem>
          <ModeSwitcherOpenCommit presentation={presentation} />
        </MenuContent>
      )}
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
  /** Where "Keep an agent here" sends people without a token (defaults to /settings#tokens). */
  onCreateToken?: () => void;
  /** Bumped by the command palette's "Keep an agent here" (and the `/agent` slash item): opens the Keep-an-agent dialog. */
  keepAgentNonce?: number;
  /** Canvas mode: hide navigation, sharing, publishing, and account menus. */
  embed?: boolean;
}

/** Preview | Markdown switch shown in the header below `md`; the status-bar menu covers wider windows. */
function LayoutSegment({ layout, onLayout }: { layout: Layout; onLayout: (l: Layout) => void }) {
  const options: { value: Layout; label: string; icon: React.ReactNode }[] = [
    { value: "rich", label: "Preview", icon: <Eye size={17} /> },
    { value: "code", label: "Markdown", icon: <Code2 size={17} /> },
  ];
  return (
    <div className="inline-flex h-9 shrink-0 rounded-lg border border-line-2 bg-surface p-0.5 md:hidden" role="radiogroup" aria-label="Pane" data-testid="layout-segment">
      {options.map((o) => {
        const active = layout === o.value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={o.label}
            title={o.label}
            className={cn("inline-flex h-8 w-8 items-center justify-center rounded-md transition-colors", active ? "bg-accent-soft text-accent" : "text-ink-3 hover:text-ink")}
            onClick={() => onLayout(o.value)}
            data-testid={`layout-segment-${o.value}`}
          >
            {o.icon}
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

export function PublishStatusButton({
  sync,
  publishing,
  onPublishNow,
  onPull,
  onSync,
}: Pick<HeaderProps, "sync" | "publishing" | "onPublishNow" | "onPull" | "onSync"> & { sync: SyncStatusDto }) {
  const opensSyncDialog = sync.status === "diverged" || sync.status === "remote-unreadable";
  const label =
    sync.status === "remote-ahead"
      ? "Pull"
      : sync.status === "diverged"
        ? "Both changed"
        : sync.status === "remote-unreadable"
          ? SYNC_LABELS[sync.status]
          : sync.status === "in-sync"
            ? "Up to date"
            : "Publish";

  return (
    <button
      type="button"
      className="btn btn-primary gap-1.5 rounded-r-none pl-3 pr-3"
      disabled={publishing}
      data-testid="publish-button"
      onClick={sync.status === "remote-ahead" ? onPull : opensSyncDialog ? onSync : onPublishNow}
      title={SYNC_LABELS[sync.status]}
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
        {label}
      </span>
    </button>
  );
}

export const Header = memo(function Header(props: HeaderProps) {
  const { session, doc, compact, githubConfigured, embed = false, keepAgentNonce = 0 } = props;
  const openComments = useSessionValue(session, (s) => s.comments.list().filter((c) => !c.resolved).length);
  const linked = doc.storage !== "local";
  const canEdit = session.role === "owner" || session.role === "editor";
  // Star state and the notifications poll wait for the first sync: the socket handshake and the
  // collab-token call get the server to themselves on open (#118).
  const settled = useOpenSettled(session);
  // "Keep an agent here": one dialog, opened from the presence popover, the command palette and the slash menu.
  const [keepAgentOpen, setKeepAgentOpen] = useState(false);
  useEffect(() => {
    if (keepAgentNonce > 0) setKeepAgentOpen(true);
  }, [keepAgentNonce]);
  const keepAgentEverOpened = useEverTrue(keepAgentOpen);
  const liveTitle = useSessionValue(session, (s) => s.title || doc.title);
  const openKeepAgent = useCallback(() => setKeepAgentOpen(true), []);
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
          <PresenceStack session={session} onJump={props.onJumpToUser} onCancelRequest={props.onCancelRequest} onKeepAgent={openKeepAgent} />
        </div>
        {keepAgentEverOpened && <KeepAgentHereDialog doc={{ id: doc.id, title: liveTitle }} open={keepAgentOpen} onOpenChange={setKeepAgentOpen} onCreateToken={props.onCreateToken} />}
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
        {!embed && <Menu onOpenChange={(o) => o && props.onMoreMenuOpen?.()}>
          <MenuTrigger asChild>
            <button type="button" className="icon-btn" aria-label="More" data-testid="more-menu">
              <MoreVertical size={20} />
            </button>
          </MenuTrigger>
          <MenuContent align="end" className="w-64">
            {compact && (
              <>
                <MenuItem icon={<UserPlus size={15} />} onSelect={props.onShare} data-testid="menu-share">
                  Share…
                </MenuItem>
                <MenuItem
                  icon={linked ? <UploadCloud size={15} /> : <GitHubIcon size={15} />}
                  onSelect={linked ? props.onPublishNow : props.onPublish}
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
            <MenuItem icon={<History size={15} />} onSelect={props.onHistory} data-testid="menu-history">
              Version history
            </MenuItem>
            <MenuItem icon={<Activity size={15} />} onSelect={props.onActivity} data-testid="menu-activity">
              Activity
            </MenuItem>
            {canEdit && (
              <MenuItem icon={<Pencil size={15} />} onSelect={props.onNameVersion}>
                Name current version
              </MenuItem>
            )}
            <MenuSeparator />
            <MenuItem icon={<Download size={15} />} onSelect={() => props.onDownload("md", false)} data-testid="download-md">
              Download Markdown
            </MenuItem>
            <MenuItem icon={<FileCode2 size={15} />} onSelect={() => props.onDownload("html", false)} data-testid="download-html">
              Download HTML
            </MenuItem>
            <MenuItem icon={<FileText size={15} />} onSelect={() => props.onDownload("pdf", false)} data-testid="download-pdf">
              Download PDF
            </MenuItem>
            <MenuItem icon={<Copy size={15} />} onSelect={props.onCopyMarkdown}>
              Copy Markdown
            </MenuItem>
            <MenuItem
              icon={props.documentMutation === "duplicate" ? <Loader2 size={15} className="animate-spin" /> : <Files size={15} />}
              onSelect={props.onDuplicate}
              disabled={props.documentMutation !== null}
              aria-busy={props.documentMutation === "duplicate" || undefined}
              data-testid="menu-duplicate"
            >
              {props.documentMutation === "duplicate" ? "Making a copy…" : "Make a copy"}
            </MenuItem>
            <MenuItem icon={<BookOpen size={15} />} onSelect={() => window.open(`/p/${doc.id}`, "_blank", "noopener")} data-testid="menu-reader">
              Open reader view
            </MenuItem>
            <MenuSeparator />
            {linked && doc.githubUrl && (
              <MenuItem icon={<ExternalLink size={15} />} onSelect={() => window.open(doc.githubUrl!, "_blank", "noopener")}>
                Open on GitHub
              </MenuItem>
            )}
            {props.isOwner && (
              <MenuItem
                icon={<GitHubIcon size={15} />}
                onSelect={props.onPublish}
                disabled={!linked && !githubConfigured}
                title={!linked && !githubConfigured ? GITHUB_NOT_CONFIGURED : undefined}
                data-testid="menu-github"
              >
                {linked ? "GitHub connection…" : <GitHubEntryLabel configured={githubConfigured}>Connect to GitHub…</GitHubEntryLabel>}
              </MenuItem>
            )}
            {props.onCommandPalette && (
              <MenuItem icon={<Command size={15} />} onSelect={props.onCommandPalette} shortcut={shortcut("Mod-K")} data-testid="menu-command-palette">
                Search commands
              </MenuItem>
            )}
            <MenuItem icon={<Keyboard size={15} />} onSelect={props.onShortcuts}>
              Keyboard shortcuts
            </MenuItem>
            <MenuSeparator />
            <MenuItem icon={<ArrowLeft size={15} />} onSelect={props.onHome}>
              All documents
            </MenuItem>
            <MenuItem icon={<LogOut size={15} />} onSelect={() => void signOutSafely()}>
              Sign out
            </MenuItem>
            {props.isOwner && (
              <>
                <MenuSeparator />
                <MenuItem
                  icon={props.documentMutation === "delete" ? <Loader2 size={15} className="animate-spin" /> : <Trash2 size={15} />}
                  className="text-danger"
                  onSelect={props.onDelete}
                  disabled={props.documentMutation !== null}
                  aria-busy={props.documentMutation === "delete" || undefined}
                  data-testid="menu-delete"
                >
                  {props.documentMutation === "delete" ? "Moving to trash…" : "Move to trash"}
                </MenuItem>
              </>
            )}
          </MenuContent>
        </Menu>}
        {!embed && !compact && (
          <Menu>
            <div className="flex items-stretch max-md:hidden" data-sync-status={linked ? (props.sync?.status ?? "unknown") : undefined}>
              {linked && canEdit && props.sync ? (
                <PublishStatusButton sync={props.sync} publishing={props.publishing} onPublishNow={props.onPublishNow} onPull={props.onPull} onSync={props.onSync} />
              ) : (
                <MenuTrigger asChild>
                  <button type="button" className="btn btn-primary gap-1.5 rounded-r-none pl-4 pr-3" disabled={props.publishing} data-testid="publish-button">
                    {props.publishing ? <Loader2 size={16} className="animate-spin" /> : null}
                    Publish
                  </button>
                </MenuTrigger>
              )}
              <MenuTrigger asChild>
                <button type="button" className="btn btn-primary rounded-l-none border-l border-white/20 px-1.5" disabled={props.publishing} aria-label="Publish options" data-testid="publish-menu">
                  <ChevronDown size={16} className="opacity-80" />
                </button>
              </MenuTrigger>
            </div>
            <MenuContent align="end" className="w-72">
              {linked ? (
                <>
                  <MenuLabel>
                    {doc.storage === "gist" ? "Gist" : `${doc.repoOwner}/${doc.repoName} · ${doc.repoBranch}`}
                    {props.sync && <span className="ml-1 font-normal text-ink-3">· {SYNC_LABELS[props.sync.status]}</span>}
                  </MenuLabel>
                  <MenuItem icon={<UploadCloud size={15} />} onSelect={props.onPublishNow} disabled={!canEdit}>
                    {doc.storage === "gist" ? "Update gist" : "Commit to GitHub…"}
                  </MenuItem>
                  <MenuItem icon={<RefreshCw size={15} />} onSelect={props.onPull} disabled={!canEdit || props.sync?.status === "remote-unreadable"}>
                    Pull latest from GitHub
                  </MenuItem>
                  <MenuItem icon={<GitMerge size={15} />} onSelect={props.onSync} disabled={!canEdit} data-testid="menu-sync">
                    Sync…
                  </MenuItem>
                  {doc.githubUrl && (
                    <MenuItem icon={<ExternalLink size={15} />} onSelect={() => window.open(doc.githubUrl!, "_blank", "noopener")}>
                      Open on GitHub
                    </MenuItem>
                  )}
                  {props.isOwner && (
                    <>
                      <MenuSeparator />
                      <MenuItem icon={<Link2 size={15} />} onSelect={props.onPublish}>
                        Change connection…
                      </MenuItem>
                    </>
                  )}
                </>
              ) : (
                <>
                  <MenuLabel>Publish to GitHub</MenuLabel>
                  <MenuItem
                    icon={<GitHubIcon size={15} />}
                    onSelect={props.onPublish}
                    disabled={!props.isOwner || !githubConfigured}
                    title={!githubConfigured ? GITHUB_NOT_CONFIGURED : undefined}
                    data-testid="menu-publish-github"
                  >
                    <GitHubEntryLabel configured={githubConfigured}>Gist or repository…</GitHubEntryLabel>
                  </MenuItem>
                  <MenuSeparator />
                  <MenuItem icon={<Download size={15} />} onSelect={() => props.onDownload("md", false)}>
                    Download Markdown
                  </MenuItem>
                  <MenuItem icon={<Share2 size={15} />} onSelect={props.onShare}>
                    Share link…
                  </MenuItem>
                </>
              )}
            </MenuContent>
          </Menu>
        )}
      </div>
    </header>
  );
});
