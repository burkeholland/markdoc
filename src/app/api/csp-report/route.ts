import { handler, HttpError, json, requireUser } from "@/server/http";
import { routeShape } from "../../../../server/route-shape";

export const dynamic = "force-dynamic";

export const CSP_REPORT_BODY_LIMIT = 8 * 1024;
export const CSP_LOG_INTERVAL_MS = 10 * 60 * 1000;

const reportCounts = new Map<string, number>();
const lastLoggedAt = new Map<string, number>();
const ACCEPTED_CONTENT_TYPES = new Set(["application/csp-report", "application/reports+json"]);
const DIRECTIVE = /^[a-z][a-z0-9-]{0,63}$/;

interface NormalizedReport {
  directive: string;
  blocked: string;
  route: string;
}

function mediaType(request: Request): string {
  return request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

async function readBoundedBody(request: Request): Promise<string> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > CSP_REPORT_BODY_LIMIT) {
    throw new HttpError(413, "CSP report body exceeds 8 KiB");
  }
  if (!request.body) return "";

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > CSP_REPORT_BODY_LIMIT) {
        await reader.cancel();
        throw new HttpError(413, "CSP report body exceeds 8 KiB");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function field(record: Record<string, unknown>, kebab: string, camel: string): string | null {
  const value = record[kebab] ?? record[camel];
  return typeof value === "string" ? value : null;
}

function blockedOrigin(value: string, documentUri: string): string | null {
  if (value === "inline") return "inline";
  try {
    const url = new URL(value, documentUri);
    const normalized = url.origin === "null" ? url.protocol : url.origin;
    return normalized.length <= 300 ? normalized : null;
  } catch {
    return null;
  }
}

function normalizeReport(value: unknown): NormalizedReport | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const body = record.body && typeof record.body === "object" && !Array.isArray(record.body)
    ? record.body as Record<string, unknown>
    : record;
  const directive = field(body, "effective-directive", "effectiveDirective");
  const blockedUri = field(body, "blocked-uri", "blockedURL");
  const documentUri = field(body, "document-uri", "documentURL");
  if (!directive || !DIRECTIVE.test(directive) || !blockedUri || !documentUri) return null;
  try {
    const documentUrl = new URL(documentUri);
    const blocked = blockedOrigin(blockedUri, documentUri);
    if (!blocked || !["http:", "https:"].includes(documentUrl.protocol)) return null;
    return { directive, blocked, route: routeShape(documentUrl.pathname) };
  } catch {
    return null;
  }
}

function recordReport(report: NormalizedReport): void {
  const key = `${report.directive} ${report.blocked} ${report.route}`;
  const count = (reportCounts.get(key) ?? 0) + 1;
  reportCounts.set(key, count);
  const now = Date.now();
  const last = lastLoggedAt.get(key);
  if (last === undefined || now - last >= CSP_LOG_INTERVAL_MS) {
    console.error(`[csp] ${key} n=${count}`);
    lastLoggedAt.set(key, now);
  }
}

function recordMalformed(): void {
  recordReport({ directive: "malformed", blocked: "inline", route: "/" });
}

function payloadReports(contentType: string, payload: unknown): unknown[] | null {
  if (contentType === "application/reports+json") return Array.isArray(payload) ? payload : null;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  return [(payload as Record<string, unknown>)["csp-report"]];
}

export function resetCspReportState(): void {
  reportCounts.clear();
  lastLoggedAt.clear();
}

export const POST = handler(async (request: Request) => {
  const contentType = mediaType(request);
  if (!ACCEPTED_CONTENT_TYPES.has(contentType)) throw new HttpError(415, "Unsupported CSP report content type");

  const text = await readBoundedBody(request);
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    recordMalformed();
    return new Response(null, { status: 204 });
  }

  const reports = payloadReports(contentType, payload);
  if (!reports) {
    recordMalformed();
  } else {
    for (const value of reports) {
      const report = normalizeReport(value);
      if (report) recordReport(report);
      else recordMalformed();
    }
  }
  return new Response(null, { status: 204 });
});

export const GET = handler(async () => {
  const user = await requireUser();
  if (user.agent) throw new HttpError(403, "CSP reports are only available from a signed-in browser session");
  return json({ counters: Object.fromEntries([...reportCounts].sort(([a], [b]) => a.localeCompare(b))) });
});
