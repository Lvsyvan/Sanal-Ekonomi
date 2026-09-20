# Sanal Ekonomi V12

V12, V11 giriş/kayıt sorununu düzeltir.

Kök neden: V11 migration sorgusu eski `users.mines` sütununu okumaya çalışıyordu; yeni şemada bu sütun oluşturulmamıştı. Bu nedenle uygulama açılışta veritabanı init aşamasında durabiliyordu.

V12:
- `mines` migration sütununu güvenli şekilde ekler
- Eski madenleri yeni `buildings` sistemine aktarır
- Kayıt işlemini transaction ile yapar
- Başlangıç ekonomisini korur
- SCoin + Demir + Kereste + Taş + Enerji + Çelik + Makine sistemini korur
- Marketplace ve %3 komisyonu korur
- Maden yükseltmesini tüm madenler için tutarlı yapar
- Passive production hesaplarını maden seviyesine göre yapar

Deploy:
1. GitHub'da `server.js`, `package.json`, `Dockerfile`, `render.yaml`, `README.md` dosyalarını V12 ile değiştir.
2. `DATABASE_URL` ve `JWT_SECRET` Render Environment'ta mevcut kalmalı.
3. Commit.
4. Render > Manual Deploy > Deploy latest commit (gerekirse).

Gerçek para yatırma/çekme bu MVP'de yoktur.
