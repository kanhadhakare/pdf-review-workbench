import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { destroyMuPdfObject } from "./mupdfLifecycle.js";
async function importMuPdf() {
    try {
        return await import("mupdf");
    }
    catch {
        throw new Error("MuPDF unavailable (pdf.js disabled)");
    }
}
function cleanFontName(fontName) { return fontName.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64); }
export async function fingerprintPdf(filePath) {
    const buffer = await readFile(filePath);
    const parts = [];
    const mupdf = await importMuPdf();
    const document = mupdf.Document.openDocument(buffer, "application/pdf");
    try {
        parts.push(`pageCount=${document.countPages()}`);
        const pageCount = Math.min(3, document.countPages());
        for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
            const page = document.loadPage(pageIndex);
            let structured = null;
            try {
                const bounds = page.getBounds();
                parts.push(`page:${pageIndex}:${bounds.join(',')}`);
                structured = page.toStructuredText("preserve-whitespace,preserve-spans");
                const json = JSON.parse(structured.asJSON(1));
                const fonts = new Set();
                for (const block of json.blocks ?? [])
                    for (const line of block.lines ?? [])
                        if (line.font?.name)
                            fonts.add(cleanFontName(line.font.name));
                parts.push(`fonts:${pageIndex}:${Array.from(fonts).sort().join('|')}`);
            }
            finally {
                destroyMuPdfObject(structured);
                destroyMuPdfObject(page);
            }
        }
    }
    finally {
        destroyMuPdfObject(document);
    }
    return createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, 16);
}
