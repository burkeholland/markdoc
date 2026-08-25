import { HocuspocusProvider } from "@hocuspocus/provider";

/**
 * HocuspocusProvider that knows about the local (IndexedDB) mirror.
 *
 * y-indexeddb restores the stored copy of a document in one Yjs transaction whose origin is the
 * persistence instance. The stock provider treats that like any other local change and pushes the
 * whole encoded state to the server as an update — queued while the socket is still opening and
 * flushed right after the handshake — so every warm open uploaded the entire document (issue #189:
 * 167 KB for the 12k-word doc) even though the server already had all of it.
 *
 * Here that transaction is never sent as an update. What the server is missing (edits typed while
 * offline, if any) travels through the sync handshake instead: sync step 1 carries this document's
 * state vector, the server answers with the delta and its own state vector, and the reply to that
 * is exactly the part of the local copy the server does not have — a few hundred bytes each way
 * when nothing changed, instead of the document twice.
 *
 * - Mirror applied before the handshake (the normal warm open, see `CollabSession.connect`): the
 *   state vector in sync step 1 already covers it. The unsynced counter still goes up so the header
 *   reads "Offline — 1 unsaved change" after a reload without a connection; `startSync` resets it
 *   and the server's ack brings it to zero.
 * - Mirror applied after the handshake (IndexedDB slower than the socket): the state vector
 *   exchange is run again with `forceSync`, so the delta still reaches the server.
 */
export class MarkdocProvider extends HocuspocusProvider {
  private localOrigin: unknown = null;
  private handshakeStarted = false;

  /** The object y-indexeddb uses as transaction origin when it applies the stored state. */
  setLocalOrigin(origin: unknown) {
    this.localOrigin = origin;
  }

  /** True once sync step 1 went out on the current socket. */
  get syncStarted(): boolean {
    return this.handshakeStarted;
  }

  override startSync() {
    this.handshakeStarted = true;
    super.startSync();
  }

  override onClose() {
    this.handshakeStarted = false;
    super.onClose();
  }

  override documentUpdateHandler(update: Uint8Array, origin: unknown) {
    if (this.localOrigin !== null && origin === this.localOrigin) {
      if (this.handshakeStarted) this.forceSync();
      else this.incrementUnsyncedChanges();
      return;
    }
    super.documentUpdateHandler(update, origin);
  }
}
