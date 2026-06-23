import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { type ArchiveImportOptions } from "../types.js";
import { jobStore } from "./jobStore.js";

interface UnicodeFileReport {
  path: string;
  changed: boolean;
  textNodes: number;
  normalizationChanges: number;
  mojibakeRepairs: number;
  redundantJoinersRemoved: number;
  languageMetadataApplied: boolean;
}

export interface ArchiveUnicodeReport {
  version: 1;
  jobId: string;
  generatedAt: string;
  textHandling: ArchiveImportOptions["textHandling"];
  sourceRoot: string;
  reviewRoot: string;
  options: ArchiveImportOptions["unicode"];
  totals: {
    filesScanned: number;
    filesChanged: number;
    textNodes: number;
    normalizationChanges: number;
    mojibakeRepairs: number;
    redundantJoinersRemoved: number;
    languageMetadataApplied: number;
  };
  files: UnicodeFileReport[];
}

export interface ArchiveUnicodePreparation {
  reviewRoot: string;
  report: ArchiveUnicodeReport;
  warnings: string[];
}

type TextTransformStats = Omit<UnicodeFileReport, "path" | "changed" | "languageMetadataApplied">;

const CONTENT_FILE_PATTERN = /\.(?:xhtml|html|htm)$/i;
const SKIP_TEXT_TAGS = new Set(["script", "style"]);
const MOJIBAKE_RUN_PATTERN = /[\u0080-\u00ff]{2,}/g;
const REDUNDANT_DEVANAGARI_JOINER_PATTERN = /([\u0900-\u097f]\u094d)[\u200c\u200d](?=[\u0900-\u097f])/g;

function safeJobPath(rootDir: string, relativePath: string): string {
  const resolved = path.resolve(rootDir, ...relativePath.split("/"));
  const root = path.resolve(rootDir);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) throw new Error(`Unsafe archive path: ${relativePath}`);
  return resolved;
}

function isContentFile(relativePath: string): boolean {
  return CONTENT_FILE_PATTERN.test(relativePath);
}

function emptyStats(): TextTransformStats {
  return {
    textNodes: 0,
    normalizationChanges: 0,
    mojibakeRepairs: 0,
    redundantJoinersRemoved: 0
  };
}

function mojibakeScore(value: string): number {
  return (value.match(/[ÃÂâà¤¥§¦¨©ª«¬®¯°±²³´µ¶·¸¹º»¼½¾¿\u0080-\u009f]/g) ?? []).length;
}

function repairMojibakeRuns(value: string, stats: TextTransformStats): string {
  return value.replace(MOJIBAKE_RUN_PATTERN, (run) => {
    const repaired = Buffer.from(run, "latin1").toString("utf8");
    if (!repaired || repaired.includes("\uFFFD")) return run;
    if (mojibakeScore(repaired) >= mojibakeScore(run)) return run;
    stats.mojibakeRepairs += 1;
    return repaired;
  });
}

function removeRedundantIndicJoiners(value: string, stats: TextTransformStats): string {
  return value.replace(REDUNDANT_DEVANAGARI_JOINER_PATTERN, (_match, prefix: string) => {
    stats.redundantJoinersRemoved += 1;
    return prefix;
  });
}

function transformText(value: string, options: ArchiveImportOptions, stats: TextTransformStats): string {
  if (!value) return value;
  stats.textNodes += 1;
  let next = value;
  if (options.unicode.mojibakeRepair === "high-confidence") next = repairMojibakeRuns(next, stats);
  if (options.unicode.joinerPolicy === "remove-redundant-indic") next = removeRedundantIndicJoiners(next, stats);
  if (options.unicode.normalization !== "none") {
    const normalized = next.normalize(options.unicode.normalization === "nfkc" ? "NFKC" : "NFC");
    if (normalized !== next) stats.normalizationChanges += 1;
    next = normalized;
  }
  return next;
}

function transformTextNodes(html: string, options: ArchiveImportOptions, stats: TextTransformStats): string {
  let output = "";
  let lastIndex = 0;
  let skipDepth = 0;
  const tagPattern = /<[^>]*>/g;
  for (const match of html.matchAll(tagPattern)) {
    const index = match.index ?? 0;
    const text = html.slice(lastIndex, index);
    output += skipDepth > 0 ? text : transformText(text, options, stats);

    const tag = match[0];
    output += tag;
    const tagName = tag.match(/^<\s*\/?\s*([A-Za-z][\w:-]*)/)?.[1]?.toLowerCase();
    if (tagName && SKIP_TEXT_TAGS.has(tagName)) {
      const isClosing = /^<\s*\//.test(tag);
      const isSelfClosing = /\/\s*>$/.test(tag);
      if (isClosing) skipDepth = Math.max(0, skipDepth - 1);
      else if (!isSelfClosing) skipDepth += 1;
    }
    lastIndex = index + tag.length;
  }
  const tail = html.slice(lastIndex);
  output += skipDepth > 0 ? tail : transformText(tail, options, stats);
  return output;
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

function setHtmlAttribute(tag: string, name: string, value: string): string {
  const escaped = escapeAttribute(value);
  const attributePattern = new RegExp(`\\s${name.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")}\\s*=\\s*(["']).*?\\1`, "i");
  if (attributePattern.test(tag)) return tag.replace(attributePattern, ` ${name}="${escaped}"`);
  return tag.replace(/\/?>$/, (ending) => ` ${name}="${escaped}"${ending}`);
}

function applyHtmlMetadata(html: string, options: ArchiveImportOptions): { html: string; applied: boolean } {
  if (!options.unicode.applyLanguageMetadata) return { html, applied: false };
  const language = options.language === "auto" ? "" : options.language.trim();
  const direction = options.readingDirection === "auto" ? "" : options.readingDirection;
  if (!language && !direction) return { html, applied: false };
  let applied = false;
  const next = html.replace(/<html\b[^>]*>/i, (tag) => {
    let nextTag = tag;
    if (language) {
      nextTag = setHtmlAttribute(nextTag, "lang", language);
      nextTag = setHtmlAttribute(nextTag, "xml:lang", language);
      applied = true;
    }
    if (direction) {
      nextTag = setHtmlAttribute(nextTag, "dir", direction);
      applied = true;
    }
    return nextTag;
  });
  return { html: next, applied };
}

function shouldWriteReviewSource(options: ArchiveImportOptions): boolean {
  return options.textHandling === "safe-cleanup" || options.textHandling === "advanced-repair";
}

async function writeReport(jobId: string, report: ArchiveUnicodeReport): Promise<void> {
  const reportPath = path.join(jobStore.getImportedDir(jobId), "unicode-report.json");
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, JSON.stringify(report, null, 2), "utf8");
}

export async function prepareArchiveUnicodeSource(
  jobId: string,
  files: string[],
  options: ArchiveImportOptions
): Promise<ArchiveUnicodePreparation> {
  const effectiveOptions: ArchiveImportOptions = options.textHandling === "preserve"
    ? {
      ...options,
      unicode: {
        normalization: "none",
        applyLanguageMetadata: false,
        mojibakeRepair: "off",
        joinerPolicy: "preserve",
        legacyFontProfile: "off"
      }
    }
    : options;
  const importedDir = jobStore.getImportedDir(jobId);
  const sourceRoot = "source";
  const reviewRoot = shouldWriteReviewSource(effectiveOptions) ? "review-source" : "source";
  const sourceDir = path.join(importedDir, sourceRoot);
  const reviewDir = path.join(importedDir, reviewRoot);
  const warnings: string[] = [];

  if (reviewRoot !== sourceRoot) {
    await rm(reviewDir, { recursive: true, force: true });
    await cp(sourceDir, reviewDir, { recursive: true, force: true });
  }

  const fileReports: UnicodeFileReport[] = [];
  for (const relativePath of files.filter(isContentFile)) {
    const filePath = safeJobPath(reviewDir, relativePath);
    const original = await readFile(filePath, "utf8");
    const stats = emptyStats();
    const metadataResult = applyHtmlMetadata(original, effectiveOptions);
    const transformed = transformTextNodes(metadataResult.html, effectiveOptions, stats);
    const changed = transformed !== original;
    if (reviewRoot !== sourceRoot && changed) await writeFile(filePath, transformed, "utf8");
    fileReports.push({
      path: relativePath,
      changed,
      languageMetadataApplied: metadataResult.applied,
      ...stats
    });
  }

  const totals = fileReports.reduce<ArchiveUnicodeReport["totals"]>((current, file) => ({
    filesScanned: current.filesScanned + 1,
    filesChanged: current.filesChanged + (file.changed ? 1 : 0),
    textNodes: current.textNodes + file.textNodes,
    normalizationChanges: current.normalizationChanges + file.normalizationChanges,
    mojibakeRepairs: current.mojibakeRepairs + file.mojibakeRepairs,
    redundantJoinersRemoved: current.redundantJoinersRemoved + file.redundantJoinersRemoved,
    languageMetadataApplied: current.languageMetadataApplied + (file.languageMetadataApplied ? 1 : 0)
  }), {
    filesScanned: 0,
    filesChanged: 0,
    textNodes: 0,
    normalizationChanges: 0,
    mojibakeRepairs: 0,
    redundantJoinersRemoved: 0,
    languageMetadataApplied: 0
  });

  if (effectiveOptions.textHandling === "audit") warnings.push("Unicode audit completed without changing source XHTML.");
  if (reviewRoot !== sourceRoot) warnings.push(`Unicode cleanup created review source '${reviewRoot}' from the preserved import source.`);
  if (effectiveOptions.unicode.joinerPolicy === "remove-redundant-indic") warnings.push("Indic joiner cleanup is limited to redundant Devanagari ZWJ/ZWNJ after virama.");
  if (effectiveOptions.unicode.legacyFontProfile !== "off") warnings.push("Legacy font conversion is not available in this build.");

  const report: ArchiveUnicodeReport = {
    version: 1,
    jobId,
    generatedAt: new Date().toISOString(),
    textHandling: options.textHandling,
    sourceRoot,
    reviewRoot,
    options: effectiveOptions.unicode,
    totals,
    files: fileReports
  };
  await writeReport(jobId, report);
  return { reviewRoot, report, warnings };
}
