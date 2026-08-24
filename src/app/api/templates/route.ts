import { handler, json, requireUser } from "@/server/http";
import { PICKER_TEMPLATES } from "@/lib/templates";

/** Templates accepted by `POST /api/documents { template }` (hidden ones such as `welcome` are creatable but not listed). */
export const GET = handler(async () => {
  await requireUser();
  return json({ templates: PICKER_TEMPLATES.map(({ id, name, description }) => ({ id, name, description })) });
});
