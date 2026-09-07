"use client";

import { useLayoutEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { createPortal } from "react-dom";
import { Decoration, DecorationSet, type EditorView } from "prosemirror-view";
import { Bold, Italic, Code, Link as LinkIcon, MessageSquarePlus, Strikethrough } from "lucide-react";
import type { CollabSession } from "@/editor/collab/session";
import type { EditorActions, FormatState } from "./actions";
import { cn } from "@/lib/utils";
import type { Box, Insets } from "@/lib/viewport";
import { isCoarsePointer } from "@/lib/viewport-hooks";
import {
  placeSelectionBubble,
  selectionBubbleLayerPosition,
  selectionBubbleBounds,
  selectionClientBox,
  selectionIntersectsBounds,
  SELECTION_BUBBLE_ARROW_SIZE,
  type SelectionBubblePosition,
  type VisualViewportBox,
} from "./selection-bubble-geometry";

const cssPixels = (style: CSSStyleDeclaration, property: string): number => {
  const value = Number.parseFloat(style.getPropertyValue(property));
  return Number.isFinite(value) ? value : 0;
};

const clientBox = ({ left, top, width, height }: Pick<DOMRect, "left" | "top" | "width" | "height">): Box => ({ left, top, width, height });
const caretBox = ({ left, right, top, bottom }: Pick<DOMRect, "left" | "right" | "top" | "bottom">): Box => ({
  left,
  top,
  width: Math.max(0, right - left),
  height: Math.max(0, bottom - top),
});

function safeAreaInsets(): Insets {
  const style = getComputedStyle(document.documentElement);
  return {
    top: cssPixels(style, "--safe-area-inset-top"),
    right: cssPixels(style, "--safe-area-inset-right"),
    bottom: cssPixels(style, "--safe-area-inset-bottom"),
    left: cssPixels(style, "--safe-area-inset-left"),
  };
}

interface BubbleGeometry {
  owner: BubbleOwner;
  authority: BubbleActionAuthority;
  layer: HTMLDivElement;
  position: SelectionBubblePosition;
  placement: NonNullable<ReturnType<typeof selectionBubbleLayerPosition>>;
}

interface BubbleOwner {
  view: EditorView;
  editor: HTMLElement;
  scroller: HTMLElement;
  session: CollabSession;
  schedule: () => void;
  dispose: () => void;
}

interface BubbleActionAuthority {
  owner: BubbleOwner;
  view: EditorView;
  session: CollabSession;
  actions: EditorActions;
  onLink: () => void;
  onComment: () => void;
}

type BubbleControlPermission = "edit" | "comment";
type BubbleMark = Parameters<EditorActions["toggleMark"]>[0];

interface BubbleControlPublication {
  identity: symbol;
  retired: boolean;
  mount: symbol;
  geometry: BubbleGeometry;
  owner: BubbleOwner;
  authority: BubbleActionAuthority;
  view: EditorView;
  editor: HTMLElement;
  scroller: HTMLElement;
  session: CollabSession;
  activeSurface: CollabSession["activeSurface"] | null;
  actions: EditorActions;
  toggleMark: EditorActions["toggleMark"];
  format: FormatState;
  formatValues: Readonly<Pick<FormatState, "strong" | "em" | "strike" | "code" | "link">>;
  canEdit: boolean;
  canComment: boolean;
  onLink: () => void;
  onComment: () => void;
  bubble: HTMLDivElement | null;
  root: HTMLDivElement | null;
  controls: Set<BubbleControl>;
  mouseEvents: WeakSet<object>;
}

interface BubbleControl {
  identity: symbol;
  publication: BubbleControlPublication;
  permission: BubbleControlPermission;
  enabled: boolean;
  element: HTMLButtonElement | null;
  captureButton: (element: HTMLButtonElement | null) => void;
  claimed: boolean;
  invoke: () => void;
}

interface BubbleControls {
  bold: BubbleControl;
  italic: BubbleControl;
  strike: BubbleControl;
  code: BubbleControl;
  link: BubbleControl;
  comment: BubbleControl;
}

type BubbleContainerRole = "bubble" | "root";

interface BubbleElementOwner {
  publication: BubbleControlPublication;
  publicationIdentity: symbol;
  role: BubbleContainerRole | "control";
  control?: BubbleControl;
  controlIdentity?: symbol;
}

class BubbleControlCurrent {
  #geometry: BubbleGeometry | null = null;
  #owner: BubbleOwner | null = null;
  #authority: BubbleActionAuthority | null = null;
  #readContainer: (() => HTMLElement | null) | null = null;

  bindContainer(read: () => HTMLElement | null) {
    this.#readContainer = read;
  }

  unbindContainer(read: () => HTMLElement | null) {
    if (this.#readContainer === read) this.#readContainer = null;
  }

  publishGeometry(publication: BubbleGeometry) {
    this.#geometry = publication;
  }

  retireGeometry(publication: BubbleGeometry) {
    if (this.#geometry === publication) this.#geometry = null;
  }

  publishOwner(owner: BubbleOwner) {
    this.#owner = owner;
  }

  retireOwner(owner: BubbleOwner | null) {
    if (this.#owner === owner) this.#owner = null;
  }

  publishAuthority(authority: BubbleActionAuthority) {
    this.#authority = authority;
  }

  retireAuthority(authority: BubbleActionAuthority) {
    if (this.#authority === authority) this.#authority = null;
  }

  clear() {
    this.#geometry = null;
    this.#owner = null;
    this.#authority = null;
    this.#readContainer = null;
  }

  matches(publication: BubbleControlPublication, geometry: BubbleGeometry | null, mount: symbol) {
    const values = publication.formatValues;
    return (
      publication.mount === mount &&
      publication.geometry === geometry &&
      publication.geometry.owner === publication.owner &&
      publication.geometry.authority === publication.authority &&
      publication.geometry.layer.isConnected &&
      this.#geometry === publication.geometry &&
      this.#owner === publication.owner &&
      this.#authority === publication.authority &&
      publication.owner.view === publication.view &&
      publication.owner.editor === publication.editor &&
      publication.owner.scroller === publication.scroller &&
      publication.owner.session === publication.session &&
      publication.view.dom === publication.editor &&
      !publication.view.isDestroyed &&
      publication.editor.isConnected &&
      publication.scroller.isConnected &&
      this.#readContainer?.() === publication.scroller &&
      publication.authority.owner === publication.owner &&
      publication.authority.view === publication.view &&
      publication.authority.session === publication.session &&
      publication.authority.actions === publication.actions &&
      publication.authority.onLink === publication.onLink &&
      publication.authority.onComment === publication.onComment &&
      publication.actions.toggleMark === publication.toggleMark &&
      publication.format.strong === values.strong &&
      publication.format.em === values.em &&
      publication.format.strike === values.strike &&
      publication.format.code === values.code &&
      publication.format.link === values.link &&
      publication.activeSurface === "rich" &&
      publication.session.activeSurface === publication.activeSurface &&
      publication.session.canEdit === publication.canEdit &&
      publication.session.canComment === publication.canComment
    );
  }
}

class BubbleControlCoordinator {
  #current: BubbleControlPublication | null = null;
  #elementOwners = new WeakMap<HTMLElement, BubbleElementOwner>();

  publish(publication: BubbleControlPublication) {
    this.#current = publication;
  }

  retire(publication: BubbleControlPublication | null) {
    if (!publication) return;
    publication.retired = true;
    if (this.#current === publication) this.#current = null;
    this.bindContainer(publication, "bubble", null);
    this.bindContainer(publication, "root", null);
    for (const control of publication.controls) this.bindControl(control, null);
  }

  bindContainer(
    publication: BubbleControlPublication,
    role: BubbleContainerRole,
    element: HTMLDivElement | null,
  ) {
    const previous = publication[role];
    if (previous) {
      const owner = this.#elementOwners.get(previous);
      if (owner?.publication === publication && owner.publicationIdentity === publication.identity && owner.role === role) {
        this.#elementOwners.delete(previous);
      }
    }
    publication[role] = null;
    if (!element || publication.retired) return;
    this.#elementOwners.set(element, {
      publication,
      publicationIdentity: publication.identity,
      role,
    });
    publication[role] = element;
  }

  bindControl(control: BubbleControl, element: HTMLButtonElement | null) {
    const previous = control.element;
    if (previous) {
      const owner = this.#elementOwners.get(previous);
      if (
        owner?.publication === control.publication &&
        owner.publicationIdentity === control.publication.identity &&
        owner.control === control &&
        owner.controlIdentity === control.identity
      ) {
        this.#elementOwners.delete(previous);
      }
    }
    control.element = null;
    if (!element || control.publication.retired) return;
    this.#elementOwners.set(element, {
      publication: control.publication,
      publicationIdentity: control.publication.identity,
      role: "control",
      control,
      controlIdentity: control.identity,
    });
    control.element = element;
  }

  ownsElements(publication: BubbleControlPublication) {
    const { bubble, root, geometry } = publication;
    if (!bubble || !root || !bubble.isConnected || !root.isConnected || !geometry.layer.isConnected) return false;
    const bubbleOwner = this.#elementOwners.get(bubble);
    const rootOwner = this.#elementOwners.get(root);
    if (
      bubbleOwner?.publication !== publication ||
      bubbleOwner.publicationIdentity !== publication.identity ||
      bubbleOwner.role !== "bubble" ||
      rootOwner?.publication !== publication ||
      rootOwner.publicationIdentity !== publication.identity ||
      rootOwner.role !== "root"
    ) {
      return false;
    }
    return bubble.contains(root) && geometry.layer.contains(bubble);
  }

  canPublish(publication: BubbleControlPublication) {
    if (publication.retired || publication.controls.size !== 6 || !this.ownsElements(publication)) return false;
    for (const control of publication.controls) {
      const element = control.element;
      const owner = element ? this.#elementOwners.get(element) : null;
      if (
        !element ||
        !element.isConnected ||
        owner?.publication !== publication ||
        owner.publicationIdentity !== publication.identity ||
        owner.control !== control ||
        owner.controlIdentity !== control.identity ||
        !publication.root?.contains(element) ||
        !publication.bubble?.contains(element) ||
        !publication.geometry.layer.contains(element)
      ) {
        return false;
      }
    }
    return true;
  }

  ownsControl(
    publication: BubbleControlPublication,
    control: BubbleControl,
    element: HTMLButtonElement,
  ) {
    if (
      this.#current !== publication ||
      publication.retired ||
      control.claimed ||
      control.publication !== publication ||
      !publication.controls.has(control) ||
      control.element !== element
    ) {
      return false;
    }
    const owner = this.#elementOwners.get(element);
    if (
      owner?.publication !== publication ||
      owner.publicationIdentity !== publication.identity ||
      owner.control !== control ||
      owner.controlIdentity !== control.identity
    ) {
      return false;
    }
    if (!control.enabled || element.disabled || !element.isConnected || !this.ownsElements(publication)) return false;
    return publication.root!.contains(element) &&
      publication.bubble!.contains(element) &&
      publication.geometry.layer.contains(element);
  }
}

function createControlPublication({
  coordinator,
  mount,
  geometry,
  view,
  session,
  activeSurface,
  actions,
  format,
  canEdit,
  canComment,
  onLink,
  onComment,
}: {
  coordinator: BubbleControlCoordinator;
  mount: symbol;
  geometry: BubbleGeometry;
  view: EditorView;
  session: CollabSession;
  activeSurface: CollabSession["activeSurface"] | null;
  actions: EditorActions;
  format: FormatState;
  canEdit: boolean;
  canComment: boolean;
  onLink: () => void;
  onComment: () => void;
}): {
  publication: BubbleControlPublication;
  controls: BubbleControls;
  captureBubble: (element: HTMLDivElement | null) => void;
  captureRoot: (element: HTMLDivElement | null) => void;
} {
  const publication: BubbleControlPublication = {
    identity: Symbol("selection-bubble-control-publication"),
    retired: false,
    mount,
    geometry,
    owner: geometry.owner,
    authority: geometry.authority,
    view,
    editor: geometry.owner.editor,
    scroller: geometry.owner.scroller,
    session,
    activeSurface,
    actions,
    toggleMark: actions.toggleMark,
    format,
    formatValues: Object.freeze({
      strong: format.strong,
      em: format.em,
      strike: format.strike,
      code: format.code,
      link: format.link,
    }),
    canEdit,
    canComment,
    onLink,
    onComment,
    bubble: null,
    root: null,
    controls: new Set<BubbleControl>(),
    mouseEvents: new WeakSet(),
  };
  const control = (
    permission: BubbleControlPermission,
    invoke: () => void,
  ): BubbleControl => {
    const owned: BubbleControl = {
      identity: Symbol("selection-bubble-control"),
      publication,
      permission,
      enabled: permission === "edit" ? canEdit : canComment,
      element: null,
      captureButton: (element) => coordinator.bindControl(owned, element),
      claimed: false,
      invoke,
    };
    publication.controls.add(owned);
    return owned;
  };
  const toggleMark = publication.toggleMark;
  const mark = (value: BubbleMark) =>
    control("edit", () => toggleMark.call(actions, value));

  return {
    publication,
    captureBubble: (element) => coordinator.bindContainer(publication, "bubble", element),
    captureRoot: (element) => coordinator.bindContainer(publication, "root", element),
    controls: {
      bold: mark("strong"),
      italic: mark("em"),
      strike: mark("strike"),
      code: mark("code"),
      link: control("edit", onLink),
      comment: control("comment", onComment),
    },
  };
}

function BubbleButton({
  label,
  active,
  captureButton,
  onMouseDown,
  onClick,
  children,
  disabled,
}: {
  label: string;
  active?: boolean;
  captureButton: (element: HTMLButtonElement | null) => void;
  onMouseDown: (event: ReactMouseEvent<HTMLButtonElement>) => void;
  onClick: (event: ReactMouseEvent<HTMLButtonElement>) => void;
  children: React.ReactNode;
  disabled?: boolean;
}) {
  return (
    <button
      ref={captureButton}
      type="button"
      className={cn("flex h-[32px] w-[32px] shrink-0 items-center justify-center rounded-md text-white/85 hover:bg-white/15 hover:text-white disabled:opacity-30", active && "bg-white/20 text-white")}
      onMouseDown={onMouseDown}
      onClick={onClick}
      aria-label={label}
      title={label}
      disabled={disabled}
    >
      {children}
    </button>
  );
}

/**
 * Floating toolbar that appears over a non-empty selection in the rich pane, the way
 * word processors do. It offers the most common inline actions and "Comment".
 */
export function SelectionBubble({
  view,
  session,
  actions,
  format,
  containerRef,
  onComment,
  onLink,
}: {
  view: EditorView | null;
  session: CollabSession;
  actions: EditorActions;
  format: FormatState;
  containerRef: React.RefObject<HTMLElement | null>;
  onComment: () => void;
  onLink: () => void;
}) {
  const [geometry, setGeometry] = useState<BubbleGeometry | null>(null);
  const publicationRef = useRef<BubbleGeometry | null>(null);
  const ownerRef = useRef<BubbleOwner | null>(null);
  const authorityRef = useRef<BubbleActionAuthority | null>(null);
  const [controlMount] = useState(() => Symbol("selection-bubble-controls"));
  const [controlCoordinator] = useState(() => new BubbleControlCoordinator());
  const [controlCurrent] = useState(() => new BubbleControlCurrent());

  useLayoutEffect(() => {
    const readContainer = () => containerRef.current;
    controlCurrent.bindContainer(readContainer);
    return () => controlCurrent.unbindContainer(readContainer);
  }, [containerRef, controlCurrent]);

  const retirePublication = (publication: BubbleGeometry) => {
    if (publicationRef.current === publication) {
      publicationRef.current = null;
      controlCurrent.retireGeometry(publication);
    }
    setGeometry((current) => current === publication ? null : current);
  };
  const retireAuthority = (authority: BubbleActionAuthority) => {
    if (authorityRef.current !== authority) return;
    authorityRef.current = null;
    controlCurrent.retireAuthority(authority);
    const publication = publicationRef.current;
    if (publication?.authority === authority) retirePublication(publication);
  };

  // Resolve ref.current on every commit: the pane can be replaced without replacing its ref.
  useLayoutEffect(() => {
    const scroller = containerRef.current;
    const previous = ownerRef.current;
    if (previous?.view === view && previous?.editor === view?.dom && previous?.scroller === scroller && previous?.session === session) {
      const previousAuthority = authorityRef.current;
      if (
        previousAuthority?.owner === previous &&
        previousAuthority.view === view &&
        previousAuthority.session === session &&
        previousAuthority.actions === actions &&
        previousAuthority.onLink === onLink &&
        previousAuthority.onComment === onComment
      ) return;
      if (previousAuthority) retireAuthority(previousAuthority);
      const nextAuthority = { owner: previous, view, session, actions, onLink, onComment };
      authorityRef.current = nextAuthority;
      controlCurrent.publishAuthority(nextAuthority);
      previous.schedule();
      return;
    }
    const previousAuthority = authorityRef.current;
    if (previousAuthority) retireAuthority(previousAuthority);
    previous?.dispose();
    ownerRef.current = null;
    controlCurrent.retireOwner(previous);
    if (!view || !scroller) {
      return;
    }
    const editor = view.dom;
    const visualViewport = window.visualViewport;
    const fonts = document.fonts;
    const layer = document.createElement("div");
    layer.className = "selection-bubble-layer";
    layer.setAttribute("data-selection-bubble-layer", "");
    layer.contentEditable = "false";
    const topLayer = typeof layer.showPopover === "function";
    if (topLayer) layer.popover = "manual";
    let disposed = false;
    let pointerDown = false;
    let frame: number | null = null;
    let fullscreenWidget: {
      decorations: NonNullable<EditorView["props"]["decorations"]>;
      previous: EditorView["props"]["decorations"];
    } | null = null;
    const observedContent = new Set<Element>();

    const removeFullscreenWidget = () => {
      const owned = fullscreenWidget;
      fullscreenWidget = null;
      if (owned && !view.isDestroyed && view.props.decorations === owned.decorations) {
        view.setProps({ decorations: owned.previous });
      }
    };
    const hide = () => {
      if (disposed) return;
      if (topLayer && layer.matches(":popover-open")) layer.hidePopover();
      const publication = publicationRef.current;
      if (publication?.owner === owner) retirePublication(publication);
    };
    const compute = () => {
      if (disposed) return;
      const authority = authorityRef.current;
      if (ownerRef.current !== owner || authority?.owner !== owner) {
        hide();
        return;
      }
      if (view.isDestroyed || !editor.isConnected || !scroller.isConnected || containerRef.current !== scroller) {
        hide();
        return;
      }
      const { from, to, empty } = view.state.selection;
      const ownsFocus = view.hasFocus() || Boolean(document.activeElement && layer.contains(document.activeElement));
      if (empty || !ownsFocus || pointerDown || session.activeSurface !== "rich" || !(session.canEdit || session.canComment)) {
        hide();
        return;
      }
      const fullscreen = document.fullscreenElement;
      if (fullscreen && !fullscreen.contains(editor) && !fullscreen.contains(scroller)) {
        hide();
        return;
      }
      // The top layer escapes transforms and overflow. The non-popover fallback is outside
      // transformed body, or directly inside fullscreen with an explicit scale conversion.
      const target = fullscreen ?? document.documentElement;
      if (layer.parentElement !== target) {
        if (topLayer && layer.matches(":popover-open")) layer.hidePopover();
        if (target === editor) {
          // A portal inside editable content must be a widget: otherwise ProseMirror removes
          // its DOM, reparses its contents, and handles the toolbar's keyboard events as edits.
          // Changing the plugin array restarts every plugin view, including suggesting,
          // pending uploads and slash-menu ownership. A direct decoration leaves them intact.
          if (!fullscreenWidget || view.props.decorations !== fullscreenWidget.decorations) {
            const previous = view.props.decorations;
            const decorations: NonNullable<EditorView["props"]["decorations"]> = (state) => {
              if (disposed || fullscreenWidget?.decorations !== decorations) return DecorationSet.empty;
              let result = DecorationSet.create(state.doc, [
                Decoration.widget(0, layer, { side: -1, ignoreSelection: true, stopEvent: () => true }),
              ]);
              previous?.call(view, state)?.forEachSet((set) => { result = result.add(state.doc, set.find()); });
              return result;
            };
            fullscreenWidget = { decorations, previous };
            view.setProps({ decorations });
          }
        } else {
          removeFullscreenWidget();
          target.appendChild(layer);
        }
      }
      layer.dir = getComputedStyle(editor).direction;
      if (topLayer && !layer.matches(":popover-open")) layer.showPopover();
      try {
        const start = view.coordsAtPos(from);
        const end = view.coordsAtPos(to, -1);
        const startDOM = view.domAtPos(from);
        const endDOM = view.domAtPos(to);
        const range = document.createRange();
        range.setStart(startDOM.node, startDOM.offset);
        range.setEnd(endDOM.node, endDOM.offset);
        const fragments = Array.from(range.getClientRects(), clientBox);
        const nextContent = new Set<Element>();
        for (const node of [startDOM.node, endDOM.node]) {
          let element = node instanceof Element ? node : node.parentElement;
          while (element && element !== editor && editor.contains(element)) {
            nextContent.add(element);
            element = element.parentElement;
          }
        }
        for (const element of observedContent) {
          if (!nextContent.has(element)) {
            resizeObserver?.unobserve(element);
            observedContent.delete(element);
          }
        }
        for (const element of nextContent) {
          if (!observedContent.has(element)) {
            resizeObserver?.observe(element);
            observedContent.add(element);
          }
        }
        const visual: VisualViewportBox | null = visualViewport
          ? {
              offsetLeft: visualViewport.offsetLeft,
              offsetTop: visualViewport.offsetTop,
              width: visualViewport.width,
              height: visualViewport.height,
            }
          : null;
        const bounds = selectionBubbleBounds({
          host: clientBox((fullscreen && !fullscreen.contains(scroller) ? fullscreen : scroller).getBoundingClientRect()),
          layoutViewport: {
            left: 0,
            top: 0,
            width: document.documentElement.clientWidth || window.innerWidth,
            height: document.documentElement.clientHeight || window.innerHeight,
          },
          visualViewport: visual,
          safeArea: safeAreaInsets(),
        });
        if (fragments.length && !fragments.some((fragment) => selectionIntersectsBounds(fragment, bounds))) {
          hide();
          return;
        }
        const position = placeSelectionBubble(selectionClientBox(caretBox(start), caretBox(end), fragments), bounds, isCoarsePointer());
        const layerBox = clientBox(layer.getBoundingClientRect());
        const layerStyle = getComputedStyle(layer);
        // offsetWidth rounds fractional CSS pixels, which otherwise invents a scale at zoom.
        const layerWidth = cssPixels(layerStyle, "width") || layer.offsetWidth;
        const layerHeight = cssPixels(layerStyle, "height") || layer.offsetHeight;
        const placement = position && selectionBubbleLayerPosition(position, layerBox, layerWidth, layerHeight);
        if (!position || !placement) {
          hide();
          return;
        }
        // Clip only paint beyond the allowed pane/viewport intersection (including shadow tails).
        layer.style.clipPath = `inset(${(bounds.top - layerBox.top) * placement.scaleY}px ${(layerBox.left + layerBox.width - bounds.left - bounds.width) * placement.scaleX}px ${(layerBox.top + layerBox.height - bounds.top - bounds.height) * placement.scaleY}px ${(bounds.left - layerBox.left) * placement.scaleX}px)`;
        if (ownerRef.current !== owner || authorityRef.current !== authority) return;
        const publication = { owner, authority, layer, position, placement };
        publicationRef.current = publication;
        controlCurrent.publishGeometry(publication);
        setGeometry(publication);
      } catch (error) {
        // A replaced editor DOM can invalidate a range between selection and layout updates.
        if (error instanceof RangeError || (error instanceof DOMException && ["IndexSizeError", "InvalidStateError"].includes(error.name))) {
          hide();
          return;
        }
        throw error;
      }
    };
    const schedule = () => {
      if (disposed || frame !== null) return;
      frame = requestAnimationFrame(() => {
        if (disposed) return;
        frame = null;
        compute();
      });
    };
    const onPointerDown = (event: PointerEvent) => {
      if (disposed) return;
      if (event.target instanceof Node && editor.contains(event.target) && !layer.contains(event.target)) {
        pointerDown = true;
        hide();
      }
    };
    const onPointerUp = () => {
      if (disposed) return;
      pointerDown = false;
      schedule();
    };
    const onBlur = (event: FocusEvent) => {
      if (disposed) return;
      if (event.relatedTarget instanceof Node && layer.contains(event.relatedTarget)) return;
      hide();
    };
    const onMutation: MutationCallback = (records) => {
      if (disposed) return;
      if (!records.length || records.some((record) => {
        if (layer.contains(record.target)) return false;
        return record.type !== "childList" || [...record.addedNodes, ...record.removedNodes].some((node) => node !== layer);
      })) schedule();
    };
    const resizeObserver = typeof ResizeObserver === "function" ? new ResizeObserver(schedule) : null;
    resizeObserver?.observe(scroller);
    resizeObserver?.observe(editor);
    const mutationObserver = new MutationObserver(onMutation);
    mutationObserver.observe(editor, { childList: true, characterData: true, attributes: true, subtree: true });
    // Ancestor attribute changes can move content without resizing the scroller. No document subtree observer.
    for (let ancestor: HTMLElement | null = scroller; ancestor; ancestor = ancestor.parentElement) {
      if (ancestor === editor) continue;
      mutationObserver.observe(ancestor, { attributes: true, attributeFilter: ["style", "class", "dir", "hidden"], childList: ancestor === scroller });
    }
    scroller.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("scroll", schedule, { capture: true, passive: true });
    window.addEventListener("resize", schedule, { passive: true });
    window.addEventListener("pointerdown", onPointerDown, { passive: true });
    window.addEventListener("pointerup", onPointerUp, { passive: true });
    window.addEventListener("pointercancel", onPointerUp, { passive: true });
    document.addEventListener("selectionchange", schedule);
    document.addEventListener("fullscreenchange", schedule);
    visualViewport?.addEventListener("resize", schedule, { passive: true });
    visualViewport?.addEventListener("scroll", schedule, { passive: true });
    editor.addEventListener("blur", onBlur);
    editor.addEventListener("load", schedule, true);
    layer.addEventListener("focusout", schedule);
    fonts?.addEventListener("loadingdone", schedule);
    fonts?.addEventListener("loadingerror", schedule);
    void fonts?.ready.then(schedule);
    const dispose = () => {
      if (disposed) return;
      disposed = true;
      scroller.removeEventListener("scroll", schedule);
      window.removeEventListener("scroll", schedule, true);
      window.removeEventListener("resize", schedule);
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
      document.removeEventListener("selectionchange", schedule);
      document.removeEventListener("fullscreenchange", schedule);
      visualViewport?.removeEventListener("resize", schedule);
      visualViewport?.removeEventListener("scroll", schedule);
      editor.removeEventListener("blur", onBlur);
      editor.removeEventListener("load", schedule, true);
      layer.removeEventListener("focusout", schedule);
      fonts?.removeEventListener("loadingdone", schedule);
      fonts?.removeEventListener("loadingerror", schedule);
      resizeObserver?.disconnect();
      observedContent.clear();
      mutationObserver.disconnect();
      if (frame !== null) cancelAnimationFrame(frame);
      frame = null;
      if (topLayer && layer.matches(":popover-open")) layer.hidePopover();
      removeFullscreenWidget();
      layer.remove();
    };
    const owner = { view, editor, scroller, session, schedule, dispose };
    const authority = { owner, view, session, actions, onLink, onComment };
    ownerRef.current = owner;
    authorityRef.current = authority;
    controlCurrent.publishOwner(owner);
    controlCurrent.publishAuthority(authority);
    owner.schedule();
  });

  useLayoutEffect(() => () => {
    authorityRef.current = null;
    publicationRef.current = null;
    ownerRef.current?.dispose();
    ownerRef.current = null;
    controlCurrent.clear();
  }, [controlCurrent]);

  // Format changes carry every editor selection update into the shared geometry scheduler.
  useLayoutEffect(() => ownerRef.current?.schedule(), [format]);

  const geometryIsCurrent = Boolean(
    geometry &&
    geometry.owner.view === view &&
    geometry.owner.session === session &&
    geometry.authority.owner === geometry.owner &&
    geometry.authority.view === view &&
    geometry.authority.session === session &&
    geometry.authority.actions === actions &&
    geometry.authority.onLink === onLink &&
    geometry.authority.onComment === onComment,
  );
  const canEdit = geometryIsCurrent ? session.canEdit : false;
  const canComment = geometryIsCurrent ? session.canComment : false;
  const activeSurface = geometryIsCurrent ? session.activeSurface : null;
  const controlSet = geometryIsCurrent && geometry
    ? createControlPublication({
        coordinator: controlCoordinator,
        mount: controlMount,
        geometry,
        view: geometry.owner.view,
        session,
        activeSurface,
        actions,
        format,
        canEdit,
        canComment,
        onLink,
        onComment,
      })
    : null;
  const controlPublication = controlSet?.publication ?? null;

  useLayoutEffect(() => {
    if (
      controlPublication &&
      controlCoordinator.canPublish(controlPublication) &&
      controlCurrent.matches(controlPublication, geometry, controlMount)
    ) {
      controlCoordinator.publish(controlPublication);
    }
    return () => controlCoordinator.retire(controlPublication);
  }, [controlCoordinator, controlCurrent, controlMount, controlPublication, geometry]);

  if (!controlSet) return null;
  const { publication, controls, captureBubble, captureRoot } = controlSet;
  const { position: pos, placement, layer } = publication.geometry;
  const ownsControl = (
    control: BubbleControl,
    event: ReactMouseEvent<HTMLButtonElement>,
  ) => {
    const element = control.element;
    if (
      event.currentTarget !== element ||
      !element ||
      !controlCoordinator.ownsControl(publication, control, element) ||
      !controlCurrent.matches(publication, geometry, controlMount)
    ) {
      return false;
    }
    return control.permission === "edit" ? publication.canEdit : publication.canComment;
  };
  const onMouseDown = (control: BubbleControl) => (event: ReactMouseEvent<HTMLButtonElement>) => {
    if (event.currentTarget !== control.element || publication.mouseEvents.has(event) || !ownsControl(control, event)) return;
    publication.mouseEvents.add(event);
    event.preventDefault();
  };
  const onClick = (control: BubbleControl) => (event: ReactMouseEvent<HTMLButtonElement>) => {
    if (!ownsControl(control, event)) return;
    control.claimed = true;
    control.invoke();
  };

  return createPortal(
    <div
      ref={captureBubble}
      className="selection-bubble touch-target absolute z-30 rounded-lg bg-inverse shadow-xl dark:ring-1 dark:ring-white/10"
      style={{ left: placement.left, top: placement.top, width: pos.width, transform: `scale(${placement.scaleX}, ${placement.scaleY})`, transformOrigin: "top left" }}
      data-testid="selection-bubble"
      data-below={pos.below || undefined}
    >
      <div
        ref={captureRoot}
        className="selection-bubble-scroll flex items-center gap-[2px] overflow-x-auto overflow-y-hidden rounded-lg p-[4px]"
        tabIndex={0}
        role="toolbar"
        aria-label="Selection"
        aria-orientation="horizontal"
      >
        <BubbleButton label="Bold" active={format.strong} disabled={!canEdit} captureButton={controls.bold.captureButton} onMouseDown={onMouseDown(controls.bold)} onClick={onClick(controls.bold)}>
          <Bold size={16} strokeWidth={2.6} />
        </BubbleButton>
        <BubbleButton label="Italic" active={format.em} disabled={!canEdit} captureButton={controls.italic.captureButton} onMouseDown={onMouseDown(controls.italic)} onClick={onClick(controls.italic)}>
          <Italic size={16} />
        </BubbleButton>
        <BubbleButton label="Strikethrough" active={format.strike} disabled={!canEdit} captureButton={controls.strike.captureButton} onMouseDown={onMouseDown(controls.strike)} onClick={onClick(controls.strike)}>
          <Strikethrough size={16} />
        </BubbleButton>
        <BubbleButton label="Inline code" active={format.code} disabled={!canEdit} captureButton={controls.code.captureButton} onMouseDown={onMouseDown(controls.code)} onClick={onClick(controls.code)}>
          <Code size={16} />
        </BubbleButton>
        <BubbleButton label="Link" active={format.link} disabled={!canEdit} captureButton={controls.link.captureButton} onMouseDown={onMouseDown(controls.link)} onClick={onClick(controls.link)}>
          <LinkIcon size={16} />
        </BubbleButton>
        <span className="mx-[2px] h-[20px] w-px shrink-0 bg-white/20" />
        <BubbleButton label="Comment" disabled={!canComment} captureButton={controls.comment.captureButton} onMouseDown={onMouseDown(controls.comment)} onClick={onClick(controls.comment)}>
          <MessageSquarePlus size={16} />
        </BubbleButton>
      </div>
      <span
        className="absolute -translate-x-1/2 rotate-45 bg-inverse"
        style={{ left: pos.arrowLeft, width: SELECTION_BUBBLE_ARROW_SIZE, height: SELECTION_BUBBLE_ARROW_SIZE, ...(pos.below ? { top: -4 } : { bottom: -4 }) }}
        aria-hidden
      />
    </div>,
    layer,
  );
}
