// @vitest-environment jsdom
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import AppError from "./error";
import GlobalError from "./global-error";

afterEach(cleanup);

describe.each([
  { name: "AppError", Component: AppError },
  { name: "GlobalError", Component: GlobalError },
])("$name honors real input on Try again", ({ Component }) => {
  it("calls reset on a synthetic click", () => {
    const reset = vi.fn();
    render(createElement(Component, { error: new Error("boom"), reset }));
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(reset).toHaveBeenCalledOnce();
  });

  it("calls reset on keyboard activation", async () => {
    const reset = vi.fn();
    render(createElement(Component, { error: new Error("boom"), reset }));
    screen.getByRole("button", { name: "Try again" }).focus();
    await userEvent.keyboard("{Enter}");
    expect(reset).toHaveBeenCalledOnce();
  });
});
