import { CommonModule } from "@angular/common";
import { ChangeDetectionStrategy, Component, inject, signal } from "@angular/core";
import { FormsModule } from "@angular/forms";
import { Router, RouterLink } from "@angular/router";
import { JobService } from "../../services/job.service";

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
  private readonly router = inject(Router);

  readonly useLocalPath = signal(false);
  readonly localPath = signal("");
  readonly enableOcrValidation = signal(false);
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
    this.jobs.createJob(this.selectedFile(), this.useLocalPath() ? this.localPath() : null, this.enableOcrValidation()).subscribe({
      next: (response) => {
        this.status.set("Extracting pages...");
        this.jobs.pollJob(response.job.id).subscribe({
          next: ({ job }) => {
            this.progress.set(`${job.processedPages ?? 0} / ${job.pageCount} pages extracted`);
            if (job.status === "done") {
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

