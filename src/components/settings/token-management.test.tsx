// @vitest-environment jsdom
import { startTransition, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ApiTokenDto } from "@/lib/api";
import { Dialog, DialogContent } from "@/components/ui/primitives";
import { TokensPanel } from "./tokens-panel";

const copyText = vi.hoisted(() => vi.fn());
vi.mock("@/lib/clipboard", async (original) => ({ ...await original<typeof import("@/lib/clipboard")>(), copyText }));
const fetchMock = vi.fn<typeof fetch>();
const confirmMock = vi.fn<(message?: string) => boolean>();
const token: ApiTokenDto = {
  id: "token-one", name: "GitHub Copilot CLI", prefix: "hidden", scope: "comment",
  documentIds: ["doc-one"], collaboratorsMayAsk: false, createdAt: "2026-09-01T00:00:00.000Z",
  lastUsedAt: null, lastMcpSeenAt: null, lastMcpCallAt: null, expiresAt: null, revokedAt: null,
};
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const minted = () => ({ ...token, id: "token-two", token: crypto.randomUUID() });
const renderPanel = (open = true) => render(<TokensPanel origin="https://markdoc.test" userLogin="alice" open={open} />);
const mutations = () => fetchMock.mock.calls.filter(([, init]) => init?.method && init.method !== "GET");
const openCreate = async () => {
  await waitFor(() => expect(screen.getByTestId("token-add")).toBeEnabled());
  fireEvent.click(screen.getByTestId("token-add"));
};
function TransitionClosePanel() {
  const [open, setOpen] = useState(true);
  return <TokensPanel origin="https://markdoc.test" userLogin="alice" open={open} onClose={() => startTransition(() => setOpen(false))} />;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { reject, resolve, promise };
}

beforeEach(() => {
  fetchMock.mockReset();
  confirmMock.mockReset().mockReturnValue(false);
  copyText.mockReset().mockResolvedValue(true);
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("confirm", confirmMock);
  window.history.replaceState(null, "", "/");
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("visible token management", () => {
  it("keeps loading, empty and create disclosure separate, with two primary destinations", async () => {
    const pending = deferred<Response>();
    fetchMock.mockReturnValueOnce(pending.promise);
    renderPanel();
    expect(screen.getByText("Loading tokens...")).toBeVisible();
    expect(screen.getByTestId("token-add")).toBeDisabled();
    expect(screen.queryByTestId("token-name")).toBeNull();
    expect(within(screen.getByRole("navigation", { name: "Token access" })).getAllByRole("button")).toHaveLength(2);
    await act(async () => pending.resolve(response({ tokens: [] })));
    expect(screen.getByText("No tokens yet.")).toBeVisible();
    expect(fetchMock.mock.calls[0][0]).toBe("/api/tokens?includeRevoked=true");
    await openCreate();
    expect(screen.getByTestId("token-name")).toBeVisible();
    expect(screen.getByTestId("token-scope-comment")).toBeChecked();
  });

  it.each([401, 403, 503])("distinguishes a %i list refusal from an empty list and retries explicitly", async (status) => {
    fetchMock.mockResolvedValueOnce(response({ error: "List unavailable" }, status)).mockResolvedValueOnce(response({ tokens: [token] }));
    renderPanel();
    expect(await screen.findByRole("alert")).toHaveTextContent("List unavailable");
    expect(screen.queryByText("No tokens yet.")).toBeNull();
    expect(screen.queryByText("Loading tokens...")).toBeNull();
    expect(screen.getByTestId("token-add")).toBeDisabled();
    expect(screen.getByText(status === 503 ? /does not mean you have no tokens/ : /requires your signed-in browser session/)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Connect an MCP client" }));
    expect(screen.getByTestId("agent-connect-config")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Retry token list" }));
    expect(await screen.findByTestId("token-row")).toHaveTextContent("Active");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows a duplicate's actual matching row and explains a document-scope mismatch", async () => {
    fetchMock.mockResolvedValueOnce(response({ tokens: [] }))
      .mockResolvedValueOnce(response({ error: "Another active token has the same @mention name" }, 409))
      .mockResolvedValueOnce(response({ tokens: [token] }));
    render(<TokensPanel origin="https://markdoc.test" userLogin="alice" documentId="doc-two" embedded />);
    await openCreate();
    fireEvent.click(screen.getByTestId("token-create"));
    const row = await screen.findByTestId("token-row");
    expect(row).toHaveAttribute("data-token-match", "true");
    expect(row).toHaveFocus();
    expect(row).toHaveTextContent("other documents, not this one");
    expect(screen.getByTestId("token-conflict")).toHaveTextContent("matching token");
    expect(screen.getByRole("link", { name: /Open all your tokens/ })).toHaveAttribute("href", "/settings?next=%2Fd%2Fdoc-two#tokens");
    expect(screen.getByRole("button", { name: `Replace ${token.name}` })).toBeEnabled();
  });

  it("explains a duplicate whose follow-up list is forbidden instead of inventing an empty list", async () => {
    fetchMock.mockResolvedValueOnce(response({ tokens: [] }))
      .mockResolvedValueOnce(response({ error: "Name reserved" }, 409))
      .mockResolvedValueOnce(response({ error: "Browser session required" }, 403));
    renderPanel();
    await openCreate();
    fireEvent.click(screen.getByTestId("token-create"));
    await screen.findByText("Browser session required");
    expect(screen.getByTestId("token-conflict")).toHaveTextContent("could not be matched");
    expect(screen.queryByText("No tokens yet.")).toBeNull();
    expect(screen.queryByTestId("token-row")).toBeNull();
  });

  it("offers a real refresh action when a successful list cannot match a duplicate", async () => {
    fetchMock.mockResolvedValueOnce(response({ tokens: [] }))
      .mockResolvedValueOnce(response({ error: "Name reserved" }, 409))
      .mockResolvedValueOnce(response({ tokens: [] }))
      .mockResolvedValueOnce(response({ tokens: [token] }));
    renderPanel();
    await openCreate();
    fireEvent.click(screen.getByTestId("token-create"));
    const refresh = await screen.findByRole("button", { name: "Refresh token list" });
    await waitFor(() => expect(refresh).toBeEnabled());
    fireEvent.click(refresh);
    expect(await screen.findByTestId("token-row")).toHaveAttribute("data-token-match", "true");
  });

  it.each(["replace", "revoke"] as const)("keeps the %s result visible when another row's switch finishes during the reload", async (action) => {
    const other = { ...token, id: "other-token", name: "Other agent" };
    const patched = deferred<Response>();
    const refreshed = deferred<Response>();
    const created = minted();
    const newRow = { ...token, id: created.id };
    confirmMock.mockReturnValue(true);
    fetchMock.mockResolvedValueOnce(response({ tokens: [token, other] }))
      .mockReturnValueOnce(patched.promise)
      .mockResolvedValueOnce(response(action === "replace" ? { token: created } : { ok: true }))
      .mockReturnValueOnce(refreshed.promise);
    renderPanel();
    await screen.findAllByTestId("token-row");
    fireEvent.click(screen.getAllByTestId("token-collaborators-may-ask")[1]);
    fireEvent.click(screen.getByRole("button", { name: `${action === "replace" ? "Replace" : "Revoke"} ${token.name}` }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));
    await act(async () => patched.resolve(response({ token: { ...other, collaboratorsMayAsk: true } })));
    const history = [{ ...token, revokedAt: "2026-09-05T00:00:00.000Z" }, other];
    await act(async () => refreshed.resolve(response({ tokens: action === "replace" ? [...history, newRow] : history })));
    const rows = screen.getAllByTestId("token-row");
    expect(rows).toHaveLength(action === "replace" ? 3 : 2);
    expect(within(rows[0]).getByText("Revoked")).toBeVisible();
    expect(within(rows[0]).queryByRole("button", { name: /^Replace/ })).toBeNull();
    expect(within(rows[1]).getByTestId("token-collaborators-may-ask")).toHaveAttribute("aria-checked", "true");
    expect(copyText).not.toHaveBeenCalled();
  });

  it("renames metadata with cancel and error paths, keeping the secret out of the request", async () => {
    fetchMock.mockResolvedValueOnce(response({ tokens: [token] }))
      .mockResolvedValueOnce(response({ error: "Name reserved" }, 409))
      .mockResolvedValueOnce(response({ token: { ...token, name: "Reviewer" } }));
    renderPanel();
    const rename = await screen.findByRole("button", { name: `Rename ${token.name}` });
    fireEvent.click(rename);
    expect(screen.getByLabelText("Token name")).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Cancel rename" }));
    expect(rename).toHaveFocus();
    expect(mutations()).toHaveLength(0);
    fireEvent.click(rename);
    fireEvent.change(screen.getByLabelText("Token name"), { target: { value: "Reviewer" } });
    fireEvent.click(screen.getByRole("button", { name: "Save name" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Name reserved");
    expect(screen.getByLabelText("Token name")).toHaveValue("Reviewer");
    fireEvent.click(screen.getByRole("button", { name: "Save name" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Rename Reviewer" })).toHaveFocus());
    expect(JSON.parse(String(mutations()[1][1]?.body))).toEqual({ name: "Reviewer" });
    expect(screen.queryByTestId("copy-token")).toBeNull();
  });

  it("requires explicit replacement confirmation, then shows only the returned secret once", async () => {
    const replacement = minted();
    fetchMock.mockResolvedValueOnce(response({ tokens: [token] }))
      .mockResolvedValueOnce(response({ token: replacement }, 201))
      .mockResolvedValueOnce(response({ tokens: [{ ...token, revokedAt: "2026-09-05T00:00:00.000Z" }, { ...token, id: replacement.id }] }));
    renderPanel();
    const replace = await screen.findByRole("button", { name: `Replace ${token.name}` });
    fireEvent.click(replace);
    expect(mutations()).toHaveLength(0);
    expect(confirmMock.mock.calls[0][0]).toMatch(/old token stops working in every client/);
    confirmMock.mockReturnValue(true);
    fireEvent.click(replace);
    await screen.findByTestId("token-created");
    expect(mutations()).toHaveLength(1);
    expect(mutations()[0][0]).toBe(`/api/tokens/${token.id}/replace`);
    expect(JSON.parse(String(mutations()[0][1]?.body))).toEqual({ confirm: true });
    expect(copyText).not.toHaveBeenCalled();
    expect(screen.getByTestId("copy-token").textContent === replacement.token).toBe(true);
    await waitFor(() => expect(screen.getAllByTestId("token-row")).toHaveLength(2));
    expect(screen.getAllByTestId("token-row").some((row) => row.textContent?.includes("Revoked"))).toBe(true);
    expect(screen.getByRole("button", { name: `Replace ${token.name}` })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Copy token" }));
    await waitFor(() => expect(copyText).toHaveBeenCalledTimes(1));
    expect(copyText.mock.calls[0][0] === replacement.token).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Connect an MCP client" }));
    expect(screen.getByTestId("agent-connect-config").textContent?.includes(replacement.token)).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "I stored it - hide secret" }));
    expect(screen.queryByTestId("copy-token")).toBeNull();
    expect(screen.getByRole("button", { name: "Tokens" })).toHaveFocus();
  });

  it("does not revoke or hide the old row when replacement fails", async () => {
    confirmMock.mockReturnValue(true);
    fetchMock.mockResolvedValueOnce(response({ tokens: [token] }))
      .mockResolvedValueOnce(response({ error: "Replacement failed; old token unchanged" }, 500));
    renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: `Replace ${token.name}` }));
    expect(await screen.findByRole("alert")).toHaveTextContent("old token unchanged");
    expect(screen.getByTestId("token-row")).toHaveTextContent("Active");
    expect(screen.queryByTestId("copy-token")).toBeNull();
    expect(mutations().some(([, init]) => init?.method === "DELETE")).toBe(false);
  });

  it("handles revoke cancel, failure, and confirmed success without an unhandled rejection", async () => {
    fetchMock.mockResolvedValueOnce(response({ tokens: [token] }))
      .mockResolvedValueOnce(response({ error: "Could not revoke" }, 503))
      .mockResolvedValueOnce(response({ ok: true }))
      .mockResolvedValueOnce(response({ tokens: [{ ...token, revokedAt: "2026-09-05T00:00:00.000Z" }] }));
    renderPanel();
    const revoke = await screen.findByRole("button", { name: `Revoke ${token.name}` });
    fireEvent.click(revoke);
    expect(mutations()).toHaveLength(0);
    confirmMock.mockReturnValue(true);
    fireEvent.click(revoke);
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not revoke");
    fireEvent.click(revoke);
    await waitFor(() => expect(screen.queryByRole("button", { name: `Revoke ${token.name}` })).toBeNull());
    expect(screen.getByTestId("token-row")).toHaveTextContent("Revoked");
    expect(mutations().every(([, init]) => init?.method === "DELETE")).toBe(true);
  });
});

describe("synchronous mutation ownership", () => {
  it("sends one create request and locks every secret-hiding control through the accepted reload", async () => {
    const createRequest = deferred<Response>();
    const reload = deferred<Response>();
    const created = minted();
    const onClose = vi.fn();
    fetchMock.mockResolvedValueOnce(response({ tokens: [] }))
      .mockReturnValueOnce(createRequest.promise)
      .mockReturnValueOnce(reload.promise);
    render(<TokensPanel origin="https://markdoc.test" userLogin="alice" embedded onClose={onClose} />);
    await openCreate();

    const form = screen.getByTestId("token-name").closest("form")!;
    act(() => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });

    expect(mutations()).toHaveLength(1);
    expect(screen.getByTestId("token-name")).toBeDisabled();
    expect(screen.getByTestId("token-scope-comment")).toBeDisabled();
    expect(screen.getByTestId("token-restrict")).toBeDisabled();
    expect(screen.getByLabelText("Expires")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Connect an MCP client" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Close token management" })).toBeDisabled();
    expect(screen.getByRole("link", { name: "Open all your tokens in Settings" })).toHaveAttribute("aria-disabled", "true");
    screen.getByRole("button", { name: "Close token management" }).click();
    expect(onClose).not.toHaveBeenCalled();

    act(() => createRequest.resolve(response({ token: created }, 201)));
    expect(await screen.findByTestId("token-created")).toBeVisible();
    expect(screen.getByTestId("copy-token").textContent === created.token).toBe(true);
    expect(screen.getByRole("button", { name: "Connect an MCP client" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Close token management" })).toBeDisabled();
    expect(copyText).not.toHaveBeenCalled();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));

    act(() => reload.resolve(response({ tokens: [token] })));
    await waitFor(() => expect(screen.getByRole("button", { name: "Close token management" })).toBeEnabled());
    expect(screen.getByRole("button", { name: "Connect an MCP client" })).toBeEnabled();
    expect(screen.getByRole("link", { name: "Open all your tokens in Settings" })).not.toHaveAttribute("aria-disabled");
    expect(fetchMock.mock.calls.filter(([, init]) => !init?.method || init.method === "GET")).toHaveLength(2);
    screen.getByRole("button", { name: "Close token management" }).click();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("restores the exact create form after failure and lets one retry show one secret and reload once", async () => {
    const failed = deferred<Response>();
    const retry = deferred<Response>();
    const created = minted();
    fetchMock.mockResolvedValueOnce(response({ tokens: [] }))
      .mockReturnValueOnce(failed.promise)
      .mockReturnValueOnce(retry.promise)
      .mockResolvedValueOnce(response({ tokens: [token] }));
    renderPanel();
    await openCreate();
    fireEvent.change(screen.getByTestId("token-name"), { target: { value: "Retry agent" } });
    fireEvent.click(screen.getByTestId("token-scope-full"));
    fireEvent.change(screen.getByLabelText("Expires"), { target: { value: "30" } });
    const form = screen.getByTestId("token-name").closest("form")!;

    act(() => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(mutations()).toHaveLength(1);
    act(() => failed.resolve(response({ error: "Create unavailable" }, 503)));
    expect(await screen.findByRole("alert")).toHaveTextContent("Create unavailable");
    expect(screen.getByTestId("token-name")).toHaveValue("Retry agent");
    expect(screen.getByTestId("token-scope-full")).toBeChecked();
    expect(screen.getByLabelText("Expires")).toHaveValue("30");
    expect(screen.getByTestId("token-name")).toBeEnabled();

    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    expect(mutations()).toHaveLength(2);
    const postBodies = mutations().map(([, init]) => JSON.parse(String(init?.body)));
    expect(postBodies).toEqual([
      { name: "Retry agent", expiresInDays: 30, scope: "full", documentIds: null },
      { name: "Retry agent", expiresInDays: 30, scope: "full", documentIds: null },
    ]);
    act(() => retry.resolve(response({ token: created }, 201)));
    expect(await screen.findByTestId("token-created")).toBeVisible();
    expect(screen.getByTestId("copy-token").textContent === created.token).toBe(true);
    await waitFor(() => expect(screen.getByTestId("token-create")).toBeDisabled());
    expect(fetchMock.mock.calls.filter(([, init]) => !init?.method || init.method === "GET")).toHaveLength(2);
    expect(copyText).not.toHaveBeenCalled();
  });

  it("gives rename one owner that suppresses duplicate and mixed actions for the same token", async () => {
    const renamed = deferred<Response>();
    confirmMock.mockReturnValue(true);
    fetchMock.mockResolvedValueOnce(response({ tokens: [token] })).mockReturnValueOnce(renamed.promise);
    renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: `Rename ${token.name}` }));
    fireEvent.change(screen.getByLabelText("Token name"), { target: { value: "Reviewer" } });
    const form = screen.getByLabelText("Token name").closest("form")!;
    const replace = screen.getByRole("button", { name: `Replace ${token.name}` });
    const revoke = screen.getByRole("button", { name: `Revoke ${token.name}` });
    const collaborators = screen.getByTestId("token-collaborators-may-ask");

    act(() => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      replace.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      revoke.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      collaborators.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(mutations()).toHaveLength(1);
    expect(mutations()[0][1]?.method).toBe("PATCH");
    expect(confirmMock).not.toHaveBeenCalled();
    act(() => renamed.resolve(response({ token: { ...token, name: "Reviewer" } })));
    await waitFor(() => expect(screen.getByRole("button", { name: "Rename Reviewer" })).toBeEnabled());
    expect(screen.queryByTestId("copy-token")).toBeNull();
  });

  it("sends one replacement request and keeps close and destination locked until its reload settles", async () => {
    const replaceRequest = deferred<Response>();
    const reload = deferred<Response>();
    const replacement = minted();
    const onClose = vi.fn();
    confirmMock.mockReturnValue(true);
    fetchMock.mockResolvedValueOnce(response({ tokens: [token] }))
      .mockReturnValueOnce(replaceRequest.promise)
      .mockReturnValueOnce(reload.promise);
    render(<TokensPanel origin="https://markdoc.test" userLogin="alice" embedded onClose={onClose} />);
    const replace = await screen.findByRole("button", { name: `Replace ${token.name}` });

    act(() => {
      replace.click();
      replace.click();
    });

    expect(confirmMock).toHaveBeenCalledTimes(1);
    expect(mutations()).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Connect an MCP client" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Close token management" })).toBeDisabled();
    act(() => replaceRequest.resolve(response({ token: replacement }, 201)));
    expect(await screen.findByTestId("token-created")).toBeVisible();
    expect(screen.getByTestId("copy-token").textContent === replacement.token).toBe(true);
    expect(screen.getByRole("button", { name: "Connect an MCP client" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Close token management" })).toBeDisabled();
    expect(copyText).not.toHaveBeenCalled();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));

    act(() => reload.resolve(response({ tokens: [{ ...token, revokedAt: "2026-09-05T00:00:00.000Z" }, { ...token, id: replacement.id }] })));
    await waitFor(() => expect(screen.getByRole("button", { name: "Close token management" })).toBeEnabled());
    expect(screen.getByRole("button", { name: "Connect an MCP client" })).toBeEnabled();
    expect(mutations()).toHaveLength(1);
  });

  it("sends one revoke request for duplicate activation", async () => {
    const revokeRequest = deferred<Response>();
    const reload = deferred<Response>();
    confirmMock.mockReturnValue(true);
    fetchMock.mockResolvedValueOnce(response({ tokens: [token] }))
      .mockReturnValueOnce(revokeRequest.promise)
      .mockReturnValueOnce(reload.promise);
    renderPanel();
    const revoke = await screen.findByRole("button", { name: `Revoke ${token.name}` });

    act(() => {
      revoke.click();
      revoke.click();
    });

    expect(confirmMock).toHaveBeenCalledTimes(1);
    expect(mutations()).toHaveLength(1);
    expect(mutations()[0][1]?.method).toBe("DELETE");
    act(() => revokeRequest.resolve(response({ ok: true })));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    act(() => reload.resolve(response({ tokens: [{ ...token, revokedAt: "2026-09-05T00:00:00.000Z" }] })));
    await waitFor(() => expect(screen.queryByRole("button", { name: `Revoke ${token.name}` })).toBeNull());
    expect(mutations()).toHaveLength(1);
  });

  it("suppresses a duplicate collaborator switch while another token remains independently usable", async () => {
    const first = deferred<Response>();
    const second = deferred<Response>();
    const other = { ...token, id: "token-other", name: "Other agent" };
    fetchMock.mockResolvedValueOnce(response({ tokens: [token, other] }))
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    renderPanel();
    const switches = await screen.findAllByTestId("token-collaborators-may-ask");

    act(() => {
      switches[0].click();
      switches[0].click();
    });

    expect(mutations()).toHaveLength(1);
    expect(switches[0]).toHaveAttribute("aria-checked", "true");
    expect(switches[0]).toBeDisabled();
    expect(switches[1]).toBeEnabled();
    expect(screen.getByTestId("token-add")).toBeEnabled();
    fireEvent.click(switches[1]);
    expect(mutations()).toHaveLength(2);
    expect(switches[1]).toHaveAttribute("aria-checked", "true");

    act(() => second.resolve(response({ token: { ...other, collaboratorsMayAsk: true } })));
    await waitFor(() => expect(switches[1]).toBeEnabled());
    expect(switches[0]).toBeDisabled();
    act(() => first.resolve(response({ token: { ...token, collaboratorsMayAsk: true } })));
    await waitFor(() => expect(switches[0]).toBeEnabled());
    expect(mutations()).toHaveLength(2);
  });

  it.each(["resolve", "reject"] as const)("isolates a stale replacement %s and its finalizer from a newer mounted owner", async (settlement) => {
    const stale = deferred<Response>();
    const current = deferred<Response>();
    const staleReplacement = minted();
    const currentReplacement = { ...minted(), id: "token-current" };
    confirmMock.mockReturnValue(true);
    fetchMock.mockResolvedValueOnce(response({ tokens: [token] }))
      .mockReturnValueOnce(stale.promise)
      .mockResolvedValueOnce(response({ tokens: [token] }))
      .mockReturnValueOnce(current.promise)
      .mockResolvedValueOnce(response({ tokens: [{ ...token, revokedAt: "2026-09-05T00:00:00.000Z" }, { ...token, id: currentReplacement.id }] }));
    const view = renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: `Replace ${token.name}` }));
    view.rerender(<TokensPanel origin="https://markdoc.test" userLogin="alice" open={false} />);
    view.rerender(<TokensPanel origin="https://markdoc.test" userLogin="alice" open />);
    const currentButton = await screen.findByRole("button", { name: `Replace ${token.name}` });
    fireEvent.click(currentButton);
    expect(mutations()).toHaveLength(2);

    await act(async () => {
      if (settlement === "resolve") stale.resolve(response({ token: staleReplacement }, 201));
      else stale.reject(new Error("Late replacement failure"));
      await Promise.resolve();
    });

    expect(currentButton).toBeDisabled();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByTestId("copy-token")).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(4);

    act(() => current.resolve(response({ token: currentReplacement }, 201)));
    expect(await screen.findByTestId("token-created")).toBeVisible();
    expect(screen.getByTestId("copy-token").textContent === currentReplacement.token).toBe(true);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(5));
    expect(mutations()).toHaveLength(2);
    expect(copyText).not.toHaveBeenCalled();
  });
});

describe("one-time lifecycle and setup", () => {
  it("disables cancellation while creation is pending and displays the response only in the still-open manager", async () => {
    const user = userEvent.setup();
    const pending = deferred<Response>();
    const created = minted();
    fetchMock.mockResolvedValueOnce(response({ tokens: [] })).mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce(response({ tokens: [token] }));
    renderPanel();
    await openCreate();
    await user.click(screen.getByTestId("token-create"));
    const cancel = screen.getByRole("button", { name: "Cancel creation" });
    expect(cancel).toBeDisabled();
    await user.click(cancel);
    expect(cancel).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByTestId("token-name")).toBeVisible();
    expect(screen.queryByTestId("copy-token")).toBeNull();
    expect(mutations()).toHaveLength(1);
    expect(copyText).not.toHaveBeenCalled();
    await act(async () => pending.resolve(response({ token: created }, 201)));
    expect(screen.getByTestId("copy-token").textContent === created.token).toBe(true);
    expect(cancel).toBeDisabled();
    expect(copyText).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "I stored it - hide secret" }));
    expect(cancel).toBeEnabled();
    await user.click(cancel);
    expect(screen.queryByTestId("token-name")).toBeNull();
    expect(screen.queryByTestId("copy-token")).toBeNull();
  });

  it.each([false, true])("drops a late creation response after closing (reopened before response: %s)", async (reopen) => {
    const user = userEvent.setup();
    const pending = deferred<Response>();
    fetchMock.mockResolvedValueOnce(response({ tokens: [] })).mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce(response({ tokens: [token] }));
    const view = renderPanel();
    await openCreate();
    await user.click(screen.getByTestId("token-create"));
    const cancel = screen.getByRole("button", { name: "Cancel creation" });
    expect(cancel).toBeDisabled();
    await user.click(cancel);
    expect(screen.getByTestId("token-name")).toBeVisible();
    view.rerender(<TokensPanel origin="https://markdoc.test" userLogin="alice" open={false} />);
    expect(screen.queryByTestId("token-manager")).toBeNull();
    if (reopen) {
      view.rerender(<TokensPanel origin="https://markdoc.test" userLogin="alice" open />);
      await screen.findByTestId("token-row");
    }
    await act(async () => pending.resolve(response({ token: minted() }, 201)));
    expect(screen.queryByTestId("copy-token")).toBeNull();
    expect(screen.queryByTestId("token-name")).toBeNull();
    expect(mutations()).toHaveLength(1);
    expect(copyText).not.toHaveBeenCalled();
  });

  it("discards an existing secret on dialog Escape and restores opener focus", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValueOnce(response({ tokens: [] })).mockResolvedValueOnce(response({ token: minted() }, 201))
      .mockResolvedValueOnce(response({ tokens: [token] })).mockResolvedValueOnce(response({ tokens: [token] }));
    function Harness() {
      const [open, setOpen] = useState(false);
      return <><button onClick={() => setOpen(true)}>Open tokens</button>
        <Dialog open={open} onOpenChange={setOpen}><DialogContent title="Agent access">
          <TokensPanel origin="https://markdoc.test" userLogin="alice" open={open} />
        </DialogContent></Dialog></>;
    }
    render(<Harness />);
    await user.click(screen.getByRole("button", { name: "Open tokens" }));
    await openCreate();
    fireEvent.click(screen.getByTestId("token-create"));
    await screen.findByTestId("token-created");
    expect(screen.getByRole("button", { name: "Close" })).toBeVisible();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByRole("button", { name: "Open tokens" })).toHaveFocus();
    await user.click(screen.getByRole("button", { name: "Open tokens" }));
    await screen.findByTestId("token-row");
    expect(screen.queryByTestId("copy-token")).toBeNull();
  });

  it("uses the browser endpoint, preserves management, and copies only the chosen placeholder setup on demand", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValueOnce(response({ tokens: [token] }));
    renderPanel();
    await screen.findByTestId("token-row");
    await user.click(screen.getByRole("button", { name: "Connect an MCP client" }));
    expect(screen.getByRole("button", { name: `Rename ${token.name}` })).toBeVisible();
    const cli = screen.getByRole("tab", { name: "Copilot CLI" });
    cli.focus();
    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("tab", { name: "VS Code" })).toHaveFocus();
    const config = JSON.parse(screen.getByTestId("agent-connect-config").textContent!);
    expect(config.servers.markdoc.url).toBe(`${window.location.origin}/api/mcp`);
    expect(config.mcpServers).toBeUndefined();
    expect(config.servers.markdoc.headers.Authorization.endsWith("MARKDOC_TOKEN")).toBe(true);
    expect(copyText).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Copy MCP configuration" }));
    expect(copyText).toHaveBeenCalledTimes(1);
    expect(JSON.parse(copyText.mock.calls[0][0]).servers.markdoc.url).toBe(`${window.location.origin}/api/mcp`);
    expect(screen.getByTestId("agent-connect-config-stdio")).not.toBeVisible();
    await user.click(screen.getByTestId("agent-connect-stdio-toggle"));
    expect(screen.getByTestId("agent-connect-config-stdio")).toBeVisible();
  });

  it("opens the Connect deep link without hiding token management", async () => {
    window.history.replaceState(null, "", "/settings#connect");
    fetchMock.mockResolvedValueOnce(response({ tokens: [token] }));
    renderPanel();
    await screen.findByTestId("token-row");
    expect(screen.getByRole("button", { name: "Connect an MCP client" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: `Rename ${token.name}` })).toBeVisible();
  });

  it("shares a pending list across rapid chooser visits and retries once while preserving only accessible selections", async () => {
    const initial = deferred<Response>();
    const refresh = deferred<Response>();
    const retry = deferred<Response>();
    const documentRequests = [initial, refresh, retry];
    let documentRequestIndex = 0;
    let createBody: unknown;
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === "/api/documents") return documentRequests[documentRequestIndex++].promise;
      if (url === "/api/tokens" && init?.method === "POST") {
        createBody = JSON.parse(String(init.body));
        return response({ token: { ...minted(), documentIds: ["doc-two"] } }, 201);
      }
      if (url === "/api/tokens?includeRevoked=true") return response({ tokens: [] });
      throw new Error(`Unexpected request: ${url}`);
    });
    const documentListCount = () => fetchMock.mock.calls.filter(([input]) => String(input) === "/api/documents").length;
    const view = renderPanel();
    await openCreate();

    const restrict = screen.getByTestId("token-restrict");
    fireEvent.click(restrict);
    expect(documentListCount()).toBe(1);
    expect(screen.getAllByRole("status")).toEqual([screen.getByTestId("token-documents-pending")]);
    act(() => {
      restrict.click();
      restrict.click();
    });
    view.rerender(<TokensPanel origin="https://markdoc.test" userLogin="alice" open />);
    expect(documentListCount()).toBe(1);
    expect(screen.getAllByRole("status")).toHaveLength(1);

    await act(async () => initial.resolve(response({ documents: [
      { id: "doc-one", title: "First document" },
      { id: "doc-two", title: "Second document" },
    ] })));
    fireEvent.click(screen.getByTestId("token-document-doc-one"));
    fireEvent.click(screen.getByTestId("token-document-doc-two"));

    act(() => {
      restrict.click();
      restrict.click();
    });
    expect(documentListCount()).toBe(2);
    expect(screen.getByTestId("token-document-doc-one")).toBeChecked();
    expect(screen.getByTestId("token-document-doc-two")).toBeChecked();
    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(screen.getByTestId("token-create")).toBeDisabled();

    await act(async () => refresh.resolve(response({ error: "Documents unavailable" }, 503)));
    expect(screen.getAllByRole("alert")).toEqual([screen.getByText("Documents unavailable")]);
    expect(screen.queryByText("No documents yet.")).toBeNull();
    expect(screen.getByTestId("token-document-doc-one")).toBeChecked();
    expect(screen.getByTestId("token-document-doc-two")).toBeChecked();
    const retryButton = screen.getByRole("button", { name: "Retry documents" });
    act(() => {
      retryButton.click();
      retryButton.click();
    });
    expect(documentListCount()).toBe(3);
    expect(screen.queryByText("Documents unavailable")).toBeNull();
    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(screen.getByTestId("token-document-doc-one")).toBeChecked();
    expect(screen.getByTestId("token-document-doc-two")).toBeChecked();

    await act(async () => retry.resolve(response({ documents: [
      { id: "doc-two", title: "Second document" },
      { id: "doc-three", title: "Third document" },
    ] })));
    expect(screen.queryByTestId("token-document-doc-one")).toBeNull();
    expect(screen.getByTestId("token-document-doc-two")).toBeChecked();
    expect(screen.getByTestId("token-document-doc-three")).not.toBeChecked();
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByTestId("token-create")).toBeEnabled();

    fireEvent.click(screen.getByTestId("token-create"));
    await screen.findByTestId("token-created");
    expect(createBody).toEqual({
      name: "GitHub Copilot CLI",
      expiresInDays: 90,
      scope: "comment",
      documentIds: ["doc-two"],
    });
    expect(documentListCount()).toBe(3);
  });

  it.each(["resolve", "reject"] as const)("retires a fixed-document replacement before an old document %s and protects the new owner", async (oldSettlement) => {
    const oldRequest = deferred<Response>();
    const currentRequest = deferred<Response>();
    const documentRequests = [oldRequest, currentRequest];
    let documentRequestIndex = 0;
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url === "/api/documents") return documentRequests[documentRequestIndex++].promise;
      if (url === "/api/tokens?includeRevoked=true") return response({ tokens: [] });
      throw new Error(`Unexpected request: ${url}`);
    });
    const documentListCount = () => fetchMock.mock.calls.filter(([input]) => String(input) === "/api/documents").length;
    const view = renderPanel();
    await openCreate();
    fireEvent.click(screen.getByTestId("token-restrict"));
    expect(documentListCount()).toBe(1);

    view.rerender(<TokensPanel origin="https://markdoc.test" userLogin="alice" documentId="fixed-document" open />);
    await openCreate();
    expect(screen.getByTestId("token-restrict")).toBeChecked();
    expect(screen.getByText("Only this document")).toBeVisible();
    view.rerender(<TokensPanel origin="https://markdoc.test" userLogin="alice" open />);
    await openCreate();
    fireEvent.click(screen.getByTestId("token-restrict"));
    expect(documentListCount()).toBe(2);

    await act(async () => {
      if (oldSettlement === "resolve") {
        oldRequest.resolve(response({ documents: [{ id: "stale-document", title: "Stale document" }] }));
      } else {
        oldRequest.reject(new Error("Stale document failure"));
      }
      await Promise.allSettled([oldRequest.promise]);
    });
    expect(screen.getByText("Loading your documents...")).toBeVisible();
    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(screen.queryByText("Stale document")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(documentListCount()).toBe(2);

    if (oldSettlement === "resolve") {
      await act(async () => currentRequest.resolve(response({ error: "Current documents unavailable" }, 503)));
      expect(screen.getAllByRole("alert")).toEqual([screen.getByText("Current documents unavailable")]);
      expect(screen.queryByRole("status")).toBeNull();
    } else {
      await act(async () => currentRequest.resolve(response({ documents: [{ id: "current-document", title: "Current document" }] })));
      expect(screen.getByTestId("token-document-current-document")).toBeVisible();
      expect(screen.getAllByRole("alert")).toEqual([screen.getByTestId("token-document-error")]);
      expect(screen.getByRole("alert")).toHaveTextContent("Select at least one document");
      expect(screen.queryByRole("status")).toBeNull();
    }
    expect(documentListCount()).toBe(2);
  });

  it.each([
    ["close transition", "resolve"],
    ["direct unmount", "reject"],
  ] as const)("retires document work at the %s boundary before a late %s", async (boundary, settlement) => {
    const pending = deferred<Response>();
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url === "/api/documents") return pending.promise;
      if (url === "/api/tokens?includeRevoked=true") return response({ tokens: [] });
      throw new Error(`Unexpected request: ${url}`);
    });
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    const view = render(<TransitionClosePanel />);
    let observer: MutationObserver | null = null;
    const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
    const previousActEnvironment = actEnvironment.IS_REACT_ACT_ENVIRONMENT;

    try {
      await openCreate();
      fireEvent.click(screen.getByTestId("token-restrict"));
      expect(fetchMock.mock.calls.filter(([input]) => String(input) === "/api/documents")).toHaveLength(1);
      const settle = () => {
        if (settlement === "resolve") pending.resolve(response({ documents: [{ id: "late", title: "Late document" }] }));
        else pending.reject(new Error("Late document failure"));
      };
      let postRemovalMutations = 0;
      if (boundary === "close transition") {
        const removed = deferred<void>();
        let settledAtRemoval = false;
        observer = new MutationObserver((records) => {
          if (document.querySelector('[data-testid="token-manager"]')) return;
          if (!settledAtRemoval) {
            settledAtRemoval = true;
            settle();
            removed.resolve();
            return;
          }
          postRemovalMutations += records.length;
        });
        observer.observe(document.body, { childList: true, subtree: true });
        actEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
        screen.getByRole("button", { name: "Close token management" }).click();
        await removed.promise;
      } else {
        view.unmount();
        settle();
      }
      await Promise.allSettled([pending.promise]);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(screen.queryByTestId("token-manager")).toBeNull();
      expect(screen.queryByText("Late document")).toBeNull();
      expect(screen.queryByText("Late document failure")).toBeNull();
      expect(postRemovalMutations).toBe(0);
      expect(unhandled).toEqual([]);
    } finally {
      actEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
      observer?.disconnect();
      process.off("unhandledRejection", onUnhandled);
      view.unmount();
    }
  });

  it("does not offer replacement for expired or revoked tokens", async () => {
    fetchMock.mockResolvedValueOnce(response({ tokens: [{ ...token, expiresAt: "2020-01-01T00:00:00.000Z" }, { ...token, id: "revoked", name: "Revoked bot", revokedAt: "2021-01-01T00:00:00.000Z" }] }));
    renderPanel();
    await screen.findAllByTestId("token-row");
    expect(screen.getByRole("button", { name: `Replace ${token.name}` })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Replace Revoked bot" })).toBeNull();
    expect(screen.getByText("Create a new token to choose a new expiry.")).toBeVisible();
    expect(mutations()).toHaveLength(0);
  });

  it.each([390, 768, 1280])("renders wrapping controls and all metadata at a %i fixture width (not a geometry measurement)", async (width) => {
    vi.stubGlobal("innerWidth", width);
    fetchMock.mockResolvedValueOnce(response({ tokens: [{ ...token, name: "A".repeat(80) }] }));
    renderPanel();
    const row = await screen.findByTestId("token-row");
    expect(row).toHaveTextContent("Created");
    expect(row).toHaveTextContent("no recorded use");
    expect(within(row).getByRole("button", { name: /^Revoke / }).parentElement).toHaveClass("flex-wrap");
    expect(screen.getByRole("navigation", { name: "Token access" })).toHaveClass("flex-wrap");
  });
});
