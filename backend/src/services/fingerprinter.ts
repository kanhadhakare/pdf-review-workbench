import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

type MuPdfModule = typeof import("mupdf");
type PdfJsModule = typeof import("pdfjs-dist/legacy/build/pdf.mjs");

async function importMuPdf(): Promise<MuPdfModule | null> { try { return await import("mupdf"); } catch { return null; } }
async function importPdfJs(): Promise<PdfJsModule> { return import("pdfjs-dist/legacy/build/pdf.mjs"); }
function cleanFontName(fontName: string): string { return fontName.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64); }

export async function fingerprintPdf(filePath: string): Promise<string> {
  const buffer = await readFile(filePath);
  const parts: string[] = [];
  const mupdf = await importMuPdf();
  if (mupdf) {
    try {
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
    } catch {
      parts.push('mupdf:fallback');
    }
  } else {
    const pdfjs = await importPdfJs();
    const task = pdfjs.getDocument({ data: new Uint8Array(buffer), useWorkerFetch: false } as never);
    const document = await task.promise;
    const metadata = await document.getMetadata().catch(() => null) as { info?: Record<string, string> } | null;
    parts.push(`producer=${metadata?.info?.["Producer"] ?? ''}`);
    parts.push(`creator=${metadata?.info?.["Creator"] ?? ''}`);
    parts.push(`author=${metadata?.info?.["Author"] ?? ''}`);
    const pageCount = Math.min(3, document.numPages);
    for (let pageIndex = 1; pageIndex <= pageCount; pageIndex += 1) {
      const page = await document.getPage(pageIndex);
      const viewport = page.getViewport({ scale: 1 });
      parts.push(`page:${pageIndex - 1}:${viewport.width},${viewport.height}`);
      const text = await page.getTextContent();
      const fonts = new Set<string>();
      for (const item of text.items as Array<{ fontName?: string }>) if (item.fontName) fonts.add(cleanFontName(item.fontName));
      parts.push(`fonts:${pageIndex - 1}:${Array.from(fonts).sort().join('|')}`);
    }
  }
  return createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, 16);
}

