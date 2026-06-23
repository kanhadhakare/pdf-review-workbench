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

async function collectTreeFiles(rootDir: string, archivePrefix = ""): Promise<Array<{ name: string; data: Buffer }>> {
  const info = await stat(rootDir).catch(() => null);
  if (!info?.isDirectory()) return [];
  const files = await walkFiles(rootDir);
  return Promise.all(files.map(async (filePath) => ({
    name: path.posix.join(archivePrefix, path.relative(rootDir, filePath).replace(/\\/g, "/")),
    data: await readFile(filePath)
  })));
}

async function createFinalPageImage(jobId: string, pageNumber: number): Promise<Buffer> {
  return renderFinalBackgroundPng(jobId, pageNumber - 1);
}

function archiveFileName(originalFileName: string): string {
  const baseName = originalFileName.replace(/\.[^.]+$/, "").replace(/[^A-Za-z0-9_-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  return `${baseName || "final-book"}-final.zip`;
}

function reviewArchiveFileName(originalFileName: string): string {
  const baseName = originalFileName.replace(/\.[^.]+$/, "").replace(/[^A-Za-z0-9_-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  return `${baseName || "review-book"}-review.zip`;
}

function isArchiveJob(sourceType: string | undefined): boolean {
  return sourceType === "epub" || sourceType === "html-zip";
}

function sortEpubFiles(files: Array<{ name: string; data: Buffer }>): Array<{ name: string; data: Buffer }> {
  return [...files].sort((left, right) => {
    if (left.name === "mimetype") return -1;
    if (right.name === "mimetype") return 1;
    return left.name.localeCompare(right.name);
  });
}

export async function buildReviewArchive(jobId: string): Promise<{ fileName: string; buffer: Buffer }> {
  const job = await jobStore.getJob(jobId);
  if (!job) throw new Error("Job not found");

  let archiveFiles: Array<{ name: string; data: Buffer }>;
  if (isArchiveJob(job.sourceType)) {
    const manifest = await jobStore.getSourceManifest(jobId);
    archiveFiles = await collectTreeFiles(path.join(jobStore.getImportedDir(jobId), manifest?.reviewRoot ?? "source"));
    if (!archiveFiles.length) throw new Error("Imported review source not found");
    archiveFiles = sortEpubFiles(archiveFiles);
  } else {
    const directories = [
      [jobStore.getReviewDir(jobId), "review"],
      [jobStore.getReviewStylesDir(jobId), "style"],
      [jobStore.getImagesDir(jobId), "images"],
      [jobStore.getFontsDir(jobId), "fonts"]
    ] as const;
    archiveFiles = (await Promise.all(directories.map(([directory, prefix]) => collectTreeFiles(directory, prefix)))).flat();
    if (!archiveFiles.some((file) => /^review\/page-\d+\.html$/i.test(file.name))) throw new Error("Review build not found");
  }

  const sourceManifest = await readFile(jobStore.getSourceManifestPath(jobId)).catch(() => null);
  if (sourceManifest) archiveFiles.push({ name: "review-manifest.json", data: sourceManifest });
  return {
    fileName: reviewArchiveFileName(job.originalFileName),
    buffer: createStoredZip(archiveFiles)
  };
}

async function buildArchiveZoningFiles(jobId: string): Promise<Array<{ name: string; data: Buffer }>> {
  const manifest = await jobStore.getSourceManifest(jobId);
  if (!manifest) throw new Error("Source manifest not found");
  const finalDir = jobStore.getFinalDir(jobId);
  const pages = await Promise.all(manifest.pages.map(async (page) => {
    const fileName = `page-${page.pageIndex + 1}.boxes.json`;
    const data = await readFile(path.join(finalDir, fileName)).catch(() => Buffer.from(JSON.stringify({ boxes: [] }, null, 2), "utf8"));
    return { name: `zoning/${fileName}`, data };
  }));
  const zoningManifest = {
    version: 1,
    jobId,
    sourceType: manifest.sourceType,
    generatedAt: new Date().toISOString(),
    semanticXhtmlGenerated: false,
    note: "Original XHTML is preserved. Saved semantic zones are provided as ordered page-level box metadata.",
    pages: manifest.pages.map((page) => ({
      pageIndex: page.pageIndex,
      sourcePath: page.sourcePath,
      zoningPath: `zoning/page-${page.pageIndex + 1}.boxes.json`
    }))
  };
  return [
    ...pages,
    { name: "zoning/manifest.json", data: Buffer.from(JSON.stringify(zoningManifest, null, 2), "utf8") }
  ];
}

export async function buildFinalArchive(jobId: string): Promise<{ fileName: string; buffer: Buffer }> {
  const job = await jobStore.getJob(jobId);
  if (!job) throw new Error("Job not found");

  if (isArchiveJob(job.sourceType)) {
    const generatedSourceDir = path.join(jobStore.getFinalDir(jobId), "source");
    const manifest = await jobStore.getSourceManifest(jobId);
    const sourceRoot = (await stat(generatedSourceDir).catch(() => null))?.isDirectory()
      ? generatedSourceDir
      : path.join(jobStore.getImportedDir(jobId), manifest?.reviewRoot ?? "source");
    const sourceFiles = await collectTreeFiles(sourceRoot);
    if (!sourceFiles.length) throw new Error("Imported source not found");
    const zoningFiles = await buildArchiveZoningFiles(jobId);
    return {
      fileName: archiveFileName(job.originalFileName),
      buffer: createStoredZip([...sortEpubFiles(sourceFiles), ...zoningFiles])
    };
  }

  const finalDir = jobStore.getFinalDir(jobId);
  const info = await stat(finalDir).catch(() => null);
  if (!info?.isDirectory()) throw new Error("Final build not found");

  await mkdir(finalDir, { recursive: true });
  const files = await walkFiles(finalDir);
  const relativePaths = new Set(files.map((filePath) => path.relative(finalDir, filePath).replace(/\\/g, "/")));
  const archiveFiles: Array<{ name: string; data: Buffer }> = [];
  for (const filePath of files) {
    const relativePath = path.relative(finalDir, filePath).replace(/\\/g, "/");
    const htmlPageMatch = relativePath.match(/^page-(\d+)\.html$/);
    if (htmlPageMatch && relativePaths.has(`page-${htmlPageMatch[1]}.xhtml`)) continue;
    const pageImageMatch = relativePath.match(/^images\/page-(\d+)\.png$/);
    const data = pageImageMatch
      ? await createFinalPageImage(jobId, Number(pageImageMatch[1]))
      : await readFile(filePath);
    archiveFiles.push({ name: relativePath, data });
  }

  return {
    fileName: archiveFileName(job.originalFileName),
    buffer: createStoredZip(archiveFiles)
  };
}
