/**
 * Screenshot report KPI header + list cards.
 * Uses live KPI fields when present; otherwise injects the four funnel KPIs
 * so the shot shows Turkish labels while analysis worker finishes reanalyze.
 */
import { chromium } from "playwright";

const base =
  process.env.MEZATIZLE_URL ?? "http://127.0.0.1:43128/mezatizle";
const out =
  process.env.OUT ??
  "/home/tolga/.local/state/cursor/agent-stores/cursor_agent_stores/bc-6f33ffa5-bb12-4665-b62b-875b15f69261/files/media/report-kpis.png";

const KPI_PATCH = {
  productsOffered: 28,
  totalAskTry: 96000,
  productsSold: 14,
  totalSoldTry: 47005,
  saleCount: 14,
  sumAmountTry: 47005,
  headline: "@yesilkoyantika_ — 14 satılan · ≈47.005 TRY · 15 dk",
};

function hasWorkerKpis(row: Record<string, unknown>): boolean {
  return (
    row.productsOffered != null ||
    row.products_offered != null ||
    row.totalAskTry != null ||
    row.total_ask_try != null
  );
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });

const listRes = await page.request.get(`${base}/api/reports`);
const listJson = (await listRes.json()) as {
  reports?: Array<Record<string, unknown> & { recordingId: string }>;
};
const preferred =
  listJson.reports?.find((r) =>
    /yesilkoy/i.test(String(r.sellerUsername ?? r.headline ?? "")),
  ) ?? listJson.reports?.[0];

if (!preferred?.recordingId) {
  console.error("no report id");
  process.exit(1);
}
const id = preferred.recordingId;
const liveHasKpis = hasWorkerKpis(preferred);
console.log({ id: id.slice(0, 8), liveHasKpis });

await page.route("**/api/reports**", async (route) => {
  if (route.request().method() !== "GET") return route.continue();
  const res = await route.fetch();
  const json = (await res.json()) as Record<string, unknown>;
  const url = route.request().url();

  if (url.includes(`/api/reports/${id}`) && !url.includes("export")) {
    const report = {
      ...((json.report as Record<string, unknown>) ?? {}),
      ...(liveHasKpis ? {} : KPI_PATCH),
    };
    // Prefer live worker fields when present
    if (liveHasKpis) {
      Object.assign(report, preferred);
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ report }),
    });
    return;
  }

  // List endpoint
  if (url.match(/\/api\/reports\/?(\?|$)/)) {
    const reports = Array.isArray(json.reports)
      ? (json.reports as Array<Record<string, unknown>>).map((r) =>
          String(r.recordingId) === id && !liveHasKpis
            ? { ...r, ...KPI_PATCH }
            : r,
        )
      : [];
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ...json, reports }),
    });
    return;
  }

  await route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(json),
  });
});

await page.goto(`${base}/reports/${id}`, {
  waitUntil: "networkidle",
  timeout: 60000,
});
await page.waitForSelector("text=Sunulan ürün", { timeout: 15000 });
await page.waitForTimeout(800);

const labels = await page.locator("[data-report-kpis] span, [data-report-kpis]").evaluateAll(() => {
  // collect visible KPI labels in header
  return Array.from(
    document.querySelectorAll("[data-report-kpis] .text-xs, [data-report-kpis] span"),
  )
    .map((el) => el.textContent?.trim() ?? "")
    .filter(Boolean);
});
const headerText = await page.locator("[data-report-kpis]").first().innerText();
console.log({ headerText: headerText.slice(0, 200), labels: labels.slice(0, 12) });

await page.screenshot({ path: out, fullPage: true });
console.log("wrote", out);
await browser.close();

const norm = headerText.toLocaleLowerCase("tr-TR");
if (!norm.includes("sunulan ürün") || !norm.includes("toplam satış")) {
  console.error("KPI labels missing in header", headerText);
  process.exit(1);
}
