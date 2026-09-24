"use client";

import { useEffect, useState } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { WebhooksPanel } from "./webhooks-panel";

/** Webhooks are for unattended integrations, so they stay closed (and unloaded) until someone asks for them. */
export function AdvancedSettings() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (window.location.hash === "#webhooks") setOpen(true);
  }, []);

  return (
    <section aria-labelledby="advanced-toggle">
      <button
        type="button"
        id="advanced-toggle"
        className="flex w-full items-center gap-2 rounded-lg py-2 text-left text-sm font-medium text-ink-2 hover:text-ink"
        aria-expanded={open}
        aria-controls="advanced-panel"
        onClick={() => setOpen((value) => !value)}
        data-testid="advanced-toggle"
      >
        <ChevronRight size={16} className={cn("shrink-0 transition-transform", open && "rotate-90")} aria-hidden="true" />
        Advanced: webhooks
      </button>
      {!open && <p className="pl-6 text-xs text-ink-3">Push agent events to your own server instead of having an agent poll for them.</p>}
      {open && (
        <div id="advanced-panel" className="mt-2">
          <WebhooksPanel />
        </div>
      )}
    </section>
  );
}
