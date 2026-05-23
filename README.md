# WA Sticker Bot on Koyeb + Turso v4

Perbaikan v4:
- Endpoint pairing code dibuat lebih aman: menunggu event `connecting` atau `qr`.
- Jika socket sudah `close`, endpoint `/pair` otomatis membuat socket baru.
- Tambah fallback endpoint QR: `/qr?key=ADMIN_KEY`.
- Tambah endpoint `/restart?key=ADMIN_KEY` dan `/reset-auth?key=ADMIN_KEY`.
- Tambah `/pair?key=ADMIN_KEY&fresh=1` untuk pairing dari sesi bersih.
- Jika auth invalid 401/440, session Turso akan dibersihkan agar tidak stuck.
- Setelah pairing/scan, disconnect `restartRequired` dianggap normal dan auto-reconnect.

## Endpoint

```text
GET  /health
GET  /status?key=ADMIN_KEY
GET  /pair?key=ADMIN_KEY
GET  /pair?key=ADMIN_KEY&fresh=1
GET  /qr?key=ADMIN_KEY
POST /restart?key=ADMIN_KEY
POST /reset-auth?key=ADMIN_KEY
POST /logout?key=ADMIN_KEY
```

## Pairing via code

```text
https://APP-KAMU.koyeb.app/pair?key=ADMIN_KEY
```

Jika gagal beberapa kali, tunggu 15-30 menit, restart service, lalu coba QR:

```text
https://APP-KAMU.koyeb.app/qr?key=ADMIN_KEY
```

## QR via 1 HP

Buka endpoint QR di browser HP yang sama, lalu screenshot/zoom QR. Dari WhatsApp:
Setelan → Perangkat tertaut → Tautkan perangkat → Scan QR.
Kalau tidak bisa scan dari HP yang sama, buka URL QR di laptop/HP lain.
