import type { SyncStatusDto } from "@/lib/api";

/** User-facing strings shared by the header, the dashboard and the sync/GitHub dialogs. */

export const SYNC_LABELS: Record<SyncStatusDto["status"], string> = {
  "in-sync": "Up to date",
  "local-ahead": "Unpublished changes",
  "remote-ahead": "GitHub has changes",
  diverged: "Both changed",
  "remote-unreadable": "GitHub file too large",
};

/** Shown wherever a GitHub entry point is disabled because the server has no GitHub OAuth app (#162). */
export const GITHUB_NOT_CONFIGURED = "GitHub storage is not set up on this server.";
