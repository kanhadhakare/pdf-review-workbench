import { finalOutputDpi } from "../config/runtime.js";
import { jobStore } from "./jobStore.js";
import { renderPdfPagePng } from "./pdfRasterService.js";

export async function renderFinalBackgroundPng(jobId: string, pageIndex: number): Promise<Buffer> {
  const job = await jobStore.getJob(jobId);
  if (!job) throw new Error("Job not found");

  const imageBytes = await renderPdfPagePng(job.filePath, pageIndex, finalOutputDpi, { omitText: true });
  return Buffer.from(imageBytes);
}
