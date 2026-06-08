export type DisposableMuPdfObject = {
  destroy?: () => void;
};

export function destroyMuPdfObject(value: DisposableMuPdfObject | null | undefined, context = "mupdf"): void {
  try {
    value?.destroy?.();
  } catch (error) {
    console.warn(`[${context}] MuPDF cleanup failed:`, error);
  }
}
