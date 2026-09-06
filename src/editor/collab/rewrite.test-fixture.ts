export const REWRITE_AUTHOR = "Garden Assistant";
export const REWRITE_BEFORE =
  "During the weekly review, the garden team checks the water schedule and the nursery tools. " +
  "The team records the weather in the shared journal and asks the coordinator to approve the next delivery. " +
  "These notes help the team keep the seedlings healthy while the volunteers prepare the beds for spring.";
export const REWRITE_AFTER =
  "The shared journal gives the garden team a clear plan for spring. " +
  "Volunteers record the weather, prepare the nursery beds, and adjust the water schedule before the weekly review. " +
  "Instead of waiting for the coordinator to approve every delivery, the team checks the seedlings and orders the tools it needs.";
export const REWRITE_PREFIX = "# Garden plan\n\nThe opening remains unchanged.\n\n";
export const REWRITE_SUFFIX = "\n\nThe closing remains unchanged.\n";
export const REWRITE_DOCUMENT = REWRITE_PREFIX + REWRITE_BEFORE + REWRITE_SUFFIX;
export const REWRITE_RESULT = REWRITE_PREFIX + REWRITE_AFTER + REWRITE_SUFFIX;

export const LONG_PASSAGE_PREFIX = "L".repeat(10_000);
export const LONG_PASSAGE_SUFFIX = "R".repeat(10_000);

export const UNPLANNABLE_PASSAGES = [
  {
    reason: "oversized changed middle",
    before: "old " + "unchanged ".repeat(2_000) + "old",
    after: "new " + "unchanged ".repeat(2_000) + "new",
  },
  {
    reason: "exhausted word budget",
    before: Array.from({ length: 600 }, (_, index) => `old${index}`).join(" "),
    after: Array.from({ length: 600 }, (_, index) => `new${index}`).join(" "),
  },
  {
    reason: "exhausted block budget",
    before: Array.from({ length: 1_100 }, (_, index) => `Old paragraph ${index}.`).join("\n\n"),
    after: Array.from({ length: 1_100 }, (_, index) => `New paragraph ${index}.`).join("\n\n"),
  },
];
