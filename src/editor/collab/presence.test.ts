import { describe, expect, it } from "vitest";
import { followReducer, IDLE_AFTER_MS, isIdle, sectionAt } from "./follow";
import type { HeadingInfo } from "../markdown/parse";

const h = (text: string, from: number, level = 1): HeadingInfo => ({ text, from, level, line: 1, id: text.toLowerCase() });

describe("sectionAt", () => {
  const headings = [h("Intro", 10), h("Goals", 100), h("Details", 150, 2), h("Wrap-up", 300)];

  it("is null without a cursor or before the first heading", () => {
    expect(sectionAt(headings, null)).toBeNull();
    expect(sectionAt(headings, 0)).toBeNull();
    expect(sectionAt(headings, 9)).toBeNull();
    expect(sectionAt([], 50)).toBeNull();
  });

  it("returns the heading at or above the offset", () => {
    expect(sectionAt(headings, 10)).toBe("Intro");
    expect(sectionAt(headings, 99)).toBe("Intro");
    expect(sectionAt(headings, 100)).toBe("Goals");
    expect(sectionAt(headings, 149)).toBe("Goals");
  });

  it("picks the nearest heading inside a nested section, regardless of level", () => {
    expect(sectionAt(headings, 151)).toBe("Details");
    expect(sectionAt(headings, 299)).toBe("Details");
    expect(sectionAt(headings, 5000)).toBe("Wrap-up");
  });
});

describe("isIdle", () => {
  it("dims only after the threshold", () => {
    const now = 1_000_000;
    expect(isIdle(null, now)).toBe(false);
    expect(isIdle(now, now)).toBe(false);
    expect(isIdle(now - IDLE_AFTER_MS + 1, now)).toBe(false);
    expect(isIdle(now - IDLE_AFTER_MS, now)).toBe(true);
    expect(isIdle(now - 5 * IDLE_AFTER_MS, now)).toBe(true);
  });
});

describe("followReducer", () => {
  it("starts and switches following", () => {
    expect(followReducer(null, { type: "follow", userId: "bob" })).toEqual({ userId: "bob", left: null });
    expect(followReducer("bob", { type: "follow", userId: "carol" })).toEqual({ userId: "carol", left: null });
  });

  it("stops on Esc/Stop, own scroll and typing", () => {
    expect(followReducer("bob", { type: "stop" })).toEqual({ userId: null, left: null });
    expect(followReducer("bob", { type: "user-scroll" })).toEqual({ userId: null, left: null });
    expect(followReducer("bob", { type: "typing" })).toEqual({ userId: null, left: null });
    expect(followReducer(null, { type: "user-scroll" })).toEqual({ userId: null, left: null });
  });

  it("stops and reports who left when the followed user disappears", () => {
    expect(followReducer("bob", { type: "presence", userIds: ["alice", "bob"] })).toEqual({ userId: "bob", left: null });
    expect(followReducer("bob", { type: "presence", userIds: ["alice"] })).toEqual({ userId: null, left: "bob" });
    expect(followReducer(null, { type: "presence", userIds: [] })).toEqual({ userId: null, left: null });
  });
});
