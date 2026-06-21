import { readFile } from "node:fs/promises";
import { destroyMuPdfObject, withMuPdfLock } from "./mupdfLifecycle.js";

type MuPdfModule = typeof import("mupdf");
type MuPdfPdfPage = import("mupdf").PDFPage;

type StructuredTextJson = {
  blocks?: Array<{
    type?: string;
    bbox?: { x?: number; y?: number; w?: number; h?: number };
    lines?: Array<{
      bbox?: { x?: number; y?: number; w?: number; h?: number };
    }>;
  }>;
};

async function importMuPdf(): Promise<MuPdfModule | null> {
  try {
    return await import("mupdf");
  } catch {
    return null;
  }
}

function removePageText(page: MuPdfPdfPage): void {
  const structured = page.toStructuredText("preserve-whitespace,preserve-spans");
  try {
    const json = JSON.parse(structured.asJSON(1)) as StructuredTextJson;
    for (const block of json.blocks ?? []) {
      if (block.type !== "text") continue;
      for (const line of block.lines ?? []) {
        const bbox = line.bbox ?? block.bbox;
        const x = Number(bbox?.x);
        const y = Number(bbox?.y);
        const width = Number(bbox?.w);
        const height = Number(bbox?.h);
        if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) continue;
        const annotation = page.createAnnotation("Redact");
        try {
          annotation.setRect([x, y, x + width, y + height]);
        } finally {
          destroyMuPdfObject(annotation, "pdf-raster text redaction");
        }
      }
    }
    page.applyRedactions(false, 0, 0, 0);
  } finally {
    destroyMuPdfObject(structured, "pdf-raster structured text");
  }
}

export async function renderPdfPagePng(filePath: string, pageIndex: number, dpi: number, options: { omitText?: boolean } = {}): Promise<Uint8Array> {
  return withMuPdfLock(async () => {
    const mupdf = await importMuPdf();
    if (!mupdf) {
      throw new Error("MuPDF unavailable for final page rasterization");
    }
    const pdfBytes = await readFile(filePath);
    const document = mupdf.Document.openDocument(pdfBytes, "application/pdf");
    try {
      const page = document.loadPage(pageIndex);
      try {
        const scale = Math.max(72, dpi) / 72;
        const matrix = mupdf.Matrix.scale(scale, scale);
        if (options.omitText) {
          removePageText(page as MuPdfPdfPage);
        }
        const pixmap = page.toPixmap(matrix, mupdf.ColorSpace.DeviceRGB, false, true);
        try {
          return new Uint8Array(pixmap.asPNG());
        } finally {
          destroyMuPdfObject(pixmap, "pdf-raster pixmap");
        }
      } finally {
        destroyMuPdfObject(page, "pdf-raster page");
      }
    } finally {
      destroyMuPdfObject(document, "pdf-raster document");
    }
  });
}
