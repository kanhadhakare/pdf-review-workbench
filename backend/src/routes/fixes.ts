import { Router } from "express";
import { type ArchiveZoningCssStrategy, type DraftPageState, type FixDelta, type PageVisit, type SpanCorrection } from "../types.js";
import { buildEditSummary, saveFix, saveVisit } from "../services/fixStore.js";
import { jobStore } from "../services/jobStore.js";
import { loadProfile } from "../services/profileStore.js";
import { updateProfileFromFix } from "../services/profileUpdater.js";
import { getTrainingStatus, shouldTrain, triggerTraining } from "../services/trainer.js";
import { recognizeEquationCrop } from "../services/mathOcrService.js";
import { latexToMathMl } from "../services/mathMlService.js";
import { type SemanticBox, generateFinalPageFromBoxes, semanticBoxCropFileName, writeSemanticBoxCrop } from "../services/semanticTagService.js";
import { getSpanCorrections, saveSpanCorrection } from "../services/spanCorrectionService.js";
import { writeArchiveFinalPage } from "../services/archiveFinalPageService.js";
import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";

export const fixesRouter = Router({ mergeParams: true });

function canonicalBoxes(boxes: SemanticBox[]): string {
  return JSON.stringify(boxes, (_key, value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return value;
    return Object.keys(value).sort().reduce<Record<string, unknown>>((result, key) => {
      result[key] = (value as Record<string, unknown>)[key];
      return result;
    }, {});
  });
}

function normalizeArchiveCssStrategy(value: unknown): ArchiveZoningCssStrategy {
  return value === "preserve-child-css" ? "preserve-child-css" : "factor-common-css";
}

async function recognizeEquationBoxes(jobId: string, pageIndex: number, boxes: SemanticBox[]): Promise<void> {
  const pageNumber = pageIndex + 1;
  const finalDir = jobStore.getFinalDir(jobId);
  const finalCropDir = path.join(finalDir, "images", "crops");
  for (const box of boxes) {
    if (box.tag !== "equation") continue;
    const cropFileName = semanticBoxCropFileName(pageNumber, box);
    const cropPath = await writeSemanticBoxCrop(jobId, pageIndex, box, cropFileName, finalCropDir);
    const result = await recognizeEquationCrop(cropPath);
    const mathMlResult = result.latex ? latexToMathMl(result.latex) : { ok: false, error: "No LaTeX returned by Pix2Text." };
    box.math = {
      latex: result.latex,
      mathml: mathMlResult.mathml,
      mathmlStatus: mathMlResult.ok ? "ok" : "failed",
      mathmlError: mathMlResult.error,
      status: result.status,
      engine: result.engine,
      error: result.error,
      cropFileName,
      recognizedAt: new Date().toISOString()
    };
  }
}

fixesRouter.post("/fixes", async (req, res) => {
  try {
    const params = req.params as { id: string; pageIndex: string };
    const jobId = params.id;
    const pageIndex = Number(params.pageIndex);
    const fixes = req.body as FixDelta[];
    if (!Array.isArray(fixes)) {
      res.status(400).json({ message: "Expected an array of fixes" });
      return;
    }
    const job = await jobStore.getJob(jobId);
    if (!job) {
      res.status(404).json({ message: "Job not found" });
      return;
    }
    let profileUpdated = false;
    for (const fix of fixes) {
      await saveFix({ ...fix, jobId, pageIndex });
      const page = await jobStore.getPage(jobId, pageIndex);
      const profile = await loadProfile(job.pdfFingerprint);
      await updateProfileFromFix(profile, fix, page?.leftMarginPx ?? 0);
      profileUpdated = true;
    }
    if (fixes.length > 0) await jobStore.updatePage(jobId, pageIndex, { reviewStatus: "edited" });
    const editSummary = await buildEditSummary(jobId);
    const trainingTriggered = !(await jobStore.hasActiveExtractions()) && await shouldTrain() ? await triggerTraining() : false;
    res.json({ saved: fixes.length, profileUpdated, trainingTriggered, editSummary });
  } catch (error) {
    res.status(500).json({ message: error instanceof Error ? error.message : "Unable to save fixes" });
  }
});

fixesRouter.get("/boxes", async (req, res) => {
  try {
    const params = req.params as { id: string; pageIndex: string };
    const jobId = params.id;
    const pageIndex = Number(params.pageIndex);
    const pageNumber = pageIndex + 1;
    const boxesPath = path.join(jobStore.getFinalDir(jobId), `page-${pageNumber}.boxes.json`);
    const content = await readFile(boxesPath, "utf8").catch(() => "");
    if (!content) {
      res.json({ boxes: [] });
      return;
    }
    const payload = JSON.parse(content) as { boxes?: SemanticBox[]; archiveFinalCssStrategy?: ArchiveZoningCssStrategy };
    res.json({
      boxes: Array.isArray(payload.boxes) ? payload.boxes : [],
      archiveFinalCssStrategy: normalizeArchiveCssStrategy(payload.archiveFinalCssStrategy)
    });
  } catch (error) {
    res.status(500).json({ message: error instanceof Error ? error.message : "Unable to load boxes" });
  }
});

fixesRouter.put("/boxes", async (req, res) => {
  try {
    const params = req.params as { id: string; pageIndex: string };
    const jobId = params.id;
    const pageIndex = Number(params.pageIndex);
    const pageNumber = pageIndex + 1;
    const body = req.body as { boxes?: SemanticBox[]; recognizeEquations?: boolean; archiveFinalHtml?: string; archiveFinalCssStrategy?: ArchiveZoningCssStrategy };
    const boxes = Array.isArray(body.boxes) ? body.boxes : [];
    const job = await jobStore.getJob(jobId);
    if (!job) {
      res.status(404).json({ message: "Job not found" });
      return;
    }
    const isArchiveSource = job.sourceType === "epub" || job.sourceType === "html-zip";
    const finalDir = jobStore.getFinalDir(jobId);
    const boxesPath = path.join(finalDir, `page-${pageNumber}.boxes.json`);
    const storedContent = await readFile(boxesPath, "utf8").catch(() => "");
    const storedPayload = storedContent ? JSON.parse(storedContent) as { boxes?: SemanticBox[]; archiveFinalCssStrategy?: ArchiveZoningCssStrategy } : { boxes: [] };
    const storedBoxes = Array.isArray(storedPayload.boxes) ? storedPayload.boxes : [];
    const archiveFinalCssStrategy = normalizeArchiveCssStrategy(body.archiveFinalCssStrategy);
    const storedArchiveFinalCssStrategy = normalizeArchiveCssStrategy(storedPayload.archiveFinalCssStrategy);
    if (canonicalBoxes(storedBoxes) === canonicalBoxes(boxes) && (!isArchiveSource || archiveFinalCssStrategy === storedArchiveFinalCssStrategy)) {
      const finalPagePath = isArchiveSource && typeof body.archiveFinalHtml === "string"
        ? await writeArchiveFinalPage(jobId, pageIndex, body.archiveFinalHtml)
        : undefined;
      res.json({ ok: true, saved: storedBoxes.length, boxes: storedBoxes, unchanged: true, finalPagePath, archiveFinalCssStrategy: storedArchiveFinalCssStrategy });
      return;
    }

    await mkdir(finalDir, { recursive: true });
    if (body.recognizeEquations && !isArchiveSource) {
      await recognizeEquationBoxes(jobId, pageIndex, boxes);
    }
    if (!isArchiveSource) await generateFinalPageFromBoxes(jobId, pageIndex, boxes);
    const finalPagePath = isArchiveSource && typeof body.archiveFinalHtml === "string"
      ? await writeArchiveFinalPage(jobId, pageIndex, body.archiveFinalHtml)
      : undefined;
    await writeFile(boxesPath, JSON.stringify(isArchiveSource ? { boxes, archiveFinalCssStrategy } : { boxes }, null, 2), "utf8");
    res.json({ ok: true, saved: boxes.length, boxes, unchanged: false, finalPagePath, archiveFinalCssStrategy });
  } catch (error) {
    res.status(500).json({ message: error instanceof Error ? error.message : "Unable to save boxes" });
  }
});

fixesRouter.post("/boxes/:boxId/recognize-equation", async (req, res) => {
  try {
    const params = req.params as { id: string; pageIndex: string; boxId: string };
    const jobId = params.id;
    const pageIndex = Number(params.pageIndex);
    const pageNumber = pageIndex + 1;
    const job = await jobStore.getJob(jobId);
    if (!job) {
      res.status(404).json({ message: "Job not found" });
      return;
    }

    const finalDir = jobStore.getFinalDir(jobId);
    const boxesPath = path.join(finalDir, `page-${pageNumber}.boxes.json`);
    const body = req.body as { boxes?: SemanticBox[] };
    const content = await readFile(boxesPath, "utf8").catch(() => "");
    const payload = content ? JSON.parse(content) as { boxes?: SemanticBox[] } : { boxes: [] };
    const boxes = Array.isArray(body.boxes)
      ? body.boxes
      : Array.isArray(payload.boxes)
        ? payload.boxes
        : [];
    const box = boxes.find((candidate) => candidate.id === params.boxId);
    if (!box) {
      res.status(404).json({ message: "Box not found" });
      return;
    }
    if (box.tag !== "equation") {
      res.status(400).json({ message: "Box must be tagged as equation before math recognition." });
      return;
    }

    await recognizeEquationBoxes(jobId, pageIndex, [box]);

    await generateFinalPageFromBoxes(jobId, pageIndex, boxes);
    await mkdir(finalDir, { recursive: true });
    await writeFile(boxesPath, JSON.stringify({ boxes }, null, 2), "utf8");

    res.json({
      box,
      result: {
        ok: box.math?.status === "ok",
        status: box.math?.status ?? "failed",
        latex: box.math?.latex,
        error: box.math?.error,
        mathml: box.math?.mathml,
        mathmlStatus: box.math?.mathmlStatus,
        mathmlError: box.math?.mathmlError
      },
      cropUrl: box.math?.cropFileName ? `/storage/jobs/${encodeURIComponent(jobId)}/final/images/crops/${encodeURIComponent(box.math.cropFileName)}` : undefined
    });
  } catch (error) {
    res.status(500).json({ message: error instanceof Error ? error.message : "Unable to recognize equation" });
  }
});

fixesRouter.post("/visit", async (req, res) => {
  try {
    const params = req.params as { id: string; pageIndex: string };
    const jobId = params.id;
    const pageIndex = Number(params.pageIndex);
    const body = req.body as Partial<PageVisit>;
    const visit: PageVisit = { jobId, pageIndex, reviewerId: body.reviewerId ?? "local-reviewer", visitedAt: body.visitedAt ?? new Date().toISOString() };
    await saveVisit(visit);
    const page = await jobStore.getPage(jobId, pageIndex);
    if (page && page.reviewStatus !== "edited") {
      await jobStore.updatePage(jobId, pageIndex, { reviewStatus: "reviewed" });
    }
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ message: error instanceof Error ? error.message : "Unable to record visit" });
  }
});

fixesRouter.get("/span-corrections", async (req, res) => {
  try {
    const params = req.params as { id: string };
    const jobId = params.id;
    const job = await jobStore.getJob(jobId);
    if (!job) {
      res.status(404).json({ message: "Job not found" });
      return;
    }
    res.json({ corrections: await getSpanCorrections(jobId) });
  } catch (error) {
    res.status(500).json({ message: error instanceof Error ? error.message : "Unable to load span corrections" });
  }
});

fixesRouter.put("/span-corrections", async (req, res) => {
  try {
    const params = req.params as { id: string };
    const jobId = params.id;
    const job = await jobStore.getJob(jobId);
    if (!job) {
      res.status(404).json({ message: "Job not found" });
      return;
    }
    const body = req.body as { correction?: Partial<SpanCorrection> };
    const correction = body.correction;
    if (!correction) {
      res.status(400).json({ message: "Expected correction payload" });
      return;
    }
    const scope = correction.scope;
    if (scope !== "span" && scope !== "page-font-size" && scope !== "book-font-size") {
      res.status(400).json({ message: "Invalid correction scope" });
      return;
    }
    const pageIndex = Number(correction.pageIndex);
    const wordIndex = Number(correction.wordIndex);
    const fontSizePx = Number(correction.fontSizePx);
    const topDeltaPx = Number(correction.topDeltaPx ?? 0);
    const leftDeltaPx = Number(correction.leftDeltaPx ?? 0);
    const letterSpacingPx = Number(correction.letterSpacingPx ?? 0);
    if (![pageIndex, wordIndex, fontSizePx, topDeltaPx, leftDeltaPx, letterSpacingPx].every(Number.isFinite)) {
      res.status(400).json({ message: "Correction has invalid numeric values" });
      return;
    }
    const result = await saveSpanCorrection(jobId, {
      id: typeof correction.id === "string" ? correction.id : undefined,
      scope,
      pageIndex,
      wordIndex,
      cssClassName: typeof correction.cssClassName === "string" ? correction.cssClassName : undefined,
      fontFamily: String(correction.fontFamily ?? "").trim(),
      fontSizePx,
      fontWeight: String(correction.fontWeight ?? "normal").trim() || "normal",
      fontStyle: String(correction.fontStyle ?? "normal").trim() || "normal",
      topDeltaPx,
      leftDeltaPx,
      letterSpacingPx
    });
    res.json({ ok: true, correctionCount: result.correctionCount, affectedPages: result.affectedPages });
  } catch (error) {
    res.status(500).json({ message: error instanceof Error ? error.message : "Unable to save span correction" });
  }
});

fixesRouter.get("/draft", async (req, res) => {
  try {
    const params = req.params as { id: string; pageIndex: string };
    const jobId = params.id;
    const pageIndex = Number(params.pageIndex);
    const job = await jobStore.getJob(jobId);
    if (!job) {
      res.status(404).json({ message: "Job not found" });
      return;
    }
    const draft = await jobStore.getDraftPage(jobId, pageIndex);
    if (!draft) {
      res.status(404).json({ ready: false });
      return;
    }
    res.json(draft);
  } catch (error) {
    res.status(500).json({ message: error instanceof Error ? error.message : "Unable to load draft" });
  }
});

fixesRouter.put("/draft", async (req, res) => {
  try {
    const params = req.params as { id: string; pageIndex: string };
    const jobId = params.id;
    const pageIndex = Number(params.pageIndex);
    const job = await jobStore.getJob(jobId);
    if (!job) {
      res.status(404).json({ message: "Job not found" });
      return;
    }
    const body = req.body as Partial<DraftPageState>;
    if (!Array.isArray(body.blocks) || !Array.isArray(body.pendingFixes)) {
      res.status(400).json({ message: "Expected blocks[] and pendingFixes[]" });
      return;
    }
    const hiddenWordIds = Array.isArray(body.hiddenWordIds) ? body.hiddenWordIds.filter((value) => typeof value === "string") : [];
    const saved = await jobStore.saveDraftPage(jobId, pageIndex, { blocks: body.blocks, pendingFixes: body.pendingFixes, hiddenWordIds });
    res.json(saved);
  } catch (error) {
    res.status(500).json({ message: error instanceof Error ? error.message : "Unable to save draft" });
  }
});

fixesRouter.delete("/draft", async (req, res) => {
  try {
    const params = req.params as { id: string; pageIndex: string };
    const jobId = params.id;
    const pageIndex = Number(params.pageIndex);
    const job = await jobStore.getJob(jobId);
    if (!job) {
      res.status(404).json({ message: "Job not found" });
      return;
    }
    await jobStore.deleteDraftPage(jobId, pageIndex);
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ message: error instanceof Error ? error.message : "Unable to delete draft" });
  }
});

export const fixesStatusRouter = Router();
fixesStatusRouter.get("/status", async (_req, res) => { res.json(getTrainingStatus()); });

