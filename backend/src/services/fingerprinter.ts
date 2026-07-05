import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { mupdfMaxInputBytes } from "../config/runtime.js";
import { destroyMuPdfObject } from "./mupdfLifecycle.js";

type MuPdfModule = typeof import("mupdf");

async function importMuPdf(): Promise<MuPdfModule> {
  try {
    return await import("mupdf");
  } catch {
    throw new Error("MuPDF unavailable (pdf.js disabled)");
  }
}
function cleanFontName(fontName: string): string { return fontName.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64); }

async function fingerprintLargePdf(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest("hex").slice(0, 16);
}

export async function fingerprintPdf(filePath: string): Promise<string> {
  const info = await stat(filePath);
  if (info.size > mupdfMaxInputBytes) {
    return fingerprintLargePdf(filePath);
  }
  const buffer = await readFile(filePath);
  const parts: string[] = [];
  const mupdf = await importMuPdf();
  const document = mupdf.Document.openDocument(buffer, "application/pdf");
  try {
    parts.push(`pageCount=${document.countPages()}`);
    const pageCount = Math.min(3, document.countPages());
    for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
      const page = document.loadPage(pageIndex);
      let structured: import("mupdf").StructuredText | null = null;
      try {
        const bounds = page.getBounds() as [number, number, number, number];
        parts.push(`page:${pageIndex}:${bounds.join(',')}`);
        structured = page.toStructuredText("preserve-whitespace,preserve-spans");
        const json = JSON.parse(structured.asJSON(1)) as { blocks?: Array<{ lines?: Array<{ font?: { name?: string } }> }> };
        const fonts = new Set<string>();
        for (const block of json.blocks ?? []) for (const line of block.lines ?? []) if (line.font?.name) fonts.add(cleanFontName(line.font.name));
        parts.push(`fonts:${pageIndex}:${Array.from(fonts).sort().join('|')}`);
      } finally {
        destroyMuPdfObject(structured);
        destroyMuPdfObject(page);
      }
    }
  } finally {
    destroyMuPdfObject(document);
  }
  return createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, 16);
}

