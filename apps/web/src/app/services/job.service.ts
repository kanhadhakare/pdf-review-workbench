import { HttpClient } from "@angular/common/http";
import { Injectable, inject } from "@angular/core";
import { type ExtractionJob, type JobEditSummary, type PageResult, type TrainingStatus } from "@pdf-review-workbench/shared";
import { Observable, interval } from "rxjs";
import { shareReplay, startWith, switchMap, takeWhile } from "rxjs/operators";

@Injectable({ providedIn: "root" })
export class JobService {
  private readonly http = inject(HttpClient);

  createJob(file: File | null, localPath: string | null): Observable<{ job: ExtractionJob; editSummary: JobEditSummary; warning?: "large_file" }> {
    if (file) {
      const form = new FormData();
      form.append("file", file, file.name);
      return this.http.post<{ job: ExtractionJob; editSummary: JobEditSummary; warning?: "large_file" }>("/api/jobs", form);
    }
    return this.http.post<{ job: ExtractionJob; editSummary: JobEditSummary; warning?: "large_file" }>("/api/jobs", { localPath });
  }

  pollJob(id: string): Observable<{ job: ExtractionJob & { processedPages?: number; errorMessage?: string }; editSummary: JobEditSummary }> {
    return interval(1500).pipe(
      startWith(0),
      switchMap(() => this.http.get<{ job: ExtractionJob & { processedPages?: number; errorMessage?: string }; editSummary: JobEditSummary }>(`/api/jobs/${id}`)),
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

  getEditSummary(jobId: string): Observable<{ job: ExtractionJob; editSummary: JobEditSummary }> {
    return this.http.get<{ job: ExtractionJob; editSummary: JobEditSummary }>(`/api/jobs/${jobId}`);
  }

  getTrainingStatus(): Observable<TrainingStatus> {
    return this.http.get<TrainingStatus>("/api/fixes/status");
  }
}
