import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { type FixDelta, type JobEditSummary, type PageVisit } from "../types.js";
import { fixesStorageRoot } from "../config/runtime.js";

const FIXES_ROOT = fixesStorageRoot;

async function ensureDir(dirPath: string): Promise<void> { await mkdir(dirPath, { recursive: true }); }
async function readJson<T>(filePath: string): Promise<T | null> { try { return JSON.parse(await readFile(filePath, "utf8")) as T; } catch { return null; } }

async function walk(dirPath: string): Promise<string[]> {
  try {
    const entries = await readdir(dirPath, { withFileTypes: true });
    const nested = await Promise.all(entries.map(async (entry) => {
      const full = path.join(dirPath, entry.name);
      return entry.isDirectory() ? walk(full) : [full];
    }));
    return nested.flat();
  } catch {
    return [];
  }
}

function template(jobId: string): JobEditSummary {
  return {
    jobId,
    totalEdits: 0,
    editsByPage: {},
    editsByType: { move: 0, resize: 0, "text-correct": 0, "tag-change": 0, merge: 0, delete: 0, "style-change": 0, split: 0, "create-group": 0 },
    pagesReviewed: [],
    pagesEdited: [],
    pagesAccurate: [],
    sessionsCount: 0,
    lastEditAt: null
  };
}

export async function saveFix(fix: FixDelta): Promise<void> {
  const dir = path.join(FIXES_ROOT, fix.jobId, String(fix.pageIndex));
  await ensureDir(dir);
  await writeFile(path.join(dir, `${fix.id}.json`), JSON.stringify(fix, null, 2), "utf8");
}

export async function saveVisit(visit: PageVisit): Promise<void> {
  const dir = path.join(FIXES_ROOT, visit.jobId, "visits");
  await ensureDir(dir);
  await writeFile(path.join(dir, `${visit.pageIndex}.json`), JSON.stringify(visit, null, 2), "utf8");
}

export async function getAllFixes(): Promise<FixDelta[]> {
  const files = await walk(FIXES_ROOT);
  const fixes: FixDelta[] = [];
  for (const file of files) {
    if (!file.endsWith(".json") || file.includes(`${path.sep}visits${path.sep}`)) continue;
    const parsed = await readJson<FixDelta>(file);
    if (parsed) fixes.push(parsed);
  }
  return fixes.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

export async function getFixesByJob(jobId: string): Promise<FixDelta[]> {
  const fixes = await getAllFixes();
  return fixes.filter((fix) => fix.jobId === jobId);
}

export async function getVisitsByJob(jobId: string): Promise<PageVisit[]> {
  const dir = path.join(FIXES_ROOT, jobId, "visits");
  const files = await walk(dir);
  const visits: PageVisit[] = [];
  for (const file of files) {
    const parsed = await readJson<PageVisit>(file);
    if (parsed) visits.push(parsed);
  }
  return visits.sort((a, b) => a.visitedAt.localeCompare(b.visitedAt));
}

export async function getFixCount(): Promise<number> { return (await getAllFixes()).length; }

export async function buildEditSummary(jobId: string): Promise<JobEditSummary> {
  const summary = template(jobId);
  const fixes = await getFixesByJob(jobId);
  const visits = await getVisitsByJob(jobId);
  const sessions = new Set<string>();
  for (const visit of visits) {
    if (!summary.pagesReviewed.includes(visit.pageIndex)) summary.pagesReviewed.push(visit.pageIndex);
    sessions.add(visit.reviewerId);
  }
  for (const fix of fixes) {
    summary.totalEdits += 1;
    summary.editsByPage[fix.pageIndex] = (summary.editsByPage[fix.pageIndex] ?? 0) + 1;
    summary.editsByType[fix.type] = (summary.editsByType[fix.type] ?? 0) + 1;
    if (!summary.pagesEdited.includes(fix.pageIndex)) summary.pagesEdited.push(fix.pageIndex);
    sessions.add(fix.reviewerId);
    if (!summary.lastEditAt || fix.timestamp > summary.lastEditAt) summary.lastEditAt = fix.timestamp;
  }
  summary.pagesReviewed.sort((a, b) => a - b);
  summary.pagesEdited.sort((a, b) => a - b);
  summary.pagesAccurate = summary.pagesReviewed.filter((index) => !summary.pagesEdited.includes(index));
  summary.sessionsCount = sessions.size;
  return summary;
}

export async function hasFixesForJob(jobId: string): Promise<boolean> {
  try {
    const info = await stat(path.join(FIXES_ROOT, jobId));
    return info.isDirectory();
  } catch {
    return false;
  }
}
