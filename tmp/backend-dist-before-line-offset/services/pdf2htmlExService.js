import { mkdir, rm, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
function getCmd() {
    const value = (process.env.PDF2HTMLEX_CMD ?? "").trim();
    return value || "pdf2htmlEX";
}
function getMode() {
    const mode = (process.env.PDF2HTMLEX_MODE ?? "").trim().toLowerCase();
    if (mode === "docker")
        return "docker";
    if (mode === "remote")
        return "remote";
    return "native";
}
function getRemoteUrl() {
    const value = (process.env.PDF2HTMLEX_REMOTE_URL ?? "").trim();
    return value || null;
}
function getDockerImage() {
    return (process.env.PDF2HTMLEX_DOCKER_IMAGE ?? "").trim() ||
        "pdf2htmlex/pdf2htmlex:0.18.8.rc2-master-20200820-alpine-3.12.0-x86_64";
}
export function isPdf2HtmlExEnabled() {
    // Disabled: pdf2htmlEX output is not reliable for our current review workflow.
    return false;
}
export async function runPdf2HtmlEx(inputPdfPath, destDir) {
    await rm(destDir, { recursive: true, force: true });
    await mkdir(destDir, { recursive: true });
    const mode = getMode();
    if (mode === "remote") {
        const remoteUrl = getRemoteUrl();
        if (!remoteUrl)
            throw new Error("PDF2HTMLEX_REMOTE_URL not set");
        const jobDir = path.dirname(destDir);
        const jobId = path.basename(jobDir);
        const pdfRelPath = path.relative(jobDir, inputPdfPath);
        const destRelDir = path.relative(jobDir, destDir);
        if (pdfRelPath.includes("..") || path.isAbsolute(pdfRelPath) || destRelDir.includes("..") || path.isAbsolute(destRelDir)) {
            throw new Error("pdf2htmlEX remote mode requires paths inside the job directory");
        }
        const response = await fetch(remoteUrl, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ jobId, pdfRelPath, destRelDir })
        });
        if (!response.ok) {
            const text = await response.text().catch(() => "");
            throw new Error(`pdf2htmlEX(remote) failed: ${response.status} ${text.slice(0, 2000)}`);
        }
        const payload = await response.json().catch(() => ({}));
        if (!payload?.ok) {
            throw new Error(`pdf2htmlEX(remote) failed: ${payload?.message ?? "unknown error"}`);
        }
        return;
    }
    if (mode === "docker") {
        const jobDir = path.dirname(destDir);
        const relativeInput = path.relative(jobDir, inputPdfPath);
        if (relativeInput.includes("..") || path.isAbsolute(relativeInput)) {
            throw new Error("pdf2htmlEX docker mode requires input PDF to be inside the job directory");
        }
        const containerPdf = path.posix.join("/work", relativeInput.replace(/\\/g, "/"));
        const containerDest = "/work/pdf2htmlex";
        const image = getDockerImage();
        const dockerArgs = [
            "run",
            "--rm",
            "-v",
            `${jobDir}:/work`,
            "-w",
            "/work",
            image,
            "pdf2htmlEX",
            "--dest-dir",
            containerDest,
            "--embed-css",
            "0",
            "--embed-font",
            "0",
            "--embed-image",
            "0",
            "--split-pages",
            "1",
            "--page-filename",
            "page-%d.html",
            "--css-filename",
            "style.css",
            "--font-format",
            "woff",
            containerPdf
        ];
        await new Promise((resolve, reject) => {
            const child = spawn("docker", dockerArgs, { windowsHide: true });
            let stderr = "";
            child.stderr.on("data", (chunk) => { stderr += String(chunk); });
            child.on("error", reject);
            child.on("close", (code) => {
                if (code === 0)
                    resolve();
                else
                    reject(new Error(`pdf2htmlEX(docker) failed (code ${code}): ${stderr.slice(0, 2000)}`));
            });
        });
        return;
    }
    const cmd = getCmd();
    if (!cmd)
        throw new Error("pdf2htmlEX command not configured");
    const args = [
        "--dest-dir", destDir,
        "--embed-css", "0",
        "--embed-font", "0",
        "--embed-image", "0",
        "--split-pages", "1",
        "--page-filename", "page-%d.html",
        "--css-filename", "style.css",
        "--font-format", "woff",
        inputPdfPath
    ];
    await new Promise((resolve, reject) => {
        const child = spawn(cmd, args, { windowsHide: true });
        let stderr = "";
        child.stderr.on("data", (chunk) => { stderr += String(chunk); });
        child.on("error", reject);
        child.on("close", (code) => {
            if (code === 0)
                resolve();
            else
                reject(new Error(`pdf2htmlEX failed (code ${code}): ${stderr.slice(0, 2000)}`));
        });
    });
}
export async function validatePdf2HtmlExOutput(destDir) {
    const warnings = [];
    const cssPath = path.join(destDir, "style.css");
    const sourceHtmlPath = path.join(destDir, "source.html");
    const fontsDir = path.join(destDir, "fonts");
    let cssText = "";
    let cssSource = "";
    try {
        cssText = await readFile(cssPath, "utf8");
        cssSource = "style.css";
    }
    catch {
        // Some pdf2htmlEX outputs embed CSS in source.html instead of emitting style.css.
        try {
            const html = await readFile(sourceHtmlPath, "utf8");
            const styleBlocks = Array.from(html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)).map((m) => String(m[1] ?? ""));
            cssText = styleBlocks.join("\n");
            cssSource = "source.html";
        }
        catch {
            cssText = "";
            cssSource = "";
        }
    }
    if (!cssText) {
        warnings.push("pdf2htmlEX output missing CSS (style.css or embedded <style> in source.html). HTML may not render correctly.");
        return warnings;
    }
    if (!/@font-face\s*\{/i.test(cssText))
        warnings.push(`pdf2htmlEX output missing @font-face rules in ${cssSource} (fonts may not be extracted).`);
    if (!/\bcolor\s*:/i.test(cssText))
        warnings.push(`pdf2htmlEX output missing color rules in ${cssSource} (text color may be incorrect).`);
    try {
        const dir = await stat(fontsDir);
        if (!dir.isDirectory())
            warnings.push("pdf2htmlEX output fonts path exists but is not a directory (fonts may not load).");
    }
    catch (error) {
        if (error?.code === "ENOENT")
            warnings.push("pdf2htmlEX output missing fonts directory (fonts may not load).");
        else
            warnings.push("pdf2htmlEX output fonts directory could not be checked (fonts may not load).");
    }
    return warnings;
}
export function pdf2HtmlExPagePath(jobId, pageIndex) {
    // This is a URL path under /storage/jobs (served by express.static)
    return `/storage/jobs/${encodeURIComponent(jobId)}/pdf2htmlex/page-${pageIndex + 1}.html`;
}
