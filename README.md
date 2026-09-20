# Sanal Ekonomi V9 — PostgreSQL + SCoin

Bu sürüm, JSON dosyası yerine PostgreSQL kullanır. Gerçek çok kullanıcılı MVP için temel veri katmanı budur.

## Render kurulumu

1. GitHub repository içindeki `server.js`, `package.json`, `Dockerfile`, `render.yaml`, `README.md` dosyalarını bu sürümdekilerle güncelle.
2. Render Web Service içine PostgreSQL bağlantı bilgisini `DATABASE_URL` environment variable olarak ekle.
3. `JWT_SECRET` environment variable değerini Generate ile oluştur.
4. Deploy latest commit yap.

## Oyun
- Başlangıç: 10.000 SCoin
- Arazi: 1.000 SCoin
- Maden: 2.500 SCoin / boş arazi
- Manuel üretim: 50 SCoin → maden başına 100 demir
- Pasif üretim: maden başına 100 demir/saat, maksimum 24 saat birikim
- Marketplace komisyonu: %3
- Gerçek para yatırma/çekme yoktur.

## API
GET /health
POST /register
POST /login
GET /me
POST /land
POST /mine
POST /produce
GET /market
POST /market/list
POST /market/buy/:id
GET /transactions
GET /admin/stats
