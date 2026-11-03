import type { Note } from "../types";
import { download, safeFileName } from "../util";
import { getMomTemplate, loadEvidence, resolveMom, summaryMarkdown } from "./index";

export async function momInput(note: Note) {
  const template = await getMomTemplate();
  if (!template) throw new Error("Template MoM belum diunggah. Unggah file “MoM Roster Meeting.docx” di tab MoM.");
  const mom = resolveMom(note);
  return { mom, template, evidence: await loadEvidence(mom, note.id), summary: summaryMarkdown(note) };
}

export async function downloadMom(note: Note, kind: "docx" | "pdf") {
  const input = await momInput(note);
  const name = `MoM - ${safeFileName(note.title)}`;
  if (kind === "docx") {
    const { buildMomDocx } = await import("./docx");
    download(`${name}.docx`, await buildMomDocx(input));
  } else {
    const { buildMomPdf } = await import("./pdf");
    download(`${name}.pdf`, await buildMomPdf(input));
  }
}
