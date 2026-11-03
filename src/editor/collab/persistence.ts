import * as Y from "yjs";
import {
  PERSISTENCE_REQUEST_TIMEOUT_MS,
  type PersistenceMessage,
  type PersistenceRequest,
  type PersistenceState,
  type SavedDocumentVersion,
} from "@/lib/document-persistence";
import { newId } from "./shared";

export type { SavedDocumentVersion } from "@/lib/document-persistence";

/** State vectors alone do not acknowledge deletes (including undo). */
export function snapshotContains(saved: Y.Snapshot, target: Y.Snapshot): boolean {
  for (const [client, clock] of target.sv) {
    if ((saved.sv.get(client) ?? 0) < clock) return false;
  }
  for (const [client, ranges] of target.ds.clients) {
    const savedRanges = saved.ds.clients.get(client) ?? [];
    for (const range of ranges) {
      if (!savedRanges.some((item) => item.clock <= range.clock && item.clock + item.len >= range.clock + range.len)) return false;
    }
  }
  return true;
}

interface FlushRequest {
  target: Y.Snapshot;
  resolve: (saved: SavedDocumentVersion | null) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** Tracks database acknowledgements separately from the provider's per-update transport counter. */
export class ClientDocumentPersistence {
  savedVersion: SavedDocumentVersion | null = null;
  dirty = false;
  error: string | null = null;
  private connected = false;
  private ready = false;
  private disposed = false;
  private epoch: string | null = null;
  private sequence = -1;
  private serverState: PersistenceState = "pending";
  private statusRequestId: string | null = null;
  private statusTimer: ReturnType<typeof setTimeout> | null = null;
  private requests = new Map<string, FlushRequest>();
  private listeners = new Set<(saved: SavedDocumentVersion) => void>();
  private composing = false;

  constructor(
    private readonly docId: string,
    private readonly document: Y.Doc,
    private readonly send: (request: PersistenceRequest) => void,
    private readonly changed: () => void,
  ) {
    document.on("update", this.onUpdate);
  }

  get state(): PersistenceState {
    if (this.error) return "error";
    if (this.serverState === "saving") return "saving";
    if (!this.ready || this.dirty || this.serverState === "pending") return "pending";
    return "saved";
  }

  subscribeSaved = (listener: (saved: SavedDocumentVersion) => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private onUpdate = () => {
    const wasDirty = this.dirty;
    this.dirty = true;
    if (!wasDirty) this.changed();
  };

  synced() {
    if (this.disposed) return;
    this.connected = true;
    this.ready = false;
    this.requestStatus();
    if (this.composing) this.send({ type: "document-composition", docId: this.docId, active: true });
  }

  refreshStatus() {
    if (
      this.disposed || !this.connected ||
      (this.state !== "saving" && this.state !== "error") ||
      this.statusRequestId
    ) return;
    this.requestStatus();
  }

  private requestStatus() {
    // newId, not crypto.randomUUID: that function exists only on https and localhost. On a plain http
    // address (a name or number on the local network) it threw here and the document never reached "saved" (#2284).
    const requestId = newId();
    this.statusRequestId = requestId;
    if (this.statusTimer) clearTimeout(this.statusTimer);
    this.statusTimer = setTimeout(() => {
      this.statusTimer = null;
      if (this.statusRequestId !== requestId) return;
      this.statusRequestId = null;
      this.error = "Save confirmation timed out. Retry saving.";
      this.changed();
    }, PERSISTENCE_REQUEST_TIMEOUT_MS);
    this.send({ type: "document-persistence-status", docId: this.docId, requestId });
  }

  disconnected() {
    this.connected = false;
    this.ready = false;
    this.epoch = null;
    this.sequence = -1;
    this.clearStatusRequest();
    this.rejectRequests(new Error("Disconnected before save was acknowledged. Changes remain pending."));
  }

  setComposing(active: boolean) {
    if (this.composing === active || this.disposed) return;
    this.composing = active;
    if (this.connected) this.send({ type: "document-composition", docId: this.docId, active });
  }

  flush(): Promise<SavedDocumentVersion | null> {
    if (this.disposed) return Promise.reject(new Error("This document session is closed."));
    if (!this.connected) return Promise.reject(new Error("Offline: changes remain pending until reconnect."));
    if (this.state === "saved") return Promise.resolve(this.savedVersion);
    const requestId = newId();
    const promise = new Promise<SavedDocumentVersion | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.requests.delete(requestId);
        this.error = "Save confirmation timed out. Changes remain pending.";
        this.changed();
        reject(new Error(this.error));
      }, PERSISTENCE_REQUEST_TIMEOUT_MS);
      this.requests.set(requestId, { target: Y.snapshot(this.document), resolve, reject, timer });
    });
    this.send({ type: "document-persistence-flush", docId: this.docId, requestId });
    return promise;
  }

  receive(message: PersistenceMessage) {
    if (
      this.disposed || !this.connected || message.docId !== this.docId ||
      message.type !== "document-persistence" || typeof message.epoch !== "string" ||
      !Number.isSafeInteger(message.sequence) || !Number.isSafeInteger(message.revision) ||
      !Number.isSafeInteger(message.savedRevision) ||
      !["pending", "saving", "saved", "error"].includes(message.state)
    ) return;
    const request = message.requestId ? this.requests.get(message.requestId) : undefined;
    const statusReply = !!message.requestId && message.requestId === this.statusRequestId;
    if (this.epoch !== message.epoch) {
      if (this.epoch !== null || (!statusReply && !request)) return;
      this.epoch = message.epoch;
    }

    let snapshot: Y.Snapshot | null = null;
    if (message.snapshot && message.saved?.docId === this.docId) {
      try {
        snapshot = Y.decodeSnapshot(new Uint8Array(message.snapshot));
      } catch {
        return;
      }
    }
    if (request && message.requestId) {
      if (message.error || message.state === "error") {
        clearTimeout(request.timer);
        this.requests.delete(message.requestId);
        request.reject(new Error(message.error ?? "Document persistence failed"));
      } else if (snapshot && message.saved && snapshotContains(snapshot, request.target)) {
        clearTimeout(request.timer);
        this.requests.delete(message.requestId);
        request.resolve(message.saved);
      }
    }
    if (message.sequence <= this.sequence) {
      if (statusReply) this.clearStatusRequest(message.requestId);
      return;
    }
    this.sequence = message.sequence;
    this.ready = true;
    this.clearStatusRequest();
    this.serverState = message.state;
    this.error = message.error;
    if (snapshot && message.saved) {
      const previous = this.savedVersion;
      this.savedVersion = message.saved;
      this.dirty = !snapshotContains(snapshot, Y.snapshot(this.document));
      if (
        !statusReply && !message.error && message.savedRevision > 0 && previous?.version !== message.saved.version &&
        (previous?.contentHash !== message.saved.contentHash || previous?.title !== message.saved.title)
      ) {
        for (const listener of this.listeners) listener(message.saved);
      }
    }
    this.changed();
  }

  private clearStatusRequest(requestId?: string) {
    if (requestId !== undefined && requestId !== this.statusRequestId) return;
    if (this.statusTimer) clearTimeout(this.statusTimer);
    this.statusTimer = null;
    this.statusRequestId = null;
  }

  /** Best-effort close hint only; the immediate IndexedDB journal and server queue remain authoritative. */
  destroy(flush = true) {
    if (this.disposed) return;
    if (flush && this.connected && this.state !== "saved") {
      this.send({ type: "document-persistence-flush", docId: this.docId, requestId: newId() });
    }
    this.disposed = true;
    this.disconnected();
    this.document.off("update", this.onUpdate);
    this.listeners.clear();
  }

  private rejectRequests(error: Error) {
    for (const request of this.requests.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.requests.clear();
  }
}
