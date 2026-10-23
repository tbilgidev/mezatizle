import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  ArrowLeft,
  ChevronDown,
  ChevronUp,
  Download,
  Film,
  ImageOff,
  Pencil,
} from "lucide-react";
import {
  api,
  normalizeReportSale,
  type ReportDetail,
  type ReportSale,
  type SaleKpiSnapshot,
  type SaleReviewPatch,
} from "@/lib/api";
import {
  analysisProgressInfo,
  isAnalysisFailed,
} from "@/lib/analysis-progress";
import { resolveOffsetMs } from "@/lib/seek";
import {
  extractReportKpis,
  reportKpiChips,
} from "@/lib/report-kpis";
import { openReviewPopup } from "@/lib/review-popup";
import {
  confidenceLabel,
  formatDateTr,
  formatDuration,
  formatTry,
  statusTr,
} from "@/lib/utils";
import { EmptyState, ErrorState, LoadingState, PageHeader } from "@/components/States";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input, Select } from "@/components/ui/input";

function saleBadge(status: string): "ok" | "warn" | "danger" | "muted" {
  if (status === "confirmed") return "ok";
  if (status === "rejected") return "danger";
  if (status === "needs_review" || status === "candidate") return "warn";
  return "muted";
}

const METHOD_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "aldim_first_comment", label: "Aldım (yorum)" },
  { value: "bid_win_confirm", label: "Pey / teklif" },
  { value: "verbal_win_confirm", label: "Sözlü onay" },
  { value: "counter_accept", label: "Karşı teklif kabul" },
  { value: "sold_phrase", label: "Satıldı ifadesi" },
  { value: "manual", label: "Elle" },
];

const METHOD_TR: Record<string, string> = {
  ...Object.fromEntries(METHOD_OPTIONS.map((m) => [m.value, m.label])),
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

function buyerLabel(s: ReportSale): { text: string; known: boolean } {
  if (s.buyerUsername) {
    return { text: `@${s.buyerUsername.replace(/^@/, "")}`, known: true };
  }
  if (s.spokenBuyerName) {
    return { text: s.spokenBuyerName, known: false };
  }
  return { text: "bilinmiyor", known: false };
}

type EditDraft = {
  buyerUsername: string;
  amountTry: string;
  askAmount: string;
  method: string;
};

function draftFromSale(s: ReportSale): EditDraft {
  return {
    buyerUsername: s.buyerUsername?.replace(/^@/, "") ?? "",
    amountTry: s.amountTry != null ? String(s.amountTry) : "",
    askAmount: s.askAmountTry != null ? String(s.askAmountTry) : "",
    method: (s.saleMethod ?? s.detectionMethod ?? "manual").toLowerCase(),
  };
}

function parseOptionalTry(raw: string): number | null | undefined {
  const t = raw.trim().replace(/\s/g, "").replace(",", ".");
  if (!t) return null;
  const n = Number(t);
  if (!Number.isFinite(n) || n < 0) return undefined;
  return n;
}

function SaleTable({
  rows,
  busyId,
  editingId,
  draft,
  rowError,
  reviewedIds,
  mode,
  onOpen,
  onReview,
  onStartEdit,
  onCancelEdit,
  onDraftChange,
  onSaveEdit,
}: {
  rows: ReportSale[];
  busyId: string | null;
  editingId: string | null;
  draft: EditDraft | null;
  rowError: string | null;
  reviewedIds: Set<string>;
  mode: "sold" | "review" | "rejected";
  onOpen: (s: ReportSale) => void;
  onReview: (id: string, status: string) => void;
  onStartEdit: (s: ReportSale) => void;
  onCancelEdit: () => void;
  onDraftChange: (patch: Partial<EditDraft>) => void;
  onSaveEdit: (id: string) => void;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[820px] border-collapse text-left text-sm">
        <thead>
          <tr className="border-b border-line text-xs uppercase tracking-wide text-fog">
            <th className="pb-2 pr-3 font-semibold">Görsel</th>
            <th className="pb-2 pr-3 font-semibold">Ürün / kanıt</th>
            <th className="pb-2 pr-3 font-semibold">Alıcı</th>
            <th className="pb-2 pr-3 font-semibold">Tutar</th>
            <th className="pb-2 pr-3 font-semibold">Ask</th>
            <th className="pb-2 pr-3 font-semibold">Yöntem</th>
            <th className="pb-2 pr-3 font-semibold">Zaman</th>
            <th className="pb-2 pr-3 font-semibold">Güven</th>
            <th className="pb-2 font-semibold">Kanıt / işlem</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((s) => {
            const unlocked =
              mode === "sold" || reviewedIds.has(s.id);
            const productLabel =
              s.productTitle ?? s.productDescription ?? "Ürün tanımı yok";
            const buyer = buyerLabel(s);
            const quote =
              s.evidenceQuote?.trim() ||
              (s.explanationTr ? s.explanationTr.slice(0, 160) : null);
            const editing = editingId === s.id && draft;
            const busy = busyId === s.id;
            const showAsk =
              editing ||
              (s.askAmountTry != null &&
                (s.amountTry == null || s.askAmountTry !== s.amountTry));
            return (
              <tr
                key={s.id}
                className="border-b border-line/70 align-top transition-colors hover:bg-white/[0.03]"
                data-sale-id={s.id}
                data-editing={editing ? "1" : undefined}
              >
                <td className="py-3 pr-3">
                  <button
                    type="button"
                    className="block rounded-xl focus-visible:outline focus-visible:outline-2 focus-visible:outline-mint"
                    onClick={() => onOpen(s)}
                    title="Videoya git"
                  >
                    <SaleThumb sale={s} />
                  </button>
                </td>
                <td className="py-3 pr-3">
                  <button
                    type="button"
                    className="max-w-[20rem] text-left"
                    onClick={() => onOpen(s)}
                  >
                    <div className="font-semibold text-paper">
                      {productLabel}
                    </div>
                    {quote ? (
                      <div className="mt-0.5 line-clamp-3 text-xs italic text-fog">
                        «{quote}»
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
                <td className="py-3 pr-3">
                  {editing ? (
                    <Input
                      className="h-9 min-w-[8rem]"
                      placeholder="@kullanici"
                      value={draft.buyerUsername}
                      disabled={busy}
                      onChange={(e) =>
                        onDraftChange({ buyerUsername: e.target.value })
                      }
                    />
                  ) : buyer.known ? (
                    <span className="whitespace-nowrap font-semibold text-mint">
                      {buyer.text}
                    </span>
                  ) : (
                    <span className="text-fog" title="Alıcı tahmini">
                      {buyer.text}
                    </span>
                  )}
                </td>
                <td className="py-3 pr-3">
                  {editing ? (
                    <Input
                      className="h-9 w-24"
                      inputMode="decimal"
                      placeholder="TRY"
                      value={draft.amountTry}
                      disabled={busy}
                      onChange={(e) =>
                        onDraftChange({ amountTry: e.target.value })
                      }
                    />
                  ) : (
                    <span className="whitespace-nowrap font-display text-base font-semibold tracking-tight">
                      {formatTry(s.amountTry)}
                    </span>
                  )}
                </td>
                <td className="py-3 pr-3">
                  {editing ? (
                    <Input
                      className="h-9 w-24"
                      inputMode="decimal"
                      placeholder="Ask"
                      value={draft.askAmount}
                      disabled={busy}
                      onChange={(e) =>
                        onDraftChange({ askAmount: e.target.value })
                      }
                    />
                  ) : showAsk ? (
                    <span className="whitespace-nowrap text-fog">
                      {formatTry(s.askAmountTry)}
                    </span>
                  ) : (
                    <span className="text-fog">—</span>
                  )}
                </td>
                <td className="py-3 pr-3">
                  {editing ? (
                    <Select
                      className="h-9 min-w-[9rem]"
                      value={
                        METHOD_OPTIONS.some((m) => m.value === draft.method)
                          ? draft.method
                          : "manual"
                      }
                      disabled={busy}
                      onChange={(e) =>
                        onDraftChange({ method: e.target.value })
                      }
                    >
                      {METHOD_OPTIONS.map((m) => (
                        <option key={m.value} value={m.value}>
                          {m.label}
                        </option>
                      ))}
                    </Select>
                  ) : (
                    <span className="whitespace-nowrap text-fog">
                      {methodTr(s.detectionMethod ?? s.saleMethod)}
                    </span>
                  )}
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
                      disabled={busy}
                      onClick={() => onOpen(s)}
                    >
                      <Film className="h-3.5 w-3.5" />
                      Videoya git
                    </button>
                    <Link
                      to={`/evidence/${s.id}`}
                      className="text-xs font-semibold text-fog hover:text-mint"
                    >
                      Kanıt paneli →
                    </Link>
                    {editing ? (
                      <div className="mt-1 flex flex-wrap gap-1.5">
                        <Button
                          size="sm"
                          disabled={busy}
                          onClick={() => onSaveEdit(s.id)}
                        >
                          {busy ? "Kaydediliyor…" : "Kaydet"}
                        </Button>
                        <Button
                          size="sm"
                          variant="secondary"
                          disabled={busy}
                          onClick={onCancelEdit}
                        >
                          İptal
                        </Button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        className="inline-flex items-center gap-1 text-xs font-semibold text-fog hover:text-mint disabled:opacity-50"
                        disabled={busy || (editingId != null && editingId !== s.id)}
                        onClick={() => onStartEdit(s)}
                      >
                        <Pencil className="h-3 w-3" />
                        Düzenle
                      </button>
                    )}
                    {editing && rowError ? (
                      <p className="text-xs text-rose" role="alert">
                        {rowError}
                      </p>
                    ) : null}
                    {mode === "review" ? (
                      <div className="mt-1 flex flex-wrap gap-1.5">
                        <Button
                          size="sm"
                          disabled={busy || !unlocked}
                          title={
                            !unlocked
                              ? "Önce videoyu inceleyin"
                              : undefined
                          }
                          onClick={() => onReview(s.id, "confirmed")}
                        >
                          Satış olarak onayla
                        </Button>
                        <Button
                          size="sm"
                          variant="danger"
                          disabled={busy || !unlocked}
                          title={
                            !unlocked
                              ? "Önce videoyu inceleyin"
                              : undefined
                          }
                          onClick={() => onReview(s.id, "rejected")}
                        >
                          Satış değil
                        </Button>
                      </div>
                    ) : mode === "sold" ? (
                      <div className="mt-1 flex flex-wrap gap-1.5">
                        <Button
                          size="sm"
                          variant="danger"
                          disabled={busy}
                          onClick={() => onReview(s.id, "rejected")}
                        >
                          Satış değil
                        </Button>
                      </div>
                    ) : (
                      <div className="mt-1 flex flex-wrap gap-1.5">
                        <Button
                          size="sm"
                          disabled={busy}
                          onClick={() => onReview(s.id, "confirmed")}
                        >
                          Satış olarak onayla
                        </Button>
                      </div>
                    )}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function applyKpisToReport(
  report: ReportDetail,
  kpis: SaleKpiSnapshot | null | undefined,
): ReportDetail {
  if (!kpis) return report;
  return {
    ...report,
    confirmedCount: kpis.confirmedCount,
    needsReviewCount: kpis.needsReviewCount,
    rejectedCount: kpis.rejectedCount,
    saleCount: kpis.saleCount,
    productsSoldCount: kpis.productsSoldCount,
    productsSold: kpis.productsSold,
    productsSoldSumTry: kpis.productsSoldSumTry,
    totalSoldTry: kpis.totalSoldTry,
    sumAmountTry: kpis.sumAmountTry,
  };
}

export function ReportDetailPage() {
  const { recordingId = "" } = useParams();
  const [report, setReport] = useState<ReportDetail | null>(null);
  const [recordingMeta, setRecordingMeta] = useState<Record<
    string,
    unknown
  > | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<EditDraft | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);
  const [techOpen, setTechOpen] = useState(false);
  /** Sales whose video popup was opened this session — unlocks Onayla/Reddet. */
  const [reviewedIds, setReviewedIds] = useState<Set<string>>(() => new Set());

  async function load(opts?: { silent?: boolean }) {
    const [rep, rec] = await Promise.all([
      api.report(recordingId),
      api.recording(recordingId).catch(() => null),
    ]);
    const safe = rep?.report;
    if (!safe) throw new Error("Rapor yanıtı boş.");
    setReport((prev) => {
      const nextSales = Array.isArray(safe.sales) ? safe.sales : [];
      // Keep in-progress edit draft row stable across silent polls.
      if (opts?.silent && editingId && prev) {
        const edited = prev.sales.find((s) => s.id === editingId);
        if (edited) {
          return {
            ...safe,
            sales: nextSales.map((s) => (s.id === editingId ? edited : s)),
            jobs: Array.isArray(safe.jobs) ? safe.jobs : [],
            eventCounts:
              safe.eventCounts && typeof safe.eventCounts === "object"
                ? safe.eventCounts
                : {},
          };
        }
      }
      return {
        ...safe,
        sales: nextSales,
        jobs: Array.isArray(safe.jobs) ? safe.jobs : [],
        eventCounts:
          safe.eventCounts && typeof safe.eventCounts === "object"
            ? safe.eventCounts
            : {},
      };
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
    setEditingId(null);
    setDraft(null);
    load()
      .catch((e: Error) => {
        if (alive) setError(e.message);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    const t = setInterval(() => {
      void load({ silent: true }).catch(() => undefined);
    }, 5000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [recordingId]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2800);
    return () => clearTimeout(t);
  }, [toast]);

  const sales = useMemo(
    () => (Array.isArray(report?.sales) ? report!.sales : []),
    [report],
  );
  const soldSales = useMemo(
    () =>
      sales.filter(
        (s) => s.status === "confirmed" || s.status === "candidate",
      ),
    [sales],
  );
  const reviewSales = useMemo(
    () => sales.filter((s) => s.status === "needs_review"),
    [sales],
  );
  const rejectedSales = useMemo(
    () => sales.filter((s) => s.status === "rejected"),
    [sales],
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

  function mergeSaleResponse(
    saleRaw: Record<string, unknown>,
    kpis: SaleKpiSnapshot | null | undefined,
  ) {
    const mapped = normalizeReportSale(saleRaw);
    if (!mapped.id) return;
    setReport((prev) => {
      if (!prev) return prev;
      const salesNext = prev.sales.map((s) =>
        s.id === mapped.id
          ? {
              ...s,
              ...mapped,
              thumbnailUrl: mapped.thumbnailUrl ?? s.thumbnailUrl,
            }
          : s,
      );
      return applyKpisToReport({ ...prev, sales: salesNext }, kpis);
    });
  }

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
    setRowError(null);
    try {
      const res = await api.reviewSale(saleId, { status });
      if (res?.sale) mergeSaleResponse(res.sale, res.kpis);
      else await load();
      setToast(
        status === "confirmed"
          ? "Satış onaylandı"
          : status === "rejected"
            ? "Satış değil olarak işaretlendi"
            : "Durum güncellendi",
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  }

  async function saveEdit(saleId: string) {
    if (!draft) return;
    const amount = parseOptionalTry(draft.amountTry);
    if (amount === undefined) {
      setRowError("Geçersiz satış tutarı");
      return;
    }
    const ask = parseOptionalTry(draft.askAmount);
    if (ask === undefined) {
      setRowError("Geçersiz ask tutarı");
      return;
    }
    const patch: SaleReviewPatch = {
      buyerUsername: draft.buyerUsername.trim()
        ? draft.buyerUsername.trim().replace(/^@+/, "")
        : null,
      amountTry: amount,
      askAmount: ask,
      method: draft.method || "manual",
    };
    setBusyId(saleId);
    setRowError(null);
    setError(null);
    try {
      const res = await api.reviewSale(saleId, patch);
      if (res?.sale) mergeSaleResponse(res.sale, res.kpis);
      else await load();
      setEditingId(null);
      setDraft(null);
      setToast("Satır kaydedildi");
    } catch (e) {
      setRowError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  }

  async function openEvidencePlayer(sale: ReportSale) {
    if (!sale?.id) {
      setError("Satış kaydı bulunamadı.");
      return;
    }
    if (!report?.recordingId) {
      setError("Kayıt kimliği yok — video penceresi açılamadı.");
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
      const win = openReviewPopup({
        recordingId: report.recordingId,
        offsetMs: ms,
        saleId: sale.id,
      });
      if (!win) {
        setError(
          "Tarayıcı popup engelledi. Popup’lara izin verip «Videoya git»i yeniden deneyin.",
        );
        return;
      }
      setReviewedIds((prev) => new Set(prev).add(sale.id));
      setToast("Kanıt penceresi açıldı — yanına yerleştirip inceleyin");
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
      <div className="mx-auto max-w-[1400px]">
        <LoadingState label="Satış analizi yükleniyor…" />
      </div>
    );
  }

  if (error && !report) {
    return (
      <div className="mx-auto max-w-[1400px]">
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
          {
            key: "sold",
            label: "Satılan",
            value: String(report.confirmedCount ?? report.saleCount),
          },
          {
            key: "totalSold",
            label: "Toplam satış",
            value: formatTry(report.sumAmountTry),
          },
        ];

  const tableProps = {
    busyId,
    editingId,
    draft,
    rowError,
    reviewedIds,
    onOpen: (s: ReportSale) => void openEvidencePlayer(s),
    onReview: (id: string, st: string) => void review(id, st),
    onStartEdit: (s: ReportSale) => {
      setEditingId(s.id);
      setDraft(draftFromSale(s));
      setRowError(null);
    },
    onCancelEdit: () => {
      setEditingId(null);
      setDraft(null);
      setRowError(null);
    },
    onDraftChange: (patch: Partial<EditDraft>) =>
      setDraft((d) => (d ? { ...d, ...patch } : d)),
    onSaveEdit: (id: string) => void saveEdit(id),
  };

  return (
    <div className="mx-auto max-w-[1400px] animate-rise">
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
      {toast ? (
        <div
          className="mb-3 rounded-xl border border-mint/30 bg-mint/10 px-3 py-2 text-sm text-mint"
          role="status"
        >
          {toast}
        </div>
      ) : null}

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

      <div data-review-layout="list">
          <Card className="mb-4">
            <CardHeader>
              <CardTitle>Satış listesi</CardTitle>
              <p className="text-sm text-fog">
                Otomatik onaylanan satışlar — «Videoya git» ayrı pencerede
                A/V + yorum açar; bu sekmede liste kaydırmaya devam eder.
                İnceleme bekleyenler aşağıdaki ayrı bölümde.
              </p>
            </CardHeader>
            <CardContent>
              {!soldSales.length ? (
                <EmptyState
                  title={
                    reviewSales.length
                      ? "Onaylı satış yok"
                      : "Satış adayı yok"
                  }
                  hint={
                    reviewSales.length
                      ? `${reviewSales.length} aday inceleme bekliyor — onaylanınca burada ve KPI’da görünür.`
                      : emptySalesHint(report, analysisFailed)
                  }
                />
              ) : (
                <SaleTable
                  rows={soldSales}
                  mode="sold"
                  {...tableProps}
                />
              )}
            </CardContent>
          </Card>

          <Card className="mb-4" data-section="needs-review">
            <CardHeader>
              <CardTitle>
                İnceleme bekleyenler
                {reviewSales.length ? (
                  <span className="ml-2 text-base font-semibold text-signal">
                    ({reviewSales.length})
                  </span>
                ) : null}
              </CardTitle>
              <p className="text-sm text-fog">
                Belirsiz adaylar — alıcı / tutar / yöntemi satırda düzeltip
                kaydedin, sonra{" "}
                <strong className="font-semibold text-paper">
                  Satış olarak onayla
                </strong>{" "}
                veya{" "}
                <strong className="font-semibold text-paper">Satış değil</strong>.
                KPI’ya ancak onay sonrası dahil.
              </p>
            </CardHeader>
            <CardContent>
              {!reviewSales.length ? (
                <EmptyState
                  title="İnceleme bekleyen yok"
                  hint="Belirsiz aday çıkarsa burada listelenir."
                />
              ) : (
                <SaleTable
                  rows={reviewSales}
                  mode="review"
                  {...tableProps}
                />
              )}
            </CardContent>
          </Card>

          {rejectedSales.length > 0 ? (
            <Card className="mb-4">
              <CardHeader>
                <CardTitle>Satış değil ({rejectedSales.length})</CardTitle>
                <p className="text-sm text-fog">
                  Operatörün reddettiği adaylar — KPI’ya dahil değil.
                </p>
              </CardHeader>
              <CardContent>
                <SaleTable
                  rows={rejectedSales}
                  mode="rejected"
                  {...tableProps}
                />
              </CardContent>
            </Card>
          ) : null}

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
                  <span>
                    Ort. güven: {confidenceLabel(report.avgEventConfidence)}
                  </span>
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
                          <strong className="text-sm">
                            {j?.jobType ?? "—"}
                          </strong>
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
    </div>
  );
}
