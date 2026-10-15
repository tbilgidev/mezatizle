import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ArrowLeft, Download, Film } from "lucide-react";
import { api, type ReportDetail } from "@/lib/api";
import { resolveOffsetMs } from "@/lib/seek";
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
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";

function saleBadge(status: string): "ok" | "warn" | "danger" | "muted" {
  if (status === "confirmed") return "ok";
  if (status === "rejected") return "danger";
  if (status === "needs_review") return "warn";
  return "muted";
}

export function ReportDetailPage() {
  const { recordingId = "" } = useParams();
  const [report, setReport] = useState<ReportDetail | null>(null);
  const [segments, setSegments] = useState<Array<Record<string, unknown>>>([]);
  const [events, setEvents] = useState<Array<Record<string, unknown>>>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [player, setPlayer] = useState<{
    saleId: string;
    offsetMs: number;
  } | null>(null);

  async function load() {
    const [rep, tr, ev] = await Promise.all([
      api.report(recordingId),
      api.transcript(recordingId),
      api.events(recordingId),
    ]);
    setReport(rep.report);
    setSegments(tr.segments);
    setEvents(ev.events);
  }

  useEffect(() => {
    let alive = true;
    setLoading(true);
    load()
      .catch((e: Error) => {
        if (alive) setError(e.message);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    const t = setInterval(() => {
      void load().catch(() => undefined);
    }, 4000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [recordingId]);

  const transcriptHighlights = useMemo(() => {
    const keywords = /satıldı|satildi|gitti|aldi|aldı|kazandi|kazandı|tl\b|\d+\s*tl/i;
    return segments
      .filter((s) => keywords.test(String(s.text ?? "")))
      .slice(0, 24);
  }, [segments]);

  const ocrHighlights = useMemo(() => {
    return events
      .filter((e) => {
        const t = String(e.event_type ?? "").toLowerCase();
        return t.includes("ocr") || t.includes("overlay") || t.includes("price");
      })
      .slice(0, 24);
  }, [events]);

  async function review(saleId: string, status: string) {
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

  async function openEvidencePlayer(saleId: string, productTitle: string | null) {
    setBusyId(saleId);
    setError(null);
    try {
      const d = await api.evidence(saleId);
      const ms = resolveOffsetMs({
        offsetMs: d.offsetMs,
        evidence: d.evidence,
        productTitle:
          productTitle ??
          (d.sale.product_title != null ? String(d.sale.product_title) : null),
        auctionEvent: d.auctionEvent,
      });
      if (ms == null) {
        setError("Bu satış için video zaman damgası bulunamadı.");
        return;
      }
      setPlayer({ saleId, offsetMs: ms });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  }

  if (loading && !report) {
    return (
      <div className="mx-auto max-w-[1100px]">
        <LoadingState label="Rapor yükleniyor…" />
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
        title={report.headline || `@${report.sellerUsername}`}
        lead={`${formatDateTr(report.recordedAt ?? report.uploadedAt)} · ${formatDuration(report.durationSeconds)} · ${report.originalFilename}`}
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

      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-5">
        {[
          { l: "Durum", v: statusTr(report.status) },
          { l: "Satış", v: String(report.saleCount) },
          { l: "Toplam", v: formatTry(report.sumAmountTry) },
          { l: "Güven", v: confidenceLabel(report.avgEventConfidence) },
          {
            l: "İnceleme",
            v: String(report.needsReviewCount),
          },
        ].map((s) => (
          <div key={s.l} className="rounded-2xl border border-line bg-panel/70 px-4 py-3">
            <span className="text-xs font-semibold uppercase tracking-wide text-fog">
              {s.l}
            </span>
            <strong className="mt-1 block font-display text-lg">{s.v}</strong>
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
          <CardTitle>Ürün / satış tablosu</CardTitle>
        </CardHeader>
        <CardContent>
          {!report.sales.length ? (
            <EmptyState
              title="Satış adayı yok"
              hint="Analiz tamamlandığında tespit edilen satışlar burada listelenir."
            />
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH>Ürün</TH>
                  <TH>Alıcı</TH>
                  <TH>Tutar</TH>
                  <TH>Durum</TH>
                  <TH>Kanıt</TH>
                  <TH>İşlem</TH>
                </TR>
              </THead>
              <TBody>
                {report.sales.map((s) => (
                  <TR key={s.id}>
                    <TD>{s.productTitle ?? "—"}</TD>
                    <TD>{s.buyerUsername ? `@${s.buyerUsername}` : "—"}</TD>
                    <TD>{formatTry(s.amountTry)}</TD>
                    <TD>
                      <Badge variant={saleBadge(s.status)}>
                        {statusTr(s.status)}
                      </Badge>
                    </TD>
                    <TD>
                      <div className="flex flex-col gap-1">
                        <button
                          type="button"
                          className="inline-flex items-center gap-1 text-left text-sm font-semibold text-mint hover:text-mint-bright"
                          disabled={busyId === s.id}
                          onClick={() =>
                            void openEvidencePlayer(s.id, s.productTitle)
                          }
                        >
                          <Film className="h-3.5 w-3.5" />
                          Görüntüyü incele
                        </button>
                        <Link
                          to={`/evidence/${s.id}`}
                          className="text-sm font-semibold text-fog hover:text-mint"
                        >
                          Kanıt paneli →
                        </Link>
                      </div>
                    </TD>
                    <TD>
                      <div className="flex flex-wrap gap-1.5">
                        <Button
                          size="sm"
                          disabled={busyId === s.id || player?.saleId !== s.id}
                          title={
                            player?.saleId !== s.id
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
                          disabled={busyId === s.id || player?.saleId !== s.id}
                          title={
                            player?.saleId !== s.id
                              ? "Önce görüntüyü inceleyin"
                              : undefined
                          }
                          onClick={() => void review(s.id, "rejected")}
                        >
                          Reddet
                        </Button>
                      </div>
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <div className="mb-4 grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Transkript vurguları</CardTitle>
          </CardHeader>
          <CardContent>
            {!transcriptHighlights.length ? (
              <EmptyState
                title="Vurgu yok"
                hint={
                  report.transcriptSegmentCount
                    ? "Satış anahtar kelimesi bulunamadı."
                    : "ASR tamamlanınca segmentler dolar."
                }
              />
            ) : (
              <ul className="space-y-2">
                {transcriptHighlights.map((s) => (
                  <li
                    key={String(s.id)}
                    className="rounded-xl border border-line/80 bg-ink/30 px-3 py-2 text-sm"
                  >
                    <span className="mr-2 text-xs text-fog">
                      {Number(s.start_ms)}–{Number(s.end_ms)}ms
                    </span>
                    {String(s.text)}
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>OCR / fiyat vurguları</CardTitle>
          </CardHeader>
          <CardContent>
            {!ocrHighlights.length ? (
              <EmptyState
                title="OCR vurgusu yok"
                hint={
                  Object.keys(report.eventCounts).length
                    ? "Olaylar var; OCR/fiyat etiketi bulunamadı."
                    : "Analiz olayları oluşunca burada görünür."
                }
              />
            ) : (
              <ul className="space-y-2">
                {ocrHighlights.map((e) => (
                  <li
                    key={String(e.id)}
                    className="rounded-xl border border-line/80 bg-ink/30 px-3 py-2 text-sm"
                  >
                    <Badge variant="muted" className="mr-2">
                      {String(e.event_type)}
                    </Badge>
                    <span className="text-fog">
                      offset {String(e.offset_ms ?? "—")} · güven{" "}
                      {e.confidence != null
                        ? Number(e.confidence).toFixed(2)
                        : "—"}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {!!Object.keys(report.eventCounts).length && (
              <p className="mt-3 text-xs text-fog">
                Olay özeti:{" "}
                {Object.entries(report.eventCounts)
                  .map(([k, v]) => `${k}:${v}`)
                  .join(" · ")}
              </p>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>İş kuyruğu</CardTitle>
        </CardHeader>
        <CardContent>
          {!report.jobs.length ? (
            <EmptyState title="İş yok" />
          ) : (
            <div className="space-y-3">
              {report.jobs.map((j, i) => (
                <div key={`${j.jobType}-${i}`}>
                  <div className="mb-1 flex items-center justify-between gap-2">
                    <strong className="text-sm">{j.jobType}</strong>
                    <Badge variant="muted">{statusTr(j.status)}</Badge>
                  </div>
                  <div className="h-1.5 overflow-hidden rounded-full bg-white/10">
                    <i
                      className="block h-full rounded-full bg-gradient-to-r from-mint to-signal transition-all"
                      style={{ width: `${j.progressPercent || 0}%` }}
                    />
                  </div>
                  {j.stage ? (
                    <p className="mt-1 text-xs text-fog">{j.stage}</p>
                  ) : null}
                </div>
              ))}
            </div>
          )}
          <p className="mt-4 text-xs text-fog">
            Transkript segment: {report.transcriptSegmentCount} · Yorum:{" "}
            {report.commentCount} ·{" "}
            <Link to={`/recordings/${report.recordingId}`} className="text-mint">
              Kayıt detayı
            </Link>
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
