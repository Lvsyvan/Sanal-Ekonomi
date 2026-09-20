# Sanal Ekonomi V13 — Auth Fix (Validated)

Bu sürümde kayıt/giriş akışı oyun ekonomisinden ayrılmıştır.

Kritik tasarım:
- `/register`: kullanıcı doğrulama + başlangıç hesabı + token.
- `/login`: yalnızca kullanıcı doğrulama + token.
- `/me`: giriş sonrası oyun durumunu yükler.
- Üretim/bina/marketplace hesapları authentication akışında çalışmaz.
- PostgreSQL migration korunur.
- V10/V11/V12 mevcut verileri korunur.
- SCoin ve kaynak ekonomisi korunur.

Deploy:
1. GitHub'da `server.js` dosyasını bu sürümdeki `server.js` ile değiştir.
2. `DATABASE_URL` ve `JWT_SECRET` Render Environment'ta aynen bırak.
3. Commit changes.
4. Render -> Manual Deploy -> Deploy latest commit.
5. `/health` adresinde `version: 13.0.0` görülmeli.

Yeni kayıt başlangıç paketi:
5.000 SCoin + 300 Demir + 400 Kereste + 400 Taş + 200 Enerji + 4 arazi +
Depo + Maden + Kereste Atölyesi + Taş Ocağı.

Gerçek para yatırma/çekme yoktur.
