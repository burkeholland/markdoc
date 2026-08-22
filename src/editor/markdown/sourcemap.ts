import type { Node as PMNode } from "prosemirror-model";

/** Source range of a top-level block in the Markdown text. */
export interface BlockRange {
  from: number;
  to: number;
  /**
   * A phantom block exists in the ProseMirror document (for example an empty
   * paragraph the user just created) but has no representation in Markdown yet.
   */
  phantom?: boolean;
}

/** Maps a leaf inline node to the Markdown characters it was parsed from. */
export interface Segment {
  pmFrom: number;
  pmTo: number;
  srcFrom: number;
  srcTo: number;
}

export interface SourceMap {
  /** One entry per top-level child of the ProseMirror document, in order. */
  blocks: BlockRange[];
  /** Leaf segments sorted by ProseMirror position (and by source offset). */
  segments: Segment[];
  /** Convert a Markdown character offset to a ProseMirror position. */
  srcToPm(offset: number): number;
  /** Convert a ProseMirror position to a Markdown character offset. */
  pmToSrc(pos: number): number;
  /** Index of the top-level block containing the given ProseMirror position. */
  blockIndexAt(pos: number): number;
}

function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n));
}

export function buildSourceMap(doc: PMNode, blocks: BlockRange[], segments: Segment[]): SourceMap {
  const blockStarts: number[] = [];
  let pos = 0;
  doc.forEach((child) => {
    blockStarts.push(pos);
    pos += child.nodeSize;
  });
  const docSize = doc.content.size;

  const blockIndexAt = (p: number): number => {
    // The block whose start is <= p; positions at a boundary belong to the following block
    // except at the very end of the doc.
    let lo = 0;
    let hi = blockStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (blockStarts[mid] <= p) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };

  const srcToPm = (offset: number): number => {
    if (segments.length === 0) return 0;
    // Binary search for the last segment with srcFrom <= offset.
    let lo = 0;
    let hi = segments.length - 1;
    if (offset < segments[0].srcFrom) return segments[0].pmFrom;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (segments[mid].srcFrom <= offset) lo = mid;
      else hi = mid - 1;
    }
    const seg = segments[lo];
    if (offset <= seg.srcTo) {
      return seg.pmFrom + clamp(offset - seg.srcFrom, 0, seg.pmTo - seg.pmFrom);
    }
    const next = segments[lo + 1];
    if (!next) return seg.pmTo;
    // In a gap between two segments (Markdown syntax or block separators): snap to the
    // nearer side, preferring the end of the previous segment on a tie.
    return offset - seg.srcTo <= next.srcFrom - offset ? seg.pmTo : next.pmFrom;
  };

  const pmToSrc = (p: number): number => {
    p = clamp(p, 0, docSize);
    if (segments.length === 0) {
      const b = blocks[blockIndexAt(p)];
      return b ? b.from : 0;
    }
    let lo = 0;
    let hi = segments.length - 1;
    if (p < segments[0].pmFrom) {
      const b = blocks[blockIndexAt(p)];
      return b && b.from < segments[0].srcFrom ? b.from : segments[0].srcFrom;
    }
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (segments[mid].pmFrom <= p) lo = mid;
      else hi = mid - 1;
    }
    const seg = segments[lo];
    if (p <= seg.pmTo) {
      return seg.srcFrom + clamp(p - seg.pmFrom, 0, seg.srcTo - seg.srcFrom);
    }
    const next = segments[lo + 1];
    // Gap: if the position is inside a block with no segments (e.g. an empty paragraph),
    // use that block's source start so edits land in the right place.
    const blockIdx = blockIndexAt(p);
    const block = blocks[blockIdx];
    if (block) {
      const blockStart = blockStarts[blockIdx];
      const blockEnd = blockStart + doc.child(blockIdx).nodeSize;
      const hasSegment = seg.pmTo > blockStart || (next && next.pmFrom < blockEnd);
      if (!hasSegment) return block.from;
    }
    if (!next) return seg.srcTo;
    return p - seg.pmTo <= next.pmFrom - p ? seg.srcTo : next.srcFrom;
  };

  return { blocks, segments, srcToPm, pmToSrc, blockIndexAt };
}
