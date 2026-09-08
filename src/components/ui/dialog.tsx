"use client";

import * as React from "react";
import { Dialog as RadixDialog } from "radix-ui";
import { useComposedRefs } from "radix-ui/internal";
import { X } from "lucide-react";
import { firstTabbable, focusReturnTarget, restoreFocus } from "@/lib/a11y";
import { cn } from "@/lib/utils";

/* ---------------- Dialog ---------------- */

const OVERLAY_CLASS_NAME = "dialog-overlay animate-fade-in";
const HEADER_CLASS_NAME = "mb-4 flex items-start justify-between gap-4";
const TITLE_CLASS_NAME = "text-lg font-semibold text-ink";
const DESCRIPTION_CLASS_NAME = "mt-1 text-sm text-ink-3";
const HIDDEN_DESCRIPTION_CLASS_NAME = "sr-only";
const CLOSE_CLASS_NAME = "icon-btn -mr-2 -mt-1 h-8 w-8 shrink-0";

type DialogRootProps = React.ComponentProps<typeof RadixDialog.Root>;
type ContentProps = React.ComponentProps<typeof RadixDialog.Content>;
type OpenAutoFocusEvent = Parameters<NonNullable<ContentProps["onOpenAutoFocus"]>>[0];
type CloseAutoFocusEvent = Parameters<NonNullable<ContentProps["onCloseAutoFocus"]>>[0];
type EscapeKeyEvent = Parameters<NonNullable<ContentProps["onEscapeKeyDown"]>>[0];
type PointerDownOutsideEvent = Parameters<NonNullable<ContentProps["onPointerDownOutside"]>>[0];
type FocusOutsideEvent = Parameters<NonNullable<ContentProps["onFocusOutside"]>>[0];
type TimerHandle = ReturnType<Window["setTimeout"]>;

interface DialogRootAuthority {
  readonly identity: symbol;
  readonly mount: symbol;
  readonly actualOpen: boolean;
  readonly controlled: boolean;
  readonly open: boolean | undefined;
  readonly defaultOpen: boolean | undefined;
  readonly modal: boolean;
  readonly onOpenChange: ((open: boolean) => void) | undefined;
  readonly setUncontrolledOpen: React.Dispatch<React.SetStateAction<boolean>>;
  readonly openingTarget: HTMLElement | null;
}

interface DialogRootPresentation {
  readonly authority: DialogRootAuthority;
  readonly onOpenChange: (open: boolean) => void;
}

interface DialogAuthority {
  readonly identity: symbol;
  readonly mount: symbol;
  readonly revision: number;
  readonly root: DialogRootAuthority;
  readonly title: string;
  readonly description: string | undefined;
  readonly children: React.ReactNode;
  readonly classNameInput: string | undefined;
  readonly className: string;
  readonly wide: boolean | undefined;
  readonly onClosed: (() => void) | undefined;
  readonly opener: HTMLElement | null;
  readonly initialFocus: HTMLElement | null;
}

interface FocusCustody {
  readonly opener: HTMLElement | null;
  returnTarget: HTMLElement | null;
  returnTargetClaimed: boolean;
}

interface ElementOwnerView {
  readonly element: () => Element | null;
}

interface RefReplay {
  readonly owner: ElementOwnerView;
  readonly element: Element;
  detached: boolean;
  reattached: boolean;
}

interface DialogElements {
  readonly overlay: HTMLDivElement | null;
  readonly content: HTMLDivElement;
  readonly header: HTMLDivElement;
  readonly title: HTMLHeadingElement;
  readonly description: HTMLParagraphElement;
  readonly close: HTMLButtonElement;
  readonly icon: SVGSVGElement;
  readonly body: HTMLDivElement;
}

interface DialogElementOwners {
  readonly overlay: ElementOwner<HTMLDivElement>;
  readonly content: ElementOwner<HTMLDivElement>;
  readonly header: ElementOwner<HTMLDivElement>;
  readonly title: ElementOwner<HTMLHeadingElement>;
  readonly description: ElementOwner<HTMLParagraphElement>;
  readonly close: ElementOwner<HTMLButtonElement>;
  readonly icon: ElementOwner<SVGSVGElement>;
  readonly body: ElementOwner<HTMLDivElement>;
}

interface DialogActions {
  readonly openAutoFocus: object;
  readonly closeAutoFocus: object;
  readonly closeClick: object;
  readonly escape: object;
  readonly outsidePointer: object;
  readonly outsideFocus: object;
  readonly focusOut: object;
  readonly openingTimer: object;
}

interface DomSnapshot {
  readonly node: Node;
  readonly nodeValue: string | null;
  readonly attributes: readonly (readonly [string, string])[] | null;
  readonly children: readonly DomSnapshot[];
}

interface DialogPublication {
  readonly identity: symbol;
  readonly authority: DialogAuthority;
  readonly elements: DialogElements;
  readonly actions: DialogActions;
  readonly ownerDocument: Document;
  readonly overlayDom: DomSnapshot | null;
  readonly contentDom: DomSnapshot;
  readonly closeTargets: readonly Node[];
  readonly journal: MutationJournal;
  readonly custody: FocusCustody;
  readonly requestSuccessor: () => void;
  readonly retire: (reason?: Retirement) => boolean;
  readonly isRetired: () => boolean;
  readonly exactOpenDomMatches: () => boolean;
  readonly detachOpening: () => void;
  opening: boolean;
  openingTimer: TimerHandle | null;
  listenerAttached: boolean;
  closed: boolean;
}

type Retirement = "element" | "layout" | "other";

interface DialogReplay {
  readonly source: DialogPublication;
  readonly historyIsClean: () => boolean;
  readonly release: () => void;
}

interface PublicationRuntime {
  readonly publication: DialogPublication;
  readonly publish: () => boolean;
  readonly scheduleOpeningRecovery: () => void;
  readonly retireForElement: () => void;
  readonly retireForLayout: () => void;
  readonly noteRef: (
    owner: ElementOwnerView,
    element: Element | null,
    previous: Element | null,
  ) => void;
  readonly isExactElementReplay: () => boolean;
  readonly isExactLayoutReplay: () => boolean;
  readonly replayDomMatches: () => boolean;
  readonly replay: () => DialogReplay;
}

interface PendingDismiss {
  readonly publication: DialogPublication;
  readonly root: DialogRootAuthority;
  readonly action: object;
}

interface ParentDismissBridge {
  readonly publication: DialogPublication;
  readonly root: DialogRootAuthority;
  readonly action: object;
}

interface OwnedActionBinding {
  readonly root: DialogRootAuthority;
  readonly element: HTMLElement;
  readonly kind: "close" | "trigger";
}

interface CloseTransition {
  readonly source: DialogPublication;
  readonly authority: DialogAuthority;
  readonly closeAction: object;
  readonly custody: FocusCustody;
  readonly onClosed: (() => void) | undefined;
  claimed: boolean;
}

interface DialogContextValue {
  readonly root: DialogRootAuthority;
  readonly coordinator: DialogCoordinator;
}

function focusedElement(ownerDocument: Document): HTMLElement | null {
  const active = ownerDocument.activeElement;
  const HTMLElementConstructor = ownerDocument.defaultView?.HTMLElement;
  return HTMLElementConstructor
    && active instanceof HTMLElementConstructor
    && active !== ownerDocument.body
    ? active
    : null;
}

function currentFocusReturnTarget() {
  return typeof document === "undefined" ? null : focusReturnTarget();
}

function currentFocusedElement() {
  return typeof document === "undefined" ? null : focusedElement(document);
}

function isNodeFromDocument(value: EventTarget | null, ownerDocument: Document): value is Node {
  const NodeConstructor = ownerDocument.defaultView?.Node;
  return Boolean(
    NodeConstructor
    && value instanceof NodeConstructor
    && value.ownerDocument === ownerDocument,
  );
}

function descendantsOf(element: Element): readonly Node[] {
  const nodes: Node[] = [];
  const collect = (node: Node) => {
    nodes.push(node);
    for (const child of node.childNodes) collect(child);
  };
  collect(element);
  return Object.freeze(nodes);
}

function snapshotAttributes(node: Node): readonly (readonly [string, string])[] | null {
  if (node.nodeType !== 1) return null;
  return Object.freeze(
    [...(node as Element).attributes]
      .map(({ name, value }) => Object.freeze([name, value] as const))
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

function snapshotDom(node: Node): DomSnapshot {
  return Object.freeze({
    node,
    nodeValue: node.nodeValue,
    attributes: snapshotAttributes(node),
    children: Object.freeze([...node.childNodes].map(snapshotDom)),
  });
}

function isMutableFormAttribute(element: Element, name: string) {
  return (
    (element instanceof HTMLInputElement
      && ["value", "checked", "disabled", "type"].includes(name))
    || (element instanceof HTMLTextAreaElement && ["value", "disabled"].includes(name))
    || (element instanceof HTMLSelectElement && ["value", "disabled"].includes(name))
    || (element instanceof HTMLButtonElement && name === "disabled")
    || (element instanceof HTMLOptionElement && name === "selected")
  );
}

function attributesMatch(snapshot: DomSnapshot): boolean {
  const current = snapshotAttributes(snapshot.node);
  if (current === null || snapshot.attributes === null) return current === snapshot.attributes;
  const element = snapshot.node as Element;
  const dynamicCombobox = element.getAttribute("role") === "combobox";
  const dynamicDialog = element.getAttribute("role") === "dialog";
  const dynamicOverlay = element.getAttribute("class") === OVERLAY_CLASS_NAME;
  const dynamicAttributes = (name: string) => (
    (dynamicCombobox && name === "aria-expanded")
    || isMutableFormAttribute(element, name)
    || (dynamicDialog && (name === "aria-labelledby" || name === "aria-describedby" || name === "style"))
    || (dynamicOverlay && (name === "aria-hidden" || name === "data-aria-hidden" || name === "style"))
  );
  const expected = snapshot.attributes.filter(([name]) => !dynamicAttributes(name));
  const actual = current.filter(([name]) => !dynamicAttributes(name));
  return (
    expected.length === actual.length
    && actual.every(([name, value], index) => {
      const candidate = expected[index];
      return Boolean(candidate && candidate[0] === name && candidate[1] === value);
    })
  );
}

function domMatches(snapshot: DomSnapshot): boolean {
  const { node } = snapshot;
  return (
    node.nodeValue === snapshot.nodeValue
    && attributesMatch(snapshot)
    && node.childNodes.length === snapshot.children.length
    && snapshot.children.every((child, index) =>
      node.childNodes.item(index) === child.node && domMatches(child))
  );
}

function contentDomMatches(snapshot: DomSnapshot, header: HTMLDivElement) {
  const { node } = snapshot;
  return (
    node.nodeValue === snapshot.nodeValue
    && attributesMatch(snapshot)
    && node.childNodes.length === snapshot.children.length
    && snapshot.children.every((child, index) => {
      if (node.childNodes.item(index) !== child.node) return false;
      return child.node === header ? domMatches(child) : true;
    })
  );
}

function snapshotContains(snapshot: DomSnapshot, node: Node): boolean {
  return snapshot.node === node || snapshot.children.some((child) => snapshotContains(child, node));
}

function contentSnapshotContains(
  snapshot: DomSnapshot,
  header: HTMLDivElement,
  node: Node,
) {
  return (
    snapshotContains(snapshot, node)
    || snapshot.children.some((child) =>
      child.node !== header && child.node.contains?.(node))
  );
}

function isFocusGuard(node: Node): node is HTMLElement {
  return (
    node.nodeType === 1
    && (node as Element).tagName === "SPAN"
    && (node as Element).getAttribute("data-radix-focus-guard") === ""
    && (node as Element).getAttribute("tabindex") === "0"
  );
}

function styleParts(ownerDocument: Document, value: string | null) {
  const element = ownerDocument.createElement("div");
  if (value !== null) element.setAttribute("style", value);
  const pointerEvents = element.style.pointerEvents;
  element.style.removeProperty("pointer-events");
  return { pointerEvents, rest: element.getAttribute("style") ?? "" };
}

class MutationJournal {
  readonly #ownerDocument: Document;
  readonly #overlay: HTMLDivElement | null;
  readonly #content: HTMLDivElement;
  readonly #body: HTMLDivElement;
  readonly #title: HTMLHeadingElement;
  readonly #description: HTMLParagraphElement;
  readonly #portalParent: Node;
  readonly #ancestors: ReadonlySet<Node>;
  readonly #initialBodyPointerEvents: string;
  readonly #observer: MutationObserver;
  readonly #onInvalid: () => void;
  readonly #records: MutationRecord[] = [];
  readonly #attributeValues = new WeakMap<Element, Map<string, string | null>>();
  readonly #focusGuards = new Set<Node>();
  readonly #nestedRoots = new Set<Node>();
  #processed = 0;
  #closing = false;
  #replaying = false;
  #invalid = false;
  #released = false;

  constructor(elements: DialogElements, onInvalid: () => void) {
    this.#ownerDocument = elements.content.ownerDocument;
    this.#overlay = elements.overlay;
    this.#content = elements.content;
    this.#body = elements.body;
    this.#title = elements.title;
    this.#description = elements.description;
    this.#onInvalid = onInvalid;
    this.#initialBodyPointerEvents = this.#ownerDocument.body.style.pointerEvents;
    this.#ownerDocument
      .querySelectorAll("[data-radix-focus-guard]")
      .forEach((guard) => this.#focusGuards.add(guard));
    const portalParent = elements.content.parentNode;
    if (!portalParent || (elements.overlay && elements.overlay.parentNode !== portalParent)) {
      throw new Error("Cannot publish dialog roots without their shared portal parent");
    }
    this.#portalParent = portalParent;
    const ancestors = new Set<Node>();
    for (let node: Node | null = portalParent; node; node = node.parentNode) ancestors.add(node);
    this.#ancestors = ancestors;
    const MutationObserverConstructor = this.#ownerDocument.defaultView?.MutationObserver;
    if (!MutationObserverConstructor) throw new Error("Cannot publish a dialog without MutationObserver");
    this.#observer = new MutationObserverConstructor((records) => {
      if (this.#released || this.#invalid) return;
      this.#records.push(...records);
      this.#process();
    });
    this.#observer.observe(this.#ownerDocument, {
      attributes: true,
      attributeOldValue: true,
      characterData: true,
      characterDataOldValue: true,
      childList: true,
      subtree: true,
    });
  }

  #nextAttributeValue(index: number, target: Element, name: string): string | null {
    for (let cursor = index + 1; cursor < this.#records.length; cursor++) {
      const candidate = this.#records[cursor];
      if (candidate.type === "attributes" && candidate.target === target && candidate.attributeName === name) {
        return candidate.oldValue;
      }
    }
    return target.getAttribute(name);
  }

  #expectedAttribute(target: Element, name: string, oldValue: string | null) {
    let values = this.#attributeValues.get(target);
    if (!values) {
      values = new Map();
      this.#attributeValues.set(target, values);
    }
    if (!values.has(name)) values.set(name, oldValue);
    return values;
  }

  #isOwned(node: Node) {
    return (
      node === this.#overlay
      || node === this.#content
      || Boolean(this.#overlay?.contains(node))
      || this.#content.contains(node)
    );
  }

  #isBodyDescendant(node: Node) {
    return (
      node !== this.#content
      && this.#content.contains(node)
      && !this.#content.firstElementChild?.contains(node)
    );
  }

  #isAllowedAttribute(record: MutationRecord, index: number) {
    const target = record.target;
    const name = record.attributeName;
    if (!(target instanceof Element) || !name) return false;
    const values = this.#expectedAttribute(target, name, record.oldValue);
    const expected = values.get(name);
    const next = this.#nextAttributeValue(index, target, name);
    const mutableFormAttribute = (
      this.#body.contains(target)
      && isMutableFormAttribute(target, name)
    );
    if (
      expected !== record.oldValue
      || (next === record.oldValue && !mutableFormAttribute)
    ) {
      return false;
    }

    let allowed = false;
    if (
      name === "aria-expanded"
      && this.#body.contains(target)
      && target.getAttribute("role") === "combobox"
      && [null, "false", "true"].includes(record.oldValue)
      && [null, "false", "true"].includes(next)
    ) {
      allowed = true;
    } else if (
      mutableFormAttribute
    ) {
      allowed = true;
    } else if (this.#isBodyDescendant(target)) {
      allowed = true;
    } else if (
      target instanceof HTMLInputElement
      && this.#body.contains(target)
      && name === "name"
      && ((record.oldValue === null && next === "")
        || (record.oldValue === "" && next === null))
    ) {
      allowed = true;
    } else if (
      target === this.#content
      && (((name === "aria-labelledby" && next === this.#title.id)
          || (name === "aria-describedby" && next === this.#description.id))
        && record.oldValue === null
        || (this.#replaying
          && ((name === "aria-labelledby" && record.oldValue === this.#title.id)
            || (name === "aria-describedby" && record.oldValue === this.#description.id))
          && next === null))
    ) {
      allowed = true;
    } else if (
      this.#closing
      && name === "data-state"
      && (target === this.#overlay || target === this.#content)
      && record.oldValue === "open"
      && next === "closed"
    ) {
      allowed = true;
    } else if (
      target === this.#ownerDocument.documentElement
      && name === "data-theme"
      && [null, "light", "dark"].includes(record.oldValue)
      && (next === "light" || next === "dark")
    ) {
      allowed = true;
    } else if (
      (name === "aria-hidden" || name === "data-aria-hidden")
      && (target === this.#overlay
        || (!this.#isOwned(target) && !target.contains(this.#content)))
      && ((record.oldValue === null && next === "true")
        || ((this.#closing || this.#replaying) && record.oldValue === "true" && next === null))
    ) {
      allowed = true;
    } else if (target === this.#ownerDocument.body && name === "data-scroll-locked") {
      const before = record.oldValue === null ? 0 : Number(record.oldValue);
      const after = next === null ? 0 : Number(next);
      allowed = (
        Number.isInteger(before)
        && Number.isInteger(after)
        && before >= 0
        && ((!this.#closing && after === before + 1)
          || ((this.#closing || this.#replaying) && after === before - 1))
      );
    } else if ((target === this.#overlay || target === this.#content) && name === "style") {
      const before = styleParts(this.#ownerDocument, record.oldValue);
      const after = styleParts(this.#ownerDocument, next);
      allowed = (
        before.rest === after.rest
        && (((before.pointerEvents === "" || before.pointerEvents === "none")
            && after.pointerEvents === "auto")
          || ((this.#closing || this.#replaying)
            && before.pointerEvents === "auto"
            && (after.pointerEvents === "" || after.pointerEvents === "none")))
      );
    } else if (target === this.#ownerDocument.body && name === "style") {
      const before = styleParts(this.#ownerDocument, record.oldValue);
      const after = styleParts(this.#ownerDocument, next);
      allowed = (
        before.rest === after.rest
        && ((before.pointerEvents === this.#initialBodyPointerEvents && after.pointerEvents === "none")
          || ((this.#closing || this.#replaying)
            && before.pointerEvents === "none"
            && after.pointerEvents === this.#initialBodyPointerEvents))
      );
    }
    if (allowed) values.set(name, next);
    return allowed;
  }

  #isAllowedChildList(record: MutationRecord) {
    const added = [...record.addedNodes];
    const removed = [...record.removedNodes];
    if (this.#isBodyDescendant(record.target)) return true;
    if (
      record.target === this.#ownerDocument.body
      && added.length > 0
      && removed.length === 0
      && added.every(isFocusGuard)
    ) {
      added.forEach((node) => this.#focusGuards.add(node));
      return true;
    }
    if (
      record.target === this.#portalParent
      && added.length > 0
      && removed.length === 0
      && added.every((node) => (
        node instanceof Element
        && node !== this.#overlay
        && node !== this.#content
        && node.getAttribute("data-state") === "open"
        && (node.getAttribute("class") === OVERLAY_CLASS_NAME
          || node.getAttribute("role") === "dialog")
      ))
    ) {
      added.forEach((node) => this.#nestedRoots.add(node));
      return true;
    }
    if (
      added.length + removed.length > 0
      && [...added, ...removed].every((node) => (
        !this.#isOwned(node)
        && !node.contains?.(this.#content)
        && !(this.#overlay
          && (this.#overlay.contains(node) || node.contains?.(this.#overlay)))
      ))
    ) {
      return true;
    }
    if (
      record.target === this.#portalParent
      && removed.length > 0
      && added.length === 0
      && removed.every((node) => this.#nestedRoots.has(node))
    ) {
      removed.forEach((node) => this.#nestedRoots.delete(node));
      return true;
    }
    if (
      (this.#closing || this.#replaying || this.#nestedRoots.size > 0)
      && record.target === this.#ownerDocument.body
      && removed.length > 0
      && added.length === 0
      && removed.every((node) => this.#focusGuards.has(node))
    ) {
      removed.forEach((node) => this.#focusGuards.delete(node));
      return true;
    }
    if (
      this.#closing
      && record.target === this.#portalParent
      && added.length === 0
      && removed.length > 0
      && removed.every((node) => node === this.#overlay || node === this.#content)
    ) {
      return true;
    }
    return false;
  }

  #isRelevant(record: MutationRecord) {
    if (this.#isOwned(record.target)) return true;
    if (this.#ancestors.has(record.target)) return true;
    if (record.type === "attributes") {
      const name = record.attributeName;
      return (
        record.target === this.#ownerDocument.body
        || name === "aria-hidden"
        || name === "data-aria-hidden"
      );
    }
    if (record.type === "childList") {
      return [...record.addedNodes, ...record.removedNodes].some((node) =>
        this.#isOwned(node)
        || node.contains?.(this.#content)
        || Boolean(this.#overlay && node.contains?.(this.#overlay)));
    }
    return false;
  }

  #process() {
    if (this.#released || this.#invalid) return;
    this.#records.push(...this.#observer.takeRecords());
    for (; this.#processed < this.#records.length; this.#processed++) {
      const record = this.#records[this.#processed];
      if (!this.#isRelevant(record)) continue;
      const allowed = record.type === "attributes"
        ? this.#isAllowedAttribute(record, this.#processed)
        : record.type === "childList"
          ? this.#isAllowedChildList(record)
          : record.type === "characterData" && this.#isBodyDescendant(record.target);
      if (!allowed) {
        this.#invalid = true;
        this.#observer.disconnect();
        this.#records.length = 0;
        this.#processed = 0;
        this.#focusGuards.clear();
        this.#nestedRoots.clear();
        this.#onInvalid();
        return;
      }
    }
    this.#records.length = 0;
    this.#processed = 0;
  }

  isClean() {
    this.#process();
    return !this.#invalid && !this.#released;
  }

  startClosing() {
    if (this.#released || this.#invalid) return false;
    this.#closing = true;
    this.#process();
    if (this.#invalid) return false;
    this.#observer.disconnect();
    return true;
  }

  startReplay() {
    if (this.#released || this.#invalid) return false;
    this.#replaying = true;
    return true;
  }

  closeHistoryIsValid() {
    return this.#closing && !this.#invalid && !this.#released;
  }

  release() {
    if (this.#released) return;
    this.#process();
    this.#observer.disconnect();
    this.#records.length = 0;
    this.#focusGuards.clear();
    this.#nestedRoots.clear();
    this.#released = true;
  }
}

class ElementOwner<T extends Element> implements ElementOwnerView {
  #current: T | null = null;
  #last: T | null = null;

  constructor(
    private readonly onChange: (
      owner: ElementOwnerView,
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
    if (!element) return;
    return () => {
      if (this.#current !== element) return;
      const detached = this.#current;
      this.#current = null;
      this.onChange(this, null, detached, this.#last);
    };
  };
}

class PresentationCache<A, P> {
  #current: { readonly authority: A; readonly presentation: P; readonly revision: number } | null = null;

  resolve(
    authority: A,
    revision: number,
    authoritiesMatch: (previous: A, current: A) => boolean,
    create: () => P,
  ) {
    if (
      !this.#current
      || this.#current.revision !== revision
      || !authoritiesMatch(this.#current.authority, authority)
    ) {
      this.#current = Object.freeze({ authority, presentation: create(), revision });
    }
    return this.#current.presentation;
  }
}

function rootAuthoritiesMatch(previous: DialogRootAuthority, current: DialogRootAuthority) {
  return (
    previous.mount === current.mount
    && previous.actualOpen === current.actualOpen
    && previous.controlled === current.controlled
    && previous.open === current.open
    && previous.defaultOpen === current.defaultOpen
    && previous.modal === current.modal
    && previous.onOpenChange === current.onOpenChange
    && previous.setUncontrolledOpen === current.setUncontrolledOpen
    && previous.openingTarget === current.openingTarget
  );
}

function rootAuthoritiesMatchExceptOpen(previous: DialogRootAuthority, current: DialogRootAuthority) {
  return (
    previous.mount === current.mount
    && previous.controlled === current.controlled
    && previous.actualOpen
    && !current.actualOpen
    && (previous.controlled
      ? previous.open === true && current.open === false
      : previous.open === undefined && current.open === undefined)
    && previous.defaultOpen === current.defaultOpen
    && previous.modal === current.modal
    && previous.setUncontrolledOpen === current.setUncontrolledOpen
    && previous.openingTarget === current.openingTarget
  );
}

function dialogAuthoritiesMatch(
  previous: DialogAuthority,
  current: DialogAuthority,
  includeRevision = true,
) {
  return (
    previous.mount === current.mount
    && (!includeRevision || previous.revision === current.revision)
    && previous.root === current.root
    && previous.title === current.title
    && previous.description === current.description
    && previous.children === current.children
    && previous.classNameInput === current.classNameInput
    && previous.className === current.className
    && previous.wide === current.wide
    && previous.onClosed === current.onClosed
    && previous.opener === current.opener
    && previous.initialFocus === current.initialFocus
  );
}

function dialogAuthoritiesMatchForClose(previous: DialogAuthority, current: DialogAuthority) {
  return (
    previous.mount === current.mount
    && rootAuthoritiesMatchExceptOpen(previous.root, current.root)
    && previous.title === current.title
    && previous.description === current.description
    && previous.classNameInput === current.classNameInput
    && previous.className === current.className
    && previous.wide === current.wide
    && previous.opener === current.opener
    && previous.initialFocus === current.initialFocus
  );
}

function ownerElements(owners: DialogElementOwners, modal: boolean): DialogElements | null {
  const overlay = owners.overlay.element();
  const content = owners.content.element();
  const header = owners.header.element();
  const title = owners.title.element();
  const description = owners.description.element();
  const close = owners.close.element();
  const icon = owners.icon.element();
  const body = owners.body.element();
  return (
    content instanceof HTMLDivElement
    && header instanceof HTMLDivElement
    && title instanceof HTMLHeadingElement
    && description instanceof HTMLParagraphElement
    && close instanceof HTMLButtonElement
    && icon instanceof SVGSVGElement
    && body instanceof HTMLDivElement
    && ((modal && overlay instanceof HTMLDivElement) || (!modal && overlay === null))
  )
    ? { overlay, content, header, title, description, close, icon, body }
    : null;
}

function staticTopologyMatches(
  authority: DialogAuthority,
  elements: DialogElements,
  state: "open" | "closed",
  allowPendingAria = false,
) {
  const { overlay, content, header, title, description, close, icon, body } = elements;
  const ownerDocument = content.ownerDocument;
  const view = ownerDocument.defaultView;
  const titleGroup = title.parentElement;
  const expectedDescriptionClass = authority.description !== undefined
    ? DESCRIPTION_CLASS_NAME
    : HIDDEN_DESCRIPTION_CLASS_NAME;
  const ariaIsExact = (
    content.getAttribute("aria-labelledby") === title.id
    && content.getAttribute("aria-describedby") === description.id
  );
  const ariaIsPending = (
    allowPendingAria
    && content.getAttribute("aria-labelledby") === null
    && content.getAttribute("aria-describedby") === null
  );
  const overlayIsExact = authority.root.modal
    ? Boolean(
      overlay
      && overlay.isConnected
      && overlay.ownerDocument === ownerDocument
      && overlay.parentNode === content.parentNode
      && overlay.nextSibling === content
      && overlay.tagName === "DIV"
      && overlay.getAttribute("class") === OVERLAY_CLASS_NAME
      && overlay.getAttribute("data-state") === state,
    )
    : overlay === null;
  return Boolean(
    view
    && overlayIsExact
    && content.isConnected
    && header.ownerDocument === ownerDocument
    && title.ownerDocument === ownerDocument
    && description.ownerDocument === ownerDocument
    && close.ownerDocument === ownerDocument
    && icon.ownerDocument === ownerDocument
    && body.ownerDocument === ownerDocument
    && content.tagName === "DIV"
    && content.getAttribute("role") === "dialog"
    && content.getAttribute("data-state") === state
    && content.getAttribute("class") === authority.className
    && (ariaIsExact || ariaIsPending)
    && content.children.length >= 1
    && content.childNodes.length >= 1
    && content.firstElementChild === header
    && content.firstChild === header
    && body === content
    && header.parentElement === content
    && header.tagName === "DIV"
    && header.getAttribute("class") === HEADER_CLASS_NAME
    && header.hasAttribute("data-focus-skip")
    && header.children.length === 2
    && header.childNodes.length === 2
    && titleGroup instanceof view.HTMLDivElement
    && header.firstElementChild === titleGroup
    && titleGroup.children.length === 2
    && titleGroup.childNodes.length === 2
    && titleGroup.firstElementChild === title
    && titleGroup.lastElementChild === description
    && title.tagName === "H2"
    && title.getAttribute("class") === TITLE_CLASS_NAME
    && title.textContent === authority.title
    && description.tagName === "P"
    && description.getAttribute("class") === expectedDescriptionClass
    && description.textContent === (authority.description ?? authority.title)
    && close.parentElement === header
    && header.lastElementChild === close
    && close.tagName === "BUTTON"
    && close.type === "button"
    && !close.disabled
    && !close.matches(":disabled")
    && close.getAttribute("aria-label") === "Close"
    && close.getAttribute("class") === CLOSE_CLASS_NAME
    && close.children.length === 1
    && close.childNodes.length === 1
    && close.firstElementChild === icon
    && icon.parentElement === close
    && icon.tagName.toLowerCase() === "svg"
    && icon.classList.contains("lucide-x")
    && icon.getAttribute("width") === "16"
    && icon.getAttribute("height") === "16"
    && icon.getAttribute("aria-hidden") === "true"
  );
}

function sameDialogElements(previous: DialogElements, current: DialogElements) {
  return (
    previous.overlay === current.overlay
    && previous.content === current.content
    && previous.header === current.header
    && previous.title === current.title
    && previous.description === current.description
    && previous.close === current.close
    && previous.icon === current.icon
    && previous.body === current.body
  );
}

function exactNativeCloseClick(
  event: React.MouseEvent<HTMLButtonElement>,
  publication: DialogPublication,
) {
  if (!event || typeof event !== "object") return null;
  const { close, content } = publication.elements;
  const ownerDocument = publication.ownerDocument;
  const view = ownerDocument.defaultView;
  const nativeEvent = event.nativeEvent;
  const target = event.target;
  const path = nativeEvent?.composedPath?.() ?? [];
  const reactEvent = event as React.MouseEvent<HTMLButtonElement> & {
    isDefaultPrevented?: unknown;
    isPropagationStopped?: unknown;
    persist?: unknown;
  };
  return (
    view
    && nativeEvent instanceof view.MouseEvent
    && nativeEvent.type === "click"
    && nativeEvent.button === 0
    && nativeEvent.eventPhase !== view.Event.NONE
    && nativeEvent.bubbles
    && nativeEvent.cancelable
    && !nativeEvent.defaultPrevented
    && event.type === "click"
    && event.button === 0
    && event.bubbles
    && !event.defaultPrevented
    && event.currentTarget === close
    && nativeEvent.target === target
    && isNodeFromDocument(target, ownerDocument)
    && close.contains(target)
    && path[0] === target
    && path.includes(close)
    && path.includes(content)
    && snapshotContains(publication.contentDom, target)
    && typeof reactEvent.isDefaultPrevented === "function"
    && !reactEvent.isDefaultPrevented()
    && typeof reactEvent.isPropagationStopped === "function"
    && !reactEvent.isPropagationStopped()
    && typeof reactEvent.persist === "function"
  )
    ? nativeEvent
    : null;
}

function exactNativeOwnedCloseClick(
  event: React.MouseEvent<HTMLElement>,
  publication: DialogPublication,
) {
  const ownerDocument = publication.ownerDocument;
  const view = ownerDocument.defaultView;
  const close = event?.currentTarget;
  if (!view || !(close instanceof view.HTMLElement)) return null;
  const nativeEvent = event.nativeEvent;
  const target = event.target;
  const path = nativeEvent?.composedPath?.() ?? [];
  return (
    nativeEvent instanceof view.MouseEvent
    && nativeEvent.type === "click"
    && nativeEvent.button === 0
    && nativeEvent.eventPhase !== view.Event.NONE
    && nativeEvent.bubbles
    && nativeEvent.cancelable
    && !nativeEvent.defaultPrevented
    && event.type === "click"
    && event.button === 0
    && event.bubbles
    && !event.defaultPrevented
    && (!(close instanceof view.HTMLButtonElement)
      || (close.type === "button" && !close.disabled))
    && publication.elements.content.contains(close)
    && nativeEvent.target === target
    && isNodeFromDocument(target, ownerDocument)
    && close.contains(target)
    && path[0] === target
    && path.includes(close)
    && path.includes(publication.elements.content)
    && contentSnapshotContains(
      publication.contentDom,
      publication.elements.header,
      close,
    )
    && contentSnapshotContains(
      publication.contentDom,
      publication.elements.header,
      target,
    )
  )
    ? nativeEvent
    : null;
}

function exactNativeTriggerCloseClick(
  event: React.MouseEvent<HTMLElement>,
  publication: DialogPublication,
) {
  const ownerDocument = publication.ownerDocument;
  const view = ownerDocument.defaultView;
  const trigger = event?.currentTarget;
  if (!view || !(trigger instanceof view.HTMLElement)) return null;
  const nativeEvent = event.nativeEvent;
  const target = event.target;
  const path = nativeEvent?.composedPath?.() ?? [];
  return (
    nativeEvent instanceof view.MouseEvent
    && nativeEvent.type === "click"
    && nativeEvent.button === 0
    && nativeEvent.eventPhase !== view.Event.NONE
    && nativeEvent.bubbles
    && nativeEvent.cancelable
    && !nativeEvent.defaultPrevented
    && event.type === "click"
    && event.button === 0
    && event.bubbles
    && !event.defaultPrevented
    && (!(trigger instanceof view.HTMLButtonElement) || !trigger.disabled)
    && trigger.ownerDocument === ownerDocument
    && trigger.isConnected
    && !publication.elements.content.contains(trigger)
    && nativeEvent.target === target
    && isNodeFromDocument(target, ownerDocument)
    && trigger.contains(target)
    && path[0] === target
    && path.includes(trigger)
    && path.includes(ownerDocument)
  )
    ? nativeEvent
    : null;
}

function exactEscape(event: EscapeKeyEvent, publication: DialogPublication) {
  const ownerDocument = publication.ownerDocument;
  const view = ownerDocument.defaultView;
  const target = event?.target;
  const path = event?.composedPath?.() ?? [];
  const targetIsAccepted = isNodeFromDocument(target, ownerDocument)
    && (publication.elements.content.contains(target) || !publication.authority.root.modal);
  return (
    view
    && event instanceof view.KeyboardEvent
    && event.type === "keydown"
    && event.key === "Escape"
    && event.bubbles
    && event.cancelable
    && !event.defaultPrevented
    && event.eventPhase === view.Event.CAPTURING_PHASE
    && event.currentTarget === ownerDocument
    && targetIsAccepted
    && path[0] === target
    && (path.includes(publication.elements.content) || !publication.authority.root.modal)
    && path.includes(ownerDocument)
    && (contentSnapshotContains(
      publication.contentDom,
      publication.elements.header,
      target,
    ) || !publication.authority.root.modal)
  )
    ? event
    : null;
}

function bridgeableEscape(event: EscapeKeyEvent, publication: DialogPublication) {
  const ownerDocument = publication.ownerDocument;
  const view = ownerDocument.defaultView;
  const target = event?.target;
  return Boolean(
    view
    && event instanceof view.KeyboardEvent
    && event.type === "keydown"
    && event.key === "Escape"
    && event.bubbles
    && event.cancelable
    && !event.defaultPrevented
    && isNodeFromDocument(target, ownerDocument)
    && publication.elements.content.contains(target)
    && contentSnapshotContains(
      publication.contentDom,
      publication.elements.header,
      target,
    )
  );
}

function exactOutsideFocus(event: FocusOutsideEvent, publication: DialogPublication) {
  const ownerDocument = publication.ownerDocument;
  const view = ownerDocument.defaultView;
  const target = event?.target;
  const originalEvent = event?.detail?.originalEvent;
  const path = event?.composedPath?.() ?? [];
  return (
    view
    && !publication.authority.root.modal
    && event instanceof view.CustomEvent
    && event.type === "dismissableLayer.focusOutside"
    && event.eventPhase === view.Event.AT_TARGET
    && event.currentTarget === target
    && originalEvent instanceof view.FocusEvent
    && originalEvent.type === "focusin"
    && originalEvent.target === target
    && !originalEvent.defaultPrevented
    && isNodeFromDocument(target, ownerDocument)
    && !publication.elements.content.contains(target)
    && path[0] === target
  )
    ? originalEvent
    : null;
}

function exactAutoFocusEvent(
  event: OpenAutoFocusEvent | CloseAutoFocusEvent,
  type: "focusScope.autoFocusOnMount" | "focusScope.autoFocusOnUnmount",
  content: HTMLDivElement,
) {
  const ownerDocument = content.ownerDocument;
  const view = ownerDocument.defaultView;
  const path = event?.composedPath?.() ?? [];
  return Boolean(
    view
    && event instanceof view.CustomEvent
    && event.type === type
    && event.target === content
    && event.currentTarget === content
    && event.eventPhase === view.Event.AT_TARGET
    && !event.bubbles
    && event.cancelable
    && !event.composed
    && event.detail === null
    && path[0] === content
  );
}

function exactFocusOut(event: FocusEvent, publication: DialogPublication) {
  const ownerDocument = publication.ownerDocument;
  const view = ownerDocument.defaultView;
  const target = event?.target;
  const relatedTarget = event?.relatedTarget;
  const path = event?.composedPath?.() ?? [];
  return (
    view
    && event instanceof view.FocusEvent
    && event.type === "focusout"
    && event.bubbles
    && event.composed
    && !event.defaultPrevented
    && (event.eventPhase === view.Event.AT_TARGET || event.eventPhase === view.Event.BUBBLING_PHASE)
    && event.currentTarget === publication.elements.content
    && isNodeFromDocument(target, ownerDocument)
    && publication.elements.content.contains(target)
    && path[0] === target
    && path.includes(publication.elements.content)
    && relatedTarget instanceof view.HTMLElement
    && relatedTarget.ownerDocument === ownerDocument
    && !publication.elements.content.contains(relatedTarget)
  )
    ? relatedTarget
    : null;
}

function exactOutsidePointer(event: PointerDownOutsideEvent, publication: DialogPublication) {
  const ownerDocument = publication.ownerDocument;
  const view = ownerDocument.defaultView;
  const target = event?.target;
  const originalEvent = event?.detail?.originalEvent;
  const path = event?.composedPath?.() ?? [];
  const PointerEventConstructor = view?.PointerEvent;
  const isPointerEvent = Boolean(
    view
    && originalEvent
    && ((PointerEventConstructor && originalEvent instanceof PointerEventConstructor)
      || originalEvent instanceof view.MouseEvent),
  );
  return (
    view
    && event instanceof view.CustomEvent
    && event.type === "dismissableLayer.pointerDownOutside"
    && event.eventPhase === view.Event.AT_TARGET
    && event.currentTarget === target
    && isNodeFromDocument(target, ownerDocument)
    && !publication.elements.content.contains(target)
    && path[0] === target
    && isPointerEvent
    && originalEvent.type === "pointerdown"
    && originalEvent.button === 0
    && originalEvent.target === target
    && !originalEvent.defaultPrevented
  )
    ? originalEvent
    : null;
}

class DialogCoordinator {
  readonly #mount: symbol;
  #root: DialogRootAuthority | null = null;
  #active: DialogPublication | null = null;
  #successorOf: DialogPublication | null = null;
  #replay: DialogReplay | null = null;
  #pendingDismiss: PendingDismiss | null = null;
  #parentDismissBridge: ParentDismissBridge | null = null;
  #transition: CloseTransition | null = null;
  #retired = new WeakSet<DialogPublication>();
  #claimedReactEvents = new WeakSet<object>();
  #claimedNativeEvents = new WeakSet<object>();
  #knownCloseActions = new WeakMap<object, DialogPublication>();
  #knownAutoFocusActions = new WeakMap<object, DialogPublication>();
  #ownedActionBindings = new WeakMap<object, OwnedActionBinding>();
  #currentOwnedActions = new WeakMap<HTMLElement, object>();
  #renderedOpen: boolean | null = null;
  #openingTarget: HTMLElement | null = null;
  #managed = false;

  constructor(mount: symbol) {
    this.#mount = mount;
  }

  captureOpeningTarget(open: boolean) {
    if (open && this.#renderedOpen !== true) this.#openingTarget = currentFocusReturnTarget();
    this.#renderedOpen = open;
    return this.#openingTarget;
  }

  activateRoot(authority: DialogRootAuthority) {
    if (authority.mount === this.#mount) this.#root = authority;
  }

  deactivateRoot(authority: DialogRootAuthority) {
    if (this.#root !== authority) return;
    this.#root = null;
    queueMicrotask(() => {
      if (this.#root) return;
      const publications = new Set([
        this.#active,
        this.#successorOf,
        this.#replay?.source ?? null,
        this.#transition?.source ?? null,
      ]);
      for (const publication of publications) {
        publication?.detachOpening();
        publication?.journal.release();
      }
      this.#replay?.release();
      this.#active = null;
      this.#successorOf = null;
      this.#replay = null;
      this.#transition = null;
      this.#pendingDismiss = null;
      this.#parentDismissBridge = null;
    });
  }

  active() {
    return this.#active;
  }

  ownsRoot(authority: DialogRootAuthority) {
    return this.#root === authority && authority.mount === this.#mount;
  }

  replay() {
    return this.#replay;
  }

  acceptsSuccessorOf(publication: DialogPublication) {
    return (
      this.#active === null
      && this.#successorOf === publication
      && this.#retired.has(publication)
      && !publication.closed
    );
  }

  stageReplay(replay: DialogReplay) {
    if (!this.acceptsSuccessorOf(replay.source)) return false;
    this.#replay = replay;
    return true;
  }

  abandonReplay(publication: DialogPublication, preserveSuccessor = false) {
    if (this.#replay?.source === publication) {
      this.#replay.release();
      this.#replay = null;
    }
    if (!preserveSuccessor && this.#successorOf === publication) this.#successorOf = null;
  }

  acceptReplay(publication: DialogPublication) {
    if (this.#replay?.source !== publication || this.#successorOf !== publication) return false;
    this.#replay.release();
    this.#replay = null;
    return true;
  }

  publish(publication: DialogPublication) {
    if (
      publication.authority.root.mount !== this.#mount
      || this.#retired.has(publication)
      || !publication.authority.root.actualOpen
    ) {
      return false;
    }
    const previous = this.#active;
    const successor = this.#successorOf;
    const replay = this.#replay;
    if (previous && previous !== publication) {
      previous.retire();
      previous.journal.release();
    }
    if (this.#transition) {
      this.#transition.source.journal.release();
      this.#transition = null;
    }
    if (replay) {
      replay.release();
      this.#replay = null;
    } else if (successor && successor !== publication) {
      successor.journal.release();
    }
    this.#managed = true;
    this.#active = publication;
    this.#successorOf = null;
    this.#pendingDismiss = null;
    this.#parentDismissBridge = null;
    this.#knownCloseActions.set(publication.actions.closeAutoFocus, publication);
    this.#knownAutoFocusActions.set(publication.actions.openAutoFocus, publication);
    return true;
  }

  retire(publication: DialogPublication) {
    if (this.#retired.has(publication)) return false;
    this.#retired.add(publication);
    publication.detachOpening();
    if (this.#active === publication) {
      this.#active = null;
      this.#successorOf = publication;
    }
    if (this.#pendingDismiss?.publication === publication && !this.#transition) {
      this.#pendingDismiss = null;
    }
    if (this.#parentDismissBridge?.publication === publication) {
      this.#parentDismissBridge = null;
    }
    return true;
  }

  isCurrent(publication: DialogPublication) {
    return (
      this.#active === publication
      && !this.#retired.has(publication)
      && !publication.closed
      && this.#transition?.source !== publication
    );
  }

  bindOwnedAction(
    action: object,
    root: DialogRootAuthority,
    element: HTMLElement,
    kind: OwnedActionBinding["kind"],
  ) {
    const binding = { root, element, kind };
    this.#ownedActionBindings.set(action, binding);
    this.#currentOwnedActions.set(element, action);
    return () => {
      if (this.#currentOwnedActions.get(element) === action) {
        this.#currentOwnedActions.delete(element);
      }
      if (this.#ownedActionBindings.get(action) === binding) {
        this.#ownedActionBindings.delete(action);
      }
    };
  }

  #ownsAction(publication: DialogPublication, action: object, nativeEvent: Event) {
    if (Object.values(publication.actions).includes(action)) return true;
    const binding = this.#ownedActionBindings.get(action);
    const target = nativeEvent.target;
    if (
      !binding
      || binding.root !== publication.authority.root
      || this.#currentOwnedActions.get(binding.element) !== action
      || !binding.element.isConnected
      || binding.element.ownerDocument !== publication.ownerDocument
      || !isNodeFromDocument(target, publication.ownerDocument)
      || !binding.element.contains(target)
    ) {
      return false;
    }
    return binding.kind === "close"
      ? contentSnapshotContains(
          publication.contentDom,
          publication.elements.header,
          binding.element,
        )
      : !publication.elements.content.contains(binding.element);
  }

  custodyFor(authority: DialogAuthority, elements: DialogElements) {
    const replay = this.#replay;
    if (
      replay
      && this.acceptsSuccessorOf(replay.source)
      && dialogAuthoritiesMatch(replay.source.authority, authority, false)
      && sameDialogElements(replay.source.elements, elements)
    ) {
      return replay.source.custody;
    }
    const previous = this.#active ?? this.#successorOf;
    const candidate = authority.opener;
    if (
      previous
      && !previous.closed
      && (candidate === null
        || previous.elements.content.contains(candidate)
        || elements.content.contains(candidate))
    ) {
      return previous.custody;
    }
    return {
      opener: candidate,
      returnTarget: candidate,
      returnTargetClaimed: false,
    };
  }

  #claimEvent(reactEvent: object | null, nativeEvent: object) {
    if (
      (reactEvent && this.#claimedReactEvents.has(reactEvent))
      || this.#claimedNativeEvents.has(nativeEvent)
    ) {
      return false;
    }
    if (reactEvent) this.#claimedReactEvents.add(reactEvent);
    this.#claimedNativeEvents.add(nativeEvent);
    return true;
  }

  claimOpeningEvent(
    publication: DialogPublication,
    action: object,
    event: OpenAutoFocusEvent,
  ) {
    return (
      action === publication.actions.openAutoFocus
      && this.#knownAutoFocusActions.get(action) === publication
      && this.isCurrent(publication)
      && publication.exactOpenDomMatches()
      && this.#claimEvent(null, event)
    );
  }

  claimReplayOpeningEvent(
    publication: DialogPublication,
    action: object,
    event: OpenAutoFocusEvent,
  ) {
    return (
      action === publication.actions.openAutoFocus
      && this.#knownAutoFocusActions.get(action) === publication
      && this.acceptsSuccessorOf(publication)
      && this.#claimEvent(null, event)
    );
  }

  claimFocusOut(publication: DialogPublication, event: FocusEvent) {
    return (
      this.isCurrent(publication)
      && publication.opening
      && publication.exactOpenDomMatches()
      && this.#claimEvent(null, event)
    );
  }

  claimOpeningTimer(publication: DialogPublication, timer: TimerHandle) {
    return (
      this.isCurrent(publication)
      && publication.opening
      && publication.openingTimer === timer
      && publication.exactOpenDomMatches()
    );
  }

  beginDismiss(
    publication: DialogPublication,
    action: object,
    reactEvent: object | null,
    nativeEvent: Event,
  ) {
    if (
      !this.isCurrent(publication)
      || publication.authority.root !== this.#root
      || !this.#ownsAction(publication, action, nativeEvent)
      || !publication.exactOpenDomMatches()
      || !this.#claimEvent(reactEvent, nativeEvent)
    ) {
      return false;
    }
    this.#pendingDismiss = {
      publication,
      root: publication.authority.root,
      action,
    };
    this.#parentDismissBridge = null;
    return true;
  }

  stageCloseBridge(
    publication: DialogPublication,
    action: object,
    event: React.MouseEvent<HTMLButtonElement>,
  ) {
    if (
      !this.isCurrent(publication)
      || publication.authority.root !== this.#root
      || action !== publication.actions.closeClick
      || event?.currentTarget !== publication.elements.close
      || event.defaultPrevented
      || !publication.exactOpenDomMatches()
    ) {
      return false;
    }
    this.#parentDismissBridge = {
      publication,
      root: publication.authority.root,
      action,
    };
    return true;
  }

  stageEscapeBridge(
    publication: DialogPublication,
    action: object,
    event: EscapeKeyEvent,
  ) {
    if (
      !this.isCurrent(publication)
      || publication.authority.root !== this.#root
      || action !== publication.actions.escape
      || !bridgeableEscape(event, publication)
      || !publication.exactOpenDomMatches()
    ) {
      return false;
    }
    this.#parentDismissBridge = {
      publication,
      root: publication.authority.root,
      action,
    };
    return true;
  }

  consumeParentDismissBridge(authority: DialogRootAuthority) {
    const bridge = this.#parentDismissBridge;
    this.#parentDismissBridge = null;
    return Boolean(
      bridge
      && bridge.root === authority
      && (bridge.action === bridge.publication.actions.closeClick
        || bridge.action === bridge.publication.actions.escape)
      && this.isCurrent(bridge.publication)
      && bridge.publication.exactOpenDomMatches()
    );
  }

  claimInteraction(
    publication: DialogPublication,
    action: object,
    nativeEvent: Event,
  ) {
    return (
      this.isCurrent(publication)
      && publication.authority.root === this.#root
      && action === publication.actions.escape
      && publication.exactOpenDomMatches()
      && this.#claimEvent(null, nativeEvent)
    );
  }

  requestOpenChange(authority: DialogRootAuthority, open: boolean) {
    if (this.#root !== authority || authority.mount !== this.#mount) return false;
    if (open) return !authority.actualOpen;
    if (!this.#managed) return authority.actualOpen;
    const pending = this.#pendingDismiss;
    if (
      !pending
      || pending.root !== authority
      || !this.isCurrent(pending.publication)
      || !pending.publication.journal.startClosing()
    ) {
      return false;
    }
    this.#pendingDismiss = null;
    this.#parentDismissBridge = null;
    const transition: CloseTransition = {
      source: pending.publication,
      authority: pending.publication.authority,
      closeAction: pending.publication.actions.closeAutoFocus,
      custody: pending.publication.custody,
      onClosed: pending.publication.authority.onClosed,
      claimed: false,
    };
    this.#transition = transition;
    if (authority.controlled) {
      queueMicrotask(() => {
        if (
          this.#transition !== transition
          || this.#root !== authority
          || !authority.actualOpen
        ) {
          return;
        }
        this.#transition = null;
        transition.source.retire();
        transition.source.requestSuccessor();
      });
    }
    return true;
  }

  stageControlledClose(
    authority: DialogAuthority,
    closeAction: object,
    elements: DialogElements,
  ) {
    const source = this.#active ?? this.#successorOf;
    if (
      !source
      || source.closed
      || !dialogAuthoritiesMatchForClose(source.authority, authority)
      || !sameDialogElements(source.elements, elements)
      || !staticTopologyMatches(authority, elements, "closed")
      || !source.journal.startClosing()
    ) {
      return false;
    }
    source.retire();
    this.#pendingDismiss = null;
    this.#transition = {
      source,
      authority,
      closeAction,
      custody: source.custody,
      onClosed: source.authority.onClosed,
      claimed: false,
    };
    this.#knownCloseActions.set(closeAction, source);
    return true;
  }

  #lazyDetachedTransition(publication: DialogPublication, authority: DialogAuthority, action: object) {
    if (
      this.#active !== null
      || this.#successorOf !== publication
      || publication.closed
      || publication.elements.content.isConnected
      || !dialogAuthoritiesMatch(publication.authority, authority)
      || !publication.journal.startClosing()
    ) {
      return null;
    }
    const transition: CloseTransition = {
      source: publication,
      authority,
      closeAction: action,
      custody: publication.custody,
      onClosed: publication.authority.onClosed,
      claimed: false,
    };
    this.#transition = transition;
    return transition;
  }

  claimCloseEvent(authority: DialogAuthority, action: object, event: CloseAutoFocusEvent) {
    let publication = this.#knownCloseActions.get(action);
    if (!publication) {
      const existingTransition = this.#transition;
      if (
        existingTransition
        && !existingTransition.claimed
        && dialogAuthoritiesMatchForClose(existingTransition.source.authority, authority)
      ) {
        publication = existingTransition.source;
        this.#transition = {
          source: publication,
          authority,
          closeAction: action,
          custody: existingTransition.custody,
          onClosed: existingTransition.onClosed,
          claimed: false,
        };
        this.#knownCloseActions.set(action, publication);
      }
      const source = publication ? null : this.#active ?? this.#successorOf;
      if (
        source
        && !source.closed
        && dialogAuthoritiesMatchForClose(source.authority, authority)
        && source.journal.startClosing()
      ) {
        publication = source;
        source.retire();
        this.#transition = {
          source,
          authority,
          closeAction: action,
          custody: source.custody,
          onClosed: source.authority.onClosed,
          claimed: false,
        };
        this.#knownCloseActions.set(action, source);
      }
    }
    if (!publication || !this.#claimEvent(null, event)) return "reject" as const;
    const transition = this.#transition?.closeAction === action
      ? this.#transition
      : this.#lazyDetachedTransition(publication, authority, action);
    if (
      !transition
      || transition.claimed
      || transition.source !== publication
      || transition.source.closed
      || (this.#active !== null && this.#active !== publication)
      || !transition.source.journal.closeHistoryIsValid()
      || (transition.source.elements.content.isConnected
        && transition.source.elements.content.getAttribute("data-state") !== "closed")
    ) {
      return "neutralize" as const;
    }
    transition.claimed = true;
    publication.closed = true;
    publication.detachOpening();
    if (this.#active === publication) this.#active = null;
    if (this.#successorOf === publication) this.#successorOf = null;
    return transition;
  }

  finishClose(transition: CloseTransition) {
    if (this.#transition !== transition || !transition.claimed) return;
    const returnTarget = transition.custody.returnTarget;
    transition.custody.returnTarget = null;
    transition.source.journal.release();
    this.#transition = null;
    restoreFocus(returnTarget);
    transition.onClosed?.();
  }
}

const DialogContext = React.createContext<DialogContextValue | null>(null);

function createRootPresentation(
  authority: DialogRootAuthority,
  coordinator: DialogCoordinator,
): DialogRootPresentation {
  const onOpenChange = (open: boolean) => {
    if (typeof open !== "boolean" || open === authority.actualOpen) return;
    const accepted = coordinator.requestOpenChange(authority, open);
    const bridged = (
      !accepted
      && !open
      && coordinator.ownsRoot(authority)
      && coordinator.consumeParentDismissBridge(authority)
    );
    if (!accepted && !bridged) return;
    if (!authority.controlled) authority.setUncontrolledOpen(open);
    authority.onOpenChange?.(open);
  };
  return Object.freeze({ authority, onOpenChange });
}

export function Dialog({
  open,
  defaultOpen,
  modal = true,
  onOpenChange,
  children,
  ...props
}: DialogRootProps) {
  const [mount] = React.useState(() => Symbol("dialog-root"));
  const [coordinator] = React.useState(() => new DialogCoordinator(mount));
  const [uncontrolledOpen, setUncontrolledOpen] = React.useState(defaultOpen ?? false);
  const [cache] = React.useState(
    () => new PresentationCache<DialogRootAuthority, DialogRootPresentation>(),
  );
  const controlled = open !== undefined;
  const actualOpen = controlled ? open : uncontrolledOpen;
  const openingTarget = coordinator.captureOpeningTarget(actualOpen);
  const candidate: DialogRootAuthority = Object.freeze({
    identity: Symbol("dialog-root-render"),
    mount,
    actualOpen,
    controlled,
    open,
    defaultOpen,
    modal,
    onOpenChange,
    setUncontrolledOpen,
    openingTarget,
  });
  const presentation = cache.resolve(
    candidate,
    actualOpen ? 1 : 0,
    rootAuthoritiesMatch,
    () => createRootPresentation(candidate, coordinator),
  );
  const authority = presentation.authority;

  React.useLayoutEffect(() => {
    coordinator.activateRoot(authority);
    return () => coordinator.deactivateRoot(authority);
  }, [authority, coordinator]);

  const context = React.useMemo<DialogContextValue>(
    () => Object.freeze({ root: authority, coordinator }),
    [authority, coordinator],
  );

  return (
    <DialogContext.Provider value={context}>
      <RadixDialog.Root
        {...props}
        open={actualOpen}
        modal={modal}
        onOpenChange={presentation.onOpenChange}
      >
        {children}
      </RadixDialog.Root>
    </DialogContext.Provider>
  );
}

export const DialogPortal = RadixDialog.Portal;
export const DialogOverlay = RadixDialog.Overlay;
export const DialogTitle = RadixDialog.Title;
/** Unstyled Radix content for drawers and sheets; `DialogContent` below is the centred card. */
export const DialogPrimitiveContent = RadixDialog.Content;

export const DialogTrigger = React.forwardRef<
  React.ElementRef<typeof RadixDialog.Trigger>,
  React.ComponentPropsWithoutRef<typeof RadixDialog.Trigger>
>(function DialogTrigger({ onClick, ...props }, forwardedRef) {
  const inherited = React.useContext(DialogContext);
  const action = Object.freeze({
    identity: Symbol("dialog-owned-trigger"),
  });
  const handleClick = (event: React.MouseEvent<HTMLButtonElement>) => {
    onClick?.(event);
    if (event.defaultPrevented) return;
    const coordinator = inherited?.coordinator;
    const publication = coordinator?.active();
    if (!coordinator || !publication || !publication.authority.root.actualOpen) return;
    const nativeEvent = exactNativeTriggerCloseClick(event, publication);
    if (nativeEvent) {
      coordinator.beginDismiss(publication, action, event, nativeEvent);
    }
  };
  const elementRef = React.useRef<HTMLButtonElement | null>(null);
  const capture = useComposedRefs(elementRef, forwardedRef);
  React.useLayoutEffect(() => {
    const coordinator = inherited?.coordinator;
    const root = inherited?.root;
    const element = elementRef.current;
    if (!coordinator || !root || !element) return;
    return coordinator.bindOwnedAction(action, root, element, "trigger");
  }, [action, inherited]);
  return <RadixDialog.Trigger {...props} ref={capture} onClick={handleClick} />;
});

export const DialogClose = React.forwardRef<
  React.ElementRef<typeof RadixDialog.Close>,
  React.ComponentPropsWithoutRef<typeof RadixDialog.Close>
>(function DialogClose({ onClick, ...props }, forwardedRef) {
  const inherited = React.useContext(DialogContext);
  const action = Object.freeze({
    identity: Symbol("dialog-owned-close"),
  });
  const handleClick = (event: React.MouseEvent<HTMLButtonElement>) => {
    onClick?.(event);
    if (event.defaultPrevented) return;
    const coordinator = inherited?.coordinator;
    const publication = coordinator?.active();
    if (!coordinator || !publication) return;
    const nativeEvent = exactNativeOwnedCloseClick(event, publication);
    if (nativeEvent) {
      coordinator.beginDismiss(publication, action, event, nativeEvent);
    }
  };
  const elementRef = React.useRef<HTMLButtonElement | null>(null);
  const capture = useComposedRefs(elementRef, forwardedRef);
  React.useLayoutEffect(() => {
    const coordinator = inherited?.coordinator;
    const root = inherited?.root;
    const element = elementRef.current;
    if (!coordinator || !root || !element) return;
    return coordinator.bindOwnedAction(action, root, element, "close");
  }, [action, inherited]);
  return <RadixDialog.Close {...props} ref={capture} onClick={handleClick} />;
});

interface DialogPresentation {
  readonly captureOverlay: (element: HTMLDivElement | null) => void | (() => void);
  readonly captureContent: (element: HTMLDivElement | null) => void | (() => void);
  readonly captureHeader: (element: HTMLDivElement | null) => void | (() => void);
  readonly captureTitle: (element: HTMLHeadingElement | null) => void | (() => void);
  readonly captureDescription: (element: HTMLParagraphElement | null) => void | (() => void);
  readonly captureClose: (element: HTMLButtonElement | null) => void | (() => void);
  readonly captureIcon: (element: SVGSVGElement | null) => void | (() => void);
  readonly establish: () => void | (() => void);
  readonly onOpenAutoFocus: (event: OpenAutoFocusEvent) => void;
  readonly onCloseAutoFocus: (event: CloseAutoFocusEvent) => void;
  readonly onEscapeKeyDown: (event: EscapeKeyEvent) => void;
  readonly onPointerDownOutside: (event: PointerDownOutsideEvent) => void;
  readonly onFocusOutside: (event: FocusOutsideEvent) => void;
  readonly onCloseClick: (event: React.MouseEvent<HTMLButtonElement>) => void;
}

function createPublicationRuntime(
  authority: DialogAuthority,
  coordinator: DialogCoordinator,
  owners: DialogElementOwners,
  elements: DialogElements,
  actions: DialogActions,
  onFocusOut: (event: FocusEvent) => void,
  layoutReplaySeen: () => boolean,
  requestSuccessor: () => void,
): PublicationRuntime {
  const overlayDom = elements.overlay ? snapshotDom(elements.overlay) : null;
  const contentDom = snapshotDom(elements.content);
  let successorRequested = false;
  const journal = new MutationJournal(elements, () => {
    if (
      successorRequested
      || (elements.overlay !== null && !elements.overlay.isConnected)
      || !elements.content.isConnected
      || contentDomMatches(contentDom, elements.header)
    ) {
      return;
    }
    successorRequested = true;
    requestSuccessor();
  });
  const custody = coordinator.custodyFor(authority, elements);
  let retired = false;
  let retirement: Retirement | null = null;
  let established = false;
  let layoutRetired = false;
  let invalidReplay = false;
  let replayRefs: RefReplay[] = [];
  const allOwners = Object.freeze(
    Object.values(owners).filter((owner) =>
      owner !== owners.body && (elements.overlay !== null || owner !== owners.overlay)) as ElementOwnerView[],
  );
  const exactOpenDomMatches = () => (
    journal.isClean()
    && staticTopologyMatches(authority, elements, "open")
    && (overlayDom === null || domMatches(overlayDom))
    && contentDomMatches(contentDom, elements.header)
  );
  const replayDomMatches = () => (
    journal.isClean()
    && staticTopologyMatches(authority, elements, "open", true)
    && (overlayDom === null || domMatches(overlayDom))
    && contentDomMatches(contentDom, elements.header)
  );
  const detachOpening = () => {
    const timer = publication.openingTimer;
    if (timer !== null) {
      publication.openingTimer = null;
      publication.ownerDocument.defaultView?.clearTimeout(timer);
    }
    if (publication.listenerAttached) {
      publication.listenerAttached = false;
      elements.content.removeEventListener("focusout", onFocusOut);
    }
    publication.opening = false;
  };
  const retire = (reason: Retirement = "other") => {
    if (retired) return false;
    retired = true;
    retirement = reason;
    coordinator.retire(publication);
    return true;
  };
  const publication: DialogPublication = {
    identity: Symbol("dialog-publication"),
    authority,
    elements,
    actions,
    ownerDocument: elements.content.ownerDocument,
    overlayDom,
    contentDom,
    closeTargets: descendantsOf(elements.close),
    journal,
    custody,
    requestSuccessor,
    retire,
    isRetired: () => retired,
    exactOpenDomMatches,
    detachOpening,
    opening: true,
    openingTimer: null,
    listenerAttached: false,
    closed: false,
  };
  const refsHaveNoReplay = () =>
    !invalidReplay
    && replayRefs.every((entry) =>
      !entry.detached
      && !entry.reattached
      && entry.owner.element() === entry.element);
  const refsHaveExactReplay = () =>
    !invalidReplay
    && replayRefs.length === allOwners.length
    && replayRefs.every((entry) => (
      (entry.owner === owners.content && !entry.detached && !entry.reattached)
      || (entry.detached && entry.reattached)
    ) && entry.owner.element() === entry.element);

  const runtime: PublicationRuntime = Object.freeze({
    publication,
    publish: () => {
      established = true;
      replayRefs = allOwners.map((owner) => {
        const element = owner.element();
        if (!element) throw new Error("Cannot publish a dialog without every committed ref");
        return { owner, element, detached: false, reattached: false };
      });
      if (!coordinator.publish(publication)) {
        journal.release();
        return false;
      }
      publication.listenerAttached = true;
      elements.content.addEventListener("focusout", onFocusOut);
      return true;
    },
    scheduleOpeningRecovery: () => {
      if (!publication.opening || publication.openingTimer !== null) return;
      const ownerWindow = publication.ownerDocument.defaultView;
      if (!ownerWindow) return;
      const recoverOpeningFocus = () => {
        const timer = publication.openingTimer;
        if (timer === null || !coordinator.claimOpeningTimer(publication, timer)) return;
        publication.openingTimer = null;
        publication.opening = false;
        if (publication.listenerAttached) {
          publication.listenerAttached = false;
          elements.content.removeEventListener("focusout", onFocusOut);
        }
        if (
          !elements.content.isConnected
          || elements.content.contains(publication.ownerDocument.activeElement)
        ) {
          return;
        }
        (firstTabbable(elements.body) ?? elements.content).focus({ preventScroll: true });
      };
      publication.openingTimer = ownerWindow.setTimeout(recoverOpeningFocus, 0);
    },
    retireForElement: () => {
      retire("element");
    },
    retireForLayout: () => {
      layoutRetired = true;
      journal.startReplay();
      retire("layout");
    },
    noteRef: (
      owner: ElementOwnerView,
      element: Element | null,
      previous: Element | null,
    ) => {
      if (!established) return;
      if (owner === owners.body || (elements.overlay === null && owner === owners.overlay)) return;
      const proof = replayRefs.find((entry) => entry.owner === owner);
      if (!proof) {
        invalidReplay = true;
        return;
      }
      if (element === null && previous === proof.element) {
        proof.detached = true;
        proof.reattached = false;
      } else if (element === proof.element && previous === null && proof.detached) {
        proof.reattached = true;
      } else if (element !== previous) {
        invalidReplay = true;
      }
      if (!retired && replayRefs.every((entry) => entry.owner.element() === entry.element)) {
        for (const entry of replayRefs) {
          entry.detached = false;
          entry.reattached = false;
        }
        invalidReplay = false;
      }
    },
    isExactElementReplay: () => {
      const refs = refsHaveExactReplay();
      return retired
        && retirement === "element"
        && (layoutRetired || layoutReplaySeen())
        && refs
        && replayDomMatches();
    },
    isExactLayoutReplay: () => {
      const refs = refsHaveNoReplay() || refsHaveExactReplay();
      return retired && retirement === "layout" && refs && replayDomMatches();
    },
    replayDomMatches,
    replay: () => Object.freeze({
      source: publication,
      historyIsClean: journal.isClean.bind(journal),
      release: journal.release.bind(journal),
    }),
  });
  return runtime;
}

function createDialogPresentation(
  authority: DialogAuthority,
  coordinator: DialogCoordinator,
  requestSuccessor: () => void,
): DialogPresentation {
  let currentRuntime: PublicationRuntime | null = null;
  let lastRuntime: PublicationRuntime | null = null;
  let successorRequested = false;
  let layoutActive = false;
  let layoutSetups = 0;
  const {
    mount,
    revision,
    root,
    title,
    description,
    children,
    classNameInput,
    className,
    wide,
    onClosed,
    opener,
    initialFocus,
  } = authority;
  const actions: DialogActions = Object.freeze({
    openAutoFocus: Object.freeze({ identity: Symbol("dialog-open-autofocus") }),
    closeAutoFocus: Object.freeze({ identity: Symbol("dialog-close-autofocus") }),
    closeClick: Object.freeze({ identity: Symbol("dialog-close-click") }),
    escape: Object.freeze({ identity: Symbol("dialog-escape") }),
    outsidePointer: Object.freeze({ identity: Symbol("dialog-outside-pointer") }),
    outsideFocus: Object.freeze({ identity: Symbol("dialog-outside-focus") }),
    focusOut: Object.freeze({ identity: Symbol("dialog-focusout") }),
    openingTimer: Object.freeze({ identity: Symbol("dialog-opening-timer") }),
  });
  const onElementChange = (
    owner: ElementOwnerView,
    element: Element | null,
    previous: Element | null,
    last: Element | null,
  ) => {
    if (owner === owners.body) {
      if (layoutActive) tryEstablish();
      return;
    }
    const runtime = currentRuntime ?? lastRuntime;
    runtime?.noteRef(owner, element, previous);
    if (element === null || (last !== null && element !== last)) {
      currentRuntime?.retireForElement();
      currentRuntime = null;
    }
    if (
      runtime
      && (runtime.isExactElementReplay() || runtime.isExactLayoutReplay())
      && coordinator.acceptsSuccessorOf(runtime.publication)
    ) {
      requestReplaySuccessor(runtime);
    }
    if (layoutActive) tryEstablish();
  };
  const owners: DialogElementOwners = {
    overlay: new ElementOwner<HTMLDivElement>(onElementChange),
    content: new ElementOwner<HTMLDivElement>(onElementChange),
    header: new ElementOwner<HTMLDivElement>(onElementChange),
    title: new ElementOwner<HTMLHeadingElement>(onElementChange),
    description: new ElementOwner<HTMLParagraphElement>(onElementChange),
    close: new ElementOwner<HTMLButtonElement>(onElementChange),
    icon: new ElementOwner<SVGSVGElement>(onElementChange),
    body: new ElementOwner<HTMLDivElement>(onElementChange),
  };
  const captureContentAndBody = (element: HTMLDivElement | null) => {
    const releaseContent = owners.content.capture(element);
    const releaseBody = owners.body.capture(element);
    if (!element) return;
    return () => {
      releaseBody?.();
      releaseContent?.();
    };
  };
  const authorityFactsMatch = () => (
    authority.mount === mount
    && authority.revision === revision
    && authority.root === root
    && authority.title === title
    && authority.description === description
    && authority.children === children
    && authority.classNameInput === classNameInput
    && authority.className === className
    && authority.wide === wide
    && authority.onClosed === onClosed
    && authority.opener === opener
    && authority.initialFocus === initialFocus
    && className === cn(
      "dialog animate-fade-in",
      wide && "w-[min(94vw,760px)]",
      classNameInput,
    )
    && typeof root.actualOpen === "boolean"
    && typeof root.controlled === "boolean"
    && typeof root.modal === "boolean"
    && root.actualOpen === (root.controlled ? root.open : root.actualOpen)
  );
  const requestReplaySuccessor = (runtime: PublicationRuntime) => {
    const replay = runtime.replay();
    const elements = ownerElements(owners, authority.root.modal);
    if (
      successorRequested
      || !elements
      || !coordinator.acceptsSuccessorOf(runtime.publication)
      || !dialogAuthoritiesMatch(runtime.publication.authority, authority, false)
      || !sameDialogElements(runtime.publication.elements, elements)
      || !runtime.replayDomMatches()
      || !replay.historyIsClean()
      || !coordinator.stageReplay(replay)
    ) {
      return;
    }
    successorRequested = true;
    requestSuccessor();
  };
  const adoptPortalRoots = () => {
    const header = owners.header.element();
    const content = header?.parentElement;
    if (
      !owners.content.element()
      && content instanceof HTMLDivElement
      && content.getAttribute("role") === "dialog"
    ) {
      owners.content.capture(content);
    }
    const committedContent = owners.content.element();
    if (!owners.body.element() && committedContent instanceof HTMLDivElement) {
      owners.body.capture(committedContent);
    }
    const overlay = committedContent?.previousSibling;
    if (
      !owners.overlay.element()
      && overlay instanceof HTMLDivElement
      && overlay.getAttribute("class") === OVERLAY_CLASS_NAME
    ) {
      owners.overlay.capture(overlay);
    }
  };
  const onFocusOut = (event: FocusEvent) => {
    const publication = currentRuntime?.publication;
    const relatedTarget = publication ? exactFocusOut(event, publication) : null;
    if (
      !publication
      || publication.actions.focusOut !== actions.focusOut
      || !relatedTarget
      || !coordinator.claimFocusOut(publication, event)
    ) {
      return;
    }
    const relatedDialog = relatedTarget.closest<HTMLElement>('[role="dialog"]');
    if (
      relatedDialog
      && relatedDialog !== publication.elements.content
      && relatedDialog.isConnected
      && relatedDialog.ownerDocument === publication.ownerDocument
    ) {
      return;
    }
    if (!publication.custody.returnTargetClaimed) {
      publication.custody.returnTarget = relatedTarget;
      publication.custody.returnTargetClaimed = true;
    }
    currentRuntime?.scheduleOpeningRecovery();
  };
  const tryEstablish = () => {
    adoptPortalRoots();
    const elements = ownerElements(owners, authority.root.modal);
    if (!elements || !authorityFactsMatch()) return undefined;
    const state = authority.root.actualOpen ? "open" : "closed";
    if (!staticTopologyMatches(authority, elements, state, authority.root.actualOpen)) return undefined;
    if (!authority.root.actualOpen) {
      coordinator.stageControlledClose(authority, actions.closeAutoFocus, elements);
      return undefined;
    }
    if (lastRuntime) {
      if (
        (lastRuntime.isExactLayoutReplay() || lastRuntime.isExactElementReplay())
        && coordinator.acceptsSuccessorOf(lastRuntime.publication)
      ) {
        requestReplaySuccessor(lastRuntime);
      }
      return undefined;
    }
    const replay = coordinator.replay();
    if (replay) {
      const historyIsClean = replay.historyIsClean();
      const exactReplay = (
        dialogAuthoritiesMatch(replay.source.authority, authority, false)
        && coordinator.acceptsSuccessorOf(replay.source)
        && historyIsClean
        && sameDialogElements(replay.source.elements, elements)
        && staticTopologyMatches(authority, elements, "open", true)
        && (replay.source.overlayDom === null || domMatches(replay.source.overlayDom))
        && contentDomMatches(replay.source.contentDom, elements.header)
      );
      if (!exactReplay) {
        coordinator.abandonReplay(replay.source, historyIsClean);
        if (!historyIsClean) return undefined;
      } else {
        if (!coordinator.acceptReplay(replay.source)) return undefined;
      }
    }
    if (!staticTopologyMatches(authority, elements, "open", true)) return undefined;
    const runtime = createPublicationRuntime(
      authority,
      coordinator,
      owners,
      elements,
      actions,
      onFocusOut,
      () => layoutSetups > 1,
      requestSuccessor,
    );
    currentRuntime = runtime;
    lastRuntime = runtime;
    if (!runtime.publish()) {
      runtime.retireForElement();
      currentRuntime = null;
      return undefined;
    }
    return undefined;
  };
  const establish = () => {
    layoutSetups++;
    if (layoutSetups > 1) lastRuntime?.publication.journal.startReplay();
    layoutActive = true;
    tryEstablish();
    return () => {
      layoutActive = false;
      currentRuntime?.retireForLayout();
      currentRuntime = null;
    };
  };
  const onOpenAutoFocus = (event: OpenAutoFocusEvent) => {
    tryEstablish();
    const active = coordinator.active();
    const replayRuntime = active === null ? lastRuntime : null;
    const publication = active ?? replayRuntime?.publication ?? null;
    const currentElements = replayRuntime
      ? ownerElements(owners, authority.root.modal)
      : null;
    const replayOpening = (
      publication !== null
      && replayRuntime !== null
      && publication.authority === authority
      && currentElements !== null
      && authorityFactsMatch()
      && coordinator.acceptsSuccessorOf(publication)
      && replayRuntime.replay().historyIsClean()
      && sameDialogElements(publication.elements, currentElements)
      && staticTopologyMatches(authority, currentElements, "open", true)
    );
    if (
      !publication
      || publication.authority !== authority
      || publication.actions.openAutoFocus !== actions.openAutoFocus
      || !exactAutoFocusEvent(event, "focusScope.autoFocusOnMount", publication.elements.content)
      || (replayOpening
        ? !coordinator.claimReplayOpeningEvent(publication, actions.openAutoFocus, event)
        : !coordinator.claimOpeningEvent(publication, actions.openAutoFocus, event))
    ) {
      return;
    }
    const first = firstTabbable(publication.elements.body);
    if (!first || !snapshotContains(publication.contentDom, first)) return;
    event.preventDefault();
    first.focus({ preventScroll: true });
  };
  const onCloseAutoFocus = (event: CloseAutoFocusEvent) => {
    const content = event.currentTarget;
    if (
      !(content instanceof HTMLDivElement)
      || !exactAutoFocusEvent(event, "focusScope.autoFocusOnUnmount", content)
    ) {
      return;
    }
    const claim = coordinator.claimCloseEvent(authority, actions.closeAutoFocus, event);
    if (claim === "reject") return;
    event.preventDefault();
    if (claim === "neutralize") return;
    coordinator.finishClose(claim);
  };
  const onEscapeKeyDown = (event: EscapeKeyEvent) => {
    const publication = coordinator.active();
    if (
      !publication
      || publication.authority !== authority
      || publication.actions.escape !== actions.escape
    ) {
      return;
    }
    const nativeEvent = exactEscape(event, publication);
    if (!nativeEvent) {
      coordinator.stageEscapeBridge(publication, actions.escape, event);
      return;
    }
    const target = nativeEvent.target;
    const expandedCombobox = target instanceof Element
      ? target.closest<HTMLElement>('[role="combobox"][aria-expanded="true"]')
      : null;
    if (expandedCombobox && publication.elements.body.contains(expandedCombobox)) {
      if (coordinator.claimInteraction(publication, actions.escape, nativeEvent)) {
        event.preventDefault();
      }
      return;
    }
    coordinator.beginDismiss(publication, actions.escape, null, nativeEvent);
  };
  const onPointerDownOutside = (event: PointerDownOutsideEvent) => {
    const publication = coordinator.active();
    if (
      !publication
      || publication.authority !== authority
      || publication.actions.outsidePointer !== actions.outsidePointer
    ) {
      return;
    }
    const nativeEvent = exactOutsidePointer(event, publication);
    if (nativeEvent) coordinator.beginDismiss(publication, actions.outsidePointer, event, nativeEvent);
  };
  const onFocusOutside = (event: FocusOutsideEvent) => {
    const publication = coordinator.active();
    if (
      !publication
      || publication.authority !== authority
      || publication.actions.outsideFocus !== actions.outsideFocus
    ) {
      return;
    }
    const nativeEvent = exactOutsideFocus(event, publication);
    if (nativeEvent) coordinator.beginDismiss(publication, actions.outsideFocus, event, nativeEvent);
  };
  const onCloseClick = (event: React.MouseEvent<HTMLButtonElement>) => {
    const publication = coordinator.active();
    if (
      !publication
      || publication.authority !== authority
      || publication.actions.closeClick !== actions.closeClick
    ) {
      return;
    }
    const nativeEvent = exactNativeCloseClick(event, publication);
    if (nativeEvent) {
      coordinator.beginDismiss(publication, actions.closeClick, event, nativeEvent);
    } else {
      coordinator.stageCloseBridge(publication, actions.closeClick, event);
    }
  };

  return Object.freeze({
    captureOverlay: owners.overlay.capture,
    captureContent: captureContentAndBody,
    captureHeader: owners.header.capture,
    captureTitle: owners.title.capture,
    captureDescription: owners.description.capture,
    captureClose: owners.close.capture,
    captureIcon: owners.icon.capture,
    establish,
    onOpenAutoFocus,
    onCloseAutoFocus,
    onEscapeKeyDown,
    onPointerDownOutside,
    onFocusOutside,
    onCloseClick,
  });
}

function DialogPublicationBoundary({ establish }: { establish: () => void | (() => void) }) {
  React.useLayoutEffect(() => establish());
  return null;
}

export function DialogContent({
  title,
  description,
  children,
  className,
  wide,
  onClosed,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
  className?: string;
  wide?: boolean;
  /**
   * Runs once the closed dialog has let go of focus. An action that must leave focus in the editor
   * (insert a table, apply a link) belongs here rather than in the button's onClick: while the modal
   * is still mounted its focus trap pulls focus straight back into the dialog, and on unmount focus
   * goes to the opener — the toolbar button, so the next keystroke went to the button (task #437).
   */
  onClosed?: () => void;
}) {
  const inherited = React.useContext(DialogContext);
  const [localMount] = React.useState(() => Symbol("standalone-dialog"));
  const [localCoordinator] = React.useState(() => new DialogCoordinator(localMount));
  const [localRoot] = React.useState<DialogRootAuthority>(() => Object.freeze({
    identity: Symbol("standalone-dialog-root"),
    mount: localMount,
    actualOpen: true,
    controlled: false,
    open: undefined,
    defaultOpen: true,
    modal: true,
    onOpenChange: undefined,
    setUncontrolledOpen: () => undefined,
    openingTarget: currentFocusReturnTarget(),
  }));
  const coordinator = inherited?.coordinator ?? localCoordinator;
  const root = inherited?.root ?? localRoot;
  const [mount] = React.useState(() => Symbol("dialog-content"));
  const [opener] = React.useState(currentFocusReturnTarget);
  const [initialFocus] = React.useState(currentFocusedElement);
  const [cache] = React.useState(
    () => new PresentationCache<DialogAuthority, DialogPresentation>(),
  );
  const [revision, setRevision] = React.useState(0);
  const requestSuccessor = React.useCallback(() => {
    setRevision((current) => current + 1);
  }, []);
  const contentClassName = cn(
    "dialog animate-fade-in",
    wide && "w-[min(94vw,760px)]",
    className,
  );
  const candidate: DialogAuthority = Object.freeze({
    identity: Symbol("dialog-render"),
    mount,
    revision,
    root,
    title,
    description,
    children,
    classNameInput: className,
    className: contentClassName,
    wide,
    onClosed,
    opener: root.openingTarget ?? opener,
    initialFocus,
  });
  const presentation = cache.resolve(
    candidate,
    revision,
    dialogAuthoritiesMatch,
    () => createDialogPresentation(candidate, coordinator, requestSuccessor),
  );

  const {
    captureOverlay,
    captureContent,
    captureHeader,
    captureTitle,
    captureDescription,
    captureClose,
    captureIcon,
    establish,
    onOpenAutoFocus,
    onCloseAutoFocus,
    onEscapeKeyDown,
    onPointerDownOutside,
    onFocusOutside,
    onCloseClick,
  } = presentation;

  return (
    <RadixDialog.Portal>
      <RadixDialog.Overlay
        ref={captureOverlay}
        className={OVERLAY_CLASS_NAME}
      />
      <RadixDialog.Content
        ref={captureContent}
        className={contentClassName}
        onOpenAutoFocus={onOpenAutoFocus}
        onCloseAutoFocus={onCloseAutoFocus}
        onEscapeKeyDown={onEscapeKeyDown}
        onPointerDownOutside={onPointerDownOutside}
        onFocusOutside={onFocusOutside}
      >
        <div
          ref={captureHeader}
          className={HEADER_CLASS_NAME}
          data-focus-skip
        >
          <div>
            <RadixDialog.Title
              ref={captureTitle}
              className={TITLE_CLASS_NAME}
            >
              {title}
            </RadixDialog.Title>
            {description !== undefined ? (
              <RadixDialog.Description
                ref={captureDescription}
                className={DESCRIPTION_CLASS_NAME}
              >
                {description}
              </RadixDialog.Description>
            ) : (
              <RadixDialog.Description
                ref={captureDescription}
                className={HIDDEN_DESCRIPTION_CLASS_NAME}
              >
                {title}
              </RadixDialog.Description>
            )}
          </div>
          <RadixDialog.Close
            ref={captureClose}
            type="button"
            className={CLOSE_CLASS_NAME}
            aria-label="Close"
            onClick={onCloseClick}
          >
            <X ref={captureIcon} size={16} />
          </RadixDialog.Close>
        </div>
        {children}
        <DialogPublicationBoundary establish={establish} />
      </RadixDialog.Content>
    </RadixDialog.Portal>
  );
}
