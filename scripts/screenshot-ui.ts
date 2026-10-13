/** Capture Funnel UI pages into store media paths.
 * Run: NODE_PATH=apps/api/node_modules bun run scripts/screenshot-ui.ts
 */
import { chromium } from "playwright";

const base =
  process.env.MEZATIZLE_URL ??
  "https://tolga-mini.tailf479ba.ts.net/mezatizle";
const outDir =
  process.env.SHOT_DIR ??
  "/home/tolga/.local/state/cursor/agent-stores/cursor_agent_stores/bc-6f33ffa5-bb12-4665-b62b-875b15f69261/files/media";

async function shot(page: import("playwright").Page, path: string, file: string) {
  await page.goto(`${base}${path}`, { waitUntil: "networkidle", timeout: 60000 });
  await page.waitForTimeout(800);
  const dest = `${outDir}/${file}`;
  await page.screenshot({ path: dest, fullPage: true });
  console.log("wrote", dest);
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
try {
  await shot(page, "/settings#ig-oturum", "ig-settings-live.png");
  await shot(page, "/recordings", "recordings-nonmock.png");
  await shot(page, "/sales", "sales-nonmock.png");
} finally {
  await browser.close();
}
