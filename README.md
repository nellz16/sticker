# WA Sticker Bot on Koyeb + Turso

Bot pribadi untuk mengubah gambar yang dikirim ke WhatsApp menjadi sticker WebP 512x512 tanpa outline putih dan tanpa auto-remove background.

## Ringkas

- Runtime: Koyeb Web Service
- WA library: Baileys v7.0.0-rc13
- Auth/session: Turso SQLite/libSQL
- Keep-alive: UptimeRobot ping `/health` tiap 5 menit
- Pairing: kode pairing, bukan QR

## Environment variables

Lihat `.env.example`.

Wajib di Koyeb:

```env
TURSO_DATABASE_URL=...
TURSO_AUTH_TOKEN=...
BOT_PHONE_NUMBER=628xxxxxxxxxx
OWNER_NUMBERS=628xxxxxxxxxx
ADMIN_KEY=secret-panjang
SESSION_ID=main
```

`BOT_PHONE_NUMBER` adalah nomor WhatsApp cadangan yang akan dijadikan bot. Jangan pakai tanda `+`.

`OWNER_NUMBERS` adalah nomor yang boleh memakai bot, pisahkan koma jika lebih dari satu. Contoh:

```env
OWNER_NUMBERS=6281111111111,6282222222222
```

## Deploy Koyeb

1. Push folder ini ke GitHub.
2. Koyeb → Create Web Service → GitHub repo.
3. Builder: Dockerfile.
4. Instance: Free.
5. Exposed port: 8000, atau biarkan Koyeb pakai `PORT`.
6. Isi environment variables.
7. Deploy.

## Pairing via code

Buka endpoint ini di browser:

```text
https://APP-KAMU.koyeb.app/pair?key=ADMIN_KEY
```

Jika sukses, akan muncul kode pairing.

Di WhatsApp pada HP nomor bot:

```text
Settings / Setelan
→ Linked Devices / Perangkat tertaut
→ Link a device / Tautkan perangkat
→ Link with phone number instead / Tautkan dengan nomor telepon
→ Masukkan kode
```

## UptimeRobot

Buat monitor HTTP(s):

```text
URL: https://APP-KAMU.koyeb.app/health
Interval: 5 minutes
```

## Cara pakai

Kirim gambar ke nomor bot. Bot akan membalas sticker.

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

Contoh caption:

```text
text nopad
```

## Endpoint admin

```text
GET /health
GET /pair?key=ADMIN_KEY
GET /status?key=ADMIN_KEY
POST /logout?key=ADMIN_KEY
```

`/logout` akan menghapus sesi Baileys dari Turso, sehingga perlu pairing ulang.
