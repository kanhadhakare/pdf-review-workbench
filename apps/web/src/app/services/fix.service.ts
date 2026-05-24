import { HttpClient } from "@angular/common/http";
import { Injectable, inject } from "@angular/core";
import { type ExtractionProfile, type FixDelta } from "@pdf-review-workbench/shared";
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

  getProfile(fingerprint: string): Observable<{ profile: ExtractionProfile; sampleCount: number; recentConfidenceScores: Array<{ pageIndex: number; confidence: number }>; improvementDelta: number }> {
    return this.http.get<{ profile: ExtractionProfile; sampleCount: number; recentConfidenceScores: Array<{ pageIndex: number; confidence: number }>; improvementDelta: number }>(`/api/profiles/${fingerprint}`);
  }
}
