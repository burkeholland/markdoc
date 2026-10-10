import { describe, expect, it } from "vitest";
import { agentDisplayName, agentMentionLogin, agentMentionSlug, mentionTriggerAt, parseAgentMentions, parseMentions, possessive, splitMentions } from "./mentions";

describe("agentDisplayName (owner-labelled agent names, #1296)", () => {
  const agent = { name: "Copilot CLI", ownerLogin: "burkeholland", ownerName: "Burke" };

  it("names the viewer's own agent plainly and someone else's with its owner", () => {
    expect(agentDisplayName(agent, "burkeholland")).toBe("Copilot CLI");
    expect(agentDisplayName(agent, "drew")).toBe("Burke's Copilot CLI");
    expect(agentDisplayName(agent, null)).toBe("Burke's Copilot CLI");
    expect(agentDisplayName(agent, undefined)).toBe("Burke's Copilot CLI");
  });

  it("matches the viewer to the owner case-insensitively and ignores surrounding whitespace", () => {
    expect(agentDisplayName(agent, "BurkeHolland")).toBe("Copilot CLI");
    expect(agentDisplayName(agent, " burkeholland ")).toBe("Copilot CLI");
  });

  it("falls back to the owner's login without a display name, and to the bare name without an owner", () => {
    expect(agentDisplayName({ name: "Copilot CLI", ownerLogin: "drew" }, "burkeholland")).toBe("drew's Copilot CLI");
    expect(agentDisplayName({ name: "Copilot CLI", ownerLogin: "drew", ownerName: "  " }, "burkeholland")).toBe("drew's Copilot CLI");
    expect(agentDisplayName({ name: "Copilot CLI", ownerLogin: null }, "burkeholland")).toBe("Copilot CLI");
    expect(agentDisplayName({ name: "Copilot CLI" }, "burkeholland")).toBe("Copilot CLI");
  });

  it("uses a bare apostrophe after a name that already ends in s", () => {
    expect(possessive("Chris")).toBe("Chris'");
    expect(possessive("Burke")).toBe("Burke's");
    expect(possessive("JAMES")).toBe("JAMES'");
    expect(agentDisplayName({ name: "Scribe", ownerLogin: "chris", ownerName: "Chris" }, "burkeholland")).toBe("Chris' Scribe");
  });
});

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

  it("reads a managed account's login whole: the handle, the underscore and the short code", () => {
    expect(splitMentions("ping @mona-cat_octo, thanks")).toEqual([
      { type: "text", value: "ping " },
      { type: "mention", value: "mona-cat_octo" },
      { type: "text", value: ", thanks" },
    ]);
    expect(splitMentions("@mona-cat_octo/Copilot-CLI tighten this")).toEqual([
      { type: "mention", value: "mona-cat_octo", agent: "Copilot-CLI" },
      { type: "text", value: " tighten this" },
    ]);
    expect(parseMentions("@Mona-Cat_Octo and @mona-cat")).toEqual(["mona-cat_octo", "mona-cat"]);
    expect(parseAgentMentions("@Mona-Cat_Octo/Scribe")).toEqual([{ login: "mona-cat_octo", agent: "Scribe" }]);
  });

  it("never cuts a token with an underscore down to another account's login", () => {
    for (const body of ["@a_b_c", "@mona_oc-to"]) {
      expect(splitMentions(body), body).toEqual([{ type: "text", value: body }]);
    }
    // An underscore that no short code follows is ordinary text after the login.
    expect(splitMentions("@bob_ ok")).toEqual([
      { type: "mention", value: "bob" },
      { type: "text", value: "_ ok" },
    ]);
  });

  it("holds a managed account's login to GitHub's 39 characters as well", () => {
    const max = `${"a".repeat(30)}_${"b".repeat(8)}`;
    expect(splitMentions(`@${max}`)).toEqual([{ type: "mention", value: max }]);
    const long = `${"a".repeat(31)}_${"b".repeat(8)}`;
    expect(splitMentions(`@${long} @bob`)).toEqual([
      { type: "text", value: `@${long} ` },
      { type: "mention", value: "bob" },
    ]);
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

  it("follows a managed account's login through its underscore and short code", () => {
    expect(mentionTriggerAt("hi @mona-cat_", 13)).toEqual({ start: 3, query: "mona-cat_" });
    expect(mentionTriggerAt("hi @mona-cat_oc", 15)).toEqual({ start: 3, query: "mona-cat_oc" });
    expect(mentionTriggerAt("hi @mona-cat_octo/Cop", 21)).toEqual({ start: 3, query: "mona-cat_octo/Cop" });
    expect(mentionTriggerAt("hi @_x", 6)).toBeNull();
    expect(mentionTriggerAt("hi @mona_oc_", 12)).toBeNull();
  });
});
