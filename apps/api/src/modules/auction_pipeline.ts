import { copyFile, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Sql } from "@mezatizle/db";
import { parseAuctionText } from "@mezatizle/shared";

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
    // Prefer frame nearest to sale offset (frame_NNNNN @ OCR_FPS, default 1fps)
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
    const signal = parseAuctionText(seg.text);
    if (!signal) continue;
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
  for (const c of comments) {
    const signal = parseAuctionText(c.body);
    if (!signal) continue;
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
  return { eventsCreated: created };
}

export async function reconcileSales(
  sql: Sql,
  recordingId: string,
  storageRoot = process.env.STORAGE_ROOT ?? "./storage",
) {
  const rec = await sql<{ seller_id: string }[]>`
    SELECT seller_id FROM recordings WHERE id = ${recordingId}
  `;
  if (!rec[0]) throw new Error("recording not found");
  const sellerId = rec[0].seller_id;

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
  for (const ev of sold) {
    const amount = Number(ev.payload.amountTry ?? 0);
    const buyer = (ev.payload.buyerHint as string | undefined) ?? null;
    const productHint =
      (ev.payload.productHint as string | undefined) ??
      `Canlı lot @ ${ev.offset_ms ?? 0}ms`;

    const product = await sql<{ id: string }[]>`
      INSERT INTO products (seller_id, title, description, attributes)
      VALUES (
        ${sellerId},
        ${productHint.slice(0, 200)},
        ${"Otomatik aday ürün (yerel kurallar)"},
        ${sql.json({ sourceEventId: ev.id })}
      )
      RETURNING id
    `;
    const imagePath = await attachProductImage(
      storageRoot,
      recordingId,
      product[0]!.id,
      ev.offset_ms,
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
        ${Number.isFinite(amount) ? Math.round(amount * 100) : null},
        'TRY',
        now(),
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
        ${ev.id},
        ${"Satış olayı eşlemesi"},
        ${sql.json({ confidence: ev.confidence })}
      )
    `;
    salesCreated++;
  }

  await sql`
    UPDATE recordings SET status = 'complete', updated_at = now()
    WHERE id = ${recordingId}
  `;
  return { salesCreated };
}
