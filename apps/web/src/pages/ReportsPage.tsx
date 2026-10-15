import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ChevronRight } from "lucide-react";
import { api, type ReportListItem } from "@/lib/api";
import {
  confidenceLabel,
  formatDateTr,
  formatDuration,
  formatTry,
  statusTr,
} from "@/lib/utils";
import { EmptyState, ErrorState, LoadingState, PageHeader } from "@/components/States";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";

function statusVariant(status: string): "ok" | "warn" | "danger" | "muted" {
  if (status === "complete" || status === "confirmed") return "ok";
  if (status === "failed" || status === "rejected") return "danger";
  if (status === "analyzing" || status === "needs_review" || status === "recording")
    return "warn";
  return "muted";
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

  useEffect(() => {
    api
      .reports()
      .then((d) => {
        setReports(d.reports);
        setTotals(d.totals);
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="mx-auto max-w-[1100px] animate-rise">
      <PageHeader
        title="Raporlar"
        lead="Her kayıt bir analiz raporu. Satıcı, süre, tespit edilen satışlar ve güven özeti — detaya tıklayın."
      />

      {error && <ErrorState message={error} className="mb-4" />}
      {loading && <LoadingState label="Raporlar yükleniyor…" />}

      {!loading && !error && totals && (
        <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
          {[
            { v: String(totals.recordings), l: "Rapor" },
            { v: String(totals.sales), l: "Satış adayı" },
            { v: String(totals.needsReview), l: "İnceleme" },
            { v: formatTry(totals.sumAmountTry), l: "Toplam (yaklaşık)" },
          ].map((s) => (
            <div
              key={s.l}
              className="rounded-2xl border border-line bg-panel/70 px-4 py-4"
            >
              <strong className="font-display block text-xl tracking-tight">{s.v}</strong>
              <span className="mt-1 block text-sm text-fog">{s.l}</span>
            </div>
          ))}
        </div>
      )}

      {!loading && !error && (
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
              <Table>
                <THead>
                  <TR>
                    <TH>Özet</TH>
                    <TH>Tarih</TH>
                    <TH>Süre</TH>
                    <TH>Satış</TH>
                    <TH>Toplam</TH>
                    <TH>Güven</TH>
                    <TH>Durum</TH>
                    <TH></TH>
                  </TR>
                </THead>
                <TBody>
                  {reports.map((r) => (
                    <TR key={r.recordingId}>
                      <TD>
                        <Link
                          to={`/reports/${r.recordingId}`}
                          className="group block max-w-[28rem]"
                        >
                          <div className="font-semibold text-paper group-hover:text-mint">
                            {r.headline || `@${r.sellerUsername}`}
                          </div>
                          <div className="mt-0.5 truncate text-xs text-fog">
                            {r.displayName ? `${r.displayName} · ` : ""}
                            {r.originalFilename}
                          </div>
                        </Link>
                      </TD>
                      <TD className="whitespace-nowrap text-fog">
                        {formatDateTr(r.recordedAt ?? r.uploadedAt)}
                      </TD>
                      <TD className="whitespace-nowrap">
                        {formatDuration(r.durationSeconds)}
                      </TD>
                      <TD>
                        <span className="font-semibold">{r.saleCount}</span>
                        {r.needsReviewCount > 0 ? (
                          <span className="ml-1 text-xs text-amber">
                            ({r.needsReviewCount} inceleme)
                          </span>
                        ) : null}
                      </TD>
                      <TD className="whitespace-nowrap">
                        {formatTry(r.sumAmountTry)}
                      </TD>
                      <TD>{confidenceLabel(r.avgEventConfidence)}</TD>
                      <TD>
                        <Badge variant={statusVariant(r.status)}>
                          {statusTr(r.status)}
                        </Badge>
                      </TD>
                      <TD>
                        <Link
                          to={`/reports/${r.recordingId}`}
                          className="inline-flex items-center gap-1 text-sm font-semibold text-mint hover:text-mint-bright"
                        >
                          Aç
                          <ChevronRight className="h-4 w-4" />
                        </Link>
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
