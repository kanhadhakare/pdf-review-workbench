import { Router } from "express";
import { type DraftPageState, type FixDelta, type PageVisit } from "../types.js";
import { buildEditSummary, saveFix, saveVisit } from "../services/fixStore.js";
import { jobStore } from "../services/jobStore.js";
import { loadProfile } from "../services/profileStore.js";
import { updateProfileFromFix } from "../services/profileUpdater.js";
import { getTrainingStatus, shouldTrain, triggerTraining } from "../services/trainer.js";
// Combined review build only: final regeneration disabled for now.
import { type SemanticBox, generateFinalPageFromBoxes } from "../services/semanticTagService.js";
import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";

export const fixesRouter = Router({ mergeParams: true });

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
    const payload = JSON.parse(content) as { boxes?: SemanticBox[] };
    res.json({ boxes: Array.isArray(payload.boxes) ? payload.boxes : [] });
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
    const body = req.body as { boxes?: SemanticBox[] };
    const boxes = Array.isArray(body.boxes) ? body.boxes : [];
    const finalDir = jobStore.getFinalDir(jobId);
    await mkdir(finalDir, { recursive: true });
    const boxesPath = path.join(finalDir, `page-${pageNumber}.boxes.json`);
    await writeFile(boxesPath, JSON.stringify({ boxes }, null, 2), "utf8");

    await generateFinalPageFromBoxes(jobId, pageIndex, boxes);
    res.json({ ok: true, saved: boxes.length });
  } catch (error) {
    res.status(500).json({ message: error instanceof Error ? error.message : "Unable to save boxes" });
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

