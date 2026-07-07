import path from "node:path";
import { Buffer } from "node:buffer";
import {
  type AccessibilityMap,
  type AccessibilityTag,
  type PageResult
} from "../types.js";
import { getAccessibilityMap } from "./accessibilityStore.js";
import { jobStore, type StoredJobState } from "./jobStore.js";
import { writeTaggedPdfWithPdfBox, type PdfTagReport } from "./pdfboxPdfToolService.js";

export interface TaggedPdfExportResult {
  message: string;
  outputPath: string;
  downloadUrl: string;
  report: PdfTagReport;
}

function encodeField(value: string | undefined): string {
  return value ? Buffer.from(value, "utf8").toString("base64") : "";
}

function numeric(value: number | undefined, fallback: number): string {
  return String(Number.isFinite(value) ? value : fallback);
}

function readableTagText(tag: AccessibilityTag): string {
  if (tag.tag === "Figure") return tag.altText || tag.actualText || "";
  if (tag.tag === "Formula") return tag.actualText || tag.formula?.latex || "";
  return tag.actualText || tag.altText || "";
}

async function getPageSize(jobId: string, pageIndex: number): Promise<Pick<PageResult, "pageWidth" | "pageHeight">> {
  const page = await jobStore.getPage(jobId, pageIndex);
  return {
    pageWidth: page?.pageWidth && page.pageWidth > 0 ? page.pageWidth : 1,
    pageHeight: page?.pageHeight && page.pageHeight > 0 ? page.pageHeight : 1
  };
}

async function buildTagPlan(jobId: string, map: AccessibilityMap): Promise<{ tsv: string; plannedTags: number }> {
  const lines = [
    [
      "pageIndex",
      "readingOrder",
      "tag",
      "x",
      "y",
      "w",
      "h",
      "pageWidth",
      "pageHeight",
      "text",
      "actualText",
      "altText",
      "language",
      "formulaLatex",
      "formulaMathml",
      "status"
    ].join("\t")
  ];

  const pages = Object.values(map.pages ?? {}).sort((a, b) => a.pageIndex - b.pageIndex);
  let plannedTags = 0;
  for (const page of pages) {
    const pageSize = await getPageSize(jobId, page.pageIndex);
    const tags = [...(page.tags ?? [])].sort((a, b) => a.readingOrder - b.readingOrder);
    for (const tag of tags) {
      if (tag.tag === "Artifact") continue;
      plannedTags += 1;
      lines.push([
        String(tag.pageIndex),
        String(tag.readingOrder),
        tag.tag,
        numeric(tag.bbox?.x, 0),
        numeric(tag.bbox?.y, 0),
        numeric(tag.bbox?.w, 1),
        numeric(tag.bbox?.h, 1),
        numeric(pageSize.pageWidth, 1),
        numeric(pageSize.pageHeight, 1),
        encodeField(readableTagText(tag)),
        encodeField(tag.actualText),
        encodeField(tag.altText),
        encodeField(tag.language || map.document?.language),
        encodeField(tag.formula?.latex),
        encodeField(tag.formula?.mathml),
        encodeField(tag.status)
      ].join("\t"));
    }
  }

  return {
    tsv: `${lines.join("\n")}\n`,
    plannedTags
  };
}

function assertExportableJob(job: StoredJobState): void {
  if (job.sourceType && job.sourceType !== "pdf") {
    throw new Error("Tagged PDF export is only available for PDF source jobs.");
  }
  if (!job.filePath || !job.filePath.toLowerCase().endsWith(".pdf")) {
    throw new Error("Tagged PDF export requires the original source PDF.");
  }
}

export async function exportTaggedPdf(job: StoredJobState): Promise<TaggedPdfExportResult> {
  assertExportableJob(job);
  const map = await getAccessibilityMap(job.id);
  const { tsv, plannedTags } = await buildTagPlan(job.id, map);
  if (plannedTags === 0) {
    throw new Error("No accessibility tags found. Auto-detect or create tags before exporting.");
  }

  const outputPath = path.join(jobStore.getAccessibilityDir(job.id), "tagged.pdf");
  const report = await writeTaggedPdfWithPdfBox(job.id, job.filePath, tsv, outputPath);
  const downloadUrl = `/storage/jobs/${encodeURIComponent(job.id)}/accessibility/tagged.pdf`;
  return {
    message: `Tagged PDF exported with ${report.writtenTags} semantic tag(s): ${downloadUrl}`,
    outputPath,
    downloadUrl,
    report
  };
}
