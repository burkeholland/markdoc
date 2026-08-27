import type { Connection } from "@hocuspocus/server";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/server/db";
import { canEdit, getDocumentAccess, getUserById } from "@/server/documents";
import type { LinkAccess, Role } from "@/server/db/schema";
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

/** Transition key for a document-wide link-access change; `\0\0` cannot occur in a login. */
function linkKey(docId: string): string {
  return `${docId}\0\0link`;
}

function loginOf(context: CollabContext): string | null {
  return context.login?.trim().toLowerCase() ?? null;
}

/**
 * Wait until an owner-initiated access change that could affect this identity has committed: a
 * change to this collaborator, or a link-access change on the document (which reaches everyone).
 */
export async function waitForCollabAccessChange(docId: string, login: string | null): Promise<void> {
  await Promise.all([state.transitions.get(linkKey(docId)), login ? state.transitions.get(accessKey(docId, login)) : undefined]);
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

interface AccessTransition {
  docId: string;
  /** Serialises changes that affect the same identities; also what `waitForCollabAccessChange` awaits. */
  key: string;
  /** Pick the live connections whose access the mutation may take away. */
  select: (connections: Connection<CollabContext>[]) => Promise<Connection<CollabContext>[]> | Connection<CollabContext>[];
  /** Whether edit rights may be lost: new messages from the selected connections are gated while prior ones drain. */
  gate: boolean;
  mutation: () => Promise<void>;
  what: string;
}

/**
 * Apply an access database mutation without losing edits already accepted by the live document:
 * gate, flush pending messages and stores, mutate, then re-resolve each affected connection.
 */
async function transitionAccess({ docId, key, select, gate, mutation, what }: AccessTransition): Promise<void> {
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
  const connections = await select(document?.getConnections() ?? []);

  if (gate) {
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
          console.error(`[collab] failed to restore access after ${what} mutation failed`, recoveryError);
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
  const normalizedLogin = login.trim().replace(/^@/, "").toLowerCase();
  await transitionAccess({
    docId,
    key: accessKey(docId, login),
    select: (connections) => connections.filter((connection) => loginOf(connection.context as CollabContext) === normalizedLogin),
    gate: !newRole || !canEdit(newRole),
    mutation,
    what: "collaborator",
  });
}

/**
 * Apply a link-access database mutation to a document. Every live connection whose access derives
 * from the link — neither the owner nor an explicit collaborator, anonymous visitors included — is
 * gated, flushed and re-resolved: a closed link disconnects them (4401), a downgraded link makes
 * them read-only, and edits accepted before the change are kept. Owner and collaborators are untouched.
 */
export async function changeLinkAccess(docId: string, newLinkAccess: LinkAccess, mutation: () => Promise<void>): Promise<void> {
  await transitionAccess({
    docId,
    key: linkKey(docId),
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
