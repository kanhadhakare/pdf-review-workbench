export function destroyMuPdfObject(value, context = "mupdf") {
    try {
        value?.destroy?.();
    }
    catch (error) {
        console.warn(`[${context}] MuPDF cleanup failed:`, error);
    }
}
