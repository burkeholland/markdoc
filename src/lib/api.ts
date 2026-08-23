import type { DocumentDto } from "@/server/dto";
import type { DocumentSummary, SearchResult } from "@/server/documents";
import type { NotificationKind, Role } from "@/server/db/schema";

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public issues?: unknown,
    /** The full error body (sync 409s carry `status`, `remoteContent`, `merged`, `conflicts`). */
    public body?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export type SyncState = "in-sync" | "local-ahead" | "remote-ahead" | "diverged";
export interface SyncStatusDto {
  status: SyncState;
  remote: { sha: string | null; revision: string | null; url: string | null; updatedAt: string | null };
  localChanged: boolean;
  remoteChanged: boolean;
  lines: { local: number; remote: number };
  /** Suggested client poll interval (SYNC_POLL_MS on the server; 60 s by default). */
  pollMs?: number;
  /** Only with `?content=1`: the GitHub file as it is now. */
  remoteContent?: string;
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    credentials: "same-origin",
  });
  const text = await res.text();
  const data = text ? (JSON.parse(text) as unknown) : null;
  if (!res.ok) {
    const err = (data ?? {}) as { error?: string; issues?: unknown };
    throw new ApiError(res.status, err.error ?? res.statusText, err.issues, (data ?? undefined) as Record<string, unknown> | undefined);
  }
  return data as T;
}

export interface VersionSummary {
  id: string;
  number: number;
  title: string | null;
  kind: "auto" | "named" | "publish" | "restore" | "import";
  createdBy: string | null;
  createdByName: string | null;
  commitSha: string | null;
  createdAt: string;
  size: number;
}

export interface CollaboratorDto {
  login: string;
  role: Exclude<Role, "owner">;
  createdAt: string;
  name: string | null;
  image: string | null;
}

export interface NotificationDto {
  id: string;
  kind: NotificationKind;
  documentId: string;
  documentTitle: string;
  actorLogin: string | null;
  actorName: string | null;
  /** Thread, reply or suggestion id; `<docId>:<login>` for shares. */
  refId: string;
  snippet: string;
  createdAt: string;
  readAt: string | null;
}

export interface NotificationsPageDto {
  items: NotificationDto[];
  unreadCount: number;
}

export type ActivityActionDto =
  | "edit"
  | "comment.add"
  | "comment.resolve"
  | "suggestion.add"
  | "suggestion.accept"
  | "suggestion.reject"
  | "version.save"
  | "version.restore"
  | "publish"
  | "share.add"
  | "share.remove"
  | "asset.upload"
  | "mention"
  | "title.change"
  | "agent.request"
  | "agent.request.done";

export interface ActivityItemDto {
  id: string;
  actorId: string | null;
  actorName: string;
  actorKind: "user" | "agent";
  action: ActivityActionDto;
  detail: Record<string, unknown>;
  createdAt: string;
}

export interface ActivityPageDto {
  items: ActivityItemDto[];
  nextBefore: string | null;
}

export interface AgentRequestDto {
  id: string;
  documentId: string;
  userId: string;
  instruction: string;
  selection: { from: number; to: number; quote: string } | null;
  mode: "suggest" | "comment" | "rewrite";
  status: "open" | "claimed" | "done" | "cancelled";
  claimedBy: string | null;
  result: { suggestions: number; comments: number; summary?: string } | null;
  createdAt: string;
  updatedAt: string;
}

export type DocumentSummaryDto = Omit<DocumentSummary, "updatedAt" | "createdAt" | "lastOpenedAt" | "deletedAt"> & {
  updatedAt: string;
  createdAt: string;
  lastOpenedAt: string | null;
  deletedAt: string | null;
};
export type SearchResultDto = Omit<SearchResult, "updatedAt" | "createdAt" | "lastOpenedAt" | "deletedAt"> & {
  updatedAt: string;
  createdAt: string;
  lastOpenedAt: string | null;
  deletedAt: string | null;
};

export const api = {
  documents: {
    list: (opts: { starred?: boolean; trash?: boolean } = {}) =>
      request<{ documents: DocumentSummaryDto[] }>(`/api/documents${opts.trash ? "?trash=1" : opts.starred ? "?starred=1" : ""}`),
    search: (q: string, init?: RequestInit) =>
      request<{ documents: SearchResultDto[]; query: string }>(
        `/api/documents?q=${encodeURIComponent(q)}`,
        init,
      ),
    create: (body: { title?: string; content?: string; template?: string } = {}) =>
      request<{ document: { id: string; title: string } }>("/api/documents", { method: "POST", body: JSON.stringify(body) }),
    get: (id: string) => request<{ document: DocumentDto; role: Role }>(`/api/documents/${id}`),
    starred: (id: string) => request<{ starred: boolean }>(`/api/documents/${id}/star`),
    star: (id: string) => request<{ starred: true }>(`/api/documents/${id}/star`, { method: "PUT" }),
    unstar: (id: string) => request<{ starred: false }>(`/api/documents/${id}/star`, { method: "DELETE" }),
    patch: (id: string, body: { title?: string; linkAccess?: DocumentDto["linkAccess"] }) =>
      request<{ document: DocumentDto }>(`/api/documents/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
    /** Move to the trash; `permanent` removes the document for good (also from the trash). */
    delete: (id: string, opts: { permanent?: boolean } = {}) =>
      request<{ ok: true; permanent: boolean }>(`/api/documents/${id}${opts.permanent ? "?permanent=1" : ""}`, { method: "DELETE" }),
    restore: (id: string) => request<{ ok: true; document: DocumentDto }>(`/api/documents/${id}/restore`, { method: "POST" }),
    duplicate: (id: string) => request<{ id: string; title: string }>(`/api/documents/${id}/duplicate`, { method: "POST" }),
    collabToken: (id: string) => request<{ token: string; role: Role }>(`/api/documents/${id}/collab-token`, { method: "POST" }),
    versions: (id: string) => request<{ versions: VersionSummary[] }>(`/api/documents/${id}/versions`),
    activity: (id: string, opts: { before?: string | null; limit?: number } = {}) => {
      const q = new URLSearchParams();
      if (opts.before) q.set("before", opts.before);
      if (opts.limit) q.set("limit", String(opts.limit));
      const qs = q.toString();
      return request<ActivityPageDto>(`/api/documents/${id}/activity${qs ? `?${qs}` : ""}`);
    },
    createVersion: (id: string, title: string) =>
      request<{ version: VersionSummary }>(`/api/documents/${id}/versions`, { method: "POST", body: JSON.stringify({ title }) }),
    version: (id: string, vid: string) => request<{ version: VersionSummary & { content: string } }>(`/api/documents/${id}/versions/${vid}`),
    restoreVersion: (id: string, vid: string) =>
      request<{ ok: true }>(`/api/documents/${id}/versions/${vid}`, { method: "POST", body: JSON.stringify({ action: "restore" }) }),
    renameVersion: (id: string, vid: string, title: string) =>
      request<{ ok: true }>(`/api/documents/${id}/versions/${vid}`, { method: "POST", body: JSON.stringify({ action: "rename", title }) }),
    copyVersion: (id: string, vid: string) => request<{ id: string; title: string }>(`/api/documents/${id}/versions/${vid}/copy`, { method: "POST" }),
    collaborators: (id: string) =>
      request<{ owner: { login: string | null; name: string | null; image: string | null } | null; linkAccess: DocumentDto["linkAccess"]; collaborators: CollaboratorDto[] }>(
        `/api/documents/${id}/collaborators`,
      ),
    addCollaborator: (id: string, login: string, role: Exclude<Role, "owner">) =>
      request<{ ok: true; login: string }>(`/api/documents/${id}/collaborators`, { method: "POST", body: JSON.stringify({ login, role }) }),
    removeCollaborator: (id: string, login: string) =>
      request<{ ok: true }>(`/api/documents/${id}/collaborators`, { method: "DELETE", body: JSON.stringify({ login }) }),
    publish: (id: string, message?: string, options: { force?: boolean } = {}) =>
      request<{ result: { url: string | null; commitSha: string | null; publishedAt: string; skipped?: boolean; status: SyncState }; document: DocumentDto | null }>(
        `/api/documents/${id}/publish${options.force ? "?force=1" : ""}`,
        { method: "POST", body: JSON.stringify({ message }) },
      ),
    pull: (id: string, options: { force?: boolean; merge?: boolean } = {}) => {
      const q = [options.force && "force=1", options.merge && "merge=1"].filter(Boolean).join("&");
      return request<{ result: { changed: boolean; url: string | null; status: SyncState; merged?: boolean }; document: DocumentDto | null }>(
        `/api/documents/${id}/pull${q ? `?${q}` : ""}`,
        { method: "POST" },
      );
    },
    sync: (id: string, options: { fresh?: boolean; content?: boolean } = {}) => {
      const q = [options.fresh && "fresh=1", options.content && "content=1"].filter(Boolean).join("&");
      return request<SyncStatusDto>(`/api/documents/${id}/sync${q ? `?${q}` : ""}`);
    },
    link: (id: string, body: Record<string, unknown>) =>
      request<{ document: DocumentDto }>(`/api/documents/${id}/link`, { method: "POST", body: JSON.stringify(body) }),
    comment: (id: string, body: Record<string, unknown>) =>
      request<{ id?: string }>(`/api/documents/${id}/comments`, { method: "POST", body: JSON.stringify(body) }),
    requests: (id: string, opts: { status?: string[] } = {}) =>
      request<{ requests: AgentRequestDto[] }>(`/api/documents/${id}/requests${opts.status?.length ? `?status=${opts.status.join(",")}` : ""}`),
    createRequest: (id: string, body: { instruction: string; selection?: { from: number; to: number; quote: string } | null; mode: AgentRequestDto["mode"] }) =>
      request<{ request: AgentRequestDto }>(`/api/documents/${id}/requests`, { method: "POST", body: JSON.stringify(body) }),
    cancelRequest: (id: string, rid: string) => request<{ request: AgentRequestDto }>(`/api/documents/${id}/requests/${rid}/cancel`, { method: "POST" }),
  },
  tokens: {
    list: () => request<{ tokens: unknown[] }>("/api/tokens"),
  },
  github: {
    gists: () =>
      request<{
        gists: { id: string; description: string | null; public: boolean; updatedAt: string; htmlUrl: string; files: { filename: string; language: string | null; size: number }[] }[];
      }>("/api/github/gists"),
    repos: () =>
      request<{
        repos: { owner: string; name: string; fullName: string; private: boolean; defaultBranch: string; pushedAt: string | null; htmlUrl: string; description: string | null }[];
      }>("/api/github/repos"),
    branches: (owner: string, repo: string) => request<{ branches: string[] }>(`/api/github/repos/${owner}/${repo}/branches`),
    files: (owner: string, repo: string, ref: string) =>
      request<{ files: { path: string; size?: number; sha: string }[] }>(`/api/github/repos/${owner}/${repo}/files?ref=${encodeURIComponent(ref)}`),
  },
  import: (body: Record<string, unknown>) => request<{ document: { id: string; title: string } }>("/api/import", { method: "POST", body: JSON.stringify(body) }),
  notifications: {
    list: (opts: { unread?: boolean; limit?: number } = {}) => {
      const q = new URLSearchParams();
      if (opts.unread) q.set("unread", "1");
      if (opts.limit) q.set("limit", String(opts.limit));
      const qs = q.toString();
      return request<NotificationsPageDto>(`/api/notifications${qs ? `?${qs}` : ""}`);
    },
    read: (id: string) => request<{ ok: true; changed: boolean }>(`/api/notifications/${id}/read`, { method: "POST" }),
    readAll: () => request<{ ok: true; count: number }>("/api/notifications/read-all", { method: "POST" }),
    readRefs: (documentId: string, refIds: string[]) =>
      request<{ ok: true; count: number }>("/api/notifications/thread-read", { method: "POST", body: JSON.stringify({ documentId, refIds }) }),
  },
};

export interface UploadedAsset {
  id: string;
  url: string;
  name: string;
  mime: string;
  size: number;
  /** Suggested alt text (the file name without its extension). */
  alt: string;
}

/** Upload an image for a document; the returned `url` is what goes into `![alt](url)`. */
export async function uploadAsset(documentId: string, file: File): Promise<UploadedAsset> {
  const form = new FormData();
  form.append("file", file, file.name);
  const res = await fetch(`/api/documents/${documentId}/assets`, { method: "POST", body: form, credentials: "same-origin" });
  const text = await res.text();
  const data = text ? (JSON.parse(text) as unknown) : null;
  if (!res.ok) {
    const err = (data ?? {}) as { error?: string; issues?: unknown };
    throw new ApiError(res.status, err.error ?? res.statusText, err.issues);
  }
  return data as UploadedAsset;
}
