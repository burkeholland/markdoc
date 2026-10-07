import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The test-only delay inside an access change (`COLLAB_ACCESS_CHANGE_TEST_DELAY_MS`, issue #2281): where it is
 * honoured, that the rule is the development login's rule, and that a real production server ignores it.
 */

process.env.PGLITE_DATA_DIR = "memory://";
process.env.AUTH_SECRET = "test-secret-test-secret-test-secret";
delete process.env.DATABASE_URL;

// src/auth.ts builds the sign-in configuration when it is imported; only its `devLoginEnabled` is wanted here.
vi.mock("next-auth", () => ({ default: () => ({ handlers: {}, auth: async () => null, signIn: async () => undefined, signOut: async () => undefined }) }));
vi.mock("next-auth/providers/github", () => ({ default: () => ({}) }));
vi.mock("next-auth/providers/credentials", () => ({ default: () => ({}) }));

const { accessChangeTestDelayMs, ACCESS_CHANGE_TEST_DELAY_MAX_MS, changeCollaboratorAccess } = await import("./authorization");

const logins = [undefined, "", "0", "1", "true", "force", "FORCE"];
const environments = [undefined, "development", "test", "production"];
const cases = logins.flatMap((login) => environments.map((nodeEnv) => ({ login, nodeEnv })));

describe("the test delay inside an access change", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it.each(cases)("is honoured exactly where the development login is: AUTH_DEV_LOGIN=$login NODE_ENV=$nodeEnv", async ({ login, nodeEnv }) => {
    // The real rule, evaluated by src/auth.ts itself under this environment.
    vi.stubEnv("AUTH_DEV_LOGIN", login as string);
    vi.stubEnv("NODE_ENV", nodeEnv as string);
    vi.resetModules();
    const { devLoginEnabled } = await import("@/auth");
    expect(typeof devLoginEnabled).toBe("boolean");
    expect(accessChangeTestDelayMs({ AUTH_DEV_LOGIN: login, NODE_ENV: nodeEnv, COLLAB_ACCESS_CHANGE_TEST_DELAY_MS: "40" }) === 40).toBe(devLoginEnabled);
  });

  it("the matrix above covers both answers", () => {
    const answers = cases.map(({ login, nodeEnv }) => accessChangeTestDelayMs({ AUTH_DEV_LOGIN: login, NODE_ENV: nodeEnv, COLLAB_ACCESS_CHANGE_TEST_DELAY_MS: "40" }));
    expect(answers.filter((ms) => ms === 40)).toHaveLength(7);
    expect(answers.filter((ms) => ms === 0)).toHaveLength(cases.length - 7);
  });

  it("a production server without the force switch ignores it, whatever it is set to", () => {
    for (const login of [undefined, "", "0", "1", "true"]) {
      for (const value of ["40", "2000", "1e9"]) {
        expect(accessChangeTestDelayMs({ AUTH_DEV_LOGIN: login, NODE_ENV: "production", COLLAB_ACCESS_CHANGE_TEST_DELAY_MS: value })).toBe(0);
      }
    }
  });

  it.each([
    [undefined, 0],
    ["", 0],
    ["forty", 0],
    ["NaN", 0],
    ["Infinity", 0],
    ["-5", 0],
    ["0", 0],
    ["40", 40],
    ["12.5", 12.5],
    ["2000", 2000],
    ["2001", ACCESS_CHANGE_TEST_DELAY_MAX_MS],
    ["1e9", ACCESS_CHANGE_TEST_DELAY_MAX_MS],
  ])("COLLAB_ACCESS_CHANGE_TEST_DELAY_MS=%s is %s ms (capped, and 0 for anything that is not a positive number)", (value, expected) => {
    expect(ACCESS_CHANGE_TEST_DELAY_MAX_MS).toBe(2000);
    expect(accessChangeTestDelayMs({ AUTH_DEV_LOGIN: "1", NODE_ENV: "development", COLLAB_ACCESS_CHANGE_TEST_DELAY_MS: value })).toBe(expected);
    expect(accessChangeTestDelayMs({ AUTH_DEV_LOGIN: "force", NODE_ENV: "production", COLLAB_ACCESS_CHANGE_TEST_DELAY_MS: value })).toBe(expected);
  });

  /** How long an access change keeps going after its database write returned. */
  async function afterTheWrite(): Promise<number> {
    let written = 0;
    await changeCollaboratorAccess("no-such-document", "nobody", null, async () => {
      written = performance.now();
    });
    return performance.now() - written;
  }

  it("an access change really waits that long after its database write, and does not without the switch", async () => {
    vi.stubEnv("AUTH_DEV_LOGIN", "1");
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("COLLAB_ACCESS_CHANGE_TEST_DELAY_MS", "120");
    // Time is the subject: a timer may fire a millisecond early, never 100 ms early.
    expect(await afterTheWrite()).toBeGreaterThanOrEqual(115);

    vi.stubEnv("NODE_ENV", "production");
    expect(await afterTheWrite()).toBeLessThan(60);

    vi.stubEnv("AUTH_DEV_LOGIN", "force");
    expect(await afterTheWrite()).toBeGreaterThanOrEqual(115);

    vi.stubEnv("COLLAB_ACCESS_CHANGE_TEST_DELAY_MS", "");
    expect(await afterTheWrite()).toBeLessThan(60);
  });

  it("the wait also runs when the database write fails, and the failure still comes out", async () => {
    vi.stubEnv("AUTH_DEV_LOGIN", "1");
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("COLLAB_ACCESS_CHANGE_TEST_DELAY_MS", "120");
    const started = performance.now();
    await expect(
      changeCollaboratorAccess("no-such-document", "nobody", "viewer", async () => {
        throw new Error("refused");
      }),
    ).rejects.toThrow("refused");
    expect(performance.now() - started).toBeGreaterThanOrEqual(115);
  });
});
