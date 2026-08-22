import type { Hocuspocus } from "@hocuspocus/server";
import type { CollabContext } from "./hocuspocus";

// The Next.js server bundle and the custom server are separate module graphs in one
// process. The collaboration server instance is shared through globalThis so route
// handlers can apply changes to live documents.
const g = globalThis as typeof globalThis & { __markdocCollab?: Hocuspocus<CollabContext> };

export function registerCollab(instance: Hocuspocus<CollabContext>) {
  g.__markdocCollab = instance;
}

export function getCollab(): Hocuspocus<CollabContext> | null {
  return g.__markdocCollab ?? null;
}
