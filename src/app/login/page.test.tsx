import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const authMocks = vi.hoisted(() => ({
  auth: vi.fn(),
  signIn: vi.fn(),
}));

vi.mock("@/auth", () => ({
  auth: authMocks.auth,
  signIn: authMocks.signIn,
  devLoginEnabled: true,
  githubConfigured: true,
}));
vi.mock("@/components/ui/logo", () => ({ Logo: () => null }));
// The page waits for its link-preview card (see src/server/link-preview.test.ts); no document has one here.
vi.mock("@/server/document-metadata", () => ({ signInPreviewMetadata: vi.fn(async () => null) }));
// The page is rendered outside a Next request scope here; `embeddedDocumentPath` reads request
// headers to look for a canvas session cookie, so give it an empty request like the API tests do.
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));

import LoginPage, { generateMetadata } from "./page";
import { signInPreviewMetadata } from "@/server/document-metadata";

type ElementProps = {
  action?: (formData: FormData) => Promise<unknown>;
  children?: ReactNode;
  "data-testid"?: string;
};

function findForm(node: ReactNode, testId: string): ReactElement<ElementProps> | null {
  if (!isValidElement<ElementProps>(node)) return null;
  if (node.type === "form" && containsTestId(node, testId)) return node;

  for (const child of Children.toArray(node.props.children)) {
    const form = findForm(child, testId);
    if (form) return form;
  }
  return null;
}

function containsTestId(node: ReactNode, testId: string): boolean {
  if (!isValidElement<ElementProps>(node)) return false;
  if (node.props["data-testid"] === testId) return true;
  return Children.toArray(node.props.children).some((child) => containsTestId(child, testId));
}

function pageProps(next: string) {
  const props: Parameters<typeof LoginPage>[0] = {
    params: Promise.resolve({}),
    searchParams: Promise.resolve({ next }),
  };
  return props;
}

afterEach(() => {
  authMocks.auth.mockReset();
  authMocks.signIn.mockReset();
  vi.mocked(signInPreviewMetadata).mockClear();
});

describe("LoginPage return paths", () => {
  it.each([
    ["/settings", "/settings"],
    ["//example.invalid/path", "/"],
    ["/%2Fexample.invalid/path", "/"],
  ])("uses %j as an authenticated redirect Location only after validation", async (next, expected) => {
    authMocks.auth.mockResolvedValue({ user: { id: "user-1" } });

    await expect(LoginPage(pageProps(next))).rejects.toMatchObject({
      digest: `NEXT_REDIRECT;replace;${expected};307;`,
    });
  });

  it.each([
    ["/d/document-1?mode=focus#comments", "/d/document-1?mode=focus#comments"],
    ["/\\example.invalid/path", "/"],
  ])("uses the same validated path for GitHub and development sign-in", async (next, expected) => {
    authMocks.auth.mockResolvedValue(null);
    const page = await LoginPage(pageProps(next));
    const githubAction = findForm(page, "github-signin")?.props.action;
    const devAction = findForm(page, "dev-login-submit")?.props.action;
    const formData = new FormData();
    formData.set("login", "alice");

    expect(githubAction).toBeTypeOf("function");
    expect(devAction).toBeTypeOf("function");
    await githubAction!(formData);
    await devAction!(formData);

    expect(authMocks.signIn).toHaveBeenNthCalledWith(1, "github", { redirectTo: expected });
    expect(authMocks.signIn).toHaveBeenNthCalledWith(2, "dev", { login: "alice", redirectTo: expected });
  });

  // Waiting for the card in the body keeps its tags in <head> for crawlers Next.js does not block for (Teams).
  it.each([
    ["/d/document-1?mode=focus#comments", "/d/document-1?mode=focus#comments"],
    ["//example.invalid/d/document-1", "/"],
  ])("waits for the link-preview card of the validated return path %j", async (next, expected) => {
    authMocks.auth.mockResolvedValue(null);
    await LoginPage(pageProps(next));
    expect(signInPreviewMetadata).toHaveBeenCalledWith(expected);
  });
});

describe("LoginPage metadata", () => {
  const SIGN_IN_DESCRIPTION = "Sign in to Markdoc, the collaborative Markdown editor for people and AI agents.";

  it("is the plain sign-in title and description when the return path has no link-preview card", async () => {
    await expect(generateMetadata(pageProps("/settings"))).resolves.toEqual({ title: "Sign in", description: SIGN_IN_DESCRIPTION });
    expect(signInPreviewMetadata).toHaveBeenCalledWith("/settings");
  });

  it("carries the card of the validated return path, under the page's own title", async () => {
    vi.mocked(signInPreviewMetadata).mockResolvedValueOnce({
      title: "Board memo",
      description: "Q3 numbers and the hiring plan.",
      openGraph: { title: "Board memo", url: "/d/document-1" },
    });
    await expect(generateMetadata(pageProps("/d/document-1"))).resolves.toEqual({
      title: "Sign in",
      description: "Q3 numbers and the hiring plan.",
      openGraph: { title: "Board memo", url: "/d/document-1" },
    });
    expect(signInPreviewMetadata).toHaveBeenCalledWith("/d/document-1");
  });

  it("looks up the fallback path, never the raw one, when the return path fails validation", async () => {
    await generateMetadata(pageProps("/\\example.invalid/d/document-1"));
    expect(signInPreviewMetadata).toHaveBeenCalledWith("/");
  });
});
