# WA Sticker Bot on Koyeb + Turso v8

Perbaikan v8:
- Tambah owner whitelist dinamis di Turso: tidak perlu edit env untuk tambah nomor/LID.
- Tambah `/claim ADMIN_KEY` agar nomor yang sedang chat bisa mendaftarkan dirinya sendiri.
- Tambah `/addowner`, `/removeowner`, dan `/owners`.
- Fix parsing LID/PN agar koma di env tetap boleh, tapi DB owner jadi metode utama.
- Fix penting untuk Baileys v7 LID: pesan private bisa datang sebagai `@lid`, bukan `@s.whatsapp.net`.
- Tambah whitelist `OWNER_LIDS`.
- Tambah command `/whoami` untuk melihat LID pengirim.
- Tambah env `ALLOW_ALL_PRIVATE=false` untuk mode debugging sementara.
- Fix penting untuk Koyeb redeploy: status 440 / `connectionReplaced` / `conflict replaced` tidak lagi menghapus auth Turso.
- Tambah graceful shutdown SIGTERM/SIGINT: socket ditutup tanpa logout dan tanpa clear auth.
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
3. Jika sesi sebelumnya sudah terhapus oleh versi lama, jalankan reset auth dan pairing ulang. Kalau setelah v6 state sudah `open`, langkah reset tidak perlu:

```bash
curl -X POST "https://APP-KAMU.koyeb.app/reset-auth?key=ADMIN_KEY"
```

4. Pair via code:

```text
https://APP-KAMU.koyeb.app/pair?key=ADMIN_KEY&fresh=1
```

5. Untuk redeploy berikutnya, jangan reset auth. Kalau code gagal 2 kali, gunakan QR dari layar kedua:

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


## Catatan redeploy Koyeb

Koyeb akan menjalankan deployment baru sampai healthy, lalu menghentikan deployment lama. Untuk WhatsApp Web/Baileys, overlap singkat ini memicu status `440 connectionReplaced` pada instance lama. Di v6, status tersebut dianggap normal dan auth state di Turso tetap disimpan.


## Fix pesan ter-ignore karena @lid

Baileys v7 bisa mengirim private chat sebagai LID JID seperti:

```text
110858038444128@lid
```

Kalau log berisi `Ignoring non-owner sender`, kirim `/whoami` dari nomor utama ke bot. Bot akan membalas `Detected LID IDs`.

Tambahkan ID tersebut ke Koyeb env:

```env
OWNER_LIDS=110858038444128
```

Jika ingin memasukkan lebih dari satu:

```env
OWNER_LIDS=110858038444128,3229882572954
```

Lalu redeploy. Di v6 dan sebelumnya, hanya `OWNER_NUMBERS` yang dicek, sehingga pesan `@lid` selalu dianggap non-owner.


## Owner command v8

Jika pesan masih dianggap non-owner, kirim dari nomor yang ingin diizinkan:

```text
/claim ADMIN_KEY_KAMU
```

Contoh:

```text
/claim zhiv-sticker-bot-acak-panjang-123456
```

Setelah berhasil, owner tersimpan di Turso. Tidak perlu edit `OWNER_LIDS` dan tidak perlu redeploy.

Command lain:

```text
/whoami
/owners
/addowner lid:3229882572954
/addowner pn:62881025616260
/removeowner lid:3229882572954
```

`OWNER_NUMBERS` dan `OWNER_LIDS` tetap boleh dipakai sebagai bootstrap/fallback, tetapi v8 lebih nyaman memakai DB owner.
