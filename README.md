# Sanal Ekonomi V15

Auth ve oyun yükleme ayrılmıştır:
- /register sadece kullanıcı + başlangıç verileri + token oluşturur.
- /login sadece kimlik doğrular ve token verir.
- /me oyun verilerini yükler.
- Eski PostgreSQL users şeması için geriye dönük migration içerir.
- Mevcut DATABASE_URL ve JWT_SECRET değiştirilmemelidir.
