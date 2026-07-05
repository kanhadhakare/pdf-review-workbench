import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  type AccessibilityIssue,
  type AccessibilityMap,
  type AccessibilityTag,
  type AccessibilityValidationReport
} from "../types.js";
import { getAccessibilityMap } from "./accessibilityStore.js";
import { jobStore } from "./jobStore.js";

function issue(input: Omit<AccessibilityIssue, "id">): AccessibilityIssue {
  return { id: randomUUID(), ...input };
}

function sortedTags(tags: AccessibilityTag[]): AccessibilityTag[] {
  return [...tags].sort((a, b) => a.readingOrder - b.readingOrder);
}

function validateTag(tag: AccessibilityTag, issues: AccessibilityIssue[]): void {
  if (tag.bbox.w <= 1 || tag.bbox.h <= 1) {
    issues.push(issue({
      severity: "error",
      pageIndex: tag.pageIndex,
      tagId: tag.id,
      code: "invalid-bbox",
      message: `${tag.tag} has an invalid bounding box.`
    }));
  }
  if ((tag.status === "suggested" || tag.status === "needs-review") && tag.tag !== "Artifact") {
    issues.push(issue({
      severity: "warning",
      pageIndex: tag.pageIndex,
      tagId: tag.id,
      code: "unaccepted-suggestion",
      message: `${tag.tag} is not accepted by reviewer yet.`
    }));
  }
  if (tag.tag === "Figure" && !tag.altText?.trim()) {
    issues.push(issue({
      severity: "error",
      pageIndex: tag.pageIndex,
      tagId: tag.id,
      code: "figure-missing-alt",
      message: "Figure requires alt text or should be marked Artifact if decorative."
    }));
  }
  if (tag.tag === "Formula" && !tag.actualText?.trim() && !tag.formula?.latex?.trim() && !tag.formula?.mathml?.trim()) {
    issues.push(issue({
      severity: "error",
      pageIndex: tag.pageIndex,
      tagId: tag.id,
      code: "formula-missing-actual-text",
      message: "Formula requires ActualText, LaTeX, or MathML."
    }));
  }
  if (tag.tag === "Table") {
    if (!tag.table?.rowCount || !tag.table?.columnCount) {
      issues.push(issue({
        severity: "warning",
        pageIndex: tag.pageIndex,
        tagId: tag.id,
        code: "table-grid-missing",
        message: "Table should define row and column count before tagged PDF export."
      }));
    }
    if (!tag.table?.headerScope || tag.table.headerScope === "none") {
      issues.push(issue({
        severity: "warning",
        pageIndex: tag.pageIndex,
        tagId: tag.id,
        code: "table-header-scope-missing",
        message: "Table header scope should be reviewed."
      }));
    }
  }
}

function validateHeadingOrder(map: AccessibilityMap, issues: AccessibilityIssue[]): void {
  let previousLevel = 0;
  const tags = Object.values(map.pages)
    .flatMap((page) => sortedTags(page.tags))
    .filter((tag) => /^H[1-6]$/.test(tag.tag));
  for (const tag of tags) {
    const level = Number(tag.tag.slice(1));
    if (previousLevel > 0 && level > previousLevel + 1) {
      issues.push(issue({
        severity: "warning",
        pageIndex: tag.pageIndex,
        tagId: tag.id,
        code: "heading-level-skip",
        message: `${tag.tag} skips heading level after H${previousLevel}.`
      }));
    }
    previousLevel = level;
  }
}

export async function validateAccessibilityMap(jobId: string): Promise<AccessibilityValidationReport> {
  const job = await jobStore.getJob(jobId);
  if (!job) throw new Error("Job not found");
  const map = await getAccessibilityMap(jobId);
  const issues: AccessibilityIssue[] = [];

  if (!map.document.language?.trim()) {
    issues.push(issue({
      severity: "warning",
      code: "document-language-missing",
      message: "Document language is not set."
    }));
  }
  if (!map.document.title?.trim()) {
    issues.push(issue({
      severity: "warning",
      code: "document-title-missing",
      message: "Document title is not set."
    }));
  }

  for (let pageIndex = 0; pageIndex < job.pageCount; pageIndex += 1) {
    const page = map.pages[String(pageIndex)];
    if (!page || page.tags.length === 0) {
      issues.push(issue({
        severity: "error",
        pageIndex,
        code: "page-untagged",
        message: `Page ${pageIndex + 1} has no accessibility tags.`
      }));
      continue;
    }
    if (page.reviewStatus !== "reviewed") {
      issues.push(issue({
        severity: "warning",
        pageIndex,
        code: "page-not-reviewed",
        message: `Page ${pageIndex + 1} is not marked reviewed.`
      }));
    }
    for (const tag of page.tags) validateTag(tag, issues);
  }

  validateHeadingOrder(map, issues);

  const errorCount = issues.filter((item) => item.severity === "error").length;
  const warningCount = issues.filter((item) => item.severity === "warning").length;
  const report = {
    jobId,
    status: errorCount > 0 ? "fail" : warningCount > 0 ? "needs-review" : "pass",
    issueCount: issues.length,
    errorCount,
    warningCount,
    issues,
    generatedAt: new Date().toISOString()
  } satisfies AccessibilityValidationReport;
  await mkdir(path.dirname(jobStore.getAccessibilityValidationReportPath(jobId)), { recursive: true });
  await writeFile(jobStore.getAccessibilityValidationReportPath(jobId), JSON.stringify(report, null, 2), "utf8");
  return report;
}
