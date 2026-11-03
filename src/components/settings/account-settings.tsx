"use client";

import { useId, useState } from "react";
import { Download, LogOut, Trash2 } from "lucide-react";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { signOutSafely } from "@/lib/sign-out";
import { clearAllLocalDocuments } from "@/editor/collab/offline";
import { navigateTo } from "@/lib/nav";

const ROW = "flex flex-col items-start gap-4 rounded-2xl border border-line bg-surface px-5 py-4 sm:flex-row sm:items-center sm:justify-between sm:gap-6";

/** Account rows on Settings (#2402): who is signed in, sign out, export every document, delete the account. */
export function AccountSettings({ login, name, image, isDemo }: { login: string | null; name: string | null; image: string | null; isDemo: boolean }) {
  const [deleting, setDeleting] = useState(false);
  const display = name ?? login ?? "You";
  const deleteDisabled = isDemo || !login;
  return (
    <div className="space-y-3">
      <div className={ROW} data-testid="account-identity-row">
        <div className="flex min-w-0 items-center gap-3">
          {image ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={image} alt="" className="h-10 w-10 shrink-0 rounded-full" />
          ) : (
            <span aria-hidden className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-surface-2 text-base font-semibold text-ink-2">
              {display.slice(0, 1).toUpperCase()}
            </span>
          )}
          <div className="min-w-0">
            <p className="truncate text-base font-semibold text-ink" data-testid="account-name">{display}</p>
            {login && <p className="truncate text-sm text-ink-3" data-testid="account-login">Signed in as @{login}</p>}
          </div>
        </div>
        <button type="button" className="btn btn-outline btn-sm shrink-0 gap-1.5" onClick={() => void signOutSafely()} data-testid="account-sign-out">
          <LogOut size={14} /> Sign out
        </button>
      </div>
      <div className={ROW} data-testid="account-export-row">
        <div>
          <h3 className="text-base font-semibold text-ink">Export all documents</h3>
          <p className="mt-0.5 text-sm text-ink-3">Download a .zip of every document you own as Markdown, with folders kept as directories. Documents in the trash are left out.</p>
        </div>
        <a href="/api/me/export" download className="btn btn-outline btn-sm shrink-0 gap-1.5" data-testid="account-export">
          <Download size={14} /> Export .zip
        </a>
      </div>
      <div className={ROW} data-testid="account-delete-row">
        <div>
          <h3 className="text-base font-semibold text-ink">Delete account</h3>
          <p className="mt-0.5 text-sm text-ink-3">
            {isDemo ? "The shared demo account cannot be deleted." : "Permanently delete your account, your documents, folders, versions and API keys. This cannot be undone."}
          </p>
        </div>
        <button type="button" className={`btn ${deleteDisabled ? "btn-outline" : "btn-danger"} btn-sm shrink-0 gap-1.5`} disabled={deleteDisabled} onClick={() => setDeleting(true)} data-testid="account-delete">
          <Trash2 size={14} /> Delete account
        </button>
      </div>
      {login && <DeleteAccountDialog open={deleting} onOpenChange={setDeleting} login={login} />}
    </div>
  );
}

export function DeleteAccountDialog({ open, onOpenChange, login }: { open: boolean; onOpenChange: (open: boolean) => void; login: string }) {
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = useId();
  const matches = typed.trim().toLowerCase() === login.toLowerCase();

  const close = (next: boolean) => {
    if (busy) return;
    if (!next) {
      setTyped("");
      setError(null);
    }
    onOpenChange(next);
  };

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!matches || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/me", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirm: typed.trim() }) });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(body?.error ?? "Could not delete the account. Try again.");
        setBusy(false);
        return;
      }
      // The account is gone: drop this device's offline copies without asking, then end the session.
      await clearAllLocalDocuments().catch((err) => console.error("[markdoc] offline cleanup after account deletion failed", err));
      navigateTo("/api/auth/signout");
    } catch {
      setError("Could not delete the account. Check your connection and try again.");
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent title="Delete account" description="This permanently deletes your account and every document you own. Shared documents disappear for everyone they were shared with.">
        <form onSubmit={submit} data-testid="delete-account-dialog">
          <label htmlFor={`${id}-confirm`} className="text-sm text-ink-2">
            Type <strong className="font-semibold text-ink">{login}</strong> to confirm.
          </label>
          <input
            id={`${id}-confirm`}
            className="input mt-2 w-full"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            disabled={busy}
            data-testid="delete-account-confirm"
          />
          {error && (
            <p role="alert" className="mt-2 text-sm text-danger" data-testid="delete-account-error">
              {error}
            </p>
          )}
          <div className="mt-5 flex justify-end gap-2">
            <button type="button" className="btn btn-ghost" onClick={() => close(false)} disabled={busy}>
              Cancel
            </button>
            <button type="submit" className="btn btn-danger" disabled={!matches || busy} data-testid="delete-account-submit">
              {busy ? "Deleting…" : "Delete account"}
            </button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
