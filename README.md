# WA Sticker Bot on Koyeb + Turso v5

Perbaikan v5:
- Bot tidak langsung membuka socket WhatsApp saat belum paired. Ini mencegah QR expired sebelum kamu membuka endpoint.
- Pairing code menunggu event connecting/QR, lalu delay 5 detik sebelum `requestPairingCode()`.
- Endpoint fresh pairing: `/pair?key=ADMIN_KEY&fresh=1`.
- Endpoint fresh QR: `/qr?key=ADMIN_KEY&fresh=1`.
- Jika auth/session invalid 401/440/500, session Turso dibersihkan agar tidak stuck.
- QR page auto-refresh tiap 25 detik.
- Browser fingerprint default diganti ke Ubuntu Chrome. Bisa diubah via `WA_BROWSER`.
- Bisa override versi WhatsApp Web via `WA_VERSION`.

## Endpoint

```text
GET  /health
GET  /status?key=ADMIN_KEY
GET  /pair?key=ADMIN_KEY&fresh=1
GET  /qr?key=ADMIN_KEY&fresh=1
POST /reset-auth?key=ADMIN_KEY
POST /restart?key=ADMIN_KEY
POST /logout?key=ADMIN_KEY
```

## Env tambahan opsional

```env
PAIRING_DELAY_MS=5000
QR_WAIT_TIMEOUT_MS=35000
WA_COUNTRY_CODE=ID
WA_BROWSER=ubuntu
# WA_VERSION=2,3000,1035194821
```

Jangan isi `WA_VERSION` dulu. Pakai hanya kalau versi terbaru dari Baileys sedang bermasalah.

## Urutan pairing paling aman

1. Deploy v5.
2. Buka `/health` dan pastikan `buildVersion` = `5.0.0`.
3. Jalankan reset auth:

```bash
curl -X POST "https://APP-KAMU.koyeb.app/reset-auth?key=ADMIN_KEY"
```

4. Pair via code:

```text
https://APP-KAMU.koyeb.app/pair?key=ADMIN_KEY&fresh=1
```

5. Kalau code gagal 2 kali, gunakan QR dari layar kedua:

```text
https://APP-KAMU.koyeb.app/qr?key=ADMIN_KEY&fresh=1
```

## Cara pakai bot

Kirim gambar ke nomor bot. Bot membalas sticker.

Caption opsional:

```text
cover   = crop penuh 512x512
contain = gambar utuh, default
text    = optimasi screenshot/tulisan
icon    = optimasi logo/icon
photo   = optimasi foto
pixel   = pixel art, tidak blur/smoothing
white   = background putih
nopad   = tanpa margin tambahan jika memungkinkan
```
