// Route shape for the request log line (server/request-log.ts): the request path with every id
// replaced by `:id` and every segment that is not a known static segment by `:x`, so the lines can be
// grouped by route and never carry a login, an e-mail address, a document title or a token.
//
// The rule, applied segment by segment after the query string and fragment are dropped:
//   1. A segment on the STATIC_SEGMENTS allow-list is kept verbatim. The list is the set of folder
//      names under src/app/api that are not `[param]` folders, plus the page routes under src/app, the
//      Auth.js actions behind `/api/auth/[...nextauth]`, the files under public/, Next's `/_next/…`
//      asset prefixes and the custom server's own paths (`/collab`, `/_standby/takeover`) — and Next's
//      metadata file routes (`opengraph-image.tsx` today, which serves `/d/<id>/opengraph-image` and
//      `/p/<id>/opengraph-image`): a file, not a folder, so the folder walk in route-shape.test.ts
//      cannot see it and its own file-route walk keeps this part of the list honest.
//   2. A segment that looks like an id becomes `:id`. The shapes this app hands out: a UUID (users,
//      webhook deliveries), 12+ hex characters (`newId()` in src/editor/collab/shared.ts — notification,
//      activity, review and agent-request ids are 16), all digits, a base64url-ish token of 16+
//      characters (asset ids are 16 × [0-9a-z]; the embed handoff nonce is 43 base64url characters;
//      a leaked bearer token would land here too), and exactly 12 × [0-9a-z] (nanoid with the 0-9a-z
//      alphabet in src/server/documents.ts, tokens.ts and webhooks.ts: document, version, API-token and
//      webhook ids).
//   3. Anything else becomes `:x`: a GitHub owner or repository name (`/api/github/repos/[owner]/[repo]`),
//      a login, a mistyped path, an unknown Auth.js action, a percent-encoded segment. An unknown
//      segment is never emitted, so a new route shows up as `:x` until its folder name is added to the
//      list below — that is the safe failure mode, and the reason the list is closed rather than a
//      "looks like a word" heuristic.
// A 12-letter login is indistinguishable from a document id and lands as `:id` rather than `:x`; both
// are redacted, so the distinction only affects grouping. Segments are matched case-sensitively, as
// Next routes them; empty segments (`//`, a trailing slash) are dropped. The shape is capped at
// ROUTE_SHAPE_MAX_LENGTH characters (the cut is marked with `...`) so a runaway path cannot flood a line.

/** Longest shape emitted; longer ones are cut and end in `...`. */
export const ROUTE_SHAPE_MAX_LENGTH = 120;

/** Placeholder for a segment that matched one of the id shapes. */
export const ID_PLACEHOLDER = ":id";

/** Placeholder for a segment that is neither a known static segment nor an id. */
export const OTHER_PLACEHOLDER = ":x";

/**
 * Every static path segment the app answers, and nothing else. Kept sorted within each group so a
 * new route folder is easy to add next to its siblings.
 */
export const STATIC_SEGMENTS: ReadonlySet<string> = new Set([
  // src/app/api — top level
  "api",
  "admin",
  "agent",
  "assets",
  "auth",
  "documents",
  "embed",
  "folders",
  "github",
  "health",
  "import",
  "mcp",
  "me",
  "mentions",
  "notifications",
  "templates",
  "tokens",
  "webhooks",
  // src/app/api/admin/*
  "backup",
  // src/app/api/agent/* and agent/documents/[id]/*
  "events",
  "presence",
  "requests",
  // src/app/api/documents/* — a static sibling of [id]; no document id can be "move" (nanoid is 12 chars)
  "move",
  // src/app/api/documents/[id]/*
  "activity",
  "collab-token",
  "collaborators",
  "comments",
  "content",
  "duplicate",
  "export",
  "gist-auto-update",
  "link",
  "publish",
  "pull",
  "restore",
  "reviews",
  "star",
  "suggest",
  "suggestions",
  "sync",
  "versions",
  // src/app/api/documents/[id]/requests/[rid]/* and versions/[vid]/*
  "cancel",
  "claim",
  "complete",
  "copy",
  // src/app/api/embed/*
  "handoff",
  "session",
  // src/app/api/github/* and github/repos/[owner]/[repo]/*
  "branches",
  "files",
  "gists",
  "mock",
  "repos",
  "users",
  // src/app/api/import/*
  "file",
  // src/app/api/mentions/[id]/* and notifications/*
  "read",
  "read-all",
  "thread-read",
  // src/app/api/tokens/[id]/*
  "replace",
  // src/app/api/webhooks/[id]/*
  "enable",
  "test",
  // src/app/api/auth/[...nextauth]: Auth.js actions and the two provider ids (src/auth.ts)
  "callback",
  "csrf",
  "dev",
  "error",
  "providers",
  "signin",
  "signout",
  "verify-request",
  // src/app pages: /, /d/[id], /embed/[nonce], /login, /p/[id], /settings
  "d",
  "login",
  "p",
  "settings",
  // src/app/d/[id]/* and p/[id]/*: Next file routes (opengraph-image.tsx → /d/:id/opengraph-image)
  "opengraph-image",
  // Files served from src/app and public/
  "favicon.ico",
  "icon.svg",
  "brand",
  "favicon.svg",
  "mark.svg",
  "og.png",
  "wordmark.svg",
  // Next's asset routes
  "_next",
  "static",
  "chunks",
  "css",
  "media",
  "image",
  // server/index.ts: the collaboration WebSocket path and the standby takeover endpoint
  "collab",
  "_standby",
  "takeover",
]);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX_ID = /^[0-9a-f]{12,}$/i;
const DIGITS = /^\d+$/;
const BASE64URL_TOKEN = /^[A-Za-z0-9_-]{16,}$/;
const NANOID_12 = /^[0-9a-z]{12}$/;

/** True for the id shapes listed in the header comment. Pure; never consults the allow-list. */
export function looksLikeId(segment: string): boolean {
  return UUID.test(segment) || HEX_ID.test(segment) || DIGITS.test(segment) || BASE64URL_TOKEN.test(segment) || NANOID_12.test(segment);
}

/** Path of a request target: drops query and fragment, and the scheme://host of an absolute-form target. */
export function requestPath(url: string): string {
  let path = url;
  const query = path.indexOf("?");
  const fragment = path.indexOf("#");
  const cut = query === -1 ? fragment : fragment === -1 ? query : Math.min(query, fragment);
  if (cut !== -1) path = path.slice(0, cut);
  const schemeEnd = path.indexOf("://");
  if (schemeEnd > 0 && /^[a-z][a-z0-9+.-]*$/i.test(path.slice(0, schemeEnd))) {
    const firstSlash = path.indexOf("/", schemeEnd + 3);
    path = firstSlash === -1 ? "/" : path.slice(firstSlash);
  }
  return path;
}

function shapeSegment(segment: string): string {
  if (STATIC_SEGMENTS.has(segment)) return segment;
  if (looksLikeId(segment)) return ID_PLACEHOLDER;
  return OTHER_PLACEHOLDER;
}

/**
 * The route shape of a request URL, e.g. `/api/documents/:id/collaborators` for
 * `/api/documents/k3j9x0v2m8qa/collaborators?after=5`. Always starts with `/`; `/` for the root.
 */
export function routeShape(url: string): string {
  const segments = requestPath(url).split("/").filter((segment) => segment.length > 0);
  if (segments.length === 0) return "/";
  const shape = `/${segments.map(shapeSegment).join("/")}`;
  if (shape.length <= ROUTE_SHAPE_MAX_LENGTH) return shape;
  return `${shape.slice(0, ROUTE_SHAPE_MAX_LENGTH - 3)}...`;
}
