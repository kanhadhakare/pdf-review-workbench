import { ExtractionStatus, type ExtractionJob, type PageResult, type TextBlock } from "../types.js";
import fs from "fs-extra";
import path from "node:path";

export interface InternalJob extends ExtractionJob {
  processedPages: number;
  sourcePath?: string;
  sourceFileName?: string;
  errorMessage?: string;
}

export interface StoredPage extends PageResult {
  width: number;
  height: number;
  blocks: TextBlock[];
  cssContent?: string;
  fileHtmlContent?: string;
}

export class JobStore {
  private readonly jobs = new Map<string, InternalJob>();

  constructor(private readonly jobsRoot: string) {}

  async ensureJob(job: InternalJob): Promise<void> {
    this.jobs.set(job.id, job);
    await fs.ensureDir(this.getJobDirectory(job.id));
    await fs.ensureDir(this.getPageDirectory(job.id));
    await fs.ensureDir(this.getImageDirectory(job.id));
    await fs.ensureDir(this.getStyleDirectory(job.id));
    await fs.ensureDir(this.getFontDirectory(job.id));
    await this.writeMeta(job);
  }

  async create(job: InternalJob): Promise<InternalJob> {
    await this.ensureJob(job);
    return job;
  }

  getJobDirectory(jobId: string): string {
    return path.join(this.jobsRoot, jobId);
  }

  getImageDirectory(jobId: string): string {
    return path.join(this.getJobDirectory(jobId), "images");
  }

  getPageDirectory(jobId: string): string {
    return path.join(this.getJobDirectory(jobId), "pages");
  }

  getStyleDirectory(jobId: string): string {
    return path.join(this.getJobDirectory(jobId), "styles");
  }

  getFontDirectory(jobId: string): string {
    return path.join(this.getJobDirectory(jobId), "fonts");
  }

  getSourcePdfPath(jobId: string): string {
    return path.join(this.getJobDirectory(jobId), "source.pdf");
  }

  getMetaPath(jobId: string): string {
    return path.join(this.getJobDirectory(jobId), "meta.json");
  }

  getPageJsonPath(jobId: string, pageIndex: number): string {
    return path.join(this.getPageDirectory(jobId), `page-${pageIndex + 1}.json`);
  }

  getPageHtmlPath(jobId: string, pageIndex: number): string {
    return path.join(this.getPageDirectory(jobId), `page-${pageIndex + 1}.html`);
  }

  getPageCssPath(jobId: string, pageIndex: number): string {
    return path.join(this.getStyleDirectory(jobId), `page-${pageIndex + 1}.css`);
  }

  getPageImagePath(jobId: string, pageIndex: number): string {
    return path.join(this.getImageDirectory(jobId), `page-${pageIndex + 1}.png`);
  }

  async update(jobId: string, patch: Partial<InternalJob>): Promise<InternalJob> {
    const current = await this.get(jobId);
    if (!current) {
      throw new Error(`Unknown job: ${jobId}`);
    }

    const next = { ...current, ...patch };
    this.jobs.set(jobId, next);
    await this.writeMeta(next);
    return next;
  }

  async incrementProcessed(jobId: string): Promise<InternalJob> {
    const current = await this.get(jobId);
    if (!current) {
      throw new Error(`Unknown job: ${jobId}`);
    }

    return this.update(jobId, { processedPages: current.processedPages + 1 });
  }

  async get(jobId: string): Promise<InternalJob | null> {
    const cached = this.jobs.get(jobId);
    if (cached) {
      return cached;
    }

    const metaPath = this.getMetaPath(jobId);
    if (!(await fs.pathExists(metaPath))) {
      return null;
    }

    const loaded = await fs.readJson(metaPath) as InternalJob;
    this.jobs.set(jobId, loaded);
    return loaded;
  }

  async savePage(jobId: string, page: StoredPage): Promise<void> {
    await fs.writeJson(this.getPageJsonPath(jobId, page.pageIndex), page, { spaces: 2 });
    await fs.writeFile(this.getPageHtmlPath(jobId, page.pageIndex), page.fileHtmlContent ?? page.htmlContent, "utf8");
    if ("cssContent" in page && typeof page.cssContent === "string") {
      await fs.writeFile(this.getPageCssPath(jobId, page.pageIndex), page.cssContent, "utf8");
    }
  }

  async readPage(jobId: string, pageIndex: number): Promise<StoredPage | null> {
    const pagePath = this.getPageJsonPath(jobId, pageIndex);
    if (!(await fs.pathExists(pagePath))) {
      return null;
    }

    return fs.readJson(pagePath) as Promise<StoredPage>;
  }

  async writeSourcePdf(jobId: string, sourceFilePath: string): Promise<void> {
    await fs.copy(sourceFilePath, this.getSourcePdfPath(jobId), { overwrite: true });
  }

  private async writeMeta(job: InternalJob): Promise<void> {
    await fs.writeJson(this.getMetaPath(job.id), job, { spaces: 2 });
  }
}

export function createJobRecord(id: string, sourcePath?: string, sourceFileName?: string): InternalJob {
  return {
    id,
    status: ExtractionStatus.pending,
    pageCount: 0,
    createdAt: new Date().toISOString(),
    processedPages: 0,
    sourcePath,
    sourceFileName
  };
}


