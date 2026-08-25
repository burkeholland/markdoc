// The Burke-scale seeder against a rate-limited API (#157): a 429 with `retryAfter` is slept through and
// the call repeated, so `npm run seed:burke-scale` finishes on a server whose limiter is on instead of
// aborting half-seeded. The fixture lives in e2e/ (Playwright and the script share it); the behaviour
// is the client side of src/server/rate-limit.ts, so the test lives here.
import { describe, expect, it } from "vitest";
import { RATE_LIMIT_HINT, retryAfterSeconds, withRateLimitRetry, type SeedRequest, type SeedResponse } from "../../e2e/fixtures/burke-scale";

function response(status: number, body: unknown, headers: Record<string, string> = {}): SeedResponse {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return { ok: () => status >= 200 && status < 300, status: () => status, text: async () => text, json: async () => JSON.parse(text) as unknown, headers: () => headers };
}

const limited = (retryAfter: number) => response(429, { error: `Rate limit exceeded. Retry in ${retryAfter} s.`, retryAfter }, { "retry-after": String(retryAfter) });

/** A fake server that answers the queued responses in order (the last one repeats). */
function server(...queue: SeedResponse[]) {
  const calls: { verb: string; url: string; data?: unknown }[] = [];
  const send = (verb: string) => async (url: string, o?: { data?: unknown }) => {
    calls.push({ verb, url, data: o?.data });
    return queue.length > 1 ? queue.shift()! : queue[0];
  };
  const request: SeedRequest = { get: send("GET"), post: send("POST"), put: send("PUT"), delete: send("DELETE") };
  return { request, calls };
}

function fakeSleep() {
  const slept: number[] = [];
  return { slept, sleep: async (ms: number) => void slept.push(ms) };
}

describe("withRateLimitRetry", () => {
  it("sleeps retryAfter seconds on 429 and repeats the call; the seed continues on 200", async () => {
    const { request, calls } = server(limited(1), response(201, { document: { id: "abc" } }));
    const { slept, sleep } = fakeSleep();
    const firsts: number[] = [];
    const paced = withRateLimitRetry(request, { sleep, onFirst: (s) => firsts.push(s) });

    const res = await paced.post("/api/documents/x/assets?name=figure-1.png", { data: Buffer.from([1]) });

    expect(res.status()).toBe(201);
    expect(await res.json()).toEqual({ document: { id: "abc" } });
    expect(calls.map((c) => c.verb + " " + c.url)).toEqual(["POST /api/documents/x/assets?name=figure-1.png", "POST /api/documents/x/assets?name=figure-1.png"]);
    expect(calls[1].data).toBe(calls[0].data);
    expect(slept).toEqual([1000]);
    expect(firsts).toEqual([1]);
  });

  it("keeps retrying through several 429s, each with its own wait", async () => {
    const { request, calls } = server(limited(1), limited(2), limited(3), response(200, { ok: true }));
    const { slept, sleep } = fakeSleep();
    const paced = withRateLimitRetry(request, { sleep });

    const res = await paced.put("/api/documents/x/star");

    expect(res.status()).toBe(200);
    expect(calls).toHaveLength(4);
    expect(slept).toEqual([1000, 2000, 3000]);
  });

  it("gives the 429 back once a request has waited maxWaitSeconds in total", async () => {
    const { request, calls } = server(limited(3));
    const { slept, sleep } = fakeSleep();
    const paced = withRateLimitRetry(request, { sleep, maxWaitSeconds: 7 });

    const res = await paced.post("/api/documents", { data: { title: "t" } });

    expect(res.status()).toBe(429);
    // 3 + 3 = 6 s fits in 7; a third sleep would reach 9 s, so the 429 is returned after the third call.
    expect(slept).toEqual([3000, 3000]);
    expect(calls).toHaveLength(3);
  });

  it("passes anything other than 429 straight through and only reports the first 429", async () => {
    const { request, calls } = server(response(404, { error: "not found" }));
    const { slept, sleep } = fakeSleep();
    let firsts = 0;
    const paced = withRateLimitRetry(request, { sleep, onFirst: () => firsts++ });

    expect((await paced.get("/api/documents/missing")).status()).toBe(404);
    expect((await paced.delete("/api/documents/missing")).status()).toBe(404);
    expect(slept).toEqual([]);
    expect(calls).toHaveLength(2);
    expect(firsts).toBe(0);

    const again = server(limited(1), limited(1), response(200, {}));
    const pacedAgain = withRateLimitRetry(again.request, { sleep, onFirst: () => firsts++ });
    await pacedAgain.post("/a");
    await pacedAgain.post("/b");
    expect(firsts).toBe(1);
  });

  it("names the RATE_LIMIT=off switch for whoever reads the failure", () => {
    expect(RATE_LIMIT_HINT).toContain("RATE_LIMIT=off");
  });
});

describe("retryAfterSeconds", () => {
  it("prefers the JSON body, then the Retry-After header, then 1", async () => {
    expect(await retryAfterSeconds(response(429, { retryAfter: 2 }, { "retry-after": "9" }))).toBe(2);
    expect(await retryAfterSeconds(response(429, { error: "x" }, { "retry-after": "4" }))).toBe(4);
    expect(await retryAfterSeconds(response(429, "Too Many Requests", { "retry-after": "5" }))).toBe(5);
    expect(await retryAfterSeconds(response(429, "Too Many Requests"))).toBe(1);
    expect(await retryAfterSeconds({ ok: () => false, status: () => 429, text: async () => "", json: async () => JSON.parse("") as unknown })).toBe(1);
  });

  it("rounds fractional and rejects non-positive values", async () => {
    expect(await retryAfterSeconds(response(429, { retryAfter: 0.2 }))).toBe(1);
    expect(await retryAfterSeconds(response(429, { retryAfter: 0 }, { "retry-after": "3" }))).toBe(3);
    expect(await retryAfterSeconds(response(429, { retryAfter: -1 }))).toBe(1);
  });
});
