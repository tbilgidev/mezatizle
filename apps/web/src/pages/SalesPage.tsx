import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../lib/api";
import { EmptyState, ErrorState, LoadingState } from "../components/States";

export function SalesPage() {
  const [sales, setSales] = useState<Array<Record<string, unknown>>>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api
      .sales()
      .then((d) => setSales(d.sales))
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Satışlar</h1>
          <p className="lead">
            Yerel kurallarla üretilen satış adayları. CSV ile mutabakat yapın;
            kanıttan onaylayın veya reddedin.
          </p>
        </div>
        <a className="btn" href={api.csvUrl()}>
          CSV indir
        </a>
      </div>

      {error && <ErrorState message={error} />}
      {loading && <LoadingState label="Satışlar yükleniyor…" />}

      {!loading && !error && (
        <div className="panel">
          <h2>Aday listesi</h2>
          {!sales.length ? (
            <EmptyState
              title="Satış adayı yok"
              hint="Bir kayıt işlendikten sonra satıldı olayları burada görünür."
            />
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Satıcı</th>
                  <th>Ürün</th>
                  <th>Alıcı</th>
                  <th>Tutar</th>
                  <th>Durum</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {sales.map((s) => (
                  <tr key={String(s.id)}>
                    <td>@{String(s.instagram_username)}</td>
                    <td>{String(s.product_title ?? "—")}</td>
                    <td>{s.buyer_username ? `@${s.buyer_username}` : "—"}</td>
                    <td>
                      {s.amount_cents != null
                        ? `${(Number(s.amount_cents) / 100).toFixed(0)} ${s.currency}`
                        : "—"}
                    </td>
                    <td>
                      <span
                        className={
                          s.status === "needs_review"
                            ? "badge warn"
                            : s.status === "confirmed"
                              ? "badge ok"
                              : "badge"
                        }
                      >
                        {String(s.status)}
                      </span>
                    </td>
                    <td>
                      <Link to={`/evidence/${s.id}`}>Kanıt →</Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}
