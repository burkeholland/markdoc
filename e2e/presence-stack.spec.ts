import { test, expect } from "./fixtures";
import { createDocument, openDocument, shareWith, signIn, uniqueLogin } from "./helpers";

test("earlier presence avatars appear above later avatars and overflow", async ({ browser }) => {
  const alice = await signIn(browser, uniqueLogin("stack-alice"));
  const bob = await signIn(browser, uniqueLogin("stack-bob"));
  const carol = await signIn(browser, uniqueLogin("stack-carol"));
  const dave = await signIn(browser, uniqueLogin("stack-dave"));
  const docId = await createDocument(alice.page, "# Presence stack\n");

  for (const user of [bob, carol, dave]) {
    await shareWith(alice.page, docId, user.login, "editor");
  }
  for (const user of [alice, bob, carol]) {
    await openDocument(user.page, docId);
  }

  const stack = alice.page.getByTestId("presence");
  await expect(stack.getByTestId("presence-avatar")).toHaveCount(3);
  await expect(stack).toHaveAttribute("aria-label", new RegExp(`^3 people here: ${alice.login} \\(you\\)`));

  const overlapWinners = async () => stack.evaluate((element) => {
    const avatars = Array.from(element.querySelectorAll<HTMLElement>('[data-testid="presence-avatar"]'));
    return avatars.slice(0, -1).map((avatar, index) => {
      const left = avatar.getBoundingClientRect();
      const right = avatars[index + 1].getBoundingClientRect();
      const hit = document.elementFromPoint((left.right + right.left) / 2, (left.top + left.bottom) / 2);
      return {
        overlap: left.right - right.left,
        winner: avatars.findIndex((candidate) => candidate === hit?.closest('[data-testid="presence-avatar"]')),
      };
    });
  });
  expect(await overlapWinners()).toEqual([{ overlap: 8, winner: 0 }, { overlap: 8, winner: 1 }]);

  await openDocument(dave.page, docId);
  await expect(stack).toContainText("+1");
  expect(await overlapWinners()).toEqual([{ overlap: 8, winner: 0 }, { overlap: 8, winner: 1 }]);
  const overflowWinner = await stack.evaluate((element) => {
    const avatars = element.querySelectorAll<HTMLElement>('[data-testid="presence-avatar"]');
    const last = avatars[2];
    const overflow = Array.from(element.querySelectorAll<HTMLElement>(".avatar")).find((item) => item.textContent === "+1")!;
    const left = last.getBoundingClientRect();
    const right = overflow.getBoundingClientRect();
    const hit = document.elementFromPoint((left.right + right.left) / 2, (left.top + left.bottom) / 2);
    return { overlap: left.right - right.left, winner: hit?.closest('[data-testid="presence-avatar"]') === last };
  });
  expect(overflowWinner).toEqual({ overlap: 8, winner: true });
  await stack.click();
  await expect(alice.page.getByTestId("presence-row")).toHaveCount(4);
});
