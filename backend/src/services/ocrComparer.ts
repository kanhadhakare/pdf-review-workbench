import { type OcrComparisonIssue, type OcrComparisonResult, type OcrPageResult, type TextBlock } from "../types.js";

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function normalizeLooseText(input: string): string {
  return input
    .toLowerCase()
    .replace(/[\u2018\u2019\u201c\u201d]/g, "'")
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/[^\p{L}\p{N}\s'-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function intersectionOverUnion(a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }): number {
  const left = Math.max(a.x, b.x);
  const top = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.w, b.x + b.w);
  const bottom = Math.min(a.y + a.h, b.y + b.h);
  if (right <= left || bottom <= top) return 0;
  const intersection = (right - left) * (bottom - top);
  const union = (a.w * a.h) + (b.w * b.h) - intersection;
  return union <= 0 ? 0 : intersection / union;
}

function overlapScore(a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }): number {
  const iou = intersectionOverUnion(a, b);
  const centerAx = a.x + (a.w / 2);
  const centerAy = a.y + (a.h / 2);
  const centerBx = b.x + (b.w / 2);
  const centerBy = b.y + (b.h / 2);
  const distance = Math.hypot(centerAx - centerBx, centerAy - centerBy);
  const maxDimension = Math.max(a.w, a.h, b.w, b.h, 1);
  const distanceScore = clamp01(1 - (distance / (maxDimension * 2.5)));
  return Math.max(iou, distanceScore * 0.7);
}

function textSimilarity(a: string, b: string): number {
  const left = normalizeLooseText(a);
  const right = normalizeLooseText(b);
  if (!left && !right) return 1;
  if (!left || !right) return 0;
  if (left === right) return 1;
  if (left.includes(right) || right.includes(left)) return 0.82;
  const leftWords = new Set(left.split(" "));
  const rightWords = new Set(right.split(" "));
  const intersection = [...leftWords].filter((word) => rightWords.has(word)).length;
  const union = new Set([...leftWords, ...rightWords]).size;
  return union ? intersection / union : 0;
}

function isLikelyHeading(block: TextBlock): boolean {
  return block.tag === "h1" || block.tag === "h2" || block.tag === "h3" || block.fontSize >= 16;
}

export function compareOcrToBlocks(pageIndex: number, blocks: TextBlock[], ocrPage: OcrPageResult): OcrComparisonResult {
  if (ocrPage.status !== "ok") {
    return {
      pageIndex,
      score: 0,
      missingTextCount: 0,
      mismatchedBlockCount: 0,
      positionMismatchCount: 0,
      issues: []
    };
  }

  const issues: OcrComparisonIssue[] = [];
  let missingTextCount = 0;
  let mismatchedBlockCount = 0;
  let positionMismatchCount = 0;
  let matchedBlocks = 0;
  let totalTextScore = 0;
  let totalPositionScore = 0;

  const unmatchedOcrLines = new Set(ocrPage.lines.map((_, index) => index));

  for (const block of blocks) {
    let bestIndex = -1;
    let bestMatchScore = 0;
    let bestTextScore = 0;
    let bestPositionScore = 0;

    ocrPage.lines.forEach((line, index) => {
      const positionScore = overlapScore(block, line);
      const similarity = textSimilarity(block.text, line.text);
      const matchScore = (positionScore * 0.55) + (similarity * 0.45);
      if (matchScore > bestMatchScore) {
        bestMatchScore = matchScore;
        bestTextScore = similarity;
        bestPositionScore = positionScore;
        bestIndex = index;
      }
    });

    if (bestIndex >= 0) {
      unmatchedOcrLines.delete(bestIndex);
    }

    if (bestTextScore < 0.45) {
      mismatchedBlockCount += 1;
      issues.push({
        type: isLikelyHeading(block) ? "heading-mismatch" : "text-mismatch",
        severity: isLikelyHeading(block) ? "high" : "medium",
        message: `Extracted text does not match OCR near "${block.text.slice(0, 40)}"`,
        blockId: block.id,
        extractedText: block.text,
        ocrText: bestIndex >= 0 ? ocrPage.lines[bestIndex].text : undefined,
        region: { x: block.x, y: block.y, w: block.w, h: block.h }
      });
    }

    if (bestPositionScore < 0.35) {
      positionMismatchCount += 1;
      issues.push({
        type: "position-mismatch",
        severity: bestTextScore > 0.65 ? "high" : "medium",
        message: `Extracted block is displaced for "${block.text.slice(0, 40)}"`,
        blockId: block.id,
        extractedText: block.text,
        ocrText: bestIndex >= 0 ? ocrPage.lines[bestIndex].text : undefined,
        region: { x: block.x, y: block.y, w: block.w, h: block.h }
      });
    }

    if (bestTextScore >= 0.45 || bestPositionScore >= 0.35) {
      matchedBlocks += 1;
    }
    totalTextScore += bestTextScore;
    totalPositionScore += bestPositionScore;
  }

  for (const index of unmatchedOcrLines) {
    const line = ocrPage.lines[index];
    if (!line.text.trim()) continue;
    missingTextCount += 1;
    issues.push({
      type: line.y < (ocrPage.height * 0.25) ? "heading-mismatch" : "missing-text",
      severity: line.y < (ocrPage.height * 0.25) ? "high" : "medium",
      message: `OCR found text with no extracted match: "${line.text.slice(0, 40)}"`,
      ocrText: line.text,
      region: { x: line.x, y: line.y, w: line.w, h: line.h }
    });
  }

  const coverageRatio = clamp01(matchedBlocks / Math.max(blocks.length, ocrPage.lines.length, 1));
  const avgTextScore = blocks.length ? totalTextScore / blocks.length : 0;
  const avgPositionScore = blocks.length ? totalPositionScore / blocks.length : 0;
  const score = Number(clamp01((avgTextScore * 0.45) + (avgPositionScore * 0.35) + (coverageRatio * 0.20)).toFixed(4));

  return {
    pageIndex,
    score,
    missingTextCount,
    mismatchedBlockCount,
    positionMismatchCount,
    issues: issues.slice(0, 25)
  };
}
