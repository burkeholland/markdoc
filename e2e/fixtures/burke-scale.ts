/**
 * Burke-scale fixture (task #321, quality gate #920 item 4).
 *
 * Everything here is deterministic: the generator is seeded, so `LONG_DOC`, `MANY_DOCS` and
 * `COMMENT_LOAD` are byte-identical on every run and every machine. Nothing is read from disk.
 *
 *   LONG_DOC      ~12,000 words of realistic Markdown: 40 numbered H2 sections with numbered H3s,
 *                 code blocks (ts / json / bash), 6 tables (one with 30 rows), nested lists, 8 images,
 *                 blockquotes, task lists, 20 links, inline HTML and footnotes.
 *   MANY_DOCS     60 documents (40 short, 15 medium, 5 long — LONG_DOC is the first long one),
 *                 10 starred, 8 in the trash, 12 shared with a second user with mixed roles.
 *   COMMENT_LOAD  25 threads on the long doc, 60 replies, 10 resolved, 15 reactions, 6 @mentions.
 *
 * `seedBurkeScale(request, users)` pushes all of it through the public API (POST /api/documents,
 * PUT content, assets, star, trash, collaborators, comments, tokens) so the data is exactly what a
 * user could have produced. Playwright's `page.request` and the fetch client in
 * scripts/seed-burke-scale.mts both satisfy `SeedRequest`.
 */

// ---------------------------------------------------------------------------------------------
// Seeded randomness (mulberry32): the same seed always yields the same sequence.
// ---------------------------------------------------------------------------------------------

export type Rng = () => number;

export function rng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const int = (r: Rng, min: number, max: number) => min + Math.floor(r() * (max - min + 1));
const pick = <T,>(r: Rng, list: readonly T[]): T => list[Math.floor(r() * list.length)];

// ---------------------------------------------------------------------------------------------
// Vocabulary. Ordinary words plus the nouns of a product/engineering document so the prose reads
// like notes rather than lorem ipsum. Sentence length varies from 4 to 24 words.
// ---------------------------------------------------------------------------------------------

const WORDS = [
  "the", "a", "an", "and", "but", "so", "because", "while", "after", "before", "when", "where", "which", "that", "this", "those", "these",
  "we", "they", "it", "our", "their", "its", "each", "every", "some", "most", "few", "several", "another", "only", "still", "already", "again",
  "team", "release", "editor", "document", "preview", "outline", "comment", "thread", "suggestion", "version", "history", "draft", "review",
  "reader", "export", "import", "template", "dashboard", "search", "star", "trash", "share", "link", "token", "agent", "request", "notification",
  "server", "client", "browser", "tab", "socket", "cursor", "caret", "selection", "paragraph", "heading", "table", "row", "column", "cell",
  "image", "asset", "upload", "download", "file", "folder", "repository", "branch", "commit", "pull", "merge", "conflict", "diff", "patch",
  "latency", "budget", "timeout", "retry", "cache", "index", "query", "filter", "sort", "page", "scroll", "viewport", "layout", "theme",
  "keyboard", "shortcut", "palette", "menu", "dialog", "drawer", "sheet", "toast", "badge", "avatar", "presence", "session", "login", "account",
  "plan", "goal", "risk", "scope", "owner", "deadline", "milestone", "metric", "baseline", "regression", "fix", "bug", "issue", "ticket",
  "slowly", "quickly", "carefully", "roughly", "exactly", "eventually", "rarely", "often", "usually", "sometimes", "never", "always", "mostly",
  "works", "fails", "loads", "renders", "saves", "syncs", "merges", "updates", "opens", "closes", "scrolls", "types", "pastes", "reloads",
  "measured", "expected", "observed", "reported", "confirmed", "reverted", "shipped", "blocked", "planned", "deferred", "dropped", "kept",
  "small", "large", "long", "short", "slow", "fast", "stale", "fresh", "empty", "full", "visible", "hidden", "shared", "private", "public",
  "on", "in", "at", "to", "from", "with", "without", "over", "under", "between", "across", "through", "into", "onto", "about", "against",
  "first", "second", "third", "last", "next", "previous", "same", "different", "new", "old", "current", "final", "initial", "partial",
];

const PHRASES = [
  "on the 2-vCPU runner", "in the dev server", "under load", "after a reload", "with two browsers open", "on a phone viewport",
  "through the public API", "in the comments panel", "behind the outline", "before the first paint", "at the end of the document",
  "in the starred strip", "from the trash view", "with the token minted in settings", "over the WebSocket", "in IndexedDB",
  "on the production build", "in the HTML export", "inside a code block", "across 40 sections", "for every collaborator",
];

const TOPICS = [
  "Collaboration model", "Reload after create", "Outline and navigation", "Comment threads at volume", "Suggestions from agents",
  "Dashboard with real volume", "Search across bodies", "Stars and the strip", "Trash and restore", "Sharing roles",
  "Phone viewport", "Tablet layout", "Export to HTML", "Export to PDF", "Import from GitHub", "Templates", "Version history",
  "Presence and carets", "Paste handling", "Image uploads", "Tables at size", "Nested lists", "Task lists", "Inline HTML",
  "Footnotes", "Keyboard shortcuts", "Command palette", "Find and replace", "Theme and contrast", "Notifications",
  "Mentions", "Activity log", "Tokens and agents", "MCP endpoint", "Health checks", "Deployment", "Backups", "Rate limits",
  "Performance budgets", "Accessibility sweep", "Rollout plan", "Open questions", "Decisions", "Risks", "Follow-ups",
];

const SUBTOPICS = [
  "What we measured", "Where it broke", "What changed", "Budget", "Open items", "Decision", "Rollout", "Fallback",
  "Test coverage", "Edge cases", "Notes from review", "Owner and deadline", "Before and after", "Why it matters",
];

const PEOPLE = ["alice", "bob", "carol", "dave", "erin", "frank", "grace", "heidi"];

function sentence(r: Rng, minWords = 4, maxWords = 24): string {
  const n = int(r, minWords, maxWords);
  const words: string[] = [];
  for (let i = 0; i < n; i++) {
    if (i > 3 && i < n - 2 && r() < 0.08) words.push(pick(r, PHRASES));
    else words.push(pick(r, WORDS));
    if (i > 2 && i < n - 2 && r() < 0.12) words[words.length - 1] += ",";
  }
  let text = words.join(" ");
  text = text[0].toUpperCase() + text.slice(1);
  const end = r();
  return text + (end < 0.04 ? "?" : end < 0.06 ? "!" : ".");
}

function paragraph(r: Rng, minSentences = 3, maxSentences = 6): string {
  const n = int(r, minSentences, maxSentences);
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(sentence(r));
  return out.join(" ");
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

// ---------------------------------------------------------------------------------------------
// Block builders.
// ---------------------------------------------------------------------------------------------

function codeBlock(r: Rng, lang: "ts" | "json" | "bash", n: number): string {
  // No line may start with `#`: the hydrate spec counts headings with a line regex.
  if (lang === "ts") {
    return [
      "```ts",
      `export interface Section${n} {`,
      `  id: string;`,
      `  words: number;`,
      `  budgetMs: number;`,
      `}`,
      ``,
      `export function measure${n}(input: Section${n}[]): number {`,
      `  const total = input.reduce((sum, s) => sum + s.words, 0);`,
      `  return Math.round(total / Math.max(1, input.length));`,
      `}`,
      "```",
    ].join("\n");
  }
  if (lang === "json") {
    return [
      "```json",
      `{`,
      `  "section": ${n},`,
      `  "budgetMs": ${int(r, 200, 6000)},`,
      `  "workers": ${int(r, 1, 4)},`,
      `  "tags": ["${pick(r, WORDS)}", "${pick(r, WORDS)}", "${pick(r, WORDS)}"],`,
      `  "enabled": ${r() < 0.5}`,
      `}`,
      "```",
    ].join("\n");
  }
  return [
    "```bash",
    `E2E_PORT=${3200 + n} npx playwright test e2e/scale.spec.ts --reporter=list`,
    `npm run typecheck && npm run lint`,
    `git grep -il mooncake | wc -l`,
    "```",
  ].join("\n");
}

function table(r: Rng, rows: number, n: number): string {
  const lines = [`| Check | Section | Budget (ms) | Measured (ms) | Status |`, `| --- | --- | ---: | ---: | --- |`];
  for (let i = 1; i <= rows; i++) {
    const budget = int(r, 300, 6000);
    const measured = int(r, 100, budget + 800);
    lines.push(`| ${pick(r, TOPICS)} ${i} | ${n}.${i} | ${budget} | ${measured} | ${measured <= budget ? "ok" : "over"} |`);
  }
  return lines.join("\n");
}

function nestedList(r: Rng): string {
  const lines: string[] = [];
  const items = int(r, 3, 5);
  for (let i = 0; i < items; i++) {
    lines.push(`- ${sentence(r, 3, 10)}`);
    const sub = int(r, 1, 3);
    for (let j = 0; j < sub; j++) {
      lines.push(`  - ${sentence(r, 3, 9)}`);
      if (r() < 0.3) lines.push(`    - ${sentence(r, 2, 7)}`);
    }
  }
  return lines.join("\n");
}

function taskList(r: Rng): string {
  const lines: string[] = [];
  const items = int(r, 4, 7);
  for (let i = 0; i < items; i++) lines.push(`- [${r() < 0.5 ? "x" : " "}] ${sentence(r, 3, 10)}`);
  return lines.join("\n");
}

function blockquote(r: Rng): string {
  return `> ${sentence(r, 6, 18)}\n>\n> — ${pick(r, PEOPLE)}, in review`;
}

const link = (n: number, topic: string) => `[${topic.toLowerCase()} notes](https://example.org/markdoc/notes/${n}-${slug(topic)})`;

/** Placeholder image URL; `seedBurkeScale` uploads a real PNG per image and rewrites it. */
export const imagePlaceholder = (k: number) => `/api/assets/__burke_img_${k}__`;
export const IMAGE_PLACEHOLDER_RE = /\/api\/assets\/__burke_img_(\d+)__/g;
export const IMAGE_COUNT = 8;

// ---------------------------------------------------------------------------------------------
// The long document.
// ---------------------------------------------------------------------------------------------

export interface LongDocOptions {
  /** Number of H2 sections (default 40). */
  sections?: number;
  /** H1 title (default derived from the seed). */
  title?: string;
}

/** Section numbers (1-based) that carry each feature; kept explicit so the counts are checkable. */
export const LONG_DOC_SCHEDULE = {
  ts: [1, 5, 9, 13, 17, 21, 25, 29, 33, 37],
  json: [3, 11, 19, 27, 35],
  bash: [7, 15, 23, 31, 39],
  tables: [4, 10, 16, 22, 28, 34],
  bigTable: 22,
  bigTableRows: 30,
  images: [2, 6, 12, 18, 24, 30, 36, 40],
  lists: [5, 10, 15, 20, 25, 30, 35, 40],
  tasks: [8, 20, 32],
  quotes: [3, 9, 15, 21, 27, 33, 39],
  inlineHtml: [9, 27],
  footnotes: [14, 38],
} as const;

const LONG_TITLES = [
  "Markdoc at Burke's scale: the September review",
  "Platform notes, volume two",
  "Quality gate #920: what we measured",
  "Editor performance journal",
  "Release 0.1 retrospective",
  "Collaboration design document",
];

export function generateLongDoc(seed: number, options: LongDocOptions = {}): string {
  const r = rng(seed * 7919 + 17);
  const sections = options.sections ?? 40;
  const title = options.title ?? LONG_TITLES[(seed - 1) % LONG_TITLES.length];
  const S = LONG_DOC_SCHEDULE;
  const has = (list: readonly number[], n: number) => list.includes(n);
  const out: string[] = [`# ${title}`, "", paragraph(r, 3, 5), "", paragraph(r, 2, 4), ""];
  let imageIndex = 0;
  let linkIndex = 0;

  for (let n = 1; n <= sections; n++) {
    const topic = TOPICS[(n - 1) % TOPICS.length];
    out.push(`## ${n}. ${topic}`, "");
    out.push(paragraph(r, 3, 5), "");
    if (n % 2 === 0 && linkIndex < 20) {
      linkIndex++;
      out.push(`${sentence(r, 5, 12)} See the ${link(n, topic)} for the raw numbers.`, "");
    }
    if (r() < 0.5) out.push(paragraph(r, 2, 4), "");

    if (has(S.images, n)) {
      imageIndex++;
      out.push(`![Figure ${imageIndex}: ${topic.toLowerCase()} before and after](${imagePlaceholder(imageIndex)})`, "");
    }
    if (has(S.quotes, n)) out.push(blockquote(r), "");

    const subs = int(r, 2, 3);
    for (let s = 1; s <= subs; s++) {
      const sub = SUBTOPICS[(n * 3 + s) % SUBTOPICS.length];
      out.push(`### ${n}.${s} ${sub}`, "");
      out.push(paragraph(r, 2, 4), "");
      if (s === 1) {
        if (has(S.ts, n)) out.push(codeBlock(r, "ts", n), "");
        else if (has(S.json, n)) out.push(codeBlock(r, "json", n), "");
        else if (has(S.bash, n)) out.push(codeBlock(r, "bash", n), "");
      }
      if (s === 2) {
        if (has(S.tables, n)) out.push(table(r, n === S.bigTable ? S.bigTableRows : int(r, 3, 6), n), "");
        if (has(S.lists, n)) out.push(nestedList(r), "");
        if (has(S.tasks, n)) out.push(taskList(r), "");
      }
      if (s === subs && has(S.inlineHtml, n)) {
        out.push(`Press <kbd>Ctrl</kbd>+<kbd>K</kbd> to open the palette; the <abbr title="application programming interface">API</abbr> path is n<sup>2</sup> in the worst case.<br>${sentence(r, 4, 9)}`, "");
      }
      if (s === subs && has(S.footnotes, n)) {
        out.push(`${sentence(r, 6, 14)}[^fn${n}]`, "", `[^fn${n}]: ${sentence(r, 6, 14)}`, "");
      }
      if (r() < 0.35) out.push(paragraph(r, 2, 3), "");
    }
  }
  return out.join("\n");
}

/** The hero document: ~12k words, 40 H2 sections. Seed 1. */
export const LONG_DOC = generateLongDoc(1);

/** Text of the H2 headings of `md` (without `## `), in order. */
export const h2Texts = (md: string): string[] =>
  md
    .split("\n")
    .filter((l) => l.startsWith("## "))
    .map((l) => l.slice(3));

/** The first H3 heading line of section `n` (e.g. `### 37.1 Budget`); the agent-suggest target in scale.spec. */
export function firstH3Of(md: string, n: number): string {
  const line = md.split("\n").find((l) => l.startsWith(`### ${n}.1 `));
  if (!line) throw new Error(`section ${n} has no first H3`);
  return line;
}

export const wordCount = (md: string) => (md.match(/\S+/g) ?? []).length;

// ---------------------------------------------------------------------------------------------
// Sixty documents.
// ---------------------------------------------------------------------------------------------

export type DocSize = "short" | "medium" | "long";
export type ShareRole = "editor" | "commenter" | "viewer";

export interface ManyDocSpec {
  /** 1-based position in the list (doc 47 carries `UNIQUE_WORD`). */
  index: number;
  title: string;
  content: string;
  size: DocSize;
  starred: boolean;
  trashed: boolean;
  /** Role the second user gets when the doc is shared; `null` when it is not. */
  sharedAs: ShareRole | null;
}

const SHORT_TITLES = [
  "Standup notes", "Weekly sync", "1:1 with Burke", "Incident review: dashboard 500s", "Onboarding checklist",
  "Q3 planning", "Design review: comments panel", "Retro: release 0.1", "Launch checklist", "Customer call: Contoso",
  "Hiring loop feedback", "Reading list", "Ideas parking lot", "Travel plans", "Grocery list", "Meeting notes 2026-08-12",
  "Meeting notes 2026-08-19", "Meeting notes 2026-08-21", "Budget request", "Vendor comparison", "Interview questions",
  "Talk outline: collaborative Markdown", "Blog draft: why two panes", "Conference notes", "Support macros",
  "Security review notes", "Accessibility audit follow-ups", "Mobile layout notes", "Export formats", "Import edge cases",
  "Offline behaviour", "Search ranking", "Notification digest", "Agent token policy", "MCP client setup",
  "Backup and restore runbook", "On-call handbook", "Deploy checklist", "Postmortem template", "OKRs H2",
];

const MEDIUM_TITLES = [
  "Architecture overview", "Collaboration protocol", "Comments data model", "Suggestions: accept and reject semantics",
  "Version history design", "Dashboard information architecture", "Search and snippets", "Phone and tablet layouts",
  "PDF export pipeline", "GitHub sync design", "Notifications and mentions", "Agent requests workflow",
  "Performance budgets", "Test strategy", "Release process",
];

/** A word that occurs nowhere in the generated prose; placed only in doc 47's body. */
export const UNIQUE_WORD = "quillfeather";
export const UNIQUE_WORD_DOC_INDEX = 47;

function shortDoc(r: Rng, title: string): string {
  const paras = int(r, 1, 3);
  const out = [`# ${title}`, ""];
  for (let i = 0; i < paras; i++) out.push(paragraph(r, 2, 5), "");
  if (r() < 0.4) out.push(taskList(r), "");
  return out.join("\n");
}

function mediumDoc(r: Rng, title: string): string {
  const out = [`# ${title}`, "", paragraph(r, 3, 5), ""];
  const sections = int(r, 3, 5);
  for (let s = 1; s <= sections; s++) {
    out.push(`## ${SUBTOPICS[(s * 5) % SUBTOPICS.length]}`, "", paragraph(r, 3, 6), "");
    if (s === 2) out.push(nestedList(r), "");
    if (s === 3) out.push(table(r, int(r, 3, 5), s), "");
    if (r() < 0.5) out.push(paragraph(r, 2, 4), "");
  }
  return out.join("\n");
}

export function generateManyDocs(): ManyDocSpec[] {
  const r = rng(4242);
  const docs: ManyDocSpec[] = [];
  // Sizes by position: long docs at 1, 13, 25, 37, 49; medium at every 4th otherwise; the rest short.
  const longAt = new Set([1, 13, 25, 37, 49]);
  const mediumAt = new Set<number>();
  for (let i = 1; i <= 60 && mediumAt.size < 15; i++) if (!longAt.has(i) && i % 4 === 3) mediumAt.add(i);
  for (let i = 2; i <= 60 && mediumAt.size < 15; i++) if (!longAt.has(i) && !mediumAt.has(i) && i % 4 === 0) mediumAt.add(i);
  let shortIdx = 0;
  let mediumIdx = 0;
  let longSeed = 1;
  for (let index = 1; index <= 60; index++) {
    let size: DocSize;
    let title: string;
    let content: string;
    if (longAt.has(index)) {
      size = "long";
      content = longSeed === 1 ? LONG_DOC : generateLongDoc(longSeed);
      title = content.split("\n")[0].slice(2);
      longSeed++;
    } else if (mediumAt.has(index)) {
      size = "medium";
      title = MEDIUM_TITLES[mediumIdx++ % MEDIUM_TITLES.length];
      content = mediumDoc(r, title);
    } else {
      size = "short";
      title = SHORT_TITLES[shortIdx++ % SHORT_TITLES.length];
      content = shortDoc(r, title);
    }
    if (index === UNIQUE_WORD_DOC_INDEX) content += `\nThe ${UNIQUE_WORD} flag is only mentioned in this document.\n`;
    docs.push({ index, title, content, size, starred: false, trashed: false, sharedAs: null });
  }
  // 8 in the trash (never the hero doc, never starred or shared): positions 6, 14, 22, 30, 38, 46, 54, 60.
  for (const i of [6, 14, 22, 30, 38, 46, 54, 60]) docs[i - 1].trashed = true;
  // 10 starred: the hero doc plus nine spread over the list.
  for (const i of [1, 3, 8, 13, 19, 27, 33, 41, 47, 57]) docs[i - 1].starred = true;
  // 12 shared with the second user, roles cycling editor → commenter → viewer; the hero doc is shared as editor.
  const roles: ShareRole[] = ["editor", "commenter", "viewer"];
  [1, 4, 9, 13, 16, 21, 25, 28, 35, 43, 50, 58].forEach((i, k) => (docs[i - 1].sharedAs = roles[k % roles.length]));
  return docs;
}

export const MANY_DOCS: ManyDocSpec[] = generateManyDocs();

// ---------------------------------------------------------------------------------------------
// Comment load for the hero document.
// ---------------------------------------------------------------------------------------------

export interface CommentThreadSpec {
  /** Text in LONG_DOC the thread is anchored on (the numbered H2 of sections 1..25 — unique). */
  quote: string;
  body: string;
  replies: string[];
  resolved: boolean;
  /** Emojis reacted on the thread's root comment. */
  reactions: string[];
}

export interface CommentLoad {
  threads: CommentThreadSpec[];
  totals: { threads: number; replies: number; resolved: number; reactions: number; mentions: number };
}

const EMOJIS = ["👍", "❤️", "🎉", "👀", "🚀"];

/** `peer` is the login that gets @mentioned (the second user of `seedBurkeScale`). */
export function generateCommentLoad(peer = "burke-peer"): CommentLoad {
  const r = rng(9001);
  const headings = h2Texts(LONG_DOC);
  const threads: CommentThreadSpec[] = [];
  let replies = 0;
  let resolved = 0;
  let reactions = 0;
  let mentions = 0;
  for (let i = 0; i < 25; i++) {
    const replyCount = [1, 2, 3, 4, 2][i % 5];
    const isResolved = i % 5 === 2 || i % 5 === 4;
    const reacts = i % 5 === 2 || i % 5 === 4 ? [] : [EMOJIS[i % EMOJIS.length]];
    const mention = i % 4 === 0 && mentions < 6;
    const body = mention ? `@${peer} ${sentence(r, 5, 14)}` : sentence(r, 5, 16);
    if (mention) mentions++;
    const replyBodies: string[] = [];
    for (let k = 0; k < replyCount; k++) replyBodies.push(sentence(r, 3, 14));
    replies += replyCount;
    if (isResolved) resolved++;
    reactions += reacts.length;
    threads.push({ quote: headings[i], body, replies: replyBodies, resolved: isResolved, reactions: reacts });
  }
  return { threads, totals: { threads: threads.length, replies, resolved, reactions, mentions } };
}

export const COMMENT_LOAD: CommentLoad = generateCommentLoad();

// ---------------------------------------------------------------------------------------------
// Seeding through the public API.
// ---------------------------------------------------------------------------------------------

export interface SeedResponse {
  ok(): boolean;
  status(): number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}

export interface SeedRequestOptions {
  data?: unknown;
  headers?: Record<string, string>;
  timeout?: number;
}

/** The subset of Playwright's `APIRequestContext` the seeder needs (scripts/seed-burke-scale.mts implements it over fetch). */
export interface SeedRequest {
  get(url: string, options?: SeedRequestOptions): Promise<SeedResponse>;
  post(url: string, options?: SeedRequestOptions): Promise<SeedResponse>;
  put(url: string, options?: SeedRequestOptions): Promise<SeedResponse>;
  delete(url: string, options?: SeedRequestOptions): Promise<SeedResponse>;
}

export interface SeedUsers {
  /** Login of the signed-in owner `request` acts as. */
  owner: string;
  /** Login of the second user documents are shared with and who gets @mentioned. */
  peer: string;
}

export interface SeedOptions {
  /** Also mint an API token for the owner (used by the MCP checks). Default true. */
  token?: boolean;
  /** Parallel document creations (default 6). */
  concurrency?: number;
  log?: (line: string) => void;
}

export interface SeededDoc {
  id: string;
  spec: ManyDocSpec;
  /** Final Markdown after image placeholders were rewritten (long docs only differ from `spec.content`). */
  content: string;
}

export interface BurkeScaleSeed {
  longDoc: SeededDoc;
  docs: SeededDoc[];
  starredIds: string[];
  trashedIds: string[];
  sharedIds: string[];
  threadIds: string[];
  commentLoad: CommentLoad;
  /** Bearer token for the owner, or null when `token: false`. */
  token: string | null;
  /** Wall-clock milliseconds the whole seed took. */
  elapsedMs: number;
}

/** 1×1 transparent PNG. */
export const PNG_1X1 = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

async function expectOk(res: SeedResponse, what: string): Promise<unknown> {
  if (!res.ok()) throw new Error(`${what} -> ${res.status()} ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

/** Upload one PNG per image placeholder in `content` and return the Markdown with real asset URLs. */
async function rewriteImages(request: SeedRequest, docId: string, content: string): Promise<string> {
  const placeholders = [...new Set([...content.matchAll(IMAGE_PLACEHOLDER_RE)].map((m) => m[0]))];
  if (placeholders.length === 0) return content;
  const urls = await mapLimit(placeholders, 4, async (placeholder, k) => {
    const res = await request.post(`/api/documents/${docId}/assets?name=figure-${k + 1}.png`, { headers: { "content-type": "image/png" }, data: PNG_1X1 });
    const body = (await expectOk(res, `POST /api/documents/${docId}/assets`)) as { url: string };
    return body.url;
  });
  let out = content;
  placeholders.forEach((p, k) => (out = out.split(p).join(urls[k])));
  return out;
}

/**
 * Seed the whole fixture for `users.owner` (the signed-in user behind `request`). Idempotence is not
 * attempted: every call creates a fresh set of 60 documents, so use a dedicated login per run.
 */
export async function seedBurkeScale(request: SeedRequest, users: SeedUsers, options: SeedOptions = {}): Promise<BurkeScaleSeed> {
  const started = Date.now();
  const log = options.log ?? (() => undefined);
  const concurrency = options.concurrency ?? 6;
  const commentLoad = generateCommentLoad(users.peer);
  const t = () => `${String(Date.now() - started).padStart(6)} ms`;

  // 1. Sixty documents (POST), long ones get their images uploaded and the content rewritten (PUT).
  const docs = await mapLimit(MANY_DOCS, concurrency, async (spec): Promise<SeededDoc> => {
    const created = (await expectOk(await request.post("/api/documents", { data: { title: spec.title, content: spec.content } }), `POST /api/documents (${spec.title})`)) as {
      document: { id: string };
    };
    const id = created.document.id;
    let content = spec.content;
    if (spec.size === "long") {
      content = await rewriteImages(request, id, spec.content);
      if (content !== spec.content) await expectOk(await request.put(`/api/documents/${id}/content`, { data: { content } }), `PUT /api/documents/${id}/content`);
    }
    return { id, spec, content };
  });
  log(`[burke-scale] ${t()}  ${docs.length} documents created`);

  // 2. Stars, trash, shares.
  const starredIds: string[] = [];
  const trashedIds: string[] = [];
  const sharedIds: string[] = [];
  await mapLimit(docs, concurrency, async (d) => {
    if (d.spec.starred) {
      await expectOk(await request.put(`/api/documents/${d.id}/star`), `PUT /api/documents/${d.id}/star`);
      starredIds.push(d.id);
    }
    if (d.spec.sharedAs) {
      await expectOk(await request.post(`/api/documents/${d.id}/collaborators`, { data: { login: users.peer, role: d.spec.sharedAs } }), `POST /api/documents/${d.id}/collaborators`);
      sharedIds.push(d.id);
    }
    if (d.spec.trashed) {
      await expectOk(await request.delete(`/api/documents/${d.id}`), `DELETE /api/documents/${d.id}`);
      trashedIds.push(d.id);
    }
  });
  log(`[burke-scale] ${t()}  ${starredIds.length} starred, ${trashedIds.length} trashed, ${sharedIds.length} shared`);

  // 3. Comments on the hero doc — sequential: they all mutate the same live document.
  const longDoc = docs[0];
  if (longDoc.spec.content !== LONG_DOC) throw new Error("MANY_DOCS[0] must be LONG_DOC");
  const comments = `/api/documents/${longDoc.id}/comments`;
  const threadIds: string[] = [];
  for (const thread of commentLoad.threads) {
    const added = (await expectOk(await request.post(comments, { data: { action: "add", quote: thread.quote, body: thread.body } }), `POST ${comments} add`)) as { id: string };
    threadIds.push(added.id);
    for (const body of thread.replies) await expectOk(await request.post(comments, { data: { action: "reply", threadId: added.id, body } }), `POST ${comments} reply`);
    for (const emoji of thread.reactions) await expectOk(await request.post(comments, { data: { action: "react", threadId: added.id, emoji } }), `POST ${comments} react`);
    if (thread.resolved) await expectOk(await request.post(comments, { data: { action: "resolve", threadId: added.id, resolved: true } }), `POST ${comments} resolve`);
  }
  log(`[burke-scale] ${t()}  ${threadIds.length} threads, ${commentLoad.totals.replies} replies, ${commentLoad.totals.resolved} resolved, ${commentLoad.totals.reactions} reactions`);

  // 4. A token for the agent path.
  let token: string | null = null;
  if (options.token !== false) {
    const minted = (await expectOk(await request.post("/api/tokens", { data: { name: "Burke-scale seed", expiresInDays: 30 } }), "POST /api/tokens")) as { token: { token: string } };
    token = minted.token.token;
  }

  const elapsedMs = Date.now() - started;
  log(`[burke-scale] ${t()}  done (${elapsedMs} ms)`);
  return { longDoc, docs, starredIds, trashedIds, sharedIds, threadIds, commentLoad, token, elapsedMs };
}
