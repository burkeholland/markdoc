import { describe, expect, it } from "vitest";
import { ApiError, apiErrorText } from "./api";

const FALLBACK = "Could not add collaborator";

describe("apiErrorText", () => {
  it("shows the first validation issue's message instead of the bare 'Invalid request'", () => {
    const err = new ApiError(400, "Invalid request", [{ path: ["login"], message: "Enter a GitHub handle" }]);
    expect(apiErrorText(err, FALLBACK)).toBe("Enter a GitHub handle");
    expect(err.message).toBe("Invalid request");
  });

  it("falls back to the ApiError message when issues is empty", () => {
    expect(apiErrorText(new ApiError(400, "Invalid request", []), FALLBACK)).toBe("Invalid request");
  });

  it("falls back to the ApiError message when issues is not an array", () => {
    expect(apiErrorText(new ApiError(400, "Invalid request", "weird"), FALLBACK)).toBe("Invalid request");
  });

  it("returns a plain Error's message", () => {
    expect(apiErrorText(new Error("boom"), FALLBACK)).toBe("boom");
  });

  it("returns the fallback for a non-Error", () => {
    expect(apiErrorText(undefined, FALLBACK)).toBe(FALLBACK);
  });
});
