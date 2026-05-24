import { CommonModule } from "@angular/common";
import { ChangeDetectionStrategy, Component, ElementRef, HostListener, inject, signal, viewChild } from "@angular/core";
import { ActivatedRoute, RouterLink } from "@angular/router";
import { type JobEditSummary, type PageResult } from "@pdf-review-workbench/shared";
import { FixService } from "../../services/fix.service";
import { JobService } from "../../services/job.service";
import { PageNavComponent } from "../../components/page-nav/page-nav.component";
import { SplitViewComponent } from "../../components/split-view/split-view.component";
import { FixEditorComponent } from "../../components/fix-editor/fix-editor.component";

@Component({
  selector: "app-review-page",
  standalone: true,
  imports: [CommonModule, RouterLink, PageNavComponent, SplitViewComponent, FixEditorComponent],
  templateUrl: "./review.component.html",
  styleUrl: "./review.component.scss",
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class ReviewComponent {
  private readonly route = inject(ActivatedRoute);
  private readonly jobs = inject(JobService);
  private readonly fixes = inject(FixService);
  private readonly imageViewport = viewChild<ElementRef<HTMLDivElement>>("imageViewport");
  private readonly editorViewport = viewChild<ElementRef<HTMLDivElement>>("editorViewport");
  readonly jobId = signal(this.route.snapshot.paramMap.get("jobId") ?? "");

  readonly page = signal<PageResult | null>(null);
  readonly pageIndex = signal(0);
  readonly pageCount = signal(0);
  readonly confidenceMap = signal<Record<number, number>>({});
  readonly editCountMap = signal<Record<number, number>>({});
  readonly editSummary = signal<JobEditSummary | null>(null);
  readonly loading = signal("Loading...");
  readonly pageScale = signal(1);
  readonly editMode = signal(false);
  readonly pendingSummary = signal<{ total: number; byType: Record<string, number> }>({ total: 0, byType: {} });

  constructor() {
    this.jobs.getEditSummary(this.jobId()).subscribe({
      next: ({ job, editSummary }) => {
        this.pageCount.set(job.pageCount);
        this.editSummary.set(editSummary);
        this.editCountMap.set({ ...editSummary.editsByPage });
        this.loadPage(0);
      },
      error: () => this.loading.set("Unable to load review session.")
    });
  }

  selectPage(index: number): void { this.pageIndex.set(index); this.loadPage(index); }
  previousPage(): void { if (this.pageIndex() > 0) this.selectPage(this.pageIndex() - 1); }
  nextPage(): void { if (this.pageIndex() < this.pageCount() - 1) this.selectPage(this.pageIndex() + 1); }

  @HostListener("window:keydown", ["$event"])
  onKeydown(event: KeyboardEvent): void {
    if (event.key === "ArrowLeft") this.previousPage();
    if (event.key === "ArrowRight") this.nextPage();
    if (event.key.toLowerCase() === "e") this.editMode.set(!this.editMode());
  }

  transform(): string { return `scale(${this.pageScale()})`; }
  scaledWidth(): number { return this.page() ? Math.round(this.page()!.pageWidth * this.pageScale()) : 0; }
  scaledHeight(): number { return this.page() ? Math.round(this.page()!.pageHeight * this.pageScale()) : 0; }

  updatePending(summary: { total: number; byType: Record<string, number> }): void {
    this.pendingSummary.set(summary);
  }

  handleFixesSaved(summary: JobEditSummary): void {
    this.editSummary.set(summary);
    this.editCountMap.set({ ...summary.editsByPage });
  }

  private loadPage(index: number): void {
    this.loading.set(`Loading page ${index + 1}...`);
    this.pendingSummary.set({ total: 0, byType: {} });
    this.fixes.recordVisit(this.jobId(), index).subscribe({ next: () => void 0, error: () => void 0 });
    this.jobs.getPage(this.jobId(), index).subscribe({
      next: (page) => {
        this.page.set(page);
        this.confidenceMap.update((current) => ({ ...current, [page.pageIndex]: page.confidence }));
        this.loading.set("");
        queueMicrotask(() => this.updateScale());
      },
      error: () => this.loading.set("Unable to load page.")
    });
  }

  private updateScale(): void {
    const page = this.page();
    const imageViewport = this.imageViewport()?.nativeElement;
    const editorViewport = this.editorViewport()?.nativeElement;
    if (!page || !imageViewport || !editorViewport) return;
    const widthScale = Math.min((imageViewport.clientWidth - 24) / page.pageWidth, (editorViewport.clientWidth - 24) / page.pageWidth);
    const heightScale = Math.min((imageViewport.clientHeight - 24) / page.pageHeight, (editorViewport.clientHeight - 24) / page.pageHeight);
    this.pageScale.set(Number(Math.max(0.01, Math.min(1, widthScale, heightScale)).toFixed(4)));
  }
}
