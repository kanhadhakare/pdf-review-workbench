import { Router } from "express";
import { listProfiles, loadProfile } from "../services/profileStore.js";
export const profilesRouter = Router();
profilesRouter.get("/", async (_req, res) => {
    try {
        res.json(await listProfiles());
    }
    catch (error) {
        res.status(500).json({ message: error instanceof Error ? error.message : "Unable to list profiles" });
    }
});
profilesRouter.get("/:fingerprint", async (req, res) => {
    try {
        const profile = await loadProfile(req.params.fingerprint);
        res.json({ profile, sampleCount: profile.sampleCount, recentConfidenceScores: [], improvementDelta: 0 });
    }
    catch (error) {
        res.status(500).json({ message: error instanceof Error ? error.message : "Unable to load profile" });
    }
});
