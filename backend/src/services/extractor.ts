import { ExtractionStatus, type TextBlock } from "../types.js";
import fs from "fs-extra";
import pLimit from "p-limit";
import type { InternalJob, JobStore, StoredPage } from "./jobStore.js";
import { scoreTextBlocks } from "./validator.js";

type MuPdfModule = typeof import("mupdf");
type PdfJsModule = typeof import("pdfjs-dist/legacy/build/pdf.mjs");

type HtmlMode = "final" | "debug" | "boxes";

interface ExtractionContext {
  job: InternalJob;
  store: JobStore;
  sourcePdfPath: string;
}

interface ExtractedPage {
  pageIndex: number;
  width: number;
  height: number;
  blocks: TextBlock[];
  imageBytes: Uint8Array;
}

interface StructuredLine {
  bbox?: { x: number; y: number; w: number; h: number };
  font?: { size?: number; name?: string };
  text?: string;
}

interface StructuredBlock {
  type?: string;
  bbox?: { x: number; y: number; w: number; h: number };
  lines?: StructuredLine[];
}

interface StructuredPageJson {
  blocks?: StructuredBlock[];
}

interface FontAsset {
  family: string;
  sourceUrl: string;
  format: string;
  weight?: string;
  style?: string;
}

function normalizeExtractedText(text: string): string {
  let value = text
    .replace(/Â»/g, "»")
    .replace(/â€/g, "”")
    .replace(/â€œ/g, "“")
    .replace(/â€™/g, "’")
    .replace(/â€“/g, "–")
    .replace(/â€”/g, "—")
    .replace(/ï¿½/g, "")
    .replace(/\s+/g, " ")
    .trim();

  if (/^(?:[A-Z0-9]\s+){2,}[A-Z0-9]$/.test(value)) {
    value = value.replace(/\s+/g, "");
  }

  return value;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function chooseTag(block: TextBlock, thresholds: { h1: number; h2: number; p: number }): "h1" | "h2" | "p" | "span" {
  if (block.fontSize >= thresholds.h1) {
    return "h1";
  }

  if (block.fontSize >= thresholds.h2) {
    return "h2";
  }

  if (block.fontSize >= thresholds.p) {
    return "p";
  }

  return "span";
}

function toCssFontFamily(fontName: string): string {
  const cleaned = fontName.replace(/[^\w\s-]/g, " ").replace(/\s+/g, " ").trim();
  return cleaned || "PDFExtractedText";
}

function buildCss(width: number, height: number, fontAssets: FontAsset[], blocks: TextBlock[]): string {
  const fontFaceCss = fontAssets.map((font) => {
    const declarations = [
      `font-family: "${font.family}";`,
      `src: url("${font.sourceUrl}") format("${font.format}");`
    ];

    if (font.weight) {
      declarations.push(`font-weight: ${font.weight};`);
    }

    if (font.style) {
      declarations.push(`font-style: ${font.style};`);
    }

    return `@font-face {\n  ${declarations.join("\n  ")}\n}`;
  }).join("\n\n");

  const blockCss = blocks.map((block, index) => {
    const left = block.x.toFixed(2);
    const topValue = block.y.toFixed(2);
    const widthValue = block.w.toFixed(2);
    const heightValue = block.h.toFixed(2);
    const fontSize = block.fontSize.toFixed(2);
    const lineHeight = Math.max(block.h, block.fontSize * 1.1).toFixed(2);
    const family = toCssFontFamily(block.fontName);
    return `#text-block-${index + 1} {\n  position: absolute;\n  left: ${left}px;\n  top: ${topValue}px;\n  width: ${widthValue}px;\n  min-height: ${heightValue}px;\n  font-size: ${fontSize}pt;\n  line-height: ${lineHeight}px;\n  font-family: "${family}", "Times New Roman", Georgia, serif;\n}`;
  }).join("\n\n");

  return `${fontFaceCss ? `${fontFaceCss}\n\n` : ""}html, body {
  margin: 0;
  padding: 0;
  background: #0a0f17;
}

.page {
  position: relative;
  width: ${width}px;
  height: ${height}px;
  margin: 0 auto;
  background: white;
  overflow: hidden;
  user-select: text;
  -webkit-user-select: text;
}

.page-bg {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: fill;
  pointer-events: none;
  user-select: none;
  -webkit-user-drag: none;
}

.text-layer {
  position: absolute;
  inset: 0;
  z-index: 1;
}

.text-block {
  margin: 0;
  padding: 0;
  white-space: pre-wrap;
  letter-spacing: normal;
  text-shadow: none;
  font-weight: 400;
  transform-origin: top left;
  background: transparent;
}

${blockCss}
`;
}

function buildHtml(pageIndex: number, imageUrl: string, cssUrl: string, blocks: TextBlock[], mode: HtmlMode): string {
  const fontSizes = blocks.map((block) => block.fontSize).sort((a, b) => b - a);
  const top = fontSizes[0] ?? 18;
  const h1 = top;
  const h2 = Math.max(top * 0.82, 14);
  const p = Math.max(top * 0.62, 10);

  const pageClass = mode === "boxes" ? "page mode-boxes" : mode === "debug" ? "page mode-debug" : "page mode-final";
  const items = blocks.map((block, index) => {
    const tag = chooseTag(block, { h1, h2, p });
    return `<${tag} id="text-block-${index + 1}" class="text-block">${escapeHtml(block.text)}</${tag}>`;
  }).join("\n");

  const modeCss = mode === "final"
    ? `.mode-final .text-block { color: rgba(0, 0, 0, 0.01); }`
    : mode === "debug"
      ? `.mode-debug .text-block { color: rgba(0, 0, 0, 0.85); background: rgba(255, 255, 255, 0.35); }`
      : `.mode-boxes .text-block { color: rgba(0, 0, 0, 0.9); background: rgba(255, 255, 0, 0.16); outline: 1px dashed rgba(255, 0, 0, 0.9); }`;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Page ${pageIndex + 1}</title>
  <link rel="stylesheet" href="${cssUrl}">
  <style>${modeCss}</style>
</head>
<body>
  <div class="${pageClass}" id="page-${pageIndex + 1}">
    <img class="page-bg" src="${imageUrl}" alt="">
    <div class="text-layer">
${items}
    </div>
  </div>
</body>
</html>`;
}

function mergeFragments(blocks: TextBlock[]): TextBlock[] {
  const sorted = [...blocks].sort((a, b) => {
    if (Math.abs(a.y - b.y) > 3) {
      return a.y - b.y;
    }

    return a.x - b.x;
  });

  const merged: TextBlock[] = [];

  for (const block of sorted) {
    const previous = merged[merged.length - 1];

    if (!previous) {
      merged.push({ ...block });
      continue;
    }

    const sameBand = Math.abs(previous.y - block.y) <= 3;
    const gap = block.x - (previous.x + previous.w);
    const compatibleFont = Math.abs(previous.fontSize - block.fontSize) <= 1 && previous.fontName === block.fontName;

    if (sameBand && compatibleFont && gap >= -1 && gap <= 12) {
      const compactPrevious = previous.text.replace(/\s+/g, "");
      const compactCurrent = block.text.replace(/\s+/g, "");
      const previousLooksLikeLetters = compactPrevious.length <= 3 || /^[A-Z0-9]+$/.test(compactPrevious);
      const currentLooksLikeLetters = compactCurrent.length <= 3 || /^[A-Z0-9]+$/.test(compactCurrent);
      const shouldInsertSpace = gap > 3 && !(previousLooksLikeLetters && currentLooksLikeLetters);

      previous.text = `${previous.text}${shouldInsertSpace ? " " : ""}${block.text}`;
      previous.w = Math.max(previous.w, (block.x + block.w) - previous.x);
      previous.h = Math.max(previous.h, block.h);
      previous.confidence = Math.min(previous.confidence, block.confidence);
      continue;
    }

    merged.push({ ...block });
  }

  return merged;
}

function normalizeMuPdfBlocks(data: StructuredPageJson, pageHeight: number): TextBlock[] {
  const raw: TextBlock[] = [];

  for (const block of data.blocks ?? []) {
    if (block.type !== "text") {
      continue;
    }

    for (const line of block.lines ?? []) {
      const text = normalizeExtractedText(line.text ?? "");
      const bbox = line.bbox ?? block.bbox;
      if (!text || !bbox) {
        continue;
      }

      const fontSize = line.font?.size ?? bbox.h ?? 12;
      raw.push({
        x: bbox.x,
        y: bbox.y,
        w: bbox.w,
        h: bbox.h,
        text,
        fontSize,
        fontName: line.font?.name ?? "Unknown",
        confidence: 0.9
      });
    }
  }

  return mergeFragments(raw);
}

async function importMuPdf(): Promise<MuPdfModule | null> {
  try {
    return await import("mupdf");
  } catch {
    return null;
  }
}

async function importPdfJs(): Promise<PdfJsModule> {
  return import("pdfjs-dist/legacy/build/pdf.mjs");
}

async function extractWithMuPdf(sourcePdfPath: string): Promise<ExtractedPage[]> {
  const mupdfjs = await importMuPdf();
  if (!mupdfjs) {
    throw new Error("MuPDF.js is not available");
  }

  const fileData = await fs.readFile(sourcePdfPath);
  const document = mupdfjs.Document.openDocument(fileData, "application/pdf");
  const pageCount = document.countPages();
  const scale = 2;
  const matrix = mupdfjs.Matrix.scale(scale, scale);

  const limit = pLimit(6);
  const work = Array.from({ length: pageCount }, (_, pageIndex) => limit(async () => {
    const page = document.loadPage(pageIndex);
    const bounds = page.getBounds() as [number, number, number, number];
    const width = Math.round((bounds[2] - bounds[0]) * scale);
    const height = Math.round((bounds[3] - bounds[1]) * scale);
    const pixmap = page.toPixmap(matrix, mupdfjs.ColorSpace.DeviceRGB, false, true);
    const imageBytes = pixmap.asPNG();
    const structured = page.toStructuredText("preserve-whitespace,preserve-spans");
    const json = JSON.parse(structured.asJSON(scale)) as StructuredPageJson;
    const blocks = normalizeMuPdfBlocks(json, height);

    return {
      pageIndex,
      width,
      height,
      blocks,
      imageBytes
    } satisfies ExtractedPage;
  }));

  return Promise.all(work);
}

interface PdfJsTextItem {
  str: string;
  width: number;
  height: number;
  transform: number[];
  fontName: string;
}

function normalizePdfJsBlocks(items: PdfJsTextItem[], pageHeight: number, scale: number): TextBlock[] {
  const raw = items
    .map((item) => {
      const text = normalizeExtractedText(item.str);
      if (!text) {
        return null;
      }

      const [, , , d, e, f] = item.transform;
      const fontSize = Math.abs(d) || item.height || 12;
      const width = item.width * scale;
      const height = (item.height || fontSize) * scale;
      return {
        x: e * scale,
        y: (pageHeight - (f * scale)) - height,
        w: width,
        h: height,
        text,
        fontSize: fontSize * scale,
        fontName: item.fontName,
        confidence: 0.72
      } satisfies TextBlock;
    })
    .filter((block): block is TextBlock => block !== null);

  return mergeFragments(raw);
}

async function extractWithPdfJs(sourcePdfPath: string): Promise<ExtractedPage[]> {
  const pdfjs = await importPdfJs();
  const canvasModule = await import("@napi-rs/canvas");
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(await fs.readFile(sourcePdfPath)),
    useWorkerFetch: false
  } as any);
  const document = await loadingTask.promise;
  const pageCount = document.numPages;
  const scale = 2;
  const limit = pLimit(6);

  const work = Array.from({ length: pageCount }, (_, index) => limit(async () => {
    const page = await document.getPage(index + 1);
    const viewport = page.getViewport({ scale });
    const canvas = canvasModule.createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    const context = canvas.getContext("2d");

    await page.render({
      canvas,
      canvasContext: context as never,
      viewport
    } as any).promise;

    const textContent = await page.getTextContent();
    const blocks = normalizePdfJsBlocks(textContent.items as PdfJsTextItem[], viewport.height, scale);

    return {
      pageIndex: index,
      width: Math.ceil(viewport.width),
      height: Math.ceil(viewport.height),
      blocks,
      imageBytes: new Uint8Array(canvas.toBuffer("image/png"))
    } satisfies ExtractedPage;
  }));

  return Promise.all(work);
}

async function extractPages(sourcePdfPath: string): Promise<ExtractedPage[]> {
  try {
    return await extractWithMuPdf(sourcePdfPath);
  } catch {
    return extractWithPdfJs(sourcePdfPath);
  }
}

function toStoredPage(jobId: string, page: ExtractedPage): StoredPage {
  const confidence = scoreTextBlocks(page.blocks);
  const imageUrl = `/api/jobs/${jobId}/pages/${page.pageIndex}/image`;
  const cssUrl = `/files/${jobId}/styles/page-${page.pageIndex + 1}.css`;
  const relativeImageUrl = `../images/page-${page.pageIndex + 1}.png`;
  const relativeCssUrl = `../styles/page-${page.pageIndex + 1}.css`;
  const fontAssets: FontAsset[] = [];
  const cssContent = buildCss(page.width, page.height, fontAssets, page.blocks);
  const htmlContent = buildHtml(page.pageIndex, imageUrl, cssUrl, page.blocks, "final");
  const debugHtmlContent = buildHtml(page.pageIndex, imageUrl, cssUrl, page.blocks, "debug");
  const boxesHtmlContent = buildHtml(page.pageIndex, imageUrl, cssUrl, page.blocks, "boxes");
  const fileHtmlContent = buildHtml(page.pageIndex, relativeImageUrl, relativeCssUrl, page.blocks, "final");

  return {
    pageIndex: page.pageIndex,
    imageUrl,
    htmlContent,
    cssUrl,
    confidence,
    width: page.width,
    height: page.height,
    debugHtmlContent,
    boxesHtmlContent,
    fileHtmlContent,
    cssContent,
    blocks: page.blocks.map((block) => ({
      ...block,
      confidence: Number(((block.confidence + confidence) / 2).toFixed(3))
    }))
  };
}

export async function runExtraction(context: ExtractionContext): Promise<void> {
  const { job, store, sourcePdfPath } = context;

  await store.update(job.id, {
    status: ExtractionStatus.processing,
    processedPages: 0,
    errorMessage: undefined
  });

  try {
    const pages = await extractPages(sourcePdfPath);
    await store.update(job.id, { pageCount: pages.length });

    for (const page of pages.sort((a, b) => a.pageIndex - b.pageIndex)) {
      const imagePath = store.getPageImagePath(job.id, page.pageIndex);
      await fs.writeFile(imagePath, page.imageBytes);
      const storedPage = toStoredPage(job.id, page);
      await store.savePage(job.id, storedPage);
      await store.incrementProcessed(job.id);
    }

    await store.update(job.id, {
      status: ExtractionStatus.done,
      pageCount: pages.length
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown extraction failure";
    await store.update(job.id, {
      status: ExtractionStatus.failed,
      errorMessage: message
    });
    throw error;
  }
}
