import { expect, test } from "@playwright/test";
import { ask, signUp } from "./helpers";

test.describe("security in the browser", () => {
  test("stored XSS via filenames, document text and model output doesn't execute", async ({ page }) => {
    const dialogs: string[] = [];
    page.on("dialog", (d) => {
      dialogs.push(d.message());
      void d.dismiss();
    });
    await signUp(page);
    const payload =
      'Payload line zebra: <script>alert("s")</script> <img src=x onerror=alert("i")> [click me](javascript:alert("l")) ' +
      '![tracker](https://evil.example/pixel.png) https://evil.example/visible-link';
    await page.getByTestId("file-input").setInputFiles({
      name: '<img src=x onerror=alert("f")>.txt',
      mimeType: "text/plain",
      buffer: Buffer.from(payload),
    });
    await expect(page.locator(".badge-pending, .badge-processing")).toHaveCount(0, { timeout: 30_000 });
    await expect(page.locator(".documents")).toContainText('<img src=x onerror=alert("f")>.txt');

    const answer = await ask(page, "What is on the payload line zebra?");
    await expect(answer).toContainText("<script>", { timeout: 15_000 });
    // Rendered as text: no injected elements, no javascript: links, no auto-loading images.
    await expect(page.locator(".messages img, .documents img, .messages script")).toHaveCount(0);
    await expect(page.locator('a[href^="javascript:"]')).toHaveCount(0);
    // URLs in answers are inert text: visible and copyable, but not clickable (no one-click exfiltration).
    await expect(answer.locator("a")).toHaveCount(0);
    await expect(answer.locator(".inert-url").first()).toContainText("https://evil.example/");
    await page.waitForTimeout(300);
    expect(dialogs).toEqual([]);
  });

  test("suggests a higher classification for a sensitive upload", async ({ page }) => {
    await signUp(page);
    await page.getByTestId("file-input").setInputFiles({
      name: "pay-review.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("2027 pay review. Jordan's salary increases to $88,000 from April."),
    });
    const banner = page.getByTestId("doc-pay-review.txt").getByTestId("classification-suggestion");
    await expect(banner).toContainText("This looks Confidential", { timeout: 30_000 });
    await expect(banner).toContainText("salary");
    if (process.env.E2E_SCREENSHOTS) await page.screenshot({ path: `${process.env.E2E_SCREENSHOTS}/suggestion.png` });
    await banner.getByRole("button", { name: "Mark Confidential" }).click();
    await expect(page.getByTestId("doc-pay-review.txt")).toContainText("Confidential");
    await expect(banner).toHaveCount(0);
  });
});
