import { createWriteStream } from "node:fs";
import { mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform, type Readable } from "node:stream";
import { randomUUID } from "node:crypto";
import yauzl, { type Entry, type ZipFile } from "yauzl";
import { type SourceType } from "../types.js";
import { jobStore } from "./jobStore.js";

export interface ArchiveExtractionLimits {
  maxEntries: number;
  maxEntryBytes: number;
  maxTotalBytes: number;
  maxCompressionRatio: number;
  maxRelativePathLength: number;
}

export interface ArchiveExtractionResult {
  files: string[];
  skippedFiles: string[];
  totalBytes: number;
  entryCount: number;
}

const DEFAULT_LIMITS: ArchiveExtractionLimits = {
  maxEntries: 10_000,
  maxEntryBytes: 256 * 1024 * 1024,
  maxTotalBytes: 1024 * 1024 * 1024,
  maxCompressionRatio: 200,
  maxRelativePathLength: 220
};

const ALLOWED_EXTENSIONS = new Set([
  ".html", ".htm", ".xhtml", ".css", ".json", ".xml", ".opf", ".ncx", ".smil",
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".avif",
  ".otf", ".ttf", ".woff", ".woff2",
  ".mp3", ".m4a", ".aac", ".oga", ".ogg", ".mp4", ".webm"
]);

function openArchive(filePath: string): Promise<ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(filePath, { lazyEntries: true, autoClose: true, decodeStrings: true, validateEntrySizes: true }, (error, zipFile) => {
      if (error || !zipFile) reject(error ?? new Error("Unable to open archive"));
      else resolve(zipFile);
    });
  });
}

function openEntryStream(zipFile: ZipFile, entry: Entry): Promise<Readable> {
  return new Promise((resolve, reject) => {
    zipFile.openReadStream(entry, (error, stream) => {
      if (error || !stream) reject(error ?? new Error(`Unable to read ${entry.fileName}`));
      else resolve(stream);
    });
  });
}

function safeRelativePath(fileName: string, maxLength: number): string {
  if (fileName.includes("\0")) throw new Error("Archive contains a filename with a null byte");
  const normalized = fileName.replace(/\\/g, "/").replace(/^\.\//, "");
  if (!normalized || normalized.length > maxLength) throw new Error(`Unsafe archive path: ${fileName}`);
  if (normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized)) throw new Error(`Absolute archive path is not allowed: ${fileName}`);
  const segments = normalized.split("/").filter(Boolean);
  if (segments.some((segment) => segment === "." || segment === "..")) throw new Error(`Archive path traversal is not allowed: ${fileName}`);
  return segments.join("/");
}

function isSymbolicLink(entry: Entry): boolean {
  const unixMode = (entry.externalFileAttributes >>> 16) & 0xffff;
  return (unixMode & 0o170000) === 0o120000;
}

function isAllowedFile(relativePath: string): boolean {
  if (relativePath === "mimetype") return true;
  return ALLOWED_EXTENSIONS.has(path.posix.extname(relativePath).toLowerCase());
}

function ensureEntryWithinLimits(entry: Entry, limits: ArchiveExtractionLimits, totalBytes: number): void {
  if ((entry.generalPurposeBitFlag & 0x1) !== 0) throw new Error(`Encrypted archive entry is not supported: ${entry.fileName}`);
  if (isSymbolicLink(entry)) throw new Error(`Symbolic links are not allowed in archives: ${entry.fileName}`);
  if (entry.uncompressedSize > limits.maxEntryBytes) throw new Error(`Archive entry is too large: ${entry.fileName}`);
  if (totalBytes + entry.uncompressedSize > limits.maxTotalBytes) throw new Error("Archive exceeds the maximum extracted size");
  if (entry.uncompressedSize > 0) {
    const ratio = entry.compressedSize === 0 ? Number.POSITIVE_INFINITY : entry.uncompressedSize / entry.compressedSize;
    if (ratio > limits.maxCompressionRatio) throw new Error(`Suspicious compression ratio for archive entry: ${entry.fileName}`);
  }
}

async function validateExtractedArchive(targetDir: string, sourceType: SourceType): Promise<void> {
  if (sourceType !== "epub") return;
  const mimetype = (await readFile(path.join(targetDir, "mimetype"), "utf8").catch(() => "")).trim();
  if (mimetype !== "application/epub+zip") throw new Error("Invalid EPUB: missing or incorrect mimetype file");
  const container = await stat(path.join(targetDir, "META-INF", "container.xml")).catch(() => null);
  if (!container?.isFile()) throw new Error("Invalid EPUB: META-INF/container.xml is missing");
}

export async function extractBookArchive(
  archivePath: string,
  targetDir: string,
  sourceType: Exclude<SourceType, "pdf">,
  customLimits: Partial<ArchiveExtractionLimits> = {}
): Promise<ArchiveExtractionResult> {
  const limits = { ...DEFAULT_LIMITS, ...customLimits };
  const parentDir = path.dirname(targetDir);
  const temporaryDir = path.join(parentDir, `.${path.basename(targetDir)}-${randomUUID()}.partial`);
  const zipFile = await openArchive(archivePath);
  const files: string[] = [];
  const skippedFiles: string[] = [];
  const seenPaths = new Set<string>();
  let totalBytes = 0;
  let entryCount = 0;

  await mkdir(temporaryDir, { recursive: true });
  try {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const fail = (error: unknown): void => {
        if (settled) return;
        settled = true;
        zipFile.close();
        reject(error);
      };

      zipFile.on("error", fail);
      zipFile.on("end", () => {
        if (settled) return;
        settled = true;
        resolve();
      });
      zipFile.on("entry", (entry) => {
        void (async () => {
          entryCount += 1;
          if (entryCount > limits.maxEntries) throw new Error("Archive contains too many entries");
          const relativePath = safeRelativePath(entry.fileName, limits.maxRelativePathLength);
          const dedupeKey = relativePath.toLowerCase();
          if (seenPaths.has(dedupeKey)) throw new Error(`Archive contains duplicate paths: ${relativePath}`);
          seenPaths.add(dedupeKey);
          ensureEntryWithinLimits(entry, limits, totalBytes);

          if (entry.fileName.endsWith("/")) {
            await mkdir(path.join(temporaryDir, ...relativePath.split("/")), { recursive: true });
            zipFile.readEntry();
            return;
          }

          if (!isAllowedFile(relativePath)) {
            skippedFiles.push(relativePath);
            zipFile.readEntry();
            return;
          }

          const targetPath = path.join(temporaryDir, ...relativePath.split("/"));
          await mkdir(path.dirname(targetPath), { recursive: true });
          let writtenBytes = 0;
          const byteLimiter = new Transform({
            transform(chunk: Buffer, _encoding, callback) {
              writtenBytes += chunk.length;
              if (writtenBytes > limits.maxEntryBytes || totalBytes + writtenBytes > limits.maxTotalBytes) {
                callback(new Error(`Archive extraction limit exceeded by ${relativePath}`));
                return;
              }
              callback(null, chunk);
            }
          });
          const input = await openEntryStream(zipFile, entry);
          await pipeline(input, byteLimiter, createWriteStream(targetPath, { flags: "wx" }));
          totalBytes += writtenBytes;
          files.push(relativePath);
          zipFile.readEntry();
        })().catch(fail);
      });
      zipFile.readEntry();
    });

    await validateExtractedArchive(temporaryDir, sourceType);
    const existingTarget = await stat(targetDir).catch(() => null);
    if (existingTarget) throw new Error(`Archive target already exists: ${targetDir}`);
    await rename(temporaryDir, targetDir);
    return { files, skippedFiles, totalBytes, entryCount };
  } catch (error) {
    await rm(temporaryDir, { recursive: true, force: true });
    throw error;
  } finally {
    zipFile.close();
  }
}

export async function extractJobArchive(
  jobId: string,
  archivePath: string,
  sourceType: Exclude<SourceType, "pdf">,
  customLimits: Partial<ArchiveExtractionLimits> = {}
): Promise<ArchiveExtractionResult> {
  return extractBookArchive(archivePath, path.join(jobStore.getImportedDir(jobId), "source"), sourceType, customLimits);
}
