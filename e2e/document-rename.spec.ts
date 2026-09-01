import { test, expect } from "./fixtures";
import { signIn, createDocument, type User } from "./helpers";

/**
 * `PATCH /api/documents/:id { title }` must rename the *live* document (`meta.title`), not just the `title`
 * column: every store of the document (a keystroke, or any REST write such as `PATCH /content`) copies
 * `meta.title` back over the column, so a column-only rename answered 200 and silently reverted a few
 * seconds later (audit #1202, finding F4). API only: no editor page is opened beyond the login.
 */
test.describe("PATCH /api/documents/:id { title } renames the live document", () => {
  let user: User;

  test.beforeAll(async ({ browser }) => {
    user = await signIn(browser, `renamer-${Date.now().toString(36)}`);
  });

  test.afterAll(async () => {
    await user.context.close();
  });

  test("the rename survives the next store and is recorded once as title.change", async () => {
    const api = user.page.request;
    const docId = await createDocument(user.page, "# Rename me\n\nBody.\n", "Rename me");
    const columnTitle = async () => ((await (await api.get(`/api/documents/${docId}`)).json()) as { document: { title: string } }).document.title;
    const liveTitle = async () => ((await (await api.get(`/api/documents/${docId}/content`, { timeout: 60_000 })).json()) as { title: string }).title;
    const timeline: string[] = [];
    const t0 = Date.now();
    const note = async (what: string, extra = "") => {
      timeline.push(`t=${String(Date.now() - t0).padStart(5)} ms  ${what.padEnd(30)} GET /documents title=${JSON.stringify(await columnTitle())}${extra}`);
    };

    // First request to the route compiles it on demand in the dev server; keep that out of the timed part.
    const renamed = await api.patch(`/api/documents/${docId}`, { data: { title: "Renamed twice" }, timeout: 60_000 });
    expect(renamed.status()).toBe(200);
    expect(((await renamed.json()) as { document: { title: string } }).document.title).toBe("Renamed twice");
    const liveAfterRename = await liveTitle();
    await note("after PATCH { title }", `  GET /content title=${JSON.stringify(liveAfterRename)}`);

    // Any write stores the document: the store copies meta.title over the column (the revert, on the base).
    const appended = await api.patch(`/api/documents/${docId}/content`, { data: { append: "\n\nx" }, timeout: 60_000 });
    expect(appended.status()).toBe(200);
    const atFirstStore = await columnTitle();
    await note("after PATCH /content (a store)");

    // Poll for the full 10 s: the title must still be the new one at the end, whatever stores happened in between.
    const samples: { at: number; title: string }[] = [];
    const pollStart = Date.now();
    while (Date.now() - pollStart < 10_000) {
      samples.push({ at: Date.now() - t0, title: await columnTitle() });
      await new Promise((r) => setTimeout(r, 500));
    }
    const changes = samples.filter((s, i) => i === 0 || s.title !== samples[i - 1].title);
    timeline.push(`poll: ${samples.length} samples over ${Date.now() - pollStart} ms: ${changes.map((s) => `t=${s.at} ms → ${JSON.stringify(s.title)}`).join(", then ")}`);
    const finalTitle = await columnTitle();
    const finalLive = await liveTitle();
    await note("at the end of the poll", `  GET /content title=${JSON.stringify(finalLive)}`);
    console.log(`[document-rename ${docId}]\n  ${timeline.join("\n  ")}`);
    test.info().annotations.push({ type: "rename-timeline", description: timeline.join(" | ") });

    expect(finalTitle, `GET /api/documents/:id title after the store and a 10 s poll\n${timeline.join("\n")}`).toBe("Renamed twice");
    expect(samples.map((s) => s.title)).toEqual(samples.map(() => "Renamed twice"));
    expect(atFirstStore).toBe("Renamed twice");
    expect(liveAfterRename).toBe("Renamed twice");
    expect(finalLive).toBe("Renamed twice");

    // Exactly one title.change, attributed to the caller (the append is a separate `edit` row).
    const activity = (await (await api.get(`/api/documents/${docId}/activity`, { timeout: 60_000 })).json()) as {
      items: { action: string; actorName: string; actorKind: string; detail: { title?: string } }[];
    };
    const titleChanges = activity.items.filter((item) => item.action === "title.change");
    console.log(`[document-rename ${docId}] activity: ${activity.items.map((i) => i.action).join(", ")} — title.change ×${titleChanges.length}`);
    expect(titleChanges).toHaveLength(1);
    expect(titleChanges[0].detail.title).toBe("Renamed twice");
    expect(titleChanges[0].actorKind).toBe("user");
    expect(titleChanges[0].actorName).toBe(user.login);
  });
});
