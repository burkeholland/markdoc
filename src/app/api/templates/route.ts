import { handler, json, requireUser } from "@/server/http";
import { TEMPLATES } from "@/lib/templates";

/** Templates accepted by `POST /api/documents { template }`. */
export const GET = handler(async () => {
  await requireUser();
  return json({ templates: TEMPLATES.map(({ id, name, description }) => ({ id, name, description })) });
});
