import type { Node as PMNode, ResolvedPos } from "prosemirror-model";

export interface ParentMatch {
  node: PMNode;
  pos: number;
  depth: number;
}

/** Closest ancestor (including the parent) of the resolved position that matches. */
export function findParentNode($pos: ResolvedPos, predicate: (node: PMNode) => boolean): ParentMatch | null {
  for (let depth = $pos.depth; depth > 0; depth--) {
    const node = $pos.node(depth);
    if (predicate(node)) return { node, pos: $pos.before(depth), depth };
  }
  return null;
}
