import { CommonModule } from "@angular/common";
import { ChangeDetectionStrategy, Component, inject, signal } from "@angular/core";
import { ActivatedRoute, RouterLink } from "@angular/router";
import { JobService } from "../../services/job.service";
import { type ImportedBookManifest, type ImportedPageManifest } from "../../types";

@Component({
  selector: "app-archive-book-page",
  standalone: true,
  imports: [CommonModule, RouterLink],
  templateUrl: "./archive-book.component.html",
  styleUrls: ["../pdf-dashboard/pdf-dashboard.component.scss", "./archive-book.component.scss"],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class ArchiveBookComponent {
  private readonly route = inject(ActivatedRoute);
  private readonly jobs = inject(JobService);
  readonly manifest = signal<ImportedBookManifest | null>(null);
  readonly error = signal("");
  readonly jobId = this.route.snapshot.paramMap.get("jobId") ?? "";

  constructor() {
    this.jobs.getSourceManifest(this.jobId).subscribe({
      next: (manifest) => this.manifest.set(manifest),
      error: () => this.error.set("Unable to load imported archive manifest.")
    });
  }

  pageUrl(page: ImportedPageManifest): string {
    const root = this.manifest()?.reviewRoot ?? "source";
    const encodedPath = page.reviewPath.split("/").map((segment) => encodeURIComponent(segment)).join("/");
    return `/storage/jobs/${encodeURIComponent(this.jobId)}/imported/${encodeURIComponent(root)}/${encodedPath}`;
  }

  unicodeReportUrl(): string {
    return `/storage/jobs/${encodeURIComponent(this.jobId)}/imported/unicode-report.json`;
  }
}
