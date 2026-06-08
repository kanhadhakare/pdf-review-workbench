import { readFile, mkdir, readdir, copyFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { jobStore } from "./jobStore.js";
import { renderFinalBackgroundPng } from "./finalBackgroundService.js";
import { latexToMathMl } from "./mathMlService.js";
const INHERITED_WORD_STYLE_KEYS = [
    "font-family",
    "font-size",
    "font-weight",
    "font-style",
    "color"
];
const STYLE_OUTPUT_ORDER = [
    "left",
    "top",
    "width",
    "height",
    "padding-top",
    "padding-left",
    "font-family",
    "font-size",
    "font-weight",
    "font-style",
    "color",
    "line-height",
    "text-align"
];
function boxesIntersect(a, b) {
    return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}
function boxIntersectionArea(a, b) {
    const width = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
    const height = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
    return width * height;
}
function wordBoxOverlapRatio(wordBounds, box) {
    const wordArea = Math.max(1, wordBounds.w * wordBounds.h);
    return boxIntersectionArea(wordBounds, box) / wordArea;
}
function wordCenterInsideBox(wordBounds, box) {
    const centerX = wordBounds.x + wordBounds.w / 2;
    const centerY = wordBounds.y + wordBounds.h / 2;
    return centerX >= box.x && centerX <= box.x + box.w && centerY >= box.y && centerY <= box.y + box.h;
}
function wordCanBeClaimedByBox(wordBounds, box, overlapRatio) {
    if (isCropBox(box)) {
        return overlapRatio >= 0.7 || (overlapRatio >= 0.25 && wordCenterInsideBox(wordBounds, box));
    }
    return overlapRatio >= 0.15;
}
function escapeHtml(value) {
    return value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/\"/g, "&quot;")
        .replace(/'/g, "&#39;");
}
function isTextBox(box) {
    return box.tag !== "img" && box.tag !== "equation";
}
function isCropBox(box) {
    return box.tag === "img" || box.tag === "equation";
}
function cssSingleQuoted(value) {
    return `'${String(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}
function parseWordCss(pageNumber, cssText) {
    const map = new Map();
    const ruleRegex = new RegExp(`\\.page${pageNumber}__word(\\d+)\\s*\\{([^}]*)\\}`, "g");
    for (const m of cssText.matchAll(ruleRegex)) {
        const index = Number(m[1]);
        const body = String(m[2] ?? "");
        const getNum = (prop) => {
            const mm = body.match(new RegExp(`${prop}\\s*:\\s*(-?[0-9.]+)px`, "i"));
            return mm ? Number(mm[1]) : 0;
        };
        const getStr = (prop) => {
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
function parseRotation(transform) {
    const match = transform.match(/rotate\(\s*(-?[0-9.]+)deg\s*\)/i);
    return match ? Number(match[1]) : 0;
}
function parseWordHtml(pageNumber, html) {
    const map = new Map();
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
function stripPageWordRules(pageNumber, cssText) {
    const ruleRegex = new RegExp(`\\n?\\.page${pageNumber}__word\\d+\\s*\\{[^}]*\\}\\s*`, "g");
    return cssText
        .replace(ruleRegex, "\n")
        .replace(/\n?\.page__word\s*\{[^}]*\}\s*/g, "\n")
        .replace(/\n{3,}/g, "\n\n");
}
function extractFontFaceRules(cssText) {
    return Array.from(cssText.matchAll(/@font-face\s*\{[^}]*\}/gi))
        .map((match) => String(match[0] ?? "").trim())
        .filter(Boolean);
}
function stripFontFaceRules(cssText) {
    return cssText
        .replace(/@font-face\s*\{[^}]*\}\s*/gi, "")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}
function stripSharedReviewRules(cssText) {
    return cssText
        .replace(/\n?\.page__bg\s*\{[^}]*\}\s*/g, "\n")
        .replace(/\n?\.page__text\s*\{[^}]*\}\s*/g, "\n")
        .replace(/\n?\.page__word\s*\{[^}]*\}\s*/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}
function median(values) {
    if (!values.length)
        return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
function groupWordsIntoLines(words) {
    const sorted = [...words].sort((a, b) => (a.y - b.y) || (a.x - b.x));
    const lines = [];
    for (const word of sorted) {
        const tolerance = Math.max(2, word.h * 0.45);
        const line = lines.find((candidate) => Math.abs(median(candidate.map((w) => w.y)) - word.y) <= tolerance);
        if (line) {
            line.push(word);
        }
        else {
            lines.push([word]);
        }
    }
    return lines
        .map((line) => line.sort((a, b) => a.x - b.x))
        .sort((a, b) => median(a.map((w) => w.y)) - median(b.map((w) => w.y)));
}
function tableGapThreshold(line) {
    const gaps = [];
    for (let i = 1; i < line.length; i += 1) {
        const previous = line[i - 1];
        const current = line[i];
        gaps.push(Math.max(0, current.x - (previous.x + previous.w)));
    }
    const medianGap = median(gaps.filter((gap) => gap > 0));
    const medianHeight = median(line.map((word) => word.h));
    const medianFontSize = median(line.map((word) => word.fontSizePx));
    return Math.max(12, medianHeight * 0.75, medianFontSize * 0.85, medianGap * 2.4);
}
function segmentTableLine(line) {
    if (!line.length)
        return [];
    const threshold = tableGapThreshold(line);
    const segments = [[line[0]]];
    for (let i = 1; i < line.length; i += 1) {
        const previous = line[i - 1];
        const current = line[i];
        const gap = current.x - (previous.x + previous.w);
        if (gap > threshold) {
            segments.push([current]);
        }
        else {
            segments[segments.length - 1].push(current);
        }
    }
    return segments;
}
function clusterColumnStarts(segments, tolerance) {
    const starts = segments
        .filter((segment) => segment.length > 0)
        .map((segment) => getWordBounds(segment).x)
        .sort((a, b) => a - b);
    const clusters = [];
    for (const start of starts) {
        const cluster = clusters.find((candidate) => Math.abs(candidate.value - start) <= tolerance);
        if (cluster) {
            cluster.value = ((cluster.value * cluster.count) + start) / (cluster.count + 1);
            cluster.count += 1;
        }
        else {
            clusters.push({ value: start, count: 1 });
        }
    }
    return clusters.map((cluster) => cluster.value).sort((a, b) => a - b);
}
function nearestColumnIndex(columns, x) {
    if (!columns.length)
        return 0;
    let bestIndex = 0;
    let bestDistance = Number.POSITIVE_INFINITY;
    columns.forEach((columnX, index) => {
        const distance = Math.abs(columnX - x);
        if (distance < bestDistance) {
            bestDistance = distance;
            bestIndex = index;
        }
    });
    return bestIndex;
}
function isLikelyHeaderRow(words) {
    if (!words.length)
        return false;
    const boldCount = words.filter((word) => /bold|700|800|900/i.test(word.fontWeight)).length;
    return boldCount / words.length >= 0.5;
}
function tableCellText(words) {
    return words.map((word) => word.text).join(" ").replace(/\s+/g, " ").trim();
}
function isRotatedWord(word) {
    return Math.abs(word.rotation) > 0.01;
}
function wordVisualBounds(word) {
    if (word.rotation === -90)
        return { x: word.x, y: word.y - word.w, w: word.h, h: word.w };
    if (word.rotation === 90)
        return { x: word.x - word.h, y: word.y, w: word.h, h: word.w };
    if (Math.abs(word.rotation) === 180)
        return { x: word.x - word.w, y: word.y - word.h, w: word.w, h: word.h };
    return { x: word.x, y: word.y, w: word.w, h: word.h };
}
function formatPx(value) {
    return `${Number(value.toFixed(3))}px`;
}
function wordInheritedStyles(word) {
    return {
        "font-family": `${cssSingleQuoted(word.fontFamily)}, serif`,
        "font-size": formatPx(word.fontSizePx),
        "font-weight": word.fontWeight,
        "font-style": word.fontStyle,
        color: word.color
    };
}
function commonDeclarations(declarations, keys) {
    if (!declarations.length)
        return {};
    const common = {};
    for (const key of keys) {
        const firstValue = declarations[0][key];
        if (typeof firstValue !== "string")
            continue;
        if (declarations.every((entry) => entry[key] === firstValue)) {
            common[key] = firstValue;
        }
    }
    return common;
}
function subtractDeclarations(declarations, inherited) {
    const result = {};
    for (const [property, value] of Object.entries(declarations)) {
        if (inherited[property] !== value)
            result[property] = value;
    }
    return result;
}
function declarationsToCss(declarations) {
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
function styleClassName(prefix, index) {
    return `${prefix}${index}`;
}
function emptyFinalStyleRegistry() {
    return { version: 1, counters: {}, classes: [], fontFaces: [] };
}
const finalBuildLocks = new Map();
async function withFinalBuildLock(jobId, task) {
    const previous = finalBuildLocks.get(jobId) ?? Promise.resolve();
    const current = previous.catch(() => void 0).then(task);
    finalBuildLocks.set(jobId, current);
    try {
        await current;
    }
    finally {
        if (finalBuildLocks.get(jobId) === current)
            finalBuildLocks.delete(jobId);
    }
}
async function readFinalStyleRegistry(filePath) {
    try {
        const parsed = JSON.parse(await readFile(filePath, "utf8"));
        if (parsed.version !== 1 || !parsed.counters || !Array.isArray(parsed.classes) || !Array.isArray(parsed.fontFaces)) {
            return emptyFinalStyleRegistry();
        }
        return {
            version: 1,
            counters: parsed.counters,
            classes: parsed.classes.filter((entry) => Boolean(entry?.prefix && entry?.cssText && entry?.className)),
            fontFaces: parsed.fontFaces.filter((entry) => typeof entry === "string" && Boolean(entry.trim()))
        };
    }
    catch {
        return emptyFinalStyleRegistry();
    }
}
function mergeFontFaces(existing, incoming) {
    const byRule = new Map();
    for (const rule of [...existing, ...incoming]) {
        const normalized = rule.replace(/\s+/g, " ").trim();
        if (normalized && !byRule.has(normalized))
            byRule.set(normalized, rule.trim());
    }
    return [...byRule.values()];
}
function createStyleClassRegistry(stored = emptyFinalStyleRegistry()) {
    const counters = new Map();
    const byKey = new Map();
    const classes = [];
    for (const [prefix, count] of Object.entries(stored.counters))
        counters.set(prefix, count);
    for (const entry of stored.classes) {
        const key = `${entry.prefix}\u0000${entry.cssText}`;
        if (byKey.has(key))
            continue;
        byKey.set(key, entry.className);
        classes.push(entry);
    }
    return {
        use(prefix, declarations) {
            const cssText = declarationsToCss(declarations);
            if (!cssText)
                return "";
            const key = `${prefix}\u0000${cssText}`;
            const existing = byKey.get(key);
            if (existing)
                return existing;
            const nextIndex = (counters.get(prefix) ?? 0) + 1;
            counters.set(prefix, nextIndex);
            const className = styleClassName(prefix, nextIndex);
            byKey.set(key, className);
            classes.push({ prefix, cssText, className });
            return className;
        },
        rules() {
            return classes.map((entry) => `.${entry.className} { ${entry.cssText} }`);
        },
        snapshot(fontFaces) {
            return {
                version: 1,
                counters: Object.fromEntries(counters),
                classes: [...classes],
                fontFaces: [...fontFaces]
            };
        }
    };
}
const FINAL_COMMON_BASE_CSS = `html, body { margin: 0; padding: 0; }
.page { position: relative; overflow: hidden; }
.page__bg { position: absolute; inset: 0; width: 100%; height: 100%; z-index: 0; pointer-events: none; }
.page__text { position: absolute; inset: 0; z-index: 1; }
.page__word { user-select: text; }
.page__text > .page__word { position: absolute; margin: 0; padding: 0; white-space: nowrap; overflow: visible; background: transparent; z-index: 1; }
.page__para { position: absolute; margin: 0; padding: 0; border: 0; background: transparent; white-space: pre; overflow: visible; z-index: 1; }
.page__para--absolute .page__word { position: absolute; margin: 0; padding: 0; white-space: nowrap; overflow: visible; background: transparent; }
.page__line { display: flex; align-items: flex-start; margin: 0; padding: 0; box-sizing: border-box; white-space: nowrap; overflow: visible; }
.page__table { position: absolute; margin: 0; padding: 0; border: 0; border-collapse: collapse; border-spacing: 0; table-layout: fixed; background: transparent; white-space: normal; overflow: visible; z-index: 1; }
.page__table-row { margin: 0; padding: 0; border: 0; background: transparent; }
.page__table-cell { margin: 0; border: 0; background: transparent; box-sizing: border-box; vertical-align: top; text-align: left; white-space: pre; overflow: visible; font-weight: inherit; }
.page__table-word { position: static; display: inline; margin: 0; padding: 0; white-space: pre; background: transparent; }
.page__crop { position: absolute; display: block; margin: 0; padding: 0; border: 0; object-fit: fill; z-index: 2; }
.math-zone { background: transparent; overflow: visible; }
.math-crop-fallback { display: block; width: 100%; height: 100%; object-fit: fill; }
.math-zone--mathml .math-crop-fallback { display: none; }
.mathml-render { position: absolute; display: block; color: #000; line-height: 1; overflow: visible; transform-origin: top left; }
.mathml-render math { font-size: 1em; color: inherit; font-family: inherit; }
.math-latex { display: none; }`;
function buildFinalCommonCss(fontFaces, styleRules) {
    return `${fontFaces.join("\n\n")}\n\n${FINAL_COMMON_BASE_CSS}\n\n${styleRules.join("\n")}`.trim();
}
function semanticStyleClasses(registry, declarations) {
    const classNames = [
        registry.use("f", declarations["font-family"] ? { "font-family": declarations["font-family"] } : {}),
        registry.use("fs", declarations["font-size"] ? { "font-size": declarations["font-size"] } : {}),
        registry.use("fw", declarations["font-weight"] ? { "font-weight": declarations["font-weight"] } : {}),
        registry.use("fst", declarations["font-style"] ? { "font-style": declarations["font-style"] } : {}),
        registry.use("c", declarations.color ? { color: declarations.color } : {}),
        registry.use("lh", declarations["line-height"] ? { "line-height": declarations["line-height"] } : {}),
        registry.use("ta", declarations["text-align"] ? { "text-align": declarations["text-align"] } : {})
    ];
    return classNames.filter(Boolean);
}
function getWordBounds(words) {
    const bounds = words.map(wordVisualBounds);
    const left = Math.min(...bounds.map((box) => box.x));
    const top = Math.min(...bounds.map((box) => box.y));
    const right = Math.max(...bounds.map((box) => box.x + box.w));
    const bottom = Math.max(...bounds.map((box) => box.y + box.h));
    return { x: left, y: top, w: right - left, h: bottom - top };
}
function dominantValue(words, selector, fallback) {
    if (!words.length)
        return fallback;
    const weights = new Map();
    for (const word of words) {
        const value = selector(word).trim();
        if (!value)
            continue;
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
function clampNumber(value, min, max) {
    return Math.max(min, Math.min(max, value));
}
function mathCssFontFamily(sourceFontFamily) {
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
function inferEquationRenderStyle(box, selectedWords) {
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
function applyEquationRenderStyle(box, renderStyle) {
    if (box.tag !== "equation")
        return;
    box.math = {
        ...box.math,
        renderStyle
    };
}
function wordSpanHtml(pageNumber, word) {
    return `<span class="page__word page${pageNumber}__word${word.index}" data-word-index="${word.index}">${escapeHtml(word.text)}</span>`;
}
function tableWordSpanHtml(pageNumber, word) {
    return `<span class="page__table-word page${pageNumber}__word${word.index}" data-word-index="${word.index}">${escapeHtml(word.text)}</span>`;
}
function wordCssRule(pageNumber, word, offset) {
    const left = word.x - (offset?.x ?? 0);
    const top = word.y - (offset?.y ?? 0);
    const transformCss = word.transform ? ` transform-origin: ${word.transformOrigin}; transform: ${word.transform};` : "";
    return `.page${pageNumber}__word${word.index} { position: absolute; left: ${formatPx(left)}; top: ${formatPx(top)}; width: ${formatPx(word.w)}; height: ${formatPx(word.h)}; font-size: ${formatPx(word.fontSizePx)}; font-family: ${cssSingleQuoted(word.fontFamily)}, serif; font-weight: ${word.fontWeight}; font-style: ${word.fontStyle}; color: ${word.color}; white-space: nowrap; overflow: visible; background: transparent;${transformCss} }`;
}
function tableWordCssRule(pageNumber, word, inherited) {
    const declarations = subtractDeclarations(wordInheritedStyles(word), inherited);
    const cssText = declarationsToCss(declarations);
    return cssText ? `.page__table .page${pageNumber}__word${word.index} { ${cssText} }` : "";
}
function safeFileToken(value) {
    return value.replace(/[^A-Za-z0-9_-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 80) || "crop";
}
export function semanticBoxCropFileName(pageNumber, box) {
    return `page-${pageNumber}-${safeFileToken(box.id)}.png`;
}
function pageElementId(pageNumber, type, index) {
    return `page${String(pageNumber).padStart(4, "0")}_${type}${index}`;
}
function lineTop(line) {
    return Math.min(...line.map((word) => word.y));
}
function lineLeft(line) {
    return Math.min(...line.map((word) => word.x));
}
function lineBottom(line) {
    return Math.max(...line.map((word) => word.y + word.h));
}
function lineHeight(lines, lineIndex) {
    const currentTop = lineTop(lines[lineIndex]);
    const nextLine = lines[lineIndex + 1];
    if (nextLine)
        return Math.max(0, lineTop(nextLine) - currentTop);
    return Math.max(0, lineBottom(lines[lineIndex]) - currentTop);
}
function renderedLineHeight(line) {
    return Math.max(...line.map((word) => word.h));
}
function lineGapValues(line) {
    const gaps = [];
    for (let wordIndex = 0; wordIndex < line.length - 1; wordIndex += 1) {
        const word = line[wordIndex];
        const nextWord = line[wordIndex + 1];
        gaps.push(Math.max(0, nextWord.x - (word.x + word.w)));
    }
    return gaps;
}
function commonLineGap(line) {
    const gaps = lineGapValues(line);
    if (!gaps.length)
        return null;
    const averageGap = gaps.reduce((sum, gap) => sum + gap, 0) / gaps.length;
    const maxDeviation = Math.max(...gaps.map((gap) => Math.abs(gap - averageGap)));
    return maxDeviation <= 0.05 ? averageGap : null;
}
function sortedSemanticBoxes(boxes) {
    return [...boxes].sort((a, b) => {
        const aOrder = typeof a.readingOrder === "number" && Number.isFinite(a.readingOrder) ? a.readingOrder : Number.POSITIVE_INFINITY;
        const bOrder = typeof b.readingOrder === "number" && Number.isFinite(b.readingOrder) ? b.readingOrder : Number.POSITIVE_INFINITY;
        if (aOrder !== bOrder)
            return aOrder - bOrder;
        return Date.parse(a.createdAt) - Date.parse(b.createdAt);
    });
}
function inferTextAlign(box, lines, bounds) {
    if (!lines.length)
        return "left";
    const boxLeft = box.x;
    const boxRight = box.x + box.w;
    const boxCenter = box.x + (box.w / 2);
    const lineBounds = lines.map(getWordBounds);
    const averageCenterDelta = lineBounds.reduce((sum, line) => sum + Math.abs((line.x + (line.w / 2)) - boxCenter), 0) / lineBounds.length;
    const averageLeftDelta = lineBounds.reduce((sum, line) => sum + Math.abs(line.x - boxLeft), 0) / lineBounds.length;
    const averageRightDelta = lineBounds.reduce((sum, line) => sum + Math.abs((line.x + line.w) - boxRight), 0) / lineBounds.length;
    const tolerance = Math.max(4, Math.min(18, box.w * 0.08));
    if (averageCenterDelta <= tolerance && averageCenterDelta < averageLeftDelta && averageCenterDelta < averageRightDelta)
        return "center";
    if (averageRightDelta <= tolerance && averageRightDelta < averageLeftDelta)
        return "right";
    if (Math.abs((bounds.x + (bounds.w / 2)) - boxCenter) <= tolerance && averageCenterDelta < averageLeftDelta)
        return "center";
    return "left";
}
function flowWordCssRule(pageNumber, word, line, wordIndex, inherited, lineGap) {
    const nextWord = line[wordIndex + 1];
    const rawMarginRight = nextWord ? Math.max(0, nextWord.x - (word.x + word.w)) : 0;
    const marginRight = nextWord && lineGap !== null ? Math.max(0, rawMarginRight - lineGap) : rawMarginRight;
    const marginTop = Math.max(0, word.y - lineTop(line));
    const normalizedMarginTop = marginTop <= 0.05 ? 0 : marginTop;
    const normalizedMarginRight = marginRight <= 0.05 ? 0 : marginRight;
    const declarations = subtractDeclarations(wordInheritedStyles(word), inherited);
    const layoutDeclarations = {};
    if (normalizedMarginTop > 0 || normalizedMarginRight > 0) {
        layoutDeclarations.margin = `${formatPx(normalizedMarginTop)} ${formatPx(normalizedMarginRight)} 0 0`;
    }
    const cssText = declarationsToCss({ ...layoutDeclarations, ...declarations });
    return cssText ? `.page${pageNumber}__word${word.index} { ${cssText} }` : null;
}
async function copyFileOrKeepExisting(sourcePath, targetPath) {
    try {
        await copyFile(sourcePath, targetPath);
    }
    catch (error) {
        const existing = await stat(targetPath).catch(() => null);
        if (existing?.isFile())
            return;
        throw error;
    }
}
async function writeFinalPageImage(jobId, pageIndex, targetPath) {
    const imageBytes = await renderFinalBackgroundPng(jobId, pageIndex);
    const tempPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
    try {
        await writeFile(tempPath, imageBytes);
        await rename(tempPath, targetPath);
    }
    catch {
        await writeFile(targetPath, imageBytes);
    }
}
async function writeFinalTextFile(targetPath, content) {
    const tempPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
    try {
        await writeFile(tempPath, content, "utf8");
    }
    catch {
        await writeFile(targetPath, content, "utf8");
        return;
    }
    try {
        await rename(tempPath, targetPath);
    }
    catch {
        await writeFile(targetPath, content, "utf8");
    }
}
async function writeBinaryFileOrKeepExisting(targetPath, content) {
    try {
        await writeFile(targetPath, content);
    }
    catch (error) {
        const existing = await stat(targetPath).catch(() => null);
        if (existing?.isFile())
            return;
        throw error;
    }
}
async function writeImageCrops(jobId, pageIndex, imageBlocks, finalCropDir) {
    if (!imageBlocks.length)
        return;
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
export async function writeSemanticBoxCrop(jobId, pageIndex, box, fileName, finalCropDir) {
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
async function generateFinalPageFromBoxesUnlocked(jobId, pageIndex, boxes) {
    const pageNumber = pageIndex + 1;
    const orderedBoxes = sortedSemanticBoxes(boxes);
    const finalDir = jobStore.getFinalDir(jobId);
    const finalStyleDir = path.join(finalDir, "style");
    const finalImagesDir = path.join(finalDir, "images");
    const finalCropDir = path.join(finalImagesDir, "crops");
    const finalFontsDir = path.join(finalDir, "fonts");
    const styleRegistryDir = jobStore.getStylesDir(jobId);
    const styleRegistryPath = path.join(styleRegistryDir, "final-common.registry.json");
    const reviewHtmlPath = path.join(jobStore.getReviewDir(jobId), `page-${pageNumber}.html`);
    const reviewCssPath = path.join(jobStore.getReviewStylesDir(jobId), `page-${pageNumber}.css`);
    await Promise.all([
        mkdir(finalStyleDir, { recursive: true }),
        mkdir(styleRegistryDir, { recursive: true })
    ]);
    const [html, css] = await Promise.all([
        readFile(reviewHtmlPath, "utf8"),
        readFile(reviewCssPath, "utf8")
    ]);
    let storedStyleRegistry = await readFinalStyleRegistry(styleRegistryPath);
    if (storedStyleRegistry.classes.length === 0 && storedStyleRegistry.fontFaces.length === 0) {
        storedStyleRegistry = await readFinalStyleRegistry(path.join(finalStyleDir, "common.registry.json"));
    }
    const cssMap = parseWordCss(pageNumber, css);
    const htmlMap = parseWordHtml(pageNumber, html);
    const words = [];
    for (const [index, style] of cssMap.entries()) {
        const text = htmlMap.get(index);
        if (typeof text !== "string")
            continue;
        words.push({ index, ...style, text });
    }
    const byIndex = new Map(words.map((w) => [w.index, w]));
    words.sort((a, b) => (a.y - b.y) || (a.x - b.x));
    const paraBlocks = orderedBoxes.map((box) => ({ box, wordIndices: [] }));
    for (const word of words) {
        const wordBounds = wordVisualBounds(word);
        let bestBoxIndex = -1;
        let bestOverlapRatio = 0;
        orderedBoxes.forEach((box, index) => {
            const overlapRatio = wordBoxOverlapRatio(wordBounds, box);
            if (!wordCanBeClaimedByBox(wordBounds, box, overlapRatio))
                return;
            if (overlapRatio > bestOverlapRatio) {
                bestBoxIndex = index;
                bestOverlapRatio = overlapRatio;
            }
        });
        if (bestBoxIndex >= 0) {
            paraBlocks[bestBoxIndex].wordIndices.push(word.index);
        }
    }
    const claimed = new Set();
    for (const block of paraBlocks) {
        block.wordIndices.sort((a, b) => {
            const wa = byIndex.get(a);
            const wb = byIndex.get(b);
            if (!wa || !wb)
                return a - b;
            return (wa.y - wb.y) || (wa.x - wb.x);
        });
        block.wordIndices.forEach((wordIndex) => claimed.add(wordIndex));
    }
    const semanticBlocks = paraBlocks
        .map((block, i) => {
        if (!isTextBox(block.box))
            return null;
        const selectedWords = block.wordIndices
            .map((wordIndex) => byIndex.get(wordIndex))
            .filter((word) => Boolean(word));
        if (!selectedWords.length)
            return null;
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
        .filter((block) => Boolean(block));
    const textSemanticBlocks = semanticBlocks.filter((block) => block.box.tag !== "table");
    const tableSemanticBlocks = semanticBlocks.filter((block) => block.box.tag === "table");
    const cropBlocks = paraBlocks
        .filter((block) => isCropBox(block.box))
        .map((block, i) => {
        const selectedWords = block.wordIndices
            .map((wordIndex) => byIndex.get(wordIndex))
            .filter((word) => Boolean(word));
        const renderStyle = block.box.tag === "equation"
            ? inferEquationRenderStyle(block.box, selectedWords)
            : null;
        if (renderStyle)
            applyEquationRenderStyle(block.box, renderStyle);
        return {
            box: block.box,
            elementId: pageElementId(pageNumber, block.box.tag === "equation" ? "eq" : "img", i + 1),
            className: `page${pageNumber}-${block.box.tag === "equation" ? "eq" : "img"}${i + 1}`,
            fileName: semanticBoxCropFileName(pageNumber, block.box),
            selectedWords,
            renderStyle
        };
    });
    const styleClassRegistry = createStyleClassRegistry(storedStyleRegistry);
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
    const semanticModels = textSemanticBlocks.map((block) => {
        const parentOrigin = { x: block.box.x, y: block.box.y, w: block.box.w, h: block.box.h };
        if (block.isAbsolute) {
            const parentStyles = commonDeclarations(block.selectedWords.map(wordInheritedStyles), STYLE_OUTPUT_ORDER);
            return {
                ...block,
                parentOrigin,
                classNames: [baseParaClass, ...semanticStyleClasses(styleClassRegistry, parentStyles), "page__para", "page__para--absolute", block.className].filter(Boolean),
                parentStyles,
                lineModels: []
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
        const parentStyles = {
            ...commonDeclarations(lineModels.map((lineModel) => lineModel.styles), STYLE_OUTPUT_ORDER),
            "text-align": inferTextAlign(block.box, block.lines, block.bounds)
        };
        return {
            ...block,
            parentOrigin,
            classNames: [baseParaClass, ...semanticStyleClasses(styleClassRegistry, parentStyles), "page__para", block.className].filter(Boolean),
            parentStyles,
            lineModels
        };
    });
    const baseTableClass = styleClassRegistry.use("tbl", {
        position: "absolute",
        display: "table",
        margin: "0",
        padding: "0",
        border: "0",
        background: "transparent",
        "border-collapse": "collapse",
        "border-spacing": "0",
        "table-layout": "fixed",
        overflow: "visible",
        "z-index": "1"
    });
    const tableModels = tableSemanticBlocks.map((block, tableIndex) => {
        const tableElementId = pageElementId(pageNumber, "table", tableIndex + 1);
        const tableClassName = `page${pageNumber}-table${tableIndex + 1}`;
        const lines = groupWordsIntoLines(block.selectedWords);
        const rowSegments = lines.map(segmentTableLine);
        const allSegments = rowSegments.flat();
        const columnTolerance = Math.max(8, median(block.selectedWords.map((word) => word.fontSizePx)) * 0.75, median(block.selectedWords.map((word) => word.h)) * 0.75);
        const columns = clusterColumnStarts(allSegments, columnTolerance);
        const tableColumns = columns.length ? columns : [block.bounds.x];
        const tableBounds = block.bounds;
        const tableRight = tableBounds.x + tableBounds.w;
        const parentStyles = commonDeclarations(block.selectedWords.map(wordInheritedStyles), STYLE_OUTPUT_ORDER);
        const rows = rowSegments.map((segments, rowIndex) => {
            const rowWords = segments.flat().sort((a, b) => a.x - b.x);
            const rowBounds = rowWords.length ? getWordBounds(rowWords) : { x: tableBounds.x, y: tableBounds.y, w: tableBounds.w, h: 1 };
            const nextRowWords = rowSegments[rowIndex + 1]?.flat() ?? [];
            const nextRowBounds = nextRowWords.length ? getWordBounds(nextRowWords) : null;
            const rowHeight = nextRowBounds ? Math.max(rowBounds.h, nextRowBounds.y - rowBounds.y) : rowBounds.h;
            const cellsByColumn = new Map();
            for (const segment of segments) {
                const segmentBounds = getWordBounds(segment);
                const columnIndex = nearestColumnIndex(tableColumns, segmentBounds.x);
                const existing = cellsByColumn.get(columnIndex) ?? [];
                existing.push(...segment);
                cellsByColumn.set(columnIndex, existing.sort((a, b) => a.x - b.x));
            }
            const isHeader = isLikelyHeaderRow(rowWords);
            return {
                className: `${tableClassName}__row${rowIndex + 1}`,
                rowHeight,
                isHeader,
                cells: tableColumns.map((columnX, columnIndex) => {
                    const cellWords = cellsByColumn.get(columnIndex) ?? [];
                    const cellBounds = cellWords.length ? getWordBounds(cellWords) : { x: columnX, y: rowBounds.y, w: 0, h: rowBounds.h };
                    const nextColumnX = tableColumns[columnIndex + 1] ?? tableRight;
                    const width = Math.max(1, nextColumnX - columnX);
                    const cellStyles = subtractDeclarations(commonDeclarations(cellWords.map(wordInheritedStyles), STYLE_OUTPUT_ORDER), parentStyles);
                    return {
                        elementId: `${tableElementId}_r${rowIndex + 1}c${columnIndex + 1}`,
                        classNames: ["page__table-cell", `${tableClassName}__cell`, `${tableClassName}__r${rowIndex + 1}c${columnIndex + 1}`, ...semanticStyleClasses(styleClassRegistry, cellStyles)].filter(Boolean),
                        words: cellWords,
                        text: tableCellText(cellWords),
                        width,
                        height: rowHeight,
                        paddingLeft: Math.max(0, cellBounds.x - columnX),
                        paddingTop: Math.max(0, cellBounds.y - rowBounds.y),
                        inheritedStyles: { ...parentStyles, ...cellStyles }
                    };
                })
            };
        });
        return {
            ...block,
            elementId: tableElementId,
            className: tableClassName,
            classNames: [baseTableClass, ...semanticStyleClasses(styleClassRegistry, parentStyles), "page__table", tableClassName].filter(Boolean),
            parentStyles,
            tableBounds,
            rows
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
    const tableElements = tableModels.map((table) => {
        const rowsHtml = table.rows.map((row) => {
            const cellsHtml = row.cells.map((cell) => {
                const cellContent = cell.words.map((word, wordIndex) => `${wordIndex > 0 ? " " : ""}${tableWordSpanHtml(pageNumber, word)}`).join("");
                const cellTag = row.isHeader ? "th" : "td";
                const scope = row.isHeader ? " scope=\"col\"" : "";
                return `<${cellTag} id="${cell.elementId}" class="${cell.classNames.join(" ")}" data-text="${escapeHtml(cell.text)}"${scope}>${cellContent}</${cellTag}>`;
            }).join("");
            return `<tr class="page__table-row ${row.className}">${cellsHtml}</tr>`;
        }).join("");
        return `<table id="${table.elementId}" class="${table.classNames.join(" ")}" data-box-id="${escapeHtml(table.box.id)}" data-row-count="${table.rows.length}" data-column-count="${table.rows[0]?.cells.length ?? 0}"><tbody>${rowsHtml}</tbody></table>`;
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
<link rel="stylesheet" href="./style/common.css">
<link rel="stylesheet" href="./style/page-${pageNumber}.css">
</head>
<body>
<div class="page">
<img class="page__bg" src="./images/page-${pageNumber}.png" alt="">
<div class="page__text">
${semanticElements}
${tableElements}
${leftoverWords}
${imageElements}
</div>
</div>
</body>
</html>`;
    const paraCssBlocks = [];
    const lineCssBlocks = [];
    const tableCssBlocks = [];
    const semanticWordRules = [];
    const imageCssBlocks = cropBlocks.map((block) => {
        const renderStyle = block.renderStyle;
        const baseRule = `#${block.elementId} { left: ${formatPx(block.box.x)}; top: ${formatPx(block.box.y)}; width: ${formatPx(block.box.w)}; height: ${formatPx(block.box.h)}; }`;
        if (!renderStyle)
            return baseRule;
        return `${baseRule}\n#${block.elementId} .mathml-render { left: ${formatPx(renderStyle.leftOffsetPx)}; top: ${formatPx(renderStyle.topOffsetPx)}; width: ${formatPx(renderStyle.widthPx)}; height: ${formatPx(renderStyle.heightPx)}; font-size: ${formatPx(renderStyle.fontSizePx)}; color: ${renderStyle.color}; font-family: ${renderStyle.cssFontFamily}; }`;
    });
    for (const block of semanticModels) {
        if (block.isAbsolute) {
            const parentCss = declarationsToCss({
                left: formatPx(block.parentOrigin.x),
                top: formatPx(block.parentOrigin.y),
                width: formatPx(block.parentOrigin.w),
                height: formatPx(block.parentOrigin.h)
            });
            paraCssBlocks.push(`#${block.elementId} { ${parentCss} }`);
            for (const word of block.selectedWords) {
                semanticWordRules.push(`.${block.className} ${wordCssRule(pageNumber, word, block.parentOrigin)}`);
            }
            continue;
        }
        const parentLayout = {
            left: formatPx(block.parentOrigin.x),
            top: formatPx(block.parentOrigin.y),
            width: formatPx(block.parentOrigin.w)
        };
        const paddingTop = Math.max(0, block.bounds.y - block.parentOrigin.y);
        if (paddingTop > 0.001)
            parentLayout["padding-top"] = formatPx(paddingTop);
        const parentCss = declarationsToCss(parentLayout);
        paraCssBlocks.push(`#${block.elementId} { ${parentCss} }`);
        block.lineModels.forEach((lineModel, lineIndex) => {
            const { line, commonGap, styles } = lineModel;
            const lineClassName = `${block.className}__line${lineIndex + 1}`;
            const lineStyles = subtractDeclarations(styles, block.parentStyles);
            const lineLayout = {
                height: formatPx(lineHeight(block.lines, lineIndex)),
                "padding-left": formatPx(lineLeft(line) - block.parentOrigin.x)
            };
            if (commonGap !== null)
                lineLayout["column-gap"] = formatPx(commonGap);
            const lineCss = declarationsToCss({ ...lineStyles, ...lineLayout });
            lineCssBlocks.push(`.${lineClassName} { ${lineCss} }`);
            line.forEach((word, wordIndex) => {
                const wordRule = flowWordCssRule(pageNumber, word, line, wordIndex, styles, commonGap);
                if (wordRule)
                    semanticWordRules.push(`.${block.className} ${wordRule}`);
            });
        });
    }
    for (const table of tableModels) {
        tableCssBlocks.push(`#${table.elementId} { left: ${formatPx(table.tableBounds.x)}; top: ${formatPx(table.tableBounds.y)}; width: ${formatPx(table.tableBounds.w)}; }`);
        for (const row of table.rows) {
            tableCssBlocks.push(`.${row.className} { height: ${formatPx(row.rowHeight)}; }`);
            for (const cell of row.cells) {
                tableCssBlocks.push(`#${cell.elementId} { width: ${formatPx(cell.width)}; height: ${formatPx(cell.height)}; padding: ${formatPx(cell.paddingTop)} 0 0 ${formatPx(cell.paddingLeft)}; }`);
                for (const word of cell.words) {
                    const wordRule = tableWordCssRule(pageNumber, word, cell.inheritedStyles);
                    if (wordRule)
                        semanticWordRules.push(wordRule);
                }
            }
        }
    }
    const wordRules = words
        .filter((w) => !claimed.has(w.index))
        .map((w) => wordCssRule(pageNumber, w))
        .join("\n");
    const pageSourceCss = stripSharedReviewRules(stripFontFaceRules(stripPageWordRules(pageNumber, css)));
    const finalCss = `${pageSourceCss}\n\n${paraCssBlocks.join("\n")}\n\n${lineCssBlocks.join("\n")}\n\n${tableCssBlocks.join("\n")}\n\n${semanticWordRules.join("\n")}\n\n${imageCssBlocks.join("\n")}\n\n${wordRules}`.trim();
    const fontFaces = mergeFontFaces(storedStyleRegistry.fontFaces, extractFontFaceRules(css));
    const finalStyleRegistry = styleClassRegistry.snapshot(fontFaces);
    const finalCommonCss = buildFinalCommonCss(fontFaces, styleClassRegistry.rules());
    await mkdir(finalImagesDir, { recursive: true });
    await mkdir(finalCropDir, { recursive: true });
    await mkdir(finalFontsDir, { recursive: true });
    // Copy page image and all fonts into final (simple, safe).
    await writeFinalPageImage(jobId, pageIndex, path.join(finalImagesDir, `page-${pageNumber}.png`));
    await writeImageCrops(jobId, pageIndex, cropBlocks, finalCropDir);
    const fontEntries = await readdir(jobStore.getFontsDir(jobId)).catch(() => []);
    for (const entry of fontEntries) {
        if (!entry || entry.endsWith(".json"))
            continue;
        await copyFile(path.join(jobStore.getFontsDir(jobId), entry), path.join(finalFontsDir, entry)).catch(() => void 0);
    }
    await Promise.all([
        writeFinalTextFile(path.join(finalDir, `page-${pageNumber}.html`), finalHtml),
        writeFinalTextFile(path.join(finalStyleDir, `page-${pageNumber}.css`), finalCss),
        writeFinalTextFile(path.join(finalStyleDir, "common.css"), finalCommonCss),
        writeFinalTextFile(styleRegistryPath, JSON.stringify(finalStyleRegistry, null, 2)),
        unlink(path.join(finalStyleDir, "common.registry.json")).catch(() => void 0)
    ]);
}
export async function generateFinalPageFromBoxes(jobId, pageIndex, boxes) {
    return withFinalBuildLock(jobId, () => generateFinalPageFromBoxesUnlocked(jobId, pageIndex, boxes));
}
