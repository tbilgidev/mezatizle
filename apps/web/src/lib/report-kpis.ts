import { formatTry } from "@/lib/utils";

/**
 * Report funnel KPIs from analysis worker.
 * Field names may vary — pick first present numeric value.
 */
export type ReportKpis = {
  /** Sunulan ürün */
  productsOffered: number | null;
  /** Sunulan tutar (TRY) */
  totalAskTry: number | null;
  /** Satılan */
  productsSold: number | null;
  /** Toplam satış (TRY) */
  totalSoldTry: number | null;
};

function num(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function firstNum(row: Record<string, unknown>, keys: string[]): number | null {
  for (const k of keys) {
    if (k in row) {
      const n = num(row[k]);
      if (n != null) return n;
    }
  }
  return null;
}

/** cents → TRY if value looks like integer kuruş and no TRY field won. */
function maybeCentsToTry(v: number | null): number | null {
  if (v == null) return null;
  // Heuristic unused — callers pass TRY when possible
  return v;
}

/**
 * Read KPIs from a report list/detail row.
 * Prefers explicit worker fields; falls back to saleCount / sumAmountTry for sold side.
 */
export function extractReportKpis(row: Record<string, unknown>): ReportKpis {
  const productsOffered = firstNum(row, [
    "productsOffered",
    "products_offered",
    "offeredProductCount",
    "offered_product_count",
    "productsOfferedCount",
    "offeredCount",
    "offered_count",
    "askProductCount",
    "ask_product_count",
  ]);

  let totalAskTry = firstNum(row, [
    "totalAskTry",
    "total_ask_try",
    "offeredAmountTry",
    "offered_amount_try",
    "totalOfferedTry",
    "total_offered_try",
    "askSumTry",
    "ask_sum_try",
    "sumAskTry",
    "sum_ask_try",
  ]);
  if (totalAskTry == null) {
    const cents = firstNum(row, [
      "totalAskCents",
      "total_ask_cents",
      "offeredAmountCents",
      "offered_amount_cents",
    ]);
    if (cents != null) totalAskTry = cents / 100;
  }

  const productsSold =
    firstNum(row, [
      "productsSold",
      "products_sold",
      "soldProductCount",
      "sold_product_count",
      "soldCount",
      "sold_count",
    ]) ?? firstNum(row, ["saleCount", "sale_count"]);

  let totalSoldTry =
    firstNum(row, [
      "totalSoldTry",
      "total_sold_try",
      "soldAmountTry",
      "sold_amount_try",
      "sumSoldTry",
      "sum_sold_try",
    ]) ?? firstNum(row, ["sumAmountTry", "sum_amount_try"]);
  if (totalSoldTry == null) {
    const cents = firstNum(row, [
      "totalSoldCents",
      "total_sold_cents",
      "sumAmountCents",
      "sum_amount_cents",
    ]);
    if (cents != null) totalSoldTry = cents / 100;
  }

  return {
    productsOffered,
    totalAskTry: maybeCentsToTry(totalAskTry),
    productsSold,
    totalSoldTry: maybeCentsToTry(totalSoldTry),
  };
}

export function hasAnyKpi(k: ReportKpis): boolean {
  return (
    k.productsOffered != null ||
    k.totalAskTry != null ||
    k.productsSold != null ||
    k.totalSoldTry != null
  );
}

export type KpiChip = { key: string; label: string; value: string };

/** Ordered chips for header / list cards (Turkish). */
export function reportKpiChips(k: ReportKpis): KpiChip[] {
  const chips: KpiChip[] = [];
  if (k.productsOffered != null) {
    chips.push({
      key: "offered",
      label: "Sunulan ürün",
      value: String(Math.round(k.productsOffered)),
    });
  }
  if (k.totalAskTry != null) {
    chips.push({
      key: "ask",
      label: "Sunulan tutar",
      value: formatTry(k.totalAskTry),
    });
  }
  if (k.productsSold != null) {
    chips.push({
      key: "sold",
      label: "Satılan",
      value: String(Math.round(k.productsSold)),
    });
  }
  if (k.totalSoldTry != null) {
    chips.push({
      key: "totalSold",
      label: "Toplam satış",
      value: formatTry(k.totalSoldTry),
    });
  }
  return chips;
}
