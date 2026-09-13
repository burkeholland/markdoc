"use client";

type WebIdlIntrinsic = (this: unknown) => unknown;

const APPLY_INTRINSIC = Reflect.apply;
const CONSTRUCT = Reflect.construct;
const FREEZE = Object.freeze;
const GET_OWN_PROPERTY_DESCRIPTOR = Object.getOwnPropertyDescriptor;
const GET_PROTOTYPE_OF = Object.getPrototypeOf;
const IS_ARRAY = Array.isArray;
const INITIAL_SET_TIMEOUT =
  typeof window === "undefined" ? null : window.setTimeout;

function callIntrinsic<T>(intrinsic: WebIdlIntrinsic, receiver: object): T {
  return APPLY_INTRINSIC(intrinsic, receiver, []) as T;
}

interface RealmConstructorBinding {
  readonly name: "Event" | "UIEvent" | "KeyboardEvent" | "Node" | "Document";
  readonly value: object;
  readonly prototype: object;
  readonly prototypeParent: object | null;
  readonly chain: readonly object[];
  readonly getter: WebIdlIntrinsic | undefined;
  readonly setter: object | undefined;
  readonly writable: boolean | undefined;
  readonly enumerable: boolean | undefined;
  readonly configurable: boolean | undefined;
  readonly prototypeWritable: boolean | undefined;
  readonly prototypeEnumerable: boolean | undefined;
  readonly prototypeConfigurable: boolean | undefined;
}

interface RealmMemberBinding {
  readonly owner: object;
  readonly name: string;
  readonly kind: "getter" | "method";
  readonly intrinsic: WebIdlIntrinsic;
  readonly setter: object | undefined;
  readonly writable: boolean | undefined;
  readonly enumerable: boolean | undefined;
  readonly configurable: boolean | undefined;
}

export interface FindKeyboardIntrinsics {
  readonly view: Window;
  readonly event: RealmConstructorBinding;
  readonly uiEvent: RealmConstructorBinding;
  readonly keyboardEvent: RealmConstructorBinding;
  readonly node: RealmConstructorBinding;
  readonly document: RealmConstructorBinding;
  readonly members: readonly RealmMemberBinding[];
  readonly eventGetters: Readonly<{
    type: WebIdlIntrinsic;
    bubbles: WebIdlIntrinsic;
    cancelable: WebIdlIntrinsic;
    defaultPrevented: WebIdlIntrinsic;
    eventPhase: WebIdlIntrinsic;
    timeStamp: WebIdlIntrinsic;
    target: WebIdlIntrinsic;
    currentTarget: WebIdlIntrinsic;
  }>;
  readonly keyboardGetters: Readonly<{
    key: WebIdlIntrinsic;
    code: WebIdlIntrinsic;
    location: WebIdlIntrinsic;
    repeat: WebIdlIntrinsic;
    isComposing: WebIdlIntrinsic;
    altKey: WebIdlIntrinsic;
    ctrlKey: WebIdlIntrinsic;
    metaKey: WebIdlIntrinsic;
    shiftKey: WebIdlIntrinsic;
  }>;
  readonly uiEventGetters: Readonly<{
    view: WebIdlIntrinsic;
  }>;
  readonly nodeGetters: Readonly<{
    ownerDocument: WebIdlIntrinsic;
    isConnected: WebIdlIntrinsic;
  }>;
  readonly documentGetters: Readonly<{
    activeElement: WebIdlIntrinsic;
    defaultView: WebIdlIntrinsic;
  }>;
  readonly composedPath: WebIdlIntrinsic;
  readonly preventDefault: WebIdlIntrinsic;
  readonly isTrusted: WebIdlIntrinsic;
}

export interface FindNativeKeyboardFacts {
  readonly event: object;
  readonly type: string;
  readonly key: string;
  readonly code: string;
  readonly location: number;
  readonly repeat: boolean;
  readonly isComposing: boolean;
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
  readonly bubbles: boolean;
  readonly cancelable: boolean;
  readonly defaultPrevented: boolean;
  readonly isTrusted: boolean;
  readonly eventPhase: number;
  readonly timeStamp: number;
  readonly view: Window | null;
  readonly ownerView: Window | null;
  readonly target: Node;
  readonly currentTarget: EventTarget | null;
  readonly path: readonly EventTarget[];
  readonly activeElement: Element | null;
}

function captureRealmConstructor(
  view: Window,
  name: RealmConstructorBinding["name"],
): RealmConstructorBinding | null {
  try {
    const chain: object[] = [];
    let owner: object | null = view;
    while (owner) {
      chain.push(owner);
      const descriptor = GET_OWN_PROPERTY_DESCRIPTOR(owner, name);
      if (descriptor) {
        const value = "value" in descriptor
          ? descriptor.value
          : typeof descriptor.get === "function"
            ? APPLY_INTRINSIC(descriptor.get, view, [])
            : null;
        if (typeof value !== "function") return null;
        const prototypeDescriptor = GET_OWN_PROPERTY_DESCRIPTOR(
          value,
          "prototype",
        );
        if (
          !prototypeDescriptor ||
          !("value" in prototypeDescriptor) ||
          !prototypeDescriptor.value ||
          typeof prototypeDescriptor.value !== "object"
        ) {
          return null;
        }
        return FREEZE({
          name,
          value,
          prototype: prototypeDescriptor.value,
          prototypeParent: GET_PROTOTYPE_OF(prototypeDescriptor.value),
          chain: FREEZE(chain),
          getter: descriptor.get as WebIdlIntrinsic | undefined,
          setter: descriptor.set,
          writable: descriptor.writable,
          enumerable: descriptor.enumerable,
          configurable: descriptor.configurable,
          prototypeWritable: prototypeDescriptor.writable,
          prototypeEnumerable: prototypeDescriptor.enumerable,
          prototypeConfigurable: prototypeDescriptor.configurable,
        });
      }
      owner = GET_PROTOTYPE_OF(owner);
    }
  } catch {
    return null;
  }
  return null;
}

function realmConstructorIsCurrent(binding: RealmConstructorBinding): boolean {
  try {
    let candidate: object | null = binding.chain[0] ?? null;
    for (let index = 0; index < binding.chain.length; index += 1) {
      const expected = binding.chain[index];
      if (!expected || candidate !== expected) return false;
      const descriptor = GET_OWN_PROPERTY_DESCRIPTOR(candidate, binding.name);
      if (index < binding.chain.length - 1) {
        if (descriptor) return false;
      } else {
        if (!descriptor) return false;
        if (binding.getter) {
          if (
            "value" in descriptor ||
            descriptor.get !== binding.getter ||
            descriptor.set !== binding.setter ||
            APPLY_INTRINSIC(binding.getter, binding.chain[0], []) !== binding.value
          ) {
            return false;
          }
        } else if (
          !("value" in descriptor) ||
          descriptor.value !== binding.value ||
          binding.setter !== undefined
        ) {
          return false;
        }
        if (
          descriptor.writable !== binding.writable ||
          descriptor.enumerable !== binding.enumerable ||
          descriptor.configurable !== binding.configurable
        ) {
          return false;
        }
      }
      candidate = GET_PROTOTYPE_OF(candidate);
    }
    const prototypeDescriptor = GET_OWN_PROPERTY_DESCRIPTOR(
      binding.value,
      "prototype",
    );
    return !!(
      prototypeDescriptor &&
      "value" in prototypeDescriptor &&
      prototypeDescriptor.value === binding.prototype &&
      GET_PROTOTYPE_OF(binding.prototype) === binding.prototypeParent &&
      prototypeDescriptor.writable === binding.prototypeWritable &&
      prototypeDescriptor.enumerable === binding.prototypeEnumerable &&
      prototypeDescriptor.configurable === binding.prototypeConfigurable
    );
  } catch {
    return false;
  }
}

function captureGetter(
  prototype: object,
  name: string,
  members: RealmMemberBinding[],
): WebIdlIntrinsic | null {
  const descriptor = GET_OWN_PROPERTY_DESCRIPTOR(prototype, name);
  if (typeof descriptor?.get !== "function") return null;
  const intrinsic = descriptor.get as WebIdlIntrinsic;
  members.push(FREEZE({
    owner: prototype,
    name,
    kind: "getter",
    intrinsic,
    setter: descriptor.set,
    writable: descriptor.writable,
    enumerable: descriptor.enumerable,
    configurable: descriptor.configurable,
  }));
  return intrinsic;
}

function captureMethod(
  prototype: object,
  name: string,
  members: RealmMemberBinding[],
): WebIdlIntrinsic | null {
  const descriptor = GET_OWN_PROPERTY_DESCRIPTOR(prototype, name);
  if (typeof descriptor?.value !== "function") return null;
  const intrinsic = descriptor.value as WebIdlIntrinsic;
  members.push(FREEZE({
    owner: prototype,
    name,
    kind: "method",
    intrinsic,
    setter: descriptor.set,
    writable: descriptor.writable,
    enumerable: descriptor.enumerable,
    configurable: descriptor.configurable,
  }));
  return intrinsic;
}

function captureLegacyUnforgeableGetter(
  constructor: RealmConstructorBinding,
  name: string,
): WebIdlIntrinsic | null {
  const probe = CONSTRUCT(constructor.value as typeof Event, [
    "markdoc-trust-probe",
  ]);
  const descriptor = GET_OWN_PROPERTY_DESCRIPTOR(probe, name);
  return typeof descriptor?.get === "function" && descriptor.configurable === false
    ? descriptor.get as WebIdlIntrinsic
    : null;
}

function realmMemberIsCurrent(binding: RealmMemberBinding): boolean {
  try {
    const descriptor = GET_OWN_PROPERTY_DESCRIPTOR(binding.owner, binding.name);
    return !!(
      descriptor &&
      (binding.kind === "getter"
        ? !("value" in descriptor) &&
          descriptor.get === binding.intrinsic &&
          descriptor.set === binding.setter
        : "value" in descriptor &&
          descriptor.value === binding.intrinsic) &&
      descriptor.writable === binding.writable &&
      descriptor.enumerable === binding.enumerable &&
      descriptor.configurable === binding.configurable
    );
  } catch {
    return false;
  }
}

function captureFindKeyboardIntrinsics(view: Window): FindKeyboardIntrinsics | null {
  try {
    const members: RealmMemberBinding[] = [];
    const event = captureRealmConstructor(view, "Event");
    const uiEvent = captureRealmConstructor(view, "UIEvent");
    const keyboardEvent = captureRealmConstructor(view, "KeyboardEvent");
    const node = captureRealmConstructor(view, "Node");
    const document = captureRealmConstructor(view, "Document");
    if (!event || !uiEvent || !keyboardEvent || !node || !document) return null;
    const eventGetters = {
      type: captureGetter(event.prototype, "type", members),
      bubbles: captureGetter(event.prototype, "bubbles", members),
      cancelable: captureGetter(event.prototype, "cancelable", members),
      defaultPrevented: captureGetter(event.prototype, "defaultPrevented", members),
      eventPhase: captureGetter(event.prototype, "eventPhase", members),
      timeStamp: captureGetter(event.prototype, "timeStamp", members),
      target: captureGetter(event.prototype, "target", members),
      currentTarget: captureGetter(event.prototype, "currentTarget", members),
    };
    const uiEventGetters = {
      view: captureGetter(uiEvent.prototype, "view", members),
    };
    const keyboardGetters = {
      key: captureGetter(keyboardEvent.prototype, "key", members),
      code: captureGetter(keyboardEvent.prototype, "code", members),
      location: captureGetter(keyboardEvent.prototype, "location", members),
      repeat: captureGetter(keyboardEvent.prototype, "repeat", members),
      isComposing: captureGetter(keyboardEvent.prototype, "isComposing", members),
      altKey: captureGetter(keyboardEvent.prototype, "altKey", members),
      ctrlKey: captureGetter(keyboardEvent.prototype, "ctrlKey", members),
      metaKey: captureGetter(keyboardEvent.prototype, "metaKey", members),
      shiftKey: captureGetter(keyboardEvent.prototype, "shiftKey", members),
    };
    const nodeGetters = {
      ownerDocument: captureGetter(node.prototype, "ownerDocument", members),
      isConnected: captureGetter(node.prototype, "isConnected", members),
    };
    const documentGetters = {
      activeElement: captureGetter(document.prototype, "activeElement", members),
      defaultView: captureGetter(document.prototype, "defaultView", members),
    };
    const composedPath = captureMethod(event.prototype, "composedPath", members);
    const preventDefault = captureMethod(event.prototype, "preventDefault", members);
    const isTrusted = captureLegacyUnforgeableGetter(event, "isTrusted");
    if (
      !eventGetters.type ||
      !eventGetters.bubbles ||
      !eventGetters.cancelable ||
      !eventGetters.defaultPrevented ||
      !eventGetters.eventPhase ||
      !eventGetters.timeStamp ||
      !eventGetters.target ||
      !eventGetters.currentTarget ||
      !uiEventGetters.view ||
      !keyboardGetters.key ||
      !keyboardGetters.code ||
      !keyboardGetters.location ||
      !keyboardGetters.repeat ||
      !keyboardGetters.isComposing ||
      !keyboardGetters.altKey ||
      !keyboardGetters.ctrlKey ||
      !keyboardGetters.metaKey ||
      !keyboardGetters.shiftKey ||
      !nodeGetters.ownerDocument ||
      !nodeGetters.isConnected ||
      !documentGetters.activeElement ||
      !documentGetters.defaultView ||
      !composedPath ||
      !preventDefault ||
      !isTrusted
    ) {
      return null;
    }
    return FREEZE({
      view,
      event,
      uiEvent,
      keyboardEvent,
      node,
      document,
      members: FREEZE(members),
      eventGetters: FREEZE(eventGetters) as FindKeyboardIntrinsics["eventGetters"],
      uiEventGetters: FREEZE(uiEventGetters) as FindKeyboardIntrinsics["uiEventGetters"],
      keyboardGetters: FREEZE(keyboardGetters) as FindKeyboardIntrinsics["keyboardGetters"],
      nodeGetters: FREEZE(nodeGetters) as FindKeyboardIntrinsics["nodeGetters"],
      documentGetters: FREEZE(documentGetters) as FindKeyboardIntrinsics["documentGetters"],
      composedPath,
      preventDefault,
      isTrusted,
    });
  } catch {
    return null;
  }
}

function findKeyboardIntrinsicsAreCurrent(intrinsics: FindKeyboardIntrinsics) {
  if (
    !realmConstructorIsCurrent(intrinsics.event) ||
    !realmConstructorIsCurrent(intrinsics.uiEvent) ||
    !realmConstructorIsCurrent(intrinsics.keyboardEvent) ||
    !realmConstructorIsCurrent(intrinsics.node) ||
    !realmConstructorIsCurrent(intrinsics.document)
  ) {
    return false;
  }
  for (let index = 0; index < intrinsics.members.length; index += 1) {
    const member = intrinsics.members[index];
    if (!member || !realmMemberIsCurrent(member)) return false;
  }
  return true;
}

const INITIAL_FIND_KEYBOARD_INTRINSICS =
  typeof window === "undefined" ? null : captureFindKeyboardIntrinsics(window);

export function primeFindKeyboardTrust() {
  return INITIAL_FIND_KEYBOARD_INTRINSICS !== null;
}

export function freezeFindKeyboardRecord<T extends object>(value: T): Readonly<T> {
  return FREEZE(value);
}

export function scheduleFindKeyboardRecordExpiry(
  view: Window,
  expire: () => void,
) {
  try {
    if (!INITIAL_SET_TIMEOUT) return false;
    APPLY_INTRINSIC(INITIAL_SET_TIMEOUT, view, [expire, 0]);
    return true;
  } catch {
    return false;
  }
}

export function trustedFindKeyboardIntrinsics(
  view: Window,
): FindKeyboardIntrinsics | null {
  return INITIAL_FIND_KEYBOARD_INTRINSICS?.view === view &&
    findKeyboardIntrinsicsAreCurrent(INITIAL_FIND_KEYBOARD_INTRINSICS)
    ? INITIAL_FIND_KEYBOARD_INTRINSICS
    : null;
}

export function readFindKeyboardFacts(
  intrinsics: FindKeyboardIntrinsics,
  event: object,
  ownerDocument: Document,
): FindNativeKeyboardFacts | null {
  try {
    if (GET_PROTOTYPE_OF(event) !== intrinsics.keyboardEvent.prototype) {
      return null;
    }
    const target = callIntrinsic<EventTarget | null>(
      intrinsics.eventGetters.target,
      event,
    );
    if (!target || typeof target !== "object") return null;
    const targetOwnerDocument = callIntrinsic<Document | null>(
      intrinsics.nodeGetters.ownerDocument,
      target,
    );
    const targetConnected = callIntrinsic<boolean>(
      intrinsics.nodeGetters.isConnected,
      target,
    );
    if (targetOwnerDocument !== ownerDocument || !targetConnected) return null;
    const path = callIntrinsic<EventTarget[]>(
      intrinsics.composedPath,
      event,
    );
    if (!IS_ARRAY(path)) return null;
    return FREEZE({
      event,
      type: callIntrinsic<string>(intrinsics.eventGetters.type, event),
      key: callIntrinsic<string>(intrinsics.keyboardGetters.key, event),
      code: callIntrinsic<string>(intrinsics.keyboardGetters.code, event),
      location: callIntrinsic<number>(intrinsics.keyboardGetters.location, event),
      repeat: callIntrinsic<boolean>(intrinsics.keyboardGetters.repeat, event),
      isComposing: callIntrinsic<boolean>(
        intrinsics.keyboardGetters.isComposing,
        event,
      ),
      altKey: callIntrinsic<boolean>(intrinsics.keyboardGetters.altKey, event),
      ctrlKey: callIntrinsic<boolean>(intrinsics.keyboardGetters.ctrlKey, event),
      metaKey: callIntrinsic<boolean>(intrinsics.keyboardGetters.metaKey, event),
      shiftKey: callIntrinsic<boolean>(intrinsics.keyboardGetters.shiftKey, event),
      bubbles: callIntrinsic<boolean>(intrinsics.eventGetters.bubbles, event),
      cancelable: callIntrinsic<boolean>(intrinsics.eventGetters.cancelable, event),
      defaultPrevented: callIntrinsic<boolean>(
        intrinsics.eventGetters.defaultPrevented,
        event,
      ),
      isTrusted: callIntrinsic<boolean>(intrinsics.isTrusted, event),
      eventPhase: callIntrinsic<number>(
        intrinsics.eventGetters.eventPhase,
        event,
      ),
      timeStamp: callIntrinsic<number>(intrinsics.eventGetters.timeStamp, event),
      view: callIntrinsic<Window | null>(intrinsics.uiEventGetters.view, event),
      ownerView: callIntrinsic<Window | null>(
        intrinsics.documentGetters.defaultView,
        ownerDocument,
      ),
      target: target as Node,
      currentTarget: callIntrinsic<EventTarget | null>(
        intrinsics.eventGetters.currentTarget,
        event,
      ),
      path: FREEZE([...path]),
      activeElement: callIntrinsic<Element | null>(
        intrinsics.documentGetters.activeElement,
        ownerDocument,
      ),
    });
  } catch {
    return null;
  }
}

export function sameFindKeyboardDelivery(
  captured: FindNativeKeyboardFacts,
  current: FindNativeKeyboardFacts,
  captureBoundary: EventTarget,
  deliveryBoundary: EventTarget,
) {
  if (
    current.event !== captured.event ||
    current.type !== captured.type ||
    current.key !== captured.key ||
    current.code !== captured.code ||
    current.location !== captured.location ||
    current.repeat !== captured.repeat ||
    current.isComposing !== captured.isComposing ||
    current.altKey !== captured.altKey ||
    current.ctrlKey !== captured.ctrlKey ||
    current.metaKey !== captured.metaKey ||
    current.shiftKey !== captured.shiftKey ||
    current.bubbles !== captured.bubbles ||
    current.cancelable !== captured.cancelable ||
    current.defaultPrevented !== captured.defaultPrevented ||
    current.isTrusted !== captured.isTrusted ||
    captured.eventPhase !== 1 ||
    current.eventPhase !== 3 ||
    current.timeStamp !== captured.timeStamp ||
    current.view !== captured.view ||
    current.ownerView !== captured.ownerView ||
    current.target !== captured.target ||
    captured.currentTarget !== captureBoundary ||
    current.currentTarget !== deliveryBoundary ||
    current.activeElement !== captured.target ||
    current.path.length !== captured.path.length
  ) {
    return false;
  }
  for (let index = 0; index < current.path.length; index += 1) {
    if (current.path[index] !== captured.path[index]) return false;
  }
  return true;
}

export function findKeyboardPathIncludes(
  facts: FindNativeKeyboardFacts,
  target: EventTarget,
) {
  for (let index = 0; index < facts.path.length; index += 1) {
    if (facts.path[index] === target) return true;
  }
  return false;
}

export function preventFindKeyboardDefault(
  intrinsics: FindKeyboardIntrinsics,
  event: object,
) {
  try {
    callIntrinsic<void>(intrinsics.preventDefault, event);
    return callIntrinsic<boolean>(
      intrinsics.eventGetters.defaultPrevented,
      event,
    );
  } catch {
    return false;
  }
}
