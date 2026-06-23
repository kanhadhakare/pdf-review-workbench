import { HttpClient } from "@angular/common/http";
import { Injectable, inject } from "@angular/core";
import { type ArchiveImportOptions, type ExtractionJob, type ImportedBookManifest, type JobEditSummary, type JobListItem, type PageResult, type ResumeInfo, type TrainingStatus } from "../types";
import { Observable, interval, timer } from "rxjs";
import { exhaustMap, retry, shareReplay, startWith, takeWhile } from "rxjs/operators";

@Injectable({ providedIn: "root" })
export class JobService {
  private readonly http = inject(HttpClient);

  createJob(file: File | null, localPath: string | null, enableOcrValidation = false): Observable<{ job: ExtractionJob; editSummary: JobEditSummary; warning?: "large_file" }> {
    if (file) {
      const form = new FormData();
      form.append("file", file, file.name);
      void enableOcrValidation; // OCR disabled for now.
      form.append("enableOcrValidation", "false");
      return this.http.post<{ job: ExtractionJob; editSummary: JobEditSummary; warning?: "large_file" }>("/api/jobs", form);
    }
    void enableOcrValidation;
    return this.http.post<{ job: ExtractionJob; editSummary: JobEditSummary; warning?: "large_file" }>("/api/jobs", { localPath, enableOcrValidation: false });
  }

  createArchiveJob(file: File, options: ArchiveImportOptions): Observable<{ job: ExtractionJob; manifest: ImportedBookManifest; editSummary: JobEditSummary; warning?: "large_file" }> {
    const form = new FormData();
    form.append("file", file, file.name);
    form.append("options", JSON.stringify(options));
    return this.http.post<{ job: ExtractionJob; manifest: ImportedBookManifest; editSummary: JobEditSummary; warning?: "large_file" }>("/api/jobs/archive", form);
  }

  getSourceManifest(jobId: string): Observable<ImportedBookManifest> {
    return this.http.get<ImportedBookManifest>(`/api/jobs/${jobId}/source-manifest`);
  }

  pollJob(id: string): Observable<{ job: ExtractionJob & { processedPages?: number; errorMessage?: string }; editSummary: JobEditSummary }> {
    return interval(3000).pipe(
      startWith(0),
      // Do not cancel slow status requests while extraction is running in the same backend process.
      exhaustMap(() => this.http.get<{ job: ExtractionJob & { processedPages?: number; errorMessage?: string }; editSummary: JobEditSummary }>(`/api/jobs/${id}`)),
      retry({
        count: 10,
        delay: (_error, retryCount) => timer(Math.min(retryCount * 1000, 5000))
      }),
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

  listJobs(): Observable<JobListItem[]> {
    return this.http.get<JobListItem[]>("/api/jobs");
  }

  getResumeInfo(jobId: string): Observable<ResumeInfo> {
    return this.http.get<ResumeInfo>(`/api/jobs/${jobId}/resume`);
  }

  getFinalZipUrl(jobId: string): string {
    return `/api/jobs/${jobId}/final.zip`;
  }

  getReviewZipUrl(jobId: string): string {
    return `/api/jobs/${jobId}/review.zip`;
  }

  deleteJob(jobId: string): Observable<{ ok: true }> {
    return this.http.delete<{ ok: true }>(`/api/jobs/${jobId}`);
  }

  getTrainingStatus(): Observable<TrainingStatus> {
    return this.http.get<TrainingStatus>("/api/fixes/status");
  }
}

