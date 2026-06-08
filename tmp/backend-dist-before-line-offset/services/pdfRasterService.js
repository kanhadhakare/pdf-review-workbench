import { readFile } from "node:fs/promises";
import { destroyMuPdfObject } from "./mupdfLifecycle.js";
async function importMuPdf() {
    try {
        return await import("mupdf");
    }
    catch {
        return null;
    }
}
function integerRect(rect) {
    return [
        Math.floor(rect[0]),
        Math.floor(rect[1]),
        Math.ceil(rect[2]),
        Math.ceil(rect[3])
    ];
}
function createNoTextDrawDevice(mupdf, matrix, pixmap) {
    const drawDevice = new mupdf.DrawDevice(matrix, pixmap);
    let skippedTextClipDepth = 0;
    let closed = false;
    const isSkippingTextClip = () => skippedTextClipDepth > 0;
    const close = () => {
        if (closed)
            return;
        closed = true;
        drawDevice.close();
    };
    const device = new mupdf.Device({
        close,
        fillPath: (...args) => { if (!isSkippingTextClip())
            drawDevice.fillPath(...args); },
        strokePath: (...args) => { if (!isSkippingTextClip())
            drawDevice.strokePath(...args); },
        clipPath: (...args) => { if (!isSkippingTextClip())
            drawDevice.clipPath(...args); },
        clipStrokePath: (...args) => { if (!isSkippingTextClip())
            drawDevice.clipStrokePath(...args); },
        fillText: () => void 0,
        strokeText: () => void 0,
        clipText: () => { skippedTextClipDepth += 1; },
        clipStrokeText: () => { skippedTextClipDepth += 1; },
        ignoreText: () => void 0,
        fillShade: (...args) => { if (!isSkippingTextClip())
            drawDevice.fillShade(...args); },
        fillImage: (...args) => { if (!isSkippingTextClip())
            drawDevice.fillImage(...args); },
        fillImageMask: (...args) => { if (!isSkippingTextClip())
            drawDevice.fillImageMask(...args); },
        clipImageMask: (...args) => { if (!isSkippingTextClip())
            drawDevice.clipImageMask(...args); },
        popClip: () => {
            if (skippedTextClipDepth > 0) {
                skippedTextClipDepth -= 1;
                return;
            }
            drawDevice.popClip();
        },
        beginMask: (...args) => { if (!isSkippingTextClip())
            drawDevice.beginMask(...args); },
        endMask: () => { if (!isSkippingTextClip())
            drawDevice.endMask(); },
        beginGroup: (...args) => isSkippingTextClip() ? 0 : drawDevice.beginGroup(...args),
        endGroup: () => { if (!isSkippingTextClip())
            drawDevice.endGroup(); },
        beginTile: (...args) => isSkippingTextClip() ? 0 : drawDevice.beginTile(...args),
        endTile: () => { if (!isSkippingTextClip())
            drawDevice.endTile(); },
        beginLayer: (...args) => { if (!isSkippingTextClip())
            drawDevice.beginLayer(...args); },
        endLayer: () => { if (!isSkippingTextClip())
            drawDevice.endLayer(); }
    });
    return {
        device,
        close,
        destroy: () => {
            close();
            destroyMuPdfObject(device);
            destroyMuPdfObject(drawDevice);
        }
    };
}
export async function renderPdfPagePng(filePath, pageIndex, dpi, options = {}) {
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
                let pixmap = null;
                let device = null;
                try {
                    const bounds = page.getBounds();
                    const pixmapBounds = integerRect(mupdf.Rect.transform(bounds, matrix));
                    pixmap = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, pixmapBounds, false);
                    pixmap.clear(255);
                    device = createNoTextDrawDevice(mupdf, matrix, pixmap);
                    page.run(device.device, mupdf.Matrix.identity);
                    device.close();
                    return new Uint8Array(pixmap.asPNG());
                }
                finally {
                    device?.destroy();
                    destroyMuPdfObject(pixmap);
                }
            }
            const pixmap = page.toPixmap(matrix, mupdf.ColorSpace.DeviceRGB, false, true);
            try {
                return new Uint8Array(pixmap.asPNG());
            }
            finally {
                destroyMuPdfObject(pixmap);
            }
        }
        finally {
            destroyMuPdfObject(page);
        }
    }
    finally {
        destroyMuPdfObject(document);
    }
}
