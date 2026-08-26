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
vi.mock("@/components/editor/header", () => ({ Logo: () => null }));
vi.mock("@/components/ui/primitives", () => ({ GitHubIcon: () => null }));

import LoginPage from "./page";

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
});
