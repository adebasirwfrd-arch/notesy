import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFImage, type PDFPage, type RGB } from "pdf-lib";
import { strFromU8, type Unzipped } from "fflate";
import { readTemplate, type MomExportInput } from "./docx";
import { dataUrlToBytes, fitBox, normalizeImage } from "./index";
import type { Signature } from "../types";

/*
 * Geometry is measured from the "MoM Roster Meeting" template rendered at US Letter (points, top-left origin),
 * so the PDF lines up with the Word file cell for cell.
 */
const PAGE = { w: 612, h: 792 };
const BODY_TOP = 108.2;
const BODY_BOTTOM = 720;
const HEADER = { xs: [35.1, 74.9, 127.1, 235.2, 334.1, 410.7, 508.8, 588.0], ys: [28.7, 52.5, 62.3, 80.8] };
const KEYPOINTS = { xs: [37.2, 72.0, 302.7, 435.4, 568.2], split: 256.5, rows: [108.2, 120.2, 132.2, 144.2, 158.8], itemH: 13.15, blankRows: 41 };
const ROSTER = {
  xs: [21.2, 192.4, 277.5, 362.5, 454.7, 590.2],
  headTop: 131.2,
  headBottom: 155.2,
  rows: [37.8, 41.3, 37.7, 37.6, 41.9, 46, 46, 46, 46, 46, 46],
  labels: ["PRINT NAME", "COMPANY", "EMP #", "TITLE/POSITION", "SIGNATURE"],
};
const PREPARED = { x0: 36.3, x1: 252.0, ys: [121.5, 137.8, 254.2, 270.7, 288.5] };
const EVIDENCE = { labelTop: 311.9, top: 335.4, xs: [36.3, 309.1, 582.0], pairs: [[165.5, 12], [185.7, 13]] as [number, number][], nextPair: [185.7, 13] as [number, number] };
const TEXT = { size: 10, ascent: 9.05, line: 11.5, pad: 5.5 };
const BLACK = rgb(0, 0, 0);
const GRAY_FILL = rgb(0xa6 / 255, 0xa6 / 255, 0xa6 / 255);
const WHITE = rgb(1, 1, 1);
const LINE = 0.5;

const hex = (h: string) => rgb(parseInt(h.slice(0, 2), 16) / 255, parseInt(h.slice(2, 4), 16) / 255, parseInt(h.slice(4, 6), 16) / 255);
const textOf = (xml: string) => [...xml.matchAll(/<w:t(?: [^>]*)?>([^<]*)<\/w:t>/g)].map((m) => decode(m[1])).join("");
const decode = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

interface Fonts {
  regular: PDFFont;
  bold: PDFFont;
  /** Maps characters the standard PDF fonts cannot encode (WinAnsi) to readable stand-ins. */
  safe: (s: string) => string;
}

interface Chrome {
  title: string;
  labels: string[];
  values: string[];
  logos: { img: PDFImage; w: number; h: number }[];
  footer: Span[][];
}

const WINANSI_FALLBACK: Record<string, string> = { "→": "->", "←": "<-", "≥": ">=", "≤": "<=", "✓": "v", "✔": "v", "✗": "x", "≈": "~", "\u00a0": " ", "\t": " ", "\n": "\n" };

function makeSafe(fonts: Pick<Fonts, "regular" | "bold">) {
  const ok = new Map<string, boolean>();
  return (s: string) =>
    [...s]
      .map((ch) => {
        if (WINANSI_FALLBACK[ch] !== undefined) return WINANSI_FALLBACK[ch];
        if (!ok.has(ch)) {
          try {
            fonts.bold.encodeText(ch);
            fonts.regular.encodeText(ch);
            ok.set(ch, true);
          } catch {
            ok.set(ch, false);
          }
        }
        return ok.get(ch) ? ch : "?";
      })
      .join("");
}

type Span = { text: string; bold?: boolean; color?: RGB };

/** Word-wraps mixed regular/bold spans to a width, returning lines of spans. */
function wrap(spans: Span[], width: number, fonts: Fonts, size = TEXT.size): Span[][] {
  const lines: Span[][] = [[]];
  let x = 0;
  const widthOf = (t: string, bold?: boolean) => (bold ? fonts.bold : fonts.regular).widthOfTextAtSize(t, size);
  for (const span of spans) {
    for (const [i, para] of fonts.safe(span.text).split("\n").entries()) {
      if (i > 0) {
        lines.push([]);
        x = 0;
      }
      for (const word of para.split(/(\s+)/).filter(Boolean)) {
        const space = /^\s+$/.test(word);
        let w = widthOf(word, span.bold);
        if (!space && x + w > width && x > 0) {
          lines.push([]);
          x = 0;
        }
        if (space && x === 0) continue;
        let piece = word;
        while (!space && w > width) {
          let cut = piece.length - 1;
          while (cut > 1 && widthOf(piece.slice(0, cut), span.bold) > width - x) cut--;
          lines[lines.length - 1].push({ ...span, text: piece.slice(0, cut) });
          lines.push([]);
          x = 0;
          piece = piece.slice(cut);
          w = widthOf(piece, span.bold);
        }
        lines[lines.length - 1].push({ ...span, text: piece });
        x += w;
      }
    }
  }
  return lines;
}

class Writer {
  pages: PDFPage[] = [];
  page!: PDFPage;
  safe: (s: string) => string;
  constructor(
    public pdf: PDFDocument,
    public fonts: Fonts,
  ) {
    this.safe = fonts.safe;
  }

  newPage() {
    this.page = this.pdf.addPage([PAGE.w, PAGE.h]);
    this.pages.push(this.page);
    return this.page;
  }

  text(t: string, x: number, top: number, opts: { bold?: boolean; size?: number; color?: RGB } = {}) {
    const size = opts.size ?? TEXT.size;
    this.page.drawText(this.safe(t), { x, y: PAGE.h - top - size * 0.905, size, font: opts.bold ? this.fonts.bold : this.fonts.regular, color: opts.color ?? BLACK });
  }

  spans(line: Span[], x: number, top: number, size = TEXT.size, color: RGB = BLACK) {
    for (const s of line) {
      const t = this.safe(s.text);
      const font = s.bold ? this.fonts.bold : this.fonts.regular;
      this.page.drawText(t, { x, y: PAGE.h - top - size * 0.905, size, font, color: s.color ?? color });
      x += font.widthOfTextAtSize(t, size);
    }
  }

  lineWidth(line: Span[], size = TEXT.size) {
    return line.reduce((w, s) => w + (s.bold ? this.fonts.bold : this.fonts.regular).widthOfTextAtSize(this.safe(s.text), size), 0);
  }

  rect(x0: number, top: number, x1: number, bottom: number, fill?: RGB) {
    this.page.drawRectangle({ x: x0, y: PAGE.h - bottom, width: x1 - x0, height: bottom - top, borderColor: BLACK, borderWidth: LINE, color: fill });
  }

  hline(x0: number, x1: number, top: number) {
    this.page.drawLine({ start: { x: x0, y: PAGE.h - top }, end: { x: x1, y: PAGE.h - top }, thickness: LINE, color: BLACK });
  }

  vline(x: number, top: number, bottom: number) {
    this.page.drawLine({ start: { x, y: PAGE.h - top }, end: { x, y: PAGE.h - bottom }, thickness: LINE, color: BLACK });
  }

  image(img: PDFImage, x0: number, top: number, x1: number, bottom: number, natural: { w: number; h: number }, pad = 4) {
    const { w, h } = fitBox(natural.w, natural.h, x1 - x0 - pad * 2, bottom - top - pad * 2);
    if (w <= 0 || h <= 0) return;
    this.page.drawImage(img, { x: x0 + (x1 - x0 - w) / 2, y: PAGE.h - top - (bottom - top + h) / 2, width: w, height: h });
  }
}

async function cropToPng(bytes: Uint8Array, mime: string, crop?: { l: number; t: number; r: number; b: number }) {
  const bmp = await createImageBitmap(new Blob([bytes as BlobPart], { type: mime }));
  const sx = ((crop?.l ?? 0) / 100000) * bmp.width;
  const sy = ((crop?.t ?? 0) / 100000) * bmp.height;
  const sw = bmp.width * (1 - ((crop?.l ?? 0) + (crop?.r ?? 0)) / 100000);
  const sh = bmp.height * (1 - ((crop?.t ?? 0) + (crop?.b ?? 0)) / 100000);
  const canvas = new OffscreenCanvas(Math.max(1, Math.round(sw)), Math.max(1, Math.round(sh)));
  canvas.getContext("2d")!.drawImage(bmp, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
  bmp.close();
  return new Uint8Array(await (await canvas.convertToBlob({ type: "image/png" })).arrayBuffer());
}

async function readChrome(files: Unzipped, pdf: PDFDocument): Promise<Chrome> {
  const docRels = strFromU8(files["word/_rels/document.xml.rels"]);
  const doc = strFromU8(files["word/document.xml"]);
  const relTarget = (rels: string, id: string) => rels.match(new RegExp(`<Relationship [^>]*Id="${id}"[^>]*Target="([^"]+)"`))?.[1] ?? rels.match(new RegExp(`<Relationship [^>]*Target="([^"]+)"[^>]*Id="${id}"`))?.[1];
  const sect = doc.slice(doc.lastIndexOf("<w:sectPr"));
  const headerFile = relTarget(docRels, sect.match(/<w:headerReference [^>]*w:type="default"[^>]*r:id="([^"]+)"/)?.[1] ?? "") ?? "header1.xml";
  const footerFile = relTarget(docRels, sect.match(/<w:footerReference [^>]*w:type="default"[^>]*r:id="([^"]+)"/)?.[1] ?? "") ?? "footer1.xml";
  const header = strFromU8(files[`word/${headerFile}`] ?? new Uint8Array());
  const headerRels = strFromU8(files[`word/_rels/${headerFile}.rels`] ?? new Uint8Array());
  const rows = (header.match(/<w:tr[ >][\s\S]*?<\/w:tr>/g) ?? []).map((r) => (r.match(/<w:tc>[\s\S]*?<\/w:tc>/g) ?? []).map(textOf));

  const logos: Chrome["logos"] = [];
  for (const d of header.match(/<w:drawing>[\s\S]*?<\/w:drawing>/g) ?? []) {
    const id = d.match(/r:embed="([^"]+)"/)?.[1];
    const target = id && relTarget(headerRels, id);
    const bytes = target && files[`word/${target.replace(/^\.\//, "")}`];
    if (!bytes) continue;
    const ext = d.match(/<wp:extent cx="(\d+)" cy="(\d+)"/);
    const src = d.match(/<a:srcRect l="(\d+)" t="(\d+)" r="(\d+)" b="(\d+)"/);
    const mime = /\.gif$/i.test(target) ? "image/gif" : /\.jpe?g$/i.test(target) ? "image/jpeg" : "image/png";
    const png = await cropToPng(bytes, mime, src ? { l: +src[1], t: +src[2], r: +src[3], b: +src[4] } : undefined);
    logos.push({ img: await pdf.embedPng(png), w: ext ? +ext[1] / 12700 : 30, h: ext ? +ext[2] / 12700 : 20 });
  }

  const footerXml = strFromU8(files[`word/${footerFile}`] ?? new Uint8Array());
  const footer = (footerXml.match(/<w:p[ >][\s\S]*?<\/w:p>/g) ?? [])
    .map((p) => {
      const spans: Span[] = (p.match(/<w:r[ >][\s\S]*?<\/w:r>/g) ?? []).map((r) => ({
        text: (r.match(/<w:br\/>|<w:t(?: [^>]*)?>[^<]*<\/w:t>/g) ?? []).map((m) => (m === "<w:br/>" ? "\n" : decode(m.replace(/<[^>]+>/g, "")))).join(""),
        bold: /<w:b\/>/.test(r),
        color: hex(r.match(/<w:color w:val="([0-9A-Fa-f]{6})"/)?.[1] ?? "C4C4C4"),
      }));
      while (spans.length && !spans[0]!.text.replace(/^\s+/, "")) spans.shift();
      if (spans[0]) spans[0] = { ...spans[0], text: spans[0].text.replace(/^\s+/, "") };
      return spans;
    })
    .filter((p) => p.length);

  return { title: rows[0]?.[2] ?? "MEETING ROSTER", labels: rows[1] ?? [], values: rows[2] ?? [], logos, footer };
}

function drawChrome(w: Writer, c: Chrome, pageNo: number, total: number) {
  const { xs, ys } = HEADER;
  w.rect(xs[0], ys[0], xs[7], ys[3]);
  w.hline(xs[0], xs[7], ys[1]);
  w.hline(xs[0], xs[7], ys[2]);
  for (const x of [xs[1], xs[2], xs[6]]) w.vline(x, ys[0], ys[1]);
  for (const x of [xs[2], xs[3], xs[4], xs[5], xs[6]]) w.vline(x, ys[1], ys[3]);
  const [left, right] = [c.logos[0], c.logos[c.logos.length - 1]];
  const logo = (l: Chrome["logos"][number], x0: number, x1: number) => {
    const { w: lw, h: lh } = fitBox(l.w, l.h, Math.min(l.w, x1 - x0 - 2), Math.min(l.h, ys[1] - ys[0] - 2));
    w.page.drawImage(l.img, { x: (x0 + x1 - lw) / 2, y: PAGE.h - (ys[0] + ys[1] + lh) / 2, width: lw, height: lh });
  };
  if (left) logo(left, xs[0], xs[1]);
  if (right && c.logos.length > 1) logo(right, xs[6], xs[7]);

  const page: Span[] = [{ text: String(pageNo), bold: true }, { text: " of " }, { text: String(total), bold: true }];
  w.spans(page, (xs[1] + xs[2] - w.lineWidth(page, 6.5)) / 2, (ys[0] + ys[1]) / 2 - 3.6, 6.5);
  const titleW = w.fonts.bold.widthOfTextAtSize(w.safe(c.title), 11.5);
  w.text(c.title, (xs[2] + xs[6] - titleW) / 2, (ys[0] + ys[1]) / 2 - 6.3, { bold: true, size: 11.5 });

  const spans = [
    [xs[0], xs[2]],
    [xs[2], xs[3]],
    [xs[3], xs[4]],
    [xs[4], xs[5]],
    [xs[5], xs[6]],
    [xs[6], xs[7]],
  ];
  const cellText = (t: string, bold: boolean, [x0, x1]: number[], top: number, bottom: number) => {
    const lines = wrap([{ text: t, bold }], x1 - x0 - 10.8, w.fonts, 6.5);
    const lh = 7.5;
    let y = (top + bottom) / 2 - (lines.length * lh) / 2 + 0.3;
    for (const l of lines) {
      w.spans(l, (x0 + x1 - w.lineWidth(l, 6.5)) / 2, y, 6.5);
      y += lh;
    }
  };
  spans.forEach((s, i) => {
    if (c.labels[i]) cellText(c.labels[i], true, s, ys[1], ys[2]);
    if (c.values[i]) cellText(c.values[i], false, s, ys[2], ys[3]);
  });

  let top = 722.8;
  for (const p of c.footer) {
    for (const l of wrap(p, 558, w.fonts, 6.5)) {
      w.spans(l, (PAGE.w - w.lineWidth(l, 6.5)) / 2, top, 6.5);
      top += 7.45;
    }
  }
}

async function embedSignature(pdf: PDFDocument, sig?: Signature) {
  if (!sig) return null;
  return { img: await pdf.embedPng(dataUrlToBytes(sig.dataUrl)), w: sig.width, h: sig.height };
}

function drawKeyPoints(w: Writer, input: MomExportInput) {
  const { mom } = input;
  const k = KEYPOINTS;
  const [x0, , , , x4] = k.xs;
  w.newPage();
  const labelRow = (top: number, bottom: number, cells: [number, number, string, string][]) => {
    w.rect(x0, top, x4, bottom);
    for (const [a, b, label, value] of cells) {
      if (a > x0) w.vline(a, top, bottom);
      const line = wrap([{ text: label, bold: true }, { text: value }], b - a - TEXT.pad * 2, w.fonts)[0] ?? [];
      w.spans(line, a + TEXT.pad, top + 0.2);
    }
  };
  labelRow(k.rows[0], k.rows[1], [
    [x0, k.split, "Date: ", mom.date],
    [k.split, x4, "Location: ", mom.location],
  ]);
  labelRow(k.rows[1], k.rows[2], [
    [x0, k.split, "Time: ", mom.time],
    [k.split, x4, "Facilitator: ", mom.facilitator],
  ]);
  labelRow(k.rows[2], k.rows[3], [[x0, x4, "Key points covered: ", ""]]);

  const cols = [k.xs[0], k.xs[1], k.xs[2], k.xs[3], k.xs[4]];
  const grid = (top: number, bottom: number) => {
    w.rect(x0, top, x4, bottom);
    for (const x of cols.slice(1, -1)) w.vline(x, top, bottom);
  };
  grid(k.rows[3], k.rows[4]);
  ["No", "Description", "PIC", "Status"].forEach((h, i) => {
    const tw = w.fonts.bold.widthOfTextAtSize(h, TEXT.size);
    w.text(h, (cols[i] + cols[i + 1] - tw) / 2, k.rows[3] + 1.5, { bold: true });
  });

  let top = k.rows[4];
  let drawn = 0;
  const rowsWanted = Math.max(k.blankRows, mom.items.length);
  for (let i = 0; i < rowsWanted; i++) {
    const item = mom.items[i];
    const cells = item ? [String(i + 1), item.description, item.pic, item.status] : ["", "", "", ""];
    const wrapped = cells.map((t, ci) => wrap([{ text: t }], cols[ci + 1] - cols[ci] - TEXT.pad * 2, w.fonts));
    const h = Math.max(k.itemH, Math.max(...wrapped.map((l) => l.length)) * TEXT.line + 1.6);
    if (top + h > BODY_BOTTOM) {
      if (!item) break;
      w.newPage();
      top = BODY_TOP;
    }
    grid(top, top + h);
    wrapped.forEach((lines, ci) =>
      lines.forEach((l, li) => {
        const x = ci === 0 ? (cols[0] + cols[1] - w.lineWidth(l)) / 2 : cols[ci] + TEXT.pad;
        w.spans(l, x, top + 0.8 + li * TEXT.line);
      }),
    );
    top += h;
    drawn++;
  }
  return drawn;
}

async function drawRoster(w: Writer, input: MomExportInput) {
  const r = ROSTER;
  const people = input.mom.attendees.filter((a) => a.name.trim() || a.signature);
  const rows = Math.max(r.rows.length, people.length);
  const head = (top: number) => {
    const bottom = top + (r.headBottom - r.headTop);
    w.rect(r.xs[0], top, r.xs[5], bottom, GRAY_FILL);
    r.xs.slice(1, -1).forEach((x) => w.vline(x, top, bottom));
    r.labels.forEach((l, i) => {
      const tw = w.fonts.bold.widthOfTextAtSize(l, TEXT.size);
      w.text(l, (r.xs[i] + r.xs[i + 1] - tw) / 2, top + 0.5, { bold: true, color: l === "COMPANY" ? BLACK : WHITE });
    });
    return bottom;
  };
  w.newPage();
  let top = head(r.headTop);
  for (let i = 0; i < rows; i++) {
    const h = r.rows[i] ?? r.rows[r.rows.length - 1];
    if (top + h > BODY_BOTTOM) {
      w.newPage();
      top = head(BODY_TOP);
    }
    w.rect(r.xs[0], top, r.xs[5], top + h);
    r.xs.slice(1, -1).forEach((x) => w.vline(x, top, top + h));
    const a = people[i];
    const textTop = top + 10.8;
    const fits = Math.max(1, Math.floor((h - 12) / TEXT.line));
    const cell = (spans: Span[], ci: number) =>
      wrap(spans, r.xs[ci + 1] - r.xs[ci] - TEXT.pad * 2, w.fonts)
        .slice(0, fits)
        .forEach((l, li) => w.spans(l, r.xs[ci] + TEXT.pad, textTop + li * TEXT.line));
    cell([{ text: `${i + 1}. `, bold: true }, { text: a?.name.trim() ?? "" }], 0);
    if (a) {
      cell([{ text: a.company }], 1);
      cell([{ text: a.empNo }], 2);
      cell([{ text: a.title }], 3);
      const sig = await embedSignature(w.pdf, a.signature);
      if (sig) w.image(sig.img, r.xs[4], top, r.xs[5], top + h, sig, 4);
    }
    top += h;
  }
}

async function drawPreparedAndEvidence(w: Writer, input: MomExportInput) {
  const { mom } = input;
  const p = PREPARED;
  w.newPage();
  w.rect(p.x0, p.ys[0], p.x1, p.ys[4]);
  for (const y of p.ys.slice(1, -1)) w.hline(p.x0, p.x1, y);
  w.text("Prepared by:", p.x0 + TEXT.pad, p.ys[0] + 0.2, { bold: true });
  const sig = await embedSignature(w.pdf, mom.preparedBy.signature);
  if (sig) w.image(sig.img, p.x0, p.ys[1], p.x1, p.ys[2], sig, 4);
  const row = (label: string, value: string, top: number) => {
    const line = wrap([{ text: label, bold: true }, { text: value ? ` ${value}` : "" }], p.x1 - p.x0 - TEXT.pad * 2, w.fonts)[0] ?? [];
    w.spans(line, p.x0 + TEXT.pad, top + 0.2);
  };
  row("Name      :", mom.preparedBy.name.trim(), p.ys[2]);
  row("Position  :", mom.preparedBy.position.trim(), p.ys[3]);

  const e = EVIDENCE;
  w.text("EVIDENCE:", 36.1, e.labelTop, { bold: true });
  const pics = await Promise.all(input.evidence.map((x) => normalizeImage(x.blob, "image/jpeg")));
  const imgs = await Promise.all(pics.map((x) => w.pdf.embedJpg(x.bytes)));
  const pairs = Math.max(2, Math.ceil(input.evidence.length / 2));
  let top = e.top;
  for (let pi = 0; pi < pairs; pi++) {
    const [picH, nameH] = e.pairs[pi] ?? e.nextPair;
    if (top + picH + nameH > BODY_BOTTOM) {
      w.newPage();
      top = BODY_TOP;
    }
    w.rect(e.xs[0], top, e.xs[2], top + picH + nameH);
    w.vline(e.xs[1], top, top + picH + nameH);
    w.hline(e.xs[0], e.xs[2], top + picH);
    for (let side = 0; side < 2; side++) {
      const idx = pi * 2 + side;
      const [x0, x1] = [e.xs[side], e.xs[side + 1]];
      if (imgs[idx]) w.image(imgs[idx], x0, top, x1, top + picH, { w: pics[idx].width, h: pics[idx].height }, 5);
      else if (!input.evidence.length) {
        const tw = w.fonts.bold.widthOfTextAtSize("PICTURE HERE", TEXT.size);
        w.text("PICTURE HERE", (x0 + x1 - tw) / 2, top + picH / 2 - 5, { bold: true });
      }
      const name = input.evidence[idx]?.name ?? "";
      const line = wrap([{ text: "Evidence Name :", bold: true }, { text: name ? ` ${name}` : "" }], x1 - x0 - TEXT.pad * 2, w.fonts)[0] ?? [];
      w.spans(line, x0 + TEXT.pad, top + picH + 0.2);
    }
    top += picH + nameH;
  }
}

function inline(text: string): Span[] {
  return text
    .replace(/`/g, "")
    .split(/(\*\*[^*]+\*\*)/)
    .filter(Boolean)
    .map((part) => (part.startsWith("**") && part.endsWith("**") ? { text: part.slice(2, -2), bold: true } : { text: part.replace(/(^|\s)[*_]([^*_]+)[*_]/g, "$1$2") }));
}

function drawSummary(w: Writer, markdown: string) {
  const X0 = 36;
  const X1 = 576;
  const LH = 12.65;
  w.newPage();
  w.text("SUMMARY:", X0, BODY_TOP, { bold: true });
  let top = BODY_TOP + LH + 4;
  const ensure = (h: number) => {
    if (top + h > BODY_BOTTOM) {
      w.newPage();
      top = BODY_TOP;
    }
  };
  const para = (spans: Span[], indent = 0, mark?: string, before = 0, after = 3) => {
    const lines = wrap(spans, X1 - X0 - indent, w.fonts);
    top += before;
    lines.forEach((l, i) => {
      ensure(LH);
      if (i === 0 && mark) w.text(mark, X0 + indent - 12, top);
      w.spans(l, X0 + indent, top);
      top += LH;
    });
    top += after;
  };
  const lines = markdown.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\s+$/, "");
    if (!line.trim()) continue;
    if (line.trim().startsWith("|")) {
      const block: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith("|")) block.push(lines[i++]);
      i--;
      const rows = block.filter((l) => !/^\|?\s*:?-{2,}/.test(l.trim())).map((l) => l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim()));
      const cols = Math.max(...rows.map((r) => r.length));
      const cw = (X1 - X0) / cols;
      for (const [ri, r] of rows.entries()) {
        const cells = Array.from({ length: cols }, (_, ci) => wrap(ri === 0 ? [{ text: r[ci] ?? "", bold: true }] : inline(r[ci] ?? ""), cw - 8, w.fonts));
        const h = Math.max(...cells.map((c) => c.length)) * TEXT.line + 4;
        ensure(h);
        w.rect(X0, top, X1, top + h);
        for (let ci = 1; ci < cols; ci++) w.vline(X0 + ci * cw, top, top + h);
        cells.forEach((c, ci) => c.forEach((l, li) => w.spans(l, X0 + ci * cw + 4, top + 2 + li * TEXT.line)));
        top += h;
      }
      top += 6;
      continue;
    }
    const heading = line.match(/^#{1,6}\s+(.*)/);
    if (heading) {
      ensure(LH * 2 + 8);
      para([{ text: heading[1].replace(/\*\*/g, ""), bold: true }], 0, undefined, 8, 3);
      continue;
    }
    const bullet = line.match(/^(\s*)[-*+]\s+(?:\[[ xX]\]\s+)?(.*)/);
    const numbered = line.match(/^(\s*)(\d+[.)])\s+(.*)/);
    if (bullet || numbered) {
      const level = Math.min(3, Math.floor((bullet?.[1] ?? numbered![1]).length / 2));
      para(inline(bullet ? bullet[2] : numbered![3]), 15 + level * 15, bullet ? "•" : numbered![2], 0, 2);
      continue;
    }
    para(inline(line.replace(/^>\s?/, "")));
  }
}

export async function buildMomPdf(input: MomExportInput): Promise<Blob> {
  const files = await readTemplate(input.template);
  const pdf = await PDFDocument.create();
  const base = { regular: await pdf.embedFont(StandardFonts.Helvetica), bold: await pdf.embedFont(StandardFonts.HelveticaBold) };
  const w = new Writer(pdf, { ...base, safe: makeSafe(base) });
  const chrome = await readChrome(files, pdf);
  drawKeyPoints(w, input);
  await drawRoster(w, input);
  await drawPreparedAndEvidence(w, input);
  if (input.summary.trim()) drawSummary(w, input.summary);
  w.pages.forEach((p, i) => {
    w.page = p;
    drawChrome(w, chrome, i + 1, w.pages.length);
  });
  pdf.setTitle(chrome.title);
  pdf.setProducer("Notesy");
  const bytes = await pdf.save();
  return new Blob([bytes as BlobPart], { type: "application/pdf" });
}
