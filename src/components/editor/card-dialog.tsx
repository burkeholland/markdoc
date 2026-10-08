"use client";

import { memo, useId, useLayoutEffect, useRef, useState } from "react";
import { Dialog, DialogContent } from "@/components/ui/primitives";
import { cardProviderList, matchLinkCard } from "@/editor/markdown/link-cards";

interface Draft {
  open: boolean;
  link: string;
  /** The Insert button was pressed with a link that is not on the list. */
  refused: boolean;
}

const closedDraft = (open: boolean): Draft => ({ open, link: "", refused: false });


/**
 * Insert → "Video or post from a link" (#2317): paste a link, get a card. The link is asked of the same
 * list as everywhere else (`matchLinkCard`), here and again when the card is inserted; a link that is not
 * on it is refused with a sentence that says what works. Nothing is fetched to decide.
 *
 * The card is inserted once the dialog has closed and let go of focus (`DialogContent.onClosed`), so the
 * caret ends up in the editor under the new card.
 */
export const CardDialog = memo(function CardDialog({ open, onOpenChange, onSubmit }: { open: boolean; onOpenChange: (open: boolean) => void; onSubmit: (url: string) => void }) {
  const id = useId();
  const [stored, setDraft] = useState<Draft>(() => closedDraft(open));
  let draft = stored;
  // Every opening starts empty.
  if (draft.open !== open) {
    draft = closedDraft(open);
    setDraft(draft);
  }
  // The link the Insert button accepted, kept until the dialog has closed. A new opening starts with none.
  const accepted = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (open) accepted.current = null;
  }, [open]);
  const sites = cardProviderList();
  const link = draft.link.trim();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title="Video or post from a link"
        description={`Paste a link to a video or post on ${sites}. It becomes a card on a line of its own.`}
        onClosed={() => {
          const url = accepted.current;
          accepted.current = null;
          if (url) onSubmit(url);
        }}
      >
        <form
          className="flex flex-col gap-3"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            if (!matchLinkCard(link)) {
              setDraft({ ...draft, refused: true });
              return;
            }
            accepted.current = link;
            onOpenChange(false);
          }}
        >
          <label className="flex flex-col gap-1 text-sm font-medium text-ink-2">
            Link
            <input
              className="input"
              type="url"
              inputMode="url"
              autoComplete="off"
              spellCheck={false}
              placeholder="https://www.youtube.com/watch?v=..."
              value={draft.link}
              onChange={(event) => setDraft({ ...draft, link: event.target.value, refused: false })}
              aria-invalid={draft.refused || undefined}
              aria-describedby={draft.refused ? `${id}-error` : undefined}
              autoFocus
              data-testid="card-link"
            />
          </label>
          {draft.refused && (
            <p id={`${id}-error`} role="alert" className="text-sm text-danger" data-testid="card-link-error">
              {link === "" ? "Paste a link first." : `Markdoc cannot show this link as a card. Use the link to one video or post on ${sites}, starting with https://.`}
            </p>
          )}
          <div className="flex justify-end gap-2 pt-1">
            <button type="button" className="btn btn-ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </button>
            <button type="submit" className="btn btn-primary" data-testid="card-submit">
              Insert
            </button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
});
