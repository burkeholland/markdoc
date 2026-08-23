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
});

const STATUSES: AgentRequestStatus[] = ["open", "claimed", "done", "cancelled"];

/**
 * Ask an agent: hand a selection plus an instruction to whichever agent picks it up. Commenters
 * may ask for comments; asking for changes (suggest / rewrite) needs edit access.
 */
export const POST = handler(async (req: Request, { params }: Params) => {
  const { id } = await params;
  const { user, role } = await requireAccess(id, "comment");
  if (!user) throw new HttpError(401, "Sign in required");
  const body = await readJson(req, (d) => createSchema.parse(d));
  const request = await createRequest(id, user, role, body);
  return json({ request }, { status: 201 });
});

/** Requests on this document, newest first. `?status=open,claimed` filters. */
export const GET = handler(async (req: Request, { params }: Params) => {
  const { id } = await params;
  await requireAccess(id, "view");
  const raw = new URL(req.url).searchParams.get("status");
  const status = raw
    ? raw
        .split(",")
        .map((s) => s.trim())
        .filter((s): s is AgentRequestStatus => (STATUSES as string[]).includes(s))
    : undefined;
  const requests = await listRequests(id, { status: status && status.length ? status : undefined });
  return json({ requests });
});
