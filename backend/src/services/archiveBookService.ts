import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { type ArchiveImportOptions, type ImportedBookManifest, type ImportedPageManifest, type SourceLayout, type SourceType } from "../types.js";
import { extractJobArchive } from "./archiveImportService.js";
import { prepareArchiveUnicodeSource } from "./archiveUnicodeService.js";
import { jobStore } from "./jobStore.js";

type OpfItem = { id: string; href: string; mediaType: string };
type ArchivePagePathResult = { pagePaths: string[]; warnings: string[] };

function xmlAttributes(tag: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  for (const match of tag.matchAll(/([:\w-]+)\s*=\s*(["'])(.*?)\2/g)) attributes[match[1]] = match[3];
  return attributes;
}

function decodeXml(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function normalizeRelativePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\//, "");
}

function safeArchiveReference(baseDir: string, value: string): string {
  if (value.includes("\0")) throw new Error("Archive manifest contains an unsafe null byte");
  let decoded: string;
  try {
    decoded = decodeURIComponent(decodeXml(value).split("#")[0]);
  } catch {
    throw new Error(`Archive manifest contains an invalid encoded path: ${value}`);
  }
  const resolved = path.posix.normalize(path.posix.join(baseDir === "." ? "" : baseDir, normalizeRelativePath(decoded)));
  if (!resolved || resolved === ".." || resolved.startsWith("../") || path.posix.isAbsolute(resolved)) {
    throw new Error(`Archive manifest path traversal is not allowed: ${value}`);
  }
  return resolved;
}

async function walkFiles(rootDir: string, currentDir = rootDir): Promise<string[]> {
  const entries = await readdir(currentDir, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const fullPath = path.join(currentDir, entry.name);
    return entry.isDirectory() ? walkFiles(rootDir, fullPath) : [normalizeRelativePath(path.relative(rootDir, fullPath))];
  }));
  return nested.flat();
}

function naturalPageSort(left: string, right: string): number {
  return left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" });
}

function contentDimension(html: string, name: "width" | "height"): number {
  const metaTags = html.match(/<meta\b[^>]*>/gi) ?? [];
  for (const tag of metaTags) {
    const attributes = xmlAttributes(tag);
    if (attributes.name?.toLowerCase() !== "viewport") continue;
    const match = attributes.content?.match(new RegExp(`(?:^|[,;\\s])${name}\\s*=\\s*([0-9.]+)`, "i"));
    if (match) return Number(match[1]) || 0;
  }
  return 0;
}

function contentTitle(html: string): string | undefined {
  const match = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  return match ? decodeXml(match[1].replace(/<[^>]+>/g, "").trim()) || undefined : undefined;
}

async function epubSpinePages(sourceDir: string): Promise<string[]> {
  const containerXml = await readFile(path.join(sourceDir, "META-INF", "container.xml"), "utf8");
  const rootfileTag = containerXml.match(/<rootfile\b[^>]*>/i)?.[0];
  const opfRelativePath = rootfileTag ? xmlAttributes(rootfileTag)["full-path"] : "";
  if (!opfRelativePath) throw new Error("Invalid EPUB: package document path is missing");
  const normalizedOpfPath = safeArchiveReference("", opfRelativePath);
  const opfPath = path.join(sourceDir, ...normalizedOpfPath.split("/"));
  const opf = await readFile(opfPath, "utf8");
  const opfDir = path.posix.dirname(normalizedOpfPath);
  const items = new Map<string, OpfItem>();
  for (const tag of opf.match(/<item\b[^>]*>/gi) ?? []) {
    const attributes = xmlAttributes(tag);
    if (!attributes.id || !attributes.href) continue;
    items.set(attributes.id, { id: attributes.id, href: attributes.href, mediaType: attributes["media-type"] ?? "" });
  }
  const pages: string[] = [];
  for (const tag of opf.match(/<itemref\b[^>]*>/gi) ?? []) {
    const idref = xmlAttributes(tag).idref;
    const item = idref ? items.get(idref) : undefined;
    if (!item || item.mediaType !== "application/xhtml+xml") continue;
    pages.push(safeArchiveReference(opfDir, item.href));
  }
  return pages;
}

function fileExistsInArchive(files: Set<string>, relativePath: string): boolean {
  return files.has(normalizeRelativePath(relativePath).toLowerCase());
}

async function archivePagePaths(sourceDir: string, sourceType: Exclude<SourceType, "pdf">, files: string[], options: ArchiveImportOptions): Promise<ArchivePagePathResult> {
  const fileSet = new Set(files.map((file) => normalizeRelativePath(file).toLowerCase()));
  const warnings: string[] = [];
  if (sourceType === "epub" && options.pageDiscovery !== "all-xhtml") {
    const spinePages = await epubSpinePages(sourceDir);
    if (spinePages.length) {
      const existingSpinePages = spinePages.filter((page) => fileExistsInArchive(fileSet, page));
      for (const missingPage of spinePages.filter((page) => !fileExistsInArchive(fileSet, page))) {
        warnings.push(`Skipped missing EPUB spine page: ${missingPage}`);
      }
      if (existingSpinePages.length) return { pagePaths: existingSpinePages, warnings };
    }
  }
  return {
    pagePaths: files
    .filter((file) => /\.(?:xhtml|html|htm)$/i.test(file))
    .filter((file) => !/(?:^|\/)(?:nav|navigation|toc)(?:\.[^/]*)?\.(?:xhtml|html|htm)$/i.test(file))
      .sort(naturalPageSort),
    warnings
  };
}

export async function importArchiveBook(
  jobId: string,
  archivePath: string,
  sourceType: Exclude<SourceType, "pdf">,
  originalFileName: string,
  createdAt: string,
  options: ArchiveImportOptions
): Promise<ImportedBookManifest> {
  const extraction = await extractJobArchive(jobId, archivePath, sourceType);
  const unicodePreparation = await prepareArchiveUnicodeSource(jobId, extraction.files, options);
  const sourceDir = path.join(jobStore.getImportedDir(jobId), unicodePreparation.reviewRoot);
  const { pagePaths, warnings: pagePathWarnings } = await archivePagePaths(sourceDir, sourceType, extraction.files, options);
  if (!pagePaths.length) throw new Error("Archive does not contain XHTML or HTML content pages");

  const pages: ImportedPageManifest[] = [];
  for (const [pageIndex, relativePath] of pagePaths.entries()) {
    const html = await readFile(path.join(sourceDir, ...relativePath.split("/")), "utf8");
    pages.push({
      pageIndex,
      sourcePath: relativePath,
      reviewPath: relativePath,
      width: contentDimension(html, "width"),
      height: contentDimension(html, "height"),
      title: contentTitle(html)
    });
  }

  const pagesWithViewport = pages.filter((page) => page.width > 0 && page.height > 0).length;
  const detectedLayout: SourceLayout = pagesWithViewport === pages.length ? "fixed" : pagesWithViewport > 0 ? "unknown" : "reflowable";
  const layout: SourceLayout = options.layoutMode === "auto" ? detectedLayout : options.layoutMode;
  const pageSet = new Set(pagePaths.map((page) => page.toLowerCase()));
  const now = new Date().toISOString();
  return {
    version: 1,
    jobId,
    sourceType,
    layout,
    sourceRoot: "source",
    reviewRoot: unicodePreparation.reviewRoot,
    unicodeReportPath: "imported/unicode-report.json",
    status: "ready",
    originalFileName,
    pages,
    sharedAssets: extraction.files.filter((file) => !pageSet.has(file.toLowerCase())),
    warnings: [
      ...extraction.skippedFiles.map((file) => `Skipped unsupported archive file: ${file}`),
      ...pagePathWarnings,
      ...unicodePreparation.warnings,
      ...(unicodePreparation.report.totals.mojibakeRepairs > 0 ? [`Unicode repair changed ${unicodePreparation.report.totals.mojibakeRepairs} high-confidence mojibake text runs.`] : []),
      ...(unicodePreparation.report.totals.redundantJoinersRemoved > 0 ? [`Unicode cleanup removed ${unicodePreparation.report.totals.redundantJoinersRemoved} redundant Indic joiners.`] : []),
      ...(layout === "unknown" ? ["Some content pages do not declare fixed-layout viewport dimensions."] : [])
    ],
    importOptions: options,
    createdAt,
    updatedAt: now
  };
}
