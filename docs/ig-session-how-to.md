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

Playwright formu doldurdu; Instagram yanıtı: *“Girdiğin giriş bilgileri yanlış…”* → oturum **Yüklü olmadı**. Parola sunucuya tam iletildi (truncation yok).

### Chrome’da giriyorsan ama Playwright başarısızsa

Bu sık görülür. Chrome’daki **senin** oturumun (zaten geçmiş challenge / güvenilir cihaz) ile sunucudaki **yeni headless Chromium** aynı şey değil. Instagram otomasyona bazen sahte “yanlış parola” veya checkpoint döner — şifren Chrome’da doğru olsa bile.

**Ne yap:** Chrome’da yedek hesapla açık oturumdayken Netscape **cookies.txt** dışa aktar → Ayarlar’dan yükle. yt-dlp bu çerezlerle yayın çeker; Playwright login’e gerek kalmaz.

Chrome cookie alma (kısa):

1. Chrome’da https://www.instagram.com — `ferahsevecen` ile girişli olduğundan emin ol  
2. Eklenti: **Get cookies.txt LOCALLY** (veya eşdeğeri) → `instagram.com` → Export  
3. https://tolga-mini.tailf479ba.ts.net/mezatizle/settings#ig-oturum → dosyayı yükle  
4. Durum **Yüklü** olmalı → sonra 10 dk canlı test

## Form reset bug (fixed)

React: after `await`, `event.currentTarget` can be null — calling `.reset()` threw `can't access property "reset", tt.currentTarget is null` and looked like a failed cookie save even when the API succeeded.

**Fix:** capture `const form = e.currentTarget` before any `await`, then `form.reset()` only on success. Clear Türkçe başarı mesajı: «durum: Yüklü».

