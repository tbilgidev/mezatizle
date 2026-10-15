import { FormEvent, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "@/lib/api";
import { statusTr } from "@/lib/utils";
import { EmptyState, ErrorState, LoadingState, PageHeader } from "@/components/States";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, Input } from "@/components/ui/input";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";

function statusBadge(r: Record<string, unknown>) {
  const capture = r.capture_status ? String(r.capture_status) : "";
  const label = capture ? statusTr(capture) : statusTr(String(r.status));
  const variant =
    capture === "engellendi" ||
    capture === "hata" ||
    r.status === "failed"
      ? "danger"
      : capture === "bitti" || r.status === "complete"
        ? "ok"
        : "warn";
  return <Badge variant={variant as "ok" | "warn" | "danger"}>{label}</Badge>;
}

/** Prefer API lastError (TR) under waiting / not-found / blocked captures. */
function captureLastError(r: Record<string, unknown>): string | null {
  const capture = r.capture_status ? String(r.capture_status) : "";
  const showUnder = new Set(["bekleniyor", "bulunamadi", "engellendi", "hata"]);
  if (capture && !showUnder.has(capture)) return null;
  const msg =
    r.lastError ??
    r.last_error ??
    r.capture_error ??
    r.last_probe_detail ??
    r.error_message;
  if (msg == null) return null;
  const s = String(msg).trim();
  return s.length ? s : null;
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
    const form = e.currentTarget;
    setBusy(true);
    setError(null);
    setOk(null);
    setLimitation(null);
    const fd = new FormData(form);
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
      form.reset();
      await refresh();
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Canlı yayın eklenemedi. Bağlantıyı veya oturumu kontrol edin.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function onUploadSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    setBusy(true);
    setError(null);
    setOk(null);
    const fd = new FormData(form);
    try {
      const res = await api.upload(fd);
      setOk(`MP4 yüklendi · ${res.recordingId.slice(0, 8)}…`);
      form.reset();
      await refresh();
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "MP4 yükleme başarısız. Dosyayı ve satıcı adını kontrol edin.",
      );
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
    <div className="mx-auto max-w-[1100px] animate-rise">
      <PageHeader
        title="Kayıtlar"
        lead="Satıcının canlı yayınını bağlantı veya @kullanıcı ile ekleyin. Yayın çözülebilirse yerelde kaydedilir; bitince analiz kuyruğuna alınır."
      />

      <section className="relative mb-4 overflow-hidden rounded-[1.35rem] border border-line bg-gradient-to-br from-mint/10 via-panel to-panel-2 p-5 shadow-[0_18px_50px_rgba(0,0,0,0.25)]">
        <h2 className="font-display mb-1 text-xl font-bold tracking-tight">
          Canlı yayın ekle
        </h2>
        <p className="mb-4 text-sm text-fog">
          Instagram Live URL’si, profil linki veya <code>@kullanici</code>. Giriş
          gerektiren yayınlar için{" "}
          <Link to="/settings#ig-oturum" className="text-mint hover:underline">
            Ayarlar → Instagram oturumu
          </Link>
          .
        </p>
        <form className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" onSubmit={onLiveSubmit}>
          <Field label="Canlı link veya @kullanıcı" className="sm:col-span-2 lg:col-span-4">
            <Input
              name="input"
              placeholder="https://www.instagram.com/satici/live/  veya  @satici"
              required
            />
          </Field>
          <Field label="Görünen ad (ops.)">
            <Input name="displayName" placeholder="Satıcı adı" />
          </Field>
          <Field label="Kayıt süresi (dk)">
            <Input
              name="maxDurationMinutes"
              type="number"
              min={0}
              max={1440}
              step={1}
              placeholder="boş = tüm yayın"
            />
          </Field>
          <Field label="Not (ops.)">
            <Input name="notes" placeholder="opsiyonel" />
          </Field>
          <div className="flex items-end">
            <Button type="submit" disabled={busy} className="w-full">
              {busy ? "Ekleniyor…" : "Canlı yayın ekle"}
            </Button>
          </div>
        </form>
        <p className="mt-3 text-xs text-fog">
          Varsayılan: yayının tamamı. Süre dolunca veya yayın bitince kayıt
          sonlanır → analiz. Dosya ~720p / CRF28 / AAC 80kbps.
        </p>
        {ok && (
          <p className="mt-3">
            <Badge variant="ok">{ok}</Badge>
          </p>
        )}
        {limitation && <p className="mt-2 text-sm text-fog">{limitation}</p>}
      </section>

      <details
        className="mb-4 rounded-2xl border border-line bg-panel/70 px-5 py-4"
        open={showUpload}
        onToggle={(e) => setShowUpload((e.target as HTMLDetailsElement).open)}
      >
        <summary className="cursor-pointer font-semibold text-paper">
          Gelişmiş · Elle MP4 yükle
        </summary>
        <p className="mt-2 text-sm text-fog">
          Zaten elinizde olan satıcıya ait MP4 için. Birincil yol canlı yayındır.
        </p>
        <form className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4" onSubmit={onUploadSubmit}>
          <Field label="Dosya (.mp4)">
            <Input name="file" type="file" accept="video/mp4,.mp4" required />
          </Field>
          <Field label="Instagram kullanıcı adı">
            <Input name="sellerInstagramUsername" placeholder="ornek_satici" required />
          </Field>
          <Field label="Kayıt tarihi">
            <Input
              name="recordedAt"
              type="datetime-local"
              required
              defaultValue={new Date().toISOString().slice(0, 16)}
            />
          </Field>
          <Field label="Not">
            <Input name="notes" placeholder="opsiyonel" />
          </Field>
          <div className="flex items-end">
            <Button type="submit" variant="secondary" disabled={busy}>
              {busy ? "Yükleniyor…" : "MP4 yükle"}
            </Button>
          </div>
        </form>
      </details>

      {error && <ErrorState message={error} className="mb-4" />}
      {loading && <LoadingState label="Kayıtlar yükleniyor…" />}

      {!loading && (
        <Card>
          <CardHeader>
            <CardTitle>Kayıt listesi</CardTitle>
          </CardHeader>
          <CardContent>
            {!rows.length ? (
              <EmptyState
                title="Henüz kayıt yok"
                hint="Yukarıdan bir canlı yayın ekleyerek başlayın."
              />
            ) : (
              <Table>
                <THead>
                  <TR>
                    <TH>Satıcı</TH>
                    <TH>Kaynak</TH>
                    <TH>Durum</TH>
                    <TH>Boyut</TH>
                    <TH></TH>
                  </TR>
                </THead>
                <TBody>
                  {rows.map((r) => (
                    <TR key={String(r.id)}>
                      <TD>@{String(r.instagram_username)}</TD>
                      <TD>
                        <Link
                          to={`/recordings/${r.id}`}
                          className="font-semibold text-mint hover:text-mint-bright"
                        >
                          {String(r.source_type) === "live"
                            ? "Canlı"
                            : String(r.original_filename)}
                        </Link>
                        {r.source_url ? (
                          <div className="mt-0.5 max-w-[28rem] truncate text-xs text-fog">
                            {String(r.source_url)}
                          </div>
                        ) : null}
                        {(() => {
                          const err = captureLastError(r);
                          if (!err) return null;
                          return (
                            <div
                              className="mt-0.5 max-w-[28rem] text-xs text-amber"
                              title={err}
                            >
                              {err}
                            </div>
                          );
                        })()}
                      </TD>
                      <TD>{statusBadge(r)}</TD>
                      <TD>
                        {r.capture_bytes != null && Number(r.capture_bytes) > 0
                          ? `${(Number(r.capture_bytes) / (1024 * 1024)).toFixed(1)} MB`
                          : r.file_size_bytes != null
                            ? `${(Number(r.file_size_bytes) / (1024 * 1024)).toFixed(1)} MB`
                            : "—"}
                      </TD>
                      <TD>
                        <div className="flex flex-wrap gap-2">
                          <Link
                            to={`/reports/${r.id}`}
                            className="text-sm font-semibold text-fog hover:text-mint"
                          >
                            Rapor
                          </Link>
                          {String(r.source_type) === "live" &&
                          (r.status === "awaiting_live" ||
                            r.status === "recording") ? (
                            <Button
                              type="button"
                              size="sm"
                              variant="secondary"
                              onClick={() => void onCancel(String(r.id))}
                            >
                              İptal
                            </Button>
                          ) : null}
                        </div>
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
