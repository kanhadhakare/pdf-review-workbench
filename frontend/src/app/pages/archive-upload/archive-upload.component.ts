import { CommonModule } from "@angular/common";
import { ChangeDetectionStrategy, Component, inject, signal } from "@angular/core";
import { Router, RouterLink } from "@angular/router";
import { FormsModule } from "@angular/forms";
import { JobService } from "../../services/job.service";
import { type ArchiveImportOptions, type ArchiveTextHandling, type UnicodeJoinerPolicy, type UnicodeMojibakeRepairMode, type UnicodeNormalizationMode } from "../../types";

@Component({
  selector: "app-archive-upload-page",
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink],
  templateUrl: "./archive-upload.component.html",
  styleUrls: ["../upload/upload.component.scss", "./archive-upload.component.scss"],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class ArchiveUploadComponent {
  private readonly jobs = inject(JobService);
  private readonly router = inject(Router);
  readonly selectedFile = signal<File | null>(null);
  readonly busy = signal(false);
  readonly status = signal("Waiting for archive");
  readonly error = signal("");
  readonly purpose = signal<ArchiveImportOptions["purpose"]>("zoning");
  readonly pageDiscovery = signal<ArchiveImportOptions["pageDiscovery"]>("auto");
  readonly layoutMode = signal<ArchiveImportOptions["layoutMode"]>("auto");
  readonly languageMode = signal<"auto" | "manual">("auto");
  readonly language = signal("hi");
  readonly readingDirection = signal<ArchiveImportOptions["readingDirection"]>("auto");
  readonly textHandling = signal<ArchiveTextHandling>("preserve");
  readonly unicodeNormalization = signal<UnicodeNormalizationMode>("nfc");
  readonly applyLanguageMetadata = signal(true);
  readonly mojibakeRepair = signal<UnicodeMojibakeRepairMode>("off");
  readonly joinerPolicy = signal<UnicodeJoinerPolicy>("preserve");

  onFileSelected(event: Event): void {
    this.selectedFile.set((event.target as HTMLInputElement).files?.[0] ?? null);
    this.error.set("");
  }

  submit(): void {
    const file = this.selectedFile();
    if (!file || this.busy()) return;
    this.busy.set(true);
    this.error.set("");
    this.status.set("Validating and importing archive...");
    const options: ArchiveImportOptions = {
      purpose: this.purpose(),
      pageDiscovery: this.pageDiscovery(),
      layoutMode: this.layoutMode(),
      language: this.languageMode() === "auto" ? "auto" : this.language().trim(),
      readingDirection: this.readingDirection(),
      textHandling: this.textHandling(),
      unicode: {
        normalization: this.textHandling() === "preserve" ? "none" : this.unicodeNormalization(),
        applyLanguageMetadata: this.textHandling() !== "preserve" && this.applyLanguageMetadata(),
        mojibakeRepair: this.textHandling() !== "preserve" ? this.mojibakeRepair() : "off",
        joinerPolicy: this.textHandling() !== "preserve" ? this.joinerPolicy() : "preserve",
        legacyFontProfile: "off"
      }
    };
    this.jobs.createArchiveJob(file, options).subscribe({
      next: ({ job }) => {
        this.status.set("Import complete");
        this.busy.set(false);
        void this.router.navigate(["/review", job.id]);
      },
      error: (error) => {
        this.busy.set(false);
        this.status.set("Import failed");
        this.error.set(error?.error?.message ?? "Unable to import archive.");
      }
    });
  }
}
