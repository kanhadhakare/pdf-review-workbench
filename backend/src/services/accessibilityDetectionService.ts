import { randomUUID } from "node:crypto";
import {
  type AccessibilityPageMap,
  type AccessibilityTag,
  type AccessibilityTagName,
  type PageResult,
  type SemanticTag,
  type TextBlock
} from "../types.js";
import { accessibilityAutoDetectionEngine } from "../config/runtime.js";
import { getAccessibilityPage, saveAccessibilityPage } from "./accessibilityStore.js";
import { getDoclingLayout, type LayoutModelItem, type LayoutModelResult } from "./doclingLayoutService.js";
import { jobStore } from "./jobStore.js";

export interface AccessibilityPageDetectionResult {
  page: AccessibilityPageMap;
  engine: string;
  warnings: string[];
}

export interface AccessibilityBookDetectionResult {
  pageCount: number;
  taggedPages: number;
  engine: string;
  warnings: string[];
}

function mapSemanticTag(tag: SemanticTag): AccessibilityTagName {
  if (tag === "h1") return "H1";
  if (tag === "h2") return "H2";
  if (tag === "h3") return "H3";
  if (tag === "caption") return "Caption";
  if (tag === "table") return "Table";
  if (tag === "img") return "Figure";
  if (tag === "equation") return "Formula";
  if (tag === "artifact") return "Artifact";
  return "P";
}

function normalizeModelLabel(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function mapDoclingLabel(label: string, text: string): AccessibilityTagName {
  const normalized = normalizeModelLabel(label);
  if (normalized.includes("page_header") || normalized.includes("page_footer") || normalized.includes("footnote")) return "Artifact";
  if (normalized.includes("title")) return "H1";
  if (normalized.includes("section_header") || normalized.includes("heading") || normalized.includes("subtitle")) return "H2";
  if (normalized.includes("list_item")) return "LI";
  if (normalized === "list" || normalized.includes("ordered_list") || normalized.includes("unordered_list")) return "L";
  if (normalized.includes("table")) return "Table";
  if (normalized.includes("picture") || normalized.includes("figure") || normalized.includes("image")) return "Figure";
  if (normalized.includes("caption")) return "Caption";
  if (normalized.includes("formula") || normalized.includes("equation")) return "Formula";
  if (!text.trim()) return "Artifact";
  return "P";
}

function blockText(block: TextBlock): string {
  return (block.text ?? "").replace(/\s+/g, " ").trim();
}

function blockConfidence(block: TextBlock): number {
  const confidence = Number.isFinite(block.confidence) ? block.confidence : 0.75;
  const hasText = blockText(block).length > 0;
  const hasReasonableBox = block.w > 1 && block.h > 1;
  const penalty = hasText && hasReasonableBox ? 0 : 0.25;
  return Math.max(0.25, Math.min(0.95, confidence - penalty));
}

function inferTagFromBlock(block: TextBlock, page: PageResult): AccessibilityTagName {
  const mapped = mapSemanticTag(block.tag);
  if (mapped !== "P") return mapped;
  const fontSizes = page.blocks.map((candidate) => candidate.fontSize).filter((value) => Number.isFinite(value) && value > 0);
  const averageFontSize = fontSizes.length ? fontSizes.reduce((sum, value) => sum + value, 0) / fontSizes.length : block.fontSize;
  const text = blockText(block);
  if (block.fontSize >= averageFontSize * 1.65 && text.length < 160) return "H1";
  if (block.fontSize >= averageFontSize * 1.35 && text.length < 140) return "H2";
  if (block.fontWeight === "bold" && block.fontSize >= averageFontSize * 1.12 && text.length < 120) return "H3";
  return "P";
}

function suggestTags(page: PageResult): AccessibilityTag[] {
  const now = new Date().toISOString();
  const blocks = page.blocks
    .filter((block) => block.w > 1 && block.h > 1)
    .filter((block) => block.tag === "img" || block.tag === "table" || block.tag === "equation" || block.tag === "artifact" || blockText(block).length > 0)
    .sort((a, b) => (a.y - b.y) || (a.x - b.x));

  return blocks.map((block, index) => {
    const tag = inferTagFromBlock(block, page);
    const confidence = blockConfidence(block);
    return {
      id: randomUUID(),
      pageIndex: page.pageIndex,
      tag,
      bbox: {
        x: Number(block.x.toFixed(2)),
        y: Number(block.y.toFixed(2)),
        w: Number(block.w.toFixed(2)),
        h: Number(block.h.toFixed(2))
      },
      readingOrder: index + 1,
      confidence,
      source: "auto-detection",
      status: confidence >= 0.8 && tag !== "Figure" && tag !== "Formula" && tag !== "Table" ? "suggested" : "needs-review",
      actualText: tag === "Formula" ? blockText(block) || undefined : undefined,
      createdAt: now,
      updatedAt: now
    };
  });
}

function scaleModelBox(item: LayoutModelItem, page: PageResult) {
  const sourceWidth = item.pageSize?.width && item.pageSize.width > 0
    ? item.pageSize.width
    : page.pdfPageBounds?.widthPt && page.pdfPageBounds.widthPt > 0
      ? page.pdfPageBounds.widthPt
      : page.pageWidth;
  const sourceHeight = item.pageSize?.height && item.pageSize.height > 0
    ? item.pageSize.height
    : page.pdfPageBounds?.heightPt && page.pdfPageBounds.heightPt > 0
      ? page.pdfPageBounds.heightPt
      : page.pageHeight;
  const scaleX = page.pageWidth / sourceWidth;
  const scaleY = page.pageHeight / sourceHeight;
  const x = Math.max(0, item.bbox.x * scaleX);
  const y = Math.max(0, item.bbox.y * scaleY);
  const right = Math.min(page.pageWidth, (item.bbox.x + item.bbox.w) * scaleX);
  const bottom = Math.min(page.pageHeight, (item.bbox.y + item.bbox.h) * scaleY);
  return {
    x: Number(x.toFixed(2)),
    y: Number(y.toFixed(2)),
    w: Number(Math.max(1, right - x).toFixed(2)),
    h: Number(Math.max(1, bottom - y).toFixed(2))
  };
}

function confidenceFromModel(item: LayoutModelItem, tag: AccessibilityTagName): number {
  const raw = typeof item.confidence === "number" && Number.isFinite(item.confidence) ? item.confidence : null;
  const confidence = raw === null ? 0.86 : raw > 1 ? raw / 100 : raw;
  const tagPenalty = tag === "Table" || tag === "Figure" || tag === "Formula" ? 0.08 : 0;
  return Number(Math.max(0.35, Math.min(0.96, confidence - tagPenalty)).toFixed(3));
}

function tagsFromDoclingItems(page: PageResult, items: LayoutModelItem[]): AccessibilityTag[] {
  const now = new Date().toISOString();
  const pageItems = items
    .filter((item) => item.pageIndex === page.pageIndex)
    .filter((item) => item.bbox.w > 1 && item.bbox.h > 1)
    .sort((a, b) => (a.order - b.order) || (a.bbox.y - b.bbox.y) || (a.bbox.x - b.bbox.x));

  return pageItems.map((item, index) => {
    const text = (item.text ?? "").replace(/\s+/g, " ").trim();
    const tag = mapDoclingLabel(item.label, text);
    const confidence = confidenceFromModel(item, tag);
    return {
      id: randomUUID(),
      pageIndex: page.pageIndex,
      tag,
      bbox: scaleModelBox(item, page),
      readingOrder: index + 1,
      confidence,
      source: "auto-detection",
      status: confidence >= 0.82 && tag !== "Figure" && tag !== "Formula" && tag !== "Table" ? "suggested" : "needs-review",
      actualText: tag === "Formula" && text ? text : undefined,
      altText: tag === "Figure" && text ? text : undefined,
      createdAt: now,
      updatedAt: now
    } satisfies AccessibilityTag;
  }).filter((tag) => tag.tag !== "Artifact" || tag.bbox.w > 2 || tag.bbox.h > 2);
}

function useDoclingDetection(): boolean {
  return accessibilityAutoDetectionEngine !== "heuristic";
}

function allowHeuristicFallback(): boolean {
  return accessibilityAutoDetectionEngine !== "docling-only";
}

async function loadDocling(jobId: string): Promise<LayoutModelResult | null> {
  if (!useDoclingDetection()) return null;
  const job = await jobStore.getJob(jobId);
  if (!job) throw new Error("Job not found");
  return getDoclingLayout(job);
}

async function detectPageWithLayout(
  jobId: string,
  pageIndex: number,
  replace: boolean,
  layout: LayoutModelResult | null
): Promise<AccessibilityPageDetectionResult> {
  const existing = await getAccessibilityPage(jobId, pageIndex);
  if (!replace && existing.tags.length > 0) return { page: existing, engine: "existing", warnings: [] };
  const page = await jobStore.getPage(jobId, pageIndex);
  if (!page) throw new Error(`Page ${pageIndex + 1} not found`);
  const warnings: string[] = [];
  let engine = "review-block-heuristic";
  let tags: AccessibilityTag[] = [];

  if (layout) {
    if (layout.status === "ok") {
      tags = tagsFromDoclingItems(page, layout.items);
      engine = "docling";
      if (!tags.length) warnings.push(`Docling returned no layout tags for page ${pageIndex + 1}.`);
    } else {
      warnings.push(layout.message ?? `Docling ${layout.status}.`);
    }
  }

  if (!tags.length && allowHeuristicFallback()) {
    tags = suggestTags(page);
    engine = layout && layout.status !== "ok" ? "review-block-heuristic-fallback" : engine;
  }

  if (!tags.length && layout && layout.status !== "ok" && !allowHeuristicFallback()) {
    throw new Error(layout.message ?? "Docling detection failed and heuristic fallback is disabled.");
  }

  const savedPage = await saveAccessibilityPage(jobId, pageIndex, {
    tags,
    reviewStatus: tags.length ? "needs-review" : "untagged"
  });
  return { page: savedPage, engine, warnings };
}

export async function detectAccessibilityTagsForPage(jobId: string, pageIndex: number, replace = false): Promise<AccessibilityPageDetectionResult> {
  const layout = await loadDocling(jobId);
  return detectPageWithLayout(jobId, pageIndex, replace, layout);
}

export async function detectAccessibilityTagsForJob(jobId: string, replace = false): Promise<AccessibilityBookDetectionResult> {
  const job = await jobStore.getJob(jobId);
  if (!job) throw new Error("Job not found");
  let taggedPages = 0;
  const warnings: string[] = [];
  const engineCounts = new Map<string, number>();
  const layout = await loadDocling(jobId);
  if (layout && layout.status !== "ok") warnings.push(layout.message ?? `Docling ${layout.status}.`);
  for (let pageIndex = 0; pageIndex < job.pageCount; pageIndex += 1) {
    const result = await detectPageWithLayout(jobId, pageIndex, replace, layout);
    engineCounts.set(result.engine, (engineCounts.get(result.engine) ?? 0) + 1);
    warnings.push(...result.warnings);
    if (result.page.tags.length) taggedPages += 1;
  }
  const engine = [...engineCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? (layout?.status === "ok" ? "docling" : "review-block-heuristic");
  return { pageCount: job.pageCount, taggedPages, engine, warnings: [...new Set(warnings)] };
}
