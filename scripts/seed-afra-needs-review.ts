/**
 * After reconcile, ensure forensic residual needs_review rows exist for afra.
 * Idempotent: skips when a sale already sits near the same offset.
 *
 * Usage: bun run ./scripts/seed-afra-needs-review.ts [recording-id]
 */
import { createSql } from "@mezatizle/db";

const RECORDING_ID =
  process.argv[2] ?? "69765459-23ff-4e0c-a8ce-aaa992b2c281";

const databaseUrl =
  process.env.DATABASE_URL ??
  "postgres://mezatizle:mezatizle@127.0.0.1:5433/mezatizle";
const storageRoot = process.env.STORAGE_ROOT ?? "./storage";

type Residual = {
  offsetMs: number;
  spokenBuyerName?: string;
  buyerUsername?: string;
  amountTry?: number;
  evidenceQuote: string;
  productHint: string;
  reason: string;
};

/** From afra missed-sales forensic pass (I / J / K / L). */
const RESIDUALS: Residual[] = [
  {
    offsetMs: 7_399_000,
    buyerUsername: "elgizhenden",
    amountTry: 1000,
    evidenceQuote:
      "kısa aldım buyuk boncuklu — satıcı «Kısa mı aldınız…?» (soru, onay yok)",
    productHint: "Kısa / büyük boncuklu (Elgiz — belirsiz)",
    reason: "forensic_elgiz_question_not_confirm",
  },
  {
    offsetMs: 2_509_000,
    spokenBuyerName: "İris",
    evidenceQuote: "İris de sizin hayırlı olsun — kullanıcı adı eşleşmedi",
    productHint: "İris sözlü onay (handle yok)",
    reason: "forensic_iris_named_verbal_unmatched",
  },
  {
    offsetMs: 2_784_000,
    spokenBuyerName: "Sevda",
    evidenceQuote: "Hayırlı olsun sevda hanımcığım — yorumcu eşleşmedi",
    productHint: "Sevda sözlü onay (handle yok)",
    reason: "forensic_sevda_named_verbal_unmatched",
  },
  {
    offsetMs: 11_277_000,
    buyerUsername: "halecaloglu1",
    evidenceQuote:
      "Monet lale küpe / kahve cam broş aldım — ASR sonrası (ask penceresi yok)",
    productHint: "Geç Hale aldım (ASR cutoff sonrası)",
    reason: "forensic_late_hale_post_asr",
  },
];

const sql = createSql(databaseUrl);

const [rec] = await sql<{ seller_id: string; recorded_at: Date | string }[]>`
  SELECT seller_id, recorded_at FROM recordings WHERE id = ${RECORDING_ID}
`;
if (!rec) {
  console.error("missing recording", RECORDING_ID);
  process.exit(1);
}
const sellerId = rec.seller_id;
const recordedAt = new Date(rec.recorded_at);

const existing = await sql<
  {
    id: string;
    status: string;
    buyer_username: string | null;
    attrs: Record<string, unknown> | null;
  }[]
>`
  SELECT sa.id, sa.status, sa.buyer_username, p.attributes AS attrs
  FROM sales sa
  LEFT JOIN products p ON p.id = sa.product_id
  WHERE sa.recording_id = ${RECORDING_ID}
`;

function nearOffset(attrs: Record<string, unknown> | null, targetMs: number) {
  if (!attrs || attrs.offsetMs == null) return false;
  const ms = Number(attrs.offsetMs);
  return Number.isFinite(ms) && Math.abs(ms - targetMs) <= 90_000;
}

let inserted = 0;
let skipped = 0;

for (const r of RESIDUALS) {
  const already = existing.some((s) => {
    const attrs =
      s.attrs && typeof s.attrs === "object" ? s.attrs : null;
    if (!nearOffset(attrs, r.offsetMs)) return false;
    if (r.buyerUsername && s.buyer_username === r.buyerUsername) return true;
    const spoken =
      attrs && typeof attrs.spokenBuyerName === "string"
        ? attrs.spokenBuyerName
        : "";
    if (r.spokenBuyerName && spoken === r.spokenBuyerName) return true;
    // Offset alone is enough when status already needs_review / confirmed
    return s.status === "needs_review" || s.status === "confirmed";
  });
  if (already) {
    skipped++;
    console.log("skip near", r.offsetMs, r.spokenBuyerName ?? r.buyerUsername);
    continue;
  }

  const amountCents =
    r.amountTry != null ? Math.round(r.amountTry * 100) : null;
  const soldAt = Number.isFinite(recordedAt.getTime())
    ? new Date(recordedAt.getTime() + r.offsetMs)
    : new Date();

  const product = await sql<{ id: string }[]>`
    INSERT INTO products (seller_id, title, description, attributes)
    VALUES (
      ${sellerId},
      ${r.productHint},
      ${r.evidenceQuote},
      ${sql.json({
        confidence: 0.45,
        amountKnown: amountCents != null,
        buyerKnown: Boolean(r.buyerUsername),
        spokenBuyerName: r.spokenBuyerName ?? null,
        saleMethod: "verbal_win_confirm",
        offsetMs: r.offsetMs,
        gaps: ["needs_review", "forensic_seed"],
        needsReview: true,
        evidenceQuote: r.evidenceQuote,
        seedReason: r.reason,
      })}
    )
    RETURNING id
  `;

  const sale = await sql<{ id: string }[]>`
    INSERT INTO sales (
      recording_id, product_id, seller_id, buyer_username,
      amount_cents, currency, sold_at, status
    ) VALUES (
      ${RECORDING_ID},
      ${product[0]!.id},
      ${sellerId},
      ${r.buyerUsername ?? null},
      ${amountCents},
      'TRY',
      ${soldAt.toISOString()},
      'needs_review'
    )
    RETURNING id
  `;

  await sql`
    INSERT INTO sale_evidence (sale_id, evidence_type, ref_table, ref_id, note, payload)
    VALUES (
      ${sale[0]!.id},
      'manual_seed',
      'recordings',
      ${RECORDING_ID},
      ${"Forensic residual — operatör incelemesi"},
      ${sql.json({
        explanationTr: `Kanıt: «${r.evidenceQuote}». Operatör onayı bekleniyor.`,
        evidenceQuote: r.evidenceQuote,
        offsetMs: r.offsetMs,
        reason: r.reason,
        spokenBuyerName: r.spokenBuyerName ?? null,
        buyer: r.buyerUsername ?? null,
        needsReview: true,
        storageRoot,
      })}
    )
  `;
  inserted++;
  console.log(
    "seeded",
    r.offsetMs,
    r.spokenBuyerName ?? r.buyerUsername,
    sale[0]!.id,
  );
}

const [counts] = await sql<
  { confirmed: string; needs_review: string; rejected: string }[]
>`
  SELECT
    COUNT(*) FILTER (WHERE status = 'confirmed')::text AS confirmed,
    COUNT(*) FILTER (WHERE status = 'needs_review')::text AS needs_review,
    COUNT(*) FILTER (WHERE status = 'rejected')::text AS rejected
  FROM sales WHERE recording_id = ${RECORDING_ID}
`;

console.log({ inserted, skipped, counts });
await sql.end?.();
process.exit(0);
