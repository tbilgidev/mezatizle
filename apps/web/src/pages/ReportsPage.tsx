import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { ChevronRight } from "lucide-react";
import { api, type ReportListItem } from "@/lib/api";
import {
  analysisProgressInfo,
  isAnalysisRunning,
} from "@/lib/analysis-progress";
import {
  extractReportKpis,
  hasAnyKpi,
  reportKpiChips,
} from "@/lib/report-kpis";
import {
  formatDateTr,
  formatDuration,
  formatTry,
  statusTr,
} from "@/lib/utils";
import { EmptyState, ErrorState, LoadingState, PageHeader } from "@/components/States";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

function statusVariant(status: string): "ok" | "warn" | "danger" | "muted" {
  if (status === "complete" || status === "confirmed") return "ok";
  if (status === "failed" || status === "rejected") return "danger";
  if (status === "analyzing" || status === "needs_review" || status === "recording")
    return "warn";
  return "muted";
}

function reportAsRow(r: ReportListItem): Record<string, unknown> {
  return { ...(r as unknown as Record<string, unknown>) };
}

export function ReportsPage() {
  const [reports, setReports] = useState<ReportListItem[]>([]);
  const [totals, setTotals] = useState<{
    recordings: number;
    sales: number;
    needsReview: number;
    sumAmountTry: number;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function tick(first = false) {
      try {
        const d = await api.reports();
        if (cancelled) return;
        setReports(Array.isArray(d.reports) ? d.reports : []);
        setTotals(d.totals);
        setError(null);
        const running = (d.reports ?? []).some((r) =>
          isAnalysisRunning(reportAsRow(r)),
        );
        pollRef.current = setTimeout(() => void tick(), running ? 2500 : 12000);
      } catch (e) {
        if (e instanceof Error) setError(e.message);
        if (!cancelled) {
          pollRef.current = setTimeout(() => void tick(), 12000);
        }
      } finally {
        if (first) setLoading(false);
      }
    }

    void tick(true);
    return () => {
      cancelled = true;
      if (pollRef.current) clearTimeout(pollRef.current);
    };
  }, []);

  return (
    <div className="mx-auto max-w-[1100px] animate-rise">
      <PageHeader
        title="Raporlar"
        lead="Her kayıt bir analiz raporu. Sunulan / satılan özeti ve satış listesi — detaya tıklayın."
      />

      {error && <ErrorState message={error} className="mb-4" />}
      {loading && <LoadingState label="Raporlar yükleniyor…" />}

      {!loading && totals && (
        <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
          {[
            { v: String(totals.recordings), l: "Rapor" },
            { v: String(totals.sales), l: "Satılan (aday)" },
            { v: String(totals.needsReview), l: "İnceleme" },
            { v: formatTry(totals.sumAmountTry), l: "Toplam satış" },
          ].map((s) => (
            <div
              key={s.l}
              className="rounded-2xl border border-line bg-panel/70 px-4 py-4"
            >
              <strong className="font-display block text-xl tracking-tight">
                {s.v}
              </strong>
              <span className="mt-1 block text-sm text-fog">{s.l}</span>
            </div>
          ))}
        </div>
      )}

      {!loading && (
        <Card>
          <CardHeader>
            <CardTitle>Kayıt raporları</CardTitle>
          </CardHeader>
          <CardContent>
            {!reports.length ? (
              <EmptyState
                title="Henüz rapor yok"
                hint="Bir canlı yayın ekleyip analiz tamamlanınca burada özet görünür."
              />
            ) : (
              <ul className="space-y-3">
                {reports.map((r) => {
                  const progress = analysisProgressInfo(reportAsRow(r));
                  const kpis = extractReportKpis(reportAsRow(r));
                  const chips = reportKpiChips(kpis);
                  return (
                    <li key={r.recordingId}>
                      <Link
                        to={`/reports/${r.recordingId}`}
                        className="group block rounded-2xl border border-line bg-ink/25 px-4 py-4 transition-colors hover:border-mint/40 hover:bg-ink/40"
                      >
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <div className="min-w-0 flex-1">
                            <div className="font-semibold text-paper group-hover:text-mint">
                              {r.headline || `@${r.sellerUsername}`}
                            </div>
                            <div className="mt-0.5 text-xs text-fog">
                              {formatDateTr(r.recordedAt ?? r.uploadedAt)}
                              {" · "}
                              {formatDuration(r.durationSeconds)}
                              {r.displayName ? ` · ${r.displayName}` : ""}
                            </div>
                          </div>
                          <div className="flex items-center gap-2">
                            <Badge
                              variant={
                                progress ? "warn" : statusVariant(r.status)
                              }
                            >
                              {statusTr(r.status)}
                            </Badge>
                            <span className="inline-flex items-center gap-1 text-sm font-semibold text-mint">
                              Aç
                              <ChevronRight className="h-4 w-4" />
                            </span>
                          </div>
                        </div>

                        {progress ? (
                          <p className="mt-2 text-xs font-medium text-amber">
                            {progress.label}
                          </p>
                        ) : null}

                        {chips.length ? (
                          <div
                            className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4"
                            data-report-kpis={
                              hasAnyKpi(kpis) ? "1" : undefined
                            }
                          >
                            {chips.map((c) => (
                              <div
                                key={c.key}
                                className="rounded-xl border border-line/80 bg-panel/60 px-3 py-2"
                              >
                                <div className="text-[0.65rem] font-semibold uppercase tracking-wide text-fog">
                                  {c.label}
                                </div>
                                <div className="mt-0.5 font-display text-base font-semibold tracking-tight text-paper">
                                  {c.value}
                                </div>
                              </div>
                            ))}
                          </div>
                        ) : (
                          <div className="mt-3 flex flex-wrap gap-3 text-sm text-fog">
                            <span>
                              Satılan:{" "}
                              <strong className="text-paper">
                                {r.saleCount}
                              </strong>
                            </span>
                            <span>
                              Toplam satış:{" "}
                              <strong className="text-paper">
                                {formatTry(r.sumAmountTry)}
                              </strong>
                            </span>
                          </div>
                        )}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
