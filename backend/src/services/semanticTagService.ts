import { readFile, mkdir, readdir, copyFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { jobStore } from "./jobStore.js";

export type SemanticBoxTag = "p" | "h1" | "h2" | "h3" | "caption" | "img";

export interface SemanticBox {
  id: string;
  tag: SemanticBoxTag;
  x: number;
  y: number;
  w: number;
  h: number;
  createdAt: string;
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
  text: string;
};

type CssDeclarations = Record<string, string>;
type TextSemanticBox = SemanticBox & { tag: Exclude<SemanticBoxTag, "img"> };

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

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function isTextBox(box: SemanticBox): box is TextSemanticBox {
  return box.tag !== "img";
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
      const mm = body.match(new RegExp(`${prop}\\s*:\\s*([0-9.]+)px`, "i"));
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
      color: getStr("color") || "#000000"
    });
  }
  return map;
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

function getWordBounds(words: WordStyle[]): { x: number; y: number; w: number; h: number } {
  const left = Math.min(...words.map((word) => word.x));
  const top = Math.min(...words.map((word) => word.y));
  const right = Math.max(...words.map((word) => word.x + word.w));
  const bottom = Math.max(...words.map((word) => word.y + word.h));
  return { x: left, y: top, w: right - left, h: bottom - top };
}

function wordSpanHtml(pageNumber: number, word: WordStyle): string {
  return `<span class="page__word page${pageNumber}__word${word.index}" data-word-index="${word.index}">${escapeHtml(word.text)}</span>`;
}

function wordCssRule(pageNumber: number, word: WordStyle, offset?: { x: number; y: number }): string {
  const left = word.x - (offset?.x ?? 0);
  const top = word.y - (offset?.y ?? 0);
  return `.page${pageNumber}__word${word.index} { position: absolute; left: ${formatPx(left)}; top: ${formatPx(top)}; width: ${formatPx(word.w)}; height: ${formatPx(word.h)}; font-size: ${formatPx(word.fontSizePx)}; font-family: ${cssSingleQuoted(word.fontFamily)}, serif; font-weight: ${word.fontWeight}; font-style: ${word.fontStyle}; color: ${word.color}; white-space: nowrap; overflow: visible; background: transparent; }`;
}

function safeFileToken(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 80) || "crop";
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

async function writeImageCrops(
  jobId: string,
  pageIndex: number,
  imageBlocks: Array<{ box: SemanticBox; fileName: string }>,
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
    await writeFile(path.join(finalCropDir, block.fileName), new Uint8Array(canvas.toBuffer("image/png")));
  }
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

  const claimed = new Set<number>();
  const paraBlocks: Array<{ box: SemanticBox; wordIndices: number[] }> = [];
  for (const box of boxes) {
    const picked: number[] = [];
    for (const word of words) {
      if (claimed.has(word.index)) continue;
      if (boxesIntersect(box, word)) {
        picked.push(word.index);
        claimed.add(word.index);
      }
    }
    picked.sort((a, b) => {
      const wa = byIndex.get(a);
      const wb = byIndex.get(b);
      if (!wa || !wb) return a - b;
      return (wa.y - wb.y) || (wa.x - wb.x);
    });
    paraBlocks.push({ box, wordIndices: picked });
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
        className: `page${pageNumber}-para${i + 1}`,
        selectedWords,
        lines: groupWordsIntoLines(selectedWords),
        bounds: getWordBounds(selectedWords)
      };
    })
    .filter((block): block is {
      box: TextSemanticBox;
      className: string;
      selectedWords: WordStyle[];
      lines: WordStyle[][];
      bounds: { x: number; y: number; w: number; h: number };
    } => Boolean(block));

  const imageBlocks = paraBlocks
    .filter((block) => block.box.tag === "img")
    .map((block, i) => ({
      box: block.box,
      className: `page${pageNumber}-img${i + 1}`,
      fileName: `page-${pageNumber}-${safeFileToken(block.box.id)}.png`
    }));

  // Build final HTML: semantic parents own only grouping and origin; words keep their own extracted styles.
  const semanticElements = semanticBlocks.map((block) => {
    const lineHtml = block.lines
      .map((line, lineIndex) => `<span class="page__line ${block.className}__line${lineIndex + 1}">${line.map((word) => wordSpanHtml(pageNumber, word)).join("")}</span>`)
      .join("");
    return `<${block.box.tag} class="page__para ${block.className}" data-box-id="${escapeHtml(block.box.id)}">${lineHtml}</${block.box.tag}>`;
  }).join("\n");

  // Unboxed words remain absolutely positioned as before.
  const leftoverWords = words
    .filter((w) => !claimed.has(w.index))
    .map((w) => wordSpanHtml(pageNumber, w))
    .join("\n");

  const imageElements = imageBlocks
    .map((block) => `<img class="page__crop ${block.className}" src="./images/crops/${escapeHtml(block.fileName)}" alt="">`)
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
.page__line { display: flex; align-items: flex-start; margin: 0; padding: 0; box-sizing: border-box; white-space: nowrap; overflow: visible; }
.page__crop { position: absolute; display: block; margin: 0; padding: 0; border: 0; object-fit: fill; z-index: 2; }`;

  const paraCssBlocks: string[] = [];
  const lineCssBlocks: string[] = [];
  const semanticWordRules: string[] = [];
  const imageCssBlocks = imageBlocks.map((block) => `.${block.className} { left: ${formatPx(block.box.x)}; top: ${formatPx(block.box.y)}; width: ${formatPx(block.box.w)}; height: ${formatPx(block.box.h)}; }`);
  for (const block of semanticBlocks) {
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
    const parentCss = declarationsToCss(parentStyles);
    paraCssBlocks.push(`.${block.className} { left: ${formatPx(block.bounds.x)}; top: ${formatPx(block.bounds.y)};${parentCss ? ` ${parentCss}` : ""} }`);
    lineModels.forEach((lineModel, lineIndex) => {
      const { line, commonGap, styles } = lineModel;
      const lineClassName = `${block.className}__line${lineIndex + 1}`;
      const lineStyles = subtractDeclarations(styles, parentStyles);
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

  const finalCss = `${stripPageWordRules(pageNumber, css)}\n\n${commonCss}\n\n${paraCssBlocks.join("\n")}\n\n${lineCssBlocks.join("\n")}\n\n${semanticWordRules.join("\n")}\n\n${imageCssBlocks.join("\n")}\n\n${wordRules}`;

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
  await copyFileOrKeepExisting(jobStore.getImagePath(jobId, pageIndex), path.join(finalImagesDir, `page-${pageNumber}.png`));
  await writeImageCrops(jobId, pageIndex, imageBlocks, finalCropDir);
  const fontEntries = await readdir(jobStore.getFontsDir(jobId)).catch(() => []);
  for (const entry of fontEntries) {
    if (!entry || entry.endsWith(".json")) continue;
    await copyFile(path.join(jobStore.getFontsDir(jobId), entry), path.join(finalFontsDir, entry)).catch(() => void 0);
  }

  await Promise.all([
    writeFile(path.join(finalDir, `page-${pageNumber}.html`), finalHtml, "utf8"),
    writeFile(path.join(finalStyleDir, `page-${pageNumber}.css`), finalCss, "utf8")
  ]);
}
