import { CommonModule } from "@angular/common";
import { AfterViewInit, ChangeDetectionStrategy, Component, ElementRef, HostListener, inject, signal, viewChild } from "@angular/core";
import { ActivatedRoute, RouterLink } from "@angular/router";
import { type PageResult } from "../../types";
import { PageNavComponent } from "../../components/page-nav/page-nav.component";
import { SplitViewComponent } from "../../components/split-view/split-view.component";
import { JobService, type JobView } from "../../services/job.service";

type ReviewMode = "final" | "debug" | "boxes";

@Component({
  selector: "app-review-page",
  standalone: true,
  imports: [CommonModule, RouterLink, PageNavComponent, SplitViewComponent],
  template: `
    <main class="review-page">
      <header class="review-toolbar">
        <div>
          <a routerLink="/" class="review-toolbar__back">Back</a>
          <h1>Manual Extraction Review</h1>
        </div>

        <div class="review-toolbar__meta" *ngIf="job() as currentJob">
          <span class="chip">Job {{ currentJob.id.slice(0, 8) }}</span>
          <span class="chip">Status {{ currentJob.status }}</span>
          <span class="chip">Pages {{ currentJob.pageCount }}</span>
        </div>
      </header>

      <section class="review-shell" *ngIf="job() as currentJob; else loadingBlock">
        <div
          class="review-shell__nav-wrap"
          [class.is-collapsed]="navCollapsed()"
          (mouseenter)="handleNavEnter()"
          (mouseleave)="handleNavLeave()">
          <button
            type="button"
            class="review-shell__nav-peek"
            aria-label="Show page navigation"
            (click)="expandNav()">
            Pages
          </button>

          <app-page-nav
            class="review-shell__nav"
            [pageCount]="currentJob.pageCount"
            [currentPageIndex]="currentPageIndex()"
            [confidenceMap]="confidenceMap()"
            (pageSelected)="selectPage($event)" />
        </div>

        <div class="review-shell__content">
          <div class="review-shell__topbar">
            <div>
              <strong>Page {{ currentPageIndex() + 1 }}</strong>
              <span *ngIf="currentPage() as page">Confidence {{ page.confidence.toFixed(2) }}</span>
            </div>
            <div class="review-shell__actions">
              <div class="mode-switch" role="tablist" aria-label="Review mode">
                <button type="button" [class.is-active]="reviewMode() === 'final'" (click)="setReviewMode('final')">Final</button>
                <button type="button" [class.is-active]="reviewMode() === 'debug'" (click)="setReviewMode('debug')">Text Visible</button>
                <button type="button" [class.is-active]="reviewMode() === 'boxes'" (click)="setReviewMode('boxes')">Boxes</button>
              </div>
              <button type="button" (click)="previousPage()" [disabled]="currentPageIndex() === 0">Previous</button>
              <button type="button" (click)="nextPage()" [disabled]="currentPageIndex() >= currentJob.pageCount - 1">Next</button>
            </div>
          </div>

          <app-split-view>
            <div leftPane class="pane">
              <h2>Rasterized PDF Page</h2>
              <div #imageViewport class="pane__surface" *ngIf="currentPage() as page">
                <div
                  class="page-fit-box"
                  [style.width.px]="scaledWidth()"
                  [style.height.px]="scaledHeight()">
                  <img
                    class="page-preview"
                    [src]="page.imageUrl"
                    [alt]="'Rendered page ' + (page.pageIndex + 1)"
                    [style.width.px]="page.width"
                    [style.height.px]="page.height"
                    [style.transform]="pageTransform()">
                </div>
              </div>
            </div>

            <div rightPane class="pane">
              <h2>Extracted Fixed-Layout HTML</h2>
              <div #htmlViewport class="pane__surface pane__surface--iframe" *ngIf="currentPage() as page">
                <div
                  class="page-fit-box"
                  [style.width.px]="scaledWidth()"
                  [style.height.px]="scaledHeight()">
                  <iframe
                    class="page-preview-frame"
                    title="Extracted HTML preview"
                    scrolling="no"
                    [style.width.px]="page.width"
                    [style.height.px]="page.height"
                    [style.transform]="pageTransform()"
                    [attr.srcdoc]="currentHtmlContent()"></iframe>
                </div>
              </div>
            </div>
          </app-split-view>
        </div>
      </section>

      <ng-template #loadingBlock>
        <section class="loading-block">
          <p>{{ loadingMessage() }}</p>
        </section>
      </ng-template>
    </main>
  `,
  styles: [`
    .review-page {
      min-height: 100vh;
      display: grid;
      grid-template-rows: auto 1fr;
    }

    .review-toolbar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: var(--space-4);
      padding: var(--space-3) var(--space-4);
      border-bottom: 1px solid var(--border);
      background: rgba(7, 12, 19, 0.86);
      backdrop-filter: blur(18px);
    }

    .review-toolbar h1 {
      margin: 6px 0 0;
      font-family: var(--font-display);
      font-size: 1.6rem;
    }

    .review-toolbar__back {
      color: var(--accent);
      text-decoration: none;
      font-size: 0.92rem;
    }

    .review-toolbar__meta {
      display: flex;
      gap: var(--space-2);
      flex-wrap: wrap;
      justify-content: flex-end;
    }

    .chip {
      padding: 8px 12px;
      border-radius: 999px;
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid var(--border);
      color: var(--text-muted);
      font-size: 0.86rem;
    }

    .review-shell {
      min-height: 0;
      display: grid;
      grid-template-columns: auto 1fr;
    }

    .review-shell__nav-wrap {
      position: relative;
      min-height: 0;
      width: 132px;
      transition: width 160ms ease;
      overflow: hidden;
    }

    .review-shell__nav-wrap.is-collapsed {
      width: 20px;
    }

    .review-shell__nav {
      min-height: 0;
      width: 132px;
      height: 100%;
      transition: transform 160ms ease, opacity 160ms ease;
    }

    .review-shell__nav-wrap.is-collapsed .review-shell__nav {
      transform: translateX(-112px);
      opacity: 0.05;
      pointer-events: none;
    }

    .review-shell__nav-peek {
      position: absolute;
      inset: 0 auto 0 0;
      width: 20px;
      padding: 0;
      display: grid;
      place-items: center;
      writing-mode: vertical-rl;
      transform: rotate(180deg);
      letter-spacing: 0.12em;
      text-transform: uppercase;
      font-size: 0.68rem;
      color: rgba(236, 244, 255, 0.8);
      background: linear-gradient(180deg, rgba(94, 208, 255, 0.35), rgba(94, 208, 255, 0.12));
      border-right: 1px solid rgba(94, 208, 255, 0.28);
      opacity: 0;
      pointer-events: none;
      transition: opacity 160ms ease;
      z-index: 2;
    }

    .review-shell__nav-wrap.is-collapsed .review-shell__nav-peek {
      opacity: 1;
      pointer-events: auto;
    }

    .review-shell__content {
      min-height: 0;
      display: grid;
      grid-template-rows: auto 1fr;
    }

    .review-shell__topbar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: var(--space-4);
      padding: var(--space-3) var(--space-4);
      border-bottom: 1px solid var(--border);
      background: rgba(10, 16, 25, 0.74);
    }

    .review-shell__topbar strong {
      margin-right: var(--space-2);
    }

    .review-shell__topbar span {
      color: var(--text-muted);
    }

    .review-shell__actions {
      display: flex;
      gap: var(--space-2);
      align-items: center;
      flex-wrap: wrap;
    }

    .review-shell__actions button,
    .mode-switch button {
      padding: 10px 14px;
      border-radius: 999px;
      background: rgba(255, 255, 255, 0.06);
      color: var(--text);
    }

    .review-shell__actions button:disabled {
      opacity: 0.4;
      cursor: not-allowed;
    }

    .mode-switch {
      display: flex;
      gap: 8px;
      padding: 4px;
      border-radius: 999px;
      background: rgba(255, 255, 255, 0.04);
      border: 1px solid var(--border);
    }

    .mode-switch button.is-active {
      background: linear-gradient(135deg, rgba(94, 208, 255, 0.34), rgba(94, 208, 255, 0.18));
      color: var(--text);
    }

    .pane {
      min-height: 100%;
      display: grid;
      grid-template-rows: auto 1fr;
      padding: var(--space-4);
      gap: var(--space-3);
    }

    .pane h2 {
      margin: 0;
      font-size: 0.98rem;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.08em;
    }

    .pane__surface {
      min-height: 0;
      border-radius: var(--radius);
      border: 1px solid var(--border);
      background: #08111c;
      overflow: auto;
      display: grid;
      place-items: center;
      padding: var(--space-3);
    }

    .page-fit-box {
      position: relative;
      flex: 0 0 auto;
      display: block;
    }

    .page-preview,
    .page-preview-frame {
      display: block;
      background: white;
      box-shadow: 0 10px 30px rgba(0, 0, 0, 0.3);
      transform-origin: top left;
    }

    .page-preview-frame {
      border: 0;
    }

    .loading-block {
      display: grid;
      place-items: center;
      min-height: 60vh;
      color: var(--text-muted);
    }

    @media (max-width: 1100px) {
      .review-shell__nav-wrap {
        width: 110px;
      }

      .review-shell__nav {
        width: 110px;
      }

      .review-shell__nav-wrap.is-collapsed {
        width: 20px;
      }

      .review-shell__nav-wrap.is-collapsed .review-shell__nav {
        transform: translateX(-90px);
      }
    }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class ReviewComponent implements AfterViewInit {
  private readonly route = inject(ActivatedRoute);
  private readonly jobs = inject(JobService);
  private readonly imageViewport = viewChild<ElementRef<HTMLDivElement>>("imageViewport");
  private readonly htmlViewport = viewChild<ElementRef<HTMLDivElement>>("htmlViewport");
  private resizeObserver: ResizeObserver | null = null;

  readonly job = signal<JobView | null>(null);
  readonly currentPage = signal<PageResult | null>(null);
  readonly currentPageIndex = signal(0);
  readonly confidenceMap = signal<Record<number, number>>({});
  readonly loadingMessage = signal("Loading review session...");
  readonly navCollapsed = signal(false);
  readonly pageScale = signal(1);
  readonly reviewMode = signal<ReviewMode>("final");

  ngAfterViewInit(): void {
    queueMicrotask(() => this.bindViewportObserver());
  }

  constructor() {
    const jobId = this.route.snapshot.paramMap.get("jobId");
    if (!jobId) {
      this.loadingMessage.set("Missing job id.");
      return;
    }

    this.jobs.getJob(jobId).subscribe({
      next: (job) => {
        this.job.set(job);
        if (job.status === "done") {
          this.loadPage(jobId, this.currentPageIndex());
        } else {
          this.loadingMessage.set("Waiting for extraction to complete...");
          this.jobs.pollJob(jobId).subscribe({
            next: (polledJob) => {
              this.job.set(polledJob);
              if (polledJob.status === "done") {
                this.loadPage(jobId, this.currentPageIndex());
              }
              if (polledJob.status === "failed") {
                this.loadingMessage.set(polledJob.errorMessage ?? "Extraction failed.");
              }
            }
          });
        }
      },
      error: () => {
        this.loadingMessage.set("Unable to load job state.");
      }
    });
  }

  selectPage(pageIndex: number): void {
    const jobId = this.job()?.id;
    if (!jobId) {
      return;
    }

    this.currentPageIndex.set(pageIndex);
    this.navCollapsed.set(true);
    this.loadPage(jobId, pageIndex);
  }

  previousPage(): void {
    if (this.currentPageIndex() > 0) {
      this.selectPage(this.currentPageIndex() - 1);
    }
  }

  nextPage(): void {
    const currentJob = this.job();
    if (!currentJob) {
      return;
    }

    if (this.currentPageIndex() < currentJob.pageCount - 1) {
      this.selectPage(this.currentPageIndex() + 1);
    }
  }

  setReviewMode(mode: ReviewMode): void {
    this.reviewMode.set(mode);
  }

  currentHtmlContent(): string {
    const page = this.currentPage();
    if (!page) {
      return "";
    }

    if (this.reviewMode() === "boxes") {
      return page.boxesHtmlContent ?? page.debugHtmlContent ?? page.htmlContent;
    }

    if (this.reviewMode() === "debug") {
      return page.debugHtmlContent ?? page.htmlContent;
    }

    return page.htmlContent;
  }

  @HostListener("window:keydown", ["$event"])
  handleKeyboard(event: KeyboardEvent): void {
    if (event.key === "ArrowLeft") {
      this.previousPage();
    }

    if (event.key === "ArrowRight") {
      this.nextPage();
    }
  }

  @HostListener("window:resize")
  handleResize(): void {
    this.updateScale();
  }

  pageTransform(): string {
    return `scale(${this.pageScale()})`;
  }

  scaledWidth(): number {
    const page = this.currentPage();
    if (!page) {
      return 0;
    }

    return Math.round(page.width * this.pageScale());
  }

  scaledHeight(): number {
    const page = this.currentPage();
    if (!page) {
      return 0;
    }

    return Math.round(page.height * this.pageScale());
  }

  expandNav(): void {
    this.navCollapsed.set(false);
  }

  handleNavEnter(): void {
    this.navCollapsed.set(false);
  }

  handleNavLeave(): void {
    this.navCollapsed.set(true);
  }

  private bindViewportObserver(): void {
    if (this.resizeObserver) {
      return;
    }

    this.resizeObserver = new ResizeObserver(() => this.updateScale());

    const imageViewport = this.imageViewport()?.nativeElement;
    const htmlViewport = this.htmlViewport()?.nativeElement;
    if (imageViewport) {
      this.resizeObserver.observe(imageViewport);
    }
    if (htmlViewport) {
      this.resizeObserver.observe(htmlViewport);
    }

    this.updateScale();
  }

  private updateScale(): void {
    const page = this.currentPage();
    const imageViewport = this.imageViewport()?.nativeElement;
    const htmlViewport = this.htmlViewport()?.nativeElement;
    if (!page || !imageViewport || !htmlViewport) {
      this.pageScale.set(1);
      return;
    }

    const widthPadding = 24;
    const heightPadding = 24;
    const imageWidthScale = Math.max(0.01, (imageViewport.clientWidth - widthPadding) / page.width);
    const htmlWidthScale = Math.max(0.01, (htmlViewport.clientWidth - widthPadding) / page.width);
    const imageHeightScale = Math.max(0.01, (imageViewport.clientHeight - heightPadding) / page.height);
    const htmlHeightScale = Math.max(0.01, (htmlViewport.clientHeight - heightPadding) / page.height);

    const scale = Math.min(1, imageWidthScale, htmlWidthScale, imageHeightScale, htmlHeightScale);
    this.pageScale.set(Number(scale.toFixed(4)));
  }

  private loadPage(jobId: string, pageIndex: number): void {
    this.loadingMessage.set(`Loading page ${pageIndex + 1}...`);
    this.jobs.getPage(jobId, pageIndex).subscribe({
      next: (page) => {
        this.currentPage.set(page);
        this.confidenceMap.update((current) => ({ ...current, [page.pageIndex]: page.confidence }));
        this.loadingMessage.set("");
        queueMicrotask(() => {
          this.bindViewportObserver();
          this.updateScale();
        });
      },
      error: () => {
        this.loadingMessage.set(`Unable to load page ${pageIndex + 1}.`);
      }
    });
  }
}
