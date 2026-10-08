"use client";

import { useEffect } from "react";
import { cardLinkText, matchLinkCard, MAX_CARD_FRAMES } from "@/editor/markdown/link-cards";
import { cardLoadLabel, createCardFrame } from "@/editor/link-card-frame";

const ROOT_SELECTOR = "[data-reader-overflow-root]";

/**
 * Gives the published page's link cards their frames (#2317). The server draws each card as Markdoc's
 * own markup with an empty box of the frame's size (`rehypeLinkCards`); the frame is made here, from the
 * card's link and the same list the server asked, never from an address in the HTML. The browser loads
 * a frame only when its card is near the viewport. A page loads `MAX_CARD_FRAMES` by itself; a card
 * beyond that gets a button. Without JavaScript the card keeps its label and its link.
 *
 * A box that already holds something is left alone, so running twice (React's development double run)
 * adds nothing; new content arrives as new HTML with empty boxes.
 */
export function ReaderLinkCards({ contentKey }: { contentKey: string }) {
  useEffect(() => {
    const root = document.querySelector<HTMLElement>(ROOT_SELECTOR);
    if (!root) return;
    // Frames this page already loads by itself (none on a first run; all of them on a second run over the same HTML).
    let loading = root.querySelectorAll("iframe.md-link-card-iframe:not([data-asked])").length;
    for (const figure of root.querySelectorAll<HTMLElement>("figure.md-link-card[data-link-card]")) {
      const link = figure.getAttribute("data-link-card") ?? "";
      const card = matchLinkCard(link);
      const box = figure.querySelector<HTMLElement>(":scope > .md-link-card-frame");
      if (!card || !box || box.childElementCount > 0) continue;
      const add = (asked: boolean) => {
        const frame = createCardFrame(card, link);
        if (!frame) return;
        if (asked) frame.setAttribute("data-asked", "");
        box.replaceChildren(frame);
      };
      if (loading < MAX_CARD_FRAMES) {
        loading++;
        add(false);
        continue;
      }
      const load = document.createElement("button");
      load.type = "button";
      load.className = "md-link-card-load";
      load.textContent = cardLoadLabel(card);
      load.setAttribute("aria-label", `${cardLoadLabel(card)}: ${cardLinkText(link)}`);
      load.setAttribute("data-testid", "link-card-load");
      load.addEventListener("click", () => add(true));
      box.replaceChildren(load);
    }
  }, [contentKey]);
  return null;
}
