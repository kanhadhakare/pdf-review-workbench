import { CommonModule } from "@angular/common";
import { ChangeDetectionStrategy, Component, inject, signal } from "@angular/core";
import { FormsModule } from "@angular/forms";
import { Router } from "@angular/router";
import { JobService, type JobView } from "../../services/job.service";

@Component({
  selector: "app-upload-page",
  standalone: true,
  imports: [CommonModule, FormsModule],
  template: `
    <main class="upload-page">
      <section class="upload-card">
        <div class="upload-card__eyebrow">PDF Review Workbench</div>
        <h1>Extract fixed-layout HTML from a local PDF.</h1>
        <p class="upload-card__intro">
          Upload a file or enter a trusted local path. The backend rasterizes pages, extracts text blocks,
          and opens a page-by-page review screen when processing finishes.
        </p>

        <div
          class="drop-zone"
          [class.is-active]="isDragActive()"
          (dragover)="handleDragOver($event)"
          (dragleave)="handleDragLeave($event)"
          (drop)="handleDrop($event)">
          <input #fileInput type="file" accept="application/pdf" hidden (change)="handleFileInput($event)">
          <p>{{ selectedFileName() || 'Drop a PDF here or choose a file' }}</p>
          <button type="button" class="secondary-button" (click)="fileInput.click()">Choose PDF</button>
        </div>

        <div class="path-input">
          <label for="localPath">Trusted local path</label>
          <input id="localPath" type="text" [(ngModel)]="localPath" placeholder="E:\\docs\\sample.pdf">
        </div>

        <div class="actions">
          <button type="button" class="primary-button" [disabled]="isSubmitting()" (click)="submit()">
            {{ isSubmitting() ? 'Startingâ€¦' : 'Start Extraction' }}
          </button>
          <span class="status-text" *ngIf="job() as currentJob">
            {{ formatStatus(currentJob) }}
          </span>
        </div>

        <div class="progress-shell" *ngIf="isProcessing()">
          <div class="progress-bar"></div>
        </div>

        <p class="error-text" *ngIf="errorMessage()">{{ errorMessage() }}</p>
      </section>
    </main>
  `,
  styles: [`
    .upload-page {
      min-height: 100vh;
      display: grid;
      place-items: center;
      padding: var(--space-6) var(--space-4);
    }

    .upload-card {
      width: min(760px, 100%);
      padding: var(--space-5);
      border-radius: calc(var(--radius) + 6px);
      background: linear-gradient(180deg, rgba(14, 26, 43, 0.96), rgba(11, 19, 31, 0.96));
      border: 1px solid var(--border-strong);
      box-shadow: var(--shadow);
    }

    .upload-card__eyebrow {
      color: var(--accent);
      text-transform: uppercase;
      letter-spacing: 0.18em;
      font-size: 0.74rem;
      margin-bottom: var(--space-2);
    }

    h1 {
      margin: 0;
      font-family: var(--font-display);
      font-size: clamp(2rem, 3.4vw, 3.3rem);
      line-height: 1.03;
    }

    .upload-card__intro {
      margin: var(--space-3) 0 var(--space-4);
      color: var(--text-muted);
      max-width: 62ch;
      line-height: 1.6;
    }

    .drop-zone {
      display: grid;
      gap: var(--space-3);
      place-items: center;
      padding: 52px 24px;
      border-radius: var(--radius);
      background: linear-gradient(135deg, rgba(94, 208, 255, 0.08), rgba(255, 255, 255, 0.02));
      border: 1px dashed rgba(94, 208, 255, 0.45);
      text-align: center;
      transition: border-color 120ms ease, transform 120ms ease, background 120ms ease;
    }

    .drop-zone.is-active {
      transform: translateY(-2px);
      border-color: rgba(94, 208, 255, 0.8);
      background: linear-gradient(135deg, rgba(94, 208, 255, 0.14), rgba(255, 255, 255, 0.03));
    }

    .drop-zone p {
      margin: 0;
      font-size: 1.05rem;
    }

    .path-input {
      display: grid;
      gap: var(--space-2);
      margin-top: var(--space-4);
    }

    .path-input label {
      color: var(--text-muted);
      font-size: 0.92rem;
    }

    .path-input input {
      width: 100%;
      padding: 14px 16px;
      border-radius: var(--radius-sm);
      border: 1px solid var(--border);
      background: rgba(255, 255, 255, 0.04);
      color: var(--text);
      outline: none;
    }

    .actions {
      display: flex;
      align-items: center;
      gap: var(--space-3);
      margin-top: var(--space-4);
      flex-wrap: wrap;
    }

    .primary-button,
    .secondary-button {
      padding: 13px 18px;
      border-radius: 999px;
      font-weight: 600;
    }

    .primary-button {
      background: linear-gradient(135deg, #5ed0ff, #87e2ff);
      color: #062033;
    }

    .primary-button:disabled {
      opacity: 0.65;
      cursor: not-allowed;
    }

    .secondary-button {
      background: rgba(255, 255, 255, 0.08);
      color: var(--text);
    }

    .status-text {
      color: var(--text-muted);
    }

    .progress-shell {
      margin-top: var(--space-4);
      height: 10px;
      border-radius: 999px;
      overflow: hidden;
      background: rgba(255, 255, 255, 0.05);
    }

    .progress-bar {
      width: 32%;
      height: 100%;
      border-radius: inherit;
      background: linear-gradient(90deg, rgba(94, 208, 255, 0.3), rgba(94, 208, 255, 1));
      animation: progress 1.1s linear infinite alternate;
    }

    .error-text {
      margin-top: var(--space-3);
      color: var(--danger);
    }

    @keyframes progress {
      from { transform: translateX(-10%); }
      to { transform: translateX(210%); }
    }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class UploadComponent {
  localPath = "";

  private readonly router = inject(Router);
  private readonly jobs = inject(JobService);

  readonly isDragActive = signal(false);
  readonly selectedFile = signal<File | null>(null);
  readonly isSubmitting = signal(false);
  readonly isProcessing = signal(false);
  readonly errorMessage = signal<string | null>(null);
  readonly job = signal<JobView | null>(null);

  selectedFileName(): string {
    return this.selectedFile()?.name ?? "";
  }

  handleDragOver(event: DragEvent): void {
    event.preventDefault();
    this.isDragActive.set(true);
  }

  handleDragLeave(event: DragEvent): void {
    event.preventDefault();
    this.isDragActive.set(false);
  }

  handleDrop(event: DragEvent): void {
    event.preventDefault();
    this.isDragActive.set(false);
    const file = event.dataTransfer?.files?.item(0) ?? null;
    if (file) {
      this.selectedFile.set(file);
      this.errorMessage.set(null);
    }
  }

  handleFileInput(event: Event): void {
    const input = event.target as HTMLInputElement;
    this.selectedFile.set(input.files?.item(0) ?? null);
    this.errorMessage.set(null);
  }

  submit(): void {
    const file = this.selectedFile();
    const path = this.localPath.trim();

    if (!file && !path) {
      this.errorMessage.set("Choose a PDF or enter a trusted local path.");
      return;
    }

    this.errorMessage.set(null);
    this.isSubmitting.set(true);

    this.jobs.createJob(file ?? path).subscribe({
      next: (job) => {
        this.job.set(job);
        this.isSubmitting.set(false);
        this.isProcessing.set(true);

        this.jobs.pollJob(job.id).subscribe({
          next: (polledJob) => {
            this.job.set(polledJob);
            if (polledJob.status === "done") {
              this.isProcessing.set(false);
              void this.router.navigate(["/review", polledJob.id]);
            }

            if (polledJob.status === "failed") {
              this.isProcessing.set(false);
              this.errorMessage.set(polledJob.errorMessage ?? "Extraction failed.");
            }
          },
          error: () => {
            this.isProcessing.set(false);
            this.errorMessage.set("Failed to poll job status.");
          }
        });
      },
      error: (error) => {
        this.isSubmitting.set(false);
        this.errorMessage.set(error?.error?.message ?? "Unable to create extraction job.");
      }
    });
  }

  formatStatus(job: JobView): string {
    if (job.status === "pending") {
      return "Queued";
    }

    if (job.status === "processing") {
      return `Processing${job.pageCount ? ` ${job.pageCount} pages` : ""}`;
    }

    if (job.status === "done") {
      return "Done";
    }

    if (job.status === "failed") {
      return "Failed";
    }

    return job.status;
  }
}


