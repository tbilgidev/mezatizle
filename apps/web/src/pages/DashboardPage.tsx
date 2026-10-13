import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../lib/api";
import { ErrorState, LoadingState } from "../components/States";

export function DashboardPage() {
  const [data, setData] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api
      .dashboard()
      .then(setData)
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  const recordings = (data?.recordings ?? {}) as Record<string, string>;
  const sales = (data?.sales ?? {}) as Record<string, string>;
  const jobs = (data?.jobs ?? {}) as Record<string, string>;

  return (
    <div className="page">
      <section className="dash-hero">
        <p className="brand-mark">
          mezat<span>izle</span>
        </p>
        <p>
          Canlı mezât yayınını yerelde kaydedin, olayları çıkarın, satış
          adaylarını doğrulayın — Instagram girişi ve ücretli API olmadan.
        </p>
      </section>

      <div className="page-head">
        <div>
          <h1>Panel</h1>
          <p className="lead">
            Operasyon özeti ve hızlı eylemler. Kuyruk boşaldıkça satış incelemesi
            hazır olur.
          </p>
        </div>
        <div className="actions" style={{ marginTop: 0 }}>
          <Link className="btn" to="/recordings">
            Canlı yayın ekle
          </Link>
          <Link className="btn secondary" to="/sales">
            Satışlar
          </Link>
        </div>
      </div>

      {loading && <LoadingState label="Panel verileri alınıyor…" />}
      {error && <ErrorState message={`API bağlantısı: ${error}`} />}

      {!loading && !error && (
        <>
          <div className="grid">
            <div className="stat">
              <strong>{recordings.total ?? "0"}</strong>
              <span>Toplam kayıt</span>
            </div>
            <div className="stat">
              <strong>{recordings.complete ?? "0"}</strong>
              <span>Tamamlanan</span>
            </div>
            <div className="stat">
              <strong>{sales.needs_review ?? "0"}</strong>
              <span>İnceleme bekleyen</span>
            </div>
            <div className="stat">
              <strong>{jobs.queued ?? "0"}</strong>
              <span>Kuyruktaki iş</span>
            </div>
          </div>

          <div className="panel">
            <h2>Hızlı başlangıç</h2>
            <p className="muted" style={{ marginTop: 0 }}>
              Profil:{" "}
              <span className="badge ok">{String(data?.profile ?? "LOCAL")}</span>{" "}
              · Harcama: ${String(data?.spentUsd ?? 0)}
            </p>
            <div className="actions">
              <Link className="btn" to="/recordings">
                Canlı yayın ekle
              </Link>
              <Link className="btn secondary" to="/evidence">
                Kanıt incele
              </Link>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
