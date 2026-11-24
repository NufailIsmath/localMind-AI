import { expect, test } from "@playwright/test";
import { ask, signUp } from "./helpers";

test("mobile layout switches panels without horizontal scroll", async ({ page }) => {
  await signUp(page);
  await ask(page, "hello");
  for (const tab of ["Docs", "Chats", "Chat"]) {
    await page.getByRole("button", { name: tab, exact: true }).click();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  }
  await page.getByRole("button", { name: "Docs", exact: true }).click();
  await expect(page.getByText("Knowledge base")).toBeVisible();
});
