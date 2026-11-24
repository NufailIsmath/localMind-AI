import { expect, test, type Page } from "@playwright/test";
import { ask } from "./helpers";

/** Requires the demo organisation (`npm run seed:demo`). */
async function signIn(page: Page, email: string) {
  await page.goto("/");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("demo-password");
  await page.getByRole("button", { name: "Sign in" }).last().click();
  await expect(page.getByText("What can I help you sort out today?")).toBeVisible();
}
const SHOTS = process.env.E2E_SCREENSHOTS;

test.describe("CL Buddy as a work buddy", () => {
  test("drafts an email to the right team with copy and open-in-email actions", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await signIn(page, "engineer@demo.local");
    await expect(page.locator(".brand").first()).toHaveText(/CL Buddy/);
    await expect(page).toHaveTitle("CL Buddy");

    // One of the starter suggestions.
    await page.getByRole("button", { name: "Draft an email to HR asking for annual leave from 2 to 6 March", exact: true }).click();
    const answer = page.locator(".msg-assistant:not(.msg-draft)").last();
    const draft = answer.getByTestId("email-draft");
    await expect(draft).toBeVisible({ timeout: 20_000 });
    await expect(answer.locator(".tool")).toContainText("Looked up who handles it");
    await expect(draft).toContainText("hr@demo.local");
    await expect(draft).toContainText("Annual leave from 2 to 6 March");
    await expect(draft).toContainText("[Your name]");
    const open = draft.getByRole("link", { name: "Open in email app" });
    await expect(open).toHaveAttribute("href", /^mailto:hr@demo\.local\?subject=Annual%20leave/);
    await draft.getByRole("button", { name: "Copy" }).click();
    await expect(draft.getByRole("button", { name: "Copied ✓" })).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toContain("Subject: Annual leave from 2 to 6 March");
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/buddy-email.png` });
  });

  test("walks someone through sorting out a work issue, citing company docs", async ({ page }) => {
    await signIn(page, "intern@demo.local");
    const answer = await ask(page, "My laptop isn't working, what should I do?");
    await expect(answer).toContainText("Here's what to do");
    await expect(answer).toContainText("restart");
    await expect(answer.locator(".sources li").first()).toContainText("it-support-guide.md");
    await expect(answer).toContainText("draft the email");
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/buddy-guidance.png` });

    // Follow-up: who to contact.
    const who = await ask(page, "Draft an email to IT about my broken laptop");
    await expect(who.getByTestId("email-draft")).toContainText("it@demo.local");
  });
});
