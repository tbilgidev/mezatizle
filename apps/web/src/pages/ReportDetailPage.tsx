import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  ArrowLeft,
  ChevronDown,
  ChevronUp,
  Download,
  Film,
  ImageOff,
} from "lucide-react";
import { api, type ReportDetail, type ReportSale } from "@/lib/api";
import {
  analysisProgressInfo,
  isAnalysisFailed,
} from "@/lib/analysis-progress";
import { resolveOffsetMs } from "@/lib/seek";
import {
  extractReportKpis,
  reportKpiChips,
} from "@/lib/report-kpis";
import {
  confidenceLabel,
  formatDateTr,
  formatDuration,
  formatTry,
  statusTr,
} from "@/lib/utils";
import { EvidencePlayer } from "@/components/EvidencePlayer";
import { EmptyState, ErrorState, LoadingState, PageHeader } from "@/components/States";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

function saleBadge(status: string): "ok" | "warn" | "danger" | "muted" {
  if (status === "confirmed") return "ok";
  if (status === "rejected") return "danger";
  if (status === "needs_review" || status === "candidate") return "warn";
  return "muted";
}

const METHOD_TR: Record<string, string> = {
  transcript: "Ses",
  asr: "Ses",
  ocr: "OCR",
  overlay: "OCR",
  comment: "Yorum",
  comments: "Yorum",
  video: "Video",
  frame: "Kare",
  reconcile: "Eşleştirme",
  bid: "Teklif",
  auction_event: "Olay",
  manual: "Elle",
  seller_aldim: "Satıcı «aldım»",
  seller_sold: "Satıcı «satıldı»",
  buyer_bid: "Alıcı teklifi",
};

function methodTr(raw: string | null | undefined): string {
  if (!raw) return "—";
  const key = raw.toLowerCase().replace(/\s+/g, "_");
  return METHOD_TR[key] ?? raw;
}

function formatOffset(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return "—";
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${String(m).padStart(2, "0")}:${String(rem).padStart(2, "0")}`;
}

function emptySalesHint(
  report: ReportDetail,
  analysisFailed: boolean,
): string {
  if (analysisFailed) {
    return "Analiz başarısız olduğu için satış adayları üretilemedi. Altyapı düzelince kaydı yeniden analiz edin.";
  }
  const counts =
    report.eventCounts && typeof report.eventCounts === "object"
      ? report.eventCounts
      : {};
  const bids = Number(counts.bid ?? 0);
  const ocr =
    Number(counts.ocr ?? 0) +
    Number(counts.price ?? 0) +
    Number(counts.overlay ?? 0);
  const jobs = Array.isArray(report.jobs) ? report.jobs : [];
  const running = jobs.some(
    (j) => j?.status === "running" || j?.status === "queued",
  );
  if (running) {
    return "Analiz sürüyor — satış adayları hazır olunca burada listelenir.";
  }
  if (bids > 0 || ocr > 0) {
    const bits: string[] = [];
    if (bids > 0) bits.push(`${bids} teklif sinyali`);
    if (ocr > 0) bits.push(`${ocr} OCR/fiyat sinyali`);
    return `${bits.join(", ")} bulundu ama henüz satış satırına dönüşmedi. Transkript + OCR eşleşmesi tamamlanınca ürün / alıcı / tutar burada görünür.`;
  }
  if ((report.transcriptSegmentCount ?? 0) > 0) {
    return "Transkript var; bu yayında onaylanabilir satış cümlesi / fiyat eşleşmesi çıkmadı.";
  }
  return "Bu kayıtta henüz satış adayı yok. Analiz bitince ürün, alıcı ve tutar burada listelenir.";
}

function SaleThumb({ sale }: { sale: ReportSale }) {
  const [broken, setBroken] = useState(false);
  if (!sale.thumbnailUrl || broken) {
    return (
      <div
        className="flex h-16 w-16 shrink-0 items-center justify-center rounded-xl border border-line bg-ink/50 text-fog"
        aria-hidden
      >
        <ImageOff className="h-5 w-5" />
      </div>
    );
  }
  return (
    <img
      src={sale.thumbnailUrl}
      alt=""
      className="h-16 w-16 shrink-0 rounded-xl border border-line object-cover"
      loading="lazy"
      onError={() => setBroken(true)}
    />
  );
}

export function ReportDetailPage() {
  const { recordingId = "" } = useParams();
  const [report, setReport] = useState<ReportDetail | null>(null);
  const [recordingMeta, setRecordingMeta] = useState<Record<
    string,
    unknown
  > | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [techOpen, setTechOpen] = useState(false);
  const [player, setPlayer] = useState<{
    saleId: string;
    offsetMs: number;
  } | null>(null);
  /** Sales whose video was reviewed this session — unlocks Onayla/Reddet. */
  const [reviewedIds, setReviewedIds] = useState<Set<string>>(() => new Set());

  async function load() {
    const [rep, rec] = await Promise.all([
      api.report(recordingId),
      api.recording(recordingId).catch(() => null),
    ]);
    const safe = rep?.report;
    if (!safe) throw new Error("Rapor yanıtı boş.");
    setReport({
      ...safe,
      sales: Array.isArray(safe.sales) ? safe.sales : [],
      jobs: Array.isArray(safe.jobs) ? safe.jobs : [],
      eventCounts:
        safe.eventCounts && typeof safe.eventCounts === "object"
          ? safe.eventCounts
          : {},
    });
    setRecordingMeta(
      rec?.recording && typeof rec.recording === "object"
        ? (rec.recording as Record<string, unknown>)
        : null,
    );
  }

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setReviewedIds(new Set());
    setPlayer(null);
    load()
      .catch((e: Error) => {
        if (alive) setError(e.message);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    const t = setInterval(() => {
      void load().catch(() => undefined);
    }, 5000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [recordingId]);

  const sales = useMemo(
    () => (Array.isArray(report?.sales) ? report!.sales : []),
    [report],
  );

  const analysisRow = useMemo(() => {
    const base = {
      ...(report as unknown as Record<string, unknown>),
      ...(recordingMeta ?? {}),
    };
    return base;
  }, [report, recordingMeta]);

  const analysisFailed = isAnalysisFailed(analysisRow);
  const analysisProgress = analysisProgressInfo(analysisRow);

  async function review(saleId: string, status: string) {
    if (!saleId) {
      setError("Satış kimliği yok — işlem yapılamadı.");
      return;
    }
    if (analysisFailed) {
      setError(
        "Analiz başarısız. Onay/red için önce analizi yeniden çalıştırın.",
      );
      return;
    }
    setBusyId(saleId);
    setError(null);
    try {
      await api.reviewSale(saleId, status);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  }

  async function openEvidencePlayer(sale: ReportSale) {
    if (!sale?.id) {
      setError("Satış kaydı bulunamadı.");
      return;
    }
    setBusyId(sale.id);
    setError(null);
    try {
      let ms = sale.offsetMs != null ? Number(sale.offsetMs) : null;
      if (ms == null || !Number.isFinite(ms)) {
        const d = await api.evidence(sale.id);
        ms = resolveOffsetMs({
          offsetMs: d.offsetMs,
          evidence: Array.isArray(d.evidence) ? d.evidence : [],
          productTitle:
            sale.productTitle ??
            (d.sale && d.sale.product_title != null
              ? String(d.sale.product_title)
              : null),
          auctionEvent: d.auctionEvent ?? null,
        });
      }
      if (ms == null || !Number.isFinite(ms)) {
        setError(
          analysisFailed
            ? "Analiz başarısız — bu satış için video zamanı yok. Analizi yeniden deneyin."
            : "Bu satış için video zaman damgası bulunamadı.",
        );
        return;
      }
      setPlayer({ saleId: sale.id, offsetMs: ms });
      setReviewedIds((prev) => new Set(prev).add(sale.id));
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "Kanıt videosu açılamadı. Analiz tamamlanmamış olabilir.",
      );
    } finally {
      setBusyId(null);
    }
  }

  if (loading && !report) {
    return (
      <div className="mx-auto max-w-[1100px]">
        <LoadingState label="Satış analizi yükleniyor…" />
      </div>
    );
  }

  if (error && !report) {
    return (
      <div className="mx-auto max-w-[1100px]">
        <ErrorState message={error} />
      </div>
    );
  }

  if (!report) return null;

  const kpiChips = reportKpiChips(
    extractReportKpis(report as unknown as Record<string, unknown>),
  );
  const headerChips =
    kpiChips.length > 0
      ? kpiChips
      : [
          { key: "seller", label: "Satıcı", value: `@${report.sellerUsername}` },
          {
            key: "dur",
            label: "Süre",
            value: formatDuration(report.durationSeconds),
          },
          { key: "sold", label: "Satılan", value: String(report.saleCount) },
          {
            key: "totalSold",
            label: "Toplam satış",
            value: formatTry(report.sumAmountTry),
          },
        ];

  return (
    <div className="mx-auto max-w-[1100px] animate-rise">
      <p className="mb-3">
        <Link
          to="/reports"
          className="inline-flex items-center gap-1.5 text-sm font-semibold text-fog hover:text-mint"
        >
          <ArrowLeft className="h-4 w-4" />
          Raporlar
        </Link>
      </p>

      <PageHeader
        title={
          report.headline ||
          `@${report.sellerUsername} — satış analizi`
        }
        lead={`${formatDateTr(report.recordedAt ?? report.uploadedAt)} · ${formatDuration(report.durationSeconds)} · @${report.sellerUsername}`}
        actions={
          <a
            href={api.reportCsvUrl(report.recordingId)}
            className="inline-flex h-10 items-center gap-2 rounded-xl border border-line bg-white/5 px-4 text-sm font-semibold text-fog hover:text-paper"
          >
            <Download className="h-4 w-4" />
            CSV indir
          </a>
        }
      />

      {error && <ErrorState message={error} className="mb-4" />}

      {analysisFailed ? (
        <div
          className="mb-4 rounded-2xl border border-rose/40 bg-rose/10 px-4 py-3 text-sm text-rose"
          role="alert"
          data-analysis-failed="1"
        >
          <strong className="font-semibold">Analiz başarısız.</strong>{" "}
          {analysisProgress?.label ?? "Analiz tamamlanamadı."} Satış listesi
          boş veya eksik olabilir. Altyapı (Python/ASR) düzelince bu kaydı
          yeniden analiz edin.
        </div>
      ) : null}

      <div
        className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-4"
        data-report-kpis={kpiChips.length ? "1" : undefined}
      >
        {headerChips.map((s) => (
          <div
            key={s.key}
            className="rounded-2xl border border-line bg-panel/70 px-4 py-3"
          >
            <span className="text-xs font-semibold uppercase tracking-wide text-fog">
              {s.label}
            </span>
            <strong className="mt-1 block truncate font-display text-lg tracking-tight">
              {s.value}
            </strong>
          </div>
        ))}
      </div>

      {player && (
        <EvidencePlayer
          recordingId={report.recordingId}
          offsetMs={player.offsetMs}
          open
          onClose={() => setPlayer(null)}
          title="Kanıt videosu"
        />
      )}

      <Card className="mb-4">
        <CardHeader>
          <CardTitle>Satış listesi</CardTitle>
          <p className="text-sm text-fog">
            Ne satıldı, kaça satıldı, kim aldı — satıra tıklayınca video kanıtına
            gidilir. Onay / red için önce görüntüyü inceleyin.
          </p>
        </CardHeader>
        <CardContent>
          {!sales.length ? (
            <EmptyState
              title="Satış adayı yok"
              hint={emptySalesHint(report, analysisFailed)}
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[720px] border-collapse text-left text-sm">
                <thead>
                  <tr className="border-b border-line text-xs uppercase tracking-wide text-fog">
                    <th className="pb-2 pr-3 font-semibold">Görsel</th>
                    <th className="pb-2 pr-3 font-semibold">Ürün</th>
                    <th className="pb-2 pr-3 font-semibold">Alıcı</th>
                    <th className="pb-2 pr-3 font-semibold">Tutar</th>
                    <th className="pb-2 pr-3 font-semibold">Yöntem</th>
                    <th className="pb-2 pr-3 font-semibold">Zaman</th>
                    <th className="pb-2 pr-3 font-semibold">Güven</th>
                    <th className="pb-2 font-semibold">Kanıt / işlem</th>
                  </tr>
                </thead>
                <tbody>
                  {sales.map((s) => {
                    const unlocked =
                      reviewedIds.has(s.id) || player?.saleId === s.id;
                    const productLabel =
                      s.productTitle ??
                      s.productDescription ??
                      "Ürün tanımı yok";
                    return (
                      <tr
                        key={s.id}
                        className="border-b border-line/70 align-top transition-colors hover:bg-white/[0.03]"
                      >
                        <td className="py-3 pr-3">
                          <button
                            type="button"
                            className="block rounded-xl focus-visible:outline focus-visible:outline-2 focus-visible:outline-mint"
                            onClick={() => void openEvidencePlayer(s)}
                            title="Görüntüyü incele"
                          >
                            <SaleThumb sale={s} />
                          </button>
                        </td>
                        <td className="py-3 pr-3">
                          <button
                            type="button"
                            className="max-w-[18rem] text-left"
                            onClick={() => void openEvidencePlayer(s)}
                          >
                            <div className="font-semibold text-paper">
                              {productLabel}
                            </div>
                            {s.explanationTr ? (
                              <div className="mt-0.5 line-clamp-2 text-xs text-fog">
                                {s.explanationTr}
                              </div>
                            ) : s.productDescription &&
                              s.productTitle &&
                              s.productDescription !== s.productTitle ? (
                              <div className="mt-0.5 line-clamp-2 text-xs text-fog">
                                {s.productDescription}
                              </div>
                            ) : null}
                            <Badge
                              variant={saleBadge(s.status)}
                              className="mt-1.5"
                            >
                              {statusTr(s.status)}
                            </Badge>
                          </button>
                        </td>
                        <td className="py-3 pr-3 whitespace-nowrap">
                          {s.buyerUsername ? (
                            <span className="font-semibold text-mint">
                              @{s.buyerUsername.replace(/^@/, "")}
                            </span>
                          ) : s.spokenBuyerName ? (
                            <span className="text-fog" title="Konuşulan isim">
                              {s.spokenBuyerName}
                            </span>
                          ) : (
                            <span className="text-fog">Bilinmiyor</span>
                          )}
                        </td>
                        <td className="py-3 pr-3 whitespace-nowrap font-display text-base font-semibold tracking-tight">
                          {formatTry(s.amountTry)}
                        </td>
                        <td className="py-3 pr-3 whitespace-nowrap text-fog">
                          {methodTr(s.detectionMethod)}
                        </td>
                        <td className="py-3 pr-3 whitespace-nowrap text-fog">
                          {s.offsetMs != null
                            ? formatOffset(s.offsetMs)
                            : formatDateTr(s.soldAt)}
                        </td>
                        <td className="py-3 pr-3 whitespace-nowrap">
                          {confidenceLabel(s.confidence)}
                        </td>
                        <td className="py-3">
                          <div className="flex flex-col gap-1.5">
                            <button
                              type="button"
                              className="inline-flex items-center gap-1 text-sm font-semibold text-mint hover:text-mint-bright disabled:opacity-50"
                              disabled={busyId === s.id}
                              onClick={() => void openEvidencePlayer(s)}
                            >
                              <Film className="h-3.5 w-3.5" />
                              Görüntüyü incele
                            </button>
                            <Link
                              to={`/evidence/${s.id}`}
                              className="text-xs font-semibold text-fog hover:text-mint"
                            >
                              Kanıt paneli →
                            </Link>
                            <div className="mt-1 flex flex-wrap gap-1.5">
                              <Button
                                size="sm"
                                disabled={busyId === s.id || !unlocked}
                                title={
                                  !unlocked
                                    ? "Önce görüntüyü inceleyin"
                                    : undefined
                                }
                                onClick={() => void review(s.id, "confirmed")}
                              >
                                Onayla
                              </Button>
                              <Button
                                size="sm"
                                variant="danger"
                                disabled={busyId === s.id || !unlocked}
                                title={
                                  !unlocked
                                    ? "Önce görüntüyü inceleyin"
                                    : undefined
                                }
                                onClick={() => void review(s.id, "rejected")}
                              >
                                Reddet
                              </Button>
                            </div>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <button
            type="button"
            className="flex w-full items-center justify-between gap-2 text-left"
            onClick={() => setTechOpen((v) => !v)}
            aria-expanded={techOpen}
          >
            <CardTitle>Teknik özet</CardTitle>
            {techOpen ? (
              <ChevronUp className="h-5 w-5 text-fog" />
            ) : (
              <ChevronDown className="h-5 w-5 text-fog" />
            )}
          </button>
          <p className="text-sm text-fog">
            İş kuyruğu ve sinyal sayıları — satış listesinin altında, isteğe bağlı.
          </p>
        </CardHeader>
        {techOpen ? (
          <CardContent>
            <div className="mb-4 flex flex-wrap gap-3 text-sm text-fog">
              <span>Durum: {statusTr(report.status)}</span>
              <span>Transkript: {report.transcriptSegmentCount}</span>
              <span>Yorum: {report.commentCount}</span>
              <span>İnceleme: {report.needsReviewCount}</span>
              <span>Ort. güven: {confidenceLabel(report.avgEventConfidence)}</span>
            </div>
            {!!Object.keys(report.eventCounts ?? {}).length && (
              <p className="mb-4 text-xs text-fog">
                Sinyaller:{" "}
                {Object.entries(report.eventCounts ?? {})
                  .map(([k, v]) => `${k}:${v}`)
                  .join(" · ")}
              </p>
            )}
            {!(report.jobs ?? []).length ? (
              <EmptyState title="İş yok" />
            ) : (
              <div className="space-y-3">
                {(report.jobs ?? []).map((j, i) => (
                  <div key={`${j?.jobType ?? "job"}-${i}`}>
                    <div className="mb-1 flex items-center justify-between gap-2">
                      <strong className="text-sm">{j?.jobType ?? "—"}</strong>
                      <Badge variant="muted">{statusTr(j?.status)}</Badge>
                    </div>
                    <div className="h-1.5 overflow-hidden rounded-full bg-white/10">
                      <i
                        className="block h-full rounded-full bg-gradient-to-r from-mint to-signal transition-all"
                        style={{ width: `${j?.progressPercent || 0}%` }}
                      />
                    </div>
                    {j?.stage ? (
                      <p className="mt-1 text-xs text-fog">{j.stage}</p>
                    ) : null}
                  </div>
                ))}
              </div>
            )}
            <p className="mt-4 text-xs text-fog">
              <Link
                to={`/recordings/${report.recordingId}`}
                className="text-mint"
              >
                Kayıt detayı
              </Link>
            </p>
          </CardContent>
        ) : null}
      </Card>
    </div>
  );
}
