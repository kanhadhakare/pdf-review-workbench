import { finalOutputDpi } from "../config/runtime.js";
import { jobStore } from "./jobStore.js";
import { renderPdfPagePng } from "./pdfRasterService.js";
import { readFile } from "node:fs/promises";
import path from "node:path";

interface ChunkManifest {
  chunks?: Array<{
    fileName: string;
    startPage: number;
    endPage: number;
  }>;
}

async function resolvePdfForPage(jobId: string, sourcePdfPath: string, pageIndex: number): Promise<{ filePath: string; pageIndex: number }> {
  const chunksDir = path.join(jobStore.getJobDir(jobId), "optimized", "chunks");
  const manifestPath = path.join(chunksDir, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8").catch(() => "{}")) as ChunkManifest;
  const pageNumber = pageIndex + 1;
  const chunk = manifest.chunks?.find((candidate) => pageNumber >= candidate.startPage && pageNumber <= candidate.endPage);
  if (!chunk) return { filePath: sourcePdfPath, pageIndex };
  return {
    filePath: path.join(chunksDir, chunk.fileName),
    pageIndex: pageNumber - chunk.startPage
  };
}

export async function renderFinalBackgroundPng(jobId: string, pageIndex: number): Promise<Buffer> {
  const job = await jobStore.getJob(jobId);
  if (!job) throw new Error("Job not found");

  const source = await resolvePdfForPage(jobId, job.filePath, pageIndex);
  const imageBytes = await renderPdfPagePng(source.filePath, source.pageIndex, finalOutputDpi, { omitText: true });
  return Buffer.from(imageBytes);
}
