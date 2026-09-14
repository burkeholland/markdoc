import { describe, expect, it } from "vitest";
import { countWords as publicCountWords } from "./utils";
import { countWords } from "./word-count";

describe("countWords", () => {
  it.each([
    { name: "empty text", text: "", expected: 0 },
    { name: "whitespace", text: " \t\r\n ", expected: 0 },
    { name: "ASCII prose and punctuation", text: "Hello, world! (One more.)", expected: 4 },
    { name: "digits and mixed alphanumerics", text: "123 abc123 4.5", expected: 4 },
    { name: "existing word connectors", text: "don't can\u2019t mother-in-law", expected: 3 },
    { name: "repeated or outer connectors", text: "'word' -word- word--word", expected: 4 },
    { name: "precomposed diaeresis", text: "na\u00EFve", expected: 1 },
    { name: "decomposed diaeresis", text: "nai\u0308ve", expected: 1 },
    { name: "precomposed accents", text: "r\u00E9sum\u00E9", expected: 1 },
    { name: "decomposed accents", text: "re\u0301sume\u0301", expected: 1 },
    { name: "multiple attached nonspacing marks", text: "a\u0308\u0301b", expected: 1 },
    { name: "Devanagari spacing vowel marks", text: "\u0915\u093F\u0924\u093E\u092C", expected: 1 },
    { name: "Devanagari nonspacing virama", text: "\u0915\u094D\u0937", expected: 1 },
    { name: "enclosing mark", text: "a\u20DDb", expected: 1 },
    { name: "marks attached to digits", text: "1\u03082\u20DD3", expected: 1 },
    { name: "marked word with straight apostrophe", text: "cafe\u0301's", expected: 1 },
    { name: "marked word with curly apostrophe", text: "cafe\u0301\u2019s", expected: 1 },
    { name: "marked components with hyphen", text: "\u0915\u093F-\u0915\u093F", expected: 1 },
    { name: "enclosing mark before hyphen", text: "x\u20DD-y", expected: 1 },
    { name: "marked digit component after hyphen", text: "a\u0301-2\u0308", expected: 1 },
    { name: "mark cannot start apostrophe component", text: "a'\u0301b", expected: 2 },
    { name: "mark cannot start curly apostrophe component", text: "a\u2019\u0301b", expected: 2 },
    { name: "mark cannot start hyphen component", text: "a-\u0301b", expected: 2 },
    { name: "separate marked words", text: "nai\u0308ve re\u0301sume\u0301", expected: 2 },
    { name: "isolated marks of all three categories", text: "\u0301\u093F\u20DD", expected: 0 },
    { name: "marks separated by whitespace", text: "\u0301 \t\u093F\n\u20DD", expected: 0 },
    { name: "leading marks", text: "\u0301\u20DDword", expected: 1 },
    { name: "trailing marks", text: "word\u0301\u20DD", expected: 1 },
    { name: "leading and attached marks", text: "\u0301nai\u0308ve\u20DD", expected: 1 },
    { name: "marks cannot bridge whitespace", text: "a\u0301 \u0308b", expected: 2 },
    { name: "marks cannot bridge punctuation", text: "a\u0301,\u0308b", expected: 2 },
    { name: "mark after sentence punctuation", text: "a.\u0301b", expected: 2 },
    { name: "marks and punctuation alone", text: ".\u0301,\u093E!\u20DD", expected: 0 },
    { name: "contiguous CJK run", text: "\u4E2D\u6587", expected: 1 },
    { name: "separate CJK runs", text: "\u4E2D \u6587", expected: 2 },
    { name: "attached mark in CJK run", text: "\u4E2D\u0301\u6587", expected: 1 },
    { name: "joiner and non-joiner remain boundaries", text: "a\u200Cb a\u200Db", expected: 4 },
    { name: "emoji remain boundaries", text: "word\u{1F600}word", expected: 2 },
    { name: "emoji-only text with joiners and variation selector", text: "\u{1F600} \u2764\uFE0F \u{1F469}\u200D\u{1F467}", expected: 0 },
  ])("$name", ({ text, expected }) => {
    expect(countWords(text)).toBe(expected);
  });

  it("re-exports the same counter from the public utils module", () => {
    expect(publicCountWords).toBe(countWords);
  });
});
