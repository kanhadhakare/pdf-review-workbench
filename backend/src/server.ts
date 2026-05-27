import cors from "cors";
import express from "express";
import path from "node:path";
import { mkdir, stat } from "node:fs/promises";
import { fixesRouter, fixesStatusRouter } from "./routes/fixes.js";
import { jobsRouter } from "./routes/jobs.js";
import { profilesRouter } from "./routes/profiles.js";
import { getCorsOrigins, serverPort, storageRoot } from "./config/runtime.js";
import { warmClassifier } from "./services/classifier.js";
import { warmProfiles } from "./services/profileStore.js";

const app = express();
const port = serverPort;

async function ensureDirectory(dirPath: string, label: string): Promise<void> {
  try {
    const info = await stat(dirPath);
    if (!info.isDirectory()) {
      throw new Error(`${label} exists but is not a directory: ${dirPath}`);
    }
  } catch (error) {
    if ((error as any)?.code !== "ENOENT") throw error;
    await mkdir(dirPath, { recursive: true });
  }
}

app.use(cors({ origin: getCorsOrigins() }));
app.use(express.json({ limit: "10mb" }));
app.use("/storage/jobs", express.static(path.join(storageRoot, "jobs")));
app.use("/api/jobs", jobsRouter);
app.use("/api/jobs/:id/pages/:pageIndex", fixesRouter);
app.use("/api/profiles", profilesRouter);
app.use("/api/fixes", fixesStatusRouter);
app.get("/api/health", (_req, res) => res.json({ ok: true }));

const server = app.listen(port, async () => {
  await ensureDirectory(storageRoot, "STORAGE_ROOT");
  await ensureDirectory(path.join(storageRoot, "jobs"), "STORAGE_ROOT/jobs");
  await warmProfiles();
  await warmClassifier();
  console.log(`API listening on http://0.0.0.0:${port}`);
});

const shutdown = () => {
  server.close(() => process.exit(0));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
