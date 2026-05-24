import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { Router } from "express";
import multer from "multer";
import { ExtractionStatus, type JobsResponse } from "@pdf-review-workbench/shared";
import { extractPDF, getActiveEngine } from "../services/extractor.js";
import { buildEditSummary } from "../services/fixStore.js";
import { fingerprintPdf } from "../services/fingerprinter.js";
import { jobStore, type StoredJobState } from "../services/jobStore.js";
import { loadProfile } from "../services/profileStore.js";

const upload = multer({ storage: multer.memoryStorage() });
const allowedRoots = ["E:/pdf-review-workbench", "E:/pdf-inputs", "E:/"];

async function validatePdfBytes(buffer: Uint8Array): Promise<void> {
  if (buffer.length < 4 || String.fromCharCode(buffer[0], buffer[1], buffer[2], buffer[3]) !== "%PDF") {
    throw new Error("Input is not a valid PDF");
  }
}

function normalizeLocalPath(localPath: string): string {
  const normalized = path.resolve(localPath);
  const allowed = allowedRoots.some((root) => normalized.toLowerCase().startsWith(path.resolve(root).toLowerCase()));
  if (!allowed) {
    throw new Error("Local path is outside allowed roots");
  }
  return normalized;
}

async function createJobState(filePath: string, originalFileName: string, warning?: "large_file"): Promise<StoredJobState> {
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
    processedPages: 0,
    warning
  };
}

export const jobsRouter = Router();

jobsRouter.post("/", upload.single("file"), async (req, res) => {
  try {
    let bytes: Uint8Array;
    let originalFileName: string;
    let warning: "large_file" | undefined;

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

    await validatePdfBytes(bytes);
    const tempPath = path.join(jobStore.storageRoot, 'uploads', `${Date.now()}-${originalFileName}`);
    await import('node:fs/promises').then((fs) => fs.writeFile(tempPath, bytes));
    const job = await createJobState(tempPath, originalFileName, warning);
    await jobStore.create(job);
    const sourcePdfPath = await jobStore.saveSourcePdf(job.id, bytes);
    await jobStore.updateJob(job.id, { filePath: sourcePdfPath });
    const profile = await loadProfile(job.pdfFingerprint);

    void extractPDF({ ...job, filePath: sourcePdfPath }, profile, 150).catch((error) => {
      console.error(`[jobs] extraction failed for ${job.id}:`, error);
    });

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
    res.json({ job, editSummary });
  } catch (error) {
    res.status(500).json({ message: error instanceof Error ? error.message : "Unable to load job" });
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
