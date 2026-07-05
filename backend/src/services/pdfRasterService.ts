import { readFile } from "node:fs/promises";
import { finalMaxPixels } from "../config/runtime.js";
import { destroyMuPdfObject, withMuPdfLock } from "./mupdfLifecycle.js";
import { fitMuPdfRenderSizing } from "./mupdfRenderSizing.js";

type MuPdfModule = typeof import("mupdf");
type MuPdfPdfPage = import("mupdf").PDFPage;
type MuPdfPageBox = "MediaBox" | "CropBox" | "BleedBox" | "TrimBox" | "ArtBox";

type SelectedPageBox = {
  name: MuPdfPageBox;
  bounds: [number, number, number, number];
};

const MAX_EFFECTIVE_RENDER_PIXELS = 8_000_000;
const MAX_RENDER_DIMENSION_PX = 8_192;
const MAX_RENDER_BYTES = 128 * 1024 * 1024;
const MAX_SAFE_PAGE_BOX_PT = 5_000;

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

function validPageBox(bounds: [number, number, number, number] | number[]): bounds is [number, number, number, number] {
  if (bounds.length !== 4 || !bounds.every(Number.isFinite) || bounds[2] <= bounds[0] || bounds[3] <= bounds[1]) return false;
  const widthPt = bounds[2] - bounds[0];
  const heightPt = bounds[3] - bounds[1];
  return widthPt <= MAX_SAFE_PAGE_BOX_PT && heightPt <= MAX_SAFE_PAGE_BOX_PT;
}

function selectPageBox(page: import("mupdf").Page): SelectedPageBox {
  for (const name of ["TrimBox", "CropBox", "MediaBox"] as const) {
    try {
      const bounds = page.getBounds(name) as [number, number, number, number];
      if (validPageBox(bounds)) return { name, bounds };
    } catch {
      // Continue with fallback boxes.
    }
  }
  const bounds = page.getBounds() as [number, number, number, number];
  return { name: "MediaBox", bounds };
}

function renderPageBox(page: import("mupdf").Page, matrix: import("mupdf").Matrix, colorspace: import("mupdf").ColorSpace, box: MuPdfPageBox): import("mupdf").Pixmap {
  if (page.isPDF()) return (page as MuPdfPdfPage).toPixmap(matrix, colorspace, false, true, undefined, box);
  return page.toPixmap(matrix, colorspace, false, true);
}

function assertSafeRenderSize(pageIndex: number, widthPx: number, heightPx: number, dpi: number, box: MuPdfPageBox): void {
  const pixelCount = widthPx * heightPx;
  const estimatedBytes = pixelCount * 4;
  if (
    !Number.isFinite(pixelCount)
    || !Number.isFinite(estimatedBytes)
    || widthPx > MAX_RENDER_DIMENSION_PX
    || heightPx > MAX_RENDER_DIMENSION_PX
    || estimatedBytes > MAX_RENDER_BYTES
  ) {
    throw new Error(
      `Refusing to rasterize page ${pageIndex + 1}: ${widthPx}x${heightPx}px at ${dpi} DPI from ${box} would require about ${Math.round(estimatedBytes / 1024 / 1024)} MB. Lower FINAL_MAX_PIXELS/FINAL_OUTPUT_DPI or inspect PDF page boxes.`
    );
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
        const selectedBox = selectPageBox(page);
        const bounds = selectedBox.bounds;
        const widthPt = bounds[2] - bounds[0];
        const heightPt = bounds[3] - bounds[1];
        const renderSizing = fitMuPdfRenderSizing(widthPt, heightPt, dpi, {
          minDpi: 72,
          maxDpi: Math.max(72, dpi),
          maxPixels: Math.min(finalMaxPixels, MAX_EFFECTIVE_RENDER_PIXELS)
        });
        assertSafeRenderSize(pageIndex, renderSizing.widthPx, renderSizing.heightPx, renderSizing.dpi, selectedBox.name);
        if (renderSizing.capped) {
          console.warn(`[pdf-raster] page ${pageIndex + 1} raster capped to ${renderSizing.dpi} DPI (${renderSizing.widthPx}x${renderSizing.heightPx}, ${renderSizing.pixelCount} px) to avoid MuPDF WASM memory exhaustion.`);
        }
        const scale = renderSizing.scale;
        const matrix = mupdf.Matrix.scale(scale, scale);
        if (options.omitText) {
          removePageText(page as MuPdfPdfPage);
        }
        let pixmap: import("mupdf").Pixmap;
        try {
          pixmap = renderPageBox(page, matrix, mupdf.ColorSpace.DeviceRGB, selectedBox.name);
        } catch (error) {
          throw new Error(`MuPDF rasterization failed on page ${pageIndex + 1} at ${renderSizing.dpi} DPI (${renderSizing.widthPx}x${renderSizing.heightPx}). Lower FINAL_MAX_PIXELS or FINAL_OUTPUT_DPI. ${error instanceof Error ? error.message : String(error)}`);
        }
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
