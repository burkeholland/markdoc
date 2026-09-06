/** Metadata for a server-acknowledged snapshot, not a transport acknowledgement or a history entry. */
export interface SavedDocumentVersion {
  docId: string;
  /** Opaque identity. Only compare for equality; it changes when the server reloads the document. */
  version: string;
  /** Digest of the persisted source; never resend the full document just to acknowledge it. */
  contentHash: string;
  title: string;
  savedAt: string;
}

export type PersistenceState = "pending" | "saving" | "saved" | "error";

export interface PersistenceMessage {
  type: "document-persistence";
  docId: string;
  epoch: string;
  sequence: number;
  revision: number;
  savedRevision: number;
  state: PersistenceState;
  error: string | null;
  requestId?: string;
  saved?: SavedDocumentVersion;
  /** Encoded Yjs snapshot (state vector AND deletions), captured with the persisted content. */
  snapshot?: number[];
}

export type PersistenceRequest =
  | { type: "document-persistence-status" | "document-persistence-flush"; docId: string; requestId: string }
  | { type: "document-composition"; docId: string; active: boolean };

export const CONTENT_AUTOSAVE_IDLE_MS = 1_000;
export const PERSISTENCE_REQUEST_TIMEOUT_MS = 15_000;
