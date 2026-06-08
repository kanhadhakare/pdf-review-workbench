import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { ExtractionStatus } from "../types.js";
import { classifyBlocks } from "./classifier.js";
import { jobStore } from "./jobStore.js";
import { extractFontsWithPdfBox } from "./pdfboxFontService.js";
import { convertManifestFontsForWeb } from "./fontConversionService.js";
import { validatePage } from "./validator.js";
import { isPdf2HtmlExEnabled, runPdf2HtmlEx, validatePdf2HtmlExOutput } from "./pdf2htmlExService.js";
import { extractionMaxDpi } from "../config/runtime.js";
import { normalizePdfText } from "./textNormalizer.js";
import { destroyMuPdfObject } from "./mupdfLifecycle.js";
let activeEngine = "uninitialized";
async function importMuPdf() {
    try {
        return await import("mupdf");
    }
    catch {
        return null;
    }
}
function normalizeText(text, profile) {
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
function escapeHtml(value) {
    return value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/\"/g, "&quot;")
        .replace(/'/g, "&#39;");
}
function cssSingleQuoted(value) {
    // Safe CSS string for use inside inline style attributes.
    // Use single quotes to avoid breaking `style="..."` attributes.
    return `'${String(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}
function cleanPdfFontName(fontName) {
    return fontName
        .replace(/^[A-Z]{6}\+/, "")
        .replace(/[^A-Za-z0-9_\s-]/g, " ")
        .replace(/\s+/g, " ")
        .trim() || "pdffont";
}
function sanitizeFont(fontName) {
    const cleaned = fontName.replace(/[^A-Za-z0-9_\s-]/g, " ").replace(/\s+/g, " ").trim();
    return cleaned || "serif";
}
function sanitizeFontFamily(fontName) {
    return cleanPdfFontName(fontName);
}
function normalizeFontKey(fontName) {
    return sanitizeFontFamily(fontName).replace(/[^A-Za-z0-9]/g, "").toLowerCase();
}
function detectFontStyle(fontName) {
    return /italic|oblique/i.test(fontName) ? "italic" : "normal";
}
function sanitizeColor(value) {
    const normalized = value.trim();
    if (/^#[0-9A-Fa-f]{3,6}$/.test(normalized))
        return normalized;
    if (/^rgba?\(/i.test(normalized))
        return normalized;
    return "#000000";
}
function parseColorsFromStructuredHtml(html) {
    const colors = [];
    const regex = /color\s*:\s*(#[0-9A-Fa-f]{3,6}|rgba?\([^\)]*\))/gi;
    let match;
    while ((match = regex.exec(html))) {
        colors.push(sanitizeColor(match[1]));
    }
    return colors;
}
function decodeHtmlEntities(value) {
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
function parseHtmlSpanRuns(html) {
    // MuPDF structured HTML is typically: <p style="top:..;left:.."><span style="...color:...">TEXT</span></p>
    // We extract spans in document order and keep the paragraph top/left as hints.
    const runs = [];
    const paragraphRegex = /<p\b[^>]*style\s*=\s*"([^"]*)"[^>]*>([\s\S]*?)<\/p>/gi;
    const spanRegex = /<span\b[^>]*style\s*=\s*"([^"]*)"[^>]*>([\s\S]*?)<\/span>/gi;
    const parsePt = (styleText, key) => {
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
function normalizeRotationAngle(angle) {
    let normalized = ((angle % 360) + 360) % 360;
    if (normalized > 180)
        normalized -= 360;
    if (Math.abs(normalized) < 3)
        return 0;
    if (Math.abs(normalized - 90) < 3)
        return 90;
    if (Math.abs(normalized + 90) < 3)
        return -90;
    if (Math.abs(Math.abs(normalized) - 180) < 3)
        return 180;
    return Number(normalized.toFixed(2));
}
function rotationFromQuad(quad) {
    if (quad.length < 4)
        return 0;
    const dx = quad[2] - quad[0];
    const dy = quad[3] - quad[1];
    if (Math.hypot(dx, dy) < 0.01)
        return 0;
    return normalizeRotationAngle((Math.atan2(dy, dx) * 180) / Math.PI);
}
function pointFromValue(value) {
    if (Array.isArray(value) && value.length >= 2 && Number.isFinite(Number(value[0])) && Number.isFinite(Number(value[1]))) {
        return [Number(value[0]), Number(value[1])];
    }
    if (value && typeof value === "object" && "x" in value && "y" in value) {
        const point = value;
        if (Number.isFinite(Number(point.x)) && Number.isFinite(Number(point.y))) {
            return [Number(point.x), Number(point.y)];
        }
    }
    return null;
}
function quadFromValue(value) {
    if (!Array.isArray(value))
        return null;
    const flattened = value.flatMap((entry) => Array.isArray(entry) ? entry : [entry]).map(Number);
    return flattened.length >= 8 && flattened.every(Number.isFinite) ? flattened : null;
}
function bboxFromQuad(quad, scale, profile) {
    const xs = [quad[0], quad[2], quad[4], quad[6]];
    const ys = [quad[1], quad[3], quad[5], quad[7]];
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    return {
        x: (minX * scale) + profile.coordOffsetX,
        y: (minY * scale) + profile.coordOffsetY,
        w: Math.max(0.1, (maxX - minX) * scale),
        h: Math.max(0.1, (maxY - minY) * scale)
    };
}
function cssColorFromMuPdf(color) {
    if (!Array.isArray(color) || color.length === 0)
        return "#000000";
    const channels = color.map(Number).filter(Number.isFinite);
    if (channels.length === 0)
        return "#000000";
    const toByte = (value) => Math.max(0, Math.min(255, Math.round(value <= 1 ? value * 255 : value)));
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
function unionBoxes(chars) {
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
function structuredCharsToReviewWords(chars, profile) {
    const words = [];
    let current = [];
    const flush = () => {
        if (current.length === 0)
            return;
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
function collectReviewWords(structured, profile, scale) {
    const words = [];
    let lineChars = [];
    const flushLine = () => {
        words.push(...structuredCharsToReviewWords(lineChars, profile));
        lineChars = [];
    };
    const walker = structured;
    if (typeof walker.walk !== "function")
        return words;
    try {
        walker.walk({
            beginLine: () => flushLine(),
            onChar: (...args) => {
                const rawText = String(args[0] ?? "");
                const font = args[2];
                const size = Number(args[3]);
                const quad = quadFromValue(args[4]);
                if (!rawText || !quad)
                    return;
                const box = bboxFromQuad(quad, scale, profile);
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
    }
    catch (error) {
        console.warn("[extractor] failed to collect MuPDF character boxes:", error);
    }
    return words;
}
function collectRotationHints(structured) {
    const hints = [];
    const walker = structured;
    if (typeof walker.walk !== "function")
        return hints;
    try {
        walker.walk({
            onChar: (...args) => {
                const text = String(args[0] ?? "");
                if (!text.trim())
                    return;
                const origin = pointFromValue(args[1]);
                const quad = args.map(quadFromValue).find((value) => Boolean(value));
                if (!origin || !quad)
                    return;
                const rotation = rotationFromQuad(quad);
                if (rotation === 0)
                    return;
                hints.push({ text, x: origin[0], y: origin[1], rotation });
            }
        });
    }
    catch (error) {
        console.warn("[extractor] failed to inspect MuPDF character rotation:", error);
    }
    return hints;
}
function findLineRotation(hints, rawText, x, y) {
    if (!Number.isFinite(x) || !Number.isFinite(y))
        return undefined;
    const firstChar = rawText.match(/\S/u)?.[0];
    if (!firstChar)
        return undefined;
    const direct = hints.find((hint) => hint.text === firstChar && Math.abs(hint.x - Number(x)) <= 2 && Math.abs(hint.y - Number(y)) <= 2);
    return direct?.rotation;
}
function isRotated(rotation) {
    return typeof rotation === "number" && Math.abs(rotation) > 0.01;
}
function createReviewWords(span) {
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
function cssBoxForRotation(word) {
    const rotation = normalizeRotationAngle(word.rotation ?? 0);
    if (rotation === -90)
        return { left: word.x, top: word.y + word.h, width: word.h, height: word.w };
    if (rotation === 90)
        return { left: word.x + word.w, top: word.y, width: word.h, height: word.w };
    if (rotation === 180)
        return { left: word.x + word.w, top: word.y + word.h, width: word.w, height: word.h };
    return { left: word.x, top: word.y, width: word.w, height: word.h };
}
function getFontStreamExtension(fontStream) {
    const subtype = fontStream.get("Subtype")?.asName?.()?.toLowerCase?.();
    if (subtype === "truetype")
        return "ttf";
    if (subtype === "type1" || subtype === "type1c" || subtype === "cff" || subtype === "opentype")
        return "otf";
    if (subtype === "woff")
        return "woff";
    if (subtype === "woff2")
        return "woff2";
    return "bin";
}
function getFontFileFormat(extension) {
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
function getCssFontFormat(format) {
    if (format === "type1")
        return "opentype";
    return format === "unknown" ? "opentype" : format;
}
function fontSourcePriority(format) {
    if (format === "woff2")
        return 0;
    if (format === "woff")
        return 1;
    if (format === "truetype")
        return 2;
    if (format === "opentype" || format === "type1")
        return 3;
    return 4;
}
function isBrowserSafeFontFormat(format) {
    // pdfbox extractor may emit Type1 fonts as .otf files; browsers can still load them as OpenType.
    return format === "truetype" || format === "opentype" || format === "type1" || format === "woff" || format === "woff2";
}
function buildFontFaceCss(fontAssets) {
    const grouped = new Map();
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
function resolveCssFontFamily(fontName, fontAssets) {
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
function resolveCssFontStyle(fontName, fontAssets) {
    const normalized = normalizeFontKey(fontName);
    const matched = fontAssets.find((font) => normalizeFontKey(font.baseFont) === normalized || normalizeFontKey(font.family) === normalized);
    return matched?.fontStyle ?? detectFontStyle(fontName);
}
function detectLeftMarginPx(spans) {
    const buckets = new Map();
    for (const span of spans) {
        const bucket = Math.round(span.x / 4) * 4;
        buckets.set(bucket, (buckets.get(bucket) ?? 0) + 1);
    }
    const best = [...buckets.entries()].sort((a, b) => b[1] - a[1])[0];
    return best?.[0] ?? 0;
}
function defaultStyles(indent = 0) {
    return { textIndent: indent, paddingLeft: 0, lineHeight: 1.4, textAlign: "left" };
}
function mergeSpans(spans, profile, leftMarginPx) {
    const sorted = [...spans].sort((a, b) => (Math.abs(a.y - b.y) > profile.yBandTolerance ? a.y - b.y : a.x - b.x));
    const blocks = [];
    for (const span of sorted) {
        const normalized = normalizeText(span.text, profile);
        if (!normalized)
            continue;
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
function predictTag(block, pageWidth, profile) {
    if (block.confidence < profile.artifactThreshold)
        return "artifact";
    if (block.isFirstLineIndented)
        return "p";
    if (block.fontSize >= profile.headingCutoffs[0])
        return "h1";
    if (block.fontSize >= profile.headingCutoffs[1])
        return "h2";
    if (block.fontSize >= profile.headingCutoffs[2])
        return "h3";
    return block.w > pageWidth * 0.5 ? "p" : "span";
}
function applyClassifierResults(blocks, results, pageWidth, profile) {
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
function applyParagraphStyles(blocks, profile, leftMarginPx) {
    return blocks.map((block) => {
        if (block.tag !== "p")
            return block;
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
function filterBlocks(blocks) {
    return blocks.filter((block) => block.tag !== "artifact" && block.text.trim() && block.w >= 2 && block.h >= 2);
}
function buildCss(pageWidth, pageHeight, blocks, fontAssets, fontFaceCss = "") {
    const rules = blocks.map((block) => `[data-block-id="${block.id}"] {\n  position: absolute;\n  left: ${block.x}px;\n  top: ${block.y}px;\n  width: ${block.w}px;\n  height: ${block.h}px;\n  font-size: ${block.fontSize}pt;\n  font-family: "${resolveCssFontFamily(block.fontName, fontAssets)}", serif;\n  font-weight: ${block.fontWeight};\n  font-style: ${resolveCssFontStyle(block.fontName, fontAssets)};\n  color: ${sanitizeColor(block.fontColor)};\n  white-space: nowrap;\n  overflow: visible;\n  text-indent: ${block.styles.textIndent}px;\n  padding-left: ${block.styles.paddingLeft}px;\n  line-height: ${block.styles.lineHeight};\n  text-align: ${block.styles.textAlign};\n}`).join("\n\n");
    return `html, body { margin: 0; padding: 0; background: transparent; }\n.page { position: relative; width: ${pageWidth}px; height: ${pageHeight}px; overflow: hidden; }\n.page__bg { position: absolute; inset: 0; width: 100%; height: 100%; z-index: 0; pointer-events: none; }\n.page__text { position: absolute; inset: 0; z-index: 1; }\n.page__text > * { margin: 0; user-select: text; }\n${fontFaceCss ? `${fontFaceCss}\n\n` : ""}${rules}`;
}
function buildHtml(page, imageHref, cssHref, mode) {
    const modeCss = mode === "final"
        ? `.page__text > * { color: rgba(0, 0, 0, 0.01); }`
        : mode === "review"
            ? `.page__text > * { background: rgba(255, 255, 255, 0.2); }`
            : `.page__text > * { background: rgba(255, 255, 0, 0.14); outline: 1px dashed rgba(74, 144, 226, 0.95); }`;
    const elements = page.blocks.map((block) => `<${block.tag} data-block-id="${block.id}" data-confidence="${block.confidence}" data-tag="${block.tag}" data-is-indented="${block.isFirstLineIndented}">${escapeHtml(block.text)}</${block.tag}>`).join("\n");
    return `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<link rel="stylesheet" href="${cssHref}">\n<style>${modeCss}</style>\n</head>\n<body>\n<div class="page">\n<img class="page__bg" src="${imageHref}" alt="">\n<div class="page__text">\n${elements}\n</div>\n</div>\n</body>\n</html>`;
}
async function extractWithMuPdf(filePath, profile, dpi) {
    const mupdf = await importMuPdf();
    if (!mupdf)
        throw new Error("MuPDF unavailable");
    activeEngine = "mupdf";
    const pdfBytes = await readFile(filePath);
    const document = mupdf.Document.openDocument(pdfBytes, "application/pdf");
    try {
        const pageCount = document.countPages();
        const safeDpi = Math.min(extractionMaxDpi, Math.max(72, dpi));
        const scale = Math.min(200, safeDpi) / 72;
        const matrix = mupdf.Matrix.scale(scale, scale);
        const pages = [];
        for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
            const page = document.loadPage(pageIndex);
            let pixmap = null;
            let structured = null;
            try {
                const bounds = page.getBounds();
                const pageWidth = Math.round((bounds[2] - bounds[0]) * scale);
                const pageHeight = Math.round((bounds[3] - bounds[1]) * scale);
                pixmap = page.toPixmap(matrix, mupdf.ColorSpace.DeviceRGB, false, true);
                const imageBytes = new Uint8Array(pixmap.asPNG());
                structured = page.toStructuredText("preserve-whitespace,preserve-spans");
                const html = structured.asHTML(0);
                const htmlRuns = parseHtmlSpanRuns(html);
                const rotationHints = collectRotationHints(structured);
                const reviewWords = collectReviewWords(structured, profile, scale);
                let runIndex = 0;
                const json = JSON.parse(structured.asJSON(1));
                const spans = [];
                for (const block of json.blocks ?? []) {
                    if (block.type !== "text")
                        continue;
                    for (const line of block.lines ?? []) {
                        const bbox = line.bbox ?? block.bbox;
                        const text = normalizeText(line.text ?? "", profile);
                        if (!bbox || !text)
                            continue;
                        const fontName = line.font?.name ?? "Unknown";
                        let rawColor = null;
                        let bestFallback = null;
                        for (let attempts = 0; attempts < 12 && runIndex < htmlRuns.length; attempts += 1) {
                            const run = htmlRuns[runIndex++];
                            const runText = normalizeText(run.text ?? "", profile);
                            if (!runText)
                                continue;
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
                                if (!bestFallback || score < bestFallback.score)
                                    bestFallback = { color: run.color, score };
                            }
                        }
                        if (rawColor === null && bestFallback)
                            rawColor = bestFallback.color;
                        const rotation = findLineRotation(rotationHints, line.text ?? "", line.x, line.y);
                        spans.push({
                            x: (bbox.x * scale) + profile.coordOffsetX,
                            y: (bbox.y * scale) + profile.coordOffsetY,
                            w: bbox.w * scale,
                            h: bbox.h * scale,
                            text,
                            fontSize: line.font?.size ?? bbox.h ?? 12,
                            fontName,
                            fontColor: sanitizeColor(rawColor ?? "#000000"),
                            rotation,
                            pageIndex,
                            fontWeight: /bold|black|heavy/i.test(fontName) ? "bold" : "normal"
                        });
                    }
                }
                pages.push({ pageIndex, pageWidth, pageHeight, scale, leftMarginPx: detectLeftMarginPx(spans), spans, reviewWords, imageBytes });
            }
            finally {
                destroyMuPdfObject(structured);
                destroyMuPdfObject(pixmap);
                destroyMuPdfObject(page);
            }
        }
        return pages;
    }
    finally {
        destroyMuPdfObject(document);
    }
}
async function extractFontsFromMuPdf(filePath, jobId) {
    const mupdf = await importMuPdf();
    if (!mupdf)
        return [];
    const pdfBytes = await readFile(filePath);
    const document = mupdf.Document.openDocument(pdfBytes, "application/pdf");
    try {
        const pdfDocument = document.asPDF();
        if (!pdfDocument) {
            return [];
        }
        const fontAssets = [];
        const seen = new Map();
        const candidates = [];
        for (let pageIndex = 0; pageIndex < pdfDocument.countPages(); pageIndex++) {
            const page = pdfDocument.loadPage(pageIndex);
            try {
                const pageObj = page.getObject();
                const resources = pageObj.get("Resources");
                if (!resources?.isDictionary?.())
                    continue;
                const fontResources = resources.get("Font");
                if (!fontResources?.isDictionary?.())
                    continue;
                fontResources.forEach((valueObj, keyName) => {
                    try {
                        const fontRef = valueObj.toString?.() ?? String(keyName);
                        if (seen.has(fontRef) || candidates.some((candidate) => candidate.fontRef === fontRef))
                            return;
                        const font = valueObj.isDictionary?.() ? valueObj : valueObj.resolve?.();
                        if (!font?.isDictionary?.())
                            return;
                        const baseFont = font.get("BaseFont")?.asName?.() ?? font.get("FontName")?.asName?.() ?? String(keyName);
                        const cleanedName = cleanPdfFontName(baseFont);
                        const descriptorObject = font.get("FontDescriptor");
                        const fontDescriptor = descriptorObject?.isDictionary?.() ? descriptorObject : descriptorObject?.resolve?.();
                        if (!fontDescriptor?.isDictionary?.())
                            return;
                        const fontFileObject = fontDescriptor.get("FontFile2") ?? fontDescriptor.get("FontFile3") ?? fontDescriptor.get("FontFile");
                        if (!fontFileObject)
                            return;
                        const fontStream = fontFileObject.isStream?.() ? fontFileObject : fontFileObject.resolve?.();
                        if (!fontStream?.isStream?.())
                            return;
                        const rawBytes = fontStream.readRawStream?.() ?? fontStream.readStream?.();
                        if (!rawBytes)
                            return;
                        const bytes = rawBytes instanceof Uint8Array
                            ? new Uint8Array(rawBytes)
                            : rawBytes instanceof ArrayBuffer
                                ? new Uint8Array(rawBytes)
                                : new Uint8Array(rawBytes);
                        candidates.push({
                            fontRef,
                            family: cleanedName,
                            fontWeight: /bold|black|heavy/i.test(baseFont) ? "bold" : "normal",
                            fontStyle: /italic|oblique/i.test(baseFont) ? "italic" : "normal",
                            bytes,
                            extension: getFontStreamExtension(fontStream)
                        });
                    }
                    catch (error) {
                        console.warn(`[extractor] skipping font resource ${String(keyName)} on page ${pageIndex + 1}:`, error);
                    }
                });
            }
            finally {
                destroyMuPdfObject(page);
            }
        }
        for (const candidate of candidates) {
            const fileName = `${sanitizeFontFamily(candidate.family).replace(/\s+/g, "-").toLowerCase()}-${createHash("sha256").update(candidate.bytes).digest("hex").slice(0, 8)}.${candidate.extension}`;
            if (seen.has(fileName))
                continue;
            await jobStore.saveFontFile(jobId, fileName, candidate.bytes);
            const asset = {
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
    }
    finally {
        destroyMuPdfObject(document);
    }
}
function buildMuPdfFallbackManifest(sourcePdf, fonts) {
    return {
        sourcePdf,
        engine: "mupdf",
        status: fonts.length > 0 ? "ok" : "failed",
        message: fonts.length > 0 ? undefined : "MuPDF font fallback did not find any readable embedded font streams",
        fonts
    };
}
async function extractPages(filePath, profile, dpi, jobId) {
    const pages = await extractWithMuPdf(filePath, profile, dpi);
    let fontManifest = await extractFontsWithPdfBox(jobId, filePath);
    if (fontManifest.fonts.length === 0) {
        try {
            const fallbackFonts = await extractFontsFromMuPdf(filePath, jobId);
            if (fallbackFonts.length > 0) {
                fontManifest = await convertManifestFontsForWeb(jobId, buildMuPdfFallbackManifest(filePath, fallbackFonts));
                await jobStore.saveFontManifest(jobId, fontManifest);
            }
        }
        catch (error) {
            console.warn("[extractor] MuPDF font fallback failed:", error);
        }
    }
    return { pages, fontManifest };
}
async function extractPageImagesOnly(filePath, profile, dpi) {
    return await extractWithMuPdf(filePath, profile, dpi);
}
function buildCombinedReviewCss(extracted, profile, fontAssets) {
    void profile;
    const browserSafeFonts = fontAssets.filter((font) => isBrowserSafeFontFormat(font.format));
    const fontFaceCss = buildFontFaceCss(browserSafeFonts);
    const commonCss = `.page { position: relative; width: ${extracted.pageWidth}px; height: ${extracted.pageHeight}px; overflow: hidden; }
.page__bg { position: absolute; inset: 0; width: 100%; height: 100%; z-index: 0; pointer-events: none; }
.page__text { position: absolute; inset: 0; z-index: 1; }
.page__word { position: absolute; margin: 0; white-space: nowrap; overflow: visible; user-select: text; }
.page__word { background: rgba(255, 255, 255, 0.04); }`;
    const rules = [];
    for (const [index, span] of extracted.spans.entries()) {
        // This function operates on already extracted (scaled) spans.
        // We keep per-word split below in HTML generation.
        void span;
        void index;
    }
    return `${fontFaceCss ? `${fontFaceCss}\n\n` : ""}${commonCss}`;
}
function buildCombinedReviewHtml(extracted, profile, fontAssets, imageHref, cssHref) {
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
function buildPageArtifacts(jobId, extracted, profile, blocks, fontAssets) {
    const filtered = filterBlocks(applyParagraphStyles(blocks, profile, extracted.leftMarginPx));
    const browserSafeFonts = fontAssets.filter((font) => isBrowserSafeFontFormat(font.format));
    const page = {
        pageIndex: extracted.pageIndex,
        imageUrl: `/api/jobs/${jobId}/pages/${extracted.pageIndex}/image`,
        htmlContent: "",
        blocks: filtered,
        confidence: validatePage(filtered, profile, extracted.pageWidth, extracted.pageHeight),
        pageWidth: extracted.pageWidth,
        pageHeight: extracted.pageHeight,
        leftMarginPx: extracted.leftMarginPx,
        reviewStatus: "unvisited"
    };
    const pageNumber = extracted.pageIndex + 1;
    // Per-page CSS contains both common rules and per-word absolute positioning and style.
    const commonCss = `.page { position: relative; width: ${extracted.pageWidth}px; height: ${extracted.pageHeight}px; overflow: hidden; }\n.page__bg { position: absolute; inset: 0; width: 100%; height: 100%; z-index: 0; pointer-events: none; }\n.page__text { position: absolute; inset: 0; z-index: 1; }\n.page__word { position: absolute; margin: 0; white-space: nowrap; overflow: visible; user-select: text; }\n.page__word { background: rgba(255, 255, 255, 0.04); }`;
    const wordRules = [];
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
export async function extractPDF(job, profile, dpi = 150, options = {}) {
    void options; // OCR disabled for now.
    await jobStore.markActive(job.id);
    await jobStore.updateJob(job.id, { status: ExtractionStatus.processing, processedPages: 0, dpi });
    try {
        let pdf2htmlExReady = false;
        if (isPdf2HtmlExEnabled()) {
            try {
                await runPdf2HtmlEx(job.filePath, jobStore.getPdf2HtmlExDir(job.id));
                activeEngine = "pdf2htmlEX";
                pdf2htmlExReady = true;
                const warnings = await validatePdf2HtmlExOutput(jobStore.getPdf2HtmlExDir(job.id));
                await jobStore.updateJob(job.id, { hasPdf2HtmlEx: true, pdf2htmlExWarnings: warnings });
            }
            catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                console.warn("[extractor] pdf2htmlEX failed, falling back to built HTML:", error);
                await jobStore.updateJob(job.id, {
                    hasPdf2HtmlEx: false,
                    pdf2htmlExWarnings: [`pdf2htmlEX conversion failed; using fallback extractor output.`, message]
                });
            }
        }
        // If pdf2htmlEX succeeded, treat it as the source of truth for HTML output.
        // We still rasterize page images + dimensions for navigation/viewport scaling.
        if (pdf2htmlExReady) {
            const pages = await extractPageImagesOnly(job.filePath, profile, dpi);
            await jobStore.updateJob(job.id, { pageCount: pages.length });
            for (const extracted of pages.sort((a, b) => a.pageIndex - b.pageIndex)) {
                await jobStore.savePdf2HtmlExPage(job.id, extracted.pageIndex, extracted.pageWidth, extracted.pageHeight, extracted.imageBytes);
                await jobStore.updateJob(job.id, { processedPages: extracted.pageIndex + 1 });
            }
            await jobStore.updateJob(job.id, { status: ExtractionStatus.done, pageCount: pages.length });
            return;
        }
        const { pages, fontManifest } = await extractPages(job.filePath, profile, dpi, job.id);
        await jobStore.updateJob(job.id, { pageCount: pages.length });
        for (const extracted of pages.sort((a, b) => a.pageIndex - b.pageIndex)) {
            const merged = mergeSpans(extracted.spans, profile, extracted.leftMarginPx);
            const classified = applyClassifierResults(merged, await classifyBlocks(merged, { pageWidth: extracted.pageWidth, pageHeight: extracted.pageHeight }), extracted.pageWidth, profile);
            const built = buildPageArtifacts(job.id, extracted, profile, classified, fontManifest.fonts);
            await jobStore.savePageArtifacts(job.id, extracted.pageIndex, {
                page: built.page,
                reviewHtmlContent: built.reviewHtml,
                reviewCssContent: built.reviewCssContent
            }, extracted.imageBytes);
            await jobStore.updateJob(job.id, { processedPages: extracted.pageIndex + 1 });
        }
        // If pdf2htmlEX was enabled and succeeded, it is already available for the review UI
        // under /storage/jobs/<jobId>/pdf2htmlex/page-<n>.html.
        void pdf2htmlExReady;
        await jobStore.updateJob(job.id, { status: ExtractionStatus.done, pageCount: pages.length });
    }
    catch (error) {
        await jobStore.updateJob(job.id, {
            status: ExtractionStatus.failed,
            errorMessage: error instanceof Error ? error.message : "Extraction failed"
        });
        throw error;
    }
    finally {
        await jobStore.markInactive(job.id);
    }
}
export function getActiveEngine() {
    return activeEngine;
}
