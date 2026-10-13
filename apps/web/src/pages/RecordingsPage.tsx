import { FormEvent, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../lib/api";
import { EmptyState, ErrorState, LoadingState } from "../components/States";

export function RecordingsPage() {
  const [rows, setRows] = useState<Array<Record<string, unknown>>>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [ok, setOk] = useState<string | null>(null);

  async function refresh() {
    const data = await api.recordings();
    setRows(data.recordings);
  }

  useEffect(() => {
    refresh()
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setOk(null);
    const fd = new FormData(e.currentTarget);
    try {
      const res = await api.upload(fd);
      setOk(`Yüklendi · ${res.recordingId.slice(0, 8)}…`);
      e.currentTarget.reset();
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Kayıtlar</h1>
          <p className="lead">
            Satıcıya ait MP4 canlı kaydını yükleyin. Süre ve çözünürlük otomatik
            algılanır; ses/kare çıkarma kuyruğa alınır.
          </p>
        </div>
      </div>

      <section className="hero-upload">
        <h2>MP4 yükle</h2>
        <form className="row" onSubmit={onSubmit}>
          <label>
            Dosya (.mp4)
            <input name="file" type="file" accept="video/mp4,.mp4" required />
          </label>
          <label>
            Instagram kullanıcı adı
            <input
              name="sellerInstagramUsername"
              placeholder="ornek_satici"
              required
            />
          </label>
          <label>
            Kayıt tarihi
            <input
              name="recordedAt"
              type="datetime-local"
              required
              defaultValue={new Date().toISOString().slice(0, 16)}
            />
          </label>
          <label>
            Not
            <input name="notes" placeholder="opsiyonel" />
          </label>
          <button type="submit" disabled={busy}>
            {busy ? "Yükleniyor…" : "Yükle ve işle"}
          </button>
        </form>
        {ok && (
          <p style={{ marginBottom: 0 }}>
            <span className="badge ok">{ok}</span>
          </p>
        )}
      </section>

      {error && <ErrorState message={error} />}
      {loading && <LoadingState label="Kayıtlar yükleniyor…" />}

      {!loading && (
        <div className="panel">
          <h2>Kayıt listesi</h2>
          {!rows.length ? (
            <EmptyState
              title="Henüz kayıt yok"
              hint="Yukarıdaki formdan bir MP4 yükleyerek başlayın."
            />
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Satıcı</th>
                  <th>Dosya</th>
                  <th>Durum</th>
                  <th>Süre</th>
                  <th>Çözünürlük</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={String(r.id)}>
                    <td>@{String(r.instagram_username)}</td>
                    <td>
                      <Link to={`/recordings/${r.id}`}>
                        {String(r.original_filename)}
                      </Link>
                    </td>
                    <td>
                      <span
                        className={
                          r.status === "failed"
                            ? "badge err"
                            : r.status === "complete"
                              ? "badge ok"
                              : "badge warn"
                        }
                      >
                        {String(r.status)}
                      </span>
                    </td>
                    <td>
                      {r.duration_seconds != null
                        ? `${Number(r.duration_seconds).toFixed(1)}s`
                        : "—"}
                    </td>
                    <td>
                      {r.width && r.height ? `${r.width}×${r.height}` : "—"}
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
