import { z } from "zod";
import { handler, json, readJson, requireAccess, HttpError } from "@/server/http";
import { createRequest, listRequests, INSTRUCTION_MAX, QUOTE_MAX } from "@/server/agent-requests";
import type { AgentRequestStatus } from "@/server/db/schema";

type Params = { params: Promise<{ id: string }> };

const createSchema = z.object({
  instruction: z.string().trim().min(1).max(INSTRUCTION_MAX),
  selection: z
    .object({ from: z.number().int().min(0), to: z.number().int().min(0), quote: z.string().max(QUOTE_MAX) })
    .nullable()
    .optional(),
  mode: z.enum(["suggest", "comment", "rewrite"]).default("suggest"),
  /** The comment thread the request is made from (must exist: `404 Comment not found`); the thread's Y.Map gets `requestId`. */
  threadId: z.string().trim().min(1).nullable().optional(),
  /** The agent to address, `login/slug` (leading `@` accepted, case-insensitive). Default: the thread's first `@login/slug`, else unaddressed. */
  agent: z.string().trim().min(1).max(100).nullable().optional(),
});

const STATUSES = ["open", "claimed", "done", "cancelled"] as const satisfies readonly AgentRequestStatus[];

const querySchema = z.object({ status: z.array(z.enum(STATUSES)).min(1).optional() });

/**
 * Ask an agent: hand a selection plus an instruction to one agent. Commenters may ask for comments;
 * asking for changes (suggest / rewrite) needs edit access. The addressee (`agent`, or the thread's first
 * `@login/slug`) must be a live token (`400 unknown-agent`) whose owner is the caller or has switched
 * `collaboratorsMayAsk` on (`403 agent-owner-only`); without one the request goes to the caller's own agents.
 */
export const POST = handler(async (req: Request, { params }: Params) => {
  const { id } = await params;
  const { user, role } = await requireAccess(id, "comment");
  if (!user) throw new HttpError(401, "Sign in required");
  const body = await readJson(req, (d) => createSchema.parse(d));
  const request = await createRequest(id, user, role, body);
  return json({ request }, { status: 201 });
});

/** Requests on this document, newest first. `?status=open,claimed` filters (`open | claimed | done | cancelled`; anything else is a `400`). */
export const GET = handler(async (req: Request, { params }: Params) => {
  const { id } = await params;
  await requireAccess(id, "view");
  const raw = new URL(req.url).searchParams.get("status");
  const { status } = querySchema.parse({ status: raw?.split(",").map((s) => s.trim()) });
  const requests = await listRequests(id, { status });
  return json({ requests });
});
