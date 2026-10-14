# Instagram oturumu — nasıl

Funnel: https://tolga-mini.tailf479ba.ts.net/mezatizle/settings#ig-oturum

## Tercih sırası

1. **cookies.txt** (en güvenilir) — tarayıcıda yedek hesapla giriş → Netscape cookies dışa aktar → Ayarlar’dan yükle.
2. **Playwright ile giriş yap** — kullanıcı + parola; sunucu Chromium ile normal giriş dener, `sessionid` çerezini `storage/secrets/` altına yazar.
3. Yalnızca kullanıcı/parola sakla — yt-dlp `-u/-p` yedeği (çerez yoksa).

## Playwright butonu “hiçbir şey yapmıyor” gibi görünürdü — kök neden

Instagram giriş formu alan adlarını değiştirdi: artık çoğu zaman `input[name="email"]` + `input[name="pass"]` (eski: `username` / `password`). Eski seçiciler 30 sn timeout yiyordu; hata sayfanın üstünde kaldığı için form yanında geri bildirim yokmuş gibi duruyordu.

**Düzeltme (2026-10-15):** her iki alan adı destekleniyor; butonda yükleniyor durumu; Türkçe başarı/hata formu hemen altında; challenge / yanlış parola ekran görüntüsü `storage/secrets/ig-login-shots/` (+ store `media/ig-login-*.png`).

## Gotcha’lar

- Giriş **1–2 dakika** sürebilir — butona bir kez basın; “Giriş yapılıyor…” görünür.
- Instagram **yanlış parola** derse UI’da net Türkçe mesaj + ekran görüntüsü gelir; durum **Son hata** kalır (Yüklü olmaz).
- **Challenge / 2FA / checkpoint** otomatik geçilmez — cookies.txt yolu kullanın.
- Headless sunucu IP’leri bazen ek doğrulama ister; yine cookies.txt daha sağlam.
- Parola git’e **asla** yazılmaz; AES ile `storage/secrets/` içinde tutulur, API yanıtında dönmez.
- Funnel yolu: `/mezatizle/api/...` (web proxy → API `:43127`).

## “Yüklü” ne demek?

`hasCookies: true` ve durum **Yüklü** — yt-dlp `--cookies` için Netscape dosyası hazır. Kullanıcı/parola tek başına Yüklü sayılmaz.

## Test notu (ferahsevecen)

Playwright formu doldurdu; Instagram yanıtı: *“Girdiğin giriş bilgileri yanlış…”* → oturum **Yüklü olmadı**. Doğru parola veya cookies.txt gerekli.
