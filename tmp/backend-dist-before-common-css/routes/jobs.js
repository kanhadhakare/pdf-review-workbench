import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Router } from "express";
import multer from "multer";
import { ExtractionStatus } from "../types.js";
import { getAllowedLocalPathRoots } from "../config/runtime.js";
import { getActiveEngine } from "../services/extractor.js";
import { spawnExtractionJob } from "../services/extractionRunner.js";
import { buildEditSummary, deleteFixesForJob, getVisitsByJob } from "../services/fixStore.js";
import { fingerprintPdf } from "../services/fingerprinter.js";
import { buildFinalArchive } from "../services/finalArchiveService.js";
import { jobStore } from "../services/jobStore.js";
const upload = multer({ storage: multer.memoryStorage() });
const allowedRoots = getAllowedLocalPathRoots();
async function validatePdfBytes(buffer) {
    if (buffer.length < 4 || String.fromCharCode(buffer[0], buffer[1], buffer[2], buffer[3]) !== "%PDF") {
        throw new Error("Input is not a valid PDF");
    }
}
function normalizeLocalPath(localPath) {
    const normalized = path.resolve(localPath);
    const allowed = allowedRoots.some((root) => normalized.toLowerCase().startsWith(path.resolve(root).toLowerCase()));
    if (!allowed) {
        throw new Error(`Local path is outside allowed roots. Allowed roots: ${allowedRoots.join(", ")}`);
    }
    return normalized;
}
function parseBooleanOption(value) {
    return value === true || value === "true" || value === "1" || value === 1;
}
async function createJobState(filePath, originalFileName, enableOcrValidation, warning) {
    const fingerprint = await fingerprintPdf(filePath);
    const now = new Date().toISOString();
    return {
        id: randomUUID(),
        status: ExtractionStatus.pending,
        pageCount: 0,
        pdfFingerprint: fingerprint,
        createdAt: now,
        updatedAt: now,
        dpi: 150,
        filePath,
        originalFileName,
        enableOcrValidation,
        processedPages: 0,
        warning
    };
}
export const jobsRouter = Router();
jobsRouter.get("/", async (_req, res) => {
    try {
        const jobs = await jobStore.listJobs();
        const items = await Promise.all(jobs.map(async (job) => {
            const editSummary = await buildEditSummary(job.id);
            const visits = await getVisitsByJob(job.id);
            const lastVisitedPageIndex = visits.length ? visits[visits.length - 1].pageIndex : null;
            const draftPageIndices = await jobStore.listDraftPages(job.id);
            return { job, editSummary, lastVisitedPageIndex, draftPageIndices };
        }));
        res.json(items);
    }
    catch (error) {
        res.status(500).json({ message: error instanceof Error ? error.message : "Unable to list jobs" });
    }
});
jobsRouter.get("/:id/resume", async (req, res) => {
    try {
        const job = await jobStore.getJob(req.params.id);
        if (!job) {
            res.status(404).json({ message: "Job not found" });
            return;
        }
        const visits = await getVisitsByJob(job.id);
        const lastVisitedPageIndex = visits.length ? visits[visits.length - 1].pageIndex : null;
        const draftPageIndices = await jobStore.listDraftPages(job.id);
        res.json({ jobId: job.id, lastVisitedPageIndex, draftPageIndices });
    }
    catch (error) {
        res.status(500).json({ message: error instanceof Error ? error.message : "Unable to load resume info" });
    }
});
jobsRouter.post("/", upload.single("file"), async (req, res) => {
    try {
        let bytes;
        let originalFileName;
        let warning;
        const enableOcrValidation = parseBooleanOption(req.body?.enableOcrValidation);
        if (req.file) {
            bytes = new Uint8Array(req.file.buffer);
            originalFileName = req.file.originalname;
            warning = req.file.size > 50 * 1024 * 1024 ? "large_file" : undefined;
        }
        else if (typeof req.body?.localPath === "string") {
            const normalizedPath = normalizeLocalPath(req.body.localPath);
            bytes = new Uint8Array(await readFile(normalizedPath));
            originalFileName = path.basename(normalizedPath);
            warning = bytes.byteLength > 50 * 1024 * 1024 ? "large_file" : undefined;
        }
        else {
            res.status(400).json({ message: "Provide a PDF upload or localPath" });
            return;
        }
        await validatePdfBytes(bytes);
        const tempPath = path.join(jobStore.storageRoot, "uploads", `${Date.now()}-${originalFileName}`);
        await mkdir(path.dirname(tempPath), { recursive: true });
        await writeFile(tempPath, bytes);
        const job = await createJobState(tempPath, originalFileName, enableOcrValidation, warning);
        await jobStore.create(job);
        const sourcePdfPath = await jobStore.saveSourcePdf(job.id, bytes);
        await jobStore.updateJob(job.id, { filePath: sourcePdfPath });
        void spawnExtractionJob(job.id, 150);
        const response = {
            job: { ...job, filePath: sourcePdfPath },
            editSummary: jobStore.emptySummary(job.id),
            warning
        };
        res.status(202).json({ ...response, engine: getActiveEngine() });
    }
    catch (error) {
        res.status(400).json({ message: error instanceof Error ? error.message : "Unable to create job" });
    }
});
jobsRouter.get("/:id", async (req, res) => {
    try {
        const job = await jobStore.getJob(req.params.id);
        if (!job) {
            res.status(404).json({ message: "Job not found" });
            return;
        }
        const editSummary = await buildEditSummary(job.id);
        const hasPdf2HtmlEx = Boolean(job.hasPdf2HtmlEx);
        res.json({ job, editSummary, hasPdf2HtmlEx, pdf2htmlExWarnings: job.pdf2htmlExWarnings ?? [] });
    }
    catch (error) {
        res.status(500).json({ message: error instanceof Error ? error.message : "Unable to load job" });
    }
});
jobsRouter.get("/:id/final.zip", async (req, res) => {
    try {
        const archive = await buildFinalArchive(req.params.id);
        res.setHeader("Content-Type", "application/zip");
        res.setHeader("Content-Disposition", `attachment; filename="${archive.fileName}"`);
        res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
        res.setHeader("Pragma", "no-cache");
        res.setHeader("Expires", "0");
        res.setHeader("X-Final-Archive-Generated-At", new Date().toISOString());
        res.send(archive.buffer);
    }
    catch (error) {
        res.status(error instanceof Error && error.message === "Job not found" ? 404 : 500).json({
            message: error instanceof Error ? error.message : "Unable to build final archive"
        });
    }
});
jobsRouter.delete("/:id", async (req, res) => {
    try {
        const job = await jobStore.getJob(req.params.id);
        if (!job) {
            res.status(404).json({ message: "Job not found" });
            return;
        }
        await Promise.all([
            jobStore.deleteJob(req.params.id),
            deleteFixesForJob(req.params.id)
        ]);
        res.json({ ok: true });
    }
    catch (error) {
        res.status(500).json({ message: error instanceof Error ? error.message : "Unable to delete job" });
    }
});
jobsRouter.get("/:id/pages/:pageIndex", async (req, res) => {
    try {
        const pageIndex = Number(req.params.pageIndex);
        const page = await jobStore.getPage(req.params.id, pageIndex);
        if (!page) {
            res.status(404).json({ ready: false });
            return;
        }
        res.json(page);
    }
    catch (error) {
        res.status(500).json({ message: error instanceof Error ? error.message : "Unable to load page" });
    }
});
jobsRouter.get("/:id/pages/:pageIndex/image", async (req, res) => {
    try {
        const pageIndex = Number(req.params.pageIndex);
        const imagePath = jobStore.getImagePath(req.params.id, pageIndex);
        res.sendFile(imagePath);
    }
    catch (error) {
        res.status(404).json({ message: error instanceof Error ? error.message : "Image not found" });
    }
});
jobsRouter.get("/:id/pages/:pageIndex/ocr", async (req, res) => {
    void req;
    res.status(404).json({ ready: false, message: "OCR disabled" });
});
jobsRouter.get("/:id/pages/:pageIndex/ocr-compare", async (req, res) => {
    void req;
    res.status(404).json({ ready: false, message: "OCR disabled" });
});
