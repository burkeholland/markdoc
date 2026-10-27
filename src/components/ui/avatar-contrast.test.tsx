// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Avatar } from "./display";

describe("Avatar initials contrast (#2396)", () => {
  it("draws initials in the theme ink, keeping the identity color on the ring only", () => {
    const { container } = render(<Avatar name="Demo User" color="#ea580c" />);
    const avatar = container.querySelector(".avatar") as HTMLElement;
    const initials = avatar.querySelector("span") as HTMLElement;
    expect(initials.textContent).toBe("DU");
    expect(initials.style.color).toBe("");
    expect(avatar.style.boxShadow).toContain("#ea580c");
  });
});
