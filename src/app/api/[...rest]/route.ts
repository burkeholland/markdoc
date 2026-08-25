import { json } from "@/server/http";

/**
 * Every `/api/*` path that no route claims answers JSON, like every other API error, instead of
 * the HTML 404 page: agents parsing the body would otherwise fail on `<!DOCTYPE html>`.
 */
export const dynamic = "force-dynamic";

const notFound = async (req: Request) => json({ error: "Not found", path: new URL(req.url).pathname }, { status: 404 });

export const GET = notFound;
export const HEAD = notFound;
export const POST = notFound;
export const PUT = notFound;
export const PATCH = notFound;
export const DELETE = notFound;
export const OPTIONS = notFound;
