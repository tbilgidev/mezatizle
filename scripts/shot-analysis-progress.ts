/** Capture Kayıtlar with analysis progress + green done Rapor links. */
import { chromium } from "playwright";

const base =
  process.env.MEZATIZLE_URL ?? "http://127.0.0.1:43128/mezatizle";
const out =
  process.env.OUT ??
  "/home/tolga/.local/state/cursor/agent-stores/cursor_agent_stores/bc-6f33ffa5-bb12-4665-b62b-875b15f69261/files/media/recordings-analysis-progress.png";

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });

// Inject one running analysis so amber progress is visible alongside real done (green) rows.
await page.route("**/api/recordings", async (route) => {
  if (route.request().method() !== "GET") return route.continue();
  const res = await route.fetch();
  const json = (await res.json()) as {
    recordings?: Array<Record<string, unknown>>;
  };
  const recordings = Array.isArray(json.recordings) ? [...json.recordings] : [];
  recordings.unshift({
    id: "demo-progress-0001",
    seller_username: "demo_antik",
    display_name: "Demo Antik (progress)",
    original_filename: "live-demo.mp4",
    status: "transcribing",
    analysisState: "running",
    analysisProgress: 42,
    analysisStage: "Ses çözülüyor",
    source_type: "upload",
    capture_bytes: 51_000_000,
    uploaded_at: new Date().toISOString(),
  });
  await route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ ...json, recordings }),
  });
});

await page.goto(`${base}/recordings`, {
  waitUntil: "networkidle",
  timeout: 60000,
});
await page.waitForSelector("text=Rapor", { timeout: 15000 });
await page.waitForTimeout(800);

const progressVisible = await page.locator("text=Analiz %42").count();
const greenDone = await page.locator('[data-tone="green"]').count();
const yellow = await page.locator('[data-tone="yellow"]').count();
console.log({ progressVisible, greenDone, yellow });

await page.screenshot({ path: out, fullPage: true });
console.log("wrote", out);
await browser.close();

if (progressVisible < 1) {
  console.error("progress label missing");
  process.exit(1);
}
if (greenDone < 1) {
  console.error("green Rapor (done) missing");
  process.exit(1);
}
