import { describe, expect, it } from "vitest";
import { signInErrorMessage } from "./sign-in-error";

describe("signInErrorMessage()", () => {
  it("says the GitHub step did not finish when GitHub or the person stopped it", () => {
    expect(signInErrorMessage("OAuthCallbackError")).toBe("The GitHub sign-in was cancelled or did not finish. Please try again.");
    expect(signInErrorMessage("AccessDenied")).toBe(signInErrorMessage("OAuthCallbackError"));
  });

  it("owns up to a server-side failure, which is all Auth.js tells the browser", () => {
    const ours = "Sign-in could not be completed because of a problem on our side. Please try again later.";
    expect(signInErrorMessage("Configuration")).toBe(ours);
    expect(signInErrorMessage("AdapterError")).toBe(ours);
  });

  it("never repeats what the address bar sent", () => {
    for (const error of ["<script>alert(1)</script>", "x".repeat(500), ""]) {
      expect(signInErrorMessage(error)).toBe(signInErrorMessage("Configuration"));
    }
  });

  it("has its own line for the development login", () => {
    expect(signInErrorMessage("CredentialsSignin")).toBe("That development login was not accepted. Enter a GitHub handle and try again.");
  });
});
