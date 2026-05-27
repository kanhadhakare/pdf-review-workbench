import { mkdir, readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { jobStore } from "./jobStore.js";
import { createStoredZip } from "./zipWriter.js";

type WordBox = { x: number; y: number; w: number; h: number };

async function walkFiles(dirPath: string): Promise<string[]> {
  const entries = await readdir(dirPath, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const fullPath = path.join(dirPath, entry.name);
    return entry.isDirectory() ? walkFiles(fullPath) : [fullPath];
  }));
  return nested.flat();
}

function parseWordBoxes(pageNumber: number, cssText: string): WordBox[] {
  const boxes: WordBox[] = [];
  const ruleRegex = new RegExp(`\\.page${pageNumber}__word\\d+\\s*\\{([^}]*)\\}`, "g");
  for (const match of cssText.matchAll(ruleRegex)) {
    const body = String(match[1] ?? "");
    const getPx = (property: string): number => {
      const value = body.match(new RegExp(`${property}\\s*:\\s*([0-9.]+)px`, "i"))?.[1];
      return value ? Number(value) : 0;
    };
    const box = {
      x: getPx("left"),
      y: getPx("top"),
      w: getPx("width"),
      h: getPx("height")
    };
    if (box.w > 0 && box.h > 0) boxes.push(box);
  }
  return boxes;
}

function median(values: number[]): number {
  if (!values.length) return 255;
  const sorted = values.sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function sampleBackgroundColor(data: Uint8ClampedArray, width: number, height: number, box: WordBox): string {
  const left = Math.max(0, Math.floor(box.x) - 2);
  const top = Math.max(0, Math.floor(box.y) - 2);
  const right = Math.min(width - 1, Math.ceil(box.x + box.w) + 2);
  const bottom = Math.min(height - 1, Math.ceil(box.y + box.h) + 2);
  const reds: number[] = [];
  const greens: number[] = [];
  const blues: number[] = [];
  const pushPixel = (x: number, y: number): void => {
    const index = ((y * width) + x) * 4;
    reds.push(data[index]);
    greens.push(data[index + 1]);
    blues.push(data[index + 2]);
  };

  for (let x = left; x <= right; x += 2) {
    pushPixel(x, top);
    pushPixel(x, bottom);
  }
  for (let y = top; y <= bottom; y += 2) {
    pushPixel(left, y);
    pushPixel(right, y);
  }

  return `rgb(${median(reds)}, ${median(greens)}, ${median(blues)})`;
}

async function createTextMaskedPageImage(jobId: string, pageNumber: number, fallbackImagePath: string): Promise<Buffer> {
  const reviewCssPath = path.join(jobStore.getReviewStylesDir(jobId), `page-${pageNumber}.css`);
  const cssText = await readFile(reviewCssPath, "utf8").catch(() => "");
  const boxes = parseWordBoxes(pageNumber, cssText);
  if (!boxes.length) return readFile(fallbackImagePath);

  const sourceImage = await loadImage(fallbackImagePath);
  const width = sourceImage.width;
  const height = sourceImage.height;
  const canvas = createCanvas(width, height);
  const context = canvas.getContext("2d");
  context.drawImage(sourceImage, 0, 0);
  const imageData = context.getImageData(0, 0, width, height);

  for (const box of boxes) {
    const expandedX = Math.max(0, Math.floor(box.x) - 1);
    const expandedY = Math.max(0, Math.floor(box.y) - 1);
    const expandedW = Math.min(width - expandedX, Math.ceil(box.w) + 2);
    const expandedH = Math.min(height - expandedY, Math.ceil(box.h) + 2);
    context.fillStyle = sampleBackgroundColor(imageData.data, width, height, box);
    context.fillRect(expandedX, expandedY, expandedW, expandedH);
  }

  return canvas.toBuffer("image/png");
}

function archiveFileName(originalFileName: string): string {
  const baseName = originalFileName.replace(/\.[^.]+$/, "").replace(/[^A-Za-z0-9_-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  return `${baseName || "final-book"}-final.zip`;
}

export async function buildFinalArchive(jobId: string): Promise<{ fileName: string; buffer: Buffer }> {
  const job = await jobStore.getJob(jobId);
  if (!job) throw new Error("Job not found");

  const finalDir = jobStore.getFinalDir(jobId);
  const info = await stat(finalDir).catch(() => null);
  if (!info?.isDirectory()) throw new Error("Final build not found");

  await mkdir(finalDir, { recursive: true });
  const files = await walkFiles(finalDir);
  const archiveFiles = await Promise.all(files.map(async (filePath) => {
    const relativePath = path.relative(finalDir, filePath).replace(/\\/g, "/");
    const pageImageMatch = relativePath.match(/^images\/page-(\d+)\.png$/);
    const data = pageImageMatch
      ? await createTextMaskedPageImage(jobId, Number(pageImageMatch[1]), filePath)
      : await readFile(filePath);
    return { name: relativePath, data };
  }));

  return {
    fileName: archiveFileName(job.originalFileName),
    buffer: createStoredZip(archiveFiles)
  };
}
