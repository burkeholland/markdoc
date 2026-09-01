import { test, expect } from "./fixtures";
import { signIn } from "./helpers";

test("authenticated login redirects only to validated internal paths", async ({ browser }) => {
  const user = await signIn(browser, "login-redirect-user");

  try {
    for (const { next, location } of [
      { next: "/settings", location: "/settings" },
      { next: "/d/document-1?mode=focus#comments", location: "/d/document-1?mode=focus#comments" },
      { next: "//example.invalid/path", location: "/" },
      { next: "/\\example.invalid/path", location: "/" },
      { next: "/%2Fexample.invalid/path", location: "/" },
      { next: "/malformed%", location: "/" },
    ]) {
      const response = await user.page.request.get(`/login?next=${encodeURIComponent(next)}`, { maxRedirects: 0 });
      expect(response.status(), next).toBe(307);
      expect(response.headers().location, next).toBe(location);
    }
  } finally {
    await user.context.close();
  }
});
