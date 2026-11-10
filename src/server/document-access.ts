import { and, eq, inArray, sql, type SQL, type SQLWrapper } from "drizzle-orm";
import { getDb, schema, type Db } from "@/server/db";
import type { LinkAccess, Role } from "@/server/db/schema";

export type AccessSource = "owner" | "collaborator" | "folder" | "link" | "folder-link";
type CollaboratorRole = Exclude<Role, "owner">;

export interface AccessDocument {
  id: string;
  ownerId: string;
  folderId: string | null;
  linkAccess: LinkAccess;
}

interface AccessUser {
  id: string;
  login: string | null;
}

export interface AccessSqlPrincipal {
  id?: string | SQLWrapper | null;
  login?: string | SQLWrapper | null;
  signedIn: boolean;
}

export interface EffectiveAccess {
  role: Role;
  source: AccessSource;
}

export function roleFromLink(linkAccess: LinkAccess, signedIn: boolean): Role | null {
  switch (linkAccess) {
    case "private":
      return null;
    case "view":
      return "viewer";
    case "comment":
      return signedIn ? "commenter" : "viewer";
    case "edit":
      return signedIn ? "editor" : "viewer";
  }
}

/** The strongest applicable grant wins. Direct grants win ties, followed by folder grants and links. */
export function effectiveRole({
  owner,
  directRole,
  folderRole,
  linkRole,
  folderLinkRole = null,
}: {
  owner: boolean;
  directRole: CollaboratorRole | null;
  folderRole: CollaboratorRole | null;
  linkRole: Role | null;
  folderLinkRole?: Role | null;
}): EffectiveAccess | null {
  if (owner) return { role: "owner", source: "owner" };

  for (const role of ["editor", "commenter", "viewer"] as const) {
    if (directRole === role) return { role, source: "collaborator" };
    if (folderRole === role) return { role, source: "folder" };
    if (linkRole === role) return { role, source: "link" };
    if (folderLinkRole === role) return { role, source: "folder-link" };
  }
  return null;
}

/** Resolve the user's strongest role for a document whose metadata is already loaded. */
export async function effectiveRoleForDocument(
  doc: AccessDocument,
  user: AccessUser | null,
  db?: Db,
): Promise<EffectiveAccess | null> {
  if (user?.id === doc.ownerId) return { role: "owner", source: "owner" };
  const database = db ?? (await getDb());
  const login = normalizeLogin(user?.login);
  let directRole: CollaboratorRole | null = null;
  let folderRole: CollaboratorRole | null = null;
  const [folder] = doc.folderId
    ? await database.select({ linkAccess: schema.folders.linkAccess }).from(schema.folders).where(eq(schema.folders.id, doc.folderId)).limit(1)
    : [];

  if (login) {
    const [direct, folder] = await Promise.all([
      database
        .select({ role: schema.collaborators.role })
        .from(schema.collaborators)
        .where(and(eq(schema.collaborators.documentId, doc.id), sql`lower(${schema.collaborators.login}) = ${login}`))
        .limit(1),
      doc.folderId
        ? database
            .select({ role: schema.folderCollaborators.role })
            .from(schema.folderCollaborators)
            .where(and(eq(schema.folderCollaborators.folderId, doc.folderId), sql`lower(${schema.folderCollaborators.login}) = ${login}`))
            .limit(1)
        : Promise.resolve([]),
    ]);
    directRole = direct[0]?.role ?? null;
    folderRole = folder[0]?.role ?? null;
  }

  return effectiveRole({
    owner: user?.id === doc.ownerId,
    directRole,
    folderRole,
    linkRole: roleFromLink(doc.linkAccess, user !== null),
    folderLinkRole: folder ? roleFromLink(folder.linkAccess, user !== null) : null,
  });
}

/** Candidate logins that can open a document; used to filter @mentions in one bounded set of reads. */
export async function accessibleLoginsForDocument(docId: string, candidates: readonly string[]): Promise<Set<string>> {
  const logins = [...new Set(candidates.map(normalizeLogin).filter((login): login is string => login !== null))];
  if (logins.length === 0) return new Set();
  const database = await getDb();
  const [doc] = await database
    .select({
      ownerId: schema.documents.ownerId, folderId: schema.documents.folderId, linkAccess: schema.documents.linkAccess,
      folderLinkAccess: sql<LinkAccess | null>`(select ${schema.folders.linkAccess} from ${schema.folders} where ${schema.folders.id} = ${schema.documents.folderId})`,
    })
    .from(schema.documents)
    .where(and(eq(schema.documents.id, docId), sql`${schema.documents.deletedAt} is null`))
    .limit(1);
  if (!doc) return new Set();
  const linkRole = roleFromLink(doc.linkAccess, true);
  if (linkRole || (doc.folderLinkAccess && roleFromLink(doc.folderLinkAccess, true))) return new Set(logins);

  const [ownerRows, directRows, folderRows] = await Promise.all([
    database
      .select({ login: schema.users.login })
      .from(schema.users)
      .where(and(eq(schema.users.id, doc.ownerId), inArray(sql`lower(${schema.users.login})`, logins)))
      .limit(1),
    database
      .select({ login: schema.collaborators.login, role: schema.collaborators.role })
      .from(schema.collaborators)
      .where(and(eq(schema.collaborators.documentId, docId), inArray(sql`lower(${schema.collaborators.login})`, logins))),
    doc.folderId
      ? database
          .select({ login: schema.folderCollaborators.login, role: schema.folderCollaborators.role })
          .from(schema.folderCollaborators)
          .where(and(eq(schema.folderCollaborators.folderId, doc.folderId), inArray(sql`lower(${schema.folderCollaborators.login})`, logins)))
      : Promise.resolve([]),
  ]);
  const ownerLogin = ownerRows[0]?.login?.toLowerCase();
  const directRoles = new Map(directRows.map(({ login, role }) => [login.toLowerCase(), role]));
  const folderRoles = new Map(folderRows.map(({ login, role }) => [login.toLowerCase(), role]));
  return new Set(
    logins.filter(
      (login) =>
        effectiveRole({
          owner: ownerLogin === login,
          directRole: directRoles.get(login) ?? null,
          folderRole: folderRoles.get(login) ?? null,
          linkRole,
        }) !== null,
    ),
  );
}

/**
 * SQL equivalent of {@link effectiveRole}. Its expressions are correlated to the document columns
 * passed in, so access filters and role projections use the same precedence as single-document reads.
 */
export function effectiveRoleSql(
  doc: {
    id: SQLWrapper;
    ownerId: SQLWrapper;
    folderId: SQLWrapper;
    linkAccess: SQLWrapper;
  },
  user: AccessSqlPrincipal | null,
  { includeLink = true }: { includeLink?: boolean } = {},
): {
  role: SQL<Role | null>;
  source: SQL<AccessSource | null>;
  directRole: SQL<CollaboratorRole | null>;
  folderRole: SQL<CollaboratorRole | null>;
  folderLinkRole: SQL<Role | null>;
} {
  const login = loginSql(user?.login ?? null);
  const owner =
    user?.id != null
      ? sql<boolean>`${doc.ownerId} = ${user.id}`
      : login
        ? sql<boolean>`exists (
            select 1 from ${schema.users}
            where ${schema.users.id} = ${doc.ownerId}
              and lower(${schema.users.login}) = ${login}
          )`
        : sql<boolean>`false`;
  const directRole = login
    ? sql<CollaboratorRole | null>`(
        select ${schema.collaborators.role}
        from ${schema.collaborators}
        where ${schema.collaborators.documentId} = ${doc.id}
          and lower(${schema.collaborators.login}) = ${login}
        limit 1
      )`
    : sql<CollaboratorRole | null>`null`;
  const folderRole = login
    ? sql<CollaboratorRole | null>`(
        select ${schema.folderCollaborators.role}
        from ${schema.folderCollaborators}
        where ${schema.folderCollaborators.folderId} = ${doc.folderId}
          and lower(${schema.folderCollaborators.login}) = ${login}
        limit 1
      )`
    : sql<CollaboratorRole | null>`null`;
  const linkRole =
    includeLink
      ? user?.signedIn
        ? sql<Role | null>`case ${doc.linkAccess}
            when 'view' then 'viewer'
            when 'comment' then 'commenter'
            when 'edit' then 'editor'
            else null
          end`
        : sql<Role | null>`case when ${doc.linkAccess} = 'private' then null else 'viewer' end`
      : sql<Role | null>`null`;
  const folderLinkAccess = sql<LinkAccess | null>`(select ${schema.folders.linkAccess} from ${schema.folders} where ${schema.folders.id} = ${doc.folderId})`;
  const folderLinkRole = !includeLink
    ? sql<Role | null>`null`
    : user?.signedIn
      ? sql<Role | null>`case ${folderLinkAccess} when 'view' then 'viewer' when 'comment' then 'commenter' when 'edit' then 'editor' else null end`
      : sql<Role | null>`case when ${folderLinkAccess} in ('view', 'comment', 'edit') then 'viewer' else null end`;

  const role = sql<Role | null>`case
    when ${owner} then 'owner'
    when ${directRole} = 'editor' or ${folderRole} = 'editor' or ${linkRole} = 'editor' or ${folderLinkRole} = 'editor' then 'editor'
    when ${directRole} = 'commenter' or ${folderRole} = 'commenter' or ${linkRole} = 'commenter' or ${folderLinkRole} = 'commenter' then 'commenter'
    when ${directRole} = 'viewer' or ${folderRole} = 'viewer' or ${linkRole} = 'viewer' or ${folderLinkRole} = 'viewer' then 'viewer'
    else null
  end`;
  const source = sql<AccessSource | null>`case
    when ${owner} then 'owner'
    when ${directRole} = 'editor' then 'collaborator'
    when ${folderRole} = 'editor' then 'folder'
    when ${linkRole} = 'editor' then 'link'
    when ${folderLinkRole} = 'editor' then 'folder-link'
    when ${directRole} = 'commenter' then 'collaborator'
    when ${folderRole} = 'commenter' then 'folder'
    when ${linkRole} = 'commenter' then 'link'
    when ${folderLinkRole} = 'commenter' then 'folder-link'
    when ${directRole} = 'viewer' then 'collaborator'
    when ${folderRole} = 'viewer' then 'folder'
    when ${linkRole} = 'viewer' then 'link'
    when ${folderLinkRole} = 'viewer' then 'folder-link'
    else null
  end`;

  return { role, source, directRole, folderRole, folderLinkRole };
}

function normalizeLogin(login: string | null | undefined): string | null {
  const normalized = login?.trim().replace(/^@/, "").toLowerCase() ?? "";
  return normalized || null;
}

function loginSql(login: string | SQLWrapper | null): SQL | null {
  if (typeof login === "string") {
    const normalized = normalizeLogin(login);
    return normalized ? sql`${normalized}` : null;
  }
  return login ? sql`lower(${login})` : null;
}
