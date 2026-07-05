import { copyFile, link, mkdir, readdir, rm, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { jobStore } from "./jobStore.js";

const sourceCopyPromises = new Map<string, Promise<void>>();

async function linkOrCopyFile(sourcePath: string, targetPath: string): Promise<void> {
  await mkdir(path.dirname(targetPath), { recursive: true });
  try {
    await link(sourcePath, targetPath);
  } catch {
    await copyFile(sourcePath, targetPath);
  }
}

async function linkOrCopyTree(sourceDir: string, targetDir: string): Promise<void> {
  const entries = await readdir(sourceDir, { withFileTypes: true });
  await mkdir(targetDir, { recursive: true });
  await Promise.all(entries.map(async (entry) => {
    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);
    if (entry.isDirectory()) {
      await linkOrCopyTree(sourcePath, targetPath);
      return;
    }
    if (entry.isFile()) {
      await linkOrCopyFile(sourcePath, targetPath);
    }
  }));
}

async function ensureFinalSource(jobId: string): Promise<string> {
  const finalDir = jobStore.getFinalDir(jobId);
  const finalSourceDir = path.join(finalDir, "source");
  const readyPath = path.join(finalDir, ".archive-source-ready");
  if ((await stat(readyPath).catch(() => null))?.isFile()) return finalSourceDir;

  const existing = sourceCopyPromises.get(jobId);
  if (existing) {
    await existing;
    return finalSourceDir;
  }

  const copyPromise = (async () => {
    const manifest = await jobStore.getSourceManifest(jobId);
    const importedSourceDir = path.join(jobStore.getImportedDir(jobId), manifest?.reviewRoot ?? "source");
    if (!(await stat(importedSourceDir).catch(() => null))?.isDirectory()) throw new Error("Imported review source not found");
    await mkdir(finalDir, { recursive: true });
    await rm(finalSourceDir, { recursive: true, force: true });
    await linkOrCopyTree(importedSourceDir, finalSourceDir);
    await writeFile(readyPath, new Date().toISOString(), "utf8");
  })();
  sourceCopyPromises.set(jobId, copyPromise);
  try {
    await copyPromise;
  } finally {
    sourceCopyPromises.delete(jobId);
  }
  return finalSourceDir;
}

export async function writeArchiveFinalPage(jobId: string, pageIndex: number, html: string): Promise<string> {
  const manifest = await jobStore.getSourceManifest(jobId);
  const page = manifest?.pages.find((candidate) => candidate.pageIndex === pageIndex);
  if (!page) throw new Error("Imported page not found");
  if (!html.includes("data-zoning-final=\"true\"")) throw new Error("Generated archive final page is invalid");

  const finalSourceDir = await ensureFinalSource(jobId);
  const targetPath = path.resolve(finalSourceDir, ...page.reviewPath.split("/"));
  const finalRoot = `${path.resolve(finalSourceDir)}${path.sep}`;
  if (!targetPath.startsWith(finalRoot)) throw new Error("Invalid imported page path");
  await mkdir(path.dirname(targetPath), { recursive: true });
  await unlink(targetPath).catch(() => void 0);
  await writeFile(targetPath, html, "utf8");
  return page.reviewPath;
}
