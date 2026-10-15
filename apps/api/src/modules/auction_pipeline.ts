import { copyFile, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Sql } from "@mezatizle/db";
import {
  explainSaleTr,
  isSaleWorthy,
  parseAuctionTexts,
  reconcileMezatWindows,
  SALE_MIN_CONFIDENCE,
  type TimelineEvent,
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

  let created = 0;

  for (const seg of segments) {
    const signals = parseAuctionTexts(seg.text, { source: "transcript" });
    for (const signal of signals) {
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
      if (author && !signal.buyerHint && signal.eventType === "bid") {
        signal = { ...signal, buyerHint: author };
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

  return { eventsCreated: created, soldEnrichedFromBids: 0 };
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

  const rows = await sql<{
    id: string;
    offset_ms: number | null;
    event_type: string;
    payload: Record<string, unknown>;
    confidence: number | null;
  }[]>`
    SELECT id, offset_ms, event_type, payload, confidence FROM auction_events
    WHERE recording_id = ${recordingId}
    ORDER BY COALESCE(offset_ms, 0) ASC
  `;

  const timeline: TimelineEvent[] = rows.map((r) => {
    const p = r.payload ?? {};
    const source =
      p.source === "comment" ? "comment" : ("transcript" as const);
    return {
      id: r.id,
      offsetMs: Number(r.offset_ms ?? 0),
      eventType: r.event_type as TimelineEvent["eventType"],
      source,
      amountTry:
        p.amountTry != null && Number.isFinite(Number(p.amountTry))
          ? Number(p.amountTry)
          : undefined,
      buyerHint: typeof p.buyerHint === "string" ? p.buyerHint : undefined,
      spokenBuyerName:
        typeof p.spokenBuyerName === "string" ? p.spokenBuyerName : undefined,
      reason: typeof p.reason === "string" ? p.reason : undefined,
      matched: typeof p.matched === "string" ? p.matched : "",
      confidence: Number(r.confidence ?? p.confidence ?? 0),
      productHint:
        typeof p.productHint === "string" ? p.productHint : undefined,
    };
  });

  const candidates = reconcileMezatWindows(timeline);

  let salesCreated = 0;
  let skippedLowConfidence = 0;
  let skippedNoBuyer = 0;
  let skippedDuplicate = 0;
  const seenKeys = new Set<string>();

  for (const cand of candidates) {
    const pseudo = { eventType: "sold" as const, confidence: cand.confidence };
    if (!isSaleWorthy(pseudo) || cand.confidence < gate) {
      skippedLowConfidence++;
      continue;
    }
    if (!cand.buyerUsername) {
      skippedNoBuyer++;
      continue;
    }

    const amountCents =
      cand.amountTry != null && cand.amountTry >= 10
        ? Math.round(cand.amountTry * 100)
        : null;
    const buyer = cand.buyerUsername;
    const offsetMs = cand.offsetMs;
    const dedupeKey = `${buyer}:${amountCents ?? "_"}:${Math.floor(offsetMs / 8000)}`;
    if (seenKeys.has(dedupeKey)) {
      skippedDuplicate++;
      continue;
    }
    seenKeys.add(dedupeKey);

    const gaps: string[] = [];
    if (amountCents == null) gaps.push("amount_unknown");

    const productHint =
      cand.productHint && cand.productHint.trim().length > 2
        ? cand.productHint.trim().slice(0, 200)
        : `Canlı lot @ ${offsetMs}ms (inceleme)`;

    const saleMethod = cand.saleMethod;
    const explanation = explainSaleTr({
      confidence: cand.confidence,
      reason: cand.reason,
      buyer,
      amountCents,
      gaps,
    });

    const soldAt =
      Number.isFinite(recordedAt.getTime())
        ? new Date(recordedAt.getTime() + offsetMs)
        : new Date();

    const product = await sql<{ id: string }[]>`
      INSERT INTO products (seller_id, title, description, attributes)
      VALUES (
        ${sellerId},
        ${productHint},
        ${productHint},
        ${sql.json({
          confidence: cand.confidence,
          amountKnown: amountCents != null,
          buyerKnown: true,
          spokenBuyerName: cand.spokenBuyerName ?? null,
          saleMethod,
          offsetMs,
          askAmountTry: cand.askAmountTry ?? null,
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

    await sql`
      INSERT INTO sale_evidence (sale_id, evidence_type, ref_table, ref_id, note, payload)
      VALUES (
        ${sale[0]!.id},
        'auction_event',
        'auction_events',
        ${cand.evidenceEventIds[0] ?? sale[0]!.id},
        ${"Mezat penceresi eşlemesi (alıcı kanıtı zorunlu)"},
        ${sql.json({
          confidence: cand.confidence,
          gate,
          reason: cand.reason,
          saleMethod,
          amountCents,
          buyer,
          spokenBuyerName: cand.spokenBuyerName ?? null,
          gaps,
          explanationTr: explanation,
          offsetMs,
          evidenceEventIds: cand.evidenceEventIds,
        })}
      )
    `;
    for (const eid of cand.evidenceEventIds.slice(1)) {
      await sql`
        INSERT INTO sale_evidence (sale_id, evidence_type, ref_table, ref_id, note, payload)
        VALUES (
          ${sale[0]!.id},
          'auction_event',
          'auction_events',
          ${eid},
          ${"İlgili mezat olayı"},
          ${sql.json({ offsetMs })}
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
    skippedNoBuyer,
    skippedDuplicate,
    saleMinConfidence: gate,
    candidatesConsidered: candidates.length,
  };
}
