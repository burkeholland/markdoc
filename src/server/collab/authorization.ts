import { OutgoingMessage, type Connection } from "@hocuspocus/server";
import { eq } from "drizzle-orm";
import * as Y from "yjs";
import { getDb, schema } from "@/server/db";
import { canEdit, getDocumentAccess, getUserById } from "@/server/documents";
import type { LinkAccess, Role } from "@/server/db/schema";
import type { TokenScope } from "@/server/db/schema";
import { resolveApiTokenById } from "@/server/tokens";
import { getCollab } from "./registry";
import { isVerifiedCollabClaims, type CollabClaims, type VerifiedCollabClaims } from "./token";

type CollabContext = CollabClaims & { version?: 2; principal?: "user" | "token" };

const UNAUTHORIZED = { code: 4401, reason: "Unauthorized" };

/**
 * How long, and how much, a paused connection's messages wait for an access change. Past either bound the
 * pause falls back to refusing (see {@link refuseHeld}), so a change that hangs or a client that floods
 * cannot grow memory without end. The time stays well under the 15 s a page waits for a save confirmation.
 */
export const HOLD_LIMITS = { ms: 3_000, messages: 500, bytes: 1024 * 1024 };

/** One per paused connection. Access changes of a document run one at a time, so never two at once. */
interface Hold {
  /** A bound was hit: messages are no longer held, they are refused until the change resolves the access. */
  refusing: boolean;
  /** Settles when the pause ends or falls back to refusing. */
  released: Promise<void>;
  release: () => void;
  /** Messages that arrived while paused. */
  messages: number;
  bytes: number;
  timer: ReturnType<typeof setTimeout>;
  /** Puts the connection's own `handleMessage` back. */
  restore: () => void;
}

interface AuthorizationState {
  transitions: Map<string, Promise<void>>;
  /** Connections paused by an access change: their messages wait until their access is known. */
  holds: WeakMap<object, Hold>;
  /** The message each connection is handling right now, with whoever waits for it to finish. */
  handling: WeakMap<object, { waiting?: (() => void)[] }>;
  /** Sync messages refused per connection since the server last asked it for a full sync. */
  refused: WeakMap<object, number>;
  /** Acknowledgements owed to a connection once its answer to that full sync has been applied. */
  owed: WeakMap<object, number>;
  /** Connections whose answer is being handled right now. */
  answering: WeakSet<object>;
  revision: number;
}

const globalState = globalThis as typeof globalThis & {
  __markdocCollabAuthorization?: AuthorizationState;
};

const state =
  globalState.__markdocCollabAuthorization ??
  (globalState.__markdocCollabAuthorization = {
    transitions: new Map(),
    holds: new WeakMap(),
    handling: new WeakMap(),
    refused: new WeakMap(),
    owed: new WeakMap(),
    answering: new WeakSet(),
    revision: 0,
  });
state.revision ??= 0;
// A development server keeps this object across hot reloads of this module.
state.holds ??= new WeakMap();
state.handling ??= new WeakMap();
state.refused ??= new WeakMap();
state.owed ??= new WeakMap();
state.answering ??= new WeakSet();

/**
 * Test seam: extra milliseconds inside every access change, right after its database write, so tests meet the
 * pause a database on another machine gives production (the in-process test database answers without the server
 * taking another message). Honoured only where the development login is (the rule of `devLoginEnabled` in
 * src/auth.ts, pinned by access-change-delay.test.ts), capped, and 0 for anything that is not a positive number.
 */
export const ACCESS_CHANGE_TEST_DELAY_MAX_MS = 2_000;
export function accessChangeTestDelayMs(env: Record<string, string | undefined> = process.env): number {
  const allowed = (env.AUTH_DEV_LOGIN === "1" && env.NODE_ENV !== "production") || env.AUTH_DEV_LOGIN === "force";
  if (!allowed) return 0;
  const ms = Number(env.COLLAB_ACCESS_CHANGE_TEST_DELAY_MS);
  return Number.isFinite(ms) && ms > 0 ? Math.min(ms, ACCESS_CHANGE_TEST_DELAY_MAX_MS) : 0;
}

function loginOf(context: CollabContext): string | null {
  return context.login?.trim().toLowerCase() ?? null;
}

const ROLE_RANK: Record<Role, number> = { viewer: 0, commenter: 1, editor: 2, owner: 3 };
const TOKEN_ROLE_CAP: Record<TokenScope, Role | null> = { read: "viewer", comment: "commenter", full: null };

function narrowestRole(...roles: Role[]): Role {
  return roles.reduce((narrowest, role) => (ROLE_RANK[role] < ROLE_RANK[narrowest] ? role : narrowest));
}

/** Revocation is immediate for live token-backed sockets, not deferred until their next write. */
export function disconnectCollabToken(tokenId: string): void {
  const collab = getCollab();
  if (!collab) return;
  for (const document of collab.documents.values()) {
    for (const connection of document.getConnections() as Connection<CollabContext>[]) {
      if (connection.context.tokenId !== tokenId) continue;
      connection.readOnly = true;
      connection.close(UNAUTHORIZED);
    }
  }
}

/** Wait until the owner-initiated access changes of this document (collaborators, link access) have committed. */
export async function waitForCollabAccessChange(docId: string): Promise<void> {
  await state.transitions.get(docId);
}

/** Resolve token identity and role from current database state instead of trusting the role claim. */
export async function resolveCollabAccess(claims: VerifiedCollabClaims): Promise<CollabContext | null> {
  if (claims.principal === "token") {
    const actor = await resolveApiTokenById(claims.tokenId);
    if (!actor || actor.id !== claims.userId || actor.scope !== claims.tokenScope) return null;
    if (actor.documentIds?.length && !actor.documentIds.includes(claims.docId)) return null;
    const access = await getDocumentAccess(claims.docId, actor);
    if (!access) return null;
    const cap = TOKEN_ROLE_CAP[actor.scope];
    const role = narrowestRole(claims.role, cap ?? access.role, access.role);
    return {
      ...claims,
      role,
      name: actor.name ?? actor.login ?? claims.name,
      login: actor.login ?? null,
      avatar: actor.image ?? null,
      tokenExpiresAt: actor.expiresAt?.getTime() ?? null,
    };
  }
  if (claims.principal !== "user") return null;
  const user = await getUserById(claims.userId);
  if (!user && !(claims.userId.startsWith("anon-") && claims.login === null)) return null;

  const access = await getDocumentAccess(
    claims.docId,
    user
      ? {
          id: user.id,
          login: user.login,
          name: user.name,
          image: user.image,
        }
      : null,
  );
  if (!access) return null;

  return {
    ...claims,
    role: access.role,
    name: user?.name ?? user?.login ?? claims.name,
    login: user?.login ?? null,
    avatar: user?.image ?? null,
  };
}

/** Resolve access from a database snapshot that did not overlap a collaboration access change. */
export async function resolveStableCollabAccess(claims: VerifiedCollabClaims): Promise<CollabContext | null> {
  for (;;) {
    const revision = state.revision;
    await waitForCollabAccessChange(claims.docId);
    const current = await resolveCollabAccess(claims);
    if (state.revision === revision) return current;
  }
}

/** True while an access change has this connection paused (its messages wait, or are refused past a bound). */
export function collabAccessChangeBlocks(connection: Connection<CollabContext>): boolean {
  return state.holds.has(connection);
}

const attached = (connection: Connection<CollabContext>) => connection.document.hasConnection(connection);

/**
 * `beforeHandleMessage`: a paused connection's message waits here, in arrival order (Hocuspocus handles one
 * message per connection at a time, so everything behind it waits too), until the access change that paused
 * the connection has resolved its access. No database query: this runs for every message.
 */
export async function collabMessageBegins(connection: Connection<CollabContext>): Promise<void> {
  let held = false;
  for (let hold = state.holds.get(connection); hold && !hold.refusing; hold = state.holds.get(connection)) {
    held = true;
    await hold.released;
  }
  // A connection that closed while its messages were held handles none of them.
  if (held && !attached(connection)) connection.readOnly = true;
  state.handling.set(connection, {});
}

/** `afterHandleMessage`: lets an access change that waits for this message go on. */
export function collabMessageEnds(connection: Connection<CollabContext>): void {
  const current = state.handling.get(connection);
  state.handling.delete(connection);
  for (const resume of current?.waiting ?? []) resume();
  if (state.answering.delete(connection)) acknowledgeOwed(connection);
}

/** Resolves once the message this connection is handling (if any) is done; never waits longer than a pause may. */
function handled(connection: Connection<CollabContext>): Promise<void> | undefined {
  const current = state.handling.get(connection);
  if (!current) return undefined;
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, HOLD_LIMITS.ms);
    timer.unref?.();
    (current.waiting ??= []).push(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/**
 * `beforeSync`: count what a read-only connection sends that Hocuspocus will not apply. An update is dropped
 * and answered "not applied", and the client never sends it again; neither is a sync step 2 that holds
 * something new (the same test Hocuspocus makes). {@link heal} uses the count.
 */
export function collabSyncReceived(connection: Connection<CollabContext>, type: number, payload: Uint8Array): void {
  if (type === 0) return;
  if (!connection.readOnly) {
    // The connection's answer to the full sync the server asked for: what is owed is sent once it is applied.
    if (type === 1 && state.owed.has(connection)) state.answering.add(connection);
    return;
  }
  if (type === 1 && Y.snapshotContainsUpdate(Y.snapshot(connection.document), payload)) return;
  state.refused.set(connection, (state.refused.get(connection) ?? 0) + 1);
}

/**
 * A connection that had updates refused can edit again: ask it for everything this server lacks. Later
 * updates build on the refused ones, so without this nothing it sends can be applied until a reload.
 * The server sends sync step 1 and the stock client answers with the missing part. The client still counts
 * one unacknowledged change per refused message; its answer is acknowledged once by Hocuspocus, the others
 * by {@link acknowledgeOwed} after that answer has been applied, never before.
 */
function heal(connection: Connection<CollabContext>): void {
  const refused = state.refused.get(connection);
  if (!refused) return;
  state.refused.delete(connection);
  state.owed.set(connection, (state.owed.get(connection) ?? 0) + refused - 1);
  connection.send(new OutgoingMessage(connection.messageAddress).createSyncMessage().writeFirstSyncStepFor(connection.document).toUint8Array());
}

function acknowledgeOwed(connection: Connection<CollabContext>): void {
  const owed = state.owed.get(connection) ?? 0;
  state.owed.delete(connection);
  const acknowledged = new OutgoingMessage(connection.messageAddress).writeSyncStatus(true).toUint8Array();
  for (let i = 0; i < owed; i += 1) connection.send(acknowledged);
}

/** The access of this connection is known: open it for writing, or keep it read-only. A closed one stays shut. */
function settle(connection: Connection<CollabContext>): void {
  const editable = attached(connection) && canEdit((connection.context as CollabContext).role);
  connection.readOnly = !editable;
  if (editable) heal(connection);
}

function applyCurrentAccess(connection: Connection<CollabContext>, current: CollabContext | null): void {
  if (!current) {
    connection.readOnly = true;
    connection.close(UNAUTHORIZED);
    return;
  }
  connection.context = current;
  settle(connection);
}

/** A bound was hit: stop holding and refuse instead. {@link heal} repairs a connection that turns out to keep edit. */
function refuseHeld(connection: Connection<CollabContext>, hold: Hold): void {
  if (hold.refusing) return;
  hold.refusing = true;
  connection.readOnly = true;
  hold.release();
}

function pause(connection: Connection<CollabContext>): void {
  if (state.holds.has(connection)) return;
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const hold: Hold = { refusing: false, released, release, messages: 0, bytes: 0, timer: setTimeout(() => refuseHeld(connection, hold), HOLD_LIMITS.ms), restore: () => undefined };
  hold.timer.unref?.();
  // Hocuspocus queues without a limit; count what arrives while paused so the wait is bounded in size too.
  // The socket looks `handleMessage` up on the connection for every message, so this wrapper sees them all.
  const own = Object.hasOwn(connection, "handleMessage");
  const receive = connection.handleMessage;
  connection.handleMessage = (data: Uint8Array) => {
    hold.messages += 1;
    hold.bytes += data.byteLength;
    if (hold.messages > HOLD_LIMITS.messages || hold.bytes > HOLD_LIMITS.bytes) refuseHeld(connection, hold);
    receive.call(connection, data);
  };
  hold.restore = () => {
    if (own) connection.handleMessage = receive;
    else delete (connection as { handleMessage?: unknown }).handleMessage;
  };
  state.holds.set(connection, hold);
}

function resume(connection: Connection<CollabContext>): void {
  const hold = state.holds.get(connection);
  if (!hold) return;
  state.holds.delete(connection);
  clearTimeout(hold.timer);
  hold.restore();
  hold.release();
}

interface AccessTransition {
  docId: string;
  /** Pick the live connections whose access the mutation may take away. */
  select: (connections: Connection<CollabContext>[]) => Promise<Connection<CollabContext>[]> | Connection<CollabContext>[];
  /** Whether edit rights may be lost: the selected connections are paused until their access is known again. */
  gate: boolean;
  mutation: () => Promise<void>;
  what: string;
}

/**
 * Apply an access database mutation without losing edits and without accepting any after access ended:
 * pause the affected connections (their messages wait, none is refused), let the message already being
 * handled finish, flush pending stores, mutate, re-resolve each connection, then let the waiting messages
 * through under the access each connection has now.
 *
 * The access changes of one document run one at a time, whatever they change (a collaborator, the link):
 * the access a change resolves for a connection is then never older than another change's write, and a
 * connection is never paused by two changes at once. `waitForCollabAccessChange` awaits the same queue.
 */
async function transitionAccess({ docId, select, gate, mutation, what }: AccessTransition): Promise<void> {
  const key = docId;
  const previous = state.transitions.get(key) ?? Promise.resolve();
  let release!: () => void;
  const settled = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.catch(() => undefined).then(() => settled);
  state.transitions.set(key, queued);
  state.revision++;

  await previous.catch(() => undefined);
  const collab = getCollab();
  const document = collab?.documents.get(docId);
  let connections: Connection<CollabContext>[] = [];
  let paused: Connection<CollabContext>[] = [];

  const resolveAccess = async (connection: Connection<CollabContext>) =>
    applyCurrentAccess(connection, isVerifiedCollabClaims(connection.context) ? await resolveCollabAccess(connection.context) : null);

  try {
    // Inside the `try`: a lookup that fails must still let the next change, and new connections, go on.
    connections = await select(document?.getConnections() ?? []);
    if (gate) paused = connections;
    for (const connection of paused) pause(connection);
    // Not `waitForPendingMessages`: the messages behind the one being handled wait for this change to end.
    await Promise.all(connections.map(handled));
    if (collab && document) {
      const pendingStore = collab.debouncer.executeNow(`onStoreDocument-${docId}`);
      if (pendingStore) await pendingStore;
      await document.saveMutex.waitForUnlock();
    }

    try {
      await mutation();
    } finally {
      const delay = accessChangeTestDelayMs();
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    }

    await Promise.all(connections.map(resolveAccess));
  } catch (error) {
    // The connections stay paused while their access is restored (they are resumed in `finally`).
    await Promise.all(
      connections.map(async (connection) => {
        try {
          await resolveAccess(connection);
        } catch (recoveryError) {
          connection.readOnly = true;
          connection.close(UNAUTHORIZED);
          console.error(`[collab] failed to restore access after ${what} mutation failed`, recoveryError);
        }
      }),
    );
    throw error;
  } finally {
    for (const connection of paused) resume(connection);
    release();
    if (state.transitions.get(key) === queued) state.transitions.delete(key);
  }
}

/**
 * Apply a collaborator database mutation without losing edits already accepted by the live
 * document. That collaborator's live connections are paused while it runs: what they send meanwhile
 * waits and is applied afterwards if they may still edit (through the link, or because the change
 * was refused), and refused if they may not.
 */
export async function changeCollaboratorAccess(
  docId: string,
  login: string,
  newRole: Exclude<Role, "owner"> | null,
  mutation: () => Promise<void>,
): Promise<void> {
  const normalizedLogin = login.trim().replace(/^@/, "").toLowerCase();
  await transitionAccess({
    docId,
    select: (connections) => connections.filter((connection) => loginOf(connection.context as CollabContext) === normalizedLogin),
    gate: !newRole || !canEdit(newRole),
    mutation,
    what: "collaborator",
  });
}

/**
 * Apply a link-access database mutation to a document. Every live connection whose access derives
 * from the link — neither the owner nor an explicit collaborator, anonymous visitors included — is
 * paused, flushed and re-resolved: a closed link disconnects them (4401), a downgraded link makes
 * them read-only, and edits accepted before the change are kept. Owner and collaborators are untouched.
 */
export async function changeLinkAccess(docId: string, newLinkAccess: LinkAccess, mutation: () => Promise<void>): Promise<void> {
  await transitionAccess({
    docId,
    select: async (connections) => {
      if (connections.length === 0) return [];
      const db = await getDb();
      const [doc] = await db.select({ ownerId: schema.documents.ownerId }).from(schema.documents).where(eq(schema.documents.id, docId));
      const collaborators = await db
        .select({ login: schema.collaborators.login })
        .from(schema.collaborators)
        .where(eq(schema.collaborators.documentId, docId));
      const explicit = new Set(collaborators.map((row) => row.login.toLowerCase()));
      return connections.filter((connection) => {
        const context = connection.context as CollabContext;
        if (doc && context.userId === doc.ownerId) return false;
        const login = loginOf(context);
        return !(login && explicit.has(login));
      });
    },
    // Only "edit" admits link visitors as editors; every other value can take editing away.
    gate: newLinkAccess !== "edit",
    mutation,
    what: "link access",
  });
}

export const unauthorizedCollabError = () => Object.assign(new Error(UNAUTHORIZED.reason), UNAUTHORIZED);
