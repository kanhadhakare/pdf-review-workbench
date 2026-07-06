import { createHash, randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { ExtractionStatus, type ClassifierResult, type ExtractedFontAsset, type ExtractionProfile, type FontExtractionManifest, type ImportedPageManifest, type PageResult, type PdfPageBounds, type RawSpan, type SemanticTag, type TextBlock } from "../types.js";
import { classifyBlocks } from "./classifier.js";
import { jobStore, type StoredJobState } from "./jobStore.js";
import { extractFontsWithPdfBox } from "./pdfboxFontService.js";
import { convertManifestFontsForWeb } from "./fontConversionService.js";
import { validatePage } from "./validator.js";
import { isPdf2HtmlExEnabled, runPdf2HtmlEx, validatePdf2HtmlExOutput } from "./pdf2htmlExService.js";
import { extractionMaxDpi, extractionMaxPixels, extractionMinDpi, largePdfPagesPerChunk, mupdfMaxInputBytes } from "../config/runtime.js";
import { normalizePdfText } from "./textNormalizer.js";
import { destroyMuPdfObject, withMuPdfLock } from "./mupdfLifecycle.js";
import { fitMuPdfRenderSizing, fitMuPdfRenderSizingToWidth } from "./mupdfRenderSizing.js";
import { createJobLogger, type JobLogger } from "./jobLogger.js";
import { splitPdfWithPdfBox } from "./pdfboxPdfToolService.js";

type MuPdfModule = typeof import("mupdf");
type MuPdfPdfDocument = import("mupdf").PDFDocument;
type MuPdfPdfPage = import("mupdf").PDFPage;
type MuPdfPdfObject = import("mupdf").PDFObject;

// pdf.js is disabled for now. MuPDF is the only extraction engine.

interface ExtractorSpan extends RawSpan {
  pageIndex: number;
  fontWeight: "normal" | "bold";
}

interface PageExtraction {
  pageIndex: number;
  pageWidth: number;
  pageHeight: number;
  pdfPageBounds: PdfPageBounds;
  renderDpi: number;
  scale: number;
  leftMarginPx: number;
  spans: ExtractorSpan[];
  reviewWords: ReviewWord[];
  imageBytes: Uint8Array;
}

type SelectedPageBox = {
  name: NonNullable<PdfPageBounds["box"]>;
  bounds: [number, number, number, number];
};

interface MuPdfExtractionOptions {
  pageIndexOffset?: number;
  totalPageCount?: number;
  targetWidthPx?: number;
}

const MAX_EFFECTIVE_RENDER_PIXELS = 8_000_000;
const MAX_RENDER_DIMENSION_PX = 8_192;
const MAX_RENDER_BYTES = 128 * 1024 * 1024;
const MAX_SAFE_PAGE_BOX_PT = 5_000;

async function getFileSize(filePath: string): Promise<number> {
  const info = await stat(filePath);
  return info.size;
}

function isTooLargeForMuPdf(fileSize: number): boolean {
  return fileSize > mupdfMaxInputBytes;
}

async function assertMuPdfInputSize(filePath: string, logger?: JobLogger): Promise<void> {
  const size = await getFileSize(filePath);
  await logger?.info("mupdf.input-size", { bytes: size, maxBytes: mupdfMaxInputBytes });
  if (isTooLargeForMuPdf(size)) {
    throw new Error(
      `PDF is too large for MuPDF WASM (${Math.round(size / 1024 / 1024)} MB). Current limit is ${Math.round(mupdfMaxInputBytes / 1024 / 1024)} MB. Use native MuPDF/Poppler for this file or upload an optimized/split PDF.`
    );
  }
}

interface StructuredPageJson {
  blocks?: Array<{
    type?: string;
    bbox?: { x: number; y: number; w: number; h: number };
    lines?: Array<{
      bbox?: { x: number; y: number; w: number; h: number };
      font?: { size?: number; name?: string };
      text?: string;
      x?: number;
      y?: number;
      wmode?: number;
    }>;
  }>;
}

let activeEngine = "uninitialized";

async function importMuPdf(): Promise<MuPdfModule | null> {
  try {
    return await import("mupdf");
  } catch {
    return null;
  }
}

function normalizeText(text: string, profile: ExtractionProfile): string {
  const result = normalizePdfText(text, profile);
  if (result.warnings.length) {
    console.warn("[extractor] suspicious PDF text", {
      input: text,
      output: result.text,
      warnings: result.warnings
    });
  }
  return result.text;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function cssSingleQuoted(value: string): string {
  // Safe CSS string for use inside inline style attributes.
  // Use single quotes to avoid breaking `style="..."` attributes.
  return `'${String(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

function cleanPdfFontName(fontName: string): string {
  return fontName
    .replace(/^[A-Z]{6}\+/, "")
    .replace(/[^A-Za-z0-9_\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim() || "pdffont";
}

function sanitizeFont(fontName: string): string {
  const cleaned = fontName.replace(/[^A-Za-z0-9_\s-]/g, " ").replace(/\s+/g, " ").trim();
  return cleaned || "serif";
}

function sanitizeFontFamily(fontName: string): string {
  return cleanPdfFontName(fontName);
}

function normalizeFontKey(fontName: string): string {
  return sanitizeFontFamily(fontName).replace(/[^A-Za-z0-9]/g, "").toLowerCase();
}

function detectFontStyle(fontName: string): "normal" | "italic" {
  return /italic|oblique/i.test(fontName) ? "italic" : "normal";
}

function sanitizeColor(value: string): string {
  const normalized = value.trim();
  if (/^#[0-9A-Fa-f]{3,6}$/.test(normalized)) return normalized;
  if (/^rgba?\(/i.test(normalized)) return normalized;
  return "#000000";
}

function parseColorsFromStructuredHtml(html: string): string[] {
  const colors: string[] = [];
  const regex = /color\s*:\s*(#[0-9A-Fa-f]{3,6}|rgba?\([^\)]*\))/gi;
  let match;
  while ((match = regex.exec(html))) {
    colors.push(sanitizeColor(match[1]));
  }
  return colors;
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#([0-9]+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'");
}

type HtmlSpanRun = { text: string; color: string | null; x: number | null; y: number | null };
type RotationHint = { text: string; x: number; y: number; rotation: number };
type ReviewWord = {
  x: number;
  y: number;
  w: number;
  h: number;
  text: string;
  fontSize: number;
  fontName: string;
  fontWeight: "normal" | "bold";
  fontStyle: "normal" | "italic";
  fontColor: string;
  rotation?: number;
};

type StructuredChar = {
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
  fontSize: number;
  fontName: string;
  fontWeight: "normal" | "bold";
  fontStyle: "normal" | "italic";
  fontColor: string;
  rotation?: number;
};

function parseHtmlSpanRuns(html: string): HtmlSpanRun[] {
  // MuPDF structured HTML is typically: <p style="top:..;left:.."><span style="...color:...">TEXT</span></p>
  // We extract spans in document order and keep the paragraph top/left as hints.
  const runs: HtmlSpanRun[] = [];
  const paragraphRegex = /<p\b[^>]*style\s*=\s*"([^"]*)"[^>]*>([\s\S]*?)<\/p>/gi;
  const spanRegex = /<span\b[^>]*style\s*=\s*"([^"]*)"[^>]*>([\s\S]*?)<\/span>/gi;

  const parsePt = (styleText: string, key: "top" | "left"): number | null => {
    const m = styleText.match(new RegExp(`${key}\\s*:\\s*([0-9.]+)pt`, "i"));
    return m ? Number(m[1]) : null;
  };

  for (const pMatch of html.matchAll(paragraphRegex)) {
    const pStyle = String(pMatch[1] ?? "");
    const pInner = String(pMatch[2] ?? "");
    const y = parsePt(pStyle, "top");
    const x = parsePt(pStyle, "left");
    for (const sMatch of pInner.matchAll(spanRegex)) {
      const spanStyle = String(sMatch[1] ?? "");
      const rawText = String(sMatch[2] ?? "");
      const colorMatch = spanStyle.match(/color\s*:\s*(#[0-9A-Fa-f]{3,6}|rgba?\([^\)]*\))/i);
      const color = colorMatch ? sanitizeColor(colorMatch[1]) : null;
      const text = decodeHtmlEntities(rawText).replace(/<[^>]+>/g, "");
      runs.push({ text, color, x, y });
    }
  }

  return runs;
}

function normalizeRotationAngle(angle: number): number {
  let normalized = ((angle % 360) + 360) % 360;
  if (normalized > 180) normalized -= 360;
  if (Math.abs(normalized) < 3) return 0;
  if (Math.abs(normalized - 90) < 3) return 90;
  if (Math.abs(normalized + 90) < 3) return -90;
  if (Math.abs(Math.abs(normalized) - 180) < 3) return 180;
  return Number(normalized.toFixed(2));
}

function rotationFromQuad(quad: number[]): number {
  if (quad.length < 4) return 0;
  const dx = quad[2] - quad[0];
  const dy = quad[3] - quad[1];
  if (Math.hypot(dx, dy) < 0.01) return 0;
  return normalizeRotationAngle((Math.atan2(dy, dx) * 180) / Math.PI);
}

function pointFromValue(value: unknown): [number, number] | null {
  if (Array.isArray(value) && value.length >= 2 && Number.isFinite(Number(value[0])) && Number.isFinite(Number(value[1]))) {
    return [Number(value[0]), Number(value[1])];
  }
  if (value && typeof value === "object" && "x" in value && "y" in value) {
    const point = value as { x?: unknown; y?: unknown };
    if (Number.isFinite(Number(point.x)) && Number.isFinite(Number(point.y))) {
      return [Number(point.x), Number(point.y)];
    }
  }
  return null;
}

function quadFromValue(value: unknown): number[] | null {
  if (!Array.isArray(value)) return null;
  const flattened = value.flatMap((entry) => Array.isArray(entry) ? entry : [entry]).map(Number);
  return flattened.length >= 8 && flattened.every(Number.isFinite) ? flattened : null;
}

function bboxFromQuad(quad: number[], scale: number, profile: ExtractionProfile, originX = 0, originY = 0): { x: number; y: number; w: number; h: number } {
  const xs = [quad[0], quad[2], quad[4], quad[6]];
  const ys = [quad[1], quad[3], quad[5], quad[7]];
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  return {
    x: ((minX - originX) * scale) + profile.coordOffsetX,
    y: ((minY - originY) * scale) + profile.coordOffsetY,
    w: Math.max(0.1, (maxX - minX) * scale),
    h: Math.max(0.1, (maxY - minY) * scale)
  };
}

function cssColorFromMuPdf(color: unknown): string {
  if (!Array.isArray(color) || color.length === 0) return "#000000";
  const channels = color.map(Number).filter(Number.isFinite);
  if (channels.length === 0) return "#000000";
  const toByte = (value: number) => Math.max(0, Math.min(255, Math.round(value <= 1 ? value * 255 : value)));
  if (channels.length === 1) {
    const gray = toByte(channels[0]);
    return `#${gray.toString(16).padStart(2, "0").repeat(3)}`;
  }
  if (channels.length >= 4) {
    const [c, m, y, k] = channels.map((value) => value <= 1 ? value : value / 255);
    const r = toByte((1 - Math.min(1, c)) * (1 - Math.min(1, k)));
    const g = toByte((1 - Math.min(1, m)) * (1 - Math.min(1, k)));
    const b = toByte((1 - Math.min(1, y)) * (1 - Math.min(1, k)));
    return `#${[r, g, b].map((value) => value.toString(16).padStart(2, "0")).join("")}`;
  }
  const [r, g, b] = channels.map(toByte);
  return `#${[r, g, b].map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}

function unionBoxes(chars: StructuredChar[]): { x: number; y: number; w: number; h: number } {
  const minX = Math.min(...chars.map((char) => char.x));
  const minY = Math.min(...chars.map((char) => char.y));
  const maxX = Math.max(...chars.map((char) => char.x + char.w));
  const maxY = Math.max(...chars.map((char) => char.y + char.h));
  return {
    x: minX,
    y: minY,
    w: Math.max(0.1, maxX - minX),
    h: Math.max(0.1, maxY - minY)
  };
}

function structuredCharsToReviewWords(chars: StructuredChar[], profile: ExtractionProfile): ReviewWord[] {
  const words: ReviewWord[] = [];
  let current: StructuredChar[] = [];
  const flush = () => {
    if (current.length === 0) return;
    const rawText = current.map((char) => char.text).join("");
    const text = normalizeText(rawText, profile);
    if (text) {
      const box = unionBoxes(current);
      const styleSource = current.find((char) => char.text.trim()) ?? current[0];
      words.push({
        x: Number(box.x.toFixed(2)),
        y: Number(box.y.toFixed(2)),
        w: Number(box.w.toFixed(2)),
        h: Number(box.h.toFixed(2)),
        text,
        fontSize: styleSource.fontSize,
        fontName: styleSource.fontName,
        fontWeight: styleSource.fontWeight,
        fontStyle: styleSource.fontStyle,
        fontColor: styleSource.fontColor,
        rotation: styleSource.rotation
      });
    }
    current = [];
  };

  for (const char of chars) {
    if (!char.text || /\s/u.test(char.text)) {
      flush();
      continue;
    }
    current.push(char);
  }
  flush();
  return words;
}

function collectReviewWords(structured: unknown, profile: ExtractionProfile, scale: number, originX = 0, originY = 0): ReviewWord[] {
  const words: ReviewWord[] = [];
  let lineChars: StructuredChar[] = [];
  const flushLine = () => {
    words.push(...structuredCharsToReviewWords(lineChars, profile));
    lineChars = [];
  };
  const walker = structured as {
    walk?: (handlers: {
      beginLine?: (...args: unknown[]) => void;
      onChar?: (...args: unknown[]) => void;
      endLine?: () => void;
    }) => void;
  };
  if (typeof walker.walk !== "function") return words;
  try {
    walker.walk({
      beginLine: () => flushLine(),
      onChar: (...args: unknown[]) => {
        const rawText = String(args[0] ?? "");
        const font = args[2] as { getName?: () => string; isBold?: () => boolean; isItalic?: () => boolean } | undefined;
        const size = Number(args[3]);
        const quad = quadFromValue(args[4]);
        if (!rawText || !quad) return;
        const box = bboxFromQuad(quad, scale, profile, originX, originY);
        const fontName = font?.getName?.() ?? "Unknown";
        const rotation = rotationFromQuad(quad);
        lineChars.push({
          text: rawText,
          x: box.x,
          y: box.y,
          w: box.w,
          h: box.h,
          fontSize: Number.isFinite(size) ? size : box.h / scale,
          fontName,
          fontWeight: font?.isBold?.() || /bold|black|heavy/i.test(fontName) ? "bold" : "normal",
          fontStyle: font?.isItalic?.() || detectFontStyle(fontName) === "italic" ? "italic" : "normal",
          fontColor: cssColorFromMuPdf(args[5]),
          rotation: rotation === 0 ? undefined : rotation
        });
      },
      endLine: () => flushLine()
    });
    flushLine();
  } catch (error) {
    console.warn("[extractor] failed to collect MuPDF character boxes:", error);
  }
  return words;
}

function validPageBox(bounds: [number, number, number, number] | number[]): bounds is [number, number, number, number] {
  if (bounds.length !== 4 || !bounds.every(Number.isFinite) || bounds[2] <= bounds[0] || bounds[3] <= bounds[1]) return false;
  const widthPt = bounds[2] - bounds[0];
  const heightPt = bounds[3] - bounds[1];
  return widthPt <= MAX_SAFE_PAGE_BOX_PT && heightPt <= MAX_SAFE_PAGE_BOX_PT;
}

function selectPageBox(page: import("mupdf").Page): SelectedPageBox {
  for (const name of ["TrimBox", "CropBox", "MediaBox"] as const) {
    try {
      const bounds = page.getBounds(name) as [number, number, number, number];
      if (validPageBox(bounds)) return { name, bounds };
    } catch {
      // Optional boxes may be absent or unsupported for non-PDF page types.
    }
  }
  const bounds = page.getBounds() as [number, number, number, number];
  return { name: "MediaBox", bounds };
}

function pageToPixmap(
  page: import("mupdf").Page,
  matrix: import("mupdf").Matrix,
  colorspace: import("mupdf").ColorSpace,
  box: NonNullable<PdfPageBounds["box"]>
): import("mupdf").Pixmap {
  if (page.isPDF()) return (page as MuPdfPdfPage).toPixmap(matrix, colorspace, false, true, undefined, box);
  return page.toPixmap(matrix, colorspace, false, true);
}

function assertSafeRenderSize(pageIndex: number, widthPx: number, heightPx: number, dpi: number, box: NonNullable<PdfPageBounds["box"]>): void {
  const pixelCount = widthPx * heightPx;
  const estimatedBytes = pixelCount * 4;
  if (
    !Number.isFinite(pixelCount)
    || !Number.isFinite(estimatedBytes)
    || widthPx > MAX_RENDER_DIMENSION_PX
    || heightPx > MAX_RENDER_DIMENSION_PX
    || estimatedBytes > MAX_RENDER_BYTES
  ) {
    throw new Error(
      `Refusing to rasterize page ${pageIndex + 1}: ${widthPx}x${heightPx}px at ${dpi} DPI from ${box} would require about ${Math.round(estimatedBytes / 1024 / 1024)} MB. Lower EXTRACT_MAX_PIXELS/EXTRACT_MAX_DPI or inspect PDF page boxes.`
    );
  }
}

function collectRotationHints(structured: unknown): RotationHint[] {
  const hints: RotationHint[] = [];
  const walker = structured as { walk?: (handlers: { onChar?: (...args: unknown[]) => void }) => void };
  if (typeof walker.walk !== "function") return hints;
  try {
    walker.walk({
      onChar: (...args: unknown[]) => {
        const text = String(args[0] ?? "");
        if (!text.trim()) return;
        const origin = pointFromValue(args[1]);
        const quad = args.map(quadFromValue).find((value): value is number[] => Boolean(value));
        if (!origin || !quad) return;
        const rotation = rotationFromQuad(quad);
        if (rotation === 0) return;
        hints.push({ text, x: origin[0], y: origin[1], rotation });
      }
    });
  } catch (error) {
    console.warn("[extractor] failed to inspect MuPDF character rotation:", error);
  }
  return hints;
}

function findLineRotation(hints: RotationHint[], rawText: string, x?: number, y?: number): number | undefined {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return undefined;
  const firstChar = rawText.match(/\S/u)?.[0];
  if (!firstChar) return undefined;
  const direct = hints.find((hint) => hint.text === firstChar && Math.abs(hint.x - Number(x)) <= 2 && Math.abs(hint.y - Number(y)) <= 2);
  return direct?.rotation;
}

function isRotated(rotation?: number): boolean {
  return typeof rotation === "number" && Math.abs(rotation) > 0.01;
}

function createReviewWords(span: ExtractorSpan): ReviewWord[] {
  const fontColor = sanitizeColor(span.fontColor ?? "#000000");
  const base = {
    fontSize: span.fontSize,
    fontName: span.fontName,
    fontWeight: span.fontWeight,
    fontStyle: detectFontStyle(span.fontName),
    fontColor,
    rotation: span.rotation
  };
  if (isRotated(span.rotation)) {
    const text = span.text.trim();
    return text ? [{
      x: Number(span.x.toFixed(2)),
      y: Number(span.y.toFixed(2)),
      w: Number(span.w.toFixed(2)),
      h: Number(span.h.toFixed(2)),
      text,
      ...base
    }] : [];
  }
  const matches = [...span.text.matchAll(/\S+/g)];
  const unit = span.text.length > 0 ? span.w / span.text.length : span.w;
  return matches.map((match) => {
    const text = match[0];
    const start = match.index ?? 0;
    const x = span.x + (start * unit);
    const w = Math.max(2, text.length * unit);
    return {
      x: Number(x.toFixed(2)),
      y: Number(span.y.toFixed(2)),
      w: Number(w.toFixed(2)),
      h: Number(span.h.toFixed(2)),
      text,
      ...base
    };
  });
}

function cssBoxForRotation(word: ReviewWord): { left: number; top: number; width: number; height: number } {
  const rotation = normalizeRotationAngle(word.rotation ?? 0);
  if (rotation === -90) return { left: word.x, top: word.y + word.h, width: word.h, height: word.w };
  if (rotation === 90) return { left: word.x + word.w, top: word.y, width: word.h, height: word.w };
  if (rotation === 180) return { left: word.x + word.w, top: word.y + word.h, width: word.w, height: word.h };
  return { left: word.x, top: word.y, width: word.w, height: word.h };
}

function getFontStreamExtension(fontStream: any): string {
  const subtype = fontStream.get("Subtype")?.asName?.()?.toLowerCase?.();
  if (subtype === "truetype") return "ttf";
  if (subtype === "type1" || subtype === "type1c" || subtype === "cff" || subtype === "opentype") return "otf";
  if (subtype === "woff") return "woff";
  if (subtype === "woff2") return "woff2";
  return "bin";
}

function getFontFileFormat(extension: string): ExtractedFontAsset["format"] {
  switch (extension) {
    case "ttf":
      return "truetype";
    case "otf":
      return "opentype";
    case "woff":
      return "woff";
    case "woff2":
      return "woff2";
    default:
      return "unknown";
  }
}

function getCssFontFormat(format: ExtractedFontAsset["format"]): string {
  if (format === "type1") return "opentype";
  return format === "unknown" ? "opentype" : format;
}

function fontSourcePriority(format: ExtractedFontAsset["format"]): number {
  if (format === "woff2") return 0;
  if (format === "woff") return 1;
  if (format === "truetype") return 2;
  if (format === "opentype" || format === "type1") return 3;
  return 4;
}

function isBrowserSafeFontFormat(format: ExtractedFontAsset["format"]): boolean {
  // pdfbox extractor may emit Type1 fonts as .otf files; browsers can still load them as OpenType.
  return format === "truetype" || format === "opentype" || format === "type1" || format === "woff" || format === "woff2";
}

function buildFontFaceCss(fontAssets: ExtractedFontAsset[]): string {
  const grouped = new Map<string, ExtractedFontAsset[]>();
  for (const font of fontAssets) {
    const key = [sanitizeFontFamily(font.family), font.fontWeight, font.fontStyle].join("\u0000");
    grouped.set(key, [...(grouped.get(key) ?? []), font]);
  }
  return [...grouped.values()].map((fonts) => {
    const primary = fonts[0];
    const sources = [...fonts]
      .sort((a, b) => fontSourcePriority(a.format) - fontSourcePriority(b.format))
      .map((font) => `url("../fonts/${font.fileName}") format("${getCssFontFormat(font.format)}")`)
      .join(",\n    ");
    return `@font-face {
  font-family: "${sanitizeFontFamily(primary.family)}";
  src: ${sources};
  font-weight: ${primary.fontWeight};
  font-style: ${primary.fontStyle};
}`;
  }).join("\n\n");
}

function resolveCssFontFamily(fontName: string, fontAssets: ExtractedFontAsset[]): string {
  const normalized = normalizeFontKey(fontName);
  const exact = fontAssets.find((font) => normalizeFontKey(font.baseFont) === normalized || normalizeFontKey(font.family) === normalized);
  if (exact) {
    return sanitizeFontFamily(exact.family);
  }
  const partial = fontAssets.find((font) => {
    const familyKey = normalizeFontKey(font.family);
    return familyKey.includes(normalized) || normalized.includes(familyKey);
  });
  return partial ? sanitizeFontFamily(partial.family) : sanitizeFont(fontName);
}

function resolveCssFontStyle(fontName: string, fontAssets: ExtractedFontAsset[]): "normal" | "italic" {
  const normalized = normalizeFontKey(fontName);
  const matched = fontAssets.find((font) => normalizeFontKey(font.baseFont) === normalized || normalizeFontKey(font.family) === normalized);
  return matched?.fontStyle ?? detectFontStyle(fontName);
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
      const rotationCompatible = (prevLastRaw.rotation ?? 0) === (span.rotation ?? 0);
      const shouldMerge = Math.abs(prevLastRaw.y - span.y) <= profile.yBandTolerance && fontCompatible && rotationCompatible && gap <= profile.xGapTolerance && gap >= -1;
      const indentGuard = isIndented && previous.y < span.y && Math.abs(previous.x - span.x) > 2;
      if (shouldMerge && !indentGuard) {
        const lettersOnly = /^[A-Z0-9]+$/.test(previous.text.replace(/\s+/g, "")) && /^[A-Z0-9]+$/.test(normalized.replace(/\s+/g, ""));
        previous.text = `${previous.text}${gap > 3 && !lettersOnly ? " " : ""}${normalized}`;
        previous.w = Math.max(previous.w, (span.x + span.w) - previous.x);
        previous.h = Math.max(previous.h, span.h);
        previous.rawSpans.push({ x: span.x, y: span.y, w: span.w, h: span.h, text: normalized, fontSize: span.fontSize, fontName: span.fontName, fontColor: span.fontColor, rotation: span.rotation });
        continue;
      }
    }
    const textIndent = isIndented ? (profile.firstLineIndentPx || indentOffset) : 0;
    blocks.push({
      id: randomUUID(),
      x: Number(span.x.toFixed(2)),
      y: Number((span.y + profile.baselineDrift).toFixed(2)),
      w: Number(span.w.toFixed(2)),
      h: Number(span.h.toFixed(2)),
      text: normalized,
      fontSize: Number(span.fontSize.toFixed(2)),
      fontName: span.fontName,
      fontWeight: span.fontWeight,
      fontColor: span.fontColor ?? "#000000",
      confidence: 0.8,
      tag: "span",
      pageIndex: span.pageIndex,
      styles: defaultStyles(textIndent),
      isFirstLineIndented: isIndented,
      rawSpans: [{ x: span.x, y: span.y, w: span.w, h: span.h, text: normalized, fontSize: span.fontSize, fontName: span.fontName, fontColor: span.fontColor, rotation: span.rotation }]
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
    return {
      ...block,
      tag: result?.predictedTag ?? predictTag(block, pageWidth, profile),
      confidence: Number((result?.confidence ?? block.confidence).toFixed(3))
    };
  });
}

function applyParagraphStyles(blocks: TextBlock[], profile: ExtractionProfile, leftMarginPx: number): TextBlock[] {
  return blocks.map((block) => {
    if (block.tag !== "p") return block;
    const shouldApply = profile.defaultTextIndent > 0 && !block.isFirstLineIndented && Math.abs(block.x - leftMarginPx) < 8;
    return {
      ...block,
      styles: {
        ...block.styles,
        textIndent: shouldApply ? profile.defaultTextIndent : block.styles.textIndent
      }
    };
  });
}

function filterBlocks(blocks: TextBlock[]): TextBlock[] {
  return blocks.filter((block) => block.tag !== "artifact" && block.text.trim() && block.w >= 2 && block.h >= 2);
}

function buildCss(pageWidth: number, pageHeight: number, blocks: TextBlock[], fontAssets: ExtractedFontAsset[], fontFaceCss = ""): string {
  const rules = blocks.map((block) => `[data-block-id="${block.id}"] {\n  position: absolute;\n  left: ${block.x}px;\n  top: ${block.y}px;\n  width: ${block.w}px;\n  height: ${block.h}px;\n  font-size: ${block.fontSize}pt;\n  font-family: "${resolveCssFontFamily(block.fontName, fontAssets)}", serif;\n  font-weight: ${block.fontWeight};\n  font-style: ${resolveCssFontStyle(block.fontName, fontAssets)};\n  color: ${sanitizeColor(block.fontColor)};\n  white-space: nowrap;\n  overflow: visible;\n  text-indent: ${block.styles.textIndent}px;\n  padding-left: ${block.styles.paddingLeft}px;\n  line-height: ${block.styles.lineHeight};\n  text-align: ${block.styles.textAlign};\n}`).join("\n\n");
  return `html, body { margin: 0; padding: 0; background: transparent; }\n.page { position: relative; width: ${pageWidth}px; height: ${pageHeight}px; overflow: hidden; }\n.page__bg { position: absolute; inset: 0; width: 100%; height: 100%; z-index: 0; pointer-events: none; }\n.page__text { position: absolute; inset: 0; z-index: 1; }\n.page__text > * { margin: 0; user-select: text; }\n${fontFaceCss ? `${fontFaceCss}\n\n` : ""}${rules}`;
}

function buildHtml(page: PageResult, imageHref: string, cssHref: string, mode: "final" | "review" | "boxes"): string {
  const modeCss = mode === "final"
    ? `.page__text > * { color: rgba(0, 0, 0, 0.01); }`
    : mode === "review"
      ? `.page__text > * { background: rgba(255, 255, 255, 0.2); }`
      : `.page__text > * { background: rgba(255, 255, 0, 0.14); outline: 1px dashed rgba(74, 144, 226, 0.95); }`;
  const elements = page.blocks.map((block) => `<${block.tag} data-block-id="${block.id}" data-confidence="${block.confidence}" data-tag="${block.tag}" data-is-indented="${block.isFirstLineIndented}">${escapeHtml(block.text)}</${block.tag}>`).join("\n");
  return `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<link rel="stylesheet" href="${cssHref}">\n<style>${modeCss}</style>\n</head>\n<body>\n<div class="page">\n<img class="page__bg" src="${imageHref}" alt="">\n<div class="page__text">\n${elements}\n</div>\n</div>\n</body>\n</html>`;
}

async function extractWithMuPdf(
  filePath: string,
  profile: ExtractionProfile,
  dpi: number,
  onPage?: (page: PageExtraction, pageCount: number) => Promise<void>,
  logger?: JobLogger,
  options: MuPdfExtractionOptions = {}
): Promise<PageExtraction[]> {
  return withMuPdfLock(async () => {
    const mupdf = await importMuPdf();
    if (!mupdf) throw new Error("MuPDF unavailable");
    activeEngine = "mupdf";
    await assertMuPdfInputSize(filePath, logger);
    const pdfBytes = await readFile(filePath);
    const document = mupdf.Document.openDocument(pdfBytes, "application/pdf");
    try {
    const pageCount = document.countPages();
    const pageIndexOffset = options.pageIndexOffset ?? 0;
    const callbackPageCount = options.totalPageCount ?? pageCount;
      await logger?.info("mupdf.page-count", { pageCount, pageIndexOffset, callbackPageCount });
    const safeDpi = Math.min(extractionMaxDpi, Math.max(extractionMinDpi, dpi));
    const pages: PageExtraction[] = [];
    for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
      const page = document.loadPage(pageIndex);
      let pixmap: import("mupdf").Pixmap | null = null;
      let structured: import("mupdf").StructuredText | null = null;
      try {
        const originalPageIndex = pageIndex + pageIndexOffset;
        await logger?.info("page.start", { pageNumber: originalPageIndex + 1, chunkPageNumber: pageIndex + 1, pageCount: callbackPageCount });
        const selectedBox = selectPageBox(page);
        const bounds = selectedBox.bounds;
        const widthPt = bounds[2] - bounds[0];
        const heightPt = bounds[3] - bounds[1];
        const pdfPageBounds: PdfPageBounds = {
          x0: bounds[0],
          y0: bounds[1],
          x1: bounds[2],
          y1: bounds[3],
          widthPt,
          heightPt,
          box: selectedBox.name
        };
        const maxPixels = Math.min(extractionMaxPixels, MAX_EFFECTIVE_RENDER_PIXELS);
        const renderSizing = options.targetWidthPx
          ? fitMuPdfRenderSizingToWidth(widthPt, heightPt, options.targetWidthPx, { maxPixels })
          : fitMuPdfRenderSizing(widthPt, heightPt, safeDpi, {
              minDpi: extractionMinDpi,
              maxDpi: extractionMaxDpi,
              maxPixels
            });
        const scale = renderSizing.scale;
        const pageWidth = renderSizing.widthPx;
        const pageHeight = renderSizing.heightPx;
        assertSafeRenderSize(originalPageIndex, pageWidth, pageHeight, renderSizing.dpi, selectedBox.name);
        if (renderSizing.capped) {
          console.warn(`[extractor] page ${originalPageIndex + 1} raster capped to ${renderSizing.dpi} DPI (${pageWidth}x${pageHeight}, ${renderSizing.pixelCount} px) to avoid MuPDF WASM memory exhaustion.`);
          await logger?.warn("page.render-capped", { pageNumber: originalPageIndex + 1, chunkPageNumber: pageIndex + 1, dpi: renderSizing.dpi, widthPx: pageWidth, heightPx: pageHeight, pixelCount: renderSizing.pixelCount });
        }
        console.info(`[extractor] page ${originalPageIndex + 1}/${callbackPageCount}: rendering ${selectedBox.name} ${widthPt.toFixed(2)}x${heightPt.toFixed(2)}pt at ${renderSizing.dpi} DPI -> ${pageWidth}x${pageHeight}px`);
        await logger?.info("page.render.start", {
          pageNumber: originalPageIndex + 1,
          chunkPageNumber: pageIndex + 1,
          box: selectedBox.name,
          widthPt,
          heightPt,
          dpi: renderSizing.dpi,
          widthPx: pageWidth,
          heightPx: pageHeight,
          pixelCount: renderSizing.pixelCount,
          targetWidthPx: options.targetWidthPx,
          memory: process.memoryUsage()
        });
        const matrix = mupdf.Matrix.scale(scale, scale);
        try {
          pixmap = pageToPixmap(page, matrix, mupdf.ColorSpace.DeviceRGB, selectedBox.name);
        } catch (error) {
          await logger?.error("page.render.error", error, { pageNumber: originalPageIndex + 1, chunkPageNumber: pageIndex + 1, dpi: renderSizing.dpi, widthPx: pageWidth, heightPx: pageHeight });
          throw new Error(`MuPDF rasterization failed on page ${originalPageIndex + 1} at ${renderSizing.dpi} DPI (${pageWidth}x${pageHeight}). Lower EXTRACT_MAX_PIXELS or EXTRACT_MAX_DPI. ${error instanceof Error ? error.message : String(error)}`);
        }
        console.info(`[extractor] page ${originalPageIndex + 1}/${callbackPageCount}: encoding PNG`);
        await logger?.info("page.png.start", { pageNumber: originalPageIndex + 1, chunkPageNumber: pageIndex + 1, memory: process.memoryUsage() });
        const imageBytes = new Uint8Array(pixmap.asPNG());
        await logger?.info("page.png.done", { pageNumber: originalPageIndex + 1, chunkPageNumber: pageIndex + 1, imageBytes: imageBytes.byteLength, memory: process.memoryUsage() });
        console.info(`[extractor] page ${originalPageIndex + 1}/${callbackPageCount}: reading structured text`);
        await logger?.info("page.structured-text.start", { pageNumber: originalPageIndex + 1, chunkPageNumber: pageIndex + 1, memory: process.memoryUsage() });
        structured = page.toStructuredText("preserve-whitespace,preserve-spans");
        await logger?.info("page.structured-text.done", { pageNumber: originalPageIndex + 1, chunkPageNumber: pageIndex + 1, memory: process.memoryUsage() });
        console.info(`[extractor] page ${originalPageIndex + 1}/${callbackPageCount}: parsing structured text`);
        const html = structured.asHTML(0);
        const htmlRuns = parseHtmlSpanRuns(html);
        const rotationHints = collectRotationHints(structured);
        const reviewWords = collectReviewWords(structured, profile, scale, bounds[0], bounds[1]);
        let runIndex = 0;
        const json = JSON.parse(structured.asJSON(1)) as StructuredPageJson;
        const spans: ExtractorSpan[] = [];
        for (const block of json.blocks ?? []) {
          if (block.type !== "text") continue;
          for (const line of block.lines ?? []) {
            const bbox = line.bbox ?? block.bbox;
            const text = normalizeText(line.text ?? "", profile);
            if (!bbox || !text) continue;
            const fontName = line.font?.name ?? "Unknown";
            let rawColor: string | null = null;
            let bestFallback: { color: string | null; score: number } | null = null;
            for (let attempts = 0; attempts < 12 && runIndex < htmlRuns.length; attempts += 1) {
              const run = htmlRuns[runIndex++];
              const runText = normalizeText(run.text ?? "", profile);
              if (!runText) continue;
              if (runText === text) {
                rawColor = run.color;
                bestFallback = null;
                break;
              }
              const overlap = text.includes(runText) || runText.includes(text);
              if (overlap && run.x !== null && run.y !== null) {
                const dx = Math.abs(run.x - bbox.x);
                const dy = Math.abs(run.y - bbox.y);
                const score = dx + (dy * 2);
                if (!bestFallback || score < bestFallback.score) bestFallback = { color: run.color, score };
              }
            }
            if (rawColor === null && bestFallback) rawColor = bestFallback.color;
            const rotation = findLineRotation(rotationHints, line.text ?? "", line.x, line.y);
            spans.push({
              x: ((bbox.x - bounds[0]) * scale) + profile.coordOffsetX,
              y: ((bbox.y - bounds[1]) * scale) + profile.coordOffsetY,
              w: bbox.w * scale,
              h: bbox.h * scale,
              text,
              fontSize: line.font?.size ?? bbox.h ?? 12,
              fontName,
              fontColor: sanitizeColor(rawColor ?? "#000000"),
              rotation,
              pageIndex: originalPageIndex,
              fontWeight: /bold|black|heavy/i.test(fontName) ? "bold" : "normal"
            });
          }
        }
        const extracted = { pageIndex: originalPageIndex, pageWidth, pageHeight, pdfPageBounds, renderDpi: renderSizing.dpi, scale, leftMarginPx: detectLeftMarginPx(spans), spans, reviewWords, imageBytes };
        if (onPage) {
          await onPage(extracted, callbackPageCount);
        } else {
          pages.push(extracted);
        }
        await logger?.info("page.done", { pageNumber: originalPageIndex + 1, chunkPageNumber: pageIndex + 1, spans: spans.length, reviewWords: reviewWords.length, memory: process.memoryUsage() });
      } catch (error) {
        await logger?.error("page.error", error, { pageNumber: pageIndex + pageIndexOffset + 1, chunkPageNumber: pageIndex + 1, memory: process.memoryUsage() });
        throw error;
      } finally {
        destroyMuPdfObject(structured);
        destroyMuPdfObject(pixmap);
        destroyMuPdfObject(page);
        (globalThis as { gc?: () => void }).gc?.();
      }
    }
    return pages;
    } finally {
      destroyMuPdfObject(document);
    }
  });
}

async function extractFontsFromMuPdf(filePath: string, jobId: string): Promise<ExtractedFontAsset[]> {
  const fileSize = await getFileSize(filePath);
  if (isTooLargeForMuPdf(fileSize)) {
    console.warn(
      `[extractor] Skipping MuPDF font fallback for oversized PDF ${jobId}: ${Math.round(fileSize / 1024 / 1024)} MB`
    );
    return [];
  }
  const mupdf = await importMuPdf();
  if (!mupdf) return [];
  const pdfBytes = await readFile(filePath);
  const document = mupdf.Document.openDocument(pdfBytes, "application/pdf");
  try {
    const pdfDocument = document.asPDF();
    if (!pdfDocument) {
      return [];
    }
    const fontAssets: ExtractedFontAsset[] = [];
    const seen = new Map<string, ExtractedFontAsset>();
    const candidates: Array<{ fontRef: string; family: string; fontWeight: "normal" | "bold"; fontStyle: "normal" | "italic"; bytes: Uint8Array; extension: string; }> = [];
    for (let pageIndex = 0; pageIndex < pdfDocument.countPages(); pageIndex++) {
      const page = pdfDocument.loadPage(pageIndex) as MuPdfPdfPage;
      try {
        const pageObj = page.getObject();
        const resources = pageObj.get("Resources");
        if (!resources?.isDictionary?.()) continue;
        const fontResources = resources.get("Font");
        if (!fontResources?.isDictionary?.()) continue;
        fontResources.forEach((valueObj: MuPdfPdfObject, keyName: string | number) => {
          try {
            const fontRef = valueObj.toString?.() ?? String(keyName);
            if (seen.has(fontRef) || candidates.some((candidate) => candidate.fontRef === fontRef)) return;
            const font = valueObj.isDictionary?.() ? valueObj : valueObj.resolve?.();
            if (!font?.isDictionary?.()) return;
            const baseFont = font.get("BaseFont")?.asName?.() ?? font.get("FontName")?.asName?.() ?? String(keyName);
            const cleanedName = cleanPdfFontName(baseFont);
            const descriptorObject = font.get("FontDescriptor");
            const fontDescriptor = descriptorObject?.isDictionary?.() ? descriptorObject : descriptorObject?.resolve?.();
            if (!fontDescriptor?.isDictionary?.()) return;
            const fontFileObject = fontDescriptor.get("FontFile2") ?? fontDescriptor.get("FontFile3") ?? fontDescriptor.get("FontFile");
            if (!fontFileObject) return;
            const fontStream = fontFileObject.isStream?.() ? fontFileObject : fontFileObject.resolve?.();
            if (!fontStream?.isStream?.()) return;
            const rawBytes = fontStream.readRawStream?.() ?? fontStream.readStream?.();
            if (!rawBytes) return;
            const bytes = rawBytes instanceof Uint8Array
              ? new Uint8Array(rawBytes)
              : rawBytes instanceof ArrayBuffer
                ? new Uint8Array(rawBytes)
                : new Uint8Array(rawBytes as unknown as Uint8Array);
            candidates.push({
              fontRef,
              family: cleanedName,
              fontWeight: /bold|black|heavy/i.test(baseFont) ? "bold" : "normal",
              fontStyle: /italic|oblique/i.test(baseFont) ? "italic" : "normal",
              bytes,
              extension: getFontStreamExtension(fontStream)
            });
          } catch (error) {
            console.warn(`[extractor] skipping font resource ${String(keyName)} on page ${pageIndex + 1}:`, error);
          }
        });
      } finally {
        destroyMuPdfObject(page);
      }
    }
    for (const candidate of candidates) {
      const fileName = `${sanitizeFontFamily(candidate.family).replace(/\s+/g, "-").toLowerCase()}-${createHash("sha256").update(candidate.bytes).digest("hex").slice(0, 8)}.${candidate.extension}`;
      if (seen.has(fileName)) continue;
      await jobStore.saveFontFile(jobId, fileName, candidate.bytes);
      const asset: ExtractedFontAsset = {
        resourceName: candidate.fontRef,
        baseFont: candidate.family,
        family: candidate.family,
        format: getFontFileFormat(candidate.extension),
        fileName,
        fontWeight: candidate.fontWeight,
        fontStyle: candidate.fontStyle,
        pages: []
      };
      seen.set(candidate.fontRef, asset);
      seen.set(fileName, asset);
      fontAssets.push(asset);
    }
    return fontAssets;
  } finally {
    destroyMuPdfObject(document);
  }
}

function buildMuPdfFallbackManifest(sourcePdf: string, fonts: ExtractedFontAsset[]): FontExtractionManifest {
  return {
    sourcePdf,
    engine: "mupdf",
    status: fonts.length > 0 ? "ok" : "failed",
    message: fonts.length > 0 ? undefined : "MuPDF font fallback did not find any readable embedded font streams",
    fonts
  };
}

async function extractFontManifest(filePath: string, jobId: string): Promise<FontExtractionManifest> {
  let fontManifest = await extractFontsWithPdfBox(jobId, filePath);
  if (fontManifest.fonts.length === 0) {
    try {
      const fallbackFonts = await extractFontsFromMuPdf(filePath, jobId);
      if (fallbackFonts.length > 0) {
        fontManifest = await convertManifestFontsForWeb(jobId, buildMuPdfFallbackManifest(filePath, fallbackFonts));
        await jobStore.saveFontManifest(jobId, fontManifest);
      }
    } catch (error) {
      console.warn("[extractor] MuPDF font fallback failed:", error);
    }
  }
  return fontManifest;
}

function buildCombinedReviewCss(extracted: PageExtraction, profile: ExtractionProfile, fontAssets: ExtractedFontAsset[]): string {
  void profile;
  const browserSafeFonts = fontAssets.filter((font) => isBrowserSafeFontFormat(font.format));
  const fontFaceCss = buildFontFaceCss(browserSafeFonts);
  const commonCss = `.page { position: relative; width: ${extracted.pageWidth}px; height: ${extracted.pageHeight}px; overflow: hidden; }
.page__bg { position: absolute; inset: 0; width: 100%; height: 100%; z-index: 0; pointer-events: none; }
.page__text { position: absolute; inset: 0; z-index: 1; }
.page__word { position: absolute; margin: 0; white-space: nowrap; overflow: visible; user-select: text; }
.page__word { background: rgba(255, 255, 255, 0.04); }`;

  const rules: string[] = [];
  for (const [index, span] of extracted.spans.entries()) {
    // This function operates on already extracted (scaled) spans.
    // We keep per-word split below in HTML generation.
    void span;
    void index;
  }

  return `${fontFaceCss ? `${fontFaceCss}\n\n` : ""}${commonCss}`;
}

function buildCombinedReviewHtml(extracted: PageExtraction, profile: ExtractionProfile, fontAssets: ExtractedFontAsset[], imageHref: string, cssHref: string): string {
  void profile;
  void fontAssets;
  const words = extracted.reviewWords.length > 0
    ? extracted.reviewWords
    : extracted.spans.flatMap((span) => createReviewWords(span));

  const elements = words
    .map((word, index) => {
      // Per-word rules live in the per-page CSS file, keyed by a unique class.
      return `<span class="page__word page${extracted.pageIndex + 1}__word${index}" data-word-index="${index}">${escapeHtml(word.text)}</span>`;
    })
    .join("\n");

  return `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<link rel="stylesheet" href="${cssHref}">\n</head>\n<body>\n<div class="page">\n<img class="page__bg" src="${imageHref}" alt="">\n<div class="page__text">\n${elements}\n</div>\n</div>\n</body>\n</html>`;
}

function buildImageOnlyReviewHtml(extracted: PageExtraction, imageHref: string, cssHref: string): string {
  const pageNumber = extracted.pageIndex + 1;
  return `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=${extracted.pageWidth}, height=${extracted.pageHeight}">\n<meta name="pdf-page-number" content="${pageNumber}">\n<meta name="pdf-page-width" content="${extracted.pageWidth}">\n<meta name="pdf-page-height" content="${extracted.pageHeight}">\n<meta name="pdf-page-scale" content="${Number(extracted.scale.toFixed(6))}">\n<link rel="stylesheet" href="${cssHref}">\n</head>\n<body>\n<div class="page">\n<img class="page__bg" src="${imageHref}" alt="">\n</div>\n</body>\n</html>`;
}

function buildImageOnlyReviewCss(extracted: PageExtraction): string {
  return `html, body { margin: 0; padding: 0; background: transparent; }\n.page { position: relative; width: ${extracted.pageWidth}px; height: ${extracted.pageHeight}px; overflow: hidden; background: #fff; }\n.page__bg { position: absolute; inset: 0; width: 100%; height: 100%; display: block; z-index: 0; pointer-events: none; }`;
}

function buildAccessibilityTaggingPageArtifacts(jobId: string, extracted: PageExtraction, profile: ExtractionProfile, blocks: TextBlock[]) {
  const filtered = filterBlocks(applyParagraphStyles(blocks, profile, extracted.leftMarginPx));
  const page: PageResult = {
    pageIndex: extracted.pageIndex,
    imageUrl: `/api/jobs/${jobId}/pages/${extracted.pageIndex}/image`,
    htmlContent: "",
    blocks: filtered,
    confidence: validatePage(filtered, profile, extracted.pageWidth, extracted.pageHeight),
    pageWidth: extracted.pageWidth,
    pageHeight: extracted.pageHeight,
    pdfPageBounds: extracted.pdfPageBounds,
    renderDpi: extracted.renderDpi,
    leftMarginPx: extracted.leftMarginPx,
    reviewStatus: "unvisited"
  };
  const pageNumber = extracted.pageIndex + 1;
  const reviewHtml = buildImageOnlyReviewHtml(extracted, `../images/page-${pageNumber}.png`, `../style/page-${pageNumber}.css`);
  return { page, reviewHtml, reviewCssContent: buildImageOnlyReviewCss(extracted) };
}

function buildPageArtifacts(jobId: string, extracted: PageExtraction, profile: ExtractionProfile, blocks: TextBlock[], fontAssets: ExtractedFontAsset[]) {
  const filtered = filterBlocks(applyParagraphStyles(blocks, profile, extracted.leftMarginPx));
  const browserSafeFonts = fontAssets.filter((font) => isBrowserSafeFontFormat(font.format));
  const page: PageResult = {
    pageIndex: extracted.pageIndex,
    imageUrl: `/api/jobs/${jobId}/pages/${extracted.pageIndex}/image`,
    htmlContent: "",
    blocks: filtered,
    confidence: validatePage(filtered, profile, extracted.pageWidth, extracted.pageHeight),
    pageWidth: extracted.pageWidth,
    pageHeight: extracted.pageHeight,
    pdfPageBounds: extracted.pdfPageBounds,
    renderDpi: extracted.renderDpi,
    leftMarginPx: extracted.leftMarginPx,
    reviewStatus: "unvisited"
  };
  const pageNumber = extracted.pageIndex + 1;
  // Per-page CSS contains both common rules and per-word absolute positioning and style.
  const commonCss = `.page { position: relative; width: ${extracted.pageWidth}px; height: ${extracted.pageHeight}px; overflow: hidden; }\n.page__bg { position: absolute; inset: 0; width: 100%; height: 100%; z-index: 0; pointer-events: none; }\n.page__text { position: absolute; inset: 0; z-index: 1; }\n.page__word { position: absolute; margin: 0; white-space: nowrap; overflow: visible; user-select: text; }\n.page__word { background: rgba(255, 255, 255, 0.04); }`;

  const wordRules: string[] = [];
  const reviewWords = extracted.reviewWords.length > 0
    ? extracted.reviewWords
    : extracted.spans.flatMap((span) => createReviewWords(span));
  for (const [wordIndex, word] of reviewWords.entries()) {
    const family = resolveCssFontFamily(word.fontName, browserSafeFonts);
    const fontSizePx = Number((word.fontSize * extracted.scale).toFixed(3));
    const color = sanitizeColor(word.fontColor ?? "#000000");
    const box = cssBoxForRotation(word);
    const transformCss = isRotated(word.rotation) ? ` transform-origin: top left; transform: rotate(${normalizeRotationAngle(word.rotation ?? 0)}deg);` : "";
    wordRules.push(`.page${pageNumber}__word${wordIndex} { left: ${Number(box.left.toFixed(2))}px; top: ${Number(box.top.toFixed(2))}px; width: ${Number(box.width.toFixed(2))}px; height: ${Number(box.height.toFixed(2))}px; font-size: ${fontSizePx}px; font-family: ${cssSingleQuoted(family)}, serif; font-weight: ${word.fontWeight}; font-style: ${word.fontStyle}; color: ${color};${transformCss} }`);
  }

  // Phase 1: word mapping rules are required for correct rendering.
  const reviewCss = `${buildFontFaceCss(browserSafeFonts)}\n\n${commonCss}\n\n${wordRules.join("\n")}`;
  const reviewHtml = buildCombinedReviewHtml(extracted, profile, browserSafeFonts, `../images/page-${pageNumber}.png`, `../style/page-${pageNumber}.css`);
  page.htmlContent = reviewHtml;
  return { page, reviewHtml, reviewCssContent: reviewCss };
}

async function completeSourceManifest(job: StoredJobState, pages: ImportedPageManifest[]): Promise<void> {
  const manifest = await jobStore.getSourceManifest(job.id);
  if (!manifest) return;
  await jobStore.saveSourceManifest(job.id, {
    ...manifest,
    layout: "fixed",
    status: "ready",
    pages,
    updatedAt: new Date().toISOString()
  });
}

async function extractLargePdfInChunks(job: StoredJobState, profile: ExtractionProfile, dpi: number, logger: JobLogger, options: { accessibilityTagging?: boolean } = {}): Promise<void> {
  await logger.info("large-pdf.split-flow.start", { pagesPerChunk: largePdfPagesPerChunk, maxChunkBytes: mupdfMaxInputBytes });
  const splitManifest = await splitPdfWithPdfBox(job.id, job.filePath, largePdfPagesPerChunk);
  const oversizedChunks = splitManifest.chunks.filter((chunk) => isTooLargeForMuPdf(chunk.sizeBytes));
  if (oversizedChunks.length) {
    throw new Error(
      `PDFBox split produced ${oversizedChunks.length} chunk(s) still too large for MuPDF WASM. Largest chunk is ${Math.round(Math.max(...oversizedChunks.map((chunk) => chunk.sizeBytes)) / 1024 / 1024)} MB. Lower LARGE_PDF_PAGES_PER_CHUNK or use native extraction.`
    );
  }

  await jobStore.updateJob(job.id, { pageCount: splitManifest.pageCount });
  await logger.info("font-extraction.start", { source: "large-pdf-original" });
  const fontManifest = await extractFontManifest(job.filePath, job.id);
  await logger.info("font-extraction.done", { fonts: fontManifest.fonts.length });

  const sourcePages: ImportedPageManifest[] = [];
  for (const chunk of splitManifest.chunks) {
    const chunkPath = path.join(jobStore.getJobDir(job.id), "optimized", "chunks", chunk.fileName);
    await logger.info("large-pdf.chunk.start", {
      chunkIndex: chunk.chunkIndex,
      startPage: chunk.startPage,
      endPage: chunk.endPage,
      pageCount: chunk.pageCount,
      sizeBytes: chunk.sizeBytes
    });
    await extractWithMuPdf(
      chunkPath,
      profile,
      dpi,
      async (extracted) => {
        const merged = mergeSpans(extracted.spans, profile, extracted.leftMarginPx);
        const classified = applyClassifierResults(
          merged,
          await classifyBlocks(merged, { pageWidth: extracted.pageWidth, pageHeight: extracted.pageHeight } as PageResult),
          extracted.pageWidth,
          profile
        );
        const built = options.accessibilityTagging
          ? buildAccessibilityTaggingPageArtifacts(job.id, extracted, profile, classified)
          : buildPageArtifacts(job.id, extracted, profile, classified, fontManifest.fonts);
        await jobStore.savePageArtifacts(
          job.id,
          extracted.pageIndex,
          {
            page: built.page,
            reviewHtmlContent: built.reviewHtml,
            reviewCssContent: built.reviewCssContent
          },
          extracted.imageBytes
        );
        sourcePages.push({
          pageIndex: extracted.pageIndex,
          sourcePath: `source.pdf#page=${extracted.pageIndex + 1}`,
          reviewPath: `review/page-${extracted.pageIndex + 1}.html`,
          width: extracted.pageWidth,
          height: extracted.pageHeight
        });
        await jobStore.updateJob(job.id, { processedPages: extracted.pageIndex + 1 });
        await logger.info("large-pdf.page.saved", { pageNumber: extracted.pageIndex + 1, chunkIndex: chunk.chunkIndex, blocks: built.page.blocks.length });
      },
      logger,
      { pageIndexOffset: chunk.startPage - 1, totalPageCount: splitManifest.pageCount, targetWidthPx: job.targetWidthPx }
    );
    await logger.info("large-pdf.chunk.done", { chunkIndex: chunk.chunkIndex });
  }

  sourcePages.sort((left, right) => left.pageIndex - right.pageIndex);
  await completeSourceManifest(job, sourcePages);
  await jobStore.updateJob(job.id, { status: ExtractionStatus.done, pageCount: splitManifest.pageCount, processedPages: splitManifest.pageCount });
  await logger.info("large-pdf.split-flow.done", { pageCount: splitManifest.pageCount, chunks: splitManifest.chunks.length });
}

export async function extractPDFForAccessibilityTagging(job: StoredJobState, profile: ExtractionProfile, dpi = 150): Promise<void> {
  const logger = createJobLogger(job.id);
  await logger.info("accessibility-extraction.start", { dpi, filePath: job.filePath });
  await jobStore.markActive(job.id);
  await jobStore.updateJob(job.id, { status: ExtractionStatus.processing, processedPages: 0, dpi });
  const sourcePages: ImportedPageManifest[] = [];
  try {
    const sourceSize = await getFileSize(job.filePath);
    await logger.info("accessibility-pdf.preflight", { sourceSize, mupdfMaxInputBytes });
    if (isTooLargeForMuPdf(sourceSize)) {
      await extractLargePdfInChunks(job, profile, dpi, logger, { accessibilityTagging: true });
      return;
    }
    await assertMuPdfInputSize(job.filePath, logger);
    let pageCount = 0;
    await extractWithMuPdf(job.filePath, profile, dpi, async (extracted, totalPages) => {
      if (pageCount === 0) {
        pageCount = totalPages;
        await jobStore.updateJob(job.id, { pageCount });
      }
      const merged = mergeSpans(extracted.spans, profile, extracted.leftMarginPx);
      const classified = applyClassifierResults(
        merged,
        await classifyBlocks(merged, { pageWidth: extracted.pageWidth, pageHeight: extracted.pageHeight } as PageResult),
        extracted.pageWidth,
        profile
      );
      const built = buildAccessibilityTaggingPageArtifacts(job.id, extracted, profile, classified);
      await jobStore.savePageArtifacts(
        job.id,
        extracted.pageIndex,
        {
          page: built.page,
          reviewHtmlContent: built.reviewHtml,
          reviewCssContent: built.reviewCssContent
        },
        extracted.imageBytes
      );
      sourcePages.push({
        pageIndex: extracted.pageIndex,
        sourcePath: `source.pdf#page=${extracted.pageIndex + 1}`,
        reviewPath: `review/page-${extracted.pageIndex + 1}.html`,
        width: extracted.pageWidth,
        height: extracted.pageHeight
      });
      await jobStore.updateJob(job.id, { processedPages: extracted.pageIndex + 1 });
      await logger.info("accessibility-page.saved", { pageNumber: extracted.pageIndex + 1, blocks: built.page.blocks.length });
    }, logger, { targetWidthPx: job.targetWidthPx });
    await completeSourceManifest(job, sourcePages);
    await jobStore.updateJob(job.id, { status: ExtractionStatus.done, pageCount });
    await logger.info("accessibility-extraction.done", { pageCount });
  } catch (error) {
    await logger.error("accessibility-extraction.error", error);
    const manifest = await jobStore.getSourceManifest(job.id);
    if (manifest) {
      await jobStore.saveSourceManifest(job.id, {
        ...manifest,
        status: "failed",
        warnings: [...manifest.warnings, error instanceof Error ? error.message : "Extraction failed"],
        updatedAt: new Date().toISOString()
      });
    }
    await jobStore.updateJob(job.id, {
      status: ExtractionStatus.failed,
      errorMessage: error instanceof Error ? error.message : "Extraction failed"
    });
    throw error;
  } finally {
    await jobStore.markInactive(job.id);
  }
}

export async function extractPDF(job: StoredJobState, profile: ExtractionProfile, dpi = 150, options: { enableOcrValidation?: boolean } = {}): Promise<void> {
  void options; // OCR disabled for now.
  const logger = createJobLogger(job.id);
  await logger.info("extraction.start", { dpi, filePath: job.filePath, workflow: job.workflow });
  await jobStore.markActive(job.id);
  await jobStore.updateJob(job.id, { status: ExtractionStatus.processing, processedPages: 0, dpi });
  const sourcePages: ImportedPageManifest[] = [];
  try {
    const sourceSize = await getFileSize(job.filePath);
    await logger.info("pdf.preflight", { sourceSize, mupdfMaxInputBytes });
    if (isTooLargeForMuPdf(sourceSize)) {
      await extractLargePdfInChunks(job, profile, dpi, logger);
      return;
    }
    let pdf2htmlExReady = false;
    if (isPdf2HtmlExEnabled()) {
      try {
        await logger.info("pdf2htmlEX.start");
        await runPdf2HtmlEx(job.filePath, jobStore.getPdf2HtmlExDir(job.id));
        activeEngine = "pdf2htmlEX";
        pdf2htmlExReady = true;
        const warnings = await validatePdf2HtmlExOutput(jobStore.getPdf2HtmlExDir(job.id));
        await jobStore.updateJob(job.id, { hasPdf2HtmlEx: true, pdf2htmlExWarnings: warnings });
        await logger.info("pdf2htmlEX.done", { warnings });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn("[extractor] pdf2htmlEX failed, falling back to built HTML:", error);
        await logger.error("pdf2htmlEX.error", error);
        await jobStore.updateJob(job.id, {
          hasPdf2HtmlEx: false,
          pdf2htmlExWarnings: [`pdf2htmlEX conversion failed; using fallback extractor output.`, message]
        });
      }
    }

    // If pdf2htmlEX succeeded, treat it as the source of truth for HTML output.
    // We still rasterize page images + dimensions for navigation/viewport scaling.
    if (pdf2htmlExReady) {
      let pageCount = 0;
      await extractWithMuPdf(job.filePath, profile, dpi, async (extracted, totalPages) => {
        if (pageCount === 0) {
          pageCount = totalPages;
          await jobStore.updateJob(job.id, { pageCount });
        }
        await jobStore.savePdf2HtmlExPage(job.id, extracted.pageIndex, extracted.pageWidth, extracted.pageHeight, extracted.imageBytes, extracted.pdfPageBounds, extracted.renderDpi);
        sourcePages.push({
          pageIndex: extracted.pageIndex,
          sourcePath: `source.pdf#page=${extracted.pageIndex + 1}`,
          reviewPath: `pdf2htmlex/page-${extracted.pageIndex + 1}.html`,
          width: extracted.pageWidth,
          height: extracted.pageHeight
        });
        await jobStore.updateJob(job.id, { processedPages: extracted.pageIndex + 1 });
        await logger.info("pdf2htmlEX-page.saved", { pageNumber: extracted.pageIndex + 1, width: extracted.pageWidth, height: extracted.pageHeight });
      }, logger, { targetWidthPx: job.targetWidthPx });
      await completeSourceManifest(job, sourcePages);
      await jobStore.updateJob(job.id, { status: ExtractionStatus.done, pageCount });
      await logger.info("extraction.done", { pageCount, engine: "pdf2htmlEX" });
      return;
    }

    await logger.info("font-extraction.start");
    const fontManifest = await extractFontManifest(job.filePath, job.id);
    await logger.info("font-extraction.done", { fonts: fontManifest.fonts.length });
    let pageCount = 0;
    await extractWithMuPdf(job.filePath, profile, dpi, async (extracted, totalPages) => {
      if (pageCount === 0) {
        pageCount = totalPages;
        await jobStore.updateJob(job.id, { pageCount });
      }
      const merged = mergeSpans(extracted.spans, profile, extracted.leftMarginPx);
      const classified = applyClassifierResults(
        merged,
        await classifyBlocks(merged, { pageWidth: extracted.pageWidth, pageHeight: extracted.pageHeight } as PageResult),
        extracted.pageWidth,
        profile
      );
      const built = buildPageArtifacts(job.id, extracted, profile, classified, fontManifest.fonts);
      await jobStore.savePageArtifacts(
        job.id,
        extracted.pageIndex,
        {
          page: built.page,
          reviewHtmlContent: built.reviewHtml,
          reviewCssContent: built.reviewCssContent
        },
        extracted.imageBytes
      );
      sourcePages.push({
        pageIndex: extracted.pageIndex,
        sourcePath: `source.pdf#page=${extracted.pageIndex + 1}`,
        reviewPath: `review/page-${extracted.pageIndex + 1}.html`,
        width: extracted.pageWidth,
        height: extracted.pageHeight
      });

      await jobStore.updateJob(job.id, { processedPages: extracted.pageIndex + 1 });
      await logger.info("page.artifacts.saved", { pageNumber: extracted.pageIndex + 1, blocks: built.page.blocks.length, width: extracted.pageWidth, height: extracted.pageHeight });
    }, logger, { targetWidthPx: job.targetWidthPx });
    // If pdf2htmlEX was enabled and succeeded, it is already available for the review UI
    // under /storage/jobs/<jobId>/pdf2htmlex/page-<n>.html.
    void pdf2htmlExReady;
    await completeSourceManifest(job, sourcePages);
    await jobStore.updateJob(job.id, { status: ExtractionStatus.done, pageCount });
    await logger.info("extraction.done", { pageCount, engine: "mupdf" });
  } catch (error) {
    await logger.error("extraction.error", error);
    const manifest = await jobStore.getSourceManifest(job.id);
    if (manifest) {
      await jobStore.saveSourceManifest(job.id, {
        ...manifest,
        status: "failed",
        warnings: [...manifest.warnings, error instanceof Error ? error.message : "Extraction failed"],
        updatedAt: new Date().toISOString()
      });
    }
    await jobStore.updateJob(job.id, {
      status: ExtractionStatus.failed,
      errorMessage: error instanceof Error ? error.message : "Extraction failed"
    });
    throw error;
  } finally {
    await jobStore.markInactive(job.id);
  }
}

export function getActiveEngine(): string {
  return activeEngine;
}
