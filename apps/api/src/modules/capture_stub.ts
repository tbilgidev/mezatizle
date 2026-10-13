/**
 * Module H — Capture policy surface (settings / meta).
 * Implementation lives in live_capture.ts (public stream only).
 */
import { LIVE_CAPTURE_POLICY } from "./live_capture.ts";

export const CAPTURE_POLICY = LIVE_CAPTURE_POLICY;

/** @deprecated use createLiveCapture — kept so old clients get a clear error */
export function startCapture(): never {
  throw new Error(
    "Eski /api/capture/start kapatıldı. POST /api/recordings/live kullanın.",
  );
}
