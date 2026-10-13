import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api } from "../lib/api";
import { EmptyState, ErrorState, LoadingState } from "../components/States";

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

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Kanıt inceleme</h1>
          <p className="lead">
            Her satış adayının dayandığı olay ve referansları kontrol edin;
            onaylayın veya reddedin.
          </p>
        </div>
      </div>

      {error && <ErrorState message={error} />}
      {loading && <LoadingState />}

      {!loading && !sales.length && (
        <EmptyState
          title="İncelenecek satış yok"
          hint="Önce bir kayıt yükleyip işlemenin bitmesini bekleyin."
        />
      )}

      {!loading && !!sales.length && (
        <>
          <div className="panel row">
            <label>
              Satış seç
              <select
                value={selected ?? ""}
                onChange={(e) => setSelected(e.target.value)}
              >
                <option value="" disabled>
                  Seçin
                </option>
                {sales.map((s) => (
                  <option key={String(s.id)} value={String(s.id)}>
                    {String(s.product_title ?? s.id)} ({String(s.status)})
                  </option>
                ))}
              </select>
            </label>
            {sale && (
              <>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => review("confirmed")}
                >
                  Onayla
                </button>
                <button
                  type="button"
                  className="danger"
                  disabled={busy}
                  onClick={() => review("rejected")}
                >
                  Reddet
                </button>
                <Link className="btn secondary" to="/sales">
                  Satış listesi
                </Link>
              </>
            )}
          </div>

          {busy && !sale && <LoadingState label="Kanıtlar getiriliyor…" />}

          {sale && (
            <div className="panel">
              <h2>Satış özeti</h2>
              <p>
                Durum:{" "}
                <span
                  className={
                    sale.status === "needs_review"
                      ? "badge warn"
                      : sale.status === "confirmed"
                        ? "badge ok"
                        : "badge err"
                  }
                >
                  {String(sale.status)}
                </span>{" "}
                · Tutar:{" "}
                {sale.amount_cents != null
                  ? `${Number(sale.amount_cents) / 100} TRY`
                  : "—"}{" "}
                · Alıcı: {sale.buyer_username ? `@${sale.buyer_username}` : "—"}
              </p>
              <h2>Kanıtlar</h2>
              {!evidence.length ? (
                <EmptyState title="Kanıt kaydı yok" />
              ) : (
                <ul>
                  {evidence.map((e) => (
                    <li key={String(e.id)}>
                      <strong>{String(e.evidence_type)}</strong> —{" "}
                      {String(e.note)} ({String(e.ref_table)}/
                      {String(e.ref_id)})
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
