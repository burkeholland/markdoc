// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import NotFound from "./not-found";

afterEach(cleanup);

describe("root not-found page", () => {
  it("links back to the Markdoc home with a clear label", () => {
    render(<NotFound />);

    expect(screen.getByRole("link", { name: "Back to Markdoc home" })).toHaveAttribute("href", "/");
  });
});
