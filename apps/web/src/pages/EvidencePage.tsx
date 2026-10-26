import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { Film } from "lucide-react";
import { api } from "@/lib/api";
import { resolveOffsetMs } from "@/lib/seek";
import { formatTry, statusTr } from "@/lib/utils";
import { EvidencePlayer } from "@/components/EvidencePlayer";
import { EmptyState, ErrorState, LoadingState, PageHeader } from "@/components/States";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, Select } from "@/components/ui/input";

export function EvidencePage() {
  const { id } = useParams();
  const [sales, setSales] = useState<Array<Record<string, unknown>>>([]);
  const [selected, setSelected] = useState<string | null>(id ?? null);
  const [evidence, setEvidence] = useState<Array<Record<string, unknown>>>([]);
  const [sale, setSale] = useState<Record<string, unknown> | null>(null);
  const [auctionEvent, setAuctionEvent] = useState<Record<string, unknown> | null>(
    null,
  );
  const [apiOffsetMs, setApiOffsetMs] = useState<number | null>(null);
  const [explanationTr, setExplanationTr] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [playerOpen, setPlayerOpen] = useState(false);
  const [mediaPurged, setMediaPurged] = useState(false);
  const [mediaPurgedNoteTr, setMediaPurgedNoteTr] = useState<string | null>(
    null,
  );

  useEffect(() => {
    api
      .sales()
      .then((d) => {
        setSales(d.sales);
        if (!selected && d.sales[0]) setSelected(String(d.sales[0].id));
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!selected) return;
    setBusy(true);
    setPlayerOpen(false);
    api
      .evidence(selected)
      .then((d) => {
        setSale(d.sale);
        setEvidence(d.evidence);
        setAuctionEvent(d.auctionEvent ?? null);
        setApiOffsetMs(d.offsetMs ?? null);
        setExplanationTr(d.explanationTr ?? null);
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setBusy(false));
  }, [selected]);

  const offsetMs = useMemo(
    () =>
      resolveOffsetMs({
        offsetMs: apiOffsetMs,
        evidence,
        productTitle:
          sale?.product_title != null ? String(sale.product_title) : null,
        auctionEvent,
      }),
    [apiOffsetMs, evidence, sale, auctionEvent],
  );

  const recordingId =
    sale?.recording_id != null ? String(sale.recording_id) : null;

  useEffect(() => {
    if (!recordingId) {
      setMediaPurged(false);
      setMediaPurgedNoteTr(null);
      return;
    }
    let alive = true;
    api
      .recording(recordingId)
      .then((d) => {
        if (!alive) return;
        const r = (d?.recording ?? {}) as Record<string, unknown>;
        const purged =
          r.mediaPurged === true ||
          (r.media_purged_at != null && String(r.media_purged_at).trim() !== "");
        setMediaPurged(purged);
        setMediaPurgedNoteTr(
          r.mediaPurgedNoteTr != null ? String(r.mediaPurgedNoteTr) : null,
        );
      })
      .catch(() => {
        if (!alive) return;
        setMediaPurged(false);
        setMediaPurgedNoteTr(null);
      });
    return () => {
      alive = false;
    };
  }, [recordingId]);

  async function review(status: string) {
    if (!selected) return;
    setBusy(true);
    try {
      await api.reviewSale(selected, status);
      const d = await api.evidence(selected);
      setSale(d.sale);
      setEvidence(d.evidence);
      setAuctionEvent(d.auctionEvent ?? null);
      setApiOffsetMs(d.offsetMs ?? null);
      setExplanationTr(d.explanationTr ?? null);
      const list = await api.sales();
      setSales(list.sales);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const saleStatus = sale ? String(sale.status) : "";

  return (
    <div className="mx-auto max-w-[1100px] animate-rise">
      <PageHeader
        title="Kanıt inceleme"
        lead="Onay / red öncesi ilgili video dilimini izleyin ve dinleyin. Görüntü muxed kayıttan açılır."
      />

      {error && <ErrorState message={error} className="mb-4" />}
      {loading && <LoadingState />}

      {!loading && !sales.length && (
        <EmptyState
          title="İncelenecek satış yok"
          hint="Önce bir kayıt yükleyip işlemenin bitmesini bekleyin."
        />
      )}

      {!loading && !!sales.length && (
        <>
          <Card className="mb-4">
            <CardContent className="flex flex-wrap items-end gap-3 pt-5">
              <Field label="Satış seç" className="min-w-[220px] flex-1">
                <Select
                  value={selected ?? ""}
                  onChange={(e) => setSelected(e.target.value)}
                >
                  <option value="" disabled>
                    Seçin
                  </option>
                  {sales.map((s) => (
                    <option key={String(s.id)} value={String(s.id)}>
                      {String(s.product_title ?? s.id)} ({statusTr(String(s.status))})
                    </option>
                  ))}
                </Select>
              </Field>
              {sale && recordingId && offsetMs != null && (
                <Button
                  type="button"
                  onClick={() => setPlayerOpen(true)}
                  disabled={busy}
                >
                  <Film className="h-4 w-4" />
                  Görüntüyü incele
                </Button>
              )}
              {sale && (
                <>
                  <Button
                    type="button"
                    disabled={busy || !playerOpen}
                    title={
                      !playerOpen
                        ? "Önce görüntüyü inceleyin"
                        : undefined
                    }
                    onClick={() => review("confirmed")}
                  >
                    Onayla
                  </Button>
                  <Button
                    type="button"
                    variant="danger"
                    disabled={busy || !playerOpen}
                    title={
                      !playerOpen
                        ? "Önce görüntüyü inceleyin"
                        : undefined
                    }
                    onClick={() => review("rejected")}
                  >
                    Reddet
                  </Button>
                  {recordingId ? (
                    <Link
                      to={`/reports/${recordingId}`}
                      className="inline-flex h-10 items-center rounded-xl border border-line px-4 text-sm font-semibold text-fog hover:text-paper"
                    >
                      Rapora dön
                    </Link>
                  ) : (
                    <Link
                      to="/reports"
                      className="inline-flex h-10 items-center rounded-xl border border-line px-4 text-sm font-semibold text-fog hover:text-paper"
                    >
                      Raporlar
                    </Link>
                  )}
                </>
              )}
            </CardContent>
          </Card>

          {busy && !sale && <LoadingState label="Kanıtlar getiriliyor…" />}

          {sale && recordingId && offsetMs != null && (
            <EvidencePlayer
              recordingId={recordingId}
              offsetMs={offsetMs}
              open={playerOpen}
              onClose={() => setPlayerOpen(false)}
              title="Kanıt videosu"
              mediaPurged={mediaPurged}
              mediaPurgedNoteTr={mediaPurgedNoteTr}
            />
          )}

          {sale && (
            <Card>
              <CardHeader>
                <CardTitle>Satış özeti</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="mb-3 text-sm">
                  Durum:{" "}
                  <Badge
                    variant={
                      saleStatus === "needs_review"
                        ? "warn"
                        : saleStatus === "confirmed"
                          ? "ok"
                          : "danger"
                    }
                  >
                    {statusTr(saleStatus)}
                  </Badge>{" "}
                  · Tutar:{" "}
                  {sale.amount_cents != null
                    ? formatTry(Number(sale.amount_cents) / 100)
                    : "—"}{" "}
                  · Alıcı:{" "}
                  {sale.buyer_username ? `@${sale.buyer_username}` : "—"}
                  {offsetMs != null ? (
                    <>
                      {" "}
                      · Zaman:{" "}
                      <span className="font-mono text-mint">
                        {(offsetMs / 1000).toFixed(1)}s
                      </span>
                    </>
                  ) : null}
                </p>
                {explanationTr ? (
                  <p className="mb-4 rounded-xl border border-line bg-ink/30 px-3 py-2 text-sm text-fog">
                    {explanationTr}
                  </p>
                ) : null}
                {!playerOpen && recordingId && offsetMs != null ? (
                  <p className="mb-4 text-sm text-amber">
                    Onay / red için önce <strong>Görüntüyü incele</strong> ile
                    ilgili dilimi izleyin.
                  </p>
                ) : null}
                {recordingId && offsetMs == null ? (
                  <p className="mb-4 text-sm text-fog">
                    Bu satış için video zaman damgası bulunamadı.
                  </p>
                ) : null}
                <h3 className="font-display mb-2 text-base font-bold">Kanıtlar</h3>
                {!evidence.length ? (
                  <EmptyState title="Kanıt kaydı yok" />
                ) : (
                  <ul className="space-y-2">
                    {evidence.map((e) => (
                      <li
                        key={String(e.id)}
                        className="rounded-xl border border-line bg-ink/30 px-3 py-2 text-sm"
                      >
                        <strong className="text-mint">{String(e.evidence_type)}</strong>{" "}
                        — {String(e.note)} ({String(e.ref_table)}/
                        {String(e.ref_id)})
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
