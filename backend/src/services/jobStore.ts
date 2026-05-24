import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { type ExtractionJob, type JobEditSummary, type OcrComparisonResult, type OcrPageResult, type PageResult } from "../types.js";

const STORAGE_ROOT = path.resolve("E:/pdf-review-workbench/storage");
const JOBS_ROOT = path.join(STORAGE_ROOT, "jobs");

export interface StoredPageArtifacts {
  page: PageResult;
  reviewHtmlContent: string;
  boxesHtmlContent: string;
  finalHtmlContent: string;
  cssContent: string;
}

export interface StoredJobState extends ExtractionJob {
  processedPages: number;
  errorMessage?: string;
  warning?: "large_file";
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
    split: 0
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
  try {
    const content = await readFile(filePath, "utf8");
    return JSON.parse(content) as T;
  } catch {
    return null;
  }
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await ensureDir(path.dirname(filePath));
  await writeFile(filePath, JSON.stringify(value, null, 2), "utf8");
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
      ensureDir(this.getFinalDir(job.id)),
      ensureDir(this.getStylesDir(job.id)),
      ensureDir(this.getFontsDir(job.id)),
      ensureDir(this.getOcrDir(job.id))
    ]);
    await this.saveJob(job);
    return job;
  }

  async saveJob(job: StoredJobState): Promise<void> {
    await writeJson(this.getMetaPath(job.id), job);
  }

  async getJob(jobId: string): Promise<StoredJobState | null> {
    return readJson<StoredJobState>(this.getMetaPath(jobId));
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
      writeFile(path.join(this.getReviewDir(jobId), `page-${pageNumber}.json`), JSON.stringify({ pageIndex, blocks: artifacts.page.blocks, confidence: artifacts.page.confidence }, null, 2), "utf8"),
      writeFile(path.join(this.getReviewDir(jobId), `page-${pageNumber}-boxes.html`), artifacts.boxesHtmlContent, "utf8"),
      writeFile(path.join(this.getFinalDir(jobId), `page-${pageNumber}.html`), artifacts.finalHtmlContent, "utf8"),
      writeFile(path.join(this.getStylesDir(jobId), `page-${pageNumber}.css`), artifacts.cssContent, "utf8")
    ]);
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

  getJobDir(jobId: string): string { return path.join(JOBS_ROOT, jobId); }
  getMetaPath(jobId: string): string { return path.join(this.getJobDir(jobId), "meta.json"); }
  getPagesDir(jobId: string): string { return path.join(this.getJobDir(jobId), "pages"); }
  getReviewDir(jobId: string): string { return path.join(this.getJobDir(jobId), "review"); }
  getFinalDir(jobId: string): string { return path.join(this.getJobDir(jobId), "final"); }
  getStylesDir(jobId: string): string { return path.join(this.getJobDir(jobId), "styles"); }
  getFontsDir(jobId: string): string { return path.join(this.getJobDir(jobId), "fonts"); }
  getOcrDir(jobId: string): string { return path.join(this.getJobDir(jobId), "ocr"); }
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

  emptySummary(jobId: string): JobEditSummary {
    return EMPTY_EDIT_SUMMARY(jobId);
  }
}

export const jobStore = new JobStore();

