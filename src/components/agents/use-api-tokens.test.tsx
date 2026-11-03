// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";

import { api, type ApiTokenDto } from "@/lib/api";
import { API_TOKENS_POLL_MS, useApiTokens } from "./use-api-tokens";

function key(overrides: Partial<ApiTokenDto> = {}): ApiTokenDto {
  return {
    id: "key-1",
    name: "Copilot CLI",
    prefix: "mdk_live",
    scope: "comment",
    documentIds: null,
    collaboratorsMayAsk: false,
    createdAt: "2026-09-01T12:00:00.000Z",
    lastUsedAt: null,
    lastMcpSeenAt: null,
    lastMcpCallAt: null,
    expiresAt: "2026-12-01T12:00:00.000Z",
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("useApiTokens", () => {
  it("refreshes MCP activity while the page is visible", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    const initial = key();
    const updated = key({
      lastMcpSeenAt: "2026-09-24T14:00:00.000Z",
      lastMcpCallAt: "2026-09-24T15:00:00.000Z",
    });
    const list = vi.spyOn(api.tokens, "list").mockResolvedValue({ tokens: [initial] });
    const { result } = renderHook(() => useApiTokens(true, [initial]));

    await act(async () => {
      await Promise.resolve();
    });
    expect(list).toHaveBeenCalledOnce();
    expect(result.current.tokens?.[0]?.lastMcpCallAt).toBeNull();

    list.mockResolvedValueOnce({ tokens: [updated] });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(API_TOKENS_POLL_MS);
    });

    expect(list).toHaveBeenCalledTimes(2);
    expect(result.current.tokens?.[0]?.lastMcpCallAt).toBe(updated.lastMcpCallAt);
  });
});
