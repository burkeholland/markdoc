// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { SignInLinkContent } from "./sign-in-link-content";

let pending = false;
vi.mock("next/link", () => ({ useLinkStatus: () => ({ pending }) }));

afterEach(() => {
  pending = false;
  cleanup();
});

it("updates the existing status and restores the label when navigation ends", () => {
  const view = render(<SignInLinkContent>Get started</SignInLinkContent>);
  const status = screen.getByRole("status");
  expect(status).toBeEmptyDOMElement();
  expect(screen.getByText("Get started")).toBeVisible();

  pending = true;
  view.rerender(<SignInLinkContent>Get started</SignInLinkContent>);
  expect(screen.getByRole("status")).toBe(status);
  expect(status).toHaveTextContent("Opening sign-in…");
  expect(screen.getByText("Opening sign-in…", { selector: '[aria-hidden="true"]' })).toBeVisible();
  expect(screen.getByText("Get started")).not.toBeVisible();

  pending = false;
  view.rerender(<SignInLinkContent>Get started</SignInLinkContent>);
  expect(status).toBeEmptyDOMElement();
  expect(screen.getByText("Get started")).toBeVisible();
});
