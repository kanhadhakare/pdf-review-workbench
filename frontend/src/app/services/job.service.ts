import { HttpClient } from "@angular/common/http";
import { Injectable, inject } from "@angular/core";
import { type ExtractionJob, type JobEditSummary, type JobListItem, type OcrComparisonResult, type OcrPageResult, type PageResult, type ResumeInfo, type TrainingStatus } from "../types";
import { Observable, interval } from "rxjs";
import { exhaustMap, shareReplay, startWith, takeWhile } from "rxjs/operators";

@Injectable({ providedIn: "root" })
export class JobService {
  private readonly http = inject(HttpClient);

  createJob(file: File | null, localPath: string | null, enableOcrValidation = false): Observable<{ job: ExtractionJob; editSummary: JobEditSummary; warning?: "large_file" }> {
    if (file) {
      const form = new FormData();
      form.append("file", file, file.name);
      form.append("enableOcrValidation", String(enableOcrValidation));
      return this.http.post<{ job: ExtractionJob; editSummary: JobEditSummary; warning?: "large_file" }>("/api/jobs", form);
    }
    return this.http.post<{ job: ExtractionJob; editSummary: JobEditSummary; warning?: "large_file" }>("/api/jobs", { localPath, enableOcrValidation });
  }

  pollJob(id: string): Observable<{ job: ExtractionJob & { processedPages?: number; errorMessage?: string }; editSummary: JobEditSummary }> {
    return interval(3000).pipe(
      startWith(0),
      // Do not cancel slow status requests while extraction is running in the same backend process.
      exhaustMap(() => this.http.get<{ job: ExtractionJob & { processedPages?: number; errorMessage?: string }; editSummary: JobEditSummary }>(`/api/jobs/${id}`)),
      takeWhile((response) => response.job.status === "pending" || response.job.status === "processing", true),
      shareReplay({ bufferSize: 1, refCount: true })
    );
  }

  getPage(jobId: string, pageIndex: number): Observable<PageResult> {
    return this.http.get<PageResult>(`/api/jobs/${jobId}/pages/${pageIndex}`);
  }

  getImageUrl(jobId: string, pageIndex: number): string {
    return `/api/jobs/${jobId}/pages/${pageIndex}/image`;
  }

  getOcrPage(jobId: string, pageIndex: number): Observable<OcrPageResult> {
    return this.http.get<OcrPageResult>(`/api/jobs/${jobId}/pages/${pageIndex}/ocr`);
  }

  getOcrComparison(jobId: string, pageIndex: number): Observable<OcrComparisonResult> {
    return this.http.get<OcrComparisonResult>(`/api/jobs/${jobId}/pages/${pageIndex}/ocr-compare`);
  }

  getEditSummary(jobId: string): Observable<{ job: ExtractionJob; editSummary: JobEditSummary }> {
    return this.http.get<{ job: ExtractionJob; editSummary: JobEditSummary }>(`/api/jobs/${jobId}`);
  }

  listJobs(): Observable<JobListItem[]> {
    return this.http.get<JobListItem[]>("/api/jobs");
  }

  getResumeInfo(jobId: string): Observable<ResumeInfo> {
    return this.http.get<ResumeInfo>(`/api/jobs/${jobId}/resume`);
  }

  getTrainingStatus(): Observable<TrainingStatus> {
    return this.http.get<TrainingStatus>("/api/fixes/status");
  }
}

