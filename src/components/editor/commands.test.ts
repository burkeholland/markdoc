import { describe, expect, it } from "vitest";
import {
  buildCommands,
  buildDashboardCommands,
  filterCommands,
  groupCommands,
  loadRecent,
  matchRank,
  pushRecent,
  saveRecent,
  withRecentFirst,
  type Command,
  type DashboardCommandContext,
  type EditorCommandContext,
} from "./commands";
import { findReplaceShortcut } from "@/lib/utils";

function stubCtx(overrides: Partial<EditorCommandContext> = {}, session: Partial<EditorCommandContext["session"]> = {}): EditorCommandContext {
  const calls: string[] = [];
  const ctx: EditorCommandContext & { calls: string[] } = {
    calls,
    actions: {
      rich: null,
      toggleMark: (k) => calls.push(`mark:${k}`),
      undo: () => calls.push("undo"),
      redo: () => calls.push("redo"),
      revealSource: (offset) => calls.push(`reveal:${offset}`),
    },
    session: {
      contentReady: true,
      canEdit: true,
      canComment: true,
      mode: "editing",
      canChangeMode: true,
      setMode: (m) => calls.push(`mode:${m}`),
      ...session,
    },
    doc: { id: "d1", title: "Doc", storage: "local" },
    isOwner: true,
    slashWhere: { inTable: false, canComment: true },
    setDialog: (k) => calls.push(`dialog:${k}`),
    openLink: () => calls.push("link"),
    openImage: () => calls.push("image"),
    startComment: () => calls.push("comment"),
    toggleComments: () => calls.push("comments"),
    toggleHistory: () => calls.push("history"),
    toggleActivity: () => calls.push("activity"),
    layout: "split",
    setLayout: (l) => calls.push(`layout:${l}`),
    outlineOpen: true,
    toggleOutline: () => calls.push("outline"),
    syncScroll: true,
    setSyncScroll: (on) => calls.push(`sync:${on}`),
    openFind: (replace) => calls.push(`find:${replace}`),
    download: (f) => calls.push(`download:${f}`),
    copyMarkdown: () => calls.push("copy"),
    duplicate: () => calls.push("duplicate"),
    trash: () => calls.push("trash"),
    publish: () => calls.push("publish"),
    openReader: () => calls.push("reader"),
    navigate: (href) => calls.push(`nav:${href}`),
    headings: () => [
      { id: "intro", level: 1, text: "Intro", from: 0, line: 1 },
      { id: "details", level: 2, text: "Details", from: 20, line: 5 },
    ],
    recentDocuments: async () => [{ id: "a", title: "Alpha" }, { id: "b", title: "" }],
    ...overrides,
  };
  return ctx;
}

const visible = (cmds: Command[]) => cmds.filter((c) => !c.when || c.when());

describe("the palette's Insert entry for a card (#2317)", () => {
  it("'Video or post from a link' opens the card dialog, for people who can edit, and not in a table", () => {
    const ctx = stubCtx();
    ctx.actions = { ...ctx.actions, rich: {} as NonNullable<EditorCommandContext["actions"]["rich"]> };
    const entry = buildCommands(ctx).find((c) => c.id === "block:card")!;
    expect(entry.title).toBe("Video or post from a link");
    expect(entry.group).toBe("Insert");
    expect(entry.icon).toBe("SquarePlay");
    expect(entry.when?.()).toBe(true);
    void entry.run();
    expect((ctx as unknown as { calls: string[] }).calls).toEqual(["dialog:card"]);
    expect(filterCommands("video", buildCommands(ctx)).map((c) => c.id)).toContain("block:card");
    expect(filterCommands("youtube", buildCommands(ctx)).map((c) => c.id)).toContain("block:card");

    const readOnly = buildCommands(stubCtx({}, { canEdit: false })).find((c) => c.id === "block:card")!;
    expect(readOnly.when?.()).toBe(false);
    expect(buildCommands(stubCtx({ slashWhere: { inTable: true, canComment: true } })).map((c) => c.id)).not.toContain("block:card");
  });

  it("re-checks edit readiness when a previously visible insert command runs", () => {
    const ctx = stubCtx();
    ctx.actions = { ...ctx.actions, rich: {} as NonNullable<EditorCommandContext["actions"]["rich"]> };
    const entry = buildCommands(ctx).find((command) => command.id === "block:card")!;
    expect(entry.when?.()).toBe(true);
    ctx.session.contentReady = false;
    void entry.run();
    expect((ctx as unknown as { calls: string[] }).calls).toEqual([]);
  });

  it("uses comment permission after readiness instead of requiring text-edit permission", () => {
    const ctx = stubCtx({}, { canEdit: false, canComment: true });
    ctx.actions = { ...ctx.actions, rich: {} as NonNullable<EditorCommandContext["actions"]["rich"]> };
    const entry = buildCommands(ctx).find((command) => command.id === "block:comment")!;
    expect(entry.when?.()).toBe(true);
    void entry.run();
    expect((ctx as unknown as { calls: string[] }).calls).toEqual(["comment"]);
  });
});
const ids = (cmds: Command[]) => cmds.map((c) => c.id);

describe("buildCommands", () => {
  it("gives every command a unique id and a group", () => {
    const cmds = buildCommands(stubCtx());
    const seen = new Set<string>();
    for (const c of cmds) {
      expect(seen.has(c.id), `duplicate id ${c.id}`).toBe(false);
      seen.add(c.id);
      expect(c.group.length).toBeGreaterThan(0);
      expect(c.title.length).toBeGreaterThan(0);
    }
    expect(ids(cmds)).toEqual(
      expect.arrayContaining(["nav:heading", "nav:recent", "nav:dashboard", "block:heading1", "block:table", "doc:share", "doc:publish", "doc:reader", "doc:find", "view:outline", "help:shortcuts"]),
    );
  });

  it("shows shortcuts on items that have one", () => {
    const byId = new Map(buildCommands(stubCtx()).map((c) => [c.id, c]));
    expect(byId.get("block:heading1")?.shortcut).toBe("Mod-Alt-1");
    expect(byId.get("format:bold")?.shortcut).toBe("Mod-B");
    expect(byId.get("doc:find")?.shortcut).toBe("Mod-F");
    expect(byId.get("doc:find-replace")?.shortcut).toBe(findReplaceShortcut());
    expect(byId.get("help:shortcuts")?.shortcut).toBe("Mod-/");
  });

  it("hides editing commands when the user cannot edit", () => {
    const editable = visible(buildCommands(stubCtx()));
    expect(ids(editable)).toContain("doc:publish");
    expect(ids(editable)).toContain("format:bold");
    expect(ids(editable)).toContain("block:heading1");

    const readOnly = visible(buildCommands(stubCtx({}, { canEdit: false, canComment: false, canChangeMode: false })));
    expect(ids(readOnly)).not.toContain("doc:publish");
    expect(ids(readOnly)).not.toContain("format:bold");
    expect(ids(readOnly)).not.toContain("block:heading1");
    expect(ids(readOnly)).not.toContain("block:comment");
    expect(ids(readOnly)).not.toContain("mode:suggesting");
    expect(ids(readOnly)).toContain("doc:reader");
    expect(ids(readOnly)).toContain("doc:download-md");
    expect(ids(readOnly)).toContain("nav:heading");
  });

  it("hides owner-only and current-state items", () => {
    const notOwner = visible(buildCommands(stubCtx({ isOwner: false })));
    expect(ids(notOwner)).not.toContain("doc:trash");
    const split = visible(buildCommands(stubCtx({ layout: "split" })));
    expect(ids(split)).not.toContain("layout:split");
    expect(ids(split)).toContain("layout:code");
    expect(ids(split)).not.toContain("mode:editing");
    expect(ids(split)).toContain("mode:viewing");
  });

  it("skips slash items that are unavailable at the caret", () => {
    const inTable = buildCommands(stubCtx({ slashWhere: { inTable: true, canComment: true } }));
    expect(ids(inTable)).not.toContain("block:table");
    expect(ids(inTable)).not.toContain("block:heading1");
    expect(ids(inTable)).toContain("block:text");
  });

  it("keeps canvas editing commands but removes operations outside the embedded document", () => {
    const canvas = ids(buildCommands(stubCtx({ embed: true })));
    expect(canvas).toEqual(expect.arrayContaining(["nav:heading", "format:bold", "block:heading1", "doc:comments", "doc:find", "mode:viewing", "layout:code", "view:outline", "help:shortcuts"]));
    expect(canvas).not.toEqual(
      expect.arrayContaining(["nav:recent", "nav:dashboard", "doc:share", "doc:publish", "doc:download-md", "doc:copy-markdown", "doc:reader", "doc:duplicate", "doc:trash"]),
    );
  });

  it("offers the link card command that applies, to people who can edit, in the document and in the canvas (#2317)", () => {
    const calls: string[] = [];
    const withCard = (state: "card" | "link" | null, session: Partial<EditorCommandContext["session"]> = {}, embed = false) => {
      const ctx = stubCtx({ embed }, session);
      ctx.actions = { ...ctx.actions, cardState: () => state, showCard: (as) => calls.push(`card:${as}`) };
      return buildCommands(ctx);
    };
    const cardIds = (cmds: Command[]) => ids(visible(cmds)).filter((id) => id.startsWith("card:"));

    expect(cardIds(withCard("card"))).toEqual(["card:as-text"]);
    expect(cardIds(withCard("link"))).toEqual(["card:as-card"]);
    expect(cardIds(withCard(null))).toEqual([]);
    expect(cardIds(withCard("card", {}, true))).toEqual(["card:as-text"]);
    // Not for people who cannot edit, and not when the shell gives no card state at all.
    expect(cardIds(withCard("card", { canEdit: false }))).toEqual([]);
    expect(cardIds(withCard("link", { canEdit: false }))).toEqual([]);
    expect(cardIds(buildCommands(stubCtx()))).toEqual([]);

    const byId = new Map(withCard("card").map((c) => [c.id, c]));
    expect(byId.get("card:as-text")?.title).toBe("Show card as text");
    expect(byId.get("card:as-card")?.title).toBe("Show link as card");
    void byId.get("card:as-text")!.run();
    void byId.get("card:as-card")!.run();
    expect(calls).toEqual(["card:text", "card:card"]);
    // Found by the words a person would type.
    expect(ids(filterCommands("show as text", visible(withCard("card"))))[0]).toBe("card:as-text");
    expect(ids(filterCommands("card", visible(withCard("link"))))).toContain("card:as-card");
  });

  it("lists headings and recent documents as children", async () => {
    const ctx = stubCtx();
    const byId = new Map(buildCommands(ctx).map((c) => [c.id, c]));
    const headings = await byId.get("nav:heading")!.children!();
    expect(headings.map((h) => h.title)).toEqual(["Intro", "Details"]);
    headings[1].run();
    expect((ctx as unknown as { calls: string[] }).calls).toContain("reveal:20");

    const docs = await byId.get("nav:recent")!.children!();
    expect(docs.map((d) => d.title)).toEqual(["Alpha", "Untitled"]);
    docs[0].run();
    expect((ctx as unknown as { calls: string[] }).calls).toContain("nav:/d/a");
  });

  it("runs the plumbing it was given", () => {
    const ctx = stubCtx();
    const byId = new Map(buildCommands(ctx).map((c) => [c.id, c]));
    byId.get("doc:reader")!.run();
    byId.get("doc:find-replace")!.run();
    byId.get("view:sync-scroll")!.run();
    byId.get("layout:code")!.run();
    byId.get("help:shortcuts")!.run();
    expect((ctx as unknown as { calls: string[] }).calls).toEqual(["reader", "find:true", "sync:false", "layout:code", "dialog:shortcuts"]);
  });

  it("offers 'Connect an AI agent' for 'agent' only when the shell wires it", () => {
    const without = buildCommands(stubCtx());
    expect(ids(visible(without))).not.toContain("doc:connect-agent");
    const calls: string[] = [];
    const cmds = buildCommands(stubCtx({ connectAgent: () => calls.push("connect-agent") }));
    const hits = ids(filterCommands("agent", cmds));
    expect(hits).toContain("doc:connect-agent");
    // The `/agent` slash item is the same action; the palette lists it once.
    expect(ids(cmds)).not.toContain("block:agent");
    cmds.find((c) => c.id === "doc:connect-agent")!.run();
    expect(calls).toEqual(["connect-agent"]);
  });

  it("offers 'Comment on the document' when the shell wires it and the user can comment (#1025)", () => {
    expect(ids(visible(buildCommands(stubCtx())))).not.toContain("doc:comment-document");
    const calls: string[] = [];
    const cmds = buildCommands(stubCtx({ commentDocument: () => calls.push("comment-document") }));
    expect(ids(visible(cmds))).toContain("doc:comment-document");
    expect(ids(filterCommands("whole document", cmds))).toContain("doc:comment-document");
    cmds.find((c) => c.id === "doc:comment-document")!.run();
    expect(calls).toEqual(["comment-document"]);
    const viewer = buildCommands(stubCtx({ commentDocument: () => calls.push("nope") }, { canComment: false }));
    expect(ids(visible(viewer))).not.toContain("doc:comment-document");
  });
});

describe("filterCommands", () => {
  const cmds = buildCommands(stubCtx());

  it("returns everything visible for an empty query, in registry order", () => {
    expect(ids(filterCommands("", cmds))).toEqual(ids(visible(cmds)));
  });

  it("ranks exact title > prefix > title word > keyword", () => {
    const sample: Command[] = [
      { id: "kw", title: "Comments", keywords: ["head"], group: "g", run: () => {} },
      { id: "word", title: "Go to heading…", keywords: [], group: "g", run: () => {} },
      { id: "prefix", title: "Heading 1", keywords: [], group: "g", run: () => {} },
      { id: "exact", title: "Head", keywords: [], group: "g", run: () => {} },
      { id: "none", title: "Share", keywords: ["link"], group: "g", run: () => {} },
    ];
    expect(ids(filterCommands("head", sample))).toEqual(["exact", "prefix", "word", "kw"]);
    expect(matchRank(sample[4], "head")).toBeNull();
  });

  it("puts Heading 1 first for 'head' and is case-insensitive", () => {
    expect(ids(filterCommands("head", cmds))[0]).toBe("block:heading1");
    expect(ids(filterCommands("HEAD", cmds))[0]).toBe("block:heading1");
  });

  it("matches keywords and multi-word queries", () => {
    expect(ids(filterCommands("h1", cmds))).toContain("block:heading1");
    expect(ids(filterCommands("reader", cmds))[0]).toBe("doc:reader");
    expect(ids(filterCommands("download pdf", cmds))).toEqual(["doc:download-pdf"]);
    expect(ids(filterCommands("zzzz", cmds))).toEqual([]);
  });

  it("honours `when`", () => {
    const readOnly = buildCommands(stubCtx({}, { canEdit: false, canComment: false, canChangeMode: false }));
    expect(ids(filterCommands("bold", readOnly))).toEqual([]);
  });
});

describe("recent commands", () => {
  it("pushRecent keeps the newest first, de-duplicates and caps at five", () => {
    let r: string[] = [];
    for (const id of ["a", "b", "c", "a", "d", "e", "f"]) r = pushRecent(r, id);
    expect(r).toEqual(["f", "e", "d", "a", "c"]);
  });

  it("withRecentFirst floats recent commands to a Recent group and drops unknown ids", () => {
    const cmds: Command[] = ["x", "y", "z"].map((id) => ({ id, title: id, keywords: [], group: "G", run: () => {} }));
    const out = withRecentFirst(cmds, ["z", "missing", "x"]);
    expect(ids(out)).toEqual(["z", "x", "y"]);
    expect(out[0].group).toBe("Recent");
    expect(out[2].group).toBe("G");
    expect(groupCommands(out, ["Recent", "G"]).map((g) => g.group)).toEqual(["Recent", "G"]);
  });

  it("round-trips through storage and tolerates garbage", () => {
    const store = new Map<string, string>();
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
    saveRecent(["a", "b"], storage);
    expect(loadRecent(storage)).toEqual(["a", "b"]);
    store.set("markdoc:paletteRecent", "{not json");
    expect(loadRecent(storage)).toEqual([]);
    store.set("markdoc:paletteRecent", JSON.stringify([1, "ok", null]));
    expect(loadRecent(storage)).toEqual(["ok"]);
    expect(loadRecent(null)).toEqual([]);
  });
});

describe("buildDashboardCommands", () => {
  it("has unique ids, loads templates as children and creates from one", async () => {
    const calls: string[] = [];
    const ctx: DashboardCommandContext = {
      createDocument: (t) => calls.push(`create:${t ?? "blank"}`),
      templates: async () => [{ id: "meeting-notes", name: "Meeting notes", description: "Agenda and action items" }],
      recentDocuments: async () => [{ id: "r1", title: "Recent one" }],
      starredDocuments: async () => [],
      showTrash: () => calls.push("trash"),
      openFile: () => calls.push("open-file"),
      navigate: (href) => calls.push(`nav:${href}`),
      signOut: () => calls.push("signout"),
    };
    const cmds = buildDashboardCommands(ctx);
    expect(new Set(ids(cmds)).size).toBe(cmds.length);
    expect(ids(cmds)).toEqual(["dash:new", "dash:open-file", "dash:template", "dash:recent", "dash:starred", "dash:trash", "dash:settings", "dash:signout"]);
    const templates = await cmds[2].children!();
    expect(templates[0].title).toBe("Meeting notes");
    expect(ids(filterCommands("agenda", templates))).toEqual(["template:meeting-notes"]);
    templates[0].run();
    cmds[0].run();
    cmds[1].run();
    cmds[5].run();
    cmds[6].run();
    expect(calls).toEqual(["create:meeting-notes", "create:blank", "open-file", "trash", "nav:/settings"]);
    const recent = await cmds[3].children!();
    expect(recent[0].title).toBe("Recent one");
  });
});
