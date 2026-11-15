// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { DocumentSummaryDto } from "@/lib/api";

const listDocuments = vi.fn<(options?: { trash?: boolean }) => Promise<{ documents: DocumentSummaryDto[] }>>();
const restoreDocument = vi.fn<(id: string) => Promise<{ ok: true }>>();
const router = { push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn(), back: vi.fn(), forward: vi.fn() };

vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("@/components/dashboard/notifications-strip", () => ({ NotificationsStrip: () => null }));
vi.mock("@/components/ui/theme-toggle", () => ({ ThemeToggle: () => null }));
vi.mock("@/lib/notice", () => ({ takePendingNotice: () => null }));
vi.mock("@/lib/sign-out", () => ({ signOutSafely: () => Promise.resolve(true) }));
vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      documents: {
        ...actual.api.documents,
        search: async (query: string) => ({ query, documents: [] }),
        list: (options?: { trash?: boolean }) => listDocuments(options),
        restore: (id: string) => restoreDocument(id),
      },
      folders: { ...actual.api.folders, list: async () => ({ folders: [] }) },
    },
  };
});

import { Dashboard } from "./dashboard";

const USER = { id: "owner", name: "Owner", login: "owner", image: null };
const doc = (id: string, title: string, deletedAt: string | null = null): DocumentSummaryDto => ({
  id,
  title,
  excerpt: "",
  storage: "local",
  updatedAt: "2026-09-07T12:00:00.000Z",
  createdAt: "2026-09-01T12:00:00.000Z",
  lastOpenedAt: null,
  deletedAt,
  ownerId: USER.id,
  ownerName: USER.name,
  ownerLogin: USER.login,
  role: "owner",
  repoOwner: null,
  repoName: null,
  repoPath: null,
  gistId: null,
  starred: false,
  folderId: null,
  folderName: null,
});

beforeEach(() => {
  Object.defineProperty(Element.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
  listDocuments.mockReset();
  listDocuments.mockResolvedValue({ documents: [doc("t1", "Trashed", "2026-09-07T13:00:00.000Z")] });
  restoreDocument.mockReset();
  restoreDocument.mockResolvedValue({ ok: true });
});
afterEach(() => cleanup());

const renderDashboard = () =>
  render(<Dashboard user={USER} documents={[doc("a", "Alpha"), doc("b", "Beta")]} githubAvailable githubConfigured />);

it("sidebar views respond to real clicks and keyboard activation", async () => {
  const user = userEvent.setup();
  renderDashboard();
  await user.click(screen.getByTestId("filter-shared"));
  expect(screen.getByTestId("filter-shared")).toHaveAttribute("aria-current", "page");
  screen.getByTestId("filter-all").focus();
  await user.keyboard("{Enter}");
  expect(screen.getByTestId("filter-all")).toHaveAttribute("aria-current", "page");
  expect(screen.getByTestId("filter-shared")).not.toHaveAttribute("aria-current");
});

it("restores a trashed document with a real click and moves between trash actions by keyboard", async () => {
  const user = userEvent.setup();
  renderDashboard();
  await user.click(screen.getByTestId("filter-trash"));
  const card = await screen.findByTestId("trash-card");
  within(card).getByTestId("restore-button").focus();
  await user.keyboard("{ArrowRight}");
  expect(within(card).getByTestId("purge-button")).toHaveFocus();
  await user.keyboard("{ArrowRight}");
  expect(within(card).getByTestId("purge-button")).toHaveFocus();
  await user.click(within(card).getByTestId("restore-button"));
  await waitFor(() => expect(restoreDocument).toHaveBeenCalledExactlyOnceWith("t1"));
});

it("ArrowDown on the account trigger opens the menu on its first item, ArrowUp on its last", async () => {
  const user = userEvent.setup();
  renderDashboard();
  const trigger = screen.getByRole("button", { name: "Account" });
  trigger.focus();
  await user.keyboard("{ArrowDown}");
  await waitFor(() => expect(screen.getByRole("menuitem", { name: "Settings" })).toHaveFocus());
  await user.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  trigger.focus();
  await user.keyboard("{ArrowUp}");
  await waitFor(() => expect(screen.getByRole("menuitem", { name: "Sign out" })).toHaveFocus());
});
