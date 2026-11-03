import { strFromU8, strToU8, unzipSync, zipSync, type Unzipped } from "fflate";
import type { Mom } from "../types";
import { dataUrlToBytes, fitBox, normalizeImage } from "./index";

const EMU_PER_PT = 12700;
const VALUE_RPR = '<w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial"/><w:sz w:val="20"/><w:szCs w:val="20"/></w:rPr>';
const BOLD_RPR = '<w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial"/><w:b/><w:sz w:val="20"/><w:szCs w:val="20"/></w:rPr>';
const IMAGE_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image";
const MARKERS = ["Key points covered", "PRINT NAME", "Prepared by", "EVIDENCE"];

export interface MomExportInput {
  mom: Mom;
  evidence: { name: string; blob: Blob }[];
  summary: string;
  template: Blob;
}

const esc = (s: string) =>
  s
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const run = (text: string, rPr = VALUE_RPR) =>
  text
    .split("\n")
    .map((line) => `<w:r>${rPr}<w:t xml:space="preserve">${esc(line)}</w:t></w:r>`)
    .join(`<w:r>${rPr}<w:br/></w:r>`);

/** Inline **bold** spans from the AI summary become bold runs; other Markdown marks are dropped. */
function richRuns(text: string) {
  return text
    .replace(/`/g, "")
    .split(/(\*\*[^*]+\*\*)/)
    .filter(Boolean)
    .map((part) => (part.startsWith("**") && part.endsWith("**") ? run(part.slice(2, -2), BOLD_RPR) : run(part.replace(/(^|\s)[*_]([^*_]+)[*_]/g, "$1$2"))))
    .join("");
}

export async function readTemplate(blob: Blob) {
  let files: Unzipped;
  try {
    files = unzipSync(new Uint8Array(await blob.arrayBuffer()));
  } catch {
    throw new Error("File template tidak bisa dibuka. Pastikan file .docx tidak rusak.");
  }
  const doc = files["word/document.xml"];
  if (!doc) throw new Error("File ini bukan dokumen Word (.docx).");
  const xml = strFromU8(doc);
  const missing = MARKERS.filter((m) => !xml.includes(m));
  if (missing.length || tables(xml).length < 4) throw new Error(`Template tidak sesuai format MoM Roster Meeting (tidak ditemukan: ${missing.join(", ") || "4 tabel"}).`);
  return files;
}

const tables = (xml: string) => xml.match(/<w:tbl>[\s\S]*?<\/w:tbl>/g) ?? [];

function splitTable(tbl: string) {
  const rows: string[] = tbl.match(/<w:tr[ >][\s\S]*?<\/w:tr>/g) ?? [];
  if (!rows.length) throw new Error("Tabel template kosong; template tidak sesuai format MoM Roster Meeting.");
  const head = tbl.slice(0, tbl.indexOf(rows[0]!));
  return { head, rows, tail: "</w:tbl>" };
}

const joinTable = (t: { head: string; rows: string[]; tail: string }) => t.head + t.rows.join("") + t.tail;
/** Positional, because empty cells are often byte-identical and user text may contain "$". */
function mapCells(row: string, fn: (cell: string, i: number) => string) {
  let i = 0;
  return row.replace(/<w:tc>[\s\S]*?<\/w:tc>/g, (c) => fn(c, i++));
}

/** Adds runs at the end of the cell's last paragraph, after any label already there. */
const appendToCell = (cell: string, runs: string) => {
  const at = cell.lastIndexOf("</w:p>");
  return cell.slice(0, at) + runs + cell.slice(at);
};

const clearRuns = (cell: string) => cell.replace(/<w:r>[\s\S]*?<\/w:r>|<w:r [^>]*>[\s\S]*?<\/w:r>|<w:proofErr [^>]*\/>/g, "");

/** Rebuilds the paragraph properties in schema order (Word rejects out-of-order or duplicate children). */
function setParagraph(cell: string, props: string) {
  const pPr = cell.match(/<w:pPr>[\s\S]*?<\/w:pPr>/)?.[0];
  const rPr = pPr?.match(/<w:rPr>[\s\S]*?<\/w:rPr>/)?.[0] ?? "";
  const next = `<w:pPr>${props}${rPr}</w:pPr>`;
  return pPr ? cell.replace(pPr, () => next) : cell.replace(/<w:p>|<w:p ([^>]*)>/, (m) => m + next);
}

const tightParagraph = (cell: string) => setParagraph(cell, '<w:spacing w:before="0" w:after="0" w:line="240" w:lineRule="auto"/><w:jc w:val="center"/>');

const freshIds = (xml: string) => xml.replace(/ w14:(paraId|textId)="[^"]*"/g, "");

class Media {
  private n = 0;
  private docPr = 9100;
  rels: string[] = [];
  constructor(private files: Unzipped) {}

  add(bytes: Uint8Array, ext: "png" | "jpeg") {
    const id = `rIdMom${++this.n}`;
    const name = `media/notesy-mom-${this.n}.${ext}`;
    this.files[`word/${name}`] = bytes as Unzipped[string];
    this.rels.push(`<Relationship Id="${id}" Type="${IMAGE_REL}" Target="${name}"/>`);
    return id;
  }

  drawing(rId: string, wPt: number, hPt: number, name = "Picture") {
    const id = ++this.docPr;
    const cx = Math.round(wPt * EMU_PER_PT);
    const cy = Math.round(hPt * EMU_PER_PT);
    return `<w:r><w:rPr><w:noProof/></w:rPr><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:effectExtent l="0" t="0" r="0" b="0"/><wp:docPr id="${id}" name="${name} ${id}"/><wp:cNvGraphicFramePr><a:graphicFrameLocks xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" noChangeAspect="1"/></wp:cNvGraphicFramePr><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="${id}" name="${name} ${id}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${rId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;
  }

  signature(sig: { dataUrl: string; width: number; height: number }, maxW: number, maxH: number) {
    const rId = this.add(dataUrlToBytes(sig.dataUrl), "png");
    const { w, h } = fitBox(sig.width, sig.height, maxW, maxH);
    return this.drawing(rId, w, h, "Signature");
  }
}

function fillKeyPoints(tbl: string, mom: Mom) {
  const t = splitTable(tbl);
  const label = (row: string, labels: [string, string], values: [string, string]) =>
    mapCells(row, (c, i) => (values[i]?.trim() && c.includes(labels[i]) ? appendToCell(c, run(values[i].trim())) : c));
  t.rows[0] = label(t.rows[0], ["Date:", "Location:"], [mom.date, mom.location]);
  t.rows[1] = label(t.rows[1], ["Time:", "Facilitator:"], [mom.time, mom.facilitator]);
  const first = 4;
  const blank = freshIds(t.rows[first] ?? t.rows[t.rows.length - 1]!);
  // The template's 41 blank rows exactly fill page 1; every wrapped line of a key point costs one blank row,
  // otherwise the leftover blank rows spill onto page 2 above the roster.
  const lines = (s: string, perLine: number) => Math.max(1, Math.ceil(s.trim().length / perLine));
  const extra = mom.items.reduce((n, it) => n + Math.max(lines(it.description, 42), lines(it.pic, 22), lines(it.status, 22)) - 1, 0);
  const blanks = t.rows.length - first - mom.items.length;
  if (blanks > 0) t.rows.splice(t.rows.length - Math.min(blanks, extra), Math.min(blanks, extra));
  mom.items.forEach((item, i) => {
    const idx = first + i;
    if (idx >= t.rows.length) t.rows.push(blank);
    const values = [String(i + 1), item.description, item.pic, item.status];
    t.rows[idx] = mapCells(t.rows[idx], (c, ci) => (values[ci]?.trim() ? appendToCell(ci === 0 ? setParagraph(c, '<w:jc w:val="center"/>') : c, run(values[ci].trim())) : c));
  });
  return joinTable(t);
}

function fillRoster(tbl: string, mom: Mom, media: Media) {
  const t = splitTable(tbl);
  const people = mom.attendees.filter((a) => a.name.trim() || a.signature);
  // Every template row is flagged as a repeating header; once rows are added, only the column titles may repeat.
  if (people.length >= t.rows.length) t.rows = t.rows.map((r, i) => (i === 0 ? r : r.replace(/<w:tblHeader\/>/g, "")));
  const last = freshIds(t.rows[t.rows.length - 1]!);
  people.forEach((a, i) => {
    const idx = 1 + i;
    if (idx >= t.rows.length) t.rows.push(last.replace(/<w:t([^>]*)>\d+\.\s*<\/w:t>/, `<w:t$1>${idx}.</w:t>`));
    const values = [a.name, a.company, a.empNo, a.title];
    t.rows[idx] = mapCells(t.rows[idx]!, (c, ci) => {
      if (ci < 4) {
        const v = values[ci]?.trim();
        // Rows have an exact height: single line spacing lets a wrapped company or title show its second line.
        return v ? appendToCell(setParagraph(c, '<w:spacing w:before="240" w:line="240" w:lineRule="auto"/>'), run((ci === 0 ? " " : "") + v)) : c;
      }
      return a.signature ? appendToCell(tightParagraph(c), media.signature(a.signature, 125, 30)) : c;
    });
  });
  return joinTable(t);
}

function fillPreparedBy(tbl: string, mom: Mom, media: Media, files: Unzipped, rels: { xml: string }) {
  const t = splitTable(tbl);
  const oldEmbed = t.rows[1].match(/r:embed="([^"]+)"/)?.[1];
  const sig = mom.preparedBy.signature;
  t.rows[1] = mapCells(t.rows[1], (c) => {
    const cleared = clearRuns(c);
    return sig ? appendToCell(cleared, media.signature(sig, 155, 112)) : cleared;
  });
  if (oldEmbed) dropRelationship(files, rels, oldEmbed);
  const values = [mom.preparedBy.name, mom.preparedBy.position];
  for (let i = 0; i < 2; i++) {
    const v = values[i]?.trim();
    if (v) t.rows[2 + i] = mapCells(t.rows[2 + i], (c) => appendToCell(c, run(" " + v)));
  }
  return joinTable(t);
}

/** The template ships a real person's signature; it must never end up in someone else's minutes. */
function dropRelationship(files: Unzipped, rels: { xml: string }, rId: string) {
  const re = new RegExp(`<Relationship [^>]*Id="${rId}"[^>]*/>`);
  const rel = rels.xml.match(re)?.[0];
  if (!rel) return;
  rels.xml = rels.xml.replace(rel, "");
  const target = rel.match(/Target="([^"]+)"/)?.[1];
  if (target) delete files[`word/${target}`];
}

async function fillEvidence(tbl: string, evidence: MomExportInput["evidence"], media: Media) {
  const t = splitTable(tbl);
  if (!evidence.length) return tbl;
  const [picRow, nameRow] = [freshIds(t.rows[2]), freshIds(t.rows[3])];
  const pairs = Math.max(2, Math.ceil(evidence.length / 2));
  while (t.rows.length < pairs * 2) t.rows.push(picRow, nameRow);
  for (let p = 0; p < pairs; p++) {
    const items = [evidence[p * 2], evidence[p * 2 + 1]];
    const pics = await Promise.all(items.map((e) => (e ? normalizeImage(e.blob, "image/jpeg") : null)));
    // A picture row must stay on the same page as its "Evidence Name" row.
    const keep = (row: string) => (row.includes("<w:cantSplit/>") ? row : row.replace(/<w:trHeight /, "<w:cantSplit/><w:trHeight "));
    t.rows[p * 2] = mapCells(keep(t.rows[p * 2]!), (c, i) => {
      const img = pics[i];
      const cell = setParagraph(clearRuns(c), '<w:keepNext/><w:spacing w:before="0" w:after="0" w:line="240" w:lineRule="auto"/><w:jc w:val="center"/>');
      if (!img) return cell;
      const { w, h } = fitBox(img.width, img.height, 255, 155);
      return appendToCell(cell, media.drawing(media.add(img.bytes, "jpeg"), w, h, "Evidence"));
    });
    t.rows[p * 2 + 1] = mapCells(t.rows[p * 2 + 1]!, (c, i) => (items[i] ? appendToCell(c, run(" " + items[i]!.name)) : c));
  }
  return joinTable(t);
}

const PARA_PPR = '<w:pPr><w:spacing w:before="0" w:after="80" w:line="264" w:lineRule="auto"/><w:ind w:left="-720" w:right="-720"/></w:pPr>';

function summaryTable(lines: string[]) {
  const rows = lines.filter((l) => !/^\|?\s*:?-{2,}/.test(l.trim())).map((l) =>
    l
      .trim()
      .replace(/^\||\|$/g, "")
      .split("|")
      .map((c) => c.trim()),
  );
  const cols = Math.max(...rows.map((r) => r.length));
  const width = Math.floor(10914 / cols);
  const border = '<w:top w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:left w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:bottom w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:right w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:insideH w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:insideV w:val="single" w:sz="4" w:space="0" w:color="auto"/>';
  const body = rows
    .map(
      (r, ri) =>
        `<w:tr>${Array.from({ length: cols }, (_, ci) => `<w:tc><w:tcPr><w:tcW w:w="${width}" w:type="dxa"/></w:tcPr><w:p><w:pPr><w:spacing w:before="20" w:after="20"/></w:pPr>${ri === 0 ? run(r[ci] ?? "", BOLD_RPR) : richRuns(r[ci] ?? "")}</w:p></w:tc>`).join("")}</w:tr>`,
    )
    .join("");
  return `<w:tbl><w:tblPr><w:tblW w:w="${width * cols}" w:type="dxa"/><w:tblInd w:w="-720" w:type="dxa"/><w:tblBorders>${border}</w:tblBorders><w:tblLayout w:type="fixed"/></w:tblPr><w:tblGrid>${`<w:gridCol w:w="${width}"/>`.repeat(cols)}</w:tblGrid>${body}</w:tbl><w:p>${PARA_PPR}</w:p>`;
}

export function summaryXml(markdown: string) {
  const out: string[] = [
    '<w:p><w:r><w:br w:type="page"/></w:r></w:p>',
    `<w:p><w:pPr><w:ind w:left="-720"/></w:pPr>${run("SUMMARY:", BOLD_RPR)}</w:p>`,
  ];
  const lines = markdown.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\s+$/, "");
    if (!line.trim()) continue;
    if (line.trim().startsWith("|")) {
      const block: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith("|")) block.push(lines[i++]);
      i--;
      out.push(summaryTable(block));
      continue;
    }
    const heading = line.match(/^#{1,6}\s+(.*)/);
    if (heading) {
      out.push(`<w:p><w:pPr><w:keepNext/><w:spacing w:before="160" w:after="60"/><w:ind w:left="-720" w:right="-720"/></w:pPr>${run(heading[1].replace(/\*\*/g, ""), BOLD_RPR)}</w:p>`);
      continue;
    }
    const bullet = line.match(/^(\s*)[-*+]\s+(?:\[[ xX]\]\s+)?(.*)/);
    const numbered = line.match(/^(\s*)(\d+[.)])\s+(.*)/);
    if (bullet || numbered) {
      const level = Math.min(3, Math.floor((bullet?.[1] ?? numbered![1]).length / 2));
      const left = -720 + 300 + level * 300;
      const mark = bullet ? "•" : numbered![2];
      out.push(
        `<w:p><w:pPr><w:spacing w:before="0" w:after="60" w:line="264" w:lineRule="auto"/><w:ind w:left="${left}" w:right="-720" w:hanging="300"/></w:pPr>${run(mark + "\t")}${richRuns(bullet ? bullet[2] : numbered![3])}</w:p>`,
      );
      continue;
    }
    out.push(`<w:p>${PARA_PPR}${richRuns(line.replace(/^>\s?/, ""))}</w:p>`);
  }
  return out.join("");
}

function ensureContentTypes(xml: string) {
  for (const [ext, type] of [
    ["png", "image/png"],
    ["jpeg", "image/jpeg"],
  ]) {
    if (!new RegExp(`Extension="${ext}"`, "i").test(xml)) xml = xml.replace("</Types>", `<Default Extension="${ext}" ContentType="${type}"/></Types>`);
  }
  return xml;
}

export async function buildMomDocx({ mom, evidence, summary, template }: MomExportInput): Promise<Blob> {
  const files = await readTemplate(template);
  const media = new Media(files);
  const rels = { xml: strFromU8(files["word/_rels/document.xml.rels"]) };
  let doc = strFromU8(files["word/document.xml"]);
  const [t0, t1, t2, t3] = tables(doc) as [string, string, string, string];
  const filled = [fillKeyPoints(t0, mom), fillRoster(t1, mom, media), fillPreparedBy(t2, mom, media, files, rels), await fillEvidence(t3, evidence, media)];
  [t0, t1, t2, t3].forEach((t, i) => (doc = doc.replace(t, () => filled[i])));
  if (splitTable(filled[1]).rows.length > splitTable(t1).rows.length) {
    // The empty paragraphs after the roster normally sit at the bottom of page 2; once the roster overflows they
    // would push "Prepared by" down the next page, so collapse them into one hairline spacer.
    const end = doc.indexOf(filled[1]) + filled[1].length;
    const next = doc.indexOf(filled[2], end);
    const gap = doc.slice(end, next);
    if (/^(?:<w:p[ >][\s\S]*?<\/w:p>)+$/.test(gap) && !/<w:t[ >]|<w:drawing|<w:br /.test(gap))
      doc = doc.slice(0, end) + '<w:p><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/><w:rPr><w:sz w:val="2"/><w:szCs w:val="2"/></w:rPr></w:pPr></w:p>' + doc.slice(next);
  }
  if (summary.trim()) {
    const at = doc.lastIndexOf("<w:sectPr");
    doc = doc.slice(0, at) + summaryXml(summary) + doc.slice(at);
  }
  rels.xml = rels.xml.replace("</Relationships>", media.rels.join("") + "</Relationships>");
  files["word/document.xml"] = strToU8(doc);
  files["word/_rels/document.xml.rels"] = strToU8(rels.xml);
  files["[Content_Types].xml"] = strToU8(ensureContentTypes(strFromU8(files["[Content_Types].xml"])));
  const zipped = zipSync(files, { level: 6 });
  return new Blob([zipped], { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
}
