# Sanal Ekonomi V8 — Bad Request Fix / SCoin

Bu sürüm, Arazi / Maden / Üret butonlarında görülen HTTP 400 Bad Request sorununu düzeltir.
POST isteklerinde gövde yokken gereksiz application/json başlığı gönderilmez; action istekleri boş JSON gövdesiyle gönderilir.

GitHub'da sadece `server.js` dosyasını bununla değiştirip Commit changes yapman yeterli.
Render yeni commit'i otomatik deploy eder.
