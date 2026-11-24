import { expect, test } from "@playwright/test";
import { DOCS, ask, signUp } from "./helpers";

test.describe("LocalMind", () => {
  test("upload documents, get a cited answer, use tools and restore history", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await signUp(page);

    await page.getByTestId("file-input").setInputFiles([`${DOCS}/employee-handbook.md`, `${DOCS}/product-faq.txt`]);
    // Org-wide documents from the demo seed may also be listed, so wait for indexing to finish instead of counting.
    await expect(page.locator(".badge-pending, .badge-processing")).toHaveCount(0, { timeout: 30_000 });
    await expect(page.locator(".doc").filter({ hasNotText: "from " }).locator(".badge-ready")).toHaveCount(2);

    const answer = await ask(page, "How many days of paid annual leave do full-time employees get?");
    await expect(answer).toContainText("21 days of paid annual leave");
    await expect(answer.locator(".tool")).toContainText("Searched documents");
    await expect(answer.locator(".sources li")).toHaveCount(1);
    await expect(answer.locator(".sources li")).toContainText("employee-handbook.md");
    await answer.locator(".cite").first().click();
    await expect(answer.locator(".sources li.highlight")).toHaveCount(1);

    const calc = await ask(page, "What is 1250 multiplied by 12?");
    await expect(calc).toContainText("15000");
    await expect(calc.locator(".tool")).toContainText("Calculated");

    await expect(page.locator(".conv-title")).toHaveCount(1);
    await page.reload();
    await page.locator(".conv").first().click();
    await expect(page.locator(".msg")).toHaveCount(4);
    expect(errors).toEqual([]);
  });

  test("shows backend failures and keeps the UI usable", async ({ page }) => {
    await signUp(page);
    await page.getByLabel("Message").fill("[fail-llm] please crash");
    await page.keyboard.press("Enter");
    await expect(page.locator(".error.banner")).toContainText("AI backend is unavailable");
    const ok = await ask(page, "hello");
    await expect(ok).toContainText("LocalMind");
  });

  test("switching conversations mid-stream does not leak the answer into another chat", async ({ page }) => {
    await signUp(page);
    await ask(page, "hello there");
    await page.getByRole("button", { name: "+ New chat" }).click();
    await page.getByLabel("Message").fill("hello again, please write a long greeting");
    await page.keyboard.press("Enter");
    await expect(page.locator(".msg-draft")).toBeVisible();
    // Jump back to the first conversation while the second is still streaming.
    await page.locator(".conv").last().click();
    await expect(page.locator(".msg")).toHaveCount(2);
    await page.waitForTimeout(1500);
    await expect(page.locator(".msg")).toHaveCount(2);
  });

  test("rejects unsupported files with a clear message", async ({ page }) => {
    await signUp(page);
    await page.getByTestId("file-input").setInputFiles({ name: "evil.exe", mimeType: "application/octet-stream", buffer: Buffer.from("MZ") });
    await expect(page.locator(".documents .error")).toContainText("Unsupported file type");
  });
});
