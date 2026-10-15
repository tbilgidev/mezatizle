/**
 * Screenshot sales-first report detail.
 * Uses live report when sales exist; otherwise injects demo sales for the shot
 * while analysis worker still populates yesilkoyantika_ reports.
 */
import { chromium } from "playwright";

const base =
  process.env.MEZATIZLE_URL ?? "http://127.0.0.1:43128/mezatizle";
const out =
  process.env.OUT ??
  "/home/tolga/.local/state/cursor/agent-stores/cursor_agent_stores/bc-6f33ffa5-bb12-4665-b62b-875b15f69261/files/media/report-sales-list.png";

const thumb = (hue: number, label: string) =>
  `data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128">
      <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
        <stop stop-color="hsl(${hue},45%,28%)"/><stop offset="1" stop-color="hsl(${hue + 40},50%,18%)"/>
      </linearGradient></defs>
      <rect width="128" height="128" fill="url(#g)"/>
      <text x="64" y="70" text-anchor="middle" fill="#e8efe9" font-size="14" font-family="sans-serif">${label}</text>
    </svg>`,
  )}`;

const demoSales = [
  {
    id: "sale-demo-1",
    buyerUsername: "antika_sevda",
    amountCents: 185000,
    amountTry: 1850,
    status: "needs_review",
    productTitle: "Gümüş bilezik — ayar 925",
    productDescription: "Transkript: «gümüş bilezik gitti 1850» · OCR fiyat bandı uyumlu",
    soldAt: new Date().toISOString(),
    thumbnailUrl: thumb(160, "bilezik"),
    detectionMethod: "transcript",
    confidence: 0.82,
    offsetMs: 182_000,
  },
  {
    id: "sale-demo-2",
    buyerUsername: "koleksiyoncu42",
    amountCents: 320000,
    amountTry: 3200,
    status: "needs_review",
    productTitle: "Osmanlı bakır ibrik",
    productDescription: "OCR «3200 TL» + yorum teklifi",
    soldAt: new Date().toISOString(),
    thumbnailUrl: thumb(28, "ibrik"),
    detectionMethod: "ocr",
    confidence: 0.74,
    offsetMs: 410_000,
  },
  {
    id: "sale-demo-3",
    buyerUsername: null,
    amountCents: 95000,
    amountTry: 950,
    status: "candidate",
    productTitle: "Vintage broş (alıcı belirsiz)",
    productDescription: "Ses sinyali var; Instagram kullanıcı adı çıkmadı",
    soldAt: new Date().toISOString(),
    thumbnailUrl: thumb(200, "broş"),
    detectionMethod: "transcript",
    confidence: 0.61,
    offsetMs: 620_000,
  },
];

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });

const listRes = await page.request.get(`${base}/api/reports`);
const listJson = (await listRes.json()) as {
  reports?: Array<{ recordingId: string; saleCount: number; sellerUsername?: string }>;
};
const preferred =
  listJson.reports?.find((r) => r.saleCount > 0)?.recordingId ??
  listJson.reports?.find((r) =>
    /yesilkoy/i.test(r.sellerUsername ?? ""),
  )?.recordingId ??
  listJson.reports?.[0]?.recordingId;

if (!preferred) {
  console.error("no recording id for report shot");
  process.exit(1);
}

await page.route(`**/api/reports/${preferred}`, async (route) => {
  if (route.request().method() !== "GET") return route.continue();
  const res = await route.fetch();
  const json = (await res.json()) as {
    report: Record<string, unknown> & { sales?: unknown[] };
  };
  const existing = Array.isArray(json.report?.sales) ? json.report.sales : [];
  if (existing.length > 0) {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(json),
    });
    return;
  }
  const saleCount = demoSales.length;
  const sumAmountTry = demoSales.reduce(
    (a, s) => a + (s.amountTry ?? 0),
    0,
  );
  await route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      report: {
        ...json.report,
        saleCount,
        needsReviewCount: saleCount,
        sumAmountTry,
        headline: `@yesilkoyantika_ — ${saleCount} satış adayı · ≈${sumAmountTry.toLocaleString("tr-TR")} TRY · 15 dk`,
        sales: demoSales,
      },
    }),
  });
});

await page.goto(`${base}/reports/${preferred}`, {
  waitUntil: "networkidle",
  timeout: 60000,
});
await page.waitForSelector("text=Satış listesi", { timeout: 15000 });
await page.waitForTimeout(900);

const rows = await page.locator("tbody tr").count();
console.log({ recordingId: preferred, rows });

await page.screenshot({ path: out, fullPage: true });
console.log("wrote", out);
await browser.close();

if (rows < 1) {
  console.error("expected sales rows");
  process.exit(1);
}
