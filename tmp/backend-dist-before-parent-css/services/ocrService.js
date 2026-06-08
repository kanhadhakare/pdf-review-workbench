import { spawn } from "node:child_process";
import pLimit from "p-limit";
import { tesseractCommandCandidates } from "../config/runtime.js";
const OCR_LIMIT = pLimit(1);
let tesseractCommand = null;
let cachedUnavailableMessage = null;
function buildResult(message, status, pageIndex, pageWidth, pageHeight) {
    return {
        pageIndex,
        width: pageWidth,
        height: pageHeight,
        engine: "tesseract",
        status,
        averageConfidence: 0,
        lines: [],
        message
    };
}
function parseInteger(value) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : 0;
}
function parseFloatValue(value) {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : 0;
}
function parseTsv(stdout) {
    const lines = stdout.split(/\r?\n/).filter(Boolean);
    if (lines.length <= 1) {
        return [];
    }
    const rows = [];
    for (const line of lines.slice(1)) {
        const parts = line.split("\t");
        if (parts.length < 12) {
            continue;
        }
        rows.push({
            level: parseInteger(parts[0]),
            pageNum: parseInteger(parts[1]),
            blockNum: parseInteger(parts[2]),
            parNum: parseInteger(parts[3]),
            lineNum: parseInteger(parts[4]),
            wordNum: parseInteger(parts[5]),
            left: parseInteger(parts[6]),
            top: parseInteger(parts[7]),
            width: parseInteger(parts[8]),
            height: parseInteger(parts[9]),
            conf: parseFloatValue(parts[10]),
            text: parts.slice(11).join("\t").trim()
        });
    }
    return rows.filter((row) => row.level === 5 && row.text);
}
function buildLines(rows) {
    const groups = new Map();
    for (const row of rows) {
        const word = {
            text: row.text,
            x: row.left,
            y: row.top,
            w: row.width,
            h: row.height,
            confidence: Math.max(0, Math.min(1, row.conf / 100))
        };
        const key = `${row.pageNum}:${row.blockNum}:${row.parNum}:${row.lineNum}`;
        const line = groups.get(key);
        if (line) {
            line.push(word);
        }
        else {
            groups.set(key, [word]);
        }
    }
    const ocrLines = [...groups.values()].map((words) => {
        const ordered = words.sort((a, b) => a.x - b.x);
        const x = Math.min(...ordered.map((word) => word.x));
        const y = Math.min(...ordered.map((word) => word.y));
        const right = Math.max(...ordered.map((word) => word.x + word.w));
        const bottom = Math.max(...ordered.map((word) => word.y + word.h));
        const confidence = ordered.reduce((sum, word) => sum + word.confidence, 0) / Math.max(ordered.length, 1);
        return {
            text: ordered.map((word) => word.text).join(" ").replace(/\s+/g, " ").trim(),
            x,
            y,
            w: right - x,
            h: bottom - y,
            confidence: Number(confidence.toFixed(4)),
            words: ordered
        };
    }).filter((line) => line.text);
    const averageConfidence = ocrLines.length
        ? Number((ocrLines.reduce((sum, line) => sum + line.confidence, 0) / ocrLines.length).toFixed(4))
        : 0;
    return {
        lines: ocrLines.sort((a, b) => (Math.abs(a.y - b.y) > 2 ? a.y - b.y : a.x - b.x)),
        averageConfidence
    };
}
async function runCommand(command, imagePath, pageIndex, pageWidth, pageHeight) {
    return new Promise((resolve) => {
        const child = spawn(command, [imagePath, "stdout", "-l", "eng", "--psm", "6", "tsv", "quiet"], {
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
            resolve(buildResult(`Unable to launch ${command}: ${error.message}`, "unavailable", pageIndex, pageWidth, pageHeight));
        });
        child.on("close", (code) => {
            if (code !== 0) {
                resolve(buildResult((stderr || stdout || `Tesseract exited with code ${code}`).trim(), "failed", pageIndex, pageWidth, pageHeight));
                return;
            }
            try {
                const parsedRows = parseTsv(stdout);
                const { lines, averageConfidence } = buildLines(parsedRows);
                resolve({
                    pageIndex,
                    width: pageWidth,
                    height: pageHeight,
                    engine: "tesseract",
                    status: "ok",
                    averageConfidence,
                    lines,
                    message: stderr.trim() || undefined
                });
            }
            catch (error) {
                resolve(buildResult(error instanceof Error ? error.message : "Tesseract returned invalid TSV", "failed", pageIndex, pageWidth, pageHeight));
            }
        });
    });
}
async function resolveTesseractCommand(imagePath, pageIndex, pageWidth, pageHeight) {
    if (tesseractCommand) {
        return runCommand(tesseractCommand, imagePath, pageIndex, pageWidth, pageHeight);
    }
    if (cachedUnavailableMessage) {
        return buildResult(cachedUnavailableMessage, "unavailable", pageIndex, pageWidth, pageHeight);
    }
    const candidates = tesseractCommandCandidates();
    const attemptMessages = [];
    for (const candidate of candidates) {
        console.info(`[ocr] probing tesseract candidate: ${candidate}`);
        const result = await runCommand(candidate, imagePath, pageIndex, pageWidth, pageHeight);
        console.info(`[ocr] candidate result: ${candidate} -> ${result.status}${result.message ? ` (${result.message})` : ""}`);
        if (result.status === "ok" || result.status === "failed") {
            tesseractCommand = candidate;
            return result;
        }
        attemptMessages.push(`${candidate}: ${result.message ?? result.status}`);
    }
    cachedUnavailableMessage = `Tesseract is not available. Checked: ${attemptMessages.join(" | ") || candidates.join(", ")}`;
    console.warn(`[ocr] ${cachedUnavailableMessage}`);
    return buildResult(cachedUnavailableMessage, "unavailable", pageIndex, pageWidth, pageHeight);
}
export async function runOcr(imagePath, pageIndex, pageWidth, pageHeight) {
    return OCR_LIMIT(() => resolveTesseractCommand(imagePath, pageIndex, pageWidth, pageHeight));
}
