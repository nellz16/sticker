# WA Sticker Bot on Koyeb + Turso v3

Perbaikan v3:
- Endpoint pairing code dibuat lebih aman: menunggu event `connecting` atau `qr`.
- Jika socket sudah `close`, endpoint `/pair` otomatis membuat socket baru.
- Tambah fallback endpoint QR: `/qr?key=ADMIN_KEY`.
- Tambah endpoint `/restart?key=ADMIN_KEY`.
- Setelah pairing/scan, disconnect `restartRequired` dianggap normal dan auto-reconnect.

## Endpoint

```text
GET  /health
GET  /status?key=ADMIN_KEY
GET  /pair?key=ADMIN_KEY
GET  /qr?key=ADMIN_KEY
POST /restart?key=ADMIN_KEY
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
