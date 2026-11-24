import { expect, type Page } from "@playwright/test";
import { resolve } from "node:path";

export const DOCS = resolve(__dirname, "../../api/eval/documents");

export async function signUp(page: Page) {
  await page.goto("/");
  await page.getByRole("tab", { name: "Create account" }).click();
  await page.getByLabel("Email").fill(`e2e-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@example.com`);
  await page.getByLabel("Password").fill("password123");
  await page.getByRole("button", { name: "Create account" }).last().click();
  await expect(page.getByText("How can I help?")).toBeVisible();
}

export async function ask(page: Page, text: string) {
  const before = await page.locator(".msg-assistant:not(.msg-draft)").count();
  await page.getByLabel("Message").fill(text);
  await page.keyboard.press("Enter");
  await expect(page.locator(".msg-assistant:not(.msg-draft)")).toHaveCount(before + 1, { timeout: 30_000 });
  return page.locator(".msg-assistant:not(.msg-draft)").nth(before);
}
