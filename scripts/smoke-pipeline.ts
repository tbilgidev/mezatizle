/**
 * Upload fixtures/sample-live.mp4 and wait for pipeline completion (real ASR/OCR).
 * Usage: bun run scripts/smoke-pipeline.ts
 */
const API = process.env.API_BASE ?? "http://127.0.0.1:43127";
const FIXTURE =
  process.env.SMOKE_FIXTURE ??
  new URL("../fixtures/sample-live.mp4", import.meta.url).pathname;

async function main() {
  const health = await fetch(`${API}/api/health`).then((r) => r.json());
  console.log("health", health);

  const settings = await fetch(`${API}/api/settings`).then((r) => r.json());
  console.log("profile", settings.profile);
  if (
    settings.profile?.asrBackend === "mock" ||
    settings.profile?.ocrBackend === "mock"
  ) {
    throw new Error("API still on mock backends — restart without FORCE_MOCK_*");
  }

  const file = Bun.file(FIXTURE);
  if (!(await file.exists())) throw new Error(`missing fixture ${FIXTURE}`);
  const fd = new FormData();
  fd.append("file", file, "sample-live.mp4");
  fd.append("sellerInstagramUsername", "smoke_seller");
  fd.append("recordedAt", new Date().toISOString());
  fd.append("notes", "smoke real asr/ocr");

  const created = await fetch(`${API}/api/recordings/upload`, {
    method: "POST",
    body: fd,
  }).then(async (r) => {
    const j = await r.json();
    if (!r.ok) throw new Error(JSON.stringify(j));
    return j as { recordingId: string };
  });
  console.log("recording", created.recordingId);

  const t0 = Date.now();
  let status = "uploaded";
  for (let i = 0; i < 240; i++) {
    await Bun.sleep(5000);
    const rec = await fetch(`${API}/api/recordings/${created.recordingId}`).then(
      (r) => r.json(),
    );
    status = rec.recording?.status ?? rec.status;
    const jobs = rec.jobs ?? [];
    console.log(
      `[${((Date.now() - t0) / 1000).toFixed(0)}s] status=${status} jobs=${jobs
        .map(
          (j: { job_type: string; status: string }) =>
            `${j.job_type}:${j.status}`,
        )
        .join(",")}`,
    );
    if (status === "complete" || status === "failed") break;
  }

  const detail = await fetch(
    `${API}/api/recordings/${created.recordingId}`,
  ).then((r) => r.json());
  const transcript = await fetch(
    `${API}/api/recordings/${created.recordingId}/transcript`,
  ).then((r) => r.json());
  const comments = await fetch(
    `${API}/api/comments?recordingId=${created.recordingId}`,
  )
    .then((r) => r.json())
    .catch(() => ({ comments: [] }));
  const sales = await fetch(
    `${API}/api/sales?recordingId=${created.recordingId}`,
  )
    .then((r) => r.json())
    .catch(() => ({ sales: [] }));

  const wallSec = (Date.now() - t0) / 1000;
  const report = {
    recordingId: created.recordingId,
    status: detail.recording?.status,
    wallSec,
    transcriptSegments: (transcript.segments ?? []).length,
    sampleTranscript: (transcript.segments ?? [])
      .slice(0, 3)
      .map((s: { text: string; source: string }) => ({
        text: s.text,
        source: s.source,
      })),
    comments: (comments.comments ?? comments ?? []).length,
    sales: (sales.sales ?? sales ?? []).length,
    error: detail.recording?.error_message,
    jobs: detail.jobs,
  };
  console.log(JSON.stringify(report, null, 2));
  if (status !== "complete") process.exit(1);
  // Real ASR must not be mock_asr
  const sources = new Set(
    (transcript.segments ?? []).map((s: { source: string }) => s.source),
  );
  if (sources.has("mock_asr") && sources.size === 1) {
    throw new Error("transcript still mock_asr only");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
