import { FormEvent, useEffect, useState } from "react";
import { api } from "../lib/api";
import { ErrorState, LoadingState } from "../components/States";

type IgSession = {
  status: string;
  hasCookies: boolean;
  hasCredentials: boolean;
  usernameMasked: string | null;
  updatedAt: string | null;
  lastError: string | null;
  hintTr: string;
};

const STATUS_TR: Record<string, string> = {
  yok: "Yok",
  yuklu: "Yüklü",
  hata: "Son hata",
};

export function SettingsPage() {
  const [settings, setSettings] = useState<Record<string, unknown> | null>(
    null,
  );
  const [metrics, setMetrics] = useState<Record<string, unknown> | null>(null);
  const [ig, setIg] = useState<IgSession | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [pwBusy, setPwBusy] = useState(false);
  const [pwMsg, setPwMsg] = useState<string | null>(null);
  const [pwErr, setPwErr] = useState<string | null>(null);

  async function refresh() {
    const [s, m, session] = await Promise.all([
      api.settings(),
      api.metrics(),
      api.igSession(),
    ]);
    setSettings(s);
    setMetrics(m);
    setIg(session);
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
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Ayarlar</h1>
          <p className="lead">
            İşleme profili, yakalama politikası ve yedek Instagram oturumu.
            Gizli bilgiler kayıttan sonra arayüzde gösterilmez.
          </p>
        </div>
      </div>

      {loading && <LoadingState label="Ayarlar yükleniyor…" />}
      {error && <ErrorState message={error} />}
      {ok && (
        <p>
          <span className="badge ok">{ok}</span>
        </p>
      )}

      {!loading && settings && (
        <>
          <div className="panel" id="ig-oturum">
            <h2>Instagram oturumu (yedek hesap)</h2>
            <p className="muted" style={{ marginTop: 0 }}>
              {ig?.hintTr ||
                "Canlı kayıt için yedek hesabınızın oturumunu buraya ekleyin."}
            </p>
            <p>
              Durum:{" "}
              <span
                className={
                  ig?.status === "yuklu"
                    ? "badge ok"
                    : ig?.status === "hata"
                      ? "badge err"
                      : "badge warn"
                }
              >
                {STATUS_TR[ig?.status ?? "yok"] ?? ig?.status ?? "Yok"}
              </span>
              {ig?.hasCookies ? (
                <span className="badge ok" style={{ marginLeft: 8 }}>
                  cookies.txt
                </span>
              ) : null}
              {ig?.hasCredentials ? (
                <span className="badge warn" style={{ marginLeft: 8 }}>
                  kullanıcı/parola ••••
                </span>
              ) : null}
            </p>
            <ul className="muted">
              <li>
                Maskeli kullanıcı: {ig?.usernameMasked ?? "—"}
              </li>
              <li>Son güncelleme: {ig?.updatedAt ?? "—"}</li>
              <li>Son hata: {ig?.lastError ?? "—"}</li>
            </ul>
            <p className="muted" style={{ fontSize: "0.9rem" }}>
              Yalnızca kendi yedek hesabınızı kullanın. Kayıt izni / KVKK /
              platform kuralları operatörün sorumluluğundadır. Çerez ve parola
              loglanmaz; kayıttan sonra API yanıtında da dönmez.
            </p>

            <h3 style={{ marginTop: "1.25rem" }}>1) Tercih edilen: cookies.txt</h3>
            <form className="row" onSubmit={onCookiesFile}>
              <label style={{ gridColumn: "1 / -1" }}>
                Netscape cookies.txt yükle
                <input name="cookiesFile" type="file" accept=".txt,text/plain" />
              </label>
              <button type="submit" disabled={busy}>
                Çerezleri kaydet
              </button>
            </form>

            <form className="row" onSubmit={onCookiesPaste} style={{ marginTop: "0.75rem" }}>
              <label style={{ gridColumn: "1 / -1" }}>
                Veya yapıştır
                <textarea
                  name="cookiesText"
                  rows={5}
                  placeholder="# Netscape HTTP Cookie File …"
                  style={{ width: "100%", fontFamily: "monospace", fontSize: "0.8rem" }}
                />
              </label>
              <button type="submit" disabled={busy}>
                Yapıştırmayı kaydet
              </button>
            </form>

            <form className="row" onSubmit={onCookiesPath} style={{ marginTop: "0.75rem" }}>
              <label style={{ gridColumn: "1 / -1" }}>
                Veya sunucudaki dosya yolu
                <input
                  name="cookiesPath"
                  placeholder="/home/…/instagram-cookies.txt"
                />
              </label>
              <button type="submit" className="secondary" disabled={busy}>
                Yoldan içe aktar
              </button>
            </form>

            <h3 style={{ marginTop: "1.25rem" }}>2) Playwright ile giriş (yedek izleyici)</h3>
            <p className="muted">
              Yalnızca izleme/kayıt için yedek hesap. Normal tarayıcı girişi —
              özel API veya bot aşımı yok. Başarılı olursa çerezler kaydedilir;
              parola sunucuda şifreli kalır (<strong>••••</strong>), yanıtta dönmez.
              İşlem 1–2 dakika sürebilir — butona bir kez basın.
            </p>
            {pwBusy && (
              <p className="badge warn" style={{ display: "block", marginBottom: 8 }}>
                Playwright sunucuda Instagram’a giriş yapıyor… Lütfen bekleyin (1–2 dk).
              </p>
            )}
            {pwMsg && (
              <p>
                <span className="badge ok">{pwMsg}</span>
              </p>
            )}
            {pwErr && <ErrorState message={pwErr} />}
            <form
              className="row"
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
                          (STATUS_TR[st.status] ?? st.status);
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
              <label>
                Kullanıcı adı
                <input
                  name="username"
                  autoComplete="username"
                  placeholder="yedek_hesap"
                  required
                  disabled={pwBusy}
                />
              </label>
              <label>
                Parola
                <input
                  name="password"
                  type="password"
                  autoComplete="current-password"
                  placeholder="••••••••"
                  required
                  disabled={pwBusy}
                />
              </label>
              <button type="submit" disabled={busy || pwBusy}>
                {pwBusy ? "Giriş yapılıyor… (bekleyin)" : "Playwright ile giriş yap"}
              </button>
            </form>

            <details style={{ marginTop: "1.25rem" }}>
              <summary style={{ cursor: "pointer", fontWeight: 600 }}>
                İsteğe bağlı: yalnızca kullanıcı/parola sakla (Playwright’suz)
              </summary>
              <p className="muted">
                Çerez yoksa yt-dlp <code>--username/--password</code> dener.
                Parola sunucuda AES ile saklanır; kayıttan sonra yalnızca{" "}
                <strong>••••</strong> görünür.
              </p>
              <form className="row" onSubmit={onCredentials}>
                <label>
                  Kullanıcı adı
                  <input name="username" autoComplete="username" placeholder="yedek_hesap" />
                </label>
                <label>
                  Parola
                  <input
                    name="password"
                    type="password"
                    autoComplete="current-password"
                    placeholder="••••••••"
                  />
                </label>
                <button type="submit" className="secondary" disabled={busy}>
                  Kullanıcı/parola kaydet
                </button>
              </form>
            </details>

            <div className="actions" style={{ marginTop: "1.25rem" }}>
              <button type="button" className="secondary" disabled={busy} onClick={() => void onClear()}>
                Oturumu kaldır
              </button>
            </div>
          </div>

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
            <p>
              <span className="badge ok">
                {String(capture.status ?? "operator_session_optional")}
              </span>
            </p>
            <p>{String(capture.message)}</p>
            {capture.settingsPathTr ? (
              <p>
                <strong>{String(capture.settingsPathTr)}</strong>
              </p>
            ) : null}
            {capture.limitationTr ? (
              <p className="muted">{String(capture.limitationTr)}</p>
            ) : null}
            <ul>
              {((capture.restrictions as string[]) ?? []).map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
            <p className="muted" style={{ marginBottom: 0 }}>
              Araçlar: {((capture.tools as string[]) ?? []).join(", ") || "—"}
            </p>
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
