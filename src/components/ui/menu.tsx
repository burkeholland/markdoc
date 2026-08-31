"use client";

import * as React from "react";
import { DropdownMenu as RadixDropdown } from "radix-ui";
import { cn } from "@/lib/utils";

/* ---------------- Dropdown menu ---------------- */

export const Menu = RadixDropdown.Root;
export const MenuTrigger = RadixDropdown.Trigger;
export const MenuGroup = RadixDropdown.Group;
export const MenuSub = RadixDropdown.Sub;
export const MenuRadioGroup = RadixDropdown.RadioGroup;

export function MenuContent({ className, children, ...props }: React.ComponentProps<typeof RadixDropdown.Content>) {
  return (
    <RadixDropdown.Portal>
      {/* Long menus (the phone ⋮ menu has 22 rows) cap at the room Radix measures below the trigger and scroll inside, so the last item is always reachable.
          Radix leaves the content at tabindex -1 (items are the roving tab stops); tabindex 0 keeps the scroller itself keyboard-reachable
          (axe scrollable-region-focusable) — Tab is swallowed by the menu anyway, so nothing else changes. */}
      <RadixDropdown.Content
        sideOffset={6}
        align="end"
        collisionPadding={8}
        tabIndex={0}
        className={cn("menu animate-fade-in max-h-[var(--radix-dropdown-menu-content-available-height)] overflow-y-auto", className)}
        {...props}
      >
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
