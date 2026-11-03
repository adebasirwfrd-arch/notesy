import type { Note, Segment, Slide, Template } from "../types";
import { formatClock, formatDate, formatTime } from "../util";

export const AGENT_PREAMBLE = `Kamu adalah asisten notulen rapat di aplikasi Notesy.
Kamu TIDAK sedang mengerjakan kode: jangan menjalankan perintah, jangan membuat atau mengubah file, jangan memakai tool apa pun.
Balas hanya dengan teks jawaban yang diminta, tanpa pembuka atau penutup.`;

export function speakerName(note: Note, seg: Segment) {
  return note.speakerNames[seg.speaker] || seg.speaker || "Pembicara";
}

export function transcriptText(note: Note, maxChars = 180_000) {
  const lines: string[] = [];
  let last = "";
  for (const s of note.transcript) {
    const who = speakerName(note, s);
    if (who === last && lines.length) lines[lines.length - 1] += " " + s.text;
    else lines.push(`[${formatClock(s.start * 1000)}] ${who}: ${s.text}`);
    last = who;
  }
  let text = lines.join("\n");
  if (text.length > maxChars) {
    const head = text.slice(0, maxChars * 0.6);
    const tail = text.slice(-maxChars * 0.4);
    text = `${head}\n…(bagian tengah dipotong karena terlalu panjang)…\n${tail}`;
  }
  return text;
}

export function transcriptAround(note: Note, tSec: number, before = 60, after = 120) {
  return note.transcript
    .filter((s) => s.end >= tSec - before && s.start <= tSec + after)
    .map((s) => `${speakerName(note, s)}: ${s.text}`)
    .join(" ")
    .slice(0, 2500);
}

export function describePrompt(note: Note, slides: Slide[]) {
  const items = slides
    .map(
      (s, i) =>
        `Gambar ${i + 1} — id: ${s.id}, menit ${formatClock(s.t)}\nPercakapan di sekitar waktu itu: ${transcriptAround(note, s.t / 1000) || "(tidak ada ucapan)"}`,
    )
    .join("\n\n");
  return `Berikut ${slides.length} tangkapan layar dari rapat "${note.title}", berurutan sesuai lampiran.

${items}

Untuk setiap gambar, tentukan:
- caption: judul singkat isi layar (maks 10 kata, bahasa Indonesia).
- description: 2–4 kalimat yang menjelaskan isi slide/layar DAN apa yang dibahas peserta saat layar itu tampil. Sebut angka, nama, istilah yang terlihat. Jangan mengarang.
- keep: false jika gambar tidak informatif (hanya wajah/galeri video, layar kosong, desktop, loading, atau duplikat gambar sebelumnya), selain itu true.

Balas HANYA JSON array tanpa code fence:
[{"id":"...","caption":"...","description":"...","keep":true}]`;
}

export interface SummaryContext {
  note: Note;
  slides: Slide[];
  template?: Template;
  language: string;
  maxImages: number;
  extraInstructions?: string;
  userName?: string;
  meLabel?: string;
}

export function summaryPrompt({ note, slides, template, language, maxImages, extraInstructions, userName, meLabel }: SummaryContext) {
  const speakers = [...new Set(note.transcript.map((s) => speakerName(note, s)))];
  const words = note.transcript.reduce((n, s) => n + s.text.split(/\s+/).length, 0);
  const length = words < 600 ? "ringkas (± 150–300 kata)" : words < 3000 ? "sedang (± 300–600 kata)" : "lengkap (± 600–1200 kata)";
  const usable = slides.filter((s) => !s.excluded);
  const slideList = usable.length
    ? usable
        .map((s) => `- slide:${s.id} | menit ${formatClock(s.t)} | ${s.caption ?? "(tanpa caption)"}${s.description ? ` — ${s.description}` : ""}`)
        .join("\n")
    : "(tidak ada)";
  const structure =
    template && template.sections.length
      ? `Gunakan struktur ini (heading "## " persis seperti tertulis):\n${template.sections.map((s) => `## ${s.title} — ${s.hint}`).join("\n")}`
      : `Pilih sendiri 3–6 bagian "## " yang paling cocok dengan isi rapat (misalnya Situasi, Pembahasan, Keputusan, Tindak lanjut, Risiko). Jika ada tugas yang disebut, buat bagian "## Tindak lanjut" berupa tabel: | Penanggung jawab | Tugas | Tenggat |.`;

  return `Buat ringkasan rapat dalam ${language}.

## Data rapat
- Judul sementara: ${note.title}
- Tanggal: ${formatDate(note.createdAt)} ${formatTime(note.startedAt ?? note.createdAt)}
- Durasi: ${formatClock(note.durationMs)}
- Pembicara terdeteksi: ${speakers.join(", ") || "-"}${userName ? `\n- Pengguna aplikasi bernama ${userName}${meLabel ? `; hanya baris berlabel "${meLabel}" yang diucapkan olehnya` : ""}. Jangan menganggap kata "saya" dari pembicara lain sebagai ${userName}.` : ""}

## Catatan pribadi pengguna (memo) — prioritaskan poin yang ditandai di sini
${note.memo.trim() || "(kosong)"}

## Tangkapan layar yang tersedia
${slideList}

## Transkrip
${transcriptText(note)}

## Aturan
1. Baris pertama: "Judul: <judul rapat yang spesifik, maks 8 kata>". Baris kedua kosong. Lalu isi ringkasan.
2. ${structure}
3. Tiap bagian berisi minimal 3 poin konkret (kecuali memang tidak ada). Tulis fakta, angka, nama, dan istilah persis seperti di transkrip/slide.
4. JANGAN mengarang. Penanggung jawab dan tenggat hanya diisi jika disebut jelas; jika tidak, tulis "-".
5. Istilah teknis dan nama produk tetap dalam bentuk aslinya (biasanya bahasa Inggris).
6. Sisipkan gambar slide yang relevan di dalam bagian pembahasannya memakai sintaks persis: ![caption singkat](slide:ID). Maksimal ${maxImages} gambar, hanya yang benar-benar membantu memahami diskusi, dan tulis 1–2 kalimat penjelasan tepat di bawah tiap gambar. Jangan menyisipkan ID yang tidak ada di daftar.
7. Panjang ${length}. Tanpa kata pembuka, tanpa penutup, tanpa code fence.${extraInstructions?.trim() ? `\n8. Instruksi tambahan pengguna: ${extraInstructions.trim()}` : ""}`;
}

export function chatContext(note: Note, summary?: string) {
  return `Konteks rapat "${note.title}" (${formatDate(note.createdAt)}).

${summary ? `Ringkasan saat ini:\n${summary}\n\n` : ""}Memo pengguna:\n${note.memo.trim() || "(kosong)"}

Transkrip:\n${transcriptText(note, 120_000)}`;
}

export const CHAT_RULES = `Jawab pertanyaan pengguna tentang rapat ini dalam bahasa yang sama dengan pertanyaannya.
Dasarkan jawaban hanya pada transkrip, memo, dan ringkasan. Kutip waktu [mm:ss] bila membantu. Jika informasinya tidak ada, katakan terus terang.
Gunakan Markdown seperlunya.`;

export function parseSummary(raw: string) {
  let text = raw.trim().replace(/^```(?:markdown|md)?\s*/i, "").replace(/```\s*$/, "").trim();
  let title: string | undefined;
  const m = text.match(/^\s*(?:\*\*)?Judul(?:\*\*)?\s*:\s*(.+)\n/i);
  if (m) {
    title = m[1].replace(/[*#"]/g, "").trim();
    text = text.slice(m[0].length).trim();
  }
  return { title, markdown: text };
}

export function parseSlideJson(raw: string): { id: string; caption?: string; description?: string; keep?: boolean }[] {
  const start = raw.indexOf("[");
  const end = raw.lastIndexOf("]");
  if (start < 0 || end < start) return [];
  try {
    const arr = JSON.parse(raw.slice(start, end + 1));
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}
