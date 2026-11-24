import { expect, test, type Page } from "@playwright/test";
import { ask } from "./helpers";

/** Requires the demo organisation (`npm run seed:demo`, which resets demo leave). */
async function signIn(page: Page, email: string): Promise<string> {
  await page.goto("/");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("demo-password");
  await page.getByRole("button", { name: "Sign in" }).last().click();
  await expect(page.getByText("What can I help you sort out today?")).toBeVisible();
  return (await page.evaluate(() => localStorage.getItem("clbuddy.token")))!;
}
const API = process.env.E2E_API_URL ?? "http://localhost:4000";
const SHOTS = process.env.E2E_SCREENSHOTS;
const year = new Date().getFullYear();

async function remaining(page: Page, token: string): Promise<number> {
  const res = await page.request.get(`${API}/api/leave/me`, { headers: { authorization: `Bearer ${token}` } });
  const body = (await res.json()) as { balances: { leaveType: string; remaining: number }[] };
  return body.balances.find((b) => b.leaveType === "ANNUAL")!.remaining;
}

test.describe("leave balance", () => {
  test("shows my balance and answers 'how many days do I have?' from my own record", async ({ page }) => {
    const token = await signIn(page, "intern@demo.local");
    const left = await remaining(page, token);
    const card = page.getByTestId("my-leave");
    await expect(card).toContainText(`${left} days of leave left`);
    await card.getByRole("button").first().click();
    await expect(card).toContainText("Taken");
    await expect(card).toContainText("Booked");

    const answer = await ask(page, "How many leave days do I have?");
    await expect(answer.locator(".tool")).toContainText("Checked your leave balance");
    await expect(answer).toContainText(`You have ${left} days of annual leave left for ${year}`);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/leave-balance.png` });

    const plan = await ask(page, `If I take leave from ${year}-12-28 to ${year}-12-31, what's left?`);
    await expect(plan).toContainText("4 working day(s)");
    await expect(plan).toContainText(`You'd have ${left - 4} days left`);

    // "Plan time off" pre-fills the composer without sending.
    await card.getByRole("button", { name: "Plan time off with CL Buddy →" }).click();
    await expect(page.getByLabel("Message")).toHaveValue(/plan some time off/);
  });

  test("HR records leave and the person's balance updates", async ({ page, browser }) => {
    const hrToken = await signIn(page, "hr@demo.local");
    await page.getByRole("button", { name: /Manage leave/ }).click();
    const panel = page.getByRole("dialog", { name: "Manage leave" });
    await panel.getByRole("tab", { name: "People" }).click(); // opens on Requests by default
    const row = panel.getByRole("row").filter({ hasText: "engineer@demo.local" });
    await expect(row).toBeVisible();
    await row.getByRole("button", { name: "Edit" }).click();
    const editor = panel.getByTestId("leave-editor");
    await editor.getByLabel("From").fill(`${year}-12-28`);
    await editor.getByLabel("To").fill(`${year}-12-29`);
    await editor.getByLabel("Note").fill("E2E test");
    const engPage = await browser.newPage();
    const engToken = await signIn(engPage, "engineer@demo.local");
    const before = await remaining(engPage, engToken);
    await editor.getByRole("button", { name: "Add" }).click();
    await expect(panel).toContainText("Leave recorded");
    await expect(editor).toContainText("E2E test");
    expect(await remaining(engPage, engToken)).toBe(before - 2);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/leave-manage.png` });

    // Clean up: cancel it again.
    await editor.getByRole("listitem").filter({ hasText: "E2E test" }).getByRole("button", { name: "Cancel" }).click();
    await expect(panel).toContainText("Leave cancelled");
    expect(await remaining(engPage, engToken)).toBe(before);
    void hrToken;
  });

  test("people outside HR can't open leave management", async ({ page }) => {
    const token = await signIn(page, "engineer@demo.local");
    await expect(page.getByRole("button", { name: /Manage leave/ })).toHaveCount(0);
    const res = await page.request.get(`${API}/api/leave/manage/people?year=${year}`, { headers: { authorization: `Bearer ${token}` } });
    expect(res.status()).toBe(403);
  });
});
