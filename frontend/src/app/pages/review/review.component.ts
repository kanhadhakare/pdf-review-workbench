import { CommonModule } from "@angular/common";
import { ChangeDetectionStrategy, Component, ElementRef, HostListener, computed, inject, signal, viewChild } from "@angular/core";
import { ActivatedRoute, Router, RouterLink } from "@angular/router";
import {
  type AccessibilityPageReviewStatus,
  type AccessibilityTag,
  type AccessibilityTagName,
  type AccessibilityTagStatus,
  type AccessibilityValidationReport,
  type ArchiveZoningCssStrategy,
  type ImportedBookManifest,
  type JobEditSummary,
  type JobWorkflow,
  type PageResult,
  type SourceType,
  type SpanCorrectionScope
} from "../../types";
import { JobService } from "../../services/job.service";
import { AccessibilityService } from "../../services/accessibility.service";
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

type AccessibilityTagInteraction =
  | { type: "move"; tagId: string; startClientX: number; startClientY: number; original: AccessibilityTag }
  | { type: "resize"; tagId: string; handle: ResizeHandle; startClientX: number; startClientY: number; original: AccessibilityTag };

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
  private readonly accessibility = inject(AccessibilityService);
  private readonly fixes = inject(FixService);
  private readonly sanitizer = inject(DomSanitizer);
  private readonly editorViewport = viewChild<ElementRef<HTMLDivElement>>("editorViewport");
  private readonly reviewIframe = viewChild<ElementRef<HTMLIFrameElement>>("reviewIframe");
  readonly jobId = signal(this.route.snapshot.paramMap.get("jobId") ?? "");

  readonly page = signal<PageResult | null>(null);
  readonly pageIndex = signal(0);
  readonly pageCount = signal(0);
  readonly sourceType = signal<SourceType>("pdf");
  readonly workflow = signal<JobWorkflow>("zoning");
  readonly archiveManifest = signal<ImportedBookManifest | null>(null);
  readonly isArchiveSource = computed(() => this.sourceType() === "epub" || this.sourceType() === "html-zip");
  readonly isTaggingWorkflow = computed(() => this.workflow() === "accessibility-tagging");
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
  readonly accessibilityTags = signal<AccessibilityTag[]>([]);
  readonly activeAccessibilityTag = signal<AccessibilityTagName>("P");
  readonly accessibilityReviewStatus = signal<AccessibilityPageReviewStatus>("untagged");
  readonly selectedAccessibilityTagId = signal<string | null>(null);
  readonly drawingAccessibilityTag = signal<{ startX: number; startY: number; x: number; y: number; w: number; h: number } | null>(null);
  readonly accessibilityTagInteraction = signal<AccessibilityTagInteraction | null>(null);
  readonly savingAccessibilityTags = signal(false);
  readonly detectingAccessibilityTags = signal(false);
  readonly validatingAccessibilityTags = signal(false);
  readonly accessibilityValidationReport = signal<AccessibilityValidationReport | null>(null);
  readonly accessibilityMessage = signal("");
  private savedAccessibilitySignature = "[]";
  readonly hasAccessibilityTagChanges = computed(() => this.accessibilitySignature(this.accessibilityTags(), this.accessibilityReviewStatus()) !== this.savedAccessibilitySignature);
  readonly selectedAccessibilityTag = computed(() => {
    const selectedId = this.selectedAccessibilityTagId();
    return selectedId ? this.accessibilityTags().find((tag) => tag.id === selectedId) ?? null : null;
  });
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
        this.workflow.set(job.workflow ?? "zoning");
        this.editSummary.set(editSummary);
        this.editCountMap.set({ ...editSummary.editsByPage });
        if (this.isTaggingWorkflow()) {
          this.boxMode.set(false);
          this.showFinalPane.set(false);
        }
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

    const selectedAccessibilityTagId = this.selectedAccessibilityTagId();
    if (this.isTaggingWorkflow() && selectedAccessibilityTagId) {
      if (event.key === "Backspace" || event.key === "Delete") {
        event.preventDefault();
        this.deleteAccessibilityTag(selectedAccessibilityTagId);
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
        this.moveSelectedAccessibilityTag(delta.x, delta.y);
        return;
      }
    }

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

    const tagInteraction = this.accessibilityTagInteraction();
    if (tagInteraction) {
      event.preventDefault();
      const scale = this.pageScale();
      const dx = (event.clientX - tagInteraction.startClientX) / scale;
      const dy = (event.clientY - tagInteraction.startClientY) / scale;
      const nextTag = tagInteraction.type === "move"
        ? this.clampAccessibilityTag({
          ...tagInteraction.original,
          bbox: {
            ...tagInteraction.original.bbox,
            x: tagInteraction.original.bbox.x + dx,
            y: tagInteraction.original.bbox.y + dy
          }
        })
        : this.resizeAccessibilityTag(tagInteraction.original, tagInteraction.handle, dx, dy);
      this.updateAccessibilityTag(tagInteraction.tagId, nextTag);
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
    if (this.drawingAccessibilityTag()) this.finishDrawingAccessibilityTag();
    if (this.drawingBox()) this.finishDrawingBox();
    this.boxInteraction.set(null);
    this.accessibilityTagInteraction.set(null);
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
    this.clearSelectedReviewElement();
    const iframe = event.target as HTMLIFrameElement;
    const frameDocument = iframe.contentDocument;
    const frameWindow = iframe.contentWindow;
    if (!frameDocument || !frameWindow) return;
    if (this.isTaggingWorkflow()) return;
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
        this.clearSelectedReviewElement();
        this.selectedReviewSpan.set(null);
        this.reviewRefreshToken.update((value) => value + 1);
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
    this.accessibilityTagInteraction.set(null);
    this.drawingBox.set(null);
    this.drawingAccessibilityTag.set(null);
    this.equationMessage.set("");
    this.accessibilityMessage.set("");
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
    if (this.isTaggingWorkflow()) {
      this.boxes.set([]);
      this.selectedBoxId.set(null);
      this.loadAccessibilityPage(page.pageIndex);
      queueMicrotask(() => this.updateScale());
      return;
    }
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
    const saved = this.isTaggingWorkflow()
      ? await this.saveCurrentAccessibilityTags("Saving accessibility tags before navigation...")
      : await this.saveCurrentBoxes("Saving page and reading equations before navigation...");
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

  accessibilityOverlayMouseDown(event: MouseEvent): void {
    if (!this.isTaggingWorkflow() || this.blockingMessage()) return;
    const page = this.page();
    if (!page) return;
    event.preventDefault();
    const target = event.currentTarget as HTMLElement;
    const rect = target.getBoundingClientRect();
    const scale = this.pageScale();
    const x = (event.clientX - rect.left) / scale;
    const y = (event.clientY - rect.top) / scale;
    this.selectedAccessibilityTagId.set(null);
    this.drawingAccessibilityTag.set({ startX: x, startY: y, x, y, w: 0, h: 0 });
  }

  accessibilityOverlayMouseMove(event: MouseEvent): void {
    const current = this.drawingAccessibilityTag();
    if (!current) return;
    event.preventDefault();
    const target = event.currentTarget as HTMLElement;
    const rect = target.getBoundingClientRect();
    const scale = this.pageScale();
    const x = (event.clientX - rect.left) / scale;
    const y = (event.clientY - rect.top) / scale;
    this.drawingAccessibilityTag.set({
      ...current,
      x: Math.min(current.startX, x),
      y: Math.min(current.startY, y),
      w: Math.abs(x - current.startX),
      h: Math.abs(y - current.startY)
    });
  }

  accessibilityOverlayMouseUp(event: MouseEvent): void {
    event.preventDefault();
    this.finishDrawingAccessibilityTag();
  }

  accessibilityTagMouseDown(event: MouseEvent, tag: AccessibilityTag): void {
    if (!this.isTaggingWorkflow()) return;
    event.preventDefault();
    event.stopPropagation();
    this.selectedAccessibilityTagId.set(tag.id);
    this.activeAccessibilityTag.set(tag.tag);
    this.accessibilityTagInteraction.set({ type: "move", tagId: tag.id, startClientX: event.clientX, startClientY: event.clientY, original: { ...tag, bbox: { ...tag.bbox } } });
  }

  accessibilityTagResizeMouseDown(event: MouseEvent, tag: AccessibilityTag, handle: ResizeHandle): void {
    if (!this.isTaggingWorkflow()) return;
    event.preventDefault();
    event.stopPropagation();
    this.selectedAccessibilityTagId.set(tag.id);
    this.activeAccessibilityTag.set(tag.tag);
    this.accessibilityTagInteraction.set({ type: "resize", tagId: tag.id, handle, startClientX: event.clientX, startClientY: event.clientY, original: { ...tag, bbox: { ...tag.bbox } } });
  }

  setActiveAccessibilityTag(tag: AccessibilityTagName): void {
    this.activeAccessibilityTag.set(tag);
    const selectedId = this.selectedAccessibilityTagId();
    if (!selectedId) return;
    this.accessibilityTags.update((existing) => existing.map((candidate) => candidate.id === selectedId
      ? { ...candidate, tag, status: "accepted", updatedAt: new Date().toISOString() }
      : candidate));
    if (this.accessibilityReviewStatus() === "reviewed") this.accessibilityReviewStatus.set("needs-review");
  }

  deleteAccessibilityTag(tagId: string): void {
    this.accessibilityTags.update((existing) => this.normalizeAccessibilityTagOrder(existing.filter((tag) => tag.id !== tagId)));
    if (this.selectedAccessibilityTagId() === tagId) this.selectedAccessibilityTagId.set(null);
    if (this.accessibilityReviewStatus() === "reviewed") this.accessibilityReviewStatus.set("needs-review");
  }

  deleteSelectedAccessibilityTag(): void {
    const selectedId = this.selectedAccessibilityTagId();
    if (selectedId) this.deleteAccessibilityTag(selectedId);
  }

  moveAccessibilityTagOrder(tagId: string, delta: -1 | 1): void {
    this.accessibilityTags.update((existing) => {
      const ordered = this.normalizeAccessibilityTagOrder(existing);
      const index = ordered.findIndex((tag) => tag.id === tagId);
      if (index < 0) return ordered;
      const nextIndex = Math.max(0, Math.min(ordered.length - 1, index + delta));
      if (nextIndex === index) return ordered;
      const next = [...ordered];
      const [tag] = next.splice(index, 1);
      next.splice(nextIndex, 0, tag);
      if (this.accessibilityReviewStatus() === "reviewed") this.accessibilityReviewStatus.set("needs-review");
      return this.normalizeAccessibilityTagOrder(next);
    });
  }

  saveAccessibilityTags(): void {
    void this.saveCurrentAccessibilityTags("Saving accessibility tags...");
  }

  markAccessibilityPageReviewed(): void {
    this.accessibilityReviewStatus.set("reviewed");
    void this.saveCurrentAccessibilityTags("Saving reviewed accessibility page...");
  }

  detectAccessibilityPage(): void {
    if (!this.isTaggingWorkflow() || this.detectingAccessibilityTags() || this.blockingMessage()) return;
    const page = this.page();
    if (!page) return;
    const replace = this.accessibilityTags().length > 0
      ? window.confirm("Replace current page accessibility tags with auto-detected suggestions?")
      : true;
    if (!replace && this.accessibilityTags().length > 0) return;
    this.detectingAccessibilityTags.set(true);
    this.blockingMessage.set("Auto-detecting accessibility tags...");
    this.accessibilityMessage.set("Auto detection running...");
    this.accessibility.detectPage(this.jobId(), page.pageIndex, replace).subscribe({
      next: ({ page: pageMap, engine, warnings }) => {
        const tags = this.normalizeAccessibilityTagOrder(pageMap.tags ?? []);
        this.accessibilityTags.set(tags);
        this.accessibilityReviewStatus.set(pageMap.reviewStatus ?? (tags.length ? "needs-review" : "untagged"));
        this.savedAccessibilitySignature = this.accessibilitySignature(tags, this.accessibilityReviewStatus());
        const warningText = warnings?.length ? ` Warning: ${warnings[0]}` : "";
        this.accessibilityMessage.set(`Auto detection complete (${engine}). Tags: ${tags.length}.${warningText}`);
        this.detectingAccessibilityTags.set(false);
        this.blockingMessage.set("");
      },
      error: (error) => {
        this.accessibilityMessage.set(error?.error?.message ?? "Auto detection failed.");
        this.detectingAccessibilityTags.set(false);
        this.blockingMessage.set("");
      }
    });
  }

  detectAccessibilityBook(): void {
    if (!this.isTaggingWorkflow() || this.detectingAccessibilityTags() || this.blockingMessage()) return;
    const replace = window.confirm("Run auto detection for all pages? Existing tags will be preserved unless you confirm replacement on the next prompt.");
    if (!replace) return;
    const replaceExisting = window.confirm("Replace existing accessibility tags on pages that already have tags?");
    this.detectingAccessibilityTags.set(true);
    this.blockingMessage.set("Auto-detecting accessibility tags for all pages...");
    this.accessibilityMessage.set("Book-level auto detection running...");
    this.accessibility.detectAll(this.jobId(), replaceExisting).subscribe({
      next: ({ pageCount, taggedPages, engine, warnings }) => {
        this.detectingAccessibilityTags.set(false);
        this.blockingMessage.set("");
        const warningText = warnings?.length ? ` Warning: ${warnings[0]}` : "";
        this.accessibilityMessage.set(`Auto detection complete (${engine}). Tagged pages: ${taggedPages}/${pageCount}.${warningText}`);
        this.loadAccessibilityPage(this.pageIndex());
      },
      error: (error) => {
        this.detectingAccessibilityTags.set(false);
        this.blockingMessage.set("");
        this.accessibilityMessage.set(error?.error?.message ?? "Book-level auto detection failed.");
      }
    });
  }

  validateAccessibility(): void {
    if (!this.isTaggingWorkflow() || this.validatingAccessibilityTags() || this.blockingMessage()) return;
    void this.validateAccessibilityAsync();
  }

  exportTaggedPdf(): void {
    if (!this.isTaggingWorkflow() || this.blockingMessage()) return;
    this.accessibility.exportPdf(this.jobId()).subscribe({
      next: (response) => this.accessibilityMessage.set(response.message),
      error: (error) => this.accessibilityMessage.set(error?.error?.message ?? "Tagged PDF export is not available yet.")
    });
  }

  updateSelectedAccessibilityTagStatus(status: AccessibilityTagStatus): void {
    this.patchSelectedAccessibilityTag({ status });
  }

  updateSelectedAccessibilityTagText(field: "altText" | "actualText" | "language", value: string): void {
    this.patchSelectedAccessibilityTag({ [field]: value } as Partial<AccessibilityTag>);
  }

  updateSelectedAccessibilityTable(field: "rowCount" | "columnCount", value: number): void {
    const current = this.selectedAccessibilityTag();
    if (!current) return;
    this.patchSelectedAccessibilityTag({
      table: {
        ...current.table,
        [field]: Math.max(0, Math.floor(Number(value) || 0))
      }
    });
  }

  updateSelectedAccessibilityTableScope(headerScope: "row" | "column" | "both" | "none"): void {
    const current = this.selectedAccessibilityTag();
    if (!current) return;
    this.patchSelectedAccessibilityTag({
      table: {
        ...current.table,
        headerScope
      }
    });
  }

  updateSelectedAccessibilityFormula(field: "latex" | "mathml", value: string): void {
    const current = this.selectedAccessibilityTag();
    if (!current) return;
    this.patchSelectedAccessibilityTag({
      formula: {
        ...current.formula,
        [field]: value
      }
    });
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
        table: tag === "table" ? box.table ?? (this.isArchiveSource() ? this.ensureTableGrid({ ...box, tag }) : { outputMode: "crop" }) : undefined
      };
    }));
    this.boxesDirty.set(true);
  }

  setSelectedTableMode(mode: "crop" | "semantic"): void {
    const box = this.selectedTableBox();
    if (!box) return;
    this.updateBox(box.id, {
      ...box,
      table: mode === "semantic" || this.isArchiveSource() ? this.ensureTableGrid(box) : { outputMode: "crop" }
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

  private loadAccessibilityPage(pageIndex: number): void {
    this.accessibility.getPage(this.jobId(), pageIndex).subscribe({
      next: (pageMap) => {
        const tags = this.normalizeAccessibilityTagOrder(pageMap.tags ?? []);
        this.accessibilityTags.set(tags);
        this.accessibilityReviewStatus.set(pageMap.reviewStatus ?? (tags.length ? "needs-review" : "untagged"));
        this.savedAccessibilitySignature = this.accessibilitySignature(tags, this.accessibilityReviewStatus());
      },
      error: () => {
        this.accessibilityTags.set([]);
        this.accessibilityReviewStatus.set("untagged");
        this.savedAccessibilitySignature = this.accessibilitySignature([], "untagged");
        this.accessibilityMessage.set("Unable to load accessibility tags.");
      }
    });
  }

  private finishDrawingAccessibilityTag(): void {
    const current = this.drawingAccessibilityTag();
    const page = this.page();
    if (!current || !page) return;
    const now = new Date().toISOString();
    const tag = this.clampAccessibilityTag({
      id: crypto.randomUUID(),
      pageIndex: page.pageIndex,
      tag: this.activeAccessibilityTag(),
      bbox: {
        x: Number(current.x.toFixed(2)),
        y: Number(current.y.toFixed(2)),
        w: Number(current.w.toFixed(2)),
        h: Number(current.h.toFixed(2))
      },
      readingOrder: this.accessibilityTags().length + 1,
      confidence: 1,
      source: "manual",
      status: "accepted",
      createdAt: now,
      updatedAt: now
    });
    if (tag.bbox.w > 2 && tag.bbox.h > 2) {
      this.accessibilityTags.update((existing) => this.normalizeAccessibilityTagOrder([...existing, tag]));
      this.accessibilityReviewStatus.set("needs-review");
      this.selectedAccessibilityTagId.set(tag.id);
    }
    this.drawingAccessibilityTag.set(null);
  }

  private moveSelectedAccessibilityTag(dx: number, dy: number): void {
    const selectedId = this.selectedAccessibilityTagId();
    if (!selectedId) return;
    const tag = this.accessibilityTags().find((candidate) => candidate.id === selectedId);
    if (!tag) return;
    this.updateAccessibilityTag(selectedId, this.clampAccessibilityTag({
      ...tag,
      bbox: {
        ...tag.bbox,
        x: tag.bbox.x + dx,
        y: tag.bbox.y + dy
      }
    }));
  }

  private updateAccessibilityTag(tagId: string, nextTag: AccessibilityTag): void {
    this.accessibilityTags.update((existing) => existing.map((tag) => (tag.id === tagId ? nextTag : tag)));
    if (this.accessibilityReviewStatus() === "reviewed") this.accessibilityReviewStatus.set("needs-review");
  }

  private patchSelectedAccessibilityTag(patch: Partial<AccessibilityTag>): void {
    const selectedId = this.selectedAccessibilityTagId();
    if (!selectedId) return;
    this.accessibilityTags.update((existing) => existing.map((tag) => tag.id === selectedId
      ? {
        ...tag,
        ...patch,
        status: patch.status ?? (tag.status === "suggested" ? "accepted" : tag.status),
        updatedAt: new Date().toISOString()
      }
      : tag));
    if (this.accessibilityReviewStatus() === "reviewed") this.accessibilityReviewStatus.set("needs-review");
  }

  private async validateAccessibilityAsync(): Promise<void> {
    const saved = await this.saveCurrentAccessibilityTags("Saving accessibility tags before validation...");
    if (!saved) return;
    this.validatingAccessibilityTags.set(true);
    this.blockingMessage.set("Validating accessibility map...");
    this.accessibilityMessage.set("Validation running...");
    this.accessibility.validate(this.jobId()).subscribe({
      next: (report) => {
        this.accessibilityValidationReport.set(report);
        this.accessibilityMessage.set(`Validation ${report.status}. Errors: ${report.errorCount}, warnings: ${report.warningCount}.`);
        this.validatingAccessibilityTags.set(false);
        this.blockingMessage.set("");
      },
      error: (error) => {
        this.accessibilityMessage.set(error?.error?.message ?? "Validation failed.");
        this.validatingAccessibilityTags.set(false);
        this.blockingMessage.set("");
      }
    });
  }

  private async saveCurrentAccessibilityTags(message: string): Promise<boolean> {
    if (this.savingAccessibilityTags() || this.blockingMessage()) return false;
    const page = this.page();
    if (!page) return false;
    const orderedTags = this.normalizeAccessibilityTagOrder(this.accessibilityTags());
    const reviewStatus = orderedTags.length ? this.accessibilityReviewStatus() : "untagged";
    if (this.accessibilitySignature(orderedTags, reviewStatus) === this.savedAccessibilitySignature) return true;
    this.accessibilityTags.set(orderedTags);
    this.savingAccessibilityTags.set(true);
    this.blockingMessage.set(message);
    this.accessibilityMessage.set("Saving accessibility tags...");
    try {
      const saved = await firstValueFrom(this.accessibility.savePage(this.jobId(), page.pageIndex, orderedTags, reviewStatus));
      const savedTags = this.normalizeAccessibilityTagOrder(saved.tags ?? []);
      this.accessibilityTags.set(savedTags);
      this.accessibilityReviewStatus.set(saved.reviewStatus ?? reviewStatus);
      this.savedAccessibilitySignature = this.accessibilitySignature(savedTags, this.accessibilityReviewStatus());
      this.accessibilityMessage.set(this.accessibilityReviewStatus() === "reviewed" ? "Accessibility page reviewed." : "Accessibility tags saved.");
      return true;
    } catch (error: any) {
      this.accessibilityMessage.set(error?.error?.message ?? error?.message ?? "Unable to save accessibility tags.");
      return false;
    } finally {
      this.savingAccessibilityTags.set(false);
      this.blockingMessage.set("");
    }
  }

  private resizeAccessibilityTag(tag: AccessibilityTag, handle: ResizeHandle, dx: number, dy: number): AccessibilityTag {
    const page = this.page();
    const pageWidth = page?.pageWidth ?? Number.POSITIVE_INFINITY;
    const pageHeight = page?.pageHeight ?? Number.POSITIVE_INFINITY;
    const minSize = 4;
    const box = tag.bbox;
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

    return this.clampAccessibilityTag({
      ...tag,
      bbox: {
        x,
        y,
        w: width,
        h: height
      }
    });
  }

  private clampAccessibilityTag(tag: AccessibilityTag): AccessibilityTag {
    const page = this.page();
    const pageWidth = page?.pageWidth ?? Number.POSITIVE_INFINITY;
    const pageHeight = page?.pageHeight ?? Number.POSITIVE_INFINITY;
    const minSize = 4;
    const width = Math.max(minSize, Math.min(tag.bbox.w, pageWidth));
    const height = Math.max(minSize, Math.min(tag.bbox.h, pageHeight));
    const x = Math.max(0, Math.min(tag.bbox.x, pageWidth - width));
    const y = Math.max(0, Math.min(tag.bbox.y, pageHeight - height));
    return {
      ...tag,
      bbox: {
        x: Number(x.toFixed(2)),
        y: Number(y.toFixed(2)),
        w: Number(width.toFixed(2)),
        h: Number(height.toFixed(2))
      },
      updatedAt: new Date().toISOString()
    };
  }

  private normalizeAccessibilityTagOrder(tags: AccessibilityTag[]): AccessibilityTag[] {
    return [...tags]
      .sort((a, b) => {
        if (a.readingOrder !== b.readingOrder) return a.readingOrder - b.readingOrder;
        return Date.parse(a.createdAt) - Date.parse(b.createdAt);
      })
      .map((tag, index) => ({ ...tag, readingOrder: index + 1 }));
  }

  private accessibilitySignature(tags: AccessibilityTag[], reviewStatus: AccessibilityPageReviewStatus): string {
    return JSON.stringify({
      reviewStatus,
      tags: this.normalizeAccessibilityTagOrder(tags).map((tag) => ({
        id: tag.id,
        tag: tag.tag,
        x: Number(tag.bbox.x.toFixed(3)),
        y: Number(tag.bbox.y.toFixed(3)),
        w: Number(tag.bbox.w.toFixed(3)),
        h: Number(tag.bbox.h.toFixed(3)),
        readingOrder: tag.readingOrder,
        status: tag.status,
        source: tag.source,
        confidence: Number(tag.confidence.toFixed(3)),
        altText: tag.altText ?? "",
        actualText: tag.actualText ?? "",
        language: tag.language ?? "",
        table: tag.table ?? null,
        formula: tag.formula ?? null
      }))
    });
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
      table: tag === "table" ? (this.isArchiveSource() ? this.ensureTableGrid({ ...current, id: "", tag, createdAt: "" }) : { outputMode: "crop" }) : undefined
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
      // this.showFinalPane.set(!this.isArchiveSource() || savedBoxes.length > 0);
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
        // this.showFinalPane.set(true);
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
      domOrder: number;
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
    const parsePx = (value: string): number | null => {
      const match = value.trim().match(/^(-?\d+(?:\.\d+)?)px$/i);
      return match ? Number(match[1]) : null;
    };
    const scaledPx = (value: string, scale: number): string => {
      const numericValue = parsePx(value);
      return numericValue === null || scale === 1 ? value : roundCss(numericValue * scale);
    };
    const matrixScale = (transform: string): number => {
      if (!transform || transform === "none") return 1;
      const matrix = transform.match(/^matrix\(([^)]+)\)$/);
      if (matrix) {
        const [a, b] = matrix[1].split(",").map((part) => Number(part.trim()));
        return Number.isFinite(a) && Number.isFinite(b) ? Math.sqrt(a * a + b * b) : 1;
      }
      const scale = transform.match(/^scale\((-?\d+(?:\.\d+)?)(?:,\s*-?\d+(?:\.\d+)?)?\)$/);
      return scale ? Number(scale[1]) : 1;
    };
    const inheritedVisualScale = (element: HTMLElement): number => {
      let scale = 1;
      let parent = element.parentElement;
      while (parent && parent !== frameDocument.body) {
        scale *= matrixScale(frameWindow.getComputedStyle(parent).transform);
        parent = parent.parentElement;
      }
      return Number.isFinite(scale) && scale > 0 ? scale : 1;
    };
    const scaleAwareProperties = new Set(["font-size", "line-height", "letter-spacing", "word-spacing"]);
    const median = (values: number[]): number => {
      const sorted = values.filter((value) => Number.isFinite(value) && value > 0).sort((a, b) => a - b);
      if (!sorted.length) return 0;
      const middle = Math.floor(sorted.length / 2);
      return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
    };
    const orderCandidatesForReading = (selected: Candidate[]): Candidate[] => {
      const medianHeight = median(selected.map((candidate) => candidate.h));
      const lineTolerance = Math.max(3, medianHeight * 0.45);
      const lines: Array<{ centerY: number; candidates: Candidate[] }> = [];
      for (const candidate of [...selected].sort((a, b) => (a.y + a.h / 2) - (b.y + b.h / 2) || a.x - b.x || a.domOrder - b.domOrder)) {
        const centerY = candidate.y + candidate.h / 2;
        const line = lines.find((entry) => Math.abs(entry.centerY - centerY) <= lineTolerance);
        if (line) {
          line.candidates.push(candidate);
          line.centerY = line.candidates.reduce((sum, entry) => sum + entry.y + entry.h / 2, 0) / line.candidates.length;
        } else {
          lines.push({ centerY, candidates: [candidate] });
        }
      }
      return lines
        .sort((a, b) => a.centerY - b.centerY)
        .flatMap((line) => line.candidates.sort((a, b) => a.x - b.x || a.domOrder - b.domOrder));
    };
    const removeEmptyStructuralElements = (scope: ParentNode): void => {
      for (const element of Array.from(scope.querySelectorAll<HTMLElement>("p"))) {
        if (element.classList.contains("zoning-semantic-parent")) continue;
        if (element.querySelector("img,svg,math,table,canvas,video,audio")) continue;
        if (element.textContent?.replace(/\s+/g, "").length) continue;
        if (element.children.length) continue;
        element.remove();
      }
      for (const element of Array.from(scope.querySelectorAll<HTMLElement>("html,head,body,div"))) {
        for (const node of Array.from(element.childNodes)) {
          if (node.nodeType === Node.TEXT_NODE && !node.textContent?.trim()) node.remove();
        }
      }
    };
    const formatSerializedXhtml = (html: string): string => {
      return html
        .replace(/><(head|body|div|p|style|link|meta|title)(\s|>)/g, ">\n<$1$2")
        .replace(/<\/(head|body|div|p|style|title)></g, "</$1>\n<")
        .replace(/\n{3,}/g, "\n\n");
    };
    const firstTextNode = (node: Node): Text | null => {
      if (node.nodeType === Node.TEXT_NODE && node.textContent?.length) return node as Text;
      for (const child of Array.from(node.childNodes)) {
        const text = firstTextNode(child);
        if (text) return text;
      }
      return null;
    };
    const textRangeRect = (textNode: Text, start: number, end: number): DOMRect | null => {
      const length = textNode.textContent?.length ?? 0;
      if (!length) return null;
      const range = frameDocument.createRange();
      range.setStart(textNode, Math.max(0, Math.min(start, length)));
      range.setEnd(textNode, Math.max(0, Math.min(end, length)));
      const rect = range.getBoundingClientRect();
      range.detach();
      return rect.width || rect.height ? rect : null;
    };
    const textBoundaryGap = (before: Text, after: Text): number | null => {
      const beforeLength = before.textContent?.length ?? 0;
      if (!beforeLength || !(after.textContent?.length ?? 0)) return null;
      const beforeRect = textRangeRect(before, beforeLength - 1, beforeLength);
      const afterRect = textRangeRect(after, 0, 1);
      if (!beforeRect || !afterRect) return null;
      return afterRect.left - beforeRect.right;
    };
    const previousTextNode = (parent: Node, beforeChild: Node): Text | null => {
      const children = Array.from(parent.childNodes) as Node[];
      const childIndex = children.indexOf(beforeChild);
      for (let index = childIndex - 1; index >= 0; index -= 1) {
        const child = children[index];
        if (child.nodeType === Node.TEXT_NODE && child.textContent?.length) return child as Text;
        const textNodes = Array.from(child.childNodes).filter((node): node is Text => node.nodeType === Node.TEXT_NODE && Boolean(node.textContent?.length));
        if (textNodes.length) return textNodes[textNodes.length - 1];
      }
      return null;
    };
    type TextLeaf = {
      text: string;
      hasLeadingWhitespace: boolean;
      hasTrailingWhitespace: boolean;
      rect: DOMRect;
      fontSize: number;
      centerY: number;
      x: number;
      domOrder: number;
    };
    const textNodeFullRect = (textNode: Text): DOMRect | null => {
      const length = textNode.textContent?.length ?? 0;
      if (!length) return null;
      const range = frameDocument.createRange();
      range.selectNodeContents(textNode);
      const rect = range.getBoundingClientRect();
      range.detach();
      return rect.width || rect.height ? rect : null;
    };
    const measuredTextLeaves = (element: HTMLElement, domOrderBase = 0): TextLeaf[] => {
      const leaves: TextLeaf[] = [];
      let domOrder = 0;
      const walk = (node: Node): void => {
        for (const child of Array.from(node.childNodes)) {
          if (child.nodeType === Node.TEXT_NODE) {
            const rawText = child.textContent ?? "";
            const text = rawText.replace(/\s+/g, " ").trim();
            if (!text) continue;
            const rect = textNodeFullRect(child as Text);
            if (!rect) continue;
            const parentElement = child.parentElement;
            const fontSize = parentElement ? parsePx(frameWindow.getComputedStyle(parentElement).fontSize) ?? 16 : 16;
            leaves.push({
              text,
              hasLeadingWhitespace: /^\s/.test(rawText),
              hasTrailingWhitespace: /\s$/.test(rawText),
              rect,
              fontSize,
              centerY: rect.top + rect.height / 2,
              x: rect.left,
              domOrder: domOrderBase + domOrder
            });
            domOrder += 1;
            continue;
          }
          if (child.nodeType !== Node.ELEMENT_NODE) continue;
          walk(child);
        }
      };
      walk(element);
      return leaves;
    };
    const normalizeMeasuredText = (element: HTMLElement): string => {
      const leaves = measuredTextLeaves(element);
      return leaves.map((leaf) => leaf.text).join("").replace(/\s+/g, " ").trim();
    };
    const semanticTextLines = (selected: Candidate[], useMeasuredSpacing: boolean): string[] => {
      const leaves = selected.flatMap((candidate, index) => measuredTextLeaves(candidate.element, index * 100000));
      if (!leaves.length) return [];
      const lines: Array<{ centerY: number; leaves: TextLeaf[] }> = [];
      const medianHeight = median(leaves.map((leaf) => leaf.rect.height));
      const lineTolerance = Math.max(3, medianHeight * 0.45);
      for (const leaf of leaves.sort((a, b) => a.centerY - b.centerY || a.x - b.x || a.domOrder - b.domOrder)) {
        const centerY = leaf.centerY;
        const line = lines.find((entry) => Math.abs(entry.centerY - centerY) <= lineTolerance);
        if (line) {
          line.leaves.push(leaf);
          line.centerY = (line.centerY + centerY) / 2;
        } else {
          lines.push({ centerY, leaves: [leaf] });
        }
      }
      const textForLine = (lineLeaves: TextLeaf[]): string => {
        const ordered = [...lineLeaves].sort((a, b) => a.x - b.x || a.domOrder - b.domOrder);
        let text = "";
        let previous: TextLeaf | null = null;
        for (const leaf of ordered) {
          if (!text) {
            text = leaf.text;
            previous = leaf;
            continue;
          }
          const gap = previous ? leaf.rect.left - previous.rect.right : 0;
          const hasTextWhitespace = Boolean(previous?.hasTrailingWhitespace || leaf.hasLeadingWhitespace);
          const needsSpace = hasTextWhitespace || Boolean(useMeasuredSpacing && previous && shouldInsertMeasuredTextSpace(previous.text, leaf.text, gap, previous.fontSize));
          text += `${needsSpace ? " " : ""}${leaf.text}`;
          previous = leaf;
        }
        return text.replace(/\s+/g, " ").trim();
      };
      return lines
        .sort((a, b) => a.centerY - b.centerY)
        .map((line) => textForLine(line.leaves))
        .filter(Boolean);
    };
    const normalizedSemanticText = (selected: Candidate[]): string => {
      return semanticTextLines(selected, true).join("\n");
    };
    const rawSemanticText = (selected: Candidate[]): string => {
      return semanticTextLines(selected, false).join("\n");
    };
    const semanticTextFixes = (selected: Candidate[]): Array<{ line: number; from: string; to: string }> => {
      const rawLines = semanticTextLines(selected, false);
      const normalizedLines = semanticTextLines(selected, true);
      const fixes: Array<{ line: number; from: string; to: string }> = [];
      for (let index = 0; index < Math.max(rawLines.length, normalizedLines.length); index += 1) {
        const from = rawLines[index] ?? "";
        const to = normalizedLines[index] ?? "";
        if (from && to && from !== to) fixes.push({ line: index + 1, from, to });
      }
      return fixes;
    };
    const classListHasExtractorPositioning = (element: Element): boolean => {
      const classes = Array.from(element.classList);
      return classes.some((className) => /^(x|b|l|t|o)\d+$/i.test(className));
    };
    const hasUnsafeInlineStyles = (element: HTMLElement): boolean => {
      const style = element.style;
      return Boolean(
        style.position ||
        style.left ||
        style.top ||
        style.bottom ||
        style.right ||
        style.transform ||
        style.display === "block" ||
        style.display === "inline-block"
      );
    };
    const sameFontRendering = (parent: HTMLElement, child: HTMLElement): boolean => {
      const parentStyle = frameWindow.getComputedStyle(parent);
      const childStyle = frameWindow.getComputedStyle(child);
      return [
        "fontFamily",
        "fontSize",
        "fontWeight",
        "fontStyle",
        "fontVariant",
        "fontStretch",
        "lineHeight",
        "color",
        "direction",
        "textTransform"
      ].every((property) => parentStyle[property as keyof CSSStyleDeclaration] === childStyle[property as keyof CSSStyleDeclaration]);
    };
    const canFlattenInlineSpan = (parent: HTMLElement, child: HTMLElement): boolean => {
      if (child.tagName.toLowerCase() !== "span") return false;
      if (child.querySelector("img,svg,math,table,canvas,video,audio,sup,sub")) return false;
      if (classListHasExtractorPositioning(child) || hasUnsafeInlineStyles(child)) return false;
      if (!sameFontRendering(parent, child)) return false;
      const before = previousTextNode(parent, child);
      const firstChildText = firstTextNode(child);
      if (before?.nodeType === Node.TEXT_NODE && firstChildText) {
        const gap = textBoundaryGap(before, firstChildText);
        if (gap !== null && gap < -0.5) return false;
        if (gap !== null && gap > 12) return false;
      }
      return true;
    };
    const lastWordToken = (value: string): string => value.match(/[\p{L}\p{N}]+$/u)?.[0] ?? "";
    const firstWordToken = (value: string): string => value.match(/^[\p{L}\p{N}]+/u)?.[0] ?? "";
    const isLikelyCompleteWord = (value: string): boolean => {
      if (!value) return false;
      if (/^\d+$/u.test(value)) return true;
      if (value.length <= 2) {
        return /^(a|i|am|an|as|at|be|by|do|go|he|if|in|is|it|me|my|no|of|on|or|so|to|up|us|we)$/iu.test(value);
      }
      return value.length >= 3;
    };
    const shouldInsertMeasuredTextSpace = (beforeText: string, afterText: string, gap: number | null, fontSize: number): boolean => {
      if (gap === null || gap <= 0) return false;
      const previousToken = lastWordToken(beforeText);
      const nextToken = firstWordToken(afterText);
      if (/[,:;.!?]$/.test(beforeText.trim()) && Boolean(nextToken)) return true;
      if (!previousToken || !nextToken) return gap > Math.max(3, fontSize * 0.35);
      if (!isLikelyCompleteWord(previousToken) || !isLikelyCompleteWord(nextToken)) return false;
      const smallGap = Math.max(3, fontSize * 0.35);
      const largeGap = Math.max(12, fontSize);
      if (gap <= smallGap) return false;
      if (gap >= largeGap) return true;
      return true;
    };
    const needsSpaceBeforeFlattenedSpan = (parent: HTMLElement, child: HTMLElement): boolean => {
      const before = previousTextNode(parent, child);
      const firstChildText = firstTextNode(child);
      if (!before || !firstChildText) return false;
      const beforeText = before.textContent ?? "";
      const afterText = firstChildText.textContent ?? "";
      if (/\s$/.test(beforeText) || /^\s/.test(afterText)) return false;
      const gap = textBoundaryGap(before, firstChildText);
      const fontSize = parsePx(frameWindow.getComputedStyle(parent).fontSize) ?? 16;
      return shouldInsertMeasuredTextSpace(beforeText, afterText, gap, fontSize);
    };
    const simplifySafeInlineSpans = (sourceElement: HTMLElement, clonedElement: HTMLElement): void => {
      const sourceSpans = Array.from(sourceElement.querySelectorAll<HTMLElement>("span"));
      const clonedSpans = Array.from(clonedElement.querySelectorAll<HTMLElement>("span"));
      for (let index = sourceSpans.length - 1; index >= 0; index -= 1) {
        const sourceSpan = sourceSpans[index];
        const clonedSpan = clonedSpans[index];
        const sourceParent = sourceSpan.parentElement;
        if (!sourceParent || !clonedSpan || !sourceElement.contains(sourceParent)) continue;
        if (!canFlattenInlineSpan(sourceParent, sourceSpan)) continue;
        if (needsSpaceBeforeFlattenedSpan(sourceParent, sourceSpan)) {
          clonedSpan.parentNode?.insertBefore(ownerDocument.createTextNode(" "), clonedSpan);
        }
        while (clonedSpan.firstChild) clonedSpan.parentNode?.insertBefore(clonedSpan.firstChild, clonedSpan);
        clonedSpan.remove();
      }
    };
    const measuredCandidates = Array.from(frameDocument.body.querySelectorAll<HTMLElement>("*"))
      .map((element, index) => {
        const style = frameWindow.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        const hasTransform = style.transform && style.transform !== "none";
        const visualScale = inheritedVisualScale(element);
        const useComputedPosition = style.position === "absolute" && hasTransform && style.left !== "auto" && style.top !== "auto";
        const styleValues = new Map<string, string>();
        for (const property of visualProperties) styleValues.set(property, style.getPropertyValue(property));
        styleValues.set("position", "absolute");
        styleValues.set("left", useComputedPosition ? style.getPropertyValue("left") : roundCss(rect.left + frameWindow.scrollX));
        styleValues.set("top", useComputedPosition ? style.getPropertyValue("top") : roundCss(rect.top + frameWindow.scrollY));
        styleValues.set("width", hasTransform ? style.getPropertyValue("width") : roundCss(rect.width));
        styleValues.set("height", hasTransform ? style.getPropertyValue("height") : roundCss(rect.height));
        if (visualScale !== 1) {
          for (const property of scaleAwareProperties) {
            const value = styleValues.get(property);
            if (value && value !== "normal") styleValues.set(property, scaledPx(value, visualScale));
          }
        }
        return {
          key: `zoning-source-${index}`,
          element,
          style,
          styleValues,
          x: rect.left + frameWindow.scrollX,
          y: rect.top + frameWindow.scrollY,
          w: rect.width,
          h: rect.height,
          domOrder: index
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
    const frameTextContainer = frameDocument.querySelector<HTMLElement>("[id^='TextContainer'], #TextContainer, .main");
    const textContainer = root.querySelector<HTMLElement>("[id^='TextContainer'], #TextContainer, .main") ?? body;
    const textContainerScale = frameTextContainer ? matrixScale(frameWindow.getComputedStyle(frameTextContainer).transform) : 1;
    const useSourceCoordinateSystem = textContainer !== body && textContainerScale !== 1;
    const toSourceCss = (value: number): string => roundCss(useSourceCoordinateSystem ? value / textContainerScale : value);
    const namespace = root.namespaceURI || "http://www.w3.org/1999/xhtml";
    const ownerDocument = frameDocument;
    const claimedKeys = new Set<string>();
    const archivePath = this.archiveManifest()?.pages[page.pageIndex]?.reviewPath ?? "";
    const sourcePagePrefix = archivePath.match(/(?:^|\/)(page\d+)\.(?:xhtml|html|htm)$/i)?.[1]?.toLowerCase();
    const semanticPagePrefix = sourcePagePrefix ?? `page${String(page.pageIndex + 1).padStart(4, "0")}`;

    const styleElement = ownerDocument.createElementNS(namespace, "style");
    styleElement.textContent = ".zoning-semantic-content{position:absolute;display:block;overflow:visible}";
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
    const tableBoundaries = (values: number[] | undefined, max: number): number[] => {
      const inner = (values ?? []).filter((value) => Number.isFinite(value) && value > 0 && value < max).sort((a, b) => a - b);
      return [0, ...inner, max];
    };

    for (const [boxIndex, box] of this.normalizeBoxOrder(boxes).entries()) {
      const selected = orderCandidatesForReading(candidates.filter((candidate) => {
        if (claimedKeys.has(candidate.key)) return false;
        const centerX = candidate.x + candidate.w / 2;
        const centerY = candidate.y + candidate.h / 2;
        return centerX >= box.x && centerX <= box.x + box.w && centerY >= box.y && centerY <= box.y + box.h;
      }));
      for (const candidate of selected) claimedKeys.add(candidate.key);
      const commonStyles = useSourceCoordinateSystem ? new Map<string, string>() : commonStylesFor(selected);

      const semantic = ownerDocument.createElementNS(namespace, box.tag) as HTMLElement;
      const order = box.readingOrder ?? boxIndex + 1;
      semantic.setAttribute("id", `${semanticPagePrefix}_para${order}`);
      semantic.setAttribute("class", `zoning-semantic-parent ${semanticPagePrefix}-para${order}`);
      semantic.setAttribute("data-box-id", box.id);
      semantic.setAttribute("data-reading-order", String(order));
      semantic.setAttribute("data-semantic-tag", box.tag);
      const fixes = semanticTextFixes(selected);
      if (fixes.length) {
        semantic.setAttribute("data-text-fix-count", String(fixes.length));
        semantic.setAttribute("data-text-fixes", JSON.stringify(fixes));
      }
      if (!useSourceCoordinateSystem) semantic.setAttribute("style", `left:${toSourceCss(box.x)};top:${toSourceCss(box.y)}`);
      for (const [property, value] of commonStyles) semantic.style.setProperty(property, value);

      if (box.tag === "table") {
        const table = box.table?.outputMode === "semantic" && box.table.grid ? box.table : this.ensureTableGrid(box);
        const columns = tableBoundaries(table.grid?.columns, box.w);
        const rows = tableBoundaries(table.grid?.rows, box.h);
        const tbody = ownerDocument.createElementNS(namespace, "tbody");
        let tableMovedCount = 0;
        for (let rowIndex = 0; rowIndex < rows.length - 1; rowIndex += 1) {
          const row = ownerDocument.createElementNS(namespace, "tr");
          row.setAttribute("class", "zoning-table-row");
          for (let columnIndex = 0; columnIndex < columns.length - 1; columnIndex += 1) {
            const cellTag = rowIndex === 0 ? "th" : "td";
            const cell = ownerDocument.createElementNS(namespace, cellTag) as HTMLElement;
            cell.setAttribute("class", `zoning-table-cell ${semanticPagePrefix}-table${order}-r${rowIndex + 1}c${columnIndex + 1}`);
            cell.setAttribute("data-row", String(rowIndex + 1));
            cell.setAttribute("data-column", String(columnIndex + 1));
            const cellLeft = box.x + columns[columnIndex];
            const cellRight = box.x + columns[columnIndex + 1];
            const cellTop = box.y + rows[rowIndex];
            const cellBottom = box.y + rows[rowIndex + 1];
            const cellCandidates = selected.filter((candidate) => {
              const centerX = candidate.x + candidate.w / 2;
              const centerY = candidate.y + candidate.h / 2;
              return centerX >= cellLeft && centerX <= cellRight && centerY >= cellTop && centerY <= cellBottom;
            });
            const cellFixes = semanticTextFixes(cellCandidates);
            if (cellFixes.length) {
              cell.setAttribute("data-text-fix-count", String(cellFixes.length));
              cell.setAttribute("data-text-fixes", JSON.stringify(cellFixes));
            }
            for (const candidate of cellCandidates) {
              const clonedElement = cloneBySourceKey.get(candidate.key);
              if (!clonedElement) continue;
              if (useSourceCoordinateSystem) {
                cell.appendChild(clonedElement);
              } else {
                const replacement = ownerDocument.createElementNS(namespace, "span") as HTMLElement;
                for (const attribute of Array.from(clonedElement.attributes)) {
                  if (attribute.name === "style" || attribute.name === sourceMarker) continue;
                  replacement.setAttribute(attribute.name, attribute.value);
                }
                while (clonedElement.firstChild) replacement.appendChild(clonedElement.firstChild);
                applyStyles(replacement, candidate.styleValues, commonStyles);
                clonedElement.remove();
                cell.appendChild(replacement);
              }
              tableMovedCount += 1;
            }
            row.appendChild(cell);
          }
          tbody.appendChild(row);
        }
        semantic.setAttribute("data-table-mode", "semantic");
        semantic.setAttribute("data-row-count", String(rows.length - 1));
        semantic.setAttribute("data-column-count", String(columns.length - 1));
        semantic.appendChild(tbody);
        if (tableMovedCount === 0) continue;
        movedElementCount += tableMovedCount;
        textContainer.appendChild(semantic);
        continue;
      }

      const content = useSourceCoordinateSystem ? semantic : ownerDocument.createElementNS(namespace, "span");
      if (!useSourceCoordinateSystem) {
        content.setAttribute("class", "zoning-semantic-content");
        content.setAttribute("style", `left:${toSourceCss(-box.x)};top:${toSourceCss(-box.y)};width:${toSourceCss(page.pageWidth)};height:${toSourceCss(page.pageHeight)}`);
      }
      for (const candidate of selected) {
        const clonedElement = cloneBySourceKey.get(candidate.key);
        if (!clonedElement) continue;
        if (useSourceCoordinateSystem) {
          content.appendChild(clonedElement);
          movedElementCount += 1;
          continue;
        }
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
      if (!useSourceCoordinateSystem) semantic.appendChild(content);
      textContainer.appendChild(semantic);
    }

    if (boxes.length > 0 && movedElementCount === 0) return null;
    removeEmptyStructuralElements(root);

    const serializer = new XMLSerializer();
    return formatSerializedXhtml(`<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE html>\n${serializer.serializeToString(root)}`);
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
