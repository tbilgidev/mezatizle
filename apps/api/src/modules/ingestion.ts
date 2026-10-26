import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import type { Sql } from "@mezatizle/db";
import { enqueueJob } from "@mezatizle/db";
import { normalizeInstagramUsername } from "@mezatizle/shared";
import type { AppEnv } from "../lib/env.ts";
import { probeMedia, extractAudioAndFrames } from "../lib/ffmpeg.ts";
import { safeJoinStorage, toStorageKey } from "../lib/storage.ts";
import { recordMetric } from "../lib/cost.ts";

export async function upsertSeller(sql: Sql, usernameRaw: string) {
  const username = normalizeInstagramUsername(usernameRaw);
  const rows = await sql<{ id: string; instagram_username: string }[]>`
    INSERT INTO sellers (instagram_username)
    VALUES (${username})
    ON CONFLICT (instagram_username) DO UPDATE
      SET updated_at = now()
    RETURNING id, instagram_username
  `;
  return rows[0]!;
}

export async function createRecordingFromUpload(
  sql: Sql,
  env: AppEnv,
  opts: {
    file: File;
    sellerInstagramUsername: string;
    recordedAt: string;
    notes?: string;
  },
) {
  if (!opts.file || opts.file.size === 0) {
    throw new Error("MP4 dosyası gerekli");
  }
  if (opts.file.size > env.maxUploadBytes) {
    throw new Error(`Dosya boyutu limiti aşıldı (${env.maxUploadBytes} bayt)`);
  }
  const name = opts.file.name || "upload.mp4";
  if (!name.toLowerCase().endsWith(".mp4")) {
    throw new Error("Yalnızca .mp4 yüklemelerine izin verilir");
  }
  if (name.includes("..") || name.includes("/") || name.includes("\\")) {
    throw new Error("Geçersiz dosya adı");
  }

  const seller = await upsertSeller(sql, opts.sellerInstagramUsername);
  const recordedAt = new Date(opts.recordedAt);
  if (Number.isNaN(recordedAt.getTime())) {
    throw new Error("Geçersiz kayıt tarihi");
  }

  const id = crypto.randomUUID();
  const destAbs = safeJoinStorage(env.storageRoot, "recordings", `${id}.mp4`);
  await mkdir(join(env.storageRoot, "recordings"), { recursive: true });
  await Bun.write(destAbs, opts.file);
  const storagePath = toStorageKey(env.storageRoot, destAbs);

  const rows = await sql<{ id: string }[]>`
    INSERT INTO recordings (
      id, seller_id, original_filename, storage_path, recorded_at,
      status, file_size_bytes, notes
    ) VALUES (
      ${id}, ${seller.id}, ${name}, ${storagePath}, ${recordedAt.toISOString()},
      'uploaded', ${opts.file.size}, ${opts.notes ?? null}
    )
    RETURNING id
  `;

  await enqueueAnalysisPipeline(sql, id);

  return {
    recordingId: rows[0]!.id,
    sellerId: seller.id,
  };
}

export async function enqueueAnalysisPipeline(sql: Sql, recordingId: string) {
  await enqueueJob(sql, recordingId, "probe_media", 10);
  await enqueueJob(sql, recordingId, "extract_audio_frames", 20);
  await enqueueJob(sql, recordingId, "transcribe", 30);
  await enqueueJob(sql, recordingId, "ocr_frames", 40);
  await enqueueJob(sql, recordingId, "segment_auction", 50);
  await enqueueJob(sql, recordingId, "reconcile_sales", 60);
}

export async function runProbeJob(
  sql: Sql,
  env: AppEnv,
  jobId: string,
  recordingId: string,
) {
  const rec = await sql<{ storage_path: string }[]>`
    SELECT storage_path FROM recordings WHERE id = ${recordingId}
  `;
  if (!rec[0]) throw new Error("recording not found");
  await sql`UPDATE recordings SET status = 'probing', updated_at = now() WHERE id = ${recordingId}`;
  const abs = safeJoinStorage(env.storageRoot, rec[0].storage_path);
  const started = performance.now();
  const probe = await probeMedia(env.ffprobePath, abs);
  await sql`
    UPDATE recordings SET
      duration_seconds = ${probe.durationSeconds},
      width = ${probe.width},
      height = ${probe.height},
      video_codec = ${probe.videoCodec ?? null},
      audio_codec = ${probe.audioCodec ?? null},
      container = ${probe.container ?? null},
      status = 'ready',
      updated_at = now()
    WHERE id = ${recordingId}
  `;
  await recordMetric(sql, {
    name: "probe_duration_ms",
    value: performance.now() - started,
    unit: "ms",
    recordingId,
    jobId,
  });
  return probe;
}

export async function runExtractJob(
  sql: Sql,
  env: AppEnv,
  jobId: string,
  recordingId: string,
) {
  const rec = await sql<{ storage_path: string; duration_seconds: number | null }[]>`
    SELECT storage_path, duration_seconds FROM recordings WHERE id = ${recordingId}
  `;
  if (!rec[0]) throw new Error("recording not found");
  await sql`UPDATE recordings SET status = 'extracting', updated_at = now() WHERE id = ${recordingId}`;
  const input = safeJoinStorage(env.storageRoot, rec[0].storage_path);
  const audioOut = safeJoinStorage(
    env.storageRoot,
    "audio",
    `${recordingId}.wav`,
  );
  const framesDir = safeJoinStorage(env.storageRoot, "frames", recordingId);
  const started = performance.now();
  const extract = await extractAudioAndFrames({
    ffmpegPath: env.ffmpegPath,
    ffprobePath: env.ffprobePath,
    inputPath: input,
    audioOutPath: audioOut,
    framesDir,
    intervalSeconds: env.frameIntervalSeconds,
    durationSeconds: rec[0].duration_seconds,
    onHeartbeat: async () => {
      await sql`
        UPDATE processing_jobs
        SET updated_at = now(), locked_at = now(), stage = 'ffmpeg'
        WHERE id = ${jobId} AND status = 'running'
      `;
    },
  });
  const frameGlob = Array.from(
    new Bun.Glob("*.jpg").scanSync({ cwd: framesDir }),
  );
  await sql`UPDATE recordings SET status = 'extracted', updated_at = now() WHERE id = ${recordingId}`;
  await recordMetric(sql, {
    name: "extract_duration_ms",
    value: performance.now() - started,
    unit: "ms",
    recordingId,
    jobId,
    labels: {
      frames: frameGlob.length,
      audioPartial: extract.audioPartial,
      audioDurationSec: extract.audioDurationSec,
      frameFps: extract.frameFps,
    },
  });
  return {
    audioPath: toStorageKey(env.storageRoot, audioOut),
    framesDir: toStorageKey(env.storageRoot, framesDir),
    frameCount: frameGlob.length,
    audioPartial: extract.audioPartial,
    audioDurationSec: extract.audioDurationSec,
    frameFps: extract.frameFps,
  };
}
