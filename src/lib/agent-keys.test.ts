import { describe, expect, it } from "vitest";
import type { ApiTokenDto } from "@/lib/api";
import { hasConnected, isActiveKey, keyReaches, lastSeenAt, uniqueKeyName } from "./agent-keys";

const NOW = Date.parse("2026-09-24T12:00:00.000Z");

function key(overrides: Partial<ApiTokenDto> = {}): ApiTokenDto {
  return {
    id: "k1",
    name: "Copilot CLI",
    prefix: "mdk_abcd",
    scope: "comment",
    documentIds: null,
    collaboratorsMayAsk: false,
    createdAt: "2026-09-01T00:00:00.000Z",
    lastUsedAt: null,
    lastMcpSeenAt: null,
    lastMcpCallAt: null,
    expiresAt: null,
    ...overrides,
  };
}

describe("isActiveKey", () => {
  it("accepts a key without an expiry, or one that expires later", () => {
    expect(isActiveKey(key(), NOW)).toBe(true);
    expect(isActiveKey(key({ expiresAt: "2026-10-01T00:00:00.000Z" }), NOW)).toBe(true);
  });

  it("rejects an expired or revoked key", () => {
    expect(isActiveKey(key({ expiresAt: "2026-09-01T00:00:00.000Z" }), NOW)).toBe(false);
    expect(isActiveKey(key({ revokedAt: "2026-09-10T00:00:00.000Z" }), NOW)).toBe(false);
  });
});

describe("keyReaches", () => {
  it("lets an all-documents key reach anything and a limited key reach only its documents", () => {
    expect(keyReaches(key(), "doc-a")).toBe(true);
    expect(keyReaches(key({ documentIds: ["doc-a", "doc-b"] }), "doc-b")).toBe(true);
    expect(keyReaches(key({ documentIds: ["doc-a"] }), "doc-z")).toBe(false);
  });
});

describe("connection", () => {
  it("counts an MCP tools/list or any authenticated request as connected", () => {
    expect(hasConnected(key())).toBe(false);
    expect(hasConnected(key({ lastMcpSeenAt: "2026-09-20T00:00:00.000Z" }))).toBe(true);
    expect(hasConnected(key({ lastUsedAt: "2026-09-20T00:00:00.000Z" }))).toBe(true);
  });

  it("reports the most recent time an agent used the key", () => {
    expect(lastSeenAt(key())).toBeNull();
    expect(lastSeenAt(key({ lastMcpSeenAt: "2026-09-20T00:00:00.000Z" }))).toBe("2026-09-20T00:00:00.000Z");
    expect(lastSeenAt(key({ lastMcpSeenAt: "2026-09-20T00:00:00.000Z", lastUsedAt: "2026-09-22T00:00:00.000Z" }))).toBe("2026-09-22T00:00:00.000Z");
  });
});

describe("uniqueKeyName", () => {
  it("keeps the base name when nothing collides", () => {
    expect(uniqueKeyName("Copilot CLI", null, NOW)).toBe("Copilot CLI");
    expect(uniqueKeyName("Copilot CLI", [key({ name: "Cursor" })], NOW)).toBe("Copilot CLI");
  });

  it("steps to the next free number, comparing the @mention slug case-insensitively", () => {
    expect(uniqueKeyName("Copilot CLI", [key()], NOW)).toBe("Copilot CLI 2");
    expect(uniqueKeyName("Copilot CLI", [key({ name: "copilot cli" })], NOW)).toBe("Copilot CLI 2");
    expect(uniqueKeyName("Copilot CLI", [key(), key({ id: "k2", name: "Copilot CLI 2" })], NOW)).toBe("Copilot CLI 3");
  });

  it("ignores revoked and expired keys, which no longer own their @mention", () => {
    const revoked = key({ revokedAt: "2026-09-10T00:00:00.000Z" });
    const expired = key({ id: "k2", expiresAt: "2026-09-01T00:00:00.000Z" });
    expect(uniqueKeyName("Copilot CLI", [revoked, expired], NOW)).toBe("Copilot CLI");
  });
});
