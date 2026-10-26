import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowRight, FileBarChart2, Radio } from "lucide-react";
import { api } from "@/lib/api";
import { ErrorState, LoadingState, PageHeader } from "@/components/States";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

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
    <div className="mx-auto max-w-[1100px] animate-rise">
      <section className="relative mb-6 overflow-hidden rounded-[1.5rem] bg-gradient-to-br from-[#0f2a2a] via-[#0d1a28] to-[#0a1520] px-[clamp(1.3rem,3vw,2rem)] py-[clamp(1.4rem,3vw,2rem)] text-paper shadow-[0_22px_60px_rgba(0,0,0,0.35)]">
        <div
          className="pointer-events-none absolute -right-16 -top-20 h-72 w-72 rounded-full bg-[radial-gradient(circle,rgba(45,212,191,0.28),transparent_65%)] animate-drift"
          aria-hidden
        />
        <p className="relative z-[1] font-display text-[clamp(2.3rem,5vw,3.5rem)] font-extrabold tracking-[-0.05em] leading-none">
          mezat<span className="text-mint-bright">izle</span>
        </p>
        <p className="relative z-[1] mt-3 max-w-[46ch] text-[0.98rem] text-fog">
          Canlı mezât yayınını yerelde kaydedin, olayları çıkarın, satış
          adaylarını raporlayın — Instagram girişi ve ücretli API olmadan.
        </p>
      </section>

      <PageHeader
        title="Panel"
        lead="Operasyon özeti ve hızlı eylemler. Analiz bitince raporlar hazır olur."
        actions={
          <>
            <Link
              to="/recordings"
              className="inline-flex h-10 items-center gap-2 rounded-xl bg-mint px-4 text-sm font-semibold text-ink shadow-[0_10px_28px_rgba(45,212,191,0.22)]"
            >
              <Radio className="h-4 w-4" />
              Canlı yayın ekle
            </Link>
            <Link
              to="/reports"
              className="inline-flex h-10 items-center gap-2 rounded-xl border border-line bg-white/5 px-4 text-sm font-semibold text-fog hover:bg-white/10 hover:text-paper"
            >
              <FileBarChart2 className="h-4 w-4" />
              Raporlar
            </Link>
          </>
        }
      />

      {loading && <LoadingState label="Panel verileri alınıyor…" />}
      {error && <ErrorState message={`API bağlantısı: ${error}`} />}

      {!loading && !error && (
        <>
          <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
            {[
              { v: recordings.total ?? "0", l: "Toplam kayıt" },
              { v: recordings.complete ?? "0", l: "Tamamlanan" },
              { v: sales.needs_review ?? "0", l: "İnceleme bekleyen" },
              { v: jobs.queued ?? "0", l: "Kuyruktaki iş" },
            ].map((s) => (
              <div
                key={s.l}
                className="rounded-2xl border border-line bg-panel/70 px-4 py-4 backdrop-blur-md transition-transform duration-200 hover:-translate-y-0.5"
              >
                <strong className="font-display block text-[2rem] leading-none tracking-tight">
                  {s.v}
                </strong>
                <span className="mt-2 block text-sm font-medium text-fog">{s.l}</span>
              </div>
            ))}
          </div>

          <Card>
            <CardHeader>
              <CardTitle>Hızlı başlangıç</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="mb-4 text-sm text-fog">
                Profil:{" "}
                <Badge variant="ok">{String(data?.profile ?? "LOCAL")}</Badge> ·
                Harcama: ${String(data?.spentUsd ?? 0)}
              </p>
              <div className="flex flex-wrap gap-2">
                <Link
                  to="/recordings"
                  className="inline-flex h-10 items-center gap-2 rounded-xl bg-mint px-4 text-sm font-semibold text-ink"
                >
                  Canlı yayın ekle
                  <ArrowRight className="h-4 w-4" />
                </Link>
                <Link
                  to="/reports"
                  className="inline-flex h-10 items-center gap-2 rounded-xl border border-line px-4 text-sm font-semibold text-fog hover:text-paper"
                >
                  Raporlara git
                </Link>
                <Link
                  to="/evidence"
                  className="inline-flex h-10 items-center gap-2 rounded-xl border border-line px-4 text-sm font-semibold text-fog hover:text-paper"
                >
                  Kanıt incele
                </Link>
              </div>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
