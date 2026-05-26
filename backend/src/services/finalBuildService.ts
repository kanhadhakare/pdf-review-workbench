import { createCanvas, loadImage } from "@napi-rs/canvas";
import { type BlockStyles, type ExtractedFontAsset, type FixDelta, type PageResult, type SemanticChildSpan, type SemanticTag, type TextBlock } from "../types.js";
import { jobStore } from "./jobStore.js";

type MutableTextBlock = TextBlock & { imageCrop?: NonNullable<TextBlock["imageCrop"]> };

const TEXT_TAGS = new Set<SemanticTag>(["h1", "h2", "h3", "p", "span", "caption"]);

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function sanitizeAttr(value: string): string {
  return escapeHtml(value).replace(/\n/g, " ");
}

function sanitizeCssString(value: string): string {
  const cleaned = value.replace(/["\\\n\r]/g, " ").replace(/\s+/g, " ").trim();
  return cleaned || "serif";
}

function sanitizeColor(value: string | undefined): string {
  const normalized = (value ?? "#000000").trim();
  if (/^#[0-9A-Fa-f]{3,8}$/.test(normalized)) return normalized;
  if (/^rgba?\(\s*[\d.\s%,]+\)$/i.test(normalized)) return normalized;
  return "#000000";
}

function cleanPdfFontName(fontName: string): string {
  return fontName
    .replace(/^[A-Z]{6}\+/, "")
    .replace(/[^A-Za-z0-9_\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim() || "pdffont";
}

function normalizeFontKey(fontName: string): string {
  return cleanPdfFontName(fontName).replace(/[^A-Za-z0-9]/g, "").toLowerCase();
}

function isBrowserSafeFontFormat(format: ExtractedFontAsset["format"]): boolean {
  return format === "truetype" || format === "opentype" || format === "woff" || format === "woff2";
}

function cssFontFormat(format: ExtractedFontAsset["format"]): string {
  return format === "truetype" ? "truetype" : format === "woff" ? "woff" : format === "woff2" ? "woff2" : "opentype";
}

function fontFaceCss(fontAssets: ExtractedFontAsset[]): string {
  return fontAssets
    .filter((font) => isBrowserSafeFontFormat(font.format))
    .map((font) => `@font-face {
  font-family: "${sanitizeCssString(cleanPdfFontName(font.family))}";
  src: url("../fonts/${sanitizeAttr(font.fileName)}") format("${cssFontFormat(font.format)}");
  font-weight: ${font.fontWeight};
  font-style: ${font.fontStyle};
}`)
    .join("\n\n");
}

function resolveCssFontFamily(fontName: string, fontAssets: ExtractedFontAsset[]): string {
  const normalized = normalizeFontKey(fontName);
  const exact = fontAssets.find((font) => normalizeFontKey(font.baseFont) === normalized || normalizeFontKey(font.family) === normalized);
  if (exact) return sanitizeCssString(cleanPdfFontName(exact.family));
  const partial = fontAssets.find((font) => {
    const familyKey = normalizeFontKey(font.family);
    return familyKey.includes(normalized) || normalized.includes(familyKey);
  });
  return partial ? sanitizeCssString(cleanPdfFontName(partial.family)) : sanitizeCssString(cleanPdfFontName(fontName));
}

function resolveCssFontStyle(fontName: string, fontAssets: ExtractedFontAsset[]): "normal" | "italic" {
  const normalized = normalizeFontKey(fontName);
  const matched = fontAssets.find((font) => normalizeFontKey(font.baseFont) === normalized || normalizeFontKey(font.family) === normalized);
  return matched?.fontStyle ?? (/italic|oblique/i.test(fontName) ? "italic" : "normal");
}

function blockStyles(block: TextBlock): BlockStyles {
  return {
    textIndent: block.styles?.textIndent ?? 0,
    paddingLeft: block.styles?.paddingLeft ?? 0,
    lineHeight: block.styles?.lineHeight ?? 1.4,
    textAlign: block.styles?.textAlign ?? "left"
  };
}

function validTag(tag: SemanticTag): SemanticTag {
  return TEXT_TAGS.has(tag) ? tag : "span";
}

function sourceBlockIdFromWordId(sourceId: string): string | null {
  const parts = sourceId.split(":");
  if (parts[0] !== "word" || parts.length < 4) return null;
  return parts.slice(1, -2).join(":") || null;
}

function touchedSourceBlockIds(fixes: FixDelta[]): Set<string> {
  const sourceBlockIds = new Set<string>();
  for (const fix of fixes) {
    const block = fix.after as Partial<TextBlock>;
    for (const sourceId of block.sourceSpanIds ?? []) {
      const sourceBlockId = sourceBlockIdFromWordId(sourceId);
      if (sourceBlockId) sourceBlockIds.add(sourceBlockId);
    }
  }
  return sourceBlockIds;
}

function mergeBlockPatch(block: TextBlock, patch: Partial<TextBlock>): TextBlock {
  const next: TextBlock = {
    ...block,
    ...clone(patch),
    styles: { ...blockStyles(block), ...(patch.styles ?? {}) },
    imageCrop: patch.imageCrop ? { ...block.imageCrop, ...patch.imageCrop } : block.imageCrop
  };
  if (next.imageCrop && (patch.x !== undefined || patch.y !== undefined || patch.w !== undefined || patch.h !== undefined)) {
    next.imageCrop = {
      ...next.imageCrop,
      x: next.x,
      y: next.y,
      w: next.w,
      h: next.h
    };
  }
  return next;
}

function applyFixes(page: PageResult, fixes: FixDelta[]): TextBlock[] {
  const sourceBlocksToSuppress = touchedSourceBlockIds(fixes);
  const byId = new Map<string, TextBlock>();
  for (const block of page.blocks) {
    if (sourceBlocksToSuppress.has(block.id)) continue;
    byId.set(block.id, clone(block));
  }

  for (const fix of fixes) {
    if (fix.type === "create-group") {
      const created = fix.after as TextBlock;
      if (created?.id) byId.set(created.id, clone(created));
      continue;
    }

    if (fix.type === "delete") {
      byId.delete(fix.blockId);
      continue;
    }

    if (fix.type === "merge") {
      byId.delete(fix.blockId);
      if (fix.secondaryBlockId) byId.delete(fix.secondaryBlockId);
      const base = (fix.after as Partial<TextBlock>) ?? {};
      const merged: TextBlock = {
        ...(clone(page.blocks.find((block) => block.id === fix.blockId) ?? page.blocks[0]) as TextBlock),
        ...clone(base),
        id: fix.blockId,
        pageIndex: page.pageIndex,
        tag: (base.tag as SemanticTag | undefined) ?? "p",
        confidence: base.confidence ?? 0.8,
        fontName: base.fontName ?? "serif",
        fontSize: base.fontSize ?? 12,
        fontWeight: base.fontWeight ?? "normal",
        fontColor: base.fontColor ?? "#000000",
        text: base.text ?? "",
        rawSpans: base.rawSpans ?? [],
        styles: { textIndent: 0, paddingLeft: 0, lineHeight: 1.4, textAlign: "left", ...(base.styles ?? {}) },
        isFirstLineIndented: base.isFirstLineIndented ?? false
      };
      byId.set(merged.id, merged);
      continue;
    }

    const current = byId.get(fix.blockId);
    if (!current) continue;
    byId.set(fix.blockId, mergeBlockPatch(current, fix.after));
  }

  return [...byId.values()]
    .filter((block) => block.tag === "img" || (block.text.trim() && block.w >= 1 && block.h >= 1))
    .sort((a, b) => (a.y - b.y) || (a.x - b.x));
}

function safeCropFileName(pageIndex: number, blockId: string): string {
  const safeId = blockId.replace(/[^A-Za-z0-9_-]/g, "-");
  return `page-${pageIndex + 1}-${safeId}.png`;
}

async function materializeImageCrops(jobId: string, pageIndex: number, blocks: TextBlock[]): Promise<TextBlock[]> {
  const imageBlocks = blocks.filter((block): block is MutableTextBlock => block.tag === "img" && Boolean(block.imageCrop));
  if (!imageBlocks.length) return blocks;

  const sourceImage = await loadImage(jobStore.getImagePath(jobId, pageIndex));
  for (const block of imageBlocks) {
    const crop = block.imageCrop;
    if (!crop) continue;
    const x = Math.max(0, Math.round(crop.x));
    const y = Math.max(0, Math.round(crop.y));
    const w = Math.max(1, Math.round(crop.w));
    const h = Math.max(1, Math.round(crop.h));
    const canvas = createCanvas(w, h);
    const context = canvas.getContext("2d");
    context.drawImage(sourceImage, x, y, w, h, 0, 0, w, h);
    const fileName = crop.fileName ?? safeCropFileName(pageIndex, block.id);
    await jobStore.saveCropImage(jobId, fileName, new Uint8Array(canvas.toBuffer("image/png")));
    block.imageCrop = { x, y, w, h, fileName };
  }

  return blocks;
}

function childInlineStyle(child: SemanticChildSpan): string {
  const declarations: string[] = [];
  const overrides = child.styleOverrides;
  if (overrides.fontSize !== undefined) declarations.push(`font-size: ${overrides.fontSize}pt`);
  if (overrides.fontName) declarations.push(`font-family: "${sanitizeCssString(cleanPdfFontName(overrides.fontName))}", serif`);
  if (overrides.fontWeight) declarations.push(`font-weight: ${overrides.fontWeight}`);
  if (overrides.fontColor) declarations.push(`color: ${sanitizeColor(overrides.fontColor)}`);
  if (overrides.styles?.textIndent !== undefined) declarations.push(`text-indent: ${overrides.styles.textIndent}px`);
  if (overrides.styles?.paddingLeft !== undefined) declarations.push(`padding-left: ${overrides.styles.paddingLeft}px`);
  if (overrides.styles?.lineHeight !== undefined) declarations.push(`line-height: ${overrides.styles.lineHeight}`);
  if (overrides.styles?.textAlign !== undefined) declarations.push(`text-align: ${overrides.styles.textAlign}`);
  return declarations.length ? ` style="${escapeHtml(declarations.join("; "))}"` : "";
}

function renderSemanticChildren(children: SemanticChildSpan[]): string {
  const lines = new Map<number, SemanticChildSpan[]>();
  for (const child of children) {
    const line = lines.get(child.lineIndex) ?? [];
    line.push(child);
    lines.set(child.lineIndex, line);
  }
  return [...lines.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, line]) => line
      .sort((a, b) => a.x - b.x)
      .map((child) => `<span data-source-span-id="${sanitizeAttr(child.id)}"${childInlineStyle(child)}>${escapeHtml(child.text)}</span>`)
      .join(" "))
    .join("\n");
}

function buildCss(page: PageResult, fontAssets: ExtractedFontAsset[]): string {
  const rules = page.blocks.map((block) => {
    const styles = blockStyles(block);
    if (block.tag === "img") {
      return `[data-block-id="${block.id}"] {
  position: absolute;
  left: ${block.x}px;
  top: ${block.y}px;
  width: ${block.w}px;
  height: ${block.h}px;
  object-fit: fill;
  z-index: 2;
}`;
    }
    return `[data-block-id="${block.id}"] {
  position: absolute;
  left: ${block.x}px;
  top: ${block.y}px;
  width: ${block.w}px;
  height: ${block.h}px;
  font-size: ${block.fontSize}pt;
  font-family: "${resolveCssFontFamily(block.fontName, fontAssets)}", serif;
  font-weight: ${block.fontWeight};
  font-style: ${resolveCssFontStyle(block.fontName, fontAssets)};
  color: ${sanitizeColor(block.fontColor)};
  white-space: ${block.textMode === "pre" ? "pre" : "nowrap"};
  overflow: visible;
  text-indent: ${styles.textIndent}px;
  padding-left: ${styles.paddingLeft}px;
  line-height: ${styles.lineHeight};
  text-align: ${styles.textAlign};
  z-index: 1;
}`;
  }).join("\n\n");

  const faces = fontFaceCss(fontAssets);
  return `html, body { margin: 0; padding: 0; background: transparent; }
.page { position: relative; width: ${page.pageWidth}px; height: ${page.pageHeight}px; overflow: hidden; }
.page__bg { position: absolute; inset: 0; width: 100%; height: 100%; z-index: 0; pointer-events: none; }
.page__text { position: absolute; inset: 0; z-index: 1; }
.page__text > * { margin: 0; user-select: text; }
.page__text [data-semantic-text="true"] { opacity: 0.01; }
${faces ? `${faces}\n\n` : ""}${rules}`;
}

function renderBlock(block: TextBlock): string {
  if (block.tag === "img") {
    const fileName = block.imageCrop?.fileName;
    const src = fileName ? `../images/crops/${fileName}` : "";
    return `<img data-block-id="${sanitizeAttr(block.id)}" data-tag="img" src="${sanitizeAttr(src)}" alt="">`;
  }
  const tag = validTag(block.tag);
  const content = block.semanticChildren?.length ? renderSemanticChildren(block.semanticChildren) : escapeHtml(block.text);
  return `<${tag} data-semantic-text="true" data-block-id="${sanitizeAttr(block.id)}" data-confidence="${block.confidence}" data-tag="${tag}" data-is-indented="${block.isFirstLineIndented}">${content}</${tag}>`;
}

function buildHtml(page: PageResult, pageNumber: number): string {
  const elements = page.blocks.map(renderBlock).join("\n");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="../styles/page-${pageNumber}.css">
</head>
<body>
<div class="page">
<img class="page__bg" src="../images/page-${pageNumber}.png" alt="">
<div class="page__text">
${elements}
</div>
</div>
</body>
</html>`;
}

export async function applyFixesAndRegenerateFinal(jobId: string, pageIndex: number, fixes: FixDelta[]): Promise<PageResult | null> {
  if (!fixes.length) return null;
  const currentPage = await jobStore.getPage(jobId, pageIndex);
  if (!currentPage) return null;

  const nextBlocks = await materializeImageCrops(jobId, pageIndex, applyFixes(currentPage, fixes));
  const nextPage: PageResult = {
    ...currentPage,
    blocks: nextBlocks,
    reviewStatus: "edited"
  };
  const pageNumber = pageIndex + 1;
  const manifest = await jobStore.getFontManifest(jobId);
  const fontAssets = manifest?.fonts ?? [];
  const css = buildCss(nextPage, fontAssets);
  const html = buildHtml(nextPage, pageNumber);
  nextPage.htmlContent = html;
  await jobStore.saveRegeneratedFinalPage(jobId, pageIndex, nextPage, html, css);
  return nextPage;
}
