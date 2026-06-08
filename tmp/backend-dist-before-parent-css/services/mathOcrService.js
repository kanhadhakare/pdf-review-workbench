import { spawn } from "node:child_process";
import pLimit from "p-limit";
import { pix2TextScriptPath, pythonCommandCandidates } from "../config/runtime.js";
const MATH_OCR_LIMIT = pLimit(1);
const MATH_OCR_TIMEOUT_MS = 120_000;
let pythonCommand = null;
function normalizeResult(payload, fallbackError) {
    if (!payload || typeof payload !== "object") {
        return {
            ok: false,
            status: "failed",
            engine: "pix2text",
            error: fallbackError ?? "Pix2Text returned invalid output."
        };
    }
    const record = payload;
    const status = record.status === "ok" || record.status === "unavailable" || record.status === "failed"
        ? record.status
        : "failed";
    const latex = typeof record.latex === "string" ? record.latex : undefined;
    const error = status === "ok"
        ? undefined
        : typeof record.error === "string"
            ? record.error
            : fallbackError;
    return {
        ok: Boolean(record.ok && status === "ok" && latex),
        status,
        engine: "pix2text",
        latex,
        error,
        raw: record.raw
    };
}
function parseRunnerJson(stdout) {
    const trimmed = stdout.trim();
    if (!trimmed) {
        throw new Error("Pix2Text runner returned empty output.");
    }
    try {
        return JSON.parse(trimmed);
    }
    catch {
        const lines = trimmed.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).reverse();
        for (const line of lines) {
            if (!line.startsWith("{"))
                continue;
            try {
                return JSON.parse(line);
            }
            catch {
                continue;
            }
        }
        throw new Error("Pix2Text runner did not return JSON.");
    }
}
async function runPix2Text(command, imagePath) {
    return new Promise((resolve) => {
        const child = spawn(command, [pix2TextScriptPath, imagePath], {
            stdio: ["ignore", "pipe", "pipe"],
            windowsHide: true
        });
        let stdout = "";
        let stderr = "";
        const timer = setTimeout(() => {
            child.kill();
            resolve({
                ok: false,
                status: "failed",
                engine: "pix2text",
                error: `Pix2Text timed out after ${Math.round(MATH_OCR_TIMEOUT_MS / 1000)} seconds.`
            });
        }, MATH_OCR_TIMEOUT_MS);
        child.stdout.on("data", (chunk) => {
            stdout += chunk.toString();
        });
        child.stderr.on("data", (chunk) => {
            stderr += chunk.toString();
        });
        child.on("error", (error) => {
            clearTimeout(timer);
            resolve({
                ok: false,
                status: "unavailable",
                engine: "pix2text",
                error: `Unable to launch ${command}: ${error.message}`,
                launchFailed: true
            });
        });
        child.on("close", (code) => {
            clearTimeout(timer);
            if (code !== 0 && !stdout.trim()) {
                resolve({
                    ok: false,
                    status: "failed",
                    engine: "pix2text",
                    error: (stderr || `Pix2Text runner exited with code ${code}`).trim()
                });
                return;
            }
            try {
                resolve(normalizeResult(parseRunnerJson(stdout), stderr.trim() || undefined));
            }
            catch (error) {
                resolve({
                    ok: false,
                    status: "failed",
                    engine: "pix2text",
                    error: error instanceof Error ? `${error.message}${stderr ? `: ${stderr.trim()}` : ""}` : "Pix2Text runner failed."
                });
            }
        });
    });
}
async function recognizeEquationCropInternal(imagePath) {
    if (pythonCommand) {
        return runPix2Text(pythonCommand, imagePath);
    }
    const messages = [];
    for (const candidate of pythonCommandCandidates()) {
        const result = await runPix2Text(candidate, imagePath);
        if (!result.launchFailed) {
            pythonCommand = candidate;
            return result;
        }
        messages.push(result.error ?? `${candidate}: unavailable`);
    }
    return {
        ok: false,
        status: "unavailable",
        engine: "pix2text",
        error: `No usable Python runtime found for Pix2Text. Checked: ${messages.join(" | ")}`
    };
}
export async function recognizeEquationCrop(imagePath) {
    return MATH_OCR_LIMIT(() => recognizeEquationCropInternal(imagePath));
}
