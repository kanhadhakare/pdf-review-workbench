import { Router } from "express";
import { type FixDelta, type PageVisit } from "../types.js";
import { buildEditSummary, saveFix, saveVisit } from "../services/fixStore.js";
import { jobStore } from "../services/jobStore.js";
import { loadProfile } from "../services/profileStore.js";
import { updateProfileFromFix } from "../services/profileUpdater.js";
import { getTrainingStatus, shouldTrain, triggerTraining } from "../services/trainer.js";

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
    if (fixes.length > 0) {
      await jobStore.updatePage(jobId, pageIndex, { reviewStatus: "edited" });
    }
    const editSummary = await buildEditSummary(jobId);
    const trainingTriggered = !jobStore.hasActiveExtraction() && await shouldTrain() ? await triggerTraining() : false;
    res.json({ saved: fixes.length, profileUpdated, trainingTriggered, editSummary });
  } catch (error) {
    res.status(500).json({ message: error instanceof Error ? error.message : "Unable to save fixes" });
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

export const fixesStatusRouter = Router();
fixesStatusRouter.get("/status", async (_req, res) => { res.json(getTrainingStatus()); });

