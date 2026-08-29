import { beforeEach, describe, expect, it, vi } from "vitest";

const execute = vi.fn();
const getDb = vi.fn();
let collab: { getDocumentsCount: () => number; getConnectionsCount: () => number } | null = null;
vi.mock("@/server/db", () => ({ getDb }));
vi.mock("@/server/collab/registry", () => ({ getCollab: () => collab }));

process.env.APP_VERSION = "test-sha";

const { GET } = await import("./route");

const BASE = "http://localhost:3220";
const get = (path: string) => GET(new Request(`${BASE}${path}`));

beforeEach(() => {
  execute.mockReset().mockResolvedValue([]);
  getDb.mockReset().mockResolvedValue({ execute });
  collab = null;
});

describe("GET /api/health", () => {
  it("runs one database round trip by default and reports it", async () => {
    collab = { getDocumentsCount: () => 3, getConnectionsCount: () => 5 };
    const response = await get("/api/health");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ ok: true, db: true, collab: true, documentsLoaded: 3, connections: 5, version: "test-sha" });
    expect(typeof body.latencyMs).toBe("number");
    expect(body.probe).toBeUndefined();
    expect(getDb).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("answers 503 with the error message when the database is unreachable", async () => {
    getDb.mockRejectedValue(new Error("connect ECONNREFUSED 10.42.1.4:5432"));
    const response = await get("/api/health");
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ ok: false, error: "connect ECONNREFUSED 10.42.1.4:5432" });
  });

  it("?probe=live never touches the database and reports the process alone", async () => {
    const response = await get("/api/health?probe=live");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, probe: "live", collab: false, version: "test-sha" });
    expect(getDb).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it("?probe=live stays 200 while the database is down or slow, and reports the collab server", async () => {
    collab = { getDocumentsCount: () => 1, getConnectionsCount: () => 1 };
    getDb.mockImplementation(() => new Promise(() => undefined)); // a hung connection attempt
    const response = await get("/api/health?probe=live");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, collab: true });
    expect(getDb).not.toHaveBeenCalled();
  });

  it("any other probe value is the full check", async () => {
    const response = await get("/api/health?probe=ready");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, db: true });
    expect(getDb).toHaveBeenCalledTimes(1);
  });
});
