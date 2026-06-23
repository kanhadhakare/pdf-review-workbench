import { type ImportedBookManifest, type SourceType } from "../types.js";

const PDF_SIGNATURE = "%PDF";
const ZIP_SIGNATURES = ["PK\u0003\u0004", "PK\u0005\u0006", "PK\u0007\u0008"];

function byteString(bytes: Uint8Array, length: number): string {
  return String.fromCharCode(...bytes.subarray(0, Math.min(bytes.length, length)));
}

export function detectSourceType(bytes: Uint8Array): SourceType {
  const signature = byteString(bytes, 4);
  if (signature === PDF_SIGNATURE) return "pdf";
  if (!ZIP_SIGNATURES.includes(signature)) {
    throw new Error("Unsupported input. Upload a PDF, fixed-layout EPUB, or extracted HTML ZIP.");
  }

  const headerText = byteString(bytes, 512);
  return headerText.includes("application/epub+zip") ? "epub" : "html-zip";
}

export function createPendingSourceManifest(
  jobId: string,
  sourceType: SourceType,
  originalFileName: string,
  timestamp = new Date().toISOString()
): ImportedBookManifest {
  return {
    version: 1,
    jobId,
    sourceType,
    layout: sourceType === "pdf" ? "fixed" : "unknown",
    status: "pending",
    originalFileName,
    pages: [],
    sharedAssets: [],
    warnings: [],
    createdAt: timestamp,
    updatedAt: timestamp
  };
}
