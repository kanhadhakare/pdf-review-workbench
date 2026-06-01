import { readFile } from "node:fs/promises";
import { finalOutputDpi } from "../config/runtime.js";
import { jobStore } from "./jobStore.js";
import { renderPdfPagePng } from "./pdfRasterService.js";

export async function renderFinalBackgroundPng(jobId: string, pageIndex: number, fallbackImagePath?: string): Promise<Buffer> {
  const job = await jobStore.getJob(jobId);
  if (!job) throw new Error("Job not found");

  try {
    const imageBytes = await renderPdfPagePng(job.filePath, pageIndex, finalOutputDpi, { omitText: true });
    return Buffer.from(imageBytes);
  } catch (error) {
    if (!fallbackImagePath) throw error;
    console.warn(`[finalBackgroundService] unable to render object-level no-text ${finalOutputDpi} DPI final image; using fallback`, error);
    return readFile(fallbackImagePath);
  }
}
