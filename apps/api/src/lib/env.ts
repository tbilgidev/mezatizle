import { DEFAULT_MAX_UPLOAD_BYTES, resolveProfile } from "@mezatizle/shared";
import { resolve } from "node:path";

export function loadEnv() {
  const storageRoot = resolve(process.env.STORAGE_ROOT ?? "./storage");
  const profile = resolveProfile(process.env.PROCESSING_PROFILE);
  return {
    host: process.env.API_HOST ?? "0.0.0.0",
    port: Number(process.env.API_PORT ?? "43127"),
    databaseUrl:
      process.env.DATABASE_URL ??
      "postgres://mezatizle:mezatizle@127.0.0.1:5432/mezatizle",
    storageRoot,
    maxUploadBytes: Number(
      process.env.MAX_UPLOAD_BYTES ?? DEFAULT_MAX_UPLOAD_BYTES,
    ),
    corsOrigin: process.env.CORS_ORIGIN ?? "*",
    ffmpegPath: process.env.FFMPEG_PATH ?? "ffmpeg",
    ffprobePath: process.env.FFPROBE_PATH ?? "ffprobe",
    frameIntervalSeconds: Number(process.env.FRAME_INTERVAL_SECONDS ?? "5"),
    profile,
    hardSpendLimitUsd: profile.hardSpendLimitUsd,
  };
}

export type AppEnv = ReturnType<typeof loadEnv>;
