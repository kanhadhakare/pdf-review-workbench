import { HttpClient } from "@angular/common/http";
import { Injectable, inject } from "@angular/core";
import { type DraftPageState, type ExtractionProfile, type FixDelta, type SemanticBox } from "../types";
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

  getBoxes(jobId: string, pageIndex: number): Observable<{ boxes: SemanticBox[] }> {
    return this.http.get<{ boxes: SemanticBox[] }>(`/api/jobs/${jobId}/pages/${pageIndex}/boxes`);
  }

  saveBoxes(jobId: string, pageIndex: number, boxes: SemanticBox[]): Observable<{ ok: true; saved: number }> {
    return this.http.put<{ ok: true; saved: number }>(`/api/jobs/${jobId}/pages/${pageIndex}/boxes`, { boxes });
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

