import { FormEvent, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "@/lib/api";
import {
  analysisProgressInfo,
  isAnalysisRunning,
} from "@/lib/analysis-progress";
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

/** Master MP4 exists (finalized or in-progress bytes) — show Video open link. */
function hasPlayableMedia(r: Record<string, unknown>): boolean {
  const capture = String(r.capture_status ?? "");
  if (capture === "bitti" || capture === "kaydediliyor") return true;
  const status = String(r.status ?? "");
  if (status === "recording") return true;
  const bytes = Number(r.capture_bytes ?? r.file_size_bytes ?? 0);
  return Number.isFinite(bytes) && bytes >= 64_000;
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

type ReportLinkTone = "green" | "yellow" | "red";

/**
 * Color Rapor by analysis phase.
 * Prefer API `analysisState` (done|running|none|failed) — `status=complete`
 * can still be running. Fall back to status only if analysisState missing.
 */
function reportLinkTone(r: Record<string, unknown>): {
  tone: ReportLinkTone;
  title: string;
  className: string;
} {
  const analysisState = String(
    r.analysisState ?? r.analysis_state ?? "",
  ).toLowerCase();
  const status = String(r.status ?? "");

  if (analysisState === "done") {
    const progress = analysisProgressInfo(r);
    return {
      tone: "green",
      title: progress?.label ?? "Analiz tamam — rapor hazır",
      className: "text-emerald hover:text-emerald/80",
    };
  }
  if (analysisState === "running") {
    const progress = analysisProgressInfo(r);
    return {
      tone: "yellow",
      title: progress?.label ?? `Analiz sürüyor${status ? ` (${statusTr(status)})` : ""}`,
      className: "text-amber hover:text-amber/80",
    };
  }
  if (analysisState === "failed") {
    const progress = analysisProgressInfo(r);
    return {
      tone: "red",
      title: progress?.label ?? "Analiz başarısız — rapor sınırlı olabilir",
      className: "text-rose hover:text-rose/80",
    };
  }
  if (analysisState === "none") {
    const title =
      status === "awaiting_live" || status === "recording"
        ? "Kayıt henüz bitmedi — analiz yok"
        : status === "cancelled"
          ? "İptal — analiz yok"
          : "Henüz analiz edilmedi";
    return {
      tone: "red",
      title,
      className: "text-rose hover:text-rose/80",
    };
  }

  // Fallback when analysisState absent (older API)
  if (status === "complete") {
    return {
      tone: "green",
      title: "Analiz tamam — rapor hazır",
      className: "text-emerald hover:text-emerald/80",
    };
  }
  const inProgress = new Set([
    "probing",
    "ready",
    "extracting",
    "extracted",
    "transcribing",
    "analyzing",
  ]);
  if (inProgress.has(status)) {
    const progress = analysisProgressInfo(r);
    return {
      tone: "yellow",
      title: progress?.label ?? `Analiz sürüyor (${statusTr(status)})`,
      className: "text-amber hover:text-amber/80",
    };
  }
  const title =
    status === "failed"
      ? "Analiz başarısız — rapor sınırlı olabilir"
      : status === "cancelled"
        ? "İptal — analiz yok"
        : status === "awaiting_live" || status === "recording"
          ? "Kayıt henüz bitmedi — analiz yok"
          : "Henüz analiz edilmedi";
  return {
    tone: "red",
    title,
    className: "text-rose hover:text-rose/80",
  };
}

export function RecordingsPage() {
  const [rows, setRows] = useState<Array<Record<string, unknown>>>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [ok, setOk] = useState<string | null>(null);
  const [limitation, setLimitation] = useState<string | null>(null);
  const [showUpload, setShowUpload] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  async function refresh() {
    const data = await api.recordings();
    const list = Array.isArray(data.recordings) ? data.recordings : [];
    setRows(list);
    // Drop selections that no longer exist
    setSelectedIds((prev) => {
      if (!prev.size) return prev;
      const alive = new Set(list.map((r) => String(r.id)));
      const next = new Set([...prev].filter((id) => alive.has(id)));
      return next.size === prev.size ? prev : next;
    });
    setError(null);
    return list;
  }

  const allIds = rows.map((r) => String(r.id));
  const allSelected = allIds.length > 0 && allIds.every((id) => selectedIds.has(id));
  const someSelected = selectedIds.size > 0;

  function toggleOne(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    if (allSelected) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(allIds));
    }
  }

  async function deleteIds(ids: string[]) {
    if (!ids.length) return;
    const n = ids.length;
    const msg =
      n === 1
        ? "Bu kaydı silmek istediğinize emin misiniz? Analiz ve dosyalar da silinir."
        : `${n} kaydı silmek istediğinize emin misiniz? Analiz ve dosyalar da silinir.`;
    if (!window.confirm(msg)) return;

    setDeleting(true);
    setError(null);
    setOk(null);
    try {
      if (n === 1) {
        await api.deleteRecording(ids[0]!);
        setOk("Kayıt silindi.");
      } else {
        const res = await api.bulkDeleteRecordings(ids);
        setOk(`${res.deletedCount} kayıt silindi.`);
      }
      setSelectedIds(new Set());
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Silme başarısız.");
    } finally {
      setDeleting(false);
    }
  }

  useEffect(() => {
    let cancelled = false;

    async function tick(first = false) {
      try {
        const list = await refresh();
        if (cancelled) return;
        // Faster while any analysis is running so % / stage stay fresh.
        const ms = list.some((r) => isAnalysisRunning(r)) ? 2500 : 8000;
        pollRef.current = setTimeout(() => void tick(), ms);
      } catch (e) {
        // Keep last good rows on poll failure — don't flash empty.
        if (e instanceof Error) setError(e.message);
        if (!cancelled) {
          pollRef.current = setTimeout(() => void tick(), 8000);
        }
      } finally {
        if (first) setLoading(false);
      }
    }

    void tick(true);

    return () => {
      cancelled = true;
      if (pollRef.current) clearTimeout(pollRef.current);
    };
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

      {someSelected ? (
        <div
          className="sticky top-2 z-20 mb-4 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-rose/30 bg-rose/10 px-4 py-3 shadow-[0_12px_40px_rgba(0,0,0,0.35)] backdrop-blur-md"
          role="region"
          aria-label="Toplu işlemler"
        >
          <p className="text-sm font-medium text-paper">
            <span className="font-semibold text-rose">{selectedIds.size}</span> kayıt
            seçildi
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              variant="secondary"
              disabled={deleting}
              onClick={() => setSelectedIds(new Set())}
            >
              Seçimi temizle
            </Button>
            <Button
              type="button"
              size="sm"
              variant="danger"
              disabled={deleting}
              onClick={() => void deleteIds([...selectedIds])}
            >
              {deleting ? "Siliniyor…" : "Seçilenleri sil"}
            </Button>
          </div>
        </div>
      ) : null}

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
          <CardHeader className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
            <CardTitle>Kayıt listesi</CardTitle>
            <p
              className="text-xs text-fog"
              aria-label="Rapor bağlantısı renk açıklaması"
            >
              <span className="font-semibold text-emerald">Rapor yeşil</span>
              {" = tamam · "}
              <span className="font-semibold text-amber">sarı</span>
              {" = analiz sürüyor · "}
              <span className="font-semibold text-rose">kırmızı</span>
              {" = henüz yok / başarısız"}
            </p>
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
                    <TH className="w-10">
                      <input
                        type="checkbox"
                        className="h-4 w-4 cursor-pointer rounded border-line accent-mint"
                        checked={allSelected}
                        ref={(el) => {
                          if (el) {
                            el.indeterminate =
                              someSelected && !allSelected;
                          }
                        }}
                        onChange={toggleAll}
                        aria-label="Tümünü seç"
                      />
                    </TH>
                    <TH>Satıcı</TH>
                    <TH>Kaynak</TH>
                    <TH>Durum</TH>
                    <TH>Boyut</TH>
                    <TH></TH>
                  </TR>
                </THead>
                <TBody>
                  {rows.map((r) => {
                    const id = String(r.id);
                    const checked = selectedIds.has(id);
                    return (
                      <TR
                        key={id}
                        className={checked ? "bg-rose/[0.06]" : undefined}
                      >
                        <TD>
                          <input
                            type="checkbox"
                            className="h-4 w-4 cursor-pointer rounded border-line accent-mint"
                            checked={checked}
                            onChange={() => toggleOne(id)}
                            aria-label={`@${String(r.instagram_username)} seç`}
                          />
                        </TD>
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
                          <div className="flex flex-col gap-1">
                            <div className="flex flex-wrap items-center gap-2">
                              {(() => {
                                const link = reportLinkTone(r);
                                return (
                                  <Link
                                    to={`/reports/${r.id}`}
                                    title={link.title}
                                    aria-label={`Rapor — ${link.title}`}
                                    data-tone={link.tone}
                                    className={`text-sm font-semibold ${link.className}`}
                                  >
                                    Rapor
                                  </Link>
                                );
                              })()}
                              {(() => {
                                const progress = analysisProgressInfo(r);
                                if (!progress) return null;
                                return (
                                  <span
                                    className={`text-xs font-medium ${progress.className}`}
                                    title={progress.label}
                                    data-analysis-progress={
                                      progress.percent ?? undefined
                                    }
                                    data-analysis-state={progress.state}
                                  >
                                    {progress.label}
                                  </span>
                                );
                              })()}
                              {hasPlayableMedia(r) ? (
                                <a
                                  href={api.mediaUrl(id)}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  title="Kayıt videosunu aç / oynat"
                                  aria-label="Video — kayıt medyasını aç"
                                  className="text-sm font-semibold text-mint hover:text-mint-bright"
                                  data-recording-media={id}
                                >
                                  Video
                                </a>
                              ) : null}
                              {String(r.source_type) === "live" &&
                              (r.status === "awaiting_live" ||
                                r.status === "recording") ? (
                                <Button
                                  type="button"
                                  size="sm"
                                  variant="secondary"
                                  onClick={() => void onCancel(id)}
                                >
                                  İptal
                                </Button>
                              ) : null}
                              <Button
                                type="button"
                                size="sm"
                                variant="ghost"
                                className="text-rose hover:bg-rose/15 hover:text-rose"
                                disabled={deleting}
                                onClick={() => void deleteIds([id])}
                              >
                                Sil
                              </Button>
                            </div>
                          </div>
                        </TD>
                      </TR>
                    );
                  })}
                </TBody>
              </Table>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
