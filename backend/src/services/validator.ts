import type { TextBlock } from "../types.js";

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function groupLines(blocks: TextBlock[]): TextBlock[][] {
  const sorted = [...blocks].sort((a, b) => {
    if (Math.abs(a.y - b.y) > 3) {
      return a.y - b.y;
    }

    return a.x - b.x;
  });

  const lines: TextBlock[][] = [];

  for (const block of sorted) {
    const line = lines.find((candidate) => Math.abs(candidate[0].y - block.y) <= 3);
    if (line) {
      line.push(block);
    } else {
      lines.push([block]);
    }
  }

  for (const line of lines) {
    line.sort((a, b) => a.x - b.x);
  }

  return lines;
}

function baselineScore(lines: TextBlock[][]): number {
  if (!lines.length) {
    return 0;
  }

  const scores = lines.map((line) => {
    if (line.length === 1) {
      return 0.9;
    }

    const baselines = line.map((block) => block.y + block.h);
    const mean = baselines.reduce((sum, value) => sum + value, 0) / baselines.length;
    const variance = baselines.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / baselines.length;
    const deviation = Math.sqrt(variance);
    return clamp(1 - deviation / 4);
  });

  return scores.reduce((sum, value) => sum + value, 0) / scores.length;
}

function neighborScore(lines: TextBlock[][]): number {
  const gaps: number[] = [];

  for (const line of lines) {
    for (let index = 1; index < line.length; index += 1) {
      const previous = line[index - 1];
      const current = line[index];
      gaps.push(current.x - (previous.x + previous.w));
    }
  }

  if (!gaps.length) {
    return 0.85;
  }

  const clean = gaps.map((gap) => {
    if (gap < -1) {
      return 0;
    }

    if (gap <= 12) {
      return 1;
    }

    return clamp(1 - ((gap - 12) / 30));
  });

  return clean.reduce((sum, value) => sum + value, 0) / clean.length;
}

function widthScore(blocks: TextBlock[]): number {
  if (!blocks.length) {
    return 0;
  }

  const scores = blocks.map((block) => {
    const normalizedText = block.text.replace(/\s+/g, " ").trim();
    if (!normalizedText) {
      return 1;
    }

    const expectedWidth = normalizedText.length * block.fontSize * 0.52;
    const delta = Math.abs(block.w - expectedWidth);
    const tolerance = Math.max(block.fontSize * 1.5, expectedWidth * 0.35, 6);
    return clamp(1 - delta / tolerance);
  });

  return scores.reduce((sum, value) => sum + value, 0) / scores.length;
}

export function scoreTextBlocks(blocks: TextBlock[]): number {
  if (!blocks.length) {
    return 0;
  }

  const lines = groupLines(blocks);
  const baseline = baselineScore(lines);
  const neighbor = neighborScore(lines);
  const width = widthScore(blocks);

  return Number(((baseline * 0.4) + (neighbor * 0.35) + (width * 0.25)).toFixed(3));
}


