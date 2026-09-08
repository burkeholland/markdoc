"use client";

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
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

class LinkElementOwner<T extends HTMLElement> {
  private current: T | null = null;

  constructor(private readonly retire: () => void) {}

  readonly element = () => this.current;
  readonly capture: React.RefCallback<T> = (element) => {
    if (this.current === element) return;
    this.current = element;
    this.retire();
    if (!element) return;
    return () => {
      if (this.current !== element) return;
      this.current = null;
      this.retire();
    };
  };
}

function createLinkElementOwners(authority: LinkPublicationAuthority, identity: object) {
  const retire = () => authority.retire(identity);
  const form = new LinkElementOwner<HTMLFormElement>(retire);
  const url = new LinkElementOwner<HTMLInputElement>(retire);
  const text = new LinkElementOwner<HTMLInputElement>(retire);
  const remove = new LinkElementOwner<HTMLButtonElement>(retire);
  const placeholder = new LinkElementOwner<HTMLSpanElement>(retire);
  const cancel = new LinkElementOwner<HTMLButtonElement>(retire);
  const apply = new LinkElementOwner<HTMLButtonElement>(retire);
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
  const owners = createLinkElementOwners(authority, identity);
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
const IMAGE_ERROR_CLASS = "text-sm text-danger";
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
const IMAGE_GET_PROTOTYPE_OF = Object.getPrototypeOf;
const IMAGE_OWN_KEYS = Reflect.ownKeys;

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
  readonly uploading: boolean;
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
  closer: object | null;
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
  readonly capturePublicSurface: (event: Event) => boolean;
  readonly publicSurfaceIsCanonical: (event: Event) => boolean;
  readonly stopPropagation: (event: Event) => void;
}

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
    this.#active = publication;
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
      !this.isCurrent(publication) ||
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
  #listener: ((event: Event) => void) | null = null;
  #submitForm: HTMLFormElement | null = null;
  #submitListener: ((event: Event) => void) | null = null;
  #submitProvenance: ImageSubmitProvenance | null = null;

  constructor(private readonly coordinator: ImagePublicationCoordinator) {}

  attach(bridge: HTMLDivElement) {
    const ownerDocument = bridge.ownerDocument;
    this.#bridge = bridge;
    if (this.#document === ownerDocument && this.#listener) return;
    this.release();
    this.#bridge = bridge;
    const listener = (event: Event) => {
      const publication = this.coordinator.active();
      const ownerWindow = ownerDocument.defaultView;
      if (
        !publication ||
        publication.isRetired() ||
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

  attachSubmit(provenance: ImageSubmitProvenance) {
    const form = provenance.form;
    this.#submitProvenance = provenance;
    if (this.#submitForm === form && this.#submitListener) return;
    this.releaseSubmit();
    this.#submitProvenance = provenance;
    const listener = (event: Event) => {
      const current = this.#submitProvenance;
      if (
        !current ||
        current.form !== form ||
        current.nativeEvent.publicSurfaceIsCanonical(event)
      ) {
        return;
      }
      current.nativeEvent.stopPropagation(event);
    };
    this.#submitForm = form;
    this.#submitListener = listener;
    form.addEventListener("submit", listener);
  }

  releaseWhenDetached(bridge: HTMLDivElement) {
    queueMicrotask(() => {
      if (this.#bridge === bridge && !bridge.isConnected) this.release();
    });
  }

  private releaseSubmit() {
    const form = this.#submitForm;
    const listener = this.#submitListener;
    this.#submitForm = null;
    this.#submitListener = null;
    this.#submitProvenance = null;
    if (form && listener) form.removeEventListener("submit", listener);
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
    shellCloser: object | null = null,
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
      shellClosesSynchronously: shellCloser !== null,
      closer: shellCloser,
    };
    this.#pending = owner;
    return owner;
  }

  cancel() {
    this.#pending = null;
  }

  authorize(authority: ImageAuthority, closer: object) {
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
    pending.closer = closer;
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
    previous.uploading === current.uploading &&
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
  return Object.freeze({
    isClean: drain,
    finishCommit: () => {
      if (!reactCommitSettling) return;
      drain();
      reactCommitSettling = false;
      radixContentSettling.clear();
      radixOverlaySettling.clear();
    },
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
      upload.disabled !== authority.uploading ||
      upload.matches(":disabled") !== authority.uploading ||
      upload.className !== IMAGE_UPLOAD_CLASS ||
      upload.dataset.testid !== "image-upload" ||
      upload.textContent !== (authority.uploading ? "Uploading…" : "Upload…") ||
      file.type !== "file" ||
      file.form !== form ||
      file.disabled ||
      file.accept !== IMAGE_FILE_ACCEPT ||
      file.className !== "hidden" ||
      file.dataset.testid !== "image-file" ||
      (changing !== "file" &&
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

function captureImageNativeSubmitIntrinsics(
  ownerWindow: Window & typeof globalThis,
): ImageNativeSubmitIntrinsics | null {
  const EventConstructor = ownerWindow.Event;
  const SubmitEventConstructor = ownerWindow.SubmitEvent;
  const eventPrototype = EventConstructor.prototype;
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
  const composedPath = getOwnPropertyDescriptor(
    eventPrototype,
    "composedPath",
  )?.value;
  const preventDefault = getOwnPropertyDescriptor(
    eventPrototype,
    "preventDefault",
  )?.value;
  const stopPropagation = getOwnPropertyDescriptor(
    eventPrototype,
    "stopPropagation",
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
    typeof composedPath !== "function" ||
    typeof preventDefault !== "function" ||
    typeof stopPropagation !== "function" ||
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
  let publicSurface:
    | {
        readonly event: Event;
        readonly ownProperties: readonly ImageNativePropertySnapshot[];
        readonly prototypeChain: readonly ImageNativePrototypeSnapshot[];
      }
    | null = null;
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
    preventDefault: (event: Event) => {
      IMAGE_APPLY(preventDefault, event, []);
      return defaultPrevented(event);
    },
    capturePublicSurface: (event: Event) => {
      publicSurface = null;
      const prototypeChain = canonicalChain(event);
      const ownProperties = captureProperties(event);
      if (
        !prototypeChain ||
        !ownProperties ||
        !prototypeChainMatches(event, prototypeChain)
      ) {
        return false;
      }
      publicSurface = Object.freeze({
        event,
        ownProperties,
        prototypeChain,
      });
      return true;
    },
    publicSurfaceIsCanonical: (event: Event) => {
      const captured = publicSurface;
      return (
        captured?.event === event &&
        prototypeChainMatches(event, captured.prototypeChain) &&
        propertiesMatch(event, captured.ownProperties)
      );
    },
    stopPropagation: (event: Event) => {
      IMAGE_APPLY(stopPropagation, event, []);
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

function imageExactNativeSubmit(
  event: React.FormEvent<HTMLFormElement>,
  provenance: ImageSubmitProvenance,
  expectedDefaultPrevented: boolean,
) {
  const { form, insert, content } = provenance;
  const nativeEvent = event.nativeEvent;
  const intrinsics = provenance.nativeEvent;
  const wrapper = event as React.FormEvent<HTMLFormElement> & {
    readonly _reactName?: unknown;
    readonly isDefaultPrevented?: unknown;
    readonly isPropagationStopped?: unknown;
    readonly persist?: unknown;
  };
  if (!intrinsics.isEvent(nativeEvent)) return null;
  const path = intrinsics.composedPath(nativeEvent);
  if (
    intrinsics.eventPhase(nativeEvent) === 0 ||
    intrinsics.type(nativeEvent) !== "submit" ||
    intrinsics.defaultPrevented(nativeEvent) !== expectedDefaultPrevented ||
    !intrinsics.bubbles(nativeEvent) ||
    !intrinsics.cancelable(nativeEvent) ||
    intrinsics.target(nativeEvent) !== form ||
    !IMAGE_APPLY(IMAGE_ARRAY_INCLUDES, path, [form]) ||
    !IMAGE_APPLY(IMAGE_ARRAY_INCLUDES, path, [content]) ||
    !IMAGE_APPLY(IMAGE_ARRAY_INCLUDES, path, [provenance.ownerDocument]) ||
    event.currentTarget !== form ||
    wrapper._reactName !== "onSubmit" ||
    typeof wrapper.isDefaultPrevented !== "function" ||
    typeof wrapper.isPropagationStopped !== "function" ||
    typeof wrapper.persist !== "function" ||
    !form.isConnected ||
    form.ownerDocument !== provenance.ownerDocument ||
    insert.form !== form ||
    !imageSnapshotContains(provenance.contentTree, form)
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

function imageSubmitProvenance(
  authority: ImageAuthority,
  controls: ImageControls,
  revision: number,
): ImageSubmitProvenance | null {
  const form = controls.form.owner.element();
  const insert = controls.insert.owner.element();
  const content = form?.parentElement;
  const ownerWindow = content?.ownerDocument.defaultView;
  const nativeEvent = ownerWindow
    ? captureImageNativeSubmitIntrinsics(ownerWindow)
    : null;
  if (
    !authority.open ||
    !ownerWindow ||
    !nativeEvent ||
    !(form instanceof ownerWindow.HTMLFormElement) ||
    !(insert instanceof ownerWindow.HTMLButtonElement) ||
    !(content instanceof ownerWindow.HTMLDivElement) ||
    !form.isConnected ||
    form.parentElement !== content ||
    !form.contains(insert)
  ) {
    return null;
  }
  return Object.freeze({
    authority,
    ownerDocument: content.ownerDocument,
    form,
    insert,
    content,
    contentTree: imageSnapshotDom(content),
    revision,
    nativeEvent,
  });
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
        (!includeConnectivity || entry.element.isConnected),
    );
  const currentShapeMatches = (
    changing: "url" | "alt" | "file" | null = null,
  ) => {
    if (
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
        ? coordinator.acceptsSuccessorOf(publication)
        : coordinator.isCurrent(publication))
    );
  };
  const committedDomMatches = (
    changing: "url" | "alt" | "file" | null = null,
  ) =>
    dom.content === contentTree.node &&
    dom.overlay === overlayTree.node &&
    imagePlacementMatches(dom.bridge, dom.overlay, dom.content, placement) &&
    imageDomMatches(bridgeTree) &&
    imageDomMatches(contentTree) &&
    imageDomMatches(overlayTree) &&
    Boolean(resolveImageDom(authority, controls, changing, fileFacts));
  const retire = (reason: Retirement) => {
    if (retired) return false;
    retired = true;
    retirement = reason;
    onRetire();
    coordinator.retire(publication);
    queueMicrotask(() => {
      if (coordinator.replay()?.source !== publication) {
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
    isRetired: () => retired,
    publishedDomMatches: (changing: ImageChangingControl = null) => {
      const exact = currentDomMatches(changing);
      if (!exact) retire("element");
      return exact;
    },
  });
  const refsHaveExactReplay = () =>
    !invalidReplay &&
    replayRefs.length > 0 &&
    replayRefs.every(
      (entry) =>
        entry.detached &&
        entry.reattached &&
        entry.owner.element() === entry.element &&
        entry.element.isConnected,
    );
  const partialReplayIsCurrent = () =>
    retired &&
    retirement === "element" &&
    established &&
    !layoutRetired &&
    !invalidReplay &&
    replayRefs.some((entry) => entry.detached && entry.reattached) &&
    replayRefs.every(
      (entry) =>
        entry.owner.element() === entry.element &&
        entry.element.isConnected,
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
    noteRef: (
      owner: ImageElementOwnerView,
      element: Element | null,
      previous: Element | null,
    ) => {
      if (!established) return;
      const proof = replayRefs.find((entry) => entry.owner === owner);
      if (!proof) return;
      if (
        element === null &&
        previous === proof.element &&
        proof.element.isConnected
      ) {
        proof.detached = true;
        proof.reattached = false;
      } else if (
        element === proof.element &&
        previous === null &&
        proof.detached &&
        proof.element.isConnected
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
  resumeUploadSettlement: () => void,
  abandonDeferredUpload: () => boolean,
  afterClose: ImageAfterCloseAuthority,
  completeClose: (closer: object) => void,
): ImagePresentation {
  let currentRuntime: ImagePublicationRuntime | null = null;
  let lastRuntime: ImagePublicationRuntime | null = null;
  let submitProvenance: ImageSubmitProvenance | null = null;
  let capturedSubmit:
    | {
        readonly nativeEvent: Event;
        readonly provenance: ImageSubmitProvenance;
      }
    | null = null;
  let submitRevision = 0;
  let successorRequested = false;
  let partialRecoveryQueued = false;
  let portalSettlement = 0;
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
  const scheduleCommitFinish = (runtime: ImagePublicationRuntime | null) => {
    if (!runtime) return;
    const settlement = ++portalSettlement;
    const ownerWindow = runtime.publication.ownerDocument.defaultView;
    if (ownerWindow) {
      ownerWindow.setTimeout(() => {
        if (settlement === portalSettlement) runtime.finishCommit();
      }, 0);
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
      authority.visit.onOpenChange === authority.onOpenChange &&
      authority.visit.onSubmit === authority.onSubmit &&
      authority.visit.onUpload === authority.onUpload &&
      authority.uploading === (authority.upload !== null) &&
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
      !coordinator.isCurrent(publication) ||
      publication.isRetired() ||
      !publication.publishedDomMatches(changing)
    ) {
      return false;
    }
    return (
      factsAreCurrent() &&
      publication.authority === authority &&
      coordinator.isCurrent(publication) &&
      !publication.isRetired()
    );
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
    );
    if (nextSubmitProvenance) {
      submitProvenance = nextSubmitProvenance;
      dismissalListener.attachSubmit(nextSubmitProvenance);
    }
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
      factsAreCurrent,
      authorizeNativeDismissal,
      expectedOwners(),
      () => {
        clearDismissal();
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
    );
    if (replacementSubmitProvenance) {
      submitProvenance = replacementSubmitProvenance;
      dismissalListener.attachSubmit(replacementSubmitProvenance);
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
    resumeUploadSettlement();
    return runtime.retireForLayout;
  };
  const currentPublication = (
    changing: "url" | "alt" | "file" | null = null,
  ) => {
    const publication = coordinator.active();
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
      ownedForm.isConnected &&
      ownedForm.ownerDocument === provenance.ownerDocument &&
      ownedForm.parentElement === content &&
      ownedInsert.form === ownedForm &&
      ownedForm.contains(ownedInsert) &&
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
    setDraft(
      nextImageDraft(authority.draft, {
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
    setDraft(
      nextImageDraft(authority.draft, {
        alt: value,
        altRevision: authority.altRevision + 1,
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
      authority.uploading ||
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
      authority.uploading ||
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
    setDraft(
      nextImageDraft(authority.draft, { previewFailed: true }),
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
        publication.dom.overlay === publication.dom.content
          ? closeToken
          : null,
      );
    }
    else afterClose.cancel();
    publication.retire();
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
  const onFormSubmitCapture = (
    event: React.FormEvent<HTMLFormElement>,
  ) => {
    capturedSubmit = null;
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
    const nativeEvent = imageExactNativeSubmit(event, provenance, false);
    if (!nativeEvent || !provenance.nativeEvent.preventDefault(nativeEvent)) {
      return;
    }
    if (provenance.nativeEvent.capturePublicSurface(nativeEvent)) {
      capturedSubmit = { nativeEvent, provenance };
    }
  };
  const onFormSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    const captured = capturedSubmit;
    capturedSubmit = null;
    const committed = lastRuntime?.publication ?? null;
    const provenance = submitProvenance;
    const ownedForm = form.owner.element();
    if (
      !captured ||
      !provenance ||
      !ownedForm ||
      captured.provenance !== provenance ||
      provenance.authority !== authority ||
      provenance.form !== ownedForm ||
      event.currentTarget !== ownedForm
    ) {
      return;
    }
    const nativeEvent = imageExactNativeSubmit(event, provenance, true);
    if (
      !nativeEvent ||
      captured.nativeEvent !== nativeEvent ||
      !provenance.nativeEvent.publicSurfaceIsCanonical(nativeEvent)
    ) {
      return;
    }
    if (!submitSuppressionIsCurrent(provenance)) return;
    const publication = currentPublication(
      authority.uploading ? "file" : null,
    );
    if (
      !publication ||
      !committed ||
      publication !== committed ||
      publication.dom.form !== ownedForm ||
      publication.dom.insert !== insert.owner.element() ||
      authority.submitDisabled ||
      authority.uploading ||
      activeUpload() !== null ||
      !authority.normalizedSrc
    ) {
      return;
    }
    const claimed = claim(
      publication,
      form,
      insert.action,
      event,
      nativeEvent,
    );
    if (!claimed) return;
    closeCurrent(publication, true);
  };
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
    afterClose.cancel();
    proof.publication.retire();
    authority.onOpenChange(false);
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
      abandonUploadOwner(lease.owner, lease.publication);
    },
    [abandonUploadOwner],
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
      activeUpload.set(null);
      setDraft((current) => {
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
        });
      });
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
        uploading: draft.upload !== null,
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
        resumeUploadSettlement,
        abandonDeferredUpload,
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
    else afterClose.authorize(current, presentation.closeToken);
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
                        disabled={current.uploading}
                        data-testid="image-upload"
                      >
                        {current.uploading ? "Uploading…" : "Upload…"}
                      </button>
                      <input
                        ref={captureFile}
                        type="file"
                        accept={IMAGE_FILE_ACCEPT}
                        className="hidden"
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

interface TableCellOwner {
  visit: DialogActionVisit;
  element: HTMLButtonElement;
}

function tableDraft(visit: DialogActionVisit, open: boolean): TableDraft {
  return { visit, open, focused: { row: 0, col: 0 }, hover: null };
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
  const cells = useRef<(TableCellOwner | null)[]>([]);
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
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (activeVisit.current !== visit || !openRef.current) return;
    const next = gridCell(e.key, focused, GRID_ROWS, GRID_COLS, { ctrl: e.ctrlKey || e.metaKey });
    if (!next) return;
    e.preventDefault();
    setDraft((current) => (current.visit === visit ? { ...current, focused: next, hover: null } : current));
    const cell = cells.current[next.row * GRID_COLS + next.col];
    if (cell?.visit === visit) cell.element.focus();
  };
  const setOpen = (nextOpen: boolean) => {
    if (activeVisit.current === visit) onOpenChange(nextOpen);
  };
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent title="Insert table" description="Pick a size. The first row becomes the header." onClosed={after.onClosed}>
        <div className="flex flex-col items-center gap-3">
          <div
            className="flex flex-col gap-1"
            role="grid"
            aria-label="Table size"
            onMouseLeave={() => {
              if (activeVisit.current !== visit || !openRef.current) return;
              setDraft((current) => (current.visit === visit ? { ...current, hover: null } : current));
            }}
            onKeyDown={onKeyDown}
            data-testid="table-grid"
          >
            {Array.from({ length: GRID_ROWS }, (_, r) => (
              <div key={r} role="row" className="flex gap-1">
                {Array.from({ length: GRID_COLS }, (_, c) => {
                  const isFocused = focused.row === r && focused.col === c;
                  return (
                    <div key={c} role="gridcell">
                      <button
                        ref={(el) => {
                          const index = r * GRID_COLS + c;
                          if (el) cells.current[index] = { visit, element: el };
                          else if (cells.current[index]?.visit === visit) cells.current[index] = null;
                        }}
                        type="button"
                        tabIndex={isFocused ? 0 : -1}
                        className={`block h-6 w-6 rounded border ${r < shown.row + 1 && c < shown.col + 1 ? "border-accent bg-accent-soft" : "border-line-2 bg-surface"}`}
                        onMouseEnter={() => {
                          if (activeVisit.current !== visit || !openRef.current) return;
                          setDraft((current) => (current.visit === visit ? { ...current, hover: { row: r, col: c } } : current));
                        }}
                        onFocus={() => {
                          if (activeVisit.current !== visit || !openRef.current) return;
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
  useLayoutEffect(() => {
    if (open) {
      activeVisit.current = visit;
      activeSave.current = null;
      setTitle("");
      setError(null);
      setBusy(false);
    } else if (activeVisit.current === visit) {
      activeVisit.current = null;
      activeSave.current = null;
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
    }
    onOpenChange(visit, nextOpen);
  };
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent title="Name this version" description="Named versions stay easy to find in the history.">
        <form
          className="flex flex-col gap-3"
          onSubmit={async (e) => {
            e.preventDefault();
            const currentVisit = activeVisit.current;
            const submittedTitle = title.trim();
            if (!currentVisit || activeSave.current || !submittedTitle) return;
            const owner = {
              visit: currentVisit,
              editor: currentVisit.editor,
              documentId: currentVisit.documentId,
              operationId: nextOperationId(),
              title: submittedTitle,
            };
            activeSave.current = owner;
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
                setBusy(false);
              }
            }
          }}
        >
          <input
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
            <div className="text-sm text-danger" role="alert" data-testid="version-name-error">
              {error}
            </div>
          )}
          {busy && (
            <div className="text-sm text-ink-3" role="status">
              Closing this dialog does not cancel the version already being saved.
            </div>
          )}
          <div className="flex justify-end gap-2">
            <button type="button" className="btn btn-ghost" onClick={() => setOpen(false)}>
              Cancel
            </button>
            <button type="submit" className="btn btn-primary" disabled={busy || !title.trim()} data-testid="version-name-submit">
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
