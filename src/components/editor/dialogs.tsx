"use client";

import { memo, useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
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

interface ImageDraft {
  visit: DialogActionVisit;
  open: boolean;
  src: string;
  alt: string;
  uploading: boolean;
  error: string | null;
  altRevision: number;
}

interface ImageUploadOwner {
  visit: DialogActionVisit;
  id: number;
  altRevision: number;
}

function imageDraft(visit: DialogActionVisit, open: boolean): ImageDraft {
  return { visit, open, src: "", alt: "", uploading: false, error: null, altRevision: 0 };
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
  const visit = useMemo<DialogActionVisit>(() => ({ onOpenChange, onSubmit, onUpload }), [onOpenChange, onSubmit, onUpload]);
  const activeVisit = useRef<DialogActionVisit | null>(null);
  const openRef = useRef(false);
  const [storedDraft, setDraft] = useState<ImageDraft>(() => imageDraft(visit, open));
  let draft = storedDraft;
  if (draft.visit !== visit || draft.open !== open) {
    draft = imageDraft(visit, open);
    setDraft(draft);
  }
  const { src, alt, uploading, error } = draft;
  const fileInput = useRef<HTMLInputElement>(null);
  const uploadSequence = useRef(0);
  const activeUpload = useRef<ImageUploadOwner | null>(null);
  useLayoutEffect(() => {
    activeVisit.current = visit;
    return () => {
      if (activeVisit.current === visit) activeVisit.current = null;
      if (activeUpload.current?.visit === visit) activeUpload.current = null;
    };
  }, [visit]);
  useLayoutEffect(() => {
    openRef.current = open;
    if (!open) {
      if (activeUpload.current?.visit === visit) activeUpload.current = null;
    }
  }, [open, visit]);
  const chooseFile = async (file: File | undefined) => {
    if (!file || !onUpload || activeVisit.current !== visit || !openRef.current || activeUpload.current !== null) return;
    const owner = { visit, id: ++uploadSequence.current, altRevision: draft.altRevision };
    activeUpload.current = owner;
    setDraft((current) => (current.visit === visit ? { ...current, error: null, uploading: true } : current));
    const isCurrent = () => activeVisit.current === visit && activeUpload.current === owner;
    try {
      const result = await onUpload(file);
      if (!isCurrent()) return;
      const resultUrl = result.url;
      const resultAlt = result.alt;
      setDraft((current) => {
        if (current.visit !== visit) return current;
        const nextAlt = current.altRevision !== owner.altRevision || current.alt ? current.alt : resultAlt || file.name.replace(/\.[a-z0-9]{2,5}$/i, "");
        return { ...current, src: resultUrl, alt: nextAlt };
      });
    } catch (e) {
      if (!isCurrent()) return;
      const message = apiErrorText(e, "Upload failed");
      setDraft((current) => (current.visit === visit ? { ...current, error: message } : current));
    } finally {
      if (isCurrent()) {
        activeUpload.current = null;
        setDraft((current) => (current.visit === visit ? { ...current, uploading: false } : current));
        if (fileInput.current) fileInput.current.value = "";
      }
    }
  };
  const setOpen = (nextOpen: boolean) => {
    if (activeVisit.current !== visit) return;
    if (!nextOpen && activeUpload.current?.visit === visit) activeUpload.current = null;
    onOpenChange(nextOpen);
  };
  const after = useAfterClose(visit, activeVisit);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent title="Insert image" description="Paste the address of an image or upload one. Alt text describes the image for people who can't see it." onClosed={after.onClosed}>
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (activeVisit.current !== visit || !openRef.current || activeUpload.current !== null || uploading || !src.trim()) return;
            const [s, a] = [src.trim(), alt.trim()];
            after.defer(() => onSubmit(s, a));
            setOpen(false);
          }}
        >
          <label className="flex flex-col gap-1 text-sm font-medium text-ink-2">
            Image URL
            <div className="flex gap-2">
              <input
                className="input flex-1"
                placeholder="https://…/image.png"
                value={src}
                onChange={(e) => {
                  if (activeVisit.current !== visit || !openRef.current) return;
                  const value = e.target.value;
                  setDraft((current) => (current.visit === visit ? { ...current, src: value } : current));
                }}
                autoFocus
                data-testid="image-url"
              />
              {onUpload && (
                <>
                  <button
                    type="button"
                    className="btn btn-outline shrink-0"
                    onClick={() => {
                      if (activeVisit.current === visit && openRef.current) fileInput.current?.click();
                    }}
                    disabled={uploading}
                    data-testid="image-upload"
                  >
                    {uploading ? "Uploading…" : "Upload…"}
                  </button>
                  <input
                    ref={fileInput}
                    type="file"
                    accept="image/png,image/jpeg,image/gif,image/webp,image/svg+xml"
                    className="hidden"
                    onChange={(e) => void chooseFile(e.target.files?.[0])}
                    data-testid="image-file"
                  />
                </>
              )}
            </div>
          </label>
          {error && (
            <div className="text-sm text-danger" role="alert" data-testid="image-upload-error">
              {error}
            </div>
          )}
          <label className="flex flex-col gap-1 text-sm font-medium text-ink-2">
            Alt text
            <input
              className="input"
              placeholder="Describe the image"
              value={alt}
              onChange={(e) => {
                if (activeVisit.current !== visit || !openRef.current) return;
                const value = e.target.value;
                setDraft((current) => (current.visit === visit ? { ...current, alt: value, altRevision: current.altRevision + 1 } : current));
              }}
              data-testid="image-alt"
            />
          </label>
          {src.trim() && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={src.trim()}
              alt=""
              className="max-h-40 rounded-lg border border-line object-contain"
              onError={(e) => {
                if (activeVisit.current === visit) (e.target as HTMLImageElement).style.display = "none";
              }}
            />
          )}
          <div className="flex justify-end gap-2 pt-1">
            <button type="button" className="btn btn-ghost" onClick={() => setOpen(false)}>
              Cancel
            </button>
            <button type="submit" className="btn btn-primary" disabled={uploading || !src.trim()} data-testid="image-submit">
              Insert
            </button>
          </div>
        </form>
      </DialogContent>
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
