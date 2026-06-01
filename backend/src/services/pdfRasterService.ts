import { readFile } from "node:fs/promises";

type MuPdfModule = typeof import("mupdf");
type MuPdfMatrix = import("mupdf").Matrix;
type MuPdfRect = import("mupdf").Rect;

async function importMuPdf(): Promise<MuPdfModule | null> {
  try {
    return await import("mupdf");
  } catch {
    return null;
  }
}

function integerRect(rect: MuPdfRect): MuPdfRect {
  return [
    Math.floor(rect[0]),
    Math.floor(rect[1]),
    Math.ceil(rect[2]),
    Math.ceil(rect[3])
  ];
}

function createNoTextDrawDevice(mupdf: MuPdfModule, matrix: MuPdfMatrix, pixmap: import("mupdf").Pixmap): import("mupdf").Device {
  const drawDevice = new mupdf.DrawDevice(matrix, pixmap) as any;
  let skippedTextClipDepth = 0;
  const isSkippingTextClip = (): boolean => skippedTextClipDepth > 0;
  return new mupdf.Device({
    close: () => drawDevice.close(),
    fillPath: (...args) => { if (!isSkippingTextClip()) drawDevice.fillPath(...args); },
    strokePath: (...args) => { if (!isSkippingTextClip()) drawDevice.strokePath(...args); },
    clipPath: (...args) => { if (!isSkippingTextClip()) drawDevice.clipPath(...args); },
    clipStrokePath: (...args) => { if (!isSkippingTextClip()) drawDevice.clipStrokePath(...args); },
    fillText: () => void 0,
    strokeText: () => void 0,
    clipText: () => { skippedTextClipDepth += 1; },
    clipStrokeText: () => { skippedTextClipDepth += 1; },
    ignoreText: () => void 0,
    fillShade: (...args) => { if (!isSkippingTextClip()) drawDevice.fillShade(...args); },
    fillImage: (...args) => { if (!isSkippingTextClip()) drawDevice.fillImage(...args); },
    fillImageMask: (...args) => { if (!isSkippingTextClip()) drawDevice.fillImageMask(...args); },
    clipImageMask: (...args) => { if (!isSkippingTextClip()) drawDevice.clipImageMask(...args); },
    popClip: () => {
      if (skippedTextClipDepth > 0) {
        skippedTextClipDepth -= 1;
        return;
      }
      drawDevice.popClip();
    },
    beginMask: (...args) => { if (!isSkippingTextClip()) drawDevice.beginMask(...args); },
    endMask: () => { if (!isSkippingTextClip()) drawDevice.endMask(); },
    beginGroup: (...args) => isSkippingTextClip() ? 0 : drawDevice.beginGroup(...args),
    endGroup: () => { if (!isSkippingTextClip()) drawDevice.endGroup(); },
    beginTile: (...args) => isSkippingTextClip() ? 0 : drawDevice.beginTile(...args),
    endTile: () => { if (!isSkippingTextClip()) drawDevice.endTile(); },
    beginLayer: (...args) => { if (!isSkippingTextClip()) drawDevice.beginLayer(...args); },
    endLayer: () => { if (!isSkippingTextClip()) drawDevice.endLayer(); }
  });
}

export async function renderPdfPagePng(filePath: string, pageIndex: number, dpi: number, options: { omitText?: boolean } = {}): Promise<Uint8Array> {
  const mupdf = await importMuPdf();
  if (!mupdf) {
    throw new Error("MuPDF unavailable for final page rasterization");
  }
  const pdfBytes = await readFile(filePath);
  const document = mupdf.Document.openDocument(pdfBytes, "application/pdf");
  const page = document.loadPage(pageIndex);
  const scale = Math.max(72, dpi) / 72;
  const matrix = mupdf.Matrix.scale(scale, scale);
  if (options.omitText) {
    const bounds = page.getBounds();
    const pixmapBounds = integerRect(mupdf.Rect.transform(bounds, matrix) as MuPdfRect);
    const pixmap = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, pixmapBounds, false);
    pixmap.clear(255);
    const device = createNoTextDrawDevice(mupdf, matrix, pixmap);
    page.run(device, mupdf.Matrix.identity);
    device.close();
    return pixmap.asPNG();
  }
  const pixmap = page.toPixmap(matrix, mupdf.ColorSpace.DeviceRGB, false, true);
  return pixmap.asPNG();
}
