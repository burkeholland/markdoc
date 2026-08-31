import type { SyncStatusDto } from "@/lib/api";

// User-facing strings shared by the header, the dashboard and the sync/GitHub dialogs. They live apart
// from the dialogs so that importing a label never pulls a dialog into the editor's entry chunk.

/** The sync chip / status line per three-way sync state. */
export const SYNC_LABELS: Record<SyncStatusDto["status"], string> = {
  "in-sync": "Up to date",
  "local-ahead": "Unpublished changes",
  "remote-ahead": "GitHub has changes",
  diverged: "Both changed",
  "remote-unreadable": "GitHub file too large",
};

/** Shown wherever a GitHub entry point is disabled because the server has no GitHub OAuth app (#162). */
export const GITHUB_NOT_CONFIGURED = "GitHub storage is not set up on this server.";
