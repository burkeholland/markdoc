"use client";

import { useId, useSyncExternalStore } from "react";
import { linkCardsStore, setLinkCardsSetting } from "@/lib/link-cards-setting";
import { cardProviderList } from "@/editor/markdown/link-cards";

/**
 * The Settings row for link cards (#2317), in the "This device" section, right under Theme. A switch, on by default; the choice is
 * saved in this browser like the theme. It governs what Markdoc writes for this person; it never changes
 * how a document is shown to anyone.
 */
export function LinkCardsSetting() {
  const on = useSyncExternalStore(linkCardsStore.subscribe, linkCardsStore.getSnapshot, linkCardsStore.getServerSnapshot);
  const id = useId();
  return (
    <div className="flex flex-col items-start gap-4 rounded-2xl border border-line bg-surface px-5 py-4 sm:flex-row sm:items-center sm:justify-between sm:gap-6" data-testid="link-cards-row">
      <div>
        <h3 id={`${id}-title`} className="text-base font-semibold text-ink">
          Turn links to known sites into cards
        </h3>
        <p id={`${id}-description`} className="mt-0.5 text-sm text-ink-3" data-testid="link-cards-description">
          When on, a link to {cardProviderList()} pasted on an empty line becomes a card. Type a link on its own line and press Enter to turn it into one. Off: pasted and typed links stay text. Existing cards stay, and the toolbar button &quot;Video or post from a link&quot; can still add one. The choice is saved in this browser.
        </p>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-labelledby={`${id}-title`}
        aria-describedby={`${id}-description`}
        className="switch"
        onClick={() => setLinkCardsSetting(!on)}
        data-testid="link-cards-switch"
      />
    </div>
  );
}
