import { chromium } from "playwright";

const base =
  process.env.MEZATIZLE_URL ?? "http://127.0.0.1:43128/mezatizle";
const outDir =
  process.env.SHOT_DIR ??
  "/home/tolga/.local/state/cursor/agent-stores/cursor_agent_stores/bc-6f33ffa5-bb12-4665-b62b-875b15f69261/files/media";

let sale = process.env.SALE_ID ?? "";
if (!sale) {
  const j = (await fetch("http://127.0.0.1:43127/api/sales").then((r) =>
    r.json(),
  )) as { sales: Array<{ id: string; status: string }> };
  sale =
    j.sales.find((s) => s.status === "needs_review")?.id ?? j.sales[0]?.id ?? "";
}
if (!sale) throw new Error("no sale id");

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
try {
  await page.goto(`${base}/evidence/${sale}`, {
    waitUntil: "networkidle",
    timeout: 60000,
  });
  await page.waitForTimeout(1000);
  await page.getByRole("button", { name: /Görüntüyü incele/i }).click();
  await page.waitForSelector("[data-testid=evidence-player]", {
    timeout: 15000,
  });
  // Wait for media metadata / seek
  await page.waitForFunction(
    () => {
      const v = document.querySelector(
        "[data-testid=evidence-player] video",
      ) as HTMLVideoElement | null;
      return v != null && v.readyState >= 1;
    },
    { timeout: 20000 },
  );
  await page.waitForTimeout(800);
  const videoSrc = await page
    .locator("[data-testid=evidence-player] video")
    .getAttribute("src");
  const current = await page
    .locator("[data-testid=evidence-player] video")
    .evaluate((v: HTMLVideoElement) => ({
      currentTime: v.currentTime,
      readyState: v.readyState,
      networkState: v.networkState,
      error: v.error?.code ?? null,
    }));
  await page.screenshot({
    path: `${outDir}/evidence-player.png`,
    fullPage: true,
  });
  console.log(JSON.stringify({ sale, videoSrc, current }, null, 2));
} finally {
  await browser.close();
}
