import { CommonModule } from "@angular/common";
import { ChangeDetectionStrategy, Component, inject, signal } from "@angular/core";
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

  constructor() {
    this.jobs.listJobs().subscribe({
      next: (items) => this.items.set(items ?? []),
      error: () => this.error.set("Unable to load uploaded PDFs.")
    });
  }

  iconUrl(item: JobListItem): string | null {
    return item.job.pageCount > 0 ? `/api/jobs/${item.job.id}/pages/0/image` : null;
  }

  finalZipUrl(item: JobListItem): string {
    return this.jobs.getFinalZipUrl(item.job.id);
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
        this.error.set("Unable to delete PDF from server.");
        this.deletingJobId.set(null);
      }
    });
  }
}
