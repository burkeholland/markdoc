const WORD_RE = /[\p{L}\p{N}][\p{L}\p{N}\p{M}]*(?:['\u2019-][\p{L}\p{N}][\p{L}\p{N}\p{M}]*)*/gu;

export function countWords(text: string): number {
  const words = text.match(WORD_RE);
  return words ? words.length : 0;
}
