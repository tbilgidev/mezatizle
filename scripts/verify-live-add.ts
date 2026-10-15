import { chromium } from "playwright";

const base =
  process.env.MEZATIZLE_URL ?? "http://127.0.0.1:43128/mezatizle";
const out =
  process.env.SHOT_DIR ??
  "/home/tolga/.local/state/cursor/agent-stores/cursor_agent_stores/bc-6f33ffa5-bb12-4665-b62b-875b15f69261/files/media";

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
const pageErrors: string[] = [];
page.on("pageerror", (e) => pageErrors.push(String(e.message ?? e)));

try {
  await page.goto(`${base}/recordings`, {
    waitUntil: "networkidle",
    timeout: 60000,
  });
  await page.fill('input[name="input"]', "@smoke_seller");
  await page.fill('input[name="maxDurationMinutes"]', "1");
  await page.getByRole("button", { name: /Canlı yayın ekle/i }).click();
  // Wait for success badge or error — must not throw currentTarget.reset
  await page.waitForTimeout(3000);
  const okText = await page
    .locator("body")
    .innerText()
    .then((t) => {
      const m = t.match(/Canlı oturum açıldı[^\n]*/);
      return m?.[0] ?? null;
    });
  const alertText = await page
    .locator('[role="alert"]')
    .first()
    .textContent()
    .catch(() => null);
  const inputVal = await page.inputValue('input[name="input"]');
  await page.screenshot({
    path: `${out}/live-add-form-fixed.png`,
    fullPage: true,
  });
  console.log(
    JSON.stringify(
      {
        pageErrors,
        okText,
        alertText,
        inputCleared: inputVal === "",
        hasCurrentTargetResetBug: pageErrors.some((e) =>
          /currentTarget|reset/i.test(e),
        ),
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
}
