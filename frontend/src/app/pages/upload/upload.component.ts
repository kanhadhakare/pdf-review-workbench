import { CommonModule } from "@angular/common";
import { ChangeDetectionStrategy, Component, computed, inject, signal } from "@angular/core";
import { FormsModule } from "@angular/forms";
import { ActivatedRoute, Router, RouterLink } from "@angular/router";
import { JobService } from "../../services/job.service";
import { AccessibilityService } from "../../services/accessibility.service";
import { type JobWorkflow } from "../../types";

@Component({
  selector: "app-upload-page",
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink],
  templateUrl: "./upload.component.html",
  styleUrls: ["./upload.component.scss"],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class UploadComponent {
  private readonly jobs = inject(JobService);
  private readonly accessibility = inject(AccessibilityService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);

  readonly workflow = signal<JobWorkflow>(this.route.snapshot.data["workflow"] === "accessibility-tagging" ? "accessibility-tagging" : "zoning");
  readonly isTaggingUpload = computed(() => this.workflow() === "accessibility-tagging");
  readonly useLocalPath = signal(false);
  readonly localPath = signal("");
  readonly targetWidthPx = signal<number | null>(807);
  readonly selectedFile = signal<File | null>(null);
  readonly error = signal("");
  readonly status = signal("Idle");
  readonly progress = signal("0 / 0 pages extracted");
  readonly busy = signal(false);

  onFileSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    this.selectedFile.set(input.files?.[0] ?? null);
  }

  submit(): void {
    this.error.set("");
    this.busy.set(true);
    this.status.set(this.useLocalPath() ? "Loading local PDF..." : "Uploading...");
    this.jobs.createJob(this.selectedFile(), this.useLocalPath() ? this.localPath() : null, false, this.workflow(), this.targetWidthPx()).subscribe({
      next: (response) => {
        this.status.set("Extracting pages...");
        this.jobs.pollJob(response.job.id).subscribe({
          next: ({ job }) => {
            this.progress.set(`${job.processedPages ?? 0} / ${job.pageCount} pages extracted`);
            if (job.status === "done") {
              if (this.isTaggingUpload()) {
                this.status.set("Auto-detecting accessibility tags...");
                this.accessibility.detectAll(job.id, false).subscribe({
                  next: ({ taggedPages, pageCount }) => {
                    this.progress.set(`${taggedPages} / ${pageCount} pages tagged`);
                    this.status.set("Done!");
                    this.busy.set(false);
                    void this.router.navigate(["/review", job.id]);
                  },
                  error: () => {
                    this.status.set("Extraction done; auto detection failed.");
                    this.busy.set(false);
                    void this.router.navigate(["/review", job.id]);
                  }
                });
                return;
              }
              this.status.set("Done!");
              this.busy.set(false);
              void this.router.navigate(["/review", job.id]);
            }
            if (job.status === "failed") {
              this.busy.set(false);
              this.error.set((job as { errorMessage?: string }).errorMessage ?? "Extraction failed.");
            }
          },
          error: () => {
            this.busy.set(false);
            this.error.set("Unable to poll extraction status.");
          }
        });
      },
      error: (error) => {
        this.busy.set(false);
        this.error.set(error?.error?.message ?? "Unable to create job.");
      }
    });
  }

  canSubmit(): boolean {
    if (this.busy()) {
      return false;
    }

    if (this.useLocalPath()) {
      return this.localPath().trim().length > 0;
    }

    return Boolean(this.selectedFile());
  }
}

