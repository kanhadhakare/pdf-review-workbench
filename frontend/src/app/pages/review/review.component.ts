import { CommonModule } from "@angular/common";
import { ChangeDetectionStrategy, Component, ElementRef, HostListener, computed, inject, signal, viewChild } from "@angular/core";
import { ActivatedRoute, RouterLink } from "@angular/router";
import { type JobEditSummary, type PageResult } from "../../types";
import { JobService } from "../../services/job.service";
import { PageNavComponent } from "../../components/page-nav/page-nav.component";
import { FormsModule } from "@angular/forms";
import { DomSanitizer, type SafeResourceUrl } from "@angular/platform-browser";
import { FixService } from "../../services/fix.service";
import { type SemanticBox, type SemanticBoxTag } from "../../types";

@Component({
  selector: "app-review-page",
  standalone: true,
  imports: [CommonModule, RouterLink, PageNavComponent, FormsModule],
  templateUrl: "./review.component.html",
  styleUrls: ["./review.component.scss"],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class ReviewComponent {
  private readonly route = inject(ActivatedRoute);
  private readonly jobs = inject(JobService);
  private readonly fixes = inject(FixService);
  private readonly sanitizer = inject(DomSanitizer);
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
  readonly viewMode = signal<"split" | "html-only">("html-only");
  readonly htmlScale = signal(1);
  readonly draftPageMap = signal<Record<number, boolean>>({});

  readonly boxMode = signal(false);
  readonly boxes = signal<SemanticBox[]>([]);
  readonly activeTag = signal<SemanticBoxTag>("p");
  readonly drawingBox = signal<{ startX: number; startY: number; x: number; y: number; w: number; h: number } | null>(null);
  readonly savingBoxes = signal(false);
  readonly finalRefreshToken = signal(0);

  readonly reviewHtmlUrl = computed<SafeResourceUrl>(() => {
    const page = this.page();
    if (!page) return this.sanitizer.bypassSecurityTrustResourceUrl("about:blank");
    const pageNumber = page.pageIndex + 1;
    return this.sanitizer.bypassSecurityTrustResourceUrl(`/storage/jobs/${this.jobId()}/review/page-${pageNumber}.html`);
  });

  readonly finalPreviewUrl = computed<SafeResourceUrl>(() => {
    const page = this.page();
    if (!page) return this.sanitizer.bypassSecurityTrustResourceUrl("about:blank");
    const pageNumber = page.pageIndex + 1;
    const token = this.finalRefreshToken();
    return this.sanitizer.bypassSecurityTrustResourceUrl(`/storage/jobs/${this.jobId()}/final/page-${pageNumber}.html?v=${token}`);
  });

  constructor() {
    this.jobs.getResumeInfo(this.jobId()).subscribe({
      next: (resume) => {
        this.draftPageMap.set(Object.fromEntries((resume.draftPageIndices ?? []).map((index) => [index, true])));
        this.jobs.getEditSummary(this.jobId()).subscribe({
          next: (data: any) => {
            const job = data.job as any;
            const editSummary = data.editSummary as JobEditSummary;
            this.pageCount.set(job.pageCount);
            this.editSummary.set(editSummary);
            this.editCountMap.set({ ...editSummary.editsByPage });
            const resumeIndex = resume.lastVisitedPageIndex ?? (resume.draftPageIndices?.[resume.draftPageIndices.length - 1] ?? 0);
            const nextIndex = Math.max(0, Math.min(job.pageCount - 1, resumeIndex));
            this.pageIndex.set(nextIndex);
            this.loadPage(nextIndex);
          },
          error: () => this.loading.set("Unable to load review session.")
        });
      },
      error: () => {
        this.jobs.getEditSummary(this.jobId()).subscribe({
          next: (data: any) => {
            const job = data.job as any;
            const editSummary = data.editSummary as JobEditSummary;
            this.pageCount.set(job.pageCount);
            this.editSummary.set(editSummary);
            this.editCountMap.set({ ...editSummary.editsByPage });
            this.loadPage(0);
          },
          error: () => this.loading.set("Unable to load review session.")
        });
      }
    });
  }

  selectPage(index: number): void { this.pageIndex.set(index); this.loadPage(index); }
  previousPage(): void { if (this.pageIndex() > 0) this.selectPage(this.pageIndex() - 1); }
  nextPage(): void { if (this.pageIndex() < this.pageCount() - 1) this.selectPage(this.pageIndex() + 1); }

  @HostListener("window:keydown", ["$event"])
  onKeydown(event: KeyboardEvent): void {
    if (event.key === "ArrowLeft") this.previousPage();
    if (event.key === "ArrowRight") this.nextPage();
  }

  transform(): string { return `scale(${this.pageScale()})`; }
  scaledWidth(): number { return this.page() ? Math.round(this.page()!.pageWidth * this.pageScale()) : 0; }
  scaledHeight(): number { return this.page() ? Math.round(this.page()!.pageHeight * this.pageScale()) : 0; }

  updatePending(summary: { total: number; byType: Record<string, number> }): void {
    void summary;
  }

  handleFixesSaved(summary: JobEditSummary): void {
    this.editSummary.set(summary);
    this.editCountMap.set({ ...summary.editsByPage });
  }

  private loadPage(index: number): void {
    this.loading.set(`Loading page ${index + 1}...`);
    this.jobs.getResumeInfo(this.jobId()).subscribe({
      next: (resume) => this.draftPageMap.set(Object.fromEntries((resume.draftPageIndices ?? []).map((value) => [value, true]))),
      error: () => void 0
    });
    this.jobs.getPage(this.jobId(), index).subscribe({
      next: (page) => {
        this.page.set(page);
        this.confidenceMap.update((current) => ({ ...current, [page.pageIndex]: page.confidence }));
        this.loading.set("");
        this.fixes.getBoxes(this.jobId(), index).subscribe({
          next: ({ boxes }) => this.boxes.set(Array.isArray(boxes) ? boxes : []),
          error: () => this.boxes.set([])
        });
        queueMicrotask(() => this.updateScale());
      },
      error: () => this.loading.set("Unable to load page.")
    });
  }

  overlayMouseDown(event: MouseEvent): void {
    if (!this.boxMode()) return;
    const page = this.page();
    if (!page) return;
    event.preventDefault();
    const target = event.currentTarget as HTMLElement;
    const rect = target.getBoundingClientRect();
    const scale = this.pageScale();
    const x = (event.clientX - rect.left) / scale;
    const y = (event.clientY - rect.top) / scale;
    this.drawingBox.set({ startX: x, startY: y, x, y, w: 0, h: 0 });
  }

  overlayMouseMove(event: MouseEvent): void {
    const current = this.drawingBox();
    if (!current) return;
    event.preventDefault();
    const target = event.currentTarget as HTMLElement;
    const rect = target.getBoundingClientRect();
    const scale = this.pageScale();
    const x = (event.clientX - rect.left) / scale;
    const y = (event.clientY - rect.top) / scale;
    const nextX = Math.min(current.startX, x);
    const nextY = Math.min(current.startY, y);
    this.drawingBox.set({ ...current, x: nextX, y: nextY, w: Math.abs(x - current.startX), h: Math.abs(y - current.startY) });
  }

  overlayMouseUp(): void {
    const current = this.drawingBox();
    if (!current) return;
    const tag = this.activeTag();
    const box: SemanticBox = {
      id: crypto.randomUUID(),
      tag,
      x: Number(current.x.toFixed(2)),
      y: Number(current.y.toFixed(2)),
      w: Number(current.w.toFixed(2)),
      h: Number(current.h.toFixed(2)),
      createdAt: new Date().toISOString()
    };
    if (box.w > 2 && box.h > 2) {
      this.boxes.update((existing) => [...existing, box]);
    }
    this.drawingBox.set(null);
  }

  saveBoxes(): void {
    if (this.savingBoxes()) return;
    const page = this.page();
    if (!page) return;
    this.savingBoxes.set(true);
    this.fixes.saveBoxes(this.jobId(), page.pageIndex, this.boxes()).subscribe({
      next: () => {
        this.savingBoxes.set(false);
        this.finalRefreshToken.update((value) => value + 1);
      },
      error: () => this.savingBoxes.set(false)
    });
  }

  private updateScale(): void {
    const page = this.page();
    const editorViewport = this.editorViewport()?.nativeElement;
    if (!page || !editorViewport) return;

    const widthCandidates = [(editorViewport.clientWidth - 24) / page.pageWidth];
    const heightCandidates = [(editorViewport.clientHeight - 24) / page.pageHeight];

    const widthScale = Math.min(...widthCandidates);
    const heightScale = Math.min(...heightCandidates);
    this.pageScale.set(Number(Math.max(0.01, Math.min(1, widthScale, heightScale)).toFixed(4)));
    this.htmlScale.set(this.pageScale());
  }
}


