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

  constructor() {
    this.jobs.listJobs().subscribe({
      next: (items) => this.items.set(items ?? []),
      error: () => this.error.set("Unable to load uploaded PDFs.")
    });
  }

  iconUrl(item: JobListItem): string | null {
    return item.job.pageCount > 0 ? `/api/jobs/${item.job.id}/pages/0/image` : null;
  }
}

