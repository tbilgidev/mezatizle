/** Capture Funnel UI v2 pages into store media paths.
 * Run: bun run scripts/screenshot-ui-v2.ts
 */
import { chromium } from "playwright";

const base =
  process.env.MEZATIZLE_URL ??
  "https://tolga-mini.tailf479ba.ts.net/mezatizle";
const outDir =
  process.env.SHOT_DIR ??
  "/home/tolga/.local/state/cursor/agent-stores/cursor_agent_stores/bc-6f33ffa5-bb12-4665-b62b-875b15f69261/files/media";

async function shot(
  page: import("playwright").Page,
  path: string,
  file: string,
) {
  await page.goto(`${base}${path}`, {
    waitUntil: "networkidle",
    timeout: 60000,
  });
  await page.waitForTimeout(1000);
  const dest = `${outDir}/${file}`;
  await page.screenshot({ path: dest, fullPage: true });
  console.log("wrote", dest);
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });

try {
  // discover a report id for detail shot
  const reportsRes = await page.request.get(`${base}/api/reports`);
  const reportsJson = (await reportsRes.json()) as {
    reports?: Array<{ recordingId: string }>;
  };
  const reportId = reportsJson.reports?.[0]?.recordingId;

  await shot(page, "/", "ui-v2-panel.png");
  await shot(page, "/recordings", "ui-v2-recordings.png");
  await shot(page, "/reports", "ui-v2-reports.png");
  if (reportId) {
    await shot(page, `/reports/${reportId}`, "ui-v2-report-detail.png");
  } else {
    console.warn("no report id — skipping detail shot");
  }
  await shot(page, "/evidence", "ui-v2-evidence.png");
  await shot(page, "/settings", "ui-v2-settings.png");
} finally {
  await browser.close();
}
