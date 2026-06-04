import { readFile, mkdir, readdir, copyFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { jobStore } from "./jobStore.js";
import { renderFinalBackgroundPng } from "./finalBackgroundService.js";
import { latexToMathMl } from "./mathMlService.js";

export type SemanticBoxTag = "p" | "h1" | "h2" | "h3" | "caption" | "img" | "equation";

export interface SemanticBox {
  id: string;
  tag: SemanticBoxTag;
  x: number;
  y: number;
  w: number;
  h: number;
  createdAt: string;
  math?: {
    latex?: string;
    mathml?: string;
    mathmlStatus?: "pending" | "ok" | "failed";
    mathmlError?: string;
    renderStyle?: {
      fontSizePx: number;
      color: string;
      fontFamily: string;
      cssFontFamily: string;
      leftOffsetPx: number;
      topOffsetPx: number;
      widthPx: number;
      heightPx: number;
      sourceWordCount: number;
    };
    status?: "pending" | "ok" | "unavailable" | "failed";
    engine?: string;
    error?: string;
    cropFileName?: string;
    recognizedAt?: string;
  };
}

type WordStyle = {
  index: number;
  x: number;
  y: number;
  w: number;
  h: number;
  fontSizePx: number;
  fontFamily: string;
  fontWeight: string;
  fontStyle: string;
  color: string;
  transform: string;
  transformOrigin: string;
  rotation: number;
  text: string;
};

type CssDeclarations = Record<string, string>;
type CropSemanticBox = SemanticBox & { tag: "img" | "equation" };
type TextSemanticBox = SemanticBox & { tag: Exclude<SemanticBoxTag, CropSemanticBox["tag"]> };
type EquationRenderStyle = NonNullable<NonNullable<SemanticBox["math"]>["renderStyle"]>;

const INHERITED_WORD_STYLE_KEYS = [
  "font-family",
  "font-size",
  "font-weight",
  "font-style",
  "color"
];

const STYLE_OUTPUT_ORDER = [
  "font-family",
  "font-size",
  "font-weight",
  "font-style",
  "color",
  "line-height"
];

function boxesIntersect(a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

function boxIntersectionArea(a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }): number {
  const width = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const height = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  return width * height;
}

function wordBoxOverlapRatio(wordBounds: { x: number; y: number; w: number; h: number }, box: SemanticBox): number {
  const wordArea = Math.max(1, wordBounds.w * wordBounds.h);
  return boxIntersectionArea(wordBounds, box) / wordArea;
}

function wordCenterInsideBox(wordBounds: { x: number; y: number; w: number; h: number }, box: SemanticBox): boolean {
  const centerX = wordBounds.x + wordBounds.w / 2;
  const centerY = wordBounds.y + wordBounds.h / 2;
  return centerX >= box.x && centerX <= box.x + box.w && centerY >= box.y && centerY <= box.y + box.h;
}

function wordCanBeClaimedByBox(wordBounds: { x: number; y: number; w: number; h: number }, box: SemanticBox, overlapRatio: number): boolean {
  if (isCropBox(box)) {
    return overlapRatio >= 0.7 || (overlapRatio >= 0.25 && wordCenterInsideBox(wordBounds, box));
  }
  return overlapRatio >= 0.15;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function isTextBox(box: SemanticBox): box is TextSemanticBox {
  return box.tag !== "img" && box.tag !== "equation";
}

function isCropBox(box: SemanticBox): box is CropSemanticBox {
  return box.tag === "img" || box.tag === "equation";
}

function cssSingleQuoted(value: string): string {
  return `'${String(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

function parseWordCss(pageNumber: number, cssText: string): Map<number, Omit<WordStyle, "text" | "index">> {
  const map = new Map<number, Omit<WordStyle, "text" | "index">>();
  const ruleRegex = new RegExp(`\\.page${pageNumber}__word(\\d+)\\s*\\{([^}]*)\\}`, "g");
  for (const m of cssText.matchAll(ruleRegex)) {
    const index = Number(m[1]);
    const body = String(m[2] ?? "");
    const getNum = (prop: string): number => {
      const mm = body.match(new RegExp(`${prop}\\s*:\\s*(-?[0-9.]+)px`, "i"));
      return mm ? Number(mm[1]) : 0;
    };
    const getStr = (prop: string): string => {
      const mm = body.match(new RegExp(`${prop}\\s*:\\s*([^;]+);`, "i"));
      return mm ? mm[1].trim() : "";
    };
    map.set(index, {
      x: getNum("left"),
      y: getNum("top"),
      w: getNum("width"),
      h: getNum("height"),
      fontSizePx: getNum("font-size"),
      fontFamily: getStr("font-family").replace(/,\s*serif$/i, "").replace(/^['"]|['"]$/g, ""),
      fontWeight: getStr("font-weight") || "normal",
      fontStyle: getStr("font-style") || "normal",
      color: getStr("color") || "#000000",
      transform: getStr("transform"),
      transformOrigin: getStr("transform-origin") || "top left",
      rotation: parseRotation(getStr("transform"))
    });
  }
  return map;
}

function parseRotation(transform: string): number {
  const match = transform.match(/rotate\(\s*(-?[0-9.]+)deg\s*\)/i);
  return match ? Number(match[1]) : 0;
}

function parseWordHtml(pageNumber: number, html: string): Map<number, string> {
  const map = new Map<number, string>();
  const spanRegex = new RegExp(`<span[^>]*class="[^"]*\\bpage${pageNumber}__word(\\d+)\\b[^"]*"[^>]*>([\\s\\S]*?)<\\/span>`, "g");
  for (const m of html.matchAll(spanRegex)) {
    const index = Number(m[1]);
    const inner = String(m[2] ?? "");
    // page words are plain text (escaped); decode minimal entities we used.
    const text = inner
      .replace(/<[^>]+>/g, "")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, "\"")
      .replace(/&#39;/g, "'");
    map.set(index, text);
  }
  return map;
}

function stripPageWordRules(pageNumber: number, cssText: string): string {
  const ruleRegex = new RegExp(`\\n?\\.page${pageNumber}__word\\d+\\s*\\{[^}]*\\}\\s*`, "g");
  return cssText
    .replace(ruleRegex, "\n")
    .replace(/\n?\.page__word\s*\{[^}]*\}\s*/g, "\n")
    .replace(/\n{3,}/g, "\n\n");
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function groupWordsIntoLines(words: WordStyle[]): WordStyle[][] {
  const sorted = [...words].sort((a, b) => (a.y - b.y) || (a.x - b.x));
  const lines: WordStyle[][] = [];
  for (const word of sorted) {
    const tolerance = Math.max(2, word.h * 0.45);
    const line = lines.find((candidate) => Math.abs(median(candidate.map((w) => w.y)) - word.y) <= tolerance);
    if (line) {
      line.push(word);
    } else {
      lines.push([word]);
    }
  }
  return lines
    .map((line) => line.sort((a, b) => a.x - b.x))
    .sort((a, b) => median(a.map((w) => w.y)) - median(b.map((w) => w.y)));
}

function isRotatedWord(word: WordStyle): boolean {
  return Math.abs(word.rotation) > 0.01;
}

function wordVisualBounds(word: WordStyle): { x: number; y: number; w: number; h: number } {
  if (word.rotation === -90) return { x: word.x, y: word.y - word.w, w: word.h, h: word.w };
  if (word.rotation === 90) return { x: word.x - word.h, y: word.y, w: word.h, h: word.w };
  if (Math.abs(word.rotation) === 180) return { x: word.x - word.w, y: word.y - word.h, w: word.w, h: word.h };
  return { x: word.x, y: word.y, w: word.w, h: word.h };
}

function formatPx(value: number): string {
  return `${Number(value.toFixed(3))}px`;
}

function wordInheritedStyles(word: WordStyle): CssDeclarations {
  return {
    "font-family": `${cssSingleQuoted(word.fontFamily)}, serif`,
    "font-size": formatPx(word.fontSizePx),
    "font-weight": word.fontWeight,
    "font-style": word.fontStyle,
    color: word.color
  };
}

function commonDeclarations(declarations: CssDeclarations[], keys: string[]): CssDeclarations {
  if (!declarations.length) return {};
  const common: CssDeclarations = {};
  for (const key of keys) {
    const firstValue = declarations[0][key];
    if (typeof firstValue !== "string") continue;
    if (declarations.every((entry) => entry[key] === firstValue)) {
      common[key] = firstValue;
    }
  }
  return common;
}

function subtractDeclarations(declarations: CssDeclarations, inherited: CssDeclarations): CssDeclarations {
  const result: CssDeclarations = {};
  for (const [property, value] of Object.entries(declarations)) {
    if (inherited[property] !== value) result[property] = value;
  }
  return result;
}

function declarationsToCss(declarations: CssDeclarations): string {
  const orderedProperties = [
    ...STYLE_OUTPUT_ORDER,
    ...Object.keys(declarations).filter((property) => !STYLE_OUTPUT_ORDER.includes(property))
  ];
  return orderedProperties
    .filter((property, index, properties) => properties.indexOf(property) === index)
    .filter((property) => typeof declarations[property] === "string")
    .map((property) => `${property}: ${declarations[property]};`)
    .join(" ");
}

function styleClassName(prefix: string, index: number): string {
  return `${prefix}${index}`;
}

function createStyleClassRegistry() {
  const counters = new Map<string, number>();
  const byKey = new Map<string, string>();
  const rules: string[] = [];
  return {
    use(prefix: string, declarations: CssDeclarations): string {
      const cssText = declarationsToCss(declarations);
      if (!cssText) return "";
      const key = `${prefix}\u0000${cssText}`;
      const existing = byKey.get(key);
      if (existing) return existing;
      const nextIndex = (counters.get(prefix) ?? 0) + 1;
      counters.set(prefix, nextIndex);
      const className = styleClassName(prefix, nextIndex);
      byKey.set(key, className);
      rules.push(`.${className} { ${cssText} }`);
      return className;
    },
    rules(): string[] {
      return rules;
    }
  };
}

function semanticStyleClasses(registry: ReturnType<typeof createStyleClassRegistry>, declarations: CssDeclarations): string[] {
  const classNames = [
    registry.use("f", declarations["font-family"] ? { "font-family": declarations["font-family"] } : {}),
    registry.use("fs", declarations["font-size"] ? { "font-size": declarations["font-size"] } : {}),
    registry.use("fw", declarations["font-weight"] ? { "font-weight": declarations["font-weight"] } : {}),
    registry.use("fst", declarations["font-style"] ? { "font-style": declarations["font-style"] } : {}),
    registry.use("c", declarations.color ? { color: declarations.color } : {}),
    registry.use("lh", declarations["line-height"] ? { "line-height": declarations["line-height"] } : {})
  ];
  return classNames.filter(Boolean);
}

function getWordBounds(words: WordStyle[]): { x: number; y: number; w: number; h: number } {
  const bounds = words.map(wordVisualBounds);
  const left = Math.min(...bounds.map((box) => box.x));
  const top = Math.min(...bounds.map((box) => box.y));
  const right = Math.max(...bounds.map((box) => box.x + box.w));
  const bottom = Math.max(...bounds.map((box) => box.y + box.h));
  return { x: left, y: top, w: right - left, h: bottom - top };
}

function dominantValue(words: WordStyle[], selector: (word: WordStyle) => string, fallback: string): string {
  if (!words.length) return fallback;
  const weights = new Map<string, number>();
  for (const word of words) {
    const value = selector(word).trim();
    if (!value) continue;
    const weight = Math.max(1, word.w * word.h);
    weights.set(value, (weights.get(value) ?? 0) + weight);
  }
  let bestValue = fallback;
  let bestWeight = -1;
  for (const [value, weight] of weights.entries()) {
    if (weight > bestWeight) {
      bestValue = value;
      bestWeight = weight;
    }
  }
  return bestValue;
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function mathCssFontFamily(sourceFontFamily: string): string {
  const fontFamily = sourceFontFamily.toLowerCase();
  if (fontFamily.includes("symbol") || fontFamily.includes("extra")) {
    return "'Cambria Math', 'STIX Two Math', 'Latin Modern Math', serif";
  }
  if (fontFamily.includes("times")) {
    return "'Times New Roman', 'Cambria Math', 'STIX Two Math', serif";
  }
  if (fontFamily.includes("calibri")) {
    return "'Cambria Math', Calibri, sans-serif";
  }
  return "'Cambria Math', 'STIX Two Math', 'Times New Roman', serif";
}

function inferEquationRenderStyle(box: SemanticBox, selectedWords: WordStyle[]): EquationRenderStyle {
  const usefulWords = selectedWords.filter((word) => word.fontSizePx > 0 && word.w > 0 && word.h > 0);
  if (!usefulWords.length) {
    const fontSizePx = Math.max(8, box.h * 0.82);
    return {
      fontSizePx: Number(fontSizePx.toFixed(3)),
      color: "#000000",
      fontFamily: "",
      cssFontFamily: "'Cambria Math', 'STIX Two Math', 'Times New Roman', serif",
      leftOffsetPx: 0,
      topOffsetPx: 0,
      widthPx: Number(box.w.toFixed(3)),
      heightPx: Number(box.h.toFixed(3)),
      sourceWordCount: 0
    };
  }

  const maxFontSize = Math.max(...usefulWords.map((word) => word.fontSizePx));
  const baseWords = usefulWords.filter((word) => word.fontSizePx >= maxFontSize * 0.78);
  const fontSizePx = clampNumber(median((baseWords.length ? baseWords : usefulWords).map((word) => word.fontSizePx)), 6, Math.max(8, box.h * 1.35));
  const sourceBounds = getWordBounds(usefulWords);
  const leftOffsetPx = clampNumber(sourceBounds.x - box.x, 0, Math.max(0, box.w - 1));
  const topOffsetPx = clampNumber(sourceBounds.y - box.y, 0, Math.max(0, box.h - 1));
  const widthPx = clampNumber(sourceBounds.w, 1, Math.max(1, box.w - leftOffsetPx));
  const heightPx = clampNumber(sourceBounds.h, 1, Math.max(1, box.h - topOffsetPx));
  const fontFamily = dominantValue(baseWords.length ? baseWords : usefulWords, (word) => word.fontFamily, "");

  return {
    fontSizePx: Number(fontSizePx.toFixed(3)),
    color: dominantValue(usefulWords, (word) => word.color, "#000000"),
    fontFamily,
    cssFontFamily: mathCssFontFamily(fontFamily),
    leftOffsetPx: Number(leftOffsetPx.toFixed(3)),
    topOffsetPx: Number(topOffsetPx.toFixed(3)),
    widthPx: Number(widthPx.toFixed(3)),
    heightPx: Number(heightPx.toFixed(3)),
    sourceWordCount: usefulWords.length
  };
}

function applyEquationRenderStyle(box: CropSemanticBox, renderStyle: EquationRenderStyle): void {
  if (box.tag !== "equation") return;
  box.math = {
    ...box.math,
    renderStyle
  };
}

function wordSpanHtml(pageNumber: number, word: WordStyle): string {
  return `<span class="page__word page${pageNumber}__word${word.index}" data-word-index="${word.index}">${escapeHtml(word.text)}</span>`;
}

function wordCssRule(pageNumber: number, word: WordStyle, offset?: { x: number; y: number }): string {
  const left = word.x - (offset?.x ?? 0);
  const top = word.y - (offset?.y ?? 0);
  const transformCss = word.transform ? ` transform-origin: ${word.transformOrigin}; transform: ${word.transform};` : "";
  return `.page${pageNumber}__word${word.index} { position: absolute; left: ${formatPx(left)}; top: ${formatPx(top)}; width: ${formatPx(word.w)}; height: ${formatPx(word.h)}; font-size: ${formatPx(word.fontSizePx)}; font-family: ${cssSingleQuoted(word.fontFamily)}, serif; font-weight: ${word.fontWeight}; font-style: ${word.fontStyle}; color: ${word.color}; white-space: nowrap; overflow: visible; background: transparent;${transformCss} }`;
}

function safeFileToken(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 80) || "crop";
}

export function semanticBoxCropFileName(pageNumber: number, box: Pick<SemanticBox, "id">): string {
  return `page-${pageNumber}-${safeFileToken(box.id)}.png`;
}

function pageElementId(pageNumber: number, type: "para" | "img" | "eq", index: number): string {
  return `page${String(pageNumber).padStart(4, "0")}_${type}${index}`;
}

function lineTop(line: WordStyle[]): number {
  return Math.min(...line.map((word) => word.y));
}

function lineLeft(line: WordStyle[]): number {
  return Math.min(...line.map((word) => word.x));
}

function lineBottom(line: WordStyle[]): number {
  return Math.max(...line.map((word) => word.y + word.h));
}

function lineHeight(lines: WordStyle[][], lineIndex: number): number {
  const currentTop = lineTop(lines[lineIndex]);
  const nextLine = lines[lineIndex + 1];
  if (nextLine) return Math.max(0, lineTop(nextLine) - currentTop);
  return Math.max(0, lineBottom(lines[lineIndex]) - currentTop);
}

function renderedLineHeight(line: WordStyle[]): number {
  return Math.max(...line.map((word) => word.h));
}

function lineGapValues(line: WordStyle[]): number[] {
  const gaps: number[] = [];
  for (let wordIndex = 0; wordIndex < line.length - 1; wordIndex += 1) {
    const word = line[wordIndex];
    const nextWord = line[wordIndex + 1];
    gaps.push(Math.max(0, nextWord.x - (word.x + word.w)));
  }
  return gaps;
}

function commonLineGap(line: WordStyle[]): number | null {
  const gaps = lineGapValues(line);
  if (!gaps.length) return null;
  const averageGap = gaps.reduce((sum, gap) => sum + gap, 0) / gaps.length;
  const maxDeviation = Math.max(...gaps.map((gap) => Math.abs(gap - averageGap)));
  return maxDeviation <= 0.05 ? averageGap : null;
}

function flowWordCssRule(pageNumber: number, word: WordStyle, line: WordStyle[], wordIndex: number, inherited: CssDeclarations, lineGap: number | null): string | null {
  const nextWord = line[wordIndex + 1];
  const rawMarginRight = nextWord ? Math.max(0, nextWord.x - (word.x + word.w)) : 0;
  const marginRight = nextWord && lineGap !== null ? Math.max(0, rawMarginRight - lineGap) : rawMarginRight;
  const marginTop = Math.max(0, word.y - lineTop(line));
  const normalizedMarginTop = marginTop <= 0.05 ? 0 : marginTop;
  const normalizedMarginRight = marginRight <= 0.05 ? 0 : marginRight;
  const declarations: CssDeclarations = subtractDeclarations(wordInheritedStyles(word), inherited);
  const layoutDeclarations: CssDeclarations = {};
  if (normalizedMarginTop > 0 || normalizedMarginRight > 0) {
    layoutDeclarations.margin = `${formatPx(normalizedMarginTop)} ${formatPx(normalizedMarginRight)} 0 0`;
  }
  const cssText = declarationsToCss({ ...layoutDeclarations, ...declarations });
  return cssText ? `.page${pageNumber}__word${word.index} { ${cssText} }` : null;
}

async function copyFileOrKeepExisting(sourcePath: string, targetPath: string): Promise<void> {
  try {
    await copyFile(sourcePath, targetPath);
  } catch (error) {
    const existing = await stat(targetPath).catch(() => null);
    if (existing?.isFile()) return;
    throw error;
  }
}

async function writeFinalPageImage(jobId: string, pageIndex: number, targetPath: string): Promise<void> {
  const imageBytes = await renderFinalBackgroundPng(jobId, pageIndex, jobStore.getImagePath(jobId, pageIndex));
  try {
    await writeFile(targetPath, imageBytes);
  } catch (error) {
    const existing = await stat(targetPath).catch(() => null);
    if (existing?.isFile()) return;
    throw error;
  }
}

async function writeFinalTextFile(targetPath: string, content: string): Promise<void> {
  const tempPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(tempPath, content, "utf8");
  } catch {
    await writeFile(targetPath, content, "utf8");
    return;
  }
  try {
    await rename(tempPath, targetPath);
  } catch {
    await writeFile(targetPath, content, "utf8");
  }
}

async function writeBinaryFileOrKeepExisting(targetPath: string, content: Uint8Array): Promise<void> {
  try {
    await writeFile(targetPath, content);
  } catch (error) {
    const existing = await stat(targetPath).catch(() => null);
    if (existing?.isFile()) return;
    throw error;
  }
}

async function writeImageCrops(
  jobId: string,
  pageIndex: number,
  imageBlocks: Array<{ box: CropSemanticBox; fileName: string }>,
  finalCropDir: string
): Promise<void> {
  if (!imageBlocks.length) return;
  const sourceImage = await loadImage(jobStore.getImagePath(jobId, pageIndex));
  const sourceWidth = Math.max(1, sourceImage.width);
  const sourceHeight = Math.max(1, sourceImage.height);
  for (const block of imageBlocks) {
    const sourceX = Math.min(sourceWidth - 1, Math.max(0, Math.round(block.box.x)));
    const sourceY = Math.min(sourceHeight - 1, Math.max(0, Math.round(block.box.y)));
    const sourceW = Math.max(1, Math.min(Math.round(block.box.w), sourceWidth - sourceX));
    const sourceH = Math.max(1, Math.min(Math.round(block.box.h), sourceHeight - sourceY));
    const canvas = createCanvas(sourceW, sourceH);
    const context = canvas.getContext("2d");
    context.drawImage(sourceImage, sourceX, sourceY, sourceW, sourceH, 0, 0, sourceW, sourceH);
    await writeBinaryFileOrKeepExisting(path.join(finalCropDir, block.fileName), new Uint8Array(canvas.toBuffer("image/png")));
  }
}

export async function writeSemanticBoxCrop(jobId: string, pageIndex: number, box: Pick<SemanticBox, "x" | "y" | "w" | "h">, fileName: string, finalCropDir: string): Promise<string> {
  await mkdir(finalCropDir, { recursive: true });
  const sourceImage = await loadImage(jobStore.getImagePath(jobId, pageIndex));
  const sourceWidth = Math.max(1, sourceImage.width);
  const sourceHeight = Math.max(1, sourceImage.height);
  const sourceX = Math.min(sourceWidth - 1, Math.max(0, Math.round(box.x)));
  const sourceY = Math.min(sourceHeight - 1, Math.max(0, Math.round(box.y)));
  const sourceW = Math.max(1, Math.min(Math.round(box.w), sourceWidth - sourceX));
  const sourceH = Math.max(1, Math.min(Math.round(box.h), sourceHeight - sourceY));
  const canvas = createCanvas(sourceW, sourceH);
  const context = canvas.getContext("2d");
  context.drawImage(sourceImage, sourceX, sourceY, sourceW, sourceH, 0, 0, sourceW, sourceH);
  const cropPath = path.join(finalCropDir, fileName);
  await writeBinaryFileOrKeepExisting(cropPath, new Uint8Array(canvas.toBuffer("image/png")));
  return cropPath;
}

export async function generateFinalPageFromBoxes(jobId: string, pageIndex: number, boxes: SemanticBox[]): Promise<void> {
  const pageNumber = pageIndex + 1;
  const reviewHtmlPath = path.join(jobStore.getReviewDir(jobId), `page-${pageNumber}.html`);
  const reviewCssPath = path.join(jobStore.getReviewStylesDir(jobId), `page-${pageNumber}.css`);
  const [html, css] = await Promise.all([
    readFile(reviewHtmlPath, "utf8"),
    readFile(reviewCssPath, "utf8")
  ]);

  const cssMap = parseWordCss(pageNumber, css);
  const htmlMap = parseWordHtml(pageNumber, html);

  const words: WordStyle[] = [];
  for (const [index, style] of cssMap.entries()) {
    const text = htmlMap.get(index);
    if (typeof text !== "string") continue;
    words.push({ index, ...style, text });
  }

  const byIndex = new Map(words.map((w) => [w.index, w]));

  words.sort((a, b) => (a.y - b.y) || (a.x - b.x));

  const paraBlocks: Array<{ box: SemanticBox; wordIndices: number[] }> = boxes.map((box) => ({ box, wordIndices: [] }));
  for (const word of words) {
    const wordBounds = wordVisualBounds(word);
    let bestBoxIndex = -1;
    let bestOverlapRatio = 0;
    boxes.forEach((box, index) => {
      const overlapRatio = wordBoxOverlapRatio(wordBounds, box);
      if (!wordCanBeClaimedByBox(wordBounds, box, overlapRatio)) return;
      if (overlapRatio > bestOverlapRatio) {
        bestBoxIndex = index;
        bestOverlapRatio = overlapRatio;
      }
    });
    if (bestBoxIndex >= 0) {
      paraBlocks[bestBoxIndex].wordIndices.push(word.index);
    }
  }

  const claimed = new Set<number>();
  for (const block of paraBlocks) {
    block.wordIndices.sort((a, b) => {
      const wa = byIndex.get(a);
      const wb = byIndex.get(b);
      if (!wa || !wb) return a - b;
      return (wa.y - wb.y) || (wa.x - wb.x);
    });
    block.wordIndices.forEach((wordIndex) => claimed.add(wordIndex));
  }

  const semanticBlocks = paraBlocks
    .map((block, i) => {
      if (!isTextBox(block.box)) return null;
      const selectedWords = block.wordIndices
        .map((wordIndex) => byIndex.get(wordIndex))
        .filter((word): word is WordStyle => Boolean(word));
      if (!selectedWords.length) return null;
      return {
        box: block.box,
        elementId: pageElementId(pageNumber, "para", i + 1),
        className: `page${pageNumber}-para${i + 1}`,
        selectedWords,
        isAbsolute: selectedWords.some(isRotatedWord),
        lines: selectedWords.some(isRotatedWord) ? [] : groupWordsIntoLines(selectedWords),
        bounds: getWordBounds(selectedWords)
      };
    })
    .filter((block): block is {
      box: TextSemanticBox;
      elementId: string;
      className: string;
      selectedWords: WordStyle[];
      isAbsolute: boolean;
      lines: WordStyle[][];
      bounds: { x: number; y: number; w: number; h: number };
    } => Boolean(block));

  const cropBlocks = paraBlocks
    .filter((block): block is { box: CropSemanticBox; wordIndices: number[] } => isCropBox(block.box))
    .map((block, i) => {
      const selectedWords = block.wordIndices
        .map((wordIndex) => byIndex.get(wordIndex))
        .filter((word): word is WordStyle => Boolean(word));
      const renderStyle = block.box.tag === "equation"
        ? inferEquationRenderStyle(block.box, selectedWords)
        : null;
      if (renderStyle) applyEquationRenderStyle(block.box, renderStyle);
      return {
        box: block.box,
        elementId: pageElementId(pageNumber, block.box.tag === "equation" ? "eq" : "img", i + 1),
        className: `page${pageNumber}-${block.box.tag === "equation" ? "eq" : "img"}${i + 1}`,
        fileName: semanticBoxCropFileName(pageNumber, block.box),
        selectedWords,
        renderStyle
      };
    });

  const styleClassRegistry = createStyleClassRegistry();
  const baseParaClass = styleClassRegistry.use("s", {
    position: "absolute",
    display: "block",
    margin: "0",
    padding: "0",
    border: "0",
    background: "transparent",
    "white-space": "pre",
    overflow: "visible",
    "z-index": "1"
  });
  const semanticModels = semanticBlocks.map((block) => {
    if (block.isAbsolute) {
      const parentStyles = commonDeclarations(block.selectedWords.map(wordInheritedStyles), STYLE_OUTPUT_ORDER);
      return {
        ...block,
        classNames: [baseParaClass, ...semanticStyleClasses(styleClassRegistry, parentStyles), "page__para", "page__para--absolute", block.className].filter(Boolean),
        parentStyles,
        lineModels: [] as Array<{ line: WordStyle[]; commonGap: number | null; styles: CssDeclarations }>
      };
    }
    const lineModels = block.lines.map((line) => {
      const commonWordStyles = commonDeclarations(line.map(wordInheritedStyles), INHERITED_WORD_STYLE_KEYS);
      return {
        line,
        commonGap: commonLineGap(line),
        styles: {
          ...commonWordStyles,
          "line-height": formatPx(renderedLineHeight(line))
        }
      };
    });
    const parentStyles = commonDeclarations(lineModels.map((lineModel) => lineModel.styles), STYLE_OUTPUT_ORDER);
    return {
      ...block,
      classNames: [baseParaClass, ...semanticStyleClasses(styleClassRegistry, parentStyles), "page__para", block.className].filter(Boolean),
      parentStyles,
      lineModels
    };
  });

  // Build final HTML: semantic parents own only grouping and origin; words keep their own extracted styles.
  const semanticElements = semanticModels.map((block) => {
    const classAttr = block.classNames.join(" ");
    if (block.isAbsolute) {
      return `<${block.box.tag} id="${block.elementId}" class="${classAttr}" data-box-id="${escapeHtml(block.box.id)}">${block.selectedWords.map((word) => wordSpanHtml(pageNumber, word)).join("")}</${block.box.tag}>`;
    }
    const lineHtml = block.lines
      .map((line, lineIndex) => `<span class="page__line ${block.className}__line${lineIndex + 1}">${line.map((word) => wordSpanHtml(pageNumber, word)).join("")}</span>`)
      .join("");
    return `<${block.box.tag} id="${block.elementId}" class="${classAttr}" data-box-id="${escapeHtml(block.box.id)}">${lineHtml}</${block.box.tag}>`;
  }).join("\n");

  // Unboxed words remain absolutely positioned as before.
  const leftoverWords = words
    .filter((w) => !claimed.has(w.index))
    .map((w) => wordSpanHtml(pageNumber, w))
    .join("\n");

  const imageElements = cropBlocks
    .map((block) => {
      if (block.box.tag === "equation") {
        const latex = block.box.math?.latex ?? "";
        const status = block.box.math?.status ?? "pending";
        const existingMathMl = block.box.math?.mathml?.trim() ?? "";
        const generatedMathMl = !existingMathMl && latex ? latexToMathMl(latex) : null;
        const mathml = existingMathMl || generatedMathMl?.mathml || "";
        const mathmlStatus = mathml ? "ok" : latex ? "failed" : "pending";
        const mathmlError = block.box.math?.mathmlError ?? generatedMathMl?.error ?? "";
        const latexAttr = latex ? ` data-latex="${escapeHtml(latex)}"` : "";
        const errorAttr = status !== "ok" && block.box.math?.error ? ` data-math-error="${escapeHtml(block.box.math.error)}"` : "";
        const mathmlErrorAttr = mathmlError ? ` data-mathml-error="${escapeHtml(mathmlError)}"` : "";
        const mathmlAttr = ` data-mathml-status="${escapeHtml(mathmlStatus)}"`;
        const renderStyle = block.renderStyle;
        const styleAttrs = renderStyle
          ? ` data-source-font-size="${escapeHtml(String(renderStyle.fontSizePx))}" data-source-font-family="${escapeHtml(renderStyle.fontFamily)}" data-source-word-count="${escapeHtml(String(renderStyle.sourceWordCount))}"`
          : "";
        const className = ["page__crop", "math-zone", "equation-zone", mathml ? "math-zone--mathml" : "math-zone--crop", block.className].join(" ");
        const cropImage = `<img class="math-crop-fallback" src="./images/crops/${escapeHtml(block.fileName)}" alt="Equation">`;
        const mathMlHtml = mathml ? `<span class="mathml-render">${mathml}</span>` : "";
        return `<figure id="${block.elementId}" class="${className}" data-box-id="${escapeHtml(block.box.id)}" data-math-status="${escapeHtml(status)}"${mathmlAttr}${latexAttr}${styleAttrs}${errorAttr}${mathmlErrorAttr}>${mathMlHtml}${cropImage}${latex ? `<figcaption class="math-latex">${escapeHtml(latex)}</figcaption>` : ""}</figure>`;
      }
      return `<img id="${block.elementId}" class="page__crop ${block.className}" src="./images/crops/${escapeHtml(block.fileName)}" alt="">`;
    })
    .join("\n");

  const finalHtml = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="./style/page-${pageNumber}.css">
</head>
<body>
<div class="page">
<img class="page__bg" src="./images/page-${pageNumber}.png" alt="">
<div class="page__text">
${semanticElements}
${leftoverWords}
${imageElements}
</div>
</div>
</body>
</html>`;

  // Build final CSS: include font faces, common rules. Keep word rules but only for leftovers and for debug.
  const commonCss = `html, body { margin: 0; padding: 0; }
.page { position: relative; overflow: hidden; }
.page__bg { position: absolute; inset: 0; width: 100%; height: 100%; z-index: 0; pointer-events: none; }
.page__text { position: absolute; inset: 0; z-index: 1; }
.page__word { user-select: text; }
.page__text > .page__word { position: absolute; margin: 0; padding: 0; white-space: nowrap; overflow: visible; background: transparent; z-index: 1; }
.page__para { position: absolute; margin: 0; padding: 0; border: 0; background: transparent; white-space: pre; overflow: visible; z-index: 1; }
.page__para--absolute .page__word { position: absolute; margin: 0; padding: 0; white-space: nowrap; overflow: visible; background: transparent; }
.page__line { display: flex; align-items: flex-start; margin: 0; padding: 0; box-sizing: border-box; white-space: nowrap; overflow: visible; }
.page__crop { position: absolute; display: block; margin: 0; padding: 0; border: 0; object-fit: fill; z-index: 2; }
.math-zone { background: transparent; overflow: visible; }
.math-crop-fallback { display: block; width: 100%; height: 100%; object-fit: fill; }
.math-zone--mathml .math-crop-fallback { display: none; }
.mathml-render { position: absolute; display: block; color: #000; line-height: 1; overflow: visible; transform-origin: top left; }
.mathml-render math { font-size: 1em; }
.math-latex { display: none; }`;

  const paraCssBlocks: string[] = [];
  const lineCssBlocks: string[] = [];
  const semanticWordRules: string[] = [];
  const imageCssBlocks = cropBlocks.map((block) => {
    const renderStyle = block.renderStyle;
    const fontSize = renderStyle ? ` font-size: ${formatPx(renderStyle.fontSizePx)};` : "";
    const color = renderStyle ? ` color: ${renderStyle.color};` : "";
    const fontFamily = renderStyle ? ` font-family: ${renderStyle.cssFontFamily};` : "";
    const baseRule = `#${block.elementId} { left: ${formatPx(block.box.x)}; top: ${formatPx(block.box.y)}; width: ${formatPx(block.box.w)}; height: ${formatPx(block.box.h)};${fontSize}${color}${fontFamily} }`;
    if (!renderStyle) return baseRule;
    return `${baseRule}\n#${block.elementId} .mathml-render { left: ${formatPx(renderStyle.leftOffsetPx)}; top: ${formatPx(renderStyle.topOffsetPx)}; width: ${formatPx(renderStyle.widthPx)}; height: ${formatPx(renderStyle.heightPx)}; }`;
  });
  for (const block of semanticModels) {
    if (block.isAbsolute) {
      paraCssBlocks.push(`#${block.elementId} { left: ${formatPx(block.bounds.x)}; top: ${formatPx(block.bounds.y)}; width: ${formatPx(block.bounds.w)}; height: ${formatPx(block.bounds.h)}; }`);
      for (const word of block.selectedWords) {
        semanticWordRules.push(`.${block.className} ${wordCssRule(pageNumber, word, block.bounds)}`);
      }
      continue;
    }
    paraCssBlocks.push(`#${block.elementId} { left: ${formatPx(block.bounds.x)}; top: ${formatPx(block.bounds.y)}; }`);
    block.lineModels.forEach((lineModel, lineIndex) => {
      const { line, commonGap, styles } = lineModel;
      const lineClassName = `${block.className}__line${lineIndex + 1}`;
      const lineStyles = subtractDeclarations(styles, block.parentStyles);
      const lineLayout: CssDeclarations = {
        height: formatPx(lineHeight(block.lines, lineIndex)),
        "padding-left": formatPx(lineLeft(line) - block.bounds.x)
      };
      if (commonGap !== null) lineLayout["column-gap"] = formatPx(commonGap);
      const lineCss = declarationsToCss({ ...lineStyles, ...lineLayout });
      lineCssBlocks.push(`.${lineClassName} { ${lineCss} }`);
      line.forEach((word, wordIndex) => {
        const wordRule = flowWordCssRule(pageNumber, word, line, wordIndex, styles, commonGap);
        if (wordRule) semanticWordRules.push(`.${block.className} ${wordRule}`);
      });
    });
  }

  const wordRules = words
    .filter((w) => !claimed.has(w.index))
    .map((w) => wordCssRule(pageNumber, w))
    .join("\n");

  const finalCss = `${stripPageWordRules(pageNumber, css)}\n\n${commonCss}\n\n${styleClassRegistry.rules().join("\n")}\n\n${paraCssBlocks.join("\n")}\n\n${lineCssBlocks.join("\n")}\n\n${semanticWordRules.join("\n")}\n\n${imageCssBlocks.join("\n")}\n\n${wordRules}`;

  const finalDir = jobStore.getFinalDir(jobId);
  const finalStyleDir = path.join(finalDir, "style");
  const finalImagesDir = path.join(finalDir, "images");
  const finalCropDir = path.join(finalImagesDir, "crops");
  const finalFontsDir = path.join(finalDir, "fonts");
  await mkdir(finalStyleDir, { recursive: true });
  await mkdir(finalImagesDir, { recursive: true });
  await mkdir(finalCropDir, { recursive: true });
  await mkdir(finalFontsDir, { recursive: true });

  // Copy page image and all fonts into final (simple, safe).
  await writeFinalPageImage(jobId, pageIndex, path.join(finalImagesDir, `page-${pageNumber}.png`));
  await writeImageCrops(jobId, pageIndex, cropBlocks, finalCropDir);
  const fontEntries = await readdir(jobStore.getFontsDir(jobId)).catch(() => []);
  for (const entry of fontEntries) {
    if (!entry || entry.endsWith(".json")) continue;
    await copyFile(path.join(jobStore.getFontsDir(jobId), entry), path.join(finalFontsDir, entry)).catch(() => void 0);
  }

  await Promise.all([
    writeFinalTextFile(path.join(finalDir, `page-${pageNumber}.html`), finalHtml),
    writeFinalTextFile(path.join(finalStyleDir, `page-${pageNumber}.css`), finalCss)
  ]);
}
