/** Screenshot Kayıtlar with analysis % visible for failed/running/done. */
import { chromium } from "playwright";

const base =
  process.env.MEZATIZLE_URL ?? "http://127.0.0.1:43128/mezatizle";
const out =
  process.env.OUT ??
  "/home/tolga/.local/state/cursor/agent-stores/cursor_agent_stores/bc-6f33ffa5-bb12-4665-b62b-875b15f69261/files/media/recordings-progress-visible.png";

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
const errs: string[] = [];
page.on("pageerror", (e) => errs.push(e.message));

await page.goto(`${base}/recordings`, {
  waitUntil: "networkidle",
  timeout: 60000,
});
await page.waitForSelector("[data-analysis-progress]", { timeout: 15000 });
await page.waitForTimeout(800);

const chips = await page.locator("[data-analysis-progress]").evaluateAll((els) =>
  els.map((el) => ({
    text: el.textContent?.trim(),
    state: el.getAttribute("data-analysis-state"),
    pct: el.getAttribute("data-analysis-progress"),
    className: el.className,
  })),
);
console.log({ chips, errs });

await page.screenshot({ path: out, fullPage: true });
console.log("wrote", out);

// Smoke report detail does not pageerror
const id = (
  await page.request.get(`${base}/api/recordings`).then((r) => r.json())
) as { recordings?: Array<{ id: string }> };
const rid = id.recordings?.[0]?.id;
if (rid) {
  await page.goto(`${base}/reports/${rid}`, {
    waitUntil: "networkidle",
    timeout: 60000,
  });
  await page.waitForTimeout(1000);
  const failedBanner = await page.locator("[data-analysis-failed]").count();
  console.log({ reportId: rid.slice(0, 8), failedBanner, errs });
}

await browser.close();

if (!chips.length) {
  console.error("no progress chips");
  process.exit(1);
}
if (errs.length) {
  console.error("page errors", errs);
  process.exit(1);
}
