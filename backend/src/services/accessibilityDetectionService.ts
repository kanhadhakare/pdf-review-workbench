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
  listCandidates: DebugCandidateSnapshot[];
  regionCandidates: DebugCandidateSnapshot[];
  mergeDecisions: DebugMergeDecision[];
  finalTags: Array<{
    readingOrder: number;
    tag: AccessibilityTagName;
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
    lastLineBbox: candidate.lastLineBlock ? snapshotBox(candidate.lastLineBlock) : undefined,
    lastLineText: candidate.lastLineText,
    lineCount: candidate.lineCount,
    maxLineWidth: candidate.maxLineWidth === undefined ? undefined : Number(candidate.maxLineWidth.toFixed(2))
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

function hasTerminalPunctuation(text: string): boolean {
  return /[.!?:;]$/u.test(text.trim());
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
  const trimmed = text.trim();
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
  return /^(IF|THEN|WHEN|WHERE|STEP\s*\d*|EXAMPLE|NOTE|TIP|OBJECTIVE|OBJECTIVES|MATERIALS|STANDARDS|HOMEWORK)\b[:：]?/iu.test(text.trim());
}

function isIsolatedMarker(candidate: DetectionCandidate): boolean {
  return candidate.text.trim().length <= 2 && candidate.block.w <= Math.max(8, candidate.block.h * 0.8);
}

function hasSemanticMergeBlocker(previous: DetectionCandidate, next: DetectionCandidate): boolean {
  if (previous.tag !== next.tag && (previous.tag !== "LI" || next.tag !== "P")) return true;
  if (previous.tag !== "P" && previous.tag !== "LI") return true;
  if (next.tag !== "P") return true;
  if (isIsolatedMarker(previous) || isIsolatedMarker(next)) return true;
  if (startsWithStrongInstructionLabel(next.text)) return true;
  if (startsWithStrongInstructionLabel(previous.text) && startsWithStrongInstructionLabel(next.text)) return true;
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
    maxLineWidth: Math.max(candidateMaxLineWidth(previous), candidateMaxLineWidth(next))
  };
}

function mergeHeuristicParagraphCandidates(candidates: DetectionCandidate[], debug?: AccessibilityDetectionDebug): DetectionCandidate[] {
  const lineCandidates = assignHeuristicRegions(classifyListLineCandidates(buildHeuristicLineCandidates(candidates, debug)))
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
    const { block, tag, confidence } = candidate;
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

function unionModelItems(first: LayoutModelItem, second: LayoutModelItem): LayoutModelItem {
  const x = Math.min(first.bbox.x, second.bbox.x);
  const y = Math.min(first.bbox.y, second.bbox.y);
  const right = Math.max(first.bbox.x + first.bbox.w, second.bbox.x + second.bbox.w);
  const bottom = Math.max(first.bbox.y + first.bbox.h, second.bbox.y + second.bbox.h);
  const confidenceValues = [first.confidence, second.confidence].filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  return {
    ...first,
    text: `${first.text ?? ""} ${second.text ?? ""}`.replace(/\s+/g, " ").trim(),
    bbox: {
      x,
      y,
      w: right - x,
      h: bottom - y
    },
    confidence: confidenceValues.length
      ? confidenceValues.reduce((sum, value) => sum + value, 0) / confidenceValues.length
      : first.confidence,
    order: Math.min(first.order, second.order)
  };
}

function doclingParagraphMergeBlockReason(previous: LayoutModelItem, next: LayoutModelItem): string | null {
  const previousText = (previous.text ?? "").trim();
  const nextText = (next.text ?? "").trim();
  if (!previousText || !nextText) return "missing-text";
  if (previous.pageIndex !== next.pageIndex) return "different-page";
  if (mapDoclingLabel(previous.label, previousText) !== "P" || mapDoclingLabel(next.label, nextText) !== "P") return "not-paragraph-pair";

  const previousBottom = previous.bbox.y + previous.bbox.h;
  const verticalGap = next.bbox.y - previousBottom;
  const averageLineHeight = Math.max(1, (previous.bbox.h + next.bbox.h) / 2);
  if (verticalGap < -averageLineHeight * 0.25 || verticalGap > averageLineHeight * 1.8) return "vertical-gap";

  const leftDelta = Math.abs(previous.bbox.x - next.bbox.x);
  const widthDelta = Math.abs(previous.bbox.w - next.bbox.w);
  const maxWidth = Math.max(previous.bbox.w, next.bbox.w, 1);
  const sameColumn = sameColumnBoxes(previous.bbox, next.bbox) && leftDelta <= Math.max(14, maxWidth * 0.12);
  const compatibleWidth = widthDelta <= Math.max(24, maxWidth * 0.35);
  if (!sameColumn) return "different-column";
  if (!compatibleWidth) return "width-delta";

  if (/[:;]$/u.test(previousText) && nextText.length < 24) return "label-like-short-next-line";
  return null;
}

function shouldMergeDoclingParagraphItems(previous: LayoutModelItem, next: LayoutModelItem): boolean {
  return doclingParagraphMergeBlockReason(previous, next) === null;
}

function mergeDoclingParagraphItems(items: LayoutModelItem[], page: PageResult, debug?: AccessibilityDetectionDebug): LayoutModelItem[] {
  if (debug) debug.doclingCandidates = items.map((item) => snapshotModelItem(item, page));
  const merged: LayoutModelItem[] = [];
  for (const item of items) {
    const previous = merged[merged.length - 1];
    const reason = previous ? doclingParagraphMergeBlockReason(previous, item) : "first-candidate";
    if (previous) {
      debug?.mergeDecisions.push({
        type: "docling-paragraph",
        previous: snapshotModelItem(previous, page),
        next: snapshotModelItem(item, page),
        merged: reason === null,
        reason: reason ?? "docling-paragraph-merge"
      });
    }
    if (previous && reason === null) {
      merged[merged.length - 1] = unionModelItems(previous, item);
    } else {
      merged.push(item);
    }
  }
  if (debug) debug.doclingMergedCandidates = merged.map((item) => snapshotModelItem(item, page));
  return merged;
}

function tagsFromDoclingItems(page: PageResult, items: LayoutModelItem[], debug?: AccessibilityDetectionDebug): AccessibilityTag[] {
  const now = new Date().toISOString();
  const pageItems = mergeDoclingParagraphItems(items
    .filter((item) => item.pageIndex === page.pageIndex)
    .filter((item) => item.bbox.w > 1 && item.bbox.h > 1)
    .sort((a, b) => (a.order - b.order) || (a.bbox.y - b.bbox.y) || (a.bbox.x - b.bbox.x)), page, debug);

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
