import { expect, test, type Page } from "@playwright/test";
import { ask } from "./helpers";

/**
 * Requires the demo organisation: `npm run seed:demo` (see apps/api/scripts/seed-demo.ts).
 */
async function signIn(page: Page, email: string) {
  await page.goto("/");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("demo-password");
  await page.getByRole("button", { name: "Sign in" }).last().click();
  await expect(page.getByText("How can I help?")).toBeVisible();
}

const SHOTS = process.env.E2E_SCREENSHOTS;

test.describe("document access control (demo organisation)", () => {
  test("an intern asking for the CEO's salary gets nothing; the file isn't even listed", async ({ page }) => {
    await signIn(page, "intern@demo.local");
    await expect(page.locator(".documents")).toContainText("employee-handbook.md");
    await expect(page.locator(".documents")).toContainText("engineering-roadmap.md");
    await expect(page.locator(".documents")).not.toContainText("executive-compensation.md");
    await expect(page.locator(".documents")).not.toContainText("board-strategy.md");
    await expect(page.locator(".account")).toContainText("Internal clearance");

    const answer = await ask(page, "What is the CEO salary?");
    await expect(answer).not.toContainText("480,000");
    await expect(answer.getByText("executive-compensation.md")).toHaveCount(0);
    await expect(answer.locator(".sources li")).toHaveCount(0);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/access-intern.png` });
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
