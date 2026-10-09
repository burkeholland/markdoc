/**
 * How a space at the end of a table cell is written. GFM takes the spaces around a cell's text as
 * padding, so a plain one cannot be told from the padding that lines the columns up: typed in the rich
 * editor after a word, it was gone from the text and the next letter joined the word ("a b" came out
 * as "ab"). A no-break space is not padding. `serialize.ts` ends the cell with one and `parse.ts`
 * reads it back as the space.
 */
export const CELL_END_SPACE = "\u00a0";
