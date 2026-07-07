import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
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

interface DetectionCandidate {
  block: TextBlock;
  tag: AccessibilityTagName;
  text: string;
  confidence: number;
  listMarker?: ListMarkerInfo;
  regionId?: string;
  lastLineBlock?: LayoutBox;
  lastLineText?: string;
  lineCount?: number;
  maxLineWidth?: number;
  sourceLabel?: string;
  order?: number;
  splitConfidence?: number;
  splitReasons?: string[];
  splitBoundaryBefore?: boolean;
}

interface LineCandidate extends DetectionCandidate {
  sourceCandidates: DetectionCandidate[];
}

interface ListMarkerInfo {
  marker: string;
  markerLeft: number;
  textLeft: number;
}

interface LayoutBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface DebugCandidateSnapshot {
  tag: AccessibilityTagName;
  text: string;
  bbox: LayoutBox;
  confidence?: number;
  regionId?: string;
  listMarker?: ListMarkerInfo;
  sourceLabel?: string;
  order?: number;
  lastLineBbox?: LayoutBox;
  lastLineText?: string;
  lineCount?: number;
  maxLineWidth?: number;
  splitConfidence?: number;
  splitReasons?: string[];
  splitBoundaryBefore?: boolean;
}

interface DebugMergeDecision {
  type: "visual-line" | "list-continuation" | "paragraph" | "docling-paragraph";
  previous: DebugCandidateSnapshot;
  next: DebugCandidateSnapshot;
  merged: boolean;
  reason: string;
}

interface AccessibilityDetectionDebug {
  pageIndex: number;
  generatedAt: string;
  engine: string;
  warnings: string[];
  rawBlocks: DebugCandidateSnapshot[];
  doclingCandidates: DebugCandidateSnapshot[];
  doclingMergedCandidates: DebugCandidateSnapshot[];
  lineCandidates: DebugCandidateSnapshot[];
  tocCandidates: DebugCandidateSnapshot[];
  listCandidates: DebugCandidateSnapshot[];
  regionCandidates: DebugCandidateSnapshot[];
  mergeDecisions: DebugMergeDecision[];
  finalTags: Array<{
    readingOrder: number;
    tag: AccessibilityTagName;
    text?: string;
    bbox: LayoutBox;
    confidence: number;
  }>;
}

interface HeuristicColumnRegion {
  id: string;
  bounds: LayoutBox;
  lastBlock: LayoutBox;
}

interface HeuristicColumn {
  index: number;
  bounds: LayoutBox;
  regions: HeuristicColumnRegion[];
  breakAfterY: number | null;
}

function unionBlocks(first: TextBlock, second: TextBlock): TextBlock {
  const x = Math.min(first.x, second.x);
  const y = Math.min(first.y, second.y);
  const right = Math.max(first.x + first.w, second.x + second.w);
  const bottom = Math.max(first.y + first.h, second.y + second.h);
  return {
    ...first,
    x,
    y,
    w: right - x,
    h: bottom - y,
    text: `${blockText(first)} ${blockText(second)}`.replace(/\s+/g, " ").trim(),
    confidence: (blockConfidence(first) + blockConfidence(second)) / 2
  };
}

function snapshotBox(box: LayoutBox): LayoutBox {
  return {
    x: Number(box.x.toFixed(2)),
    y: Number(box.y.toFixed(2)),
    w: Number(box.w.toFixed(2)),
    h: Number(box.h.toFixed(2))
  };
}

function snapshotCandidate(candidate: DetectionCandidate): DebugCandidateSnapshot {
  return {
    tag: candidate.tag,
    text: candidate.text,
    bbox: snapshotBox(candidate.block),
    confidence: Number(candidate.confidence.toFixed(3)),
    regionId: candidate.regionId,
    listMarker: candidate.listMarker,
    sourceLabel: candidate.sourceLabel,
    order: candidate.order,
    lastLineBbox: candidate.lastLineBlock ? snapshotBox(candidate.lastLineBlock) : undefined,
    lastLineText: candidate.lastLineText,
    lineCount: candidate.lineCount,
    maxLineWidth: candidate.maxLineWidth === undefined ? undefined : Number(candidate.maxLineWidth.toFixed(2)),
    splitConfidence: candidate.splitConfidence === undefined ? undefined : Number(candidate.splitConfidence.toFixed(3)),
    splitReasons: candidate.splitReasons,
    splitBoundaryBefore: candidate.splitBoundaryBefore
  };
}

function snapshotRawBlock(block: TextBlock, page: PageResult): DebugCandidateSnapshot {
  return {
    tag: inferTagFromBlock(block, page),
    text: blockText(block),
    bbox: snapshotBox(block),
    confidence: Number(blockConfidence(block).toFixed(3))
  };
}

function copyLayoutBox(box: LayoutBox): LayoutBox {
  return {
    x: box.x,
    y: box.y,
    w: box.w,
    h: box.h
  };
}

function candidateLastLineBlock(candidate: DetectionCandidate): LayoutBox {
  return candidate.lastLineBlock ? copyLayoutBox(candidate.lastLineBlock) : copyLayoutBox(candidate.block);
}

function candidateLastLineText(candidate: DetectionCandidate): string {
  return candidate.lastLineText ?? candidate.text;
}

function candidateMaxLineWidth(candidate: DetectionCandidate): number {
  return candidate.maxLineWidth ?? candidate.block.w;
}

function candidateLineCount(candidate: DetectionCandidate): number {
  return candidate.lineCount ?? 1;
}

function isTinyDecorativeText(block: TextBlock): boolean {
  const text = blockText(block);
  return /^[■▪•·●○]$/u.test(text) && block.w <= 8 && block.h <= 10;
}

function listMarkerMatch(text: string): RegExpMatchArray | null {
  return text.trimStart().match(/^((?:[\u2022\u25E6\u25AA\u25CF\u25CB\u25A0\u00B7])|(?:[-\u2013\u2014])|(?:\(?\d{1,3}\)|\d{1,3}[.)])|(?:\(?[a-zA-Z]\)|[a-zA-Z][.)])|(?:\(?[ivxlcdmIVXLCDM]{1,8}\)|[ivxlcdmIVXLCDM]{1,8}[.)]))(?:\s+|$)/u);
}

function startsWithListMarker(text: string): boolean {
  const match = listMarkerMatch(text);
  return !!match && text.trim().length > match[1].length;
}

function boxRight(box: LayoutBox): number {
  return box.x + box.w;
}

function boxCenterX(box: LayoutBox): number {
  return box.x + box.w / 2;
}

function averageBoxHeight(first: LayoutBox, second: LayoutBox): number {
  return Math.max(1, (first.h + second.h) / 2);
}

function unionLayoutBoxes(first: LayoutBox, second: LayoutBox): LayoutBox {
  const x = Math.min(first.x, second.x);
  const y = Math.min(first.y, second.y);
  const right = Math.max(boxRight(first), boxRight(second));
  const bottom = Math.max(first.y + first.h, second.y + second.h);
  return {
    x,
    y,
    w: right - x,
    h: bottom - y
  };
}

function horizontalOverlapRatio(first: LayoutBox, second: LayoutBox): number {
  const overlap = Math.min(boxRight(first), boxRight(second)) - Math.max(first.x, second.x);
  if (overlap <= 0) return 0;
  return overlap / Math.max(1, Math.min(first.w, second.w));
}

function sameColumnBoxes(previous: LayoutBox, next: LayoutBox): boolean {
  const averageHeight = averageBoxHeight(previous, next);
  const overlapRatio = horizontalOverlapRatio(previous, next);
  if (overlapRatio >= 0.45) return true;

  const centerTolerance = Math.max(24, averageHeight * 2.5);
  return Math.abs(boxCenterX(previous) - boxCenterX(next)) <= centerTolerance;
}

function sameColumnCandidate(previous: DetectionCandidate, next: DetectionCandidate): boolean {
  return sameColumnBoxes(previous.block, next.block);
}

function sameRegionCandidate(previous: DetectionCandidate, next: DetectionCandidate): boolean {
  return !previous.regionId || !next.regionId || previous.regionId === next.regionId;
}

function toLineCandidate(candidate: DetectionCandidate): LineCandidate {
  return {
    ...candidate,
    lastLineBlock: copyLayoutBox(candidate.block),
    lastLineText: candidate.text,
    lineCount: 1,
    maxLineWidth: candidate.block.w,
    sourceCandidates: [candidate]
  };
}

function canMergeIntoVisualLine(previous: DetectionCandidate, next: DetectionCandidate): boolean {
  if (previous.tag !== "P" || next.tag !== "P") return false;
  if (!previous.text || !next.text) return false;
  const verticalCenterDelta = Math.abs((previous.block.y + previous.block.h / 2) - (next.block.y + next.block.h / 2));
  const averageHeight = averageBoxHeight(previous.block, next.block);
  if (verticalCenterDelta > averageHeight * 0.45) return false;
  const gap = next.block.x - boxRight(previous.block);
  const sameTextRunGap = Math.max(12, averageHeight * 1.2);
  if (gap > sameTextRunGap && !sameColumnCandidate(previous, next)) return false;
  return gap >= -averageHeight * 0.3 && gap <= Math.max(18, averageHeight * 2.2);
}

function mergeLineCandidate(previous: LineCandidate, next: DetectionCandidate): LineCandidate {
  const block = unionBlocks(previous.block, next.block);
  return {
    block,
    tag: previous.tag,
    text: blockText(block),
    confidence: (previous.confidence + next.confidence) / 2,
    lastLineBlock: copyLayoutBox(block),
    lastLineText: blockText(block),
    lineCount: 1,
    maxLineWidth: block.w,
    sourceCandidates: [...previous.sourceCandidates, next]
  };
}

function detectLineListMarker(line: LineCandidate): ListMarkerInfo | null {
  const match = listMarkerMatch(line.text);
  if (!match || !startsWithListMarker(line.text)) return null;
  const sortedSources = [...line.sourceCandidates].sort((a, b) => a.block.x - b.block.x);
  const markerSource = sortedSources.find((source) => listMarkerMatch(source.text)) ?? sortedSources[0];
  const textSource = sortedSources.find((source) => source !== markerSource && blockText(source.block).trim().length > 0);
  const averageHeight = Math.max(1, line.block.h);
  const embeddedMarkerTextOffset = averageHeight * Math.min(2.2, 0.55 + match[1].length * 0.35);
  return {
    marker: match[1],
    markerLeft: markerSource.block.x,
    textLeft: textSource ? textSource.block.x : markerSource.block.x + embeddedMarkerTextOffset
  };
}

function classifyListLineCandidates(lines: LineCandidate[]): LineCandidate[] {
  return lines.map((line) => {
    const listMarker = detectLineListMarker(line);
    return listMarker ? { ...line, tag: "LI", listMarker } : line;
  });
}

interface TocRowCandidate {
  marker: LineCandidate;
  title: LineCandidate;
  pageNumber?: LineCandidate;
}

function isTocSectionMarker(text: string): boolean {
  return /^\d+(?:\.\d+)*$/u.test(text.trim());
}

function isStandalonePageNumber(text: string): boolean {
  return /^\d{1,4}$/u.test(text.trim());
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function sameBaselineCandidate(first: DetectionCandidate, second: DetectionCandidate): boolean {
  const centerDelta = Math.abs((first.block.y + first.block.h / 2) - (second.block.y + second.block.h / 2));
  const averageHeight = averageBoxHeight(first.block, second.block);
  return centerDelta <= Math.max(3, averageHeight * 0.35);
}

function findTocRowCandidates(lines: LineCandidate[]): TocRowCandidate[] {
  const rows: TocRowCandidate[] = [];
  const sortedLines = [...lines].sort((a, b) => (a.block.y - b.block.y) || (a.block.x - b.block.x));
  for (const marker of sortedLines) {
    if (marker.tag !== "P" || !isTocSectionMarker(marker.text)) continue;
    const sameRowRight = sortedLines
      .filter((candidate) => candidate !== marker)
      .filter((candidate) => candidate.tag === "P")
      .filter((candidate) => sameBaselineCandidate(marker, candidate))
      .filter((candidate) => candidate.block.x > boxRight(marker.block))
      .sort((a, b) => a.block.x - b.block.x);
    const title = sameRowRight.find((candidate) => !isStandalonePageNumber(candidate.text) && candidate.text.trim().length >= 4);
    if (!title) continue;
    const gap = title.block.x - boxRight(marker.block);
    const averageHeight = averageBoxHeight(marker.block, title.block);
    if (gap < 0 || gap > Math.max(72, averageHeight * 5)) continue;
    const pageNumber = sameRowRight.find((candidate) => candidate !== title && isStandalonePageNumber(candidate.text) && candidate.block.x > boxRight(title.block));
    rows.push({ marker, title, pageNumber });
  }
  return rows;
}

function isTocLikeRegion(rows: TocRowCandidate[]): boolean {
  if (rows.length < 5) return false;
  const markerX = median(rows.map((row) => row.marker.block.x));
  const titleX = median(rows.map((row) => row.title.block.x));
  const alignedRows = rows.filter((row) => {
    const averageHeight = averageBoxHeight(row.marker.block, row.title.block);
    return Math.abs(row.marker.block.x - markerX) <= Math.max(8, averageHeight * 0.8)
      && Math.abs(row.title.block.x - titleX) <= Math.max(12, averageHeight * 1.2)
      && row.title.block.x > row.marker.block.x;
  });
  const hierarchicalRows = alignedRows.filter((row) => row.marker.text.includes(".")).length;
  const rowsWithPageNumber = alignedRows.filter((row) => !!row.pageNumber || /\s\d{1,4}$/u.test(row.title.text.trim())).length;
  return alignedRows.length >= 5 && (hierarchicalRows >= 4 || rowsWithPageNumber >= 4);
}

function mergeTocRow(row: TocRowCandidate): LineCandidate {
  const sources = [
    ...row.marker.sourceCandidates,
    ...row.title.sourceCandidates,
    ...(row.pageNumber?.sourceCandidates ?? [])
  ];
  const block = [row.title.block, row.pageNumber?.block].filter((candidate): candidate is TextBlock => !!candidate)
    .reduce((mergedBlock, candidate) => unionBlocks(mergedBlock, candidate), row.marker.block);
  return {
    block,
    tag: "LI",
    text: blockText(block),
    confidence: (row.marker.confidence + row.title.confidence + (row.pageNumber?.confidence ?? row.title.confidence)) / (row.pageNumber ? 3 : 2),
    listMarker: {
      marker: row.marker.text.trim(),
      markerLeft: row.marker.block.x,
      textLeft: row.title.block.x
    },
    lastLineBlock: copyLayoutBox(block),
    lastLineText: blockText(block),
    lineCount: 1,
    maxLineWidth: block.w,
    sourceCandidates: sources
  };
}

function mergeTocLikeRows(lines: LineCandidate[], debug?: AccessibilityDetectionDebug): LineCandidate[] {
  const rows = findTocRowCandidates(lines);
  if (!isTocLikeRegion(rows)) return lines;

  const consumed = new Set<LineCandidate>();
  const tocRows = rows.map((row) => {
    consumed.add(row.marker);
    consumed.add(row.title);
    if (row.pageNumber) consumed.add(row.pageNumber);
    return mergeTocRow(row);
  });
  const merged = [...lines.filter((line) => !consumed.has(line)), ...tocRows]
    .sort((a, b) => (a.block.y - b.block.y) || (a.block.x - b.block.x));
  if (debug) debug.tocCandidates = tocRows.map(snapshotCandidate);
  return merged;
}

function isRegionBodyCandidate(candidate: DetectionCandidate): boolean {
  return candidate.tag === "P" || candidate.tag === "LI";
}

function isRegionBoundaryCandidate(candidate: DetectionCandidate): boolean {
  return candidate.tag !== "P" && candidate.tag !== "LI";
}

function findColumnForCandidate(columns: HeuristicColumn[], candidate: DetectionCandidate): HeuristicColumn | null {
  let bestColumn: HeuristicColumn | null = null;
  let bestScore = 0;
  for (const column of columns) {
    const overlapScore = horizontalOverlapRatio(column.bounds, candidate.block);
    const centerDelta = Math.abs(boxCenterX(column.bounds) - boxCenterX(candidate.block));
    const centerTolerance = Math.max(28, averageBoxHeight(column.bounds, candidate.block) * 3);
    const score = overlapScore >= 0.2 || centerDelta <= centerTolerance ? overlapScore + Math.max(0, 1 - centerDelta / centerTolerance) : 0;
    if (score > bestScore) {
      bestScore = score;
      bestColumn = column;
    }
  }
  return bestColumn;
}

function createColumn(columns: HeuristicColumn[], block: LayoutBox): HeuristicColumn {
  const column = {
    index: columns.length,
    bounds: { ...block },
    regions: [],
    breakAfterY: null
  };
  columns.push(column);
  return column;
}

function shouldStartNewRegion(column: HeuristicColumn, candidate: DetectionCandidate): boolean {
  const previousRegion = column.regions[column.regions.length - 1];
  if (!previousRegion) return true;
  if (column.breakAfterY !== null && candidate.block.y >= column.breakAfterY) return true;
  const verticalGap = candidate.block.y - (previousRegion.lastBlock.y + previousRegion.lastBlock.h);
  const averageHeight = averageBoxHeight(previousRegion.lastBlock, candidate.block);
  return verticalGap > Math.max(32, averageHeight * 2.4);
}

function assignCandidateToRegion(column: HeuristicColumn, candidate: DetectionCandidate): DetectionCandidate {
  let region = column.regions[column.regions.length - 1];
  if (shouldStartNewRegion(column, candidate)) {
    region = {
      id: `c${column.index}-r${column.regions.length}`,
      bounds: { ...candidate.block },
      lastBlock: { ...candidate.block }
    };
    column.regions.push(region);
    column.breakAfterY = null;
  } else {
    region.bounds = unionLayoutBoxes(region.bounds, candidate.block);
    region.lastBlock = { ...candidate.block };
  }
  column.bounds = unionLayoutBoxes(column.bounds, candidate.block);
  return { ...candidate, regionId: region.id };
}

function applyRegionBoundary(columns: HeuristicColumn[], boundary: DetectionCandidate): void {
  const boundaryBottom = boundary.block.y + boundary.block.h;
  for (const column of columns) {
    const overlapsColumn = horizontalOverlapRatio(column.bounds, boundary.block) >= 0.2 || sameColumnBoxes(column.bounds, boundary.block);
    if (overlapsColumn) column.breakAfterY = Math.max(column.breakAfterY ?? 0, boundaryBottom);
  }
}

function assignHeuristicRegions(candidates: DetectionCandidate[]): DetectionCandidate[] {
  const columns: HeuristicColumn[] = [];
  const assigned: DetectionCandidate[] = [];
  for (const candidate of [...candidates].sort((a, b) => (a.block.y - b.block.y) || (a.block.x - b.block.x))) {
    if (isRegionBoundaryCandidate(candidate)) {
      applyRegionBoundary(columns, candidate);
      assigned.push(candidate);
      continue;
    }
    if (!isRegionBodyCandidate(candidate)) {
      assigned.push(candidate);
      continue;
    }
    const column = findColumnForCandidate(columns, candidate) ?? createColumn(columns, candidate.block);
    assigned.push(assignCandidateToRegion(column, candidate));
  }
  return assigned;
}

function listContinuationBlockReason(previous: DetectionCandidate, next: DetectionCandidate): string | null {
  if (previous.tag !== "LI" || next.tag !== "P") return "not-li-continuation";
  if (!previous.text || !next.text) return "missing-text";
  if (hasSemanticMergeBlocker(previous, next)) return "semantic-blocker";
  if (startsWithListMarker(next.text)) return "new-list-marker";
  if (!sameColumnCandidate(previous, next)) return "different-column";

  const verticalGap = next.block.y - (previous.block.y + previous.block.h);
  const averageHeight = averageBoxHeight(previous.block, next.block);
  if (verticalGap < -averageHeight * 0.25 || verticalGap > averageHeight * 1.35) return "vertical-gap";
  if (!sameRegionCandidate(previous, next) && verticalGap > averageHeight * 0.4) return "different-region";

  const textLeft = previous.listMarker?.textLeft ?? previous.block.x;
  const leftDelta = Math.abs(next.block.x - textLeft);
  if (leftDelta > Math.max(10, averageHeight * 0.8)) return "continuation-indent";
  return null;
}

function shouldMergeListContinuation(previous: DetectionCandidate, next: DetectionCandidate): boolean {
  return listContinuationBlockReason(previous, next) === null;
}

function terminalComparableText(text: string): string {
  return text
    .trim()
    .replace(/\s*\([^)]{0,80}\)\s*$/u, "")
    .replace(/[\s)"'\]\u2019\u201d]+$/u, "");
}

function hasTerminalPunctuation(text: string): boolean {
  return /[.!?:;]$/u.test(terminalComparableText(text));
}

function endsWithHyphenatedContinuation(text: string): boolean {
  return /[\p{L}\p{N}]-$/u.test(text.trim());
}

function endsWithKnownAbbreviation(text: string): boolean {
  const trimmed = text.trim();
  if (/(?:^|\s)(?:[A-Z]\.){1,4}$/u.test(trimmed)) return true;
  return /(?:^|\s)(?:dr|prof|mr|mrs|ms|jr|sr|st|fig|figs|eq|eqs|no|nos|vol|vs|etc|e\.g|i\.e)\.$/iu.test(trimmed);
}

function endsWithDecimalOrVersion(text: string): boolean {
  return /(?:^|\s)\d+(?:\.\d+)+\.?$/u.test(text.trim());
}

function hasRealSentenceTerminalPunctuation(text: string): boolean {
  const trimmed = terminalComparableText(text);
  if (!/[.!?]$/u.test(trimmed)) return false;
  if (endsWithKnownAbbreviation(trimmed)) return false;
  if (endsWithDecimalOrVersion(trimmed)) return false;
  return true;
}

function startsWithUppercaseOrDigit(text: string): boolean {
  return /^[\p{Lu}\d]/u.test(text.trim());
}

function startsWithLowercaseOrContinuation(text: string): boolean {
  return /^[\p{Ll},)\]\u2019\u201d]/u.test(text.trim());
}

function startsWithStrongInstructionLabel(text: string): boolean {
  return /^(IF|THEN|WHEN|WHERE|STEP\s*\d*|EXAMPLE|NOTE|TIP|VOCABULARY|OBJECTIVE|OBJECTIVES|MATERIALS|STANDARDS|HOMEWORK)\b[:：]?/iu.test(text.trim());
}

function startsWithInstructionBoundary(text: string): boolean {
  return /^(Ask|Choose|Complete|Display|Encourage|Explain|Have\s+students|Model|Read|Record|Show|So\b|Use(?:\s+Turn\s*&\s*Talk)?|What|Which|How|Why)\b/iu.test(text.trim());
}

function isIsolatedMarker(candidate: DetectionCandidate): boolean {
  return candidate.text.trim().length <= 2 && candidate.block.w <= Math.max(8, candidate.block.h * 0.8);
}

function hasSemanticMergeBlocker(previous: DetectionCandidate, next: DetectionCandidate): boolean {
  if (next.splitBoundaryBefore) return true;
  if (previous.tag !== next.tag && (previous.tag !== "LI" || next.tag !== "P")) return true;
  if (previous.tag !== "P" && previous.tag !== "LI") return true;
  if (next.tag !== "P") return true;
  if (isIsolatedMarker(previous) || isIsolatedMarker(next)) return true;
  if (startsWithStrongInstructionLabel(next.text)) return true;
  if (startsWithStrongInstructionLabel(previous.text) && startsWithStrongInstructionLabel(next.text)) return true;
  if (hasRealSentenceTerminalPunctuation(candidateLastLineText(previous)) && startsWithInstructionBoundary(next.text)) return true;
  return false;
}

function paragraphLeftAligned(previous: DetectionCandidate, next: DetectionCandidate, averageHeight: number): boolean {
  const leftDelta = Math.abs(previous.block.x - next.block.x);
  return leftDelta <= Math.max(6, averageHeight * 0.45);
}

function paragraphFirstLineIndentAllowed(previous: DetectionCandidate, next: DetectionCandidate, averageHeight: number): boolean {
  const indent = next.block.x - previous.block.x;
  return indent > Math.max(6, averageHeight * 0.45) && indent <= Math.max(24, averageHeight * 1.8);
}

function paragraphRightEdgeCompatible(previous: DetectionCandidate, next: DetectionCandidate, averageHeight: number): boolean {
  const previousLineBlock = candidateLastLineBlock(previous);
  const previousLineText = candidateLastLineText(previous);
  const rightDelta = Math.abs(boxRight(previousLineBlock) - boxRight(next.block));
  if (rightDelta <= Math.max(12, averageHeight * 0.9)) return true;

  const previousMuchShorter = boxRight(previousLineBlock) < boxRight(next.block) - Math.max(18, averageHeight * 1.25);
  if (previousMuchShorter && hasRealSentenceTerminalPunctuation(previousLineText) && startsWithUppercaseOrDigit(next.text)) return false;
  return true;
}

function isShortFinalLineContinuation(previous: DetectionCandidate, next: DetectionCandidate, averageHeight: number): boolean {
  const previousLineText = candidateLastLineText(previous);
  if (next.block.w >= candidateMaxLineWidth(previous)) return false;
  if (!paragraphLeftAligned(previous, next, averageHeight)) return false;
  if (hasTerminalPunctuation(previousLineText)) return false;
  if (startsWithListMarker(next.text) || startsWithStrongInstructionLabel(next.text)) return false;
  return startsWithLowercaseOrContinuation(next.text);
}

function isMateriallyShortLastLine(previous: DetectionCandidate, averageHeight: number): boolean {
  const lastLineWidth = candidateLastLineBlock(previous).w;
  const maxLineWidth = candidateMaxLineWidth(previous);
  return lastLineWidth < maxLineWidth * 0.82 && maxLineWidth - lastLineWidth > Math.max(28, averageHeight * 2.2);
}

function isIndentedNewParagraphStart(previous: DetectionCandidate, next: DetectionCandidate, averageHeight: number): boolean {
  const indent = next.block.x - previous.block.x;
  return indent > Math.max(8, averageHeight * 0.55) && indent <= Math.max(32, averageHeight * 2.2);
}

function isLikelyNewParagraphAfterTerminalLine(previous: DetectionCandidate, next: DetectionCandidate, averageHeight: number, verticalGap: number): boolean {
  const previousLineText = candidateLastLineText(previous);
  if (!hasRealSentenceTerminalPunctuation(previousLineText)) return false;
  if (!startsWithUppercaseOrDigit(next.text)) return false;
  if (endsWithHyphenatedContinuation(previousLineText)) return false;
  if (startsWithListMarker(next.text) || startsWithStrongInstructionLabel(next.text)) return true;
  if (isIndentedNewParagraphStart(previous, next, averageHeight)) return true;
  if (isMateriallyShortLastLine(previous, averageHeight)) return true;
  return verticalGap > averageHeight * 0.75;
}

function mergeHeuristicListCandidates(candidates: DetectionCandidate[], debug?: AccessibilityDetectionDebug): DetectionCandidate[] {
  const merged: DetectionCandidate[] = [];
  for (const candidate of [...candidates].sort((a, b) => (a.block.y - b.block.y) || (a.block.x - b.block.x))) {
    let targetIndex = -1;
    let targetReason = "";
    if (candidate.tag === "P") {
      for (let index = merged.length - 1; index >= 0; index -= 1) {
        const reason = listContinuationBlockReason(merged[index], candidate);
        if (merged[index].tag === "LI") recordMergeDecision(debug, "list-continuation", merged[index], candidate, reason === null, reason ?? "list-continuation");
        if (reason === null) {
          targetIndex = index;
          targetReason = "list-continuation";
          break;
        }
      }
    }
    if (targetIndex >= 0) {
      merged[targetIndex] = mergeCandidatePair(merged[targetIndex], candidate);
      if (targetReason) merged[targetIndex].regionId = merged[targetIndex].regionId ?? candidate.regionId;
    } else {
      merged.push(candidate);
    }
  }
  if (debug) debug.listCandidates = merged.map(snapshotCandidate);
  return merged;
}

function paragraphMergeBlockReason(previous: DetectionCandidate, next: DetectionCandidate): string | null {
  if (previous.tag !== "P" || next.tag !== "P") return "not-paragraph-pair";
  if (!previous.text || !next.text) return "missing-text";
  if (hasSemanticMergeBlocker(previous, next)) return "semantic-blocker";
  if (!sameColumnCandidate(previous, next)) return "different-column";
  if (!sameRegionCandidate(previous, next)) return "different-region";
  const previousLineBlock = candidateLastLineBlock(previous);
  const previousLineText = candidateLastLineText(previous);
  const verticalGap = next.block.y - (previousLineBlock.y + previousLineBlock.h);
  const averageHeight = averageBoxHeight(previousLineBlock, next.block);
  if (verticalGap < -averageHeight * 0.25 || verticalGap > averageHeight * 1.2) return "vertical-gap";
  if (endsWithHyphenatedContinuation(previousLineText)) return null;
  if (isLikelyNewParagraphAfterTerminalLine(previous, next, averageHeight, verticalGap)) return "terminal-line-paragraph-boundary";
  if (!paragraphLeftAligned(previous, next, averageHeight) && !paragraphFirstLineIndentAllowed(previous, next, averageHeight)) return "paragraph-left-alignment";
  if (!paragraphRightEdgeCompatible(previous, next, averageHeight)) return "paragraph-right-edge";
  const maxWidth = Math.max(candidateMaxLineWidth(previous), next.block.w, 1);
  const widthDelta = Math.abs(candidateMaxLineWidth(previous) - next.block.w);
  if (widthDelta > Math.max(36, maxWidth * 0.55) && !isShortFinalLineContinuation(previous, next, averageHeight)) return "paragraph-width-delta";
  return null;
}

function shouldMergeNextLineParagraphCandidate(previous: DetectionCandidate, next: DetectionCandidate): boolean {
  return paragraphMergeBlockReason(previous, next) === null;
}

function recordMergeDecision(
  debug: AccessibilityDetectionDebug | undefined,
  type: DebugMergeDecision["type"],
  previous: DetectionCandidate,
  next: DetectionCandidate,
  merged: boolean,
  reason: string
): void {
  debug?.mergeDecisions.push({
    type,
    previous: snapshotCandidate(previous),
    next: snapshotCandidate(next),
    merged,
    reason
  });
}

function buildHeuristicLineCandidates(candidates: DetectionCandidate[], debug?: AccessibilityDetectionDebug): LineCandidate[] {
  const lines: LineCandidate[] = [];
  for (const candidate of [...candidates].sort((a, b) => (a.block.y - b.block.y) || (a.block.x - b.block.x))) {
    const previous = lines[lines.length - 1];
    const shouldMerge = !!previous && canMergeIntoVisualLine(previous, candidate);
    if (previous) recordMergeDecision(debug, "visual-line", previous, candidate, shouldMerge, shouldMerge ? "visual-line-merge" : "not-same-visual-line");
    if (previous && shouldMerge) {
      lines[lines.length - 1] = mergeLineCandidate(previous, candidate);
    } else {
      lines.push(toLineCandidate(candidate));
    }
  }
  if (debug) debug.lineCandidates = lines.map(snapshotCandidate);
  return lines;
}

function mergeCandidatePair(previous: DetectionCandidate, next: DetectionCandidate): DetectionCandidate {
  const block = unionBlocks(previous.block, next.block);
  const orderValues = [previous.order, next.order].filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  return {
    block,
    tag: previous.tag,
    text: blockText(block),
    confidence: (previous.confidence + next.confidence) / 2,
    listMarker: previous.listMarker,
    regionId: previous.regionId,
    lastLineBlock: candidateLastLineBlock(next),
    lastLineText: candidateLastLineText(next),
    lineCount: candidateLineCount(previous) + candidateLineCount(next),
    maxLineWidth: Math.max(candidateMaxLineWidth(previous), candidateMaxLineWidth(next)),
    sourceLabel: previous.sourceLabel ?? next.sourceLabel,
    order: orderValues.length ? Math.min(...orderValues) : undefined
  };
}

function mergeHeuristicParagraphCandidates(candidates: DetectionCandidate[], debug?: AccessibilityDetectionDebug): DetectionCandidate[] {
  const rawLineCandidates = buildHeuristicLineCandidates(candidates, debug);
  const lineCandidates = assignHeuristicRegions(classifyListLineCandidates(mergeTocLikeRows(rawLineCandidates, debug)))
    .filter((candidate) => candidate.tag === "LI" || !isTinyDecorativeText(candidate.block));
  if (debug) debug.regionCandidates = lineCandidates.map(snapshotCandidate);
  const listCandidates = mergeHeuristicListCandidates(lineCandidates, debug);

  const verticalMerged: DetectionCandidate[] = [];
  for (const candidate of [...listCandidates].sort((a, b) => (a.block.x - b.block.x) || (a.block.y - b.block.y))) {
    const previous = verticalMerged[verticalMerged.length - 1];
    const paragraphReason = previous ? paragraphMergeBlockReason(previous, candidate) : "first-candidate";
    if (previous) recordMergeDecision(debug, "paragraph", previous, candidate, paragraphReason === null, paragraphReason ?? "paragraph-merge");
    if (previous && paragraphReason === null) {
      verticalMerged[verticalMerged.length - 1] = mergeCandidatePair(previous, candidate);
    } else {
      verticalMerged.push(candidate);
    }
  }

  return verticalMerged.sort((a, b) => (a.block.y - b.block.y) || (a.block.x - b.block.x));
}

function createDetectionDebug(page: PageResult, engine: string, warnings: string[] = []): AccessibilityDetectionDebug {
  return {
    pageIndex: page.pageIndex,
    generatedAt: new Date().toISOString(),
    engine,
    warnings,
    rawBlocks: page.blocks
      .filter((block) => block.w > 1 && block.h > 1)
      .map((block) => snapshotRawBlock(block, page)),
    doclingCandidates: [],
    doclingMergedCandidates: [],
    lineCandidates: [],
    tocCandidates: [],
    listCandidates: [],
    regionCandidates: [],
    mergeDecisions: [],
    finalTags: []
  };
}

async function writeDetectionDebug(jobId: string, pageIndex: number, debug: AccessibilityDetectionDebug): Promise<void> {
  const debugDir = path.join(jobStore.getAccessibilityDir(jobId), "debug");
  await mkdir(debugDir, { recursive: true });
  await writeFile(path.join(debugDir, `page-${pageIndex + 1}.json`), JSON.stringify(debug, null, 2), "utf8");
}

function summarizeFinalTags(tags: AccessibilityTag[]): AccessibilityDetectionDebug["finalTags"] {
  return tags.map((tag) => ({
    readingOrder: tag.readingOrder,
    tag: tag.tag,
    text: tag.actualText || tag.altText || undefined,
    bbox: tag.bbox,
    confidence: Number(tag.confidence.toFixed(3))
  }));
}

function suggestTags(page: PageResult, debug?: AccessibilityDetectionDebug): AccessibilityTag[] {
  const now = new Date().toISOString();
  const candidates = page.blocks
    .filter((block) => block.w > 1 && block.h > 1)
    .filter((block) => block.tag === "img" || block.tag === "table" || block.tag === "equation" || block.tag === "artifact" || blockText(block).length > 0)
    .map((block) => {
      const tag = inferTagFromBlock(block, page);
      return {
        block,
        tag,
        text: blockText(block),
        confidence: blockConfidence(block)
      } satisfies DetectionCandidate;
    });

  return mergeHeuristicParagraphCandidates(candidates, debug).map((candidate, index) => {
    const { block, tag, confidence, text } = candidate;
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
      actualText: tag !== "Figure" && tag !== "Artifact" && text ? text : undefined,
      altText: tag === "Figure" && text ? text : undefined,
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

function snapshotModelItem(item: LayoutModelItem, page: PageResult): DebugCandidateSnapshot {
  const text = (item.text ?? "").replace(/\s+/g, " ").trim();
  const tag = mapDoclingLabel(item.label, text);
  return {
    tag,
    text,
    bbox: scaleModelBox(item, page),
    confidence: confidenceFromModel(item, tag),
    sourceLabel: item.label,
    order: item.order
  };
}

function confidenceFromModel(item: LayoutModelItem, tag: AccessibilityTagName): number {
  const raw = typeof item.confidence === "number" && Number.isFinite(item.confidence) ? item.confidence : null;
  const confidence = raw === null ? 0.86 : raw > 1 ? raw / 100 : raw;
  const tagPenalty = tag === "Table" || tag === "Figure" || tag === "Formula" ? 0.08 : 0;
  return Number(Math.max(0.35, Math.min(0.96, confidence - tagPenalty)).toFixed(3));
}

function estimatePageTextLineHeight(page: PageResult): number {
  const heights = page.blocks
    .filter((block) => blockText(block).length > 0)
    .map((block) => block.h)
    .filter((height) => Number.isFinite(height) && height >= 5 && height <= 80);
  return heights.length ? Math.max(8, median(heights)) : 12;
}

function splitTextIntoSentenceUnits(text: string): string[] {
  const normalizedText = text.replace(/\s+/g, " ").trim();
  if (!normalizedText) return [];
  const units: string[] = [];
  let start = 0;

  for (let index = 0; index < normalizedText.length; index += 1) {
    const char = normalizedText[index];
    if (char !== "." && char !== "?" && char !== "!") continue;
    if (char === "." && /\d/u.test(normalizedText[index - 1] ?? "") && /\d/u.test(normalizedText[index + 1] ?? "")) continue;

    const candidateText = normalizedText.slice(start, index + 1);
    if (!hasRealSentenceTerminalPunctuation(candidateText)) continue;

    let end = index + 1;
    const parentheticalMatch = normalizedText.slice(end).match(/^\s*\([^)]{1,80}\)/u);
    if (parentheticalMatch) end += parentheticalMatch[0].length;

    const nextText = normalizedText.slice(end).trimStart();
    if (!nextText) continue;
    if (!startsWithUppercaseOrDigit(nextText) && !startsWithInstructionBoundary(nextText)) continue;

    const unitText = normalizedText.slice(start, end).trim();
    if (unitText) units.push(unitText);
    start = end;
  }

  const finalText = normalizedText.slice(start).trim();
  if (finalText) units.push(finalText);
  return units.length ? units : [normalizedText];
}

function countInstructionUnits(units: string[]): number {
  return units.filter((unit) => startsWithInstructionBoundary(unit) || startsWithStrongInstructionLabel(unit)).length;
}

function countQuestionAnswerPatterns(text: string): number {
  return text.match(/\?\s*\([^)]{1,80}\)/gu)?.length ?? 0;
}

function hasEmbeddedSemanticLabel(text: string): boolean {
  return /\b(?:VOCABULARY|NOTE|EXAMPLE|TIP|IF|THEN|OBJECTIVE|OBJECTIVES|MATERIALS|STANDARDS|HOMEWORK)\b/iu.test(text);
}

function hasAbbreviationOrReferenceAmbiguity(text: string): boolean {
  return /\b(?:Dr|Prof|Mr|Mrs|Ms|Fig|Figs|Eq|Eqs|No|Nos|Vol|etc|e\.g|i\.e)\./iu.test(text) || /\b\d+(?:\.\d+){1,}\b/u.test(text);
}

function assessDoclingSplit(candidate: DetectionCandidate, page: PageResult): { confidence: number; reasons: string[]; units: string[] } {
  const units = splitTextIntoSentenceUnits(candidate.text);
  if (candidate.tag !== "P" || units.length < 2) return { confidence: 0, reasons: [], units };

  const reasons: string[] = [];
  let confidence = 0;
  const lineHeight = estimatePageTextLineHeight(page);
  const estimatedLines = candidate.block.h / Math.max(1, lineHeight);
  const instructionUnits = countInstructionUnits(units);
  const followingInstructionUnits = countInstructionUnits(units.slice(1));
  const questionAnswerPatterns = countQuestionAnswerPatterns(candidate.text);
  const embeddedSemanticLabel = hasEmbeddedSemanticLabel(candidate.text);

  confidence += 0.3;
  reasons.push("multiple-real-sentence-boundaries");

  if (estimatedLines >= 2.25 || (units.length >= 3 && estimatedLines >= 1.6)) {
    confidence += 0.25;
    reasons.push(`tall-docling-block:${estimatedLines.toFixed(2)}-lines`);
  }
  if (followingInstructionUnits >= 1 || instructionUnits >= 2) {
    confidence += 0.25;
    reasons.push("repeated-instruction-starts");
  }
  if (questionAnswerPatterns >= 1) {
    confidence += questionAnswerPatterns >= 2 ? 0.2 : 0.12;
    reasons.push(`question-answer-patterns:${questionAnswerPatterns}`);
  }
  if (embeddedSemanticLabel) {
    confidence += 0.35;
    reasons.push("embedded-semantic-label");
  }
  if (instructionUnits === 0 && questionAnswerPatterns === 0 && !embeddedSemanticLabel) {
    confidence -= 0.3;
    reasons.push("normal-prose-penalty");
  }
  if (hasAbbreviationOrReferenceAmbiguity(candidate.text)) {
    confidence -= 0.15;
    reasons.push("abbreviation-reference-ambiguity");
  }

  return {
    confidence: Number(Math.max(0, Math.min(1, confidence)).toFixed(3)),
    reasons,
    units
  };
}

function semanticTagFromAccessibilityTag(tag: AccessibilityTagName): SemanticTag {
  if (tag === "H1") return "h1";
  if (tag === "H2") return "h2";
  if (tag === "H3" || tag === "H4" || tag === "H5" || tag === "H6") return "h3";
  if (tag === "Caption") return "caption";
  if (tag === "Table") return "table";
  if (tag === "Figure") return "img";
  if (tag === "Formula") return "equation";
  if (tag === "Artifact") return "artifact";
  return "p";
}

function doclingItemToCandidate(item: LayoutModelItem, page: PageResult): DetectionCandidate {
  const text = (item.text ?? "").replace(/\s+/g, " ").trim();
  const tag = mapDoclingLabel(item.label, text);
  const bbox = scaleModelBox(item, page);
  const confidence = confidenceFromModel(item, tag);
  const block: TextBlock = {
    id: `docling-${page.pageIndex + 1}-${item.order}`,
    x: bbox.x,
    y: bbox.y,
    w: bbox.w,
    h: bbox.h,
    text,
    fontSize: Math.max(1, Number((bbox.h * 0.75).toFixed(3))),
    fontName: "Docling",
    fontWeight: tag === "H1" || tag === "H2" || tag === "H3" ? "bold" : "normal",
    fontColor: "#000000",
    confidence,
    tag: semanticTagFromAccessibilityTag(tag),
    pageIndex: page.pageIndex,
    styles: {
      textIndent: 0,
      paddingLeft: 0,
      lineHeight: bbox.h,
      textAlign: "left"
    },
    isFirstLineIndented: false,
    rawSpans: []
  };
  return {
    block,
    tag,
    text,
    confidence,
    lastLineBlock: copyLayoutBox(bbox),
    lastLineText: text,
    lineCount: 1,
    maxLineWidth: bbox.w,
    sourceLabel: item.label,
    order: item.order
  };
}

function splitSuspiciousDoclingCandidate(candidate: DetectionCandidate, page: PageResult): DetectionCandidate[] {
  const assessment = assessDoclingSplit(candidate, page);
  if (assessment.confidence < 0.7 || assessment.units.length < 2) return [candidate];

  const unitHeight = candidate.block.h / assessment.units.length;
  return assessment.units.map((unitText, index) => {
    const block: TextBlock = {
      ...candidate.block,
      id: `${candidate.block.id}-split-${index + 1}`,
      y: Number((candidate.block.y + unitHeight * index).toFixed(2)),
      h: Number(Math.max(1, unitHeight).toFixed(2)),
      text: unitText
    };
    return {
      ...candidate,
      block,
      text: unitText,
      lastLineBlock: copyLayoutBox(block),
      lastLineText: unitText,
      lineCount: 1,
      maxLineWidth: block.w,
      order: candidate.order === undefined ? undefined : candidate.order + index / 1000,
      splitConfidence: assessment.confidence,
      splitReasons: assessment.reasons,
      splitBoundaryBefore: index > 0
    };
  });
}

function classifyDoclingListCandidates(candidates: DetectionCandidate[]): DetectionCandidate[] {
  return candidates.map((candidate) => {
    if (candidate.tag !== "P" && candidate.tag !== "LI") return candidate;
    const match = listMarkerMatch(candidate.text);
    if (!match && candidate.tag !== "LI") return candidate;
    const averageHeight = Math.max(1, candidate.block.h);
    const embeddedMarkerTextOffset = match ? averageHeight * Math.min(2.2, 0.55 + match[1].length * 0.35) : averageHeight * 0.9;
    return {
      ...candidate,
      tag: "LI",
      listMarker: {
        marker: match?.[1] ?? "",
        markerLeft: candidate.block.x,
        textLeft: candidate.block.x + embeddedMarkerTextOffset
      }
    };
  });
}

function mergeDoclingParagraphCandidates(items: LayoutModelItem[], page: PageResult, debug?: AccessibilityDetectionDebug): DetectionCandidate[] {
  const rawCandidates = items.flatMap((item) => splitSuspiciousDoclingCandidate(doclingItemToCandidate(item, page), page));
  if (debug) debug.doclingCandidates = rawCandidates.map(snapshotCandidate);

  const regionCandidates = assignHeuristicRegions(classifyDoclingListCandidates(rawCandidates))
    .filter((candidate) => candidate.tag === "LI" || !isTinyDecorativeText(candidate.block));
  if (debug) debug.regionCandidates = regionCandidates.map(snapshotCandidate);

  const listCandidates = mergeHeuristicListCandidates(regionCandidates, debug);
  const verticalMerged: DetectionCandidate[] = [];
  for (const candidate of [...listCandidates].sort((a, b) => (a.block.x - b.block.x) || (a.block.y - b.block.y))) {
    const previous = verticalMerged[verticalMerged.length - 1];
    const paragraphReason = previous ? paragraphMergeBlockReason(previous, candidate) : "first-candidate";
    if (previous) recordMergeDecision(debug, "docling-paragraph", previous, candidate, paragraphReason === null, paragraphReason ?? "docling-paragraph-merge");
    if (previous && paragraphReason === null) {
      verticalMerged[verticalMerged.length - 1] = mergeCandidatePair(previous, candidate);
    } else {
      verticalMerged.push(candidate);
    }
  }

  const merged = verticalMerged.sort((a, b) => (a.block.y - b.block.y) || (a.block.x - b.block.x));
  if (debug) debug.doclingMergedCandidates = merged.map(snapshotCandidate);
  return merged;
}

function tagsFromDoclingItems(page: PageResult, items: LayoutModelItem[], debug?: AccessibilityDetectionDebug): AccessibilityTag[] {
  const now = new Date().toISOString();
  const pageItems = mergeDoclingParagraphCandidates(items
    .filter((item) => item.pageIndex === page.pageIndex)
    .filter((item) => item.bbox.w > 1 && item.bbox.h > 1)
    .sort((a, b) => (a.order - b.order) || (a.bbox.y - b.bbox.y) || (a.bbox.x - b.bbox.x)), page, debug);

  return pageItems.map((candidate, index) => {
    const { block, tag, confidence, text } = candidate;
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
      status: confidence >= 0.82 && tag !== "Figure" && tag !== "Formula" && tag !== "Table" ? "suggested" : "needs-review",
      actualText: tag !== "Figure" && tag !== "Artifact" && text ? text : undefined,
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
  let debug = createDetectionDebug(page, engine, warnings);

  if (layout) {
    if (layout.status === "ok") {
      engine = "docling";
      debug = createDetectionDebug(page, engine, warnings);
      tags = tagsFromDoclingItems(page, layout.items, debug);
      if (!tags.length) warnings.push(`Docling returned no layout tags for page ${pageIndex + 1}.`);
    } else {
      warnings.push(layout.message ?? `Docling ${layout.status}.`);
    }
  }

  if (!tags.length && allowHeuristicFallback()) {
    engine = layout && layout.status !== "ok" ? "review-block-heuristic-fallback" : engine;
    debug = createDetectionDebug(page, engine, warnings);
    tags = suggestTags(page, debug);
  }

  if (!tags.length && layout && layout.status !== "ok" && !allowHeuristicFallback()) {
    throw new Error(layout.message ?? "Docling detection failed and heuristic fallback is disabled.");
  }

  const savedPage = await saveAccessibilityPage(jobId, pageIndex, {
    tags,
    reviewStatus: tags.length ? "needs-review" : "untagged"
  });
  debug.engine = engine;
  debug.warnings = warnings;
  debug.finalTags = summarizeFinalTags(savedPage.tags);
  await writeDetectionDebug(jobId, pageIndex, debug);
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
