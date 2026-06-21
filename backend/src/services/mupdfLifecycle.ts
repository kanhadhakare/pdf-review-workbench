export type DisposableMuPdfObject = {
  destroy?: () => void;
};

let muPdfOperationQueue = Promise.resolve();

export async function withMuPdfLock<T>(operation: () => Promise<T> | T): Promise<T> {
  const previousOperation = muPdfOperationQueue;
  let releaseOperation: () => void = () => void 0;
  muPdfOperationQueue = new Promise<void>((resolve) => {
    releaseOperation = resolve;
  });

  await previousOperation;
  try {
    return await operation();
  } finally {
    releaseOperation();
  }
}

export function destroyMuPdfObject(value: DisposableMuPdfObject | null | undefined, context = "mupdf"): void {
  try {
    value?.destroy?.();
  } catch (error) {
    console.warn(`[${context}] MuPDF cleanup failed:`, error);
  }
}
