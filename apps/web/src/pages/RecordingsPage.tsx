import { FormEvent, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../lib/api";
import { EmptyState, ErrorState, LoadingState } from "../components/States";

const CAPTURE_LABEL: Record<string, string> = {
  bekleniyor: "Bekleniyor",
  kaydediliyor: "Kaydediliyor",
  bitti: "Bitti",
  bulunamadi: "Yayın bulunamadı",
  engellendi: "Erişim engellendi",
  iptal: "İptal",
  hata: "Hata",
};

function statusBadge(r: Record<string, unknown>) {
  const capture = r.capture_status ? String(r.capture_status) : "";
  const label = capture
    ? (CAPTURE_LABEL[capture] ?? capture)
    : String(r.status);
  const cls =
    capture === "engellendi" ||
    capture === "hata" ||
    r.status === "failed"
      ? "badge err"
      : capture === "bitti" || r.status === "complete"
        ? "badge ok"
        : "badge warn";
  return <span className={cls}>{label}</span>;
}

export function RecordingsPage() {
  const [rows, setRows] = useState<Array<Record<string, unknown>>>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [ok, setOk] = useState<string | null>(null);
  const [limitation, setLimitation] = useState<string | null>(null);
  const [showUpload, setShowUpload] = useState(false);

  async function refresh() {
    const data = await api.recordings();
    setRows(data.recordings);
  }

  useEffect(() => {
    refresh()
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
    const t = setInterval(() => {
      void refresh().catch(() => undefined);
    }, 8000);
    return () => clearInterval(t);
  }, []);

  async function onLiveSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setOk(null);
    const fd = new FormData(e.currentTarget);
    try {
      const durRaw = String(fd.get("maxDurationMinutes") ?? "").trim();
      const maxDurationMinutes = durRaw === "" ? null : Number(durRaw);
      const res = await api.startLive({
        input: String(fd.get("input") ?? ""),
        displayName: String(fd.get("displayName") ?? "") || undefined,
        notes: String(fd.get("notes") ?? "") || undefined,
        maxDurationMinutes:
          maxDurationMinutes != null &&
          Number.isFinite(maxDurationMinutes) &&
          maxDurationMinutes > 0
            ? maxDurationMinutes
            : null,
      });
      const durNote =
        res.maxDurationMinutes && res.maxDurationMinutes > 0
          ? ` · en fazla ${res.maxDurationMinutes} dk`
          : " · yayının tamamı";
      setOk(`Canlı oturum açıldı · ${res.recordingId.slice(0, 8)}…${durNote}`);
      setLimitation(res.policy?.limitationTr ?? null);
      e.currentTarget.reset();
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function onUploadSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setOk(null);
    const fd = new FormData(e.currentTarget);
    try {
      const res = await api.upload(fd);
      setOk(`MP4 yüklendi · ${res.recordingId.slice(0, 8)}…`);
      e.currentTarget.reset();
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function onCancel(id: string) {
    try {
      await api.cancelLive(id);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Kayıtlar</h1>
          <p className="lead">
            Satıcının canlı yayınını bağlantı veya @kullanıcı ile ekleyin. Yayın
            çözülebilirse yerelde kaydedilir; bitince analiz kuyruğuna alınır.
          </p>
        </div>
      </div>

      <section className="hero-upload">
        <h2>Canlı yayın ekle</h2>
        <p className="muted" style={{ marginTop: 0 }}>
          Instagram Live URL’si, profil linki veya <code>@kullanici</code>. Özel
          API yok. Giriş gerektiren yayınlar için{" "}
          <Link to="/settings#ig-oturum">Ayarlar → Instagram oturumu</Link>{" "}
          altına yedek hesap çerezlerini ekleyin.
        </p>
        <form className="row" onSubmit={onLiveSubmit}>
          <label style={{ gridColumn: "1 / -1" }}>
            Canlı link veya @kullanıcı
            <input
              name="input"
              placeholder="https://www.instagram.com/satici/live/  veya  @satici"
              required
            />
          </label>
          <label>
            Görünen ad (ops.)
            <input name="displayName" placeholder="Satıcı adı" />
          </label>
          <label>
            Kayıt süresi (dk)
            <input
              name="maxDurationMinutes"
              type="number"
              min={0}
              max={1440}
              step={1}
              placeholder="boş = tüm yayın"
              title="Boş veya 0: canlı bitene kadar. Örn. 10, 180."
            />
          </label>
          <label>
            Not (ops.)
            <input name="notes" placeholder="opsiyonel" />
          </label>
          <button type="submit" disabled={busy}>
            {busy ? "Ekleniyor…" : "Canlı yayın ekle"}
          </button>
          <p className="muted" style={{ gridColumn: "1 / -1", margin: 0, fontSize: "0.85rem" }}>
            Varsayılan: yayının tamamı. Süre dolunca veya yayın bitince (hangisi önce)
            kayıt sonlanır → analiz kuyruğu. Dosya kalitesi ~720p / CRF28 / AAC 80kbps
            (disk dostu, ASR+OCR için yeterli).
          </p>
        </form>
        {ok && (
          <p style={{ marginBottom: 0 }}>
            <span className="badge ok">{ok}</span>
          </p>
        )}
        {limitation && (
          <p className="muted" style={{ marginBottom: 0, fontSize: "0.9rem" }}>
            {limitation}
          </p>
        )}
      </section>

      <details
        className="panel"
        open={showUpload}
        onToggle={(e) => setShowUpload((e.target as HTMLDetailsElement).open)}
      >
        <summary style={{ cursor: "pointer", fontWeight: 600 }}>
          Gelişmiş · Elle MP4 yükle
        </summary>
        <p className="muted">
          Zaten elinizde olan satıcıya ait MP4 kaydı için. Birincil yol canlı
          yayındır.
        </p>
        <form className="row" onSubmit={onUploadSubmit}>
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
          <button className="secondary" type="submit" disabled={busy}>
            {busy ? "Yükleniyor…" : "MP4 yükle"}
          </button>
        </form>
      </details>

      {error && <ErrorState message={error} />}
      {loading && <LoadingState label="Kayıtlar yükleniyor…" />}

      {!loading && (
        <div className="panel">
          <h2>Kayıt listesi</h2>
          {!rows.length ? (
            <EmptyState
              title="Henüz kayıt yok"
              hint="Yukarıdan bir canlı yayın ekleyerek başlayın."
            />
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Satıcı</th>
                  <th>Kaynak</th>
                  <th>Durum</th>
                  <th>Boyut</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={String(r.id)}>
                    <td>@{String(r.instagram_username)}</td>
                    <td>
                      <Link to={`/recordings/${r.id}`}>
                        {String(r.source_type) === "live"
                          ? "Canlı"
                          : String(r.original_filename)}
                      </Link>
                      {r.source_url ? (
                        <div className="muted" style={{ fontSize: "0.8rem" }}>
                          {String(r.source_url)}
                        </div>
                      ) : null}
                      {r.last_probe_detail || r.capture_error ? (
                        <div className="muted" style={{ fontSize: "0.8rem" }}>
                          {String(r.capture_error || r.last_probe_detail)}
                        </div>
                      ) : null}
                    </td>
                    <td>{statusBadge(r)}</td>
                    <td>
                      {r.capture_bytes != null && Number(r.capture_bytes) > 0
                        ? `${(Number(r.capture_bytes) / (1024 * 1024)).toFixed(1)} MB`
                        : r.file_size_bytes != null
                          ? `${(Number(r.file_size_bytes) / (1024 * 1024)).toFixed(1)} MB`
                          : "—"}
                    </td>
                    <td>
                      {String(r.source_type) === "live" &&
                      (r.status === "awaiting_live" ||
                        r.status === "recording") ? (
                        <button
                          type="button"
                          className="secondary"
                          onClick={() => void onCancel(String(r.id))}
                        >
                          İptal
                        </button>
                      ) : null}
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
