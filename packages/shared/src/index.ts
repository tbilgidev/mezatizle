export const MODULES = [
  "A_INGESTION",
  "B_TRANSCRIPTION",
  "C_COMMENTS",
  "D_AUCTION_EVENTS",
  "E_PRODUCTS_SALES",
  "F_EVIDENCE_METRICS",
  "G_DASHBOARD",
  "H_CAPTURE_ADAPTER",
] as const;

export type ModuleId = (typeof MODULES)[number];

export type JobType =
  | "probe_media"
  | "extract_audio_frames"
  | "transcribe"
  | "ocr_frames"
  | "segment_auction"
  | "reconcile_sales";

export type JobStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

export type RecordingStatus =
  | "awaiting_live"
  | "recording"
  | "uploaded"
  | "probing"
  | "ready"
  | "extracting"
  | "extracted"
  | "transcribing"
  | "analyzing"
  | "complete"
  | "failed"
  | "cancelled";

export interface MediaProbe {
  durationSeconds: number;
  width: number;
  height: number;
  videoCodec?: string;
  audioCodec?: string;
  container?: string;
}

export const INSTAGRAM_USERNAME_RE = /^[A-Za-z0-9._]{1,30}$/;

export function normalizeInstagramUsername(raw: string): string {
  const cleaned = raw.trim().replace(/^@/, "");
  if (!INSTAGRAM_USERNAME_RE.test(cleaned)) {
    throw new Error(
      "Geçersiz Instagram kullanıcı adı (1–30 karakter; harf, rakam, . _)",
    );
  }
  return cleaned.toLowerCase();
}

/** Reject path traversal and absolute paths in relative storage keys. */
export function assertSafeRelativePath(rel: string): string {
  const normalized = rel.replace(/\\/g, "/");
  if (
    !normalized ||
    normalized.startsWith("/") ||
    normalized.includes("..") ||
    normalized.includes("\0")
  ) {
    throw new Error("Güvensiz dosya yolu reddedildi");
  }
  return normalized;
}

export const DEFAULT_MAX_UPLOAD_BYTES = 500 * 1024 * 1024;

export {
  resolveProfile,
  type ProcessingProfile,
  type ProfileConfig,
} from "./profiles.ts";
export {
  parseAuctionText,
  parseAuctionTexts,
  splitAuctionClauses,
  parsePriceTry,
  parseTurkishWordAmount,
  parseBuyerHint,
  parseSpokenBuyerName,
  isSellerAldimClosing,
  isSellerAldimAsk,
  isPostedSellerAsk,
  isSellerAcceptPhrase,
  isSaleWorthy,
  isAuctionNoise,
  enrichSoldFromBids,
  reconcileMezatWindows,
  buildProductLots,
  summarizeOfferWindows,
  explainSaleTr,
  SALE_MIN_CONFIDENCE,
  SALE_BID_LOOKBACK_MS,
  ALDIM_CLAIM_WINDOW_MS,
  OFFER_AMOUNT_SANITY_MAX_TRY,
  OFFER_AMOUNT_SANITY_MIN_TRY,
  LOT_RESHOW_MERGE_MS,
  LOT_MIN_NEW_MS,
  LOT_EARLY_REVISE_MS,
  type AuctionEventType,
  type ParsedAuctionSignal,
  type BidContext,
  type ParseAuctionOpts,
  type ParseAuctionSource,
  type TimelineEvent,
  type SaleCandidate,
  type SaleMethod,
  type ProductLot,
} from "./auction.ts";
export {
  parseLiveSourceInput,
  CAPTURE_STATUS_TR,
  type LiveSourceKind,
  type ParsedLiveSource,
} from "./live-source.ts";
