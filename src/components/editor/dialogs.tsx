"use client";

import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefCallback,
} from "react";
import { Dialog, DialogContent, Kbd } from "@/components/ui/primitives";
import { gridCell, type GridCell } from "@/lib/a11y";
import { apiErrorText } from "@/lib/api";
import { findReplaceShortcut, shortcut } from "@/lib/utils";

/**
 * Editor actions picked in a dialog run after the dialog has closed and let go of focus (see
 * `DialogContent.onClosed`), so the caret ends up in the editor, not on the toolbar button.
 */
type DialogActionVisit = object;

function useAfterClose(visit: DialogActionVisit, activeVisit: React.RefObject<DialogActionVisit | null>) {
  const pending = useRef<{ visit: DialogActionVisit; run: () => void } | null>(null);
  useLayoutEffect(
    () => () => {
      if (pending.current?.visit === visit) pending.current = null;
    },
    [visit],
  );
  const onClosed = useCallback(() => {
    const action = pending.current;
    if (!action || action.visit !== visit || activeVisit.current !== visit) return;
    pending.current = null;
    action.run();
  }, [activeVisit, visit]);
  const defer = useCallback(
    (run: () => void) => {
      if (activeVisit.current === visit) pending.current = { visit, run };
    },
    [activeVisit, visit],
  );
  return { defer, onClosed };
}

interface LinkDraft {
  visit: DialogActionVisit;
  open: boolean;
  initialHref: string;
  initialText: string;
  href: string;
  text: string;
}

function linkDraft(visit: DialogActionVisit, open: boolean, href: string, text: string): LinkDraft {
  return { visit, open, initialHref: href, initialText: text, href, text };
}

interface LinkRender {
  readonly identity: object;
  readonly mount: symbol;
  readonly visit: DialogActionVisit;
  readonly open: boolean;
  readonly initialHref: string;
  readonly initialText: string;
  readonly href: string;
  readonly text: string;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSubmit: (href: string, text: string) => void;
  readonly onRemove: (() => void) | undefined;
  readonly apply: Readonly<{ href: string; text: string }>;
  readonly removeAvailable: boolean;
  readonly title: "Edit link" | "Insert link";
  readonly applyDisabled: boolean;
}

interface LinkPresentation {
  readonly render: LinkRender;
  readonly content: HTMLDivElement;
  readonly form: HTMLFormElement;
  readonly url: HTMLInputElement;
  readonly text: HTMLInputElement;
  readonly removeSlot: HTMLButtonElement | HTMLSpanElement;
  readonly remove: HTMLButtonElement | null;
  readonly cancel: HTMLButtonElement;
  readonly apply: HTMLButtonElement;
}

interface LinkCloseOwner {
  readonly visit: DialogActionVisit;
  readonly source: object;
  readonly allowedClosers: WeakSet<object>;
}

class LinkPublicationAuthority {
  #active: LinkPresentation | null = null;
  #pendingClose: LinkCloseOwner | null = null;
  readonly #claimed = new WeakSet<LinkPresentation>();

  active() {
    return this.#active;
  }

  publish(presentation: LinkPresentation) {
    this.#active = presentation;
  }

  retire(identity: object) {
    if (this.#active?.render.identity === identity) this.#active = null;
  }

  claim(presentation: LinkPresentation) {
    if (this.#claimed.has(presentation)) return false;
    this.#claimed.add(presentation);
    return true;
  }

  scheduleClose(visit: DialogActionVisit, source: object) {
    const allowedClosers = new WeakSet<object>();
    allowedClosers.add(source);
    this.#pendingClose = Object.freeze({ visit, source, allowedClosers });
  }

  authorizeClose(visit: DialogActionVisit, source: object) {
    if (this.#pendingClose?.visit === visit) this.#pendingClose.allowedClosers.add(source);
  }

  consumeClose(visit: DialogActionVisit, source: object) {
    const pending = this.#pendingClose;
    if (!pending || pending.visit !== visit || !pending.allowedClosers.has(source)) return false;
    this.#pendingClose = null;
    return true;
  }

  retireVisit(visit: DialogActionVisit) {
    if (this.#pendingClose?.visit === visit) this.#pendingClose = null;
  }
}

const attachedLinkElements = new WeakSet<HTMLElement>();

class LinkElementOwner<T extends HTMLElement> {
  private current: T | null = null;

  constructor(
    private readonly retire: () => void,
    private readonly onAttach: () => void = () => {},
  ) {}

  readonly element = () => this.current;
  readonly capture: React.RefCallback<T> = (element) => {
    if (this.current === element) return;
    this.current = element;
    this.retire();
    if (!element) return;
    // Every render re-attaches the same nodes through fresh owners; only a newly mounted node counts.
    if (!attachedLinkElements.has(element)) {
      attachedLinkElements.add(element);
      this.onAttach();
    }
    return () => {
      if (this.current !== element) return;
      this.current = null;
      this.retire();
    };
  };
}

function createLinkElementOwners(authority: LinkPublicationAuthority, identity: object, onAttach: () => void) {
  const retire = () => authority.retire(identity);
  const form = new LinkElementOwner<HTMLFormElement>(retire, onAttach);
  const url = new LinkElementOwner<HTMLInputElement>(retire, onAttach);
  const text = new LinkElementOwner<HTMLInputElement>(retire, onAttach);
  const remove = new LinkElementOwner<HTMLButtonElement>(retire, onAttach);
  const placeholder = new LinkElementOwner<HTMLSpanElement>(retire, onAttach);
  const cancel = new LinkElementOwner<HTMLButtonElement>(retire, onAttach);
  const apply = new LinkElementOwner<HTMLButtonElement>(retire, onAttach);
  return Object.freeze({
    form,
    url,
    text,
    remove,
    placeholder,
    cancel,
    apply,
    captureForm: form.capture,
    captureUrl: url.capture,
    captureText: text.capture,
    captureRemove: remove.capture,
    capturePlaceholder: placeholder.capture,
    captureCancel: cancel.capture,
    captureApply: apply.capture,
    retire,
  });
}

function normalizeLinkHref(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return trimmed;
  if (/^(https?:|mailto:|#|\/|\.)/i.test(trimmed)) return trimmed;
  if (/^[\w.-]+\.[a-z]{2,}(\/|$)/i.test(trimmed)) return `https://${trimmed}`;
  return trimmed;
}

function linkDomIsExact(presentation: LinkPresentation, changing: "url" | "text" | null = null) {
  const { render, content, form, url, text, removeSlot, remove, cancel, apply } = presentation;
  const document = content.ownerDocument;
  const urlLabel = url.parentElement;
  const textLabel = text.parentElement;
  const actions = removeSlot.parentElement;
  const closingActions = cancel.parentElement;
  const labelledTitle = content.getAttribute("aria-label");
  const titleElement = labelledTitle === null ? content.firstElementChild?.firstElementChild?.firstElementChild : null;
  if (
    !render.open ||
    !content.isConnected ||
    !form.isConnected ||
    !url.isConnected ||
    !text.isConnected ||
    !removeSlot.isConnected ||
    !cancel.isConnected ||
    !apply.isConnected ||
    content.tagName !== "DIV" ||
    content.getAttribute("role") !== "dialog" ||
    form.tagName !== "FORM" ||
    form.ownerDocument !== document ||
    url.ownerDocument !== document ||
    text.ownerDocument !== document ||
    removeSlot.ownerDocument !== document ||
    cancel.ownerDocument !== document ||
    apply.ownerDocument !== document ||
    form.parentElement !== content ||
    content.lastElementChild !== form ||
    (labelledTitle === null
      ? content.children.length !== 2 || titleElement?.textContent !== render.title
      : content.children.length !== 1 || labelledTitle !== render.title) ||
    form.children.length !== 3 ||
    form.children.item(0) !== urlLabel ||
    form.children.item(1) !== textLabel ||
    form.children.item(2) !== actions ||
    urlLabel?.tagName !== "LABEL" ||
    urlLabel.children.length !== 1 ||
    urlLabel.firstElementChild !== url ||
    urlLabel.textContent?.trim() !== "URL" ||
    textLabel?.tagName !== "LABEL" ||
    textLabel.children.length !== 1 ||
    textLabel.firstElementChild !== text ||
    textLabel.textContent?.trim() !== "Text" ||
    !actions ||
    actions.children.length !== 2 ||
    actions.children.item(0) !== removeSlot ||
    actions.children.item(1) !== closingActions ||
    !closingActions ||
    closingActions.children.length !== 2 ||
    closingActions.children.item(0) !== cancel ||
    closingActions.children.item(1) !== apply ||
    url.tagName !== "INPUT" ||
    url.type !== "text" ||
    url.form !== form ||
    url.disabled ||
    !url.required ||
    url.placeholder !== "https://example.com" ||
    url.dataset.testid !== "link-url" ||
    (changing !== "url" && url.value !== render.href) ||
    text.tagName !== "INPUT" ||
    text.type !== "text" ||
    text.form !== form ||
    text.disabled ||
    text.required ||
    text.placeholder !== "Link text (optional)" ||
    text.dataset.testid !== "link-text" ||
    (changing !== "text" && text.value !== render.text) ||
    cancel.tagName !== "BUTTON" ||
    cancel.type !== "button" ||
    cancel.form !== form ||
    cancel.disabled ||
    cancel.textContent?.trim() !== "Cancel" ||
    apply.tagName !== "BUTTON" ||
    apply.type !== "submit" ||
    apply.form !== form ||
    apply.disabled !== render.applyDisabled ||
    apply.dataset.testid !== "link-submit" ||
    apply.textContent?.trim() !== "Apply"
  ) {
    return false;
  }
  if (!render.removeAvailable) {
    return remove === null && removeSlot.tagName === "SPAN" && removeSlot.children.length === 0;
  }
  return (
    remove !== null &&
    removeSlot === remove &&
    remove.tagName === "BUTTON" &&
    remove.type === "button" &&
    remove.form === form &&
    !remove.disabled &&
    remove.textContent?.trim() === "Remove link"
  );
}

/** Successor renders requested per link dialog while its portal content attaches. */
const linkRecoveries = new WeakMap<LinkPublicationAuthority, number>();

export const LinkDialog = memo(function LinkDialog({
  open,
  onOpenChange,
  initial,
  onSubmit,
  onRemove,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initial: { href: string; text: string } | null;
  onSubmit: (href: string, text: string) => void;
  onRemove?: () => void;
}) {
  const [mount] = useState(() => Symbol("link dialog"));
  const [authority] = useState(() => new LinkPublicationAuthority());
  const visit = useMemo<DialogActionVisit>(() => ({ onOpenChange, onRemove, onSubmit }), [onOpenChange, onRemove, onSubmit]);
  const activeVisit = useRef<DialogActionVisit | null>(null);
  const initialHref = initial?.href ?? "";
  const initialText = initial?.text ?? "";
  const [storedDraft, setDraft] = useState<LinkDraft>(() => linkDraft(visit, open, initialHref, initialText));
  let draft = storedDraft;
  if (draft.visit !== visit || draft.open !== open || draft.initialHref !== initialHref || draft.initialText !== initialText) {
    draft = linkDraft(visit, open, initialHref, initialText);
    setDraft(draft);
  }
  const { href, text } = draft;
  const after = useAfterClose(visit, activeVisit);
  const identity = Object.freeze({});
  const [, setPublicationRevision] = useState(0);
  // The dialog body mounts through a portal after this component's layout effect has run, so
  // render once more when new elements attach without a publication; capped per open so it cannot loop.
  const onAttach = () =>
    queueMicrotask(() => {
      const requests = linkRecoveries.get(authority) ?? 0;
      if (authority.active() || requests >= 3) return;
      linkRecoveries.set(authority, requests + 1);
      setPublicationRevision((revision) => revision + 1);
    });
  useLayoutEffect(() => {
    if (open) linkRecoveries.delete(authority);
  }, [authority, open]);
  const owners = createLinkElementOwners(authority, identity, onAttach);
  const {
    form: formOwner,
    url: urlOwner,
    text: textOwner,
    remove: removeOwner,
    placeholder: placeholderOwner,
    cancel: cancelOwner,
    apply: applyOwner,
    captureForm,
    captureUrl,
    captureText,
    captureRemove,
    capturePlaceholder,
    captureCancel,
    captureApply,
    retire,
  } = owners;
  const render: LinkRender = Object.freeze({
    identity,
    mount,
    visit,
    open,
    initialHref,
    initialText,
    href,
    text,
    onOpenChange,
    onSubmit,
    onRemove,
    apply: Object.freeze({ href: normalizeLinkHref(href), text: text.trim() }),
    removeAvailable: Boolean(initialHref && onRemove),
    title: initialHref ? "Edit link" : "Insert link",
    applyDisabled: !href.trim(),
  });

  useLayoutEffect(() => {
    activeVisit.current = visit;
    return () => {
      if (activeVisit.current === visit) activeVisit.current = null;
      authority.retireVisit(visit);
    };
  }, [authority, visit]);

  useLayoutEffect(() => {
    retire();
    if (!render.open) {
      authority.authorizeClose(visit, identity);
      return;
    }
    const form = formOwner.element();
    const url = urlOwner.element();
    const textInput = textOwner.element();
    const remove = removeOwner.element();
    const placeholder = placeholderOwner.element();
    const removeSlot = render.removeAvailable ? remove : placeholder;
    const cancel = cancelOwner.element();
    const apply = applyOwner.element();
    const content = form?.parentElement;
    const ContentElement = content?.ownerDocument.defaultView?.HTMLDivElement;
    if (
      !ContentElement ||
      !(content instanceof ContentElement) ||
      !form ||
      !url ||
      !textInput ||
      !removeSlot ||
      !cancel ||
      !apply
    ) {
      return;
    }
    const presentation = Object.freeze<LinkPresentation>({
      render,
      content,
      form,
      url,
      text: textInput,
      removeSlot,
      remove,
      cancel,
      apply,
    });
    if (!linkDomIsExact(presentation)) return;
    authority.publish(presentation);
    return retire;
  });

  const currentPresentation = (changing: "url" | "text" | null = null) => {
    const presentation = authority.active();
    if (
      !presentation ||
      presentation.render !== render ||
      presentation.render.identity !== identity ||
      presentation.render.mount !== mount ||
      presentation.render.visit !== visit ||
      !linkDomIsExact(presentation, changing)
    ) {
      return null;
    }
    return presentation;
  };

  const claim = (presentation: LinkPresentation) => authority.claim(presentation);

  const changePresentation = (event: React.ChangeEvent<HTMLInputElement>, expected: "url" | "text") => {
    const input = expected === "url" ? urlOwner.element() : textOwner.element();
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
      (nativeEvent.type !== "input" && nativeEvent.type !== "change") ||
      nativeEvent.target !== input ||
      nativeEvent.defaultPrevented
    ) {
      return null;
    }
    const presentation = currentPresentation(expected);
    if (!presentation || presentation[expected] !== input || !claim(presentation)) return null;
    return presentation;
  };

  const clickPresentation = (event: React.MouseEvent<HTMLButtonElement>, expected: "remove" | "cancel") => {
    const button = expected === "remove" ? removeOwner.element() : cancelOwner.element();
    const ButtonElement = button?.ownerDocument.defaultView?.HTMLButtonElement;
    if (
      !ButtonElement ||
      !(button instanceof ButtonElement) ||
      event.type !== "click" ||
      event.currentTarget !== button ||
      event.defaultPrevented
    ) {
      return null;
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
      nativeEvent.defaultPrevented ||
      !button.contains(target)
    ) {
      return null;
    }
    const presentation = currentPresentation();
    if (
      !presentation ||
      presentation[expected] !== button ||
      button.disabled ||
      !claim(presentation)
    ) {
      return null;
    }
    return presentation;
  };

  const closeWithAction = (presentation: LinkPresentation, run: () => void) => {
    authority.scheduleClose(visit, presentation.render.identity);
    after.defer(run);
    presentation.render.onOpenChange(false);
  };

  const setOpen = (nextOpen: boolean) => {
    const presentation = currentPresentation();
    if (!presentation || !claim(presentation)) return;
    presentation.render.onOpenChange(nextOpen);
  };

  const onClosed = () => {
    if (!authority.consumeClose(visit, identity)) return;
    after.onClosed();
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent title={render.title} onClosed={onClosed}>
        <form
          ref={captureForm}
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            const form = formOwner.element();
            const applyButton = applyOwner.element();
            const nativeEvent = e.nativeEvent;
            if (
              !form ||
              !applyButton ||
              e.type !== "submit" ||
              e.currentTarget !== form ||
              e.target !== form ||
              e.defaultPrevented
            ) {
              return;
            }
            const ownerWindow = form.ownerDocument.defaultView;
            if (
              !ownerWindow?.SubmitEvent ||
              !(nativeEvent instanceof ownerWindow.SubmitEvent) ||
              nativeEvent.type !== "submit" ||
              nativeEvent.target !== form ||
              nativeEvent.defaultPrevented ||
              (nativeEvent.submitter !== null && nativeEvent.submitter !== applyButton)
            ) {
              return;
            }
            const presentation = currentPresentation();
            if (
              !presentation ||
              presentation.form !== form ||
              presentation.apply !== applyButton ||
              presentation.apply.disabled ||
              presentation.render.applyDisabled ||
              !claim(presentation)
            ) {
              return;
            }
            e.preventDefault();
            const applyPayload = presentation.render.apply;
            const submit = presentation.render.onSubmit;
            closeWithAction(presentation, () => submit(applyPayload.href, applyPayload.text));
          }}
        >
          <label className="flex flex-col gap-1 text-sm font-medium text-ink-2">
            URL
            <input
              ref={captureUrl}
              className="input"
              placeholder="https://example.com"
              value={href}
              onChange={(e) => {
                const presentation = changePresentation(e, "url");
                if (!presentation) return;
                setDraft({ ...draft, href: presentation.url.value });
              }}
              required
              autoFocus
              data-testid="link-url"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm font-medium text-ink-2">
            Text
            <input
              ref={captureText}
              className="input"
              placeholder="Link text (optional)"
              value={text}
              onChange={(e) => {
                const presentation = changePresentation(e, "text");
                if (!presentation) return;
                setDraft({ ...draft, text: presentation.text.value });
              }}
              data-testid="link-text"
            />
          </label>
          <div className="flex items-center justify-between pt-1">
            {render.removeAvailable ? (
              <button
                ref={captureRemove}
                type="button"
                className="btn btn-ghost text-danger"
                onClick={(event) => {
                  const presentation = clickPresentation(event, "remove");
                  const remove = presentation?.render.onRemove;
                  if (!presentation || !remove) return;
                  closeWithAction(presentation, remove);
                }}
              >
                Remove link
              </button>
            ) : (
              <span ref={capturePlaceholder} />
            )}
            <div className="flex gap-2">
              <button
                ref={captureCancel}
                type="button"
                className="btn btn-ghost"
                onClick={(event) => {
                  const presentation = clickPresentation(event, "cancel");
                  if (!presentation) return;
                  presentation.render.onOpenChange(false);
                }}
              >
                Cancel
              </button>
              <button
                ref={captureApply}
                type="submit"
                className="btn btn-primary"
                disabled={render.applyDisabled}
                data-testid="link-submit"
              >
                Apply
              </button>
            </div>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
});

const IMAGE_TITLE = "Insert image";
const IMAGE_DESCRIPTION =
  "Paste the address of an image or upload one. Alt text describes the image for people who can't see it.";
const IMAGE_FORM_CLASS = "flex flex-col gap-3";
const IMAGE_LABEL_CLASS =
  "flex flex-col gap-1 text-sm font-medium text-ink-2";
const IMAGE_URL_ROW_CLASS = "flex gap-2";
const IMAGE_URL_CLASS = "input flex-1";
const IMAGE_UPLOAD_CLASS = "btn btn-outline shrink-0";
const IMAGE_FILE_ACCEPT =
  "image/png,image/jpeg,image/gif,image/webp,image/svg+xml";
const IMAGE_ERROR_CLASS = "text-sm text-danger wrap-anywhere";
const IMAGE_ALT_CLASS = "input";
const IMAGE_PREVIEW_CLASS =
  "max-h-40 rounded-lg border border-line object-contain";
const IMAGE_ACTIONS_CLASS = "flex justify-end gap-2 pt-1";
const IMAGE_CANCEL_CLASS = "btn btn-ghost";
const IMAGE_INSERT_CLASS = "btn btn-primary";
const IMAGE_RADIX_SETTLING_ATTRIBUTES = new Set([
  "aria-describedby",
  "aria-labelledby",
  "style",
]);
const IMAGE_APPLY = Reflect.apply;
const IMAGE_HAS_INSTANCE = Function.prototype[Symbol.hasInstance];
const IMAGE_ARRAY_INCLUDES = Array.prototype.includes;
const IMAGE_HAS_OWN = Object.prototype.hasOwnProperty;
const IMAGE_GET_OWN_PROPERTY_DESCRIPTOR = Object.getOwnPropertyDescriptor;
const IMAGE_DEFINE_PROPERTY = Object.defineProperty;
const IMAGE_GET_PROTOTYPE_OF = Object.getPrototypeOf;
const IMAGE_OWN_KEYS = Reflect.ownKeys;
const IMAGE_WEAK_MAP_DELETE = WeakMap.prototype.delete;
const IMAGE_WEAK_MAP_GET = WeakMap.prototype.get;
const IMAGE_WEAK_MAP_SET = WeakMap.prototype.set;
const IMAGE_SET_ADD = Set.prototype.add;
const IMAGE_SET_DELETE = Set.prototype.delete;
const IMAGE_SET_FOR_EACH = Set.prototype.forEach;
const IMAGE_WEAK_SET_ADD = WeakSet.prototype.add;
const IMAGE_WEAK_SET_DELETE = WeakSet.prototype.delete;
const IMAGE_WEAK_SET_HAS = WeakSet.prototype.has;

function imageUploadErrorText(error: unknown) {
  try {
    return apiErrorText(error, "Upload failed");
  } catch {
    return "Upload failed";
  }
}

interface ImageVisit {
  readonly onOpenChange: (open: boolean) => void;
  readonly onSubmit: (src: string, alt: string) => void;
  readonly onUpload:
    | ((file: File) => Promise<{ url: string; alt?: string }>)
    | undefined;
}

interface ImageDraft {
  readonly visit: ImageVisit;
  readonly open: boolean;
  readonly src: string;
  readonly alt: string;
  readonly error: string | null;
  readonly altRevision: number;
  readonly previewFailed: boolean;
  readonly upload: ImageUploadOwner | null;
  readonly uploadAdmission: ImageUploadOwner | null;
}

interface ImageAuthority {
  readonly mount: symbol;
  readonly revision: number;
  readonly visit: ImageVisit;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSubmit: (src: string, alt: string) => void;
  readonly onUpload: ImageVisit["onUpload"];
  readonly draft: ImageDraft;
  readonly src: string;
  readonly alt: string;
  readonly error: string | null;
  readonly altRevision: number;
  readonly previewFailed: boolean;
  readonly upload: ImageUploadOwner | null;
  readonly uploadAdmission: ImageUploadOwner | null;
  readonly uploading: boolean;
  readonly uploadDisabled: boolean;
  readonly uploadAvailable: boolean;
  readonly normalizedSrc: string;
  readonly normalizedAlt: string;
  readonly submitDisabled: boolean;
}

interface ImageUploadOwner {
  readonly identity: symbol;
  readonly origin: ImagePublication;
  readonly authority: ImageAuthority;
  readonly visit: ImageVisit;
  readonly callback: NonNullable<ImageVisit["onUpload"]>;
  readonly file: File;
  readonly fileInput: HTMLInputElement;
  readonly altRevision: number;
  readonly fallbackAlt: string;
  readonly settlementAction: object;
}

type ImageUploadOutcome =
  | {
      readonly kind: "success";
      readonly result: { url: string; alt?: string };
    }
  | { readonly kind: "error"; readonly error: unknown };

interface ImageDomSnapshot {
  readonly node: Node;
  readonly value: string | null;
  readonly attributes: readonly (readonly [string, string])[] | null;
  readonly children: readonly ImageDomSnapshot[];
}

interface ImageNodePlacement {
  readonly node: Node;
  readonly parent: Node;
  readonly previous: Node | null;
  readonly next: Node | null;
}

interface ImagePlacement {
  readonly document: Document;
  readonly portalParent: Node;
  readonly overlayPrevious: Node | null;
  readonly overlayNext: Node | null;
  readonly contentPrevious: Node | null;
  readonly contentNext: Node | null;
  readonly bridge: ImageNodePlacement;
  readonly ancestors: readonly ImageNodePlacement[];
}

interface ImageFileFacts {
  readonly value: string;
  readonly files: readonly File[];
}

type ImageChangingControl = "url" | "alt" | "file" | null;

interface ImageDom {
  readonly bridge: HTMLDivElement;
  readonly overlay: HTMLDivElement;
  readonly content: HTMLDivElement;
  readonly header: HTMLElement;
  readonly title: HTMLElement;
  readonly description: HTMLElement;
  readonly close: HTMLButtonElement;
  readonly form: HTMLFormElement;
  readonly urlLabel: HTMLLabelElement;
  readonly urlRow: HTMLDivElement;
  readonly url: HTMLInputElement;
  readonly upload: HTMLButtonElement | null;
  readonly file: HTMLInputElement | null;
  readonly error: HTMLDivElement | null;
  readonly altLabel: HTMLLabelElement;
  readonly alt: HTMLInputElement;
  readonly preview: HTMLImageElement | null;
  readonly actions: HTMLDivElement;
  readonly cancel: HTMLButtonElement;
  readonly insert: HTMLButtonElement;
}

interface ImageElementOwnerView {
  readonly element: () => Element | null;
}

interface ImageRefReplay {
  readonly owner: ImageElementOwnerView;
  readonly element: Element;
  detached: boolean;
  reattached: boolean;
}

interface ImagePublication {
  readonly identity: symbol;
  readonly authority: ImageAuthority;
  readonly ownerDocument: Document;
  readonly dom: ImageDom;
  readonly bridgeTree: ImageDomSnapshot;
  readonly contentTree: ImageDomSnapshot;
  readonly overlayTree: ImageDomSnapshot;
  readonly placement: ImagePlacement;
  readonly fileFacts: ImageFileFacts | null;
  readonly fileControl: object | null;
  readonly authorizeDismissal: (event: Event) => void;
  readonly retire: () => boolean;
  readonly releaseTerminal: () => boolean;
  readonly isRetired: () => boolean;
  readonly publishedDomMatches: (
    changing?: "url" | "alt" | "file" | null,
  ) => boolean;
}

interface ImagePublicationReplay {
  readonly source: ImagePublication;
  readonly bridgeTree: ImageDomSnapshot;
  readonly contentTree: ImageDomSnapshot;
  readonly overlayTree: ImageDomSnapshot;
  readonly placement: ImagePlacement;
  readonly historyIsClean: () => boolean;
  readonly proofIsCurrent: () => boolean;
  readonly release: () => boolean;
}

interface ImagePublicationRuntime {
  readonly publication: ImagePublication;
  readonly publish: (beforePublish?: () => boolean) => boolean;
  readonly retireForElement: () => void;
  readonly retireForLayout: () => void;
  readonly finishCommit: () => void;
  readonly sealForSubmit: () => boolean;
  readonly noteRef: (
    owner: ImageElementOwnerView,
    element: Element | null,
    previous: Element | null,
  ) => void;
  readonly isExactReplay: () => boolean;
  readonly isRecoverablePartialReplay: () => boolean;
  readonly replay: () => ImagePublicationReplay | null;
}

interface ImageDismissalProof {
  readonly publication: ImagePublication;
  readonly control: object;
  readonly reactEvent: object;
  readonly nativeEvent: Event;
}

interface ImageInsertionOwner {
  readonly identity: symbol;
  readonly origin: ImagePublication;
  readonly mount: symbol;
  readonly visit: ImageVisit;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSubmit: (src: string, alt: string) => void;
  readonly onUpload: ImageVisit["onUpload"];
  readonly src: string;
  readonly alt: string;
  readonly shellClosesSynchronously: boolean;
  readonly closer: object;
}

interface ImageUploadLease {
  readonly owner: ImageUploadOwner;
  readonly publication: ImagePublication;
}

interface ImageDeferredUploadOutcome {
  readonly owner: ImageUploadOwner;
  readonly outcome: ImageUploadOutcome;
  readonly source: ImagePublication;
}

interface ImageSubmitProvenance {
  readonly authority: ImageAuthority;
  readonly ownerDocument: Document;
  readonly form: HTMLFormElement;
  readonly insert: HTMLButtonElement;
  readonly content: HTMLDivElement;
  readonly contentTree: ImageDomSnapshot;
  readonly revision: number;
  readonly nativeEvent: ImageNativeSubmitIntrinsics;
  readonly nativeDom: ImageNativeSubmitDomIntrinsics;
}

interface ImageSubmitCaptureProof {
  readonly nativeEvent: Event;
  readonly publication: ImagePublication | null;
  readonly provenance: ImageSubmitProvenance;
  readonly reactEvent: React.FormEvent<HTMLFormElement>;
  readonly delivery: ImageSubmitTerminalDelivery;
}

interface ImageSubmitFinalization {
  readonly proof: ImageSubmitCaptureProof;
  readonly applicationEligible: boolean;
}

type ImageSubmitTerminalDelivery = (proof: ImageSubmitCaptureProof) => void;

interface ImageNativeRelationSnapshot {
  readonly target: object;
  readonly properties: readonly (
    | ImageNativePropertySnapshot
    | null
  )[];
}

interface ImageNativeSubmitDomIntrinsics {
  readonly surfaceIsCanonical: () => boolean;
  readonly addFormSubmitListener: (
    listener: (event: Event) => void,
    options?: boolean | AddEventListenerOptions,
  ) => void;
  readonly removeFormSubmitListener: (
    listener: (event: Event) => void,
    options?: boolean | EventListenerOptions,
  ) => void;
  readonly nodeIsConnected: (node: Node) => boolean;
  readonly formIsConnected: () => boolean;
  readonly formOwnerDocument: () => Document | null;
  readonly formParentElement: () => Element | null;
  readonly formContains: (node: Node) => boolean;
  readonly insertForm: () => HTMLFormElement | null;
}

interface ImageNativePropertySnapshot {
  readonly key: PropertyKey;
  readonly kind: "accessor" | "data";
  readonly configurable: boolean;
  readonly enumerable: boolean;
  readonly value: unknown;
  readonly writable: boolean;
  readonly get: PropertyDescriptor["get"];
  readonly set: PropertyDescriptor["set"];
}

interface ImageNativeSubmitOwnerRealm {
  readonly ownerDocument: Document;
  readonly ownerWindow: Window & typeof globalThis;
  readonly nodePrototype: object;
  readonly documentPrototype: object;
  readonly formPrototype: object;
  readonly insertPrototype: object;
  readonly eventTargetPrototype: object;
  readonly relationProperties: readonly ImageNativePropertySnapshot[];
  readonly documentSurface: readonly ImageNativeRelationSnapshot[];
  readonly defaultViewProperty: ImageNativePropertySnapshot;
  readonly insertFormProperty: ImageNativePropertySnapshot;
  readonly addEventListenerProperty: ImageNativePropertySnapshot;
  readonly removeEventListenerProperty: ImageNativePropertySnapshot;
  readonly nativeEvent: ImageNativeSubmitIntrinsics;
  readonly addEventListener: (
    target: EventTarget,
    type: string,
    listener: (event: Event) => void,
    options?: boolean | AddEventListenerOptions,
  ) => void;
  readonly removeEventListener: (
    target: EventTarget,
    type: string,
    listener: (event: Event) => void,
    options?: boolean | EventListenerOptions,
  ) => void;
  readonly isConnected: (node: Node) => boolean;
  readonly ownerDocumentOf: (node: Node) => Document | null;
  readonly parentElement: (node: Node) => Element | null;
  readonly contains: (node: Node, other: Node) => boolean;
  readonly insertForm: (insert: HTMLButtonElement) => HTMLFormElement | null;
}

interface ImageNativePrototypeSnapshot {
  readonly prototype: object;
  readonly properties: readonly ImageNativePropertySnapshot[];
}

interface ImageNativeSubmitIntrinsics {
  readonly isEvent: (value: unknown) => value is Event;
  readonly isSubmitEvent: (value: Event) => boolean;
  readonly type: (event: Event) => string;
  readonly target: (event: Event) => EventTarget | null;
  readonly eventPhase: (event: Event) => number;
  readonly defaultPrevented: (event: Event) => boolean;
  readonly bubbles: (event: Event) => boolean;
  readonly cancelable: (event: Event) => boolean;
  readonly composedPath: (event: Event) => EventTarget[];
  readonly submitter: (event: Event) => HTMLElement | null;
  readonly preventDefault: (event: Event) => boolean;
  readonly externalPreventionAttempted: (event: Event) => boolean;
  readonly capturePublicSurface: (event: Event) => boolean;
  readonly publicSurfaceIsCanonical: (event: Event) => boolean;
  readonly releasePublicSurface: (event: Event) => void;
  readonly propagationStopped: (event: Event) => boolean;
  readonly stopImmediatePropagation: (event: Event) => void;
}

interface ImageNativeSubmitCancellationMonitor {
  readonly wrappedPreventDefault: (this: Event) => void;
  readonly preventDefault: (event: Event) => boolean;
  readonly externalPreventionAttempted: (event: Event) => boolean;
}

const IMAGE_NATIVE_SUBMIT_CANCELLATION_MONITORS = new WeakMap<
  object,
  ImageNativeSubmitCancellationMonitor
>();

interface ImageReplayValidation {
  readonly complete: () => boolean;
  readonly release: () => boolean;
  readonly reject: () => void;
}

interface ImageControlPresentation<T extends HTMLElement> {
  readonly owner: ImageElementOwner<T>;
  readonly capture: (element: T | null) => void;
  readonly action: object;
}

interface ImagePresentation {
  readonly authority: ImageAuthority;
  readonly closeToken: object;
  readonly bridge: ImageControlPresentation<HTMLDivElement>;
  readonly form: ImageControlPresentation<HTMLFormElement>;
  readonly urlLabel: ImageControlPresentation<HTMLLabelElement>;
  readonly urlRow: ImageControlPresentation<HTMLDivElement>;
  readonly url: ImageControlPresentation<HTMLInputElement>;
  readonly upload: ImageControlPresentation<HTMLButtonElement>;
  readonly file: ImageControlPresentation<HTMLInputElement>;
  readonly error: ImageControlPresentation<HTMLDivElement>;
  readonly altLabel: ImageControlPresentation<HTMLLabelElement>;
  readonly alt: ImageControlPresentation<HTMLInputElement>;
  readonly preview: ImageControlPresentation<HTMLImageElement>;
  readonly actions: ImageControlPresentation<HTMLDivElement>;
  readonly cancel: ImageControlPresentation<HTMLButtonElement>;
  readonly insert: ImageControlPresentation<HTMLButtonElement>;
  readonly captureBridge: (element: HTMLDivElement | null) => void;
  readonly captureForm: (element: HTMLFormElement | null) => void;
  readonly captureUrlLabel: (element: HTMLLabelElement | null) => void;
  readonly captureUrlRow: (element: HTMLDivElement | null) => void;
  readonly captureUrl: (element: HTMLInputElement | null) => void;
  readonly captureUpload: (element: HTMLButtonElement | null) => void;
  readonly captureFile: (element: HTMLInputElement | null) => void;
  readonly captureError: (element: HTMLDivElement | null) => void;
  readonly captureAltLabel: (element: HTMLLabelElement | null) => void;
  readonly captureAlt: (element: HTMLInputElement | null) => void;
  readonly capturePreview: (element: HTMLImageElement | null) => void;
  readonly captureActions: (element: HTMLDivElement | null) => void;
  readonly captureCancel: (element: HTMLButtonElement | null) => void;
  readonly captureInsert: (element: HTMLButtonElement | null) => void;
  readonly establish: () => void | (() => void);
  readonly settlePortal: () => void | (() => void);
  readonly onOpenChange: (open: boolean) => void;
  readonly onClickCapture: (event: React.MouseEvent<HTMLDivElement>) => void;
  readonly onUrlChange: (event: React.ChangeEvent<HTMLInputElement>) => void;
  readonly onAltChange: (event: React.ChangeEvent<HTMLInputElement>) => void;
  readonly onUploadClick: (
    event: React.MouseEvent<HTMLButtonElement>,
  ) => void;
  readonly onFileChange: (event: React.ChangeEvent<HTMLInputElement>) => void;
  readonly onPreviewError: (
    event: React.SyntheticEvent<HTMLImageElement>,
  ) => void;
  readonly onCancelClick: (
    event: React.MouseEvent<HTMLButtonElement>,
  ) => void;
  readonly onFormSubmitCapture: (
    event: React.FormEvent<HTMLFormElement>,
  ) => void;
  readonly onFormSubmit: (event: React.FormEvent<HTMLFormElement>) => void;
  readonly onClosed: () => void;
}

type ImageControls = Pick<
  ImagePresentation,
  | "bridge"
  | "form"
  | "urlLabel"
  | "urlRow"
  | "url"
  | "upload"
  | "file"
  | "error"
  | "altLabel"
  | "alt"
  | "preview"
  | "actions"
  | "cancel"
  | "insert"
>;

function imageDraft(visit: ImageVisit, open: boolean): ImageDraft {
  return Object.freeze({
    visit,
    open,
    src: "",
    alt: "",
    error: null,
    altRevision: 0,
    previewFailed: false,
    upload: null,
    uploadAdmission: null,
  });
}

function nextImageDraft(
  draft: ImageDraft,
  changes: Partial<Omit<ImageDraft, "visit" | "open">>,
): ImageDraft {
  return Object.freeze({ ...draft, ...changes });
}

class ImageCurrentValue<T> {
  #value: T;

  constructor(value: T) {
    this.#value = value;
  }

  get() {
    return this.#value;
  }

  set(value: T) {
    this.#value = value;
  }
}

class ImageElementOwner<T extends Element> implements ImageElementOwnerView {
  #current: T | null = null;
  #last: T | null = null;

  constructor(
    private readonly onChange: (
      owner: ImageElementOwnerView,
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
      this.#current = null;
      this.onChange(this, null, element, this.#last);
    };
  };
}

class ImagePublicationCoordinator {
  readonly #mount: symbol;
  #active: ImagePublication | null = null;
  #committed: ImagePublication | null = null;
  #committedDraft: ImageDraft | null = null;
  #successorOf: ImagePublication | null = null;
  #replay: ImagePublicationReplay | null = null;
  #rejectedReplayAuthority: ImageAuthority | null = null;
  readonly #retired = new WeakSet<ImagePublication>();
  readonly #claimedPublications = new WeakSet<ImagePublication>();
  readonly #claimedControls = new WeakSet<object>();
  readonly #claimedActions = new WeakSet<object>();
  readonly #claimedReactEvents = new WeakSet<object>();
  readonly #claimedNativeEvents = new WeakSet<Event>();
  readonly #claimedContinuations = new WeakSet<object>();

  constructor(mount: symbol) {
    this.#mount = mount;
  }

  active() {
    return this.#active;
  }

  authoritative() {
    return this.#active ?? this.#committed;
  }

  replay() {
    return this.#replay;
  }

  acceptsSuccessorOf(publication: ImagePublication) {
    return (
      this.#active === null &&
      this.#successorOf === publication &&
      this.#retired.has(publication) &&
      !this.#claimedPublications.has(publication)
    );
  }

  stageReplay(replay: ImagePublicationReplay) {
    if (!this.acceptsSuccessorOf(replay.source)) return false;
    this.#replay = replay;
    return true;
  }

  abandonReplay(publication: ImagePublication) {
    if (this.#replay?.source === publication) this.#replay = null;
    if (this.#successorOf === publication) this.#successorOf = null;
  }

  rejectReplay(publication: ImagePublication) {
    this.#rejectedReplayAuthority = publication.authority;
    this.abandonReplay(publication);
  }

  releaseTerminal(publication: ImagePublication) {
    if (this.#active === publication) this.#active = null;
    if (this.#committed === publication) {
      this.#committed = null;
      this.#committedDraft = null;
      publication.releaseTerminal();
    }
    this.abandonReplay(publication);
    if (this.#rejectedReplayAuthority === publication.authority) {
      this.#rejectedReplayAuthority = null;
    }
  }

  acceptsAuthority(authority: ImageAuthority) {
    const rejected = this.#rejectedReplayAuthority;
    if (!rejected) return true;
    if (imageAuthoritiesMatch(rejected, authority, false)) return false;
    this.#rejectedReplayAuthority = null;
    return true;
  }

  publish(publication: ImagePublication) {
    if (
      publication.authority.mount !== this.#mount ||
      this.#retired.has(publication)
    ) {
      return false;
    }
    const previous = this.#active;
    if (previous && previous !== publication) previous.retire();
    const committed = this.#committed;
    if (committed && committed !== publication) committed.releaseTerminal();
    this.#active = publication;
    this.#committed = null;
    this.#committedDraft = null;
    this.#successorOf = null;
    this.#replay = null;
    return true;
  }

  retire(publication: ImagePublication) {
    if (this.#retired.has(publication)) return false;
    this.#retired.add(publication);
    if (this.#active === publication) {
      this.#active = null;
      this.#successorOf = publication;
    }
    return true;
  }

  isCurrent(publication: ImagePublication) {
    return this.#active === publication && !this.#retired.has(publication);
  }

  isAuthoritative(publication: ImagePublication) {
    return (
      this.isCurrent(publication) ||
      (this.#committed === publication && this.#retired.has(publication))
    );
  }

  isRetained(publication: ImagePublication) {
    return this.#committed === publication && this.#retired.has(publication);
  }

  retainCommitted(publication: ImagePublication, draft: ImageDraft) {
    if (
      this.#active !== null ||
      (this.#committed !== null && this.#committed !== publication) ||
      this.#successorOf !== publication ||
      !this.#retired.has(publication) ||
      draft === publication.authority.draft ||
      draft.visit !== publication.authority.visit ||
      draft.open !== publication.authority.open ||
      draft.upload !== null ||
      draft.uploadAdmission === null
    ) {
      return false;
    }
    this.#committed = publication;
    this.#committedDraft = draft;
    IMAGE_APPLY(IMAGE_WEAK_SET_DELETE, this.#claimedPublications, [publication]);
    this.abandonReplay(publication);
    return true;
  }

  updateRetainedDraft(
    publication: ImagePublication,
    update: (current: ImageDraft) => ImageDraft,
  ) {
    const current = this.#committedDraft;
    if (!current || !this.isRetained(publication)) return null;
    const next = update(current);
    this.#committedDraft = next;
    return next;
  }

  wasClaimed(publication: ImagePublication) {
    return this.#claimedPublications.has(publication);
  }

  hasClaimed(
    publication: ImagePublication,
    control: object,
    action: object,
    reactEvent: object,
    nativeEvent: Event,
  ) {
    return (
      this.#claimedPublications.has(publication) ||
      this.#claimedControls.has(control) ||
      this.#claimedActions.has(action) ||
      this.#claimedReactEvents.has(reactEvent) ||
      this.#claimedNativeEvents.has(nativeEvent)
    );
  }

  claim(
    publication: ImagePublication,
    control: object,
    action: object,
    reactEvent: object,
    nativeEvent: Event,
  ) {
    if (
      !this.isAuthoritative(publication) ||
      this.hasClaimed(
        publication,
        control,
        action,
        reactEvent,
        nativeEvent,
      )
    ) {
      return false;
    }
    this.#claimedPublications.add(publication);
    this.#claimedControls.add(control);
    this.#claimedActions.add(action);
    this.#claimedReactEvents.add(reactEvent);
    this.#claimedNativeEvents.add(nativeEvent);
    return true;
  }

  claimContinuation(
    publication: ImagePublication,
    control: object,
    action: object,
    proof: object,
  ) {
    if (
      !this.isCurrent(publication) ||
      this.#claimedPublications.has(publication) ||
      this.#claimedControls.has(control) ||
      this.#claimedActions.has(action) ||
      this.#claimedContinuations.has(proof)
    ) {
      return false;
    }
    this.#claimedPublications.add(publication);
    this.#claimedControls.add(control);
    this.#claimedActions.add(action);
    this.#claimedContinuations.add(proof);
    return true;
  }
}

class ImageDismissalListener {
  #bridge: HTMLDivElement | null = null;
  #document: Document | null = null;
  #submitOwnerRealms = new Set<ImageNativeSubmitOwnerRealm>();
  #submitFormOwnerRealm: ImageNativeSubmitOwnerRealm | null = null;
  #listener: ((event: Event) => void) | null = null;
  #submitForm: HTMLFormElement | null = null;
  #submitListener: ((event: Event) => void) | null = null;
  #submitProvenance: ImageSubmitProvenance | null = null;
  #submitDelivery: ImageSubmitTerminalDelivery | null = null;
  #submitProofs = new WeakMap<Event, ImageSubmitCaptureProof>();
  #submitFinalizations = new WeakMap<
    ImageSubmitCaptureProof,
    ImageSubmitFinalization
  >();
  #submitFinalizers = new WeakMap<
    ImageSubmitCaptureProof,
    (event: Event) => void
  >();
  #pendingSubmitProofs = new Set<ImageSubmitCaptureProof>();

  constructor(private readonly coordinator: ImagePublicationCoordinator) {}

  attach(bridge: HTMLDivElement) {
    const ownerRealm =
      this.findSubmitOwnerRealm(bridge) ??
      captureImageNativeSubmitOwnerRealm(bridge);
    if (!ownerRealm) {
      this.release();
      return;
    }
    IMAGE_APPLY(IMAGE_SET_ADD, this.#submitOwnerRealms, [ownerRealm]);
    const ownerDocument = ownerRealm.ownerDocument;
    this.#bridge = bridge;
    if (this.#document === ownerDocument && this.#listener) return;
    this.release();
    this.#bridge = bridge;
    const listener = (event: Event) => {
      const publication = this.coordinator.authoritative();
      const ownerWindow = ownerDocument.defaultView;
      if (
        !publication ||
        !this.coordinator.isAuthoritative(publication) ||
        publication.ownerDocument !== ownerDocument ||
        !ownerWindow ||
        (!(event instanceof ownerWindow.KeyboardEvent) &&
          !(event instanceof ownerWindow.MouseEvent))
      ) {
        return;
      }
      publication.authorizeDismissal(event);
    };
    this.#document = ownerDocument;
    this.#listener = listener;
    ownerDocument.addEventListener("keydown", listener, true);
    ownerDocument.addEventListener("pointerdown", listener, true);
    ownerDocument.addEventListener("click", listener, true);
  }

  submitOwnerRealm(node: Node) {
    try {
      const current = this.#submitFormOwnerRealm;
      if (current) {
        return current.ownerDocumentOf(node) === current.ownerDocument
          ? current
          : null;
      }
      const ownerRealm =
        this.findSubmitOwnerRealm(node) ??
        captureImageNativeSubmitOwnerRealm(node);
      if (ownerRealm) {
        IMAGE_APPLY(IMAGE_SET_ADD, this.#submitOwnerRealms, [ownerRealm]);
        this.#submitFormOwnerRealm = ownerRealm;
      }
      return ownerRealm;
    } catch {
      return null;
    }
  }

  private findSubmitOwnerRealm(
    node: Node,
  ): ImageNativeSubmitOwnerRealm | null {
    let matched: ImageNativeSubmitOwnerRealm | null = null;
    IMAGE_APPLY(IMAGE_SET_FOR_EACH, this.#submitOwnerRealms, [
      (realm: ImageNativeSubmitOwnerRealm) => {
        if (matched) return;
        try {
          if (realm.ownerDocumentOf(node) === realm.ownerDocument) {
            matched = realm;
          }
        } catch {
          return;
        }
      },
    ]);
    return matched;
  }

  attachSubmit(
    provenance: ImageSubmitProvenance,
    delivery: ImageSubmitTerminalDelivery,
  ) {
    const form = provenance.form;
    if (this.#submitForm === form && this.#submitListener) {
      this.#submitProvenance = provenance;
      this.#submitDelivery = delivery;
      return;
    }
    this.releaseSubmit();
    this.#submitProvenance = provenance;
    this.#submitDelivery = delivery;
    const listener = (event: Event) => {
      const proof = IMAGE_APPLY(IMAGE_WEAK_MAP_GET, this.#submitProofs, [
        event,
      ]) as ImageSubmitCaptureProof | undefined;
      if (!proof) {
        const current = this.#submitProvenance;
        if (!current || current.form !== form) return;
        try {
          if (
            imageExactNativeOwnedFormSubmitEvent(event, current, null) ===
              event &&
            current.nativeEvent.preventDefault(event)
          ) {
            current.nativeEvent.stopImmediatePropagation(event);
          }
        } catch {
          return;
        }
        return;
      }
      IMAGE_APPLY(IMAGE_WEAK_MAP_DELETE, this.#submitProofs, [event]);
      IMAGE_APPLY(IMAGE_SET_DELETE, this.#pendingSubmitProofs, [proof]);
      const intrinsics = proof.provenance.nativeEvent;
      const finalization = IMAGE_APPLY(
        IMAGE_WEAK_MAP_GET,
        this.#submitFinalizations,
        [proof],
      ) as ImageSubmitFinalization | undefined;
      if (!intrinsics.defaultPrevented(event)) intrinsics.preventDefault(event);
      const propagationWasStopped = intrinsics.propagationStopped(event);
      intrinsics.stopImmediatePropagation(event);
      this.releaseSubmitFinalizer(proof);
      const current = this.#submitProvenance;
      const currentDelivery = this.#submitDelivery;
      try {
        if (
          finalization?.proof !== proof ||
          !finalization.applicationEligible ||
          propagationWasStopped ||
          current !== proof.provenance ||
          currentDelivery !== proof.delivery ||
          current?.form !== form ||
          !intrinsics.publicSurfaceIsCanonical(event)
        ) {
          return;
        }
        proof.delivery(proof);
      } finally {
        this.releaseSubmitProof(proof);
      }
    };
    form.addEventListener("submit", listener);
    this.#submitForm = form;
    this.#submitListener = listener;
  }

  stageSubmit(proof: ImageSubmitCaptureProof) {
    if (
      this.#submitForm !== proof.provenance.form ||
      this.#submitProvenance !== proof.provenance ||
      this.#submitDelivery !== proof.delivery ||
      !this.#submitListener
    ) {
      return false;
    }
    const intrinsics = proof.provenance.nativeEvent;
    const finalizer = (event: Event) => {
      if (event !== proof.nativeEvent) return;
      const applicationEligible =
        !intrinsics.externalPreventionAttempted(event) &&
        proof.publication !== null;
      intrinsics.preventDefault(event);
      IMAGE_APPLY(IMAGE_WEAK_MAP_SET, this.#submitFinalizations, [
        proof,
        Object.freeze({ proof, applicationEligible }),
      ]);
    };
    try {
      proof.provenance.nativeDom.addFormSubmitListener(finalizer, {
        capture: true,
      });
    } catch {
      return false;
    }
    IMAGE_APPLY(IMAGE_WEAK_MAP_SET, this.#submitFinalizers, [proof, finalizer]);
    const previous = IMAGE_APPLY(IMAGE_WEAK_MAP_GET, this.#submitProofs, [
      proof.nativeEvent,
    ]) as ImageSubmitCaptureProof | undefined;
    if (previous) {
      this.releaseSubmitProof(previous);
      IMAGE_APPLY(IMAGE_SET_DELETE, this.#pendingSubmitProofs, [previous]);
    }
    IMAGE_APPLY(IMAGE_WEAK_MAP_SET, this.#submitProofs, [
      proof.nativeEvent,
      proof,
    ]);
    IMAGE_APPLY(IMAGE_SET_ADD, this.#pendingSubmitProofs, [proof]);
    // Expire after the whole dispatch: browsers drain microtasks between listeners of a real
    // (user-initiated) submit, which would drop the proof before the form's own listener runs.
    setTimeout(() => {
      const current = IMAGE_APPLY(IMAGE_WEAK_MAP_GET, this.#submitProofs, [
        proof.nativeEvent,
      ]) as ImageSubmitCaptureProof | undefined;
      if (current !== proof) return;
      IMAGE_APPLY(IMAGE_WEAK_MAP_DELETE, this.#submitProofs, [
        proof.nativeEvent,
      ]);
      IMAGE_APPLY(IMAGE_SET_DELETE, this.#pendingSubmitProofs, [proof]);
      this.releaseSubmitProof(proof);
    });
    return true;
  }

  releaseWhenDetached(bridge: HTMLDivElement) {
    queueMicrotask(() => {
      if (this.#bridge !== bridge) return;
      const ownerRealm = this.findSubmitOwnerRealm(bridge);
      if (!ownerRealm || !ownerRealm.isConnected(bridge)) this.release();
    });
  }

  clearSubmit() {
    this.releaseSubmit();
  }

  releaseTerminal(form: HTMLFormElement) {
    if (this.#submitForm === form) this.release();
  }

  retainSubmitSuppression(form: HTMLFormElement | null) {
    if (
      !this.#submitForm ||
      (form !== null && this.#submitForm !== form) ||
      this.#submitProvenance?.form !== this.#submitForm ||
      !this.#submitListener
    ) {
      return false;
    }
    this.#submitDelivery = null;
    this.clearSubmitProofs();
    return true;
  }

  private clearSubmitProofs() {
    IMAGE_APPLY(IMAGE_SET_FOR_EACH, this.#pendingSubmitProofs, [
      (proof: ImageSubmitCaptureProof) => {
        this.releaseSubmitProof(proof);
      },
    ]);
    this.#submitProofs = new WeakMap<Event, ImageSubmitCaptureProof>();
    this.#submitFinalizations = new WeakMap<
      ImageSubmitCaptureProof,
      ImageSubmitFinalization
    >();
    this.#submitFinalizers = new WeakMap<
      ImageSubmitCaptureProof,
      (event: Event) => void
    >();
    this.#pendingSubmitProofs = new Set<ImageSubmitCaptureProof>();
  }

  private releaseSubmitFinalizer(proof: ImageSubmitCaptureProof) {
    const finalizer = IMAGE_APPLY(
      IMAGE_WEAK_MAP_GET,
      this.#submitFinalizers,
      [proof],
    ) as ((event: Event) => void) | undefined;
    if (finalizer) {
      proof.provenance.nativeDom.removeFormSubmitListener(finalizer, true);
    }
    IMAGE_APPLY(IMAGE_WEAK_MAP_DELETE, this.#submitFinalizers, [proof]);
  }

  private releaseSubmitProof(proof: ImageSubmitCaptureProof) {
    this.releaseSubmitFinalizer(proof);
    IMAGE_APPLY(IMAGE_WEAK_MAP_DELETE, this.#submitFinalizations, [proof]);
    proof.provenance.nativeEvent.releasePublicSurface(proof.nativeEvent);
  }

  private releaseSubmit() {
    const form = this.#submitForm;
    const listener = this.#submitListener;
    const nativeDom = this.#submitProvenance?.nativeDom ?? null;
    this.#submitForm = null;
    this.#submitListener = null;
    this.#submitProvenance = null;
    this.#submitDelivery = null;
    this.clearSubmitProofs();
    if (form && listener && nativeDom) {
      nativeDom.removeFormSubmitListener(listener);
    }
  }

  private release() {
    const ownerDocument = this.#document;
    const listener = this.#listener;
    this.#bridge = null;
    this.#document = null;
    this.#listener = null;
    this.releaseSubmit();
    if (!ownerDocument || !listener) return;
    ownerDocument.removeEventListener("keydown", listener, true);
    ownerDocument.removeEventListener("pointerdown", listener, true);
    ownerDocument.removeEventListener("click", listener, true);
  }
}

class ImageAfterCloseAuthority {
  #pending: ImageInsertionOwner | null = null;

  schedule(
    publication: ImagePublication,
    authority: ImageAuthority,
    closer: object,
    shellClosesSynchronously: boolean,
  ) {
    const owner: ImageInsertionOwner = {
      identity: Symbol("image-insertion"),
      origin: publication,
      mount: authority.mount,
      visit: authority.visit,
      onOpenChange: authority.onOpenChange,
      onSubmit: authority.onSubmit,
      onUpload: authority.onUpload,
      src: authority.normalizedSrc,
      alt: authority.normalizedAlt,
      shellClosesSynchronously,
      closer,
    };
    this.#pending = owner;
    return owner;
  }

  cancel() {
    this.#pending = null;
  }

  authorize(authority: ImageAuthority) {
    const pending = this.#pending;
    if (
      !pending ||
      (!pending.shellClosesSynchronously && authority.open) ||
      authority.mount !== pending.mount ||
      authority.visit !== pending.visit ||
      authority.onOpenChange !== pending.onOpenChange ||
      authority.onSubmit !== pending.onSubmit ||
      authority.onUpload !== pending.onUpload
    ) {
      this.#pending = null;
      return;
    }
  }

  consume(authority: ImageAuthority, closer: object) {
    const pending = this.#pending;
    if (
      !pending ||
      pending.closer !== closer ||
      (!pending.shellClosesSynchronously && authority.open) ||
      (pending.shellClosesSynchronously &&
        !pending.origin.dom.bridge.isConnected) ||
      authority.mount !== pending.mount ||
      authority.visit !== pending.visit ||
      authority.onOpenChange !== pending.onOpenChange ||
      authority.onSubmit !== pending.onSubmit ||
      authority.onUpload !== pending.onUpload
    ) {
      return null;
    }
    this.#pending = null;
    return pending;
  }
}

function imageAuthoritiesMatch(
  previous: ImageAuthority,
  current: ImageAuthority,
  includeRevision = true,
) {
  return (
    previous.mount === current.mount &&
    (!includeRevision || previous.revision === current.revision) &&
    previous.visit === current.visit &&
    previous.open === current.open &&
    previous.onOpenChange === current.onOpenChange &&
    previous.onSubmit === current.onSubmit &&
    previous.onUpload === current.onUpload &&
    previous.draft === current.draft &&
    previous.src === current.src &&
    previous.alt === current.alt &&
    previous.error === current.error &&
    Object.is(previous.altRevision, current.altRevision) &&
    previous.previewFailed === current.previewFailed &&
    previous.upload === current.upload &&
    previous.uploadAdmission === current.uploadAdmission &&
    previous.uploading === current.uploading &&
    previous.uploadDisabled === current.uploadDisabled &&
    previous.uploadAvailable === current.uploadAvailable &&
    previous.normalizedSrc === current.normalizedSrc &&
    previous.normalizedAlt === current.normalizedAlt &&
    previous.submitDisabled === current.submitDisabled
  );
}

function imageUploadMatchesAuthority(
  upload: ImageUploadOwner,
  authority: ImageAuthority,
) {
  return (
    upload.authority.mount === authority.mount &&
    upload.visit === authority.visit &&
    upload.callback === authority.onUpload &&
    upload.authority.onOpenChange === authority.onOpenChange &&
    upload.authority.onSubmit === authority.onSubmit &&
    authority.open &&
    authority.upload === upload
  );
}

function imageSnapshotAttributes(
  node: Node,
): readonly (readonly [string, string])[] | null {
  if (node.nodeType !== 1) return null;
  const element = node as Element;
  return Object.freeze(
    [...element.attributes]
      .filter(({ name }) => {
        if (
          element.getAttribute("role") === "dialog" &&
          IMAGE_RADIX_SETTLING_ATTRIBUTES.has(name)
        ) {
          return false;
        }
        if (
          element.classList.contains("dialog-overlay") &&
          (name === "aria-hidden" || name === "data-aria-hidden")
        ) {
          return false;
        }
        return true;
      })
      .map(({ name, value }) => Object.freeze([name, value] as const))
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

function imageSnapshotDom(node: Node): ImageDomSnapshot {
  return Object.freeze({
    node,
    value: node.nodeValue,
    attributes: imageSnapshotAttributes(node),
    children: Object.freeze([...node.childNodes].map(imageSnapshotDom)),
  });
}

function imageDomMatches(snapshot: ImageDomSnapshot): boolean {
  const { node } = snapshot;
  if (node.nodeValue !== snapshot.value) return false;
  const attributes = imageSnapshotAttributes(node);
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
  return (
    node.childNodes.length === snapshot.children.length &&
    snapshot.children.every(
      (child, index) =>
        node.childNodes.item(index) === child.node && imageDomMatches(child),
    )
  );
}

function imageSnapshotContains(
  snapshot: ImageDomSnapshot,
  node: Node,
): boolean {
  return (
    snapshot.node === node ||
    snapshot.children.some((child) => imageSnapshotContains(child, node))
  );
}

function imageIsRadixFocusGuard(node: Node | null) {
  return (
    node?.nodeType === 1 &&
    (node as Element).tagName === "SPAN" &&
    (node as Element).hasAttribute("data-radix-focus-guard")
  );
}

function imagePreviousCommittedSibling(node: Node) {
  let sibling = node.previousSibling;
  while (imageIsRadixFocusGuard(sibling)) {
    sibling = sibling?.previousSibling ?? null;
  }
  return sibling;
}

function imageNextCommittedSibling(node: Node) {
  let sibling = node.nextSibling;
  while (imageIsRadixFocusGuard(sibling)) {
    sibling = sibling?.nextSibling ?? null;
  }
  return sibling;
}

function imageNodePlacement(node: Node): ImageNodePlacement | null {
  const parent = node.parentNode;
  if (!parent) return null;
  return Object.freeze({
    node,
    parent,
    previous: imagePreviousCommittedSibling(node),
    next: imageNextCommittedSibling(node),
  });
}

function captureImagePlacement(
  bridge: HTMLDivElement,
  overlay: HTMLDivElement,
  content: HTMLDivElement,
): ImagePlacement | null {
  const document = content.ownerDocument;
  const portalParent = content.parentNode;
  const bridgePlacement = imageNodePlacement(bridge);
  if (
    !portalParent ||
    !bridgePlacement ||
    overlay.ownerDocument !== document ||
    bridge.ownerDocument !== document ||
    overlay.parentNode !== portalParent ||
    !bridge.isConnected ||
    !overlay.isConnected ||
    !content.isConnected
  ) {
    return null;
  }
  const placements = new Map<Node, ImageNodePlacement>();
  const captureAncestors = (start: Node) => {
    let node = start;
    while (node !== document) {
      const placement = imageNodePlacement(node);
      if (!placement) return false;
      placements.set(node, placement);
      node = placement.parent;
    }
    return true;
  };
  if (
    !captureAncestors(portalParent) ||
    !captureAncestors(bridgePlacement.parent)
  ) {
    return null;
  }
  return Object.freeze({
    document,
    portalParent,
    overlayPrevious: imagePreviousCommittedSibling(overlay),
    overlayNext: imageNextCommittedSibling(overlay),
    contentPrevious: imagePreviousCommittedSibling(content),
    contentNext: imageNextCommittedSibling(content),
    bridge: bridgePlacement,
    ancestors: Object.freeze([...placements.values()]),
  });
}

function imagePlacementMatches(
  bridge: HTMLDivElement,
  overlay: HTMLDivElement,
  content: HTMLDivElement,
  placement: ImagePlacement,
) {
  return (
    bridge.isConnected &&
    overlay.isConnected &&
    content.isConnected &&
    bridge.ownerDocument === placement.document &&
    overlay.ownerDocument === placement.document &&
    content.ownerDocument === placement.document &&
    bridge.parentNode === placement.bridge.parent &&
    imagePreviousCommittedSibling(bridge) === placement.bridge.previous &&
    imageNextCommittedSibling(bridge) === placement.bridge.next &&
    overlay.parentNode === placement.portalParent &&
    content.parentNode === placement.portalParent &&
    imagePreviousCommittedSibling(overlay) === placement.overlayPrevious &&
    imageNextCommittedSibling(overlay) === placement.overlayNext &&
    imagePreviousCommittedSibling(content) === placement.contentPrevious &&
    imageNextCommittedSibling(content) === placement.contentNext &&
    placement.ancestors.every(
      (ancestor) =>
        ancestor.node.isConnected &&
        ancestor.node.parentNode === ancestor.parent &&
        imagePreviousCommittedSibling(ancestor.node) === ancestor.previous &&
        imageNextCommittedSibling(ancestor.node) === ancestor.next,
    )
  );
}

function imageRadixStyleTextIsExact(value: string | null) {
  const normalized = value?.trim() ?? "";
  return (
    normalized === "" ||
    /^pointer-events:\s*(?:auto|none);?$/i.test(normalized)
  );
}

function imageRadixContentStyleIsExact(content: HTMLDivElement) {
  return (
    imageRadixStyleTextIsExact(content.getAttribute("style")) &&
    (content.style.pointerEvents === "" ||
      content.style.pointerEvents === "auto")
  );
}

interface ImageDomGuard {
  readonly isClean: (
    changing?: "url" | "alt" | "file" | null,
  ) => boolean;
  readonly finishCommit: () => void;
  readonly sealForSubmit: () => boolean;
  readonly release: () => boolean;
}

function createImageDomGuard(
  dom: ImageDom,
  placement: ImagePlacement,
  committedDomMatches: () => boolean,
  onDirty: () => void,
): ImageDomGuard | null {
  const ownerWindow = placement.document.defaultView;
  const Observer = ownerWindow?.MutationObserver;
  if (!ownerWindow || !Observer) return null;
  let changed = false;
  let released = false;
  let reactCommitSettling = true;
  const controlledInputs = new Set(
    [dom.url, dom.alt, dom.file].filter(
      (input): input is HTMLInputElement => input !== null,
    ),
  );
  const radixContentSettling = new Map(
    [...IMAGE_RADIX_SETTLING_ATTRIBUTES].map((attribute) => [attribute, 4]),
  );
  const radixOverlaySettling = new Map(
    ["aria-hidden", "data-aria-hidden"].map((attribute) => [attribute, 4]),
  );
  const claimRadixSettlement = (
    allowances: Map<string, number>,
    attribute: string,
  ) => {
    const remaining = allowances.get(attribute) ?? 0;
    if (remaining === 0) return false;
    if (remaining === 1) allowances.delete(attribute);
    else allowances.set(attribute, remaining - 1);
    return true;
  };
  const exactControlledInputReconciliation = (
    records: readonly MutationRecord[],
    index: number,
  ) => {
    const start = records[index];
    if (
      start?.type !== "attributes" ||
      start.attributeName !== "name" ||
      start.oldValue !== null ||
      !(start.target instanceof ownerWindow.HTMLInputElement) ||
      !controlledInputs.has(start.target)
    ) {
      return 0;
    }
    let nextIndex = index + 1;
    const value = records[nextIndex];
    if (
      value?.type === "attributes" &&
      value.target === start.target &&
      value.attributeName === "value"
    ) {
      nextIndex += 1;
    }
    const type = records[nextIndex];
    if (
      type?.type === "attributes" &&
      type.target === start.target &&
      type.attributeName === "type" &&
      type.oldValue === "file" &&
      start.target === dom.file &&
      start.target.type === "file"
    ) {
      nextIndex += 1;
    }
    const end = records[nextIndex];
    if (
      end?.type !== "attributes" ||
      end.target !== start.target ||
      end.attributeName !== "name" ||
      end.oldValue !== "" ||
      start.target.hasAttribute("name")
    ) {
      return 0;
    }
    return nextIndex - index + 1;
  };
  const exactRadixMutation = (record: MutationRecord) => {
    if (
      record.type === "attributes" &&
      record.target === dom.content &&
      record.attributeName &&
      (record.attributeName === "style"
        ? imageRadixStyleTextIsExact(record.oldValue)
        : record.oldValue === null ||
          record.oldValue ===
            dom.content.getAttribute(record.attributeName)) &&
      claimRadixSettlement(radixContentSettling, record.attributeName)
    ) {
      if (record.attributeName === "aria-labelledby") {
        return dom.content.getAttribute(record.attributeName) === dom.title.id;
      }
      if (record.attributeName === "aria-describedby") {
        return (
          dom.content.getAttribute(record.attributeName) === dom.description.id
        );
      }
      return imageRadixContentStyleIsExact(dom.content);
    }
    if (
      record.type === "attributes" &&
      record.target === dom.overlay &&
      record.attributeName &&
      (record.oldValue === null ||
        record.oldValue === "true" ||
        record.oldValue ===
          dom.overlay.getAttribute(record.attributeName)) &&
      claimRadixSettlement(radixOverlaySettling, record.attributeName)
    ) {
      const current = dom.overlay.getAttribute(record.attributeName);
      return current === null || current === "true";
    }
    if (
      record.type === "childList" &&
      record.target === placement.portalParent
    ) {
      const nodes = [...record.addedNodes, ...record.removedNodes];
      return nodes.length > 0 && nodes.every(imageIsRadixFocusGuard);
    }
    return false;
  };
  const markDirty = () => {
    if (changed) return;
    changed = true;
    onDirty();
  };
  const record = (records: readonly MutationRecord[]) => {
    if (changed || records.length === 0) return changed;
    for (let index = 0; index < records.length; index += 1) {
      if (reactCommitSettling) {
        const reconciled = exactControlledInputReconciliation(records, index);
        if (reconciled > 0) {
          index += reconciled - 1;
          continue;
        }
        if (exactRadixMutation(records[index])) continue;
      }
      markDirty();
      break;
    }
    return changed;
  };
  const observer = new Observer((records) => {
    record(records);
  });
  observer.observe(dom.content, {
    attributeOldValue: true,
    attributes: true,
    characterData: true,
    childList: true,
    subtree: true,
  });
  observer.observe(dom.overlay, {
    attributeOldValue: true,
    attributes: true,
    characterData: true,
    childList: true,
    subtree: true,
  });
  observer.observe(dom.bridge, {
    attributeOldValue: true,
    attributes: true,
    characterData: true,
    childList: true,
    subtree: true,
  });
  const observedParents = new Set<Node>();
  for (const parent of [
    placement.portalParent,
    placement.bridge.parent,
    ...placement.ancestors.map((ancestor) => ancestor.parent),
  ]) {
    if (observedParents.has(parent)) continue;
    observedParents.add(parent);
    observer.observe(parent, { childList: true });
  }
  const drain = () => {
    for (let pass = 0; pass < 32; pass += 1) {
      const records = observer.takeRecords();
      if (records.length === 0) return !changed;
      if (record(records)) return false;
    }
    markDirty();
    return false;
  };
  const sealCommit = () => {
    if (!reactCommitSettling) return drain();
    const clean = drain();
    reactCommitSettling = false;
    radixContentSettling.clear();
    radixOverlaySettling.clear();
    return clean;
  };
  return Object.freeze({
    isClean: drain,
    finishCommit: () => {
      sealCommit();
    },
    sealForSubmit: sealCommit,
    release: () => {
      if (released) return !changed;
      released = true;
      const clean = drain();
      observer.disconnect();
      return clean;
    },
  });
}

function imageFileFacts(
  input: HTMLInputElement | null,
): ImageFileFacts | null | undefined {
  if (!input) return null;
  try {
    return Object.freeze({
      value: input.value,
      files: Object.freeze(Array.from(input.files ?? [])),
    });
  } catch {
    return undefined;
  }
}

function imageFileFactsMatch(
  input: HTMLInputElement,
  facts: ImageFileFacts,
) {
  const files = Array.from(input.files ?? []);
  return (
    input.value === facts.value &&
    files.length === facts.files.length &&
    files.every((file, index) => file === facts.files[index])
  );
}

function imageTextNodeMatches(element: Element, text: string) {
  return element.childNodes.item(0)?.textContent?.trim() === text;
}

function resolveImageDom(
  authority: ImageAuthority,
  controls: ImageControls,
  changing: ImageChangingControl = null,
  fileFacts: ImageFileFacts | null = null,
  settledFileReset = false,
): ImageDom | null {
  const bridge = controls.bridge.owner.element();
  const form = controls.form.owner.element();
  const urlLabel = controls.urlLabel.owner.element();
  const urlRow = controls.urlRow.owner.element();
  const url = controls.url.owner.element();
  const upload = controls.upload.owner.element();
  const file = controls.file.owner.element();
  const error = controls.error.owner.element();
  const altLabel = controls.altLabel.owner.element();
  const alt = controls.alt.owner.element();
  const preview = controls.preview.owner.element();
  const actions = controls.actions.owner.element();
  const cancel = controls.cancel.owner.element();
  const insert = controls.insert.owner.element();
  const content = form?.parentElement;
  const ownerWindow = content?.ownerDocument.defaultView;
  const harnessShell =
    !!ownerWindow &&
    bridge instanceof ownerWindow.HTMLDivElement &&
    content instanceof ownerWindow.HTMLDivElement &&
    form instanceof ownerWindow.HTMLFormElement &&
    content.parentElement === bridge &&
    content.getAttribute("role") === "dialog" &&
    content.getAttribute("aria-label") === IMAGE_TITLE &&
    content.attributes.length === 2 &&
    content.children.length === 1 &&
    content.childNodes.length === 1 &&
    content.firstElementChild === form;
  const header = harnessShell ? content : content?.firstElementChild;
  const title = harnessShell
    ? content
    : header?.firstElementChild?.firstElementChild;
  const description = harnessShell ? content : title?.nextElementSibling;
  const close = harnessShell ? cancel : header?.lastElementChild;
  const overlay = harnessShell ? content : content?.previousElementSibling;
  if (
    !ownerWindow ||
    !(bridge instanceof ownerWindow.HTMLDivElement) ||
    !(overlay instanceof ownerWindow.HTMLDivElement) ||
    !(content instanceof ownerWindow.HTMLDivElement) ||
    !(header instanceof ownerWindow.HTMLDivElement) ||
    !(title instanceof ownerWindow.HTMLElement) ||
    !(description instanceof ownerWindow.HTMLElement) ||
    (!(title instanceof ownerWindow.HTMLHeadingElement) && !harnessShell) ||
    (!(description instanceof ownerWindow.HTMLParagraphElement) &&
      !harnessShell) ||
    !(close instanceof ownerWindow.HTMLButtonElement) ||
    !(form instanceof ownerWindow.HTMLFormElement) ||
    !(urlLabel instanceof ownerWindow.HTMLLabelElement) ||
    !(urlRow instanceof ownerWindow.HTMLDivElement) ||
    !(url instanceof ownerWindow.HTMLInputElement) ||
    !(altLabel instanceof ownerWindow.HTMLLabelElement) ||
    !(alt instanceof ownerWindow.HTMLInputElement) ||
    !(actions instanceof ownerWindow.HTMLDivElement) ||
    !(cancel instanceof ownerWindow.HTMLButtonElement) ||
    !(insert instanceof ownerWindow.HTMLButtonElement)
  ) {
    return null;
  }
  const expectedFormChildren =
    3 +
    (authority.error ? 1 : 0) +
    (authority.normalizedSrc ? 1 : 0);
  let formIndex = 0;
  const expectedUrlLabel = form.children.item(formIndex++);
  const expectedError = authority.error ? form.children.item(formIndex++) : null;
  const expectedAltLabel = form.children.item(formIndex++);
  const expectedPreview = authority.normalizedSrc
    ? form.children.item(formIndex++)
    : null;
  const expectedActions = form.children.item(formIndex);
  const closeIcon = close.firstElementChild;
  const exactShell =
    harnessShell
      ? bridge.isConnected &&
        bridge.ownerDocument === content.ownerDocument &&
        bridge.tagName === "DIV" &&
        bridge.className === "contents" &&
        bridge.children.length === 1 &&
        bridge.childNodes.length === 1 &&
        bridge.firstElementChild === content &&
        content.isConnected &&
        content.parentElement === bridge
      : bridge.isConnected &&
        bridge.ownerDocument === content.ownerDocument &&
        bridge.tagName === "DIV" &&
        bridge.className === "contents" &&
        bridge.childNodes.length === 0 &&
        overlay.isConnected &&
        overlay.ownerDocument === content.ownerDocument &&
        overlay.className === "dialog-overlay animate-fade-in" &&
        overlay.getAttribute("data-state") === "open" &&
        overlay.parentNode === content.parentNode &&
        overlay.nextElementSibling === content &&
        content.isConnected &&
        content.tagName === "DIV" &&
        content.className === "dialog animate-fade-in" &&
        imageRadixContentStyleIsExact(content) &&
        content.getAttribute("role") === "dialog" &&
        content.getAttribute("data-state") === "open" &&
        content.children.length === 2 &&
        content.childNodes.length === 2 &&
        content.children.item(0) === header &&
        content.children.item(1) === form &&
        header.parentElement === content &&
        header.className ===
          "mb-4 flex items-start justify-between gap-4" &&
        header.hasAttribute("data-focus-skip") &&
        title.textContent === IMAGE_TITLE &&
        description.textContent === IMAGE_DESCRIPTION &&
        title.id !== "" &&
        description.id !== "" &&
        (content.getAttribute("aria-labelledby") === null ||
          content.getAttribute("aria-labelledby") === title.id) &&
        (content.getAttribute("aria-describedby") === null ||
          content.getAttribute("aria-describedby") === description.id) &&
        close.type === "button" &&
        !close.disabled &&
        close.getAttribute("aria-label") === "Close" &&
        close.className === "icon-btn -mr-2 -mt-1 h-8 w-8 shrink-0" &&
        close.parentElement === header &&
        close.children.length === 1 &&
        closeIcon?.tagName.toLowerCase() === "svg" &&
        closeIcon.getAttribute("width") === "16" &&
        closeIcon.getAttribute("height") === "16" &&
        closeIcon.getAttribute("aria-hidden") === "true";
  const exact =
    authority.open &&
    exactShell &&
    form.isConnected &&
    form.ownerDocument === content.ownerDocument &&
    form.parentElement === content &&
    form.className === IMAGE_FORM_CLASS &&
    form.children.length === expectedFormChildren &&
    form.childNodes.length === expectedFormChildren &&
    expectedUrlLabel === urlLabel &&
    expectedAltLabel === altLabel &&
    expectedActions === actions &&
    urlLabel.parentElement === form &&
    urlLabel.className === IMAGE_LABEL_CLASS &&
    urlLabel.children.length === 1 &&
    urlLabel.childNodes.length === 2 &&
    imageTextNodeMatches(urlLabel, "Image URL") &&
    urlLabel.lastElementChild === urlRow &&
    urlRow.parentElement === urlLabel &&
    urlRow.className === IMAGE_URL_ROW_CLASS &&
    urlRow.children.item(0) === url &&
    url.isConnected &&
    url.ownerDocument === content.ownerDocument &&
    url.type === "text" &&
    url.form === form &&
    !url.disabled &&
    !url.required &&
    url.className === IMAGE_URL_CLASS &&
    url.placeholder === "https://…/image.png" &&
    url.dataset.testid === "image-url" &&
    (changing === "url" || url.value === authority.src) &&
    altLabel.parentElement === form &&
    altLabel.className === IMAGE_LABEL_CLASS &&
    altLabel.children.length === 1 &&
    altLabel.childNodes.length === 2 &&
    imageTextNodeMatches(altLabel, "Alt text") &&
    altLabel.lastElementChild === alt &&
    alt.isConnected &&
    alt.ownerDocument === content.ownerDocument &&
    alt.type === "text" &&
    alt.form === form &&
    !alt.disabled &&
    !alt.required &&
    alt.className === IMAGE_ALT_CLASS &&
    alt.placeholder === "Describe the image" &&
    alt.dataset.testid === "image-alt" &&
    (changing === "alt" || alt.value === authority.alt) &&
    actions.parentElement === form &&
    actions.className === IMAGE_ACTIONS_CLASS &&
    actions.children.length === 2 &&
    actions.childNodes.length === 2 &&
    actions.children.item(0) === cancel &&
    actions.children.item(1) === insert &&
    cancel.type === "button" &&
    cancel.form === form &&
    !cancel.disabled &&
    cancel.className === IMAGE_CANCEL_CLASS &&
    cancel.textContent === "Cancel" &&
    insert.type === "submit" &&
    insert.form === form &&
    insert.disabled === authority.submitDisabled &&
    insert.matches(":disabled") === authority.submitDisabled &&
    insert.className === IMAGE_INSERT_CLASS &&
    insert.dataset.testid === "image-submit" &&
    insert.textContent === "Insert";
  if (!exact) return null;
  if (authority.uploadAvailable) {
    if (
      !(upload instanceof ownerWindow.HTMLButtonElement) ||
      !(file instanceof ownerWindow.HTMLInputElement) ||
      upload.parentElement !== urlRow ||
      file.parentElement !== urlRow ||
      urlRow.children.length !== 3 ||
      urlRow.childNodes.length !== 3 ||
      urlRow.children.item(1) !== upload ||
      urlRow.children.item(2) !== file ||
      upload.type !== "button" ||
      upload.form !== form ||
      upload.disabled !== authority.uploadDisabled ||
      upload.matches(":disabled") !== authority.uploadDisabled ||
      upload.className !== IMAGE_UPLOAD_CLASS ||
      upload.dataset.testid !== "image-upload" ||
      upload.textContent !== (authority.uploading ? "Uploading…" : "Upload…") ||
      file.type !== "file" ||
      file.form !== form ||
      file.disabled !== authority.uploadDisabled ||
      file.matches(":disabled") !== authority.uploadDisabled ||
      file.accept !== IMAGE_FILE_ACCEPT ||
      file.className !== "hidden" ||
      file.dataset.testid !== "image-file" ||
      (changing !== "file" &&
        !settledFileReset &&
        fileFacts !== null &&
        !imageFileFactsMatch(file, fileFacts))
    ) {
      return null;
    }
  } else if (
    upload !== null ||
    file !== null ||
    urlRow.children.length !== 1 ||
    urlRow.querySelector('[data-testid="image-upload"]') ||
    urlRow.querySelector('[data-testid="image-file"]')
  ) {
    return null;
  }
  if (authority.error) {
    if (
      !(error instanceof ownerWindow.HTMLDivElement) ||
      expectedError !== error ||
      error.parentElement !== form ||
      error.className !== IMAGE_ERROR_CLASS ||
      error.getAttribute("role") !== "alert" ||
      error.dataset.testid !== "image-upload-error" ||
      error.children.length !== 0 ||
      error.textContent !== authority.error
    ) {
      return null;
    }
  } else if (
    error !== null ||
    expectedError !== null ||
    form.querySelector('[data-testid="image-upload-error"]')
  ) {
    return null;
  }
  if (authority.normalizedSrc) {
    if (
      !(preview instanceof ownerWindow.HTMLImageElement) ||
      expectedPreview !== preview ||
      preview.parentElement !== form ||
      preview.getAttribute("src") !== authority.normalizedSrc ||
      preview.alt !== "" ||
      preview.className !== IMAGE_PREVIEW_CLASS ||
      preview.style.display !== (authority.previewFailed ? "none" : "")
    ) {
      return null;
    }
  } else if (
    preview !== null ||
    expectedPreview !== null ||
    form.querySelector(`img.${IMAGE_PREVIEW_CLASS.split(" ")[0]}`)
  ) {
    return null;
  }
  return {
    bridge,
    overlay,
    content,
    header,
    title,
    description,
    close,
    form,
    urlLabel,
    urlRow,
    url,
    upload,
    file,
    error,
    altLabel,
    alt,
    preview,
    actions,
    cancel,
    insert,
  };
}

function captureImageNativeRelationProperty(
  target: object,
  key: PropertyKey,
): ImageNativePropertySnapshot | null {
  const descriptor = IMAGE_APPLY(
    IMAGE_GET_OWN_PROPERTY_DESCRIPTOR,
    null,
    [target, key],
  ) as PropertyDescriptor | undefined;
  if (!descriptor) return null;
  const data =
    IMAGE_APPLY(IMAGE_HAS_OWN, descriptor, ["value"]) ||
    IMAGE_APPLY(IMAGE_HAS_OWN, descriptor, ["writable"]);
  return Object.freeze({
    key,
    kind: data ? "data" : "accessor",
    configurable: descriptor.configurable === true,
    enumerable: descriptor.enumerable === true,
    value: data ? descriptor.value : undefined,
    writable: data && descriptor.writable === true,
    get: data ? undefined : descriptor.get,
    set: data ? undefined : descriptor.set,
  });
}

function imageNativeRelationPropertyMatches(
  target: object,
  expected: ImageNativePropertySnapshot,
) {
  const actual = captureImageNativeRelationProperty(target, expected.key);
  return Boolean(
    actual &&
      actual.kind === expected.kind &&
      actual.configurable === expected.configurable &&
      actual.enumerable === expected.enumerable &&
      actual.value === expected.value &&
      actual.writable === expected.writable &&
      actual.get === expected.get &&
      actual.set === expected.set,
  );
}

function captureImageNativeSubmitCancellationMonitor(
  ownerWindow: Window & typeof globalThis,
): ImageNativeSubmitCancellationMonitor | null {
  const eventPrototype = ownerWindow.Event.prototype;
  const descriptor = IMAGE_APPLY(
    IMAGE_GET_OWN_PROPERTY_DESCRIPTOR,
    null,
    [eventPrototype, "preventDefault"],
  ) as PropertyDescriptor | undefined;
  const existing = IMAGE_APPLY(
    IMAGE_WEAK_MAP_GET,
    IMAGE_NATIVE_SUBMIT_CANCELLATION_MONITORS,
    [eventPrototype],
  ) as ImageNativeSubmitCancellationMonitor | undefined;
  if (
    existing &&
    descriptor?.value === existing.wrappedPreventDefault
  ) {
    return existing;
  }
  const nativePreventDefault = descriptor?.value;
  const defaultPrevented = IMAGE_APPLY(
    IMAGE_GET_OWN_PROPERTY_DESCRIPTOR,
    null,
    [eventPrototype, "defaultPrevented"],
  )?.get;
  if (
    typeof nativePreventDefault !== "function" ||
    typeof defaultPrevented !== "function"
  ) {
    return null;
  }
  const internalEvents = new WeakSet<Event>();
  const externalEvents = new WeakSet<Event>();
  const wrappedPreventDefault = function (this: Event) {
    if (
      !IMAGE_APPLY(IMAGE_WEAK_SET_HAS, internalEvents, [this])
    ) {
      IMAGE_APPLY(IMAGE_WEAK_SET_ADD, externalEvents, [this]);
    }
    IMAGE_APPLY(nativePreventDefault, this, []);
  };
  const monitor: ImageNativeSubmitCancellationMonitor = Object.freeze({
    wrappedPreventDefault,
    preventDefault: (event: Event) => {
      IMAGE_APPLY(IMAGE_WEAK_SET_ADD, internalEvents, [event]);
      try {
        IMAGE_APPLY(wrappedPreventDefault, event, []);
      } finally {
        IMAGE_APPLY(IMAGE_WEAK_SET_DELETE, internalEvents, [event]);
      }
      return IMAGE_APPLY(defaultPrevented, event, []) as boolean;
    },
    externalPreventionAttempted: (event: Event) =>
      IMAGE_APPLY(IMAGE_WEAK_SET_HAS, externalEvents, [event]) as boolean,
  });
  try {
    IMAGE_APPLY(IMAGE_DEFINE_PROPERTY, null, [
      eventPrototype,
      "preventDefault",
      { ...descriptor, value: wrappedPreventDefault },
    ]);
  } catch {
    return Object.freeze({
      wrappedPreventDefault: nativePreventDefault,
      preventDefault: (event: Event) => {
        IMAGE_APPLY(nativePreventDefault, event, []);
        return IMAGE_APPLY(defaultPrevented, event, []) as boolean;
      },
      externalPreventionAttempted: () => true,
    });
  }
  IMAGE_APPLY(IMAGE_WEAK_MAP_SET, IMAGE_NATIVE_SUBMIT_CANCELLATION_MONITORS, [
    eventPrototype,
    monitor,
  ]);
  return monitor;
}

if (typeof window !== "undefined") {
  captureImageNativeSubmitCancellationMonitor(
    window as Window & typeof globalThis,
  );
}

function captureImageNativeSubmitOwnerRealm(
  node: Node,
): ImageNativeSubmitOwnerRealm | null {
  const getDescriptor = (target: object, key: PropertyKey) =>
    IMAGE_APPLY(IMAGE_GET_OWN_PROPERTY_DESCRIPTOR, null, [
      target,
      key,
    ]) as PropertyDescriptor | undefined;
  const getPrototype = (target: object) =>
    IMAGE_APPLY(IMAGE_GET_PROTOTYPE_OF, null, [target]) as object | null;
  let nodePrototype: object | null = null;
  let ownerDocumentGetter: PropertyDescriptor["get"];
  let current: object | null = node;
  for (let depth = 0; current && depth < 16; depth += 1) {
    const parent = getPrototype(current);
    const isConnected = getDescriptor(current, "isConnected")?.get;
    const ownerDocument = getDescriptor(current, "ownerDocument")?.get;
    const parentElement = getDescriptor(current, "parentElement")?.get;
    const contains = getDescriptor(current, "contains")?.value;
    if (
      parent &&
      typeof isConnected === "function" &&
      typeof ownerDocument === "function" &&
      typeof parentElement === "function" &&
      typeof contains === "function" &&
      typeof getDescriptor(parent, "addEventListener")?.value === "function" &&
      typeof getDescriptor(parent, "removeEventListener")?.value ===
        "function" &&
      typeof getDescriptor(parent, "dispatchEvent")?.value === "function"
    ) {
      nodePrototype = current;
      ownerDocumentGetter = ownerDocument;
    }
    current = parent;
  }
  if (!nodePrototype || !ownerDocumentGetter) return null;
  const ownerDocument = IMAGE_APPLY(ownerDocumentGetter, node, []) as
    | Document
    | null;
  if (!ownerDocument || typeof ownerDocument !== "object") return null;
  let documentPrototype: object | null = null;
  let defaultViewGetter: PropertyDescriptor["get"];
  current = ownerDocument;
  for (let depth = 0; current && depth < 16; depth += 1) {
    const parent = getPrototype(current);
    const defaultView = getDescriptor(current, "defaultView")?.get;
    if (parent === nodePrototype && typeof defaultView === "function") {
      documentPrototype = current;
      defaultViewGetter = defaultView;
    }
    current = parent;
  }
  if (!documentPrototype || !defaultViewGetter) return null;
  const ownerWindow = IMAGE_APPLY(defaultViewGetter, ownerDocument, []) as
    | (Window & typeof globalThis)
    | null;
  if (
    !ownerWindow ||
    ownerWindow.Node.prototype !== nodePrototype ||
    ownerWindow.Document.prototype !== documentPrototype
  ) {
    return null;
  }
  const formPrototype = ownerWindow.HTMLFormElement.prototype;
  const insertPrototype = ownerWindow.HTMLButtonElement.prototype;
  const eventTargetPrototype = ownerWindow.EventTarget.prototype;
  const documentSurface: ImageNativeRelationSnapshot[] = [];
  current = ownerDocument;
  while (current && documentSurface.length < 16) {
    documentSurface.push(
      Object.freeze({
        target: current,
        properties: Object.freeze([
          captureImageNativeRelationProperty(current, "defaultView"),
        ]),
      }),
    );
    current = getPrototype(current);
  }
  if (current !== null) return null;
  const isConnected = captureImageNativeRelationProperty(
    nodePrototype,
    "isConnected",
  );
  const ownerDocumentProperty = captureImageNativeRelationProperty(
    nodePrototype,
    "ownerDocument",
  );
  const parentElement = captureImageNativeRelationProperty(
    nodePrototype,
    "parentElement",
  );
  const contains = captureImageNativeRelationProperty(
    nodePrototype,
    "contains",
  );
  const defaultViewProperty = captureImageNativeRelationProperty(
    documentPrototype,
    "defaultView",
  );
  const insertFormProperty = captureImageNativeRelationProperty(
    insertPrototype,
    "form",
  );
  const addEventListenerProperty = captureImageNativeRelationProperty(
    eventTargetPrototype,
    "addEventListener",
  );
  const removeEventListenerProperty = captureImageNativeRelationProperty(
    eventTargetPrototype,
    "removeEventListener",
  );
  const nativeEvent = captureImageNativeSubmitIntrinsics(ownerWindow);
  const isConnectedGetter = isConnected?.get;
  const ownerDocumentIntrinsic = ownerDocumentProperty?.get;
  const parentElementGetter = parentElement?.get;
  const containsMethod = contains?.value;
  const insertFormGetter = insertFormProperty?.get;
  const addEventListenerMethod = addEventListenerProperty?.value;
  const removeEventListenerMethod = removeEventListenerProperty?.value;
  if (
    !isConnected ||
    typeof isConnectedGetter !== "function" ||
    !ownerDocumentProperty ||
    typeof ownerDocumentIntrinsic !== "function" ||
    !parentElement ||
    typeof parentElementGetter !== "function" ||
    !contains ||
    typeof containsMethod !== "function" ||
    !defaultViewProperty ||
    typeof defaultViewProperty.get !== "function" ||
    !insertFormProperty ||
    typeof insertFormGetter !== "function" ||
    !addEventListenerProperty ||
    typeof addEventListenerMethod !== "function" ||
    !removeEventListenerProperty ||
    typeof removeEventListenerMethod !== "function" ||
    !nativeEvent
  ) {
    return null;
  }
  return Object.freeze({
    ownerDocument,
    ownerWindow,
    nodePrototype,
    documentPrototype,
    formPrototype,
    insertPrototype,
    eventTargetPrototype,
    relationProperties: Object.freeze([
      isConnected,
      ownerDocumentProperty,
      parentElement,
      contains,
    ]),
    documentSurface: Object.freeze(documentSurface),
    defaultViewProperty,
    insertFormProperty,
    addEventListenerProperty,
    removeEventListenerProperty,
    nativeEvent,
    addEventListener: (
      target: EventTarget,
      type: string,
      listener: (event: Event) => void,
      options?: boolean | AddEventListenerOptions,
    ) => {
      IMAGE_APPLY(addEventListenerMethod, target, [
        type,
        listener,
        options,
      ]);
    },
    removeEventListener: (
      target: EventTarget,
      type: string,
      listener: (event: Event) => void,
      options?: boolean | EventListenerOptions,
    ) => {
      IMAGE_APPLY(removeEventListenerMethod, target, [
        type,
        listener,
        options,
      ]);
    },
    isConnected: (target: Node) =>
      IMAGE_APPLY(isConnectedGetter, target, []) as boolean,
    ownerDocumentOf: (target: Node) =>
      IMAGE_APPLY(ownerDocumentIntrinsic, target, []) as Document | null,
    parentElement: (target: Node) =>
      IMAGE_APPLY(parentElementGetter, target, []) as Element | null,
    contains: (target: Node, other: Node) =>
      IMAGE_APPLY(containsMethod, target, [other]) as boolean,
    insertForm: (target: HTMLButtonElement) =>
      IMAGE_APPLY(insertFormGetter, target, []) as HTMLFormElement | null,
  });
}

function captureImageNativeSubmitDomIntrinsics(
  realm: ImageNativeSubmitOwnerRealm,
  form: HTMLFormElement,
  insert: HTMLButtonElement,
): ImageNativeSubmitDomIntrinsics | null {
  const { ownerWindow } = realm;
  const getDescriptor = (target: object, key: PropertyKey) =>
    IMAGE_APPLY(IMAGE_GET_OWN_PROPERTY_DESCRIPTOR, null, [
      target,
      key,
    ]) as PropertyDescriptor | undefined;
  const getPrototype = (target: object) =>
    IMAGE_APPLY(IMAGE_GET_PROTOTYPE_OF, null, [target]) as object | null;
  const propertySnapshot = (
    target: object,
    key: PropertyKey,
  ): ImageNativePropertySnapshot | null => {
    const descriptor = getDescriptor(target, key);
    if (!descriptor) return null;
    const data =
      IMAGE_APPLY(IMAGE_HAS_OWN, descriptor, ["value"]) ||
      IMAGE_APPLY(IMAGE_HAS_OWN, descriptor, ["writable"]);
    return Object.freeze({
      key,
      kind: data ? "data" : "accessor",
      configurable: descriptor.configurable === true,
      enumerable: descriptor.enumerable === true,
      value: data ? descriptor.value : undefined,
      writable: data && descriptor.writable === true,
      get: data ? undefined : descriptor.get,
      set: data ? undefined : descriptor.set,
    });
  };
  const captureSurface = (
    target: object,
    keys: readonly PropertyKey[],
  ): readonly ImageNativeRelationSnapshot[] | null => {
    const surface: ImageNativeRelationSnapshot[] = [];
    let current: object | null = target;
    while (current && surface.length < 16) {
      surface.push(
        Object.freeze({
          target: current,
          properties: Object.freeze(
            keys.map((key) => propertySnapshot(current as object, key)),
          ),
        }),
      );
      current = getPrototype(current);
    }
    return current === null ? Object.freeze(surface) : null;
  };
  const propertyMatches = (
    target: object,
    expected: ImageNativePropertySnapshot | null,
    key: PropertyKey,
  ) => {
    const actual = propertySnapshot(target, key);
    return (
      actual === expected ||
      (actual !== null &&
        expected !== null &&
        actual.key === expected.key &&
        actual.kind === expected.kind &&
        actual.configurable === expected.configurable &&
        actual.enumerable === expected.enumerable &&
        actual.value === expected.value &&
        actual.writable === expected.writable &&
        actual.get === expected.get &&
        actual.set === expected.set)
    );
  };
  const surfaceMatches = (
    target: object,
    keys: readonly PropertyKey[],
    expected: readonly ImageNativeRelationSnapshot[],
  ) => {
    let current: object | null = target;
    for (let index = 0; index < expected.length; index += 1) {
      const snapshot = expected[index];
      if (current !== snapshot.target) return false;
      for (let property = 0; property < keys.length; property += 1) {
        if (
          !propertyMatches(
            current,
            snapshot.properties[property] ?? null,
            keys[property],
          )
        ) {
          return false;
        }
      }
      current = getPrototype(current);
    }
    return current === null;
  };
  const formKeys = Object.freeze([
    "isConnected",
    "ownerDocument",
    "parentElement",
    "contains",
  ]);
  const insertKeys = Object.freeze(["form"]);
  const documentKeys = Object.freeze(["defaultView"]);
  const formPrototype = realm.formPrototype;
  const insertPrototype = realm.insertPrototype;
  const nodePrototype = realm.nodePrototype;
  const chainIncludes = (target: object, expected: object) => {
    let current: object | null = target;
    for (let depth = 0; current && depth < 16; depth += 1) {
      if (current === expected) return true;
      current = getPrototype(current);
    }
    return false;
  };
  if (
    !chainIncludes(form, formPrototype) ||
    !chainIncludes(insert, insertPrototype)
  ) {
    return null;
  }
  const propertiesAreAbsent = (
    target: object,
    keys: readonly PropertyKey[],
  ) => {
    for (let index = 0; index < keys.length; index += 1) {
      if (getDescriptor(target, keys[index])) return false;
    }
    return true;
  };
  let relationPrototype: object | null = formPrototype;
  let canonicalRelationSlots = true;
  while (relationPrototype && relationPrototype !== nodePrototype) {
    if (!propertiesAreAbsent(relationPrototype, formKeys)) {
      canonicalRelationSlots = false;
    }
    relationPrototype = getPrototype(relationPrototype);
  }
  if (relationPrototype !== nodePrototype) return null;
  const canonicalFormSurface = captureSurface(formPrototype, formKeys);
  const canonicalInsertSurface = captureSurface(insertPrototype, insertKeys);
  const realmIsCanonical = () => {
    if (
      ownerWindow.Node.prototype !== nodePrototype ||
      ownerWindow.Document.prototype !== realm.documentPrototype ||
      ownerWindow.HTMLFormElement.prototype !== formPrototype ||
      ownerWindow.HTMLButtonElement.prototype !== insertPrototype ||
      ownerWindow.EventTarget.prototype !== realm.eventTargetPrototype ||
      !surfaceMatches(
        realm.ownerDocument,
        documentKeys,
        realm.documentSurface,
      ) ||
      !imageNativeRelationPropertyMatches(
        realm.documentPrototype,
        realm.defaultViewProperty,
      ) ||
      !imageNativeRelationPropertyMatches(
        insertPrototype,
        realm.insertFormProperty,
      ) ||
      !imageNativeRelationPropertyMatches(
        realm.eventTargetPrototype,
        realm.addEventListenerProperty,
      ) ||
      !imageNativeRelationPropertyMatches(
        realm.eventTargetPrototype,
        realm.removeEventListenerProperty,
      )
    ) {
      return false;
    }
    for (
      let index = 0;
      index < realm.relationProperties.length;
      index += 1
    ) {
      if (
        !imageNativeRelationPropertyMatches(
          nodePrototype,
          realm.relationProperties[index],
        )
      ) {
        return false;
      }
    }
    return true;
  };
  if (
    !canonicalFormSurface ||
    !canonicalInsertSurface ||
    !surfaceMatches(formPrototype, formKeys, canonicalFormSurface) ||
    !surfaceMatches(insertPrototype, insertKeys, canonicalInsertSurface)
  ) {
    return null;
  }
  return Object.freeze({
    surfaceIsCanonical: () =>
      realmIsCanonical() &&
      canonicalRelationSlots &&
      getPrototype(form) === formPrototype &&
      getPrototype(insert) === insertPrototype &&
      propertiesAreAbsent(form, formKeys) &&
      propertiesAreAbsent(insert, insertKeys) &&
      surfaceMatches(formPrototype, formKeys, canonicalFormSurface) &&
      surfaceMatches(insertPrototype, insertKeys, canonicalInsertSurface),
    addFormSubmitListener: (
      listener: (event: Event) => void,
      options?: boolean | AddEventListenerOptions,
    ) => {
      realm.addEventListener(form, "submit", listener, options);
    },
    removeFormSubmitListener: (
      listener: (event: Event) => void,
      options?: boolean | EventListenerOptions,
    ) => {
      realm.removeEventListener(form, "submit", listener, options);
    },
    nodeIsConnected: (node: Node) =>
      node === form ? realm.isConnected(node) : node.isConnected,
    formIsConnected: () => realm.isConnected(form),
    formOwnerDocument: () => realm.ownerDocumentOf(form),
    formParentElement: () => realm.parentElement(form),
    formContains: (node: Node) => realm.contains(form, node),
    insertForm: () => realm.insertForm(insert),
  });
}

function captureImageNativeSubmitIntrinsics(
  ownerWindow: Window & typeof globalThis,
): ImageNativeSubmitIntrinsics | null {
  const EventConstructor = ownerWindow.Event;
  const SubmitEventConstructor = ownerWindow.SubmitEvent;
  const eventPrototype = EventConstructor.prototype;
  const cancellationMonitor =
    captureImageNativeSubmitCancellationMonitor(ownerWindow);
  if (!cancellationMonitor) return null;
  const getOwnPropertyDescriptor = (
    target: object,
    property: PropertyKey,
  ) =>
    IMAGE_APPLY(IMAGE_GET_OWN_PROPERTY_DESCRIPTOR, null, [
      target,
      property,
    ]) as PropertyDescriptor | undefined;
  const getPrototypeOf = (target: object) =>
    IMAGE_APPLY(IMAGE_GET_PROTOTYPE_OF, null, [target]) as object | null;
  const captureProperties = (
    target: object,
  ): readonly ImageNativePropertySnapshot[] | null => {
    const keys = IMAGE_APPLY(IMAGE_OWN_KEYS, null, [target]) as PropertyKey[];
    const properties: ImageNativePropertySnapshot[] = [];
    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index];
      const descriptor = getOwnPropertyDescriptor(target, key);
      if (!descriptor) return null;
      const data =
        IMAGE_APPLY(IMAGE_HAS_OWN, descriptor, ["value"]) ||
        IMAGE_APPLY(IMAGE_HAS_OWN, descriptor, ["writable"]);
      properties.push(
        Object.freeze({
          key,
          kind: data ? "data" : "accessor",
          configurable: descriptor.configurable === true,
          enumerable: descriptor.enumerable === true,
          value: data ? descriptor.value : undefined,
          writable: data && descriptor.writable === true,
          get: data ? undefined : descriptor.get,
          set: data ? undefined : descriptor.set,
        }),
      );
    }
    return Object.freeze(properties);
  };
  const propertiesMatch = (
    target: object,
    expected: readonly ImageNativePropertySnapshot[],
  ) => {
    const actual = captureProperties(target);
    if (!actual || actual.length !== expected.length) return false;
    for (let index = 0; index < expected.length; index += 1) {
      const left = actual[index];
      const right = expected[index];
      if (
        left.key !== right.key ||
        left.kind !== right.kind ||
        left.configurable !== right.configurable ||
        left.enumerable !== right.enumerable ||
        left.value !== right.value ||
        left.writable !== right.writable ||
        left.get !== right.get ||
        left.set !== right.set
      ) {
        return false;
      }
    }
    return true;
  };
  const capturePrototypeChain = (
    first: object,
  ): readonly ImageNativePrototypeSnapshot[] | null => {
    const chain: ImageNativePrototypeSnapshot[] = [];
    let current: object | null = first;
    while (current && chain.length < 16) {
      const properties = captureProperties(current);
      if (!properties) return null;
      chain.push(Object.freeze({ prototype: current, properties }));
      current = getPrototypeOf(current);
    }
    return current === null ? Object.freeze(chain) : null;
  };
  const eventPrototypeChain = capturePrototypeChain(eventPrototype);
  const submitEventPrototypeChain =
    typeof SubmitEventConstructor === "function"
      ? capturePrototypeChain(SubmitEventConstructor.prototype)
      : null;
  if (
    !eventPrototypeChain ||
    (typeof SubmitEventConstructor === "function" &&
      !submitEventPrototypeChain)
  ) {
    return null;
  }
  const canonicalChain = (event: Event) => {
    const prototype = getPrototypeOf(event);
    if (prototype === eventPrototypeChain[0]?.prototype) {
      return eventPrototypeChain;
    }
    if (prototype === submitEventPrototypeChain?.[0]?.prototype) {
      return submitEventPrototypeChain;
    }
    return null;
  };
  const prototypeChainMatches = (
    event: Event,
    expected: readonly ImageNativePrototypeSnapshot[],
  ) => {
    let current: object | null = getPrototypeOf(event);
    for (let index = 0; index < expected.length; index += 1) {
      const snapshot = expected[index];
      if (
        current !== snapshot.prototype ||
        !propertiesMatch(current, snapshot.properties)
      ) {
        return false;
      }
      current = getPrototypeOf(current);
    }
    return current === null;
  };
  const getter = <T,>(property: keyof Event) => {
    const value = getOwnPropertyDescriptor(eventPrototype, property)?.get;
    return typeof value === "function"
      ? (event: Event) => IMAGE_APPLY(value, event, []) as T
      : null;
  };
  const type = getter<string>("type");
  const target = getter<EventTarget | null>("target");
  const eventPhase = getter<number>("eventPhase");
  const defaultPrevented = getter<boolean>("defaultPrevented");
  const bubbles = getter<boolean>("bubbles");
  const cancelable = getter<boolean>("cancelable");
  const propagationStopped = getter<boolean>("cancelBubble");
  const composedPath = getOwnPropertyDescriptor(
    eventPrototype,
    "composedPath",
  )?.value;
  const preventDefault = getOwnPropertyDescriptor(
    eventPrototype,
    "preventDefault",
  )?.value;
  const stopImmediatePropagation = getOwnPropertyDescriptor(
    eventPrototype,
    "stopImmediatePropagation",
  )?.value;
  const submitter =
    typeof SubmitEventConstructor === "function"
      ? getOwnPropertyDescriptor(
          SubmitEventConstructor.prototype,
          "submitter",
        )?.get
      : null;
  if (
    !type ||
    !target ||
    !eventPhase ||
    !defaultPrevented ||
    !bubbles ||
    !cancelable ||
    !propagationStopped ||
    typeof composedPath !== "function" ||
    typeof preventDefault !== "function" ||
    typeof stopImmediatePropagation !== "function" ||
    (typeof SubmitEventConstructor === "function" &&
      typeof submitter !== "function")
  ) {
    return null;
  }
  const isEvent = (value: unknown): value is Event =>
    typeof value === "object" &&
    value !== null &&
    IMAGE_APPLY(IMAGE_HAS_INSTANCE, EventConstructor, [value]);
  const isSubmitEvent = (value: Event) =>
    typeof SubmitEventConstructor === "function" &&
    IMAGE_APPLY(IMAGE_HAS_INSTANCE, SubmitEventConstructor, [value]);
  const publicSurfaces = new WeakMap<
    Event,
    {
      readonly ownProperties: readonly ImageNativePropertySnapshot[];
      readonly prototypeChain: readonly ImageNativePrototypeSnapshot[];
    }
  >();
  return Object.freeze({
    isEvent,
    isSubmitEvent,
    type,
    target,
    eventPhase,
    defaultPrevented,
    bubbles,
    cancelable,
    composedPath: (event: Event) =>
      IMAGE_APPLY(composedPath, event, []) as EventTarget[],
    submitter: (event: Event) =>
      isSubmitEvent(event) && submitter
        ? (IMAGE_APPLY(submitter, event, []) as HTMLElement | null)
        : null,
    preventDefault: cancellationMonitor.preventDefault,
    externalPreventionAttempted:
      cancellationMonitor.externalPreventionAttempted,
    capturePublicSurface: (event: Event) => {
      IMAGE_APPLY(IMAGE_WEAK_MAP_DELETE, publicSurfaces, [event]);
      const prototypeChain = canonicalChain(event);
      const ownProperties = captureProperties(event);
      if (
        !prototypeChain ||
        !ownProperties ||
        !prototypeChainMatches(event, prototypeChain)
      ) {
        return false;
      }
      IMAGE_APPLY(IMAGE_WEAK_MAP_SET, publicSurfaces, [
        event,
        Object.freeze({
          ownProperties,
          prototypeChain,
        }),
      ]);
      return true;
    },
    publicSurfaceIsCanonical: (event: Event) => {
      const captured = IMAGE_APPLY(IMAGE_WEAK_MAP_GET, publicSurfaces, [
        event,
      ]) as
        | {
            readonly ownProperties: readonly ImageNativePropertySnapshot[];
            readonly prototypeChain: readonly ImageNativePrototypeSnapshot[];
          }
        | undefined;
      return (
        captured !== undefined &&
        prototypeChainMatches(event, captured.prototypeChain) &&
        propertiesMatch(event, captured.ownProperties)
      );
    },
    releasePublicSurface: (event: Event) => {
      IMAGE_APPLY(IMAGE_WEAK_MAP_DELETE, publicSurfaces, [event]);
    },
    propagationStopped,
    stopImmediatePropagation: (event: Event) => {
      IMAGE_APPLY(stopImmediatePropagation, event, []);
    },
  });
}

function imageReactEnvelope(
  event: React.SyntheticEvent,
  reactName: string,
  syntheticType: string,
  currentTarget: EventTarget,
  content: HTMLDivElement,
) {
  if (!event || typeof event !== "object") return null;
  const ownerWindow = content.ownerDocument.defaultView;
  const nativeEvent = event.nativeEvent;
  const target = event.target;
  const wrapper = event as React.SyntheticEvent & {
    readonly _reactName?: unknown;
    readonly isDefaultPrevented?: unknown;
    readonly isPropagationStopped?: unknown;
    readonly persist?: unknown;
  };
  if (
    !ownerWindow ||
    !(nativeEvent instanceof ownerWindow.Event) ||
    nativeEvent.eventPhase === ownerWindow.Event.NONE ||
    nativeEvent.type === "" ||
    event.type !== syntheticType ||
    event.currentTarget !== currentTarget ||
    event.eventPhase !== nativeEvent.eventPhase ||
    event.defaultPrevented ||
    nativeEvent.defaultPrevented ||
    nativeEvent.target !== target ||
    !(target instanceof ownerWindow.Node) ||
    target.ownerDocument !== content.ownerDocument ||
    !nativeEvent.composedPath().includes(target) ||
    !nativeEvent.composedPath().includes(content) ||
    !nativeEvent.composedPath().includes(content.ownerDocument) ||
    wrapper._reactName !== reactName ||
    typeof wrapper.isDefaultPrevented !== "function" ||
    wrapper.isDefaultPrevented() ||
    typeof wrapper.isPropagationStopped !== "function" ||
    wrapper.isPropagationStopped() ||
    typeof wrapper.persist !== "function"
  ) {
    return null;
  }
  return nativeEvent;
}

function imageExactNativeInput(
  event: React.ChangeEvent<HTMLInputElement>,
  input: HTMLInputElement,
  publication: ImagePublication,
) {
  const nativeEvent = imageReactEnvelope(
    event,
    "onChange",
    "change",
    input,
    publication.dom.content,
  );
  const ownerWindow = publication.ownerDocument.defaultView;
  return nativeEvent &&
    ownerWindow &&
    nativeEvent instanceof ownerWindow.Event &&
    (nativeEvent.type === "input" || nativeEvent.type === "change") &&
    event.target === input &&
    nativeEvent.target === input &&
    input.isConnected &&
    input.ownerDocument === publication.ownerDocument &&
    imageSnapshotContains(publication.contentTree, input)
    ? nativeEvent
    : null;
}

function imageExactNativeClick(
  event: React.MouseEvent<HTMLElement>,
  currentTarget: HTMLElement,
  control: HTMLElement,
  publication: ImagePublication,
) {
  const nativeEvent = imageReactEnvelope(
    event,
    "onClick",
    "click",
    currentTarget,
    publication.dom.content,
  );
  const ownerWindow = publication.ownerDocument.defaultView;
  const target = event.target;
  return nativeEvent &&
    ownerWindow &&
    nativeEvent instanceof ownerWindow.MouseEvent &&
    nativeEvent.type === "click" &&
    nativeEvent.button === 0 &&
    event.button === 0 &&
    nativeEvent.bubbles &&
    event.bubbles &&
    target instanceof ownerWindow.Node &&
    control.contains(target) &&
    nativeEvent.composedPath().includes(control) &&
    imageSnapshotContains(publication.contentTree, target)
    ? nativeEvent
    : null;
}

function imageExactNativeError(
  event: React.SyntheticEvent<HTMLImageElement>,
  preview: HTMLImageElement,
  publication: ImagePublication,
) {
  const nativeEvent = imageReactEnvelope(
    event,
    "onError",
    "error",
    preview,
    publication.dom.content,
  );
  return nativeEvent?.type === "error" &&
    event.target === preview &&
    nativeEvent.target === preview &&
    imageSnapshotContains(publication.contentTree, preview)
    ? nativeEvent
    : null;
}

function imageExactNativeOwnedFormSubmitEvent(
  nativeEvent: Event,
  provenance: ImageSubmitProvenance,
  expectedDefaultPrevented: boolean | null,
) {
  const { form, nativeDom } = provenance;
  const intrinsics = provenance.nativeEvent;
  if (!intrinsics.isEvent(nativeEvent)) return null;
  const path = intrinsics.composedPath(nativeEvent);
  const currentOwnerDocument = nativeDom.formOwnerDocument();
  if (
    !currentOwnerDocument ||
    intrinsics.eventPhase(nativeEvent) === 0 ||
    intrinsics.type(nativeEvent) !== "submit" ||
    (expectedDefaultPrevented !== null &&
      intrinsics.defaultPrevented(nativeEvent) !== expectedDefaultPrevented) ||
    !intrinsics.bubbles(nativeEvent) ||
    !intrinsics.cancelable(nativeEvent) ||
    intrinsics.target(nativeEvent) !== form ||
    !IMAGE_APPLY(IMAGE_ARRAY_INCLUDES, path, [form]) ||
    !IMAGE_APPLY(IMAGE_ARRAY_INCLUDES, path, [currentOwnerDocument])
  ) {
    return null;
  }
  return nativeEvent;
}

function imageExactNativeSubmitEvent(
  nativeEvent: Event,
  provenance: ImageSubmitProvenance,
  expectedDefaultPrevented: boolean,
) {
  const { form, insert, content, nativeDom } = provenance;
  const intrinsics = provenance.nativeEvent;
  if (
    imageExactNativeOwnedFormSubmitEvent(
      nativeEvent,
      provenance,
      expectedDefaultPrevented,
    ) !== nativeEvent ||
    !nativeDom.surfaceIsCanonical() ||
    !nativeDom.formIsConnected() ||
    nativeDom.formOwnerDocument() !== provenance.ownerDocument ||
    nativeDom.formParentElement() !== content ||
    nativeDom.insertForm() !== form ||
    !nativeDom.formContains(insert)
  ) {
    return null;
  }
  const submitter = intrinsics.submitter(nativeEvent);
  if (
    intrinsics.isSubmitEvent(nativeEvent) &&
    submitter !== null &&
    submitter !== insert
  ) {
    return null;
  }
  return nativeEvent;
}

function imageExactNativeSubmit(
  event: React.FormEvent<HTMLFormElement>,
  provenance: ImageSubmitProvenance,
  expectedDefaultPrevented: boolean | null,
) {
  const nativeEvent = event.nativeEvent;
  const wrapper = event as React.FormEvent<HTMLFormElement> & {
    readonly _reactName?: unknown;
    readonly isDefaultPrevented?: unknown;
    readonly isPropagationStopped?: unknown;
    readonly persist?: unknown;
  };
  return imageExactNativeOwnedFormSubmitEvent(
    nativeEvent,
    provenance,
    expectedDefaultPrevented,
  ) &&
    event.currentTarget === provenance.form &&
    wrapper._reactName === "onSubmit" &&
    typeof wrapper.isDefaultPrevented === "function" &&
    typeof wrapper.isPropagationStopped === "function" &&
    typeof wrapper.persist === "function"
    ? nativeEvent
    : null;
}

function imageSubmitProvenance(
  authority: ImageAuthority,
  controls: ImageControls,
  revision: number,
  dismissalListener: ImageDismissalListener,
): ImageSubmitProvenance | null {
  const form = controls.form.owner.element();
  const insert = controls.insert.owner.element();
  if (!authority.open || !form || !insert) {
    return null;
  }
  try {
    const ownerRealm = dismissalListener.submitOwnerRealm(form);
    if (!ownerRealm) return null;
    const { ownerDocument, ownerWindow } = ownerRealm;
    const nativeDom = captureImageNativeSubmitDomIntrinsics(
      ownerRealm,
      form,
      insert,
    );
    if (!nativeDom) return null;
    const content = nativeDom.formParentElement();
    const contentIsExact = (
      value: Element | null,
    ): value is HTMLDivElement =>
      value !== null &&
      IMAGE_APPLY(IMAGE_GET_PROTOTYPE_OF, null, [value]) ===
        ownerWindow.HTMLDivElement.prototype;
    if (
      nativeDom.formOwnerDocument() !== ownerDocument ||
      !contentIsExact(content) ||
      !nativeDom.formIsConnected() ||
      nativeDom.formParentElement() !== content ||
      nativeDom.insertForm() !== form ||
      !nativeDom.formContains(insert)
    ) {
      return null;
    }
    return Object.freeze({
      authority,
      ownerDocument,
      form,
      insert,
      content,
      contentTree: imageSnapshotDom(content),
      revision,
      nativeEvent: ownerRealm.nativeEvent,
      nativeDom,
    });
  } catch {
    return null;
  }
}

function imageExactNativeDismissal(
  event: KeyboardEvent | PointerEvent,
  publication: ImagePublication,
) {
  const ownerWindow = publication.ownerDocument.defaultView;
  const target = event.target;
  if (
    !ownerWindow ||
    event.eventPhase === ownerWindow.Event.NONE ||
    !event.bubbles ||
    event.defaultPrevented ||
    !(target instanceof ownerWindow.Node) ||
    !target.isConnected ||
    target.ownerDocument !== publication.ownerDocument ||
    !event.composedPath().includes(target) ||
    !event.composedPath().includes(publication.ownerDocument)
  ) {
    return false;
  }
  if (event instanceof ownerWindow.KeyboardEvent) {
    return (
      event.type === "keydown" &&
      event.key === "Escape" &&
      publication.dom.content.contains(target) &&
      imageSnapshotContains(publication.contentTree, target)
    );
  }
  const PointerEventConstructor = ownerWindow.PointerEvent;
  return Boolean(
    PointerEventConstructor &&
      event instanceof PointerEventConstructor &&
      event.type === "pointerdown" &&
      event.button === 0 &&
      event.isPrimary &&
      !event.ctrlKey &&
      !publication.dom.content.contains(target) &&
      imageSnapshotContains(publication.overlayTree, target),
  );
}

function imageExactNativeOutsideClick(
  pointer: {
    readonly target: EventTarget | null;
    readonly pointerId: number;
    readonly pointerType: string;
    readonly isPrimary: boolean;
  },
  event: MouseEvent,
  publication: ImagePublication,
) {
  const ownerWindow = publication.ownerDocument.defaultView;
  const PointerEventConstructor = ownerWindow?.PointerEvent;
  const target = event.target;
  return Boolean(
    ownerWindow &&
      PointerEventConstructor &&
      event instanceof PointerEventConstructor &&
      event.type === "click" &&
      event.eventPhase !== ownerWindow.Event.NONE &&
      event.bubbles &&
      !event.defaultPrevented &&
      event.button === 0 &&
      event.isPrimary &&
      !event.ctrlKey &&
      target === pointer.target &&
      target instanceof ownerWindow.Node &&
      target.isConnected &&
      target.ownerDocument === publication.ownerDocument &&
      event.composedPath().includes(target) &&
      event.composedPath().includes(publication.ownerDocument) &&
      !publication.dom.content.contains(target) &&
      imageSnapshotContains(publication.overlayTree, target) &&
      event.pointerId === pointer.pointerId &&
      event.pointerType === pointer.pointerType &&
      event.isPrimary === pointer.isPrimary,
  );
}

function createImagePublicationRuntime(
  authority: ImageAuthority,
  coordinator: ImagePublicationCoordinator,
  dom: ImageDom,
  controls: ImageControls,
  submitDom: ImageNativeSubmitDomIntrinsics,
  authorityIsCurrent: () => boolean,
  authorizeDismissal: (
    publication: ImagePublication,
    event: Event,
  ) => void,
  owners: readonly ImageElementOwnerView[],
  onRetire: () => void,
): ImagePublicationRuntime | null {
  type Retirement = "element" | "layout" | "other";
  const placement = captureImagePlacement(
    dom.bridge,
    dom.overlay,
    dom.content,
  );
  if (!placement) {
    throw new Error(
      "Cannot publish image controls without a connected portal placement",
    );
  }
  const contentTree = imageSnapshotDom(dom.content);
  const overlayTree = imageSnapshotDom(dom.overlay);
  const bridgeTree = imageSnapshotDom(dom.bridge);
  const fileFacts = imageFileFacts(dom.file);
  if (fileFacts === undefined) return null;
  let retired = false;
  let retirement: Retirement | null = null;
  let established = false;
  let layoutRetired = false;
  let invalidReplay = false;
  let replayProofReleased = false;
  let replayRefs: ImageRefReplay[] = [];
  let guard: ImageDomGuard | null = null;
  const refsAreCurrent = (includeConnectivity: boolean) =>
    replayRefs.every(
      (entry) =>
        entry.owner.element() === entry.element &&
        (!includeConnectivity || submitDom.nodeIsConnected(entry.element)),
    );
  const currentShapeMatches = (
    changing: "url" | "alt" | "file" | null = null,
  ) => {
    if (
      !submitDom.surfaceIsCanonical() ||
      !guard?.isClean(changing) ||
      !refsAreCurrent(true) ||
      !committedDomMatches(changing) ||
      !refsAreCurrent(true) ||
      !guard.isClean(changing)
    ) {
      return false;
    }
    return refsAreCurrent(false);
  };
  const currentDomMatches = (
    changing: "url" | "alt" | "file" | null = null,
  ) => {
    return (
      currentShapeMatches(changing) &&
      authorityIsCurrent() &&
      (retired
        ? coordinator.acceptsSuccessorOf(publication) ||
          coordinator.isRetained(publication)
        : coordinator.isCurrent(publication))
    );
  };
  const committedDomMatches = (
    changing: "url" | "alt" | "file" | null = null,
  ) =>
    submitDom.surfaceIsCanonical() &&
    dom.content === contentTree.node &&
    dom.overlay === overlayTree.node &&
    imagePlacementMatches(dom.bridge, dom.overlay, dom.content, placement) &&
    imageDomMatches(bridgeTree) &&
    imageDomMatches(contentTree) &&
    imageDomMatches(overlayTree) &&
    Boolean(
      resolveImageDom(
        authority,
        controls,
        changing,
        fileFacts,
        retired && coordinator.isRetained(publication),
      ),
    );
  const retire = (reason: Retirement) => {
    if (retired) return false;
    retired = true;
    retirement = reason;
    onRetire();
    coordinator.retire(publication);
    queueMicrotask(() => {
      if (
        coordinator.replay()?.source !== publication &&
        !coordinator.isRetained(publication)
      ) {
        replayProofReleased = true;
        guard?.release();
      }
    });
    return true;
  };
  const publication: ImagePublication = Object.freeze({
    identity: Symbol("image-publication"),
    authority,
    ownerDocument: dom.content.ownerDocument,
    dom,
    bridgeTree,
    contentTree,
    overlayTree,
    placement,
    fileFacts,
    fileControl: authority.uploadAvailable ? controls.file : null,
    authorizeDismissal: (event: Event) =>
      authorizeDismissal(publication, event),
    retire: () => retire("other"),
    releaseTerminal: () => {
      replayProofReleased = true;
      return guard?.release() ?? true;
    },
    isRetired: () => retired,
    publishedDomMatches: (changing: ImageChangingControl = null) => {
      const exact = currentDomMatches(changing);
      if (!exact) {
        retire("element");
        if (coordinator.isRetained(publication)) {
          coordinator.releaseTerminal(publication);
        }
      }
      return exact;
    },
  });
  const refsHaveExactReplay = () =>
    submitDom.surfaceIsCanonical() &&
    !invalidReplay &&
    replayRefs.length > 0 &&
    replayRefs.every(
      (entry) =>
        entry.detached &&
        entry.reattached &&
        entry.owner.element() === entry.element &&
        submitDom.nodeIsConnected(entry.element),
    );
  const partialReplayIsCurrent = () =>
    submitDom.surfaceIsCanonical() &&
    retired &&
    retirement === "element" &&
    established &&
    !layoutRetired &&
    !invalidReplay &&
    replayRefs.some((entry) => entry.detached && entry.reattached) &&
    replayRefs.every(
      (entry) =>
        entry.owner.element() === entry.element &&
        submitDom.nodeIsConnected(entry.element),
    ) &&
    currentDomMatches();
  return Object.freeze({
    publication,
    publish: (beforePublish: () => boolean = () => true) => {
      const capturedRefs: ImageRefReplay[] = [];
      for (const owner of owners) {
        const element = owner.element();
        if (!element) return false;
        capturedRefs.push({
          owner,
          element,
          detached: false,
          reattached: false,
        });
      }
      replayRefs = capturedRefs;
      established = true;
      guard = createImageDomGuard(
        dom,
        placement,
        committedDomMatches,
        () => {
          retire("element");
        },
      );
      if (!guard) return false;
      if (
        !beforePublish() ||
        !currentShapeMatches() ||
        !authorityIsCurrent() ||
        coordinator.active() !== null ||
        retired ||
        !coordinator.publish(publication)
      ) {
        guard.release();
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
    finishCommit: () => {
      guard?.finishCommit();
    },
    sealForSubmit: () => guard?.sealForSubmit() === true,
    noteRef: (
      owner: ImageElementOwnerView,
      element: Element | null,
      previous: Element | null,
    ) => {
      if (!established) return;
      if (!submitDom.surfaceIsCanonical()) {
        invalidReplay = true;
        return;
      }
      const proof = replayRefs.find((entry) => entry.owner === owner);
      if (!proof) return;
      const proofIsConnected = submitDom.nodeIsConnected(proof.element);
      if (
        element === null &&
        previous === proof.element &&
        proofIsConnected
      ) {
        proof.detached = true;
        proof.reattached = false;
      } else if (
        element === proof.element &&
        previous === null &&
        proof.detached &&
        proofIsConnected
      ) {
        proof.reattached = true;
      } else if (element !== previous) {
        invalidReplay = true;
      }
    },
    isExactReplay: () =>
      retired &&
      (retirement === "element" || retirement === "layout") &&
      established &&
      layoutRetired &&
      refsHaveExactReplay() &&
      currentDomMatches(),
    isRecoverablePartialReplay: () =>
      partialReplayIsCurrent(),
    replay: () =>
      guard
        ? Object.freeze({
            source: publication,
            bridgeTree,
            contentTree,
            overlayTree,
            placement,
            historyIsClean: guard.isClean,
            proofIsCurrent: () => !invalidReplay && !replayProofReleased,
            release: guard.release,
          })
        : null,
  });
}

function imageReplayValidation(
  coordinator: ImagePublicationCoordinator,
  authority: ImageAuthority,
  dom: ImageDom,
): ImageReplayValidation | null {
  const replay = coordinator.replay();
  if (!replay) {
    return Object.freeze({
      complete: () => true,
      release: () => true,
      reject: () => {},
    });
  }
  const sameAuthority = imageAuthoritiesMatch(
    replay.source.authority,
    authority,
    false,
  );
  const exactReplay = () => {
    const exactShape =
      replay.source.dom.bridge === dom.bridge &&
      replay.source.dom.overlay === dom.overlay &&
      replay.source.dom.content === dom.content &&
      imagePlacementMatches(
        dom.bridge,
        dom.overlay,
        dom.content,
        replay.placement,
      ) &&
      imageDomMatches(replay.bridgeTree) &&
      imageDomMatches(replay.contentTree) &&
      imageDomMatches(replay.overlayTree);
    return (
      exactShape &&
      replay.historyIsClean() &&
      coordinator.acceptsSuccessorOf(replay.source) &&
      replay.proofIsCurrent()
    );
  };
  if (sameAuthority && !exactReplay()) {
    coordinator.rejectReplay(replay.source);
    replay.release();
    return null;
  }
  let released = false;
  let releaseAccepted = false;
  const release = () => {
    if (released) return releaseAccepted;
    released = true;
    const clean = replay.release();
    releaseAccepted =
      !sameAuthority ||
      (clean &&
        coordinator.acceptsSuccessorOf(replay.source) &&
        replay.proofIsCurrent());
    if (releaseAccepted) coordinator.abandonReplay(replay.source);
    else coordinator.rejectReplay(replay.source);
    return releaseAccepted;
  };
  const reject = () => {
    if (!released) {
      released = true;
      replay.release();
    }
    releaseAccepted = false;
    coordinator.rejectReplay(replay.source);
  };
  return Object.freeze({
    complete: () => {
      const accepted = !sameAuthority || exactReplay();
      if (!accepted) reject();
      return accepted;
    },
    release,
    reject,
  });
}

function ImagePublicationBoundary({
  establish,
  settlePortal,
  children,
}: {
  establish: ImagePresentation["establish"];
  settlePortal: ImagePresentation["settlePortal"];
  children: ReactNode;
}) {
  useLayoutEffect(() => {
    const cleanup = establish();
    return cleanup;
  }, [establish]);
  useEffect(() => {
    const cleanup = settlePortal();
    return cleanup;
  }, [settlePortal]);
  return children;
}

/** Successor renders requested after a publication retired outside a render, per dialog open. */
const imageRecoveries = new WeakMap<object, number>();

function createImagePresentation(
  authority: ImageAuthority,
  coordinator: ImagePublicationCoordinator,
  latestAuthority: () => ImageAuthority | null,
  commitAuthority: (authority: ImageAuthority) => void,
  dismissalListener: ImageDismissalListener,
  requestSuccessor: () => void,
  activeUpload: () => ImageUploadOwner | null,
  setDraft: React.Dispatch<React.SetStateAction<ImageDraft>>,
  startUpload: (
    publication: ImagePublication,
    authority: ImageAuthority,
    file: File,
    input: HTMLInputElement,
    fallbackAlt: string,
  ) => void,
  releaseUploadAdmission: (
    publication: ImagePublication,
    authority: ImageAuthority,
  ) => void,
  resumeUploadSettlement: () => void,
  abandonDeferredUpload: () => boolean,
  releaseTerminalResources: (publication: ImagePublication) => void,
  afterClose: ImageAfterCloseAuthority,
  completeClose: (closer: object) => void,
): ImagePresentation {
  let currentRuntime: ImagePublicationRuntime | null = null;
  let lastRuntime: ImagePublicationRuntime | null = null;
  let submitProvenance: ImageSubmitProvenance | null = null;
  let submitRevision = 0;
  let successorRequested = false;
  let partialRecoveryQueued = false;
  let portalSettlement = 0;
  let commitTimer:
    | {
        readonly ownerWindow: Window & typeof globalThis;
        readonly id: number;
      }
    | null = null;
  let replayRejected = false;
  let dismissal: ImageDismissalProof | null = null;
  let dismissalTimer: number | null = null;
  let outsidePointer:
    | {
        readonly publication: ImagePublication;
        readonly target: EventTarget | null;
        readonly pointerId: number;
        readonly pointerType: string;
        readonly isPrimary: boolean;
      }
    | null = null;
  const clearDismissal = () => {
    dismissal = null;
    outsidePointer = null;
    if (dismissalTimer !== null) {
      const ownerWindow =
        lastRuntime?.publication.ownerDocument.defaultView;
      ownerWindow?.clearTimeout(dismissalTimer);
      dismissalTimer = null;
    }
  };
  const clearCommitFinish = () => {
    portalSettlement += 1;
    if (commitTimer) {
      commitTimer.ownerWindow.clearTimeout(commitTimer.id);
      commitTimer = null;
    }
  };
  const scheduleCommitFinish = (runtime: ImagePublicationRuntime | null) => {
    if (!runtime) return;
    clearCommitFinish();
    const settlement = portalSettlement;
    const ownerWindow = runtime.publication.ownerDocument.defaultView;
    if (ownerWindow) {
      const id = ownerWindow.setTimeout(() => {
        if (commitTimer?.id === id) commitTimer = null;
        if (settlement === portalSettlement) runtime.finishCommit();
      }, 0);
      commitTimer = { ownerWindow, id };
    } else {
      queueMicrotask(() => {
        if (settlement === portalSettlement) runtime.finishCommit();
      });
    }
  };
  const onElementChange = (
    owner: ImageElementOwnerView,
    element: Element | null,
    previous: Element | null,
    last: Element | null,
  ) => {
    if (
      (owner === form.owner || owner === insert.owner) &&
      (element === null || (last !== null && element !== last))
    ) {
      submitRevision += 1;
    }
    const runtime = currentRuntime ?? lastRuntime;
    runtime?.noteRef(owner, element, previous);
    if (
      element === null ||
      (element !== null && last !== null && element !== last)
    ) {
      currentRuntime?.retireForElement();
      currentRuntime = null;
      clearDismissal();
    }
    if (
      runtime?.isExactReplay() &&
      coordinator.acceptsSuccessorOf(runtime.publication)
    ) {
      requestReplaySuccessor(runtime);
    } else if (
      !partialRecoveryQueued &&
      runtime?.isRecoverablePartialReplay() &&
      coordinator.acceptsSuccessorOf(runtime.publication)
    ) {
      const replay = runtime.replay();
      if (!replay || !coordinator.stageReplay(replay)) return;
      scheduleCommitFinish(runtime);
      partialRecoveryQueued = true;
      queueMicrotask(() => {
        partialRecoveryQueued = false;
        if (
          successorRequested ||
          !runtime.isRecoverablePartialReplay() ||
          !coordinator.acceptsSuccessorOf(runtime.publication) ||
          !factsAreCurrent()
        ) {
          const successorWasRequested = successorRequested;
          replay.release();
          coordinator.rejectReplay(runtime.publication);
          successorRequested = true;
          const abandoned = abandonDeferredUpload();
          if (!abandoned && !successorWasRequested) {
            requestSuccessor();
          }
          return;
        }
        scheduleCommitFinish(runtime);
        successorRequested = true;
        requestSuccessor();
      });
    }
  };
  const control = <T extends HTMLElement>() => {
    const owner = new ImageElementOwner<T>(onElementChange);
    return Object.freeze({
      owner,
      capture: owner.capture,
      action: Object.freeze({ identity: Symbol("image-control-action") }),
    });
  };
  const bridge = control<HTMLDivElement>();
  const form = control<HTMLFormElement>();
  const urlLabel = control<HTMLLabelElement>();
  const urlRow = control<HTMLDivElement>();
  const url = control<HTMLInputElement>();
  const upload = control<HTMLButtonElement>();
  const file = control<HTMLInputElement>();
  const error = control<HTMLDivElement>();
  const altLabel = control<HTMLLabelElement>();
  const alt = control<HTMLInputElement>();
  const preview = control<HTMLImageElement>();
  const actions = control<HTMLDivElement>();
  const cancel = control<HTMLButtonElement>();
  const insert = control<HTMLButtonElement>();
  const closeToken = Object.freeze({ identity: Symbol("image-close") });
  const controls = {
    bridge,
    form,
    urlLabel,
    urlRow,
    url,
    upload,
    file,
    error,
    altLabel,
    alt,
    preview,
    actions,
    cancel,
    insert,
  };
  const expectedOwners = () => {
    const owners: (ImageElementOwnerView | null)[] = [
        form.owner,
        urlLabel.owner,
        urlRow.owner,
        url.owner,
        authority.uploadAvailable ? upload.owner : null,
        authority.uploadAvailable ? file.owner : null,
        authority.error ? error.owner : null,
        altLabel.owner,
        alt.owner,
        authority.normalizedSrc ? preview.owner : null,
        actions.owner,
        cancel.owner,
        insert.owner,
      ];
    return Object.freeze(
      owners.filter(
        (owner): owner is ImageElementOwnerView => owner !== null,
      ),
    );
  };
  const factsAreCurrent = () => {
    const draft = authority.draft;
    return (
      latestAuthority() === authority &&
      draft.visit === authority.visit &&
      draft.open === authority.open &&
      draft.src === authority.src &&
      draft.alt === authority.alt &&
      draft.error === authority.error &&
      Object.is(draft.altRevision, authority.altRevision) &&
      draft.previewFailed === authority.previewFailed &&
      draft.upload === authority.upload &&
      draft.uploadAdmission === authority.uploadAdmission &&
      authority.visit.onOpenChange === authority.onOpenChange &&
      authority.visit.onSubmit === authority.onSubmit &&
      authority.visit.onUpload === authority.onUpload &&
      authority.uploading === (authority.upload !== null) &&
      authority.uploadDisabled ===
        (authority.uploading || authority.draft.uploadAdmission !== null) &&
      authority.uploadAvailable === (authority.onUpload !== undefined) &&
      authority.normalizedSrc === authority.src.trim() &&
      authority.normalizedAlt === authority.alt.trim() &&
      authority.submitDisabled ===
        (authority.uploading || !authority.normalizedSrc)
    );
  };
  const exactDom = (
    changing: "url" | "alt" | "file" | null = null,
    facts: ImageFileFacts | null = null,
  ) => resolveImageDom(authority, controls, changing, facts);
  const owns = (
    publication: ImagePublication,
    changing: "url" | "alt" | "file" | null = null,
  ) => {
    if (
      !factsAreCurrent() ||
      publication.authority !== authority ||
      !coordinator.isAuthoritative(publication) ||
      !publication.publishedDomMatches(changing)
    ) {
      return false;
    }
    return (
      factsAreCurrent() &&
      publication.authority === authority &&
      coordinator.isAuthoritative(publication)
    );
  };
  const updateOwnedDraft = (
    publication: ImagePublication,
    update: (current: ImageDraft) => ImageDraft,
  ) => {
    const retained = coordinator.updateRetainedDraft(publication, update);
    setDraft(retained ?? update(authority.draft));
  };
  const requestReplaySuccessor = (runtime: ImagePublicationRuntime) => {
    const replay = runtime.replay();
    if (
      successorRequested ||
      !replay ||
      !runtime.isExactReplay() ||
      !coordinator.acceptsSuccessorOf(runtime.publication) ||
      !factsAreCurrent() ||
      !coordinator.stageReplay(replay)
    ) {
      return;
    }
    scheduleCommitFinish(runtime);
    successorRequested = true;
    requestSuccessor();
  };
  const stageDismissal = (
    publication: ImagePublication,
    proof: Omit<ImageDismissalProof, "publication">,
  ) => {
    clearDismissal();
    if (
      !owns(publication) ||
      coordinator.hasClaimed(
        publication,
        proof.control,
        insert.action,
        proof.reactEvent,
        proof.nativeEvent,
      )
    ) {
      return;
    }
    dismissal = { publication, ...proof };
    const ownerWindow = publication.ownerDocument.defaultView;
    dismissalTimer =
      ownerWindow?.setTimeout(() => {
        dismissal = null;
        dismissalTimer = null;
      }, 0) ?? null;
  };
  const authorizeNativeDismissal = (
    publication: ImagePublication,
    event: Event,
  ) => {
    const ownerWindow = publication.ownerDocument.defaultView;
    const PointerEventConstructor = ownerWindow?.PointerEvent;
    if (!ownerWindow) return;
    const pointer = outsidePointer;
    clearDismissal();
    if (!owns(publication)) return;
    if (
      event.type === "click" &&
      PointerEventConstructor &&
      event instanceof PointerEventConstructor
    ) {
      if (
        pointer?.publication === publication &&
        imageExactNativeOutsideClick(pointer, event, publication) &&
        owns(publication)
      ) {
        stageDismissal(publication, {
          control: publication.dom.overlay,
          reactEvent: event,
          nativeEvent: event,
        });
      }
      return;
    }
    if (event instanceof ownerWindow.KeyboardEvent) {
      if (
        imageExactNativeDismissal(event, publication) &&
        owns(publication)
      ) {
        stageDismissal(publication, {
          control: publication.dom.content,
          reactEvent: event,
          nativeEvent: event,
        });
      }
      return;
    }
    if (
      !PointerEventConstructor ||
      !(event instanceof PointerEventConstructor) ||
      !imageExactNativeDismissal(event, publication) ||
      !owns(publication)
    ) {
      return;
    }
    outsidePointer = {
      publication,
      target: event.target,
      pointerId: event.pointerId,
      pointerType: event.pointerType,
      isPrimary: event.isPrimary,
    };
  };
  const establish = () => {
    if (lastRuntime) {
      if (
        lastRuntime.isExactReplay() &&
        coordinator.acceptsSuccessorOf(lastRuntime.publication)
      ) {
        requestReplaySuccessor(lastRuntime);
      }
      return undefined;
    }
    const nextSubmitProvenance = imageSubmitProvenance(
      authority,
      controls,
      submitRevision,
      dismissalListener,
    );
    if (nextSubmitProvenance) {
      submitProvenance = nextSubmitProvenance;
      dismissalListener.attachSubmit(
        nextSubmitProvenance,
        deliverFormSubmit,
      );
    } else {
      submitProvenance = null;
      if (
        !dismissalListener.retainSubmitSuppression(form.owner.element())
      ) {
        dismissalListener.clearSubmit();
      }
      return undefined;
    }
    if (!nextSubmitProvenance.nativeDom.surfaceIsCanonical()) return undefined;
    if (!coordinator.acceptsAuthority(authority)) return undefined;
    const dom = exactDom();
    if (!factsAreCurrent() || !dom || replayRejected) {
      if (coordinator.replay()) abandonDeferredUpload();
      return undefined;
    }
    const replayValidation = imageReplayValidation(
      coordinator,
      authority,
      dom,
    );
    if (!replayValidation) {
      replayRejected = true;
      abandonDeferredUpload();
      return undefined;
    }
    const runtime = createImagePublicationRuntime(
      authority,
      coordinator,
      dom,
      controls,
      nextSubmitProvenance.nativeDom,
      factsAreCurrent,
      authorizeNativeDismissal,
      expectedOwners(),
      () => {
        clearDismissal();
        // A publication retired by a DOM change outside a render (focus guards, portal settling)
        // has no successor; render one so typing and Insert keep working. Capped per open.
        queueMicrotask(() => {
          if (coordinator.authoritative()) return;
          const recoveries = imageRecoveries.get(coordinator) ?? 0;
          if (recoveries >= 5) return;
          imageRecoveries.set(coordinator, recoveries + 1);
          requestSuccessor();
        });
      },
    );
    if (!runtime) {
      replayValidation.reject();
      replayRejected = true;
      abandonDeferredUpload();
      return undefined;
    }
    const replacementSubmitProvenance = imageSubmitProvenance(
      authority,
      controls,
      submitRevision,
      dismissalListener,
    );
    if (replacementSubmitProvenance) {
      submitProvenance = replacementSubmitProvenance;
      dismissalListener.attachSubmit(
        replacementSubmitProvenance,
        deliverFormSubmit,
      );
    } else {
      submitProvenance = null;
      if (
        !dismissalListener.retainSubmitSuppression(form.owner.element())
      ) {
        dismissalListener.clearSubmit();
      }
      replayValidation.reject();
      runtime.retireForElement();
      replayRejected = true;
      abandonDeferredUpload();
      return undefined;
    }
    if (!replacementSubmitProvenance.nativeDom.surfaceIsCanonical()) {
      replayValidation.reject();
      runtime.retireForElement();
      replayRejected = true;
      abandonDeferredUpload();
      return undefined;
    }
    if (!replayValidation.complete()) {
      runtime.retireForElement();
      replayRejected = true;
      abandonDeferredUpload();
      return undefined;
    }
    if (!runtime.publish(replayValidation.release)) {
      replayValidation.reject();
      runtime.retireForElement();
      replayRejected = true;
      abandonDeferredUpload();
      return undefined;
    }
    currentRuntime = runtime;
    lastRuntime = runtime;
    releaseUploadAdmission(runtime.publication, authority);
    resumeUploadSettlement();
    return runtime.retireForLayout;
  };
  const currentPublication = (
    changing: "url" | "alt" | "file" | null = null,
  ) => {
    const publication = coordinator.authoritative();
    return publication && owns(publication, changing) ? publication : null;
  };
  const submitSuppressionIsCurrent = (
    provenance: ImageSubmitProvenance,
  ) => {
    if (
      submitProvenance !== provenance ||
      provenance.authority !== authority ||
      provenance.revision !== submitRevision ||
      !factsAreCurrent() ||
      form.owner.element() !== provenance.form ||
      insert.owner.element() !== provenance.insert
    ) {
      return false;
    }
    const { form: ownedForm, insert: ownedInsert, content } = provenance;
    const structurallyCurrent =
      provenance.nativeDom.surfaceIsCanonical() &&
      provenance.nativeDom.formIsConnected() &&
      provenance.nativeDom.formOwnerDocument() === provenance.ownerDocument &&
      provenance.nativeDom.formParentElement() === content &&
      provenance.nativeDom.insertForm() === ownedForm &&
      provenance.nativeDom.formContains(ownedInsert) &&
      imageSnapshotContains(provenance.contentTree, ownedForm);
    return (
      structurallyCurrent &&
      submitProvenance === provenance &&
      provenance.revision === submitRevision &&
      factsAreCurrent() &&
      form.owner.element() === ownedForm &&
      insert.owner.element() === ownedInsert
    );
  };
  const claim = (
    publication: ImagePublication,
    controlOwner: object,
    action: object,
    reactEvent: object,
    nativeEvent: Event,
  ) =>
    coordinator.claim(
      publication,
      controlOwner,
      action,
      reactEvent,
      nativeEvent,
    );
  const onUrlChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const publication = currentPublication("url");
    const input = url.owner.element();
    if (
      !publication ||
      !input ||
      publication.dom.url !== input ||
      event.currentTarget !== input
    ) {
      return;
    }
    const nativeEvent = imageExactNativeInput(event, input, publication);
    if (
      !nativeEvent ||
      !owns(publication, "url") ||
      !claim(publication, url, url.action, event, nativeEvent)
    ) {
      return;
    }
    let value: string;
    try {
      value = input.value;
    } catch {
      publication.retire();
      requestSuccessor();
      return;
    }
    if (!owns(publication, "url")) {
      publication.retire();
      requestSuccessor();
      return;
    }
    imageRecoveries.delete(coordinator);
    updateOwnedDraft(publication, (current) =>
      nextImageDraft(current, {
        src: value,
        previewFailed: false,
      }),
    );
  };
  const onAltChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const publication = currentPublication("alt");
    const input = alt.owner.element();
    if (
      !publication ||
      !input ||
      publication.dom.alt !== input ||
      event.currentTarget !== input
    ) {
      return;
    }
    const nativeEvent = imageExactNativeInput(event, input, publication);
    if (
      !nativeEvent ||
      !owns(publication, "alt") ||
      !claim(publication, alt, alt.action, event, nativeEvent)
    ) {
      return;
    }
    let value: string;
    try {
      value = input.value;
    } catch {
      publication.retire();
      requestSuccessor();
      return;
    }
    if (!owns(publication, "alt")) {
      publication.retire();
      requestSuccessor();
      return;
    }
    imageRecoveries.delete(coordinator);
    updateOwnedDraft(publication, (current) =>
      nextImageDraft(current, {
        alt: value,
        altRevision: current.altRevision + 1,
      }),
    );
  };
  const onUploadClick = (event: React.MouseEvent<HTMLButtonElement>) => {
    const publication = currentPublication();
    const button = upload.owner.element();
    const input = file.owner.element();
    if (
      !publication ||
      !button ||
      !input ||
      !authority.uploadAvailable ||
      authority.uploadDisabled ||
      activeUpload() !== null ||
      publication.dom.upload !== button ||
      publication.dom.file !== input ||
      event.currentTarget !== button
    ) {
      return;
    }
    const nativeEvent = imageExactNativeClick(
      event,
      button,
      button,
      publication,
    );
    if (
      !nativeEvent ||
      !owns(publication) ||
      publication.dom.upload !== upload.owner.element() ||
      publication.dom.file !== file.owner.element() ||
      authority.uploadDisabled ||
      activeUpload() !== null ||
      !claim(
        publication,
        upload,
        upload.action,
        event,
        nativeEvent,
      )
    ) {
      return;
    }
    requestSuccessor();
    input.click();
  };
  const onFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const publication = currentPublication("file");
    const input = file.owner.element();
    if (
      !publication ||
      !input ||
      publication.dom.file !== input ||
      event.currentTarget !== input
    ) {
      return;
    }
    const nativeEvent = imageExactNativeInput(event, input, publication);
    if (
      !nativeEvent ||
      !owns(publication, "file") ||
      publication.dom.file !== file.owner.element() ||
      !authority.onUpload ||
      authority.uploading ||
      activeUpload() !== null ||
      !claim(publication, file, file.action, event, nativeEvent)
    ) {
      return;
    }
    let chosen: File | undefined;
    let fallbackAlt: string;
    try {
      const selected = input.files;
      chosen = selected?.[0];
      const ownerWindow = publication.ownerDocument.defaultView;
      if (!ownerWindow || !(chosen instanceof ownerWindow.File)) {
        publication.retire();
        requestSuccessor();
        return;
      }
      const name = chosen.name;
      if (typeof name !== "string") {
        publication.retire();
        requestSuccessor();
        return;
      }
      fallbackAlt = name.replace(/\.[a-z0-9]{2,5}$/i, "");
    } catch {
      publication.retire();
      requestSuccessor();
      return;
    }
    if (!owns(publication, "file")) {
      publication.retire();
      requestSuccessor();
      return;
    }
    startUpload(publication, authority, chosen, input, fallbackAlt);
  };
  const onPreviewError = (
    event: React.SyntheticEvent<HTMLImageElement>,
  ) => {
    const publication = currentPublication();
    const image = preview.owner.element();
    if (
      !publication ||
      !image ||
      authority.previewFailed ||
      publication.dom.preview !== image ||
      event.currentTarget !== image
    ) {
      return;
    }
    const nativeEvent = imageExactNativeError(event, image, publication);
    if (
      !nativeEvent ||
      !owns(publication) ||
      publication.dom.preview !== preview.owner.element() ||
      !claim(
        publication,
        preview,
        preview.action,
        event,
        nativeEvent,
      )
    ) {
      return;
    }
    updateOwnedDraft(publication, (current) =>
      nextImageDraft(current, { previewFailed: true }),
    );
  };
  const closeCurrent = (
    publication: ImagePublication,
    withInsertion: boolean,
  ) => {
    if (withInsertion) {
      afterClose.schedule(
        publication,
        authority,
        closeToken,
        publication.dom.overlay === publication.dom.content,
      );
    }
    else afterClose.cancel();
    publication.retire();
    coordinator.releaseTerminal(publication);
    clearCommitFinish();
    releaseTerminalResources(publication);
    authority.onOpenChange(false);
  };
  const onCancelClick = (event: React.MouseEvent<HTMLButtonElement>) => {
    const publication = currentPublication();
    const button = cancel.owner.element();
    if (
      !publication ||
      !button ||
      publication.dom.cancel !== button ||
      event.currentTarget !== button
    ) {
      return;
    }
    const nativeEvent = imageExactNativeClick(
      event,
      button,
      button,
      publication,
    );
    if (
      !nativeEvent ||
      !owns(publication) ||
      publication.dom.cancel !== cancel.owner.element() ||
      !claim(
        publication,
        cancel,
        cancel.action,
        event,
        nativeEvent,
      )
    ) {
      return;
    }
    closeCurrent(publication, false);
  };
  const deliverFormSubmit: ImageSubmitTerminalDelivery = (proof) => {
    let claimedPublication: ImagePublication | null = null;
    try {
      const committed = lastRuntime?.publication ?? null;
      const provenance = submitProvenance;
      const ownedForm = form.owner.element();
      const nativeEvent = proof.nativeEvent;
      if (
        proof.delivery !== deliverFormSubmit ||
        proof.provenance !== provenance ||
        !proof.publication ||
        !ownedForm ||
        provenance.authority !== authority ||
        provenance.form !== ownedForm ||
        !provenance.nativeEvent.publicSurfaceIsCanonical(nativeEvent) ||
        imageExactNativeSubmitEvent(nativeEvent, provenance, true) !==
          nativeEvent ||
        !submitSuppressionIsCurrent(provenance)
      ) {
        return;
      }
      const publication = currentPublication(
        authority.uploading ? "file" : null,
      );
      if (
        !publication ||
        !committed ||
        publication !== proof.publication ||
        publication !== committed ||
        publication.dom.form !== ownedForm ||
        publication.dom.insert !== insert.owner.element() ||
        authority.submitDisabled ||
        authority.uploading ||
        activeUpload() !== null ||
        !authority.normalizedSrc ||
        imageExactNativeSubmitEvent(nativeEvent, provenance, true) !==
          nativeEvent ||
        !provenance.nativeEvent.publicSurfaceIsCanonical(nativeEvent) ||
        !owns(publication) ||
        !claim(
          publication,
          form,
          insert.action,
          proof.reactEvent,
          nativeEvent,
        )
      ) {
        return;
      }
      claimedPublication = publication;
    } catch {
      return;
    }
    closeCurrent(claimedPublication, true);
  };
  const onFormSubmitCapture = (
    event: React.FormEvent<HTMLFormElement>,
  ) => {
    const provenance = submitProvenance;
    const ownedForm = form.owner.element();
    if (
      !provenance ||
      !ownedForm ||
      provenance.authority !== authority ||
      provenance.form !== ownedForm ||
      event.currentTarget !== ownedForm
    ) {
      return;
    }
    const nativeEvent = imageExactNativeSubmit(event, provenance, null);
    const wasAlreadyPrevented = nativeEvent
      ? provenance.nativeEvent.defaultPrevented(nativeEvent)
      : false;
    if (!nativeEvent) return;
    if (!provenance.nativeEvent.preventDefault(nativeEvent)) return;
    let proofPublication: ImagePublication | null = null;
    const runtime = lastRuntime;
    if (runtime) {
      try {
        const settlementIsClean = runtime.sealForSubmit();
        const current = coordinator.active();
        if (
          settlementIsClean &&
          !wasAlreadyPrevented &&
          current === runtime.publication &&
          coordinator.isCurrent(current)
        ) {
          proofPublication = current;
        }
      } catch {
        runtime.publication.retire();
      }
    }
    if (!provenance.nativeEvent.capturePublicSurface(nativeEvent)) {
      provenance.nativeEvent.preventDefault(nativeEvent);
      provenance.nativeEvent.stopImmediatePropagation(nativeEvent);
      return;
    }
    const proof = Object.freeze({
      nativeEvent,
      publication: proofPublication,
      provenance,
      reactEvent: event,
      delivery: deliverFormSubmit,
    });
    if (!dismissalListener.stageSubmit(proof)) {
      provenance.nativeEvent.releasePublicSurface(nativeEvent);
      provenance.nativeEvent.preventDefault(nativeEvent);
      provenance.nativeEvent.stopImmediatePropagation(nativeEvent);
    }
  };
  const onFormSubmit = () => {};
  const onClickCapture = (event: React.MouseEvent<HTMLDivElement>) => {
    const publication = currentPublication();
    const bridgeElement = bridge.owner.element();
    if (
      !publication ||
      !bridgeElement ||
      publication.dom.bridge !== bridgeElement ||
      event.currentTarget !== bridgeElement
    ) {
      return;
    }
    const target = event.target;
    const ownerWindow = publication.ownerDocument.defaultView;
    if (
      !ownerWindow ||
      !(target instanceof ownerWindow.Node) ||
      !publication.dom.close.contains(target)
    ) {
      return;
    }
    const nativeEvent = imageExactNativeClick(
      event,
      bridgeElement,
      publication.dom.close,
      publication,
    );
    if (nativeEvent && owns(publication)) {
      stageDismissal(publication, {
        control: publication.dom.close,
        reactEvent: event,
        nativeEvent,
      });
    }
  };
  const onOpenChange = (open: boolean) => {
    const proof = dismissal;
    if (
      open ||
      !proof ||
      proof.publication.authority !== authority ||
      !owns(proof.publication) ||
      !coordinator.claim(
        proof.publication,
        proof.control,
        insert.action,
        proof.reactEvent,
        proof.nativeEvent,
      )
    ) {
      clearDismissal();
      return;
    }
    clearDismissal();
    closeCurrent(proof.publication, false);
  };
  const settlePortal = () => {
    let cleanup: void | (() => void) = undefined;
    if (!lastRuntime) {
      cleanup = establish();
    } else {
      establish();
    }
    scheduleCommitFinish(lastRuntime);
    return cleanup;
  };
  const captureBridge = (element: HTMLDivElement | null) => {
    if (!element) return bridge.capture(element);
    commitAuthority(authority);
    dismissalListener.attach(element);
    const cleanup = bridge.capture(element);
    return () => {
      cleanup?.();
      dismissalListener.releaseWhenDetached(element);
    };
  };
  return Object.freeze({
    authority,
    closeToken,
    bridge,
    form,
    urlLabel,
    urlRow,
    url,
    upload,
    file,
    error,
    altLabel,
    alt,
    preview,
    actions,
    cancel,
    insert,
    captureBridge,
    captureForm: form.capture,
    captureUrlLabel: urlLabel.capture,
    captureUrlRow: urlRow.capture,
    captureUrl: url.capture,
    captureUpload: upload.capture,
    captureFile: file.capture,
    captureError: error.capture,
    captureAltLabel: altLabel.capture,
    captureAlt: alt.capture,
    capturePreview: preview.capture,
    captureActions: actions.capture,
    captureCancel: cancel.capture,
    captureInsert: insert.capture,
    establish,
    settlePortal,
    onOpenChange,
    onClickCapture,
    onUrlChange,
    onAltChange,
    onUploadClick,
    onFileChange,
    onPreviewError,
    onCancelClick,
    onFormSubmitCapture,
    onFormSubmit,
    onClosed: () => completeClose(closeToken),
  });
}

export const ImageDialog = memo(function ImageDialog({
  open,
  onOpenChange,
  onSubmit,
  onUpload,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (src: string, alt: string) => void;
  /** Uploads a chosen file and returns the URL to use; when absent the Upload button is hidden. */
  onUpload?: (file: File) => Promise<{ url: string; alt?: string }>;
}) {
  const [mount] = useState(() => Symbol("image-dialog"));
  const [coordinator] = useState(
    () => new ImagePublicationCoordinator(mount),
  );
  useLayoutEffect(() => {
    if (open) imageRecoveries.delete(coordinator);
  }, [coordinator, open]);
  const [dismissalListener] = useState(
    () => new ImageDismissalListener(coordinator),
  );
  const [latestAuthority] = useState(
    () => new ImageCurrentValue<ImageAuthority | null>(null),
  );
  const [activeUpload] = useState(
    () => new ImageCurrentValue<ImageUploadOwner | null>(null),
  );
  const [deferredUploadOutcome] = useState(
    () => new ImageCurrentValue<ImageDeferredUploadOutcome | null>(null),
  );
  const [afterClose] = useState(() => new ImageAfterCloseAuthority());
  const [publicationRevision, setPublicationRevision] = useState(0);
  const visit = useMemo<ImageVisit>(
    () => Object.freeze({ onOpenChange, onSubmit, onUpload }),
    [onOpenChange, onSubmit, onUpload],
  );
  const [storedDraft, setDraft] = useState<ImageDraft>(() =>
    imageDraft(visit, open),
  );
  let draft = storedDraft;
  if (draft.visit !== visit || draft.open !== open) {
    draft = imageDraft(visit, open);
  }
  const requestSuccessor = useCallback(() => {
    setPublicationRevision((revision) => revision + 1);
  }, []);
  const abandonUploadOwner = useCallback(
    (owner: ImageUploadOwner, publication: ImagePublication | null = null) => {
      const deferred = deferredUploadOutcome.get();
      const deferredMatches = deferred?.owner === owner;
      if (deferredMatches) deferredUploadOutcome.set(null);
      if (activeUpload.get() !== owner) {
        if (!deferredMatches) return false;
        publication?.retire();
        requestSuccessor();
        return true;
      }
      activeUpload.set(null);
      setDraft((current) =>
        current.visit === owner.visit &&
        current.upload === owner &&
        current.open
          ? nextImageDraft(current, { upload: null })
          : current,
      );
      const currentPublication = coordinator.active();
      if (
        currentPublication &&
        imageUploadMatchesAuthority(owner, currentPublication.authority)
      ) {
        currentPublication.retire();
      } else {
        publication?.retire();
      }
      requestSuccessor();
      return true;
    },
    [
      activeUpload,
      coordinator,
      deferredUploadOutcome,
      requestSuccessor,
    ],
  );
  const abandonDeferredUpload = useCallback(() => {
    const deferred = deferredUploadOutcome.get();
    return deferred ? abandonUploadOwner(deferred.owner) : false;
  }, [abandonUploadOwner, deferredUploadOutcome]);
  const releaseTerminalResources = useCallback(
    (publication: ImagePublication) => {
      const owner = activeUpload.get();
      if (
        owner &&
        (owner.origin === publication ||
          imageUploadMatchesAuthority(owner, publication.authority))
      ) {
        activeUpload.set(null);
        const deferred = deferredUploadOutcome.get();
        if (deferred?.owner === owner) deferredUploadOutcome.set(null);
        setDraft((current) =>
          current.visit === owner.visit && current.upload === owner
            ? nextImageDraft(current, { upload: null })
            : current,
        );
      }
      dismissalListener.releaseTerminal(publication.dom.form);
    },
    [activeUpload, deferredUploadOutcome, dismissalListener],
  );
  const leaseUpload = useCallback(
    (owner: ImageUploadOwner): ImageUploadLease | null => {
      const publication = coordinator.active();
      const authority = publication?.authority;
      if (
        !publication ||
        !authority ||
        activeUpload.get() !== owner ||
        latestAuthority.get() !== authority ||
        publication.isRetired() ||
        !coordinator.isCurrent(publication) ||
        !publication.publishedDomMatches("file") ||
        activeUpload.get() !== owner ||
        latestAuthority.get() !== authority ||
        publication.isRetired() ||
        !coordinator.isCurrent(publication)
      ) {
        return null;
      }
      if (
        publication === owner.origin
          ? authority !== owner.authority ||
            !coordinator.wasClaimed(publication)
          : !imageUploadMatchesAuthority(owner, authority) ||
            !publication.fileControl ||
            !coordinator.claimContinuation(
              publication,
              publication.fileControl,
              owner.settlementAction,
              owner,
            )
      ) {
        return null;
      }
      return Object.freeze({ owner, publication });
    },
    [activeUpload, coordinator, latestAuthority],
  );
  const uploadLeaseIsCurrent = useCallback(
    (lease: ImageUploadLease) => {
      const publication = coordinator.active();
      const authority = publication?.authority;
      if (
        !publication ||
        !authority ||
        activeUpload.get() !== lease.owner ||
        latestAuthority.get() !== authority ||
        !coordinator.isCurrent(publication) ||
        publication.isRetired() ||
        publication !== lease.publication ||
        !publication.publishedDomMatches("file")
      ) {
        return false;
      }
      return (
        activeUpload.get() === lease.owner &&
        latestAuthority.get() === authority &&
        coordinator.isCurrent(publication) &&
        !publication.isRetired() &&
        publication === lease.publication &&
        (publication === lease.owner.origin
          ? authority === lease.owner.authority
          : imageUploadMatchesAuthority(lease.owner, authority))
      );
    },
    [activeUpload, coordinator, latestAuthority],
  );
  const abandonSettledUpload = useCallback(
    (lease: ImageUploadLease) => {
      const abandoned = abandonUploadOwner(lease.owner, lease.publication);
      coordinator.releaseTerminal(lease.publication);
      return abandoned;
    },
    [abandonUploadOwner, coordinator],
  );
  const settleUpload = useCallback(
    (
      owner: ImageUploadOwner,
      outcome: ImageUploadOutcome,
    ) => {
      const lease = leaseUpload(owner);
      if (!lease) {
        const replay = coordinator.replay();
        const replayOwnsDeferredOutcome = () =>
          coordinator.active() === null &&
          coordinator.replay() === replay &&
          replay !== null &&
          activeUpload.get() === owner &&
          deferredUploadOutcome.get() === null &&
          latestAuthority.get() === replay.source.authority &&
          coordinator.acceptsSuccessorOf(replay.source) &&
          imageUploadMatchesAuthority(owner, replay.source.authority) &&
          replay.source.dom.file === owner.fileInput &&
          replay.proofIsCurrent();
        if (
          replayOwnsDeferredOutcome() &&
          replay?.historyIsClean() &&
          replayOwnsDeferredOutcome()
        ) {
          deferredUploadOutcome.set(
            Object.freeze({ owner, outcome, source: replay.source }),
          );
          return;
        }
        abandonUploadOwner(owner);
        return;
      }
      const deferred = deferredUploadOutcome.get();
      if (deferred?.owner === owner) deferredUploadOutcome.set(null);
      let resultUrl: string | null = null;
      let resultAlt: string | undefined;
      let message: string | null = null;
      let succeeded = outcome.kind === "success";
      if (outcome.kind === "success") {
        if (!uploadLeaseIsCurrent(lease)) {
          abandonSettledUpload(lease);
          return;
        }
        try {
          resultUrl = outcome.result.url;
        } catch (error) {
          if (!uploadLeaseIsCurrent(lease)) {
            abandonSettledUpload(lease);
            return;
          }
          succeeded = false;
          message = imageUploadErrorText(error);
        }
        if (!uploadLeaseIsCurrent(lease)) {
          abandonSettledUpload(lease);
          return;
        }
        if (succeeded) {
          try {
            resultAlt = outcome.result.alt;
          } catch (error) {
            if (!uploadLeaseIsCurrent(lease)) {
              abandonSettledUpload(lease);
              return;
            }
            succeeded = false;
            message = imageUploadErrorText(error);
          }
          if (!uploadLeaseIsCurrent(lease)) {
            abandonSettledUpload(lease);
            return;
          }
        }
      } else {
        if (!uploadLeaseIsCurrent(lease)) {
          abandonSettledUpload(lease);
          return;
        }
        message = imageUploadErrorText(outcome.error);
        if (!uploadLeaseIsCurrent(lease)) {
          abandonSettledUpload(lease);
          return;
        }
      }
      const publication = lease.publication;
      const input = publication.dom.file;
      if (
        !input ||
        input !== owner.fileInput ||
        !uploadLeaseIsCurrent(lease)
      ) {
        abandonSettledUpload(lease);
        return;
      }
      let resetFailed = false;
      let resetError: unknown;
      try {
        input.value = "";
      } catch (error) {
        resetFailed = true;
        resetError = error;
      }
      if (!uploadLeaseIsCurrent(lease)) {
        abandonSettledUpload(lease);
        return;
      }
      if (resetFailed) {
        succeeded = false;
        message = imageUploadErrorText(resetError);
        if (!uploadLeaseIsCurrent(lease)) {
          abandonSettledUpload(lease);
          return;
        }
      }
      const applyOutcome = (current: ImageDraft) => {
        if (
          current.visit !== owner.visit ||
          current.upload !== owner ||
          !current.open
        ) {
          return current;
        }
        if (!succeeded) {
          return nextImageDraft(current, {
            upload: null,
            uploadAdmission: owner,
            error: message ?? "Upload failed",
          });
        }
        const nextAlt =
          current.altRevision !== owner.altRevision || current.alt
            ? current.alt
            : resultAlt || owner.fallbackAlt;
        return nextImageDraft(current, {
          src: resultUrl ?? "",
          alt: nextAlt,
          error: null,
          previewFailed: false,
          upload: null,
          uploadAdmission: owner,
        });
      };
      const successorDraft = applyOutcome(publication.authority.draft);
      if (
        successorDraft === publication.authority.draft ||
        !publication.retire() ||
        !coordinator.retainCommitted(publication, successorDraft)
      ) {
        abandonSettledUpload(lease);
        return;
      }
      activeUpload.set(null);
      setDraft((current) =>
        current === publication.authority.draft
          ? successorDraft
          : applyOutcome(current),
      );
    },
    [
      activeUpload,
      abandonUploadOwner,
      abandonSettledUpload,
      coordinator,
      deferredUploadOutcome,
      latestAuthority,
      leaseUpload,
      uploadLeaseIsCurrent,
    ],
  );
  const resumeUploadSettlement = useCallback(() => {
    const deferred = deferredUploadOutcome.get();
    if (!deferred) return;
    deferredUploadOutcome.set(null);
    const publication = coordinator.active();
    if (
      !publication ||
      !imageAuthoritiesMatch(
        deferred.source.authority,
        publication.authority,
        false,
      )
    ) {
      abandonUploadOwner(deferred.owner);
      return;
    }
    settleUpload(deferred.owner, deferred.outcome);
  }, [
    abandonUploadOwner,
    coordinator,
    deferredUploadOutcome,
    settleUpload,
  ]);
  const releaseUploadAdmission = useCallback(
    (publication: ImagePublication, authority: ImageAuthority) => {
      const owner = authority.uploadAdmission;
      if (
        !owner ||
        coordinator.active() !== publication ||
        latestAuthority.get() !== authority ||
        !coordinator.isCurrent(publication)
      ) {
        return;
      }
      setDraft((current) =>
        current === authority.draft &&
        current.upload === null &&
        current.uploadAdmission === owner
          ? nextImageDraft(current, { uploadAdmission: null })
          : current,
      );
    },
    [coordinator, latestAuthority],
  );
  const startUpload = useCallback(
    (
      publication: ImagePublication,
      authority: ImageAuthority,
      file: File,
      input: HTMLInputElement,
      fallbackAlt: string,
    ) => {
      const callback = authority.onUpload;
      if (
        !callback ||
        activeUpload.get() !== null ||
        coordinator.active() !== publication ||
        latestAuthority.get() !== authority ||
        !coordinator.wasClaimed(publication)
      ) {
        return;
      }
      const owner: ImageUploadOwner = Object.freeze({
        identity: Symbol("image-upload"),
        origin: publication,
        authority,
        visit: authority.visit,
        callback,
        file,
        fileInput: input,
        altRevision: authority.altRevision,
        fallbackAlt,
        settlementAction: Object.freeze({
          identity: Symbol("image-upload-settlement"),
        }),
      });
      deferredUploadOutcome.set(null);
      activeUpload.set(owner);
      setDraft((current) =>
        current === authority.draft
          ? nextImageDraft(current, {
              error: null,
              upload: owner,
            })
          : current,
      );
      const pending = new Promise<{ url: string; alt?: string }>(
        (resolve, reject) => {
          try {
            resolve(callback(file));
          } catch (error) {
            reject(error);
          }
        },
      );
      void pending
        .then(
          (result) => settleUpload(owner, { kind: "success", result }),
          (error: unknown) => settleUpload(owner, { kind: "error", error }),
        )
        .catch((error: unknown) => {
          settleUpload(owner, { kind: "error", error });
        });
    },
    [
      activeUpload,
      coordinator,
      deferredUploadOutcome,
      latestAuthority,
      settleUpload,
    ],
  );
  const completeClose = useCallback(
    (closer: object) => {
      const authority = latestAuthority.get();
      if (!authority) return;
      const insertion = afterClose.consume(authority, closer);
      if (!insertion) return;
      insertion.onSubmit(insertion.src, insertion.alt);
    },
    [afterClose, latestAuthority],
  );
  const authority = useMemo<ImageAuthority>(
    () =>
      Object.freeze({
        mount,
        revision: publicationRevision,
        visit,
        open,
        onOpenChange,
        onSubmit,
        onUpload,
        draft,
        src: draft.src,
        alt: draft.alt,
        error: draft.error,
        altRevision: draft.altRevision,
        previewFailed: draft.previewFailed,
        upload: draft.upload,
        uploadAdmission: draft.uploadAdmission,
        uploading: draft.upload !== null,
        uploadDisabled:
          draft.upload !== null || draft.uploadAdmission !== null,
        uploadAvailable: onUpload !== undefined,
        normalizedSrc: draft.src.trim(),
        normalizedAlt: draft.alt.trim(),
        submitDisabled: draft.upload !== null || !draft.src.trim(),
      }),
    [
      draft,
      mount,
      onOpenChange,
      onSubmit,
      onUpload,
      open,
      publicationRevision,
      visit,
    ],
  );
  const presentation = useMemo(
    () =>
      createImagePresentation(
        authority,
        coordinator,
        () => latestAuthority.get(),
        (current) => latestAuthority.set(current),
        dismissalListener,
        requestSuccessor,
        () => activeUpload.get(),
        setDraft,
        startUpload,
        releaseUploadAdmission,
        resumeUploadSettlement,
        abandonDeferredUpload,
        releaseTerminalResources,
        afterClose,
        completeClose,
      ),
    [
      activeUpload,
      abandonDeferredUpload,
      afterClose,
      authority,
      completeClose,
      coordinator,
      dismissalListener,
      latestAuthority,
      requestSuccessor,
      releaseTerminalResources,
      releaseUploadAdmission,
      resumeUploadSettlement,
      startUpload,
    ],
  );
  useLayoutEffect(() => {
    const current = presentation.authority;
    latestAuthority.set(current);
    if (storedDraft !== current.draft) {
      setDraft((stored) =>
        stored === storedDraft ? current.draft : stored,
      );
    }
    const upload = activeUpload.get();
    if (
      upload &&
      current.upload !== upload &&
      current !== upload.authority
    ) {
      activeUpload.set(null);
      const deferred = deferredUploadOutcome.get();
      if (deferred?.owner === upload) deferredUploadOutcome.set(null);
    }
    if (current.open) afterClose.cancel();
    else afterClose.authorize(current);
  }, [
    activeUpload,
    afterClose,
    deferredUploadOutcome,
    latestAuthority,
    presentation,
    storedDraft,
  ]);
  useLayoutEffect(() => presentation.establish(), [presentation]);
  const {
    authority: current,
    captureBridge,
    captureForm,
    captureUrlLabel,
    captureUrlRow,
    captureUrl,
    captureUpload,
    captureFile,
    captureError,
    captureAltLabel,
    captureAlt,
    capturePreview,
    captureActions,
    captureCancel,
    captureInsert,
    establish,
    settlePortal,
    onOpenChange: setOpen,
    onClickCapture,
    onUrlChange,
    onAltChange,
    onUploadClick,
    onFileChange,
    onPreviewError,
    onCancelClick,
    onFormSubmitCapture,
    onFormSubmit,
    onClosed,
  } = presentation;
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <div
        ref={captureBridge}
        className="contents"
        onClickCapture={onClickCapture}
      >
        <DialogContent
          title={IMAGE_TITLE}
          description={IMAGE_DESCRIPTION}
          onClosed={onClosed}
        >
            <form
              ref={captureForm}
              className={IMAGE_FORM_CLASS}
              onSubmitCapture={onFormSubmitCapture}
              onSubmit={onFormSubmit}
            >
              <label
                ref={captureUrlLabel}
                className={IMAGE_LABEL_CLASS}
              >
                Image URL
                <div
                  ref={captureUrlRow}
                  className={IMAGE_URL_ROW_CLASS}
                >
                  <input
                    ref={captureUrl}
                    className={IMAGE_URL_CLASS}
                    placeholder="https://…/image.png"
                    value={current.src}
                    onChange={onUrlChange}
                    autoFocus
                    data-testid="image-url"
                  />
                  {current.uploadAvailable && (
                    <>
                      <button
                        ref={captureUpload}
                        type="button"
                        className={IMAGE_UPLOAD_CLASS}
                        onClick={onUploadClick}
                        disabled={current.uploadDisabled}
                        data-testid="image-upload"
                      >
                        {current.uploading ? "Uploading…" : "Upload…"}
                      </button>
                      <input
                        ref={captureFile}
                        type="file"
                        accept={IMAGE_FILE_ACCEPT}
                        className="hidden"
                        disabled={current.uploadDisabled}
                        onChange={onFileChange}
                        data-testid="image-file"
                      />
                    </>
                  )}
                </div>
              </label>
              {current.error && (
                <div
                  ref={captureError}
                  className={IMAGE_ERROR_CLASS}
                  role="alert"
                  data-testid="image-upload-error"
                >
                  {current.error}
                </div>
              )}
              <label
                ref={captureAltLabel}
                className={IMAGE_LABEL_CLASS}
              >
                Alt text
                <input
                  ref={captureAlt}
                  className={IMAGE_ALT_CLASS}
                  placeholder="Describe the image"
                  value={current.alt}
                  onChange={onAltChange}
                  data-testid="image-alt"
                />
              </label>
              {current.normalizedSrc && (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  ref={capturePreview}
                  src={current.normalizedSrc}
                  alt=""
                  className={IMAGE_PREVIEW_CLASS}
                  style={{
                    display: current.previewFailed ? "none" : undefined,
                  }}
                  onError={onPreviewError}
                />
              )}
              <div
                ref={captureActions}
                className={IMAGE_ACTIONS_CLASS}
              >
                <button
                  ref={captureCancel}
                  type="button"
                  className={IMAGE_CANCEL_CLASS}
                  onClick={onCancelClick}
                >
                  Cancel
                </button>
                <button
                  ref={captureInsert}
                  type="submit"
                  className={IMAGE_INSERT_CLASS}
                  disabled={current.submitDisabled}
                  data-testid="image-submit"
                >
                  Insert
                </button>
              </div>
              <ImagePublicationBoundary
                establish={establish}
                settlePortal={settlePortal}
              >
                {null}
              </ImagePublicationBoundary>
            </form>
        </DialogContent>
      </div>
    </Dialog>
  );
});

const GRID_ROWS = 6;
const GRID_COLS = 8;

interface TableDraft {
  visit: DialogActionVisit;
  open: boolean;
  focused: GridCell;
  hover: GridCell | null;
}

function tableDraft(visit: DialogActionVisit, open: boolean): TableDraft {
  return { visit, open, focused: { row: 0, col: 0 }, hover: null };
}

function captureTableGridIntrinsics(document: Document) {
  const view = document.defaultView;
  if (!view) return null;
  const Keyboard = view.KeyboardEvent;
  const Event = view.Event;
  const UIEvent = view.UIEvent;
  const descriptor = Object.getOwnPropertyDescriptor;
  const event = captureNameVersionGetters(descriptor, Event.prototype, [
    "type", "target", "currentTarget", "eventPhase", "bubbles", "cancelable",
    "defaultPrevented", "cancelBubble", "timeStamp",
  ] as const);
  const keyboard = captureNameVersionGetters(descriptor, Keyboard.prototype, [
    "key", "code", "location", "repeat", "isComposing",
    "ctrlKey", "altKey", "metaKey", "shiftKey",
  ] as const);
  const ui = captureNameVersionGetters(descriptor, UIEvent.prototype, ["view"] as const);
  const path = captureNameVersionMethod<Event["composedPath"]>(descriptor, Event.prototype, "composedPath");
  const prevent = captureNameVersionMethod<Event["preventDefault"]>(descriptor, Event.prototype, "preventDefault");
  const trusted = captureNameVersionTrustedAuthority(
    descriptor, Reflect.apply, new Keyboard("table-grid-intrinsic"),
  );
  const add = captureNameVersionWindowMethod(view, "addEventListener");
  const remove = captureNameVersionWindowMethod(view, "removeEventListener");
  if (!event || !keyboard || !ui || !path || !prevent || !trusted || !add || !remove) return null;
  return Object.freeze({
    view, Keyboard, path: path.method, prevent: prevent.method, trusted, add, remove,
    getters: Object.freeze({ ...event.getters, ...keyboard.getters, ...ui.getters }),
    isCurrent: () =>
      document.defaultView === view &&
      view.KeyboardEvent === Keyboard && view.Event === Event && view.UIEvent === UIEvent &&
      event.isCurrent() && keyboard.isCurrent() && ui.isCurrent() &&
      path.isCurrent() && prevent.isCurrent() && trusted.isCurrent() &&
      add.isCurrent() && remove.isCurrent(),
  });
}

type TableGridIntrinsics = NonNullable<ReturnType<typeof captureTableGridIntrinsics>>;
type TableGridFacts = Readonly<Pick<KeyboardEvent, keyof TableGridIntrinsics["getters"]>>;
type TableGridEvent = ReactKeyboardEvent<HTMLDivElement>;
type TableGridDelivery = Readonly<{
  wrapper: TableGridEvent;
  native: KeyboardEvent;
  facts: TableGridFacts;
  prevent: TableGridEvent["preventDefault"];
  defaultQuery: TableGridEvent["isDefaultPrevented"];
  stoppedQuery: TableGridEvent["isPropagationStopped"];
}>;
type TableGridDispatch = {
  readonly receiver: EventTarget;
  readonly path: readonly EventTarget[];
  capture: TableGridDelivery | null;
  claimed: boolean;
};
type TableGridEstablishment = Readonly<{
  grid: HTMLDivElement;
  cells: readonly HTMLButtonElement[];
  focus: readonly HTMLButtonElement["focus"][];
  document: Document;
  intrinsics: TableGridIntrinsics;
  dom: NameVersionDomSnapshot;
  placement: NameVersionPlacement;
  history: NameVersionDomGuard;
  deliveries: WeakMap<KeyboardEvent, TableGridDispatch>;
  seen: WeakSet<KeyboardEvent>;
  listener: EventListener;
}>;

class TableGridRoute {
  active: TableGridPublication | null = null;
  busy = false;
}

class TableGridPublication {
  private establishment: TableGridEstablishment | null = null;
  readonly grid: LinkElementOwner<HTMLDivElement>;
  readonly cells: readonly LinkElementOwner<HTMLButtonElement>[];

  constructor(
    private readonly route: TableGridRoute,
    private readonly draft: TableDraft,
    private readonly move: (next: GridCell) => void,
  ) {
    this.grid = new LinkElementOwner(() => this.retire());
    this.cells = Object.freeze(Array.from(
      { length: GRID_ROWS * GRID_COLS },
      () => new LinkElementOwner<HTMLButtonElement>(() => this.retire()),
    ));
  }

  readonly retire = () => {
    const current = this.establishment;
    this.establishment = null;
    if (this.route.active === this) this.route.active = null;
    if (!current) return;
    current.history.release();
    Reflect.apply(current.intrinsics.remove.value, current.intrinsics.view, [
      "keydown", current.listener, true,
    ]);
  };

  readonly establish = () => {
    this.retire();
    const grid = this.grid.element();
    if (!this.draft.open || !grid) return;
    const cells = this.cells.map((owner) => owner.element());
    if (!cells.every((cell): cell is HTMLButtonElement => cell !== null)) return;
    const document = grid.ownerDocument;
    const intrinsics = captureTableGridIntrinsics(document);
    const placement = captureNameVersionPlacement(grid);
    if (!intrinsics || !placement) return;
    const history = createNameVersionDomGuard(grid, placement);
    if (!history) return;
    const deliveries = new WeakMap<KeyboardEvent, TableGridDispatch>();
    const seen = new WeakSet<KeyboardEvent>();
    const route = this.route;
    const isCurrent = () => this.isCurrent(current);
    const listener: EventListener = function (this: EventTarget, event) {
      if (route.busy || !isCurrent()) return;
      route.busy = true;
      try {
        if (!(event instanceof intrinsics.Keyboard) || seen.has(event)) {
          if (event instanceof intrinsics.Keyboard) deliveries.delete(event);
          return;
        }
        seen.add(event);
        const path = Reflect.apply(intrinsics.path, event, []) as EventTarget[];
        if (
          !isCurrent() || !intrinsics.isCurrent() ||
          Reflect.apply(intrinsics.getters.currentTarget, event, []) !== this ||
          Reflect.apply(intrinsics.getters.eventPhase, event, []) !== 1 ||
          path.at(-1) !== this || path.at(-2) !== document ||
          !path.includes(grid) || !isCurrent()
        ) return;
        deliveries.set(event, {
          receiver: this, path: Object.freeze([...path]), capture: null, claimed: false,
        });
      } catch {
        // A malformed native dispatch has no route; a different event can still recover.
        if (isCurrent() && event instanceof intrinsics.Keyboard) deliveries.delete(event);
      } finally {
        route.busy = false;
      }
    };
    const current: TableGridEstablishment = Object.freeze({
      grid, cells: Object.freeze(cells), focus: Object.freeze(cells.map((cell) => cell.focus)),
      document, intrinsics, dom: snapshotNameVersionDom(grid), placement, history,
      deliveries, seen, listener,
    });
    this.establishment = current;
    this.route.active = this;
    Reflect.apply(intrinsics.add.value, intrinsics.view, ["keydown", listener, true]);
    return this.retire;
  };

  private isCurrent(current: TableGridEstablishment) {
    return this.route.active === this && this.establishment === current &&
      this.grid.element() === current.grid &&
      this.cells.every((owner, index) => owner.element() === current.cells[index]);
  }

  readonly capture = (event: TableGridEvent) => this.deliver(event, 1);
  readonly bubble = (event: TableGridEvent) => this.deliver(event, 3);

  private deliver(event: TableGridEvent, phase: 1 | 3) {
    // Exclusion belongs to the component, not a publication: synchronous replacement cannot reset it.
    if (this.route.busy) return;
    this.route.busy = true;
    const current = this.establishment;
    let native: KeyboardEvent | null = null;
    let dispatch: TableGridDispatch | undefined;
    let acceptedCapture = false;
    try {
      if (!current || !this.isCurrent(current)) return;
      const live = () => this.isCurrent(current) &&
        (!native || !dispatch || current.deliveries.get(native) === dispatch);
      const read = <T,>(callback: () => T): T => {
        if (!live()) throw new Error("Retired table grid delivery");
        const result = callback();
        if (!live()) throw new Error("Retired table grid delivery");
        return result;
      };
      const { intrinsics, grid, document, cells } = current;
      native = read(() => event.nativeEvent);
      // nativeEvent can be an accessor which synchronously closes or replaces this publication.
      if (!live() || !(native instanceof intrinsics.Keyboard)) return;
      dispatch = current.deliveries.get(native);
      if (!dispatch || dispatch.claimed || (phase === 1 && dispatch.capture)) return;
      const exactNative = native;
      const sourceIndex = this.draft.focused.row * GRID_COLS + this.draft.focused.col;
      const source = cells[sourceIndex];
      const nativeFacts = (prevented: boolean): TableGridFacts | null => {
        if (!read(() => intrinsics.isCurrent()) || !intrinsics.trusted.matches(exactNative)) return null;
        const entries = Object.entries(intrinsics.getters).map(([field, getter]) => {
          const value: unknown = read(() => Reflect.apply(getter, exactNative, []));
          const publicValue: unknown = read(() => Reflect.get(exactNative, field));
          if (value !== publicValue) throw new Error("Changed native table grid fact");
          return [field, value];
        });
        const facts = Object.freeze(Object.fromEntries(entries)) as TableGridFacts;
        const trusted = read(() => intrinsics.trusted.read(exactNative));
        if (
          trusted !== true || read(() => exactNative.isTrusted) !== true ||
          facts.type !== "keydown" || facts.target !== source ||
          facts.eventPhase !== phase || !facts.currentTarget ||
          facts.bubbles !== true || facts.cancelable !== true ||
          facts.defaultPrevented !== prevented || facts.cancelBubble !== false ||
          facts.repeat !== false || facts.isComposing !== false ||
          facts.altKey !== false || facts.shiftKey !== false ||
          typeof facts.ctrlKey !== "boolean" || typeof facts.metaKey !== "boolean" ||
          typeof facts.key !== "string" || !isNameVersionNavigationKey(facts.key) ||
          facts.code !== facts.key || facts.location !== 0 ||
          typeof facts.timeStamp !== "number" || !Number.isFinite(facts.timeStamp) ||
          (facts.view !== intrinsics.view && facts.view !== dispatch?.receiver) ||
          read(() => exactNative.composedPath) !== intrinsics.path ||
          read(() => exactNative.preventDefault) !== intrinsics.prevent
        ) return null;
        const path = read(() => Reflect.apply(intrinsics.path, exactNative, [])) as EventTarget[];
        const expectedPath: EventTarget[] = [];
        let node: Node | null = source;
        for (let index = 0; node && index < dispatch!.path.length; index++) {
          expectedPath.push(node);
          if (node === document) break;
          node = read(() => node!.parentNode);
        }
        expectedPath.push(dispatch!.receiver);
        if (
          path.length !== expectedPath.length || path.length !== dispatch!.path.length ||
          path.some((entry, index) => entry !== expectedPath[index] || entry !== dispatch!.path[index]) ||
          path.at(-2) !== document || path.indexOf(grid) < 0 ||
          path.indexOf(facts.currentTarget) <= path.indexOf(grid)
        ) return null;
        return facts;
      };
      const facts = nativeFacts(false);
      if (!facts) return;
      const next = gridCell(facts.key, this.draft.focused, GRID_ROWS, GRID_COLS, {
        ctrl: facts.ctrlKey === true || facts.metaKey === true,
      });
      if (!next) return;
      const destinationIndex = next.row * GRID_COLS + next.col;
      const destination = cells[destinationIndex];
      const focus = current.focus[destinationIndex];
      const domMatches = () =>
        read(() => document.defaultView) === intrinsics.view &&
        read(() => document.activeElement) === source &&
        read(() => nameVersionPlacementMatches(grid, current.placement)) &&
        read(() => nameVersionDomMatches(current.dom)) &&
        read(() => current.history.isClean()) &&
        read(() => grid.children.length) === GRID_ROWS &&
        cells.every((cell, index) =>
          read(() => cell.ownerDocument) === document &&
          read(() => cell.isConnected) &&
          read(() => cell.closest("[inert], [hidden], [aria-disabled='true']")) === null &&
          !read(() => cell.matches(":disabled")) &&
          read(() => cell.tabIndex) === (index === sourceIndex ? 0 : -1) &&
          read(() => cell.parentElement?.parentElement) === grid.children.item(Math.floor(index / GRID_COLS)) &&
          read(() => cell.parentElement?.parentElement?.children.item(index % GRID_COLS)?.firstElementChild) === cell &&
          read(() => cell.focus) === current.focus[index]) &&
        live();
      const delivery: TableGridDelivery = Object.freeze({
        wrapper: event, native: exactNative, facts,
        prevent: read(() => event.preventDefault),
        defaultQuery: read(() => event.isDefaultPrevented),
        stoppedQuery: read(() => event.isPropagationStopped),
      });
      const wrapperMatches = (
        expected: TableGridDelivery,
        currentTarget: HTMLDivElement | null,
        prevented = false,
        defaultQuery = expected.defaultQuery,
      ) => {
        const wrapper = expected.wrapper;
        if (
          read(() => wrapper.nativeEvent) !== expected.native ||
          read(() => wrapper.currentTarget) !== currentTarget ||
          read(() => wrapper.isTrusted) !== true ||
          read(() => wrapper.defaultPrevented) !== prevented
        ) return false;
        for (const field of [
          "type", "target", "eventPhase", "bubbles", "cancelable", "timeStamp",
          "key", "code", "location", "repeat", "ctrlKey", "altKey", "metaKey", "shiftKey", "view",
        ] as const) {
          if (read(() => wrapper[field]) !== expected.facts[field]) return false;
        }
        if (
          typeof expected.prevent !== "function" ||
          typeof defaultQuery !== "function" || typeof expected.stoppedQuery !== "function" ||
          read(() => wrapper.preventDefault) !== expected.prevent ||
          read(() => wrapper.isDefaultPrevented) !== defaultQuery ||
          read(() => Reflect.apply(defaultQuery, wrapper, [])) !== prevented ||
          read(() => wrapper.isPropagationStopped) !== expected.stoppedQuery ||
          read(() => Reflect.apply(expected.stoppedQuery, wrapper, [])) !== false
        ) return false;
        return read(() => wrapper.preventDefault) === expected.prevent &&
          read(() => wrapper.isDefaultPrevented) === defaultQuery &&
          read(() => wrapper.isPropagationStopped) === expected.stoppedQuery;
      };
      const nativeMatches = (prevented: boolean) => {
        const observed = nativeFacts(prevented);
        return observed !== null && Object.keys(facts).every((field) =>
          field === "defaultPrevented" ||
          observed[field as keyof TableGridFacts] === facts[field as keyof TableGridFacts]);
      };
      if (!wrapperMatches(delivery, grid) || !domMatches() || !nativeMatches(false)) return;
      if (phase === 1) {
        if (!live()) return;
        dispatch.capture = delivery;
        acceptedCapture = true;
        return;
      }
      const capture = dispatch.capture;
      if (!capture || capture.native !== exactNative ||
        Object.keys(facts).some((field) =>
          field !== "eventPhase" && capture.facts[field as keyof TableGridFacts] !== facts[field as keyof TableGridFacts])
      ) return;
      dispatch.claimed = true;
      const checkpoint = (prevented: boolean, defaultQuery = delivery.defaultQuery) =>
        wrapperMatches(capture, null) &&
        wrapperMatches(delivery, grid, prevented, defaultQuery) &&
        domMatches() && nativeMatches(prevented) &&
        dispatch!.capture === capture && dispatch!.claimed && live();
      if (!checkpoint(false) || read(() => event.preventDefault) !== delivery.prevent || !live()) return;
      Reflect.apply(delivery.prevent, delivery.wrapper, []);
      // React 19 replaces this one query in preventDefault. Retain it before any other public callback.
      const preventedQuery = read(() => delivery.wrapper.isDefaultPrevented);
      if (!live() || !checkpoint(true, preventedQuery)) return;
      this.move(next);
      if (!live() || !checkpoint(true, preventedQuery) ||
        read(() => destination.focus) !== focus || !live()
      ) return;
      Reflect.apply(focus, destination, [{ preventScroll: true }]);
    } catch {
      // Public event reads/callbacks may throw. Reject this delivery without poisoning its successor.
    } finally {
      if (current && native && dispatch && !acceptedCapture && this.isCurrent(current)) {
        current.deliveries.delete(native);
      }
      this.route.busy = false;
    }
  }
}

function TableGridPublicationBoundary({ publication }: { publication: TableGridPublication }) {
  useLayoutEffect(() => publication.establish(), [publication]);
  return null;
}

/**
 * Size picker as a WAI-ARIA grid (issue #160): one Tab stop (the focused cell is the only `tabIndex=0`),
 * arrows / Home / End move focus, the "rows × columns" label follows the keyboard as well as the mouse,
 * Enter or a click inserts, Tab leaves straight for the dialog's Close button.
 */
export const TableDialog = memo(function TableDialog({ open, onOpenChange, onSubmit }: { open: boolean; onOpenChange: (open: boolean) => void; onSubmit: (rows: number, cols: number) => void }) {
  const visit = useMemo<DialogActionVisit>(() => ({ onOpenChange, onSubmit }), [onOpenChange, onSubmit]);
  const activeVisit = useRef<DialogActionVisit | null>(null);
  const openRef = useRef(false);
  const [storedDraft, setDraft] = useState<TableDraft>(() => tableDraft(visit, open));
  let draft = storedDraft;
  if (draft.visit !== visit || draft.open !== open) {
    draft = tableDraft(visit, open);
    setDraft(draft);
  }
  const { focused, hover } = draft;
  const [gridRoute] = useState(() => new TableGridRoute());
  const publication = new TableGridPublication(gridRoute, draft, (next) => {
    setDraft({ ...draft, focused: next, hover: null });
  });
  const after = useAfterClose(visit, activeVisit);
  useLayoutEffect(() => {
    activeVisit.current = visit;
    return () => {
      if (activeVisit.current === visit) activeVisit.current = null;
    };
  }, [visit]);
  useLayoutEffect(() => {
    openRef.current = open;
  }, [open]);
  const shown = hover ?? focused;
  const setOpen = (nextOpen: boolean) => {
    if (activeVisit.current === visit) onOpenChange(nextOpen);
  };
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent title="Insert table" description="Pick a size. The first row becomes the header." onClosed={after.onClosed}>
        <div className="flex flex-col items-center gap-3">
          <div
            ref={(element) => publication.grid.capture(element)}
            className="flex flex-col gap-1"
            role="grid"
            aria-label="Table size"
            onMouseLeave={() => {
              if (activeVisit.current !== visit || !openRef.current) return;
              setDraft((current) => (current.visit === visit ? { ...current, hover: null } : current));
            }}
            onKeyDownCapture={publication.capture}
            onKeyDown={publication.bubble}
            data-testid="table-grid"
          >
            {Array.from({ length: GRID_ROWS }, (_, r) => (
              <div key={r} role="row" className="flex gap-1">
                {Array.from({ length: GRID_COLS }, (_, c) => {
                  const isFocused = focused.row === r && focused.col === c;
                  return (
                    <div key={c} role="gridcell">
                      <button
                        ref={(element) => publication.cells[r * GRID_COLS + c].capture(element)}
                        type="button"
                        tabIndex={isFocused ? 0 : -1}
                        className={`block h-6 w-6 rounded border ${r < shown.row + 1 && c < shown.col + 1 ? "border-accent bg-accent-soft" : "border-line-2 bg-surface"}`}
                        onMouseEnter={() => {
                          if (activeVisit.current !== visit || !openRef.current) return;
                          setDraft((current) => (current.visit === visit ? { ...current, hover: { row: r, col: c } } : current));
                        }}
                        onFocus={() => {
                          if (gridRoute.busy || activeVisit.current !== visit || !openRef.current) return;
                          setDraft((current) => (current.visit === visit ? { ...current, focused: { row: r, col: c }, hover: null } : current));
                        }}
                        onClick={() => {
                          if (activeVisit.current !== visit || !openRef.current) return;
                          after.defer(() => onSubmit(r + 1, c + 1));
                          setOpen(false);
                        }}
                        aria-label={`${r + 1} by ${c + 1}`}
                      />
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
          <div className="text-sm text-ink-3" data-testid="table-grid-label">
            {shown.row + 1} rows × {shown.col + 1} columns
          </div>
          <TableGridPublicationBoundary publication={publication} />
        </div>
      </DialogContent>
    </Dialog>
  );
});

export interface NameVersionVisit {
  id: number;
  editor: object;
  documentId: string;
}

export interface NameVersionSaveOwner {
  visit: NameVersionVisit;
  editor: object;
  documentId: string;
  operationId: number;
  title: string;
}

type NameVersionNavigationKey =
  | "ArrowLeft"
  | "ArrowUp"
  | "ArrowRight"
  | "ArrowDown"
  | "Home"
  | "End";

type NameVersionActionFacts = Readonly<{
  kind: "cancel" | "save";
  eligible: boolean;
}>;

type NameVersionPresentation = Readonly<{
  mount: symbol;
  revision: number;
  open: boolean;
  visit: NameVersionVisit;
  title: string;
  trimmedTitle: string;
  busy: boolean;
  error: string | null;
  saveOwner: NameVersionSaveOwner | null;
  onOpenChange: (visit: NameVersionVisit, open: boolean) => void;
  nextOperationId: () => number;
  onSubmit: (owner: NameVersionSaveOwner) => Promise<void>;
  actions: readonly [
    cancel: NameVersionActionFacts,
    save: NameVersionActionFacts,
  ];
}>;

interface NameVersionElementSlot<T extends HTMLElement> {
  element: T | null;
  revision: number;
  binding: RefCallback<T> | null;
}

function nameVersionElementSlot<T extends HTMLElement>(): NameVersionElementSlot<T> {
  return {
    element: null,
    revision: 0,
    binding: null,
  };
}

type NameVersionDomSnapshot = Readonly<{
  node: Node;
  nodeValue: string | null;
  attributes: readonly (readonly [string, string])[] | null;
  children: readonly NameVersionDomSnapshot[];
}>;

type NameVersionPlacementLink = Readonly<{
  node: Node;
  parent: Node;
  previousSibling: Node | null;
  nextSibling: Node | null;
}>;

type NameVersionPlacement = Readonly<{
  document: Document;
  links: readonly NameVersionPlacementLink[];
}>;

type NameVersionDomGuard = Readonly<{
  isClean: () => boolean;
  release: () => void;
}>;

type NameVersionNativeGetter = (this: object) => unknown;
type NameVersionEventField =
  | "type"
  | "target"
  | "currentTarget"
  | "eventPhase"
  | "bubbles"
  | "cancelable"
  | "defaultPrevented"
  | "cancelBubble";
type NameVersionKeyField =
  | "key"
  | "code"
  | "location"
  | "repeat"
  | "isComposing"
  | "ctrlKey"
  | "altKey"
  | "metaKey"
  | "shiftKey";

type NameVersionGetterAuthority<Field extends string> = Readonly<{
  getters: Readonly<Record<Field, NameVersionNativeGetter>>;
  isCurrent: () => boolean;
}>;

type NameVersionViewIdentity =
  | ReactKeyboardEvent<HTMLDivElement>["view"]
  | Window
  | EventTarget;

type NameVersionMethodAuthority<Method> = Readonly<{
  method: Method;
  isCurrent: () => boolean;
}>;

type NameVersionWindowMethod<Method> = Readonly<{
  value: Method;
  isCurrent: () => boolean;
}>;

type NameVersionTrustedAuthority = Readonly<{
  matches: (event: object) => boolean;
  read: (event: object) => boolean;
  isCurrent: () => boolean;
}>;

type NameVersionTerminalProof = Readonly<{
  registration: NameVersionTerminalRegistration;
  nativeEvent: KeyboardEvent;
  receiver: EventTarget;
  currentTarget: EventTarget;
  terminal: EventTarget;
  path: readonly EventTarget[];
}>;

type NameVersionTerminalRegistration = Readonly<{
  proofFor: (event: KeyboardEvent) => NameVersionTerminalProof | null;
  claim: (proof: NameVersionTerminalProof) => boolean;
  owns: (proof: NameVersionTerminalProof) => boolean;
  release: () => void;
  isCurrent: () => boolean;
}>;

type NameVersionFocus = (
  this: HTMLElement,
  options?: FocusOptions,
) => void;

type NameVersionKeyboardAuthority = Readonly<{
  form: HTMLFormElement;
  boundary: HTMLDivElement;
  document: Document;
  ownerWindow: Window & typeof globalThis;
  targets: readonly HTMLButtonElement[];
  Event: typeof Event;
  UIEvent: typeof UIEvent;
  KeyboardEvent: typeof KeyboardEvent;
  Document: typeof Document;
  HTMLElement: typeof HTMLElement;
  event: NameVersionGetterAuthority<NameVersionEventField>["getters"];
  keyboard: NameVersionGetterAuthority<NameVersionKeyField>["getters"];
  view: NameVersionNativeGetter;
  activeElement: NameVersionNativeGetter;
  composedPath: Event["composedPath"];
  preventDefault: Event["preventDefault"];
  focus: NameVersionFocus;
  trusted: NameVersionTrustedAuthority;
  terminal: NameVersionTerminalRegistration;
  apply: typeof Reflect.apply;
  prototypeOf: typeof Object.getPrototypeOf;
  intrinsicsAreCurrent: () => boolean;
  isCurrent: () => boolean;
}>;

type NameVersionNativeSnapshot = Readonly<{
  event: KeyboardEvent;
  type: string;
  target: HTMLButtonElement;
  currentTarget: EventTarget;
  phase: number;
  path: readonly EventTarget[];
  bubbles: boolean;
  cancelable: boolean;
  defaultPrevented: boolean;
  cancelBubble: boolean;
  key: NameVersionNavigationKey;
  code: string;
  location: number;
  repeat: boolean;
  composing: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  view: NameVersionViewIdentity;
  terminal: NameVersionTerminalProof;
}>;

type NameVersionReactCancellation = Readonly<{
  preventDefault: ReactKeyboardEvent<HTMLDivElement>["preventDefault"];
  isDefaultPrevented: () => boolean;
  isPropagationStopped: () => boolean;
}>;

type NameVersionReactSnapshot = Readonly<{
  event: ReactKeyboardEvent<HTMLDivElement>;
  currentTarget: HTMLDivElement;
  eventPhase: number;
  cancellation: NameVersionReactCancellation;
}>;

type NameVersionDeliveryPair = Readonly<{
  publication: NameVersionFormPublication;
  establishment: NameVersionEstablishment;
  native: NameVersionNativeSnapshot;
  capture: NameVersionReactSnapshot;
}>;

type NameVersionRefOwner = Readonly<{
  element: HTMLElement | null;
  revision: number;
}>;

type NameVersionRefSnapshot = Readonly<{
  owner: NameVersionRefOwner;
  element: HTMLElement;
  revision: number;
}>;

interface NameVersionEstablishment {
  readonly publication: NameVersionFormPublication;
  readonly form: HTMLFormElement;
  readonly boundary: HTMLDivElement;
  readonly input: HTMLInputElement;
  readonly cancel: HTMLButtonElement;
  readonly save: HTMLButtonElement;
  readonly refs: readonly NameVersionRefSnapshot[];
  readonly dom: NameVersionDomSnapshot;
  readonly placement: NameVersionPlacement;
  readonly guard: NameVersionDomGuard;
  readonly keyboard: NameVersionKeyboardAuthority;
  pair: NameVersionDeliveryPair | null;
  claimedPair: NameVersionDeliveryPair | null;
  released: boolean;
}

type NameVersionMovement = Readonly<{
  establishment: NameVersionEstablishment;
  pair: NameVersionDeliveryPair;
  authority: NameVersionKeyboardAuthority;
  native: NameVersionNativeSnapshot;
  bubble: NameVersionReactSnapshot;
  sourceAction: NameVersionActionFacts;
  destinationAction: NameVersionActionFacts;
  source: HTMLButtonElement;
  destination: HTMLButtonElement;
}>;

interface NameVersionFormPublication {
  readonly presentation: NameVersionPresentation;
  readonly form: NameVersionElementSlot<HTMLFormElement>;
  readonly input: NameVersionElementSlot<HTMLInputElement>;
  readonly boundary: NameVersionElementSlot<HTMLDivElement>;
  readonly cancel: NameVersionElementSlot<HTMLButtonElement>;
  readonly save: NameVersionElementSlot<HTMLButtonElement>;
}

function nameVersionDescriptorsMatch(
  current: PropertyDescriptor | undefined,
  expected: PropertyDescriptor,
) {
  if (
    !current ||
    current.configurable !== expected.configurable ||
    current.enumerable !== expected.enumerable ||
    ("value" in current) !== ("value" in expected) ||
    ("writable" in current) !== ("writable" in expected) ||
    ("get" in current) !== ("get" in expected) ||
    ("set" in current) !== ("set" in expected)
  ) {
    return false;
  }
  return "value" in expected
    ? current.value === expected.value && current.writable === expected.writable
    : current.get === expected.get && current.set === expected.set;
}

function captureNameVersionGetters<const Fields extends readonly string[]>(
  getOwnPropertyDescriptor: typeof Object.getOwnPropertyDescriptor,
  prototype: object,
  fields: Fields,
): NameVersionGetterAuthority<Fields[number]> | null {
  const entries: [Fields[number], NameVersionNativeGetter][] = [];
  const descriptors: [Fields[number], Readonly<PropertyDescriptor>][] = [];
  for (const field of fields) {
    const descriptor = getOwnPropertyDescriptor(prototype, field);
    if (!descriptor || typeof descriptor.get !== "function") return null;
    entries.push([field, descriptor.get]);
    descriptors.push([field, Object.freeze({ ...descriptor })]);
  }
  const getters = Object.freeze(
    Object.fromEntries(entries),
  ) as Readonly<Record<Fields[number], NameVersionNativeGetter>>;
  return Object.freeze({
    getters,
    isCurrent: () =>
      descriptors.every(([field, expected]) =>
        nameVersionDescriptorsMatch(
          getOwnPropertyDescriptor(prototype, field),
          expected,
        )),
  });
}

function captureNameVersionMethod<Method>(
  getOwnPropertyDescriptor: typeof Object.getOwnPropertyDescriptor,
  prototype: object,
  name: PropertyKey,
): NameVersionMethodAuthority<Method> | null {
  const descriptor = getOwnPropertyDescriptor(prototype, name);
  if (!descriptor || typeof descriptor.value !== "function") return null;
  const expected = Object.freeze({ ...descriptor });
  return Object.freeze({
    method: descriptor.value as Method,
    isCurrent: () =>
      nameVersionDescriptorsMatch(
        getOwnPropertyDescriptor(prototype, name),
        expected,
      ),
  });
}

function captureNameVersionWindowMethod<
  Property extends "addEventListener" | "removeEventListener",
>(
  ownerWindow: Window & typeof globalThis,
  property: Property,
): NameVersionWindowMethod<Window[Property]> | null {
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
  const value = reflectGet(
    ownerWindow,
    property,
    ownerWindow,
  ) as Window[Property];
  if (!found || typeof value !== "function") return null;
  const isCurrent = () =>
    ownerWindow.Object.getOwnPropertyDescriptor === getOwnPropertyDescriptor &&
    ownerWindow.Object.getPrototypeOf === getPrototypeOf &&
    ownerWindow.Reflect.get === reflectGet &&
    path.every(({ target: entry, descriptor, prototype }) =>
      getPrototypeOf(entry) === prototype &&
      (descriptor
        ? nameVersionDescriptorsMatch(
            getOwnPropertyDescriptor(entry, property),
            descriptor,
          )
        : getOwnPropertyDescriptor(entry, property) === undefined)) &&
    reflectGet(ownerWindow, property, ownerWindow) === value;
  return isCurrent() ? Object.freeze({ value, isCurrent }) : null;
}

function captureNameVersionTrustedAuthority(
  getOwnPropertyDescriptor: typeof Object.getOwnPropertyDescriptor,
  apply: typeof Reflect.apply,
  probe: KeyboardEvent,
): NameVersionTrustedAuthority | null {
  const descriptor = getOwnPropertyDescriptor(probe, "isTrusted");
  if (
    !descriptor ||
    descriptor.configurable !== false ||
    descriptor.enumerable !== true ||
    typeof descriptor.get !== "function" ||
    descriptor.set !== undefined
  ) {
    return null;
  }
  const expected = Object.freeze({ ...descriptor });
  const matches = (event: object) =>
    nameVersionDescriptorsMatch(
      getOwnPropertyDescriptor(event, "isTrusted"),
      expected,
    );
  return Object.freeze({
    matches,
    read: (event) =>
      apply(
        descriptor.get as NameVersionNativeGetter,
        event,
        [],
      ) as boolean,
    isCurrent: () => matches(probe),
  });
}

function createNameVersionTerminalRegistration(
  ownerWindow: Window & typeof globalThis,
  ownerDocument: Document,
  KeyboardEventConstructor: typeof KeyboardEvent,
  keyboardEventPrototype: object,
  eventCurrentTarget: NameVersionNativeGetter,
  eventPhase: NameVersionNativeGetter,
  composedPath: Event["composedPath"],
  addEventListener: NameVersionWindowMethod<Window["addEventListener"]>,
  removeEventListener: NameVersionWindowMethod<Window["removeEventListener"]>,
  apply: typeof Reflect.apply,
  prototypeOf: typeof Object.getPrototypeOf,
  intrinsicsAreCurrent: () => boolean,
): NameVersionTerminalRegistration | null {
  const proofs = new WeakMap<KeyboardEvent, NameVersionTerminalProof>();
  const invalidEvents = new WeakSet<Event>();
  let claimed: NameVersionTerminalProof | null = null;
  let active = false;
  let released = false;

  const listener: EventListener = function (
    this: EventTarget,
    event: Event,
  ) {
    if (
      !active ||
      released ||
      !(event instanceof KeyboardEventConstructor) ||
      prototypeOf(event) !== keyboardEventPrototype ||
      invalidEvents.has(event) ||
      !intrinsicsAreCurrent()
    ) {
      return;
    }
    if (proofs.has(event)) {
      invalidEvents.add(event);
      return;
    }
    try {
      const currentTarget = apply(
        eventCurrentTarget,
        event,
        [],
      ) as EventTarget | null;
      const phase = apply(eventPhase, event, []) as number;
      const path = apply(composedPath, event, []) as EventTarget[];
      const terminal = path.at(-1);
      if (
        currentTarget !== this ||
        terminal !== this ||
        phase !== ownerWindow.Event.CAPTURING_PHASE ||
        path.at(-2) !== ownerDocument
      ) {
        invalidEvents.add(event);
        return;
      }
      proofs.set(event, Object.freeze({
        registration,
        nativeEvent: event,
        receiver: this,
        currentTarget,
        terminal,
        path: Object.freeze([...path]),
      }));
    } catch {
      invalidEvents.add(event);
    }
  };

  const proofFor = (event: KeyboardEvent) => {
    const proof = proofs.get(event);
    if (
      !proof ||
      !active ||
      released ||
      (claimed !== null && claimed !== proof) ||
      invalidEvents.has(event) ||
      proof.registration !== registration ||
      proof.nativeEvent !== event ||
      proof.receiver !== proof.currentTarget ||
      proof.receiver !== proof.terminal ||
      !intrinsicsAreCurrent()
    ) {
      return null;
    }
    try {
      const path = apply(composedPath, event, []) as EventTarget[];
      return path.length === proof.path.length &&
        path.every((entry, index) => entry === proof.path[index]) &&
        path.at(-2) === ownerDocument &&
        path.at(-1) === proof.receiver
        ? proof
        : null;
    } catch {
      invalidEvents.add(event);
      return null;
    }
  };

  const registration: NameVersionTerminalRegistration = Object.freeze({
    proofFor,
    claim: (proof) => {
      if (claimed || proofFor(proof.nativeEvent) !== proof) return false;
      claimed = proof;
      return true;
    },
    owns: (proof) =>
      claimed === proof && proofFor(proof.nativeEvent) === proof,
    release: () => {
      if (released) return;
      released = true;
      active = false;
      apply(removeEventListener.value, ownerWindow, [
        "keydown",
        listener,
        true,
      ]);
    },
    isCurrent: () =>
      active &&
      !released &&
      intrinsicsAreCurrent() &&
      addEventListener.isCurrent() &&
      removeEventListener.isCurrent(),
  });

  active = true;
  try {
    apply(addEventListener.value, ownerWindow, [
      "keydown",
      listener,
      true,
    ]);
    if (registration.isCurrent()) return registration;
    registration.release();
    return null;
  } catch {
    active = false;
    released = true;
    return null;
  }
}

function captureNameVersionKeyboardAuthority(
  publication: NameVersionFormPublication,
): NameVersionKeyboardAuthority | null {
  const form = publication.form.element;
  const boundary = publication.boundary.element;
  const cancel = publication.cancel.element;
  const save = publication.save.element;
  const document = form?.ownerDocument;
  const ownerWindow = document?.defaultView;
  if (
    !form ||
    !boundary ||
    !cancel ||
    !save ||
    !document ||
    !ownerWindow ||
    boundary.ownerDocument !== document ||
    cancel.ownerDocument !== document ||
    save.ownerDocument !== document
  ) {
    return null;
  }

  const objectConstructor = ownerWindow.Object;
  const getOwnPropertyDescriptor = objectConstructor.getOwnPropertyDescriptor;
  const prototypeOf = objectConstructor.getPrototypeOf;
  const apply = ownerWindow.Reflect.apply;
  const EventConstructor = ownerWindow.Event;
  const UIEventConstructor = ownerWindow.UIEvent;
  const KeyboardEventConstructor = ownerWindow.KeyboardEvent;
  const DocumentConstructor = ownerWindow.Document;
  const HTMLElementConstructor = ownerWindow.HTMLElement;
  const eventPrototype = EventConstructor.prototype;
  const uiEventPrototype = UIEventConstructor.prototype;
  const keyboardEventPrototype = KeyboardEventConstructor.prototype;
  const documentPrototype = DocumentConstructor.prototype;
  const eventGetters = captureNameVersionGetters(
    getOwnPropertyDescriptor,
    eventPrototype,
    [
      "type",
      "target",
      "currentTarget",
      "eventPhase",
      "bubbles",
      "cancelable",
      "defaultPrevented",
      "cancelBubble",
    ] as const,
  );
  const keyboardGetters = captureNameVersionGetters(
    getOwnPropertyDescriptor,
    keyboardEventPrototype,
    [
      "key",
      "code",
      "location",
      "repeat",
      "isComposing",
      "ctrlKey",
      "altKey",
      "metaKey",
      "shiftKey",
    ] as const,
  );
  const uiGetters = captureNameVersionGetters(
    getOwnPropertyDescriptor,
    uiEventPrototype,
    ["view"] as const,
  );
  const documentGetters = captureNameVersionGetters(
    getOwnPropertyDescriptor,
    documentPrototype,
    ["activeElement"] as const,
  );
  const composedPath = captureNameVersionMethod<Event["composedPath"]>(
    getOwnPropertyDescriptor,
    eventPrototype,
    "composedPath",
  );
  const preventDefault = captureNameVersionMethod<Event["preventDefault"]>(
    getOwnPropertyDescriptor,
    eventPrototype,
    "preventDefault",
  );
  const focus = captureNameVersionMethod<NameVersionFocus>(
    getOwnPropertyDescriptor,
    HTMLElementConstructor.prototype,
    "focus",
  );
  const addEventListener = captureNameVersionWindowMethod(
    ownerWindow,
    "addEventListener",
  );
  const removeEventListener = captureNameVersionWindowMethod(
    ownerWindow,
    "removeEventListener",
  );
  if (
    !eventGetters ||
    !keyboardGetters ||
    !uiGetters ||
    !documentGetters ||
    !composedPath ||
    !preventDefault ||
    !focus ||
    !addEventListener ||
    !removeEventListener
  ) {
    return null;
  }

  let probe: KeyboardEvent;
  try {
    probe = new KeyboardEventConstructor("name-version-keyboard-intrinsic");
  } catch {
    return null;
  }
  const trusted = captureNameVersionTrustedAuthority(
    getOwnPropertyDescriptor,
    apply,
    probe,
  );
  if (!trusted) return null;

  const intrinsicsAreCurrent = () => {
    try {
      return (
        document.defaultView === ownerWindow &&
        ownerWindow.Object === objectConstructor &&
        ownerWindow.Object.getOwnPropertyDescriptor ===
          getOwnPropertyDescriptor &&
        ownerWindow.Object.getPrototypeOf === prototypeOf &&
        ownerWindow.Reflect.apply === apply &&
        ownerWindow.Event === EventConstructor &&
        ownerWindow.UIEvent === UIEventConstructor &&
        ownerWindow.KeyboardEvent === KeyboardEventConstructor &&
        ownerWindow.Document === DocumentConstructor &&
        ownerWindow.HTMLElement === HTMLElementConstructor &&
        EventConstructor.prototype === eventPrototype &&
        UIEventConstructor.prototype === uiEventPrototype &&
        KeyboardEventConstructor.prototype === keyboardEventPrototype &&
        DocumentConstructor.prototype === documentPrototype &&
        prototypeOf(probe) === keyboardEventPrototype &&
        prototypeOf(keyboardEventPrototype) === uiEventPrototype &&
        prototypeOf(uiEventPrototype) === eventPrototype &&
        eventGetters.isCurrent() &&
        keyboardGetters.isCurrent() &&
        uiGetters.isCurrent() &&
        documentGetters.isCurrent() &&
        composedPath.isCurrent() &&
        preventDefault.isCurrent() &&
        focus.isCurrent() &&
        addEventListener.isCurrent() &&
        removeEventListener.isCurrent() &&
        trusted.isCurrent()
      );
    } catch {
      return false;
    }
  };
  try {
    if (!intrinsicsAreCurrent() || trusted.read(probe) !== false) return null;
  } catch {
    return null;
  }

  const terminal = createNameVersionTerminalRegistration(
    ownerWindow,
    document,
    KeyboardEventConstructor,
    keyboardEventPrototype,
    eventGetters.getters.currentTarget,
    eventGetters.getters.eventPhase,
    composedPath.method,
    addEventListener,
    removeEventListener,
    apply,
    prototypeOf,
    intrinsicsAreCurrent,
  );
  if (!terminal) return null;
  return Object.freeze({
    form,
    boundary,
    document,
    ownerWindow,
    targets: Object.freeze([cancel, save]),
    Event: EventConstructor,
    UIEvent: UIEventConstructor,
    KeyboardEvent: KeyboardEventConstructor,
    Document: DocumentConstructor,
    HTMLElement: HTMLElementConstructor,
    event: eventGetters.getters,
    keyboard: keyboardGetters.getters,
    view: uiGetters.getters.view,
    activeElement: documentGetters.getters.activeElement,
    composedPath: composedPath.method,
    preventDefault: preventDefault.method,
    focus: focus.method,
    trusted,
    terminal,
    apply,
    prototypeOf,
    intrinsicsAreCurrent,
    isCurrent: () => intrinsicsAreCurrent() && terminal.isCurrent(),
  });
}

function nameVersionAttributes(
  node: Node,
): readonly (readonly [string, string])[] | null {
  if (node.nodeType !== 1) return null;
  return Object.freeze(
    [...(node as Element).attributes]
      .map(({ name, value }) => Object.freeze([name, value] as const))
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

function snapshotNameVersionDom(node: Node): NameVersionDomSnapshot {
  return Object.freeze({
    node,
    nodeValue: node.nodeValue,
    attributes: nameVersionAttributes(node),
    children: Object.freeze(
      [...node.childNodes].map(snapshotNameVersionDom),
    ),
  });
}

function nameVersionDomMatches(snapshot: NameVersionDomSnapshot): boolean {
  if (snapshot.node.nodeValue !== snapshot.nodeValue) return false;
  const attributes = nameVersionAttributes(snapshot.node);
  if (attributes === null || snapshot.attributes === null) {
    if (attributes !== snapshot.attributes) return false;
  } else if (
    attributes.length !== snapshot.attributes.length ||
    attributes.some(([name, value], index) => {
      const expected = snapshot.attributes?.[index];
      return !expected || expected[0] !== name || expected[1] !== value;
    })
  ) {
    return false;
  }
  return (
    snapshot.node.childNodes.length === snapshot.children.length &&
    snapshot.children.every(
      (child, index) =>
        snapshot.node.childNodes.item(index) === child.node &&
        nameVersionDomMatches(child),
    )
  );
}

function captureNameVersionPlacement(
  root: HTMLElement,
): NameVersionPlacement | null {
  const document = root.ownerDocument;
  if (!root.isConnected) return null;
  const links: NameVersionPlacementLink[] = [];
  let node: Node = root;
  while (node !== document) {
    const parent = node.parentNode;
    if (!parent) return null;
    links.push(Object.freeze({
      node,
      parent,
      previousSibling: node.previousSibling,
      nextSibling: node.nextSibling,
    }));
    node = parent;
  }
  return links.length === 0
    ? null
    : Object.freeze({
        document,
        links: Object.freeze(links),
      });
}

function nameVersionPlacementMatches(
  root: HTMLElement,
  placement: NameVersionPlacement,
) {
  return (
    root.ownerDocument === placement.document &&
    root.isConnected &&
    placement.links[0]?.node === root &&
    placement.links.every((link) =>
      link.node.isConnected &&
      link.node.parentNode === link.parent &&
      link.node.previousSibling === link.previousSibling &&
      link.node.nextSibling === link.nextSibling) &&
    placement.links.at(-1)?.parent === placement.document
  );
}

function createNameVersionDomGuard(
  root: HTMLElement,
  placement: NameVersionPlacement,
): NameVersionDomGuard | null {
  const MutationObserverConstructor =
    placement.document.defaultView?.MutationObserver;
  if (!MutationObserverConstructor) return null;
  let changed = false;
  let released = false;
  const pendingRecords: MutationRecord[] = [];
  const observer = new MutationObserverConstructor((records) => {
    pendingRecords.push(...records);
  });
  const takeRecords = () => {
    const records = [...pendingRecords, ...observer.takeRecords()];
    pendingRecords.length = 0;
    return records;
  };
  const recordChanges = (records: readonly MutationRecord[]) => {
    if (changed) return;
    changed = records.some((record) => {
      if (record.target === root || root.contains(record.target)) return true;
      if (record.type !== "childList") return false;
      return placement.links.some((link) =>
        record.target === link.parent &&
        [...record.addedNodes, ...record.removedNodes].includes(link.node));
    });
  };
  const exactReactInputRecords = (records: readonly MutationRecord[]) => {
    if (records.length === 0) return true;
    const ownerWindow = placement.document.defaultView;
    if (!ownerWindow) return false;
    for (let index = 0; index < records.length;) {
      const nameStart = records[index];
      const possibleType = records[index + 1];
      const hasTypeReset =
        possibleType?.type === "attributes" &&
        possibleType.attributeName === "type" &&
        possibleType.target === nameStart?.target;
      const nameEnd = records[index + (hasTypeReset ? 2 : 1)];
      if (
        nameStart?.type !== "attributes" ||
        nameStart.attributeName !== "name" ||
        nameStart.oldValue !== null ||
        !(nameStart.target instanceof ownerWindow.HTMLInputElement) ||
        !root.contains(nameStart.target) ||
        nameEnd?.type !== "attributes" ||
        nameEnd.attributeName !== "name" ||
        nameEnd.target !== nameStart.target ||
        nameEnd.oldValue !== "" ||
        nameStart.target.hasAttribute("name") ||
        (hasTypeReset &&
          possibleType.oldValue !==
            nameStart.target.getAttribute("type"))
      ) {
        return false;
      }
      index += hasTypeReset ? 3 : 2;
    }
    return true;
  };
  observer.observe(root, {
    attributes: true,
    attributeOldValue: true,
    characterData: true,
    childList: true,
    subtree: true,
  });
  for (const parent of new Set(placement.links.map((link) => link.parent))) {
    observer.observe(parent, { childList: true });
  }
  return Object.freeze({
    isClean: () => {
      const records = takeRecords();
      if (!exactReactInputRecords(records)) recordChanges(records);
      return !released && !changed;
    },
    release: () => {
      if (released) return;
      recordChanges(takeRecords());
      released = true;
      observer.disconnect();
    },
  });
}

function isNameVersionNavigationKey(
  key: string,
): key is NameVersionNavigationKey {
  return (
    key === "ArrowLeft" ||
    key === "ArrowUp" ||
    key === "ArrowRight" ||
    key === "ArrowDown" ||
    key === "Home" ||
    key === "End"
  );
}

function nameVersionNativeValue<Value>(
  authority: NameVersionKeyboardAuthority,
  getter: NameVersionNativeGetter,
  target: object,
): Value {
  return authority.apply(getter, target, []) as Value;
}

function captureNameVersionNativeEvent(
  authority: NameVersionKeyboardAuthority,
  nativeEvent: Event,
  expectedPhase: number,
  expectedDefaultPrevented = false,
): NameVersionNativeSnapshot | null {
  if (
    !authority.isCurrent() ||
    authority.prototypeOf(nativeEvent) !== authority.KeyboardEvent.prototype ||
    !authority.trusted.matches(nativeEvent)
  ) {
    return null;
  }
  try {
    const type = nameVersionNativeValue<string>(
      authority,
      authority.event.type,
      nativeEvent,
    );
    const target = nameVersionNativeValue<EventTarget | null>(
      authority,
      authority.event.target,
      nativeEvent,
    );
    const currentTarget = nameVersionNativeValue<EventTarget | null>(
      authority,
      authority.event.currentTarget,
      nativeEvent,
    );
    const phase = nameVersionNativeValue<number>(
      authority,
      authority.event.eventPhase,
      nativeEvent,
    );
    const bubbles = nameVersionNativeValue<boolean>(
      authority,
      authority.event.bubbles,
      nativeEvent,
    );
    const cancelable = nameVersionNativeValue<boolean>(
      authority,
      authority.event.cancelable,
      nativeEvent,
    );
    const defaultPrevented = nameVersionNativeValue<boolean>(
      authority,
      authority.event.defaultPrevented,
      nativeEvent,
    );
    const cancelBubble = nameVersionNativeValue<boolean>(
      authority,
      authority.event.cancelBubble,
      nativeEvent,
    );
    const key = nameVersionNativeValue<string>(
      authority,
      authority.keyboard.key,
      nativeEvent,
    );
    const code = nameVersionNativeValue<string>(
      authority,
      authority.keyboard.code,
      nativeEvent,
    );
    const location = nameVersionNativeValue<number>(
      authority,
      authority.keyboard.location,
      nativeEvent,
    );
    const repeat = nameVersionNativeValue<boolean>(
      authority,
      authority.keyboard.repeat,
      nativeEvent,
    );
    const composing = nameVersionNativeValue<boolean>(
      authority,
      authority.keyboard.isComposing,
      nativeEvent,
    );
    const ctrlKey = nameVersionNativeValue<boolean>(
      authority,
      authority.keyboard.ctrlKey,
      nativeEvent,
    );
    const altKey = nameVersionNativeValue<boolean>(
      authority,
      authority.keyboard.altKey,
      nativeEvent,
    );
    const metaKey = nameVersionNativeValue<boolean>(
      authority,
      authority.keyboard.metaKey,
      nativeEvent,
    );
    const shiftKey = nameVersionNativeValue<boolean>(
      authority,
      authority.keyboard.shiftKey,
      nativeEvent,
    );
    const view = nameVersionNativeValue<NameVersionViewIdentity | null>(
      authority,
      authority.view,
      nativeEvent,
    );
    const activeElement = nameVersionNativeValue<Element | null>(
      authority,
      authority.activeElement,
      authority.document,
    );
    const path = authority.apply(
      authority.composedPath,
      nativeEvent,
      [],
    ) as EventTarget[];
    const trusted = authority.trusted.read(nativeEvent);
    const terminal = authority.terminal.proofFor(
      nativeEvent as KeyboardEvent,
    );
    if (
      type !== "keydown" ||
      !(target instanceof authority.ownerWindow.HTMLButtonElement) ||
      target.ownerDocument !== authority.document ||
      !authority.targets.includes(target) ||
      activeElement !== target ||
      !currentTarget ||
      phase !== expectedPhase ||
      !bubbles ||
      !cancelable ||
      defaultPrevented !== expectedDefaultPrevented ||
      cancelBubble ||
      !isNameVersionNavigationKey(key) ||
      repeat ||
      composing ||
      ctrlKey ||
      altKey ||
      metaKey ||
      shiftKey ||
      trusted !== true ||
      !terminal ||
      (view !== authority.ownerWindow && view !== terminal.receiver) ||
      !authority.form.isConnected ||
      !authority.boundary.isConnected ||
      authority.boundary.parentElement !== authority.form
    ) {
      return null;
    }

    const expectedPath: EventTarget[] = [];
    let node: Node | null = target;
    while (node) {
      expectedPath.push(node);
      if (node === authority.document) break;
      node = node.parentNode;
    }
    expectedPath.push(terminal.receiver);
    if (
      expectedPath.at(-2) !== authority.document ||
      path.length !== expectedPath.length ||
      path.some((entry, index) => entry !== expectedPath[index]) ||
      path.length !== terminal.path.length ||
      path.some((entry, index) => entry !== terminal.path[index]) ||
      terminal.receiver !== terminal.currentTarget ||
      terminal.receiver !== terminal.terminal ||
      !path.includes(authority.form) ||
      !path.includes(authority.boundary) ||
      !path.includes(currentTarget)
    ) {
      return null;
    }
    return Object.freeze({
      event: nativeEvent as KeyboardEvent,
      type,
      target,
      currentTarget,
      phase,
      path: Object.freeze([...path]),
      bubbles,
      cancelable,
      defaultPrevented,
      cancelBubble,
      key,
      code,
      location,
      repeat,
      composing,
      ctrlKey,
      altKey,
      metaKey,
      shiftKey,
      view,
      terminal,
    });
  } catch {
    return null;
  }
}

function nameVersionNativeEventMatches(
  authority: NameVersionKeyboardAuthority,
  expected: NameVersionNativeSnapshot,
) {
  const current = captureNameVersionNativeEvent(
    authority,
    expected.event,
    expected.phase,
    expected.defaultPrevented,
  );
  return nameVersionNativeSnapshotsMatch(current, expected);
}

function nameVersionNativeEventPreventedMatches(
  authority: NameVersionKeyboardAuthority,
  expected: NameVersionNativeSnapshot,
) {
  const current = captureNameVersionNativeEvent(
    authority,
    expected.event,
    expected.phase,
    true,
  );
  return nameVersionNativeSnapshotsMatch(current, expected, true);
}

function nameVersionNativeSnapshotsMatch(
  current: NameVersionNativeSnapshot | null,
  expected: NameVersionNativeSnapshot,
  expectedDefaultPrevented = expected.defaultPrevented,
) {
  return Boolean(
    current &&
      current.type === expected.type &&
      current.target === expected.target &&
      current.currentTarget === expected.currentTarget &&
      current.phase === expected.phase &&
      current.bubbles === expected.bubbles &&
      current.cancelable === expected.cancelable &&
      current.defaultPrevented === expectedDefaultPrevented &&
      current.cancelBubble === expected.cancelBubble &&
      current.key === expected.key &&
      current.code === expected.code &&
      current.location === expected.location &&
      current.repeat === expected.repeat &&
      current.composing === expected.composing &&
      current.ctrlKey === expected.ctrlKey &&
      current.altKey === expected.altKey &&
      current.metaKey === expected.metaKey &&
      current.shiftKey === expected.shiftKey &&
      current.view === expected.view &&
      current.terminal === expected.terminal &&
      current.path.length === expected.path.length &&
      current.path.every((entry, index) => entry === expected.path[index]),
  );
}

function captureNameVersionReactCancellation(
  event: ReactKeyboardEvent<HTMLDivElement>,
  authority: NameVersionKeyboardAuthority,
): NameVersionReactCancellation | null {
  try {
    const reactEvent = event as ReactKeyboardEvent<HTMLDivElement> & {
      preventDefault?: unknown;
      isDefaultPrevented?: unknown;
      isPropagationStopped?: unknown;
    };
    const preventDefault = reactEvent.preventDefault;
    const isDefaultPrevented = reactEvent.isDefaultPrevented;
    const isPropagationStopped = reactEvent.isPropagationStopped;
    const defaultPrevented =
      typeof isDefaultPrevented === "function" &&
      authority.apply(isDefaultPrevented, event, []);
    const propagationStopped =
      typeof isPropagationStopped === "function" &&
      authority.apply(isPropagationStopped, event, []);
    return typeof preventDefault === "function" &&
      typeof isDefaultPrevented === "function" &&
      typeof isPropagationStopped === "function" &&
      defaultPrevented === false &&
      propagationStopped === false &&
      reactEvent.preventDefault === preventDefault &&
      reactEvent.isDefaultPrevented === isDefaultPrevented &&
      reactEvent.isPropagationStopped === isPropagationStopped
      ? Object.freeze({
          preventDefault,
          isDefaultPrevented,
          isPropagationStopped,
        })
      : null;
  } catch {
    return null;
  }
}

function nameVersionReactCancellationMatches(
  snapshot: NameVersionReactSnapshot,
  authority: NameVersionKeyboardAuthority,
) {
  const current = captureNameVersionReactCancellation(
    snapshot.event,
    authority,
  );
  return Boolean(
    current &&
      current.preventDefault === snapshot.cancellation.preventDefault &&
      current.isDefaultPrevented ===
        snapshot.cancellation.isDefaultPrevented &&
      current.isPropagationStopped ===
        snapshot.cancellation.isPropagationStopped,
  );
}

function nameVersionReactPreventionMatches(
  snapshot: NameVersionReactSnapshot,
  authority: NameVersionKeyboardAuthority,
) {
  try {
    const isDefaultPrevented = snapshot.event.isDefaultPrevented;
    return (
      snapshot.event.defaultPrevented === true &&
      typeof isDefaultPrevented === "function" &&
      authority.apply(isDefaultPrevented, snapshot.event, []) === true &&
      snapshot.event.defaultPrevented === true &&
      snapshot.event.isDefaultPrevented === isDefaultPrevented
    );
  } catch {
    return false;
  }
}

function captureNameVersionReactEvent(
  event: ReactKeyboardEvent<HTMLDivElement>,
  authority: NameVersionKeyboardAuthority,
  native: NameVersionNativeSnapshot,
): NameVersionReactSnapshot | null {
  try {
    const cancellation = captureNameVersionReactCancellation(
      event,
      authority,
    );
    return cancellation &&
      event.nativeEvent === native.event &&
      event.type === native.type &&
      event.target === native.target &&
      event.currentTarget === authority.boundary &&
      event.eventPhase === native.phase &&
      event.bubbles === native.bubbles &&
      event.cancelable === native.cancelable &&
      event.defaultPrevented === native.defaultPrevented &&
      event.isTrusted === true &&
      event.key === native.key &&
      event.code === native.code &&
      event.location === native.location &&
      event.repeat === native.repeat &&
      event.ctrlKey === native.ctrlKey &&
      event.altKey === native.altKey &&
      event.metaKey === native.metaKey &&
      event.shiftKey === native.shiftKey &&
      event.view === native.view
      ? Object.freeze({
          event,
          currentTarget: authority.boundary,
          eventPhase: native.phase,
          cancellation,
        })
      : null;
  } catch {
    return null;
  }
}

function nameVersionReactEventMatches(
  snapshot: NameVersionReactSnapshot,
  authority: NameVersionKeyboardAuthority,
  native: NameVersionNativeSnapshot,
) {
  const event = snapshot.event;
  return (
    snapshot.currentTarget === authority.boundary &&
    snapshot.eventPhase === native.phase &&
    event.nativeEvent === native.event &&
    event.type === native.type &&
    event.target === native.target &&
    event.eventPhase === native.phase &&
    event.bubbles === native.bubbles &&
    event.cancelable === native.cancelable &&
    event.defaultPrevented === native.defaultPrevented &&
    event.isTrusted === true &&
    event.key === native.key &&
    event.code === native.code &&
    event.location === native.location &&
    event.repeat === native.repeat &&
    event.ctrlKey === native.ctrlKey &&
    event.altKey === native.altKey &&
    event.metaKey === native.metaKey &&
    event.shiftKey === native.shiftKey &&
    event.view === native.view &&
    nameVersionReactCancellationMatches(snapshot, authority)
  );
}

function nameVersionDeliveriesMatch(
  capture: NameVersionNativeSnapshot,
  bubble: NameVersionNativeSnapshot,
  authority: NameVersionKeyboardAuthority,
) {
  return (
    capture.event === bubble.event &&
    capture.type === bubble.type &&
    capture.target === bubble.target &&
    capture.currentTarget === bubble.currentTarget &&
    capture.phase === authority.Event.CAPTURING_PHASE &&
    bubble.phase === authority.Event.BUBBLING_PHASE &&
    capture.bubbles === bubble.bubbles &&
    capture.cancelable === bubble.cancelable &&
    capture.defaultPrevented === bubble.defaultPrevented &&
    capture.cancelBubble === bubble.cancelBubble &&
    capture.key === bubble.key &&
    capture.code === bubble.code &&
    capture.location === bubble.location &&
    capture.repeat === bubble.repeat &&
    capture.composing === bubble.composing &&
    capture.ctrlKey === bubble.ctrlKey &&
    capture.altKey === bubble.altKey &&
    capture.metaKey === bubble.metaKey &&
    capture.shiftKey === bubble.shiftKey &&
    capture.view === bubble.view &&
    capture.terminal === bubble.terminal &&
    capture.path.length === bubble.path.length &&
    capture.path.every((entry, index) => entry === bubble.path[index])
  );
}

function nameVersionPublicationRefs(
  publication: NameVersionFormPublication,
): readonly NameVersionRefOwner[] {
  return [
    publication.form,
    publication.input,
    publication.boundary,
    publication.cancel,
    publication.save,
  ];
}

function nameVersionPublicationDomIsExact(
  publication: NameVersionFormPublication,
  establishment?: NameVersionEstablishment,
) {
  const form = publication.form.element;
  const input = publication.input.element;
  const boundary = publication.boundary.element;
  const cancel = publication.cancel.element;
  const save = publication.save.element;
  const facts = publication.presentation;
  if (
    !form ||
    !input ||
    !boundary ||
    !cancel ||
    !save ||
    !form.isConnected ||
    input.ownerDocument !== form.ownerDocument ||
    boundary.ownerDocument !== form.ownerDocument ||
    cancel.ownerDocument !== form.ownerDocument ||
    save.ownerDocument !== form.ownerDocument ||
    input.parentElement !== form ||
    boundary.parentElement !== form ||
    cancel.parentElement !== boundary ||
    save.parentElement !== boundary ||
    boundary.children.length !== 2 ||
    boundary.children.item(0) !== cancel ||
    boundary.children.item(1) !== save ||
    cancel.form !== form ||
    save.form !== form ||
    cancel.type !== "button" ||
    save.type !== "submit" ||
    cancel.disabled !== !facts.actions[0].eligible ||
    save.disabled !== !facts.actions[1].eligible ||
    input.disabled !== facts.busy ||
    input.value !== facts.title ||
    input.dataset.testid !== "version-name" ||
    save.dataset.testid !== "version-name-submit" ||
    cancel.textContent?.trim() !== "Cancel" ||
    save.textContent?.trim() !== "Save version"
  ) {
    return false;
  }
  if (!establishment) return true;
  return (
    establishment.publication === publication &&
    establishment.form === form &&
    establishment.input === input &&
    establishment.boundary === boundary &&
    establishment.cancel === cancel &&
    establishment.save === save &&
    establishment.refs.length === 5 &&
    establishment.refs.every(
      ({ owner, element, revision }, index) =>
        nameVersionPublicationRefs(publication)[index] === owner &&
        owner.element === element &&
        owner.revision === revision,
    ) &&
    establishment.guard.isClean() &&
    nameVersionPlacementMatches(form, establishment.placement) &&
    nameVersionDomMatches(establishment.dom)
  );
}

class NameVersionNavigationCoordinator {
  #current: NameVersionEstablishment | null = null;
  readonly #claimedPublications = new WeakSet<NameVersionFormPublication>();
  readonly #claimedActions = new WeakSet<NameVersionActionFacts>();
  readonly #claimedWrappers = new WeakSet<object>();
  readonly #claimedNativeEvents = new WeakSet<Event>();
  readonly #claimedPairs = new WeakSet<NameVersionDeliveryPair>();

  invalidate(publication: NameVersionFormPublication) {
    if (this.#current?.publication === publication) {
      this.#release(this.#current);
    }
  }

  establish(
    publication: NameVersionFormPublication,
    factsAreCurrent: () => boolean,
  ): (() => void) | undefined {
    const previous = this.#current;
    if (previous) this.#release(previous);
    if (
      this.#claimedPublications.has(publication) ||
      !factsAreCurrent() ||
      !nameVersionPublicationDomIsExact(publication)
    ) {
      return undefined;
    }
    const form = publication.form.element;
    const boundary = publication.boundary.element;
    const input = publication.input.element;
    const cancel = publication.cancel.element;
    const save = publication.save.element;
    if (!form || !boundary || !input || !cancel || !save) return undefined;
    const placement = captureNameVersionPlacement(form);
    if (!placement) return undefined;
    const guard = createNameVersionDomGuard(form, placement);
    if (!guard) return undefined;
    const keyboard = captureNameVersionKeyboardAuthority(publication);
    if (!keyboard) {
      guard.release();
      return undefined;
    }
    const establishment: NameVersionEstablishment = {
      publication,
      form,
      boundary,
      input,
      cancel,
      save,
      refs: Object.freeze(
        nameVersionPublicationRefs(publication).map((owner) =>
          Object.freeze({
            owner,
            element: owner.element!,
            revision: owner.revision,
          })),
      ),
      dom: snapshotNameVersionDom(form),
      placement,
      guard,
      keyboard,
      pair: null,
      claimedPair: null,
      released: false,
    };
    if (
      !factsAreCurrent() ||
      !nameVersionPublicationDomIsExact(publication, establishment)
    ) {
      keyboard.terminal.release();
      guard.release();
      return undefined;
    }
    this.#current = establishment;
    return () => {
      if (this.#current === establishment) this.#release(establishment);
    };
  }

  publishCapture(
    publication: NameVersionFormPublication,
    event: ReactKeyboardEvent<HTMLDivElement>,
    factsAreCurrent: () => boolean,
  ) {
    const establishment = this.#current;
    if (!establishment || establishment.publication !== publication) return;
    const pending = establishment.pair;
    if (pending && pending.native.event !== event.nativeEvent) {
      try {
        const authority = pending.establishment.keyboard;
        const phase = nameVersionNativeValue<number>(
          authority,
          authority.event.eventPhase,
          pending.native.event,
        );
        const currentTarget = nameVersionNativeValue<EventTarget | null>(
          authority,
          authority.event.currentTarget,
          pending.native.event,
        );
        if (phase === authority.Event.NONE && currentTarget === null) {
          establishment.pair = null;
        }
      } catch {
        return;
      }
    }
    if (
      establishment.pair ||
      establishment.claimedPair ||
      establishment.released ||
      !factsAreCurrent() ||
      !nameVersionPublicationDomIsExact(publication, establishment)
    ) {
      return;
    }
    const authority = establishment.keyboard;
    const native = captureNameVersionNativeEvent(
      authority,
      event.nativeEvent,
      authority.Event.CAPTURING_PHASE,
    );
    const capture = native
      ? captureNameVersionReactEvent(event, authority, native)
      : null;
    if (
      !native ||
      !capture ||
      this.#current !== establishment ||
      establishment.released ||
      !factsAreCurrent() ||
      !nameVersionPublicationDomIsExact(publication, establishment)
    ) {
      return;
    }
    establishment.pair = Object.freeze({
      publication,
      establishment,
      native,
      capture,
    });
  }

  claimMovement(
    publication: NameVersionFormPublication,
    event: ReactKeyboardEvent<HTMLDivElement>,
    factsAreCurrent: () => boolean,
  ): NameVersionMovement | null {
    const establishment = this.#current;
    const pair = establishment?.pair;
    if (
      !establishment ||
      !pair ||
      establishment.publication !== publication ||
      pair.publication !== publication ||
      pair.establishment !== establishment ||
      pair.capture.event === event ||
      pair.native.event !== event.nativeEvent ||
      establishment.claimedPair ||
      establishment.released
    ) {
      return null;
    }
    const authority = establishment.keyboard;
    const bubbleNative = captureNameVersionNativeEvent(
      authority,
      event.nativeEvent,
      authority.Event.BUBBLING_PHASE,
    );
    const bubble = bubbleNative
      ? captureNameVersionReactEvent(event, authority, bubbleNative)
      : null;
    if (
      !bubbleNative ||
      !bubble ||
      !nameVersionDeliveriesMatch(pair.native, bubbleNative, authority) ||
      !nameVersionReactEventMatches(pair.capture, authority, pair.native) ||
      !nameVersionReactEventMatches(bubble, authority, bubbleNative) ||
      !factsAreCurrent() ||
      !nameVersionPublicationDomIsExact(publication, establishment)
    ) {
      return null;
    }

    const actions = publication.presentation.actions;
    const elements = [establishment.cancel, establishment.save] as const;
    const sourceIndex = elements.findIndex(
      (element) => element === bubbleNative.target,
    );
    const enabled = (index: number) => {
      const action = actions[index];
      const element = elements[index];
      return Boolean(
        action?.eligible &&
        element &&
        !element.disabled &&
        element.isConnected,
      );
    };
    if (sourceIndex < 0 || !enabled(sourceIndex)) return null;

    let destinationIndex: number | null = null;
    if (
      bubbleNative.key === "ArrowLeft" ||
      bubbleNative.key === "ArrowUp"
    ) {
      for (let index = sourceIndex - 1; index >= 0; index -= 1) {
        if (enabled(index)) {
          destinationIndex = index;
          break;
        }
      }
    } else if (
      bubbleNative.key === "ArrowRight" ||
      bubbleNative.key === "ArrowDown"
    ) {
      for (
        let index = sourceIndex + 1;
        index < elements.length;
        index += 1
      ) {
        if (enabled(index)) {
          destinationIndex = index;
          break;
        }
      }
    } else if (bubbleNative.key === "Home") {
      destinationIndex = elements.findIndex((_, index) => enabled(index));
    } else {
      for (let index = elements.length - 1; index >= 0; index -= 1) {
        if (enabled(index)) {
          destinationIndex = index;
          break;
        }
      }
    }
    if (
      destinationIndex === null ||
      destinationIndex < 0 ||
      destinationIndex === sourceIndex
    ) {
      return null;
    }
    const source = elements[sourceIndex];
    const destination = elements[destinationIndex];
    const sourceAction = actions[sourceIndex];
    const destinationAction = actions[destinationIndex];
    if (
      !source ||
      !destination ||
      !sourceAction ||
      !destinationAction ||
      source === destination ||
      this.#current !== establishment ||
      establishment.pair !== pair ||
      bubbleNative.target !== source ||
      !enabled(sourceIndex) ||
      !enabled(destinationIndex) ||
      !nameVersionNativeEventMatches(authority, bubbleNative) ||
      !nameVersionReactEventMatches(pair.capture, authority, pair.native) ||
      !nameVersionReactEventMatches(bubble, authority, bubbleNative) ||
      !factsAreCurrent() ||
      !nameVersionPublicationDomIsExact(publication, establishment) ||
      this.#claimedPublications.has(publication) ||
      this.#claimedActions.has(sourceAction) ||
      this.#claimedActions.has(destinationAction) ||
      this.#claimedWrappers.has(pair.capture.event) ||
      this.#claimedWrappers.has(bubble.event) ||
      this.#claimedNativeEvents.has(bubbleNative.event) ||
      this.#claimedPairs.has(pair) ||
      !authority.terminal.claim(bubbleNative.terminal)
    ) {
      return null;
    }

    this.#claimedPublications.add(publication);
    this.#claimedActions.add(sourceAction);
    this.#claimedActions.add(destinationAction);
    this.#claimedWrappers.add(pair.capture.event);
    this.#claimedWrappers.add(bubble.event);
    this.#claimedNativeEvents.add(bubbleNative.event);
    this.#claimedPairs.add(pair);
    establishment.claimedPair = pair;
    return Object.freeze({
      establishment,
      pair,
      authority,
      native: bubbleNative,
      bubble,
      sourceAction,
      destinationAction,
      source,
      destination,
    });
  }

  effectsAreCurrent(
    movement: NameVersionMovement,
    factsAreCurrent: () => boolean,
  ) {
    const { establishment, pair, authority, native, bubble } = movement;
    const stateIsCurrent = () =>
      this.#current === establishment &&
      !establishment.released &&
      establishment.claimedPair === pair &&
      establishment.pair === pair &&
      this.#claimedPublications.has(establishment.publication) &&
      this.#claimedActions.has(movement.sourceAction) &&
      this.#claimedActions.has(movement.destinationAction) &&
      this.#claimedWrappers.has(pair.capture.event) &&
      this.#claimedWrappers.has(bubble.event) &&
      this.#claimedNativeEvents.has(native.event) &&
      this.#claimedPairs.has(pair) &&
      authority.intrinsicsAreCurrent() &&
      authority.terminal.owns(native.terminal) &&
      nameVersionNativeEventMatches(authority, native) &&
      factsAreCurrent() &&
      nameVersionPublicationDomIsExact(
        establishment.publication,
        establishment,
      );
    return (
      stateIsCurrent() &&
      nameVersionReactCancellationMatches(pair.capture, authority) &&
      nameVersionReactCancellationMatches(bubble, authority) &&
      stateIsCurrent()
    );
  }

  preventionIsCurrent(
    movement: NameVersionMovement,
    factsAreCurrent: () => boolean,
  ) {
    const { establishment, pair, authority, native, bubble } = movement;
    const stateIsCurrent = () =>
      this.#current === establishment &&
      !establishment.released &&
      establishment.claimedPair === pair &&
      establishment.pair === pair &&
      this.#claimedPublications.has(establishment.publication) &&
      this.#claimedActions.has(movement.sourceAction) &&
      this.#claimedActions.has(movement.destinationAction) &&
      this.#claimedWrappers.has(pair.capture.event) &&
      this.#claimedWrappers.has(bubble.event) &&
      this.#claimedNativeEvents.has(native.event) &&
      this.#claimedPairs.has(pair) &&
      authority.intrinsicsAreCurrent() &&
      authority.terminal.owns(native.terminal) &&
      nameVersionNativeEventPreventedMatches(authority, native) &&
      factsAreCurrent() &&
      nameVersionPublicationDomIsExact(
        establishment.publication,
        establishment,
      );
    return (
      stateIsCurrent() &&
      nameVersionReactPreventionMatches(bubble, authority) &&
      stateIsCurrent()
    );
  }

  discard(publication: NameVersionFormPublication) {
    if (
      this.#current?.publication === publication &&
      !this.#current.claimedPair
    ) {
      this.#current.pair = null;
    }
  }

  finish(movement: NameVersionMovement) {
    if (this.#current === movement.establishment) {
      this.#release(movement.establishment);
    }
  }

  #release(establishment: NameVersionEstablishment) {
    if (establishment.released) return;
    establishment.released = true;
    establishment.pair = null;
    establishment.keyboard.terminal.release();
    establishment.guard.release();
    if (this.#current === establishment) this.#current = null;
  }
}

const NAME_VERSION_PREVENT_SCROLL = Object.freeze({
  preventScroll: true,
});

function createNameVersionFormPublication(
  presentation: NameVersionPresentation,
): NameVersionFormPublication {
  return Object.freeze({
    presentation,
    form: nameVersionElementSlot<HTMLFormElement>(),
    input: nameVersionElementSlot<HTMLInputElement>(),
    boundary: nameVersionElementSlot<HTMLDivElement>(),
    cancel: nameVersionElementSlot<HTMLButtonElement>(),
    save: nameVersionElementSlot<HTMLButtonElement>(),
  });
}

export const NameVersionDialog = memo(function NameVersionDialog({
  open,
  visit,
  onOpenChange,
  nextOperationId,
  onSubmit,
}: {
  open: boolean;
  visit: NameVersionVisit;
  onOpenChange: (visit: NameVersionVisit, open: boolean) => void;
  nextOperationId: () => number;
  onSubmit: (owner: NameVersionSaveOwner) => Promise<void>;
}) {
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const activeVisit = useRef<NameVersionVisit | null>(null);
  const activeSave = useRef<NameVersionSaveOwner | null>(null);
  const [saveOwner, setSaveOwner] = useState<NameVersionSaveOwner | null>(null);
  const [navigationMount] = useState(() =>
    Symbol("name-version-navigation"));
  const [publicationRevision, setPublicationRevision] = useState(0);
  const [navigationCoordinator] = useState(
    () => new NameVersionNavigationCoordinator(),
  );
  const requestPublicationSuccessor = useCallback(() => {
    setPublicationRevision((revision) => revision + 1);
  }, []);
  useLayoutEffect(() => {
    if (open) {
      activeVisit.current = visit;
      activeSave.current = null;
      setSaveOwner(null);
      setTitle("");
      setError(null);
      setBusy(false);
    } else if (activeVisit.current === visit) {
      activeVisit.current = null;
      activeSave.current = null;
      setSaveOwner(null);
    }
    return () => {
      if (activeVisit.current === visit) {
        activeVisit.current = null;
        activeSave.current = null;
      }
    };
  }, [open, visit]);
  const ownsSave = (owner: NameVersionSaveOwner) => activeVisit.current === owner.visit && activeSave.current === owner;
  const setOpen = (nextOpen: boolean) => {
    if (!nextOpen && activeVisit.current === visit) {
      activeVisit.current = null;
      activeSave.current = null;
      setSaveOwner(null);
    }
    onOpenChange(visit, nextOpen);
  };
  const presentation = useMemo<NameVersionPresentation>(() => {
    const trimmedTitle = title.trim();
    return Object.freeze({
      mount: navigationMount,
      revision: publicationRevision,
      open,
      visit,
      title,
      trimmedTitle,
      busy,
      error,
      saveOwner,
      onOpenChange,
      nextOperationId,
      onSubmit,
      actions: Object.freeze([
        Object.freeze({ kind: "cancel" as const, eligible: open }),
        Object.freeze({
          kind: "save" as const,
          eligible: open && !busy && trimmedTitle.length > 0,
        }),
      ] as const),
    });
  }, [
    busy,
    error,
    navigationMount,
    nextOperationId,
    onOpenChange,
    onSubmit,
    open,
    publicationRevision,
    saveOwner,
    title,
    visit,
  ]);
  const navigationFactsAreCurrent = useCallback(
    () =>
      presentation.mount === navigationMount &&
      presentation.revision === publicationRevision &&
      presentation.open === open &&
      presentation.open &&
      presentation.visit === visit &&
      presentation.title === title &&
      presentation.trimmedTitle === title.trim() &&
      presentation.busy === busy &&
      presentation.error === error &&
      presentation.saveOwner === saveOwner &&
      activeSave.current === saveOwner &&
      presentation.onOpenChange === onOpenChange &&
      presentation.nextOperationId === nextOperationId &&
      presentation.onSubmit === onSubmit &&
      activeVisit.current === visit,
    [
      busy,
      error,
      navigationMount,
      nextOperationId,
      onOpenChange,
      onSubmit,
      open,
      presentation,
      publicationRevision,
      saveOwner,
      title,
      visit,
    ],
  );
  const formPublication = useMemo(
    () => createNameVersionFormPublication(presentation),
    [presentation],
  );
  const bindNavigationElement = <T extends HTMLElement>(
    candidate: NameVersionFormPublication,
    owner: NameVersionElementSlot<T>,
  ): RefCallback<T> => {
    owner.binding ??= (element) => {
      if (owner.element === element) return;
      owner.element = element;
      owner.revision += 1;
      navigationCoordinator.invalidate(candidate);
    };
    return owner.binding;
  };
  useLayoutEffect(
    () =>
      navigationCoordinator.establish(
        formPublication,
        navigationFactsAreCurrent,
      ),
    [
      formPublication,
      navigationCoordinator,
      navigationFactsAreCurrent,
    ],
  );
  const onNavigationKeyDownCapture = (
    event: ReactKeyboardEvent<HTMLDivElement>,
  ) => {
    navigationCoordinator.publishCapture(
      formPublication,
      event,
      navigationFactsAreCurrent,
    );
  };
  const onNavigationKeyDown = (
    event: ReactKeyboardEvent<HTMLDivElement>,
  ) => {
    const movement = navigationCoordinator.claimMovement(
      formPublication,
      event,
      navigationFactsAreCurrent,
    );
    if (!movement) {
      navigationCoordinator.discard(formPublication);
      return;
    }
    try {
      if (
        !navigationCoordinator.effectsAreCurrent(
          movement,
          navigationFactsAreCurrent,
        )
      ) {
        return;
      }
      movement.authority.apply(
        movement.bubble.cancellation.preventDefault,
        movement.bubble.event,
        [],
      );
      if (
        !navigationCoordinator.preventionIsCurrent(
          movement,
          navigationFactsAreCurrent,
        )
      ) {
        return;
      }
      movement.authority.apply(
        movement.authority.focus,
        movement.destination,
        [NAME_VERSION_PREVENT_SCROLL],
      );
    } finally {
      navigationCoordinator.finish(movement);
      requestPublicationSuccessor();
    }
  };
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent title="Name this version" description="Named versions stay easy to find in the history.">
        <form
          ref={bindNavigationElement(formPublication, formPublication.form)}
          className="flex flex-col gap-3"
          onSubmit={async (e) => {
            e.preventDefault();
            const currentVisit = activeVisit.current;
            const submittedTitle = title.trim();
            if (!currentVisit || activeSave.current || !submittedTitle) return;
            const owner = Object.freeze({
              visit: currentVisit,
              editor: currentVisit.editor,
              documentId: currentVisit.documentId,
              operationId: nextOperationId(),
              title: submittedTitle,
            });
            activeSave.current = owner;
            setSaveOwner(owner);
            setError(null);
            setBusy(true);
            try {
              await onSubmit(owner);
              if (ownsSave(owner)) setOpen(false);
            } catch (reason) {
              if (ownsSave(owner)) setError(apiErrorText(reason, "Could not save version"));
            } finally {
              if (ownsSave(owner)) {
                activeSave.current = null;
                setSaveOwner(null);
                setBusy(false);
              }
            }
          }}
        >
          <input
            ref={bindNavigationElement(formPublication, formPublication.input)}
            className="input"
            placeholder="e.g. Draft sent for review"
            value={title}
            onChange={(e) => {
              if (!activeSave.current) setTitle(e.target.value);
            }}
            disabled={busy}
            autoFocus
            data-testid="version-name"
          />
          {error && (
            <div className="text-sm text-danger wrap-anywhere" role="alert" data-testid="version-name-error">
              {error}
            </div>
          )}
          {busy && (
            <div className="text-sm text-ink-3" role="status">
              Closing this dialog does not cancel the version already being saved.
            </div>
          )}
          <div
            ref={bindNavigationElement(
              formPublication,
              formPublication.boundary,
            )}
            className="flex justify-end gap-2"
            onKeyDownCapture={onNavigationKeyDownCapture}
            onKeyDown={onNavigationKeyDown}
          >
            <button
              ref={bindNavigationElement(
                formPublication,
                formPublication.cancel,
              )}
              type="button"
              className="btn btn-ghost"
              onClick={() => setOpen(false)}
            >
              Cancel
            </button>
            <button
              ref={bindNavigationElement(
                formPublication,
                formPublication.save,
              )}
              type="submit"
              className="btn btn-primary"
              disabled={busy || !title.trim()}
              data-testid="version-name-submit"
            >
              Save version
            </button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
});

const SHORTCUTS: { group: string; items: [string, string][] }[] = [
  {
    group: "General",
    items: [
      ["Command palette", "Mod-Shift-P"],
      ["Command palette (no selection)", "Mod-K"],
      ["Document statistics and goal", "Mod-Shift-C"],
      ["Keyboard shortcuts", "Mod-/"],
      ["Stop following a collaborator", "Esc"],
      ["Toolbar: move between buttons / first, last", "← → / Home, End"],
    ],
  },
  {
    group: "Formatting",
    items: [
      ["Bold", "Mod-B"],
      ["Italic", "Mod-I"],
      ["Strikethrough", "Mod-Shift-X"],
      ["Inline code", "Mod-`"],
      ["Link (with a selection)", "Mod-K"],
      ["Heading 1–6 / Paragraph", "Mod-Alt-1…6 / 0"],
      ["Bulleted list", "Mod-Shift-8"],
      ["Numbered list", "Mod-Shift-7"],
      ["Task list", "Mod-Shift-9"],
      ["Quote", "Mod-Shift-."],
      ["Code block", "Mod-Alt-C"],
      ["Code block with a language (preview)", "```lang + Enter"],
      ["Toggle the task checkbox (preview)", "Mod-Enter"],
    ],
  },
  {
    group: "Editing",
    items: [
      ["Undo / Redo", "Mod-Z / Mod-Shift-Z"],
      ["Line break", "Shift-Enter"],
      ["Indent / outdent list item", "Tab / Shift-Tab"],
      ["Add comment", "Mod-Alt-M"],
      ["Find", "Mod-F"],
      ["Find and replace", findReplaceShortcut()],
      ["Next / previous match", "Enter / Shift-Enter"],
      ["Close find", "Esc"],
      ["Clear the selection / hide the table menu", "Esc"],
    ],
  },
  {
    group: "Tables",
    items: [
      ["Next / previous cell", "Tab / Shift-Tab"],
      ["Row below / above", "Mod-Alt-↓ / ↑"],
      ["Column right / left", "Mod-Alt-→ / ←"],
      ["Delete row", "Mod-Alt-⌫"],
      ["Delete column", "Mod-Alt-Shift-⌫"],
      ["New row from the last cell", "Enter / Tab"],
      ["Leave the table (paragraph below)", "Mod-Enter / ↓ from the last row"],
      ["Delete empty table", "⌫"],
    ],
  },
  {
    group: "Blocks",
    items: [
      ["Insert block menu", "/"],
      ["Leave a quote or list", "Enter on an empty line"],
      ["Leave a code block", "Mod-Enter / Shift-Enter, or Enter ×3"],
    ],
  },
  {
    group: "Code pane",
    items: [
      ["Wrap selection", "* _ ` ["],
      ["Code block", "``` or ~~~ at line start"],
      ["Indent / outdent list item", "Tab / Shift-Tab"],
    ],
  },
  {
    group: "Markdown shortcuts in the preview",
    items: [
      ["Heading", "# + space"],
      ["List", "- or 1. + space"],
      ["Task", "- [ ] + space"],
      ["Quote", "> + space"],
      ["Code block", "``` + language"],
      ["Divider", "---"],
    ],
  },
];

export const ShortcutsDialog = memo(function ShortcutsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="Keyboard shortcuts" wide>
        <div className="grid gap-6 sm:grid-cols-2">
          {SHORTCUTS.map((g) => (
            <div key={g.group}>
              <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-ink-3">{g.group}</div>
              <ul className="flex flex-col gap-1.5">
                {g.items.map(([label, keys]) => (
                  <li key={label} className="flex items-center justify-between gap-3 text-sm text-ink-2">
                    <span>{label}</span>
                    <Kbd>{shortcut(keys)}</Kbd>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
        <p className="mt-5 text-xs text-ink-3" data-testid="shortcuts-panels-note">
          Esc dismisses floating things — menus, the find bar, dialogs. The docked Comments and Version history panels close from the × in their header.
        </p>
      </DialogContent>
    </Dialog>
  );
});
