import { HttpClient } from "@angular/common/http";
import { Injectable, inject } from "@angular/core";
import { type ExtractionJob, type PageResult } from "../types";
import { Observable, interval } from "rxjs";
import { startWith, switchMap, takeWhile } from "rxjs/operators";

export interface JobView extends ExtractionJob {
  processedPages?: number;
  errorMessage?: string;
}

@Injectable({ providedIn: "root" })
export class JobService {
  private readonly http = inject(HttpClient);

  createJob(input: File | string): Observable<JobView> {
    if (typeof input === "string") {
      return this.http.post<JobView>("/api/jobs", { path: input });
    }

    const formData = new FormData();
    formData.append("file", input, input.name);
    return this.http.post<JobView>("/api/jobs", formData);
  }

  pollJob(id: string): Observable<JobView> {
    return interval(1500).pipe(
      startWith(0),
      switchMap(() => this.http.get<JobView>(`/api/jobs/${id}`)),
      takeWhile((job) => job.status === "pending" || job.status === "processing", true)
    );
  }

  getJob(id: string): Observable<JobView> {
    return this.http.get<JobView>(`/api/jobs/${id}`);
  }

  getPage(jobId: string, pageIndex: number): Observable<PageResult> {
    return this.http.get<PageResult>(`/api/jobs/${jobId}/pages/${pageIndex}`);
  }
}


