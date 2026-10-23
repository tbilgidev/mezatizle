import { copyFile, mkdir, readdir, access } from "node:fs/promises";
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

/** Instagram live DOM chrome scraped as fake "comments". */
export function isLiveHudComment(
  author: string | null | undefined,
  body: string | null | undefined,
): boolean {
  const a = (author ?? "").trim().toLowerCase();
  if (
    a === "reels" ||
    a === "popular" ||
    a === "nunusvintageshop" ||
    a === "instagram"
  ) {
    return true;
  }
  const b = (body ?? "").trim();
  if (!b) return true;
  if (/^(Profil|Gönderiler|Gonderiler|Popüler|Popular|Reels)$/i.test(b)) {
    return true;
  }
  if (/Vintage Custom Jewellery/i.test(b)) return true;
  return false;
}

/**
 * Map a timeline offset onto a sparse OCR frame index.
 * Long lives extract ~OCR_MAX_FRAMES frames at fps≈N/duration — never assume 1fps.
 */
export function pickFrameIndexForOffset(opts: {
  offsetMs: number;
  frameCount: number;
  durationSeconds?: number | null;
  /** Optional explicit extraction fps (overrides duration mapping). */
  frameFps?: number | null;
}): number {
  const n = Math.max(1, Math.floor(opts.frameCount));
  if (n === 1) return 1;
  const offsetSec = Math.max(0, opts.offsetMs / 1000);
  const fps =
    opts.frameFps != null &&
    Number.isFinite(opts.frameFps) &&
    opts.frameFps > 0
      ? opts.frameFps
      : opts.durationSeconds != null &&
          Number.isFinite(opts.durationSeconds) &&
          opts.durationSeconds > 1
        ? (n - 1) / Number(opts.durationSeconds)
        : null;
  if (fps != null && fps > 0) {
    const idx = Math.round(offsetSec * fps) + 1;
    return Math.min(n, Math.max(1, idx));
  }
  // No duration → proportional guess across the set
  const durGuess = Math.max(offsetSec, 1);
  const idx = Math.round((offsetSec / durGuess) * (n - 1)) + 1;
  return Math.min(n, Math.max(1, idx));
}

async function extractFrameAtOffset(
  ffmpegPath: string,
  videoPath: string,
  offsetMs: number,
  destPath: string,
): Promise<boolean> {
  const sec = Math.max(0, offsetMs / 1000);
  const proc = Bun.spawn(
    [
      ffmpegPath,
      "-y",
      "-ss",
      String(sec),
      "-i",
      videoPath,
      "-frames:v",
      "1",
      "-q:v",
      "4",
      destPath,
    ],
    { stdout: "ignore", stderr: "pipe" },
  );
  const code = await proc.exited;
  if (code !== 0) return false;
  try {
    await access(destPath);
    return true;
  } catch {
    return false;
  }
}

async function attachProductImage(
  storageRoot: string,
  recordingId: string,
  productId: string,
  offsetMs: number | null = null,
  opts?: {
    durationSeconds?: number | null;
    videoPath?: string | null;
    frameFps?: number | null;
  },
) {
  const framesDir = join(storageRoot, "frames", recordingId);
  const outDir = join(storageRoot, "products");
  await mkdir(outDir, { recursive: true });
  const dest = join(outDir, `${productId}.jpg`);
  const ffmpegPath = process.env.FFMPEG_PATH ?? "ffmpeg";

  // Prefer a still from the master at this lot's offset (distinct thumbs on long lives).
  if (
    opts?.videoPath &&
    offsetMs != null &&
    Number.isFinite(offsetMs)
  ) {
    try {
      await access(opts.videoPath);
      const ok = await extractFrameAtOffset(
        ffmpegPath,
        opts.videoPath,
        offsetMs,
        dest,
      );
      if (ok) return `products/${productId}.jpg`;
    } catch {
      // fall through to OCR frame bank
    }
  }

  try {
    const files = (await readdir(framesDir))
      .filter((f) => f.endsWith(".jpg"))
      .sort();
    if (!files[0]) return null;
    const indices = files
      .map((f) => {
        const m = f.match(/(\d+)/);
        return m ? Number(m[1]) : NaN;
      })
      .filter((n) => Number.isFinite(n));
    const frameCount = indices.length
      ? Math.max(...indices)
      : files.length;
    let pick = files[0]!;
    if (offsetMs != null && Number.isFinite(offsetMs)) {
      const targetIdx = pickFrameIndexForOffset({
        offsetMs,
        frameCount,
        durationSeconds: opts?.durationSeconds,
        frameFps: opts?.frameFps,
      });
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

  const [recMeta] = await sql<{
    duration_seconds: number | null;
    capture_started_at: Date | string | null;
  }[]>`
    SELECT duration_seconds, capture_started_at FROM recordings
    WHERE id = ${recordingId}
  `;
  const durationMs =
    recMeta?.duration_seconds != null &&
    Number.isFinite(Number(recMeta.duration_seconds))
      ? Math.round(Number(recMeta.duration_seconds) * 1000)
      : null;
  // Grace: comments slightly after last frame still OK; post-live poll noise is not
  const commentMaxMs =
    durationMs != null ? durationMs + 15_000 : Number.MAX_SAFE_INTEGER;
  const captureStartedMs = recMeta?.capture_started_at
    ? new Date(recMeta.capture_started_at).getTime()
    : null;

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
    observed_at: Date | string | null;
  }[]>`
    SELECT id, offset_ms, body, author_username, observed_at
    FROM observed_comments
    WHERE recording_id = ${recordingId}
    ORDER BY COALESCE(offset_ms, 0) ASC
  `;

  let created = 0;

  for (const seg of segments) {
    if (durationMs != null && seg.start_ms > durationMs + 5_000) continue;
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
    // Live DOM HUD chrome (Reels/Profil/Popüler) floods offsets past duration.
    if (isLiveHudComment(c.author_username, c.body)) continue;

    let offset = c.offset_ms ?? 0;
    // Realign from observed_at when stored offset is past the recording
    // (post-live DOM poll kept writing wall-clock deltas).
    if (
      captureStartedMs != null &&
      c.observed_at != null &&
      durationMs != null &&
      offset > commentMaxMs
    ) {
      const derived = new Date(c.observed_at).getTime() - captureStartedMs;
      if (derived >= 0 && derived <= commentMaxMs) {
        offset = Math.round(derived);
      } else {
        continue;
      }
    } else if (offset > commentMaxMs) {
      continue;
    }
    // Pre-roll live_api comments (before capture) land at offset 0 and poison asks
    if (
      captureStartedMs != null &&
      c.observed_at != null &&
      new Date(c.observed_at).getTime() < captureStartedMs - 2_000
    ) {
      continue;
    }
    const signals = parseAuctionTexts(c.body, { source: "comment" });
    for (let signal of signals) {
      const author =
        c.author_username && /^[A-Za-z0-9._]{1,30}$/.test(c.author_username)
          ? c.author_username.toLowerCase()
          : undefined;
      // Never attach co-host/seller ask authors as buyers; only real bid events
      if (
        author &&
        !signal.buyerHint &&
        signal.eventType === "bid" &&
        signal.reason !== "seller_aldim_ask"
      ) {
        signal = { ...signal, buyerHint: author };
      }
      await sql`
        INSERT INTO auction_events (recording_id, event_type, offset_ms, payload, confidence)
        VALUES (
          ${recordingId},
          ${signal.eventType},
          ${offset},
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
  const rec = await sql<
    {
      seller_id: string;
      recorded_at: Date | string;
      duration_seconds: number | null;
      storage_path: string | null;
    }[]
  >`
    SELECT seller_id, recorded_at, duration_seconds, storage_path
    FROM recordings WHERE id = ${recordingId}
  `;
  if (!rec[0]) throw new Error("recording not found");
  const sellerId = rec[0].seller_id;
  const recordedAt = new Date(rec[0].recorded_at);
  const durationSeconds =
    rec[0].duration_seconds != null &&
    Number.isFinite(Number(rec[0].duration_seconds))
      ? Number(rec[0].duration_seconds)
      : null;
  const videoPath = rec[0].storage_path
    ? join(storageRoot, rec[0].storage_path)
    : null;

  const minConf = Number(
    process.env.SALE_MIN_CONFIDENCE ?? SALE_MIN_CONFIDENCE,
  );
  const gate = Number.isFinite(minConf) ? minConf : SALE_MIN_CONFIDENCE;

  // Preserve operator approve/reject across re-reconcile (match by ~offset + buyer/spoken).
  const priorDecisions = await sql<
    {
      status: string;
      buyer_username: string | null;
      amount_cents: string | null;
      attrs: Record<string, unknown> | null;
    }[]
  >`
    SELECT
      sa.status,
      sa.buyer_username,
      sa.amount_cents::text AS amount_cents,
      p.attributes AS attrs
    FROM sales sa
    LEFT JOIN products p ON p.id = sa.product_id
    WHERE sa.recording_id = ${recordingId}
      AND sa.status IN ('confirmed', 'rejected')
  `;
  const decisionByKey = new Map<string, string>();
  for (const d of priorDecisions) {
    const attrs = d.attrs && typeof d.attrs === "object" ? d.attrs : {};
    const offsetMs =
      attrs.offsetMs != null && Number.isFinite(Number(attrs.offsetMs))
        ? Number(attrs.offsetMs)
        : null;
    const spoken =
      typeof attrs.spokenBuyerName === "string"
        ? attrs.spokenBuyerName.toLowerCase()
        : "";
    const buyer = (d.buyer_username ?? "").toLowerCase();
    const amt =
      d.amount_cents != null ? Math.round(Number(d.amount_cents) / 100) : "_";
    if (offsetMs != null) {
      decisionByKey.set(
        `${Math.floor(offsetMs / 15_000)}|${buyer}|${spoken}|${amt}`,
        d.status,
      );
    }
  }

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
      buyerHint:
        typeof p.buyerHint === "string"
          ? p.buyerHint
          : typeof p.author === "string" &&
              p.source === "comment" &&
              /^[A-Za-z0-9._]{1,30}$/.test(p.author)
            ? p.author.toLowerCase()
            : undefined,
      spokenBuyerName:
        typeof p.spokenBuyerName === "string" ? p.spokenBuyerName : undefined,
      reason: typeof p.reason === "string" ? p.reason : undefined,
      matched: typeof p.matched === "string" ? p.matched : "",
      confidence: Number(r.confidence ?? p.confidence ?? 0),
      productHint:
        typeof p.productHint === "string" ? p.productHint : undefined,
      lotNumber:
        p.lotNumber != null && Number.isFinite(Number(p.lotNumber))
          ? Number(p.lotNumber)
          : undefined,
      quantity:
        p.quantity != null && Number.isFinite(Number(p.quantity))
          ? Number(p.quantity)
          : undefined,
      descriptorTokens: Array.isArray(p.descriptorTokens)
        ? p.descriptorTokens.filter((t): t is string => typeof t === "string")
        : undefined,
    };
  });

  const candidates = reconcileMezatWindows(timeline);

  let salesCreated = 0;
  let needsReviewCreated = 0;
  let autoConfirmed = 0;
  let skippedLowConfidence = 0;
  let skippedNoBuyer = 0;
  let skippedDuplicate = 0;
  const seenKeys = new Set<string>();

  for (const cand of candidates) {
    const wantsReview = cand.needsReview === true;
    const hasBuyer = Boolean(cand.buyerUsername);
    const pseudo = { eventType: "sold" as const, confidence: cand.confidence };

    // Confident auto sales still require gate + buyer.
    // Uncertain candidates (needsReview) persist even without @handle / below gate.
    if (!wantsReview) {
      if (!isSaleWorthy(pseudo) || cand.confidence < gate) {
        skippedLowConfidence++;
        continue;
      }
      if (!hasBuyer) {
        skippedNoBuyer++;
        continue;
      }
    }

    const amountCents =
      cand.amountTry != null && cand.amountTry >= 10
        ? Math.round(cand.amountTry * 100)
        : null;
    const buyer = cand.buyerUsername ?? null;
    const spoken = (cand.spokenBuyerName ?? "").toLowerCase();
    const offsetMs = cand.offsetMs;
    const buyerKey = (buyer ?? `spoken:${spoken || "bilinmiyor"}`).toLowerCase();
    // Multi-item packing legs («qty_2_of_4», dual 800+800) must not share a key.
    const leg =
      (cand.reason ?? "").match(/qty_(\d+)_of_(\d+)/)?.[0] ??
      ((cand.reason ?? "").match(/dual_same_price[_\w]*/)?.[0] || "");
    // Legacy 8s key + ~3 min same-buyer≈price key (repeated verbal confirms).
    const dedupeKey = `${buyerKey}:${amountCents ?? "_"}:${Math.floor(offsetMs / 8000)}:${leg}`;
    const lotDedupeKey = `${buyerKey}:${amountCents != null ? Math.round(amountCents / 100 / 500) * 500 : "_"}:${Math.floor(offsetMs / 180_000)}:${leg}`;
    if (seenKeys.has(dedupeKey) || seenKeys.has(lotDedupeKey)) {
      skippedDuplicate++;
      continue;
    }
    seenKeys.add(dedupeKey);
    seenKeys.add(lotDedupeKey);

    const gaps: string[] = [];
    if (amountCents == null) gaps.push("amount_unknown");
    if (!hasBuyer) gaps.push("buyer_unknown");
    if (wantsReview) gaps.push("needs_review");

    const productHint =
      cand.productHint && cand.productHint.trim().length > 2
        ? cand.productHint.trim().slice(0, 200)
        : `Canlı lot @ ${offsetMs}ms (inceleme)`;

    const saleMethod = cand.saleMethod;
    const evidenceQuote =
      cand.evidenceQuote?.trim().slice(0, 240) ||
      cand.reason.slice(0, 240);
    const explanation = [
      explainSaleTr({
        confidence: cand.confidence,
        reason: cand.reason,
        buyer: buyer ?? undefined,
        amountCents,
        gaps,
      }),
      evidenceQuote ? `Kanıt: «${evidenceQuote}»` : "",
      wantsReview
        ? "Operatör onayı bekleniyor (satış KPI’sına dahil değil)."
        : "",
    ]
      .filter(Boolean)
      .join(" ");

    const soldAt = Number.isFinite(recordedAt.getTime())
      ? new Date(recordedAt.getTime() + offsetMs)
      : new Date();

    const decisionKey = `${Math.floor(offsetMs / 15_000)}|${(buyer ?? "").toLowerCase()}|${spoken}|${amountCents != null ? Math.round(amountCents / 100) : "_"}`;
    const preserved = decisionByKey.get(decisionKey);
    // Auto-confirm only with buyer + price; amount-unknown → needs_review
    // (never KPI-inflate a null TRY sale from bare verbal packing).
    let status =
      preserved === "confirmed" || preserved === "rejected"
        ? preserved
        : wantsReview || !hasBuyer || amountCents == null
          ? "needs_review"
          : "confirmed";

    const product = await sql<{ id: string }[]>`
      INSERT INTO products (seller_id, title, description, attributes)
      VALUES (
        ${sellerId},
        ${productHint},
        ${evidenceQuote || productHint},
        ${sql.json({
          confidence: cand.confidence,
          amountKnown: amountCents != null,
          buyerKnown: hasBuyer,
          spokenBuyerName: cand.spokenBuyerName ?? null,
          saleMethod,
          offsetMs,
          askAmountTry: cand.askAmountTry ?? null,
          gaps,
          needsReview: wantsReview || status === "needs_review",
          evidenceQuote,
        })}
      )
      RETURNING id
    `;
    const imagePath = await attachProductImage(
      storageRoot,
      recordingId,
      product[0]!.id,
      offsetMs,
      { durationSeconds, videoPath },
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
        ${status}
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
        ${
          status === "needs_review"
            ? "İnceleme bekleyen mezat adayı"
            : "Mezat penceresi eşlemesi (otomatik satış)"
        },
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
          evidenceQuote,
          offsetMs,
          evidenceEventIds: cand.evidenceEventIds,
          needsReview: status === "needs_review",
          autoConfirmed: status === "confirmed" && !preserved,
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
    if (status === "needs_review") needsReviewCreated++;
    if (status === "confirmed" && !preserved) autoConfirmed++;
  }

  await sql`
    UPDATE recordings SET status = 'complete', updated_at = now()
    WHERE id = ${recordingId}
  `;
  return {
    salesCreated,
    needsReviewCreated,
    autoConfirmed,
    skippedLowConfidence,
    skippedNoBuyer,
    skippedDuplicate,
    saleMinConfidence: gate,
    candidatesConsidered: candidates.length,
  };
}
