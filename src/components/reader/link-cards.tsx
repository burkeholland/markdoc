"use client";

import { useEffect } from "react";
import { cardLinkText, matchLinkCard, MAX_CARD_FRAMES } from "@/editor/markdown/link-cards";
import { cardLoadLabel, createCardFrame, createCardUnavailableNotice, watchCardFrameAvailability } from "@/editor/link-card-frame";
import { createTurnedOffNotice, guardCardFrame } from "@/editor/link-card-focus-guard";

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
    // Frames this run has made. A run over HTML it has already been through finds every box filled.
    let loading = 0;
    // The focus guards of this run (#2338); they end with it.
    const guards = new Set<() => void>();
    for (const figure of root.querySelectorAll<HTMLElement>("figure.md-link-card[data-link-card]")) {
      const link = figure.getAttribute("data-link-card") ?? "";
      const card = matchLinkCard(link);
      const box = figure.querySelector<HTMLElement>(":scope > .md-link-card-frame");
      if (!card || !box) continue;
      /** The frame's page may not take the keyboard by itself; one that keeps trying is turned off. */
      const watch = (frame: HTMLIFrameElement) => {
        let stop = () => {};
        const stopAvailability = watchCardFrameAvailability(frame, card, box, () => {
          stop();
          box.replaceChildren(createCardUnavailableNotice(add));
        });
        const stopFocusGuard = guardCardFrame(frame, () => {
          stop();
          box.replaceChildren(createTurnedOffNotice(add));
        });
        stop = () => {
          stopAvailability();
          stopFocusGuard();
          guards.delete(stop);
        };
        guards.add(stop);
      };
      const add = () => {
        const frame = createCardFrame(card, link);
        if (!frame) return;
        if (card.kind === "video") box.setAttribute("data-checking", "");
        box.replaceChildren(frame);
        watch(frame);
      };
      // A frame an earlier run made is kept, and guarded again.
      const made = box.querySelector<HTMLIFrameElement>(":scope > iframe.md-link-card-iframe");
      if (made) {
        watch(made);
        continue;
      }
      if (box.childElementCount > 0) continue;
      if (loading < MAX_CARD_FRAMES) {
        loading++;
        add();
        continue;
      }
      const load = document.createElement("button");
      load.type = "button";
      load.className = "md-link-card-load";
      load.textContent = cardLoadLabel(card);
      load.setAttribute("aria-label", `${cardLoadLabel(card)}: ${cardLinkText(link)}`);
      load.setAttribute("data-testid", "link-card-load");
      load.addEventListener("click", add);
      box.replaceChildren(load);
    }
    return () => {
      for (const stop of guards) stop();
    };
  }, [contentKey]);
  return null;
}
