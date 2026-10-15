import { copyFile, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Sql } from "@mezatizle/db";
import {
  enrichSoldFromBids,
  explainSaleTr,
  isSaleWorthy,
  parseAuctionTexts,
  SALE_MIN_CONFIDENCE,
  type BidContext,
  type ParsedAuctionSignal,
} from "@mezatizle/shared";

async function attachProductImage(
  storageRoot: string,
  recordingId: string,
  productId: string,
  offsetMs: number | null = null,
) {
  const framesDir = join(storageRoot, "frames", recordingId);
  const outDir = join(storageRoot, "products");
  await mkdir(outDir, { recursive: true });
  try {
    const files = (await readdir(framesDir))
      .filter((f) => f.endsWith(".jpg"))
      .sort();
    if (!files[0]) return null;
    const fps = Number(process.env.OCR_FPS ?? process.env.FRAME_FPS ?? "1");
    let pick = files[0]!;
    if (offsetMs != null && Number.isFinite(offsetMs) && fps > 0) {
      const targetIdx = Math.max(1, Math.round((offsetMs / 1000) * fps) + 1);
      let best = files[0]!;
      let bestDist = Infinity;
      for (const f of files) {
        const m = f.match(/(\d+)/);
        if (!m) continue;
        const idx = Number(m[1]);
        const dist = Math.abs(idx - targetIdx);
        if (dist < bestDist) {
          bestDist = dist;
          best = f;
        }
      }
      pick = best;
    }
    const dest = join(outDir, `${productId}.jpg`);
    await copyFile(join(framesDir, pick), dest);
    return `products/${productId}.jpg`;
  } catch {
    return null;
  }
}

export async function segmentAuctionFromSignals(
  sql: Sql,
  recordingId: string,
) {
  // Idempotent re-runs: drop prior events for this recording
  await sql`DELETE FROM auction_events WHERE recording_id = ${recordingId}`;

  const segments = await sql<{
    id: string;
    start_ms: number;
    text: string;
  }[]>`
    SELECT id, start_ms, text FROM transcript_segments
    WHERE recording_id = ${recordingId}
    ORDER BY start_ms ASC
  `;
  const comments = await sql<{
    id: string;
    offset_ms: number | null;
    body: string;
    author_username: string | null;
  }[]>`
    SELECT id, offset_ms, body, author_username FROM observed_comments
    WHERE recording_id = ${recordingId}
    ORDER BY COALESCE(offset_ms, 0) ASC
  `;

  const bidCtx: BidContext[] = [];
  let created = 0;

  for (const seg of segments) {
    const signals = parseAuctionTexts(seg.text, { source: "transcript" });
    for (const signal of signals) {
      if (signal.eventType === "bid" && signal.buyerHint) {
        bidCtx.push({
          offsetMs: seg.start_ms,
          amountTry: signal.amountTry,
          buyerHint: signal.buyerHint,
          source: "transcript",
        });
      }
      await sql`
        INSERT INTO auction_events (recording_id, event_type, offset_ms, payload, confidence)
        VALUES (
          ${recordingId},
          ${signal.eventType},
          ${seg.start_ms},
          ${sql.json({
            source: "transcript",
            refId: seg.id,
            ...signal,
          })},
          ${signal.confidence}
        )
      `;
      created++;
    }
  }

  for (const c of comments) {
    const signals = parseAuctionTexts(c.body, { source: "comment" });
    for (let signal of signals) {
      const author =
        c.author_username && /^[A-Za-z0-9._]{1,30}$/.test(c.author_username)
          ? c.author_username.toLowerCase()
          : undefined;
      // Prefer explicit @ in body; else OCR author column for bids only
      if (author && !signal.buyerHint && signal.eventType === "bid") {
        signal = { ...signal, buyerHint: author };
      }
      if (signal.eventType === "bid" && signal.buyerHint) {
        bidCtx.push({
          offsetMs: c.offset_ms ?? 0,
          amountTry: signal.amountTry,
          buyerHint: signal.buyerHint,
          source: "comment",
        });
      }
      await sql`
        INSERT INTO auction_events (recording_id, event_type, offset_ms, payload, confidence)
        VALUES (
          ${recordingId},
          ${signal.eventType},
          ${c.offset_ms ?? 0},
          ${sql.json({
            source: "comment",
            refId: c.id,
            author: c.author_username,
            ...signal,
          })},
          ${signal.confidence}
        )
      `;
      created++;
    }
  }

  // Second pass: enrich sold events lacking @ from nearby bid @handles
  const soldRows = await sql<{
    id: string;
    offset_ms: number | null;
    payload: Record<string, unknown>;
    confidence: number | null;
  }[]>`
    SELECT id, offset_ms, payload, confidence FROM auction_events
    WHERE recording_id = ${recordingId} AND event_type = 'sold'
  `;
  let enriched = 0;
  for (const row of soldRows) {
    const base: ParsedAuctionSignal = {
      eventType: "sold",
      confidence: Number(row.confidence ?? 0),
      matched: String(row.payload.matched ?? ""),
      amountTry:
        row.payload.amountTry != null
          ? Number(row.payload.amountTry)
          : undefined,
      buyerHint:
        typeof row.payload.buyerHint === "string"
          ? row.payload.buyerHint
          : undefined,
      reason:
        typeof row.payload.reason === "string" ? row.payload.reason : undefined,
    };
    const next = enrichSoldFromBids(base, bidCtx, row.offset_ms ?? 0);
    if (next.buyerHint && next.buyerHint !== base.buyerHint) {
      await sql`
        UPDATE auction_events
        SET confidence = ${next.confidence},
            payload = payload || ${sql.json({
              buyerHint: next.buyerHint,
              confidence: next.confidence,
              reason: next.reason,
              enrichedFromBid: true,
            })}::jsonb
        WHERE id = ${row.id}
      `;
      enriched++;
    }
  }

  return { eventsCreated: created, soldEnrichedFromBids: enriched };
}

function saleMethodFromReason(reason: unknown, source: unknown): string {
  const r = typeof reason === "string" ? reason : "";
  if (r.includes("seller_aldim")) return "seller_aldim";
  if (r.includes("bid_lookback") || r.includes("+bid_lookback")) {
    return "sold_phrase_bid_enriched";
  }
  if (source === "comment") return "comment_sold";
  if (r.includes("sold")) return "sold_phrase";
  return source === "transcript" ? "transcript_sold" : "unknown";
}

export async function reconcileSales(
  sql: Sql,
  recordingId: string,
  storageRoot = process.env.STORAGE_ROOT ?? "./storage",
) {
  const rec = await sql<{ seller_id: string; recorded_at: Date | string }[]>`
    SELECT seller_id, recorded_at FROM recordings WHERE id = ${recordingId}
  `;
  if (!rec[0]) throw new Error("recording not found");
  const sellerId = rec[0].seller_id;
  const recordedAt = new Date(rec[0].recorded_at);

  const minConf = Number(
    process.env.SALE_MIN_CONFIDENCE ?? SALE_MIN_CONFIDENCE,
  );
  const gate = Number.isFinite(minConf) ? minConf : SALE_MIN_CONFIDENCE;

  // Idempotent: remove prior auto sales/evidence/products for this recording
  const oldSales = await sql<{ id: string; product_id: string | null }[]>`
    SELECT id, product_id FROM sales WHERE recording_id = ${recordingId}
  `;
  if (oldSales.length) {
    const saleIds = oldSales.map((s) => s.id);
    await sql`DELETE FROM sale_evidence WHERE sale_id = ANY(${saleIds}::uuid[])`;
    await sql`DELETE FROM sales WHERE recording_id = ${recordingId}`;
    const productIds = oldSales
      .map((s) => s.product_id)
      .filter((id): id is string => Boolean(id));
    if (productIds.length) {
      await sql`DELETE FROM products WHERE id = ANY(${productIds}::uuid[])`;
    }
  }

  const sold = await sql<{
    id: string;
    offset_ms: number | null;
    payload: Record<string, unknown>;
    confidence: number | null;
  }[]>`
    SELECT id, offset_ms, payload, confidence FROM auction_events
    WHERE recording_id = ${recordingId} AND event_type = 'sold'
    ORDER BY COALESCE(offset_ms, 0) ASC
  `;

  let salesCreated = 0;
  let skippedLowConfidence = 0;
  let skippedDuplicate = 0;
  const seenKeys = new Set<string>();
  for (const ev of sold) {
    const conf = Number(ev.confidence ?? ev.payload.confidence ?? 0);
    const pseudo = {
      eventType: "sold" as const,
      confidence: conf,
    };
    if (!isSaleWorthy(pseudo)) {
      skippedLowConfidence++;
      continue;
    }

    const rawAmount = Number(ev.payload.amountTry);
    const amountCents =
      Number.isFinite(rawAmount) && rawAmount >= 10
        ? Math.round(rawAmount * 100)
        : null;

    const buyerRaw =
      typeof ev.payload.buyerHint === "string"
        ? ev.payload.buyerHint.trim().replace(/^@/, "").toLowerCase()
        : "";
    const buyer =
      buyerRaw && /^[a-z0-9._]{1,30}$/.test(buyerRaw) ? buyerRaw : null;

    const spokenRaw =
      typeof ev.payload.spokenBuyerName === "string"
        ? ev.payload.spokenBuyerName.trim()
        : "";
    const spokenBuyerName =
      spokenRaw &&
      spokenRaw.length >= 2 &&
      (!buyer || spokenRaw.toLowerCase() !== buyer)
        ? spokenRaw.slice(0, 40)
        : null;

    // Dedupe: same amount within ~8s window (transcript repeats)
    const offsetMs = ev.offset_ms != null ? Number(ev.offset_ms) : null;
    const dedupeKey =
      amountCents != null
        ? `${amountCents}:${Math.floor((offsetMs ?? 0) / 8000)}`
        : `${buyer ?? "_"}:${offsetMs ?? "_"}`;
    if (seenKeys.has(dedupeKey)) {
      skippedDuplicate++;
      continue;
    }
    seenKeys.add(dedupeKey);

    const gaps: string[] = [];
    if (!buyer) gaps.push("buyer_unknown");
    if (amountCents == null) gaps.push("amount_unknown");

    const matched =
      typeof ev.payload.matched === "string" ? ev.payload.matched.trim() : "";
    const productHint =
      typeof ev.payload.productHint === "string" &&
      ev.payload.productHint.trim().length > 2
        ? ev.payload.productHint.trim().slice(0, 200)
        : matched.length > 2
          ? matched.slice(0, 200)
          : `Canlı lot @ ${offsetMs ?? 0}ms (inceleme)`;

    const saleMethod = saleMethodFromReason(
      ev.payload.reason,
      ev.payload.source,
    );

    const explanation = explainSaleTr({
      confidence: conf,
      reason:
        typeof ev.payload.reason === "string" ? ev.payload.reason : null,
      buyer,
      amountCents,
      gaps,
    });

    const soldAt =
      offsetMs != null && Number.isFinite(recordedAt.getTime())
        ? new Date(recordedAt.getTime() + offsetMs)
        : new Date();

    const product = await sql<{ id: string }[]>`
      INSERT INTO products (seller_id, title, description, attributes)
      VALUES (
        ${sellerId},
        ${productHint},
        ${matched || "Otomatik aday ürün — LOCAL kurallar; yanlış olursa reddedin"},
        ${sql.json({
          sourceEventId: ev.id,
          confidence: conf,
          amountKnown: amountCents != null,
          buyerKnown: buyer != null,
          spokenBuyerName,
          saleMethod,
          offsetMs,
          gaps,
        })}
      )
      RETURNING id
    `;
    const imagePath = await attachProductImage(
      storageRoot,
      recordingId,
      product[0]!.id,
      offsetMs,
    );
    if (imagePath) {
      await sql`
        UPDATE products
        SET attributes = attributes || ${sql.json({ imagePath })}::jsonb,
            updated_at = now()
        WHERE id = ${product[0]!.id}
      `;
    }

    const sale = await sql<{ id: string }[]>`
      INSERT INTO sales (
        recording_id, product_id, seller_id, buyer_username,
        amount_cents, currency, sold_at, status
      ) VALUES (
        ${recordingId},
        ${product[0]!.id},
        ${sellerId},
        ${buyer},
        ${amountCents},
        'TRY',
        ${soldAt.toISOString()},
        'needs_review'
      )
      RETURNING id
    `;

    const refTable =
      ev.payload.source === "comment"
        ? "observed_comments"
        : ev.payload.source === "transcript"
          ? "transcript_segments"
          : "auction_events";
    const refId =
      typeof ev.payload.refId === "string" ? ev.payload.refId : ev.id;

    await sql`
      INSERT INTO sale_evidence (sale_id, evidence_type, ref_table, ref_id, note, payload)
      VALUES (
        ${sale[0]!.id},
        'auction_event',
        'auction_events',
        ${ev.id},
        ${"Satış olayı eşlemesi (yüksek güven kapısı)"},
        ${sql.json({
          confidence: conf,
          gate,
          reason: ev.payload.reason ?? null,
          saleMethod,
          amountCents,
          buyer,
          spokenBuyerName,
          gaps,
          explanationTr: explanation,
          offsetMs,
        })}
      )
    `;
    if (refId && refTable !== "auction_events") {
      await sql`
        INSERT INTO sale_evidence (sale_id, evidence_type, ref_table, ref_id, note, payload)
        VALUES (
          ${sale[0]!.id},
          ${refTable === "observed_comments" ? "comment" : "transcript"},
          ${refTable},
          ${refId},
          ${"Kaynak satır (uydurma yok)"},
          ${sql.json({
            matched: ev.payload.matched ?? null,
            offsetMs,
          })}
        )
      `;
    }
    salesCreated++;
  }

  await sql`
    UPDATE recordings SET status = 'complete', updated_at = now()
    WHERE id = ${recordingId}
  `;
  return {
    salesCreated,
    skippedLowConfidence,
    skippedDuplicate,
    saleMinConfidence: gate,
  };
}
