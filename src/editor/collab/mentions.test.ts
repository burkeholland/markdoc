import { describe, expect, it } from "vitest";
import { agentMentionLogin, agentMentionSlug, mentionTriggerAt, parseAgentMentions, parseMentions, splitMentions } from "./mentions";

describe("agent mentions (@login/Agent-Name)", () => {
  it("slugs token names into mention-safe text", () => {
    expect(agentMentionSlug("Copilot CLI")).toBe("Copilot-CLI");
    expect(agentMentionSlug("  GitHub Copilot (work) ")).toBe("GitHub-Copilot-work");
    expect(agentMentionSlug("***")).toBe("agent");
    expect(agentMentionSlug("x".repeat(50))).toHaveLength(39);
    expect(agentMentionLogin("burke", "Copilot CLI")).toBe("burke/Copilot-CLI");
  });

  it("splits the agent suffix off and still resolves the mention to the owner", () => {
    expect(splitMentions("@burke/Copilot-CLI tighten this")).toEqual([
      { type: "mention", value: "burke", agent: "Copilot-CLI" },
      { type: "text", value: " tighten this" },
    ]);
    expect(parseMentions("@burke/Copilot-CLI and @Burke too")).toEqual(["burke"]);
    expect(parseAgentMentions("@burke/Copilot-CLI, @alice and @Burke/copilot-cli again, @bob/Scribe")).toEqual([
      { login: "burke", agent: "Copilot-CLI" },
      { login: "bob", agent: "Scribe" },
    ]);
  });

  it("a bare slash after a login is plain text", () => {
    expect(splitMentions("@bob/ ok")).toEqual([
      { type: "mention", value: "bob" },
      { type: "text", value: "/ ok" },
    ]);
  });

  it("the composer trigger follows an agent login being typed", () => {
    expect(mentionTriggerAt("hi @burke/Cop", 13)).toEqual({ start: 3, query: "burke/Cop" });
    expect(mentionTriggerAt("hi @burke/", 10)).toEqual({ start: 3, query: "burke/" });
  });
});

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
