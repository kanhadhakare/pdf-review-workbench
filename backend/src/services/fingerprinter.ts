import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

type MuPdfModule = typeof import("mupdf");

async function importMuPdf(): Promise<MuPdfModule> {
  try {
    return await import("mupdf");
  } catch {
    throw new Error("MuPDF unavailable (pdf.js disabled)");
  }
}
function cleanFontName(fontName: string): string { return fontName.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64); }

export async function fingerprintPdf(filePath: string): Promise<string> {
  const buffer = await readFile(filePath);
  const parts: string[] = [];
  const mupdf = await importMuPdf();
  const document = mupdf.Document.openDocument(buffer, "application/pdf");
  parts.push(`pageCount=${document.countPages()}`);
  const pageCount = Math.min(3, document.countPages());
  for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
    const page = document.loadPage(pageIndex);
    const bounds = page.getBounds() as [number, number, number, number];
    parts.push(`page:${pageIndex}:${bounds.join(',')}`);
    const structured = page.toStructuredText("preserve-whitespace,preserve-spans");
    const json = JSON.parse(structured.asJSON(1)) as { blocks?: Array<{ lines?: Array<{ font?: { name?: string } }> }> };
    const fonts = new Set<string>();
    for (const block of json.blocks ?? []) for (const line of block.lines ?? []) if (line.font?.name) fonts.add(cleanFontName(line.font.name));
    parts.push(`fonts:${pageIndex}:${Array.from(fonts).sort().join('|')}`);
  }
  return createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, 16);
}

