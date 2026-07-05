import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { type SpanCorrection } from "../types.js";
import { jobStore } from "./jobStore.js";

const OVERRIDE_START = "/* span-correction-overrides:start */";
const OVERRIDE_END = "/* span-correction-overrides:end */";
const BOOK_CORRECTION_CONCURRENCY = 12;
const backgroundBookApplies = new Map<string, Promise<void>>();

type WordRule = {
  pageIndex: number;
  pageNumber: number;
  wordIndex: number;
  selector: string;
  body: string;
  declarations: Map<string, string>;
};

function correctionsPath(jobId: string): string {
  return path.join(jobStore.getJobDir(jobId), "span-corrections.json");
}

async function readJson<T>(filePath: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as T;
  } catch {
    return fallback;
  }
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(value, null, 2), "utf8");
}

function normalizeFamily(value: string): string {
  return value
    .split(",")[0]
    .replace(/^['"]|['"]$/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function parsePx(value: string | undefined): number | null {
  if (!value) return null;
  const match = value.match(/(-?\d+(?:\.\d+)?)px/i);
  if (!match) return null;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatPx(value: number): string {
  return `${Number(value.toFixed(3))}px`;
}

function parseDeclarations(body: string): Map<string, string> {
  const declarations = new Map<string, string>();
  for (const part of body.split(";")) {
    const index = part.indexOf(":");
    if (index < 0) continue;
    const key = part.slice(0, index).trim().toLowerCase();
    const value = part.slice(index + 1).trim();
    if (key && value) declarations.set(key, value);
  }
  return declarations;
}

function serializeDeclarations(declarations: Map<string, string>): string {
  return [...declarations.entries()].map(([key, value]) => `${key}: ${value};`).join(" ");
}

function stripOverrideBlock(css: string): string {
  const pattern = new RegExp(`\\n?${OVERRIDE_START.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\s\\S]*?${OVERRIDE_END.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\n?`, "g");
  return css.replace(pattern, "\n").trimEnd();
}

function parseWordRules(pageIndex: number, css: string): WordRule[] {
  const pageNumber = pageIndex + 1;
  const rules: WordRule[] = [];
  const regex = new RegExp(`(\\.page${pageNumber}__word(\\d+))\\s*\\{([^}]*)\\}`, "g");
  for (const match of css.matchAll(regex)) {
    rules.push({
      pageIndex,
      pageNumber,
      wordIndex: Number(match[2]),
      selector: match[1],
      body: match[3],
      declarations: parseDeclarations(match[3])
    });
  }
  return rules;
}

function normalizeClassName(value: string | undefined): string {
  return (value ?? "").trim().replace(/^\./, "");
}

function ruleHasClass(rule: WordRule, cssClassName: string | undefined): boolean {
  const normalized = normalizeClassName(cssClassName);
  if (!normalized) return false;
  return rule.selector.replace(/^\./, "") === normalized;
}

function correctionKey(correction: Pick<SpanCorrection, "scope" | "pageIndex" | "wordIndex" | "cssClassName" | "fontFamily" | "fontSizePx" | "fontStyle">): string {
  const cssClassName = normalizeClassName(correction.cssClassName);
  if (cssClassName && correction.scope === "span") return `${correction.scope}:class:${cssClassName}`;
  if (correction.scope === "span") return `${correction.scope}:${correction.pageIndex}:${correction.wordIndex}`;
  const styleKey = [
    normalizeFamily(correction.fontFamily),
    Number(correction.fontSizePx.toFixed(3)),
    correction.fontStyle.trim().toLowerCase()
  ].join(":");
  return correction.scope === "page-font-size"
    ? `${correction.scope}:${correction.pageIndex}:${styleKey}`
    : `${correction.scope}:${styleKey}`;
}

function matchesCorrection(rule: WordRule, correction: SpanCorrection): boolean {
  if (correction.scope === "span" && ruleHasClass(rule, correction.cssClassName)) {
    return true;
  }
  if (correction.scope === "span") {
    return rule.pageIndex === correction.pageIndex && rule.wordIndex === correction.wordIndex;
  }
  if (correction.scope === "page-font-size" && rule.pageIndex !== correction.pageIndex) return false;

  const fontFamily = rule.declarations.get("font-family") ?? "";
  const fontSize = parsePx(rule.declarations.get("font-size"));
  const fontStyle = (rule.declarations.get("font-style") ?? "normal").trim().toLowerCase();
  return normalizeFamily(fontFamily) === normalizeFamily(correction.fontFamily)
    && fontSize !== null
    && Math.abs(fontSize - correction.fontSizePx) < 0.01
    && fontStyle === correction.fontStyle.trim().toLowerCase();
}

function correctionCanAffectPage(correction: SpanCorrection, pageIndex: number): boolean {
  if (correction.scope === "book-font-size") return true;
  return correction.pageIndex === pageIndex;
}

function cssMayContainCorrection(css: string, correction: SpanCorrection): boolean {
  if (correction.scope === "span") {
    const className = normalizeClassName(correction.cssClassName);
    return className ? css.includes(`.${className}`) : css.includes(`.page${correction.pageIndex + 1}__word${correction.wordIndex}`);
  }
  return css.includes("font-family")
    && css.includes("font-size")
    && css.includes(correction.fontSizePx.toString())
    && css.toLowerCase().includes(correction.fontStyle.trim().toLowerCase());
}

function cssMayContainAnyCorrection(css: string, corrections: SpanCorrection[]): boolean {
  return corrections.some((correction) => cssMayContainCorrection(css, correction));
}

function buildOverrideRules(pageIndex: number, baseCss: string, corrections: SpanCorrection[]): string[] {
  const pageCorrections = corrections.filter((correction) => correctionCanAffectPage(correction, pageIndex));
  if (pageCorrections.length === 0) return [];
  if (!cssMayContainAnyCorrection(baseCss, pageCorrections)) return [];
  const rules = parseWordRules(pageIndex, baseCss);
  const overrides: string[] = [];
  for (const rule of rules) {
    let topDelta = 0;
    let leftDelta = 0;
    let letterSpacingPx: number | null = null;
    for (const correction of pageCorrections) {
      if (!matchesCorrection(rule, correction)) continue;
      topDelta += correction.topDeltaPx;
      leftDelta += correction.leftDeltaPx;
      if (Number.isFinite(correction.letterSpacingPx) && Math.abs(correction.letterSpacingPx) > 0.001) {
        letterSpacingPx = correction.letterSpacingPx;
      }
    }
    if (Math.abs(topDelta) < 0.001 && Math.abs(leftDelta) < 0.001 && letterSpacingPx === null) continue;
    const left = parsePx(rule.declarations.get("left"));
    const top = parsePx(rule.declarations.get("top"));
    if (left === null || top === null) continue;
    const declarations = new Map(rule.declarations);
    declarations.set("left", formatPx(left + leftDelta));
    declarations.set("top", formatPx(top + topDelta));
    if (letterSpacingPx !== null) declarations.set("letter-spacing", formatPx(letterSpacingPx));
    overrides.push(`${rule.selector} { ${serializeDeclarations(declarations)} }`);
  }
  return overrides;
}

async function mapWithConcurrency<T, R>(items: T[], concurrency: number, mapper: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(1, concurrency), items.length);
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (true) {
      const index = nextIndex++;
      if (index >= items.length) return;
      results[index] = await mapper(items[index]);
    }
  }));
  return results;
}

export async function getSpanCorrections(jobId: string): Promise<SpanCorrection[]> {
  const payload = await readJson<{ corrections?: SpanCorrection[] }>(correctionsPath(jobId), { corrections: [] });
  return Array.isArray(payload.corrections) ? payload.corrections : [];
}

function pagesAffectedByCorrection(correction: SpanCorrection, previousCorrection?: SpanCorrection): Set<number> | null {
  if (previousCorrection?.scope === "book-font-size") return null;
  const pages = new Set([correction.pageIndex]);
  if (previousCorrection) pages.add(previousCorrection.pageIndex);
  return pages;
}

function queueBookCorrectionApply(jobId: string, corrections: SpanCorrection[]): void {
  const previous = backgroundBookApplies.get(jobId) ?? Promise.resolve();
  const next = previous
    .catch(() => void 0)
    .then(async () => {
      await applySpanCorrections(jobId, corrections, null);
    })
    .catch((error) => {
      console.warn(`[span-corrections] background book apply failed for ${jobId}:`, error);
    })
    .finally(() => {
      if (backgroundBookApplies.get(jobId) === next) backgroundBookApplies.delete(jobId);
    });
  backgroundBookApplies.set(jobId, next);
}

export async function saveSpanCorrection(jobId: string, input: Omit<SpanCorrection, "id" | "createdAt" | "updatedAt"> & Partial<Pick<SpanCorrection, "id">>): Promise<{ correctionCount: number; affectedPages: number[] }> {
  const existing = await getSpanCorrections(jobId);
  const now = new Date().toISOString();
  const inputKey = correctionKey(input);
  const previousCorrection = existing.find((item) => item.id === input.id || correctionKey(item) === inputKey);
  const nextCorrection: SpanCorrection = {
    id: input.id ?? previousCorrection?.id ?? randomUUID(),
    scope: input.scope,
    pageIndex: input.pageIndex,
    wordIndex: input.wordIndex,
    cssClassName: normalizeClassName(input.cssClassName),
    fontFamily: input.fontFamily,
    fontSizePx: input.fontSizePx,
    fontWeight: input.fontWeight,
    fontStyle: input.fontStyle,
    topDeltaPx: (previousCorrection?.topDeltaPx ?? 0) + input.topDeltaPx,
    leftDeltaPx: (previousCorrection?.leftDeltaPx ?? 0) + input.leftDeltaPx,
    letterSpacingPx: input.letterSpacingPx,
    createdAt: previousCorrection?.createdAt ?? now,
    updatedAt: now
  };
  const replaceKey = correctionKey(nextCorrection);
  const corrections = [
    ...existing.filter((item) => item.id !== nextCorrection.id && correctionKey(item) !== replaceKey),
    nextCorrection
  ];
  await writeJson(correctionsPath(jobId), { corrections });
  const targetPages = nextCorrection.scope === "book-font-size"
    ? new Set([nextCorrection.pageIndex])
    : pagesAffectedByCorrection(nextCorrection, previousCorrection);
  const affectedPages = await applySpanCorrections(jobId, corrections, targetPages);
  if (nextCorrection.scope === "book-font-size") {
    queueBookCorrectionApply(jobId, corrections);
  }
  return { correctionCount: corrections.length, affectedPages };
}

export async function applySpanCorrections(jobId: string, corrections?: SpanCorrection[], targetPages?: Set<number> | null): Promise<number[]> {
  const activeCorrections = corrections ?? await getSpanCorrections(jobId);
  const styleDir = jobStore.getReviewStylesDir(jobId);
  const entries = targetPages
    ? [...targetPages].map((pageIndex) => `page-${pageIndex + 1}.css`)
    : await readdir(styleDir).catch(() => []);
  const targetEntries = entries.filter((entry) => {
    const match = entry.match(/^page-(\d+)\.css$/);
    if (!match) return false;
    const pageIndex = Number(match[1]) - 1;
    return !targetPages || targetPages.has(pageIndex);
  });
  const affectedPages = await mapWithConcurrency(targetEntries, targetPages ? 1 : BOOK_CORRECTION_CONCURRENCY, async (entry) => {
    const match = entry.match(/^page-(\d+)\.css$/);
    if (!match) return null;
    const pageIndex = Number(match[1]) - 1;
    const filePath = path.join(styleDir, entry);
    const originalCss = await readFile(filePath, "utf8");
    const baseCss = stripOverrideBlock(originalCss);
    const overrides = buildOverrideRules(pageIndex, baseCss, activeCorrections);
    const nextCss = overrides.length
      ? `${baseCss.trimEnd()}\n\n${OVERRIDE_START}\n${overrides.join("\n")}\n${OVERRIDE_END}\n`
      : `${baseCss.trimEnd()}\n`;
    if (nextCss !== originalCss) {
      await writeFile(filePath, nextCss, "utf8");
      return pageIndex;
    }
    return null;
  });
  return affectedPages.filter((pageIndex): pageIndex is number => pageIndex !== null).sort((a, b) => a - b);
}
