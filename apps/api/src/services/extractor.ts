import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { ExtractionStatus, type ClassifierResult, type ExtractionProfile, type PageResult, type RawSpan, type SemanticTag, type TextBlock } from "@pdf-review-workbench/shared";
import pLimit from "p-limit";
import { classifyBlocks } from "./classifier.js";
import { jobStore, type StoredJobState } from "./jobStore.js";
import { validatePage } from "./validator.js";

type MuPdfModule = typeof import("mupdf");
type PdfJsModule = typeof import("pdfjs-dist/legacy/build/pdf.mjs");

interface ExtractorSpan extends RawSpan {
  pageIndex: number;
  fontWeight: "normal" | "bold";
}

interface PageExtraction {
  pageIndex: number;
  pageWidth: number;
  pageHeight: number;
  leftMarginPx: number;
  spans: ExtractorSpan[];
  imageBytes: Uint8Array;
}

interface StructuredPageJson {
  blocks?: Array<{
    type?: string;
    bbox?: { x: number; y: number; w: number; h: number };
    lines?: Array<{
      bbox?: { x: number; y: number; w: number; h: number };
      font?: { size?: number; name?: string };
      text?: string;
    }>;
  }>;
}

let activeEngine = "uninitialized";

async function importMuPdf(): Promise<MuPdfModule | null> { try { return await import("mupdf"); } catch { return null; } }
async function importPdfJs(): Promise<PdfJsModule> { return import("pdfjs-dist/legacy/build/pdf.mjs"); }

function normalizeText(text: string, profile: ExtractionProfile): string {
  let value = text
    .replace(/Â»/g, "�")
    .replace(/â€/g, "�")
    .replace(/â€œ/g, "�")
    .replace(/â€™/g, "�")
    .replace(/â€“/g, "�")
    .replace(/â€”/g, "�")
    .replace(/ï¿½/g, "")
    .replace(/\s+/g, " ")
    .trim();
  for (const [source, target] of Object.entries(profile.encodingMap)) {
    value = value.split(source).join(target);
  }
  if (/^(?:[A-Z0-9]\s+){2,}[A-Z0-9]$/.test(value)) {
    value = value.replace(/\s+/g, "");
  }
  return value;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\"/g, "&quot;").replace(/'/g, "&#39;");
}

function sanitizeFont(fontName: string): string {
  const cleaned = fontName.replace(/[^A-Za-z0-9_\s-]/g, " ").replace(/\s+/g, " ").trim();
  return cleaned || "serif";
}

function detectLeftMarginPx(spans: ExtractorSpan[]): number {
  const buckets = new Map<number, number>();
  for (const span of spans) {
    const bucket = Math.round(span.x / 4) * 4;
    buckets.set(bucket, (buckets.get(bucket) ?? 0) + 1);
  }
  const best = [...buckets.entries()].sort((a, b) => b[1] - a[1])[0];
  return best?.[0] ?? 0;
}

function defaultStyles(indent = 0) {
  return { textIndent: indent, paddingLeft: 0, lineHeight: 1.4, textAlign: "left" as const };
}

function mergeSpans(spans: ExtractorSpan[], profile: ExtractionProfile, leftMarginPx: number): TextBlock[] {
  const sorted = [...spans].sort((a, b) => (Math.abs(a.y - b.y) > profile.yBandTolerance ? a.y - b.y : a.x - b.x));
  const blocks: TextBlock[] = [];
  for (const span of sorted) {
    const normalized = normalizeText(span.text, profile);
    if (!normalized) continue;
    const indentOffset = span.x - leftMarginPx;
    const potentialIndent = span.x > leftMarginPx + (profile.indentedParaXOffset || 10);
    const confirmedIndent = profile.firstLineIndentPx > 0 && Math.abs(indentOffset - profile.firstLineIndentPx) < 3;
    const isIndented = potentialIndent || confirmedIndent;
    const previous = blocks[blocks.length - 1];
    if (previous) {
      const prevLastRaw = previous.rawSpans[previous.rawSpans.length - 1];
      const gap = span.x - (previous.x + previous.w);
      const fontCompatible = Math.abs(previous.fontSize - span.fontSize) <= 1 && previous.fontName === span.fontName;
      const shouldMerge = Math.abs(prevLastRaw.y - span.y) <= profile.yBandTolerance && fontCompatible && gap <= profile.xGapTolerance && gap >= -1;
      const indentGuard = isIndented && previous.y < span.y && Math.abs(previous.x - span.x) > 2;
      if (shouldMerge && !indentGuard) {
        const lettersOnly = /^[A-Z0-9]+$/.test(previous.text.replace(/\s+/g, "")) && /^[A-Z0-9]+$/.test(normalized.replace(/\s+/g, ""));
        previous.text = `${previous.text}${gap > 3 && !lettersOnly ? " " : ""}${normalized}`;
        previous.w = Math.max(previous.w, (span.x + span.w) - previous.x);
        previous.h = Math.max(previous.h, span.h);
        previous.rawSpans.push({ x: span.x, y: span.y, w: span.w, h: span.h, text: normalized, fontSize: span.fontSize, fontName: span.fontName });
        continue;
      }
    }
    const textIndent = isIndented ? (profile.firstLineIndentPx || indentOffset) : 0;
    blocks.push({
      id: randomUUID(), x: Number(span.x.toFixed(2)), y: Number((span.y + profile.baselineDrift).toFixed(2)), w: Number(span.w.toFixed(2)), h: Number(span.h.toFixed(2)),
      text: normalized, fontSize: Number(span.fontSize.toFixed(2)), fontName: span.fontName, fontWeight: span.fontWeight, confidence: 0.8, tag: "span", pageIndex: span.pageIndex,
      styles: defaultStyles(textIndent), isFirstLineIndented: isIndented,
      rawSpans: [{ x: span.x, y: span.y, w: span.w, h: span.h, text: normalized, fontSize: span.fontSize, fontName: span.fontName }]
    });
  }
  return blocks;
}

function predictTag(block: TextBlock, pageWidth: number, profile: ExtractionProfile): SemanticTag {
  if (block.confidence < profile.artifactThreshold) return "artifact";
  if (block.isFirstLineIndented) return "p";
  if (block.fontSize >= profile.headingCutoffs[0]) return "h1";
  if (block.fontSize >= profile.headingCutoffs[1]) return "h2";
  if (block.fontSize >= profile.headingCutoffs[2]) return "h3";
  return block.w > pageWidth * 0.5 ? "p" : "span";
}

function applyClassifierResults(blocks: TextBlock[], results: ClassifierResult[], pageWidth: number, profile: ExtractionProfile): TextBlock[] {
  const byId = new Map(results.map((result) => [result.blockId, result]));
  return blocks.map((block) => {
    const result = byId.get(block.id);
    return { ...block, tag: result?.predictedTag ?? predictTag(block, pageWidth, profile), confidence: Number((result?.confidence ?? block.confidence).toFixed(3)) };
  });
}

function applyParagraphStyles(blocks: TextBlock[], profile: ExtractionProfile, leftMarginPx: number): TextBlock[] {
  return blocks.map((block) => {
    if (block.tag !== "p") return block;
    const shouldApply = profile.defaultTextIndent > 0 && !block.isFirstLineIndented && Math.abs(block.x - leftMarginPx) < 8;
    return { ...block, styles: { ...block.styles, textIndent: shouldApply ? profile.defaultTextIndent : block.styles.textIndent } };
  });
}

function filterBlocks(blocks: TextBlock[]): TextBlock[] {
  return blocks.filter((block) => block.tag !== "artifact" && block.text.trim() && block.w >= 2 && block.h >= 2);
}

function buildCss(pageWidth: number, pageHeight: number, blocks: TextBlock[]): string {
  const rules = blocks.map((block) => `[data-block-id="${block.id}"] {\n  position: absolute;\n  left: ${block.x}px;\n  top: ${block.y}px;\n  width: ${block.w}px;\n  height: ${block.h}px;\n  font-size: ${block.fontSize}pt;\n  font-family: "${sanitizeFont(block.fontName)}", serif;\n  font-weight: ${block.fontWeight};\n  white-space: nowrap;\n  overflow: visible;\n  text-indent: ${block.styles.textIndent}px;\n  padding-left: ${block.styles.paddingLeft}px;\n  line-height: ${block.styles.lineHeight};\n  text-align: ${block.styles.textAlign};\n}`).join("\n\n");
  return `html, body { margin: 0; padding: 0; background: transparent; }\n.page { position: relative; width: ${pageWidth}px; height: ${pageHeight}px; overflow: hidden; }\n.page__bg { position: absolute; inset: 0; width: 100%; height: 100%; z-index: 0; pointer-events: none; }\n.page__text { position: absolute; inset: 0; z-index: 1; }\n.page__text > * { margin: 0; user-select: text; }\n${rules}`;
}

function buildHtml(page: PageResult, imageHref: string, cssHref: string, mode: "final" | "review" | "boxes"): string {
  const modeCss = mode === "final" ? `.page__text > * { color: rgba(0, 0, 0, 0.01); }` : mode === "review" ? `.page__text > * { color: rgba(0, 0, 0, 0.88); background: rgba(255, 255, 255, 0.2); }` : `.page__text > * { color: rgba(0, 0, 0, 0.88); background: rgba(255, 255, 0, 0.14); outline: 1px dashed rgba(74, 144, 226, 0.95); }`;
  const elements = page.blocks.map((block) => `<${block.tag} data-block-id="${block.id}" data-confidence="${block.confidence}" data-tag="${block.tag}" data-is-indented="${block.isFirstLineIndented}">${escapeHtml(block.text)}</${block.tag}>`).join("\n");
  return `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<link rel="stylesheet" href="${cssHref}">\n<style>${modeCss}</style>\n</head>\n<body>\n<div class="page">\n<img class="page__bg" src="${imageHref}" alt="">\n<div class="page__text">\n${elements}\n</div>\n</div>\n</body>\n</html>`;
}

async function extractWithMuPdf(filePath: string, profile: ExtractionProfile, dpi: number): Promise<PageExtraction[]> {
  const mupdf = await importMuPdf();
  if (!mupdf) throw new Error("MuPDF unavailable");
  activeEngine = "mupdf";
  const pdfBytes = await readFile(filePath);
  const document = mupdf.Document.openDocument(pdfBytes, "application/pdf");
  const pageCount = document.countPages();
  const scale = Math.min(200, Math.max(72, dpi)) / 72;
  const matrix = mupdf.Matrix.scale(scale, scale);
  const limit = pLimit(4);
  return Promise.all(Array.from({ length: pageCount }, (_, pageIndex) => limit(async () => {
    const page = document.loadPage(pageIndex);
    const bounds = page.getBounds() as [number, number, number, number];
    const pageWidth = Math.round((bounds[2] - bounds[0]) * scale);
    const pageHeight = Math.round((bounds[3] - bounds[1]) * scale);
    const pixmap = page.toPixmap(matrix, mupdf.ColorSpace.DeviceRGB, false, true);
    const imageBytes = pixmap.asPNG();
    const structured = page.toStructuredText("preserve-whitespace,preserve-spans");
    const json = JSON.parse(structured.asJSON(scale)) as StructuredPageJson;
    const spans: ExtractorSpan[] = [];
    for (const block of json.blocks ?? []) {
      if (block.type !== "text") continue;
      for (const line of block.lines ?? []) {
        const bbox = line.bbox ?? block.bbox;
        const text = normalizeText(line.text ?? "", profile);
        if (!bbox || !text) continue;
        const fontName = line.font?.name ?? "Unknown";
        spans.push({ x: bbox.x + profile.coordOffsetX, y: bbox.y + profile.coordOffsetY, w: bbox.w, h: bbox.h, text, fontSize: line.font?.size ?? bbox.h ?? 12, fontName, pageIndex, fontWeight: /bold|black|heavy/i.test(fontName) ? "bold" : "normal" });
      }
    }
    return { pageIndex, pageWidth, pageHeight, leftMarginPx: detectLeftMarginPx(spans), spans, imageBytes };
  })));
}

async function extractWithPdfJs(filePath: string, profile: ExtractionProfile, dpi: number): Promise<PageExtraction[]> {
  const pdfjs = await importPdfJs();
  const canvasModule = await import("@napi-rs/canvas");
  activeEngine = "pdfjs-dist";
  const task = pdfjs.getDocument({ data: new Uint8Array(await readFile(filePath)), useWorkerFetch: false } as never);
  const document = await task.promise;
  const scale = Math.min(200, Math.max(72, dpi)) / 72;
  const limit = pLimit(4);
  return Promise.all(Array.from({ length: document.numPages }, (_, zeroIndex) => limit(async () => {
    const page = await document.getPage(zeroIndex + 1);
    const viewport = page.getViewport({ scale });
    const canvas = canvasModule.createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    const context = canvas.getContext("2d");
    await page.render({ canvas, canvasContext: context as never, viewport } as never).promise;
    const text = await page.getTextContent();
    const spans: ExtractorSpan[] = [];
    for (const item of text.items as Array<{ str: string; width: number; height: number; transform: number[]; fontName: string }>) {
      const normalized = normalizeText(item.str, profile);
      if (!normalized) continue;
      const [, , , d, e, f] = item.transform;
      const height = (item.height || Math.abs(d) || 12) * scale;
      spans.push({ x: (e * scale) + profile.coordOffsetX, y: (viewport.height - (f * scale) - height) + profile.coordOffsetY, w: item.width * scale, h: height, text: normalized, fontSize: Math.abs(d) || item.height || 12, fontName: item.fontName, pageIndex: zeroIndex, fontWeight: /bold|black|heavy/i.test(item.fontName) ? "bold" : "normal" });
    }
    return { pageIndex: zeroIndex, pageWidth: Math.ceil(viewport.width), pageHeight: Math.ceil(viewport.height), leftMarginPx: detectLeftMarginPx(spans), spans, imageBytes: new Uint8Array(canvas.toBuffer("image/png")) };
  })));
}

async function extractPages(filePath: string, profile: ExtractionProfile, dpi: number): Promise<PageExtraction[]> {
  try { return await extractWithMuPdf(filePath, profile, dpi); } catch { return extractWithPdfJs(filePath, profile, dpi); }
}

function buildPageArtifacts(jobId: string, extracted: PageExtraction, profile: ExtractionProfile, blocks: TextBlock[]) {
  const filtered = filterBlocks(applyParagraphStyles(blocks, profile, extracted.leftMarginPx));
  const page: PageResult = { pageIndex: extracted.pageIndex, imageUrl: `/api/jobs/${jobId}/pages/${extracted.pageIndex}/image`, htmlContent: "", blocks: filtered, confidence: validatePage(filtered, profile, extracted.pageWidth, extracted.pageHeight), pageWidth: extracted.pageWidth, pageHeight: extracted.pageHeight, leftMarginPx: extracted.leftMarginPx, reviewStatus: "unvisited" };
  const pageNumber = extracted.pageIndex + 1;
  const cssContent = buildCss(extracted.pageWidth, extracted.pageHeight, filtered);
  const finalHtml = buildHtml(page, `../images/page-${pageNumber}.png`, `../styles/page-${pageNumber}.css`, "final");
  const reviewHtml = buildHtml(page, `../images/page-${pageNumber}.png`, `../styles/page-${pageNumber}.css`, "review");
  const boxesHtml = buildHtml(page, `../images/page-${pageNumber}.png`, `../styles/page-${pageNumber}.css`, "boxes");
  page.htmlContent = finalHtml;
  return { page, cssContent, finalHtml, reviewHtml, boxesHtml };
}

export async function extractPDF(job: StoredJobState, profile: ExtractionProfile, dpi = 150): Promise<void> {
  await jobStore.markActive(job.id);
  await jobStore.updateJob(job.id, { status: ExtractionStatus.processing, processedPages: 0, dpi });
  try {
    const pages = await extractPages(job.filePath, profile, dpi);
    await jobStore.updateJob(job.id, { pageCount: pages.length });
    for (const extracted of pages.sort((a, b) => a.pageIndex - b.pageIndex)) {
      const merged = mergeSpans(extracted.spans, profile, extracted.leftMarginPx);
      const classified = applyClassifierResults(merged, await classifyBlocks(merged, { pageWidth: extracted.pageWidth, pageHeight: extracted.pageHeight } as PageResult), extracted.pageWidth, profile);
      const built = buildPageArtifacts(job.id, extracted, profile, classified);
      await jobStore.savePageArtifacts(job.id, extracted.pageIndex, { page: built.page, cssContent: built.cssContent, finalHtmlContent: built.finalHtml, reviewHtmlContent: built.reviewHtml, boxesHtmlContent: built.boxesHtml }, extracted.imageBytes);
      await jobStore.updateJob(job.id, { processedPages: extracted.pageIndex + 1 });
    }
    await jobStore.updateJob(job.id, { status: ExtractionStatus.done, pageCount: pages.length });
  } catch (error) {
    await jobStore.updateJob(job.id, { status: ExtractionStatus.failed, errorMessage: error instanceof Error ? error.message : "Extraction failed" });
    throw error;
  } finally {
    await jobStore.markInactive(job.id);
  }
}

export function getActiveEngine(): string { return activeEngine; }

