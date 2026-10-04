# Spotify Clone + Tools

## Struktur
- index.html            -> player musik (deploy ke Vercel)
- vercel.json
- assets/               -> taruh door-closed.jpg & door-open.jpg (lihat README.txt)
- tools/                -> menu Tools (cek khodam, jodoh, install panel)
- server/               -> backend Install Panel (JANGAN di-deploy ke Vercel)

## Deploy web (Vercel)
Upload folder ini ke GitHub lalu import di vercel.com.
Folder `server/` otomatis diabaikan lewat .vercelignore.

## Jalankan backend Install Panel (di VPS / Railway / Render)
cd server
npm install
API_TOKEN=rahasiamu ALLOWED_ORIGIN=https://webmu.vercel.app node server.js

Lalu buka /tools/installpanel.html di webmu, isi alamat API (https) dan token itu.
