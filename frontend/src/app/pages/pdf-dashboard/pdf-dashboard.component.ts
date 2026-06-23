import { CommonModule } from "@angular/common";
import { ChangeDetectionStrategy, Component, computed, inject, signal } from "@angular/core";
import { RouterLink } from "@angular/router";
import { JobService } from "../../services/job.service";
import { type JobListItem } from "../../types";

@Component({
  selector: "app-pdf-dashboard-page",
  standalone: true,
  imports: [CommonModule, RouterLink],
  templateUrl: "./pdf-dashboard.component.html",
  styleUrls: ["./pdf-dashboard.component.scss"],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class PdfDashboardComponent {
  private readonly jobs = inject(JobService);
  readonly items = signal<JobListItem[]>([]);
  readonly error = signal("");
  readonly deletingJobId = signal<string | null>(null);
  readonly filter = signal<"all" | "pdf" | "archive">("all");
  readonly filteredItems = computed(() => this.items().filter((item) => {
    if (this.filter() === "all") return true;
    const isArchive = item.job.sourceType === "epub" || item.job.sourceType === "html-zip";
    return this.filter() === "archive" ? isArchive : !isArchive;
  }));
  readonly pdfCount = computed(() => this.items().filter((item) => item.job.sourceType !== "epub" && item.job.sourceType !== "html-zip").length);
  readonly archiveCount = computed(() => this.items().length - this.pdfCount());

  constructor() {
    this.jobs.listJobs().subscribe({
      next: (items) => this.items.set(items ?? []),
      error: () => this.error.set("Unable to load uploaded books.")
    });
  }

  iconUrl(item: JobListItem): string | null {
    return item.job.sourceType !== "epub" && item.job.sourceType !== "html-zip" && item.job.pageCount > 0
      ? `/api/jobs/${item.job.id}/pages/0/image`
      : null;
  }

  openRoute(item: JobListItem): string[] {
    return ["/review", item.job.id];
  }

  isArchive(item: JobListItem): boolean {
    return item.job.sourceType === "epub" || item.job.sourceType === "html-zip";
  }

  canDownloadBuilds(item: JobListItem): boolean {
    return item.job.status === "done";
  }

  openLabel(item: JobListItem): string {
    return item.job.sourceType === "epub" || item.job.sourceType === "html-zip" ? "Open zoning" : "Open review";
  }

  sourceLabel(item: JobListItem): string {
    if (item.job.sourceType === "epub") return "EPUB";
    if (item.job.sourceType === "html-zip") return "HTML ZIP";
    return "PDF";
  }

  finalZipUrl(item: JobListItem): string {
    return `${this.jobs.getFinalZipUrl(item.job.id)}?v=${Date.now()}`;
  }

  reviewZipUrl(item: JobListItem): string {
    return `${this.jobs.getReviewZipUrl(item.job.id)}?v=${Date.now()}`;
  }

  deleteBook(item: JobListItem): void {
    const confirmed = window.confirm(`Delete "${item.job.originalFileName}" from the server? This removes the extracted pages, final build, and review data for this upload.`);
    if (!confirmed) return;
    this.deletingJobId.set(item.job.id);
    this.jobs.deleteJob(item.job.id).subscribe({
      next: () => {
        this.items.update((items) => items.filter((current) => current.job.id !== item.job.id));
        this.deletingJobId.set(null);
      },
      error: () => {
        this.error.set("Unable to delete book from server.");
        this.deletingJobId.set(null);
      }
    });
  }
}
