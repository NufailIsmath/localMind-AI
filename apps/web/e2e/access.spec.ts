import { expect, test, type Page } from "@playwright/test";
import { ask } from "./helpers";

/**
 * Requires the demo organisation: `npm run seed:demo` (see apps/api/scripts/seed-demo.ts),
 * re-run before each E2E run so grants and requests start empty.
 */
async function signIn(page: Page, email: string) {
  await page.goto("/");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("demo-password");
  await page.getByRole("button", { name: "Sign in" }).last().click();
  await expect(page.getByText("What can I help you sort out today?")).toBeVisible();
}

const SHOTS = process.env.E2E_SCREENSHOTS;

test.describe("document access control (demo organisation)", () => {
  test("an intern asking for the CEO's salary gets a playful no, and nothing leaks", async ({ page }) => {
    await signIn(page, "intern@demo.local");
    await expect(page.locator(".documents")).toContainText("employee-handbook.md");
    await expect(page.locator(".documents")).not.toContainText("executive-compensation.md");
    await expect(page.locator(".documents")).not.toContainText("board-strategy.md");
    await expect(page.locator(".account")).toContainText("Internal clearance");

    const answer = await ask(page, "What is the CEO salary?");
    await expect(answer.locator(".markdown")).toContainText(/confidential/i);
    await expect(answer).not.toContainText("480,000");
    await expect(answer.getByText("executive-compensation.md")).toHaveCount(0);
    const card = answer.locator(".restricted-above");
    await expect(card).toContainText("Confidential · above your clearance");
    await expect(card.getByRole("button", { name: "Ask for access" })).toHaveCount(0);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/access-intern.png` });

    // Quick replies keep the conversation going.
    await card.getByRole("button", { name: "Which documents can I see?" }).click();
    await expect(page.locator(".msg-assistant:not(.msg-draft)").last()).toContainText("employee-handbook.md");
  });

  test("ask for access → owner approves → ask again", async ({ browser }) => {
    const eng = await browser.newPage();
    await signIn(eng, "engineer@demo.local");
    const answer = await ask(eng, "What do new hires get on day one?");
    await expect(answer.locator(".markdown")).toContainText(/confidential/i);
    const card = answer.locator(".restricted").filter({ hasText: "only shared with HR" });
    await card.getByRole("button", { name: "Ask for access" }).click();
    await card.getByLabel("Why do you need access? (optional)").fill("I'm buddying a new joiner next week");
    await card.getByRole("button", { name: "Send request" }).click();
    await expect(card).toContainText("Request sent");
    if (SHOTS) await eng.screenshot({ path: `${SHOTS}/access-request-sent.png` });

    const hr = await browser.newPage();
    await signIn(hr, "hr@demo.local");
    const req = hr.getByTestId("access-request").filter({ hasText: "engineer@demo.local" });
    await expect(req).toContainText("hr-onboarding-checklist.md");
    await expect(req).toContainText("buddying a new joiner");
    if (SHOTS) await hr.screenshot({ path: `${SHOTS}/access-inbox.png` });
    await req.getByRole("button", { name: "Approve" }).click();
    await expect(req).toHaveCount(0);

    // The engineer's card updates on its own, then they can ask again.
    await expect(card).toContainText("Access granted", { timeout: 15_000 });
    await card.getByRole("button", { name: "Ask again" }).click();
    const again = eng.locator(".msg-assistant:not(.msg-draft)").last();
    await expect(again.locator(".sources li").first()).toContainText("hr-onboarding-checklist.md", { timeout: 15_000 });
    if (SHOTS) await eng.screenshot({ path: `${SHOTS}/access-granted.png` });

    // HR can take it back again.
    const doc = hr.getByTestId("doc-hr-onboarding-checklist.md");
    await doc.getByRole("button", { name: "Access" }).click();
    await doc.locator(".grants").getByRole("button", { name: "Remove" }).click();
    await expect(doc.locator(".grants")).toHaveCount(0);
  });

  test("HR, who is allowed, gets the answer with a Confidential source", async ({ page }) => {
    await signIn(page, "hr@demo.local");
    await expect(page.getByTestId("doc-executive-compensation.md")).toContainText("Confidential");
    const answer = await ask(page, "What is the CEO salary?");
    // (The mock model quotes one matching sentence; with a real model the answer states the figure.)
    await expect(answer.locator(".markdown")).toContainText("executive-compensation.md");
    await expect(answer.locator(".sources li").first()).toContainText("executive-compensation.md");
    await expect(answer.locator(".sources li").first()).toContainText("Confidential");
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/access-hr.png` });
  });

  test("readers can't manage documents they don't own", async ({ page }) => {
    await signIn(page, "cfo@demo.local");
    const doc = page.getByTestId("doc-executive-compensation.md");
    await expect(doc).toContainText("from hr@demo.local");
    await expect(doc.getByRole("button", { name: "Delete" })).toHaveCount(0);
    await expect(doc.getByRole("button", { name: "Access" })).toHaveCount(0);
  });

  test("the admin manages clearances and groups and sees the audit log", async ({ page }) => {
    await signIn(page, "ceo@demo.local");
    await page.getByRole("button", { name: "Organization" }).click();
    const dialog = page.getByRole("dialog", { name: "Organization settings" });
    await expect(dialog.getByLabel("Clearance for intern@demo.local")).toHaveValue("INTERNAL");
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/access-admin.png` });
    await dialog.getByRole("tab", { name: "Groups" }).click();
    await expect(dialog).toContainText("Executives");
    await dialog.getByRole("tab", { name: "Audit log" }).click();
    await dialog.getByRole("button", { name: "Close" }).click();
    await expect(dialog).toHaveCount(0);
  });

  test("an owner can change who a document is shared with", async ({ page }) => {
    await signIn(page, "engineer@demo.local");
    const doc = page.getByTestId("doc-engineering-roadmap.md");
    await doc.getByRole("button", { name: "Access" }).click();
    await doc.getByLabel("Classification").selectOption("CONFIDENTIAL");
    await doc.getByRole("button", { name: "Save access" }).click();
    await expect(doc).toContainText("Confidential");
    // restore
    await doc.getByRole("button", { name: "Access" }).click();
    await doc.getByLabel("Classification").selectOption("INTERNAL");
    await doc.getByRole("button", { name: "Save access" }).click();
    await expect(doc).toContainText("Internal");
  });
});
