import type { DocumentDto } from "@/server/dto";
import type { DocumentSummary, SearchResult } from "@/server/documents";
import type { Role } from "@/server/db/schema";

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public issues?: unknown,
  ) {
    super(message);
  }
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
    throw new ApiError(res.status, err.error ?? res.statusText, err.issues);
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

export const api = {
  documents: {
    list: () => request<{ documents: (Omit<DocumentSummary, "updatedAt" | "createdAt"> & { updatedAt: string; createdAt: string })[] }>("/api/documents"),
    search: (q: string, init?: RequestInit) =>
      request<{ documents: (Omit<SearchResult, "updatedAt" | "createdAt"> & { updatedAt: string; createdAt: string })[]; query: string }>(
        `/api/documents?q=${encodeURIComponent(q)}`,
        init,
      ),
    create: (body: { title?: string; content?: string } = {}) =>
      request<{ document: { id: string; title: string } }>("/api/documents", { method: "POST", body: JSON.stringify(body) }),
    get: (id: string) => request<{ document: DocumentDto; role: Role }>(`/api/documents/${id}`),
    patch: (id: string, body: { title?: string; linkAccess?: DocumentDto["linkAccess"] }) =>
      request<{ document: DocumentDto }>(`/api/documents/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
    delete: (id: string) => request<{ ok: true }>(`/api/documents/${id}`, { method: "DELETE" }),
    collabToken: (id: string) => request<{ token: string; role: Role }>(`/api/documents/${id}/collab-token`, { method: "POST" }),
    versions: (id: string) => request<{ versions: VersionSummary[] }>(`/api/documents/${id}/versions`),
    createVersion: (id: string, title: string) =>
      request<{ version: VersionSummary }>(`/api/documents/${id}/versions`, { method: "POST", body: JSON.stringify({ title }) }),
    version: (id: string, vid: string) => request<{ version: VersionSummary & { content: string } }>(`/api/documents/${id}/versions/${vid}`),
    restoreVersion: (id: string, vid: string) =>
      request<{ ok: true }>(`/api/documents/${id}/versions/${vid}`, { method: "POST", body: JSON.stringify({ action: "restore" }) }),
    renameVersion: (id: string, vid: string, title: string) =>
      request<{ ok: true }>(`/api/documents/${id}/versions/${vid}`, { method: "POST", body: JSON.stringify({ action: "rename", title }) }),
    collaborators: (id: string) =>
      request<{ owner: { login: string | null; name: string | null; image: string | null } | null; linkAccess: DocumentDto["linkAccess"]; collaborators: CollaboratorDto[] }>(
        `/api/documents/${id}/collaborators`,
      ),
    addCollaborator: (id: string, login: string, role: Exclude<Role, "owner">) =>
      request<{ ok: true; login: string }>(`/api/documents/${id}/collaborators`, { method: "POST", body: JSON.stringify({ login, role }) }),
    removeCollaborator: (id: string, login: string) =>
      request<{ ok: true }>(`/api/documents/${id}/collaborators`, { method: "DELETE", body: JSON.stringify({ login }) }),
    publish: (id: string, message?: string) =>
      request<{ result: { url: string | null; commitSha: string | null; publishedAt: string; skipped?: boolean }; document: DocumentDto | null }>(
        `/api/documents/${id}/publish`,
        { method: "POST", body: JSON.stringify({ message }) },
      ),
    pull: (id: string) =>
      request<{ result: { changed: boolean; url: string | null }; document: DocumentDto | null }>(`/api/documents/${id}/pull`, { method: "POST" }),
    link: (id: string, body: Record<string, unknown>) =>
      request<{ document: DocumentDto }>(`/api/documents/${id}/link`, { method: "POST", body: JSON.stringify(body) }),
    comment: (id: string, body: Record<string, unknown>) =>
      request<{ id?: string }>(`/api/documents/${id}/comments`, { method: "POST", body: JSON.stringify(body) }),
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
