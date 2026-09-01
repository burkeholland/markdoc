import { readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ID_PLACEHOLDER,
  looksLikeId,
  OTHER_PLACEHOLDER,
  requestPath,
  ROUTE_SHAPE_MAX_LENGTH,
  routeShape,
  STATIC_SEGMENTS,
} from "./route-shape";

// Real shapes from the app: a document/version/token/webhook id (nanoid, 12 × [0-9a-z]), an asset id
// (16 × [0-9a-z]), newId() (16 hex), a user id (UUID), the embed handoff nonce (43 base64url chars).
const DOCUMENT_ID = "k3j9x0v2m8qa";
const DOCUMENT_ID_NO_DIGITS = "abcdefghijkl";
const ASSET_ID = "q7w2e9r4t1y6u3i8";
const NEW_ID = "3f2a9c8b1d4e6f70";
const UUID = "6f1d2c3b-4a5e-4f60-8a9b-0c1d2e3f4a5b";
const NONCE = "Zm9vYmFyYmF6cXV4cXV1eHF1dXhxdXV4cXV1eA";

describe("routeShape", () => {
  it("replaces a UUID segment with :id", () => {
    expect(routeShape(`/api/users/${UUID}`)).toBe("/api/users/:id");
    expect(routeShape(`/api/users/${UUID.toUpperCase()}`)).toBe("/api/users/:id");
  });

  it("replaces a hex id (newId(), 16 hex chars) with :id", () => {
    expect(routeShape(`/api/notifications/${NEW_ID}/read`)).toBe("/api/notifications/:id/read");
    expect(routeShape(`/api/documents/${DOCUMENT_ID}/requests/${NEW_ID}/claim`)).toBe("/api/documents/:id/requests/:id/claim");
  });

  it("replaces an all-digit segment with :id", () => {
    expect(routeShape("/api/documents/12345/versions/7")).toBe("/api/documents/:id/versions/:id");
  });

  it("drops the query string and any fragment", () => {
    expect(routeShape(`/api/documents/${DOCUMENT_ID}/export?format=pdf&token=secret`)).toBe("/api/documents/:id/export");
    expect(routeShape("/api/health?probe=live")).toBe("/api/health");
    expect(routeShape("/login?callbackUrl=%2Fd%2Fabc#x")).toBe("/login");
    expect(routeShape("/?x=1")).toBe("/");
  });

  it("turns a login-like segment into :x, never emitting it", () => {
    expect(routeShape("/api/github/repos/octocat/hello-world/branches")).toBe("/api/github/repos/:x/:x/branches");
    const shape = routeShape("/api/github/users/burke.holland@example.com");
    expect(shape).toBe("/api/github/users/:x");
    expect(shape).not.toContain("burke");
  });

  it("keeps the static segments of the API tree", () => {
    expect(routeShape(`/api/documents/${DOCUMENT_ID}/collaborators`)).toBe("/api/documents/:id/collaborators");
    expect(routeShape("/api/notifications/read-all")).toBe("/api/notifications/read-all");
    expect(routeShape("/api/embed/handoff")).toBe("/api/embed/handoff");
    expect(routeShape("/api/mcp")).toBe("/api/mcp");
    expect(routeShape("/api/auth/callback/github")).toBe("/api/auth/callback/github");
    expect(routeShape("/api/admin/backup")).toBe("/api/admin/backup");
    expect(routeShape("/_standby/takeover")).toBe("/_standby/takeover");
  });

  it("covers every id shape the app hands out", () => {
    expect(routeShape(`/d/${DOCUMENT_ID}`)).toBe("/d/:id");
    expect(routeShape(`/p/${DOCUMENT_ID_NO_DIGITS}`)).toBe("/p/:id");
    expect(routeShape(`/api/assets/${ASSET_ID}`)).toBe("/api/assets/:id");
    expect(routeShape(`/api/documents/${DOCUMENT_ID}/versions/${DOCUMENT_ID}/copy`)).toBe("/api/documents/:id/versions/:id/copy");
    expect(routeShape(`/api/tokens/${DOCUMENT_ID}`)).toBe("/api/tokens/:id");
    expect(routeShape(`/api/webhooks/${DOCUMENT_ID}/test`)).toBe("/api/webhooks/:id/test");
    expect(routeShape(`/api/mentions/${NEW_ID}/read`)).toBe("/api/mentions/:id/read");
    expect(routeShape(`/api/agent/documents/${DOCUMENT_ID}/presence`)).toBe("/api/agent/documents/:id/presence");
    expect(routeShape(`/embed/${NONCE}`)).toBe("/embed/:id");
  });

  it("keeps the opengraph-image file route (the social card) as a static segment after an id", () => {
    expect(routeShape(`/d/${DOCUMENT_ID}/opengraph-image?v=3`)).toBe("/d/:id/opengraph-image");
    expect(routeShape(`/p/${DOCUMENT_ID_NO_DIGITS}/opengraph-image`)).toBe("/p/:id/opengraph-image");
  });

  it("caps the shape at 120 characters and marks the cut", () => {
    const shape = routeShape(`/api/documents/${"x/".repeat(200)}`);
    expect(shape.length).toBe(ROUTE_SHAPE_MAX_LENGTH);
    expect(shape.endsWith("...")).toBe(true);
    expect(shape.startsWith("/api/documents/:x/:x/")).toBe(true);
    expect(ROUTE_SHAPE_MAX_LENGTH).toBe(120);
  });

  it("returns / for the root and for an empty target", () => {
    expect(routeShape("/")).toBe("/");
    expect(routeShape("")).toBe("/");
    expect(routeShape("///")).toBe("/");
  });

  it("drops empty segments and a trailing slash", () => {
    expect(routeShape("/api/health/")).toBe("/api/health");
    expect(routeShape("/api//health")).toBe("/api/health");
  });

  it("uses the path of an absolute-form request target", () => {
    expect(routeShape("http://example.test/api/health?x=1")).toBe("/api/health");
    expect(routeShape("http://example.test")).toBe("/");
    expect(requestPath("https://h/a/b?c")).toBe("/a/b");
  });

  it("hides percent-encoded, dotted and mixed-case unknown segments behind :x", () => {
    expect(routeShape("/api/documents/%E2%9C%93/content")).toBe("/api/documents/:x/content");
    expect(routeShape("/_next/static/chunks/app-1a2b3c4d5e6f.js")).toBe("/_next/static/chunks/:x");
    expect(routeShape("/API/Health")).toBe("/:x/:x");
    expect(routeShape("/.well-known/appspecific/com.chrome.devtools.json")).toBe("/:x/:x/:x");
  });

  it("never lets a title, e-mail or token through", () => {
    const secrets = ["My%20Secret%20Plan", "someone@example.com", "ghp_abcdefghijklmnopqrstuvwxyz0123456789", "Bearer"];
    for (const secret of secrets) {
      const shape = routeShape(`/api/documents/${secret}`);
      expect(shape.startsWith("/api/documents/")).toBe(true);
      expect(shape).not.toContain(secret);
      expect([ID_PLACEHOLDER, OTHER_PLACEHOLDER]).toContain(shape.slice("/api/documents/".length));
    }
  });
});

describe("looksLikeId", () => {
  it.each([UUID, NEW_ID, "0123456789ab", "42", DOCUMENT_ID, DOCUMENT_ID_NO_DIGITS, ASSET_ID, NONCE, "a".repeat(64)])("%s is an id", (segment) => {
    expect(looksLikeId(segment)).toBe(true);
  });

  it.each(["documents", "collaborators", "read-all", "octocat", "hello-world", "abc", "abc-123", "0123456789a", "deadbeef", "Zm9v", "x.js"])(
    "%s is not an id",
    (segment) => {
      expect(looksLikeId(segment)).toBe(false);
    },
  );
});

describe("STATIC_SEGMENTS", () => {
  // Next's metadata file routes: `opengraph-image.tsx` in a route folder serves `<folder>/opengraph-image`
  // (the social card under /d/[id] and /p/[id]); the same goes for icon, apple-icon, twitter-image,
  // sitemap, robots and manifest. The path segment is the file name up to its first dot.
  const FILE_ROUTE = /^(opengraph-image|twitter-image|icon|apple-icon|sitemap|robots|manifest)(\.[a-z0-9]+)*\.(tsx?|jsx?)$/;

  // The allow-list is closed by design: a segment that is not on it shows up as :x in the log. This keeps
  // the list honest in the other direction — every static folder under src/app/api and src/app is on it,
  // and so is every file route, which a folder walk alone cannot see (it is a file, not a folder).
  function staticSegments(root: string): { folders: string[]; fileRoutes: string[] } {
    const folders: string[] = [];
    const fileRoutes = new Set<string>();
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          if (!entry.name.startsWith("[")) folders.push(entry.name);
          walk(path.join(dir, entry.name));
        } else if (FILE_ROUTE.test(entry.name)) {
          fileRoutes.add(entry.name.slice(0, entry.name.indexOf(".")));
        }
      }
    };
    walk(root);
    return { folders, fileRoutes: [...fileRoutes] };
  }

  const APP_ROOT = path.resolve(__dirname, "../src/app");

  it("lists every static folder under src/app (the API tree included)", () => {
    const missing = staticSegments(APP_ROOT).folders.filter((name) => !STATIC_SEGMENTS.has(name));
    expect(missing).toEqual([]);
  });

  it("lists every Next file route under src/app (opengraph-image.tsx serves /d/:id/opengraph-image)", () => {
    const { fileRoutes } = staticSegments(APP_ROOT);
    // The social card exists today; this guards the walk itself against a regex that matches nothing.
    expect(fileRoutes).toContain("opengraph-image");
    const missing = fileRoutes.filter((name) => !STATIC_SEGMENTS.has(name));
    expect(missing).toEqual([]);
  });

  it("wins over the id heuristic, so a static segment is never redacted", () => {
    for (const segment of STATIC_SEGMENTS) expect(routeShape(`/${segment}`)).toBe(`/${segment}`);
  });
});
