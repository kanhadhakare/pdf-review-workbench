import { HttpClient } from "@angular/common/http";
import { Injectable, inject } from "@angular/core";
import { type ArchiveZoningCssStrategy, type DraftPageState, type ExtractionProfile, type FixDelta, type SemanticBox, type SpanCorrection } from "../types";
import { Observable } from "rxjs";

@Injectable({ providedIn: "root" })
export class FixService {
  private readonly http = inject(HttpClient);

  submitFixes(jobId: string, pageIndex: number, fixes: FixDelta[]): Observable<unknown> {
    return this.http.post(`/api/jobs/${jobId}/pages/${pageIndex}/fixes`, fixes);
  }

  recordVisit(jobId: string, pageIndex: number): Observable<unknown> {
    return this.http.post(`/api/jobs/${jobId}/pages/${pageIndex}/visit`, { reviewerId: "local-reviewer" });
  }

  getSpanCorrections(jobId: string, pageIndex: number): Observable<{ corrections: SpanCorrection[] }> {
    return this.http.get<{ corrections: SpanCorrection[] }>(`/api/jobs/${jobId}/pages/${pageIndex}/span-corrections`);
  }

  saveSpanCorrection(jobId: string, pageIndex: number, correction: Omit<SpanCorrection, "id" | "createdAt" | "updatedAt"> & Partial<Pick<SpanCorrection, "id">>): Observable<{ ok: true; correctionCount: number; affectedPages: number[] }> {
    return this.http.put<{ ok: true; correctionCount: number; affectedPages: number[] }>(`/api/jobs/${jobId}/pages/${pageIndex}/span-corrections`, { correction });
  }

  getBoxes(jobId: string, pageIndex: number): Observable<{ boxes: SemanticBox[]; archiveFinalCssStrategy?: ArchiveZoningCssStrategy }> {
    return this.http.get<{ boxes: SemanticBox[]; archiveFinalCssStrategy?: ArchiveZoningCssStrategy }>(`/api/jobs/${jobId}/pages/${pageIndex}/boxes`);
  }

  saveBoxes(
    jobId: string,
    pageIndex: number,
    boxes: SemanticBox[],
    recognizeEquations = false,
    archiveFinalHtml?: string,
    archiveFinalCssStrategy?: ArchiveZoningCssStrategy
  ): Observable<{ ok: true; saved: number; boxes: SemanticBox[]; unchanged?: boolean; finalPagePath?: string; archiveFinalCssStrategy?: ArchiveZoningCssStrategy }> {
    return this.http.put<{ ok: true; saved: number; boxes: SemanticBox[]; unchanged?: boolean; finalPagePath?: string; archiveFinalCssStrategy?: ArchiveZoningCssStrategy }>(
      `/api/jobs/${jobId}/pages/${pageIndex}/boxes`,
      { boxes, recognizeEquations, archiveFinalHtml, archiveFinalCssStrategy }
    );
  }

  recognizeEquation(jobId: string, pageIndex: number, boxId: string, boxes: SemanticBox[]): Observable<{ box: SemanticBox; result: { ok: boolean; status: "ok" | "unavailable" | "failed"; latex?: string; error?: string; mathml?: string; mathmlStatus?: "ok" | "failed"; mathmlError?: string }; cropUrl?: string }> {
    return this.http.post<{ box: SemanticBox; result: { ok: boolean; status: "ok" | "unavailable" | "failed"; latex?: string; error?: string; mathml?: string; mathmlStatus?: "ok" | "failed"; mathmlError?: string }; cropUrl?: string }>(
      `/api/jobs/${jobId}/pages/${pageIndex}/boxes/${boxId}/recognize-equation`,
      { boxes }
    );
  }

  getDraft(jobId: string, pageIndex: number): Observable<DraftPageState> {
    return this.http.get<DraftPageState>(`/api/jobs/${jobId}/pages/${pageIndex}/draft`);
  }

  saveDraft(jobId: string, pageIndex: number, draft: Pick<DraftPageState, "blocks" | "pendingFixes" | "hiddenWordIds">): Observable<DraftPageState> {
    return this.http.put<DraftPageState>(`/api/jobs/${jobId}/pages/${pageIndex}/draft`, draft);
  }

  deleteDraft(jobId: string, pageIndex: number): Observable<unknown> {
    return this.http.delete(`/api/jobs/${jobId}/pages/${pageIndex}/draft`);
  }

  getProfile(fingerprint: string): Observable<{ profile: ExtractionProfile; sampleCount: number; recentConfidenceScores: Array<{ pageIndex: number; confidence: number }>; improvementDelta: number }> {
    return this.http.get<{ profile: ExtractionProfile; sampleCount: number; recentConfidenceScores: Array<{ pageIndex: number; confidence: number }>; improvementDelta: number }>(`/api/profiles/${fingerprint}`);
  }
}

