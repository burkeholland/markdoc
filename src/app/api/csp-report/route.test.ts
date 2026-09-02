import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

process.env.PGLITE_DATA_DIR = "memory://";
process.env.AUTH_SECRET = "test-secret-test-secret-test-secret";
process.env.RATE_LIMIT = "off";

const mocks = vi.hoisted(() => ({ requireUser: vi.fn() }));
vi.mock("@/server/http", () => {
  class HttpError extends Error {
    constructor(public status: number, message: string) {
      super(message);
    }
  }
  return {
    HttpError,
    requireUser: mocks.requireUser,
    json: (data: unknown, init?: ResponseInit) => Response.json(data, init),
    handler: <T extends unknown[]>(fn: (...args: T) => Promise<Response>) =>
      async (...args: T): Promise<Response> => {
        try {
          return await fn(...args);
        } catch (error) {
          if (error instanceof HttpError) return Response.json({ error: error.message }, { status: error.status });
          throw error;
        }
      },
  };
});

const { HttpError } = await import("@/server/http");
const { CSP_LOG_INTERVAL_MS, CSP_REPORT_BODY_LIMIT, GET, POST, resetCspReportState } = await import("./route");

const BASE = "http://localhost:3297/api/csp-report";
const browserUser = { id: "user-1", login: "reader", name: "Reader", image: null };
const cspPayload = (overrides: Record<string, string> = {}) => ({
  "csp-report": {
    "effective-directive": "script-src-elem",
    "blocked-uri": "https://cdn.example.test/assets/app.js?token=secret",
    "document-uri": "https://markdoc.example.test/d/abcdefghijkl?private=1",
    ...overrides,
  },
});

function post(contentType: string, body: string): Promise<Response> {
  return POST(new Request(BASE, { method: "POST", headers: { "content-type": contentType }, body }));
}

let error: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  resetCspReportState();
  mocks.requireUser.mockReset().mockResolvedValue(browserUser);
  error = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("/api/csp-report", () => {
  it("accepts application/csp-report, strips blocked and document queries, and redacts ids in the route shape", async () => {
    const response = await post("application/csp-report", JSON.stringify(cspPayload()));
    expect(response.status).toBe(204);
    expect(error).toHaveBeenCalledWith("[csp] script-src-elem https://cdn.example.test /d/:id n=1");
    const counters = (await (await GET()).json()) as { counters: Record<string, number> };
    expect(counters).toEqual({ counters: { "script-src-elem https://cdn.example.test /d/:id": 1 } });
  });

  it("accepts application/reports+json with Reporting API field names and counts inline violations", async () => {
    const body = [{
      type: "csp-violation",
      body: {
        effectiveDirective: "style-src",
        blockedURL: "inline",
        documentURL: "https://markdoc.example.test/settings?tab=profile",
      },
    }];
    const response = await post("application/reports+json; charset=utf-8", JSON.stringify(body));
    expect(response.status).toBe(204);
    const counters = (await (await GET()).json()) as { counters: Record<string, number> };
    expect(counters.counters["style-src inline /settings"]).toBe(1);
  });

  it("rejects bodies above 8 KiB with 413 and unsupported media types with 415", async () => {
    const oversized = await post("application/csp-report", "x".repeat(CSP_REPORT_BODY_LIMIT + 1));
    expect(oversized.status).toBe(413);
    expect(await oversized.json()).toEqual({ error: "CSP report body exceeds 8 KiB" });
    const unsupported = await post("application/json", JSON.stringify(cspPayload()));
    expect(unsupported.status).toBe(415);
  });

  it("answers 204 for malformed JSON or fields and counts them under the bounded malformed key", async () => {
    expect((await post("application/csp-report", "{")).status).toBe(204);
    expect((await post("application/csp-report", JSON.stringify({ "csp-report": { "effective-directive": "script-src" } }))).status).toBe(204);
    const counters = (await (await GET()).json()) as { counters: Record<string, number> };
    expect(counters.counters).toEqual({ "malformed inline /": 2 });
  });

  it("logs a distinct key at most once per ten minutes while continuing to count every report", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = new Date("2030-01-01T00:00:00.000Z");
    vi.setSystemTime(start);
    const body = JSON.stringify(cspPayload());
    await post("application/csp-report", body);
    await post("application/csp-report", body);
    vi.setSystemTime(start.getTime() + CSP_LOG_INTERVAL_MS - 1);
    await post("application/csp-report", body);
    expect(error).toHaveBeenCalledTimes(1);

    vi.setSystemTime(start.getTime() + CSP_LOG_INTERVAL_MS);
    await post("application/csp-report", body);
    expect(error.mock.calls).toEqual([
      ["[csp] script-src-elem https://cdn.example.test /d/:id n=1"],
      ["[csp] script-src-elem https://cdn.example.test /d/:id n=4"],
    ]);
  });

  it("GET requires a signed-in browser session and refuses agents", async () => {
    mocks.requireUser.mockRejectedValueOnce(new HttpError(401, "Sign in required"));
    const anonymous = await GET();
    expect(anonymous.status).toBe(401);
    mocks.requireUser.mockResolvedValueOnce({ ...browserUser, agent: "Copilot CLI" });
    const agent = await GET();
    expect(agent.status).toBe(403);
    expect(await agent.json()).toEqual({ error: "CSP reports are only available from a signed-in browser session" });
    expect((await GET()).status).toBe(200);
  });
});
