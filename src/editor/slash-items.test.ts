import { describe, expect, it } from "vitest";
import { SLASH_GROUPS, SLASH_ITEMS, filterSlashItems, splitSlashQuery, todayIso } from "./slash-items";

const ids = (query: string, where?: { inTable: boolean; canComment: boolean }) => filterSlashItems(query, SLASH_ITEMS, where).map((i) => i.id);

describe("slash items", () => {
  it("every item has a unique id and an icon", () => {
    const seen = new Set<string>();
    for (const item of SLASH_ITEMS) {
      expect(seen.has(item.id)).toBe(false);
      seen.add(item.id);
      expect(item.icon.length).toBeGreaterThan(0);
      expect(SLASH_GROUPS).toContain(item.group);
    }
    expect(SLASH_ITEMS.map((i) => i.id)).toEqual(expect.arrayContaining(["text", "heading1", "heading2", "heading3", "bullet", "numbered", "task", "quote", "code", "divider", "table", "image", "video", "link", "comment", "date", "agent"]));
  });

  it("'ag' finds Comment (mention an agent there) and then 'Connect an AI agent' (the /agent item); 'keep' finds the /agent item alone", () => {
    expect(ids("ag")).toEqual(["comment", "agent"]);
    expect(ids("agent")).toEqual(["comment", "agent"]);
    expect(ids("copilot")).toEqual(["comment", "agent"]);
    expect(ids("keep")).toEqual(["agent"]);
    const agent = SLASH_ITEMS.find((i) => i.id === "agent")!;
    expect(agent.title).toBe("Connect an AI agent");
    expect(agent.description).toBe("Set up Copilot, Claude or Cursor, or invite your agent here");
    expect(agent.icon).toBe("Bot");
    expect(agent.run).toBeTypeOf("function");
    // Hands off to the shell's dialog; it does not edit the document.
    let opened = 0;
    agent.run!({ connectAgent: () => opened++ } as unknown as Parameters<NonNullable<typeof agent.run>>[0], "");
    expect(opened).toBe(1);
  });

  it("an empty query returns every item in group order", () => {
    const all = filterSlashItems("");
    expect(all).toHaveLength(SLASH_ITEMS.length);
    const groupIndex = all.map((i) => SLASH_GROUPS.indexOf(i.group));
    expect(groupIndex).toEqual([...groupIndex].sort((a, b) => a - b));
  });

  it("'h' lists the headings first, then other matches by group", () => {
    const result = ids("h");
    expect(result.slice(0, 3)).toEqual(["heading1", "heading2", "heading3"]);
    expect(result).toContain("divider"); // keyword "hr"
  });

  it("'tab' finds the table", () => {
    expect(ids("tab")).toEqual(["table", "toc"]);
  });

  it("'todo' and 'check' find the task list via keywords", () => {
    expect(ids("todo")).toEqual(["task"]);
    expect(ids("check")).toEqual(["task"]);
  });

  it("'ask' lands on Comment alone; 'ai' also finds Connect an AI agent, one row below Comment (#1075)", () => {
    expect(ids("ask")).toEqual(["comment"]);
    expect(ids("ai")).toEqual(["comment", "agent"]);
    const comment = SLASH_ITEMS.find((i) => i.id === "comment")!;
    expect(comment.keywords).toEqual(expect.arrayContaining(["agent", "ask", "copilot", "ai"]));
    // Commenting off: none of the agent words surface it.
    expect(ids("ask", { inTable: false, canComment: false })).toEqual([]);
  });

  it("matches any word of the title, case-insensitively", () => {
    expect(ids("LIST")).toEqual(["bullet", "numbered", "task"]);
    expect(ids("1")).toEqual(["heading1"]);
  });

  it("unknown queries return nothing", () => {
    expect(ids("zzz")).toEqual([]);
  });

  it("a trailing argument only matches items that accept one", () => {
    expect(ids("code ts")).toEqual(["code"]);
    expect(ids("table 2")).toEqual([]);
    expect(splitSlashQuery("code ts")).toEqual({ word: "code", arg: "ts" });
    expect(splitSlashQuery("Heading")).toEqual({ word: "heading", arg: "" });
  });

  it("offers 'Video or post from a link' after Link and before Upload video, and hands off to its dialog (#2317)", () => {
    const card = SLASH_ITEMS.find((i) => i.id === "card")!;
    const video = SLASH_ITEMS.find((i) => i.id === "video")!;
    expect(card.title).toBe("Video or post from a link");
    expect(card.description).toBe("Paste a link and it becomes a card");
    expect(card.group).toBe("Insert");
    expect(card.icon).toBe("SquarePlay");
    expect(video.title).toBe("Upload video");
    expect(video.group).toBe("Insert");
    expect(video.icon).toBe("Video");
    const insert = SLASH_ITEMS.filter((i) => i.group === "Insert").map((i) => i.id);
    expect(insert).toEqual(["image", "link", "card", "video", "comment", "date", "footnote", "lorem", "agent"]);
    // What a person would type to find it.
    for (const word of ["video", "post", "youtube", "tweet", "twitter", "x", "embed", "card", "media"]) expect(ids(word), word).toContain("card");
    expect(ids("video")).toEqual(["card", "video"]);
    // "/link" still offers Link first, so Enter there does what it always did.
    expect(ids("link")).toEqual(["link", "card"]);
    expect(ids("image")).toEqual(["image"]);
    expect(ids("mp4")).toEqual(["video"]);
    expect(ids("", { inTable: true, canComment: true })).not.toContain("video");
    expect(ids("", { inTable: false, canComment: true })).toContain("video");
    // A card is a block of its own at the top of the document: not offered inside a table.
    expect(ids("", { inTable: true, canComment: true })).not.toContain("card");
    expect(ids("", { inTable: false, canComment: true })).toContain("card");
    // It opens the dialog and does not edit the document.
    expect(card.command).toBeUndefined();
    let opened = 0;
    card.run!({ openCard: () => opened++ } as unknown as Parameters<NonNullable<typeof card.run>>[0], "");
    expect(opened).toBe(1);
  });

  it("hides block insertions inside tables and the comment item when commenting is off", () => {
    const inTable = ids("", { inTable: true, canComment: true });
    expect(inTable).not.toContain("table");
    expect(inTable).not.toContain("heading1");
    expect(inTable).toContain("text");
    expect(inTable).toContain("date");
    expect(ids("", { inTable: false, canComment: false })).not.toContain("comment");
    expect(ids("", { inTable: false, canComment: true })).toContain("comment");
  });

  it("formats today's date as ISO", () => {
    expect(todayIso(new Date(2026, 0, 5))).toBe("2026-01-05");
  });
});
