"use client";

import * as React from "react";
import { Tooltip as RadixTooltip } from "radix-ui";
import { cn } from "@/lib/utils";

/* ---------------- Tooltip ---------------- */

export function TooltipProvider({ children }: { children: React.ReactNode }) {
  return (
    <RadixTooltip.Provider delayDuration={400} skipDelayDuration={200}>
      {children}
    </RadixTooltip.Provider>
  );
}

export function Tip({
  label,
  children,
  side = "bottom",
  shortcut,
  testId,
  wrap = false,
}: {
  label: string;
  children: React.ReactNode;
  side?: "top" | "bottom" | "left" | "right";
  shortcut?: string;
  /** `data-testid` of the tooltip bubble (the trigger keeps its own). */
  testId?: string;
  /** Let a long label wrap onto a few lines instead of one very wide bubble. */
  wrap?: boolean;
}) {
  return (
    <RadixTooltip.Root>
      <RadixTooltip.Trigger asChild>{children}</RadixTooltip.Trigger>
      <RadixTooltip.Portal>
        <RadixTooltip.Content
          side={side}
          sideOffset={6}
          className={cn(
            "z-[60] flex items-center gap-2 rounded-md bg-inverse px-2.5 py-1.5 text-xs font-medium text-white shadow-lg animate-fade-in",
            wrap && "max-w-[280px] text-center leading-relaxed",
          )}
          data-testid={testId}
        >
          {label}
          {shortcut && <span className="rounded bg-white/15 px-1 py-0.5 font-sans text-[10px] text-white/80">{shortcut}</span>}
        </RadixTooltip.Content>
      </RadixTooltip.Portal>
    </RadixTooltip.Root>
  );
}
