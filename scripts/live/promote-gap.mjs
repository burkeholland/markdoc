#!/usr/bin/env node
// Measures the downtime a promote causes: polls GET /api/health on a port every 250 ms and, at the end,
// prints the longest run of non-200 answers (the "gap") plus every gap over 1 s with its start time.
// Runs until a SIGINT/SIGTERM arrives or --seconds elapse.
//   node scripts/live/promote-gap.mjs --port 3991 [--interval 250] [--seconds 600] [--json <file>]
// Exit 0 always (it is a meter, not a gate); promote.test reads --json.
import { writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : dflt;
};
const port = Number(opt("port", 3000));
const interval = Number(opt("interval", 250));
const seconds = Number(opt("seconds", 0));
const jsonPath = opt("json", "");
const url = `http://localhost:${port}/api/health`;

const gaps = []; // { startedAt, ms, statuses: {code: count} }
let current = null;
let total = 0;
let ok = 0;
let stopping = false;
const startedAt = Date.now();

function endGap(now) {
  if (!current) return;
  current.ms = now - current.startedAt;
  gaps.push(current);
  current = null;
  // Written after every gap as well as at the end, so a killed poller still leaves its numbers.
  if (jsonPath) writeJson();
}

function writeJson() {
  const max = gaps.reduce((m, g) => Math.max(m, g.ms), 0);
  writeFileSync(jsonPath, JSON.stringify({ port, total, ok, maxGapMs: max, gaps }, null, 2));
}

async function probe() {
  const t0 = Date.now();
  let status = 0;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
    status = res.status;
    if (status === 200) {
      const body = await res.json().catch(() => null);
      if (!body || body.ok !== true || body.db !== true) status = 299; // 200 but not ready
    }
  } catch {
    status = 0;
  }
  const now = Date.now();
  total++;
  if (status === 200) {
    ok++;
    endGap(t0);
  } else if (!current) {
    current = { startedAt: t0, ms: 0, statuses: { [status]: 1 } };
  } else {
    current.statuses[status] = (current.statuses[status] ?? 0) + 1;
  }
  return now;
}

function report() {
  endGap(Date.now());
  const max = gaps.reduce((m, g) => Math.max(m, g.ms), 0);
  const fmt = (g) => `${new Date(g.startedAt).toISOString().slice(11, 23)} ${(g.ms / 1000).toFixed(2)} s ${JSON.stringify(g.statuses)}`;
  const lines = [
    `promote-gap :${port} · ${total} probes over ${((Date.now() - startedAt) / 1000).toFixed(0)} s · ${ok} ok · ${gaps.length} gap(s) · max gap ${(max / 1000).toFixed(2)} s`,
    ...gaps.filter((g) => g.ms >= 1000).map((g) => `  gap ${fmt(g)}`),
  ];
  console.log(lines.join("\n"));
  if (jsonPath) writeJson();
}

process.on("SIGINT", () => { stopping = true; });
process.on("SIGTERM", () => { stopping = true; });

(async () => {
  const deadline = seconds > 0 ? startedAt + seconds * 1000 : Infinity;
  while (!stopping && Date.now() < deadline) {
    const t0 = Date.now();
    await probe();
    const wait = interval - (Date.now() - t0);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }
  report();
  process.exit(0);
})();
