import { type ExtractionProfile, type OcrComparisonResult, type OcrPageResult, type PageResult, type TextBlock, type OcrValidationSummary } from "../types.js";

function stddev(values: number[]): number {
  if (values.length <= 1) return 0;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / values.length;
  return Math.sqrt(variance);
}

function groupLines(blocks: TextBlock[], tolerance: number): TextBlock[][] {
  const sorted = [...blocks].sort((a, b) => (Math.abs(a.y - b.y) > tolerance ? a.y - b.y : a.x - b.x));
  const lines: TextBlock[][] = [];
  for (const block of sorted) {
    const line = lines.find((candidate) => Math.abs(candidate[0].y - block.y) <= tolerance);
    if (line) line.push(block); else lines.push([block]);
  }
  return lines.map((line) => line.sort((a, b) => a.x - b.x));
}

function clamp01(value: number): number { return Math.max(0, Math.min(1, value)); }

export function validatePage(blocks: TextBlock[], profile: ExtractionProfile, pageWidth: number, pageHeight: number): number {
  if (!blocks.length || pageWidth <= 0 || pageHeight <= 0) return 0;
  const lines = groupLines(blocks, Math.max(1, profile.yBandTolerance));

  const baselineAlignmentScore = (() => {
    const scores = lines.map((line) => clamp01(1 - (stddev(line.map((block) => block.y)) / 6)));
    return scores.reduce((sum, value) => sum + value, 0) / Math.max(1, scores.length);
  })();

  const neighborConsistencyScore = (() => {
    const scores = lines.filter((line) => line.length > 1).map((line) => {
      const gaps = line.slice(1).map((block, index) => block.x - (line[index].x + line[index].w));
      return clamp01(1 - (stddev(gaps) / Math.max(12, profile.xGapTolerance * 1.5)));
    });
    return scores.length ? scores.reduce((sum, value) => sum + value, 0) / scores.length : 1;
  })();

  const fontMetricScore = (() => {
    const scores = blocks.map((block) => {
      const estimated = Math.max(1, block.fontSize * block.text.length * 0.6);
      return clamp01(1 - (Math.abs(block.w - estimated) / estimated));
    });
    return scores.reduce((sum, value) => sum + value, 0) / scores.length;
  })();

  const coverageScore = (() => {
    const area = blocks.reduce((sum, block) => sum + (block.w * block.h), 0);
    return clamp01((area / Math.max(1, pageWidth * pageHeight)) / 0.28);
  })();

  const indentConsistencyScore = (() => {
    if (profile.firstLineIndentPx <= 0) return 0;
    const indented = blocks.filter((block) => block.isFirstLineIndented);
    if (!indented.length) return -0.03;
    const matches = indented.filter((block) => Math.abs(block.styles.textIndent - profile.firstLineIndentPx) < 3).length;
    return ((matches / indented.length) - 0.5) * 0.1;
  })();

  const score =
    (baselineAlignmentScore * 0.30) +
    (neighborConsistencyScore * 0.25) +
    (fontMetricScore * 0.25) +
    (coverageScore * 0.20) +
    indentConsistencyScore;

  return Number(clamp01(score).toFixed(4));
}

export function pageConfidencePoints(page: PageResult): { pageIndex: number; confidence: number } {
  return { pageIndex: page.pageIndex, confidence: page.confidence };
}

export function applyOcrValidation(baseScore: number, ocrPage: OcrPageResult, comparison: OcrComparisonResult): { confidence: number; summary: OcrValidationSummary } {
  if (ocrPage.status === "unavailable") {
    return {
      confidence: baseScore,
      summary: {
        status: "unavailable",
        score: null,
        issueCount: 0,
        message: ocrPage.message ?? `${ocrPage.engine} is unavailable`
      }
    };
  }

  if (ocrPage.status === "failed") {
    return {
      confidence: baseScore,
      summary: {
        status: "failed",
        score: null,
        issueCount: 0,
        message: ocrPage.message ?? `${ocrPage.engine} validation failed`
      }
    };
  }

  const blended = Number(clamp01((baseScore * 0.75) + (comparison.score * 0.25)).toFixed(4));
  const status = comparison.issues.some((issue) => issue.severity === "high") || comparison.score < 0.65
    ? "warning"
    : "ok";

  return {
    confidence: blended,
    summary: {
      status,
      score: comparison.score,
      issueCount: comparison.issues.length,
      message: comparison.issues[0]?.message
    }
  };
}

