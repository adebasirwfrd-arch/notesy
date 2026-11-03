import type { Template } from "./types";

export const BUILTIN_TEMPLATES: Template[] = [
  {
    id: "auto",
    name: "Otomatis",
    description: "AI memilih struktur yang paling cocok dengan isi rapat.",
    sections: [],
    builtin: true,
  },
  {
    id: "coordination",
    name: "Rapat koordinasi",
    description: "Rapat lintas tim: status, keputusan, dan tindak lanjut.",
    sections: [
      { title: "Situasi", hint: "Konteks dan status terkini yang dibahas" },
      { title: "Pembahasan per topik", hint: "Satu sub-bagian per topik atau slide penting" },
      { title: "Keputusan", hint: "Hanya keputusan yang benar-benar disepakati" },
      { title: "Tindak lanjut", hint: "Tabel: Penanggung jawab | Tugas | Tenggat (hanya jika disebut)" },
      { title: "Risiko dan catatan", hint: "Hambatan, kekhawatiran, pertanyaan terbuka" },
    ],
    builtin: true,
  },
  {
    id: "standup",
    name: "Daily standup",
    description: "Kemarin, hari ini, hambatan per orang.",
    sections: [
      { title: "Progres", hint: "Apa yang selesai, dikelompokkan per orang jika jelas" },
      { title: "Rencana", hint: "Apa yang akan dikerjakan berikutnya" },
      { title: "Hambatan", hint: "Blocker dan siapa yang bisa membantu" },
    ],
    builtin: true,
  },
  {
    id: "one-on-one",
    name: "1:1",
    description: "Percakapan atasan–anggota tim.",
    sections: [
      { title: "Topik yang dibahas", hint: "Ringkas per topik" },
      { title: "Umpan balik", hint: "Umpan balik dua arah yang disebut" },
      { title: "Pengembangan", hint: "Tujuan, karier, pembelajaran" },
      { title: "Komitmen", hint: "Siapa melakukan apa sebelum pertemuan berikutnya" },
    ],
    builtin: true,
  },
  {
    id: "kickoff",
    name: "Kickoff proyek",
    description: "Tujuan, ruang lingkup, peran, dan jadwal.",
    sections: [
      { title: "Tujuan", hint: "Masalah yang diselesaikan dan ukuran keberhasilan" },
      { title: "Ruang lingkup", hint: "Yang masuk dan yang tidak" },
      { title: "Peran", hint: "Siapa bertanggung jawab atas apa" },
      { title: "Jadwal dan milestone", hint: "Tanggal yang disebut" },
      { title: "Risiko", hint: "Asumsi dan risiko awal" },
    ],
    builtin: true,
  },
  {
    id: "sales",
    name: "Sales discovery",
    description: "Kebutuhan klien, hambatan, langkah berikutnya.",
    sections: [
      { title: "Profil klien", hint: "Organisasi, peran peserta, konteks" },
      { title: "Kebutuhan dan masalah", hint: "Pain point dengan kata-kata klien" },
      { title: "Keberatan", hint: "Kekhawatiran harga, teknis, waktu" },
      { title: "Langkah berikutnya", hint: "Komitmen kedua pihak dan tanggal" },
    ],
    builtin: true,
  },
  {
    id: "lecture",
    name: "Presentasi / kuliah",
    description: "Fokus pada isi slide dan penjelasan pembicara.",
    sections: [
      { title: "Inti materi", hint: "Gagasan utama dalam 3–5 poin" },
      { title: "Penjelasan per slide", hint: "Sisipkan gambar slide dan jelaskan isinya" },
      { title: "Tanya jawab", hint: "Pertanyaan dan jawabannya" },
      { title: "Hal yang perlu dipelajari lagi", hint: "Istilah atau topik lanjutan" },
    ],
    builtin: true,
  },
];
