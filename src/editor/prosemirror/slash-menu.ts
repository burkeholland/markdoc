import { Plugin, PluginKey, type Command, type EditorState, type Transaction } from "prosemirror-state";
import { Mapping, ReplaceStep } from "prosemirror-transform";
import type { EditorView } from "prosemirror-view";
import { schema } from "../markdown/schema";
import { isEditable } from "./editable";

export interface SlashState {
  /** Position of the `/` character. */
  from: number;
  /** End of the typed query (the caret). */
  to: number;
  /** Text typed after the `/`. */
  query: string;
  /** Viewport coordinates of the `/`, for positioning the menu. */
  coords: { left: number; top: number; bottom: number };
}

export type SlashKey = "ArrowUp" | "ArrowDown" | "Home" | "End" | "Enter" | "Tab" | "Escape";

export interface SlashKeyAction {
  readonly identity: symbol;
  readonly publication: SlashKeyPublication;
  readonly key: SlashKey;
  readonly isCurrent: () => boolean;
  readonly commit: () => void;
  readonly cancel: () => void;
}

export interface SlashKeyPublication {
  readonly identity: symbol;
  readonly view: EditorView;
  readonly editorState: EditorState;
  readonly pluginState: Readonly<{ from: number; to: number; query: string }>;
  readonly state: SlashState;
  readonly key: SlashKey;
  readonly event: KeyboardEvent;
  readonly ownerDocument: Document;
  readonly ownerWindow: Window & typeof globalThis;
  readonly editorDom: HTMLElement;
  readonly activeElement: Element;
  readonly path: readonly EventTarget[];
  readonly type: string;
  readonly target: EventTarget;
  readonly currentTarget: EventTarget;
  readonly eventPhase: number;
  readonly bubbles: boolean;
  readonly cancelable: boolean;
  readonly defaultPrevented: false;
  readonly cancelBubble: false;
  readonly composed: boolean;
  readonly timeStamp: number;
  readonly code: string;
  readonly location: number;
  readonly altKey: false;
  readonly ctrlKey: false;
  readonly metaKey: false;
  readonly shiftKey: false;
  readonly repeat: false;
  readonly isComposing: false;
  readonly nativeView: Window & typeof globalThis;
  readonly claim: (action: SlashKeyAction) => boolean;
}

export interface SlashMenuHandlers {
  /** Called whenever the menu should open, move, change its query or close. */
  onState: (state: SlashState | null) => void;
  /** Exact native key publications while the menu is open. */
  onKey?: (publication: SlashKeyPublication) => boolean;
}

interface Tracked {
  from: number;
  to: number;
  query: string;
}

type NativeGetter = () => unknown;
type NativeMethod = (...args: never[]) => unknown;

interface CapturedDescriptor {
  readonly owner: object;
  readonly property: PropertyKey;
  readonly descriptor: Readonly<PropertyDescriptor>;
}

interface CapturedGetter extends CapturedDescriptor {
  readonly getter: NativeGetter;
}

interface CapturedMethod extends CapturedDescriptor {
  readonly method: NativeMethod;
}

interface TrustedAuthority {
  readonly descriptor: Readonly<PropertyDescriptor>;
  readonly getter: NativeGetter;
  readonly read: (event: object) => boolean;
  readonly matches: (event: object) => boolean;
  readonly isCurrent: () => boolean;
}

interface KeyboardAuthority {
  readonly ownerDocument: Document;
  readonly ownerWindow: Window & typeof globalThis;
  readonly keyboardPrototype: object;
  readonly getOwnPropertyDescriptor: typeof Object.getOwnPropertyDescriptor;
  readonly getPrototypeOf: typeof Object.getPrototypeOf;
  readonly apply: typeof Reflect.apply;
  readonly trusted: TrustedAuthority;
  readonly event: Readonly<{
    type: NativeGetter;
    target: NativeGetter;
    currentTarget: NativeGetter;
    eventPhase: NativeGetter;
    bubbles: NativeGetter;
    cancelable: NativeGetter;
    defaultPrevented: NativeGetter;
    cancelBubble: NativeGetter;
    composed: NativeGetter;
    timeStamp: NativeGetter;
    composedPath: NativeMethod;
    preventDefault: NativeMethod;
    stopPropagation: NativeMethod;
    stopImmediatePropagation: NativeMethod;
  }>;
  readonly keyboard: Readonly<{
    key: NativeGetter;
    code: NativeGetter;
    location: NativeGetter;
    altKey: NativeGetter;
    ctrlKey: NativeGetter;
    metaKey: NativeGetter;
    shiftKey: NativeGetter;
    repeat: NativeGetter;
    isComposing: NativeGetter;
  }>;
  readonly ui: Readonly<{
    detail: NativeGetter;
    view: NativeGetter;
  }>;
  readonly document: Readonly<{ activeElement: NativeGetter }>;
  readonly historyIsClean: () => boolean;
}

interface NativeKeyFacts {
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
  readonly path: readonly EventTarget[];
  readonly key: string;
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
  readonly isTrusted: boolean;
}

interface DomPlacement {
  readonly node: Node;
  readonly parent: Node;
  readonly previousSibling: Node | null;
  readonly nextSibling: Node | null;
  readonly exactSiblings: boolean;
}

interface DomHistory {
  readonly isClean: () => boolean;
  readonly release: () => void;
}

interface PluginStatePublication {
  readonly view: EditorView;
  readonly editorState: EditorState;
  readonly tracked: Tracked;
  readonly state: SlashState;
  readonly editorDom: HTMLElement;
  readonly ownerDocument: Document;
  readonly ownerWindow: Window & typeof globalThis;
  readonly authority: KeyboardAuthority | null;
  readonly domHistory: DomHistory | null;
}

interface PluginRuntime {
  readonly view: EditorView;
  current: PluginStatePublication | null;
  dispatching: boolean;
  destroyed: boolean;
  readonly attemptedEvents: WeakSet<Event>;
}

interface SlashKeyRecord {
  readonly runtime: PluginRuntime;
  readonly statePublication: PluginStatePublication;
  action: SlashKeyAction | null;
  accepted: boolean;
  settled: boolean;
}

const slashKeyPublications = new WeakSet<object>();
const slashKeyRecords = new WeakMap<SlashKeyPublication, SlashKeyRecord>();

export function isSlashKeyPublication(value: unknown): value is SlashKeyPublication {
  return typeof value === "object" && value !== null && slashKeyPublications.has(value) && Object.isFrozen(value);
}

function descriptorsMatch(current: PropertyDescriptor | undefined, expected: Readonly<PropertyDescriptor>): boolean {
  if (!current) return false;
  return (
    current.configurable === expected.configurable &&
    current.enumerable === expected.enumerable &&
    current.get === expected.get &&
    current.set === expected.set &&
    current.value === expected.value &&
    current.writable === expected.writable
  );
}

function captureDescriptor(
  owner: object,
  property: PropertyKey,
  getOwnPropertyDescriptor: typeof Object.getOwnPropertyDescriptor,
): CapturedDescriptor | null {
  const descriptor = getOwnPropertyDescriptor(owner, property);
  if (!descriptor) return null;
  return Object.freeze({ owner, property, descriptor: Object.freeze({ ...descriptor }) });
}

function captureGetter(
  owner: object,
  property: PropertyKey,
  getOwnPropertyDescriptor: typeof Object.getOwnPropertyDescriptor,
): CapturedGetter | null {
  const capture = captureDescriptor(owner, property, getOwnPropertyDescriptor);
  const getter = capture?.descriptor.get;
  return capture && typeof getter === "function" && !("value" in capture.descriptor)
    ? Object.freeze({ ...capture, getter: getter as NativeGetter })
    : null;
}

function captureMethod(
  owner: object,
  property: PropertyKey,
  getOwnPropertyDescriptor: typeof Object.getOwnPropertyDescriptor,
): CapturedMethod | null {
  const capture = captureDescriptor(owner, property, getOwnPropertyDescriptor);
  const method = capture?.descriptor.value;
  return capture && typeof method === "function"
    ? Object.freeze({ ...capture, method: method as NativeMethod })
    : null;
}

function captureTrustedAuthority(
  ownerWindow: Window & typeof globalThis,
  getOwnPropertyDescriptor: typeof Object.getOwnPropertyDescriptor,
  getPrototypeOf: typeof Object.getPrototypeOf,
  apply: typeof Reflect.apply,
): TrustedAuthority | null {
  let probe: KeyboardEvent;
  try {
    probe = new ownerWindow.KeyboardEvent("slash-menu-keyboard-probe");
  } catch {
    return null;
  }
  const descriptor = getOwnPropertyDescriptor(probe, "isTrusted");
  if (
    getPrototypeOf(probe) !== ownerWindow.KeyboardEvent.prototype ||
    !descriptor ||
    descriptor.configurable !== false ||
    descriptor.enumerable !== true ||
    typeof descriptor.get !== "function" ||
    descriptor.set !== undefined ||
    "value" in descriptor ||
    "writable" in descriptor
  ) {
    return null;
  }
  const expected = Object.freeze({ ...descriptor });
  const getter = descriptor.get as NativeGetter;
  const matches = (event: object) => descriptorsMatch(getOwnPropertyDescriptor(event, "isTrusted"), expected);
  const read = (event: object) => apply(getter, event, []) as boolean;
  try {
    if (read(probe) !== false) return null;
  } catch {
    return null;
  }
  return Object.freeze({
    descriptor: expected,
    getter,
    read,
    matches,
    isCurrent: () => matches(probe),
  });
}

function captureKeyboardAuthority(
  ownerDocument: Document,
  ownerWindow: Window & typeof globalThis,
): KeyboardAuthority | null {
  const getOwnPropertyDescriptor = ownerWindow.Object.getOwnPropertyDescriptor;
  const getPrototypeOf = ownerWindow.Object.getPrototypeOf;
  const apply = ownerWindow.Reflect.apply;
  const eventPrototype = ownerWindow.Event.prototype;
  const keyboardPrototype = ownerWindow.KeyboardEvent.prototype;
  const uiPrototype = ownerWindow.UIEvent.prototype;
  const documentPrototype = ownerWindow.Document.prototype;
  if (
    typeof getOwnPropertyDescriptor !== "function" ||
    typeof getPrototypeOf !== "function" ||
    typeof apply !== "function"
  ) {
    return null;
  }
  const trusted = captureTrustedAuthority(ownerWindow, getOwnPropertyDescriptor, getPrototypeOf, apply);
  const type = captureGetter(eventPrototype, "type", getOwnPropertyDescriptor);
  const target = captureGetter(eventPrototype, "target", getOwnPropertyDescriptor);
  const currentTarget = captureGetter(eventPrototype, "currentTarget", getOwnPropertyDescriptor);
  const eventPhase = captureGetter(eventPrototype, "eventPhase", getOwnPropertyDescriptor);
  const bubbles = captureGetter(eventPrototype, "bubbles", getOwnPropertyDescriptor);
  const cancelable = captureGetter(eventPrototype, "cancelable", getOwnPropertyDescriptor);
  const defaultPrevented = captureGetter(eventPrototype, "defaultPrevented", getOwnPropertyDescriptor);
  const cancelBubble = captureGetter(eventPrototype, "cancelBubble", getOwnPropertyDescriptor);
  const composed = captureGetter(eventPrototype, "composed", getOwnPropertyDescriptor);
  const timeStamp = captureGetter(eventPrototype, "timeStamp", getOwnPropertyDescriptor);
  const composedPath = captureMethod(eventPrototype, "composedPath", getOwnPropertyDescriptor);
  const preventDefault = captureMethod(eventPrototype, "preventDefault", getOwnPropertyDescriptor);
  const stopPropagation = captureMethod(eventPrototype, "stopPropagation", getOwnPropertyDescriptor);
  const stopImmediatePropagation = captureMethod(eventPrototype, "stopImmediatePropagation", getOwnPropertyDescriptor);
  const key = captureGetter(keyboardPrototype, "key", getOwnPropertyDescriptor);
  const code = captureGetter(keyboardPrototype, "code", getOwnPropertyDescriptor);
  const location = captureGetter(keyboardPrototype, "location", getOwnPropertyDescriptor);
  const altKey = captureGetter(keyboardPrototype, "altKey", getOwnPropertyDescriptor);
  const ctrlKey = captureGetter(keyboardPrototype, "ctrlKey", getOwnPropertyDescriptor);
  const metaKey = captureGetter(keyboardPrototype, "metaKey", getOwnPropertyDescriptor);
  const shiftKey = captureGetter(keyboardPrototype, "shiftKey", getOwnPropertyDescriptor);
  const repeat = captureGetter(keyboardPrototype, "repeat", getOwnPropertyDescriptor);
  const isComposing = captureGetter(keyboardPrototype, "isComposing", getOwnPropertyDescriptor);
  const detail = captureGetter(uiPrototype, "detail", getOwnPropertyDescriptor);
  const nativeView = captureGetter(uiPrototype, "view", getOwnPropertyDescriptor);
  const activeElement = captureGetter(documentPrototype, "activeElement", getOwnPropertyDescriptor);
  const captures = [
    type,
    target,
    currentTarget,
    eventPhase,
    bubbles,
    cancelable,
    defaultPrevented,
    cancelBubble,
    composed,
    timeStamp,
    composedPath,
    preventDefault,
    stopPropagation,
    stopImmediatePropagation,
    key,
    code,
    location,
    altKey,
    ctrlKey,
    metaKey,
    shiftKey,
    repeat,
    isComposing,
    detail,
    nativeView,
    activeElement,
  ];
  if (
    !trusted ||
    captures.some((capture) => capture === null) ||
    getPrototypeOf(keyboardPrototype) !== uiPrototype ||
    getPrototypeOf(uiPrototype) !== eventPrototype
  ) {
    return null;
  }
  const descriptors = Object.freeze(captures.map((capture) => capture!));
  let historyIsClean = true;
  const checkHistory = () => {
    if (!historyIsClean) return false;
    historyIsClean = Boolean(
      ownerDocument.defaultView === ownerWindow &&
      ownerWindow.Object.getOwnPropertyDescriptor === getOwnPropertyDescriptor &&
      ownerWindow.Object.getPrototypeOf === getPrototypeOf &&
      ownerWindow.Reflect.apply === apply &&
      ownerWindow.Event.prototype === eventPrototype &&
      ownerWindow.KeyboardEvent.prototype === keyboardPrototype &&
      ownerWindow.UIEvent.prototype === uiPrototype &&
      ownerWindow.Document.prototype === documentPrototype &&
      getPrototypeOf(keyboardPrototype) === uiPrototype &&
      getPrototypeOf(uiPrototype) === eventPrototype &&
      trusted.isCurrent() &&
      descriptors.every((capture) =>
        descriptorsMatch(getOwnPropertyDescriptor(capture.owner, capture.property), capture.descriptor),
      ),
    );
    return historyIsClean;
  };
  return Object.freeze({
    ownerDocument,
    ownerWindow,
    keyboardPrototype,
    getOwnPropertyDescriptor,
    getPrototypeOf,
    apply,
    trusted,
    event: Object.freeze({
      type: type!.getter,
      target: target!.getter,
      currentTarget: currentTarget!.getter,
      eventPhase: eventPhase!.getter,
      bubbles: bubbles!.getter,
      cancelable: cancelable!.getter,
      defaultPrevented: defaultPrevented!.getter,
      cancelBubble: cancelBubble!.getter,
      composed: composed!.getter,
      timeStamp: timeStamp!.getter,
      composedPath: composedPath!.method,
      preventDefault: preventDefault!.method,
      stopPropagation: stopPropagation!.method,
      stopImmediatePropagation: stopImmediatePropagation!.method,
    }),
    keyboard: Object.freeze({
      key: key!.getter,
      code: code!.getter,
      location: location!.getter,
      altKey: altKey!.getter,
      ctrlKey: ctrlKey!.getter,
      metaKey: metaKey!.getter,
      shiftKey: shiftKey!.getter,
      repeat: repeat!.getter,
      isComposing: isComposing!.getter,
    }),
    ui: Object.freeze({ detail: detail!.getter, view: nativeView!.getter }),
    document: Object.freeze({ activeElement: activeElement!.getter }),
    historyIsClean: checkHistory,
  });
}

function nativeValue<T>(authority: KeyboardAuthority, getter: NativeGetter, value: object): T {
  return authority.apply(getter, value, []) as T;
}

function readNativeKey(authority: KeyboardAuthority, event: KeyboardEvent): NativeKeyFacts | null {
  if (
    !authority.historyIsClean() ||
    authority.getPrototypeOf(event) !== authority.keyboardPrototype ||
    !authority.trusted.matches(event)
  ) {
    return null;
  }
  try {
    return Object.freeze({
      type: nativeValue<string>(authority, authority.event.type, event),
      target: nativeValue<EventTarget | null>(authority, authority.event.target, event),
      currentTarget: nativeValue<EventTarget | null>(authority, authority.event.currentTarget, event),
      eventPhase: nativeValue<number>(authority, authority.event.eventPhase, event),
      bubbles: nativeValue<boolean>(authority, authority.event.bubbles, event),
      cancelable: nativeValue<boolean>(authority, authority.event.cancelable, event),
      defaultPrevented: nativeValue<boolean>(authority, authority.event.defaultPrevented, event),
      cancelBubble: nativeValue<boolean>(authority, authority.event.cancelBubble, event),
      composed: nativeValue<boolean>(authority, authority.event.composed, event),
      timeStamp: nativeValue<number>(authority, authority.event.timeStamp, event),
      path: Object.freeze([
        ...(authority.apply(authority.event.composedPath, event, []) as EventTarget[]),
      ]),
      key: nativeValue<string>(authority, authority.keyboard.key, event),
      code: nativeValue<string>(authority, authority.keyboard.code, event),
      location: nativeValue<number>(authority, authority.keyboard.location, event),
      altKey: nativeValue<boolean>(authority, authority.keyboard.altKey, event),
      ctrlKey: nativeValue<boolean>(authority, authority.keyboard.ctrlKey, event),
      metaKey: nativeValue<boolean>(authority, authority.keyboard.metaKey, event),
      shiftKey: nativeValue<boolean>(authority, authority.keyboard.shiftKey, event),
      repeat: nativeValue<boolean>(authority, authority.keyboard.repeat, event),
      isComposing: nativeValue<boolean>(authority, authority.keyboard.isComposing, event),
      detail: nativeValue<number>(authority, authority.ui.detail, event),
      view: nativeValue<Window | null>(authority, authority.ui.view, event),
      isTrusted: authority.trusted.read(event),
    });
  } catch {
    return null;
  }
}

function capturePlacement(node: Node, exactRootSiblings: boolean): readonly DomPlacement[] | null {
  if (!node.isConnected) return null;
  const placements: DomPlacement[] = [];
  let current: Node = node;
  while (current !== node.ownerDocument) {
    const parent = current.parentNode;
    if (!parent) return null;
    placements.push(
      Object.freeze({
        node: current,
        parent,
        previousSibling: current.previousSibling,
        nextSibling: current.nextSibling,
        exactSiblings: current === node && exactRootSiblings,
      }),
    );
    current = parent;
  }
  return Object.freeze(placements);
}

function placementIsCurrent(placements: readonly DomPlacement[]): boolean {
  return placements.every(
    (placement) =>
      placement.node.parentNode === placement.parent &&
      (!placement.exactSiblings ||
        (placement.node.previousSibling === placement.previousSibling &&
          placement.node.nextSibling === placement.nextSibling)),
  );
}

function placementRecordChanged(record: MutationRecord, placement: DomPlacement): boolean {
  if (record.type !== "childList" || record.target !== placement.parent) return false;
  if (
    placement.exactSiblings &&
    (record.previousSibling === placement.node || record.nextSibling === placement.node)
  ) {
    return true;
  }
  return [...record.addedNodes, ...record.removedNodes].some((node) => {
    let current: Node | null = placement.node;
    while (current) {
      if (current === node) return true;
      current = current.parentNode;
    }
    return false;
  });
}

function createDomHistory(root: HTMLElement): DomHistory | null {
  const ownerWindow = root.ownerDocument.defaultView;
  const placements = capturePlacement(root, true);
  const MutationObserverConstructor = ownerWindow?.MutationObserver;
  if (!ownerWindow || !placements || typeof MutationObserverConstructor !== "function") return null;
  const mutationPrototype = MutationObserverConstructor.prototype;
  const nodePrototype = ownerWindow.Node.prototype;
  const observe = mutationPrototype.observe;
  const takeRecords = mutationPrototype.takeRecords;
  const disconnect = mutationPrototype.disconnect;
  const contains = nodePrototype.contains;
  if (
    typeof observe !== "function" ||
    typeof takeRecords !== "function" ||
    typeof disconnect !== "function" ||
    typeof contains !== "function"
  ) {
    return null;
  }
  let changed = false;
  let released = false;
  const recordChanges = (records: readonly MutationRecord[]) => {
    if (changed) return;
    changed = records.some(
      (record) =>
        record.target === root ||
        ownerWindow.Reflect.apply(contains, root, [record.target]) ||
        placements.some((placement) => placementRecordChanged(record, placement)),
    );
  };
  const observer = new MutationObserverConstructor(recordChanges);
  observer.observe(root, {
    attributeOldValue: true,
    attributes: true,
    characterData: true,
    childList: true,
    subtree: true,
  });
  for (const placement of placements) observer.observe(placement.parent, { childList: true });
  return Object.freeze({
    isClean: () => {
      if (released || changed) return false;
      if (
        root.ownerDocument.defaultView !== ownerWindow ||
        ownerWindow.MutationObserver !== MutationObserverConstructor ||
        MutationObserverConstructor.prototype !== mutationPrototype ||
        ownerWindow.Node.prototype !== nodePrototype ||
        mutationPrototype.observe !== observe ||
        mutationPrototype.takeRecords !== takeRecords ||
        mutationPrototype.disconnect !== disconnect ||
        nodePrototype.contains !== contains
      ) {
        changed = true;
        return false;
      }
      recordChanges(observer.takeRecords());
      if (!root.isConnected || !placementIsCurrent(placements)) changed = true;
      return !changed;
    },
    release: () => {
      if (released) return;
      recordChanges(observer.takeRecords());
      observer.disconnect();
      released = true;
    },
  });
}

function eventPathMatches(
  path: readonly EventTarget[],
  editorDom: HTMLElement,
  ownerDocument: Document,
  nativeView: Window,
): boolean {
  const expected: EventTarget[] = [];
  let current: Node | null = editorDom;
  while (current) {
    expected.push(current);
    if (current === ownerDocument) break;
    current = current.parentNode;
  }
  return (
    expected.at(-1) === ownerDocument &&
    path.length === expected.length + 1 &&
    expected.every((entry, index) => path[index] === entry) &&
    path.at(-1) === nativeView
  );
}

function eventViewMatchesOwnerRealm(
  nativeView: Window | null,
  ownerDocument: Document,
  ownerWindow: Window & typeof globalThis,
): nativeView is Window & typeof globalThis {
  if (!nativeView) return false;
  const eventWindow = nativeView as Window & typeof globalThis;
  try {
    return (
      eventWindow.document === ownerDocument &&
      eventWindow.Event === ownerWindow.Event &&
      eventWindow.UIEvent === ownerWindow.UIEvent &&
      eventWindow.KeyboardEvent === ownerWindow.KeyboardEvent &&
      eventWindow.Document === ownerWindow.Document &&
      eventWindow.MutationObserver === ownerWindow.MutationObserver
    );
  } catch {
    return false;
  }
}

function isHandledSlashKey(key: string): key is SlashKey {
  return (
    key === "ArrowUp" ||
    key === "ArrowDown" ||
    key === "Home" ||
    key === "End" ||
    key === "Enter" ||
    key === "Tab" ||
    key === "Escape"
  );
}

export const slashMenuKey = new PluginKey<Tracked | null>("slashMenu");

const QUERY = /^[a-z0-9 -]*$/i;

/** True when `tr` is a single-character insertion of `/` typed by the local user. */
function typedSlash(tr: Transaction): boolean {
  if (tr.steps.length !== 1 || tr.getMeta("addToHistory") === false || tr.getMeta("paste")) return false;
  const step = tr.steps[0];
  if (!(step instanceof ReplaceStep) || step.from !== step.to) return false;
  const node = step.slice.content.firstChild;
  return step.slice.content.childCount === 1 && !!node && node.isText && node.text === "/";
}

/** Whether a `/` typed at `pos` (so the caret is at pos + 1) should open the menu. */
function slashOpensAt(state: EditorState, pos: number): boolean {
  const $pos = state.doc.resolve(pos);
  const parent = $pos.parent;
  if (!parent.isTextblock || parent.type === schema.nodes.code_block) return false;
  if ($pos.parentOffset === 0) return true;
  const before = parent.textBetween($pos.parentOffset - 1, $pos.parentOffset, "\0", "\0");
  return /\s/.test(before);
}

function track(state: EditorState, from: number): Tracked | null {
  const { selection } = state;
  if (!selection.empty) return null;
  const $from = state.doc.resolve(Math.min(from, state.doc.content.size));
  if (!$from.parent.isTextblock || $from.parent.type === schema.nodes.code_block) return null;
  const head = selection.head;
  if (head <= from || state.doc.resolve(head).parent !== $from.parent) return null;
  const text = state.doc.textBetween(from, head, "\0", "\0");
  if (text[0] !== "/") return null;
  const query = text.slice(1);
  if (!QUERY.test(query) || /\s\s$/.test(query) || query.length > 40) return null;
  return { from, to: head, query };
}

export const closeSlashMenu = (view: EditorView) => {
  if (!slashMenuKey.getState(view.state)) return;
  view.dispatch(view.state.tr.setMeta(slashMenuKey, { close: true }));
};

/**
 * Transaction that removes the tracked `/query` and closes the menu, or null
 * when the menu is not open.
 */
function deleteQueryTransaction(view: EditorView): Transaction | null {
  const tracked = slashMenuKey.getState(view.state);
  if (!tracked) return null;
  return view.state.tr.delete(tracked.from, tracked.to).setMeta(slashMenuKey, { close: true });
}

/**
 * The part of the session's Y.UndoManager the menu needs. Capturing is
 * stopped around the application so the typed `/query` (before) and whatever
 * the user types next (after) stay separate undo steps instead of being merged
 * into the menu's edit by the undo manager's capture timeout.
 */
export interface UndoBoundary {
  stopCapturing(): void;
}

/**
 * Removes the `/query` and runs `command` in the SAME ProseMirror transaction.
 * The command sees the document without the query (a derived state), and its
 * steps are appended to the deletion, so the binding writes one diff to the
 * shared text and one undo reverts the whole choice regardless of timing.
 *
 * Returns what the command returned; the query is removed either way.
 */
export function applySlashCommand(view: EditorView, command: Command, undo?: UndoBoundary): boolean {
  undo?.stopCapturing();
  try {
    const tr = deleteQueryTransaction(view);
    if (!tr) return command(view.state, view.dispatch, view);
    // Plugins may append normalizing transactions to the deletion (tables);
    // fold those in so the command's steps apply to the document it was given.
    const { state: derived, transactions } = view.state.applyTransaction(tr);
    for (const appended of transactions.slice(1)) for (const step of appended.steps) tr.step(step);
    const ok = command(
      derived,
      (next) => {
        for (const step of next.steps) tr.step(step);
        tr.setSelection(next.selection.map(tr.doc, new Mapping()));
        if (next.storedMarksSet) tr.setStoredMarks(next.storedMarks);
        if (next.scrolledIntoView) tr.scrollIntoView();
      },
      view,
    );
    view.dispatch(tr);
    return ok;
  } finally {
    undo?.stopCapturing();
  }
}

/**
 * Removes the `/query` text and then runs `action`, for items that do not edit
 * the document themselves (dialogs, comments). Editing items should use
 * {@link applySlashCommand} so the edit is a single transaction.
 */
export function applySlashItem(view: EditorView, action: () => void, undo?: UndoBoundary) {
  undo?.stopCapturing();
  try {
    const tr = deleteQueryTransaction(view);
    if (tr) view.dispatch(tr);
    action();
  } finally {
    undo?.stopCapturing();
  }
}

function pluginStatePublicationIsCurrent(
  runtime: PluginRuntime,
  publication: PluginStatePublication,
  handlers: SlashMenuHandlers,
  onState: SlashMenuHandlers["onState"],
  onKey: SlashMenuHandlers["onKey"],
): boolean {
  const { view, tracked, state, editorDom, ownerDocument, ownerWindow } = publication;
  return (
    !runtime.destroyed &&
    runtime.current === publication &&
    runtime.view === view &&
    !view.isDestroyed &&
    view.dom === editorDom &&
    editorDom.isConnected &&
    editorDom.ownerDocument === ownerDocument &&
    ownerDocument.defaultView === ownerWindow &&
    view.state === publication.editorState &&
    slashMenuKey.getState(view.state) === tracked &&
    tracked.from === state.from &&
    tracked.to === state.to &&
    tracked.query === state.query &&
    isEditable(view.state) &&
    !view.composing &&
    handlers.onState === onState &&
    handlers.onKey === onKey &&
    publication.authority?.historyIsClean() === true &&
    publication.domHistory?.isClean() === true
  );
}

function nativeKeyStillMatches(
  publication: SlashKeyPublication,
  authority: KeyboardAuthority,
  facts: NativeKeyFacts,
  settled: boolean,
): boolean {
  return (
    facts.type === publication.type &&
    facts.target === publication.target &&
    facts.currentTarget === (settled ? null : publication.currentTarget) &&
    facts.eventPhase === (settled ? publication.ownerWindow.Event.NONE : publication.eventPhase) &&
    facts.bubbles === publication.bubbles &&
    facts.cancelable === publication.cancelable &&
    facts.defaultPrevented === settled &&
    facts.cancelBubble === publication.cancelBubble &&
    facts.composed === publication.composed &&
    facts.timeStamp === publication.timeStamp &&
    facts.key === publication.key &&
    facts.code === publication.code &&
    facts.location === publication.location &&
    facts.altKey === publication.altKey &&
    facts.ctrlKey === publication.ctrlKey &&
    facts.metaKey === publication.metaKey &&
    facts.shiftKey === publication.shiftKey &&
    facts.repeat === publication.repeat &&
    facts.isComposing === publication.isComposing &&
    facts.view === publication.nativeView &&
    facts.isTrusted &&
    authority.getPrototypeOf(publication.event) === authority.keyboardPrototype &&
    authority.trusted.matches(publication.event)
  );
}

function createKeyPublication(
  runtime: PluginRuntime,
  statePublication: PluginStatePublication,
  event: KeyboardEvent,
): SlashKeyPublication | null {
  const authority = statePublication.authority;
  if (
    !authority ||
    runtime.dispatching ||
    runtime.attemptedEvents.has(event) ||
    !pluginStatePublicationIsCurrent(
      runtime,
      statePublication,
      statePublicationHandlers.get(statePublication)!.handlers,
      statePublicationHandlers.get(statePublication)!.onState,
      statePublicationHandlers.get(statePublication)!.onKey,
    )
  ) {
    return null;
  }
  const facts = readNativeKey(authority, event);
  const activeElement = (() => {
    try {
      return nativeValue<Element | null>(authority, authority.document.activeElement, authority.ownerDocument);
    } catch {
      return null;
    }
  })();
  if (
    !facts ||
    !isHandledSlashKey(facts.key) ||
    facts.type !== "keydown" ||
    facts.target !== statePublication.editorDom ||
    facts.currentTarget !== statePublication.editorDom ||
    facts.eventPhase !== authority.ownerWindow.Event.AT_TARGET ||
    !facts.bubbles ||
    !facts.cancelable ||
    facts.defaultPrevented ||
    facts.cancelBubble ||
    facts.altKey ||
    facts.ctrlKey ||
    facts.metaKey ||
    facts.shiftKey ||
    facts.repeat ||
    facts.isComposing ||
    !eventViewMatchesOwnerRealm(facts.view, authority.ownerDocument, authority.ownerWindow) ||
    !facts.isTrusted ||
    activeElement !== statePublication.editorDom ||
    !eventPathMatches(
      facts.path,
      statePublication.editorDom,
      statePublication.ownerDocument,
      facts.view,
    )
  ) {
    return null;
  }

  const publication: SlashKeyPublication = Object.freeze({
    identity: Symbol("slash-key-publication"),
    view: statePublication.view,
    editorState: statePublication.editorState,
    pluginState: Object.freeze({
      from: statePublication.tracked.from,
      to: statePublication.tracked.to,
      query: statePublication.tracked.query,
    }),
    state: statePublication.state,
    key: facts.key,
    event,
    ownerDocument: statePublication.ownerDocument,
    ownerWindow: statePublication.ownerWindow,
    editorDom: statePublication.editorDom,
    activeElement,
    path: facts.path,
    type: facts.type,
    target: facts.target,
    currentTarget: facts.currentTarget,
    eventPhase: facts.eventPhase,
    bubbles: facts.bubbles,
    cancelable: facts.cancelable,
    defaultPrevented: false,
    cancelBubble: false,
    composed: facts.composed,
    timeStamp: facts.timeStamp,
    code: facts.code,
    location: facts.location,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    repeat: false,
    isComposing: false,
    nativeView: facts.view,
    claim: (action: SlashKeyAction) => {
      const record = slashKeyRecords.get(publication);
      if (
        !record ||
        record.action ||
        record.accepted ||
        record.settled ||
        !Object.isFrozen(action) ||
        action.publication !== publication ||
        action.key !== publication.key ||
        typeof action.identity !== "symbol" ||
        typeof action.isCurrent !== "function" ||
        typeof action.commit !== "function" ||
        typeof action.cancel !== "function"
      ) {
        return false;
      }
      record.action = action;
      return true;
    },
  });
  slashKeyPublications.add(publication);
  slashKeyRecords.set(publication, {
    runtime,
    statePublication,
    action: null,
    accepted: false,
    settled: false,
  });
  return publication;
}

const statePublicationHandlers = new WeakMap<
  PluginStatePublication,
  {
    readonly handlers: SlashMenuHandlers;
    readonly onState: SlashMenuHandlers["onState"];
    readonly onKey: SlashMenuHandlers["onKey"];
  }
>();

function settleKeyPublication(publication: SlashKeyPublication): void {
  const record = slashKeyRecords.get(publication);
  if (!record || !record.accepted || record.settled) return;
  record.settled = true;
  const { runtime, statePublication, action } = record;
  const authority = statePublication.authority;
  const handlerFacts = statePublicationHandlers.get(statePublication);
  const facts = authority ? readNativeKey(authority, publication.event) : null;
  const activeElement = (() => {
    if (!authority) return null;
    try {
      return nativeValue<Element | null>(authority, authority.document.activeElement, authority.ownerDocument);
    } catch {
      return null;
    }
  })();
  if (
    !authority ||
    !handlerFacts ||
    !action ||
    !pluginStatePublicationIsCurrent(
      runtime,
      statePublication,
      handlerFacts.handlers,
      handlerFacts.onState,
      handlerFacts.onKey,
    ) ||
    !facts ||
    !nativeKeyStillMatches(publication, authority, facts, true) ||
    activeElement !== publication.activeElement ||
    activeElement !== publication.editorDom ||
    !action.isCurrent()
  ) {
    action?.cancel();
    return;
  }
  action.commit();
}

/**
 * Notion-style `/` menu. Typing `/` at the start of a textblock or after
 * whitespace opens the menu; the text after the slash is the filter query. The
 * plugin tracks the range and keeps navigation keys away from other keymaps
 * while the menu is open; rendering lives in the React `SlashMenu` component.
 */
export function slashMenuPlugin(handlers: SlashMenuHandlers): Plugin<Tracked | null> {
  const onState = handlers.onState;
  const onKey = handlers.onKey;
  const runtimes = new WeakMap<EditorView, PluginRuntime>();

  const retireStatePublication = (runtime: PluginRuntime) => {
    const publication = runtime.current;
    if (!publication) return;
    publication.domHistory?.release();
    runtime.current = null;
  };

  const publishState = (
    runtime: PluginRuntime,
    view: EditorView,
    tracked: Tracked,
    state: SlashState,
  ) => {
    retireStatePublication(runtime);
    const editorDom = view.dom;
    const ownerDocument = editorDom.ownerDocument;
    const ownerWindow = ownerDocument.defaultView as (Window & typeof globalThis) | null;
    if (!ownerWindow) return;
    const publication: PluginStatePublication = Object.freeze({
      view,
      editorState: view.state,
      tracked,
      state,
      editorDom,
      ownerDocument,
      ownerWindow,
      authority: captureKeyboardAuthority(ownerDocument, ownerWindow),
      domHistory: createDomHistory(editorDom),
    });
    statePublicationHandlers.set(publication, { handlers, onState, onKey });
    runtime.current = publication;
  };

  const publishTrackedState = (
    runtime: PluginRuntime,
    view: EditorView,
    tracked: Tracked,
  ) => {
    let coords: SlashState["coords"];
    try {
      const current = view.coordsAtPos(tracked.from);
      coords = Object.freeze({
        left: current.left,
        top: current.top,
        bottom: current.bottom,
      });
    } catch {
      coords = Object.freeze({ left: 0, top: 0, bottom: 0 });
    }
    const state = Object.freeze({ ...tracked, coords });
    publishState(runtime, view, tracked, state);
    onState(state);
  };

  return new Plugin<Tracked | null>({
    key: slashMenuKey,
    state: {
      init: () => null,
      apply(tr, prev, _old, next) {
        const meta = tr.getMeta(slashMenuKey) as { close?: boolean } | undefined;
        if (meta?.close) return null;
        if (!isEditable(next)) return null;
        if (prev) {
          const from = tr.mapping.map(prev.from, -1);
          // If the slash itself was deleted, the mapped start no longer points at it.
          if (tr.docChanged && next.doc.textBetween(from, Math.min(from + 1, next.doc.content.size), "\0", "\0") !== "/") return null;
          return track(next, from);
        }
        if (!tr.docChanged || !typedSlash(tr)) return null;
        const head = next.selection.head;
        if (!next.selection.empty || head < 1 || !slashOpensAt(next, head - 1)) return null;
        return track(next, head - 1);
      },
    },
    props: {
      handleKeyDown(view, event) {
        const runtime = runtimes.get(view);
        const statePublication = runtime?.current;
        if (!runtime || !statePublication || !onKey) return false;
        const publication = createKeyPublication(runtime, statePublication, event);
        if (!publication) return false;
        runtime.attemptedEvents.add(event);
        runtime.dispatching = true;
        let accepted = false;
        try {
          accepted = onKey(publication) === true;
        } catch (error) {
          slashKeyRecords.get(publication)?.action?.cancel();
          throw error;
        } finally {
          runtime.dispatching = false;
        }
        const record = slashKeyRecords.get(publication);
        const authority = statePublication.authority;
        const currentFacts = authority ? readNativeKey(authority, event) : null;
        if (
          !accepted ||
          !record?.action ||
          !authority ||
          !currentFacts ||
          !nativeKeyStillMatches(publication, authority, currentFacts, false) ||
          !pluginStatePublicationIsCurrent(runtime, statePublication, handlers, onState, onKey)
        ) {
          record?.action?.cancel();
          return false;
        }
        record.accepted = true;
        Promise.resolve().then(() => settleKeyPublication(publication));
        return true;
      },
      handleDOMEvents: {
        blur(view) {
          // Closing on blur would race with clicks inside the menu; the menu itself
          // cancels mousedown, so only a real focus loss reaches here.
          setTimeout(() => {
            if (!view.isDestroyed && !view.hasFocus()) closeSlashMenu(view);
          }, 0);
          return false;
        },
      },
    },
    view(initialView) {
      let last: Tracked | null = null;
      const runtime: PluginRuntime = {
        view: initialView,
        current: null,
        dispatching: false,
        destroyed: false,
        attemptedEvents: new WeakSet(),
      };
      runtimes.set(initialView, runtime);
      return {
        update(view) {
          const tracked = slashMenuKey.getState(view.state) ?? null;
          if (tracked === last) {
            if (
              tracked &&
              runtime.current?.editorState !== view.state
            ) {
              publishTrackedState(runtime, view, tracked);
            }
            return;
          }
          if (last && tracked && last.from === tracked.from && last.to === tracked.to && last.query === tracked.query) {
            last = tracked;
            publishTrackedState(runtime, view, tracked);
            return;
          }
          last = tracked;
          if (!tracked) {
            retireStatePublication(runtime);
            return onState(null);
          }
          publishTrackedState(runtime, view, tracked);
        },
        destroy() {
          runtime.destroyed = true;
          retireStatePublication(runtime);
          runtimes.delete(initialView);
          onState(null);
        },
      };
    },
  });
}

export function slashMenuState(state: EditorState): { from: number; to: number; query: string } | null {
  return slashMenuKey.getState(state) ?? null;
}
