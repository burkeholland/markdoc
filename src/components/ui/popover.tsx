"use client";

import * as React from "react";
import { Popover as RadixPopover } from "radix-ui";
import { cn } from "@/lib/utils";

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
