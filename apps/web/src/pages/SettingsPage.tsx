import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { ErrorState, LoadingState } from "../components/States";

export function SettingsPage() {
  const [settings, setSettings] = useState<Record<string, unknown> | null>(
    null,
  );
  const [metrics, setMetrics] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([api.settings(), api.metrics()])
      .then(([s, m]) => {
        setSettings(s);
        setMetrics(m);
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  const profile = (settings?.profile ?? {}) as Record<string, unknown>;
  const capture = (settings?.capture ?? {}) as Record<string, unknown>;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Ayarlar</h1>
          <p className="lead">
            İşleme profili, harcama limiti ve yakalama politikası. Gizli
            anahtarlar yalnızca ortam değişkenlerinden okunur.
          </p>
        </div>
      </div>

      {loading && <LoadingState label="Ayarlar yükleniyor…" />}
      {error && <ErrorState message={error} />}

      {!loading && settings && (
        <>
          <div className="panel">
            <h2>Profil</h2>
            <p>
              <span className="badge ok">
                {String(profile.profile ?? "LOCAL")}
              </span>
            </p>
            <ul className="muted">
              <li>ASR: {String(profile.asrBackend)}</li>
              <li>OCR: {String(profile.ocrBackend)}</li>
              <li>LLM: {String(profile.llmBackend)}</li>
              <li>Ücretli API: {String(profile.allowPaidApis)}</li>
              <li>
                Sert harcama limiti: ${String(settings?.hardSpendLimitUsd ?? 0)}{" "}
                · Harcanan: ${String(settings?.spentUsd ?? 0)}
              </li>
              <li>Maks. yükleme: {String(settings?.maxUploadBytes)} bayt</li>
            </ul>
          </div>
          <div className="panel">
            <h2>Yakalama (Modül H)</h2>
            <p>{String(capture.message)}</p>
            <ul>
              {((capture.restrictions as string[]) ?? []).map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          </div>
          <div className="panel">
            <h2>Metrikler</h2>
            <pre
              className="muted"
              style={{ whiteSpace: "pre-wrap", fontSize: "0.85rem" }}
            >
              {JSON.stringify(metrics, null, 2)}
            </pre>
          </div>
        </>
      )}
    </div>
  );
}
