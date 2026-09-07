"use client";

import { memo, useLayoutEffect, useState, type FocusEvent, type KeyboardEvent, type MouseEvent } from "react";
import {
  Bold,
  Italic,
  Link as LinkIcon,
  Code,
  List,
  ListOrdered,
  ListChecks,
  Quote,
  Image as ImageIcon,
  Table,
  Minus,
  Undo2,
  Redo2,
  ChevronDown,
  Heading,
  Strikethrough,
  SquareCode,
  MessageSquarePlus,
} from "lucide-react";
import type { CollabSession } from "@/editor/collab/session";
import type { EditorActions, FormatState } from "./actions";
import { Menu, MenuContent, MenuRadioGroup, MenuRadioItem, MenuTrigger, Tip } from "@/components/ui/primitives";
import { cn, shortcut } from "@/lib/utils";
import { rovingIndex } from "@/lib/a11y";
import { shallowEqual, useSessionValue } from "./use-session";
import { TOOLBAR_BOX } from "./chrome-classes";

type ToolbarPermission = "edit" | "undo" | "redo" | "comment" | "current";
type HeadingLevel = 0 | 1 | 2 | 3 | 4 | 5 | 6;

type ToolbarControl<T extends HTMLElement = HTMLButtonElement> = Readonly<{
  id: string;
  enabled: boolean;
  rootButton: boolean;
  element: () => T | null;
  capture: (element: T | null) => void;
  onClick: () => void;
  onMouseDown: (event: MouseEvent<T>) => void;
}>;

type OwnedToolbarControl = Readonly<{
  id: string;
  enabled: boolean;
  rootButton: boolean;
  element: () => HTMLElement | null;
}>;

type ToolbarAction = Readonly<{
  token: symbol;
  control: OwnedToolbarControl;
  permission: ToolbarPermission;
  requireEnabled: boolean;
  run: () => void;
}>;

type ToolbarButtons = Readonly<{
  heading: ToolbarControl;
  bold: ToolbarControl;
  italic: ToolbarControl;
  strike: ToolbarControl;
  link: ToolbarControl;
  code: ToolbarControl;
  codeBlock: ToolbarControl;
  bullet: ToolbarControl;
  ordered: ToolbarControl;
  task: ToolbarControl;
  quote: ToolbarControl;
  image: ToolbarControl;
  table: ToolbarControl;
  rule: ToolbarControl;
  undo: ToolbarControl;
  redo: ToolbarControl;
  comment: ToolbarControl;
}>;

type ToolbarPublication = Readonly<{
  captureRoot: (element: HTMLDivElement | null) => void;
  buttons: ToolbarButtons;
  headingItems: ReadonlyArray<Readonly<{ level: HeadingLevel; control: ToolbarControl<HTMLDivElement> }>>;
  establish: () => void;
  retire: () => void;
  onFocus: (event: FocusEvent<HTMLDivElement>) => void;
  onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
  onHeadingChange: (value: string) => void;
  onHeadingClose: (event: { preventDefault: () => void }) => void;
}>;

class CurrentCell<T> {
  constructor(public current: T) {}
}

class PublicationIdentity {
  current?: ToolbarPublication;
}

class ElementOwner<T extends HTMLElement> {
  private current: T | null = null;
  readonly element = () => this.current;
  readonly capture = (element: T | null) => {
    this.current = element;
  };
}

function createToolbarPublication({
  mount,
  active,
  last,
  session,
  actions,
  format,
  canEdit,
  canUndo,
  canRedo,
  canComment,
  onComment,
  onImage,
  onTable,
}: {
  mount: object;
  active: CurrentCell<ToolbarPublication | null>;
  last: CurrentCell<HTMLButtonElement | null>;
  session: CollabSession;
  actions: EditorActions;
  format: FormatState;
  canEdit: boolean;
  canUndo: boolean;
  canRedo: boolean;
  canComment: boolean;
  onComment: () => void;
  onImage: () => void;
  onTable: () => void;
}): ToolbarPublication {
  const authority = Object.freeze({
    mount,
    session,
    actions,
    format,
    formatValues: Object.freeze({
      strong: format.strong,
      em: format.em,
      code: format.code,
      strike: format.strike,
      link: format.link,
      heading: format.heading,
      bullet: format.bullet,
      ordered: format.ordered,
      task: format.task,
      quote: format.quote,
      codeBlock: format.codeBlock,
      hasSelection: format.hasSelection,
    }),
    canEdit,
    canUndo,
    canRedo,
    canComment,
    onComment,
    onImage,
    onTable,
  });
  const root = new ElementOwner<HTMLDivElement>();
  const claimed = new Set<symbol>();
  const mouseEvents = new WeakSet<object>();
  const closeEvents = new WeakSet<object>();
  const keyEvents = new WeakSet<object>();
  const identity = new PublicationIdentity();

  const authorityOwned = () => {
    const values = authority.formatValues;
    const current = authority.format;
    return (
      authority.session.canEdit === authority.canEdit &&
      authority.session.canUndo === authority.canUndo &&
      authority.session.canRedo === authority.canRedo &&
      authority.session.canComment === authority.canComment &&
      current.strong === values.strong &&
      current.em === values.em &&
      current.code === values.code &&
      current.strike === values.strike &&
      current.link === values.link &&
      current.heading === values.heading &&
      current.bullet === values.bullet &&
      current.ordered === values.ordered &&
      current.task === values.task &&
      current.quote === values.quote &&
      current.codeBlock === values.codeBlock &&
      current.hasSelection === values.hasSelection
    );
  };
  const permissionOwned = (permission: ToolbarPermission) => {
    switch (permission) {
      case "edit":
        return authority.canEdit && authority.session.canEdit;
      case "undo":
        return authority.canEdit && authority.canUndo && authority.session.canEdit && authority.session.canUndo;
      case "redo":
        return authority.canEdit && authority.canRedo && authority.session.canEdit && authority.session.canRedo;
      case "comment":
        return authority.canComment && authority.session.canComment;
      case "current":
        return true;
    }
  };
  const ownsControl = (control: OwnedToolbarControl, requireEnabled = true) => {
    if (active.current !== identity.current || !authorityOwned()) return false;
    const ownedRoot = root.element();
    const element = control.element();
    if (!ownedRoot || !element) return false;
    if (!ownedRoot.isConnected || !element.isConnected) return false;
    if (control.rootButton && !ownedRoot.contains(element)) return false;
    if (
      requireEnabled &&
      (!control.enabled ||
        (element instanceof HTMLButtonElement && element.disabled) ||
        element.getAttribute("aria-disabled") === "true")
    ) return false;
    return true;
  };
  const claim = (action: ToolbarAction) => {
    if (!ownsControl(action.control, action.requireEnabled) || !permissionOwned(action.permission) || claimed.has(action.token)) {
      return false;
    }
    claimed.add(action.token);
    return true;
  };
  const activate = (action: ToolbarAction) => {
    if (!claim(action)) return;
    action.run();
  };
  const preventMouseDown = (control: OwnedToolbarControl, event: { preventDefault: () => void }) => {
    if (!ownsControl(control) || mouseEvents.has(event)) return;
    mouseEvents.add(event);
    event.preventDefault();
  };

  const makeControl = <T extends HTMLElement = HTMLButtonElement>({
    id,
    enabled,
    rootButton = true,
    permission = "current",
    requireEnabled = true,
    run,
  }: {
    id: string;
    enabled: boolean;
    rootButton?: boolean;
    permission?: ToolbarPermission;
    requireEnabled?: boolean;
    run?: () => void;
  }): ToolbarControl<T> => {
    const owner = new ElementOwner<T>();
    let action: ToolbarAction | null = null;
    const control: ToolbarControl<T> = Object.freeze({
      id,
      enabled,
      rootButton,
      element: owner.element,
      capture: owner.capture,
      onClick: () => {
        if (action) activate(action);
      },
      onMouseDown: (event) => preventMouseDown(control, event),
    });
    if (run) {
      action = Object.freeze({
        token: Symbol(id),
        control,
        permission,
        requireEnabled,
        run,
      });
    }
    return control;
  };

  const toggleMark = actions.toggleMark;
  const openLinkDialog = actions.openLinkDialog;
  const toggleCodeBlock = actions.toggleCodeBlock;
  const toggleList = actions.toggleList;
  const toggleQuote = actions.toggleQuote;
  const horizontalRule = actions.horizontalRule;
  const undo = actions.undo;
  const redo = actions.redo;
  const setHeading = actions.setHeading;
  const focus = actions.focus;
  const buttons: ToolbarButtons = Object.freeze({
    heading: makeControl({ id: "heading", enabled: canEdit }),
    bold: makeControl({ id: "bold", enabled: canEdit, permission: "edit", run: () => toggleMark.call(actions, "strong") }),
    italic: makeControl({ id: "italic", enabled: canEdit, permission: "edit", run: () => toggleMark.call(actions, "em") }),
    strike: makeControl({ id: "strike", enabled: canEdit, permission: "edit", run: () => toggleMark.call(actions, "strike") }),
    link: makeControl({ id: "link", enabled: canEdit, permission: "edit", run: () => openLinkDialog.call(actions) }),
    code: makeControl({ id: "code", enabled: canEdit, permission: "edit", run: () => toggleMark.call(actions, "code") }),
    codeBlock: makeControl({ id: "code-block", enabled: canEdit, permission: "edit", run: () => toggleCodeBlock.call(actions) }),
    bullet: makeControl({ id: "bullet", enabled: canEdit, permission: "edit", run: () => toggleList.call(actions, "bullet") }),
    ordered: makeControl({ id: "ordered", enabled: canEdit, permission: "edit", run: () => toggleList.call(actions, "ordered") }),
    task: makeControl({ id: "task", enabled: canEdit, permission: "edit", run: () => toggleList.call(actions, "task") }),
    quote: makeControl({ id: "quote", enabled: canEdit, permission: "edit", run: () => toggleQuote.call(actions) }),
    image: makeControl({ id: "image", enabled: canEdit, permission: "edit", run: authority.onImage }),
    table: makeControl({ id: "table", enabled: canEdit, permission: "edit", run: authority.onTable }),
    rule: makeControl({ id: "rule", enabled: canEdit, permission: "edit", run: () => horizontalRule.call(actions) }),
    undo: makeControl({ id: "undo", enabled: canEdit && canUndo, permission: "undo", run: () => undo.call(actions) }),
    redo: makeControl({ id: "redo", enabled: canEdit && canRedo, permission: "redo", run: () => redo.call(actions) }),
    comment: makeControl({ id: "comment", enabled: canComment, permission: "comment", run: authority.onComment }),
  });
  const headingItems = Object.freeze(
    ([0, 1, 2, 3, 4, 5, 6] as const).map((level) => Object.freeze({
      level,
      control: makeControl<HTMLDivElement>({
        id: `heading-${level}`,
        enabled: canEdit,
        rootButton: false,
        permission: "edit",
        run: () => setHeading.call(actions, level),
      }),
    })),
  );
  const buttonOrder = Object.freeze([
    buttons.heading,
    buttons.bold,
    buttons.italic,
    buttons.strike,
    buttons.link,
    buttons.code,
    buttons.codeBlock,
    buttons.bullet,
    buttons.ordered,
    buttons.task,
    buttons.quote,
    buttons.image,
    buttons.table,
    buttons.rule,
    buttons.undo,
    buttons.redo,
    ...(canComment ? [buttons.comment] : []),
  ]);
  const closeAction: ToolbarAction = Object.freeze({
    token: Symbol("heading-close"),
    control: buttons.heading,
    permission: "current",
    requireEnabled: false,
    run: () => focus.call(actions),
  });

  const ownedButtons = () => {
    const ownedRoot = root.element();
    if (active.current !== identity.current || !authorityOwned() || !ownedRoot || !ownedRoot.isConnected) return null;
    const owned: Array<{ control: ToolbarControl; element: HTMLButtonElement }> = [];
    for (const control of buttonOrder) {
      const element = control.element();
      if (!element || !element.isConnected || !ownedRoot.contains(element)) return null;
      owned.push({ control, element });
    }
    return owned;
  };
  const enabledButtons = () => {
    const owned = ownedButtons();
    return owned?.filter(({ control, element }) => control.enabled && !element.disabled) ?? [];
  };
  const syncTabStops = () => {
    if (active.current !== identity.current) return;
    const owned = ownedButtons();
    if (!owned) return;
    const enabled = owned.filter(({ control, element }) => control.enabled && !element.disabled);
    const lastButton = last.current;
    const stop = enabled.find(({ element }) => element === lastButton)?.element ?? enabled[0]?.element;
    for (const { element } of owned) {
      element.tabIndex = element === stop ? 0 : -1;
    }
  };
  const establish = () => {
    const ownedRoot = root.element();
    if (!authorityOwned() || !ownedRoot || !ownedRoot.isConnected || buttonOrder.some((control) => {
      const element = control.element();
      return !element || !element.isConnected || !ownedRoot.contains(element);
    })) return;
    const publication = identity.current;
    if (!publication) return;
    const previous = active.current;
    if (previous && previous !== publication) previous.retire();
    active.current = publication;
    syncTabStops();
  };
  const retire = () => {
    if (active.current === identity.current) active.current = null;
  };
  const onFocus = (event: FocusEvent<HTMLDivElement>) => {
    const ownedRoot = root.element();
    if (active.current !== identity.current || !ownedRoot || event.currentTarget !== ownedRoot) return;
    const button = event.target instanceof Element ? event.target.closest("button") : null;
    const owned = buttonOrder.find((control) => control.element() === button);
    if (!owned || !ownsControl(owned)) return;
    last.current = button as HTMLButtonElement;
    syncTabStops();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const ownedRoot = root.element();
    if (
      active.current !== identity.current ||
      !ownedRoot ||
      event.currentTarget !== ownedRoot ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey
    ) return;
    const items = enabledButtons();
    const current = items.findIndex(({ element }) => element === ownedRoot.ownerDocument.activeElement);
    const next = rovingIndex(event.key, current, items.length, { orientation: "horizontal", wrap: true });
    if (next < 0 || keyEvents.has(event)) return;
    keyEvents.add(event);
    event.preventDefault();
    items[next]?.element.focus();
  };
  const onHeadingChange = (value: string) => {
    const item = headingItems.find(({ level }) => String(level) === value);
    if (!item || !ownsControl(item.control)) return;
    item.control.onClick();
  };
  const onHeadingClose = (event: { preventDefault: () => void }) => {
    if (closeEvents.has(event) || !claim(closeAction)) return;
    closeEvents.add(event);
    event.preventDefault();
    closeAction.run();
  };

  const publication = Object.freeze({
    captureRoot: root.capture,
    buttons,
    headingItems,
    establish,
    retire,
    onFocus,
    onKeyDown,
    onHeadingChange,
    onHeadingClose,
  });
  identity.current = publication;
  return publication;
}

function ToolButton({
  label,
  keys,
  active,
  disabled,
  control,
  children,
  testId,
}: {
  label: string;
  keys?: string;
  active?: boolean;
  disabled?: boolean;
  control: ToolbarControl;
  children: React.ReactNode;
  testId?: string;
}) {
  const { capture, onMouseDown, onClick } = control;
  return (
    <Tip label={label} shortcut={keys ? shortcut(keys) : undefined}>
      <button
        ref={capture}
        type="button"
        className="icon-btn"
        data-active={active ? "true" : undefined}
        disabled={disabled}
        onMouseDown={onMouseDown}
        onClick={onClick}
        aria-label={label}
        aria-pressed={active}
        data-testid={testId}
      >
        {children}
      </button>
    </Tip>
  );
}

function Divider() {
  return <span className="tb-divider mx-1.5 h-6 w-px bg-line" aria-hidden />;
}

/** A run of related buttons. Plain inline flow today; the brand candidates draw it as a hairline pill. */
function Group({ children }: { children: React.ReactNode }) {
  return <span className="tb-group flex items-center gap-0.5">{children}</span>;
}

const HEADINGS = [
  { value: "0", label: "Paragraph", className: "text-[15px]" },
  { value: "1", label: "Heading 1", className: "text-[22px] font-bold" },
  { value: "2", label: "Heading 2", className: "text-[19px] font-bold" },
  { value: "3", label: "Heading 3", className: "text-[17px] font-semibold" },
  { value: "4", label: "Heading 4", className: "text-[15px] font-semibold" },
  { value: "5", label: "Heading 5", className: "text-[14px] font-semibold" },
  { value: "6", label: "Heading 6", className: "text-[13px] font-semibold" },
];

export const Toolbar = memo(function Toolbar({
  session,
  actions,
  format,
  onComment,
  onImage,
  onTable,
}: {
  session: CollabSession;
  actions: EditorActions;
  format: FormatState;
  onComment: () => void;
  onImage: () => void;
  onTable: () => void;
}) {
  const { canEdit, canUndo, canRedo, canComment } = useSessionValue(
    session,
    (s) => ({
      canEdit: s.canEdit,
      canUndo: s.canUndo,
      canRedo: s.canRedo,
      canComment: s.canComment,
    }),
    shallowEqual,
  );
  const dis = !canEdit;
  const [mount] = useState(() => Object.freeze({}));
  const [active] = useState(() => new CurrentCell<ToolbarPublication | null>(null));
  const [last] = useState(() => new CurrentCell<HTMLButtonElement | null>(null));
  const publication = createToolbarPublication({
    mount,
    active,
    last,
    session,
    actions,
    format,
    canEdit,
    canUndo,
    canRedo,
    canComment,
    onComment,
    onImage,
    onTable,
  });
  useLayoutEffect(() => {
    publication.establish();
    return publication.retire;
  }, [publication]);
  const {
    captureRoot,
    onFocus: onToolbarFocus,
    onKeyDown: onToolbarKeyDown,
    onHeadingChange,
    onHeadingClose,
    headingItems,
    buttons,
  } = publication;
  const {
    heading,
    bold,
    italic,
    strike,
    link,
    code,
    codeBlock,
    bullet,
    ordered,
    task,
    quote,
    image,
    table,
    rule,
    undo,
    redo,
    comment,
  } = buttons;
  const { capture: captureHeading, onMouseDown: onHeadingMouseDown } = heading;
  const {
    capture: captureComment,
    onMouseDown: onCommentMouseDown,
    onClick: onCommentClick,
  } = comment;

  return (
    <div
      ref={captureRoot}
      className={TOOLBAR_BOX}
      role="toolbar"
      aria-label="Formatting"
      aria-orientation="horizontal"
      data-testid="toolbar"
      onFocus={onToolbarFocus}
      onKeyDown={onToolbarKeyDown}
    >
      <Group>
        <Menu>
          <MenuTrigger asChild>
            <button
              ref={captureHeading}
              type="button"
              className="icon-btn w-auto gap-1 px-2.5 font-semibold"
              disabled={dis}
              onMouseDown={onHeadingMouseDown}
              aria-label="Text style"
              data-testid="heading-menu"
            >
              <Heading size={18} />
              {format.heading > 0 && <span className="text-xs text-accent">{format.heading}</span>}
              <ChevronDown size={14} className="text-ink-4" />
            </button>
          </MenuTrigger>
          <MenuContent
            align="start"
            className="w-56"
            // Radix hands focus back to the trigger when the menu closes; the caret belongs in the editor
            // the moment a style is picked (task #437: Ctrl+Z and typing went to the toolbar button).
            onCloseAutoFocus={onHeadingClose}
          >
            <MenuRadioGroup value={String(format.heading)} onValueChange={onHeadingChange}>
              {HEADINGS.map((h, index) => (
                <MenuRadioItem
                  ref={headingItems[index].control.capture}
                  key={h.value}
                  value={h.value}
                  className={h.className}
                >
                  {h.label}
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
          </MenuContent>
        </Menu>
      </Group>
      <Divider />
      <Group>
        <ToolButton label="Bold" keys="Mod-B" active={format.strong} disabled={dis} control={bold} testId="tb-bold">
          <Bold size={18} strokeWidth={2.6} />
        </ToolButton>
        <ToolButton label="Italic" keys="Mod-I" active={format.em} disabled={dis} control={italic} testId="tb-italic">
          <Italic size={18} />
        </ToolButton>
        <ToolButton label="Strikethrough" keys="Mod-Shift-X" active={format.strike} disabled={dis} control={strike}>
          <Strikethrough size={18} />
        </ToolButton>
      </Group>
      <Divider />
      <Group>
        <ToolButton label="Link" keys="Mod-K" active={format.link} disabled={dis} control={link} testId="tb-link">
          <LinkIcon size={18} />
        </ToolButton>
        <ToolButton label="Inline code" keys="Mod-`" active={format.code} disabled={dis} control={code} testId="tb-code">
          <Code size={18} />
        </ToolButton>
        <ToolButton label="Code block" keys="Mod-Alt-C" active={format.codeBlock} disabled={dis} control={codeBlock}>
          <SquareCode size={18} />
        </ToolButton>
      </Group>
      <Divider />
      <Group>
        <ToolButton label="Bulleted list" keys="Mod-Shift-8" active={format.bullet} disabled={dis} control={bullet} testId="tb-bullet">
          <List size={18} />
        </ToolButton>
        <ToolButton label="Numbered list" keys="Mod-Shift-7" active={format.ordered} disabled={dis} control={ordered} testId="tb-ordered">
          <ListOrdered size={18} />
        </ToolButton>
        <ToolButton label="Task list" keys="Mod-Shift-9" active={format.task} disabled={dis} control={task} testId="tb-task">
          <ListChecks size={18} />
        </ToolButton>
        <ToolButton label="Quote" keys="Mod-Shift-." active={format.quote} disabled={dis} control={quote}>
          <Quote size={18} />
        </ToolButton>
        <ToolButton label="Image" disabled={dis} control={image} testId="tb-image">
          <ImageIcon size={18} />
        </ToolButton>
        <ToolButton label="Table" disabled={dis} control={table} testId="tb-table">
          <Table size={18} />
        </ToolButton>
      </Group>
      <Divider />
      <Group>
        <ToolButton label="Horizontal rule" disabled={dis} control={rule}>
          <Minus size={18} />
        </ToolButton>
      </Group>
      <Divider />
      <Group>
        <ToolButton label="Undo" keys="Mod-Z" disabled={!canEdit || !canUndo} control={undo} testId="tb-undo">
          <Undo2 size={18} />
        </ToolButton>
        <ToolButton label="Redo" keys="Mod-Shift-Z" disabled={!canEdit || !canRedo} control={redo} testId="tb-redo">
          <Redo2 size={18} />
        </ToolButton>
      </Group>
      <div className="flex-1" />
      {canComment && (
        <Tip label="Add comment" shortcut={shortcut("Mod-Alt-M")}>
          <button
            ref={captureComment}
            type="button"
            className={cn("btn btn-sm gap-1.5", format.hasSelection ? "btn-outline text-ink" : "btn-ghost text-ink-3")}
            onMouseDown={onCommentMouseDown}
            onClick={onCommentClick}
            data-testid="tb-comment"
          >
            <MessageSquarePlus size={16} />
            Comment
          </button>
        </Tip>
      )}
    </div>
  );
});
