// Setup files run after the test environment is installed, so `document` is
// only defined under the jsdom (or another DOM) environment. The jest-dom
// matchers need a DOM, so node-environment files skip installing them.
if (typeof document !== "undefined") {
  await import("@testing-library/jest-dom/vitest");
}

export {};
