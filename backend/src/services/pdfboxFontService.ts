import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { type FontExtractionManifest } from "../types.js";
import { pdfboxJarPath } from "../config/runtime.js";
import { jobStore } from "./jobStore.js";

const DEFAULT_JAR_PATH = pdfboxJarPath;
const DEFAULT_JAVA_BIN = process.env.JAVA_BIN
  || (process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, "bin", process.platform === "win32" ? "java.exe" : "java") : null)
  || "java";

function buildUnavailableManifest(sourcePdf: string, message: string): FontExtractionManifest {
  return {
    sourcePdf,
    engine: "pdfbox",
    status: "unavailable",
    message,
    fonts: []
  };
}

function buildFailedManifest(sourcePdf: string, message: string): FontExtractionManifest {
  return {
    sourcePdf,
    engine: "pdfbox",
    status: "failed",
    message,
    fonts: []
  };
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readManifest(filePath: string): Promise<FontExtractionManifest> {
  const content = await readFile(filePath, "utf8");
  return JSON.parse(content) as FontExtractionManifest;
}

function normalizeManifest(manifest: FontExtractionManifest, sourcePdf: string): FontExtractionManifest {
  return {
    sourcePdf,
    engine: "pdfbox",
    status: manifest.status ?? "ok",
    message: manifest.message,
    fonts: Array.isArray(manifest.fonts) ? manifest.fonts.map((font) => ({
      resourceName: font.resourceName,
      baseFont: font.baseFont,
      family: font.family,
      format: font.format,
      fileName: font.fileName,
      fontWeight: font.fontWeight,
      fontStyle: font.fontStyle,
      pages: [...new Set(font.pages)].sort((a, b) => a - b)
    })) : []
  };
}

export async function extractFontsWithPdfBox(jobId: string, sourcePdf: string): Promise<FontExtractionManifest> {
  const jarPath = process.env.PDFBOX_FONT_EXTRACTOR_JAR || DEFAULT_JAR_PATH;
  const manifestPath = jobStore.getFontManifestPath(jobId);
  const fontsDir = jobStore.getFontsDir(jobId);

  if (!(await fileExists(jarPath))) {
    const manifest = buildUnavailableManifest(sourcePdf, `PDFBox font extractor jar not found at ${jarPath}`);
    await jobStore.saveFontManifest(jobId, manifest);
    return manifest;
  }

  const result = await new Promise<{ code: number | null; stdout: string; stderr: string; error?: Error }>((resolve) => {
    const child = spawn(DEFAULT_JAVA_BIN, ["-jar", jarPath, sourcePdf, fontsDir, manifestPath], {
      stdio: ["ignore", "pipe", "pipe"]
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
      resolve({ code: null, stdout, stderr, error });
    });
    child.on("close", (code) => {
      resolve({ code, stdout, stderr });
    });
  });

  if (result.error) {
    const manifest = buildUnavailableManifest(sourcePdf, result.error.message);
    await jobStore.saveFontManifest(jobId, manifest);
    return manifest;
  }

  if (result.code !== 0) {
    const manifest = buildFailedManifest(sourcePdf, (result.stderr || result.stdout || `PDFBox extractor exited with code ${result.code}`).trim());
    await jobStore.saveFontManifest(jobId, manifest);
    return manifest;
  }

  try {
    const manifest = normalizeManifest(await readManifest(manifestPath), sourcePdf);
    await jobStore.saveFontManifest(jobId, manifest);
    return manifest;
  } catch (error) {
    const manifest = buildFailedManifest(sourcePdf, error instanceof Error ? error.message : "Failed to read PDFBox font manifest");
    await jobStore.saveFontManifest(jobId, manifest);
    return manifest;
  }
}
