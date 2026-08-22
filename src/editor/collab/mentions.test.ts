import { describe, expect, it } from "vitest";
import { mentionTriggerAt, parseMentions, splitMentions } from "./mentions";

describe("splitMentions", () => {
  it("returns nothing for empty input", () => {
    expect(splitMentions("")).toEqual([]);
  });

  it("leaves plain text alone", () => {
    expect(splitMentions("hello world")).toEqual([{ type: "text", value: "hello world" }]);
  });

  it("matches a mention at the start of the string", () => {
    expect(splitMentions("@bob can you look?")).toEqual([
      { type: "mention", value: "bob" },
      { type: "text", value: " can you look?" },
    ]);
  });

  it("matches a mention at the end of the string", () => {
    expect(splitMentions("ping @bob")).toEqual([
      { type: "text", value: "ping " },
      { type: "mention", value: "bob" },
    ]);
  });

  it("matches a bare mention", () => {
    expect(splitMentions("@bob")).toEqual([{ type: "mention", value: "bob" }]);
  });

  it("handles multiple mentions and keeps the text between them", () => {
    expect(splitMentions("hi @alice and @bob-smith, thanks")).toEqual([
      { type: "text", value: "hi " },
      { type: "mention", value: "alice" },
      { type: "text", value: " and " },
      { type: "mention", value: "bob-smith" },
      { type: "text", value: ", thanks" },
    ]);
  });

  it("stops at punctuation", () => {
    expect(splitMentions("(@bob) @alice's idea. @carol!")).toEqual([
      { type: "text", value: "(" },
      { type: "mention", value: "bob" },
      { type: "text", value: ") " },
      { type: "mention", value: "alice" },
      { type: "text", value: "'s idea. " },
      { type: "mention", value: "carol" },
      { type: "text", value: "!" },
    ]);
  });

  it("does not treat e-mail addresses as mentions", () => {
    expect(splitMentions("mail a@b.com or bob@example.org today")).toEqual([{ type: "text", value: "mail a@b.com or bob@example.org today" }]);
  });

  it("ignores a lone @ and @ followed by invalid characters", () => {
    expect(splitMentions("@ and @_x and @.y")).toEqual([{ type: "text", value: "@ and @_x and @.y" }]);
  });

  it("ignores tokens longer than a GitHub login", () => {
    const long = "a".repeat(40);
    expect(splitMentions(`@${long}`)).toEqual([{ type: "text", value: `@${long}` }]);
    const max = "b".repeat(39);
    expect(splitMentions(`@${max}`)).toEqual([{ type: "mention", value: max }]);
  });

  it("works across newlines", () => {
    expect(splitMentions("first\n@bob second")).toEqual([
      { type: "text", value: "first\n" },
      { type: "mention", value: "bob" },
      { type: "text", value: " second" },
    ]);
  });
});

describe("parseMentions", () => {
  it("returns unique lower-cased logins in order", () => {
    expect(parseMentions("@Bob @alice @bob, and a@b.com")).toEqual(["bob", "alice"]);
    expect(parseMentions("no one here")).toEqual([]);
  });
});

describe("mentionTriggerAt", () => {
  it("detects @ with an empty query at the caret", () => {
    expect(mentionTriggerAt("hi @", 4)).toEqual({ start: 3, query: "" });
  });

  it("detects a partial login before the caret", () => {
    expect(mentionTriggerAt("hi @bo and more", 6)).toEqual({ start: 3, query: "bo" });
  });

  it("does not trigger inside an e-mail address or after a completed token", () => {
    expect(mentionTriggerAt("a@b", 3)).toBeNull();
    expect(mentionTriggerAt("hi @bob ", 8)).toBeNull();
    expect(mentionTriggerAt("plain", 5)).toBeNull();
  });
});
