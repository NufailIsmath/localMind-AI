import { expect, test, type Page } from "@playwright/test";
import { ask } from "./helpers";

/** Requires the demo organisation (`npm run seed:demo` resets demo leave each run). */
async function signIn(page: Page, email: string) {
  await page.goto("/");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("demo-password");
  await page.getByRole("button", { name: "Sign in" }).last().click();
  await expect(page.getByText("What can I help you sort out today?")).toBeVisible();
}
const SHOTS = process.env.E2E_SCREENSHOTS;
const year = new Date().getFullYear();

test("request leave in chat → HR approves → the card updates live", async ({ browser }) => {
  test.slow();
  const intern = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  await signIn(intern, "intern@demo.local");
  const leftBefore = Number((await intern.getByTestId("my-leave").innerText()).match(/([\d.]+) days? of leave left/)![1]);
  const answer = await ask(intern, `Book leave from ${year}-12-28 to ${year}-12-29`);
  await expect(answer).toContainText("Submit request");
  const card = answer.getByTestId("leave-request-card");
  await expect(card).toContainText("Working days2");
  await card.getByRole("button", { name: "Submit request" }).click();
  await expect(card).toContainText("Waiting for HR approval");
  if (SHOTS) await intern.screenshot({ path: `${SHOTS}/leave-request-pending.png` });

  const hr = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  await signIn(hr, "hr@demo.local");
  await expect(hr.locator(".count-badge")).toHaveText(/\d+/);
  await hr.getByRole("button", { name: /Manage leave/ }).click();
  const panel = hr.getByRole("dialog", { name: "Manage leave" });
  const req = panel.getByTestId("leave-request").filter({ hasText: "intern@demo.local" }).filter({ hasText: `${year}-12-28` });
  await expect(req).toBeVisible();
  await expect(panel.getByTestId("leave-request").filter({ hasText: "Moving house" })).toBeVisible(); // seeded request
  await req.getByLabel("Note to intern@demo.local").fill("Have a lovely break!");
  if (SHOTS) await hr.screenshot({ path: `${SHOTS}/leave-request-inbox.png` });
  await req.getByRole("button", { name: "Approve" }).click();
  await expect(panel).toContainText("Approved intern@demo.local's leave");

  await expect(card).toContainText("Approved", { timeout: 15_000 });
  await expect(card).toContainText("Have a lovely break!");
  // The sidebar balance refreshes as soon as the card sees the decision.
  await expect(intern.getByTestId("my-leave")).toContainText(`${leftBefore - 2} days of leave left`);
  if (SHOTS) await intern.screenshot({ path: `${SHOTS}/leave-request-approved.png` });
});

test("HR can't approve their own request", async ({ page }) => {
  await signIn(page, "hr@demo.local");
  const answer = await ask(page, `Book leave from ${year}-12-30 to ${year}-12-31`);
  await answer.getByTestId("leave-request-card").getByRole("button", { name: "Submit request" }).click();
  await page.getByRole("button", { name: /Manage leave/ }).click();
  const panel = page.getByRole("dialog", { name: "Manage leave" });
  const mine = panel.getByTestId("leave-request").filter({ hasText: "hr@demo.local" });
  await mine.getByRole("button", { name: "Approve" }).click();
  await expect(panel.getByRole("alert")).toContainText("can't decide on your own leave request");
});
