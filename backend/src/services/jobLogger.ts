import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { jobStore } from "./jobStore.js";

export interface JobLogger {
  info(action: string, details?: Record<string, unknown>): Promise<void>;
  warn(action: string, details?: Record<string, unknown>): Promise<void>;
  error(action: string, error: unknown, details?: Record<string, unknown>): Promise<void>;
}

function errorDetails(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack
    };
  }
  return { message: String(error) };
}

function formatLine(jobId: string, level: "info" | "warn" | "error", action: string, details?: Record<string, unknown>): string {
  return `${JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    jobId,
    action,
    ...details
  })}\n`;
}

export function createJobLogger(jobId: string): JobLogger {
  const logsDir = path.join(jobStore.getJobDir(jobId), "logs");
  const logPath = path.join(logsDir, "extraction.log");

  async function write(level: "info" | "warn" | "error", action: string, details?: Record<string, unknown>): Promise<void> {
    const line = formatLine(jobId, level, action, details);
    if (level === "error") console.error(`[job:${jobId}] ${action}`, details ?? "");
    else if (level === "warn") console.warn(`[job:${jobId}] ${action}`, details ?? "");
    else console.info(`[job:${jobId}] ${action}`, details ?? "");

    try {
      await mkdir(logsDir, { recursive: true });
      await appendFile(logPath, line, "utf8");
    } catch (error) {
      console.warn(`[job:${jobId}] unable to write extraction log`, error);
    }
  }

  return {
    info: (action, details) => write("info", action, details),
    warn: (action, details) => write("warn", action, details),
    error: (action, error, details) => write("error", action, { ...details, error: errorDetails(error) })
  };
}
