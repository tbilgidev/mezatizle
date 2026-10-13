/**
 * Module H — Capture adapter STUB only.
 *
 * Instagram Live capture is NOT implemented. This module documents constraints
 * and refuses unauthorized recording / login / private API usage.
 *
 * Allowed future directions (operator-owned only):
 * - Manual MP4 upload of content the seller already owns
 * - Operator-provided comment CSV export
 *
 * Forbidden:
 * - Instagram login / credential stuffing
 * - Private Graph/undocumented APIs
 * - Anti-bot circumvention
 * - Recording streams without authorization
 */

export const CAPTURE_POLICY = {
  status: "stub_only" as const,
  playwright: "not_enabled",
  message:
    "Playwright capture adapter is intentionally stubbed. Upload seller-owned MP4s and optional comment exports only.",
  restrictions: [
    "No Instagram authentication",
    "No private/undocumented Instagram APIs",
    "No anti-bot bypass",
    "No unauthorized live recording",
  ],
};

export function startCapture(): never {
  throw new Error(
    "Capture adapter disabled: unauthorized Instagram access is not permitted. Use MP4 upload instead.",
  );
}
