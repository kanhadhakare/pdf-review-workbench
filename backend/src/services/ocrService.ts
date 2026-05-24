import { spawn } from "node:child_process";
import path from "node:path";
import pLimit from "p-limit";
import { type OcrPageResult } from "../types.js";

const OCR_LIMIT = pLimit(1);
const OCR_SCRIPT = path.resolve("E:/pdf-review-workbench/backend/src/scripts/paddle_ocr_runner.py");

let pythonCommand: string | null = null;

function candidateCommands(): string[] {
  return process.platform === "win32" ? ["python", "py"] : ["python3", "python"];
}

async function runCommand(command: string, imagePath: string, pageIndex: number, pageWidth: number, pageHeight: number): Promise<OcrPageResult> {
  return new Promise((resolve) => {
    const child = spawn(command, [OCR_SCRIPT, imagePath, String(pageIndex), String(pageWidth), String(pageHeight)], {
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
        pageIndex,
        width: pageWidth,
        height: pageHeight,
        engine: "paddleocr",
        status: "unavailable",
        averageConfidence: 0,
        lines: [],
        message: `Unable to launch ${command}: ${error.message}`
      });
    });
    child.on("close", () => {
      try {
        const parsed = JSON.parse(stdout) as OcrPageResult;
        if (!parsed.message && stderr.trim()) {
          parsed.message = stderr.trim();
        }
        resolve(parsed);
      } catch {
        resolve({
          pageIndex,
          width: pageWidth,
          height: pageHeight,
          engine: "paddleocr",
          status: "failed",
          averageConfidence: 0,
          lines: [],
          message: stderr.trim() || "PaddleOCR returned invalid JSON"
        });
      }
    });
  });
}

async function resolvePythonCommand(imagePath: string, pageIndex: number, pageWidth: number, pageHeight: number): Promise<OcrPageResult> {
  if (pythonCommand) {
    return runCommand(pythonCommand, imagePath, pageIndex, pageWidth, pageHeight);
  }
  for (const candidate of candidateCommands()) {
    const result = await runCommand(candidate, imagePath, pageIndex, pageWidth, pageHeight);
    if (result.status === "ok" || result.status === "failed") {
      pythonCommand = candidate;
      return result;
    }
    if (result.status === "unavailable" && !result.message?.includes("Unable to launch")) {
      pythonCommand = candidate;
      return result;
    }
  }
  return {
    pageIndex,
    width: pageWidth,
    height: pageHeight,
    engine: "paddleocr",
    status: "unavailable",
    averageConfidence: 0,
    lines: [],
    message: "Python or PaddleOCR is not available on this machine"
  };
}

export async function runPaddleOcr(imagePath: string, pageIndex: number, pageWidth: number, pageHeight: number): Promise<OcrPageResult> {
  return OCR_LIMIT(() => resolvePythonCommand(imagePath, pageIndex, pageWidth, pageHeight));
}
