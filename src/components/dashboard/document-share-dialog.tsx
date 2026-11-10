"use client";

import { useEffect, useState } from "react";
import { api, apiErrorText } from "@/lib/api";
import type { DocumentDto } from "@/server/dto";
import { ShareDialogContent } from "@/components/editor/share-dialog";
import { Dialog, DialogContent } from "@/components/ui/primitives";

type State =
  | { id: string; status: "loading" }
  | { id: string; status: "error"; message: string; retryable: boolean }
  | { id: string; status: "loaded"; document: DocumentDto };

/** Mount only while selected, so reopening always checks current metadata and owner authorization. */
export function DocumentShareDialog({ target, onOpenChange }: {
  target: { id: string; title: string };
  onOpenChange: (open: boolean) => void;
}) {
  const [state, setState] = useState<State>({ id: target.id, status: "loading" });
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    const id = target.id;
    setState({ id, status: "loading" });
    void api.documents.get(id, { signal: controller.signal, cache: "no-store" }).then(
      ({ document, role }) => {
        if (controller.signal.aborted) return;
        if (role !== "owner") {
          setState({ id, status: "error", message: "Only the document owner can manage sharing.", retryable: false });
        } else {
          setState({ id, status: "loaded", document });
        }
      },
      (error: unknown) => {
        if (!controller.signal.aborted) setState({ id, status: "error", message: apiErrorText(error, "Could not load document sharing. Try again."), retryable: true });
      },
    );
    return () => controller.abort();
  }, [target.id, retry]);

  const error = state.id === target.id && state.status === "error" ? state : null;
  return (
    <Dialog open onOpenChange={onOpenChange}>
      {state.id === target.id && state.status === "loaded"
        ? <ShareDialogContent open onOpenChange={onOpenChange} doc={state.document} isOwner
          onDocChange={(document) => setState((current) => current.id === document.id ? { id: document.id, status: "loaded", document } : current)} />
        : <DialogContent title={`Share document “${target.title}”`} description="Manage access to this document without opening the editor.">
        {error ? <div role="alert" className="text-sm text-danger">
          <p>{error.message}</p>
          {error.retryable && <button type="button" className="btn btn-outline mt-3" onClick={() => setRetry((value) => value + 1)}>Retry</button>}
        </div> : <p role="status" className="text-sm text-ink-3">Loading document sharing…</p>}
      </DialogContent>}
    </Dialog>
  );
}
