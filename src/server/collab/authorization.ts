import type { Connection } from "@hocuspocus/server";
import { canEdit, getDocumentAccess, getUserById } from "@/server/documents";
import type { Role } from "@/server/db/schema";
import { getCollab } from "./registry";
import type { CollabClaims } from "./token";

type CollabContext = CollabClaims;

const UNAUTHORIZED = { code: 4401, reason: "Unauthorized" };

interface AuthorizationState {
  transitions: Map<string, Promise<void>>;
  blockedConnections: WeakSet<object>;
  revision: number;
}

const globalState = globalThis as typeof globalThis & {
  __markdocCollabAuthorization?: AuthorizationState;
};

const state =
  globalState.__markdocCollabAuthorization ??
  (globalState.__markdocCollabAuthorization = {
    transitions: new Map(),
    blockedConnections: new WeakSet(),
    revision: 0,
  });
state.revision ??= 0;

function accessKey(docId: string, login: string): string {
  return `${docId}\0${login.trim().replace(/^@/, "").toLowerCase()}`;
}

function loginOf(context: CollabContext): string | null {
  return context.login?.trim().toLowerCase() ?? null;
}

/** Wait until an owner-initiated access change for this collaborator has committed. */
export async function waitForCollabAccessChange(docId: string, login: string | null): Promise<void> {
  if (!login) return;
  await state.transitions.get(accessKey(docId, login));
}

/** Resolve token identity and role from current database state instead of trusting the role claim. */
export async function resolveCollabAccess(claims: CollabClaims): Promise<CollabContext | null> {
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
export async function resolveStableCollabAccess(claims: CollabClaims): Promise<CollabContext | null> {
  for (;;) {
    const revision = state.revision;
    await waitForCollabAccessChange(claims.docId, claims.login);
    const current = await resolveCollabAccess(claims);
    if (state.revision === revision) return current;
  }
}

export function collabAccessChangeBlocks(connection: Connection<CollabContext>): boolean {
  return state.blockedConnections.has(connection);
}

function applyCurrentAccess(connection: Connection<CollabContext>, current: CollabContext | null): void {
  if (!current) {
    connection.readOnly = true;
    connection.close(UNAUTHORIZED);
    return;
  }
  connection.context = current;
  connection.readOnly = !canEdit(current.role);
}

/**
 * Apply a collaborator database mutation without losing edits already accepted by the live
 * document. New messages from that collaborator are gated while prior messages and stores drain.
 */
export async function changeCollaboratorAccess(
  docId: string,
  login: string,
  newRole: Exclude<Role, "owner"> | null,
  mutation: () => Promise<void>,
): Promise<void> {
  const key = accessKey(docId, login);
  const previous = state.transitions.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.catch(() => undefined).then(() => gate);
  state.transitions.set(key, queued);
  state.revision++;

  await previous.catch(() => undefined);
  const collab = getCollab();
  const document = collab?.documents.get(docId);
  const normalizedLogin = login.trim().replace(/^@/, "").toLowerCase();
  const connections =
    document?.getConnections().filter((connection) => loginOf(connection.context as CollabContext) === normalizedLogin) ?? [];

  if (!newRole || !canEdit(newRole)) {
    for (const connection of connections) {
      state.blockedConnections.add(connection);
      connection.readOnly = true;
    }
  }

  try {
    await Promise.all(connections.map((connection) => connection.waitForPendingMessages()));
    if (collab && document) {
      const pendingStore = collab.debouncer.executeNow(`onStoreDocument-${docId}`);
      if (pendingStore) await pendingStore;
      await document.saveMutex.waitForUnlock();
    }

    await mutation();

    await Promise.all(
      connections.map(async (connection) => {
        const current = await resolveCollabAccess(connection.context as CollabContext);
        applyCurrentAccess(connection, current);
      }),
    );
  } catch (error) {
    for (const connection of connections) state.blockedConnections.delete(connection);
    await Promise.all(
      connections.map(async (connection) => {
        try {
          const current = await resolveCollabAccess(connection.context as CollabContext);
          applyCurrentAccess(connection, current);
        } catch (recoveryError) {
          connection.readOnly = true;
          connection.close(UNAUTHORIZED);
          console.error("[collab] failed to restore access after collaborator mutation failed", recoveryError);
        }
      }),
    );
    throw error;
  } finally {
    for (const connection of connections) state.blockedConnections.delete(connection);
    release();
    if (state.transitions.get(key) === queued) state.transitions.delete(key);
  }
}

export const unauthorizedCollabError = () => Object.assign(new Error(UNAUTHORIZED.reason), UNAUTHORIZED);
