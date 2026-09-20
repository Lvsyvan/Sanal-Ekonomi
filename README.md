# Sanal Ekonomi V11 — Daha Kolay Başlangıç + Çoklu Kaynak Ekonomisi

## Başlangıç
Yeni hesap:
- 5.000 SCoin
- 300 Demir
- 400 Kereste
- 400 Taş
- 200 Enerji
- 4 Arazi
- Depo + Demir Madeni + Kereste Atölyesi + Taş Ocağı hazır

Oyuncu boş haritada kalmaz; ilk dakikada ekonomik döngüye başlayabilir.

## Kaynaklar
SCoin: ticaret, bazı yapı maliyetleri, geliştirmeler ve marketplace ekonomisi.
Demir, Kereste, Taş, Enerji: üretim kaynakları.
Çelik ve Makine: ileri seviye sanayi ürünleri.

## Yapılar
- Depo
- Demir Madeni
- Kereste Atölyesi
- Taş Ocağı
- Enerji Santrali
- Çelik Tesisi
- Makine Fabrikası

Yapıların maliyetleri farklı kaynakların kombinasyonundan oluşur; her şey SCoin'e bağlanmaz.

## Üretim
- Maden: 100 demir/saat (seviye 1)
- Kereste Atölyesi: 80 kereste/saat
- Taş Ocağı: 80 taş/saat
- Enerji Santrali: 120 enerji/saat
- 10 Demir + 10 Enerji = 1 Çelik
- 5 Çelik + 20 Demir + 10 Kereste + 20 Enerji = 1 Makine

Pasif üretim en fazla 24 saat geriye dönük birikir.

## Marketplace
Demir, Kereste, Taş, Enerji, Çelik ve Makine alınıp satılabilir.
Platform komisyonu %3.

## Migration
V10 PostgreSQL verileri korunur. Eski hesapların madenleri V11 yapı sistemine otomatik aktarılır.

## Deploy
GitHub'da `server.js`, `package.json`, `Dockerfile`, `render.yaml`, `README.md` dosyalarını güncelle.
`DATABASE_URL` ve `JWT_SECRET` Render Environment'ta mevcut kalmalı.
