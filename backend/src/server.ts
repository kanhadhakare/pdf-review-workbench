import cors from "cors";
import express from "express";
import fs from "fs-extra";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createJobsRouter } from "./routes/jobs.js";
import { JobStore } from "./services/jobStore.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const workspaceRoot = path.resolve(__dirname, "..");
const storageRoot = path.join(workspaceRoot, "storage");
const uploadsRoot = path.join(storageRoot, "uploads");
const jobsRoot = path.join(storageRoot, "jobs");
const port = Number(process.env.PORT ?? 3000);
const allowedRoots = (process.env.PDF_ALLOWED_ROOTS ?? "E:\\")
  .split(";")
  .map((entry) => entry.trim())
  .filter(Boolean);

await fs.ensureDir(uploadsRoot);
await fs.ensureDir(jobsRoot);

const app = express();
const store = new JobStore(jobsRoot);

app.use(cors({ origin: "http://localhost:4200" }));
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));
app.use("/files", express.static(jobsRoot));

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.use("/api/jobs", createJobsRouter({
  store,
  uploadRoot: uploadsRoot,
  allowedRoots
}));

app.use((error: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  res.status(500).json({
    message: error.message || "Unexpected server error"
  });
});

app.listen(port, () => {
  console.log(`PDF Review Workbench API listening on http://localhost:${port}`);
});

