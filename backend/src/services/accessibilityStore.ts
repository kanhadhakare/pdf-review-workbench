import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  type AccessibilityMap,
  type AccessibilityPageMap,
  type AccessibilityPageReviewStatus,
  type AccessibilityTag,
  type AccessibilityTagName,
  type AccessibilityTagStatus
} from "../types.js";
import { jobStore } from "./jobStore.js";

const tagNames = new Set<AccessibilityTagName>([
  "H1", "H2", "H3", "H4", "H5", "H6",
  "P", "L", "LI",
  "Table", "TR", "TH", "TD",
  "Figure", "Caption", "Formula", "Artifact"
]);

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporaryPath, JSON.stringify(value, null, 2), "utf8");
    await rename(temporaryPath, filePath);
  } finally {
    await unlink(temporaryPath).catch(() => void 0);
  }
}

async function readJson<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as T;
  } catch {
    return null;
  }
}

function emptyMap(jobId: string): AccessibilityMap {
  const now = new Date().toISOString();
  return {
    version: 1,
    jobId,
    document: {
      pdfUaTarget: "PDF/UA-1"
    },
    pages: {},
    createdAt: now,
    updatedAt: now
  };
}

function emptyPage(pageIndex: number): AccessibilityPageMap {
  return {
    pageIndex,
    reviewStatus: "untagged",
    tags: [],
    updatedAt: new Date().toISOString()
  };
}

function finiteNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function normalizeStatus(value: unknown): AccessibilityTagStatus {
  return value === "suggested" || value === "needs-review" ? value : "accepted";
}

function normalizeReviewStatus(value: unknown, tags: AccessibilityTag[]): AccessibilityPageReviewStatus {
  if (value === "reviewed") return "reviewed";
  if (value === "needs-review") return "needs-review";
  return tags.length ? "needs-review" : "untagged";
}

function normalizeTag(input: Partial<AccessibilityTag>, pageIndex: number, index: number, now: string): AccessibilityTag {
  const tag = tagNames.has(input.tag as AccessibilityTagName) ? input.tag as AccessibilityTagName : "P";
  const bbox = input.bbox ?? { x: 0, y: 0, w: 0, h: 0 };
  return {
    id: typeof input.id === "string" && input.id.trim() ? input.id : randomUUID(),
    pageIndex,
    tag,
    bbox: {
      x: Number(finiteNumber(bbox.x).toFixed(2)),
      y: Number(finiteNumber(bbox.y).toFixed(2)),
      w: Math.max(1, Number(finiteNumber(bbox.w, 1).toFixed(2))),
      h: Math.max(1, Number(finiteNumber(bbox.h, 1).toFixed(2)))
    },
    readingOrder: Math.max(1, Math.floor(finiteNumber(input.readingOrder, index + 1))),
    confidence: Math.max(0, Math.min(1, finiteNumber(input.confidence, 1))),
    source: input.source === "auto-detection" ? "auto-detection" : "manual",
    status: normalizeStatus(input.status),
    altText: typeof input.altText === "string" ? input.altText : undefined,
    actualText: typeof input.actualText === "string" ? input.actualText : undefined,
    language: typeof input.language === "string" ? input.language : undefined,
    table: input.table && typeof input.table === "object" ? {
      rowCount: Number.isFinite(input.table.rowCount) ? Math.max(0, Math.floor(input.table.rowCount!)) : undefined,
      columnCount: Number.isFinite(input.table.columnCount) ? Math.max(0, Math.floor(input.table.columnCount!)) : undefined,
      headerScope: input.table.headerScope === "row" || input.table.headerScope === "column" || input.table.headerScope === "both" || input.table.headerScope === "none" ? input.table.headerScope : undefined
    } : undefined,
    formula: input.formula && typeof input.formula === "object" ? {
      latex: typeof input.formula.latex === "string" ? input.formula.latex : undefined,
      mathml: typeof input.formula.mathml === "string" ? input.formula.mathml : undefined
    } : undefined,
    createdAt: typeof input.createdAt === "string" ? input.createdAt : now,
    updatedAt: now
  };
}

async function readMap(jobId: string): Promise<AccessibilityMap> {
  const existing = await readJson<AccessibilityMap>(jobStore.getAccessibilityMapPath(jobId));
  if (!existing || existing.version !== 1) return emptyMap(jobId);
  return {
    ...existing,
    jobId,
    document: existing.document ?? {},
    pages: existing.pages ?? {}
  };
}

export async function getAccessibilityMap(jobId: string): Promise<AccessibilityMap> {
  return readMap(jobId);
}

export async function getAccessibilityPage(jobId: string, pageIndex: number): Promise<AccessibilityPageMap> {
  const map = await readMap(jobId);
  return map.pages[String(pageIndex)] ?? emptyPage(pageIndex);
}

export async function saveAccessibilityPage(jobId: string, pageIndex: number, input: { tags?: Partial<AccessibilityTag>[]; reviewStatus?: unknown }): Promise<AccessibilityPageMap> {
  const map = await readMap(jobId);
  const now = new Date().toISOString();
  const tags = Array.isArray(input.tags)
    ? input.tags.map((tag, index) => normalizeTag(tag, pageIndex, index, now)).sort((a, b) => a.readingOrder - b.readingOrder)
    : [];
  const normalizedTags = tags.map((tag, index) => ({ ...tag, readingOrder: index + 1 }));
  const page: AccessibilityPageMap = {
    pageIndex,
    reviewStatus: normalizeReviewStatus(input.reviewStatus, normalizedTags),
    tags: normalizedTags,
    updatedAt: now
  };
  map.pages[String(pageIndex)] = page;
  map.updatedAt = now;
  await writeJson(jobStore.getAccessibilityMapPath(jobId), map);
  return page;
}
