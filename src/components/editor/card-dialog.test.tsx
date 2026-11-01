// @vitest-environment jsdom
import { useState } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CardDialog } from "./card-dialog";

const TWEET = "https://x.com/jack/status/20";
const VIDEO = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";

afterEach(() => {
  cleanup();
});

/** The dialog as the editor shell holds it: opened from a button, closed through its own request. */
function Harness({ onSubmit }: { onSubmit: (url: string) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open
      </button>
      <CardDialog open={open} onOpenChange={setOpen} onSubmit={onSubmit} />
    </>
  );
}

async function openDialog(onSubmit = vi.fn<(url: string) => void>()) {
  const user = userEvent.setup();
  render(<Harness onSubmit={onSubmit} />);
  await user.click(screen.getByRole("button", { name: "Open" }));
  const dialog = await screen.findByRole("dialog", { name: "Video or post from a link" });
  const field = screen.getByRole("textbox", { name: "Link" }) as HTMLInputElement;
  return { user, onSubmit, dialog, field };
}

describe("Insert: Video or post from a link (#2317)", () => {
  it("is a named dialog that says which sites work, with the caret in its one field", async () => {
    const { dialog, field } = await openDialog();
    expect(dialog.textContent).toContain("Paste a link to a video or post on YouTube, X, Facebook, LinkedIn, Vimeo, Loom or TikTok. It becomes a card on a line of its own.");
    await waitFor(() => expect(document.activeElement).toBe(field));
    expect(field.value).toBe("");
    expect(field.getAttribute("aria-invalid")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("button", { name: "Insert" }).getAttribute("type")).toBe("submit");
    expect(screen.getByRole("button", { name: "Cancel" }).getAttribute("type")).toBe("button");
    // Nothing in the dialog points at another site.
    expect(dialog.querySelectorAll("iframe, script, img, [src], a[href]")).toHaveLength(0);
  });

  it("a link on the list is handed over once, after the dialog has closed, with the spaces around it gone", async () => {
    // What the page looked like at the moment the link was handed over.
    const dialogsAtHandOver: number[] = [];
    const { user, onSubmit, field } = await openDialog(vi.fn<(url: string) => void>(() => void dialogsAtHandOver.push(screen.queryAllByRole("dialog").length)));
    await user.type(field, `  ${VIDEO} `);
    await user.keyboard("{Enter}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit).toHaveBeenCalledWith(VIDEO);
    // The dialog was gone by then, so focus can go to the editor and stay there.
    expect(dialogsAtHandOver).toEqual([0]);
  });

  it("the Insert button does the same as Enter", async () => {
    const { user, onSubmit, field } = await openDialog();
    await user.type(field, TWEET);
    await user.click(screen.getByRole("button", { name: "Insert" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit).toHaveBeenCalledWith(TWEET);
  });

  it("a link that is not on the list is refused with a sentence, the dialog stays open and nothing is handed over", async () => {
    const { user, onSubmit, field } = await openDialog();
    for (const link of ["https://evil.example/watch?v=dQw4w9WgXcQ", "https://x.com.evil.example/jack/status/20", "http://x.com/jack/status/20", "javascript:alert(1)", "x.com/jack/status/20", `${TWEET} and more`]) {
      await user.clear(field);
      await user.type(field, link);
      await user.keyboard("{Enter}");
      const alert = await screen.findByRole("alert");
      expect(alert.textContent, link).toBe("Markdoc cannot show this link as a card. Use the link to one video or post on YouTube, X, Facebook, LinkedIn, Vimeo, Loom or TikTok, starting with https://.");
      expect(field.getAttribute("aria-invalid"), link).toBe("true");
      expect(field.getAttribute("aria-describedby"), link).toBe(alert.id);
      expect(screen.getByRole("dialog")).toBeTruthy();
    }
    expect(onSubmit).not.toHaveBeenCalled();
    // Typing again takes the message away.
    await user.type(field, "x");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(field.getAttribute("aria-invalid")).toBeNull();
  });

  it("an empty field asks for a link", async () => {
    const { user, onSubmit } = await openDialog();
    await user.click(screen.getByRole("button", { name: "Insert" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Paste a link first.");
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("Cancel and Escape close it without a card, also after a link was typed; the next opening is empty", async () => {
    const { user, onSubmit, field } = await openDialog();
    await user.type(field, VIDEO);
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    await user.click(screen.getByRole("button", { name: "Open" }));
    const again = (await screen.findByRole("textbox", { name: "Link" })) as HTMLInputElement;
    expect(again.value).toBe("");
    expect(screen.queryByRole("alert")).toBeNull();
    await user.type(again, TWEET);
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("a link accepted in one opening is not inserted again by the next one", async () => {
    const { user, onSubmit, field } = await openDialog();
    await user.type(field, VIDEO);
    await user.keyboard("{Enter}");
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    await user.click(screen.getByRole("button", { name: "Open" }));
    await screen.findByRole("textbox", { name: "Link" });
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });
});
