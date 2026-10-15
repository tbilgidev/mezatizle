/**
 * Screenshot sales-first report detail with real API sales (no mock).
 */
import { chromium } from "playwright";

const base =
  process.env.MEZATIZLE_URL ?? "http://127.0.0.1:43128/mezatizle";
const out =
  process.env.OUT ??
  "/home/tolga/.local/state/cursor/agent-stores/cursor_agent_stores/bc-6f33ffa5-bb12-4665-b62b-875b15f69261/files/media/report-sales-list.png";

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });

const listRes = await page.request.get(`${base}/api/reports`);
const listJson = (await listRes.json()) as {
  reports?: Array<{
    recordingId: string;
    saleCount: number;
    sellerUsername?: string;
    headline?: string;
  }>;
};
const preferred =
  listJson.reports?.find(
    (r) =>
      r.saleCount > 0 &&
      /yesilkoy/i.test(`${r.sellerUsername ?? ""} ${r.headline ?? ""}`),
  )?.recordingId ??
  listJson.reports?.find((r) => r.saleCount > 0)?.recordingId;

if (!preferred) {
  console.error("no yesilkoy report with sales");
  process.exit(1);
}

const detailRes = await page.request.get(`${base}/api/reports/${preferred}`);
const detailJson = (await detailRes.json()) as {
  report?: { sales?: unknown[]; saleCount?: number };
};
const apiSales = Array.isArray(detailJson.report?.sales)
  ? detailJson.report!.sales!.length
  : 0;
console.log({
  recordingId: preferred,
  apiSaleCount: detailJson.report?.saleCount,
  apiSalesLen: apiSales,
});

await page.goto(`${base}/reports/${preferred}`, {
  waitUntil: "networkidle",
  timeout: 60000,
});
await page.waitForSelector("text=Satış listesi", { timeout: 15000 });
await page.waitForSelector("tbody tr", { timeout: 15000 });
await page.waitForTimeout(1200);

const empty = await page.locator("text=Satış adayı yok").count();
const rows = await page.locator("tbody tr").count();
const thumbs = await page.locator("tbody img").count();
const firstProduct = await page
  .locator("tbody tr")
  .first()
  .locator("td")
  .nth(1)
  .innerText();
console.log({ empty, rows, thumbs, firstProduct: firstProduct.slice(0, 80) });

await page.screenshot({ path: out, fullPage: true });
console.log("wrote", out);
await browser.close();

if (empty > 0 || rows < 1) {
  console.error("UI still empty — sales binding failed");
  process.exit(1);
}
if (apiSales > 0 && rows !== apiSales) {
  console.warn(`row count ${rows} != api sales ${apiSales}`);
}
