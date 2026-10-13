export type ProcessingProfile = "LOCAL" | "HYBRID" | "API";

export interface ProfileConfig {
  profile: ProcessingProfile;
  allowPaidApis: boolean;
  asrBackend: "faster-whisper" | "mock" | "openai-whisper-api";
  ocrBackend: "paddleocr" | "tesseract" | "mock" | "vision-api";
  llmBackend: "none" | "local-rules" | "openai";
  hardSpendLimitUsd: number;
}

export function resolveProfile(
  raw: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): ProfileConfig {
  const profile = (raw ?? env.PROCESSING_PROFILE ?? "LOCAL").toUpperCase() as
    | ProcessingProfile
    | string;
  const hardSpendLimitUsd = Number(env.HARD_SPEND_LIMIT_USD ?? "0");
  const hasOpenAi = Boolean(env.OPENAI_API_KEY);
  const hasVision = Boolean(env.VISION_API_KEY);

  if (profile === "API") {
    return {
      profile: "API",
      allowPaidApis: hasOpenAi || hasVision,
      asrBackend: hasOpenAi ? "openai-whisper-api" : "faster-whisper",
      ocrBackend: hasVision ? "vision-api" : "paddleocr",
      llmBackend: hasOpenAi ? "openai" : "local-rules",
      hardSpendLimitUsd: Number.isFinite(hardSpendLimitUsd)
        ? hardSpendLimitUsd
        : 0,
    };
  }
  if (profile === "HYBRID") {
    return {
      profile: "HYBRID",
      allowPaidApis: false,
      asrBackend: "faster-whisper",
      ocrBackend: "paddleocr",
      llmBackend: "local-rules",
      hardSpendLimitUsd: Number.isFinite(hardSpendLimitUsd)
        ? hardSpendLimitUsd
        : 0,
    };
  }
  // LOCAL default — never call paid APIs
  return {
    profile: "LOCAL",
    allowPaidApis: false,
    asrBackend: env.FORCE_MOCK_ASR === "1" ? "mock" : "faster-whisper",
    ocrBackend: env.FORCE_MOCK_OCR === "1" ? "mock" : "paddleocr",
    llmBackend: "local-rules",
    hardSpendLimitUsd: 0,
  };
}
