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
  for (const sec of note.cleanTranscript?.sections ?? []) {
    if (sec.title) lines.push(`## ${sec.title}`);
    for (const p of sec.paragraphs) lines.push(`[${formatClock(p.start * 1000)}] ${p.speaker}: ${p.text}`);
  }
  if (lines.length) return clip(lines.join("\n"), maxChars);
  let last = "";
  for (const s of note.transcript) {
    const who = speakerName(note, s);
    if (who === last && lines.length) lines[lines.length - 1] += " " + s.text;
    else lines.push(`[${formatClock(s.start * 1000)}] ${who}: ${s.text}`);
    last = who;
  }
  return clip(lines.join("\n"), maxChars);
}

function clip(text: string, maxChars: number) {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars * 0.6)}\n…(bagian tengah dipotong karena terlalu panjang)…\n${text.slice(-maxChars * 0.4)}`;
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
  micOnly?: boolean;
}

export function summaryPrompt({ note, slides, template, language, maxImages, extraInstructions, userName, meLabel, micOnly }: SummaryContext) {
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
- Pembicara terdeteksi: ${speakers.join(", ") || "-"}${userName ? `\n- Pengguna aplikasi bernama ${userName}${meLabel ? `; hanya baris berlabel "${meLabel}" yang diucapkan olehnya` : ""}. Jangan menganggap kata "saya" dari pembicara lain sebagai ${userName}.` : ""}${
    micOnly
      ? `\n- Audio hanya dari satu mikrofon: suara peserta rapat online (dari speaker) dan orang di ruangan terekam dengan label yang sama. Label pembicara tidak menunjukkan siapa yang bicara, jadi jangan menyebut label itu atau ${userName || "pengguna"} sebagai pembicara. Tulis "peserta" atau nama yang disebut dalam percakapan.`
      : ""
  }

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

export function momItemsPrompt(note: Note, language: string, attendees: string[], summary?: string) {
  const minutes = Math.max(1, Math.round(note.durationMs / 60000));
  const target = Math.min(40, Math.max(2, Math.round(minutes / 3)));
  return `Susun daftar "Key points covered" untuk notulen rapat (MoM) dalam ${language}.

## Data rapat
- Judul: ${note.title}
- Durasi: ${formatClock(note.durationMs)} (± ${minutes} menit)
- Peserta terdaftar: ${attendees.join(", ") || "(tidak diisi)"}

## Memo pengguna
${note.memo.trim() || "(kosong)"}
${summary ? `\n## Ringkasan rapat\n${summary}\n` : ""}
## Transkrip
${transcriptText(note)}

## Aturan
1. Satu baris untuk SETIAP topik/agenda berbeda yang benar-benar dibahas, urut sesuai waktu dibahas. Jangan menggabungkan topik berbeda, jangan memecah satu topik menjadi beberapa baris.
2. Jumlah baris mengikuti isi rapat, bukan angka tetap. Sebagai patokan, rapat ${minutes} menit biasanya berisi sekitar ${target} topik; boleh lebih sedikit atau lebih banyak sesuai isi transkrip (maksimal 40).
3. description: 1–2 kalimat padat: topik apa yang dibahas DAN hasilnya (keputusan, angka, temuan, tindak lanjut). Tulis nama, angka, dan istilah teknis persis seperti di transkrip.
4. pic: nama orang/tim yang bertanggung jawab bila disebut jelas (utamakan ejaan dari daftar peserta). Jika tidak disebut, isi "-". Jangan mengarang nama.
5. status: pilih salah satu: "Open" (perlu tindak lanjut), "In Progress" (sedang dikerjakan), "Closed" (selesai/sudah diputuskan), "Info" (hanya penyampaian informasi).
6. Jangan memasukkan basa-basi, salam, atau gangguan teknis rapat sebagai topik.

Balas HANYA JSON array tanpa code fence:
[{"description":"...","pic":"...","status":"Open"}]`;
}

export function parseMomItems(raw: string): { description: string; pic: string; status: string }[] {
  const start = raw.indexOf("[");
  const end = raw.lastIndexOf("]");
  if (start < 0 || end < start) return [];
  try {
    const arr = JSON.parse(raw.slice(start, end + 1));
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((x) => x && typeof x.description === "string" && x.description.trim())
      .map((x) => ({ description: String(x.description).trim(), pic: String(x.pic ?? "-").trim() || "-", status: String(x.status ?? "Open").trim() || "Open" }));
  } catch {
    return [];
  }
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

export interface TidyParagraph {
  index: number;
  start: number;
  speaker: string;
  text: string;
}

export function tidyPrompt(opts: {
  title: string;
  part: number;
  parts: number;
  /** End of the previous part's raw text, so a continuing topic gets no new heading. */
  before?: string;
  /** Speaker labels established in the first part. */
  roster?: string[];
  paragraphs: TidyParagraph[];
  fixedNames: string[];
  genericLabels: string[];
  attendees: string[];
  glossary: string[];
}) {
  const { title, part, parts, before, roster, paragraphs, fixedNames, genericLabels, attendees, glossary } = opts;
  const lines = paragraphs.map((p) => `[P${p.index}] ${formatClock(p.start * 1000)} ${p.speaker}: ${p.text}`).join("\n");
  return `Rapikan bagian ${part} dari ${parts} transkrip rapat "${title}". Transkrip ini hasil speech-to-text: ada kata salah dengar, kata berulang, dan ucapan beberapa orang yang tercampur.

Tugas:
1. Kelompokkan per topik. Tulis judul topik singkat (maks 8 kata) pada baris "## Judul" setiap kali topik pembicaraan berganti.${
    before ? ` Bagian sebelumnya diakhiri dengan: "…${before}". Jika awal bagian ini masih melanjutkan pembicaraan itu, jangan tulis judul di awal.` : ""
  }
2. Tulis setiap paragraf dengan format persis: [P<nomor>] <Nama pembicara>: <teks rapi>
   <nomor> adalah nomor paragraf asal tempat kalimat itu dimulai. Satu paragraf asal boleh dipecah menjadi beberapa baris (nomor sama) jika jelas ada pergantian pembicara, misalnya tanya-jawab.
3. Perbaiki ejaan dan kata yang jelas salah dengar sesuai konteks${glossary.length ? " dan kamus istilah" : ""}. Hapus kata pengisi (eh, hmm, apa namanya), pengulangan, dan teks yang jelas halusinasi (misalnya "Terima kasih telah menonton"). JANGAN meringkas, JANGAN menambah informasi; semua isi tetap ada. Pertahankan bahasa asli (campuran Indonesia, Inggris, atau daerah tetap apa adanya). Bagian yang tidak bisa dipahami tulis [tidak jelas].
4. Pembicara: ${fixedNames.length ? `nama dari Meet/Teams (${fixedNames.join(", ")}) sudah pasti benar, jangan diganti. ` : ""}${
    genericLabels.length
      ? `Label umum (${genericLabels.join(", ")}) boleh diganti dengan nama orang hanya jika jelas dari isi (memperkenalkan diri, dipanggil lalu menjawab). Jika satu label umum jelas berisi beberapa orang yang namanya tidak diketahui, pakai "Pembicara A", "Pembicara B", dst. secara konsisten di seluruh rapat. Jika ragu, biarkan label aslinya.`
      : ""
  }${
    roster?.length
      ? `\n   Pembicara yang sudah dikenali di awal rapat (pakai label yang sama jika orangnya sama):\n${roster.map((r) => `   - ${r}`).join("\n")}`
      : '\n5. Di akhir, tulis satu baris per pembicara: "@ <label>: <peran atau ciri singkat>", agar bagian berikutnya memakai label yang sama.'
  }
${attendees.length ? `Peserta yang diketahui: ${attendees.join(", ")}\n` : ""}${glossary.length ? `Kamus istilah (ejaan yang benar): ${glossary.join(", ")}\n` : ""}
Balas HANYA baris "## Judul"${roster ? "" : ', baris "@ …"'} dan baris "[P<nomor>] Nama: teks", tanpa pembuka, penutup, atau code fence.

Transkrip:
${lines}`;
}

/** Parses tidy output into sections; paragraphs before the first heading continue the previous part's last topic. */
export function parseTidy(raw: string, starts: Map<number, number>) {
  const sections: {
    title: string;
    paragraphs: { speaker: string; start: number; text: string }[];
  }[] = [];
  const roster: string[] = [];
  let lastStart = 0;
  for (const line of raw.split("\n").map((l) => l.trim().replace(/^[*_-]+\s*|\s*[*_]+$/g, ""))) {
    const r = line.match(/^@\s*(.+)$/);
    if (r) {
      roster.push(r[1].trim());
      continue;
    }
    const h = line.match(/^#{1,4}\s+(.+)$/);
    if (h) {
      sections.push({ title: h[1].replace(/\*+/g, "").trim(), paragraphs: [] });
      continue;
    }
    const p = line.match(/^\[?P(\d+)\]?\s*(?:\d{1,2}:\d{2}(?::\d{2})?\s+)?([^:]{1,60}):\s*(.+)$/);
    if (!p) continue;
    const start = starts.get(Number(p[1])) ?? lastStart;
    lastStart = start;
    if (!sections.length) sections.push({ title: "", paragraphs: [] });
    sections[sections.length - 1].paragraphs.push({
      speaker: p[2].replace(/\*+/g, "").trim(),
      start,
      text: p[3].trim(),
    });
  }
  return { sections: sections.filter((s) => s.paragraphs.length), roster };
}
