import { mkdir, readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { jobStore } from "./jobStore.js";
import { createStoredZip } from "./zipWriter.js";
import { renderFinalBackgroundPng } from "./finalBackgroundService.js";

async function walkFiles(dirPath: string): Promise<string[]> {
  const entries = await readdir(dirPath, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const fullPath = path.join(dirPath, entry.name);
    return entry.isDirectory() ? walkFiles(fullPath) : [fullPath];
  }));
  return nested.flat();
}

async function createFinalPageImage(jobId: string, pageNumber: number, fallbackImagePath: string): Promise<Buffer> {
  return renderFinalBackgroundPng(jobId, pageNumber - 1, fallbackImagePath);
}

function archiveFileName(originalFileName: string): string {
  const baseName = originalFileName.replace(/\.[^.]+$/, "").replace(/[^A-Za-z0-9_-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  return `${baseName || "final-book"}-final.zip`;
}

export async function buildFinalArchive(jobId: string): Promise<{ fileName: string; buffer: Buffer }> {
  const job = await jobStore.getJob(jobId);
  if (!job) throw new Error("Job not found");

  const finalDir = jobStore.getFinalDir(jobId);
  const info = await stat(finalDir).catch(() => null);
  if (!info?.isDirectory()) throw new Error("Final build not found");

  await mkdir(finalDir, { recursive: true });
  const files = await walkFiles(finalDir);
  const archiveFiles = await Promise.all(files.map(async (filePath) => {
    const relativePath = path.relative(finalDir, filePath).replace(/\\/g, "/");
    const pageImageMatch = relativePath.match(/^images\/page-(\d+)\.png$/);
    const data = pageImageMatch
      ? await createFinalPageImage(jobId, Number(pageImageMatch[1]), filePath)
      : await readFile(filePath);
    return { name: relativePath, data };
  }));

  return {
    fileName: archiveFileName(job.originalFileName),
    buffer: createStoredZip(archiveFiles)
  };
}
