// @vitest-environment jsdom
import { Fragment, StrictMode, type ComponentProps } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Avatar } from "./display";

const SOURCE_A = "https://example.test/avatar-a.png";
const SOURCE_B = "https://example.test/avatar-b.png?version=2";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe.each([false, true])("Avatar (StrictMode=%s)", (strict) => {
  function renderAvatar(props: ComponentProps<typeof Avatar>) {
    return render(<Avatar {...props} />, { wrapper: strict ? StrictMode : Fragment });
  }

  it.each([undefined, null, ""])("renders initials for absent src %s, then accepts a source", (src) => {
    const view = renderAvatar({ name: "Ada Lovelace", src });
    const outer = screen.getByTitle("Ada Lovelace");
    expect(outer.tagName).toBe("SPAN");
    expect(outer).toHaveAttribute("class", "avatar");
    expect(outer).toHaveStyle({ width: "36px", height: "36px", fontSize: "13px" });
    expect(outer.style.boxShadow).toBe("");
    expect(screen.queryAllByRole("img")).toHaveLength(0);
    expect(screen.getByText("AL")).not.toHaveAttribute("style");

    view.rerender(<Avatar name="Ada Lovelace" src={SOURCE_A} />);
    const image = screen.getByRole("img", { name: "Ada Lovelace" });
    expect(screen.getAllByRole("img")).toHaveLength(1);
    expect(image.parentElement).toBe(outer);
    expect(image).toHaveAttribute("src", SOURCE_A);
    expect(image).toHaveAttribute("width", "36");
    expect(image).toHaveAttribute("height", "36");
    expect(image).toHaveAttribute("class", "h-full w-full object-cover");
    expect(image).toHaveAttribute("referrerpolicy", "no-referrer");
  });

  it("retains a successful image when only presentation props change", () => {
    const view = renderAvatar({ name: "Ada Lovelace", src: SOURCE_A });
    const image = screen.getByRole("img");
    const outer = image.parentElement;
    fireEvent.load(image);
    const setAttribute = vi.spyOn(image, "setAttribute");

    view.rerender(
      <Avatar name="Grace Hopper" src={SOURCE_A} color="#123456" size={48} title="Document owner" className="owner-avatar" />,
    );
    expect(screen.getAllByRole("img")).toEqual([image]);
    expect(image.parentElement).toBe(outer);
    expect(image).toHaveAttribute("alt", "Grace Hopper");
    expect(image).toHaveAttribute("src", SOURCE_A);
    expect(image).toHaveAttribute("width", "48");
    expect(image).toHaveAttribute("height", "48");
    expect(image).toHaveAttribute("class", "h-full w-full object-cover");
    expect(image).toHaveAttribute("referrerpolicy", "no-referrer");
    expect(outer).toHaveAttribute("title", "Document owner");
    expect(outer).toHaveAttribute("class", "avatar owner-avatar");
    expect(outer).toHaveStyle({
      width: "48px", height: "48px", fontSize: "17px",
      boxShadow: "0 0 0 2px var(--color-surface), 0 0 0 4px #123456",
    });

    view.rerender(<Avatar name="Grace Hopper" src={SOURCE_A} title="" size={20} />);
    expect(screen.getAllByRole("img")).toEqual([image]);
    expect(outer).toHaveAttribute("title", "");
    expect(outer).toHaveAttribute("class", "avatar");
    expect(outer).toHaveStyle({ width: "20px", height: "20px", fontSize: "10px" });
    expect(outer?.style.boxShadow).toBe("");
    expect(image).toHaveAttribute("width", "20");
    expect(image).toHaveAttribute("height", "20");
    expect(setAttribute.mock.calls.map(([name]) => name)).not.toContain("src");
  });

  it("keeps failed A on initials, recovers for B, and falls back when B fails", () => {
    const view = renderAvatar({ name: "Ada Lovelace", src: SOURCE_A });
    const imageA = screen.getByRole("img");
    const outer = imageA.parentElement;
    fireEvent.error(imageA);
    expect(screen.queryAllByRole("img")).toHaveLength(0);
    expect(screen.getByText("AL")).toBeInTheDocument();

    view.rerender(<Avatar name="Ada Lovelace" src={SOURCE_A} />);
    expect(screen.queryAllByRole("img")).toHaveLength(0);
    view.rerender(<Avatar name="Grace Hopper" src={SOURCE_A} color="#123456" size={48} title="Owner" className="owner-avatar" />);
    expect(screen.queryAllByRole("img")).toHaveLength(0);
    expect(screen.getByText("GH")).toHaveStyle({ color: "#123456" });

    view.rerender(<Avatar name="Grace Hopper" src={SOURCE_B} color="#123456" size={48} title="Owner" className="owner-avatar" />);
    const imageB = screen.getByRole("img", { name: "Grace Hopper" });
    expect(screen.getAllByRole("img")).toEqual([imageB]);
    expect(imageB).not.toBe(imageA);
    expect(imageB.parentElement).toBe(outer);
    expect(imageB).toHaveAttribute("src", SOURCE_B);
    expect(imageB).toHaveAttribute("referrerpolicy", "no-referrer");
    expect(imageA).not.toBeInTheDocument();

    fireEvent.error(imageA);
    expect(screen.getAllByRole("img")).toEqual([imageB]);
    fireEvent.error(imageB);
    expect(screen.queryAllByRole("img")).toHaveLength(0);
    expect(screen.getByText("GH")).toHaveStyle({ color: "#123456" });
    expect(outer).toHaveAttribute("title", "Owner");
    expect(outer).toHaveAttribute("class", "avatar owner-avatar");
    expect(outer).toHaveStyle({
      width: "48px", height: "48px", fontSize: "17px",
      boxShadow: "0 0 0 2px var(--color-surface), 0 0 0 4px #123456",
    });

    fireEvent.error(imageB);
    view.rerender(<Avatar name="Grace Hopper" src={SOURCE_B} />);
    expect(screen.queryAllByRole("img")).toHaveLength(0);
    expect(screen.getByText("GH").style.color).toBe("");
  });

  it("ignores a late error from A when B replaces it before any error", () => {
    const view = renderAvatar({ name: "Ada Lovelace", src: SOURCE_A });
    const imageA = screen.getByRole("img");
    view.rerender(<Avatar name="Grace Hopper" src={SOURCE_B} />);
    const imageB = screen.getByRole("img", { name: "Grace Hopper" });
    expect(imageA).not.toBeInTheDocument();
    expect(imageB).not.toBe(imageA);

    fireEvent.error(imageA);
    expect(screen.getAllByRole("img")).toEqual([imageB]);
    expect(imageB).toHaveAttribute("src", SOURCE_B);
    fireEvent.error(imageB);
    expect(screen.queryAllByRole("img")).toHaveLength(0);
    expect(screen.getByText("GH")).toBeInTheDocument();
  });

  it.each([SOURCE_B, undefined, null, ""])("allows one new attempt at A after lifetime %s", (src) => {
    const view = renderAvatar({ name: "Ada Lovelace", src: SOURCE_A });
    const imageA = screen.getByRole("img");
    fireEvent.error(imageA);
    view.rerender(<Avatar name="Ada Lovelace" src={src} />);
    expect(screen.queryAllByRole("img")).toHaveLength(src ? 1 : 0);
    view.rerender(<Avatar name="Ada Lovelace" src={SOURCE_A} />);
    const nextImageA = screen.getByRole("img");
    expect(nextImageA).not.toBe(imageA);
    expect(nextImageA).toHaveAttribute("src", SOURCE_A);
    fireEvent.error(imageA);
    expect(screen.getAllByRole("img")).toEqual([nextImageA]);
    fireEvent.error(nextImageA);
    view.rerender(<Avatar name="Ada Lovelace" src={SOURCE_A} />);
    expect(screen.queryAllByRole("img")).toHaveLength(0);
    expect(screen.getByText("AL")).toBeInTheDocument();
  });

  it("uses current initials and default title while the same source remains failed", () => {
    const view = renderAvatar({ name: "Ada Lovelace", src: SOURCE_A });
    fireEvent.error(screen.getByRole("img"));
    for (const [name, expected] of [["  Grace Brewster Hopper  ", "GH"], ["ada", "AD"], [" ", "?"]]) {
      view.rerender(<Avatar name={name} src={SOURCE_A} />);
      expect(screen.queryAllByRole("img")).toHaveLength(0);
      expect(screen.getByText(expected).parentElement).toHaveAttribute("title", name);
    }
  });

  it("does not add requests, timers, animation callbacks, or focus work", () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    const xhr = vi.spyOn(XMLHttpRequest.prototype, "open");
    const timeout = vi.spyOn(globalThis, "setTimeout");
    const interval = vi.spyOn(globalThis, "setInterval");
    const frame = vi.spyOn(window, "requestAnimationFrame");
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const windowFocus = vi.spyOn(window, "focus");
    const activeElement = document.activeElement;
    const view = renderAvatar({ name: "Ada Lovelace", src: SOURCE_A });
    fireEvent.error(screen.getByRole("img"));
    view.rerender(<Avatar name="Grace Hopper" src={SOURCE_A} />);
    view.rerender(<Avatar name="Grace Hopper" src={SOURCE_B} />);
    fireEvent.error(screen.getByRole("img"));
    view.unmount();

    for (const spy of [fetch, xhr, timeout, interval, frame, focus, windowFocus]) {
      expect(spy).not.toHaveBeenCalled();
    }
    expect(document.activeElement).toBe(activeElement);
  });
});
