import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { stat } from "node:fs/promises";
import path from "node:path";
import { Router } from "express";
import multer from "multer";
import { ExtractionStatus, type ArchiveImportOptions, type JobWorkflow, type JobsResponse, type SourceType } from "../types.js";
import { getAllowedLocalPathRoots } from "../config/runtime.js";
import { getActiveEngine } from "../services/extractor.js";
import { spawnExtractionJob } from "../services/extractionRunner.js";
import { buildEditSummary, deleteFixesForJob, getVisitsByJob } from "../services/fixStore.js";
import { fingerprintPdf } from "../services/fingerprinter.js";
import { buildFinalArchive, buildReviewArchive } from "../services/finalArchiveService.js";
import { jobStore, type StoredJobState } from "../services/jobStore.js";
import { createPendingSourceManifest, detectSourceType } from "../services/sourceFormatService.js";
import { importArchiveBook } from "../services/archiveBookService.js";
import { getAccessibilityMap, getAccessibilityPage, saveAccessibilityPage } from "../services/accessibilityStore.js";
import { detectAccessibilityTagsForJob, detectAccessibilityTagsForPage } from "../services/accessibilityDetectionService.js";
import { validateAccessibilityMap } from "../services/accessibilityValidationService.js";

const upload = multer({ storage: multer.memoryStorage() });
const archiveUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 250 * 1024 * 1024 } });
const allowedRoots = getAllowedLocalPathRoots();

function normalizeLocalPath(localPath: string): string {
  const normalized = path.resolve(localPath);
  const allowed = allowedRoots.some((root) => normalized.toLowerCase().startsWith(path.resolve(root).toLowerCase()));
  if (!allowed) {
    throw new Error(`Local path is outside allowed roots. Allowed roots: ${allowedRoots.join(", ")}`);
  }
  return normalized;
}

function parseBooleanOption(value: unknown): boolean {
  return value === true || value === "true" || value === "1" || value === 1;
}

function parseJobWorkflow(value: unknown): JobWorkflow {
  return value === "accessibility-tagging" ? "accessibility-tagging" : "zoning";
}

function parseOptionalTargetWidth(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error("Target width must be a positive number");
  if (parsed < 200 || parsed > 5000) throw new Error("Target width must be between 200 and 5000 pixels");
  return Math.round(parsed);
}

function parseArchiveOptions(value: unknown): ArchiveImportOptions {
  let input: Record<string, unknown> = {};
  if (typeof value === "string" && value.trim()) {
    try { input = JSON.parse(value) as Record<string, unknown>; } catch { throw new Error("Archive import options are invalid JSON"); }
  }
  const allowed = <T extends string>(candidate: unknown, values: readonly T[], fallback: T): T =>
    typeof candidate === "string" && values.includes(candidate as T) ? candidate as T : fallback;
  const requestedLanguage = typeof input.language === "string" ? input.language.trim() : "auto";
  if (requestedLanguage !== "auto" && !/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/.test(requestedLanguage)) {
    throw new Error("Language must be 'auto' or a valid BCP-47 language tag such as hi, en or ar-SA");
  }
  return {
    purpose: allowed(input.purpose, ["zoning", "inspection"] as const, "zoning"),
    pageDiscovery: allowed(input.pageDiscovery, ["auto", "spine", "all-xhtml"] as const, "auto"),
    layoutMode: allowed(input.layoutMode, ["auto", "fixed", "reflowable"] as const, "auto"),
    language: requestedLanguage || "auto",
    readingDirection: allowed(input.readingDirection, ["auto", "ltr", "rtl"] as const, "auto"),
    textHandling: allowed(input.textHandling, ["preserve", "audit", "safe-cleanup", "advanced-repair"] as const, "preserve"),
    unicode: {
      normalization: allowed((input.unicode as Record<string, unknown> | undefined)?.normalization, ["none", "nfc", "nfkc"] as const, "nfc"),
      applyLanguageMetadata: parseBooleanOption((input.unicode as Record<string, unknown> | undefined)?.applyLanguageMetadata),
      mojibakeRepair: allowed((input.unicode as Record<string, unknown> | undefined)?.mojibakeRepair, ["off", "high-confidence"] as const, "off"),
      joinerPolicy: allowed((input.unicode as Record<string, unknown> | undefined)?.joinerPolicy, ["preserve", "remove-redundant-indic"] as const, "preserve"),
      legacyFontProfile: "off"
    }
  };
}

async function createJobState(filePath: string, originalFileName: string, sourceType: SourceType, enableOcrValidation: boolean, workflow: JobWorkflow, warning?: "large_file", targetWidthPx?: number): Promise<StoredJobState> {
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
    sourceType,
    workflow,
    enableOcrValidation,
    targetWidthPx,
    processedPages: 0,
    warning
  };
}

export const jobsRouter = Router();

jobsRouter.post("/archive", archiveUpload.single("file"), async (req, res) => {
  let job: StoredJobState | null = null;
  try {
    if (!req.file) {
      res.status(400).json({ message: "Provide an EPUB or XHTML/HTML ZIP file" });
      return;
    }
    const bytes = new Uint8Array(req.file.buffer);
    const sourceType = detectSourceType(bytes);
    if (sourceType === "pdf") {
      res.status(415).json({ message: "Use the PDF uploader for PDF files" });
      return;
    }
    const warning = req.file.size > 50 * 1024 * 1024 ? "large_file" as const : undefined;
    const importOptions = parseArchiveOptions(req.body?.options);
    const now = new Date().toISOString();
    job = {
      id: randomUUID(),
      status: ExtractionStatus.processing,
      pageCount: 0,
      pdfFingerprint: createHash("sha256").update(bytes).digest("hex").slice(0, 16),
      createdAt: now,
      updatedAt: now,
      dpi: 0,
      filePath: "",
      originalFileName: req.file.originalname,
      sourceType,
      enableOcrValidation: false,
      processedPages: 0,
      warning
    };
    await jobStore.create(job);
    const archivePath = path.join(jobStore.getJobDir(job.id), sourceType === "epub" ? "source.epub" : "source.zip");
    await writeFile(archivePath, bytes);
    await jobStore.updateJob(job.id, { filePath: archivePath });
    const manifest = await importArchiveBook(job.id, archivePath, sourceType, req.file.originalname, now, importOptions);
    const completedJob = await jobStore.updateJob(job.id, {
      status: ExtractionStatus.done,
      pageCount: manifest.pages.length,
      processedPages: manifest.pages.length
    });
    await jobStore.saveSourceManifest(job.id, manifest);
    res.status(201).json({ job: completedJob, manifest, editSummary: jobStore.emptySummary(job.id), warning });
  } catch (error) {
    if (job) {
      await jobStore.updateJob(job.id, {
        status: ExtractionStatus.failed,
        errorMessage: error instanceof Error ? error.message : "Archive import failed"
      }).catch(() => void 0);
    }
    res.status(error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE" ? 413 : 400).json({
      message: error instanceof Error ? error.message : "Unable to import archive",
      jobId: job?.id
    });
  }
});

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
  } catch (error) {
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
  } catch (error) {
    res.status(500).json({ message: error instanceof Error ? error.message : "Unable to load resume info" });
  }
});

jobsRouter.get("/:id/source-manifest", async (req, res) => {
  const manifest = await jobStore.getSourceManifest(req.params.id);
  if (!manifest) {
    res.status(404).json({ message: "Source manifest not found" });
    return;
  }
  res.json(manifest);
});

jobsRouter.get("/:id/accessibility", async (req, res) => {
  const job = await jobStore.getJob(req.params.id);
  if (!job) {
    res.status(404).json({ message: "Job not found" });
    return;
  }
  res.json(await getAccessibilityMap(job.id));
});

jobsRouter.get("/:id/accessibility/pages/:pageIndex", async (req, res) => {
  const job = await jobStore.getJob(req.params.id);
  if (!job) {
    res.status(404).json({ message: "Job not found" });
    return;
  }
  const pageIndex = Number(req.params.pageIndex);
  if (!Number.isInteger(pageIndex) || pageIndex < 0) {
    res.status(400).json({ message: "Invalid page index" });
    return;
  }
  res.json(await getAccessibilityPage(job.id, pageIndex));
});

jobsRouter.put("/:id/accessibility/pages/:pageIndex", async (req, res) => {
  const job = await jobStore.getJob(req.params.id);
  if (!job) {
    res.status(404).json({ message: "Job not found" });
    return;
  }
  const pageIndex = Number(req.params.pageIndex);
  if (!Number.isInteger(pageIndex) || pageIndex < 0) {
    res.status(400).json({ message: "Invalid page index" });
    return;
  }
  const page = await saveAccessibilityPage(job.id, pageIndex, {
    tags: Array.isArray(req.body?.tags) ? req.body.tags : [],
    reviewStatus: req.body?.reviewStatus
  });
  res.json(page);
});

jobsRouter.post("/:id/accessibility/pages/:pageIndex/detect", async (req, res) => {
  const job = await jobStore.getJob(req.params.id);
  if (!job) {
    res.status(404).json({ message: "Job not found" });
    return;
  }
  const pageIndex = Number(req.params.pageIndex);
  if (!Number.isInteger(pageIndex) || pageIndex < 0) {
    res.status(400).json({ message: "Invalid page index" });
    return;
  }
  try {
    res.json(await detectAccessibilityTagsForPage(job.id, pageIndex, parseBooleanOption(req.body?.replace)));
  } catch (error) {
    res.status(500).json({ message: error instanceof Error ? error.message : "Unable to detect accessibility tags" });
  }
});

jobsRouter.post("/:id/accessibility/detect", async (req, res) => {
  const job = await jobStore.getJob(req.params.id);
  if (!job) {
    res.status(404).json({ message: "Job not found" });
    return;
  }
  try {
    res.json(await detectAccessibilityTagsForJob(job.id, parseBooleanOption(req.body?.replace)));
  } catch (error) {
    res.status(500).json({ message: error instanceof Error ? error.message : "Unable to detect accessibility tags" });
  }
});

jobsRouter.post("/:id/accessibility/validate", async (req, res) => {
  const job = await jobStore.getJob(req.params.id);
  if (!job) {
    res.status(404).json({ message: "Job not found" });
    return;
  }
  try {
    res.json(await validateAccessibilityMap(job.id));
  } catch (error) {
    res.status(500).json({ message: error instanceof Error ? error.message : "Unable to validate accessibility map" });
  }
});

jobsRouter.post("/:id/accessibility/export-pdf", async (_req, res) => {
  res.status(501).json({
    message: "Tagged PDF export is intentionally not implemented yet. Choose a PDF tag-writing engine first: PDFix/Apryse for production speed, or a custom pikepdf/qpdf writer as a separate R&D phase."
  });
});

jobsRouter.post("/", upload.single("file"), async (req, res) => {
  try {
    let bytes: Uint8Array;
    let originalFileName: string;
    let warning: "large_file" | undefined;
    const enableOcrValidation = parseBooleanOption(req.body?.enableOcrValidation);
    const workflow = parseJobWorkflow(req.body?.workflow);
    const targetWidthPx = parseOptionalTargetWidth(req.body?.targetWidthPx);

    if (req.file) {
      bytes = new Uint8Array(req.file.buffer);
      originalFileName = req.file.originalname;
      warning = req.file.size > 50 * 1024 * 1024 ? "large_file" : undefined;
    } else if (typeof req.body?.localPath === "string") {
      const normalizedPath = normalizeLocalPath(req.body.localPath);
      bytes = new Uint8Array(await readFile(normalizedPath));
      originalFileName = path.basename(normalizedPath);
      warning = bytes.byteLength > 50 * 1024 * 1024 ? "large_file" : undefined;
    } else {
      res.status(400).json({ message: "Provide a PDF upload or localPath" });
      return;
    }

    const sourceType = detectSourceType(bytes);
    if (sourceType !== "pdf") {
      res.status(415).json({
        message: `${sourceType === "epub" ? "EPUB" : "HTML ZIP"} detected. Archive importing is not enabled until the secure importer is installed.`
      });
      return;
    }
    const tempPath = path.join(jobStore.storageRoot, "uploads", `${Date.now()}-${originalFileName}`);
    await mkdir(path.dirname(tempPath), { recursive: true });
    await writeFile(tempPath, bytes);
    const job = await createJobState(tempPath, originalFileName, sourceType, enableOcrValidation, workflow, warning, targetWidthPx);
    await jobStore.create(job);
    await jobStore.saveSourceManifest(job.id, createPendingSourceManifest(job.id, sourceType, originalFileName, job.createdAt));
    const sourcePdfPath = await jobStore.saveSourcePdf(job.id, bytes);
    await jobStore.updateJob(job.id, { filePath: sourcePdfPath });

    void spawnExtractionJob(job.id, 150);

    const response: JobsResponse = {
      job: { ...job, filePath: sourcePdfPath },
      editSummary: jobStore.emptySummary(job.id),
      warning
    };
    res.status(202).json({ ...response, engine: getActiveEngine() });
  } catch (error) {
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
  } catch (error) {
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
  } catch (error) {
    res.status(error instanceof Error && error.message === "Job not found" ? 404 : 500).json({
      message: error instanceof Error ? error.message : "Unable to build final archive"
    });
  }
});

jobsRouter.get("/:id/review.zip", async (req, res) => {
  try {
    const archive = await buildReviewArchive(req.params.id);
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="${archive.fileName}"`);
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
    res.send(archive.buffer);
  } catch (error) {
    res.status(error instanceof Error && error.message === "Job not found" ? 404 : 500).json({
      message: error instanceof Error ? error.message : "Unable to build review archive"
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
  } catch (error) {
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
  } catch (error) {
    res.status(500).json({ message: error instanceof Error ? error.message : "Unable to load page" });
  }
});

jobsRouter.get("/:id/pages/:pageIndex/image", async (req, res) => {
  try {
    const pageIndex = Number(req.params.pageIndex);
    const imagePath = jobStore.getImagePath(req.params.id, pageIndex);
    res.sendFile(imagePath);
  } catch (error) {
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
