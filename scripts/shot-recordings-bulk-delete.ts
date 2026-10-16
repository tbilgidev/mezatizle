/** Screenshot Kayıtlar with checkbox select + bulk delete bar. */
import { chromium } from "playwright";

const base =
  process.env.MEZATIZLE_URL ?? "http://127.0.0.1:43128/mezatizle";
const out =
  process.env.OUT ??
  "/home/tolga/.local/state/cursor/agent-stores/cursor_agent_stores/bc-6f33ffa5-bb12-4665-b62b-875b15f69261/files/media/recordings-bulk-delete.png";

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
const errs: string[] = [];
page.on("pageerror", (e) => errs.push(e.message));

await page.goto(`${base}/recordings`, {
  waitUntil: "networkidle",
  timeout: 60000,
});
await page.waitForSelector('table input[type="checkbox"]', { timeout: 15000 });

// Select all via header checkbox
const headerCb = page.locator('thead input[type="checkbox"]').first();
await headerCb.check();
await page.waitForSelector('button:has-text("Seçilenleri sil")', {
  timeout: 5000,
});
await page.waitForTimeout(400);

const selectedLabel = await page
  .locator('[aria-label="Toplu işlemler"]')
  .textContent();
const rowCount = await page.locator("tbody tr").count();
const silButtons = await page.locator('button:has-text("Sil")').count();
console.log({ selectedLabel: selectedLabel?.trim(), rowCount, silButtons, errs });

await page.screenshot({ path: out, fullPage: true });
console.log("wrote", out);

await browser.close();

if (!selectedLabel?.includes("Seçilenleri sil") && !selectedLabel?.includes("kayıt")) {
  console.error("bulk bar missing");
  process.exit(1);
}
if (errs.length) {
  console.error("page errors", errs);
  process.exit(1);
}
