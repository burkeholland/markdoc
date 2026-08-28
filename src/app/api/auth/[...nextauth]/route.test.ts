import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const authPost = vi.fn(async () => new Response(null, {
  status: 302,
  headers: { location: "http://localhost:3700/" },
}));

vi.mock("@/auth", () => ({
  handlers: {
    GET: vi.fn(),
    POST: authPost,
  },
}));

const {
  EMBED_SESSION_COOKIE,
  SECURE_EMBED_SESSION_COOKIE,
} = await import("@/server/session-cookie");
const { POST } = await import("./route");

beforeEach(() => authPost.mockClear());

describe("Auth.js route embed cleanup", () => {
  it("clears both embed-cookie variants when the user signs out", async () => {
    const response = await POST(new NextRequest("http://localhost:3700/api/auth/signout", {
      method: "POST",
    }));
    const cookies = response.headers.getSetCookie();
    expect(cookies.some((cookie) => cookie.startsWith(`${EMBED_SESSION_COOKIE}=`) && /Max-Age=0/i.test(cookie))).toBe(true);
    expect(cookies.some((cookie) => cookie.startsWith(`${SECURE_EMBED_SESSION_COOKIE}=`) && /Max-Age=0/i.test(cookie) && /Secure/i.test(cookie))).toBe(true);
  });

  it("does not clear an embed session for unrelated Auth.js actions", async () => {
    const response = await POST(new NextRequest("http://localhost:3700/api/auth/callback/dev", {
      method: "POST",
    }));
    expect(response.headers.getSetCookie()).toEqual([]);
  });
});
