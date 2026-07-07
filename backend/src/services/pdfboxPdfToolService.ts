import { spawn } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pdfboxPdfToolJarPath } from "../config/runtime.js";
import { jobStore } from "./jobStore.js";
import { createJobLogger } from "./jobLogger.js";

export interface PdfChunkManifest {
  engine: "pdfbox";
  sourcePdf: string;
  pageCount: number;
  pagesPerChunk: number;
  chunks: Array<{
    chunkIndex: number;
    fileName: string;
    startPage: number;
    endPage: number;
    pageCount: number;
    sizeBytes: number;
  }>;
}

const DEFAULT_JAVA_BIN = process.env.JAVA_BIN
  || (process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, "bin", process.platform === "win32" ? "java.exe" : "java") : null)
  || "java";

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function runJava(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string; error?: Error }> {
  return new Promise((resolve) => {
    const child = spawn(DEFAULT_JAVA_BIN, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", (error) => resolve({ code: null, stdout, stderr, error }));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

export async function splitPdfWithPdfBox(jobId: string, sourcePdf: string, pagesPerChunk = 50): Promise<PdfChunkManifest> {
  const logger = createJobLogger(jobId);
  const jarPath = process.env.PDFBOX_PDF_TOOL_JAR || pdfboxPdfToolJarPath;
  if (!(await fileExists(jarPath))) {
    throw new Error(`PDFBox PDF tool jar not found at ${jarPath}. Build backend/tools/pdfbox-pdf-tool first.`);
  }

  const chunksDir = path.join(jobStore.getJobDir(jobId), "optimized", "chunks");
  const manifestPath = path.join(chunksDir, "manifest.json");
  await mkdir(chunksDir, { recursive: true });

  await logger.info("pdfbox.split.start", { sourcePdf, pagesPerChunk, chunksDir });
  const result = await runJava(["-jar", jarPath, "split", sourcePdf, chunksDir, String(pagesPerChunk), manifestPath]);
  if (result.error) {
    await logger.error("pdfbox.split.error", result.error);
    throw result.error;
  }
  if (result.code !== 0) {
    const message = (result.stderr || result.stdout || `PDFBox split exited with code ${result.code}`).trim();
    await logger.error("pdfbox.split.error", new Error(message), { code: result.code });
    throw new Error(message);
  }

  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as PdfChunkManifest;
  await logger.info("pdfbox.split.done", {
    pageCount: manifest.pageCount,
    chunks: manifest.chunks.length,
    largestChunkBytes: Math.max(0, ...manifest.chunks.map((chunk) => chunk.sizeBytes))
  });
  return manifest;
}

export interface PdfTagReport {
  engine: "pdfbox";
  sourcePdf: string;
  outputPdf: string;
  pageCount: number;
  plannedTags: number;
  writtenTags: number;
}

export async function writeTaggedPdfWithPdfBox(jobId: string, sourcePdf: string, tagPlanTsv: string, outputPdf: string): Promise<PdfTagReport> {
  const logger = createJobLogger(jobId);
  const jarPath = process.env.PDFBOX_PDF_TOOL_JAR || pdfboxPdfToolJarPath;
  if (!(await fileExists(jarPath))) {
    throw new Error(`PDFBox PDF tool jar not found at ${jarPath}. Build backend/tools/pdfbox-pdf-tool first.`);
  }

  const accessibilityDir = jobStore.getAccessibilityDir(jobId);
  const planPath = path.join(accessibilityDir, "tag-plan.tsv");
  const reportPath = path.join(accessibilityDir, "tagged-report.json");
  await mkdir(accessibilityDir, { recursive: true });
  await writeFile(planPath, tagPlanTsv, "utf8");

  await logger.info("pdfbox.tag.start", { sourcePdf, planPath, outputPdf });
  const result = await runJava(["-jar", jarPath, "tag", sourcePdf, planPath, outputPdf, reportPath]);
  if (result.error) {
    await logger.error("pdfbox.tag.error", result.error);
    throw result.error;
  }
  if (result.code !== 0) {
    const message = (result.stderr || result.stdout || `PDFBox tag export exited with code ${result.code}`).trim();
    await logger.error("pdfbox.tag.error", new Error(message), { code: result.code });
    throw new Error(message);
  }

  const report = JSON.parse(await readFile(reportPath, "utf8")) as PdfTagReport;
  await logger.info("pdfbox.tag.done", { ...report });
  return report;
}
