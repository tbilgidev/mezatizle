import { FormEvent, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { statusTr } from "@/lib/utils";
import { ErrorState, LoadingState, PageHeader } from "@/components/States";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, Input, Textarea } from "@/components/ui/input";

type IgSession = {
  status: string;
  hasCookies: boolean;
  hasCredentials: boolean;
  usernameMasked: string | null;
  updatedAt: string | null;
  lastError: string | null;
  hintTr: string;
};

type AutoFollowStatus = {
  enabled: boolean;
  pollIntervalMs: number;
  loopStarted: boolean;
  lastPollAt: string | null;
  lastPollOk: boolean | null;
  lastError: string | null;
  lastDetail: string | null;
  lastLivesSeen: Array<{ username: string; broadcastId: string | null }>;
  currentlyWatching: Array<{
    username: string;
    recordingId: string;
    broadcastId: string | null;
    captureStatus: string | null;
  }>;
  scanPaused?: boolean;
  labelTr: string;
  hintTr: string;
  cookiesReady: boolean;
};

function formatPollInterval(ms: number | undefined): string {
  const n = ms ?? 330_000;
  const min = n / 60_000;
  const label =
    Number.isInteger(min) ? `${min} dk` : `≈${min.toFixed(1).replace(/\.0$/, "")} dk`;
  return `${label} (5–6 dk aralığında jitter)`;
}

function formatWhen(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleString("tr-TR", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
  } catch {
    return iso;
  }
}

export function SettingsPage() {
  const [settings, setSettings] = useState<Record<string, unknown> | null>(null);
  const [metrics, setMetrics] = useState<Record<string, unknown> | null>(null);
  const [ig, setIg] = useState<IgSession | null>(null);
  const [autoFollow, setAutoFollow] = useState<AutoFollowStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [pwBusy, setPwBusy] = useState(false);
  const [pwMsg, setPwMsg] = useState<string | null>(null);
  const [pwErr, setPwErr] = useState<string | null>(null);
  const [afBusy, setAfBusy] = useState(false);

  async function refresh() {
    const [s, m, session, af] = await Promise.all([
      api.settings(),
      api.metrics(),
      api.igSession(),
      api.autoFollowLive(),
    ]);
    setSettings(s);
    setMetrics(m);
    setIg(session);
    setAutoFollow(af as AutoFollowStatus);
  }

  useEffect(() => {
    refresh()
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  const profile = (settings?.profile ?? {}) as Record<string, unknown>;
  const capture = (settings?.capture ?? {}) as Record<string, unknown>;

  async function onCookiesFile(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    setBusy(true);
    setError(null);
    setOk(null);
    const fd = new FormData(form);
    const file = fd.get("cookiesFile");
    try {
      if (!(file instanceof File) || !file.size) {
        throw new Error("cookies.txt dosyası seçin");
      }
      const st = (await api.saveIgCookiesFile(file)) as unknown as IgSession;
      setIg(st);
      setOk(
        st.hasCookies
          ? "Çerez oturumu kaydedildi — durum: Yüklü (içerik bir daha gösterilmez)."
          : "Çerez isteği tamamlandı; durumu kontrol edin.",
      );
      form.reset();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function onCookiesPaste(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    setBusy(true);
    setError(null);
    setOk(null);
    const fd = new FormData(form);
    try {
      const st = (await api.saveIgSessionJson({
        cookiesText: String(fd.get("cookiesText") ?? ""),
      })) as unknown as IgSession;
      setIg(st);
      setOk(
        st.hasCookies
          ? "Yapıştırılan çerezler kaydedildi — durum: Yüklü."
          : "Çerez isteği tamamlandı; durumu kontrol edin.",
      );
      form.reset();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function onCookiesPath(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    setBusy(true);
    setError(null);
    setOk(null);
    const fd = new FormData(form);
    try {
      const st = (await api.saveIgSessionJson({
        cookiesPath: String(fd.get("cookiesPath") ?? ""),
      })) as unknown as IgSession;
      setIg(st);
      setOk(
        st.hasCookies
          ? "Çerez dosya yolu okundu — durum: Yüklü."
          : "Dosya yolu işlendi; durumu kontrol edin.",
      );
      form.reset();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function onCredentials(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    setBusy(true);
    setError(null);
    setOk(null);
    const fd = new FormData(form);
    try {
      const st = (await api.saveIgSessionJson({
        username: String(fd.get("username") ?? ""),
        password: String(fd.get("password") ?? ""),
      })) as unknown as IgSession;
      setIg(st);
      setOk("Kullanıcı/parola sunucuda şifreli saklandı (••••).");
      form.reset();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function onClear() {
    if (!confirm("Instagram oturumunu (çerezler + parola) kaldırmak istiyor musunuz?")) {
      return;
    }
    setBusy(true);
    setError(null);
    setOk(null);
    try {
      const st = (await api.clearIgSession()) as unknown as IgSession;
      setIg(st);
      setOk("Oturum kaldırıldı.");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-[1100px] animate-rise">
      <PageHeader
        title="Ayarlar"
        lead="İşleme profili, yakalama politikası ve yedek Instagram oturumu. Gizli bilgiler kayıttan sonra arayüzde gösterilmez."
      />

      {loading && <LoadingState label="Ayarlar yükleniyor…" />}
      {error && <ErrorState message={error} className="mb-4" />}
      {ok && (
        <p className="mb-4">
          <Badge variant="ok">{ok}</Badge>
        </p>
      )}

      {!loading && settings && (
        <>
          <Card className="mb-4" id="auto-follow-live">
            <CardHeader>
              <CardTitle>Takip canlıları otomatik kaydet</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="mb-3 text-sm text-fog">
                {autoFollow?.hintTr ||
                  "İzleyici hesabının takip ettiği mezat hesapları canlıya geçince otomatik kayıt başlar."}
              </p>
              <p className="mb-3 text-sm">
                Durum:{" "}
                <Badge variant={autoFollow?.enabled ? "ok" : "warn"}>
                  {autoFollow?.labelTr ??
                    (autoFollow?.enabled
                      ? "Takip canlıları otomatik kaydet: açık"
                      : "Takip canlıları otomatik kaydet: kapalı")}
                </Badge>
                {autoFollow?.scanPaused ? (
                  <Badge variant="warn" className="ml-2">
                    Kayıt sürerken tarama duraklatıldı
                  </Badge>
                ) : null}
                {!autoFollow?.cookiesReady ? (
                  <Badge variant="danger" className="ml-2">
                    Çerez gerekli
                  </Badge>
                ) : null}
              </p>
              <ul className="mb-4 space-y-1 text-sm text-fog">
                <li>
                  Son tarama: {formatWhen(autoFollow?.lastPollAt)}
                  {autoFollow?.lastPollOk === true
                    ? " · başarılı"
                    : autoFollow?.lastPollOk === false
                      ? " · hata"
                      : ""}
                </li>
                <li>
                  Tarama aralığı: {formatPollInterval(autoFollow?.pollIntervalMs)}
                </li>
                <li>
                  Son ayrıntı: {autoFollow?.lastDetail ?? autoFollow?.lastError ?? "—"}
                </li>
                <li>
                  Şu an izlenen:{" "}
                  {autoFollow?.currentlyWatching?.length
                    ? autoFollow.currentlyWatching
                        .map(
                          (w) =>
                            `@${w.username}${w.captureStatus ? ` (${w.captureStatus})` : ""}`,
                        )
                        .join(", ")
                    : "yok"}
                </li>
                <li>
                  Son görülen canlılar:{" "}
                  {autoFollow?.lastLivesSeen?.length
                    ? autoFollow.lastLivesSeen
                        .map((l) => `@${l.username}`)
                        .join(", ")
                    : "—"}
                </li>
              </ul>
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  disabled={afBusy || busy}
                  onClick={() => {
                    void (async () => {
                      setAfBusy(true);
                      setError(null);
                      setOk(null);
                      try {
                        const st = (await api.setAutoFollowLive({
                          enabled: !autoFollow?.enabled,
                        })) as unknown as AutoFollowStatus;
                        setAutoFollow(st);
                        setOk(st.labelTr);
                      } catch (err) {
                        setError(
                          err instanceof Error ? err.message : String(err),
                        );
                      } finally {
                        setAfBusy(false);
                      }
                    })();
                  }}
                >
                  {autoFollow?.enabled ? "Kapat" : "Aç"}
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  disabled={afBusy || busy}
                  onClick={() => {
                    void (async () => {
                      setAfBusy(true);
                      setError(null);
                      setOk(null);
                      try {
                        const st = (await api.pollAutoFollowLiveNow({
                          dryRun: true,
                        })) as unknown as AutoFollowStatus & {
                          cycle?: { detail?: string; discovered?: unknown[] };
                        };
                        setAutoFollow(st);
                        setOk(
                          `Kuru tarama: ${st.cycle?.detail ?? st.lastDetail ?? "tamam"}`,
                        );
                      } catch (err) {
                        setError(
                          err instanceof Error ? err.message : String(err),
                        );
                      } finally {
                        setAfBusy(false);
                      }
                    })();
                  }}
                >
                  Şimdi tara (kuru)
                </Button>
              </div>
            </CardContent>
          </Card>

          <Card className="mb-4" id="ig-oturum">
            <CardHeader>
              <CardTitle>Instagram oturumu (yedek hesap)</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="mb-3 text-sm text-fog">
                {ig?.hintTr ||
                  "Canlı kayıt için yedek hesabınızın oturumunu buraya ekleyin."}
              </p>
              <p className="mb-3 text-sm">
                Durum:{" "}
                <Badge
                  variant={
                    ig?.status === "yuklu"
                      ? "ok"
                      : ig?.status === "hata"
                        ? "danger"
                        : "warn"
                  }
                >
                  {statusTr(ig?.status ?? "yok")}
                </Badge>
                {ig?.hasCookies ? (
                  <Badge variant="ok" className="ml-2">
                    cookies.txt
                  </Badge>
                ) : null}
                {ig?.hasCredentials ? (
                  <Badge variant="warn" className="ml-2">
                    kullanıcı/parola ••••
                  </Badge>
                ) : null}
              </p>
              <ul className="mb-4 space-y-1 text-sm text-fog">
                <li>Maskeli kullanıcı: {ig?.usernameMasked ?? "—"}</li>
                <li>Son güncelleme: {ig?.updatedAt ?? "—"}</li>
                <li>Son hata: {ig?.lastError ?? "—"}</li>
              </ul>
              <p className="mb-5 text-xs text-fog">
                Yalnızca kendi yedek hesabınızı kullanın. Kayıt izni / KVKK /
                platform kuralları operatörün sorumluluğundadır. Çerez ve parola
                loglanmaz; kayıttan sonra API yanıtında da dönmez.
              </p>

              <h3 className="mb-2 text-sm font-bold text-paper">
                1) Tercih edilen: cookies.txt
              </h3>
              <form className="mb-3 grid gap-3" onSubmit={onCookiesFile}>
                <Field label="Netscape cookies.txt yükle">
                  <Input name="cookiesFile" type="file" accept=".txt,text/plain" />
                </Field>
                <Button type="submit" disabled={busy} className="w-fit">
                  Çerezleri kaydet
                </Button>
              </form>

              <form className="mb-3 grid gap-3" onSubmit={onCookiesPaste}>
                <Field label="Veya yapıştır">
                  <Textarea
                    name="cookiesText"
                    rows={5}
                    placeholder="# Netscape HTTP Cookie File …"
                    className="font-mono text-xs"
                  />
                </Field>
                <Button type="submit" disabled={busy} className="w-fit">
                  Yapıştırmayı kaydet
                </Button>
              </form>

              <form className="mb-5 grid gap-3" onSubmit={onCookiesPath}>
                <Field label="Veya sunucudaki dosya yolu">
                  <Input
                    name="cookiesPath"
                    placeholder="/home/…/instagram-cookies.txt"
                  />
                </Field>
                <Button type="submit" variant="secondary" disabled={busy} className="w-fit">
                  Yoldan içe aktar
                </Button>
              </form>

              <h3 className="mb-2 text-sm font-bold text-paper">
                2) Playwright ile giriş (yedek izleyici)
              </h3>
              <p className="mb-3 text-sm text-fog">
                Yalnızca izleme/kayıt için yedek hesap. Normal tarayıcı girişi —
                özel API veya bot aşımı yok. Başarılı olursa çerezler kaydedilir;
                parola sunucuda şifreli kalır (<strong>••••</strong>), yanıtta
                dönmez. İşlem 1–2 dakika sürebilir.
              </p>
              {pwBusy && (
                <p className="mb-2">
                  <Badge variant="warn">
                    Playwright sunucuda Instagram’a giriş yapıyor… (1–2 dk)
                  </Badge>
                </p>
              )}
              {pwMsg && (
                <p className="mb-2">
                  <Badge variant="ok">{pwMsg}</Badge>
                </p>
              )}
              {pwErr && <ErrorState message={pwErr} className="mb-3" />}
              <form
                className="grid gap-3 sm:grid-cols-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (pwBusy || busy) return;
                  const form = e.currentTarget;
                  const fd = new FormData(form);
                  const username = String(fd.get("username") ?? "");
                  const password = String(fd.get("password") ?? "");
                  void (async () => {
                    setPwBusy(true);
                    setBusy(true);
                    setError(null);
                    setOk(null);
                    setPwMsg(null);
                    setPwErr(null);
                    try {
                      const st = (await api.playwrightIgLogin({
                        username,
                        password,
                      })) as unknown as IgSession;
                      setIg(st);
                      const success =
                        st.hasCookies || st.status === "yuklu"
                          ? "Playwright girişi tamam — durum: Yüklü. Çerezler kaydedildi; parola saklandı (••••)."
                          : "İstek tamamlandı; durum: " +
                            statusTr(st.status);
                      setPwMsg(success);
                      setOk(success);
                      form.reset();
                    } catch (err) {
                      const msg =
                        err instanceof Error ? err.message : String(err);
                      setPwErr(msg);
                      setError(msg);
                      try {
                        setIg(await api.igSession());
                      } catch {
                        /* ignore */
                      }
                    } finally {
                      setPwBusy(false);
                      setBusy(false);
                    }
                  })();
                }}
              >
                <Field label="Kullanıcı adı">
                  <Input
                    name="username"
                    autoComplete="username"
                    placeholder="yedek_hesap"
                    required
                    disabled={pwBusy}
                  />
                </Field>
                <Field label="Parola">
                  <Input
                    name="password"
                    type="password"
                    autoComplete="current-password"
                    placeholder="••••••••"
                    required
                    disabled={pwBusy}
                  />
                </Field>
                <Button type="submit" disabled={busy || pwBusy} className="w-fit">
                  {pwBusy ? "Giriş yapılıyor… (bekleyin)" : "Playwright ile giriş yap"}
                </Button>
              </form>

              <details className="mt-5">
                <summary className="cursor-pointer text-sm font-semibold">
                  İsteğe bağlı: yalnızca kullanıcı/parola sakla (Playwright’suz)
                </summary>
                <p className="mt-2 text-sm text-fog">
                  Çerez yoksa yt-dlp <code>--username/--password</code> dener.
                  Parola sunucuda AES ile saklanır.
                </p>
                <form className="mt-3 grid gap-3 sm:grid-cols-2" onSubmit={onCredentials}>
                  <Field label="Kullanıcı adı">
                    <Input name="username" autoComplete="username" placeholder="yedek_hesap" />
                  </Field>
                  <Field label="Parola">
                    <Input
                      name="password"
                      type="password"
                      autoComplete="current-password"
                      placeholder="••••••••"
                    />
                  </Field>
                  <Button type="submit" variant="secondary" disabled={busy} className="w-fit">
                    Kullanıcı/parola kaydet
                  </Button>
                </form>
              </details>

              <div className="mt-5">
                <Button type="button" variant="secondary" disabled={busy} onClick={() => void onClear()}>
                  Oturumu kaldır
                </Button>
              </div>
            </CardContent>
          </Card>

          <Card className="mb-4">
            <CardHeader>
              <CardTitle>Profil</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="mb-3">
                <Badge variant="ok">{String(profile.profile ?? "LOCAL")}</Badge>
              </p>
              <ul className="space-y-1 text-sm text-fog">
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
            </CardContent>
          </Card>

          <Card className="mb-4" id="video-retention">
            <CardHeader>
              <CardTitle>Video saklama</CardTitle>
            </CardHeader>
            <CardContent>
              {(() => {
                const mr = (settings?.mediaRetention ?? {}) as Record<
                  string,
                  unknown
                >;
                const days = Number(mr.retentionDays ?? 7);
                return (
                  <>
                    <p className="mb-2">
                      <Badge variant="ok">
                        {String(mr.labelTr ?? `Video saklama: ${days} gün`)}
                      </Badge>
                    </p>
                    <p className="mb-2 text-sm text-fog">
                      {String(
                        mr.hintTr ??
                          `Analiz tamamlandıktan ${days} gün sonra kayıt videosu silinir; satışlar, rapor KPI’ları, yorumlar, transkript ve ürün küçük resimleri kalır.`,
                      )}
                    </p>
                    <p className="mb-2 text-sm text-fog">
                      Silinen video için arayüz notu:{" "}
                      <em>
                        {String(
                          mr.noteTr ??
                            "Video 1 hafta sonra silindi; analiz duruyor",
                        )}
                      </em>
                    </p>
                    {mr.knownGapTr ? (
                      <p className="text-xs text-fog">{String(mr.knownGapTr)}</p>
                    ) : null}
                  </>
                );
              })()}
            </CardContent>
          </Card>

          <Card className="mb-4">
            <CardHeader>
              <CardTitle>Yakalama (Modül H)</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="mb-2">
                <Badge variant="ok">
                  {String(capture.status ?? "operator_session_optional")}
                </Badge>
              </p>
              <p className="mb-2 text-sm">{String(capture.message)}</p>
              {capture.settingsPathTr ? (
                <p className="mb-2 text-sm font-semibold">
                  {String(capture.settingsPathTr)}
                </p>
              ) : null}
              {capture.limitationTr ? (
                <p className="mb-2 text-sm text-fog">{String(capture.limitationTr)}</p>
              ) : null}
              <ul className="mb-2 list-disc space-y-1 pl-5 text-sm text-fog">
                {((capture.restrictions as string[]) ?? []).map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
              <p className="text-sm text-fog">
                Araçlar: {((capture.tools as string[]) ?? []).join(", ") || "—"}
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Metrikler</CardTitle>
            </CardHeader>
            <CardContent>
              <pre className="overflow-x-auto whitespace-pre-wrap text-xs text-fog">
                {JSON.stringify(metrics, null, 2)}
              </pre>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
