# Sanal Ekonomi V5

Render'da görülen 139 / Segmentation fault hatasını önlemek için `better-sqlite3` tamamen kaldırılmıştır.
Bu MVP saf Node.js dosya tabanlı veri kullanır.

GitHub'daki eski 5 dosyanın yerine bunları koy:
- server.js
- package.json
- Dockerfile
- render.yaml
- README.md

Sonra Render -> Manual Deploy -> Deploy latest commit.

İlk kontrol: `https://SENIN-ADRESIN.onrender.com/health`
Beklenen: `{"ok":true,"service":"sanal-ekonomi","version":"5.0.0"}`

Not: Bu sürüm test/MVP içindir. Ücretsiz ve geçici disk ortamında veritabanı kalıcılığı garanti değildir. Gerçek kullanıcı sistemi için PostgreSQL'e geçilecektir.
