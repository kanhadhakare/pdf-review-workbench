import { HttpClient } from "@angular/common/http";
import { Injectable, inject } from "@angular/core";
import { type AccessibilityMap, type AccessibilityPageMap, type AccessibilityPageReviewStatus, type AccessibilityTag, type AccessibilityValidationReport } from "../types";
import { Observable } from "rxjs";

@Injectable({ providedIn: "root" })
export class AccessibilityService {
  private readonly http = inject(HttpClient);

  getMap(jobId: string): Observable<AccessibilityMap> {
    return this.http.get<AccessibilityMap>(`/api/jobs/${jobId}/accessibility`);
  }

  getPage(jobId: string, pageIndex: number): Observable<AccessibilityPageMap> {
    return this.http.get<AccessibilityPageMap>(`/api/jobs/${jobId}/accessibility/pages/${pageIndex}`);
  }

  savePage(jobId: string, pageIndex: number, tags: AccessibilityTag[], reviewStatus: AccessibilityPageReviewStatus): Observable<AccessibilityPageMap> {
    return this.http.put<AccessibilityPageMap>(`/api/jobs/${jobId}/accessibility/pages/${pageIndex}`, { tags, reviewStatus });
  }

  detectPage(jobId: string, pageIndex: number, replace: boolean): Observable<{ page: AccessibilityPageMap; engine: string; warnings?: string[] }> {
    return this.http.post<{ page: AccessibilityPageMap; engine: string; warnings?: string[] }>(`/api/jobs/${jobId}/accessibility/pages/${pageIndex}/detect`, { replace });
  }

  detectAll(jobId: string, replace: boolean): Observable<{ pageCount: number; taggedPages: number; engine: string; warnings?: string[] }> {
    return this.http.post<{ pageCount: number; taggedPages: number; engine: string; warnings?: string[] }>(`/api/jobs/${jobId}/accessibility/detect`, { replace });
  }

  validate(jobId: string): Observable<AccessibilityValidationReport> {
    return this.http.post<AccessibilityValidationReport>(`/api/jobs/${jobId}/accessibility/validate`, {});
  }

  exportPdf(jobId: string): Observable<{ message: string }> {
    return this.http.post<{ message: string }>(`/api/jobs/${jobId}/accessibility/export-pdf`, {});
  }
}
