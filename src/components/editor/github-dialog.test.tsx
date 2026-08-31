// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const signIn = vi.fn(() => new Promise<void>(() => {}));
vi.mock("next-auth/react", () => ({ signIn: (...args: unknown[]) => signIn(...(args as [])) }));

import { GitHubPicker } from "./github-dialog";
import { GITHUB_NOT_CONFIGURED } from "./labels";

// The empty state of the GitHub picker for an account without a GitHub token (#162): it used to be a
// sentence with no control, so every non-GitHub account dead-ended on Close.
describe("GitHubPicker without a GitHub token", () => {
  afterEach(() => {
    cleanup();
    signIn.mockClear();
  });

  it("offers Sign in with GitHub that returns to the current page when the server has a GitHub OAuth app", () => {
    render(<GitHubPicker mode="import" githubAvailable={false} githubConfigured />);
    const button = screen.getByRole("button", { name: /Sign in with GitHub/ });
    expect(screen.queryByTestId("github-not-configured")).toBeNull();
    expect(screen.queryByTestId("github-picker")).toBeNull();

    fireEvent.click(button);
    expect(signIn).toHaveBeenCalledTimes(1);
    expect(signIn).toHaveBeenCalledWith("github", { redirectTo: window.location.href });
    expect(button).toBeDisabled();
  });

  it("says GitHub storage is not set up, with no sign-in button, when the server has no GitHub OAuth app", () => {
    render(<GitHubPicker mode="link" githubAvailable={false} githubConfigured={false} />);
    expect(screen.getByTestId("github-not-configured")).toHaveTextContent(GITHUB_NOT_CONFIGURED);
    expect(screen.getByTestId("github-not-configured")).toHaveTextContent("AUTH_GITHUB_ID");
    expect(screen.queryByRole("button")).toBeNull();
    expect(signIn).not.toHaveBeenCalled();
  });
});
