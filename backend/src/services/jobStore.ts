import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import path from "node:path";
import { type DraftPageState, type ExtractionJob, type FontExtractionManifest, type ImportedBookManifest, type JobEditSummary, type OcrComparisonResult, type OcrPageResult, type PageResult, type PdfPageBounds } from "../types.js";
import { storageRoot } from "../config/runtime.js";

const STORAGE_ROOT = storageRoot;
const JOBS_ROOT = path.join(STORAGE_ROOT, "jobs");

export interface StoredPageArtifacts {
  page: PageResult;
  reviewHtmlContent: string;
  reviewCssContent: string;
}

export interface StoredJobState extends ExtractionJob {
  processedPages: number;
  errorMessage?: string;
  warning?: "large_file";
  hasPdf2HtmlEx?: boolean;
  pdf2htmlExWarnings?: string[];
  targetWidthPx?: number;
}

const EMPTY_EDIT_SUMMARY = (jobId: string): JobEditSummary => ({
  jobId,
  totalEdits: 0,
  editsByPage: {},
  editsByType: {
    move: 0,
    resize: 0,
    "text-correct": 0,
    "tag-change": 0,
    merge: 0,
    delete: 0,
    "style-change": 0,
    split: 0,
    "create-group": 0
  },
  pagesReviewed: [],
  pagesEdited: [],
  pagesAccurate: [],
  sessionsCount: 0,
  lastEditAt: null
});

async function ensureDir(dirPath: string): Promise<void> {
  await mkdir(dirPath, { recursive: true });
}

async function readJson<T>(filePath: string): Promise<T | null> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const content = await readFile(filePath, "utf8");
      return JSON.parse(content) as T;
    } catch {
      if (attempt < 2) await delay(10);
    }
  }
  return null;
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await ensureDir(path.dirname(filePath));
  const temporaryPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporaryPath, JSON.stringify(value, null, 2), "utf8");
    await rename(temporaryPath, filePath);
  } finally {
    await unlink(temporaryPath).catch(() => void 0);
  }
}

export class JobStore {
  private readonly activeJobs = new Set<string>();

  get storageRoot(): string {
    return STORAGE_ROOT;
  }

  get jobsRoot(): string {
    return JOBS_ROOT;
  }

  async create(job: StoredJobState): Promise<StoredJobState> {
    const dir = this.getJobDir(job.id);
    await Promise.all([
      ensureDir(dir),
      ensureDir(this.getImagesDir(job.id)),
      ensureDir(this.getPagesDir(job.id)),
      ensureDir(this.getReviewDir(job.id)),
      ensureDir(this.getReviewStylesDir(job.id)),
      ensureDir(this.getFinalDir(job.id)),
      ensureDir(this.getStylesDir(job.id)),
      ensureDir(this.getFontsDir(job.id)),
      ensureDir(this.getOcrDir(job.id)),
      ensureDir(this.getAccessibilityDir(job.id)),
      ensureDir(this.getImportedDir(job.id))
    ]);
    await this.saveJob(job);
    return job;
  }

  async saveJob(job: StoredJobState): Promise<void> {
    await writeJson(this.getMetaPath(job.id), job);
  }

  async saveSourceManifest(jobId: string, manifest: ImportedBookManifest): Promise<void> {
    await writeJson(this.getSourceManifestPath(jobId), manifest);
  }

  async getSourceManifest(jobId: string): Promise<ImportedBookManifest | null> {
    return readJson<ImportedBookManifest>(this.getSourceManifestPath(jobId));
  }

  async getJob(jobId: string): Promise<StoredJobState | null> {
    return readJson<StoredJobState>(this.getMetaPath(jobId));
  }

  async listJobs(): Promise<StoredJobState[]> {
    try {
      const entries = await readdir(JOBS_ROOT, { withFileTypes: true });
      const jobs: StoredJobState[] = [];
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const job = await this.getJob(entry.name);
        if (job) jobs.push(job);
      }
      return jobs.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
    } catch {
      return [];
    }
  }

  async updateJob(jobId: string, patch: Partial<StoredJobState>): Promise<StoredJobState> {
    const current = await this.getJob(jobId);
    if (!current) {
      throw new Error(`Job ${jobId} not found`);
    }
    const next: StoredJobState = { ...current, ...patch, updatedAt: new Date().toISOString() };
    await this.saveJob(next);
    return next;
  }

  async markActive(jobId: string): Promise<void> { this.activeJobs.add(jobId); }
  async markInactive(jobId: string): Promise<void> { this.activeJobs.delete(jobId); }
  hasActiveExtraction(): boolean { return this.activeJobs.size > 0; }
  async hasActiveExtractions(): Promise<boolean> {
    try {
      const entries = await readdir(JOBS_ROOT, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const meta = await this.getJob(entry.name);
        if (!meta) continue;
        if (meta.status === "pending" || meta.status === "processing") {
          return true;
        }
      }
      return false;
    } catch {
      return false;
    }
  }

  async saveSourcePdf(jobId: string, input: Uint8Array): Promise<string> {
    const target = path.join(this.getJobDir(jobId), "source.pdf");
    await writeFile(target, input);
    return target;
  }

  async savePageArtifacts(jobId: string, pageIndex: number, artifacts: StoredPageArtifacts, imageBytes: Uint8Array): Promise<void> {
    const pageNumber = pageIndex + 1;
    await Promise.all([
      writeFile(this.getImagePath(jobId, pageIndex), imageBytes),
      writeJson(this.getPageJsonPath(jobId, pageIndex), artifacts.page),
      writeFile(path.join(this.getReviewDir(jobId), `page-${pageNumber}.html`), artifacts.reviewHtmlContent, "utf8"),
      writeFile(path.join(this.getReviewStylesDir(jobId), `page-${pageNumber}.css`), artifacts.reviewCssContent, "utf8"),
      writeFile(path.join(this.getReviewDir(jobId), `page-${pageNumber}.json`), JSON.stringify({ pageIndex, blocks: artifacts.page.blocks, confidence: artifacts.page.confidence }, null, 2), "utf8")
    ]);
  }

  async savePdf2HtmlExPage(jobId: string, pageIndex: number, pageWidth: number, pageHeight: number, imageBytes: Uint8Array, pdfPageBounds?: PdfPageBounds, renderDpi?: number): Promise<void> {
    const page: PageResult = {
      pageIndex,
      imageUrl: `/api/jobs/${jobId}/pages/${pageIndex}/image`,
      htmlContent: "",
      blocks: [],
      confidence: 1,
      pageWidth,
      pageHeight,
      pdfPageBounds,
      renderDpi,
      leftMarginPx: 0,
      reviewStatus: "unvisited"
    };
    await Promise.all([
      writeFile(this.getImagePath(jobId, pageIndex), imageBytes),
      writeJson(this.getPageJsonPath(jobId, pageIndex), page)
    ]);
  }

  async saveFontFile(jobId: string, fileName: string, bytes: Uint8Array): Promise<void> {
    await writeFile(path.join(this.getFontsDir(jobId), fileName), bytes);
  }

  async saveFontManifest(jobId: string, manifest: FontExtractionManifest): Promise<void> {
    await writeJson(this.getFontManifestPath(jobId), manifest);
  }

  async saveCropImage(jobId: string, fileName: string, bytes: Uint8Array): Promise<void> {
    await ensureDir(this.getCropsDir(jobId));
    await writeFile(path.join(this.getCropsDir(jobId), fileName), bytes);
  }

  async saveRegeneratedFinalPage(jobId: string, pageIndex: number, page: PageResult, finalHtmlContent: string, cssContent: string): Promise<void> {
    const pageNumber = pageIndex + 1;
    await Promise.all([
      writeJson(this.getPageJsonPath(jobId, pageIndex), page),
      // Intermediate builds disabled for now.
      void finalHtmlContent,
      void cssContent
    ]);
  }

  async getFontManifest(jobId: string): Promise<FontExtractionManifest | null> {
    return readJson<FontExtractionManifest>(this.getFontManifestPath(jobId));
  }

  async getPage(jobId: string, pageIndex: number): Promise<PageResult | null> {
    return readJson<PageResult>(this.getPageJsonPath(jobId, pageIndex));
  }

  async saveOcrArtifacts(jobId: string, pageIndex: number, ocrPage: OcrPageResult, comparison: OcrComparisonResult): Promise<void> {
    const pageNumber = pageIndex + 1;
    await Promise.all([
      writeJson(path.join(this.getOcrDir(jobId), `page-${pageNumber}.ocr.json`), ocrPage),
      writeJson(path.join(this.getOcrDir(jobId), `page-${pageNumber}.compare.json`), comparison)
    ]);
  }

  async getOcrPage(jobId: string, pageIndex: number): Promise<OcrPageResult | null> {
    return readJson<OcrPageResult>(path.join(this.getOcrDir(jobId), `page-${pageIndex + 1}.ocr.json`));
  }

  async getOcrComparison(jobId: string, pageIndex: number): Promise<OcrComparisonResult | null> {
    return readJson<OcrComparisonResult>(path.join(this.getOcrDir(jobId), `page-${pageIndex + 1}.compare.json`));
  }

  async updatePage(jobId: string, pageIndex: number, patch: Partial<PageResult>): Promise<PageResult> {
    const current = await this.getPage(jobId, pageIndex);
    if (!current) {
      throw new Error(`Page ${pageIndex} not found for job ${jobId}`);
    }
    const next = { ...current, ...patch } satisfies PageResult;
    await writeJson(this.getPageJsonPath(jobId, pageIndex), next);
    return next;
  }

  async listPageConfidences(jobId: string): Promise<Array<{ pageIndex: number; confidence: number }>> {
    try {
      const entries = await readdir(this.getPagesDir(jobId));
      const results: Array<{ pageIndex: number; confidence: number }> = [];
      for (const entry of entries) {
        if (!entry.endsWith('.json')) continue;
        const page = await readJson<PageResult>(path.join(this.getPagesDir(jobId), entry));
        if (page) results.push({ pageIndex: page.pageIndex, confidence: page.confidence });
      }
      return results.sort((a, b) => a.pageIndex - b.pageIndex);
    } catch {
      return [];
    }
  }

  getDraftDir(jobId: string): string { return path.join(this.getJobDir(jobId), "draft"); }
  getDraftPagePath(jobId: string, pageIndex: number): string { return path.join(this.getDraftDir(jobId), `${pageIndex}.json`); }

  async saveDraftPage(jobId: string, pageIndex: number, state: Omit<DraftPageState, "jobId" | "pageIndex" | "updatedAt">): Promise<DraftPageState> {
    const payload: DraftPageState = { jobId, pageIndex, ...state, updatedAt: new Date().toISOString() };
    await writeJson(this.getDraftPagePath(jobId, pageIndex), payload);
    return payload;
  }

  async getDraftPage(jobId: string, pageIndex: number): Promise<DraftPageState | null> {
    return readJson<DraftPageState>(this.getDraftPagePath(jobId, pageIndex));
  }

  async listDraftPages(jobId: string): Promise<number[]> {
    try {
      const entries = await readdir(this.getDraftDir(jobId));
      return entries
        .filter((name) => name.endsWith(".json"))
        .map((name) => Number(name.replace(/\.json$/, "")))
        .filter((value) => Number.isFinite(value))
        .sort((a, b) => a - b);
    } catch {
      return [];
    }
  }

  async deleteDraftPage(jobId: string, pageIndex: number): Promise<void> {
    try {
      await unlink(this.getDraftPagePath(jobId, pageIndex));
    } catch {
      // ignore missing
    }
  }

  getJobDir(jobId: string): string { return path.join(JOBS_ROOT, jobId); }
  getMetaPath(jobId: string): string { return path.join(this.getJobDir(jobId), "meta.json"); }
  getPagesDir(jobId: string): string { return path.join(this.getJobDir(jobId), "pages"); }
  getReviewDir(jobId: string): string { return path.join(this.getJobDir(jobId), "review"); }
  getReviewStylesDir(jobId: string): string { return path.join(this.getJobDir(jobId), "style"); }
  getFinalDir(jobId: string): string { return path.join(this.getJobDir(jobId), "final"); }
  getStylesDir(jobId: string): string { return path.join(this.getJobDir(jobId), "styles"); }
  getPdf2HtmlExDir(jobId: string): string { return path.join(this.getJobDir(jobId), "pdf2htmlex"); }
  getFontsDir(jobId: string): string { return path.join(this.getJobDir(jobId), "fonts"); }
  getCropsDir(jobId: string): string { return path.join(this.getImagesDir(jobId), "crops"); }
  getFontManifestPath(jobId: string): string { return path.join(this.getFontsDir(jobId), "manifest.json"); }
  getOcrDir(jobId: string): string { return path.join(this.getJobDir(jobId), "ocr"); }
  getAccessibilityDir(jobId: string): string { return path.join(this.getJobDir(jobId), "accessibility"); }
  getAccessibilityMapPath(jobId: string): string { return path.join(this.getAccessibilityDir(jobId), "accessibility-map.json"); }
  getAccessibilityValidationReportPath(jobId: string): string { return path.join(this.getAccessibilityDir(jobId), "validation-report.json"); }
  getImportedDir(jobId: string): string { return path.join(this.getJobDir(jobId), "imported"); }
  getSourceManifestPath(jobId: string): string { return path.join(this.getJobDir(jobId), "source-manifest.json"); }
  getImagesDir(jobId: string): string { return path.join(this.getJobDir(jobId), "images"); }
  getImagePath(jobId: string, pageIndex: number): string { return path.join(this.getImagesDir(jobId), `page-${pageIndex + 1}.png`); }
  getPageJsonPath(jobId: string, pageIndex: number): string { return path.join(this.getPagesDir(jobId), `${pageIndex}.json`); }

  async jobExists(jobId: string): Promise<boolean> {
    try {
      const meta = await stat(this.getMetaPath(jobId));
      return meta.isFile();
    } catch {
      return false;
    }
  }

  async deleteJob(jobId: string): Promise<void> {
    await rm(this.getJobDir(jobId), { recursive: true, force: true });
  }

  emptySummary(jobId: string): JobEditSummary {
    return EMPTY_EDIT_SUMMARY(jobId);
  }
}

export const jobStore = new JobStore();

