"use client";

import * as React from "react";
import { Tooltip as RadixTooltip, DropdownMenu as RadixDropdown, Dialog as RadixDialog, Popover as RadixPopover } from "radix-ui";
import { X } from "lucide-react";
import { cn, initials } from "@/lib/utils";

/* ---------------- Tooltip ---------------- */

export function TooltipProvider({ children }: { children: React.ReactNode }) {
  return (
    <RadixTooltip.Provider delayDuration={400} skipDelayDuration={200}>
      {children}
    </RadixTooltip.Provider>
  );
}

export function Tip({ label, children, side = "bottom", shortcut }: { label: string; children: React.ReactNode; side?: "top" | "bottom" | "left" | "right"; shortcut?: string }) {
  return (
    <RadixTooltip.Root>
      <RadixTooltip.Trigger asChild>{children}</RadixTooltip.Trigger>
      <RadixTooltip.Portal>
        <RadixTooltip.Content
          side={side}
          sideOffset={6}
          className="z-[60] flex items-center gap-2 rounded-md bg-inverse px-2.5 py-1.5 text-xs font-medium text-white shadow-lg animate-fade-in"
        >
          {label}
          {shortcut && <span className="rounded bg-white/15 px-1 py-0.5 font-sans text-[10px] text-white/80">{shortcut}</span>}
        </RadixTooltip.Content>
      </RadixTooltip.Portal>
    </RadixTooltip.Root>
  );
}

/* ---------------- Dropdown menu ---------------- */

export const Menu = RadixDropdown.Root;
export const MenuTrigger = RadixDropdown.Trigger;
export const MenuGroup = RadixDropdown.Group;
export const MenuSub = RadixDropdown.Sub;
export const MenuRadioGroup = RadixDropdown.RadioGroup;

export function MenuContent({ className, children, ...props }: React.ComponentProps<typeof RadixDropdown.Content>) {
  return (
    <RadixDropdown.Portal>
      <RadixDropdown.Content sideOffset={6} align="end" className={cn("menu animate-fade-in", className)} {...props}>
        {children}
      </RadixDropdown.Content>
    </RadixDropdown.Portal>
  );
}

export function MenuItem({ className, icon, shortcut, children, ...props }: React.ComponentProps<typeof RadixDropdown.Item> & { icon?: React.ReactNode; shortcut?: string }) {
  return (
    <RadixDropdown.Item className={cn("menu-item", className)} {...props}>
      {icon && <span className="flex h-4 w-4 items-center justify-center text-ink-3">{icon}</span>}
      <span className="flex-1">{children}</span>
      {shortcut && <span className="ml-4 text-xs text-ink-4">{shortcut}</span>}
    </RadixDropdown.Item>
  );
}

export function MenuCheckboxItem({ className, children, ...props }: React.ComponentProps<typeof RadixDropdown.CheckboxItem>) {
  return (
    <RadixDropdown.CheckboxItem className={cn("menu-item pl-8 relative", className)} {...props}>
      <RadixDropdown.ItemIndicator className="absolute left-2.5 text-accent">✓</RadixDropdown.ItemIndicator>
      {children}
    </RadixDropdown.CheckboxItem>
  );
}

export function MenuRadioItem({ className, children, description, ...props }: React.ComponentProps<typeof RadixDropdown.RadioItem> & { description?: string }) {
  return (
    <RadixDropdown.RadioItem className={cn("menu-item relative items-start pl-8", className)} {...props}>
      <RadixDropdown.ItemIndicator className="absolute left-2.5 top-2 text-accent">✓</RadixDropdown.ItemIndicator>
      <span className="flex flex-col">
        <span>{children}</span>
        {description && <span className="text-xs text-ink-3">{description}</span>}
      </span>
    </RadixDropdown.RadioItem>
  );
}

export function MenuLabel({ children }: { children: React.ReactNode }) {
  return <RadixDropdown.Label className="menu-label">{children}</RadixDropdown.Label>;
}

export function MenuSeparator() {
  return <RadixDropdown.Separator className="menu-sep" />;
}

/* ---------------- Popover ---------------- */

export const Popover = RadixPopover.Root;
export const PopoverTrigger = RadixPopover.Trigger;
export const PopoverAnchor = RadixPopover.Anchor;

export function PopoverContent({ className, children, ...props }: React.ComponentProps<typeof RadixPopover.Content>) {
  return (
    <RadixPopover.Portal>
      <RadixPopover.Content sideOffset={8} className={cn("menu w-72 p-3 animate-fade-in", className)} {...props}>
        {children}
      </RadixPopover.Content>
    </RadixPopover.Portal>
  );
}

/* ---------------- Dialog ---------------- */

export const Dialog = RadixDialog.Root;
export const DialogTrigger = RadixDialog.Trigger;
export const DialogClose = RadixDialog.Close;

export function DialogContent({
  title,
  description,
  children,
  className,
  wide,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
  className?: string;
  wide?: boolean;
}) {
  return (
    <RadixDialog.Portal>
      <RadixDialog.Overlay className="dialog-overlay animate-fade-in" />
      <RadixDialog.Content className={cn("dialog animate-fade-in", wide && "w-[min(94vw,760px)]", className)}>
        <div className="mb-4 flex items-start justify-between gap-4">
          <div>
            <RadixDialog.Title className="text-lg font-semibold text-ink">{title}</RadixDialog.Title>
            {description ? (
              <RadixDialog.Description className="mt-1 text-sm text-ink-3">{description}</RadixDialog.Description>
            ) : (
              <RadixDialog.Description className="sr-only">{title}</RadixDialog.Description>
            )}
          </div>
          <RadixDialog.Close className="icon-btn -mr-2 -mt-1 h-8 w-8" aria-label="Close">
            <X size={16} />
          </RadixDialog.Close>
        </div>
        {children}
      </RadixDialog.Content>
    </RadixDialog.Portal>
  );
}

/* ---------------- Avatar ---------------- */

export function Avatar({
  name,
  src,
  color,
  size = 36,
  className,
  title,
}: {
  name: string;
  src?: string | null;
  color?: string;
  size?: number;
  className?: string;
  title?: string;
}) {
  const [failed, setFailed] = React.useState(false);
  const style: React.CSSProperties = { width: size, height: size, fontSize: Math.max(10, Math.round(size * 0.36)) };
  if (color) style.boxShadow = `0 0 0 2px var(--color-surface), 0 0 0 4px ${color}`;
  return (
    <span className={cn("avatar", className)} style={style} title={title ?? name}>
      {src && !failed ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt={name} width={size} height={size} className="h-full w-full object-cover" onError={() => setFailed(true)} referrerPolicy="no-referrer" />
      ) : (
        <span style={color ? { color } : undefined}>{initials(name)}</span>
      )}
    </span>
  );
}

/* ---------------- Misc ---------------- */

export function Spinner({ className }: { className?: string }) {
  return (
    <svg className={cn("h-4 w-4 animate-spin text-ink-3", className)} viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

export function Kbd({ children }: { children: React.ReactNode }) {
  return <kbd className="kbd">{children}</kbd>;
}

export function EmptyState({ icon, title, children }: { icon?: React.ReactNode; title: string; children?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-12 text-center">
      {icon && <div className="mb-1 text-ink-4">{icon}</div>}
      <div className="text-sm font-medium text-ink-2">{title}</div>
      {children && <div className="max-w-xs text-[13px] text-ink-3">{children}</div>}
    </div>
  );
}

/** GitHub mark (lucide dropped brand icons). */
export function GitHubIcon({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} fill="currentColor" className={className} aria-hidden>
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}
