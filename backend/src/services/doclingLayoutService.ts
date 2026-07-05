import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import pLimit from "p-limit";
import { doclingLayoutScriptPath, pythonCommandCandidates } from "../config/runtime.js";
import { jobStore, type StoredJobState } from "./jobStore.js";

const DOCLING_LIMIT = pLimit(1);

export interface LayoutModelBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface LayoutModelItem {
  pageIndex: number;
  label: string;
  text: string;
  bbox: LayoutModelBox;
  pageSize?: {
    width: number;
    height: number;
  };
  confidence?: number | null;
  order: number;
}

export interface LayoutModelResult {
  engine: "docling";
  status: "ok" | "unavailable" | "failed";
  message?: string;
  items: LayoutModelItem[];
}

function cachePath(jobId: string): string {
  return path.join(jobStore.getAccessibilityDir(jobId), "docling-layout.json");
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isBox(value: unknown): value is LayoutModelBox {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return isFiniteNumber(candidate.x) && isFiniteNumber(candidate.y) && isFiniteNumber(candidate.w) && isFiniteNumber(candidate.h);
}

function normalizeResult(value: unknown): LayoutModelResult {
  if (!value || typeof value !== "object") {
    return { engine: "docling", status: "failed", message: "Docling returned invalid JSON.", items: [] };
  }
  const payload = value as Record<string, unknown>;
  const status = payload.status === "ok" || payload.status === "unavailable" || payload.status === "failed" ? payload.status : "failed";
  const rawItems = Array.isArray(payload.items) ? payload.items : [];
  const items: LayoutModelItem[] = [];
  for (const rawItem of rawItems) {
    if (!rawItem || typeof rawItem !== "object") continue;
    const item = rawItem as Record<string, unknown>;
    if (!Number.isInteger(item.pageIndex) || !isBox(item.bbox)) continue;
    const pageSize = item.pageSize && typeof item.pageSize === "object"
      ? item.pageSize as Record<string, unknown>
      : null;
    items.push({
      pageIndex: item.pageIndex as number,
      label: typeof item.label === "string" && item.label.trim() ? item.label.trim() : "text",
      text: typeof item.text === "string" ? item.text : "",
      bbox: {
        x: item.bbox.x,
        y: item.bbox.y,
        w: item.bbox.w,
        h: item.bbox.h
      },
      pageSize: pageSize && isFiniteNumber(pageSize.width) && isFiniteNumber(pageSize.height)
        ? { width: pageSize.width, height: pageSize.height }
        : undefined,
      confidence: isFiniteNumber(item.confidence) ? item.confidence : null,
      order: Number.isInteger(item.order) ? item.order as number : items.length + 1
    });
  }
  return {
    engine: "docling",
    status,
    message: typeof payload.message === "string" ? payload.message : undefined,
    items
  };
}

async function readCachedResult(jobId: string): Promise<LayoutModelResult | null> {
  try {
    const parsed = JSON.parse(await readFile(cachePath(jobId), "utf8")) as unknown;
    const result = normalizeResult(parsed);
    return result.status === "ok" ? result : null;
  } catch {
    return null;
  }
}

async function writeCachedResult(jobId: string, result: LayoutModelResult): Promise<void> {
  if (result.status !== "ok") return;
  await mkdir(jobStore.getAccessibilityDir(jobId), { recursive: true });
  await writeFile(cachePath(jobId), JSON.stringify(result, null, 2), "utf8");
}

function runPython(command: string, sourcePdf: string): Promise<LayoutModelResult> {
  return new Promise((resolve) => {
    const child = spawn(command, [doclingLayoutScriptPath, sourcePdf], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      resolve({
        engine: "docling",
        status: "unavailable",
        message: `Unable to launch Python command ${command}: ${error.message}`,
        items: []
      });
    });
    child.on("close", (code) => {
      if (code !== 0 && !stdout.trim()) {
        resolve({
          engine: "docling",
          status: "failed",
          message: (stderr || `Docling runner exited with code ${code}`).trim(),
          items: []
        });
        return;
      }
      try {
        const result = normalizeResult(JSON.parse(stdout));
        if (result.status !== "ok" && stderr.trim() && !result.message) {
          result.message = stderr.trim();
        }
        resolve(result);
      } catch (error) {
        resolve({
          engine: "docling",
          status: "failed",
          message: error instanceof Error ? error.message : "Docling runner returned invalid JSON.",
          items: []
        });
      }
    });
  });
}

async function runDocling(job: StoredJobState): Promise<LayoutModelResult> {
  const messages: string[] = [];
  for (const command of pythonCommandCandidates()) {
    const result = await runPython(command, job.filePath);
    if (result.status === "ok") return result;
    messages.push(`${command}: ${result.message ?? result.status}`);
    if (result.status === "failed") return result;
  }
  return {
    engine: "docling",
    status: "unavailable",
    message: messages.join(" | ") || "No Python command candidates available for Docling.",
    items: []
  };
}

export async function getDoclingLayout(job: StoredJobState, force = false): Promise<LayoutModelResult> {
  return DOCLING_LIMIT(async () => {
    if (!force) {
      const cached = await readCachedResult(job.id);
      if (cached) return cached;
    }
    const result = await runDocling(job);
    await writeCachedResult(job.id, result);
    return result;
  });
}
