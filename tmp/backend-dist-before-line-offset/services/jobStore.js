import { mkdir, readFile, readdir, rm, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { storageRoot } from "../config/runtime.js";
const STORAGE_ROOT = storageRoot;
const JOBS_ROOT = path.join(STORAGE_ROOT, "jobs");
const EMPTY_EDIT_SUMMARY = (jobId) => ({
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
async function ensureDir(dirPath) {
    await mkdir(dirPath, { recursive: true });
}
async function readJson(filePath) {
    try {
        const content = await readFile(filePath, "utf8");
        return JSON.parse(content);
    }
    catch {
        return null;
    }
}
async function writeJson(filePath, value) {
    await ensureDir(path.dirname(filePath));
    await writeFile(filePath, JSON.stringify(value, null, 2), "utf8");
}
export class JobStore {
    activeJobs = new Set();
    get storageRoot() {
        return STORAGE_ROOT;
    }
    get jobsRoot() {
        return JOBS_ROOT;
    }
    async create(job) {
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
            ensureDir(this.getOcrDir(job.id))
        ]);
        await this.saveJob(job);
        return job;
    }
    async saveJob(job) {
        await writeJson(this.getMetaPath(job.id), job);
    }
    async getJob(jobId) {
        return readJson(this.getMetaPath(jobId));
    }
    async listJobs() {
        try {
            const entries = await readdir(JOBS_ROOT, { withFileTypes: true });
            const jobs = [];
            for (const entry of entries) {
                if (!entry.isDirectory())
                    continue;
                const job = await this.getJob(entry.name);
                if (job)
                    jobs.push(job);
            }
            return jobs.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
        }
        catch {
            return [];
        }
    }
    async updateJob(jobId, patch) {
        const current = await this.getJob(jobId);
        if (!current) {
            throw new Error(`Job ${jobId} not found`);
        }
        const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
        await this.saveJob(next);
        return next;
    }
    async markActive(jobId) { this.activeJobs.add(jobId); }
    async markInactive(jobId) { this.activeJobs.delete(jobId); }
    hasActiveExtraction() { return this.activeJobs.size > 0; }
    async hasActiveExtractions() {
        try {
            const entries = await readdir(JOBS_ROOT, { withFileTypes: true });
            for (const entry of entries) {
                if (!entry.isDirectory())
                    continue;
                const meta = await this.getJob(entry.name);
                if (!meta)
                    continue;
                if (meta.status === "pending" || meta.status === "processing") {
                    return true;
                }
            }
            return false;
        }
        catch {
            return false;
        }
    }
    async saveSourcePdf(jobId, input) {
        const target = path.join(this.getJobDir(jobId), "source.pdf");
        await writeFile(target, input);
        return target;
    }
    async savePageArtifacts(jobId, pageIndex, artifacts, imageBytes) {
        const pageNumber = pageIndex + 1;
        await Promise.all([
            writeFile(this.getImagePath(jobId, pageIndex), imageBytes),
            writeJson(this.getPageJsonPath(jobId, pageIndex), artifacts.page),
            writeFile(path.join(this.getReviewDir(jobId), `page-${pageNumber}.html`), artifacts.reviewHtmlContent, "utf8"),
            writeFile(path.join(this.getReviewStylesDir(jobId), `page-${pageNumber}.css`), artifacts.reviewCssContent, "utf8"),
            writeFile(path.join(this.getReviewDir(jobId), `page-${pageNumber}.json`), JSON.stringify({ pageIndex, blocks: artifacts.page.blocks, confidence: artifacts.page.confidence }, null, 2), "utf8")
        ]);
    }
    async savePdf2HtmlExPage(jobId, pageIndex, pageWidth, pageHeight, imageBytes) {
        const page = {
            pageIndex,
            imageUrl: `/api/jobs/${jobId}/pages/${pageIndex}/image`,
            htmlContent: "",
            blocks: [],
            confidence: 1,
            pageWidth,
            pageHeight,
            leftMarginPx: 0,
            reviewStatus: "unvisited"
        };
        await Promise.all([
            writeFile(this.getImagePath(jobId, pageIndex), imageBytes),
            writeJson(this.getPageJsonPath(jobId, pageIndex), page)
        ]);
    }
    async saveFontFile(jobId, fileName, bytes) {
        await writeFile(path.join(this.getFontsDir(jobId), fileName), bytes);
    }
    async saveFontManifest(jobId, manifest) {
        await writeJson(this.getFontManifestPath(jobId), manifest);
    }
    async saveCropImage(jobId, fileName, bytes) {
        await ensureDir(this.getCropsDir(jobId));
        await writeFile(path.join(this.getCropsDir(jobId), fileName), bytes);
    }
    async saveRegeneratedFinalPage(jobId, pageIndex, page, finalHtmlContent, cssContent) {
        const pageNumber = pageIndex + 1;
        await Promise.all([
            writeJson(this.getPageJsonPath(jobId, pageIndex), page),
            // Intermediate builds disabled for now.
            void finalHtmlContent,
            void cssContent
        ]);
    }
    async getFontManifest(jobId) {
        return readJson(this.getFontManifestPath(jobId));
    }
    async getPage(jobId, pageIndex) {
        return readJson(this.getPageJsonPath(jobId, pageIndex));
    }
    async saveOcrArtifacts(jobId, pageIndex, ocrPage, comparison) {
        const pageNumber = pageIndex + 1;
        await Promise.all([
            writeJson(path.join(this.getOcrDir(jobId), `page-${pageNumber}.ocr.json`), ocrPage),
            writeJson(path.join(this.getOcrDir(jobId), `page-${pageNumber}.compare.json`), comparison)
        ]);
    }
    async getOcrPage(jobId, pageIndex) {
        return readJson(path.join(this.getOcrDir(jobId), `page-${pageIndex + 1}.ocr.json`));
    }
    async getOcrComparison(jobId, pageIndex) {
        return readJson(path.join(this.getOcrDir(jobId), `page-${pageIndex + 1}.compare.json`));
    }
    async updatePage(jobId, pageIndex, patch) {
        const current = await this.getPage(jobId, pageIndex);
        if (!current) {
            throw new Error(`Page ${pageIndex} not found for job ${jobId}`);
        }
        const next = { ...current, ...patch };
        await writeJson(this.getPageJsonPath(jobId, pageIndex), next);
        return next;
    }
    async listPageConfidences(jobId) {
        try {
            const entries = await readdir(this.getPagesDir(jobId));
            const results = [];
            for (const entry of entries) {
                if (!entry.endsWith('.json'))
                    continue;
                const page = await readJson(path.join(this.getPagesDir(jobId), entry));
                if (page)
                    results.push({ pageIndex: page.pageIndex, confidence: page.confidence });
            }
            return results.sort((a, b) => a.pageIndex - b.pageIndex);
        }
        catch {
            return [];
        }
    }
    getDraftDir(jobId) { return path.join(this.getJobDir(jobId), "draft"); }
    getDraftPagePath(jobId, pageIndex) { return path.join(this.getDraftDir(jobId), `${pageIndex}.json`); }
    async saveDraftPage(jobId, pageIndex, state) {
        const payload = { jobId, pageIndex, ...state, updatedAt: new Date().toISOString() };
        await writeJson(this.getDraftPagePath(jobId, pageIndex), payload);
        return payload;
    }
    async getDraftPage(jobId, pageIndex) {
        return readJson(this.getDraftPagePath(jobId, pageIndex));
    }
    async listDraftPages(jobId) {
        try {
            const entries = await readdir(this.getDraftDir(jobId));
            return entries
                .filter((name) => name.endsWith(".json"))
                .map((name) => Number(name.replace(/\.json$/, "")))
                .filter((value) => Number.isFinite(value))
                .sort((a, b) => a - b);
        }
        catch {
            return [];
        }
    }
    async deleteDraftPage(jobId, pageIndex) {
        try {
            await unlink(this.getDraftPagePath(jobId, pageIndex));
        }
        catch {
            // ignore missing
        }
    }
    getJobDir(jobId) { return path.join(JOBS_ROOT, jobId); }
    getMetaPath(jobId) { return path.join(this.getJobDir(jobId), "meta.json"); }
    getPagesDir(jobId) { return path.join(this.getJobDir(jobId), "pages"); }
    getReviewDir(jobId) { return path.join(this.getJobDir(jobId), "review"); }
    getReviewStylesDir(jobId) { return path.join(this.getJobDir(jobId), "style"); }
    getFinalDir(jobId) { return path.join(this.getJobDir(jobId), "final"); }
    getStylesDir(jobId) { return path.join(this.getJobDir(jobId), "styles"); }
    getPdf2HtmlExDir(jobId) { return path.join(this.getJobDir(jobId), "pdf2htmlex"); }
    getFontsDir(jobId) { return path.join(this.getJobDir(jobId), "fonts"); }
    getCropsDir(jobId) { return path.join(this.getImagesDir(jobId), "crops"); }
    getFontManifestPath(jobId) { return path.join(this.getFontsDir(jobId), "manifest.json"); }
    getOcrDir(jobId) { return path.join(this.getJobDir(jobId), "ocr"); }
    getImagesDir(jobId) { return path.join(this.getJobDir(jobId), "images"); }
    getImagePath(jobId, pageIndex) { return path.join(this.getImagesDir(jobId), `page-${pageIndex + 1}.png`); }
    getPageJsonPath(jobId, pageIndex) { return path.join(this.getPagesDir(jobId), `${pageIndex}.json`); }
    async jobExists(jobId) {
        try {
            const meta = await stat(this.getMetaPath(jobId));
            return meta.isFile();
        }
        catch {
            return false;
        }
    }
    async deleteJob(jobId) {
        await rm(this.getJobDir(jobId), { recursive: true, force: true });
    }
    emptySummary(jobId) {
        return EMPTY_EDIT_SUMMARY(jobId);
    }
}
export const jobStore = new JobStore();
