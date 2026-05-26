import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { backendRoot } from "../config/runtime.js";
import { ExtractionStatus } from "../types.js";
import { jobStore } from "./jobStore.js";

const __filename = fileURLToPath(import.meta.url);
const isSourceRuntime = __filename.includes(`${path.sep}src${path.sep}`);
const TSX_CLI = path.join(backendRoot, "node_modules", "tsx", "dist", "cli.mjs");
const SOURCE_WORKER = path.join(backendRoot, "src", "workers", "extract-job.ts");
const DIST_WORKER = path.join(backendRoot, "dist", "workers", "extract-job.js");

function resolveWorkerArgs(jobId: string, dpi: number): string[] {
  if (isSourceRuntime && existsSync(TSX_CLI) && existsSync(SOURCE_WORKER)) {
    return [TSX_CLI, SOURCE_WORKER, jobId, String(dpi)];
  }
  return [DIST_WORKER, jobId, String(dpi)];
}

export async function spawnExtractionJob(jobId: string, dpi: number): Promise<void> {
  const args = resolveWorkerArgs(jobId, dpi);
  const child = spawn(process.execPath, args, {
    cwd: backendRoot,
    env: process.env,
    stdio: ["ignore", "inherit", "inherit"],
    windowsHide: true
  });

  child.on("error", async (error) => {
    console.error(`[extract-runner] failed to start worker for ${jobId}: ${error.message}`);
    try {
      await jobStore.updateJob(jobId, {
        status: ExtractionStatus.failed,
        errorMessage: `Unable to start extraction worker: ${error.message}`
      });
    } catch {
      // Ignore secondary failure while reporting process startup issues.
    }
  });

  child.on("exit", async (code, signal) => {
    if (code === 0) {
      return;
    }
    console.error(`[extract-runner] worker exited for ${jobId} with code ${code ?? "null"} signal ${signal ?? "none"}`);
    try {
      const job = await jobStore.getJob(jobId);
      if (job && job.status !== "done" && job.status !== "failed") {
        await jobStore.updateJob(jobId, {
          status: ExtractionStatus.failed,
          errorMessage: `Extraction worker exited unexpectedly (${signal ?? code ?? "unknown"})`
        });
      }
    } catch {
      // Ignore secondary failure while reporting process exit issues.
    }
  });
}
