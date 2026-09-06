export const GIST_AUTO_UPDATE_NOTICE =
  "Markdoc is the editing source while auto-update is on. Future saved edits, including collaborator edits, will be published to this file. Detected outside edits pause publishing, but an edit made directly on GitHub during an upload can still be overwritten. Secret gists are unlisted, not private.";

export interface GistAutoUpdateDestination {
  gistId: string;
  filename: string;
  url: string;
  visibility: "public" | "secret";
  owner: string;
}

export interface GistAutoUpdatePreview {
  destination: GistAutoUpdateDestination;
}

export interface GistAutoUpdateStatus {
  enabled: boolean;
  status: "off" | "pending" | "syncing" | "synced" | "failed" | "conflict";
  syncedAt: string | null;
  message: string | null;
  /** A saved version is waiting to send, possibly behind the current upload. */
  pending: boolean;
  destination: GistAutoUpdateDestination | null;
}

export type GistAutoUpdateSettings =
  | { enabled: false }
  | { enabled: true; acknowledgeRisk: true; destination: GistAutoUpdateDestination };
