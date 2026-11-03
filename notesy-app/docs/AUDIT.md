# Audit Anarlog → spesifikasi Notesy

Dokumen ini merangkum audit fitur Anarlog (fastrepl/anarlog, commit terbaru branch `main`, 3 Nov 2026), yang dipakai sebagai **referensi perilaku saja**. Kode Notesy ditulis dari nol dan tidak menyalin file, aset, atau teks prompt Anarlog. Bagian Anarlog yang diaudit berlisensi MIT; folder `enterprise/` tidak dibuka.

## Cakupan audit

Repo Anarlog berisi 7.323 file, terdiri dari 200+ crate Rust dan aplikasi desktop, web, mobile, dan CLI. Audit membaca seluruh file pada bagian yang menentukan fitur inti:

| Area | Path yang dibaca |
|---|---|
| Layar sesi, sidebar, floating bar, routes | `apps/desktop/src/{session,sidebar,meeting-float,routes}` |
| Setelan, AI, store, enhancer | `apps/desktop/src/{settings,ai,store,services}` |
| Prompt dan pembuat summary | `crates/{summary,template-app}` |
| Perekaman, transcript, chat | `crates/{meeting-capture,listener2-core,transcript}`, `apps/desktop/src/chat` |
| Integrasi Chrome, mobile | `crates/chrome-native-host`, `apps/mobile` |

## Temuan inti dan keputusan Notesy

### 1. Kerangka aplikasi
- **Anarlog:** sidebar timeline yang dikelompokkan per hari (Today, Yesterday, N days ago), lalu per minggu, lalu per bulan. Ada pencarian, filter, dan catatan baru.
  - Header berisi folder, tombol Record / Stop / Share, dan menu `⋯` (export, re-transcribe, delete, dan lain-lain).
  - Di bawah ada kolom "Ask anything".
- **Notesy:** sama. Sidebar timeline per hari; header dengan tombol Rekam/Stop, Share/Export, dan menu `⋯`; kolom *Tanya apa saja* di bawah.

### 2. Tiga tab catatan
- **Anarlog:** tab **Summary** (bisa lebih dari satu, per template), **Memos** (catatan sendiri), dan **Transcript**. Summary dan Memos memakai rich-text editor dengan autosave. Saat tidak aktif, tab hanya menampilkan ikon.
- **Notesy:** sama. Tambahannya, **screenshot slide disisipkan di bagian summary yang relevan, lengkap dengan penjelasannya**. Anarlog hanya menampilkan galeri screenshot di bawah memo.

### 3. Perekaman
- **Anarlog:** dua kanal disimpan terpisah. Kanal 0 adalah mic ("You"), kanal 1 adalah audio sistem (peserta lain). Tidak ada tombol pause. Ada floating bar always-on-top dengan level meter dan tombol stop.
- **Notesy:**
  - Merekam mic dan audio layar/tab sebagai dua track terpisah, sehingga label **Saya** dan **Peserta** bisa dibedakan.
  - **Ada pause/resume.**
  - Floating bar memakai **Document Picture-in-Picture** di Chrome: timer, level, jeda, stop, dan screenshot manual.

### 4. Screenshot rapat
- **Anarlog:** "Capture shared screens in Memos" (macOS/Windows native). Gambar memo ikut dikirim ke model summary, maksimal 10 gambar dengan sisi terpanjang 1280 px.
- **Notesy:** frame layar yang di-share diambil sampelnya tiap 1,5 detik. Screenshot disimpan otomatis ketika slide berganti dan sudah stabil, dan bisa juga diambil manual. AI menjelaskan isi tiap slide, lalu summary menyisipkan `![…](slide:ID)` di bagian yang relevan.

### 5. Transkripsi
- **Anarlog:** model lokal (whisper.cpp dan lainnya) atau cloud. Bahasa utama ditambah bahasa lain, dan kamus dikirim sebagai `keywords`.
- **Notesy:**
  - Whisper berjalan **di dalam browser** (WebGPU, atau WASM sebagai cadangan), dijalankan per kanal.
  - Opsional: API yang kompatibel dengan OpenAI.
  - Isi kamus dipakai sebagai prompt Whisper dan sebagai "Ejaan nama".

### 6. Pipeline summary (perilaku yang ditiru, prompt ditulis ulang)
- Input yang dikirim: konteks rapat, memo, transcript berformat `Pembicara: teks`, template, bahasa, dan kamus.
- Aturan isi:
  - Markdown dengan heading `#` per bagian.
  - Minimal 3 poin konkret per bagian.
  - Tidak boleh mengarang.
  - Penanggung jawab dan tenggat hanya dicantumkan kalau disebut eksplisit.
  - Istilah teknis tetap dalam bahasa Inggris.
  - Tanpa pembuka atau penutup basa-basi.
- Panjang summary disesuaikan dengan panjang transcript; rapat singkat menghasilkan summary singkat.
- Judul dibuat oleh tugas terpisah yang hanya menghasilkan teks singkat.
- **Mesin AI Notesy: Cursor Cloud Agents API**, memakai akun Cursor user, tanpa repo. Satu agent dipakai per rapat. Chat menjadi follow-up pada agent yang sama.

### 7. Template
- **Anarlog:** template berbentuk `{judul, deskripsi, bagian[]}`; tersedia template bawaan untuk standup, 1:1, kickoff, dan sales discovery; ada pilihan "Auto".
- **Notesy:** template bawaan **Otomatis**, **Rapat koordinasi**, **Daily standup**, **1:1**, **Kickoff proyek**, dan **Sales discovery**, ditambah template custom.

### 8. Setelan
- **Anarlog:** General (bahasa utama, bahasa tambahan, summary pakai bahasa utama), Transcription, Intelligence (provider, model, uji koneksi), Dictionary, Meetings, Templates, Privacy, Appearance.
- **Notesy:**
  - Umum (bahasa dan tema)
  - Rekaman (mode, mikrofon, screenshot otomatis, sensitivitas)
  - Transkripsi
  - Intelligence (Cursor API key, model, uji koneksi; OpenAI-compatible sebagai opsi)
  - Template
  - Kamus
  - Data (ekspor, impor, hapus)

### 9. Chat
- **Anarlog:** konteks berisi metadata rapat, summary atau memo, dan transcript `[mm:ss] Pembicara: teks`. Saran prompt yang tersedia: "List action items", "Draft follow-up email", "Find key decisions".
- **Notesy:** sama, dikirim ke agent Cursor rapat tersebut.

### 10. Mobile
- **Anarlog:** Expo React Native, mic mono 16 kHz, transkripsi lewat cloud.
- **Notesy:** APK Capacitor dari codebase web yang sama. Merekam lewat mic; foto atau impor gambar slide. Whisper berjalan di WebView, atau lewat API.

## Hal yang sengaja tidak ditiru
Notesy tidak meniru akun, billing, cloud sync, bot yang ikut masuk rapat, integrasi kalender, CRM, dan Zoom/Teams import. Semua data Notesy tersimpan lokal (IndexedDB). Data hanya keluar ke Cursor (teks transcript + screenshot) saat summary dibuat atau chat dipakai.
