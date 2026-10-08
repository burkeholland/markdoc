import { appendFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { CommentsModel } from "./comments";
import { SuggestionsModel } from "./suggestions";
import { makeCollabUser } from "./shared";
import { replaceText } from "../sync/replace-plan";
import { applyOps, diffOps } from "../sync/text-diff";

/**
 * What a whole-document replace does to the comments, pending suggestions and carets of the people in the
 * document (#2341). The case: a document of 8 paragraphs with 6 comments, 2 pending suggestions and a caret
 * in every paragraph; an agent reads it and sends it back with paragraphs 3 and 6 rewritten.
 *
 * "before" is the edit the server made until now (the smallest character edit of the two whole texts);
 * "now" is `replaceText`. Everything in a paragraph the agent did not touch must be exactly where it was.
 * `ANCHOR_TABLE_FILE=<path>` writes the table the pull request shows to that file.
 */
const ASCII = "abcdefghijklmnopqrstuvwxyz";
function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}
/** One paragraph on one line: sentences of random words, about `chars` long. */
function paragraph(chars: number, seed: number): string {
  const r = rng(seed);
  const words: string[] = [];
  let n = 0;
  while (n < chars) {
    let w = "";
    for (let i = 2 + Math.floor(r() * 8); i > 0; i--) w += ASCII[Math.floor(r() * 26)];
    if (words.length % 12 === 0) w = w[0].toUpperCase() + w.slice(1);
    if (words.length % 12 === 11) w += ".";
    words.push(w);
    n += w.length + 1;
  }
  return words.join(" ");
}

interface Mark {
  kind: "comment" | "suggestion" | "caret";
  name: string;
  /** Paragraph it sits in, from 1. */
  paragraph: number;
  rewritten: boolean;
}
interface Outcome extends Mark {
  kept: boolean;
  detail: string;
}

const REWRITTEN = [3, 6];

/** Build the case, apply the agent's text one way, and say what became of every mark. */
function run(paragraphChars: number, how: "before" | "now"): { outcomes: Outcome[]; chars: number; ms: number; edits: number; touched: number; text: string; sent: string } {
  const paragraphs = Array.from({ length: 8 }, (_, i) => paragraph(paragraphChars, 100 + i));
  const start = `# Report\n\n${paragraphs.join("\n\n")}\n`;
  const doc = new Y.Doc();
  const ytext = doc.getText("content");
  ytext.insert(0, start);
  const comments = new CommentsModel(doc, ytext);
  const suggestions = new SuggestionsModel(doc, ytext);
  const person = makeCollabUser("u-person", "Person");
  const reviewer = makeCollabUser("u-reviewer", "Reviewer");
  const marks: (Mark & { id?: string; quote?: string; caret?: Y.RelativePosition; around?: string })[] = [];
  /** A phrase of 3 words that starts about `share` of the way into paragraph `p`. */
  const phrase = (p: number, share: number) => {
    const text = ytext.toString();
    // By its first words: a pending suggestion may already have put words into the paragraph.
    const from = text.indexOf(paragraphs[p - 1].slice(0, 40));
    const at = text.indexOf(" ", from + Math.floor(paragraphs[p - 1].length * share)) + 1;
    let to = at;
    for (let i = 0; i < 3; i++) to = text.indexOf(" ", to + 1);
    return { from: at, to };
  };

  // 2 pending suggestions first (they put their proposed text into the shared text): one in a paragraph the
  // agent leaves alone, one in a paragraph it rewrites.
  for (const [name, p] of [["suggestion in paragraph 2", 2], ["suggestion in paragraph 6", 6]] as const) {
    const range = phrase(p, 0.6);
    const [id] = suggestions.proposeEdits([{ ...range, insert: `proposed words for ${p}` }], reviewer);
    marks.push({ kind: "suggestion", name, paragraph: p, rewritten: REWRITTEN.includes(p), id });
  }
  // 6 comments: 4 in paragraphs the agent leaves alone, 2 in the ones it rewrites.
  for (const p of [1, 2, 3, 5, 6, 8]) {
    const range = phrase(p, 0.25);
    const id = comments.add({ ...range, body: `About paragraph ${p}`, author: person });
    marks.push({ kind: "comment", name: `comment in paragraph ${p}`, paragraph: p, rewritten: REWRITTEN.includes(p), id, quote: ytext.toString().slice(range.from, range.to) });
  }
  // A caret in the middle of every paragraph (a person's cursor is a Yjs relative position).
  for (let p = 1; p <= 8; p++) {
    const text = ytext.toString();
    const at = text.indexOf(paragraphs[p - 1].slice(0, 40)) + Math.floor(paragraphs[p - 1].length * 0.45);
    marks.push({ kind: "caret", name: `caret in paragraph ${p}`, paragraph: p, rewritten: REWRITTEN.includes(p), caret: Y.createRelativePositionFromTypeIndex(ytext, at), around: text.slice(at - 12, at + 12) });
  }

  // The agent read the text (with the proposed words in it) and sends it back with two paragraphs rewritten.
  const read = ytext.toString();
  let sent = read;
  for (const p of REWRITTEN) {
    const from = sent.indexOf(paragraphs[p - 1].slice(0, 40));
    const to = sent.indexOf("\n", from);
    sent = sent.slice(0, from) + paragraph(paragraphChars, 900 + p) + sent.slice(to);
  }
  const started = performance.now();
  let edits = 0;
  let touched = 0;
  doc.transact(() => {
    if (how === "before") {
      const ops = diffOps(ytext.toString(), sent, 0);
      applyOps(ytext, ops);
      edits = ops.length;
      touched = ops.reduce((n, op) => n + op.deleteCount + op.insert.length, 0);
    } else {
      const ops = replaceText(ytext, sent);
      edits = ops.length;
      touched = ops.reduce((n, op) => n + op.deleteCount + op.insert.length, 0);
    }
  });
  const ms = performance.now() - started;

  const text = ytext.toString();
  const threads = comments.list();
  const pending = suggestions.list();
  const outcomes: Outcome[] = marks.map((mark) => {
    if (mark.kind === "comment") {
      const thread = threads.find((t) => t.id === mark.id);
      const now = thread?.range ? text.slice(thread.range.from, thread.range.to) : null;
      const kept = now === mark.quote;
      return { ...mark, kept, detail: kept ? "on the same words" : now === null || now === "" ? "its words are gone (shown as a comment on deleted text)" : `on ${now.length} of its ${mark.quote!.length} characters` };
    }
    if (mark.kind === "suggestion") {
      const members = pending.filter((s) => s.id === mark.id || s.groupId === mark.id);
      const insert = members.find((s) => s.type === "insert");
      const whole = !!insert && text.slice(insert.from, insert.to) === `proposed words for ${mark.paragraph}` && members.length === 2;
      return { ...mark, kept: whole, detail: whole ? "still pending, both halves" : members.length ? `${members.length} of 2 halves left` : "gone" };
    }
    const at = Y.createAbsolutePositionFromRelativePosition(mark.caret!, doc)?.index ?? -1;
    const kept = text.slice(at - 12, at + 12) === mark.around;
    return { ...mark, kept, detail: kept ? "between the same letters" : "moved" };
  });
  comments.destroy();
  suggestions.destroy();
  doc.destroy();
  return { outcomes, chars: start.length, ms, edits, touched, text, sent };
}

function table(title: string, columns: [string, ReturnType<typeof run>][]) {
  const names = columns[0][1].outcomes.map((o) => o.name);
  const lines = [`${title}`, `| | ${columns.map(([label]) => label).join(" | ")} |`, `| --- | ${columns.map(() => "---").join(" | ")} |`];
  for (const name of names) {
    const first = columns[0][1].outcomes.find((o) => o.name === name)!;
    lines.push(`| ${name}${first.rewritten ? " (rewritten)" : ""} | ${columns.map(([, r]) => { const o = r.outcomes.find((x) => x.name === name)!; return `${o.kept ? "kept" : "LOST"}: ${o.detail}`; }).join(" | ")} |`);
  }
  lines.push(`| edits, characters removed and added, time | ${columns.map(([, r]) => `${r.edits} edits, ${r.touched} characters, ${r.ms.toFixed(0)} ms`).join(" | ")} |`);
  return lines.join("\n");
}

describe("a whole-document replace and the marks of the people in the document (#2341)", () => {
  it("6,000 characters, an agent rewrites 2 of 8 paragraphs: everything in the other 6 paragraphs stays where it was, before and now", () => {
    const before = run(740, "before");
    const now = run(740, "now");
    if (process.env.ANCHOR_TABLE_FILE) appendFileSync(process.env.ANCHOR_TABLE_FILE, "\n" + table(`${before.chars} characters`, [["main (smallest character edit)", before], ["this branch (anchors)", now]]) + "\n");
    expect(before.chars).toBeGreaterThan(5_900);
    expect(before.chars).toBeLessThan(6_300);
    // Both end with exactly the text the agent sent.
    expect(before.text).toBe(before.sent);
    expect(now.text).toBe(now.sent);
    for (const outcome of now.outcomes.filter((o) => !o.rewritten)) expect(outcome.kept, `now: ${outcome.name}: ${outcome.detail}`).toBe(true);
    for (const outcome of before.outcomes.filter((o) => !o.rewritten)) expect(outcome.kept, `before: ${outcome.name}: ${outcome.detail}`).toBe(true);
    // 4 comments, 1 suggestion and 6 carets lie in paragraphs the agent did not touch.
    expect(now.outcomes.filter((o) => !o.rewritten).map((o) => o.kind).sort().join(",")).toBe("caret,caret,caret,caret,caret,caret,comment,comment,comment,comment,suggestion");
    // Nothing that the edit before kept in an untouched paragraph is lost now (the condition this change was accepted under).
    for (const outcome of now.outcomes) {
      const was = before.outcomes.find((o) => o.name === outcome.name)!;
      if (!outcome.rewritten && was.kept) expect(outcome.kept, outcome.name).toBe(true);
    }
    // Inside a rewritten paragraph a comment no longer has its words, in neither: the agent replaced them.
    expect(now.outcomes.filter((o) => o.rewritten && o.kind === "comment").every((o) => !o.kept)).toBe(true);
    expect(before.outcomes.filter((o) => o.rewritten && o.kind === "comment").every((o) => !o.kept)).toBe(true);
    // Only the two rewritten paragraphs are touched: at most what they held before plus what they hold now.
    expect(now.touched).toBeLessThanOrEqual(4 * 800);
  });

  it("60,000 characters, the same rewrite: everything in the other 6 paragraphs stays where it was", () => {
    const now = run(7_490, "now");
    if (process.env.ANCHOR_TABLE_FILE) appendFileSync(process.env.ANCHOR_TABLE_FILE, "\n" + table(`${now.chars} characters`, [["this branch (anchors)", now]]) + "\n");
    expect(now.chars).toBeGreaterThan(59_000);
    expect(now.chars).toBeLessThan(61_500);
    expect(now.text).toBe(now.sent);
    const untouched = now.outcomes.filter((o) => !o.rewritten);
    expect(untouched).toHaveLength(11);
    for (const outcome of untouched) expect(outcome.kept, `${outcome.name}: ${outcome.detail}`).toBe(true);
    expect(now.touched).toBeLessThanOrEqual(4 * 7_600);
  });
});
