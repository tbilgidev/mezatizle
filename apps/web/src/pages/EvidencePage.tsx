import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api } from "@/lib/api";
import { formatTry, statusTr } from "@/lib/utils";
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
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

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
    api
      .evidence(selected)
      .then((d) => {
        setSale(d.sale);
        setEvidence(d.evidence);
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setBusy(false));
  }, [selected]);

  async function review(status: string) {
    if (!selected) return;
    setBusy(true);
    try {
      await api.reviewSale(selected, status);
      const d = await api.evidence(selected);
      setSale(d.sale);
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
        lead="Her satış adayının dayandığı olay ve referansları kontrol edin; onaylayın veya reddedin."
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
              {sale && (
                <>
                  <Button type="button" disabled={busy} onClick={() => review("confirmed")}>
                    Onayla
                  </Button>
                  <Button
                    type="button"
                    variant="danger"
                    disabled={busy}
                    onClick={() => review("rejected")}
                  >
                    Reddet
                  </Button>
                  {sale.recording_id ? (
                    <Link
                      to={`/reports/${String(sale.recording_id)}`}
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

          {sale && (
            <Card>
              <CardHeader>
                <CardTitle>Satış özeti</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="mb-4 text-sm">
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
                </p>
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
