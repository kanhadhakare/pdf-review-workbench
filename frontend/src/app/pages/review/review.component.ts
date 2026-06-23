import { CommonModule } from "@angular/common";
import { ChangeDetectionStrategy, Component, ElementRef, HostListener, computed, inject, signal, viewChild } from "@angular/core";
import { ActivatedRoute, Router, RouterLink } from "@angular/router";
import { type ArchiveZoningCssStrategy, type ImportedBookManifest, type JobEditSummary, type PageResult, type SourceType, type SpanCorrectionScope } from "../../types";
import { JobService } from "../../services/job.service";
import { PageNavComponent } from "../../components/page-nav/page-nav.component";
import { FormsModule } from "@angular/forms";
import { DomSanitizer, type SafeResourceUrl } from "@angular/platform-browser";
import { FixService } from "../../services/fix.service";
import { type SemanticBox, type SemanticBoxTag } from "../../types";
import { firstValueFrom } from "rxjs";

type ResizeHandle = "nw" | "ne" | "sw" | "se";

type BoxInteraction =
  | { type: "move"; boxId: string; startClientX: number; startClientY: number; original: SemanticBox }
  | { type: "resize"; boxId: string; handle: ResizeHandle; startClientX: number; startClientY: number; original: SemanticBox }
  | { type: "table-grid"; boxId: string; axis: "column" | "row"; lineIndex: number; startClientX: number; startClientY: number; original: SemanticBox };

type SelectedReviewSpan = {
  pageIndex: number;
  wordIndex: number;
  cssClassName: string;
  text: string;
  fontFamily: string;
  fontSizePx: number;
  fontWeight: string;
  fontStyle: string;
  originalTopPx: number;
  originalLeftPx: number;
  originalLetterSpacingPx: number;
};

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
  private readonly router = inject(Router);
  private readonly jobs = inject(JobService);
  private readonly fixes = inject(FixService);
  private readonly sanitizer = inject(DomSanitizer);
  private readonly editorViewport = viewChild<ElementRef<HTMLDivElement>>("editorViewport");
  private readonly reviewIframe = viewChild<ElementRef<HTMLIFrameElement>>("reviewIframe");
  readonly jobId = signal(this.route.snapshot.paramMap.get("jobId") ?? "");

  readonly page = signal<PageResult | null>(null);
  readonly pageIndex = signal(0);
  readonly pageCount = signal(0);
  readonly sourceType = signal<SourceType>("pdf");
  readonly archiveManifest = signal<ImportedBookManifest | null>(null);
  readonly isArchiveSource = computed(() => this.sourceType() === "epub" || this.sourceType() === "html-zip");
  readonly showArchiveZoningNotice = signal(false);
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
  readonly archiveFinalCssStrategy = signal<ArchiveZoningCssStrategy>("factor-common-css");
  readonly drawingBox = signal<{ startX: number; startY: number; x: number; y: number; w: number; h: number } | null>(null);
  readonly selectedBoxId = signal<string | null>(null);
  readonly boxInteraction = signal<BoxInteraction | null>(null);
  readonly boxesDirty = signal(false);
  readonly hasBoxChanges = computed(() => this.boxSignature(this.boxes()) !== this.savedBoxesSignature);
  readonly hasZoningOutputChanges = computed(() => this.hasBoxChanges() || (this.isArchiveSource() && this.archiveFinalCssStrategy() !== this.savedArchiveFinalCssStrategy));
  readonly savingBoxes = signal(false);
  readonly recognizingEquation = signal(false);
  readonly equationMessage = signal("");
  readonly blockingMessage = signal("");
  readonly finalRefreshToken = signal(0);
  readonly reviewRefreshToken = signal(0);
  readonly showFinalPane = signal(false);
  readonly showPageNav = signal(true);
  readonly showStatsPopup = signal(false);
  readonly showCorrectionPopup = signal(false);
  readonly selectedReviewSpan = signal<SelectedReviewSpan | null>(null);
  readonly correctionScope = signal<SpanCorrectionScope>("page-font-size");
  readonly correctionClassName = signal("");
  readonly correctionTopDelta = signal(0);
  readonly correctionLeftDelta = signal(0);
  readonly correctionLetterSpacing = signal(0);
  readonly correctionMessage = signal("");
  readonly savingCorrection = signal(false);
  readonly correctionDrawerOffset = signal({ x: 0, y: 0 });
  private selectedReviewElement: HTMLElement | null = null;
  private savedBoxesSignature = "[]";
  private savedArchiveFinalCssStrategy: ArchiveZoningCssStrategy = "factor-common-css";
  private archiveFinalPreparedPageIndex = -1;
  private correctionDrawerDrag: { startClientX: number; startClientY: number; startOffsetX: number; startOffsetY: number } | null = null;
  readonly selectedEquationBox = computed(() => {
    const selectedBoxId = this.selectedBoxId();
    return selectedBoxId ? this.boxes().find((box) => box.id === selectedBoxId && box.tag === "equation") ?? null : null;
  });
  readonly selectedTableBox = computed(() => {
    const selectedBoxId = this.selectedBoxId();
    return selectedBoxId ? this.boxes().find((box) => box.id === selectedBoxId && box.tag === "table") ?? null : null;
  });
  readonly selectedTableMode = computed<"crop" | "semantic">(() => this.selectedTableBox()?.table?.outputMode ?? "crop");

  readonly reviewHtmlUrl = computed<SafeResourceUrl>(() => {
    const page = this.page();
    if (!page) return this.sanitizer.bypassSecurityTrustResourceUrl("about:blank");
    if (this.isArchiveSource()) {
      return this.sanitizer.bypassSecurityTrustResourceUrl(this.importedPageUrl(page.pageIndex));
    }
    const pageNumber = page.pageIndex + 1;
    const token = this.reviewRefreshToken();
    return this.sanitizer.bypassSecurityTrustResourceUrl(`/storage/jobs/${this.jobId()}/review/page-${pageNumber}.html?v=${token}`);
  });

  readonly finalPreviewUrl = computed<SafeResourceUrl>(() => {
    const page = this.page();
    if (!page) return this.sanitizer.bypassSecurityTrustResourceUrl("about:blank");
    const token = this.finalRefreshToken();
    return this.sanitizer.bypassSecurityTrustResourceUrl(`${this.finalPageUrl(page.pageIndex)}?v=${token}`);
  });
 
  constructor() {
    this.jobs.getResumeInfo(this.jobId()).subscribe({
      next: (resume) => {
        this.draftPageMap.set(Object.fromEntries((resume.draftPageIndices ?? []).map((index) => [index, true])));
        const resumeIndex = resume.lastVisitedPageIndex ?? (resume.draftPageIndices?.[resume.draftPageIndices.length - 1] ?? 0);
        this.initializeSession(resumeIndex);
      },
      error: () => this.initializeSession(0)
    });
  }

  private initializeSession(resumeIndex: number): void {
    this.jobs.getEditSummary(this.jobId()).subscribe({
      next: ({ job, editSummary }) => {
        this.sourceType.set(job.sourceType ?? "pdf");
        this.editSummary.set(editSummary);
        this.editCountMap.set({ ...editSummary.editsByPage });
        if (!this.isArchiveSource()) {
          this.openInitialPage(job.pageCount, resumeIndex);
          return;
        }
        this.jobs.getSourceManifest(this.jobId()).subscribe({
          next: (manifest) => {
            this.archiveManifest.set(manifest);
            this.showArchiveZoningNotice.set(true);
            this.boxMode.set(true);
            this.openInitialPage(manifest.pages.length, resumeIndex);
          },
          error: () => this.loading.set("Unable to load imported XHTML pages.")
        });
      },
      error: () => this.loading.set("Unable to load review session.")
    });
  }

  private openInitialPage(pageCount: number, resumeIndex: number): void {
    this.pageCount.set(pageCount);
    const nextIndex = this.initialPageIndex(pageCount, resumeIndex);
    this.pageIndex.set(nextIndex);
    this.replacePageQueryParam(nextIndex);
    this.loadPage(nextIndex);
  }

  selectPage(index: number): void { void this.navigateToPage(index); }
  previousPage(): void { if (this.pageIndex() > 0) void this.navigateToPage(this.pageIndex() - 1); }
  nextPage(): void { if (this.pageIndex() < this.pageCount() - 1) void this.navigateToPage(this.pageIndex() + 1); }

  @HostListener("window:keydown", ["$event"])
  onKeydown(event: KeyboardEvent): void {
    if (this.blockingMessage()) {
      event.preventDefault();
      return;
    }
    if (this.isEditableEventTarget(event.target)) return;

    const selectedBoxId = this.selectedBoxId();
    if (this.boxMode() && selectedBoxId) {
      if (event.key === "Backspace" || event.key === "Delete") {
        event.preventDefault();
        this.deleteBox(selectedBoxId);
        return;
      }

      const step = event.shiftKey ? 10 : 1;
      const movement: Record<string, { x: number; y: number }> = {
        ArrowLeft: { x: -step, y: 0 },
        ArrowRight: { x: step, y: 0 },
        ArrowUp: { x: 0, y: -step },
        ArrowDown: { x: 0, y: step }
      };
      const delta = movement[event.key];
      if (delta) {
        event.preventDefault();
        this.moveSelectedBox(delta.x, delta.y);
        return;
      }
    }

    if (event.key === "ArrowLeft") this.previousPage();
    if (event.key === "ArrowRight") this.nextPage();
  }

  @HostListener("window:mousemove", ["$event"])
  onWindowMouseMove(event: MouseEvent): void {
    if (this.correctionDrawerDrag) {
      event.preventDefault();
      const dx = event.clientX - this.correctionDrawerDrag.startClientX;
      const dy = event.clientY - this.correctionDrawerDrag.startClientY;
      this.correctionDrawerOffset.set({
        x: this.correctionDrawerDrag.startOffsetX + dx,
        y: this.correctionDrawerDrag.startOffsetY + dy
      });
      return;
    }

    const interaction = this.boxInteraction();
    if (!interaction) return;
    event.preventDefault();
    const scale = this.pageScale();
    const dx = (event.clientX - interaction.startClientX) / scale;
    const dy = (event.clientY - interaction.startClientY) / scale;
    const nextBox =
      interaction.type === "move"
        ? this.clampBox({ ...interaction.original, x: interaction.original.x + dx, y: interaction.original.y + dy })
        : interaction.type === "resize"
          ? this.resizeBox(interaction.original, interaction.handle, dx, dy)
          : this.moveTableGridLine(interaction.original, interaction.axis, interaction.lineIndex, dx, dy);
    this.updateBox(interaction.boxId, nextBox);
  }

  @HostListener("window:mouseup")
  onWindowMouseUp(): void {
    if (this.drawingBox()) this.finishDrawingBox();
    this.boxInteraction.set(null);
    this.correctionDrawerDrag = null;
  }

  transform(): string { return `scale(${this.pageScale()})`; }
  scaledWidth(): number { return this.page() ? Math.round(this.page()!.pageWidth * this.pageScale()) : 0; }
  scaledHeight(): number { return this.page() ? Math.round(this.page()!.pageHeight * this.pageScale()) : 0; }
  reviewZipUrl(): string { return `${this.jobs.getReviewZipUrl(this.jobId())}?v=${Date.now()}`; }
  finalZipUrl(): string { return `${this.jobs.getFinalZipUrl(this.jobId())}?v=${Date.now()}`; }

  updatePending(summary: { total: number; byType: Record<string, number> }): void {
    void summary;
  }

  openFinalOutput(): void {
    const page = this.page();
    if (!page || this.blockingMessage()) return;
    this.finalRefreshToken.update((value) => value + 1);
    window.open(`${this.finalPageUrl(page.pageIndex)}?v=${Date.now()}`, "_blank", "noopener,noreferrer");
  }

  onReviewIframeLoad(event: Event): void {
    const iframe = event.target as HTMLIFrameElement;
    const frameDocument = iframe.contentDocument;
    const frameWindow = iframe.contentWindow;
    if (!frameDocument || !frameWindow) return;
    frameDocument.addEventListener("click", (clickEvent) => {
      if (this.blockingMessage()) return;
      const target = clickEvent.target as Element | null;
      if (!target || typeof target.closest !== "function") return;
      const wordElement = target.closest(".page__word");
      if (!wordElement) return;
      clickEvent.preventDefault();
      clickEvent.stopPropagation();
      this.selectReviewSpan(wordElement as unknown as HTMLElement, iframe);
    });
    this.maybePrepareArchiveFinalPage();
  }

  applySpanCorrection(): void {
    const span = this.selectedReviewSpan();
    const page = this.page();
    const className = this.normalizedCorrectionClassName();
    if ((!span && !className) || !page || this.savingCorrection() || this.blockingMessage()) return;
    const classMatch = className.match(/^page(\d+)__word(\d+)$/);
    const targetPageIndex = span?.pageIndex ?? (classMatch ? Number(classMatch[1]) - 1 : page.pageIndex);
    const targetWordIndex = span?.wordIndex ?? (classMatch ? Number(classMatch[2]) : -1);
    this.savingCorrection.set(true);
    this.correctionMessage.set("Applying span correction...");
    this.fixes.saveSpanCorrection(this.jobId(), page.pageIndex, {
      scope: className && !span ? "span" : this.correctionScope(),
      pageIndex: targetPageIndex,
      wordIndex: targetWordIndex,
      cssClassName: className || span?.cssClassName,
      fontFamily: span?.fontFamily ?? "",
      fontSizePx: span?.fontSizePx ?? 0,
      fontWeight: span?.fontWeight ?? "normal",
      fontStyle: span?.fontStyle ?? "normal",
      topDeltaPx: Number(this.correctionTopDelta()) || 0,
      leftDeltaPx: Number(this.correctionLeftDelta()) || 0,
      letterSpacingPx: Number(this.correctionLetterSpacing()) || 0
    }).subscribe({
      next: () => {
        this.reviewRefreshToken.update((value) => value + 1);
        this.finalRefreshToken.update((value) => value + 1);
        this.correctionMessage.set("Correction applied.");
        this.savingCorrection.set(false);
        this.showCorrectionPopup.set(false);
      },
      error: (error) => {
        this.correctionMessage.set(error?.error?.message ?? error?.message ?? "Unable to apply correction.");
        this.savingCorrection.set(false);
      }
    });
  }

  updateCorrectionTopDelta(value: number): void {
    this.correctionTopDelta.set(Number(value) || 0);
    this.previewSelectedSpanCorrection();
  }

  updateCorrectionLeftDelta(value: number): void {
    this.correctionLeftDelta.set(Number(value) || 0);
    this.previewSelectedSpanCorrection();
  }

  updateCorrectionLetterSpacing(value: number): void {
    this.correctionLetterSpacing.set(Number(value) || 0);
    this.previewSelectedSpanCorrection();
  }

  openCorrectionPopup(): void {
    if (!this.selectedReviewSpan()) this.resetCorrectionInputs();
    this.showCorrectionPopup.set(true);
  }

  closeCorrectionPopup(): void {
    if (this.savingCorrection()) return;
    this.showCorrectionPopup.set(false);
  }

  startCorrectionDrawerDrag(event: MouseEvent): void {
    if (this.savingCorrection()) return;
    event.preventDefault();
    event.stopPropagation();
    const offset = this.correctionDrawerOffset();
    this.correctionDrawerDrag = {
      startClientX: event.clientX,
      startClientY: event.clientY,
      startOffsetX: offset.x,
      startOffsetY: offset.y
    };
  }

  handleFixesSaved(summary: JobEditSummary): void {
    this.editSummary.set(summary);
    this.editCountMap.set({ ...summary.editsByPage });
  }

  private loadPage(index: number): void {
    this.loading.set(`Loading page ${index + 1}...`);
    this.selectedBoxId.set(null);
    this.selectedReviewSpan.set(null);
    this.correctionClassName.set("");
    this.resetCorrectionInputs();
    this.clearSelectedReviewElement();
    this.boxInteraction.set(null);
    this.drawingBox.set(null);
    this.equationMessage.set("");
    this.archiveFinalPreparedPageIndex = -1;
    this.jobs.getResumeInfo(this.jobId()).subscribe({
      next: (resume) => this.draftPageMap.set(Object.fromEntries((resume.draftPageIndices ?? []).map((value) => [value, true]))),
      error: () => void 0
    });
    if (this.isArchiveSource()) {
      const archivePage = this.archiveManifest()?.pages[index];
      if (!archivePage) {
        this.loading.set("Unable to load imported XHTML page.");
        return;
      }
      this.applyLoadedPage({
        pageIndex: index,
        imageUrl: "",
        htmlContent: "",
        blocks: [],
        confidence: 1,
        pageWidth: Math.max(1, Math.round(archivePage.width || 1200)),
        pageHeight: Math.max(1, Math.round(archivePage.height || 1600)),
        leftMarginPx: 0,
        reviewStatus: "unvisited"
      });
      return;
    }
    this.jobs.getPage(this.jobId(), index).subscribe({
      next: (page) => this.applyLoadedPage(page),
      error: () => this.loading.set("Unable to load page.")
    });
  }

  private applyLoadedPage(page: PageResult): void {
    this.page.set(page);
    this.confidenceMap.update((current) => ({ ...current, [page.pageIndex]: page.confidence }));
    this.loading.set("");
    this.fixes.getBoxes(this.jobId(), page.pageIndex).subscribe({
      next: ({ boxes, archiveFinalCssStrategy }) => {
        const loadedBoxes = Array.isArray(boxes) ? this.normalizeBoxOrder(boxes) : [];
        const loadedStrategy = archiveFinalCssStrategy ?? "factor-common-css";
        this.boxes.set(loadedBoxes);
        this.archiveFinalCssStrategy.set(loadedStrategy);
        this.savedBoxesSignature = this.boxSignature(loadedBoxes);
        this.savedArchiveFinalCssStrategy = loadedStrategy;
        this.boxesDirty.set(false);
        if (this.isArchiveSource()) {
          this.showFinalPane.set(false);
          this.maybePrepareArchiveFinalPage();
        }
      },
      error: () => {
        this.boxes.set([]);
        this.archiveFinalCssStrategy.set("factor-common-css");
        this.savedBoxesSignature = "[]";
        this.savedArchiveFinalCssStrategy = "factor-common-css";
        this.boxesDirty.set(false);
      }
    });
    queueMicrotask(() => this.updateScale());
  }

  private async navigateToPage(index: number): Promise<void> {
    if (this.blockingMessage()) return;
    const nextIndex = Math.max(0, Math.min(this.pageCount() - 1, index));
    if (nextIndex === this.pageIndex()) return;
    const saved = await this.saveCurrentBoxes("Saving page and reading equations before navigation...");
    if (!saved) return;
    this.pageIndex.set(nextIndex);
    this.replacePageQueryParam(nextIndex);
    this.loadPage(nextIndex);
  }

  private initialPageIndex(pageCount: number, fallbackIndex: number): number {
    const pageParam = Number(this.route.snapshot.queryParamMap.get("page"));
    const requestedIndex = Number.isFinite(pageParam) && pageParam > 0 ? Math.floor(pageParam) - 1 : fallbackIndex;
    return Math.max(0, Math.min(Math.max(0, pageCount - 1), requestedIndex));
  }

  private replacePageQueryParam(index: number): void {
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { page: index + 1 },
      queryParamsHandling: "merge",
      replaceUrl: true
    });
  }

  private finalPageUrl(pageIndex: number): string {
    if (this.isArchiveSource()) return this.archiveFinalPageUrl(pageIndex);
    return `/storage/jobs/${this.jobId()}/final/page-${pageIndex + 1}.xhtml`;
  }

  private importedPageUrl(pageIndex: number): string {
    const manifest = this.archiveManifest();
    const archivePage = manifest?.pages[pageIndex];
    if (!archivePage) return "about:blank";
    const root = manifest?.reviewRoot ?? "source";
    const encodedPath = archivePage.reviewPath.split("/").map((segment) => encodeURIComponent(segment)).join("/");
    return `/storage/jobs/${encodeURIComponent(this.jobId())}/imported/${encodeURIComponent(root)}/${encodedPath}`;
  }

  private archiveFinalPageUrl(pageIndex: number): string {
    const archivePage = this.archiveManifest()?.pages[pageIndex];
    if (!archivePage) return "about:blank";
    const encodedPath = archivePage.reviewPath.split("/").map((segment) => encodeURIComponent(segment)).join("/");
    return `/storage/jobs/${encodeURIComponent(this.jobId())}/final/source/${encodedPath}`;
  }

  overlayMouseDown(event: MouseEvent): void {
    if (!this.boxMode() || this.blockingMessage()) return;
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

  overlayMouseUp(event: MouseEvent): void {
    event.preventDefault();
    this.finishDrawingBox();
  }

  boxMouseDown(event: MouseEvent, box: SemanticBox): void {
    if (!this.boxMode()) return;
    event.preventDefault();
    event.stopPropagation();
    this.selectedBoxId.set(box.id);
    this.boxInteraction.set({ type: "move", boxId: box.id, startClientX: event.clientX, startClientY: event.clientY, original: { ...box } });
  }

  resizeMouseDown(event: MouseEvent, box: SemanticBox, handle: ResizeHandle): void {
    if (!this.boxMode()) return;
    event.preventDefault();
    event.stopPropagation();
    this.selectedBoxId.set(box.id);
    this.boxInteraction.set({ type: "resize", boxId: box.id, handle, startClientX: event.clientX, startClientY: event.clientY, original: { ...box } });
  }

  tableGridMouseDown(event: MouseEvent, box: SemanticBox, axis: "column" | "row", lineIndex: number): void {
    if (!this.boxMode() || box.tag !== "table") return;
    event.preventDefault();
    event.stopPropagation();
    this.selectedBoxId.set(box.id);
    this.boxInteraction.set({ type: "table-grid", boxId: box.id, axis, lineIndex, startClientX: event.clientX, startClientY: event.clientY, original: { ...box } });
  }

  deleteBox(boxId: string): void {
    this.boxes.update((existing) => this.normalizeBoxOrder(existing.filter((box) => box.id !== boxId)));
    this.boxesDirty.set(true);
    if (this.selectedBoxId() === boxId) this.selectedBoxId.set(null);
    const interaction = this.boxInteraction();
    if (interaction?.boxId === boxId) this.boxInteraction.set(null);
  }

  deleteSelectedBox(): void {
    const selectedBoxId = this.selectedBoxId();
    if (!selectedBoxId) return;
    this.deleteBox(selectedBoxId);
  }

  setActiveTag(tag: SemanticBoxTag): void {
    this.activeTag.set(tag);
    const selectedBoxId = this.selectedBoxId();
    if (!selectedBoxId) return;
    this.boxes.update((existing) => existing.map((box) => {
      if (box.id !== selectedBoxId) return box;
      return {
        ...box,
        tag,
        math: tag === "equation" ? box.math : undefined,
        table: tag === "table" ? box.table ?? { outputMode: "crop" } : undefined
      };
    }));
    this.boxesDirty.set(true);
  }

  setSelectedTableMode(mode: "crop" | "semantic"): void {
    const box = this.selectedTableBox();
    if (!box) return;
    this.updateBox(box.id, {
      ...box,
      table: mode === "semantic" ? this.ensureTableGrid(box) : { outputMode: "crop" }
    });
  }

  addTableColumn(): void {
    const box = this.selectedTableBox();
    if (!box) return;
    const table = this.ensureTableGrid(box);
    const columns = [...(table.grid?.columns ?? [])];
    const next = Number((box.w / (columns.length + 2)).toFixed(2));
    columns.push(next);
    this.updateBox(box.id, {
      ...box,
      table: {
        outputMode: "semantic",
        grid: { ...table.grid!, columns: this.normalizeGridValues(columns, box.w) }
      }
    });
  }

  addTableRow(): void {
    const box = this.selectedTableBox();
    if (!box) return;
    const table = this.ensureTableGrid(box);
    const rows = [...(table.grid?.rows ?? [])];
    const next = Number((box.h / (rows.length + 2)).toFixed(2));
    rows.push(next);
    this.updateBox(box.id, {
      ...box,
      table: {
        outputMode: "semantic",
        grid: { ...table.grid!, rows: this.normalizeGridValues(rows, box.h) }
      }
    });
  }

  tableGridColumns(box: SemanticBox): number[] {
    return box.tag === "table" ? box.table?.grid?.columns ?? [] : [];
  }

  tableGridRows(box: SemanticBox): number[] {
    return box.tag === "table" ? box.table?.grid?.rows ?? [] : [];
  }

  private finishDrawingBox(): void {
    const current = this.drawingBox();
    if (!current) return;
    const tag = this.activeTag();
    const box = this.clampBox({
      id: crypto.randomUUID(),
      tag,
      x: Number(current.x.toFixed(2)),
      y: Number(current.y.toFixed(2)),
      w: Number(current.w.toFixed(2)),
      h: Number(current.h.toFixed(2)),
      createdAt: new Date().toISOString(),
      readingOrder: this.boxes().length + 1,
      table: tag === "table" ? { outputMode: "crop" } : undefined
    });
    if (box.w > 2 && box.h > 2) {
      this.boxes.update((existing) => this.normalizeBoxOrder([...existing, box]));
      this.boxesDirty.set(true);
      this.selectedBoxId.set(box.id);
    }
    this.drawingBox.set(null);
  }

  saveBoxes(): void {
    void this.saveCurrentBoxes("Saving boxes and reading equations...");
  }

  recognizeSelectedEquation(): void {
    const page = this.page();
    const box = this.selectedEquationBox();
    if (!page || !box || this.recognizingEquation() || this.blockingMessage()) return;
    this.recognizingEquation.set(true);
    this.equationMessage.set("Reading equation...");
    this.fixes.recognizeEquation(this.jobId(), page.pageIndex, box.id, this.boxes()).subscribe({
      next: ({ box: updatedBox, result }) => {
        this.boxes.update((existing) => this.normalizeBoxOrder(existing.map((candidate) => (candidate.id === updatedBox.id ? updatedBox : candidate))));
        this.savedBoxesSignature = this.boxSignature(this.boxes());
        this.boxesDirty.set(false);
        this.finalRefreshToken.update((value) => value + 1);
        this.equationMessage.set(
          result.status === "ok"
            ? result.mathmlStatus === "ok"
              ? "Equation read, converted to MathML, and saved."
              : result.mathmlError ?? "Equation read, but MathML conversion failed."
            : result.error ?? `Equation recognition ${result.status}.`
        );
        this.recognizingEquation.set(false);
      },
      error: (error) => {
        const message = error?.error?.message ?? error?.message ?? "Unable to recognize equation.";
        this.equationMessage.set(message);
        this.recognizingEquation.set(false);
      }
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

  private selectReviewSpan(wordElement: HTMLElement, iframe: HTMLIFrameElement): void {
    const match = wordElement.className.toString().match(/page(\d+)__word(\d+)/);
    if (!match) return;
    this.clearSelectedReviewElement();
    wordElement.style.outline = "2px solid #ffcc00";
    wordElement.style.outlineOffset = "2px";
    this.selectedReviewElement = wordElement;
    const computedStyle = iframe.contentWindow?.getComputedStyle(wordElement);
    const fontSizePx = Number.parseFloat(computedStyle?.fontSize ?? "0");
    const topPx = Number.parseFloat(computedStyle?.top ?? wordElement.style.top ?? "0");
    const leftPx = Number.parseFloat(computedStyle?.left ?? wordElement.style.left ?? "0");
    const letterSpacingPx = computedStyle?.letterSpacing === "normal" ? 0 : Number.parseFloat(computedStyle?.letterSpacing ?? "0");
    this.selectedReviewSpan.set({
      pageIndex: Number(match[1]) - 1,
      wordIndex: Number(match[2]),
      cssClassName: `page${match[1]}__word${match[2]}`,
      text: wordElement.textContent?.trim() ?? "",
      fontFamily: computedStyle?.fontFamily ?? "",
      fontSizePx: Number.isFinite(fontSizePx) ? Number(fontSizePx.toFixed(3)) : 0,
      fontWeight: computedStyle?.fontWeight ?? "normal",
      fontStyle: computedStyle?.fontStyle ?? "normal",
      originalTopPx: Number.isFinite(topPx) ? topPx : 0,
      originalLeftPx: Number.isFinite(leftPx) ? leftPx : 0,
      originalLetterSpacingPx: Number.isFinite(letterSpacingPx) ? letterSpacingPx : 0
    });
    this.correctionClassName.set(`page${match[1]}__word${match[2]}`);
    this.correctionTopDelta.set(0);
    this.correctionLeftDelta.set(0);
    this.correctionLetterSpacing.set(Number.isFinite(letterSpacingPx) ? Number(letterSpacingPx.toFixed(3)) : 0);
    this.showCorrectionPopup.set(true);
    this.correctionMessage.set("");
  }

  private normalizedCorrectionClassName(): string {
    return this.correctionClassName().trim().replace(/^\./, "");
  }

  private resetCorrectionInputs(): void {
    this.correctionTopDelta.set(0);
    this.correctionLeftDelta.set(0);
    this.correctionLetterSpacing.set(0);
    this.correctionMessage.set("");
  }

  private clearSelectedReviewElement(): void {
    if (!this.selectedReviewElement) return;
    this.selectedReviewElement.style.outline = "";
    this.selectedReviewElement.style.outlineOffset = "";
    this.selectedReviewElement = null;
  }

  private previewSelectedSpanCorrection(): void {
    const span = this.selectedReviewSpan();
    if (!span || !this.selectedReviewElement) return;
    this.selectedReviewElement.style.top = `${Number((span.originalTopPx + this.correctionTopDelta()).toFixed(3))}px`;
    this.selectedReviewElement.style.left = `${Number((span.originalLeftPx + this.correctionLeftDelta()).toFixed(3))}px`;
    this.selectedReviewElement.style.letterSpacing = `${Number(this.correctionLetterSpacing().toFixed(3))}px`;
  }

  private moveSelectedBox(dx: number, dy: number): void {
    const selectedBoxId = this.selectedBoxId();
    if (!selectedBoxId) return;
    const box = this.boxes().find((candidate) => candidate.id === selectedBoxId);
    if (!box) return;
    this.updateBox(selectedBoxId, this.clampBox({ ...box, x: box.x + dx, y: box.y + dy }));
  }

  private updateBox(boxId: string, nextBox: SemanticBox): void {
    this.boxes.update((existing) => existing.map((box) => (box.id === boxId ? nextBox : box)));
    this.boxesDirty.set(true);
  }

  private async saveCurrentBoxes(message: string): Promise<boolean> {
    if (this.savingBoxes() || this.blockingMessage()) return false;
    const page = this.page();
    if (!page) return false;
    const orderedBoxes = this.normalizeBoxOrder(this.boxes());
    if (!this.hasZoningOutputChanges()) {
      this.boxesDirty.set(false);
      return true;
    }
    this.boxes.set(orderedBoxes);
    this.savingBoxes.set(true);
    this.blockingMessage.set(message);
    this.equationMessage.set("Saving page...");
    try {
      const archiveFinalHtml = this.isArchiveSource() ? this.buildArchiveFinalHtml(orderedBoxes, this.archiveFinalCssStrategy()) : undefined;
      if (this.isArchiveSource() && !archiveFinalHtml) throw new Error("Unable to read the imported page for final generation.");
      const response = await firstValueFrom(this.fixes.saveBoxes(this.jobId(), page.pageIndex, orderedBoxes, !this.isArchiveSource(), archiveFinalHtml ?? undefined, this.isArchiveSource() ? this.archiveFinalCssStrategy() : undefined));
      const savedBoxes = this.normalizeBoxOrder(response.boxes ?? orderedBoxes);
      const savedStrategy = response.archiveFinalCssStrategy ?? this.archiveFinalCssStrategy();
      this.boxes.set(savedBoxes);
      this.archiveFinalCssStrategy.set(savedStrategy);
      this.savedBoxesSignature = this.boxSignature(savedBoxes);
      this.savedArchiveFinalCssStrategy = savedStrategy;
      this.boxesDirty.set(false);
      if (!this.isArchiveSource()) this.finalRefreshToken.update((value) => value + 1);
      if (this.isArchiveSource()) {
        this.archiveFinalPreparedPageIndex = page.pageIndex;
        this.finalRefreshToken.update((value) => value + 1);
      }
      this.showFinalPane.set(!this.isArchiveSource() || savedBoxes.length > 0);
      queueMicrotask(() => this.updateScale());
      const equationCount = (response.boxes ?? orderedBoxes).filter((box) => box.tag === "equation").length;
      this.equationMessage.set(this.isArchiveSource()
        ? "Zoning saved for imported XHTML."
        : equationCount > 0
          ? `Saved page. Equation boxes processed: ${equationCount}.`
          : "Saved page.");
      return true;
    } catch (error: any) {
      const errorMessage = error?.error?.message ?? error?.message ?? "Unable to save page.";
      this.equationMessage.set(errorMessage);
      return false;
    } finally {
      this.savingBoxes.set(false);
      this.blockingMessage.set("");
    }
  }

  private maybePrepareArchiveFinalPage(): void {
    if (!this.isArchiveSource()) return;
    const page = this.page();
    const boxes = this.boxes();
    if (!page || boxes.length === 0 || this.archiveFinalPreparedPageIndex === page.pageIndex || this.hasZoningOutputChanges()) return;
    const archiveFinalHtml = this.buildArchiveFinalHtml(boxes, this.archiveFinalCssStrategy());
    if (!archiveFinalHtml) return;
    this.archiveFinalPreparedPageIndex = page.pageIndex;
    this.fixes.saveBoxes(this.jobId(), page.pageIndex, boxes, false, archiveFinalHtml, this.archiveFinalCssStrategy()).subscribe({
      next: () => {
        this.finalRefreshToken.update((value) => value + 1);
        this.showFinalPane.set(true);
        queueMicrotask(() => this.updateScale());
      },
      error: () => {
        this.archiveFinalPreparedPageIndex = -1;
        this.equationMessage.set("Zoning is saved, but the final XHTML page could not be generated.");
      }
    });
  }

  private buildArchiveFinalHtml(boxes: SemanticBox[], cssStrategy: ArchiveZoningCssStrategy): string | null {
    const iframe = this.reviewIframe()?.nativeElement;
    const frameDocument = iframe?.contentDocument;
    const frameWindow = iframe?.contentWindow;
    const page = this.page();
    if (!frameDocument?.body || !frameWindow || !page) return null;

    type Candidate = {
      key: string;
      element: HTMLElement;
      style: CSSStyleDeclaration;
      styleValues: Map<string, string>;
      x: number;
      y: number;
      w: number;
      h: number;
    };

    const visualProperties = [
      "position", "display", "left", "top", "width", "height", "z-index",
      "font-family", "font-size", "font-weight", "font-style", "font-variant", "font-stretch",
      "line-height", "letter-spacing", "word-spacing", "text-align", "white-space", "color",
      "direction", "text-transform", "transform", "transform-origin", "writing-mode", "text-orientation",
      "opacity", "visibility"
    ];
    const factorableProperties = [
      "font-family", "font-size", "font-weight", "font-style", "font-variant", "font-stretch",
      "line-height", "letter-spacing", "word-spacing", "text-align", "white-space", "color",
      "direction", "text-transform", "writing-mode", "text-orientation"
    ];
    const layoutProperties = new Set(["position", "display", "left", "top", "width", "height", "z-index", "transform", "transform-origin", "opacity", "visibility"]);
    const ignoredTags = new Set(["html", "head", "body", "script", "style", "meta", "link", "title", "br"]);
    const sourceMarker = "data-zoning-source-id";
    const roundCss = (value: number): string => `${Number(value.toFixed(3))}px`;
    const hasText = (element: HTMLElement): boolean => Boolean(element.textContent?.replace(/\s+/g, " ").trim());
    const measuredCandidates = Array.from(frameDocument.body.querySelectorAll<HTMLElement>("*"))
      .map((element, index) => {
        const style = frameWindow.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        const hasTransform = style.transform && style.transform !== "none";
        const useComputedPosition = style.position === "absolute" && hasTransform && style.left !== "auto" && style.top !== "auto";
        const styleValues = new Map<string, string>();
        for (const property of visualProperties) styleValues.set(property, style.getPropertyValue(property));
        styleValues.set("position", "absolute");
        styleValues.set("left", useComputedPosition ? style.getPropertyValue("left") : roundCss(rect.left + frameWindow.scrollX));
        styleValues.set("top", useComputedPosition ? style.getPropertyValue("top") : roundCss(rect.top + frameWindow.scrollY));
        styleValues.set("width", hasTransform ? style.getPropertyValue("width") : roundCss(rect.width));
        styleValues.set("height", hasTransform ? style.getPropertyValue("height") : roundCss(rect.height));
        return {
          key: `zoning-source-${index}`,
          element,
          style,
          styleValues,
          x: rect.left + frameWindow.scrollX,
          y: rect.top + frameWindow.scrollY,
          w: rect.width,
          h: rect.height
        };
      })
      .filter((candidate) => !ignoredTags.has(candidate.element.tagName.toLowerCase()) && hasText(candidate.element) && candidate.w > 0 && candidate.h > 0 && candidate.style.display !== "none" && candidate.style.visibility !== "hidden" && candidate.style.opacity !== "0");
    const positionedCandidates = measuredCandidates.filter((candidate) => candidate.style.position === "absolute" || candidate.style.position === "fixed");
    const candidatePool = positionedCandidates.length > 0 ? positionedCandidates : measuredCandidates;
    const candidates = candidatePool.filter((candidate) => !candidatePool.some((other) => other !== candidate && candidate.element.contains(other.element)));
    for (const candidate of candidates) candidate.element.setAttribute(sourceMarker, candidate.key);

    const root = frameDocument.documentElement.cloneNode(true) as HTMLElement;
    root.setAttribute("data-zoning-final", "true");
    root.setAttribute("data-zoning-css-strategy", cssStrategy);
    for (const candidate of candidates) candidate.element.removeAttribute(sourceMarker);

    const cloneBySourceKey = new Map<string, HTMLElement>();
    for (const element of Array.from(root.querySelectorAll<HTMLElement>(`[${sourceMarker}]`))) {
      const key = element.getAttribute(sourceMarker);
      if (key) cloneBySourceKey.set(key, element);
      element.removeAttribute(sourceMarker);
    }

    const body = root.querySelector("body");
    if (!body) return null;
    const textContainer = root.querySelector<HTMLElement>("#TextContainer") ?? root.querySelector<HTMLElement>(".main") ?? body;
    const namespace = root.namespaceURI || "http://www.w3.org/1999/xhtml";
    const ownerDocument = frameDocument;
    const claimedKeys = new Set<string>();
    const archivePath = this.archiveManifest()?.pages[page.pageIndex]?.reviewPath ?? "";
    const sourcePagePrefix = archivePath.match(/(?:^|\/)(page\d+)\.(?:xhtml|html|htm)$/i)?.[1]?.toLowerCase();
    const semanticPagePrefix = sourcePagePrefix ?? `page${String(page.pageIndex + 1).padStart(4, "0")}`;

    const styleElement = ownerDocument.createElementNS(namespace, "style");
    styleElement.textContent = ".zoning-semantic-parent{position:absolute;margin:0!important;padding:0!important;border:0;overflow:visible;z-index:2}.zoning-semantic-content{position:absolute;display:block;overflow:visible}";
    root.querySelector("head")?.appendChild(styleElement);
    let movedElementCount = 0;

    const commonStylesFor = (selected: Candidate[]): Map<string, string> => {
      const common = new Map<string, string>();
      if (cssStrategy !== "factor-common-css" || selected.length === 0) return common;
      for (const property of factorableProperties) {
        const firstValue = selected[0].styleValues.get(property) ?? "";
        if (!firstValue) continue;
        if (selected.every((candidate) => (candidate.styleValues.get(property) ?? "") === firstValue)) common.set(property, firstValue);
      }
      return common;
    };

    const applyStyles = (element: HTMLElement, styles: Map<string, string>, commonStyles: Map<string, string>): void => {
      for (const property of visualProperties) {
        if (commonStyles.has(property) && !layoutProperties.has(property)) continue;
        const value = styles.get(property);
        if (value) element.style.setProperty(property, value);
      }
    };

    for (const [boxIndex, box] of this.normalizeBoxOrder(boxes).entries()) {
      const selected = candidates.filter((candidate) => {
        if (claimedKeys.has(candidate.key)) return false;
        const centerX = candidate.x + candidate.w / 2;
        const centerY = candidate.y + candidate.h / 2;
        return centerX >= box.x && centerX <= box.x + box.w && centerY >= box.y && centerY <= box.y + box.h;
      });
      for (const candidate of selected) claimedKeys.add(candidate.key);
      const commonStyles = commonStylesFor(selected);

      const semantic = ownerDocument.createElementNS(namespace, box.tag) as HTMLElement;
      const order = box.readingOrder ?? boxIndex + 1;
      semantic.setAttribute("id", `${semanticPagePrefix}_para${order}`);
      semantic.setAttribute("class", `zoning-semantic-parent ${semanticPagePrefix}-para${order}`);
      semantic.setAttribute("data-box-id", box.id);
      semantic.setAttribute("data-reading-order", String(order));
      semantic.setAttribute("data-semantic-tag", box.tag);
      semantic.setAttribute("style", `left:${box.x}px;top:${box.y}px`);
      for (const [property, value] of commonStyles) semantic.style.setProperty(property, value);

      const content = ownerDocument.createElementNS(namespace, "span");
      content.setAttribute("class", "zoning-semantic-content");
      content.setAttribute("style", `left:${-box.x}px;top:${-box.y}px;width:${page.pageWidth}px;height:${page.pageHeight}px`);
      for (const candidate of selected) {
        const clonedElement = cloneBySourceKey.get(candidate.key);
        if (!clonedElement) continue;
        const replacement = ownerDocument.createElementNS(namespace, "span") as HTMLElement;
        for (const attribute of Array.from(clonedElement.attributes)) {
          if (attribute.name === "style" || attribute.name === sourceMarker) continue;
          if (cssStrategy === "factor-common-css" && attribute.name === "id") {
            replacement.setAttribute("data-source-id", attribute.value);
            continue;
          }
          if (cssStrategy === "factor-common-css" && attribute.name === "class") {
            replacement.setAttribute("data-source-class", attribute.value);
            continue;
          }
          replacement.setAttribute(attribute.name, attribute.value);
        }
        while (clonedElement.firstChild) replacement.appendChild(clonedElement.firstChild);
        applyStyles(replacement, candidate.styleValues, commonStyles);
        clonedElement.remove();
        content.appendChild(replacement);
        movedElementCount += 1;
      }
      if (!content.childNodes.length) continue;
      semantic.appendChild(content);
      textContainer.appendChild(semantic);
    }

    if (boxes.length > 0 && movedElementCount === 0) return null;

    const serializer = new XMLSerializer();
    return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE html>\n${serializer.serializeToString(root)}`;
  }

  moveBoxOrder(boxId: string, delta: -1 | 1): void {
    this.boxes.update((existing) => {
      const ordered = this.normalizeBoxOrder(existing);
      const index = ordered.findIndex((box) => box.id === boxId);
      if (index < 0) return ordered;
      const nextIndex = Math.max(0, Math.min(ordered.length - 1, index + delta));
      if (nextIndex === index) return ordered;
      const next = [...ordered];
      const [box] = next.splice(index, 1);
      next.splice(nextIndex, 0, box);
      this.boxesDirty.set(true);
      return this.normalizeBoxOrder(next);
    });
  }

  private resizeBox(box: SemanticBox, handle: ResizeHandle, dx: number, dy: number): SemanticBox {
    const page = this.page();
    const pageWidth = page?.pageWidth ?? Number.POSITIVE_INFINITY;
    const pageHeight = page?.pageHeight ?? Number.POSITIVE_INFINITY;
    const minSize = 4;
    const right = box.x + box.w;
    const bottom = box.y + box.h;
    let x = box.x;
    let y = box.y;
    let width = box.w;
    let height = box.h;

    if (handle.includes("n")) {
      y = Math.max(0, Math.min(box.y + dy, bottom - minSize));
      height = bottom - y;
    }
    if (handle.includes("s")) height = Math.max(minSize, Math.min(box.h + dy, pageHeight - box.y));
    if (handle.includes("w")) {
      x = Math.max(0, Math.min(box.x + dx, right - minSize));
      width = right - x;
    }
    if (handle.includes("e")) width = Math.max(minSize, Math.min(box.w + dx, pageWidth - box.x));

    return {
      ...box,
      x: Number(x.toFixed(2)),
      y: Number(y.toFixed(2)),
      w: Number(width.toFixed(2)),
      h: Number(height.toFixed(2))
    };
  }

  private moveTableGridLine(box: SemanticBox, axis: "column" | "row", lineIndex: number, dx: number, dy: number): SemanticBox {
    if (box.tag !== "table") return box;
    const table = this.ensureTableGrid(box);
    const grid = table.grid!;
    if (axis === "column") {
      const columns = [...grid.columns];
      columns[lineIndex] = Number(((columns[lineIndex] ?? 0) + dx).toFixed(2));
      return { ...box, table: { outputMode: "semantic", grid: { ...grid, columns: this.normalizeGridValues(columns, box.w) } } };
    }
    const rows = [...grid.rows];
    rows[lineIndex] = Number(((rows[lineIndex] ?? 0) + dy).toFixed(2));
    return { ...box, table: { outputMode: "semantic", grid: { ...grid, rows: this.normalizeGridValues(rows, box.h) } } };
  }

  private ensureTableGrid(box: SemanticBox): NonNullable<SemanticBox["table"]> & { grid: NonNullable<NonNullable<SemanticBox["table"]>["grid"]> } {
    const existing = box.table?.grid;
    return {
      outputMode: "semantic",
      grid: {
        columns: this.normalizeGridValues(existing?.columns?.length ? existing.columns : [box.w / 3, (box.w * 2) / 3], box.w),
        rows: this.normalizeGridValues(existing?.rows?.length ? existing.rows : [box.h / 2], box.h),
        mergedCells: existing?.mergedCells ?? []
      }
    };
  }

  private normalizeGridValues(values: number[], max: number): number[] {
    return Array.from(new Set(values
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value) && value > 1 && value < max - 1)
      .map((value) => Number(value.toFixed(2)))
      .sort((a, b) => a - b)));
  }

  private clampBox(box: SemanticBox): SemanticBox {
    const page = this.page();
    const pageWidth = page?.pageWidth ?? Number.POSITIVE_INFINITY;
    const pageHeight = page?.pageHeight ?? Number.POSITIVE_INFINITY;
    const minSize = 4;
    const width = Math.max(minSize, Math.min(box.w, pageWidth));
    const height = Math.max(minSize, Math.min(box.h, pageHeight));
    const x = Math.max(0, Math.min(box.x, pageWidth - width));
    const y = Math.max(0, Math.min(box.y, pageHeight - height));
    return {
      ...box,
      x: Number(x.toFixed(2)),
      y: Number(y.toFixed(2)),
      w: Number(width.toFixed(2)),
      h: Number(height.toFixed(2))
    };
  }

  private isEditableEventTarget(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) return false;
    const tagName = target.tagName.toLowerCase();
    return target.isContentEditable || tagName === "input" || tagName === "textarea" || tagName === "select";
  }

  private orderBoxes(boxes: SemanticBox[]): SemanticBox[] {
    return [...boxes].sort((a, b) => {
      const aOrder = typeof a.readingOrder === "number" && Number.isFinite(a.readingOrder) ? a.readingOrder : Number.POSITIVE_INFINITY;
      const bOrder = typeof b.readingOrder === "number" && Number.isFinite(b.readingOrder) ? b.readingOrder : Number.POSITIVE_INFINITY;
      if (aOrder !== bOrder) return aOrder - bOrder;
      return Date.parse(a.createdAt) - Date.parse(b.createdAt);
    });
  }

  private normalizeBoxOrder(boxes: SemanticBox[]): SemanticBox[] {
    return this.orderBoxes(boxes).map((box, index) => ({ ...box, readingOrder: index + 1 }));
  }

  private boxSignature(boxes: SemanticBox[]): string {
    return JSON.stringify(this.normalizeBoxOrder(boxes).map((box) => ({
      id: box.id,
      tag: box.tag,
      x: Number(box.x.toFixed(3)),
      y: Number(box.y.toFixed(3)),
      w: Number(box.w.toFixed(3)),
      h: Number(box.h.toFixed(3)),
      createdAt: box.createdAt,
      readingOrder: box.readingOrder ?? 0,
      table: box.table ?? null,
      math: box.math ?? null
    })));
  }
}
