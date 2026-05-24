import { ExtractionStatus } from "../types.js";
import { Router } from "express";
import fs from "fs-extra";
import multer from "multer";
import path from "node:path";
import { v4 as uuid } from "uuid";
import { runExtraction } from "../services/extractor.js";
import { createJobRecord, type JobStore } from "../services/jobStore.js";

function normalizeDriveRoot(value: string): string {
  return path.resolve(value).toLowerCase();
}

function isMultipart(contentType?: string): boolean {
  return contentType?.toLowerCase().startsWith("multipart/form-data") ?? false;
}

function isAllowedPath(targetPath: string, allowedRoots: string[]): boolean {
  const normalizedTarget = normalizeDriveRoot(targetPath);
  return allowedRoots.some((root) => normalizedTarget.startsWith(normalizeDriveRoot(root)));
}

interface JobsRouterOptions {
  store: JobStore;
  uploadRoot: string;
  allowedRoots: string[];
}

export function createJobsRouter(options: JobsRouterOptions): Router {
  const router = Router();
  const upload = multer({ dest: options.uploadRoot });

  router.post("/", async (req, res, next) => {
    const handle = async () => {
      const localPath = typeof req.body.path === "string" ? req.body.path.trim() : "";
      const file = (req as typeof req & { file?: Express.Multer.File }).file;

      if (!file && !localPath) {
        res.status(400).json({ message: "Provide a PDF upload or a trusted local path." });
        return;
      }

      if (localPath) {
        const resolvedPath = path.resolve(localPath);
        if (!isAllowedPath(resolvedPath, options.allowedRoots)) {
          res.status(403).json({ message: "Path is outside the configured trusted roots." });
          return;
        }

        if (!(await fs.pathExists(resolvedPath))) {
          res.status(404).json({ message: "PDF path does not exist." });
          return;
        }
      }

      const id = uuid();
      const sourcePath = file?.path ?? path.resolve(localPath);
      const sourceFileName = file?.originalname ?? path.basename(sourcePath);
      const job = createJobRecord(id, sourcePath, sourceFileName);
      await options.store.create(job);
      await options.store.writeSourcePdf(id, sourcePath);

      res.status(202).json(job);

      void runExtraction({
        job,
        store: options.store,
        sourcePdfPath: options.store.getSourcePdfPath(id)
      }).catch(() => undefined);
    };

    if (isMultipart(req.headers["content-type"])) {
      upload.single("file")(req, res, (error) => {
        if (error) {
          next(error);
          return;
        }

        void handle().catch(next);
      });
      return;
    }

    void handle().catch(next);
  });

  router.get("/:id", async (req, res) => {
    const job = await options.store.get(req.params.id);
    if (!job) {
      res.status(404).json({ message: "Job not found." });
      return;
    }

    res.json(job);
  });

  router.get("/:id/pages/:pageIndex", async (req, res) => {
    const job = await options.store.get(req.params.id);
    if (!job) {
      res.status(404).json({ message: "Job not found." });
      return;
    }

    if (job.status !== ExtractionStatus.done && job.status !== ExtractionStatus.processing) {
      res.status(409).json({ message: "Pages are not available for this job yet." });
      return;
    }

    const pageIndex = Number(req.params.pageIndex);
    const page = await options.store.readPage(job.id, pageIndex);
    if (!page) {
      res.status(404).json({ message: "Page not found." });
      return;
    }

    res.json(page);
  });

  router.get("/:id/pages/:pageIndex/image", async (req, res) => {
    const imagePath = options.store.getPageImagePath(req.params.id, Number(req.params.pageIndex));
    if (!(await fs.pathExists(imagePath))) {
      res.status(404).json({ message: "Page image not found." });
      return;
    }

    res.type("png");
    res.sendFile(imagePath);
  });

  return router;
}


